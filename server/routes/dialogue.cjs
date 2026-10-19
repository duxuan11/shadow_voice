// 中译英口语对话 API：
//  - GET   /:videoId          取该用户该视频该难度的当前剧本 + 进度（未生成返回 script:null）
//  - POST  /:videoId/generate 生成新剧本（variant+1）并建进度行
//  - POST  /:scriptId/evaluate 只评当前一句（带上下文与重试次数），写回答题记录
//  - PUT   /:scriptId/progress 推进游标 / 标记完成
//  - POST  /:scriptId/restart  重新开始（清空作答记录）
// 成本控制：GET 从不触发模型调用；生成整组 1 次；每答一句 1 次。

const express = require('express')
const { getDb, run, get, all } = require('../db.cjs')
const { authMiddleware } = require('../auth.cjs')
const { loadSubtitles, findVideo } = require('../lib/videoData.cjs')
const {
  DIFFICULTIES,
  TARGET_MIN,
  TARGET_MAX,
  normalizeDifficulty,
  difficultyOf,
  buildScriptPrompt,
  normalizeDialogueScript,
  buildLineReviewPrompt,
  normalizeLineReview,
} = require('../services/ai/dialogue.cjs')
const { chat, extractJson, isConfigured, AI_MODEL } = require('../services/ai/provider.cjs')

const router = express.Router()

const MAX_GENERATE_ATTEMPTS = 2
const MAX_SEGMENTS = 120
const MAX_ATTEMPTS_PER_LINE = 20
const SCENE_CACHE_VERSION = 'scene-v1'

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v ?? fallback
  } catch {
    return fallback
  }
}

function scriptPayload(row) {
  const script = parseJson(row?.script_json, null)
  return script && typeof script === 'object' && Array.isArray(script.lines) ? script : null
}

function serializeProgress(row) {
  const answers = parseJson(row.answers_json, [])
  return {
    id: row.id,
    scriptId: row.script_id,
    cursor: row.cursor,
    status: row.status,
    answers: Array.isArray(answers) ? answers : [],
    updatedAt: row.updated_at,
  }
}

function ensureProgress(scriptRow) {
  let row = get('SELECT * FROM dialogue_progress WHERE script_id=?', [scriptRow.id])
  if (!row) {
    run('INSERT INTO dialogue_progress (script_id, user_id) VALUES (?,?)', [scriptRow.id, scriptRow.user_id])
    row = get('SELECT * FROM dialogue_progress WHERE script_id=?', [scriptRow.id])
  }
  return row
}

function currentScript(userId, videoId, difficulty) {
  return get(
    'SELECT * FROM dialogue_scripts WHERE user_id=? AND video_id=? AND difficulty=? ORDER BY variant DESC LIMIT 1',
    [userId, videoId, difficulty]
  )
}

function availableDifficulties(userId, videoId) {
  const rows = all('SELECT DISTINCT difficulty FROM dialogue_scripts WHERE user_id=? AND video_id=?', [userId, videoId])
  const set = new Set(rows.map((r) => r.difficulty))
  return DIFFICULTIES.filter((d) => set.has(d))
}

function requireOwnScript(req, res, scriptId) {
  const id = Number(scriptId)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: '脚本不存在' })
    return null
  }
  const row = get('SELECT * FROM dialogue_scripts WHERE id=?', [id])
  if (!row) {
    res.status(404).json({ error: '脚本不存在' })
    return null
  }
  if (row.user_id !== req.userId) {
    res.status(403).json({ error: '无权访问该脚本' })
    return null
  }
  return row
}

function loadCachedScene(videoId) {
  const cached = get('SELECT result FROM ai_cache WHERE video_id=? AND prompt_version=?', [videoId, SCENE_CACHE_VERSION])
  if (!cached) return null
  const scene = parseJson(cached.result, null)
  return scene && typeof scene === 'object' ? scene : null
}

