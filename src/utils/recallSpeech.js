// Web Speech API 封装：语音输入（AI 对话功能）。失败或环境不支持 → 调用方降级打字。
import { micEnvironmentProblem } from './engineSdk'

let recognitionInstance = null

function getRecognition() {
  if (recognitionInstance) return recognitionInstance
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return null
  recognitionInstance = new SR()
  recognitionInstance.lang = 'en-US'
  recognitionInstance.interimResults = false
  recognitionInstance.maxAlternatives = 1
  return recognitionInstance
}

// 返回 { ok, error, start, stop }；start(onFinal, onError, onEnd) 开始监听
export function createSpeechInput() {
  const envProblem = micEnvironmentProblem()
  if (envProblem) return { ok: false, error: envProblem.message }
  const rec = getRecognition()
  if (!rec) return { ok: false, error: '当前浏览器不支持语音识别，请使用打字输入' }
  let onFinal = null
  let onError = null
  let onEnd = null
  let active = false
  let delivered = false

  rec.onresult = (e) => {
    const text = e.results?.[0]?.[0]?.transcript || ''
    if (text && onFinal) {
      delivered = true
      onFinal(text.trim())
    }
  }
  rec.onerror = (e) => {
    active = false
    if (!onError) return
    const err = e?.error || 'unknown'
    if (err === 'aborted') return // 主动 stop，不算错误
    const map = {
      'no-speech': '没有听到声音，请靠近麦克风重试',
      'audio-capture': '麦克风采集失败，请检查麦克风权限',
      'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许',
      'service-not-allowed': '浏览器不允许语音识别服务',
      network: '语音识别网络错误，请重试',
    }
    onError(map[err] || '语音识别出错，请重试')
  }
  rec.onend = () => {
    active = false
    if (!delivered && onEnd) onEnd()
  }
  return {
    ok: true,
    get active() { return active },
    start(cb, errCb, endCb) {
      onFinal = cb
      onError = errCb
      onEnd = endCb
      delivered = false
      try {
        rec.start()
        active = true
      } catch {
        active = false
        if (errCb) errCb('语音识别启动失败，请重试')
      }
    },
    stop() {
      try { rec.stop() } catch { /* ignore */ }
      active = false
    },
  }
}
