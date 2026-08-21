// 统一 AI Provider：OpenAI 兼容 chat/completions，纯 fetch 零依赖。
// 未配置 AI_API_KEY 时 isConfigured()=false，调用方应走降级路径（绝不允许伪造结果）。
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1'
const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini'
const AI_TIMEOUT_MS = 30000

function isConfigured() {
  return !!AI_API_KEY
}

async function chat(messages, { temperature = 0.7, maxTokens = 1500 } = {}) {
  if (!isConfigured()) throw new Error('AI 未配置（AI_API_KEY 为空）')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
  try {
    const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`AI 请求失败（HTTP ${res.status}）${body.slice(0, 200)}`)
    }
    const data = await res.json()
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (!content) throw new Error('AI 响应为空')
    return content
  } finally {
    clearTimeout(timer)
  }
}

function extractJson(text) {
  let s = String(text || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 输出不含 JSON')
  return JSON.parse(s.slice(start, end + 1))
}

module.exports = { chat, extractJson, isConfigured, AI_MODEL }
