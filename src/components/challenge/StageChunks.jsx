// Step 2 语块激活：每张卡先「说出英文语块」，再用它造一句自己的话。
// 提交前隐藏英文（evidence 遮点），提交后才显示英文原句与反馈。
import { useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import AnswerInput from './AnswerInput'
import StepFeedback from './StepFeedback'
import { clampServerText, maskEvidence } from '../../utils/speakingChallenge'

export default function StageChunks({ step = 2, chunks = [], record = null, onSubmit, busy = false }) {
  const list = Array.isArray(chunks) ? chunks : []
  // 英文答案只在提交之后显示（提交前只给中文释义与遮住的出处）
  const revealed = Boolean(record?.feedback)
  const [drafts, setDrafts] = useState(() => {
    const init = {}
    for (const a of Array.isArray(record?.answers) ? record.answers : []) {
      init[a.index] = {
        chunkText: a.chunkText || '',
        sentence: a.sentence || '',
        durationMs: a.durationMs || 0,
        segments: a.segments || 0,
      }
    }
    return init
  })

  const filled = list.filter((c) => {
    const d = drafts[c.id] || {}
    return String(d.chunkText || '').trim() || String(d.sentence || '').trim()
  }).length
  const ready = filled === list.length && list.length > 0

  const update = (index, field) => (text, meta) => {
    setDrafts((prev) => ({
      ...prev,
      [index]: {
        ...(prev[index] || { chunkText: '', sentence: '', durationMs: 0, segments: 0 }),
        [field]: clampServerText(text),
        durationMs: meta?.durationMs || prev[index]?.durationMs || 0,
        segments: meta?.segments || prev[index]?.segments || 0,
      },
    }))
  }

  const submit = () => {
    if (!ready || busy) return
    onSubmit(list.map((c) => ({
      index: c.id,
      chunkText: String(drafts[c.id]?.chunkText || '').trim(),
      sentence: String(drafts[c.id]?.sentence || '').trim(),
      durationMs: drafts[c.id]?.durationMs || 0,
      segments: drafts[c.id]?.segments || 0,
    })))
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-bold text-slate-500">看到中文，先自己说出英文，再造句。提交后才显示英文原句。</p>

      {list.map((chunk, i) => {
        const d = drafts[chunk.id] || {}
        return (
          <div key={chunk.id} className="rounded-2xl border border-slate-100 bg-white px-4 py-3 space-y-2">
            <div className="flex items-start gap-2">
              <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-50 text-amber-700 text-[11px] font-extrabold">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold text-slate-800 break-words">{chunk.cn}</p>
                <p className="text-[11px] text-slate-400 mt-0.5 break-words">
                  {revealed ? chunk.evidence : maskEvidence(chunk.evidence)}
                </p>
                {revealed && <p className="text-xs font-bold text-indigo-600 mt-1 break-words">{chunk.en}</p>}
                {chunk.usageCn && <p className="text-[11px] font-bold text-slate-500 mt-1">造句提示：{chunk.usageCn}</p>}
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <AnswerInput
                value={d.chunkText || ''}
                onChange={update(chunk.id, 'chunkText')}
                placeholder="说出这个语块"
                rows={2}
                disabled={busy}
              />
              <AnswerInput
                value={d.sentence || ''}
                onChange={update(chunk.id, 'sentence')}
                placeholder="用它造一句自己的话"
                rows={2}
                disabled={busy}
              />
            </div>
          </div>
        )
      })}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!ready || busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {busy ? 'AI 评分中…' : '提交这一步，看反馈'}
        </button>
        <span className="text-[11px] font-bold text-slate-400">{filled}/{list.length} 已作答</span>
      </div>

      {record && (
        <StepFeedback
          step={step}
          feedback={record.feedback}
          chunks={list}
          busy={busy}
          onRetry={ready ? submit : undefined}
        />
      )}
    </div>
  )
}
