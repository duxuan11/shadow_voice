// 阿里云语音输入封装（接口对齐 recallSpeech 的 createSpeechInput）：
//   点开始 → 录音 16k PCM → 再点停止 → 上传服务器识别 → onFinal(text)。
// 未配置/失败 → { ok:false }，调用方降级（Web Speech → 打字）。
import { createPcmRecorder } from './pcmRecorder'

const MAX_SECONDS = 60

export async function createAsrSpeechInput(authFetch) {
  // 预检：服务器是否配置了阿里云 ASR
  try {
    const res = await authFetch('/asr/status')
    if (!res.ok) return { ok: false, error: null }
    const data = await res.json()
    if (!data.configured) return { ok: false, error: null }
  } catch {
    return { ok: false, error: null }
  }

  let rec = null
  let active = false
  let onFinal = null
  let onError = null
  let onEnd = null
  let timer = null

  async function submit() {
    active = false
    clearTimeout(timer)
    if (!rec) { if (onEnd) onEnd(); return }
    let pcm
    try {
      pcm = await rec.stop()
    } catch {
      if (onError) onError('麦克风停止失败，请重试')
      if (onEnd) onEnd()
      return
    }
    if (!pcm || !pcm.byteLength) { if (onEnd) onEnd(); return }
    try {
      const res = await authFetch('/asr/recognize', {
        method: 'POST',
        body: new Blob([pcm], { type: 'application/octet-stream' }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.text) {
        if (onFinal) onFinal(data.text)
      } else if (res.status === 401) {
        // 登录失效由页面统一处理
      } else if (onError) {
        onError(data.error || '语音识别失败，请重试')
      }
    } catch {
      if (onError) onError('语音识别网络错误，请重试')
    }
    if (onEnd) onEnd()
  }

  return {
    ok: true,
    get active() { return active },
    async start(cb, errCb, endCb) {
      onFinal = cb
      onError = errCb
      onEnd = endCb
      active = true
      try {
        rec = await createPcmRecorder()
        rec.start()
        timer = setTimeout(() => submit(), MAX_SECONDS * 1000)
      } catch {
        active = false
        rec = null
        if (errCb) errCb('麦克风启动失败，请检查浏览器权限')
      }
    },
    stop() {
      submit()
    },
  }
}
