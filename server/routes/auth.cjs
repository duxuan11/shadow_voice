const express = require('express')
const bcrypt = require('bcryptjs')
const { getDb, get, run } = require('../db.cjs')
const { signToken, authMiddleware } = require('../auth.cjs')

const router = express.Router()

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body

  if (!username || !email || !password) {
    return res.status(400).json({ error: '请填写所有字段' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6位' })
  }

  await getDb()
  const existing = get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email])
  if (existing) {
    return res.status(409).json({ error: '用户名或邮箱已被注册' })
  }

  const hash = bcrypt.hashSync(password, 10)
  const result = run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, hash])

  const token = signToken(result.lastInsertRowid)
  res.json({ token, user: { id: result.lastInsertRowid, username, email } })
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ error: '请填写用户名和密码' })
  }

  await getDb()
  const user = get('SELECT * FROM users WHERE username = ?', [username])
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const token = signToken(user.id)
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } })
})

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  await getDb()
  const user = get('SELECT id, username, email, created_at FROM users WHERE id = ?', [req.userId])
  if (!user) {
    return res.status(404).json({ error: '用户不存在' })
  }
  res.json({ user })
})

// GET /api/auth/stats — learning statistics for profile page
router.get('/stats', authMiddleware, async (req, res) => {
  await getDb()
  const dictationCount = get(
    'SELECT COUNT(*) as count FROM dictation_records WHERE user_id = ?',
    [req.userId]
  )
  const vocabCount = get(
    'SELECT COUNT(*) as count FROM vocabulary WHERE user_id = ?',
    [req.userId]
  )
  // Get average dictation score from stored data
  const dictationRecords = all(
    'SELECT data FROM dictation_records WHERE user_id = ?',
    [req.userId]
  )
  let totalScore = 0
  let scoredCount = 0
  for (const r of dictationRecords) {
    try {
      const d = JSON.parse(r.data)
      if (d.score != null) { totalScore += d.score; scoredCount++ }
    } catch {}
  }
  const avgScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0

  res.json({
    totalDictations: dictationCount?.count || 0,
    totalVocabulary: vocabCount?.count || 0,
    averageScore: avgScore,
  })
})

module.exports = router