// ── GET 当前剧本 + 进度 ──────────────────────────────────
router.get('/:videoId', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const video = findVideo(req.params.videoId)
    if (!video) return res.status(404).json({ error: '视频不存在' })

    const difficulty = normalizeDifficulty(req.query.difficulty) || difficultyOf(video.level)
    const row = currentScript(req.userId, video.id, difficulty)
    const available = availableDifficulties(req.userId, video.id)

    if (!row) {
      return res.json({ difficulty, aiConfigured: isConfigured(), available, script: null, progress: null })
    }

    return res.json({
      difficulty,
      aiConfigured: isConfigured(),
      available,
      script: scriptPayload(row),
      progress: serializeProgress(ensureProgress(row)),
    })
  } catch (err) {
    console.error('[dialogue] 读取脚本失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 生成整组剧本 ────────────────────────────────────
router.post('/:videoId/generate', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const video = findVideo(req.params.videoId)
    if (!video) return res.status(404).json({ error: '视频不存在' })

    const difficulty = normalizeDifficulty(req.body?.difficulty) || difficultyOf(video.level)
    if (!isConfigured()) return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })

    const segments = loadSubtitles(video.episode_dir)
      .map((s) => ({ textEn: s?.textEn, textCn: s?.textCn }))
      .filter((s) => String(s.textEn ?? '').trim())
    const hasSubtitles = segments.length > 0
    const hasVideoInfo = !!(String(video.title ?? '').trim() || String(video.description ?? '').trim())
    if (!hasSubtitles && !hasVideoInfo) {
      return res.status(404).json({ error: '视频信息不足，无法生成对话' })
    }

    const prompt = buildScriptPrompt({
      videoTitle: video.title,
      description: video.description || '',
      videoLevel: video.level,
      difficulty,
      segments: segments.slice(0, MAX_SEGMENTS),
      scene: loadCachedScene(video.id),
    })
    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]

    let normalized = null
    let lastReason = ''
    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt++) {
      let content
      try {
        content = await chat(messages, { temperature: 0.8, maxTokens: 3000, timeoutMs: 60000 })
      } catch (err) {
        console.error('[dialogue] 生成失败:', err.message)
        return res.status(503).json({ error: '生成失败（AI 服务暂不可用），请重试' })
      }

      let json = null
      try {
        json = extractJson(content)
      } catch {
        json = null
      }

      if (json) {
        normalized = normalizeDialogueScript(json, { difficulty, hasSubtitles })
        if (normalized.ok) break
        lastReason = normalized.reason
      } else {
        lastReason = 'AI 输出不是合法 JSON'
      }

      if (attempt < MAX_GENERATE_ATTEMPTS) {
        messages.push({ role: 'assistant', content: String(content ?? '') })
        messages.push({
          role: 'user',
          content: `上一轮输出不合格（${lastReason}）。请重新只输出一个 JSON 对象：lines 必须 ${TARGET_MIN}–${TARGET_MAX} 句，每句都要有中文 cn 与英文 en，不要重复句子。`,
        })
      }
    }

    if (!normalized || !normalized.ok) {
      console.error('[dialogue] 生成结果不合格:', lastReason)
      return res.status(503).json({ error: '生成失败（AI 服务暂不可用），请重试' })
    }

    const script = normalized.script
    let created = null
    for (let i = 0; i < 2; i++) {
      const last = get(
        'SELECT COALESCE(MAX(variant),0) AS v FROM dialogue_scripts WHERE user_id=? AND video_id=? AND difficulty=?',
        [req.userId, video.id, difficulty]
      )
      const variant = Number(last?.v ?? 0) + 1
      try {
        const r = run(
          'INSERT INTO dialogue_scripts (user_id, video_id, difficulty, variant, script_json, model) VALUES (?,?,?,?,?,?)',
          [req.userId, video.id, difficulty, variant, JSON.stringify(script), AI_MODEL]
        )
        created = get('SELECT * FROM dialogue_scripts WHERE id=?', [r.lastInsertRowid])
        break
      } catch (err) {
        if (i === 1) throw err
      }
    }

    return res.status(201).json({
      script,
      progress: serializeProgress(ensureProgress(created)),
    })
  } catch (err) {
    console.error('[dialogue] 生成异常:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 评估一句 ────────────────────────────────────────
router.post('/:scriptId/evaluate', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnScript(req, res, req.params.scriptId)
    if (!row) return

    const script = scriptPayload(row)
    if (!script) return res.status(500).json({ error: '脚本已损坏，请重新生成对话' })

    const index = Number(req.body?.index)
    if (!Number.isInteger(index) || index < 0 || index >= script.lines.length) {
      return res.status(400).json({ error: '句子索引无效' })
    }
    const userText = String(req.body?.userText ?? '').trim()
    if (!userText) return res.status(400).json({ error: '缺少学习者说的英文' })
    if (!isConfigured()) return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })

    const progressRow = ensureProgress(row)
    const answers = parseJson(progressRow.answers_json, [])
    const list = Array.isArray(answers) ? answers : []
    const prev = list.find((a) => a && a.index === index)
    // attempts 由服务端累加，客户端传值不可信
    const attempts = Math.min(MAX_ATTEMPTS_PER_LINE, (Number(prev?.attempts) || 0) + 1)

    const line = script.lines[index]
    const contextLines = []
    for (let i = Math.max(0, index - 2); i < index; i++) {
      contextLines.push({ speakerCn: script.lines[i].speakerCn, cn: script.lines[i].cn })
    }

    const prompt = buildLineReviewPrompt({
      line,
      contextLines,
      difficulty: script.difficulty,
      userText,
      attempt: attempts,
    })

    let content
    try {
      content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.2, maxTokens: 800, timeoutMs: 30000 }
      )
    } catch (err) {
      console.error('[dialogue] 评分失败:', err.message)
      return res.status(503).json({ error: '评分失败，请稍后重试' })
    }

    let json = null
    try {
      json = extractJson(content)
    } catch {
      json = null
    }
    if (!json) {
      return res.json({
        review: {
          verdict: 'wrong', score: null, issues: [], better: '', praise: '',
          hint: '', answerHidden: true, parseError: true,
        },
        attempts,
        progress: serializeProgress(progressRow),
      })
    }

    const review = normalizeLineReview(json, { attempt: attempts })
    const record = {
      index,
      attempts,
      userText,
      score: review.score,
      verdict: review.verdict,
      issues: review.issues,
      better: review.better,
      praise: review.praise,
      revealedAnswer: prev?.revealedAnswer === true,
      updatedAt: new Date().toISOString(),
    }
    const next = list.filter((a) => a && a.index !== index)
    next.push(record)
    next.sort((a, b) => a.index - b.index)

    run("UPDATE dialogue_progress SET answers_json=?, updated_at=datetime('now') WHERE id=?",
      [JSON.stringify(next), progressRow.id])
    const updated = get('SELECT * FROM dialogue_progress WHERE id=?', [progressRow.id])

    return res.json({ review, attempts, progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[dialogue] 评分异常:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 记下「查看过参考答案」 ───────────────────────────
router.post('/:scriptId/reveal', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnScript(req, res, req.params.scriptId)
    if (!row) return

    const script = scriptPayload(row)
    if (!script) return res.status(500).json({ error: '脚本已损坏，请重新生成对话' })

    const index = Number(req.body?.index)
    if (!Number.isInteger(index) || index < 0 || index >= script.lines.length) {
      return res.status(400).json({ error: '句子索引无效' })
    }

    const progressRow = ensureProgress(row)
    const answers = parseJson(progressRow.answers_json, [])
    const list = Array.isArray(answers) ? answers : []
    const record = list.find((a) => a && a.index === index)
    // 还没作答就查看答案：只记在已存在的记录上，避免造假一条作答
    if (record && record.revealedAnswer !== true) {
      record.revealedAnswer = true
      run("UPDATE dialogue_progress SET answers_json=?, updated_at=datetime('now') WHERE id=?",
        [JSON.stringify(list), progressRow.id])
    }
    const updated = get('SELECT * FROM dialogue_progress WHERE id=?', [progressRow.id])
    return res.json({ progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[dialogue] 记录查看答案失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── PUT 推进进度 ─────────────────────────────────────────
router.put('/:scriptId/progress', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnScript(req, res, req.params.scriptId)
    if (!row) return

    const script = scriptPayload(row)
    const total = script ? script.lines.length : 0
    const cursor = Number(req.body?.cursor)
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > total) {
      return res.status(400).json({ error: '进度无效' })
    }

    const requested = req.body?.status
    const status = ['active', 'completed'].includes(requested)
      ? requested
      : (cursor >= total ? 'completed' : 'active')

    const progressRow = ensureProgress(row)
    run("UPDATE dialogue_progress SET cursor=?, status=?, updated_at=datetime('now') WHERE id=?",
      [cursor, status, progressRow.id])
    const updated = get('SELECT * FROM dialogue_progress WHERE id=?', [progressRow.id])
    return res.json({ progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[dialogue] 更新进度失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 重新开始 ────────────────────────────────────────
router.post('/:scriptId/restart', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnScript(req, res, req.params.scriptId)
    if (!row) return

    const progressRow = ensureProgress(row)
    run("UPDATE dialogue_progress SET cursor=0, answers_json='[]', status='active', updated_at=datetime('now') WHERE id=?",
      [progressRow.id])
    const updated = get('SELECT * FROM dialogue_progress WHERE id=?', [progressRow.id])
    return res.json({ progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[dialogue] 重新开始失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

module.exports = { router }
