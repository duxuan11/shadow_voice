// 本次学习报告：分数、连续表达统计、四堆语块（已掌握 / 能自主使用 / 需要复习 / 本次新引入）、下次建议。
import { Award, Clock, Lightbulb, RefreshCw, Repeat, Sparkles } from 'lucide-react'
import { formatDuration, reportBuckets } from '../../utils/speakingChallenge'

const BUCKET_META = [
  { key: 'mastered', label: '本次掌握', cls: 'bg-emerald-50 text-emerald-700 border-emerald-100', dot: 'bg-emerald-500' },
  { key: 'selfUsed', label: '能自主使用', cls: 'bg-indigo-50 text-indigo-700 border-indigo-100', dot: 'bg-indigo-500' },
  { key: 'review', label: '需要复习', cls: 'bg-amber-50 text-amber-700 border-amber-100', dot: 'bg-amber-500' },
  { key: 'introduced', label: '本次新引入', cls: 'bg-slate-50 text-slate-600 border-slate-200', dot: 'bg-slate-400' },
]

export default function ChallengeReport({ report, onRestart, onRegenerate, onOpenHistory }) {
  const buckets = reportBuckets(report)
  const speaking = report?.speaking || {}
  const longest = Number(speaking.longestSeconds) || 0

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-indigo-100 bg-gradient-to-b from-indigo-50 to-white px-4 py-4 space-y-2">
        <div className="flex items-center gap-2">
          <Award className="h-5 w-5 text-indigo-600" />
          <p className="text-sm font-extrabold text-slate-800">本次学习报告</p>
          <span className="ml-auto text-2xl font-black tabular-nums text-indigo-700">{report?.score ?? '—'}</span>
        </div>
        {report?.summary && <p className="text-xs leading-relaxed text-slate-600">{report.summary}</p>}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-white border border-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
            <Clock className="h-3 w-3" />
            {longest > 0
              ? `最长连续表达 ${formatDuration(longest * 1000)}`
              : '未检测到连续语音（本次只用打字或未开麦）'}
          </span>
          {Number(speaking.totalSeconds) > 0 && (
            <span className="rounded-full bg-white border border-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
              累计开口 {formatDuration(Number(speaking.totalSeconds) * 1000)}
            </span>
          )}
          {Number(speaking.segments) > 0 && (
            <span className="rounded-full bg-white border border-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
              {speaking.segments} 段录音
            </span>
          )}
        </div>
      </div>

      {BUCKET_META.map((meta) => {
        const rows = buckets[meta.key]
        if (!rows.length) return null
        return (
          <div key={meta.key} className="rounded-2xl border border-slate-100 bg-white px-4 py-3 space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-extrabold tracking-wider text-slate-400">
              <span className={`h-2 w-2 rounded-full ${meta.dot}`} /> {meta.label}（{rows.length}）
            </p>
            <ul className="space-y-1.5">
              {rows.map((r) => (
                <li key={r.chunkKey || r.chunkEn} className={`rounded-xl border px-3 py-1.5 ${meta.cls}`}>
                  <p className="text-sm font-bold break-words">{r.chunkCn}</p>
                  <p className="text-[11px] font-bold opacity-70 break-words">{r.chunkEn}</p>
                  {r.whyCn && <p className="text-[11px] mt-0.5">{r.whyCn}</p>}
                </li>
              ))}
            </ul>
          </div>
        )
      })}

      {Array.isArray(report?.nextSuggestions) && report.nextSuggestions.length > 0 && (
        <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 space-y-2">
          <p className="flex items-center gap-1.5 text-[11px] font-extrabold tracking-wider text-slate-400">
            <Lightbulb className="h-3.5 w-3.5" /> 下次训练建议
          </p>
          <ul className="space-y-1.5">
            {report.nextSuggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600 leading-relaxed">
                <Sparkles className="h-3.5 w-3.5 text-indigo-400 shrink-0 mt-0.5" />
                <span className="break-words">{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRestart}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-bold cursor-pointer active:scale-95"
        >
          <Repeat className="h-4 w-4" /> 再练一次
        </button>
        <button
          type="button"
          onClick={onRegenerate}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer active:scale-95"
        >
          <RefreshCw className="h-4 w-4" /> 换一套新挑战
        </button>
        {onOpenHistory && (
          <button
            type="button"
            onClick={onOpenHistory}
            className="text-xs font-bold text-slate-500 hover:text-slate-700 cursor-pointer"
          >
            看历史
          </button>
        )}
      </div>
    </div>
  )
}
