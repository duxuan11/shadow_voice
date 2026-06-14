const express = require('express')
const { getDb, get, run } = require('../db.cjs')
const { authMiddleware } = require('../auth.cjs')

const router = express.Router()

// GET /api/dictation/:videoId — load progress
router.get('/:videoId', authMiddleware, async (req, res) => {
  await getDb()
  const row = get(
    'SELECT data, updated_at FROM dictation_records WHERE user_id = ? AND video_id = ?',
    [req.userId, req.params.videoId]
  )

  if (!row) {
    return res.json({ data: null })
  }

  try {
    res.json({ data: JSON.parse(row.data), updated_at: row.updated_at })
  } catch {
    res.json({ data: null })
  }
})

// PUT /api/dictation/:videoId — save progress
router.put('/:videoId', authMiddleware, async (req, res) => {
  const { data } = req.body
  if (!data) {
    return res.status(400).json({ error: '缺少数据' })
  }

  await getDb()
  const json = JSON.stringify(data)

  run(
    `INSERT INTO dictation_records (user_id, video_id, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, video_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
    [req.userId, req.params.videoId, json]
  )

  res.json({ ok: true })
})

module.exports = router
