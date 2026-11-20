// 单步反馈卡：分数、逐条语法/地道度（原文 → 更好说法 + 中文原因）、语块使用、词汇与连贯性。
// 「🔊」播英文优化版（服务器 TTS → 浏览器兜底）。语块只显示中文释义（后端不泄露英文答案）。
import { useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle2, RotateCcw, Volume2, XCircle } from 'lucide-react'
import { useAuth } from '../../context/auth-context'
import { createSpeaker } from '../../utils/tts'

const QUALITY_LABEL = { good: '用对了', partial: '意思对但不够自然', wrong: '没说对' }

function scoreTone(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 80) return 'text-emerald-600'
  if (score >= 60) return 'text-amber-600'
  return 'text-rose-600'
}

function IssueList({ title, issues, onSpeak }) {
  if (!Array.isArray(issues) || issues.length === 0) return null
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-extrabold tracking-wider text-slate-400">{title}</p>
      <ul className="space-y-2">
        {issues.map((it, i) => (
          <li key={i} className="rounded-xl bg-white border border-slate-100 px-3 py-2">
            <p className="text-xs text-slate-500 line-through break-words">{it.original || '(片段)'}</p>
            <div className="flex items-start gap-2">
              <p className="flex-1 text-sm font-bold text-emerald-700 break-words">{it.better}</p>
              {it.better && (
                <button
                  type="button"
                  onClick={() => onSpeak(it.better)}
                  className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
                  title="听地道说法"
                >
                  <Volume2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {it.reason && <p className="text-[11px] text-slate-500 mt-0.5">{it.reason}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function StepFeedback({ feedback, chunks = [], busy = false, onRetry }) {
  const { authFetch } = useAuth()
  const speakerRef = useRef(null)

  useEffect(() => {
    speakerRef.current = createSpeaker(authFetch)
    return () => { speakerRef.current?.stop() }
  }, [authFetch])

  const speak = (text) => {
    if (text) speakerRef.current?.speak(text)
  }

  const chunkCn = (chunkId) => {
    const found = (Array.isArray(chunks) ? chunks : []).find((c) => Number(c?.id) === Number(chunkId))
    return found?.cn || `语块 ${Number(chunkId) + 1}`
  }

  if (!feedback) {
    return (
      <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-4 space-y-2">
        <p className="flex items-center gap-1.5 text-sm font-extrabold text-amber-700">
          <AlertTriangle className="h-4 w-4" /> 已保存你的作答，还没有拿到反馈
        </p>
        <p className="text-xs text-amber-700/80">AI 暂时不可用（或未配置）。稍后可以重新获取反馈，答案不会丢。</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> {busy ? '正在获取…' : '重试反馈'}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className={`text-2xl font-black tabular-nums ${scoreTone(feedback.score)}`}>
          {feedback.score == null ? '—' : feedback.score}
        </span>
        <span className="text-[11px] font-extrabold text-slate-400 tracking-wider">本步得分</span>
        {feedback.praise && (
          <span className="ml-auto text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2.5 py-1">
            {feedback.praise}
          </span>
        )}
      </div>

      {Array.isArray(feedback.items) && feedback.items.length > 0 && (
        <div className="space-y-2">
          {feedback.items.map((item) => {
            if (!item.comment && !item.better && !item.grammar?.length && !item.naturalness?.length && item.chunkRestored == null) return null
            return (
              <div key={item.index} className="rounded-xl bg-white border border-slate-100 px-3 py-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-extrabold text-slate-400">第 {Number(item.index) + 1} 题</span>
                  {item.chunkRestored === true && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" /> 语块说对了
                    </span>
                  )}
                  {item.chunkRestored === false && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-600">
                      <XCircle className="h-3.5 w-3.5" /> 语块没说对
                    </span>
                  )}
                </div>
                {item.comment && <p className="text-xs text-slate-600 leading-relaxed">{item.comment}</p>}
                {item.better && (
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-sm font-bold text-emerald-700 break-words">{item.better}</p>
                    <button
                      type="button"
                      onClick={() => speak(item.better)}
                      className="shrink-0 text-indigo-600 hover:text-indigo-800 cursor-pointer"
                      title="听地道说法"
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <IssueList title="语法" issues={item.grammar} onSpeak={speak} />
                <IssueList title="更地道的说法" issues={item.naturalness} onSpeak={speak} />
              </div>
            )
          })}
        </div>
      )}

      {Array.isArray(feedback.chunkUsage) && feedback.chunkUsage.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-extrabold tracking-wider text-slate-400">语块使用</p>
          <ul className="flex flex-wrap gap-1.5">
            {feedback.chunkUsage.map((u) => (
              <li
                key={u.chunkId}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold ${u.quality === 'good' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : u.quality === 'partial' ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-rose-50 text-rose-700 border-rose-100'}`}
                title={QUALITY_LABEL[u.quality] || ''}
              >
                {u.quality === 'good' ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                {chunkCn(u.chunkId)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {feedback.vocabulary?.suggestions?.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-extrabold tracking-wider text-slate-400">
            词汇丰富度{feedback.vocabulary.level ? ` · ${feedback.vocabulary.level}` : ''}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {feedback.vocabulary.suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => speak(s)}
                className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-100 px-2.5 py-1 text-[11px] font-bold text-indigo-700 cursor-pointer hover:bg-indigo-100"
              >
                {s}
                <Volume2 className="h-3 w-3" />
              </button>
            ))}
          </div>
        </div>
      )}

      {feedback.coherence?.summary && (
        <div className="rounded-xl bg-white border border-slate-100 px-3 py-2 space-y-1">
          <p className="text-[11px] font-extrabold tracking-wider text-slate-400">连贯性</p>
          <p className="text-xs text-slate-600 leading-relaxed">{feedback.coherence.summary}</p>
          {feedback.coherence.fillers?.length > 0 && (
            <p className="text-[11px] text-slate-500">填充词：{feedback.coherence.fillers.join(' / ')}</p>
          )}
        </div>
      )}

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-700 cursor-pointer disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" /> {busy ? '正在重新评分…' : '重新提交这一步，再要一次反馈'}
        </button>
      )}
    </div>
  )
}
