const express = require('express')
const router = express.Router()
const { authMiddleware } = require('../auth.cjs')
const { getDb, run, get } = require('../db.cjs')

// GET /api/progress/:videoId — load progress
router.get('/:videoId', authMiddleware, async (req, res) => {
  try {
    const db = await getDb()
    const row = get(
      'SELECT current_time, duration, completed FROM video_progress WHERE user_id = ? AND video_id = ?',
      [req.userId, req.params.videoId]
    )
    if (!row) return res.json({ progress: null })
    res.json({
      progress: {
        currentTime: row.current_time,
        duration: row.duration,
        completed: !!row.completed
      }
    })
  } catch (err) {
    console.error('Failed to load progress:', err)
    res.status(500).json({ error: '加载进度失败' })
  }
})

// PUT /api/progress/:videoId — save/update progress
router.put('/:videoId', authMiddleware, async (req, res) => {
  try {
    const db = await getDb()
    const { currentTime, duration, completed } = req.body
    run(
      `INSERT INTO video_progress (user_id, video_id, current_time, duration, completed, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, video_id) DO UPDATE SET
         current_time = excluded.current_time,
         duration = excluded.duration,
         completed = excluded.completed,
         updated_at = excluded.updated_at`,
      [req.userId, req.params.videoId, currentTime || 0, duration || 0, completed ? 1 : 0]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Failed to save progress:', err)
    res.status(500).json({ error: '保存进度失败' })
  }
})

module.exports = router
