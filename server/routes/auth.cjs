const express = require('express')
const bcrypt = require('bcryptjs')
const rateLimit = require('express-rate-limit')
const { getDb, get, all, run } = require('../db.cjs')
const { signToken, authMiddleware } = require('../auth.cjs')

const router = express.Router()

const registerLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '注册尝试过于频繁，请稍后再试' },
})

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' },
})

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// POST /api/auth/register
router.post('/register', registerLimiter, async (req, res) => {
  const username = (req.body.username || '').trim()
  const email = (req.body.email || '').trim()
  const password = req.body.password || ''

  if (!username || !email || !password) {
    return res.status(400).json({ error: '请填写所有字段' })
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-20 位字母、数字或下划线' })
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6位' })
  }

  await getDb()
  if (get('SELECT id FROM users WHERE username = ?', [username])) {
    return res.status(409).json({ error: '用户名已被注册' })
  }
  if (get('SELECT id FROM users WHERE email = ?', [email])) {
    return res.status(409).json({ error: '邮箱已被注册' })
  }

  const hash = await bcrypt.hash(password, 10)
  let result
  try {
    result = run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, hash])
  } catch {
    return res.status(409).json({ error: '用户名或邮箱已被注册' })
  }

  const token = signToken(result.lastInsertRowid)
  res.json({ token, user: { id: result.lastInsertRowid, username, email } })
})

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const identifier = (req.body.username || req.body.email || '').trim()
  const password = req.body.password || ''

  if (!identifier || !password) {
    return res.status(400).json({ error: '请填写用户名/邮箱和密码' })
  }

  await getDb()
  const user = get('SELECT * FROM users WHERE username = ? OR email = ?', [identifier, identifier])
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  if (!(await bcrypt.compare(password, user.password))) {
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
