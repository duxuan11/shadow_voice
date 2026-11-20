// Step 4 话题连续表达：一个话题卡 + 分段录音（60 秒自动续录）+ 计时/语速提示，一次提交。
import { useState } from 'react'
import { Clock, Loader2, Send, Target } from 'lucide-react'
import AnswerInput from './AnswerInput'
import StepFeedback from './StepFeedback'
import { countWords, formatDuration, wpm } from '../../utils/speakingChallenge'

export default function StageTopic({ step = 4, topic = {}, record = null, chunks = [], onSubmit, busy = false }) {
  const [answer, setAnswer] = useState(() => {
    const a = Array.isArray(record?.answers) ? record.answers[0] : null
    return { text: a?.text || '', durationMs: a?.durationMs || 0, segments: a?.segments || 0 }
  })

  const targetSeconds = Number(topic.targetSeconds) || 90
  const words = countWords(answer.text)
  const speed = wpm(words, answer.durationMs || 0)
  const ready = Boolean(String(answer.text || '').trim()) || Number(answer.durationMs) >= 5000

  const submit = () => {
    if (!ready || busy) return
    onSubmit({
      text: String(answer.text || '').trim(),
      durationMs: Number(answer.durationMs) || 0,
      segments: Number(answer.segments) || 0,
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-indigo-600" />
          <p className="text-sm font-extrabold text-slate-800">{topic.promptCn || '围绕视频话题连续表达'}</p>
        </div>
        {topic.promptEn && <p className="text-xs font-bold text-slate-500 break-words">{topic.promptEn}</p>}
        {Array.isArray(topic.pointsCn) && topic.pointsCn.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {topic.pointsCn.map((p, i) => (
              <li key={i} className="rounded-full bg-indigo-50 border border-indigo-100 px-2.5 py-1 text-[11px] font-bold text-indigo-700">{p}</li>
            ))}
          </ul>
        )}
        <p className="flex items-center gap-1 text-[11px] font-bold text-slate-400">
          <Clock className="h-3 w-3" /> 目标 {targetSeconds} 秒 · 尽量用上本视频的语块
        </p>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 space-y-2">
        <AnswerInput
          value={answer.text}
          onChange={(text, meta) => setAnswer({ text, durationMs: meta?.durationMs || 0, segments: meta?.segments || 0 })}
          placeholder="点麦克风开始说，也可以直接打字"
          rows={6}
          disabled={busy}
          showTimer
          targetSeconds={targetSeconds}
        />
        <div className="flex items-center gap-3 text-[11px] font-bold text-slate-400">
          <span>{words} 词</span>
          {speed != null && <span>{speed} wpm</span>}
          {answer.durationMs > 0 && <span>累计 {formatDuration(answer.durationMs)}</span>}
          {answer.segments > 0 && <span>{answer.segments} 段</span>}
        </div>
      </div>

      {record?.note && (
        <p className="text-[11px] font-bold text-amber-600">{record.note}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!ready || busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {busy ? 'AI 点评中…' : '提交这一步，看反馈'}
        </button>
        {!ready && <span className="text-[11px] font-bold text-slate-400">还没有内容：说 5 秒以上或打字</span>}
      </div>

      {record && (
        <StepFeedback step={step} feedback={record.feedback} chunks={chunks} busy={busy} onRetry={ready ? submit : undefined} />
      )}
    </div>
  )
}
