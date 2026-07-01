import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ArrowLeft, Play, Pause, Volume2, VolumeX, Maximize, SkipBack, SkipForward, 
         BookOpen, FileText, Download, ChevronLeft, ChevronRight, Star, Pencil, Mic, PenLine } from 'lucide-react'

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const subtitleContainerRef = useRef(null)
  const { authFetch } = useAuth()
  
  const [video, setVideo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  
  // Player state
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  
  // Subtitle display mode: bilingual | english | chinese | hidden
  const [subtitleMode, setSubtitleMode] = useState('bilingual')
  
  // Which subtitle is currently active
  const [activeSubIndex, setActiveSubIndex] = useState(-1)
  
  // Word lookup popup
  const [wordLookup, setWordLookup] = useState(null)
  
  // Annotations panel
  const [showAnnotations, setShowAnnotations] = useState(false)
  
  // Export modal
  const [showExport, setShowExport] = useState(false)

  // Vocabulary tracking (loaded from API)
  const [vocabulary, setVocabulary] = useState([])

  // Load vocabulary from API
  useEffect(() => {
    authFetch('/vocab')
      .then(r => r.json())
      .then(data => setVocabulary(data.vocabulary || []))
      .catch(() => {})
  }, [])

  // Watched history
  const [watchedHistory, setWatchedHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('shadow_voice_watched') || '[]')
    } catch { return [] }
  })

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch('/data/consolidated.json')
      .then(r => r.json())
      .then(videos => {
        const found = videos.find(v => v.id === id)
        if (found) {
          setVideo(found)
          // Track as watched
          setWatchedHistory(prev => {
            const updated = [found.id, ...prev.filter(vid => vid !== found.id)].slice(0, 50)
            localStorage.setItem('shadow_voice_watched', JSON.stringify(updated))
            return updated
          })
        } else {
          setError('视频未找到')
        }
        setLoading(false)
      })
      .catch(err => {
        setError('加载失败')
        setLoading(false)
      })
  }, [id])

  // Update active subtitle based on current time
  useEffect(() => {
    if (!video || !video.subtitles) return
    const idx = video.subtitles.findIndex(s => 
      currentTime >= s.start_time && currentTime <= s.end_time
    )
    setActiveSubIndex(idx)
    
    // Auto-scroll to active subtitle within the panel (not the whole page)
    if (idx >= 0 && subtitleContainerRef.current) {
      const el = document.getElementById(`sub-${idx}`)
      if (el) {
        const container = subtitleContainerRef.current
        const containerRect = container.getBoundingClientRect()
        const elRect = el.getBoundingClientRect()
        const offset = elRect.top - containerRect.top + container.scrollTop - containerRect.height / 2 + elRect.height / 2
        container.scrollTo({ top: offset, behavior: 'smooth' })
      }
    }
  }, [currentTime, video])

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime)
    }
  }

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration)
    }
  }

  const togglePlay = () => {
    if (!videoRef.current) return
    if (playing) {
      videoRef.current.pause()
    } else {
      videoRef.current.play()
    }
    setPlaying(!playing)
  }

  const handleSeek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const time = pct * duration
    if (videoRef.current) {
      videoRef.current.currentTime = time
    }
    setCurrentTime(time)
  }

  const jumpToSubtitle = (startTime) => {
    if (videoRef.current) {
      videoRef.current.currentTime = startTime
      videoRef.current.play()
      setPlaying(true)
    }
  }

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !muted
      setMuted(!muted)
    }
  }

  const handleVolumeChange = (e) => {
    const v = parseFloat(e.target.value)
    if (videoRef.current) {
      videoRef.current.volume = v
      videoRef.current.muted = v === 0
    }
    setVolume(v)
    setMuted(v === 0)
  }

  const handleFullscreen = () => {
    const el = videoRef.current?.parentElement
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }

  const handleWordClick = (word, e) => {
    const cleanWord = word.replace(/[^a-zA-Z']/g, '').toLowerCase()
    if (cleanWord.length < 2) return
    
    // Add to vocabulary via API
    authFetch('/vocab', {
      method: 'POST',
      body: JSON.stringify({ word: cleanWord, videoId: id, videoTitle: video?.title })
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          // Refresh vocab list
          authFetch('/vocab')
            .then(r => r.json())
            .then(d => setVocabulary(d.vocabulary || []))
            .catch(() => {})
        }
      })
      .catch(() => {})
  }

  const exportWordDoc = () => {
    if (!video) return
    const content = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:w="urn:schemas-microsoft-com:office:word"
            xmlns="http://www.w3.org/TR/REC-html40">
      <head><meta charset="utf-8"><title>${video.title}</title>
      <style>
        body { font-family: "Microsoft YaHei", sans-serif; font-size: 14pt; line-height: 1.8; margin: 40px; color: #333; }
        h1 { font-size: 18pt; font-weight: bold; text-align: center; margin-bottom: 10px; }
        .info { text-align: center; color: #666; font-size: 11pt; margin-bottom: 30px; border-bottom: 2px solid #e5e5e5; padding-bottom: 20px; }
        .time { color: #999; font-size: 10pt; }
        .english { font-size: 14pt; color: #1a1a1a; margin: 4px 0; }
        .chinese { font-size: 13pt; color: #666; margin: 4px 0 16px 0; }
        hr { border: none; border-top: 1px solid #e5e5e5; margin: 16px 0; }
      </style></head>
      <body>
        <h1>${video.title} - 学习笔记</h1>
        <div class="info">共 ${video.subtitles.length} 条字幕 | ${subtitleMode === 'bilingual' ? '中英双语' : subtitleMode === 'english' ? '纯英文' : '纯中文'}</div>
        ${video.subtitles.map(s => `
          ${subtitleMode !== 'chinese' ? `<p class="english">${s.english_text}</p>` : ''}
          ${subtitleMode !== 'english' ? `<p class="chinese">${s.chinese_text}</p>` : ''}
          <p class="time">${formatTime(s.start_time)}</p><hr/>
        `).join('')}
      </body></html>
    `
    const blob = new Blob([content], { type: 'application/msword' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${video.title} - 学习笔记.doc`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportTxt = () => {
    if (!video) return
    let text = `${video.title} - 学习笔记\n${'='.repeat(40)}\n\n`
    video.subtitles.forEach(s => {
      text += `[${formatTime(s.start_time)}]\n`
      if (subtitleMode !== 'chinese') text += `${s.english_text}\n`
      if (subtitleMode !== 'english') text += `${s.chinese_text}\n`
      text += '\n'
    })
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${video.title} - 字幕.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const skipTime = (seconds) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + seconds))
    }
  }

  if (loading) {
    return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>
  }

  if (error) {
    return (
      <div className="error-container">
        <p>{error}</p>
        <button onClick={() => navigate('/')}>返回首页</button>
      </div>
    )
  }

  if (!video) return null

  const videoSrc = video.video_local || video.video_url

  return (
    <div className="video-detail-page">
      <div className="video-detail-header">
        <button onClick={() => navigate('/')} className="back-btn">
          <ArrowLeft size={20} />
          <span>返回</span>
        </button>
        <h1 className="video-detail-title">{video.title}</h1>
        <div className="video-detail-actions">
          <button onClick={() => navigate(`/video/${id}/shadowing`)} className="action-btn shadowing-btn-header">
            <Mic size={18} />
            <span>跟读</span>
          </button>
          <button onClick={() => navigate(`/video/${id}/cloze`)} className="action-btn cloze-btn-header">
            <PenLine size={18} />
            <span>填词</span>
          </button>
          <button onClick={() => navigate(`/video/${id}/dictation`)} className="action-btn dictation-btn">
            <Pencil size={18} />
            <span>听写</span>
          </button>
          <button onClick={() => setShowExport(!showExport)} className="action-btn">
            <Download size={18} />
            <span>导出</span>
          </button>
        </div>
      </div>

      {showExport && (
        <div className="export-panel">
          <div className="subtitle-mode-selector">
            <span>字幕模式：</span>
            {['bilingual', 'english', 'chinese'].map(mode => (
              <button key={mode} className={`mode-btn ${subtitleMode === mode ? 'active' : ''}`} onClick={() => setSubtitleMode(mode)}>
                {mode === 'bilingual' ? '双语' : mode === 'english' ? '仅英语' : '仅中文'}
              </button>
            ))}
          </div>
          <div className="export-buttons">
            <button onClick={exportWordDoc} className="export-btn">导出 Word 文档</button>
            <button onClick={exportTxt} className="export-btn">导出 TXT 文本</button>
          </div>
        </div>
      )}

      <div className="video-content">
        <div className="video-player-section">
          <div className="video-wrapper" id="video-wrapper">
            <video
              ref={videoRef}
              src={videoSrc}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              className="video-element"
              playsInline
              crossOrigin="anonymous"
            />
            
            {/* Overlay subtitles */}
            {activeSubIndex >= 0 && subtitleMode !== 'hidden' && (
              <div className="video-overlay-subtitles" onClick={togglePlay}>
                {subtitleMode !== 'chinese' && (
                  <p className="overlay-english">{video.subtitles[activeSubIndex]?.english_text}</p>
                )}
                {subtitleMode !== 'english' && (
                  <p className="overlay-chinese">{video.subtitles[activeSubIndex]?.chinese_text}</p>
                )}
              </div>
            )}

            {/* Controls */}
            <div className="video-controls">
              <div className="progress-bar" onClick={handleSeek}>
                <div className="progress-filled" style={{ width: `${(currentTime / duration) * 100}%` }} />
              </div>
              <div className="controls-row">
                <div className="controls-left">
                  <button onClick={() => skipTime(-5)} className="ctrl-btn" title="后退5秒">
                    <SkipBack size={18} />
                  </button>
                  <button onClick={togglePlay} className="ctrl-btn play-btn">
                    {playing ? <Pause size={22} /> : <Play size={22} />}
                  </button>
                  <button onClick={() => skipTime(5)} className="ctrl-btn" title="快进5秒">
                    <SkipForward size={18} />
                  </button>
                  <button onClick={toggleMute} className="ctrl-btn">
                    {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={muted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className="volume-slider"
                  />
                  <span className="time-display">{formatTime(currentTime)} / {formatTime(duration)}</span>
                </div>
                <div className="controls-right">
                  <div className="subtitle-tabs">
                    {['bilingual', 'english', 'chinese', 'hidden'].map(mode => (
                      <button key={mode} className={`subtitle-tab ${subtitleMode === mode ? 'active' : ''}`} onClick={() => setSubtitleMode(mode)}>
                        {mode === 'bilingual' ? '双语' : mode === 'english' ? 'EN' : mode === 'chinese' ? '中' : '关'}
                      </button>
                    ))}
                  </div>
                  <button onClick={handleFullscreen} className="ctrl-btn">
                    <Maximize size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="subtitle-panel">
          <div className="subtitle-panel-header">
            <h3>
              <FileText size={16} />
              <span>字幕列表</span>
              <span className="subtitle-count-badge">{video.subtitle_count} 条</span>
            </h3>
            <button
              onClick={() => setShowAnnotations(!showAnnotations)}
              className={`action-btn-sm ${showAnnotations ? 'active' : ''}`}
            >
              <Star size={14} />
              <span>生词本</span>
            </button>
          </div>

          {showAnnotations && (
            <div className="vocab-panel">
              <h4>生词本 ({vocabulary.length})</h4>
              {vocabulary.length === 0 ? (
                <p className="empty-vocab">点击字幕中的单词即可添加</p>
              ) : (
                <div className="vocab-list">
                  {vocabulary.slice(0, 30).map((v, i) => (
                    <span key={i} className="vocab-item" title={v.videoTitle}>{v.word}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="subtitle-list" ref={subtitleContainerRef}>
            {video.subtitles.map((sub, idx) => (
              <div
                key={sub.id}
                id={`sub-${idx}`}
                className={`subtitle-item ${idx === activeSubIndex ? 'active' : ''}`}
                onClick={() => jumpToSubtitle(sub.start_time)}
              >
                <span className="sub-time">{formatTime(sub.start_time)}</span>
                <div className="sub-texts">
                  {subtitleMode !== 'chinese' && (
                    <p className="sub-english">
                      {sub.english_text.split(' ').map((word, wi) => (
                        <span
                          key={wi}
                          className="sub-word"
                          onClick={(e) => { e.stopPropagation(); handleWordClick(word, e) }}
                        >
                          {word}{' '}
                        </span>
                      ))}
                    </p>
                  )}
                  {subtitleMode !== 'english' && (
                    <p className="sub-chinese">{sub.chinese_text}</p>
                  )}
                </div>
                {sub.keywords && sub.keywords.length > 0 && (
                  <div className="sub-keywords">
                    {sub.keywords.map((kw, ki) => (
                      <span key={ki} className="keyword-tag">{kw}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Video info */}
      <div className="video-info-section">
        <div className="info-card">
          <h3>视频信息</h3>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">难度</span>
              <span className={`level-badge level-${video.level}`}>{video.level}</span>
            </div>
            <div className="info-item">
              <span className="info-label">话题</span>
              <div className="topic-tags">
                {video.topics.map((t, i) => (
                  <span key={i} className="topic-tag">{t}</span>
                ))}
              </div>
            </div>
            <div className="info-item">
              <span className="info-label">时长</span>
              <span>{formatTime(video.duration)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">字幕</span>
              <span>{video.subtitle_count} 条</span>
            </div>
          </div>
          <p className="info-description">{video.description}</p>
        </div>
      </div>
    </div>
  )
}
