import { Volume2, Square } from 'lucide-react'

// AI/用户对话气泡：AI 左侧灰色，用户右侧 indigo；AI 气泡带朗读按钮
export default function ChatBubble({ role, text, meta, onSpeak, onStop, isSpeaking }) {
  const isUser = role === 'user'
  return (
    <div className={`conv-bubble-row ${isUser ? 'conv-row-user' : 'conv-row-ai'}`}>
      <div className={`conv-bubble ${isUser ? 'conv-bubble-user' : 'conv-bubble-ai'}`}>
        <p className="conv-bubble-text">{text}</p>
        <div className="conv-bubble-foot">
          {!isUser && onSpeak && (
            <button
              className={`conv-speak-btn ${isSpeaking ? 'conv-speak-active' : ''}`}
              onClick={() => (isSpeaking ? onStop() : onSpeak(text))}
              title={isSpeaking ? '停止朗读' : '朗读'}
            >
              {isSpeaking ? <Square size={13} /> : <Volume2 size={13} />}
              {isSpeaking ? '播放中' : '朗读'}
            </button>
          )}
          {meta && <span className="conv-bubble-meta">{meta}</span>}
        </div>
      </div>
    </div>
  )
}
