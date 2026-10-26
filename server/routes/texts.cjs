// 文本练习 API（与视频学习完全独立的数据域）：
//  - GET    /               列表（按最近练习排序，不含原文）
//  - POST   /               粘贴保存：切句 → 建进度行 → 批量 AI 翻译中文
//  - GET    /:id            详情（原文 + 句子 + 进度）
//  - PUT    /:id            改标题（不动进度）/ 改正文（重切句 + 清进度 + 重译）
//  - DELETE /:id            删除（显式删进度行，本库未开 foreign_keys）
//  - POST   /:id/translate  补齐缺失中文
//
// 成本约定：保存/补齐各按 50 句一批调用模型，每批最多 2 次尝试；AI 不可用时保存照常成功。

const express = require('express')
const { getDb, run, get, all } = require('../db.cjs')
const { authMiddleware } = require('../auth.cjs')
const { splitMarkdown } = require('../lib/textSentences.cjs')
const {
  TRANSLATE_CHUNK,
  buildTranslatePrompt,
  normalizeTranslations,
  buildSentenceReviewPrompt,
  normalizeSentenceReview,
} = require('../services/ai/textPractice.cjs')
const { chat, extractJson, isConfigured, AI_MODEL } = require('../services/ai/provider.cjs')

const router = express.Router()

const MAX_TITLE = 100
const MAX_TEXT = 20000
const MAX_USER_TEXT = 1000
const MAX_ATTEMPTS_PER_SENTENCE = 20
const MAX_TRANSLATE_ATTEMPTS = 2

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}

function parseSentences(row) {
  const raw = parseJson(row?.sentences_json, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s) => s && typeof s === 'object')
    .map((s, i) => ({
      i,
      en: String(s.en ?? ''),
      cn: String(s.cn ?? ''),
      section: String(s.section ?? ''),
    }))
}

// ─── 序列化 ─────────────────────────────────────────────
function serializeDoc(row) {
  const sentences = parseSentences(row)
  const missingCn = sentences.filter((s) => !s.cn).length
  return {
    id: row.id,
    title: row.title,
    sourceText: row.source_text,
    sentences,
    truncated: Number(row.truncated) === 1,
    cnReady: sentences.length > 0 && missingCn === 0,
    missingCn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeProgress(row) {
  const shadow = parseJson(row?.shadow_json, [])
  const answers = parseJson(row?.answers_json, [])
  return {
    docId: row.doc_id,
    shadowCursor: row.shadow_cursor,
    translateCursor: row.translate_cursor,
    status: row.status,
    shadow: Array.isArray(shadow) ? shadow : [],
    answers: Array.isArray(answers) ? answers : [],
    updatedAt: row.updated_at,
  }
}

function serializeSummary(docRow, progressRow) {
  const sentences = parseSentences(docRow)
  const shadow = parseJson(progressRow?.shadow_json, [])
  const answers = parseJson(progressRow?.answers_json, [])
  return {
    id: docRow.id,
    title: docRow.title,
    sentenceCount: sentences.length,
    cnReady: sentences.length > 0 && sentences.every((s) => s.cn),
    truncated: Number(docRow.truncated) === 1,
    status: progressRow?.status || 'active',
    shadowDone: Array.isArray(shadow) ? shadow.length : 0,
    translateDone: Array.isArray(answers) ? answers.length : 0,
    updatedAt: progressRow?.updated_at || docRow.updated_at,
  }
}

// ─── 通用访问 ───────────────────────────────────────────
function ensureProgress(docRow) {
  let row = get('SELECT * FROM text_progress WHERE doc_id=?', [docRow.id])
  if (!row) {
    run('INSERT INTO text_progress (doc_id, user_id) VALUES (?,?)', [docRow.id, docRow.user_id])
    row = get('SELECT * FROM text_progress WHERE doc_id=?', [docRow.id])
  }
  return row
}

function requireOwnDoc(req, res, rawId) {
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: '文本不存在' })
    return null
  }
  const row = get('SELECT * FROM text_docs WHERE id=?', [id])
  if (!row) {
    res.status(404).json({ error: '文本不存在' })
    return null
  }
  if (row.user_id !== req.userId) {
    res.status(403).json({ error: '无权访问该文本' })
    return null
  }
  return row
}

function validateTitle(title) {
  const value = String(title ?? '').trim()
  if (!value) return { ok: false, error: '标题不能为空（最多 100 字）' }
  if (value.length > MAX_TITLE) return { ok: false, error: '标题不能为空（最多 100 字）' }
  return { ok: true, value }
}

