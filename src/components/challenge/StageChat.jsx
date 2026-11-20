// Step 5 AI 对话：AI 扮演对话伙伴就视频话题聊 5–8 轮；满 5 轮可结束并出报告。
import { useState } from 'react'
import { Loader2, MessageCircle, Send, Sparkles, StopCircle } from 'lucide-react'
import AnswerInput from './AnswerInput'
import StepFeedback from './StepFeedback'
import { CHAT_MAX_TURNS, canFinishChat, chatUserTurns } from '../../utils/speakingChallenge'

export default function StageChat({
  step = 5,
  messages = [],
  record = null,
  chunks = [],
  onSend,
  onFinish,
  busy = false,
  finishing = false,
}) {
  const [draft, setDraft] = useState({ text: '', durationMs: 0, segments: 0 })
  const list = Array.isArray(messages) ? messages : []
  const { can, reason } = canFinishChat(list)
  const turns = chatUserTurns(list)
  const started = list.length > 0

  const send = () => {
    if (busy || finishing) return
    const text = String(draft.text || '').trim()
    if (!text && started) return
    onSend(text ? { text, durationMs: draft.durationMs, segments: draft.segments } : null)
    setDraft({ text: '', durationMs: 0, segments: 0 })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <MessageCircle className="h-4 w-4 text-indigo-600" />
        <p className="text-sm font-extrabold text-slate-800">和 AI 聊聊这个视频的话题</p>
        <span className="ml-auto text-[11px] font-extrabold text-slate-400 tabular-nums">
          {Math.min(turns, CHAT_MAX_TURNS)}/{CHAT_MAX_TURNS} 轮
        </span>
      </div>

      {!started ? (
        <div className="rounded-2xl border border-slate-100 bg-white px-4 py-5 space-y-3 text-center">
          <Sparkles className="h-6 w-6 text-indigo-500 mx-auto" />
          <p className="text-sm font-bold text-slate-700">AI 会用 1–2 句英文接住话题，再问你一个问题。</p>
          <p className="text-[11px] text-slate-400">目标：至少聊 5 轮，尽量自然带出本视频的语块。</p>
          <button
            type="button"
            onClick={() => onSend(null)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer disabled:opacity-50 active:scale-95"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
            {busy ? 'AI 正在开口…' : '开始对话'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed break-words ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-100 text-slate-800'}`}>
                {m.text}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-white border border-slate-100 px-3 py-2 text-sm text-slate-400">AI 正在回复…</div>
            </div>
          )}
        </div>
      )}

      {started && (
        <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 space-y-2">
          <AnswerInput
            value={draft.text}
            onChange={(text, meta) => setDraft({ text, durationMs: meta?.durationMs || 0, segments: meta?.segments || 0 })}
            placeholder="用英文回一句（也可点麦克风）"
            rows={2}
            disabled={busy || finishing || turns >= CHAT_MAX_TURNS}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={send}
              disabled={busy || finishing || !String(draft.text || '').trim() || turns >= CHAT_MAX_TURNS}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
            >
              <Send className="h-4 w-4" /> 发送
            </button>
            <button
              type="button"
              onClick={onFinish}
              disabled={!can || busy || finishing}
              title={can ? '结束对话并生成报告' : reason}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
            >
              {finishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <StopCircle className="h-4 w-4" />}
              {finishing ? '正在生成报告…' : '结束对话并生成报告'}
            </button>
            {!can && turns < CHAT_MAX_TURNS && (
              <span className="text-[11px] font-bold text-slate-400">{reason}</span>
            )}
          </div>
        </div>
      )}

      {record?.feedback && (
        <StepFeedback step={step} feedback={record.feedback} chunks={chunks} />
      )}
    </div>
  )
}
