const express = require('express')
const fs = require('fs')
const path = require('path')
const { getDb, run, get, all } = require('../db.cjs')
const { authMiddleware } = require('../auth.cjs')
const {
  PROMPT_VERSION,
  extractConversationTopics,
  buildOpeningPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  buildHistory,
} = require('../services/ai/conversation.cjs')
const { chat, extractJson, isConfigured } = require('../services/ai/provider.cjs')

const router = express.Router()

// ── 数据读取（视频索引 + 字幕）───────────────────────────
const DATA_DIR = process.env.SHADOW_VOICE_DATA_DIR || path.join(__dirname, '..', '..', 'data')
let indexCache = { at: 0, videos: null }

function loadVideoIndex() {
  const p = path.join(DATA_DIR, 'consolidated.json')
  if (!fs.existsSync(p)) return []
  const mtime = fs.statSync(p).mtimeMs
  if (indexCache.videos && mtime === indexCache.at) return indexCache.videos
  const videos = JSON.parse(fs.readFileSync(p, 'utf-8'))
  indexCache = { at: mtime, videos }
  return videos
}

function loadSubtitles(episodeDir) {
  const p = path.join(DATA_DIR, 'videos', episodeDir, 'subtitles.json')
  if (!fs.existsSync(p)) return []
  const subs = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return Array.isArray(subs) ? subs : []
}

function findVideo(videoId) {
  const videos = loadVideoIndex()
  return videos.find((v) => v.id === videoId) || null
}

// ── 主题提取（ai_cache 按 video_id + PROMPT_VERSION 缓存）──
async function getTopicsForVideo(videoId, video) {
  const cached = get('SELECT result FROM ai_cache WHERE video_id=? AND prompt_version=?', [videoId, PROMPT_VERSION])
  if (cached) {
    try {
      const parsed = JSON.parse(cached.result)
      if (parsed && (Array.isArray(parsed.words) || Array.isArray(parsed.phrases))) {
        return { ...parsed, fromCache: true }
      }
    } catch { /* 缓存损坏则重新提取 */ }
  }
  const subs = loadSubtitles(video.episode_dir)
    .map((s, i) => ({ segmentIndex: i, textEn: s.textEn, textCn: s.textCn, startTime: s.startTime }))
    .filter((s) => s.textEn && s.textEn.trim())
  const topics = await extractConversationTopics({ videoTitle: video.title, level: video.level, segments: subs })
  run(
    `INSERT INTO ai_cache (video_id, prompt_version, model, result) VALUES (?,?,?,?)
     ON CONFLICT(video_id, prompt_version) DO UPDATE SET result=excluded.result, model=excluded.model, created_at=datetime('now')`,
    [videoId, PROMPT_VERSION, topics.source === 'ai' ? 'llm' : 'local-heuristic', JSON.stringify(topics)]
  )
  return { ...topics, fromCache: false }
}

// ── 会话归属 ────────────────────────────────────────────
function requireOwnSession(req, res, sessionId) {
  const row = get('SELECT * FROM conversation_sessions WHERE id=?', [sessionId])
  if (!row) { res.status(404).json({ error: '会话不存在' }); return null }
  if (row.user_id !== req.userId) { res.status(403).json({ error: '无权访问该会话' }); return null }
  return row
}

function touchSession(sessionId) {
  run('UPDATE conversation_sessions SET updated_at=datetime(\'now\') WHERE id=?', [sessionId])
}

