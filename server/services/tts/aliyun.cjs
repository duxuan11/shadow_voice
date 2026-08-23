// Aliyun NLS TTS provider：官方 alibabacloud-nls SDK（SpeechSynthesizer）。
// 需要三件套凭据（阿里云控制台开通智能语音交互后获取）：
//   ALIYUN_NLS_APP_KEY        项目 Appkey
//   ALIYUN_ACCESS_KEY_ID      主账号/子账号 AccessKey
//   ALIYUN_ACCESS_KEY_SECRET
// 可选：ALIYUN_NLS_REGION（默认 cn-shanghai，网关 URL 按区域拼接）、
//       ALIYUN_NLS_VOICE（默认 aixia，英语教学建议在控制台确认英语发音人后配置）。
// 说明：本 provider 按官方 SDK 文档实现，当前环境无阿里云凭据，未经真实调用验证；
//       有凭据后请用 scripts/tts-live-test.cjs 实测。
const { RPCClient } = require('@alicloud/pop-core')

const APP_KEY = process.env.ALIYUN_NLS_APP_KEY || ''
const AK_ID = process.env.ALIYUN_ACCESS_KEY_ID || ''
const AK_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || ''
const REGION = process.env.ALIYUN_NLS_REGION || 'cn-shanghai'
const DEFAULT_VOICE = process.env.ALIYUN_NLS_VOICE || 'aixia'
const GATEWAY_URL = `wss://nls-gateway-${REGION}.aliyuncs.com/ws/v1`
// Token 端点（与官方 SDK getToken 默认一致：nls-meta.<region>.aliyuncs.com）
const META_HOST = `nls-meta.${REGION}.aliyuncs.com`
const TIMEOUT_MS = 30000

let tokenCache = null // { token, expireAt }

function isConfigured() {
  return !!(APP_KEY && AK_ID && AK_SECRET)
}

// CreateToken 响应有两种形状（实测 @alicloud/pop-core 1.8.0 + 当前接口）：
//   旧：{ Token: '<字符串>', ExpireTime: 秒 }
//   新：{ ErrMsg: '', Token: { UserId, Id: '<字符串>', ExpireTime: 秒 } }
// 若把新形状的对象当字符串用，ASR/TTS 把 token 放进 header/参数时会抛
// "Cannot convert object to primitive value"（用户实测 500 根因）。
function parseTokenResponse(res) {
  const t = res && res.Token
  const token = typeof t === 'string' ? t : (t && t.Id)
  const expireRaw = (t && typeof t === 'object' && t.ExpireTime) || (res && res.ExpireTime)
  const expireAt = expireRaw ? expireRaw * 1000 : Date.now() + 24 * 3600 * 1000
  return { token, expireAt }
}

async function getToken() {
  if (tokenCache && tokenCache.expireAt - 5 * 60 * 1000 > Date.now()) return tokenCache.token
  const client = new RPCClient({
    accessKeyId: AK_ID,
    accessKeySecret: AK_SECRET,
    endpoint: `http://${META_HOST}`,
    apiVersion: '2019-02-28',
  })
  const res = await client.request('CreateToken')
  const { token, expireAt } = parseTokenResponse(res)
  if (!token) throw new Error(`阿里云 NLS Token 获取失败: ${JSON.stringify(res).slice(0, 200)}`)
  tokenCache = { token, expireAt }
  return token
}

async function synthesize(text, { voice = DEFAULT_VOICE } = {}) {
  const safeText = String(text || '').trim()
  if (!safeText) throw new Error('TTS 文本为空')
  if (!isConfigured()) throw new Error('阿里云 TTS 未配置（缺少 ALIYUN_NLS_APP_KEY / ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET）')

  // 延迟加载 SDK（未配置时不引入开销）
  const Nls = require('alibabacloud-nls')
  const token = await getToken()
  const synthesizer = new Nls.SpeechSynthesizer({ url: GATEWAY_URL, appkey: APP_KEY, token })

  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    const timer = setTimeout(() => { if (!settled) finish(new Error('阿里云 TTS 超时')) }, TIMEOUT_MS)

    function finish(err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { synthesizer.shutdown() } catch { /* ignore */ }
      if (err) reject(err)
      else resolve(Buffer.concat(chunks))
    }

    synthesizer.on('data', (buf) => {
      if (Buffer.isBuffer(buf)) chunks.push(buf)
      else if (buf && buf.buffer) chunks.push(Buffer.from(buf))
    })
    synthesizer.on('completed', (str) => {
      try {
        const info = JSON.parse(str)
        if (info.header && info.header.status !== 20000000) {
          finish(new Error(`阿里云 TTS 完成但状态异常: ${info.header.status}`))
          return
        }
      } catch { /* 忽略解析 */ }
      finish(null)
    })
    synthesizer.on('failed', (str) => {
      let msg = '阿里云 TTS 合成失败'
      try {
        const info = JSON.parse(str)
        if (info.header && info.header.message) msg += `: ${info.header.message}`
      } catch { /* 忽略 */ }
      finish(new Error(msg))
    })

    const params = synthesizer.defaultStartParams(voice)
    params.format = 'mp3'
    params.sample_rate = 24000
    synthesizer.start(params, true).catch((err) => {
      if (!settled) finish(new Error(`阿里云 TTS 启动失败: ${String(err).slice(0, 200)}`))
    })
  })
}

module.exports = { synthesize, DEFAULT_VOICE, isConfigured, getToken, REGION, parseTokenResponse }
