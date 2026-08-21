// AI/用户对话气泡：AI 左侧灰色，用户右侧 indigo
export default function ChatBubble({ role, text, meta }) {
  const isUser = role === 'user'
  return (
    <div className={`conv-bubble-row ${isUser ? 'conv-row-user' : 'conv-row-ai'}`}>
      <div className={`conv-bubble ${isUser ? 'conv-bubble-user' : 'conv-bubble-ai'}`}>
        <p className="conv-bubble-text">{text}</p>
        {meta && <p className="conv-bubble-meta">{meta}</p>}
      </div>
    </div>
  )
}