function splitText(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return { ok: false, error: '正文不能为空（最多 20000 字符）' }
  if (raw.length > MAX_TEXT) return { ok: false, error: '正文不能为空（最多 20000 字符）' }
  const { units, truncated } = splitMarkdown(raw)
  if (units.length === 0) return { ok: false, error: '没有找到可练习的英文句子' }
  const sentences = units.map((u, i) => ({ i, en: u.en, cn: '', section: u.section }))
  return { ok: true, sentences, truncated, raw }
}

// ─── 批量翻译 ───────────────────────────────────────────

// 单批翻译：prompt 里的 i 是批内局部下标，结果映射回全局句子下标。
async function translateChunk(title, chunk) {
  const done = new Map()
  const prompt = buildTranslatePrompt({ title, sentences: chunk.map((c) => c.en) })
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]

  for (let attempt = 1; attempt <= MAX_TRANSLATE_ATTEMPTS; attempt++) {
    let content
    try {
      content = await chat(messages, { temperature: 0.3, maxTokens: 4000, timeoutMs: 60000 })
    } catch (err) {
      console.error('[texts] 翻译调用失败:', err?.message || err)
      continue
    }
    try {
      const normalized = normalizeTranslations(extractJson(content), { count: chunk.length })
      normalized.items.forEach(({ i, cn }) => {
        if (chunk[i]) done.set(chunk[i].i, cn)
      })
      if (normalized.ok) break
      if (attempt < MAX_TRANSLATE_ATTEMPTS) {
        messages.push({ role: 'assistant', content: String(content).slice(0, 2000) })
        messages.push({
          role: 'user',
          content: `上一轮缺少第 ${normalized.missing.join('、')} 句的译文，请补齐并只输出完整 JSON。`,
        })
      }
    } catch (err) {
      console.error('[texts] 翻译结果解析失败:', err?.message || err)
    }
  }
  return done
}

/**
 * 批量翻译（保存与「重新生成中文」共用）。
 * @returns {Promise<{ translation: 'ok'|'partial'|'unavailable', sentences: object[] }>}
 */
async function translateDoc(docRow, { onlyMissing = false } = {}) {
  const sentences = parseSentences(docRow)
  if (!isConfigured()) return { translation: 'unavailable', sentences }

  const targets = sentences.filter((s) => !(onlyMissing && s.cn))
  if (targets.length === 0) {
    const missing = sentences.filter((s) => !s.cn).length
    const translation = sentences.length === 0 ? 'unavailable' : missing === 0 ? 'ok' : 'partial'
    return { translation, sentences }
  }

  for (let start = 0; start < targets.length; start += TRANSLATE_CHUNK) {
    const chunk = targets.slice(start, start + TRANSLATE_CHUNK)
    const done = await translateChunk(docRow.title, chunk)
    for (const [index, cn] of done) {
      if (sentences[index]) sentences[index].cn = cn
    }
    // 每批结束就落库：请求中断也只丢当前这一批，不会整篇中文白跑
    if (done.size > 0) {
      run("UPDATE text_docs SET sentences_json=?, updated_at=datetime('now') WHERE id=?",
        [JSON.stringify(sentences), docRow.id])
    }
  }

  run("UPDATE text_docs SET sentences_json=?, model=?, updated_at=datetime('now') WHERE id=?",
    [JSON.stringify(sentences), AI_MODEL, docRow.id])

  const missing = sentences.filter((s) => !s.cn).length
  const translation = missing === 0 ? 'ok' : missing === sentences.length ? 'unavailable' : 'partial'
  return { translation, sentences }
}

