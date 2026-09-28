// 统一 AI Provider：OpenAI 兼容 chat/completions，纯 fetch 零依赖。
// 未配置 AI_API_KEY 时 isConfigured()=false，调用方应走降级路径（绝不允许伪造结果）。
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1'
const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini'
const AI_TIMEOUT_MS = 30000

function isConfigured() {
  return !!AI_API_KEY
}

async function chat(messages, { temperature = 0.7, maxTokens = 1500, timeoutMs = AI_TIMEOUT_MS } = {}) {
  if (!isConfigured()) throw new Error('AI 未配置（AI_API_KEY 为空）')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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
  // 1) 剥离 markdown 代码块
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  // 2) 直接解析（最常见的纯净 JSON）
  try {
    return JSON.parse(s)
  } catch {}

  // 3) 定位第一个 { 或 [，按括号配对截取「第一个完整的 JSON 值」，
  //    忽略其后的多余内容（模型常会在 JSON 后追加解释或第二个 JSON 对象）
  const start = s.search(/[\[{]/)
  if (start < 0) throw new Error('AI 输出不含 JSON')
  const end = matchClosing(s, start)
  if (end < 0) throw new Error('AI 输出 JSON 括号不匹配')
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch (e) {
    throw new Error(`AI 输出不是合法 JSON：${e.message}`)
  }
}

// 返回与 s[start] 配对的闭合括号下标（区分对象/数组，跳过字符串字面量）；未闭合返回 -1。
function matchClosing(s, start) {
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

module.exports = { chat, extractJson, isConfigured, AI_MODEL }
