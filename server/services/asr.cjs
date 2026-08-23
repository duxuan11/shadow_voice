// 阿里云 NLS 语音识别（ASR）：一句话识别 REST API。
// 复用 TTS 的 ALIYUN_NLS_* 三件套凭据与 token（NLS token 通用）。
// 输入：16kHz / 16bit / 单声道 PCM（前端 Web Audio 重采样后上传）。
// 未配置 → isConfigured()=false，调用方降级（浏览器 Web Speech / 打字）。
const aliyun = require('./tts/aliyun.cjs')

const APP_KEY = process.env.ALIYUN_NLS_APP_KEY || ''
const REGION = aliyun.REGION
const ASR_URL = `https://nls-gateway-${REGION}.aliyuncs.com/stream/v1/asr`
const TIMEOUT_MS = 30000
const MAX_BYTES = 5 * 1024 * 1024 // ~60s 音频

function isConfigured() {
  return aliyun.isConfigured()
}

// pcmBuffer: Buffer（Int16 LE, 16000Hz）
async function recognize(pcmBuffer) {
  if (!isConfigured()) throw new Error('阿里云语音识别未配置（缺少 ALIYUN_NLS_APP_KEY / ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET）')
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) throw new Error('音频为空')
  if (pcmBuffer.length > MAX_BYTES) throw new Error('音频过长（最长约 60 秒）')

  const token = await aliyun.getToken()
  const url = `${ASR_URL}?appkey=${encodeURIComponent(APP_KEY)}&format=pcm&sample_rate=16000&enable_punctuation_prediction=true&enable_inverse_text_normalization=true`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-NLS-Token': token,
        'Content-Type': 'application/octet-stream',
      },
      body: pcmBuffer,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`阿里云 ASR 请求失败（HTTP ${res.status}）${body.slice(0, 200)}`)
  }
  const data = await res.json().catch(() => null)
  if (!data || data.status !== 20000000) {
    throw new Error(`阿里云 ASR 识别失败: ${(data && (data.message || data.status)) || '响应异常'}`)
  }
  // 实测（2026-08-25）：一句话识别 REST 的 result 是字符串（如 "hello world"），
  // 旧解析 data.result.text 在字符串上恒为 undefined → 一律 422 "未识别到有效语音"。
  // 双兼容：新形状 result:"文本" 与旧 SDK 形状 result:{text:"文本"}。
  const r = data && data.result
  const text = typeof r === 'string' ? r : (r && r.text)
  return String(text || '').trim()
}

module.exports = { recognize, isConfigured, MAX_BYTES }
