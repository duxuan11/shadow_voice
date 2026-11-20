// 每日口语挑战 API：
//  - GET   /:videoId?variant=N  取挑战 + 进度 + 历史 + 视频级语块掌握（不调模型）
//  - POST  /:videoId/generate   生成新一套挑战（variant+1），登记 chunk_mastery
//  - PUT   /:challengeId/progress 推进 cursor / 状态（恢复用）
//  - POST  /:challengeId/restart  重练同一套（只清进度，不动 challenge 与掌握状态）
// 成本控制：GET 0 次模型调用；生成 1–2 次；每步反馈 1 次；对话每轮 1 次；收尾 1 次。

const express = require('express')
const { getDb, run, get, all } = require('../db.cjs')
const { authMiddleware } = require('../auth.cjs')
const { findVideo, loadSubtitles } = require('../lib/videoData.cjs')
const {
  upsertIntroduced, listForVideo, bucketsOf, applyUsage,
} = require('../lib/chunkMastery.cjs')
const {
  RECALL_COUNT, CHUNK_COUNT, TRANSFORMATION_COUNT,
  buildChallengePrompt, normalizeChallenge, buildFallbackChunks, buildTranscriptDigest,
  buildStepFeedbackPrompt, normalizeStepFeedback, buildChatTurnPrompt, normalizeChatReply,
  buildFinishPrompt, normalizeFinish,
} = require('../services/ai/challenge.cjs')
const { chat, extractJson, isConfigured, AI_MODEL } = require('../services/ai/provider.cjs')

const router = express.Router()

const MAX_GENERATE_ATTEMPTS = 2
const MAX_SEGMENTS = 120
const STEP_COUNT = 5
const MAX_TEXT = 2000
const CHAT_MIN_TURNS = 5
const CHAT_MAX_TURNS = 8
const MIN_SPEAKING_MS = 5000

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v ?? fallback
  } catch {
    return fallback
  }
}

function challengePayload(row) {
  const c = parseJson(row?.challenge_json, null)
  return c && typeof c === 'object' && !Array.isArray(c) ? c : null
}

// steps_json 恒为长度 5 的数组，未开始的步为 null
function parseSteps(json) {
  const v = parseJson(json, [])
  const out = Array(STEP_COUNT).fill(null)
  if (Array.isArray(v)) {
    v.slice(0, STEP_COUNT).forEach((s, i) => {
      out[i] = s && typeof s === 'object' && !Array.isArray(s) ? s : null
    })
  }
  return out
}

function serializeProgress(row) {
  if (!row) return null
  return {
    challengeId: row.challenge_id,
    cursor: row.cursor,
    status: row.status,
    steps: parseSteps(row.steps_json),
    report: parseJson(row.report_json, null),
    updatedAt: row.updated_at,
  }
}

function ensureProgress(scriptRow) {
  let row = get('SELECT * FROM speaking_challenge_progress WHERE challenge_id=?', [scriptRow.id])
  if (!row) {
    run('INSERT INTO speaking_challenge_progress (challenge_id, user_id) VALUES (?,?)', [scriptRow.id, scriptRow.user_id])
    row = get('SELECT * FROM speaking_challenge_progress WHERE challenge_id=?', [scriptRow.id])
  }
  return row
}

function masteryRowOf(r) {
  return {
    chunkKey: r.chunk_key,
    chunkEn: r.chunk_en,
    chunkCn: r.chunk_cn,
    status: r.status,
    usesCount: r.uses_count,
    lastScore: r.last_score,
  }
}

function serializeMastery(userId, videoId) {
  const buckets = bucketsOf(listForVideo(userId, videoId))
  return {
    mastered: buckets.mastered.map(masteryRowOf),
    selfUsed: buckets.selfUsed.map(masteryRowOf),
    review: buckets.review.map(masteryRowOf),
    introduced: buckets.introduced.map(masteryRowOf),
  }
}

function requireOwnChallenge(req, res, rawId) {
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: '挑战不存在' })
    return null
  }
  const row = get('SELECT * FROM speaking_challenges WHERE id=?', [id])
  if (!row) {
    res.status(404).json({ error: '挑战不存在' })
    return null
  }
  if (row.user_id !== req.userId) {
    res.status(403).json({ error: '无权访问该挑战' })
    return null
  }
  if (!challengePayload(row)) {
    res.status(500).json({ error: '挑战数据已损坏，请重新生成' })
    return null
  }
  return row
}

