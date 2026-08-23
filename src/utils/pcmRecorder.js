// 16kHz / 16bit / 单声道 PCM 录音器（阿里云一句话识别要求的格式）。
// 用 Web Audio 把麦克风流重采样到 16000Hz（ScriptProcessor + 零增益静音链，
// 不能直连 destination —— 会把麦克风声音放出来造成啸叫）。

// 抽取重采样：把 srcRate 的输入降到 dstRate（每 ratio 个输入采样输出 1 个）。
// 修复（2026-08-25 实测）：旧实现 while(acc>=1){acc-=1;push(input[i])} 是"复制"不是
// "抽取" —— 48k 硬件下每个采样复制 3 份，1s 音频变 9s(16k)，阿里云一句话识别
// 判定无有效语音 → 422 "未识别到有效语音"。现改为每隔 ratio 采样取 1 个。
export function linearDecimate(input, srcRate, dstRate = 16000) {
  const ratio = srcRate / dstRate
  const out = []
  let next = 0
  for (let i = 0; i < input.length; i++) {
    if (i >= next) {
      out.push(input[i])
      next += ratio
    }
  }
  return out
}

export async function createPcmRecorder() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = new Ctx()
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const gain = ctx.createGain()
  gain.gain.value = 0

  const targetRate = 16000
  const floatBuf = [] // Float32 [-1,1]
  let stopped = false

  processor.onaudioprocess = (e) => {
    if (stopped) return
    const input = e.inputBuffer.getChannelData(0)
    const decimated = linearDecimate(input, ctx.sampleRate, targetRate)
    for (let i = 0; i < decimated.length; i++) floatBuf.push(decimated[i])
  }

  const start = () => {
    source.connect(processor)
    processor.connect(gain)
    gain.connect(ctx.destination) // 静音链：保持 onaudioprocess 被拉取但不发声
  }

  const stop = async () => {
    if (stopped) return
    stopped = true
    try { source.disconnect(); processor.disconnect(); gain.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach(t => t.stop())
    await ctx.close().catch(() => {})
    // Float32 → Int16 LE
    const n = floatBuf.length
    const buf = new ArrayBuffer(n * 2)
    const view = new DataView(buf)
    for (let i = 0; i < n; i++) {
      let s = floatBuf[i]
      s = Math.max(-1, Math.min(1, s))
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return buf
  }

  return {
    start,
    stop,
  }
}
