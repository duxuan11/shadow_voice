import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RotateCcw, EyeOff, ChevronLeft, ChevronRight,
         Volume2, Mic, Play, Square, Pause } from 'lucide-react'

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function ShadowingPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const audioRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])

  // Data
  const [video, setVideo] = useState(null)
  const [subtitles, setSubtitles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // State
  const [currentIndex, setCurrentIndex] = useState(0)
  const [showChinese, setShowChinese] = useState(true)

  // Audio playback
  const [isPlaying, setIsPlaying] = useState(false)

  // Recording
  const [recordingState, setRecordingState] = useState('idle') // idle | recording | recorded
  const [recordedUrl, setRecordedUrl] = useState(null)
  const [isPlayingBack, setIsPlayingBack] = useState(false)

  // Progress
  const [practiced, setPracticed] = useState(new Set())
  const [finished, setFinished] = useState(false)

  // Load data
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
        const subs = (found.subtitles || []).filter(
          s => s.textEn && s.textEn.trim()
        )
        if (subs.length === 0) {
          setError('该视频没有可用的英文字幕')
          setLoading(false)
          return
        }
        setVideo(found)
        setSubtitles(subs)
        setLoading(false)
      })
      .catch(() => {
        setError('加载失败')
        setLoading(false)
      })
  }, [id])

  // Play current audio segment
  const playAudio = () => {
    const audio = audioRef.current
    const sub = subtitles[currentIndex]
    if (!audio || !sub) return

    audio.currentTime = sub.startTime
    audio.play().then(() => setIsPlaying(true)).catch(() => {})
  }

  // Pause audio at end time
  const handleTimeUpdate = () => {
    const audio = audioRef.current
    const sub = subtitles[currentIndex]
    if (!audio || !sub) return
    if (audio.currentTime >= sub.endTime) {
      audio.pause()
      setIsPlaying(false)
    }
  }

  const handleAudioEnded = () => setIsPlaying(false)

  // Start recording
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        if (recordedUrl) URL.revokeObjectURL(recordedUrl)
        const url = URL.createObjectURL(blob)
        setRecordedUrl(url)
        setRecordingState('recorded')
        // Stop all tracks
        stream.getTracks().forEach(t => t.stop())
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setRecordingState('recording')
    } catch (_err) {
      alert('无法访问麦克风，请检查浏览器权限设置')
    }
  }

  // Stop recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }

  // Play recorded audio
  const playRecording = () => {
    if (!recordedUrl) return
    const recAudio = new Audio(recordedUrl)
    recAudio.onended = () => setIsPlayingBack(false)
    recAudio.onplay = () => setIsPlayingBack(true)
    recAudio.play()
  }

  // Compare: replay original audio segment
  const replayOriginal = () => {
    playAudio()
  }

  // Navigate
  const goNext = () => {
    // Mark current as practiced
    setPracticed(prev => new Set([...prev, currentIndex]))
    // Clean up recording
    if (recordedUrl) URL.revokeObjectURL(recordedUrl)
    setRecordedUrl(null)
    setRecordingState('idle')

    if (currentIndex < subtitles.length - 1) {
      setCurrentIndex(currentIndex + 1)
    } else {
      setFinished(true)
      setIsPlaying(false)
      if (audioRef.current) audioRef.current.pause()
    }
  }

  const goPrev = () => {
    if (recordedUrl) URL.revokeObjectURL(recordedUrl)
    setRecordedUrl(null)
    setRecordingState('idle')
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
    }
  }

  const resetProgress = () => {
    setCurrentIndex(0)
    setPracticed(new Set())
    setFinished(false)
    setRecordingState('idle')
    if (recordedUrl) URL.revokeObjectURL(recordedUrl)
    setRecordedUrl(null)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        navigate(`/video/${id}`)
        return
      }
      if (finished) return

      if (e.ctrlKey && e.key === 'r') { e.preventDefault(); playAudio() }
      if (e.ctrlKey && e.key === 'h') { e.preventDefault(); setShowChinese(s => !s) }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); goNext() }
      if (e.ctrlKey && e.key === 'p') { e.preventDefault(); goPrev() }
      if (e.key === ' ' && recordingState === 'idle') { e.preventDefault(); startRecording() }
      if (e.key === ' ' && recordingState === 'recording') { e.preventDefault(); stopRecording() }
      if (e.key === 'Enter' && recordingState === 'recorded') { e.preventDefault(); goNext() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [currentIndex, recordingState, finished, id])

  // Auto-play audio on sentence change
  useEffect(() => {
    if (loading || subtitles.length === 0 || finished) return
    const timer = setTimeout(playAudio, 400)
    return () => clearTimeout(timer)
  }, [currentIndex, loading, subtitles.length, finished])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordedUrl) URL.revokeObjectURL(recordedUrl)
    }
  }, [])

  if (loading) {
    return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>
  }
  if (error) {
    return <div className="error-container"><p>{error}</p><button onClick={() => navigate(`/video/${id}`)}>返回视频</button></div>
  }

  const currentSub = subtitles[currentIndex]
  const totalPracticed = practiced.size + (recordingState === 'recorded' ? 1 : 0)

  return (
    <div className="shadowing-page">
      {/* Hidden audio */}
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
          <ArrowLeft size={20} /><span>返回</span>
        </button>
        <div className="dictation-header-center">
          <h1 className="dictation-title">{video?.title} — 影子跟读</h1>
        </div>
        <div className="dictation-header-actions">
          <button onClick={resetProgress} className="action-btn-sm" title="重置进度">
            <RotateCcw size={16} /><span>重置</span>
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="dictation-progress-bar">
        <div className="dictation-progress-fill" style={{ width: `${(currentIndex / subtitles.length) * 100}%` }} />
      </div>

      {/* Stats */}
      <div className="dictation-stats">
        <span className="stat-item">进度 <strong>{currentIndex + 1}</strong> / {subtitles.length}</span>
        <span className="stat-item stat-done">已练 <strong>{totalPracticed}</strong> 句</span>
      </div>

      {finished ? (
        <div className="dictation-finished">
          <div className="finished-icon">🎤</div>
          <h2>影子跟读完成！</h2>
          <p>你练习了 {totalPracticed} 个句子，继续保持！</p>
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
        <div className="shadowing-main">
          {/* Sentence card */}
          <div className="shadowing-card">
            {/* Chinese hint */}
            <div className={`dictation-hint ${showChinese ? 'visible' : 'hidden'}`}>
              {showChinese ? (
                <p className="dictation-chinese">{currentSub?.textCn}</p>
              ) : (
                <p className="dictation-chinese-placeholder">
                  <EyeOff size={14} /><span>中文已隐藏 (Ctrl+H 显示)</span>
                </p>
              )}
            </div>

            {/* English text for shadowing */}
            <div className="shadowing-text">
              <p className="shadowing-english">{currentSub?.textEn}</p>
            </div>

            {/* Audio bar */}
            <div className="shadowing-audio-bar">
              <button onClick={playAudio} className="shadowing-btn shadowing-play-btn" disabled={isPlaying}>
                <Volume2 size={18} />
                <span>{isPlaying ? '播放中...' : '听原声'}</span>
              </button>
              <span className="dictation-time">
                {currentSub ? formatTime(currentSub.startTime) : ''} - {currentSub ? formatTime(currentSub.endTime) : ''}
              </span>
            </div>

            {/* Recording area */}
            <div className="shadowing-record-area">
              {recordingState === 'idle' && (
                <button onClick={startRecording} className="shadowing-btn shadowing-record-btn">
                  <Mic size={20} />
                  <span>开始跟读 <span className="kbd-hint">(Space)</span></span>
                </button>
              )}

              {recordingState === 'recording' && (
                <div className="shadowing-recording">
                  <div className="recording-indicator">
                    <span className="recording-dot" />
                    <span>正在录音...</span>
                  </div>
                  <button onClick={stopRecording} className="shadowing-btn shadowing-stop-btn">
                    <Square size={18} />
                    <span>停止录音 <span className="kbd-hint">(Space)</span></span>
                  </button>
                </div>
              )}

              {recordingState === 'recorded' && recordedUrl && (
                <div className="shadowing-playback">
                  <div className="playback-buttons">
                    <button onClick={playRecording} className="shadowing-btn shadowing-playback-btn" disabled={isPlayingBack}>
                      {isPlayingBack ? <Pause size={18} /> : <Play size={18} />}
                      <span>{isPlayingBack ? '播放中...' : '听我的录音'}</span>
                    </button>
                    <button onClick={replayOriginal} className="shadowing-btn shadowing-compare-btn" disabled={isPlaying}>
                      <Volume2 size={18} />
                      <span>对比原声</span>
                    </button>
                  </div>
                  <p className="playback-hint">听录音对比原声，感受差距，反复练习</p>
                </div>
              )}
            </div>

            {/* Navigation */}
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
                <button
                  key={sub.id}
                  className={dotClass}
                  onClick={() => {
                    if (recordedUrl) URL.revokeObjectURL(recordedUrl)
                    setRecordedUrl(null)
                    setRecordingState('idle')
                    setCurrentIndex(idx)
                  }}
                  title={`第 ${idx + 1} 句: ${sub.textEn?.substring(0, 40)}...`}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Cheatsheet */}
      <div className="dictation-cheatsheet">
        <span><kbd>Space</kbd> 开始/停止录音</span>
        <span><kbd>Enter</kbd> 下一句</span>
        <span><kbd>Ctrl+R</kbd> 重听原声</span>
        <span><kbd>Ctrl+H</kbd> 切换中文</span>
        <span><kbd>Ctrl+N/P</kbd> 上/下句</span>
        <span><kbd>Esc</kbd> 返回</span>
      </div>
    </div>
  )
}
