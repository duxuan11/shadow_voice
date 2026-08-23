// Edge TTS provider：微软 Edge 在线语音合成（无需 key）。
// 协议严格对照 python edge-tts master（rany2/edge-tts）communicate.py + drm.py：
//   - Sec-MS-GEC = SHA256(WindowsFileTime5min + TRUSTED_CLIENT_TOKEN).upper()
//     （2024-11 起微软改用时间戳算法，旧版 SHA256(TOKEN+YYYYMMDD) 已失效）
//   - Sec-MS-GEC-Version = 1-143.0.3650.75（Chromium 版本）
//   - 请求头必须带 Origin(chrome-extension) + User-Agent(Edg/143) + Cookie(muid)，
//     实测缺失任一会 403（Node 原生 WebSocket 不支持自定义头，故用 ws 包）
// 依赖 ws —— alibabacloud-nls 已引入（8.x），非新增顶层依赖。
const crypto = require('node:crypto')
const WebSocket = require('ws')

const TRUSTED_CLIENT_TOKEN='6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const DEFAULT_VOICE = 'en-US-AriaNeural'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const TIMEOUT_MS = 20000
// 微软 Windows 文件时间纪元偏移（1601-01-01 到 1970-01-01，秒）
const WIN_EPOCH = 11644473600

function secMsGecToken() {
  // 当前 Unix 时间 → Windows 文件时间 → 向下取整到 5 分钟 → ×1e7（100ns 间隔）→ 拼 token → SHA256
  const ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH
  const rounded = ticks - (ticks % 300)
  const winTicks = Math.round(rounded * 1e7)
  return crypto.createHash('sha256').update(`${winTicks}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase()
}

function uuidHex() {
  return crypto.randomUUID().replace(/-/g, '')
}

function dateToString() {
  // JS 风格日期串（python: "%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)"）
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)')
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function buildFrame(headers, body) {
  return [...headers.map(([k, v]) => `${k}:${v}`), '', body].join('\r\n')
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Sec-WebSocket-Version': '13',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      },
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', (err) => reject(new Error(`Edge TTS WebSocket 连接失败: ${err.message}`)))
  })
}

// 解析 Edge TTS 帧头（文本帧或二进制帧共用：header 行 + \r\n\r\n + body）
function parseFrame(data) {
  const str = data.toString('utf8')
  const sep = str.indexOf('\r\n\r\n')
  const headerText = sep >= 0 ? str.slice(0, sep) : str
  const headers = {}
  for (const line of headerText.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1)
  }
  return { headers }
}

async function synthesize(text, { voice = DEFAULT_VOICE } = {}) {
  const safeText = String(text || '').trim()
  if (!safeText) throw new Error('TTS 文本为空')
  // 服务端不支持的控制字符替换为空格（python remove_incompatible_characters）
  const cleaned = safeText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')

  const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${uuidHex()}&Sec-MS-GEC=${secMsGecToken()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  const ws = await openSocket(url)

  return new Promise((resolve, reject) => {
    const chunks = []
    let failed = null
    let settled = false
    const timer = setTimeout(() => finish(new Error('Edge TTS 超时')), TIMEOUT_MS)

    function finish(err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      if (err) reject(err)
      else resolve(Buffer.concat(chunks))
    }

    ws.on('message', (data, isBinary) => {
      if (typeof data === 'string') data = Buffer.from(data, 'utf8')
      if (!isBinary) {
        const { headers } = parseFrame(data)
        const pathName = headers.path || ''
        if (pathName === 'response') {
          const sep = data.toString('utf8').indexOf('\r\n\r\n')
          const body = sep >= 0 ? data.toString('utf8').slice(sep + 4) : ''
          try {
            const json = JSON.parse(body || '{}')
            if (json.result && json.result.ResultType && !/^Success/i.test(json.result.ResultType)) {
              failed = new Error(`Edge TTS 合成失败: ${json.result.ResultType}`)
            }
          } catch { /* 忽略非 JSON 响应帧 */ }
        } else if (pathName === 'turn.end') {
          finish(failed || null)
        }
        return
      }
      // 二进制帧：前 2 字节 = 头长度（大端），随后 header 文本 + \r\n + 音频 payload
      if (data.length < 4) return
      const headerLen = data.readUInt16BE(0)
      const headerText = data.slice(2, 2 + headerLen).toString('utf8')
      let payloadStart = 2 + headerLen
      if (data[payloadStart] === 0x0d && data[payloadStart + 1] === 0x0a) payloadStart += 2
      const pathMatch = headerText.match(/^Path:(\S+)/im)
      if (pathMatch && pathMatch[1] === 'audio') {
        chunks.push(data.slice(payloadStart))
      }
    })

    ws.on('close', () => {
      if (settled) return
      if (failed) finish(failed)
      else if (chunks.length > 0) finish(null)
      else finish(new Error('Edge TTS 连接提前关闭'))
    })
    ws.on('error', () => finish(new Error('Edge TTS 传输错误')))

    // 1) speech.config（输出格式）
    ws.send(buildFrame(
      [['X-Timestamp', dateToString()], ['Content-Type', 'application/json; charset=utf-8'], ['Path', 'speech.config']],
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: OUTPUT_FORMAT,
            },
          },
        },
      })
    ))
    // 2) SSML（注意 X-Timestamp 末尾带 Z —— 微软 Edge 的已知怪癖，照抄 python 实现）
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
      `<voice name='${voice}'>` +
      `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(cleaned)}</prosody>` +
      `</voice></speak>`
    ws.send(buildFrame(
      [['X-RequestId', uuidHex()], ['Content-Type', 'application/ssml+xml'], ['X-Timestamp', `${dateToString()}Z`], ['Path', 'ssml']],
      ssml
    ))
  })
}

module.exports = { synthesize, DEFAULT_VOICE, OUTPUT_FORMAT }
