import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RotateCcw, EyeOff, ChevronLeft, ChevronRight, Volume2, Check, X as XIcon } from 'lucide-react'

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Generate cloze items from a sentence
// Removes every Nth word (skip short words under 3 chars)
function generateCloze(text, everyNth = 4) {
  const words = text.split(/\s+/).filter(w => w.length > 0)
  const items = words.map((word, idx) => {
    const clean = word.replace(/[^\w'-]/g, '')
    const shouldBlank = (idx + 1) % everyNth === 0 && clean.length >= 3
    return {
      word,
      clean,
      blank: shouldBlank,
      display: shouldBlank ? '_'.repeat(clean.length) : word
    }
  })
  return items
}

export default function ClozePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const audioRef = useRef(null)

  const [video, setVideo] = useState(null)
  const [subtitles, setSubtitles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [showChinese, setShowChinese] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [difficulty, setDifficulty] = useState(4) // every Nth word
  const [finished, setFinished] = useState(false)

  // Cloze state
  const [clozeItems, setClozeItems] = useState([])
  const [userAnswers, setUserAnswers] = useState({})
  const [submitted, setSubmitted] = useState(false)
  const [results, setResults] = useState({})

  // Progress
  const [practiced, setPracticed] = useState(new Set())

  useEffect(() => {
    fetch('/data/consolidated.json')
      .then(r => r.json())
      .then(videos => {
        const found = videos.find(v => v.id === id)
        if (!found) { setError('视频未找到'); setLoading(false); return }
        const subs = (found.subtitles || []).filter(s => s.english_text && s.english_text.trim())
        if (subs.length === 0) { setError('该视频没有可用的英文字幕'); setLoading(false); return }
        setVideo(found)
        setSubtitles(subs)
        setLoading(false)
      })
      .catch(() => { setError('加载失败'); setLoading(false) })
  }, [id])

  // Generate cloze when sentence changes
  useEffect(() => {
    if (subtitles.length === 0 || finished) return
    const sub = subtitles[currentIndex]
    if (!sub) return
    const items = generateCloze(sub.english_text, difficulty)
    setClozeItems(items)
    setUserAnswers({})
    setSubmitted(false)
    setResults({})
  }, [currentIndex, subtitles, difficulty, finished])

  const playAudio = () => {
    const audio = audioRef.current
    const sub = subtitles[currentIndex]
    if (!audio || !sub) return
    audio.currentTime = sub.start_time
    audio.play().then(() => setIsPlaying(true)).catch(() => {})
  }

  const handleTimeUpdate = () => {
    const audio = audioRef.current
    const sub = subtitles[currentIndex]
    if (!audio || !sub) return
    if (audio.currentTime >= sub.end_time) {
      audio.pause()
      setIsPlaying(false)
    }
  }

  // Handle input change
  const handleInputChange = (blankIdx, value) => {
    setUserAnswers(prev => ({ ...prev, [blankIdx]: value }))
  }

  // Submit answers
  const submitAnswers = () => {
    const newResults = {}
    const blankIndices = clozeItems
      .map((item, idx) => item.blank ? idx : -1)
      .filter(idx => idx >= 0)

    blankIndices.forEach(idx => {
      const correct = clozeItems[idx].clean.toLowerCase()
      const user = (userAnswers[idx] || '').trim().toLowerCase()
      newResults[idx] = user === correct
    })

    setResults(newResults)
    setSubmitted(true)
  }

  // Go next
  const goNext = () => {
    setPracticed(prev => new Set([...prev, currentIndex]))
    if (currentIndex < subtitles.length - 1) {
      setCurrentIndex(currentIndex + 1)
    } else {
      setFinished(true)
      if (audioRef.current) audioRef.current.pause()
    }
  }

  const goPrev = () => {
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1)
  }

  const resetProgress = () => {
    setCurrentIndex(0)
    setPracticed(new Set())
    setFinished(false)
    setUserAnswers({})
    setSubmitted(false)
  }

  // Keyboard
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') { navigate(`/video/${id}`); return }
      if (finished) return
      if (e.ctrlKey && e.key === 'r') { e.preventDefault(); playAudio() }
      if (e.ctrlKey && e.key === 'h') { e.preventDefault(); setShowChinese(s => !s) }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); goNext() }
      if (e.ctrlKey && e.key === 'p') { e.preventDefault(); goPrev() }
      if (e.key === 'Enter' && !e.ctrlKey && !submitted) { e.preventDefault(); submitAnswers() }
      if (e.key === 'Enter' && submitted) { e.preventDefault(); goNext() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [currentIndex, submitted, finished, id])

  // Auto-play
  useEffect(() => {
    if (loading || subtitles.length === 0 || finished) return
    const timer = setTimeout(playAudio, 400)
    return () => clearTimeout(timer)
  }, [currentIndex, loading, subtitles.length, finished])

  if (loading) {
    return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>
  }
  if (error) {
    return <div className="error-container"><p>{error}</p><button onClick={() => navigate(`/video/${id}`)}>返回视频</button></div>
  }

  const currentSub = subtitles[currentIndex]
  const blankCount = clozeItems.filter(i => i.blank).length
  const totalPracticed = practiced.size + (submitted ? 1 : 0)
  const correctCount = Object.values(results).filter(Boolean).length

  return (
    <div className="cloze-page">
      <video ref={audioRef} src={video?.video_local || video?.video_url}
        onTimeUpdate={handleTimeUpdate} onEnded={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}
        style={{ display: 'none' }} playsInline crossOrigin="anonymous" preload="auto"
      />

      {/* Header */}
      <div className="dictation-header">
        <button onClick={() => navigate(`/video/${id}`)} className="back-btn">
          <ArrowLeft size={20} /><span>返回</span>
        </button>
        <div className="dictation-header-center">
          <h1 className="dictation-title">{video?.title} — 挖空填词</h1>
        </div>
        <div className="dictation-header-actions">
          <button onClick={resetProgress} className="action-btn-sm" title="重置进度">
            <RotateCcw size={16} /><span>重置</span>
          </button>
        </div>
      </div>

      <div className="dictation-progress-bar">
        <div className="dictation-progress-fill" style={{ width: `${(currentIndex / subtitles.length) * 100}%` }} />
      </div>

      <div className="dictation-stats">
        <span className="stat-item">进度 <strong>{currentIndex + 1}</strong> / {subtitles.length}</span>
        <span className="stat-item stat-done">已练 <strong>{totalPracticed}</strong> 句</span>
        <span className="stat-item">挖空 <strong>{blankCount}</strong> 词</span>
        {submitted && (
          <span className={`stat-item ${correctCount === blankCount ? 'stat-correct' : 'stat-skipped'}`}>
            正确 <strong>{correctCount}</strong> / {blankCount}
          </span>
        )}
        <span className="stat-item">
          难度
          <select className="difficulty-select" value={difficulty} onChange={e => setDifficulty(Number(e.target.value))}>
            <option value={2}>每2词 (难)</option>
            <option value={3}>每3词</option>
            <option value={4}>每4词 (中)</option>
            <option value={5}>每5词</option>
            <option value={6}>每6词 (易)</option>
          </select>
        </span>
      </div>

      {finished ? (
        <div className="dictation-finished">
          <div className="finished-icon">✅</div>
          <h2>挖空填词完成！</h2>
          <p>你练习了 {totalPracticed} 个句子</p>
          <div className="finished-actions">
            <button onClick={resetProgress} className="action-btn">
              <RotateCcw size={18} /><span>重新练习</span>
            </button>
            <button onClick={() => navigate(`/video/${id}`)} className="action-btn">
              <ArrowLeft size={18} /><span>返回视频</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="cloze-main">
          <div className="cloze-card">
            {/* Chinese hint */}
            <div className={`dictation-hint ${showChinese ? 'visible' : 'hidden'}`}>
              {showChinese ? (
                <p className="dictation-chinese">{currentSub?.chinese_text}</p>
              ) : (
                <p className="dictation-chinese-placeholder">
                  <EyeOff size={14} /><span>中文已隐藏 (Ctrl+H 显示)</span>
                </p>
              )}
            </div>

            {/* Audio bar */}
            <div className="shadowing-audio-bar">
              <button onClick={playAudio} className="shadowing-btn shadowing-play-btn" disabled={isPlaying}>
                <Volume2 size={18} />
                <span>{isPlaying ? '播放中...' : '听原声'}</span>
              </button>
              <span className="dictation-time">
                {currentSub ? formatTime(currentSub.start_time) : ''} - {currentSub ? formatTime(currentSub.end_time) : ''}
              </span>
            </div>

            {/* Cloze text */}
            <div className="cloze-text">
              {clozeItems.map((item, idx) => {
                if (!item.blank) {
                  return <span key={idx} className="cloze-word">{item.word} </span>
                }
                const isCorrect = results[idx] === true
                const isWrong = results[idx] === false
                return (
                  <span key={idx} className={`cloze-blank-wrap ${submitted ? (isCorrect ? 'correct' : 'wrong') : ''}`}>
                    {submitted ? (
                      <span className="cloze-filled">
                        {userAnswers[idx] || '___'}
                        {isCorrect && <Check size={14} className="inline-icon correct-icon" />}
                        {isWrong && <XIcon size={14} className="inline-icon wrong-icon" />}
                        {isWrong && <span className="cloze-correct-answer">({item.clean})</span>}
                      </span>
                    ) : (
                      <span className="cloze-input-wrap">
                        <span className="cloze-hint">({item.clean.length}字母)</span>
                        <input
                          type="text"
                          className="cloze-input"
                          value={userAnswers[idx] || ''}
                          onChange={e => handleInputChange(idx, e.target.value)}
                          placeholder={'_'.repeat(item.clean.length)}
                          autoComplete="off"
                          spellCheck={false}
                          size={Math.max(item.clean.length + 2, 6)}
                        />
                      </span>
                    )}
                  </span>
                )
              })}
            </div>

            {/* Submit / nav */}
            <div className="cloze-actions">
              {!submitted ? (
                <button onClick={submitAnswers} className="cloze-submit-btn">
                  检查答案 (Enter)
                </button>
              ) : (
                <div className="cloze-result-summary">
                  <span className={`result-badge ${correctCount === blankCount ? 'all-correct' : ''}`}>
                    {correctCount === blankCount ? '全部正确！' : `${correctCount}/${blankCount} 正确`}
                  </span>
                </div>
              )}
            </div>

            <div className="dictation-nav">
              <button onClick={goPrev} className="nav-btn" disabled={currentIndex === 0}>
                <ChevronLeft size={18} /><span>上一句</span>
              </button>
              <button onClick={goNext} className="nav-btn nav-btn-primary">
                <span>{currentIndex < subtitles.length - 1 ? '下一句' : '完成'}</span>
                <ChevronRight size={18} />
              </button>
            </div>
          </div>

          {/* Sentence navigator */}
          <div className="dictation-timeline">
            {subtitles.map((sub, idx) => {
              let dotClass = 'timeline-dot'
              if (idx === currentIndex) dotClass += ' current'
              else if (practiced.has(idx)) dotClass += ' correct'
              return (
                <button key={sub.id} className={dotClass}
                  onClick={() => {
                    setCurrentIndex(idx)
                    setUserAnswers({})
                    setSubmitted(false)
                  }}
                  title={`第 ${idx + 1} 句: ${sub.english_text?.substring(0, 40)}...`}
                />
              )
            })}
          </div>
        </div>
      )}

      <div className="dictation-cheatsheet">
        <span><kbd>Enter</kbd> 提交答案</span>
        <span><kbd>Ctrl+R</kbd> 重听</span>
        <span><kbd>Ctrl+H</kbd> 切换中文</span>
        <span><kbd>Ctrl+N/P</kbd> 上/下句</span>
        <span><kbd>Esc</kbd> 返回</span>
      </div>
    </div>
  )
}
