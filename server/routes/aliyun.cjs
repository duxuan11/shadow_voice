const express = require('express')
const crypto = require('node:crypto')
const { authMiddleware } = require('../auth.cjs')

const router = express.Router()

const APP_ID = process.env.SSECP_APP_ID || ''
const APP_SECRET = process.env.SSECP_APP_SECRET || ''
const AUTH_URL = process.env.SSECP_AUTH_URL || 'https://api.cloud.ssapi.cn/auth/authorize'
const WARRANT_TTL = Number(process.env.SSECP_WARRANT_TTL) || 7200

// userId -> { warrantId, expiresAt }（内存缓存，重启即失效，可接受）
const cache = new Map()

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

// 官方签名：5 参数按键名升序拼 key=value 以 & 连接（值不做 URL 编码），整串 MD5 小写
function buildSign({ appid, timestamp, userId, clientIp, secret }) {
  const params = {
    appid,
    timestamp,
    user_id: userId,
    user_client_ip: clientIp,
    app_secret: secret,
  }
  const signString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return md5(signString)
}

// POST /api/aliyun/authorize
router.post('/authorize', authMiddleware, async (req, res) => {
  if (!APP_ID || !APP_SECRET) {
    return res.status(500).json({ error: '服务器未配置阿里云口语评测凭据（SSECP_APP_ID / SSECP_APP_SECRET）' })
  }

  const userId = String(req.userId)
  const cached = cache.get(userId)
  if (cached && cached.expiresAt - 60 * 1000 > Date.now()) {
    return res.json({ warrantId: cached.warrantId, expiresAt: cached.expiresAt, applicationId: APP_ID })
  }

  const timestamp = String(Math.floor(Date.now() / 1000))
  const clientIp = req.ip || req.socket.remoteAddress || ''
  const requestSign = buildSign({ appid: APP_ID, timestamp, userId, clientIp, secret: APP_SECRET })

  const form = new URLSearchParams({
    appid: APP_ID,
    timestamp,
    user_id: userId,
    user_client_ip: clientIp,
    request_sign: requestSign,
    warrant_available: String(WARRANT_TTL),
  })

  let resp
  try {
    resp = await fetch(AUTH_URL, { method: 'POST', body: form.toString() })
  } catch {
    return res.status(502).json({ error: '阿里云授权服务不可达' })
  }

  let data
  try {
    data = await resp.json()
  } catch {
    return res.status(502).json({ error: '阿里云授权服务响应异常' })
  }

  if (data.code !== 0 || !data.data || !data.data.warrant_id) {
    return res.status(503).json({ error: `阿里云授权失败: ${data.message || data.msg || data.code}` })
  }

  const expiresAt = (data.data.expire_at || Math.floor(Date.now() / 1000) + WARRANT_TTL) * 1000
  cache.set(userId, { warrantId: data.data.warrant_id, expiresAt })
  res.json({ warrantId: data.data.warrant_id, expiresAt, applicationId: APP_ID })
})

module.exports = { router, buildSign }
