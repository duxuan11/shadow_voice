// 列表式作答步骤（Step 1 视频复述 / Step 3 情境转换）：每题一个卡片 + 一个作答框，整步一起提交。
import { useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import AnswerInput from './AnswerInput'
import StepFeedback from './StepFeedback'
import { clampServerText } from '../../utils/speakingChallenge'

export default function StageList({
  step,
  items = [],
  record = null,
  chunks = [],
  onSubmit,
  busy = false,
  submitLabel = '提交这一步，看反馈',
}) {
  const [drafts, setDrafts] = useState(() => {
    const init = {}
    for (const a of Array.isArray(record?.answers) ? record.answers : []) {
      init[a.index] = { text: a.text || '', durationMs: a.durationMs || 0, segments: a.segments || 0 }
    }
    return init
  })

  const list = Array.isArray(items) ? items : []
  const filled = list.filter((it) => String(drafts[it.index]?.text || '').trim()).length
  const ready = filled === list.length && list.length > 0

  const update = (index) => (text, meta) => {
    setDrafts((prev) => ({
      ...prev,
      [index]: { text: clampServerText(text), durationMs: meta?.durationMs || 0, segments: meta?.segments || 0 },
    }))
  }

  const submit = () => {
    if (!ready || busy) return
    onSubmit(list.map((it) => ({
      index: it.index,
      text: String(drafts[it.index]?.text || '').trim(),
      durationMs: drafts[it.index]?.durationMs || 0,
      segments: drafts[it.index]?.segments || 0,
    })))
  }

  return (
    <div className="space-y-3">
      {list.map((it, i) => (
        <div key={it.index} className="rounded-2xl border border-slate-100 bg-white px-4 py-3 space-y-2">
          <div className="flex items-start gap-2">
            <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-50 text-indigo-700 text-[11px] font-extrabold">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-800 leading-snug break-words">{it.title}</p>
              {it.subtitle && <p className="text-xs text-slate-500 mt-0.5 break-words">{it.subtitle}</p>}
              {it.hint && <p className="text-[11px] font-bold text-indigo-500 mt-1">提示：{it.hint}</p>}
            </div>
          </div>
          <AnswerInput
            value={drafts[it.index]?.text || ''}
            onChange={update(it.index)}
            disabled={busy}
            rows={3}
          />
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!ready || busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {busy ? 'AI 评分中…' : submitLabel}
        </button>
        <span className="text-[11px] font-bold text-slate-400">{filled}/{list.length} 已作答</span>
      </div>

      {record && (
        <StepFeedback
          step={step}
          feedback={record.feedback}
          chunks={chunks}
          busy={busy}
          onRetry={ready ? submit : undefined}
        />
      )}
    </div>
  )
}