// ── 路由 ─────────────────────────────────────────────────
// POST /api/conversation/start — 创建会话 + 主题 + AI 开场白
router.post('/start', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const { videoId } = req.body || {}
    if (!videoId) return res.status(400).json({ error: '缺少 videoId' })
    const video = findVideo(videoId)
    if (!video) return res.status(404).json({ error: '视频不存在' })

    const topics = await getTopicsForVideo(videoId, video)
    const r = run(
      'INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
      [req.userId, videoId, JSON.stringify(topics)]
    )
    const session = get('SELECT * FROM conversation_sessions WHERE id=?', [r.lastInsertRowid])

    let opening = null
    let aiUnavailable = false
    if (isConfigured()) {
      try {
        const prompt = buildOpeningPrompt({ videoTitle: video.title, topics, level: video.level })
        const content = await chat(
          [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
          { temperature: 0.7, maxTokens: 200 }
        )
        // 容错：尝试 JSON {reply}，失败则直接用文本
        try {
          const json = extractJson(content)
          opening = (json && json.reply) || content.trim()
        } catch {
          opening = content.trim()
        }
        if (opening) {
          run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [session.id, 'ai', opening])
        } else {
          opening = null
          aiUnavailable = true
        }
      } catch (err) {
        console.error('[conversation] 开场白失败:', err.message)
        opening = null
        aiUnavailable = true
      }
    } else {
      aiUnavailable = true
    }

    res.status(201).json({
      session: { id: session.id, videoId: session.video_id, status: session.status },
      topics,
      opening,
      aiUnavailable,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/conversation/:sessionId/reply — 追加用户话 + AI 回复
router.post('/:sessionId/reply', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const session = requireOwnSession(req, res, req.params.sessionId)
    if (!session) return
    const { text } = req.body || {}
    if (!text || !String(text).trim()) return res.status(400).json({ error: '缺少 text' })

    // 轮次上限 20（user 轮次）
    const userCount = all("SELECT COUNT(*) c FROM conversation_messages WHERE session_id=? AND role='user'", [session.id])[0].c
    if (userCount >= 20) return res.status(400).json({ error: '本轮对话已达上限（20 轮），请点击解析' })

    const userText = String(text).trim().slice(0, 2000)
    run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [session.id, 'user', userText])

    if (!isConfigured()) {
      touchSession(session.id)
      return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })
    }

    const messages = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const topics = JSON.parse(session.topics_json || '{}')
    const video = findVideo(session.video_id)
    const history = buildHistory(messages.map(m => ({ role: m.role, text: m.text })))
    const prompt = buildReplyPrompt({ topics: { ...topics, videoTitle: video ? video.title : '' }, history, level: video ? video.level : undefined })

    let aiReply
    try {
      const content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.7, maxTokens: 300 }
      )
      try {
        const json = extractJson(content)
        aiReply = (json && json.reply) || content.trim()
      } catch {
        aiReply = content.trim()
      }
    } catch (err) {
      console.error('[conversation] AI 回复失败:', err.message)
      touchSession(session.id)
      return res.status(503).json({ error: 'AI 服务暂不可用，请稍后重试' })
    }

    run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [session.id, 'ai', aiReply])
    touchSession(session.id)

    const updated = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    res.json({ aiReply, history: updated })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/conversation/:sessionId/review — 批量解析
router.post('/:sessionId/review', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const session = requireOwnSession(req, res, req.params.sessionId)
    if (!session) return

    const messages = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const userMsgs = messages.filter(m => m.role === 'user')
    if (userMsgs.length === 0) return res.status(400).json({ error: '还没有可解析的对话内容' })

    const topics = JSON.parse(session.topics_json || '{}')
    const video = findVideo(session.video_id)

    if (!isConfigured()) {
      // 本地降级：不伪造分数
      const turns = userMsgs.map(m => ({ turn: m.id, score: null, issues: [], praise: '已保存，配置 AI key 后可获得逐句解析' }))
      const review = { turns, summary: 'AI 未配置，无法解析。配置 AI_API_KEY 后可获得逐句反馈。', best_turn: null }
      res.json({ review, degraded: true })
      return
    }

    const history = buildHistory(messages.map(m => ({ role: m.role, text: m.text })), { forReview: true })
    const prompt = buildReviewPrompt({ topics: { ...topics, videoTitle: video ? video.title : '' }, history })

    let review
    try {
      const content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.3, maxTokens: 2500 }
      )
      const json = extractJson(content)
      review = {
        turns: Array.isArray(json.turns) ? json.turns : [],
        summary: String(json.summary || ''),
        best_turn: typeof json.best_turn === 'number' ? json.best_turn : null,
      }
    } catch (err) {
      console.error('[conversation] 解析失败:', err.message)
      const turns = userMsgs.map(m => ({ turn: m.id, score: null, issues: [], praise: '解析失败，请稍后重试' }))
      review = { turns, summary: '解析暂时不可用，请稍后重试。', best_turn: null }
    }

    // 写回 user 轮次（按 turn 号匹配 message id）
    for (const t of review.turns) {
      const msgId = t.turn
      const score = typeof t.score === 'number' ? t.score : null
      run('UPDATE conversation_messages SET score=?, issues_json=? WHERE id=? AND role=\'user\'',
        [score, JSON.stringify(Array.isArray(t.issues) ? t.issues : []), msgId])
    }
    touchSession(session.id)
    res.json({ review, degraded: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/conversation/:sessionId — 历史
router.get('/:sessionId', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const session = requireOwnSession(req, res, req.params.sessionId)
    if (!session) return
    const messages = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    res.json({ session, messages })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = { router }
