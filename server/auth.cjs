const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'vidDict-dev-secret-change-in-production'
const JWT_EXPIRES = '30d'

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
