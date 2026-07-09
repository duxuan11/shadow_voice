import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RotateCcw, EyeOff, Eye, ChevronLeft, ChevronRight, Volume2, Send, SkipForward, Headphones } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// --- Spell-check engine ---
function normalizeText(text) {
  return text.replace(/[^\w\s'-]/g, '').replace(/\s+/g, ' ').trim()
}

function tokenize(text) {
  return normalizeText(text).split(' ')
}

function checkSpelling(userInput, correctText) {
  const userWords = tokenize(userInput)
  const correctWords = tokenize(correctText)
  const maxLen = Math.max(userWords.length, correctWords.length)
  const results = []

  for (let i = 0; i < maxLen; i++) {
    const uw = userWords[i]
    const cw = correctWords[i]

    if (uw === undefined) {
      // Missing word
      results.push({ type: 'missing', expected: cw })
    } else if (cw === undefined) {
      // Extra word
      results.push({ type: 'extra', user: uw })
    } else if (uw.toLowerCase() === cw.toLowerCase()) {
      results.push({ type: 'correct', word: uw })
    } else {
      results.push({ type: 'wrong', user: uw, expected: cw })
    }
  }
  return results
}

function isAllCorrect(spellResults) {
  return spellResults.every(r => r.type === 'correct')
}

// --- Main component ---
export default function DictationPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const audioRef = useRef(null)
  const inputRef = useRef(null)
  const { authFetch } = useAuth()

  // Data
  const [video, setVideo] = useState(null)
  const [subtitles, setSubtitles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Game state
  const [currentIndex, setCurrentIndex] = useState(0)
  const [userInput, setUserInput] = useState('')
  const [showChinese, setShowChinese] = useState(true)
  const [gamePhase, setGamePhase] = useState('typing') // 'playing-audio' | 'typing' | 'review' | 'finished'
  const [spellResults, setSpellResults] = useState(null) // current sentence check result

  // History: array of { index, userAnswer, results, correct }
  const [history, setHistory] = useState([])

  // Audio
  const [isPlaying, setIsPlaying] = useState(false)

  // Load video data
  useEffect(() => {
    fetch('/data/consolidated.json')
      .then(r => r.json())
      .then(videos => {
        const found = videos.find(v => v.id === id)
        if (!found) {
          setError('视频未找到')
          setLoading(false)
          return
        }
        // Load subtitles from episode folder
        fetch(`/data/videos/${encodeURIComponent(found.episode_dir)}/subtitles.json`)
          .then(r => r.json())
          .then(rawSubs => {
            const subs = (Array.isArray(rawSubs) ? rawSubs : []).filter(
              s => s.textEn && s.textEn.trim()
            )
            if (subs.length === 0) {
              setError('该视频没有可用的英文字幕')
              setLoading(false)
              return
            }

            setVideo(found)
            setSubtitles(subs)

            // Restore progress from API
            authFetch(`/dictation/${id}`)
              .then(r => r.json())
              .then(result => {
                if (result.data) {
                  setCurrentIndex(Math.min(result.data.currentIndex || 0, subs.length - 1))
                  setHistory(result.data.history || [])
                  setShowChinese(result.data.showChinese !== false)
                }
              })
              .catch(() => {}) // silently ignore if can't load

            setLoading(false)
          })
          .catch(() => {
            setError('字幕加载失败')
            setLoading(false)
          })
      })
      .catch(() => {
        setError('加载失败')
        setLoading(false)
      })
  }, [id])

  // Save progress to API when it changes
  useEffect(() => {
    if (subtitles.length === 0) return
    authFetch(`/dictation/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        data: { currentIndex, history, showChinese }
      })
    }).catch(() => {})
  }, [currentIndex, history, showChinese, id, subtitles.length])

  // Auto-focus input
  useEffect(() => {
    if (gamePhase === 'typing' && inputRef.current) {
      inputRef.current.focus()
    }
  }, [gamePhase, currentIndex])

  // Play audio for current sentence
  const playCurrentAudio = () => {
    const audio = audioRef.current
    const sub = subtitles[currentIndex]
    if (!audio || !sub) return

    audio.currentTime = sub.startTime
    audio.play().then(() => {
      setIsPlaying(true)
      setGamePhase('typing')
    }).catch(() => {
      // Audio failed, still allow typing
      setIsPlaying(false)
      setGamePhase('typing')
    })
  }

  // Auto-play when sentence changes
  useEffect(() => {
    if (loading || subtitles.length === 0) return
    if (gamePhase === 'finished') return

    const timer = setTimeout(() => {
      playCurrentAudio()
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, loading, subtitles.length])

  // Pause audio when endTime reached
  const handleTimeUpdate = () => {
    const audio = audioRef.current
    const sub = subtitles[currentIndex]
    if (!audio || !sub) return

    if (audio.currentTime >= sub.endTime) {
      audio.pause()
      setIsPlaying(false)
    }
  }

  const handleAudioEnded = () => {
    setIsPlaying(false)
  }

  // Submit answer
  const submitAnswer = () => {
    const trimmed = userInput.trim()
    const sub = subtitles[currentIndex]
    if (!sub) return

    const results = checkSpelling(trimmed, sub.textEn)
    const correct = isAllCorrect(results)

    setSpellResults(results)
    setGamePhase('review')

    // Update history (replace if already attempted)
    setHistory(prev => {
      const filtered = prev.filter(h => h.index !== currentIndex)
      return [...filtered, {
        index: currentIndex,
        userAnswer: trimmed,
        results,
        correct,
        timestamp: new Date().toISOString()
      }]
    })
  }

  // Go to next sentence
  const goNext = () => {
    if (currentIndex < subtitles.length - 1) {
      setCurrentIndex(currentIndex + 1)
      setUserInput('')
      setSpellResults(null)
      setGamePhase('typing')
    } else {
      setGamePhase('finished')
      setIsPlaying(false)
      if (audioRef.current) audioRef.current.pause()
    }
  }

  // Go to previous sentence
  const goPrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
      setUserInput('')
      setSpellResults(null)
      setGamePhase('typing')
    }
  }

  // Skip (reveal answer)
  const skipSentence = () => {
    const sub = subtitles[currentIndex]
    if (!sub) return

    setSpellResults([
      { type: 'correct', word: sub.textEn }
    ])
    setGamePhase('review')

    setHistory(prev => {
      const filtered = prev.filter(h => h.index !== currentIndex)
      return [...filtered, {
        index: currentIndex,
        userAnswer: '',
        results: [{ type: 'correct', word: sub.textEn }],
        correct: false, // skipped = not correct
        skipped: true,
        timestamp: new Date().toISOString()
      }]
    })
  }

  // Replay audio
  const replayAudio = () => {
    playCurrentAudio()
  }

  // Refs for keyboard handler — keep functions + state fresh without re-registering listener
  const gamePhaseRef = useRef(gamePhase)
  const userInputRef = useRef(userInput)
  const callbacksRef = useRef({})
  useEffect(() => { gamePhaseRef.current = gamePhase }, [gamePhase])
  useEffect(() => { userInputRef.current = userInput }, [userInput])
  useEffect(() => { callbacksRef.current = { submitAnswer, goNext, goPrev, skipSentence, replayAudio } })

  // Keyboard handler (stable listener, reads everything from refs)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const phase = gamePhaseRef.current
      const input = userInputRef.current
      const { submitAnswer, goNext, goPrev, skipSentence, replayAudio } = callbacksRef.current

      // Escape: go back
      if (e.key === 'Escape') {
        navigate(`/video/${id}`)
        return
      }

      if (phase === 'typing') {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          if (input.trim()) submitAnswer()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          skipSentence()
        }
      } else if (phase === 'review') {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          goNext()
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          goNext()
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          goPrev()
        }
      }

      // Global shortcuts (work in any phase except finished)
      if (phase !== 'finished') {
        if (e.ctrlKey && e.key === 'r') {
          e.preventDefault()
          replayAudio()
        } else if (e.ctrlKey && e.key === 'h') {
          e.preventDefault()
          setShowChinese(s => !s)
        } else if (e.ctrlKey && e.key === 'n') {
          e.preventDefault()
          goNext()
        } else if (e.ctrlKey && e.key === 'p') {
          e.preventDefault()
          goPrev()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stats
  const totalDone = history.filter(h => !h.skipped).length
  const totalCorrect = history.filter(h => h.correct).length
  const totalSkipped = history.filter(h => h.skipped).length
  const accuracy = totalDone > 0 ? Math.round((totalCorrect / totalDone) * 100) : 0

  // Reset progress
  const resetProgress = () => {
    setCurrentIndex(0)
    setUserInput('')
    setSpellResults(null)
    setHistory([])
    setGamePhase('typing')
    authFetch(`/dictation/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { currentIndex: 0, history: [], showChinese: true } })
    }).catch(() => {})
  }

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>加载中...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="error-container">
        <p>{error}</p>
        <button onClick={() => navigate(`/video/${id}`)}>返回视频</button>
      </div>
    )
  }

  const currentSub = subtitles[currentIndex]

  return (
    <div className="dictation-page">
      {/* Hidden audio element */}
      <video
        ref={audioRef}
        src={video?.video_local || video?.video_url}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleAudioEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        style={{ display: 'none' }}
        playsInline
        crossOrigin="anonymous"
        preload="auto"
      />

      {/* Header */}
      <div className="dictation-header">
        <button onClick={() => navigate(`/video/${id}`)} className="back-btn">
          <ArrowLeft size={20} />
          <span>返回</span>
        </button>
        <div className="dictation-header-center">
          <h1 className="dictation-title">{video?.title} — 听写练习</h1>
        </div>
        <div className="dictation-header-actions">
          <button onClick={resetProgress} className="action-btn-sm" title="重置进度">
            <RotateCcw size={16} />
            <span>重置</span>
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="dictation-progress-bar">
        <div className="dictation-progress-fill" style={{ width: `${(currentIndex / subtitles.length) * 100}%` }} />
      </div>

      {/* Stats row */}
      <div className="dictation-stats">
        <span className="stat-item">
          进度 <strong>{currentIndex + 1}</strong> / {subtitles.length}
        </span>
        <span className="stat-item stat-done">
          已练 <strong>{totalDone}</strong> 句
        </span>
        <span className="stat-item stat-correct">
          正确 <strong>{totalCorrect}</strong> 句
        </span>
        {totalSkipped > 0 && (
          <span className="stat-item stat-skipped">
            跳过 <strong>{totalSkipped}</strong> 句
          </span>
        )}
        <span className="stat-item stat-accuracy">
          正确率 <strong>{accuracy}%</strong>
        </span>
      </div>

      {/* Main dictation area */}
      {gamePhase === 'finished' ? (
        <div className="dictation-finished">
          <div className="finished-icon">🎉</div>
          <h2>练习完成！</h2>
          <div className="finished-stats">
            <div className="finished-stat">
              <span className="finished-stat-value">{totalDone}</span>
              <span className="finished-stat-label">已练习</span>
            </div>
            <div className="finished-stat">
              <span className="finished-stat-value">{totalCorrect}</span>
              <span className="finished-stat-label">正确</span>
            </div>
            <div className="finished-stat">
              <span className="finished-stat-value">{accuracy}%</span>
              <span className="finished-stat-label">正确率</span>
            </div>
          </div>
          <div className="finished-actions">
            <button onClick={resetProgress} className="action-btn">
              <RotateCcw size={18} />
              <span>重新练习</span>
            </button>
            <button onClick={() => navigate(`/video/${id}`)} className="action-btn">
              <ArrowLeft size={18} />
              <span>返回视频</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="dictation-main">
          {/* Sentence card */}
          <div className="dictation-card">
            {/* Chinese hint */}
            <div className={`dictation-hint ${showChinese ? 'visible' : 'hidden'}`}>
              {showChinese ? (
                <p className="dictation-chinese">{currentSub?.textCn}</p>
              ) : (
                <p className="dictation-chinese-placeholder">
                  <EyeOff size={14} />
                  <span>中文已隐藏 (Ctrl+H 显示)</span>
                </p>
              )}
            </div>

            {/* Audio mini player */}
            <div className="dictation-audio-bar">
              <button onClick={replayAudio} className="dictation-replay-btn" title="重播 (Ctrl+R)">
                {isPlaying ? <Volume2 size={18} /> : <RotateCcw size={18} />}
                <span>{isPlaying ? '播放中...' : '重播'}</span>
              </button>
              <span className="dictation-time">
                {currentSub ? formatTime(currentSub.startTime) : ''} - {currentSub ? formatTime(currentSub.endTime) : ''}
              </span>
            </div>

            {/* Input area - typing phase */}
            {gamePhase === 'typing' && (
              <div className="dictation-input-area">
                <textarea
                  ref={inputRef}
                  value={userInput}
                  onChange={e => setUserInput(e.target.value)}
                  className="dictation-input"
                  placeholder="输入你听到的英文句子..."
                  rows={2}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
                <div className="dictation-action-buttons">
                  <button
                    onClick={submitAnswer}
                    disabled={!userInput.trim()}
                    className="dictation-action-btn submit-btn"
                    title="提交 (Enter)"
                  >
                    <Send size={16} />
                    <span>提交</span>
                  </button>
                  <button
                    onClick={skipSentence}
                    className="dictation-action-btn skip-btn"
                    title="跳过 (Ctrl+Enter)"
                  >
                    <SkipForward size={16} />
                    <span>跳过</span>
                  </button>
                  <button
                    onClick={replayAudio}
                    className="dictation-action-btn replay-btn"
                    title="重听 (Ctrl+R)"
                  >
                    <Headphones size={16} />
                    <span>重听</span>
                  </button>
                  <button
                    onClick={() => setShowChinese(!showChinese)}
                    className={`dictation-action-btn toggle-cn-btn ${showChinese ? 'active' : ''}`}
                    title={showChinese ? '隐藏中文 (Ctrl+H)' : '显示中文 (Ctrl+H)'}
                  >
                    {showChinese ? <EyeOff size={16} /> : <Eye size={16} />}
                    <span>{showChinese ? '隐藏' : '中文'}</span>
                  </button>
                </div>
                <div className="dictation-input-hints">
                  <span className="input-hint">Enter 提交</span>
                  <span className="input-hint">Ctrl+Enter 跳过</span>
                  <span className="input-hint">Ctrl+R 重听</span>
                  <span className="input-hint">Ctrl+H {showChinese ? '隐藏' : '显示'}中文</span>
                </div>
              </div>
            )}

            {/* Review area - after submitting */}
            {gamePhase === 'review' && spellResults && (
              <div className="dictation-review">
                {/* Spell-check display */}
                <div className="spell-result">
                  {spellResults.map((r, i) => {
                    if (r.type === 'correct' && spellResults.length === 1 && history.find(h => h.index === currentIndex)?.skipped) {
                      // Skipped - show correct answer
                      return (
                        <span key={i} className="spell-word spell-skipped">
                          {r.word}
                        </span>
                      )
                    }
                    if (r.type === 'correct') {
                      if (spellResults.length === 1 && r.word === currentSub?.textEn) {
                        // Single-word match is a special case for skipped — but we handle that above
                        return <span key={i} className="spell-word spell-right">{r.word}</span>
                      }
                      return <span key={i} className="spell-word spell-right">{r.word} </span>
                    }
                    if (r.type === 'wrong') {
                      return (
                        <span key={i} className="spell-word-group spell-wrong">
                          <span className="spell-user-word">{r.user}</span>
                          <span className="spell-correct-word">{r.expected}</span>
                        </span>
                      )
                    }
                    if (r.type === 'missing') {
                      return (
                        <span key={i} className="spell-word-group spell-missing">
                          <span className="spell-correct-word">{r.expected}</span>
                        </span>
                      )
                    }
                    if (r.type === 'extra') {
                      return (
                        <span key={i} className="spell-word-group spell-extra">
                          <span className="spell-user-word">{r.user}</span>
                        </span>
                      )
                    }
                    return null
                  })}
                </div>

                {/* Sentence correct answer */}
                <div className="spell-answer">
                  <span className="answer-label">正确句子：</span>
                  <span className="answer-text">{currentSub?.textEn}</span>
                </div>

                {/* Navigation */}
                <div className="dictation-nav">
                  <button onClick={goPrev} className="nav-btn" disabled={currentIndex === 0}>
                    <ChevronLeft size={18} />
                    <span>上一句</span>
                  </button>
                  <div className="dictation-nav-center">
                    <button onClick={replayAudio} className="dictation-action-btn replay-btn" title="重听 (Ctrl+R)">
                      <Headphones size={16} />
                      <span>重听</span>
                    </button>
                    <button
                      onClick={() => setShowChinese(!showChinese)}
                      className={`dictation-action-btn toggle-cn-btn ${showChinese ? 'active' : ''}`}
                      title={showChinese ? '隐藏中文' : '显示中文'}
                    >
                      {showChinese ? <EyeOff size={16} /> : <Eye size={16} />}
                      <span>{showChinese ? '隐藏' : '中文'}</span>
                    </button>
                  </div>
                  <button onClick={goNext} className="nav-btn nav-btn-primary">
                    <span>{currentIndex < subtitles.length - 1 ? '下一句' : '完成'}</span>
                    <ChevronRight size={18} />
                  </button>
                </div>

                <div className="dictation-nav-hints">
                  <span className="input-hint">Enter/Space 下一句</span>
                  <span className="input-hint">← 上一句</span>
                </div>
              </div>
            )}
          </div>

          {/* Sentence navigator (mini timeline) */}
          <div className="dictation-timeline">
            {subtitles.map((sub, idx) => {
              const histEntry = history.find(h => h.index === idx)
              let dotClass = 'timeline-dot'
              if (idx === currentIndex) dotClass += ' current'
              else if (histEntry?.correct) dotClass += ' correct'
              else if (histEntry && !histEntry.correct) dotClass += ' wrong'
              else if (histEntry?.skipped) dotClass += ' skipped'

              return (
                <button
                  key={sub.id}
                  className={dotClass}
                  onClick={() => {
                    setCurrentIndex(idx)
                    setUserInput('')
                    setSpellResults(null)
                    setGamePhase('typing')
                  }}
                  title={`第 ${idx + 1} 句: ${sub.textEn?.substring(0, 40)}...`}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Keyboard shortcut cheat sheet */}
      <div className="dictation-cheatsheet">
        <span><kbd>Enter</kbd> 提交</span>
        <span><kbd>Ctrl+Enter</kbd> 跳过</span>
        <span><kbd>Ctrl+R</kbd> 重听</span>
        <span><kbd>Ctrl+H</kbd> 切换中文</span>
        <span><kbd>Ctrl+N/P</kbd> 上/下句</span>
        <span><kbd>Esc</kbd> 返回</span>
      </div>
    </div>
  )
}
