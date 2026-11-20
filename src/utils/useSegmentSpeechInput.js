// 分段语音输入：把连续表达的录音按 60 秒切段（阿里云单次上限），
// 各段文本拼成一段，并统计「说了多久」与「切了几段」。
// 麦克风在段间不断（阿里云 keepStream），Web Speech 则由每轮 onend 自动续识。
// 只负责文本与计时，不碰评分。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSpeechInput } from './useSpeechInput'
import { mergeSegmentText } from './speakingChallenge'

export function useSegmentSpeechInput(authFetch) {
  const [text, setText] = useState('')
  const [segments, setSegments] = useState(0)
  const [activeMs, setActiveMs] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const segStartRef = useRef(0)

  const flush = useCallback((segText) => {
    const now = Date.now()
    const ms = segStartRef.current ? Math.max(0, now - segStartRef.current) : 0
    segStartRef.current = now
    if (segText) setText((prev) => mergeSegmentText(prev, segText))
    setActiveMs((v) => v + ms)
    setSegments((n) => n + 1)
  }, [])

  const speech = useSpeechInput(authFetch, { segmented: true, onSegmentEnd: flush })
  const listening = speech.listening

  // 计时心跳：录音中每 500ms 刷新「含当前段」的已说时长
  useEffect(() => {
    if (!listening) return undefined
    const timer = setInterval(() => {
      const current = segStartRef.current ? Date.now() - segStartRef.current : 0
      setElapsedMs(activeMs + current)
    }, 500)
    return () => clearInterval(timer)
  }, [listening, activeMs])

  const start = useCallback(() => {
    setText('')
    setSegments(0)
    setActiveMs(0)
    setElapsedMs(0)
    segStartRef.current = Date.now()
    speech.start()
  }, [speech])

  const stop = useCallback(() => {
    speech.stop()
  }, [speech])

  const reset = useCallback(() => {
    speech.stop()
    setText('')
    setSegments(0)
    setActiveMs(0)
    setElapsedMs(0)
    segStartRef.current = 0
  }, [speech])

  return useMemo(() => ({
    listening,
    error: speech.error,
    source: speech.source,
    text,
    segments,
    activeMs,
    elapsedMs,
    start,
    stop,
    reset,
  }), [listening, speech.error, speech.source, text, segments, activeMs, elapsedMs, start, stop, reset])
}