// ─── 列表 ───────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const rows = all(
      `SELECT d.*, p.updated_at AS progress_updated_at, p.status AS progress_status,
              p.shadow_json, p.answers_json
         FROM text_docs d
         LEFT JOIN text_progress p ON p.doc_id = d.id
        WHERE d.user_id = ?
        ORDER BY COALESCE(p.updated_at, d.updated_at) DESC, d.id DESC`,
      [req.userId]
    )
    const docs = rows.map((row) => serializeSummary(row, {
      updated_at: row.progress_updated_at,
      status: row.progress_status,
      shadow_json: row.shadow_json,
      answers_json: row.answers_json,
    }))
    return res.json({ docs, aiConfigured: isConfigured() })
  } catch (err) {
    console.error('[texts] 列表失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ─── 保存新文本 ─────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const title = validateTitle(req.body?.title)
    if (!title.ok) return res.status(400).json({ error: title.error })
    const split = splitText(req.body?.text)
    if (!split.ok) return res.status(400).json({ error: split.error })

    const created = run(
      'INSERT INTO text_docs (user_id, title, source_text, sentences_json, truncated) VALUES (?,?,?,?,?)',
      [req.userId, title.value, split.raw, JSON.stringify(split.sentences), split.truncated ? 1 : 0]
    )
    const row = get('SELECT * FROM text_docs WHERE id=?', [created.lastInsertRowid])
    ensureProgress(row)

    const { translation } = await translateDoc(row)
    const fresh = get('SELECT * FROM text_docs WHERE id=?', [row.id])
    return res.status(201).json({
      doc: serializeDoc(fresh),
      progress: serializeProgress(ensureProgress(fresh)),
      translation,
    })
  } catch (err) {
    console.error('[texts] 保存失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ─── 详情 ───────────────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return
    return res.json({
      doc: serializeDoc(row),
      progress: serializeProgress(ensureProgress(row)),
      aiConfigured: isConfigured(),
    })
  } catch (err) {
    console.error('[texts] 读取详情失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ─── 编辑 ───────────────────────────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return

    const hasTitle = req.body?.title !== undefined
    const hasText = req.body?.text !== undefined
    if (!hasTitle && !hasText) return res.status(400).json({ error: '没有需要更新的内容' })

    let titleValue = row.title
    if (hasTitle) {
      const title = validateTitle(req.body.title)
      if (!title.ok) return res.status(400).json({ error: title.error })
      titleValue = title.value
    }

    let translation = null
    // 正文与库里完全一致 → 视为「只改标题」，绝不动句子与进度（防客户端每次都带 text）
    const textUnchanged = hasText && String(req.body.text) === String(row.source_text)
    if (hasText && !textUnchanged) {
      const split = splitText(req.body.text)
      if (!split.ok) return res.status(400).json({ error: split.error })
      run(
        "UPDATE text_docs SET title=?, source_text=?, sentences_json=?, truncated=?, updated_at=datetime('now') WHERE id=?",
        [titleValue, split.raw, JSON.stringify(split.sentences), split.truncated ? 1 : 0, row.id]
      )
      // 正文变了：进度作废（改名不动进度）
      ensureProgress(row)
      run(
        "UPDATE text_progress SET shadow_cursor=0, translate_cursor=0, shadow_json='[]', answers_json='[]', status='active', updated_at=datetime('now') WHERE doc_id=?",
        [row.id]
      )
      const fresh = get('SELECT * FROM text_docs WHERE id=?', [row.id])
      translation = (await translateDoc(fresh)).translation
    } else {
      run("UPDATE text_docs SET title=?, updated_at=datetime('now') WHERE id=?", [titleValue, row.id])
    }
    if (textUnchanged) translation = null

    const fresh = get('SELECT * FROM text_docs WHERE id=?', [row.id])
    return res.json({
      doc: serializeDoc(fresh),
      progress: serializeProgress(ensureProgress(fresh)),
      translation,
    })
  } catch (err) {
    console.error('[texts] 编辑失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ─── 删除 ───────────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return
    // 本库未开启 PRAGMA foreign_keys：显式删进度行，避免孤儿数据
    run('DELETE FROM text_progress WHERE doc_id=?', [row.id])
    run('DELETE FROM text_docs WHERE id=?', [row.id])
    return res.status(204).end()
  } catch (err) {
    console.error('[texts] 删除失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// ─── 补齐中文 ───────────────────────────────────────────
router.post('/:id/translate', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return
    if (!isConfigured()) return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })

    const { translation } = await translateDoc(row, { onlyMissing: true })
    const fresh = get('SELECT * FROM text_docs WHERE id=?', [row.id])
    return res.json({ doc: serializeDoc(fresh), translation })
  } catch (err) {
    console.error('[texts] 补齐中文失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})


// ─── 练习写入：跟读评分 / 回译评分 / 查看原文 / 进度 ─────

function validIndex(raw, total) {
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 && index < total ? index : null
}

// 跟读：只记每句最佳分与尝试次数
router.post('/:id/shadow', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return

    const sentences = parseSentences(row)
    const index = validIndex(req.body?.index, sentences.length)
    if (index === null) return res.status(400).json({ error: '句子索引无效' })

    const score = Number(req.body?.score)
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return res.status(400).json({ error: '评分无效' })
    }

    const progressRow = ensureProgress(row)
    const previous = parseJson(progressRow.shadow_json, [])
    const shadow = Array.isArray(previous) ? previous : []
    const value = Math.round(score)
    const existing = shadow.find((item) => item && item.index === index)
    if (existing) {
      existing.best = Math.max(Number(existing.best) || 0, value)
      existing.attempts = (Number(existing.attempts) || 0) + 1
      existing.updatedAt = new Date().toISOString()
    } else {
      shadow.push({ index, best: value, attempts: 1, updatedAt: new Date().toISOString() })
    }
    shadow.sort((a, b) => a.index - b.index)

    run("UPDATE text_progress SET shadow_json=?, updated_at=datetime('now') WHERE id=?",
      [JSON.stringify(shadow), progressRow.id])
    const updated = get('SELECT * FROM text_progress WHERE id=?', [progressRow.id])
    return res.json({ progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[texts] 保存跟读评分失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 回译评分：句子内容以服务端为准（客户端只传下标与答案），attempts 服务端累加
router.post('/:id/review', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return

    const sentences = parseSentences(row)
    const index = validIndex(req.body?.index, sentences.length)
    if (index === null) return res.status(400).json({ error: '句子索引无效' })

    const userText = String(req.body?.userText ?? '').trim()
    if (!userText || userText.length > MAX_USER_TEXT) {
      return res.status(400).json({ error: '缺少你的英文答案' })
    }
    if (!isConfigured()) return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })

    const progressRow = ensureProgress(row)
    const previous = parseJson(progressRow.answers_json, [])
    const answers = Array.isArray(previous) ? previous : []
    const prev = answers.find((a) => a && a.index === index)
    const attempts = Math.min(MAX_ATTEMPTS_PER_SENTENCE, (Number(prev?.attempts) || 0) + 1)

    const sentence = sentences[index]
    const prompt = buildSentenceReviewPrompt({
      title: row.title,
      en: sentence.en,
      cn: sentence.cn,
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
      console.error('[texts] 评分调用失败:', err?.message || err)
      return res.status(503).json({ error: '评分失败，请稍后重试' })
    }

    let json = null
    try {
      json = extractJson(content)
    } catch {
      json = null
    }

    const review = normalizeSentenceReview(json)
    if (review.parseError) {
      // 不写库：提示用户重试，绝不伪造分数
      return res.json({ review, attempts, progress: serializeProgress(progressRow) })
    }

    const record = {
      index,
      userText,
      score: review.score,
      verdict: review.verdict,
      issues: review.issues,
      better: review.better,
      praise: review.praise,
      attempts,
      revealedAnswer: prev?.revealedAnswer === true,
      updatedAt: new Date().toISOString(),
    }
    const next = answers.filter((a) => a && a.index !== index)
    next.push(record)
    next.sort((a, b) => a.index - b.index)

    run("UPDATE text_progress SET answers_json=?, updated_at=datetime('now') WHERE id=?",
      [JSON.stringify(next), progressRow.id])
    const updated = get('SELECT * FROM text_progress WHERE id=?', [progressRow.id])
    return res.json({ review, attempts, progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[texts] 评分异常:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 记下「查看过原文」：未作答不建假记录
router.post('/:id/reveal', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return

    const sentences = parseSentences(row)
    const index = validIndex(req.body?.index, sentences.length)
    if (index === null) return res.status(400).json({ error: '句子索引无效' })

    const progressRow = ensureProgress(row)
    const previous = parseJson(progressRow.answers_json, [])
    const answers = Array.isArray(previous) ? previous : []
    const record = answers.find((a) => a && a.index === index)
    if (record && record.revealedAnswer !== true) {
      record.revealedAnswer = true
      run("UPDATE text_progress SET answers_json=?, updated_at=datetime('now') WHERE id=?",
        [JSON.stringify(answers), progressRow.id])
    }
    const updated = get('SELECT * FROM text_progress WHERE id=?', [progressRow.id])
    return res.json({ progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[texts] 记录查看原文失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 进度：只更新传入的字段；cursor 允许等于总句数（= 练到末尾），不会自动改 status
router.put('/:id/progress', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = requireOwnDoc(req, res, req.params.id)
    if (!row) return

    const total = parseSentences(row).length
    const progressRow = ensureProgress(row)
    const fields = []
    const params = []

    for (const [key, column] of [['shadowCursor', 'shadow_cursor'], ['translateCursor', 'translate_cursor']]) {
      if (req.body?.[key] === undefined) continue
      const value = Number(req.body[key])
      if (!Number.isInteger(value) || value < 0 || value > total) {
        return res.status(400).json({ error: '进度无效' })
      }
      fields.push(`${column}=?`)
      params.push(value)
    }

    if (req.body?.status !== undefined) {
      if (!['active', 'completed'].includes(req.body.status)) {
        return res.status(400).json({ error: '状态无效' })
      }
      fields.push('status=?')
      params.push(req.body.status)
    }

    if (fields.length === 0) return res.status(400).json({ error: '进度无效' })

    fields.push("updated_at=datetime('now')")
    params.push(progressRow.id)
    run(`UPDATE text_progress SET ${fields.join(', ')} WHERE id=?`, params)
    const updated = get('SELECT * FROM text_progress WHERE id=?', [progressRow.id])
    return res.json({ progress: serializeProgress(updated) })
  } catch (err) {
    console.error('[texts] 更新进度失败:', err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

module.exports = { router }
