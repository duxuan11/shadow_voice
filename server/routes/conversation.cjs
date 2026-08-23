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

function completeSession(sessionId) {
  run("UPDATE conversation_sessions SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [sessionId])
}

// ── 目标表达：本轮提示用户尝试的短语（round-robin 轮换）──
function pickTargetPhrase(topics, userCount) {
  const phrases = Array.isArray(topics.phrases) ? topics.phrases : []
  if (phrases.length === 0) return null
  const p = phrases[userCount % phrases.length]
  return { phrase: p.phrase, meaning: p.meaning || '' }
}

// ── 路由 ─────────────────────────────────────────────────
// POST /api/conversation/start — 创建会话 + 主题 + AI 开场白
// body: { videoId, newSession?: boolean } — newSession=true 强制新会话（旧的 active 标记 completed）
router.post('/start', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const { videoId, newSession } = req.body || {}
    if (!videoId) return res.status(400).json({ error: '缺少 videoId' })
    const video = findVideo(videoId)
    if (!video) return res.status(404).json({ error: '视频不存在' })

    // 恢复进行中的会话（同一用户同一视频的最新 active 会话，且有消息）
    if (!newSession) {
      const existing = get(
        "SELECT * FROM conversation_sessions WHERE user_id=? AND video_id=? AND status='active' ORDER BY updated_at DESC, id DESC LIMIT 1",
        [req.userId, videoId]
      )
      if (existing) {
        const cnt = get('SELECT COUNT(*) c FROM conversation_messages WHERE session_id=?', [existing.id])
        if (cnt.c > 0) {
          const topics = JSON.parse(existing.topics_json || '{}')
          return res.status(200).json({
            session: { id: existing.id, videoId: existing.video_id, status: existing.status },
            topics,
            opening: null,
            resumed: true,
            aiUnavailable: !isConfigured(),
          })
        }
      }
    } else {
      // 强制新会话：旧的 active 会话收尾（防累积孤儿 active）
      run("UPDATE conversation_sessions SET status='completed', completed_at=datetime('now') WHERE user_id=? AND video_id=? AND status='active'", [req.userId, videoId])
    }

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

// GET /api/conversation/recent — 最近会话列表（必须先于 /:sessionId 注册）
router.get('/recent', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    const rows = all(
      `SELECT s.id, s.video_id, s.status, s.updated_at, s.completed_at, s.review_json,
              (SELECT COUNT(*) FROM conversation_messages m WHERE m.session_id=s.id AND m.role='user') AS user_turns,
              (SELECT text FROM conversation_messages m2 WHERE m2.session_id=s.id AND m2.role='user' ORDER BY m2.id DESC LIMIT 1) AS last_user_text
       FROM conversation_sessions s WHERE s.user_id=? ORDER BY s.updated_at DESC LIMIT ?`,
      [req.userId, limit]
    )
    const list = rows.map(row => {
      let summary = ''
      if (row.review_json) {
        try { summary = JSON.parse(row.review_json).summary || '' } catch { /* 忽略损坏 */ }
      }
      const video = findVideo(row.video_id)
      return {
        id: row.id,
        videoId: row.video_id,
        videoTitle: video ? video.title : row.video_id,
        status: row.status,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        userTurns: row.user_turns,
        lastUserText: row.last_user_text || '',
        summary,
      }
    })
    res.json({ conversations: list })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/conversation/:sessionId/reply — 追加用户话 + AI 回复（原子：AI 成功才落库）
router.post('/:sessionId/reply', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const session = requireOwnSession(req, res, req.params.sessionId)
    if (!session) return
    if (session.status === 'completed') return res.status(400).json({ error: '对话已结束，请开始新对话' })
    const { text } = req.body || {}
    if (!text || !String(text).trim()) return res.status(400).json({ error: '缺少 text' })

    // 轮次上限 20（user 轮次）
    const userCount = all("SELECT COUNT(*) c FROM conversation_messages WHERE session_id=? AND role='user'", [session.id])[0].c
    if (userCount >= 20) return res.status(400).json({ error: '本轮对话已达上限（20 轮），请点击解析' })

    const userText = String(text).trim().slice(0, 2000)

    if (!isConfigured()) {
      touchSession(session.id)
      return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })
    }

    // 历史 = 现有消息 + 待发送的 user 消息（虚拟追加，AI 成功后才真正落库）
    const messages = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const topics = JSON.parse(session.topics_json || '{}')
    const video = findVideo(session.video_id)
    const history = buildHistory([...messages.map(m => ({ role: m.role, text: m.text })), { role: 'user', text: userText }])
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
      // 不写入任何消息 —— 用户消息在 AI 成功前不落库（无孤儿消息）
      return res.status(503).json({ error: 'AI 服务暂不可用，请稍后重试' })
    }

    run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [session.id, 'user', userText])
    run("INSERT INTO conversation_messages (session_id, role, text) VALUES (?,?,?)", [session.id, 'ai', aiReply])
    touchSession(session.id)

    const updated = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const targetPhrase = pickTargetPhrase(topics, userCount)
    res.json({ aiReply, history: updated, targetPhrase })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/conversation/:sessionId/review — 批量解析（完成后会话收尾）
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

    let review
    let degraded = false
    if (!isConfigured()) {
      // 本地降级：不伪造分数
      degraded = true
      review = {
        turns: userMsgs.map((m, i) => ({ turn: i + 1, score: null, issues: [], praise: '已保存，配置 AI key 后可获得逐句解析' })),
        summary: 'AI 未配置，无法解析。配置 AI_API_KEY 后可获得逐句反馈。',
        best_turn: null,
      }
    } else {
      const history = buildHistory(messages.map(m => ({ role: m.role, text: m.text, id: m.id })), { forReview: true })
      const prompt = buildReviewPrompt({ topics: { ...topics, videoTitle: video ? video.title : '' }, history })

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
        degraded = true
        review = {
          turns: userMsgs.map((m, i) => ({ turn: i + 1, score: null, issues: [], praise: '解析失败，请稍后重试' })),
          summary: '解析暂时不可用，请稍后重试。',
          best_turn: null,
        }
      }
    }

    // 写回 user 轮次：按位置映射（turns[i] → userMsgs[i].id），不信任 AI 返回的 turn 编号
    if (Array.isArray(review.turns)) {
      review.turns.forEach((t, i) => {
        const msg = userMsgs[i]
        if (!msg) return
        const score = typeof t.score === 'number' ? t.score : null
        run('UPDATE conversation_messages SET score=?, issues_json=? WHERE id=? AND role=\'user\'',
          [score, JSON.stringify(Array.isArray(t.issues) ? t.issues : []), msg.id])
      })
    }
    // 会话收尾：completed + 保存 review_json（供历史回看）
    run('UPDATE conversation_sessions SET status=\'completed\', completed_at=datetime(\'now\'), updated_at=datetime(\'now\'), review_json=? WHERE id=?',
      [JSON.stringify(review), session.id])
    res.json({ review, degraded })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/conversation/:sessionId — 历史（含 review_json，支持回看已完成会话）
router.get('/:sessionId', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const session = requireOwnSession(req, res, req.params.sessionId)
    if (!session) return
    const messages = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    let review = null
    if (session.review_json) {
      try { review = JSON.parse(session.review_json) } catch { /* 忽略损坏 */ }
    }
    res.json({
      session: {
        id: session.id,
        videoId: session.video_id,
        status: session.status,
        startedAt: session.started_at,
        completedAt: session.completed_at,
        updatedAt: session.updated_at,
        review,
      },
      topics: (() => { try { return JSON.parse(session.topics_json || '{}') } catch { return {} } })(),
      messages,
      aiUnavailable: !isConfigured(),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = { router }
