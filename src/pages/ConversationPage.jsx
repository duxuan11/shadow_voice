import { useState, useRef, useCallback, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Mic, Keyboard, Send, Sparkles } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { createSpeechInput } from '../utils/recallSpeech'
import ChatBubble from '../components/conversation/ChatBubble'
import ReviewPanel from '../components/conversation/ReviewPanel'

// AI 对话页：视频主题多轮对话 + 手动解析
export default function ConversationPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()

  const [video, setVideo] = useState(null)
  const [session, setSession] = useState(null)
  const [topics, setTopics] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [input, setInput] = useState('')
  const [inputMode, setInputMode] = useState('speech')
  const [listening, setListening] = useState(false)
  const [speechError, setSpeechError] = useState(null)
  const [sending, setSending] = useState(false)
  const [aiUnavailable, setAiUnavailable] = useState(false)

  const [reviewing, setReviewing] = useState(false)
  const [review, setReview] = useState(null)

  const speechRef = useRef(null)
  const scrollRef = useRef(null)

  // 数据加载：视频信息
  useEffect(() => {
    fetch('/data/consolidated.json').then(r => r.json()).then(videos => {
      const found = videos.find(v => v.id === id)
      if (!found) { setError('视频未找到'); setLoading(false); return }
      setVideo(found)
      setLoading(false)
    }).catch(() => { setError('加载失败'); setLoading(false) })
  }, [id])

  // 自动滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  // 游客：401 提示登录（后端 authMiddleware 拦截，前端兜底引导）
  const guard = useCallback(() => {
    if (isGuest) { navigate('/login', { state: { from: `/video/${id}/conversation` } }); return true }
    return false
  }, [isGuest, navigate, id])

  // 开始对话：创建会话 + 主题 + AI 开场白
  const startConversation = useCallback(async () => {
    if (guard()) return
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch('/conversation/start', {
        method: 'POST',
        body: JSON.stringify({ videoId: id }),
      })
      if (res.status === 401) { guard(); return }
      const data = await res.json()
      if (!res.ok) { setError(data.error || '启动对话失败'); setLoading(false); return }
      setSession(data.session)
      setTopics(data.topics)
      setAiUnavailable(data.aiUnavailable)
      const msgs = data.opening ? [{ id: 1, role: 'ai', text: data.opening }] : []
      setMessages(msgs)
      if (data.aiUnavailable) setSpeechError('AI 未配置（AI_API_KEY 为空），暂无法对话')
      setLoading(false)
    } catch {
      setError('启动对话失败，请稍后重试')
      setLoading(false)
    }
  }, [authFetch, id, guard])

  // 恢复历史
  const loadHistory = useCallback(async (sessionId) => {
    try {
      const res = await authFetch(`/conversation/${sessionId}`)
      if (res.ok) {
        const data = await res.json()
        setMessages(data.messages)
      }
    } catch { /* 静默 */ }
  }, [authFetch])

  useEffect(() => {
    if (video && !session) {
      const t = setTimeout(() => startConversation(), 0)
      return () => clearTimeout(t)
    }
  }, [video, session, startConversation])

  // 语音
  const beginSpeech = useCallback(() => {
    setSpeechError(null)
    if (listening) return
    if (!speechRef.current) {
      const s = createSpeechInput()
      if (!s.ok) { setSpeechError(s.error); setInputMode('typing'); return }
      speechRef.current = s
    }
    if (speechRef.current.active) speechRef.current.stop()
    setListening(true)
    speechRef.current.start(
      (text) => { setInput(text); setListening(false) },
      (err) => { setListening(false); setSpeechError(err) },
      () => setListening(false)
    )
  }, [listening])

  useEffect(() => () => { speechRef.current?.stop() }, [])

  // 发送
  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || sending || !session) return
    setSending(true)
    setSpeechError(null)
    try {
      // 乐观追加用户消息
      setMessages(prev => [...prev, { id: `tmp-${Date.now()}`, role: 'user', text }])
      setInput('')
      const res = await authFetch(`/conversation/${session.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      const data = await res.json()
      if (res.status === 401) { guard(); return }
      if (!res.ok) {
        setSpeechError(data.error || '发送失败')
        // 回滚乐观消息（服务端未保存）
        setMessages(prev => prev.filter(m => m.text !== text))
        setSending(false)
        return
      }
      if (data.history) {
        setMessages(data.history)
      } else {
        setMessages(prev => [...prev, { id: `ai-${Date.now()}`, role: 'ai', text: data.aiReply }])
      }
    } catch {
      setSpeechError('发送失败，请重试')
      setMessages(prev => prev.filter(m => !String(m.id).startsWith('tmp-')))
    }
    setSending(false)
  }, [input, sending, session, authFetch, guard])

  // 解析（用户手动点）
  const runReview = useCallback(async () => {
    if (!session || reviewing) return
    setReviewing(true)
    setSpeechError(null)
    try {
      const res = await authFetch(`/conversation/${session.id}/review`, { method: 'POST' })
      const data = await res.json()
      if (res.status === 401) { guard(); return }
      if (!res.ok) { setSpeechError(data.error || '解析失败'); setReviewing(false); return }
      setReview(data.review)
      // 解析后刷新历史（score 写回）
      await loadHistory(session.id)
    } catch {
      setSpeechError('解析失败，请稍后重试')
    }
    setReviewing(false)
  }, [session, reviewing, authFetch, guard, loadHistory])

  const toggleMode = useCallback(() => {
    setInputMode(m => m === 'speech' ? 'typing' : 'speech')
    speechRef.current?.stop()
    setListening(false)
  }, [])

  if (loading) return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>

  return (
    <div className="conv-page">
      <div className="conv-header">
        <button onClick={() => navigate(`/video/${id}`)} className="conv-back"><ArrowLeft size={18} /> 返回</button>
        <h2 className="conv-title">💬 AI 对话</h2>
        <span className="conv-video-title">{video?.title}</span>
      </div>

      {error && (
        <div className="conv-error">
          <p>{error}</p>
          <button onClick={() => navigate(`/video/${id}`)}>返回视频</button>
        </div>
      )}

      {!error && (
        <>
          {/* 主题提示条 */}
          {topics && (
            <div className="conv-topics">
              <Sparkles size={14} />
              <span>
                重点词：
                {(topics.words || []).slice(0, 8).map(w => <b key={w.word}>{w.word}</b>)}
                {(topics.phrases || []).slice(0, 4).map(p => <i key={p.phrase}>{p.phrase}</i>)}
              </span>
            </div>
          )}

          {/* 对话区 */}
          <div className="conv-scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="conv-empty">
                <p>{aiUnavailable ? 'AI 未配置，请先配置 AI_API_KEY' : '正在连接 AI...'}</p>
              </div>
            )}
            {messages.map(m => (
              <ChatBubble key={m.id} role={m.role} text={m.text} meta={m.score != null ? `评分 ${m.score}` : null} />
            ))}
            {sending && <div className="conv-typing">AI 正在输入...</div>}
          </div>

          {/* 解析按钮 */}
          {messages.some(m => m.role === 'user') && !review && (
            <button className="conv-review-btn" onClick={runReview} disabled={reviewing}>
              {reviewing ? '解析中...' : '🔍 解析我的回答'}
            </button>
          )}

          {/* 输入区 */}
          {!review && (
            <div className="conv-input-bar">
              {inputMode === 'speech' ? (
                <button
                  className={`conv-mic-btn ${listening ? 'conv-mic-active' : ''}`}
                  onClick={beginSpeech}
                  disabled={aiUnavailable}
                >
                  <Mic size={22} />
                  {listening ? '聆听中...' : '🎤 按住说话'}
                </button>
              ) : (
                <button className="conv-mode-btn" onClick={toggleMode} title="语音输入"><Mic size={18} /></button>
              )}
              <input
                className="conv-input"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') sendMessage() }}
                placeholder={inputMode === 'typing' ? '输入你的回答...' : '识别结果（可修改）'}
                disabled={aiUnavailable}
              />
              <button className="conv-send-btn" onClick={sendMessage} disabled={!input.trim() || sending || aiUnavailable}>
                <Send size={18} />
              </button>
              {inputMode === 'typing' && (
                <button className="conv-mode-btn" onClick={toggleMode} title="打字输入"><Keyboard size={18} /></button>
              )}
            </div>
          )}

          {/* 解析结果 */}
          {review && (
            <ReviewPanel
              review={review}
              onRetry={() => setReview(null)}
              onNewConversation={() => { setSession(null); setReview(null); setMessages([]); setTopics(null); startConversation() }}
              onBack={() => navigate(`/video/${id}`)}
            />
          )}

          {speechError && <p className="conv-error-text">{speechError}</p>}
        </>
      )}
    </div>
  )
}
