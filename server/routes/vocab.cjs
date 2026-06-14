const express = require('express')
const { getDb, get, all, run } = require('../db.cjs')
const { authMiddleware } = require('../auth.cjs')

const router = express.Router()

// GET /api/vocab — list all vocabulary
router.get('/', authMiddleware, async (req, res) => {
  await getDb()
  const rows = all(
    'SELECT id, word, video_id, video_title, created_at FROM vocabulary WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId]
  )
  res.json({ vocabulary: rows })
})

// POST /api/vocab — add a word
router.post('/', authMiddleware, async (req, res) => {
  const { word, videoId, videoTitle } = req.body

  if (!word || !word.trim()) {
    return res.status(400).json({ error: '单词不能为空' })
  }

  const cleanWord = word.trim().toLowerCase()
  await getDb()

  try {
    run(
      'INSERT OR IGNORE INTO vocabulary (user_id, word, video_id, video_title) VALUES (?, ?, ?, ?)',
      [req.userId, cleanWord, videoId || null, videoTitle || null]
    )
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: '添加失败' })
  }
})

// DELETE /api/vocab/:word — remove a word
router.delete('/:word', authMiddleware, async (req, res) => {
  await getDb()
  run('DELETE FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, req.params.word])
  res.json({ ok: true })
})

module.exports = router
