// TTS 门面：provider 选择 + 缓存 + 统一出口。
// TTS_PROVIDER=edge（默认，免 key）| aliyun（需 ALIYUN_NLS_* 凭据）
const crypto = require('node:crypto')

const edge = require('./edge.cjs')
const aliyun = require('./aliyun.cjs')

const PROVIDER = process.env.TTS_PROVIDER || 'edge'
const EDGE_VOICE = process.env.EDGE_TTS_VOICE || edge.DEFAULT_VOICE
const ALIYUN_VOICE = process.env.ALIYUN_NLS_VOICE || aliyun.DEFAULT_VOICE

// 内存缓存：key = sha1(provider|voice|text) → mp3 Buffer
const cache = new Map()
const CACHE_MAX = 300

function getProvider() {
  return PROVIDER === 'aliyun' ? 'aliyun' : 'edge'
}

function isConfigured() {
  return getProvider() === 'aliyun' ? aliyun.isConfigured() : true
}

function getDefaultVoice() {
  return getProvider() === 'aliyun' ? ALIYUN_VOICE : EDGE_VOICE
}

// 语音白名单（防注入任意 voice 名；aliyun 无凭据时仅返回默认值）
const EDGE_VOICES = new Set([
  'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural',
  'en-US-EmmaMultilingualNeural', 'en-GB-SoniaNeural', 'en-GB-RyanNeural',
])

function normalizeVoice(voice) {
  const v = String(voice || '').trim()
  if (getProvider() === 'aliyun') return v || ALIYUN_VOICE
  return EDGE_VOICES.has(v) ? v : EDGE_VOICE
}

async function synthesize(text, { voice } = {}) {
  const safeText = String(text || '').trim()
  if (!safeText) throw new Error('TTS 文本为空')
  if (safeText.length > 2000) throw new Error('TTS 文本过长（最多 2000 字符）')
  if (!isConfigured()) throw new Error(getProvider() === 'aliyun' ? '阿里云 TTS 未配置' : 'TTS 未配置')

  const v = normalizeVoice(voice)
  const key = crypto.createHash('sha1').update(`${getProvider()}|${v}|${safeText}`).digest('hex')
  if (cache.has(key)) return cache.get(key)

  const buf = getProvider() === 'aliyun'
    ? await aliyun.synthesize(safeText, { voice: v })
    : await edge.synthesize(safeText, { voice: v })

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, buf)
  return buf
}

function getStatus() {
  return {
    provider: getProvider(),
    configured: isConfigured(),
    voice: getDefaultVoice(),
    format: 'mp3',
  }
}

module.exports = { synthesize, getStatus, isConfigured, getDefaultVoice }
