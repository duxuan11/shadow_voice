// TTS 前端封装：优先服务器 TTS（Edge/Aliyun → mp3），失败降级浏览器 SpeechSynthesis。
// 用法：const speaker = createSpeaker(authFetch)；await speaker.speak(text, { onEnd })；speaker.stop()
export function createSpeaker(authFetch) {
  let currentAudio = null
  let serverProbed = false
  let serverOk = false
  let endCallback = null

  // 探一次 /tts/status 决定是否走服务器（失败静默降级）
  async function probeServer() {
    if (serverProbed) return serverOk
    serverProbed = true
    try {
      const res = await authFetch('/tts/status')
      if (res.ok) {
        const data = await res.json()
        serverOk = !!data.configured
      }
    } catch { serverOk = false }
    return serverOk
  }

  async function speakServer(text) {
    const res = await authFetch('/tts/synthesize', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
    if (!res.ok) throw new Error(`TTS ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url)
      if (endCallback) { const cb = endCallback; endCallback = null; cb() }
    }, { once: true })
    await audio.play()
  }

  function speakBrowser(text) {
    if (!window.speechSynthesis) throw new Error('浏览器不支持语音合成')
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'en-US'
    utter.rate = 1
    utter.onend = () => {
      if (endCallback) { const cb = endCallback; endCallback = null; cb() }
    }
    window.speechSynthesis.speak(utter)
  }

  function stop() {
    endCallback = null
    if (currentAudio) {
      try { currentAudio.pause() } catch { /* ignore */ }
      currentAudio = null
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel()
  }

  return {
    stop,
    async speak(text, { onEnd } = {}) {
      stop()
      endCallback = onEnd || null
      const safe = String(text || '').trim()
      if (!safe) return
      try {
        if (await probeServer()) {
          await speakServer(safe)
          return
        }
      } catch { /* 服务器 TTS 失败 → 浏览器兜底 */ }
      try {
        speakBrowser(safe)
      } catch {
        // 双降级都失败：静默，不打扰对话
        endCallback = null
      }
    },
  }
}
