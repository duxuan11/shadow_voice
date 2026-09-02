const jwt = require('jsonwebtoken')

const DEV_SECRET = 'shadow-voice-dev-secret-change-in-production'
const JWT_SECRET = process.env.JWT_SECRET || DEV_SECRET
const JWT_EXPIRES = '30d'

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_SECRET) {
    throw new Error('生产环境必须设置 JWT_SECRET 环境变量，且不能使用默认开发密钥')
  }
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' })
  }

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.userId = payload.userId
    next()
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
}

module.exports = { signToken, authMiddleware }
