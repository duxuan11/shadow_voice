const express = require('express')
const { getDb, get, all, run } = require('../db.cjs')
const { authMiddleware } = require('../auth.cjs')

const router = express.Router()

const VOCAB_TYPES = new Set(['word', 'phrase', 'core_phrase'])

// 规范化去重 key：小写、去标点（保留撇号）、合并空白。
// 与前端 src/utils/vocabulary.js 的 normalizeVocabKey 保持一致。
function normalizeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeType(type) {
  return VOCAB_TYPES.has(type) ? type : 'word'
}

// 把 DB 行的 sources 解析成数组；老数据没有 sources 时用 video_id/video_title 兜底。
function parseSources(row) {
  if (row.sources) {
    try {
      const arr = JSON.parse(row.sources)
      if (Array.isArray(arr)) return arr.filter(s => s && (s.videoId || s.videoTitle))
    } catch { /* 损坏则走兜底 */ }
  }
  if (row.video_id || row.video_title) {
    return [{ videoId: row.video_id || null, videoTitle: row.video_title || null }]
  }
  return []
}

// 合并来源视频：按 videoId（无则按 videoTitle）去重。
function mergeSources(existing, incoming) {
  const out = Array.isArray(existing) ? existing.slice() : []
  for (const src of incoming) {
    if (!src || (!src.videoId && !src.videoTitle)) continue
    const dup = out.some(s =>
      (src.videoId && s.videoId === src.videoId) ||
      (!src.videoId && s.videoTitle && s.videoTitle === src.videoTitle)
    )
    if (!dup) out.push(src)
  }
  return out
}

// DB 行 → 前端统一模型（content/word/translation/type/phonetic/sources/created_at）。
function toEntry(row) {
  const sources = parseSources(row)
  return {
    id: row.id,
    content: row.content || row.word,
    word: row.word,
    translation: row.translation || '',
    type: row.type || 'word',
    phonetic: row.phonetic || '',
    practice_count: row.practice_count || 0,
    correct_count: row.correct_count || 0,
    last_practiced_at: row.last_practiced_at || null,
    sources,
    // 旧字段保留，兼容 Profile 等既有调用方
    video_id: row.video_id || sources[0]?.videoId || null,
    video_title: row.video_title || sources[0]?.videoTitle || null,
    created_at: row.created_at,
  }
}

// GET /api/vocab — list all vocabulary
router.get('/', authMiddleware, async (req, res) => {
  await getDb()
  try {
    const rows = all(
      'SELECT * FROM vocabulary WHERE user_id = ? ORDER BY created_at DESC, id DESC',
      [req.userId]
    )
    res.json({ vocabulary: rows.map(toEntry) })
  } catch {
    res.status(500).json({ error: '读取失败' })
  }
})

// POST /api/vocab — add a word/phrase/core phrase (dedup by normalized key)
router.post('/', authMiddleware, async (req, res) => {
  const body = req.body || {}
  const rawContent = String(body.content ?? body.word ?? '').trim()
  const key = normalizeKey(rawContent)
  if (!key) {
    return res.status(400).json({ error: '单词/短语不能为空' })
  }

  const type = normalizeType(body.type)
  const translation = String(body.translation ?? '').trim()
  const phonetic = String(body.phonetic ?? '').trim()
  const videoId = body.videoId ?? null
  const videoTitle = body.videoTitle ?? null

  await getDb()
  try {
    const existing = get('SELECT * FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, key])

    if (existing) {
      const sources = mergeSources(parseSources(existing), [{ videoId, videoTitle }])
      run(
        `UPDATE vocabulary
           SET content = ?, translation = ?, type = ?, phonetic = ?, sources = ?,
               video_id = COALESCE(video_id, ?), video_title = COALESCE(video_title, ?)
         WHERE id = ?`,
        [
          existing.content || rawContent,
          existing.translation || translation,
          existing.type || type,
          existing.phonetic || phonetic,
          JSON.stringify(sources),
          videoId,
          videoTitle,
          existing.id,
        ]
      )
      const entry = toEntry(get('SELECT * FROM vocabulary WHERE id = ?', [existing.id]))
      return res.json({ ok: true, added: false, entry })
    }

    const sources = mergeSources([], [{ videoId, videoTitle }])
    const result = run(
      `INSERT INTO vocabulary (user_id, word, content, translation, type, phonetic, sources, video_id, video_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, key, rawContent, translation, type, phonetic, JSON.stringify(sources), videoId, videoTitle]
    )
    const entry = toEntry(get('SELECT * FROM vocabulary WHERE id = ?', [result.lastInsertRowid]))
    res.json({ ok: true, added: true, entry })
  } catch {
    res.status(500).json({ error: '添加失败' })
  }
})

// POST /api/vocab/practice — 记录一次听练结果（每道题仅首次提交由前端保证）
// body: { word: string, correct: boolean }
router.post('/practice', authMiddleware, async (req, res) => {
  const body = req.body || {}
  const key = normalizeKey(body.word)
  if (!key) return res.status(400).json({ error: '单词/短语不能为空' })
  if (typeof body.correct !== 'boolean') return res.status(400).json({ error: 'correct 必须为布尔值' })

  await getDb()
  try {
    const existing = get('SELECT * FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, key])
    if (!existing) return res.status(404).json({ error: '生词不存在' })

    run(
      `UPDATE vocabulary
         SET practice_count = COALESCE(practice_count, 0) + 1,
             correct_count = COALESCE(correct_count, 0) + ?,
             last_practiced_at = datetime('now')
       WHERE id = ?`,
      [body.correct ? 1 : 0, existing.id]
    )
    const entry = toEntry(get('SELECT * FROM vocabulary WHERE id = ?', [existing.id]))
    res.json({ ok: true, entry })
  } catch {
    res.status(500).json({ error: '记录失败' })
  }
})

// DELETE /api/vocab/:word — remove by normalized key (encoded phrase keys supported)
router.delete('/:word', authMiddleware, async (req, res) => {
  await getDb()
  const key = normalizeKey(req.params.word)
  if (!key) return res.status(400).json({ error: '无效内容' })
  run('DELETE FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, key])
  res.json({ ok: true })
})

module.exports = router
