const express = require('express')
const { authMiddleware } = require('../auth.cjs')
const asr = require('../services/asr.cjs')

const router = express.Router()

// GET /api/asr/status — 配置状态（前端决定语音输入源：阿里云 → Web Speech → 打字）
router.get('/status', authMiddleware, (req, res) => {
  res.json({ configured: asr.isConfigured() })
})

// POST /api/asr/recognize — 16kHz/16bit/单声道 PCM → 文字
// body: 原始 PCM 字节。type: () => true 接受任意 Content-Type —— 前端 authFetch
// 曾把 Blob 上传强制标成 application/json，若只认 octet-stream 会落入全局
// express.json() 的 100KB 限制 → PayloadTooLargeError → 500（2026-08-24 实测）
router.post(
  '/recognize',
  authMiddleware,
  express.raw({ type: () => true, limit: '6mb' }),
  async (req, res) => {
    try {
      const pcm = req.body
      if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
        return res.status(400).json({ error: '缺少音频数据' })
      }
      if (!asr.isConfigured()) {
        return res.status(503).json({ error: '阿里云语音识别未配置（ALIYUN_NLS_* 凭据缺失）' })
      }
      let text
      try {
        text = await asr.recognize(pcm)
      } catch (err) {
        return res.status(502).json({ error: err.message })
      }
      if (!text) return res.status(422).json({ error: '未识别到有效语音' })
      res.json({ text })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }
)

module.exports = { router }
