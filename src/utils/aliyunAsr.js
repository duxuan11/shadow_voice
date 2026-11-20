// 阿里云语音输入封装（接口对齐 recallSpeech 的 createSpeechInput）：
//   点开始 → 录音 16k PCM → 再点停止 → 上传服务器识别 → onFinal(text)。
// 未配置/失败 → { ok:false }，调用方降级（Web Speech → 打字）。
// keepStream: true 时到 60 秒自动切段并继续录（麦克风不断），用于话题连续表达。
import { createPcmRecorder } from './pcmRecorder'

const MAX_SECONDS = 60

export async function createAsrSpeechInput(authFetch, { keepStream = false } = {}) {
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

  function scheduleCut() {
    clearTimeout(timer)
    // 默认模式到 60 秒即结束（保持原有行为）；keepStream 模式才自动续录
    timer = setTimeout(() => submit({ cont: keepStream }), MAX_SECONDS * 1000)
  }

  // cont = true：60 秒满载自动切段，上传后继续录（麦克风不断）；false：真正结束
  async function submit({ cont = false } = {}) {
    clearTimeout(timer)
    timer = null
    const keep = cont && active
    if (!rec) {
      active = false
      if (onEnd) onEnd()
      return
    }
    let pcm
    try {
      pcm = await rec.stop({ keepStream: keep })
    } catch {
      active = false
      rec = null
      if (onError) onError('麦克风停止失败，请重试')
      if (onEnd) onEnd()
      return
    }
    if (!keep) rec = null

    if (pcm && pcm.byteLength) {
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
    }

    if (keep) {
      scheduleCut()
      return
    }
    active = false
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
        // keepStream 模式且录音器还活着：不重复申请麦克风，直接继续录
        if (!rec) {
          rec = await createPcmRecorder()
          rec.start()
        }
        scheduleCut()
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
