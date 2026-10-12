const express = require('express')
const { authMiddleware } = require('../auth.cjs')
const { buildReviewPrompt, reviewFromContent } = require('../services/ai/speak.cjs')
const { chat, isConfigured } = require('../services/ai/provider.cjs')

const router = express.Router()

// POST /api/speak/review — 对一句「看中文说英文」进行 AI 评分
// body: { cn, en, userText }；游客 401；缺字段 400；未配置 AI 或调用失败 503。
router.post('/review', authMiddleware, async (req, res) => {
  try {
    const { cn, en, userText } = req.body || {}
    if (!String(cn ?? '').trim() || !String(en ?? '').trim() || !String(userText ?? '').trim()) {
      return res.status(400).json({ error: '缺少中文句子、参考答案或学习者说的英文' })
    }
    if (!isConfigured()) {
      return res.status(503).json({ error: 'AI 未配置（AI_API_KEY 为空）' })
    }
    const prompt = buildReviewPrompt({ cn, en, userText })
    const content = await chat(
      [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      { temperature: 0.3, maxTokens: 800, timeoutMs: 30000 },
    )
    return res.json({ review: reviewFromContent(content).review })
  } catch (err) {
    console.error('Speak review failed:', err?.message || err)
    return res.status(503).json({ error: 'AI 服务暂不可用，请稍后重试' })
  }
})

module.exports = { router }