function videoPayload(video) {
  return {
    id: video.id,
    title: video.title,
    thumbnail: video.thumbnail_local || '',
    level: video.level || '',
    duration: video.duration || 0,
    topic: video.topic || '',
  }
}

function loadSegments(video) {
  return loadSubtitles(video.episode_dir)
    .map((s) => ({ textEn: s?.textEn, textCn: s?.textCn }))
    .filter((s) => String(s.textEn ?? '').trim())
}

function cachedTopics(videoId) {
  const row = get('SELECT result FROM ai_cache WHERE video_id=? AND prompt_version=?', [videoId, 'topics-v1'])
  const parsed = row ? parseJson(row.result, null) : null
  return parsed && typeof parsed === 'object' ? parsed : null
}

// 最近 2 套已经用过的内容，避免同一视频多次生成雷同任务。
function buildAvoid(userId, videoId) {
  const rows = all(
    'SELECT challenge_json FROM speaking_challenges WHERE user_id=? AND video_id=? ORDER BY variant DESC LIMIT 2',
    [userId, videoId]
  )
  const chunks = []
  const situations = []
  const questions = []
  for (const r of rows) {
    const c = parseJson(r.challenge_json, null)
    if (!c) continue
    for (const x of Array.isArray(c.chunks) ? c.chunks : []) if (x?.en) chunks.push(String(x.en))
    for (const x of Array.isArray(c.transformations) ? c.transformations : []) if (x?.situationCn) situations.push(String(x.situationCn))
    for (const x of Array.isArray(c.recall) ? c.recall : []) if (x?.qEn) questions.push(String(x.qEn))
  }
  return {
    chunks: chunks.slice(0, 20).map((s) => s.slice(0, 80)),
    situations: situations.slice(0, 20).map((s) => s.slice(0, 80)),
    questions: questions.slice(0, 20).map((s) => s.slice(0, 80)),
  }
}

function historyOf(userId, videoId) {
  const rows = all(
    `SELECT c.id, c.variant, c.created_at, p.status, p.cursor, p.report_json, p.updated_at
     FROM speaking_challenges c
     LEFT JOIN speaking_challenge_progress p ON p.challenge_id = c.id
     WHERE c.user_id=? AND c.video_id=?
     ORDER BY c.variant DESC`,
    [userId, videoId]
  )
  return rows.map((r) => {
    const report = parseJson(r.report_json, null)
    return {
      challengeId: r.id,
      variant: r.variant,
      status: r.status || 'active',
      cursor: r.cursor ?? 0,
      score: report && typeof report.score === 'number' ? report.score : null,
      createdAt: r.created_at,
      completedAt: r.status === 'completed' ? r.updated_at : null,
    }
  })
}

