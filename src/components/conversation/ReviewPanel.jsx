import { useState } from 'react'
import { ArrowLeft, RotateCcw, MessageSquarePlus, CheckCircle2, XCircle } from 'lucide-react'

// 解析结果面板：逐句 score + issues + better 版本
const ISSUE_TYPE_LABEL = {
  grammar: '语法',
  word_choice: '用词',
  naturalness: '自然度',
  missing_expression: '漏用表达',
  incomplete: '不完整',
}

export default function ReviewPanel({ review, onRetry, onNewConversation, onBack }) {
  const [expanded, setExpanded] = useState({})
  const s = review || {}
  const turns = Array.isArray(s.turns) ? s.turns : []

  const toggle = (i) => setExpanded(prev => ({ ...prev, [i]: !prev[i] }))

  return (
    <div className="conv-review">
      <h3 className="conv-review-title">🔍 解析结果</h3>
      {s.summary && <p className="conv-review-summary">{s.summary}</p>}

      {turns.length === 0 && <p className="conv-review-empty">暂无解析结果</p>}

      {turns.map((t, i) => {
        const issues = Array.isArray(t.issues) ? t.issues : []
        const score = typeof t.score === 'number' ? t.score : null
        const isOpen = expanded[i]
        return (
          <div key={i} className={`conv-turn ${score != null && score >= 75 ? 'conv-turn-good' : ''}`}>
            <button className="conv-turn-head" onClick={() => toggle(i)}>
              <span className="conv-turn-num">第 {t.turn || i + 1} 句</span>
              <span className="conv-turn-score">{score != null ? score : '—'}</span>
            </button>
            {isOpen && (
              <div className="conv-turn-body">
                {issues.length === 0 && <p className="conv-turn-ok"><CheckCircle2 size={14} /> 没有明显问题</p>}
                {issues.map((iss, j) => (
                  <div key={j} className="conv-issue">
                    <div className="conv-issue-head">
                      <XCircle size={13} />
                      <span className="conv-issue-type">{ISSUE_TYPE_LABEL[iss.type] || iss.type}</span>
                      {iss.location && <span className="conv-issue-loc">「{iss.location}」</span>}
                    </div>
                    {iss.problem && <p className="conv-issue-problem">{iss.problem}</p>}
                    {iss.suggestion && <p className="conv-issue-suggestion">建议：{iss.suggestion}</p>}
                    {iss.better && (
                      <p className="conv-issue-better">✅ 更好说法：<em>{iss.better}</em></p>
                    )}
                  </div>
                ))}
                {t.praise && <p className="conv-praise">👍 {t.praise}</p>}
              </div>
            )}
          </div>
        )
      })}

      <div className="conv-review-actions">
        <button className="conv-primary-btn" onClick={onNewConversation}>
          <MessageSquarePlus size={16} /> 再来一轮
        </button>
        <button className="conv-secondary-btn" onClick={onRetry}>
          <RotateCcw size={16} /> 重新解析
        </button>
        <button className="conv-secondary-btn" onClick={onBack}>
          <ArrowLeft size={16} /> 返回视频
        </button>
      </div>
    </div>
  )
}
