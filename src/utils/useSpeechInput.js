// 语音输入 hook：阿里云 ASR（服务端已配置）→ 浏览器 Web Speech → 手打兜底。
// 只负责「拿到识别文本」，不碰评分。用法：
//   const speech = useSpeechInput(authFetch)
//   speech.start(text => setUserText(text)); speech.stop()
// 分段模式（话题连续表达用）：
//   useSpeechInput(authFetch, { segmented: true, onSegmentEnd: (text) => {...} })
//   —— 每段识别结果走 onSegmentEnd，麦克风在段间不断（阿里云）或自动续识（Web Speech）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createAsrSpeechInput } from './aliyunAsr'
import { createSpeechInput } from './recallSpeech'
import { selectSpeechSource } from './speechSource'
import { shouldRestartSegment } from './speechSegments'

function hasWebSpeech() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition)
}

export function useSpeechInput(authFetch, { segmented = false, onSegmentEnd } = {}) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)
  const [source, setSource] = useState(null)
  const speechRef = useRef(null)
  const sourceRef = useRef(null)
  const listeningRef = useRef(false)
  const startingRef = useRef(false)
  const segmentedRef = useRef(segmented)
  const onSegmentRef = useRef(onSegmentEnd)

  useEffect(() => { segmentedRef.current = segmented }, [segmented])
  useEffect(() => { onSegmentRef.current = onSegmentEnd }, [onSegmentEnd])

  const setActive = useCallback((active) => {
    listeningRef.current = active
    setListening(active)
  }, [])

  const stop = useCallback(() => {
    try { speechRef.current?.stop() } catch { /* ignore */ }
    setActive(false)
  }, [setActive])

  // 选源 + 建实例；服务端 ASR 不可用时降级浏览器识别
  const buildSpeech = useCallback(async () => {
    const picked = sourceRef.current || selectSpeechSource({
      configured: await probeServerAsr(authFetch),
      hasWebSpeech: hasWebSpeech(),
    })

    if (picked === 'none') {
      return { ok: false, error: '当前浏览器不支持语音输入，请直接输入英文' }
    }

    if (picked === 'aliyun') {
      const s = await createAsrSpeechInput(authFetch, { keepStream: segmentedRef.current })
      if (s.ok) {
        sourceRef.current = 'aliyun'
        return s
      }
      const w = createSpeechInput()
      if (!w.ok) return { ok: false, error: w.error || '语音输入不可用，请直接输入英文' }
      sourceRef.current = 'web'
      return w
    }

    const w = createSpeechInput()
    if (!w.ok) return { ok: false, error: w.error || '语音输入不可用，请直接输入英文' }
    sourceRef.current = 'web'
    return w
  }, [authFetch])

  // 绑定识别回调：分段模式下每段走 onSegmentEnd，Web Speech 静音自动结束后自动续识
  const bindCallbacks = useCallback((onText) => {
    const handleFinal = (text) => {
      if (segmentedRef.current) {
        onSegmentRef.current?.(text)
        return
      }
      setActive(false)
      onText?.(text)
    }
    const handleError = (err) => {
      setActive(false)
      setError(err)
    }
    const handleEnd = () => {
      if (shouldRestartSegment({
        segmented: segmentedRef.current,
        source: sourceRef.current,
        listening: listeningRef.current,
      })) {
        try {
          speechRef.current?.start(handleFinal, handleError, handleEnd)
          return
        } catch { /* 续识失败按结束处理 */ }
      }
      setActive(false)
    }
    speechRef.current?.start(handleFinal, handleError, handleEnd)
  }, [setActive])

  const start = useCallback(async (onText) => {
    if (listeningRef.current) {
      stop()
      return
    }
    // 启动是异步的：两次连点会在等待期间都通过上面的判断，用 startingRef 互斥
    if (startingRef.current) return
    startingRef.current = true
    setError(null)
    try {
      if (!speechRef.current) {
        const built = await buildSpeech()
        if (built.ok === false) {
          setError(built.error)
          setSource('none')
          return
        }
        speechRef.current = built
        setSource(sourceRef.current)
      }
      setActive(true)
      bindCallbacks(onText)
    } catch {
      setActive(false)
      setError('语音输入启动失败，请直接输入英文')
    } finally {
      startingRef.current = false
    }
  }, [buildSpeech, bindCallbacks, setActive, stop])

  useEffect(() => () => { try { speechRef.current?.stop() } catch { /* ignore */ } }, [])

  return useMemo(() => ({ listening, error, source, start, stop }), [listening, error, source, start, stop])
}

async function probeServerAsr(authFetch) {
  try {
    const res = await authFetch('/asr/status')
    const data = res.ok ? await res.json() : null
    return !!data?.configured
  } catch {
    return false
  }
}