// ── GET 挑战 + 进度 + 历史 + 掌握状态 ────────────────────
router.get('/:videoId', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const video = findVideo(req.params.videoId)
    if (!video) return res.status(404).json({ error: '视频不存在' })

    const wanted = Number(req.query.variant)
    const row = Number.isInteger(wanted) && wanted > 0
      ? get('SELECT * FROM speaking_challenges WHERE user_id=? AND video_id=? AND variant=?',
        [req.userId, video.id, wanted])
      : get('SELECT * FROM speaking_challenges WHERE user_id=? AND video_id=? ORDER BY variant DESC LIMIT 1',
        [req.userId, video.id])

    return res.json({
      video: videoPayload(video),
      aiConfigured: isConfigured(),
      challengeId: row ? row.id : null,
      variant: row ? row.variant : null,
      challenge: row ? challengePayload(row) : null,
      progress: row ? serializeProgress(ensureProgress(row)) : null,
      history: historyOf(req.userId, video.id),
      mastery: serializeMastery(req.userId, video.id),
    })
  } catch (err) {
    console.error('[challenge] 读取失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 生成新一套挑战 ─────────────────────────────────
router.post('/:videoId/generate', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const video = findVideo(req.params.videoId)
    if (!video) return res.status(404).json({ error: '视频不存在' })

    const segments = loadSegments(video)
    if (segments.length === 0) {
      return res.status(503).json({ error: '该视频没有字幕，暂不支持生成口语挑战' })
    }
    if (!isConfigured()) return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })

    const last = get(
      'SELECT COALESCE(MAX(variant),0) AS v FROM speaking_challenges WHERE user_id=? AND video_id=?',
      [req.userId, video.id]
    )
    const variant = Number(last?.v ?? 0) + 1
    const fallbackChunks = buildFallbackChunks({ segments, cachedTopics: cachedTopics(video.id) })
    const prompt = buildChallengePrompt({
      videoTitle: video.title,
      description: video.description || '',
      topic: video.topic || '',
      videoLevel: video.level,
      segments: segments.slice(0, MAX_SEGMENTS),
      variant,
      avoid: buildAvoid(req.userId, video.id),
    })
    const segmentsText = segments.map((s) => s.textEn).join(' ')
    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]

    let normalized = null
    let lastReason = ''
    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
      let content
      try {
        content = await chat(messages, { temperature: 0.9, maxTokens: 4000, timeoutMs: 60000 })
      } catch (err) {
        console.error('[challenge] 生成失败:', err.message)
        return res.status(503).json({ error: '生成失败（AI 服务暂不可用），请重试' })
      }

      let json = null
      try {
        json = extractJson(content)
      } catch {
        json = null
      }

      if (json) {
        normalized = normalizeChallenge(json, { segmentsText, fallbackChunks })
        if (normalized.ok) break
        lastReason = normalized.reason
      } else {
        lastReason = 'AI 输出不是合法 JSON'
      }

      if (attempt < MAX_GENERATE_ATTEMPTS) {
        messages.push({ role: 'assistant', content: String(content ?? '') })
        messages.push({
          role: 'user',
          content: `上一轮输出不合格（${lastReason}）。请重新只输出一个 JSON 对象：recall 恰好 ${RECALL_COUNT} 条、chunks 恰好 ${CHUNK_COUNT} 条（每条 evidence 必须是字幕原句）、transformations 恰好 ${TRANSFORMATION_COUNT} 条。`,
        })
      }
    }

    if (!normalized || !normalized.ok) {
      console.error('[challenge] 生成结果不合格:', lastReason)
      return res.status(503).json({ error: '生成失败（AI 服务暂不可用），请重试' })
    }

    const challenge = normalized.challenge
    let created = null
    for (let i = 0; i < 2; i += 1) {
      const latest = get(
        'SELECT COALESCE(MAX(variant),0) AS v FROM speaking_challenges WHERE user_id=? AND video_id=?',
        [req.userId, video.id]
      )
      const v = Number(latest?.v ?? 0) + 1
      try {
        const r = run(
          'INSERT INTO speaking_challenges (user_id, video_id, variant, challenge_json, model) VALUES (?,?,?,?,?)',
          [req.userId, video.id, v, JSON.stringify(challenge), AI_MODEL]
        )
        created = get('SELECT * FROM speaking_challenges WHERE id=?', [r.lastInsertRowid])
        break
      } catch (err) {
        if (i === 1) throw err
      }
    }

    upsertIntroduced({ userId: req.userId, videoId: video.id, chunks: challenge.chunks })

    return res.status(201).json({
      challengeId: created.id,
      variant: created.variant,
      challenge,
      progress: serializeProgress(ensureProgress(created)),
      mastery: serializeMastery(req.userId, video.id),
    })
  } catch (err) {
    console.error('[challenge] 生成异常:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── PUT 推进进度 ────────────────────────────────────────
router.put('/:challengeId/progress', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnChallenge(req, res, req.params.challengeId)
    if (!row) return

    const cursor = Number(req.body?.cursor)
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > STEP_COUNT) {
      return res.status(400).json({ error: '进度无效' })
    }
    const requested = req.body?.status
    const status = ['active', 'completed'].includes(requested) ? requested : (cursor >= STEP_COUNT ? 'completed' : 'active')

    const progressRow = ensureProgress(row)
    run("UPDATE speaking_challenge_progress SET cursor=?, status=?, updated_at=datetime('now') WHERE id=?",
      [cursor, status, progressRow.id])
    return res.json({ progress: serializeProgress(get('SELECT * FROM speaking_challenge_progress WHERE id=?', [progressRow.id])) })
  } catch (err) {
    console.error('[challenge] 更新进度失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 重练同一套 ─────────────────────────────────────
router.post('/:challengeId/restart', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnChallenge(req, res, req.params.challengeId)
    if (!row) return

    const progressRow = ensureProgress(row)
    run("UPDATE speaking_challenge_progress SET cursor=0, status='active', steps_json='[]', report_json=NULL, updated_at=datetime('now') WHERE id=?",
      [progressRow.id])
    return res.json({ progress: serializeProgress(get('SELECT * FROM speaking_challenge_progress WHERE id=?', [progressRow.id])) })
  } catch (err) {
    console.error('[challenge] 重练失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── 请求参数归一化 ──────────────────────────────────────
function num(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(min, Math.round(n)))
}

function clampText(v) {
  return String(v ?? '').trim().slice(0, MAX_TEXT)
}

// 按步骤校验作答；返回 { ok, answers } 或 { ok:false, error }
function parseStepAnswers(step, body) {
  if (step === 4) {
    const text = clampText(body?.text)
    const durationMs = num(body?.durationMs, 0, 600000)
    const segments = num(body?.segments, 0, 20)
    if (!text && durationMs < MIN_SPEAKING_MS) {
      return { ok: false, error: '还没有内容可以提交' }
    }
    return { ok: true, answers: [{ index: 0, text, durationMs, segments }] }
  }

  const raw = Array.isArray(body?.answers) ? body.answers : []
  const expected = step === 1 ? 3 : 5
  const answers = []
  for (let i = 0; i < expected; i += 1) {
    const item = raw.find((a) => Number(a?.index) === i) || raw[i] || {}
    if (step === 2) {
      const chunkText = clampText(item?.chunkText)
      const sentence = clampText(item?.sentence)
      if (!chunkText && !sentence) return { ok: false, error: `第 ${i + 1} 项还没有内容` }
      answers.push({
        index: i,
        chunkText,
        sentence,
        durationMs: num(item?.durationMs, 0, 600000),
        segments: num(item?.segments, 0, 20),
      })
    } else {
      const text = clampText(item?.text)
      if (!text) return { ok: false, error: `第 ${i + 1} 项还没有内容` }
      answers.push({
        index: i,
        text,
        durationMs: num(item?.durationMs, 0, 600000),
        segments: num(item?.segments, 0, 20),
      })
    }
  }
  return { ok: true, answers }
}

// 一次尝试 = 一条答案（页面提交时已把同一次尝试的多段录音合并）
function metricsOfAnswers(answers) {
  let longest = 0
  let total = 0
  let segments = 0
  for (const a of Array.isArray(answers) ? answers : []) {
    const ms = num(a?.durationMs, 0, 600000)
    const sg = num(a?.segments, 0, 20)
    if (!ms) continue
    longest = Math.max(longest, ms)
    total += ms
    segments += sg
  }
  return {
    longestSeconds: Math.round(longest / 1000),
    totalSeconds: Math.round(total / 1000),
    segments,
  }
}

function collectSpeakingAttempts(steps) {
  const all = []
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || !Array.isArray(s.answers)) continue
    for (const a of s.answers) all.push({ durationMs: a?.durationMs, segments: a?.segments })
  }
  return metricsOfAnswers(all)
}

function saveSteps(progressRowId, steps) {
  run("UPDATE speaking_challenge_progress SET steps_json=?, updated_at=datetime('now') WHERE id=?",
    [JSON.stringify(steps), progressRowId])
}

function loadChallengeContext(req, res, rawId) {
  const row = requireOwnChallenge(req, res, rawId)
  if (!row) return null
  const challenge = challengePayload(row)
  const video = findVideo(row.video_id)
  const segments = video ? loadSegments(video) : []
  const progressRow = ensureProgress(row)
  return {
    row,
    challenge,
    video,
    segments,
    progressRow,
    steps: parseSteps(progressRow.steps_json),
    title: video ? video.title : '',
  }
}

function resultPayload(userId, videoId, progressRow, extra = {}) {
  return {
    ...extra,
    progress: serializeProgress(get('SELECT * FROM speaking_challenge_progress WHERE id=?', [progressRow.id])),
    mastery: serializeMastery(userId, videoId),
  }
}

// ── POST 提交某一步（1–4）并拿反馈 ───────────────────────
router.post('/:challengeId/step/:step', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const step = Number(req.params.step)
    if (![1, 2, 3, 4].includes(step)) return res.status(400).json({ error: '步骤无效' })

    const ctx = loadChallengeContext(req, res, req.params.challengeId)
    if (!ctx) return

    const parsed = parseStepAnswers(step, req.body)
    if (!parsed.ok) return res.status(400).json({ error: parsed.error })

    const { challenge, video, segments, progressRow, steps } = ctx
    const answers = parsed.answers
    const record = {
      step,
      status: 'answered',
      answers,
      feedback: null,
      updatedAt: new Date().toISOString(),
    }
    steps[step - 1] = record
    saveSteps(progressRow.id, steps)

    const metrics = metricsOfAnswers(answers)

    // Step 4 完全没识别到文字：只记时长，不调 AI（D14）
    if (step === 4 && !answers[0].text) {
      record.note = '未识别到语音内容，只记录时长'
      saveSteps(progressRow.id, steps)
      return res.json(resultPayload(req.userId, ctx.row.video_id, progressRow, {
        feedback: null,
        note: record.note,
      }))
    }

    if (!isConfigured()) {
      return res.status(503).json({
        error: 'AI 未配置（AI_API_KEY 为空）',
        hasAnswers: true,
        progress: serializeProgress(get('SELECT * FROM speaking_challenge_progress WHERE id=?', [progressRow.id])),
      })
    }

    const prompt = buildStepFeedbackPrompt({
      step,
      challenge,
      videoTitle: ctx.title,
      transcriptDigest: buildTranscriptDigest(segments),
      answers,
      metrics,
    })

    let content
    try {
      content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.3, maxTokens: 1600, timeoutMs: 45000 }
      )
    } catch (err) {
      console.error('[challenge] 步骤评分失败:', err.message)
      return res.status(503).json({
        error: '评分失败，请稍后重试',
        hasAnswers: true,
        progress: serializeProgress(get('SELECT * FROM speaking_challenge_progress WHERE id=?', [progressRow.id])),
      })
    }

    let json = null
    try {
      json = extractJson(content)
    } catch {
      json = null
    }
    if (!json) {
      return res.status(503).json({
        error: '评分失败，请稍后重试',
        hasAnswers: true,
        progress: serializeProgress(get('SELECT * FROM speaking_challenge_progress WHERE id=?', [progressRow.id])),
      })
    }

    const feedback = normalizeStepFeedback(json, {
      step,
      itemCount: answers.length,
      chunks: challenge.chunks,
    })
    applyUsage({
      userId: req.userId,
      videoId: ctx.row.video_id,
      chunks: challenge.chunks,
      chunkUsage: feedback.chunkUsage,
      step,
      score: feedback.score,
    })

    record.feedback = feedback
    record.status = 'completed'
    record.updatedAt = new Date().toISOString()
    steps[step - 1] = record
    saveSteps(progressRow.id, steps)

    return res.json(resultPayload(req.userId, ctx.row.video_id, progressRow, { feedback }))
  } catch (err) {
    console.error('[challenge] 步骤提交异常:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 第 5 步：AI 对话的一轮 ─────────────────────────
router.post('/:challengeId/chat', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const ctx = loadChallengeContext(req, res, req.params.challengeId)
    if (!ctx) return

    const { challenge, progressRow, steps } = ctx
    const record = steps[4] && typeof steps[4] === 'object'
      ? { ...steps[4], step: 5 }
      : { step: 5, status: 'answered', answers: [], feedback: null }
    const messages = Array.isArray(record.answers) ? record.answers : []
    const userTurns = messages.filter((m) => m?.role === 'user').length
    const text = clampText(req.body?.text)

    if (messages.length > 0 && !text) return res.status(400).json({ error: '缺少 text' })
    if (userTurns >= CHAT_MAX_TURNS) {
      return res.status(400).json({ error: `本轮对话已达上限（${CHAT_MAX_TURNS} 轮），请结束对话` })
    }
    if (!isConfigured()) return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })

    const pending = text
      ? [...messages, {
        role: 'user',
        text,
        durationMs: num(req.body?.durationMs, 0, 600000),
        segments: num(req.body?.segments, 0, 20),
      }]
      : messages

    const prompt = buildChatTurnPrompt({ challenge, videoTitle: ctx.title, history: pending })

    let content
    try {
      content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.8, maxTokens: 400, timeoutMs: 30000 }
      )
    } catch (err) {
      console.error('[challenge] 对话失败:', err.message)
      return res.status(503).json({ error: 'AI 服务暂不可用，请稍后重试' })
    }

    let json = null
    try {
      json = extractJson(content)
    } catch {
      json = null
    }
    const normalized = json ? normalizeChatReply(json) : normalizeChatReply(content)
    if (!normalized.ok) {
      return res.status(503).json({ error: 'AI 服务暂不可用，请稍后重试' })
    }

    const nextMessages = [...pending, { role: 'ai', text: normalized.reply }]
    record.status = 'answered'
    record.answers = nextMessages
    record.updatedAt = new Date().toISOString()
    steps[4] = record
    saveSteps(progressRow.id, steps)

    const newTurns = nextMessages.filter((m) => m?.role === 'user').length
    return res.json({
      reply: normalized.reply,
      messages: nextMessages,
      userTurns: newTurns,
      canFinish: newTurns >= CHAT_MIN_TURNS,
    })
  } catch (err) {
    console.error('[challenge] 对话异常:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ── POST 收尾：第 5 步反馈 + 最终报告 ────────────────────
router.post('/:challengeId/finish', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const ctx = loadChallengeContext(req, res, req.params.challengeId)
    if (!ctx) return

    const { challenge, progressRow, steps } = ctx
    const chatRecord = steps[4] && typeof steps[4] === 'object' ? steps[4] : null
    const messages = Array.isArray(chatRecord?.answers) ? chatRecord.answers : []
    const userTurns = messages.filter((m) => m?.role === 'user').length

    if (userTurns < CHAT_MIN_TURNS) {
      return res.status(400).json({
        error: `还需要至少 ${CHAT_MIN_TURNS} 轮对话（当前 ${userTurns} 轮）`,
      })
    }
    const incomplete = [0, 1, 2, 3].filter((i) => steps[i]?.status !== 'completed')
    if (incomplete.length > 0) {
      const names = `第 ${incomplete.map((i) => i + 1).join('、')} 步`
      return res.status(400).json({ error: `还有未完成的训练环节：${names}` })
    }
    if (!isConfigured()) return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })

    const metrics = collectSpeakingAttempts(steps)
    const prompt = buildFinishPrompt({
      challenge,
      feedbacks: steps.slice(0, 4).map((s) => s?.feedback || null),
      chatMessages: messages,
      metrics,
    })

    let content
    try {
      content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.4, maxTokens: 1600, timeoutMs: 45000 }
      )
    } catch (err) {
      console.error('[challenge] 收尾失败:', err.message)
      return res.status(503).json({ error: '生成报告失败，请稍后重试' })
    }

    let json = null
    try {
      json = extractJson(content)
    } catch {
      json = null
    }
    const normalized = normalizeFinish(json, { metrics, chunks: challenge.chunks })
    if (!normalized.ok) {
      return res.status(503).json({ error: '生成报告失败，请稍后重试' })
    }

    applyUsage({
      userId: req.userId,
      videoId: ctx.row.video_id,
      chunks: challenge.chunks,
      chunkUsage: normalized.chatFeedback?.chunkUsage || [],
      step: 5,
      score: normalized.chatFeedback?.score ?? null,
    })

    const record = {
      ...(chatRecord || { step: 5, answers: messages }),
      step: 5,
      status: 'completed',
      answers: messages,
      feedback: normalized.chatFeedback,
      updatedAt: new Date().toISOString(),
    }
    steps[4] = record

    // 掌握分堆在这一刻冻结进报告（D11），后续再练也不改写旧报告
    const buckets = bucketsOf(listForVideo(req.userId, ctx.row.video_id))
    const report = {
      ...normalized.report,
      mastered: buckets.mastered.map(masteryRowOf),
      selfUsed: buckets.selfUsed.map(masteryRowOf),
      review: buckets.review.map(masteryRowOf),
      introduced: buckets.introduced.map(masteryRowOf),
      generatedAt: new Date().toISOString(),
      aiFallback: false,
    }

    run(
      "UPDATE speaking_challenge_progress SET steps_json=?, report_json=?, status='completed', cursor=?, updated_at=datetime('now') WHERE id=?",
      [JSON.stringify(steps), JSON.stringify(report), STEP_COUNT, progressRow.id]
    )

    return res.json(resultPayload(req.userId, ctx.row.video_id, progressRow, { report }))
  } catch (err) {
    console.error('[challenge] 收尾异常:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

module.exports = { router, MAX_TEXT }