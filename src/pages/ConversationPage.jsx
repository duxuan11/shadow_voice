import { useState, useRef, useCallback, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Mic, Keyboard, Send, Sparkles, Volume2, VolumeX, Clapperboard, SkipBack, SkipForward, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { createSpeechInput } from '../utils/recallSpeech'
import { createAsrSpeechInput } from '../utils/aliyunAsr'
import { createSpeaker } from '../utils/tts'
import ChatBubble from '../components/conversation/ChatBubble'
import ReviewPanel from '../components/conversation/ReviewPanel'

// AI 对话页：视频主题多轮对话 + 手动解析 + AI 台词朗读 + 视频回看
export default function ConversationPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const querySessionId = searchParams.get('session')
  const { authFetch, isGuest } = useAuth()

  const [video, setVideo] = useState(null)
  const [subs, setSubs] = useState([])
  const [session, setSession] = useState(null)
  const [topics, setTopics] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [aiUnavailable, setAiUnavailable] = useState(false)

  const [input, setInput] = useState('')
  const [inputMode, setInputMode] = useState('speech')
  const [listening, setListening] = useState(false)
  const [speechSource, setSpeechSource] = useState(null) // null | 'aliyun' | 'web' | 'none'
  const [speechError, setSpeechError] = useState(null)
  const [sending, setSending] = useState(false)
  const [hint, setHint] = useState(null) // A4：目标表达提示

  const [reviewing, setReviewing] = useState(false)
  const [review, setReview] = useState(null)

  // A1：朗读
  const speakerRef = useRef(null)
  const [speakingText, setSpeakingText] = useState(null)
  const [muted, setMuted] = useState(() => localStorage.getItem('conv_muted') === '1')

  // A2：视频回看
  const [showVideo, setShowVideo] = useState(false)
  const videoRef = useRef(null)
  const [currentSubIdx, setCurrentSubIdx] = useState(-1)

  // A3：主题素材展开
  const [openTopic, setOpenTopic] = useState(null) // { type: 'word'|'phrase'|'collocation', index }

  const startingRef = useRef(false)
  const speechRef = useRef(null)
  const scrollRef = useRef(null)

  // A1：speaker 在 effect 中创建（render 期访问 ref 会被 lint 拒绝）
  useEffect(() => {
    speakerRef.current = createSpeaker(authFetch)
    return () => { speakerRef.current?.stop(); speakerRef.current = null }
  }, [authFetch])

  // 数据加载：视频信息 + 字幕（字幕用于 A2 回看）
  useEffect(() => {
    fetch('/data/consolidated.json').then(r => r.json()).then(videos => {
      const found = videos.find(v => v.id === id)
      if (!found) { setError('视频未找到'); setLoading(false); return }
      setVideo(found)
      setLoading(false)
      if (found.episode_dir) {
        fetch(`/data/videos/${found.episode_dir}/subtitles.json`)
          .then(r => r.json())
          .then(setSubs)
          .catch(() => {})
      }
    }).catch(() => { setError('加载失败'); setLoading(false) })
  }, [id])

  // 自动滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, review])

  // 静音持久化
  useEffect(() => { localStorage.setItem('conv_muted', muted ? '1' : '0') }, [muted])

  // 卸载时停止朗读/录音
  useEffect(() => () => { speakerRef.current?.stop(); speechRef.current?.stop() }, [])

  // 游客：401 提示登录（后端 authMiddleware 拦截，前端兜底引导）
  const guard = useCallback(() => {
    if (isGuest) { navigate('/login', { state: { from: `/video/${id}/conversation` } }); return true }
    return false
  }, [isGuest, navigate, id])

  // A1：朗读文本（带结束回调刷新播放状态）
  const speakText = useCallback((text) => {
    if (!text) return
    setSpeakingText(text)
    speakerRef.current?.speak(text, { onEnd: () => setSpeakingText((cur) => (cur === text ? null : cur)) })
  }, [])

  const stopSpeaking = useCallback(() => {
    speakerRef.current?.stop()
    setSpeakingText(null)
  }, [])

  const toggleMute = useCallback(() => {
    setMuted(m => {
      if (!m) stopSpeaking()
      return !m
    })
  }, [stopSpeaking])

  // 加载指定会话（A5：?session= 回看历史）
  const loadSession = useCallback(async (sessionId) => {
    setLoading(true)
    try {
      const res = await authFetch(`/conversation/${sessionId}`)
      if (res.status === 401) { guard(); return }
      const data = await res.json()
      if (!res.ok) { setError(data.error || '加载会话失败'); setLoading(false); return }
      setSession({ id: data.session.id, videoId: data.session.videoId, status: data.session.status })
      setTopics(data.topics || null)
      setMessages(data.messages || [])
      setAiUnavailable(!!data.aiUnavailable)
      if (data.session.review) setReview(data.session.review)
      setLoading(false)
    } catch {
      setError('加载会话失败')
      setLoading(false)
    }
  }, [authFetch, guard])

  // 恢复历史（score 写回后刷新）
  const loadHistory = useCallback(async (sessionId) => {
    try {
      const res = await authFetch(`/conversation/${sessionId}`)
      if (res.ok) {
        const data = await res.json()
        setMessages(data.messages)
      }
    } catch { /* 静默 */ }
  }, [authFetch])

  // 开始对话：创建会话 + 主题 + AI 开场白（startingRef 防重入，修复双启动）
  const startConversation = useCallback(async () => {
    if (startingRef.current) return
    startingRef.current = true
    setLoading(true)
    setError(null)
    setReview(null)
    setHint(null)
    try {
      if (guard()) { setLoading(false); return }
      const res = await authFetch('/conversation/start', {
        method: 'POST',
        body: JSON.stringify({ videoId: id }),
      })
      if (res.status === 401) { guard(); setLoading(false); return }
      const data = await res.json()
      if (!res.ok) { setError(data.error || '启动对话失败'); setLoading(false); return }
      setSession(data.session)
      setTopics(data.topics)
      setAiUnavailable(data.aiUnavailable)
      if (data.resumed) {
        // 恢复进行中的会话：拉历史，不重复开场白
        await loadHistory(data.session.id)
      } else {
        const msgs = data.opening ? [{ id: 1, role: 'ai', text: data.opening }] : []
        setMessages(msgs)
        if (data.opening && !muted) speakText(data.opening)
      }
      if (data.aiUnavailable) setSpeechError('AI 未配置（AI_API_KEY 为空），暂无法对话')
      setLoading(false)
    } catch {
      setError('启动对话失败，请稍后重试')
      setLoading(false)
    } finally {
      startingRef.current = false
    }
  }, [authFetch, id, guard, loadHistory, muted, speakText])

  // 主流程：进入页面 → 有 ?session= 则回看，否则开始/恢复会话
  useEffect(() => {
    if (!video || session) return
    if (querySessionId) {
      const t = setTimeout(() => loadSession(querySessionId), 0)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => startConversation(), 0)
    return () => clearTimeout(t)
  }, [video, session, querySessionId, loadSession, startConversation])

  // 语音：输入源三级降级 —— 阿里云 ASR（已配置）→ 浏览器 Web Speech → 打字
  const beginSpeech = useCallback(async () => {
    if (listening) { speechRef.current?.stop(); return } // 再点一次 = 停止并提交（阿里云）/取消（Web Speech）
    setSpeechError(null)
    stopSpeaking() // 录音前停止 AI 朗读，避免麦克风串音
    if (!speechRef.current) {
      let src = speechSource
      if (!src) {
        try {
          const r = await authFetch('/asr/status')
          const d = r.ok ? await r.json() : null
          src = d && d.configured
            ? 'aliyun'
            : (window.SpeechRecognition || window.webkitSpeechRecognition ? 'web' : 'none')
        } catch {
          src = window.SpeechRecognition || window.webkitSpeechRecognition ? 'web' : 'none'
        }
        setSpeechSource(src)
      }
      if (src === 'none') {
        setSpeechError('当前浏览器不支持语音输入，请使用打字')
        setInputMode('typing')
        return
      }
      if (src === 'aliyun') {
        const s = await createAsrSpeechInput(authFetch)
        if (!s.ok) {
          // 阿里云 ASR 不可用 → 降级 Web Speech
          const w = createSpeechInput()
          if (!w.ok) { setSpeechError(w.error || '语音输入不可用，请使用打字'); setInputMode('typing'); return }
          speechRef.current = w
          setSpeechSource('web')
        } else {
          speechRef.current = s
        }
      } else {
        const w = createSpeechInput()
        if (!w.ok) { setSpeechError(w.error); setInputMode('typing'); return }
        speechRef.current = w
      }
    }
    if (speechRef.current.active) speechRef.current.stop()
    setListening(true)
    speechRef.current.start(
      (text) => { setInput(text); setListening(false) },
      (err) => { setListening(false); setSpeechError(err) },
      () => setListening(false)
    )
  }, [listening, stopSpeaking, authFetch, speechSource])

  // 发送
  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || sending || !session) return
    setSending(true)
    setSpeechError(null)
    const tmpId = `tmp-${Date.now()}`
    try {
      // 乐观追加用户消息
      setMessages(prev => [...prev, { id: tmpId, role: 'user', text }])
      setInput('')
      setHint(null)
      const res = await authFetch(`/conversation/${session.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      const data = await res.json()
      if (res.status === 401) { guard(); return }
      if (!res.ok) {
        setSpeechError(data.error || '发送失败')
        setMessages(prev => prev.filter(m => m.id !== tmpId)) // 只回滚本地乐观消息
        setSending(false)
        return
      }
      if (data.history) setMessages(data.history)
      if (data.targetPhrase) setHint(data.targetPhrase)
      if (!muted && data.aiReply) speakText(data.aiReply) // A1：自动朗读 AI 台词
    } catch {
      setSpeechError('发送失败，请重试')
      setMessages(prev => prev.filter(m => m.id !== tmpId))
    }
    setSending(false)
  }, [input, sending, session, authFetch, guard, muted, speakText])

  // 解析（用户手动点）
  const runReview = useCallback(async () => {
    if (!session || reviewing) return
    setReviewing(true)
    setSpeechError(null)
    stopSpeaking()
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
  }, [session, reviewing, authFetch, guard, loadHistory, stopSpeaking])

  const toggleMode = useCallback(() => {
    setInputMode(m => (m === 'speech' ? 'typing' : 'speech'))
    speechRef.current?.stop()
    setListening(false)
  }, [])

  // A2：视频回看 —— 播放时定位当前字幕
  const handleTimeUpdate = useCallback(() => {
    const t = videoRef.current?.currentTime
    if (t == null || !subs.length) return
    let idx = -1
    for (let i = 0; i < subs.length; i++) {
      if (t >= (subs[i].startTime || 0)) idx = i
      else break
    }
    setCurrentSubIdx(idx)
  }, [subs])

  const jumpSub = useCallback((i) => {
    if (i < 0 || i >= subs.length) return
    const vid = videoRef.current
    if (vid) { vid.currentTime = subs[i].startTime; if (vid.paused) vid.play().catch(() => {}) }
    setCurrentSubIdx(i)
  }, [subs])

  // 再来一轮：只清状态（旧会话已被解析置 completed，resume 找不到 → 新建）
  const newConversation = useCallback(() => {
    stopSpeaking()
    setSession(null)
    setReview(null)
    setMessages([])
    setTopics(null)
    setHint(null)
    setOpenTopic(null)
    setCurrentSubIdx(-1)
    navigate(`/video/${id}/conversation`, { replace: true })
  }, [navigate, id, stopSpeaking])

  // A3：主题素材点击展开
  const toggleTopic = useCallback((type, index) => {
    setOpenTopic(cur => (cur && cur.type === type && cur.index === index ? null : { type, index }))
  }, [])

  if (loading) return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>

  const userTurns = messages.filter(m => m.role === 'user').length
  const currentSub = currentSubIdx >= 0 ? subs[currentSubIdx] : null
  const openTopicItem = openTopic
    ? (openTopic.type === 'word' ? (topics?.words || [])[openTopic.index]
       : openTopic.type === 'phrase' ? (topics?.phrases || [])[openTopic.index]
       : (topics?.collocations || [])[openTopic.index])
    : null

  return (
    <div className="conv-page">
      <div className="conv-header">
        <button onClick={() => navigate(`/video/${id}`)} className="conv-back"><ArrowLeft size={18} /> 返回</button>
        <h2 className="conv-title">💬 AI 对话</h2>
        <span className="conv-video-title">{video?.title}</span>
        <div className="conv-header-actions">
          {userTurns > 0 && <span className="conv-turn-badge">{userTurns} 轮</span>}
          <button className={`conv-header-btn ${showVideo ? 'conv-header-btn-active' : ''}`} onClick={() => setShowVideo(v => !v)} title="回看视频">
            <Clapperboard size={16} />
          </button>
          <button className={`conv-header-btn ${muted ? '' : 'conv-header-btn-active'}`} onClick={toggleMute} title={muted ? '开启朗读' : '静音'}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>
      </div>

      {error && (
        <div className="conv-error">
          <p>{error}</p>
          <button onClick={() => navigate(`/video/${id}`)}>返回视频</button>
        </div>
      )}

      {!error && (
        <>
          {/* A2：视频回看面板 */}
          {showVideo && video && (
            <div className="conv-video-panel">
              <video
                ref={videoRef}
                src={video.video_local}
                className="conv-video"
                controls
                onTimeUpdate={handleTimeUpdate}
              />
              <div className="conv-video-sub">
                <button className="conv-video-sub-btn" onClick={() => jumpSub(currentSubIdx - 1)} disabled={currentSubIdx <= 0} title="上一句">
                  <SkipBack size={16} />
                </button>
                <div className="conv-video-sub-text">
                  <p className="en">{currentSub ? currentSub.textEn : '播放视频，这里显示当前字幕'}</p>
                  {currentSub?.textCn && <p className="cn">{currentSub.textCn}</p>}
                </div>
                <button className="conv-video-sub-btn" onClick={() => jumpSub(currentSubIdx + 1)} disabled={currentSubIdx >= subs.length - 1} title="下一句">
                  <SkipForward size={16} />
                </button>
              </div>
            </div>
          )}

          {/* A3：主题素材条（点击展开释义） */}
          {topics && (
            <div className="conv-topics">
              <div className="conv-topics-bar">
                <Sparkles size={14} />
                <span className="conv-topics-label">素材{topics.source === 'local' ? '（本地提取）' : ''}</span>
                {(topics.words || []).slice(0, 8).map((w, i) => (
                  <button key={w.word} className={`conv-topic-chip conv-topic-word ${openTopic?.type === 'word' && openTopic.index === i ? 'conv-topic-open' : ''}`} onClick={() => toggleTopic('word', i)}>
                    {w.word}
                  </button>
                ))}
                {(topics.phrases || []).slice(0, 4).map((p, i) => (
                  <button key={p.phrase} className={`conv-topic-chip conv-topic-phrase ${openTopic?.type === 'phrase' && openTopic.index === i ? 'conv-topic-open' : ''}`} onClick={() => toggleTopic('phrase', i)}>
                    {p.phrase}
                  </button>
                ))}
                {(topics.collocations || []).slice(0, 3).map((c, i) => (
                  <button key={c.collocation} className={`conv-topic-chip conv-topic-colloc ${openTopic?.type === 'collocation' && openTopic.index === i ? 'conv-topic-open' : ''}`} onClick={() => toggleTopic('collocation', i)}>
                    {c.collocation}
                  </button>
                ))}
              </div>
              {openTopicItem && (
                <div className="conv-topic-info">
                  <b>{openTopicItem.word || openTopicItem.phrase || openTopicItem.collocation}</b>
                  {(openTopicItem.meaning || openTopicItem.word) && <span className="mean">{openTopicItem.meaning || '—'}</span>}
                  {openTopic.type === 'word' && openTopicItem.count != null && <span className="count">出现 {openTopicItem.count} 次</span>}
                  {openTopicItem.example && <span className="example">例：{openTopicItem.example}</span>}
                </div>
              )}
            </div>
          )}

          {/* A4：目标表达提示 */}
          {hint && !review && (
            <div className="conv-hint">
              <span className="conv-hint-text">💡 这轮试试用：<b>{hint.phrase}</b></span>
              {hint.meaning && <span className="conv-hint-mean">{hint.meaning}</span>}
              <button className="conv-hint-close" onClick={() => setHint(null)} title="关闭提示"><X size={12} /></button>
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
              <ChatBubble
                key={m.id}
                role={m.role}
                text={m.text}
                meta={m.score != null ? `评分 ${m.score}` : null}
                onSpeak={speakText}
                onStop={stopSpeaking}
                isSpeaking={speakingText === m.text}
              />
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
                  disabled={aiUnavailable || !session}
                >
                  <Mic size={22} />
                  {listening ? (speechSource === 'aliyun' ? '录音中，再点结束' : '聆听中...') : '🎤 说话'}
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
                disabled={aiUnavailable || !session}
              />
              <button className="conv-send-btn" onClick={sendMessage} disabled={!input.trim() || sending || aiUnavailable || !session}>
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
              onNewConversation={newConversation}
              onBack={() => navigate(`/video/${id}`)}
            />
          )}

          {speechError && <p className="conv-error-text">{speechError}</p>}
        </>
      )}
    </div>
  )
}
