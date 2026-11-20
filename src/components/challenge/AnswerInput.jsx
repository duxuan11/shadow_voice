// 语音/文字作答输入框：麦克风（分段录音：60 秒自动续录）+ 文本框 + 可选计时。
// 识别文本通过 onChange(text, { durationMs, segments }) 交给父组件（父组件是唯一数据源）。
import { useEffect, useRef } from 'react'
import { AlertTriangle, Mic, Square } from 'lucide-react'
import { useAuth } from '../../context/auth-context'
import { useSegmentSpeechInput } from '../../utils/useSegmentSpeechInput'
import { formatDuration } from '../../utils/speakingChallenge'

export default function AnswerInput({
  value = '',
  onChange,
  placeholder = '用英文输入，或点麦克风说出来',
  rows = 3,
  disabled = false,
  showTimer = false,
  targetSeconds = 90,
}) {
  const { authFetch } = useAuth()
  const speech = useSegmentSpeechInput(authFetch)
  const valueRef = useRef(value)
  const changeRef = useRef(onChange)
  const syncedRef = useRef('')

  useEffect(() => { valueRef.current = value }, [value])
  useEffect(() => { changeRef.current = onChange }, [onChange])

  // 新的一段识别结果到了：把累计文本与统计回填给父组件
  useEffect(() => {
    if (!speech.text || speech.text === valueRef.current) return
    if (syncedRef.current === speech.text) return
    syncedRef.current = speech.text
    changeRef.current?.(speech.text, { durationMs: speech.activeMs, segments: speech.segments })
  }, [speech.text, speech.activeMs, speech.segments])

  const toggle = () => {
    if (disabled) return
    if (speech.listening) speech.stop()
    else speech.start()
  }

  const elapsed = speech.listening ? speech.elapsedMs : speech.activeMs
  const targetMs = Math.max(1, Number(targetSeconds) || 90) * 1000
  const ratio = Math.min(100, Math.round((elapsed / targetMs) * 100))

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => changeRef.current?.(e.target.value, { durationMs: speech.activeMs, segments: speech.segments })}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${speech.listening ? 'bg-rose-600 text-white' : 'bg-indigo-50 text-indigo-700 border border-indigo-100 hover:bg-indigo-100'}`}
        >
          {speech.listening ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {speech.listening ? '停止录音' : '语音作答'}
        </button>

        {speech.segments > 0 && (
          <span className="text-[11px] font-bold text-slate-400">
            已录 {speech.segments} 段 · {formatDuration(elapsed)}
          </span>
        )}

        {showTimer && (
          <span className={`text-[11px] font-extrabold tabular-nums ${elapsed >= targetMs ? 'text-emerald-600' : 'text-slate-500'}`}>
            {formatDuration(elapsed)} / {formatDuration(targetMs)}
          </span>
        )}
      </div>

      {showTimer && (
        <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${elapsed >= targetMs ? 'bg-emerald-500' : 'bg-indigo-500'}`}
            style={{ width: `${ratio}%` }}
          />
        </div>
      )}

      {speech.error && (
        <p className="flex items-center gap-1 text-[11px] font-bold text-rose-600">
          <AlertTriangle className="h-3 w-3" /> {speech.error}
        </p>
      )}
    </div>
  )
}
