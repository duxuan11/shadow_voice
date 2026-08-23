const express = require('express')
const { authMiddleware } = require('../auth.cjs')
const tts = require('../services/tts/tts.cjs')

const router = express.Router()

// GET /api/tts/status — provider 状态（前端决定走服务器 TTS 还是 SpeechSynthesis 兜底）
router.get('/status', authMiddleware, (req, res) => {
  res.json(tts.getStatus())
})

// POST /api/tts/synthesize — 文本转语音（mp3）
// body: { text, voice? }
// 鉴权是硬要求：无鉴权的 TTS 端点 = 免费语音代理（可被滥用刷流量）
router.post('/synthesize', authMiddleware, async (req, res) => {
  try {
    const { text, voice } = req.body || {}
    if (!text || !String(text).trim()) return res.status(400).json({ error: '缺少 text' })
    if (String(text).length > 2000) return res.status(400).json({ error: 'text 过长（最多 2000 字符）' })

    let buf
    try {
      buf = await tts.synthesize(String(text), { voice })
    } catch (err) {
      return res.status(503).json({ error: err.message })
    }
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.send(Buffer.from(buf))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = { router }
