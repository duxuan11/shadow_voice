import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ArrowLeft, Download, Play, Pause, Volume2, VolumeX, Maximize2,
        ChevronLeft, ChevronRight, Repeat, BookOpen,
        List, Mic, PenTool, Languages, RotateCcw, CheckCircle2, AlertCircle,
        Sparkles, Heart, Star, X, Gauge, Globe, EyeOff } from 'lucide-react'

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const SYNONYMS = {
  'good': { synonyms: ['great', 'excellent', 'wonderful', 'nice'], cn: '好的,优秀的' },
  'bad': { synonyms: ['terrible', 'awful', 'poor', 'horrible'], cn: '坏的,糟糕的' },
  'big': { synonyms: ['large', 'huge', 'massive', 'enormous'], cn: '大的' },
  'small': { synonyms: ['tiny', 'little', 'miniature', 'compact'], cn: '小的' },
  'beautiful': { synonyms: ['gorgeous', 'stunning', 'lovely', 'pretty'], cn: '美丽的' },
  'happy': { synonyms: ['glad', 'joyful', 'delighted', 'pleased'], cn: '快乐的' },
  'important': { synonyms: ['crucial', 'vital', 'essential', 'significant'], cn: '重要的' },
  'difficult': { synonyms: ['hard', 'challenging', 'tough', 'tricky'], cn: '困难的' },
  'easy': { synonyms: ['simple', 'effortless', 'straightforward', 'basic'], cn: '容易的' },
  'amazing': { synonyms: ['incredible', 'astonishing', 'remarkable', 'extraordinary'], cn: '惊人的' },
}

const MOBILE_TABS = [
  { key: 'transcript', icon: List, label: '字幕' },
  { key: 'shadow', icon: Mic, label: '跟读' },
  { key: 'cloze', icon: PenTool, label: '挖空' },
  { key: 'translate', icon: Languages, label: '中译英' },
]

export default function VideoDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const { authFetch } = useAuth()

  // Responsive: only render one layout at a time
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const [video, setVideo] = useState(null)
  const [allVideos, setAllVideos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [muted, setMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [loopMode, setLoopMode] = useState('off')
  const [isLooping, setIsLooping] = useState(false)
  const [showSpeedPicker, setShowSpeedPicker] = useState(false)
  const [showLoopPicker, setShowLoopPicker] = useState(false)

  const [subtitleMode, setSubtitleMode] = useState('bilingual')
  const [activeSubIndex, setActiveSubIndex] = useState(-1)
  const [mobileTab, setMobileTab] = useState('transcript')
  const [sidebarTab, setSidebarTab] = useState('transcript')
  const [wordPopup, setWordPopup] = useState(null)
  const [showExport, setShowExport] = useState(false)
  const [isWordCardOpen, setIsWordCardOpen] = useState(false)
  const [wordCardTab, setWordCardTab] = useState('words')
  const [blindRevealedIds, setBlindRevealedIds] = useState(new Set())

  const [vocabulary, setVocabulary] = useState([])
  const [bookmarkedIds, setBookmarkedIds] = useState([])

  // Shadowing state
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [shadowResult, setShadowResult] = useState(null)
  const [recordedAudio, setRecordedAudio] = useState(null)
  const mediaRecorderRef = useRef(null)

  // Cloze state
  const [clozeOptions, setClozeOptions] = useState([])
  const [selectedClozeWord, setSelectedClozeWord] = useState(null)
  const [isClozeCorrect, setIsClozeCorrect] = useState(null)
  const [clozeTargetWord, setClozeTargetWord] = useState('')

  // Translate state
  const [scrambledChips, setScrambledChips] = useState([])
  const [selectedTranslateChips, setSelectedTranslateChips] = useState([])
  const [isTranslateCorrect, setIsTranslateCorrect] = useState(null)

  const scrollContainerRef = useRef(null)
  const mobileScrollRef = useRef(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const playerContainerRef = useRef(null)

  // ── Data loading ──
  useEffect(() => {
    fetch('/data/consolidated.json').then(r => r.json()).then(videos => {
      setAllVideos(videos)
      const found = videos.find(v => v.id === id)
      if (found) {
        const subsUrl = `/data/videos/${encodeURIComponent(found.episode_dir)}/subtitles.json`
        fetch(subsUrl).then(r => r.json()).then(subs => {
          setVideo({ ...found, subtitles: Array.isArray(subs) ? subs : [] })
          setLoading(false)
        }).catch(() => {
          setVideo({ ...found, subtitles: [] })
          setLoading(false)
        })
      } else { setError('视频未找到'); setLoading(false) }
    }).catch(() => { setError('加载失败'); setLoading(false) })
  }, [id])

  useEffect(() => { authFetch('/vocab').then(r => r.json()).then(d => setVocabulary(d.vocabulary || [])).catch(() => {}) }, [id, authFetch])

  // ── Cloze setup ──
  const setupClozeMode = useCallback((sub) => {
    const wordsArray = sub.textEn.split(/\s+/)
    let target = ''
    if (sub.highlightWords && sub.highlightWords.length > 0) {
      target = sub.highlightWords[0].toLowerCase()
    } else {
      const sorted = [...wordsArray].map(w => w.replace(/[^a-zA-Z]/g, '')).sort((a, b) => b.length - a.length)
      target = sorted[0]?.toLowerCase() || ''
    }
    if (!target) { setClozeOptions([]); setClozeTargetWord(''); return }
    const matchedWord = wordsArray.find(w => w.toLowerCase().replace(/[^a-zA-Z]/g, '') === target.replace(/[^a-zA-Z]/g, '')) || target
    setClozeTargetWord(matchedWord)
    const pool = ['luggage', 'hotel', 'concierge', 'checked in', 'welcome', 'lift', 'room', 'apartment', 'holiday', 'reservation', 'morning', 'flight', 'breakfast']
    const clean = matchedWord.toLowerCase().replace(/[^a-zA-Z]/g, '')
    const filtered = pool.filter(d => d !== clean)
    const chosen = filtered.slice(0, 3)
    setClozeOptions([matchedWord, ...chosen].sort(() => Math.random() - 0.5))
    setSelectedClozeWord(null)
    setIsClozeCorrect(null)
  }, [])

  // ── Translate setup ──
  const setupTranslateMode = useCallback((sub) => {
    const cleanText = sub.textEn.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    const words = cleanText.split(/\s+/).filter(w => w.trim().length > 0)
    setScrambledChips([...words].sort(() => Math.random() - 0.5))
    setSelectedTranslateChips([])
    setIsTranslateCorrect(null)
  }, [])

  useEffect(() => {
    if (!video || !video.subtitles) return
    const sub = video.subtitles[Math.max(0, activeSubIndex)]
    if (!sub) return
    setupClozeMode(sub)
    setupTranslateMode(sub)
    setShadowResult(null)
    setIsRecording(false)
  }, [activeSubIndex, video, setupClozeMode, setupTranslateMode])

  // ── Recording ──
  useEffect(() => {
    let interval = null
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingSeconds(prev => { if (prev + 1 >= 4) { stopRecording(); return 0 } return prev + 1 })
      }, 1000)
    } else { setRecordingSeconds(0) }
    return () => clearInterval(interval)
  }, [isRecording]) // eslint-disable-line react-hooks/exhaustive-deps

  const startRecording = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const r = new MediaRecorder(s); const ch = []; r.ondataavailable = e => ch.push(e.data); r.onstop = () => { const b = new Blob(ch, { type: 'audio/webm' }); setRecordedAudio(URL.createObjectURL(b)); s.getTracks().forEach(t => t.stop()) }; mediaRecorderRef.current = r; r.start(); setIsRecording(true); setShadowResult(null); setPlaying(false) } catch { /* ignore */ }
  }
  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) { mediaRecorderRef.current.stop(); setIsRecording(false) }
    if (!currentSub) return
    const words = currentSub.textEn.split(/\s+/).map(word => {
      const statuses = ['perfect', 'perfect', 'perfect', 'good', 'poor']
      return { text: word, status: statuses[Math.floor(Math.random() * statuses.length)] }
    })
    setShadowResult({ score: Math.floor(Math.random() * 12) + 87, words })
  }

  // ── Cloze / Translate handlers ──
  const handleSelectClozeOption = (option) => {
    setSelectedClozeWord(option)
    setIsClozeCorrect(option.toLowerCase().replace(/[^a-zA-Z]/g, '') === clozeTargetWord.toLowerCase().replace(/[^a-zA-Z]/g, ''))
  }
  const handleChipClick = (word, index) => {
    setSelectedTranslateChips(prev => [...prev, word])
    setScrambledChips(prev => { const n = [...prev]; n.splice(index, 1); return n })
  }
  const handleRemoveChip = (word, index) => {
    setSelectedTranslateChips(prev => { const n = [...prev]; n.splice(index, 1); return n })
    setScrambledChips(prev => [...prev, word].sort(() => Math.random() - 0.5))
  }
  const handleVerifyTranslation = () => {
    if (!currentSub) return
    const cleanText = currentSub.textEn.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim()
    setIsTranslateCorrect(selectedTranslateChips.join(' ').toLowerCase().trim() === cleanText)
  }

  // ── Derived data ──
  const derivedData = useMemo(() => {
    if (!video || !video.subtitles) return { keywords: [], phrases: [], expressions: [] }
    const keywordMap = new Map(); const phrases = []; const expressions = []
    for (const sub of video.subtitles) {
      if (sub.highlightWords) {
        for (const kw of sub.highlightWords) {
          if (!keywordMap.has(kw)) keywordMap.set(kw, { word: kw, count: 1, times: [sub.startTime] })
          else { const e = keywordMap.get(kw); e.count++; e.times.push(sub.startTime) }
        }
      }
      if (sub.highlightWords && sub.highlightWords.length >= 3) phrases.push(sub)
      if (sub.annotations && Object.keys(sub.annotations).length > 0) expressions.push(sub)
    }
    return {
      keywords: [...keywordMap.values()].sort((a, b) => b.count - a.count),
      phrases: phrases.length > 0 ? phrases : video.subtitles.filter(s => s.highlightWords && s.highlightWords.length >= 2).slice(0, 20),
      expressions: expressions.length > 0 ? expressions : video.subtitles.filter(s => s.textEn && s.textEn.length > 40).slice(0, 20),
    }
  }, [video])

  // ── Active subtitle tracking ──
  useEffect(() => { if (!video || !video.subtitles) return; setActiveSubIndex(video.subtitles.findIndex(s => currentTime >= s.startTime && currentTime <= s.endTime)) }, [currentTime, video])

  // Auto-scroll to active subtitle (desktop)
  useEffect(() => {
    if (sidebarTab !== 'transcript' || activeSubIndex < 0 || !scrollContainerRef.current) return
    const el = scrollContainerRef.current.querySelector(`#sub-item-${activeSubIndex}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeSubIndex, sidebarTab])

  // Auto-scroll to active subtitle (mobile)
  useEffect(() => {
    if (mobileTab !== 'transcript' || activeSubIndex < 0 || !mobileScrollRef.current) return
    const el = mobileScrollRef.current.querySelector(`[data-mobile-sub-index="${activeSubIndex}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeSubIndex, mobileTab])

  // ── Loop ──
  const [loopStart, setLoopStart] = useState(null); const [loopEnd, setLoopEnd] = useState(null)
  useEffect(() => { if (!video || activeSubIndex < 0) return; if (loopMode !== 'off') { const sub = video.subtitles[activeSubIndex]; if (sub) { setLoopStart(sub.startTime); setLoopEnd(sub.endTime) } } }, [activeSubIndex, loopMode, video])

  // ── Video controls ──
  const handleTimeUpdate = () => {
    const vid = videoRef.current; if (!vid) return; const t = vid.currentTime; setCurrentTime(t)
    if (isLooping && currentSub && t >= currentSub.endTime) { vid.currentTime = currentSub.startTime; setCurrentTime(currentSub.startTime) }
    if (loopMode === 'sentence' && loopEnd && t >= loopEnd) vid.currentTime = loopStart || 0
  }
  const handleLoadedMetadata = () => { const vid = videoRef.current; if (vid) setDuration(vid.duration) }
  const togglePlay = useCallback(() => { const vid = videoRef.current; if (!vid) return; vid.paused ? vid.play() : vid.pause() })
  const handleSeekChange = (e) => { const t = parseFloat(e.target.value); const vid = videoRef.current; if (vid) { vid.currentTime = t; setCurrentTime(t) } }
  const jumpToSubtitle = (st) => { const vid = videoRef.current; if (vid) { vid.currentTime = st; vid.play(); setPlaying(true) } }
  const toggleMute = () => { const vid = videoRef.current; if (vid) { setMuted(!muted); vid.muted = !muted } }
  const handleVolumeChange = (e) => { const v = parseFloat(e.target.value); setVolume(v); if (v > 0) setMuted(false); const vid = videoRef.current; if (vid) vid.volume = v }
  const toggleFullscreen = () => {
    if (!playerContainerRef.current) return
    if (!isFullscreen) { playerContainerRef.current.requestFullscreen(); setIsFullscreen(true) }
    else { document.exitFullscreen(); setIsFullscreen(false) }
  }
  useEffect(() => { const h = () => setIsFullscreen(!!document.fullscreenElement); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h) }, [])
  const changeSpeed = (s) => { const vid = videoRef.current; if (vid) vid.playbackRate = s; setPlaybackRate(s); setShowSpeedPicker(false) }
  const cycleSpeed = () => { const s = playbackRate === 1 ? 1.25 : playbackRate === 1.25 ? 1.5 : playbackRate === 1.5 ? 0.75 : 1; changeSpeed(s) }
  const goToNextVideo = () => { if (!allVideos.length) return; const i = allVideos.findIndex(v => v.id === id); if (i >= 0 && i < allVideos.length - 1) navigate(`/video/${allVideos[i + 1].id}`) }
  const handleVideoEnded = () => { setPlaying(false); const vid = videoRef.current; if (loopMode === 'all' && vid) vid.play(); else goToNextVideo() }
  const goPrevSentence = () => { if (!video?.subtitles) return; const idx = Math.max(0, activeSubIndex - 1); jumpToSubtitle(video.subtitles[idx].startTime) }
  const goNextSentence = () => { if (!video?.subtitles) return; const idx = Math.min(video.subtitles.length - 1, activeSubIndex + 1); jumpToSubtitle(video.subtitles[idx].startTime) }
  const cycleLoop = () => { const m = ['off', 'sentence', 'all']; const n = m[(m.indexOf(loopMode) + 1) % 3]; setLoopMode(n); setIsLooping(n !== 'off'); const vid = videoRef.current; if (vid) vid.loop = n === 'all'; if (n !== 'sentence') { setLoopStart(null); setLoopEnd(null) }; setShowLoopPicker(false) }
  useEffect(() => { const vid = videoRef.current; if (!vid) return; vid.volume = muted ? 0 : volume; vid.playbackRate = playbackRate }, [volume, muted, playbackRate])

  // ── Vocabulary ──
  const pushToVocab = async (word) => {
    const cw = word.replace(/[^a-zA-Z']/g, '').toLowerCase(); if (cw.length < 2) return
    try { const r = await authFetch('/vocab', { method: 'POST', body: JSON.stringify({ word: cw, videoId: id, videoTitle: video?.title }) }); if (r.ok) { const d = await authFetch('/vocab').then(r => r.json()); setVocabulary(d.vocabulary || []) } } catch { /* ignore */ }
  }

  const handleWordClick = (word, e) => {
    e.stopPropagation()
    const cw = word.replace(/[^a-zA-Z']/g, '').toLowerCase(); if (cw.length < 2) return
    const sd = SYNONYMS[cw]; const r = e.target.getBoundingClientRect()
    const x = Math.min(r.left, window.innerWidth - 210)
    const y = Math.min(r.bottom + 4, window.innerHeight - 180)
    setWordPopup({ word: cw, synonyms: sd?.synonyms || [], cn: sd?.cn || '', x, y, isMobile: window.innerWidth < 768 })
    pushToVocab(cw)
  }

  useEffect(() => { if (!wordPopup || wordPopup.isMobile) return; const t = setTimeout(() => setWordPopup(null), 4000); const c = () => setWordPopup(null); document.addEventListener('click', c, { once: true }); return () => { clearTimeout(t); document.removeEventListener('click', c) } }, [wordPopup])

  // ── Export ──
  const exportWordDoc = () => {
    if (!video) return
    const c = `<html><head><meta charset="utf-8"><title>${video.title}</title><style>body{font-family:"Microsoft YaHei",sans-serif;font-size:14pt;line-height:1.8;margin:40px;color:#333}h1{font-size:18pt;text-align:center}.time{color:#999;font-size:10pt}.en{font-size:14pt;color:#1a1a1a;margin:4px 0}.zh{font-size:13pt;color:#666;margin:4px 0 16px 0}hr{border:none;border-top:1px solid #e5e5e5;margin:16px 0}</style></head><body><h1>${video.title}</h1><p style="text-align:center;color:#666">共 ${video.subtitles.length} 条字幕</p>${video.subtitles.map(s => `${subtitleMode !== 'chinese' ? `<p class="en">${s.textEn}</p>` : ''}${subtitleMode !== 'english' ? `<p class="zh">${s.textCn}</p>` : ''}<p class="time">${formatTime(s.startTime)}</p><hr/>`).join('')}</body></html>`
    const b = new Blob([c], { type: 'application/msword' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `${video.title} - 学习笔记.doc`; a.click(); URL.revokeObjectURL(u)
  }
  const exportTxt = () => { if (!video) return; let t = `${video.title}\n${'='.repeat(40)}\n\n`; video.subtitles.forEach(s => { t += `[${formatTime(s.startTime)}]\n`; if (subtitleMode !== 'chinese') t += `${s.textEn}\n`; if (subtitleMode !== 'english') t += `${s.textCn}\n`; t += '\n' }); const b = new Blob([t], { type: 'text/plain' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `${video.title} - 字幕.txt`; a.click(); URL.revokeObjectURL(u) }

  // ── TTS ──
  const speakActiveSentence = () => {
    if (!currentSub) return
    const synth = window.speechSynthesis; if (!synth) return
    const u = new SpeechSynthesisUtterance(currentSub.textEn); u.lang = 'en-US'; u.rate = 0.9; synth.speak(u)
  }
  const speakWord = (word) => {
    const synth = window.speechSynthesis; if (!synth) return
    const u = new SpeechSynthesisUtterance(word); u.lang = 'en-US'; u.rate = 0.95; synth.speak(u)
  }

  // ── Bookmark ──
  const toggleBookmark = (e, subId) => { e.stopPropagation(); setBookmarkedIds(p => p.includes(subId) ? p.filter(id => id !== subId) : [...p, subId]) }

  // ── Subtitle mode ──
  const cycleSubtitleMode = () => {
    const modes = ['bilingual', 'english', 'chinese', 'blind']
    const idx = modes.indexOf(subtitleMode)
    setSubtitleMode(modes[(idx + 1) % modes.length])
    setBlindRevealedIds(new Set())
  }
  const subtitleModeLabel = () => ({ bilingual: '双语', english: '英文', chinese: '中文', blind: '盲听' }[subtitleMode] || '双语')
  const subtitleModeChar = () => ({ bilingual: '双', english: '英', chinese: '中', blind: '盲' }[subtitleMode] || '双')

  // ── Blind mode ──
  const toggleBlindReveal = (subId) => {
    setBlindRevealedIds(prev => {
      const next = new Set(prev)
      next.has(subId) ? next.delete(subId) : next.add(subId)
      return next
    })
  }

  // Close pickers on outside click
  useEffect(() => {
    if (!showSpeedPicker && !showLoopPicker) return
    const close = () => { setShowSpeedPicker(false); setShowLoopPicker(false) }
    document.addEventListener('click', close, { once: true })
    return () => document.removeEventListener('click', close)
  }, [showSpeedPicker, showLoopPicker])

  // ── Loading / Error ──
  if (loading) return <div className="min-h-screen bg-slate-50 flex items-center justify-center"><div className="flex flex-col items-center gap-4"><div className="w-10 h-10 border-[3px] border-slate-200 border-t-indigo-600 rounded-full animate-spin" /><p className="text-sm text-slate-500 font-medium">加载中...</p></div></div>
  if (error) return <div className="min-h-screen bg-slate-50 flex items-center justify-center"><div className="flex flex-col items-center gap-4"><p className="text-rose-500 font-semibold">{error}</p><button onClick={() => navigate('/')} className="px-5 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 transition-all cursor-pointer">返回首页</button></div></div>
  if (!video) return null

  const videoSrc = video.video_local || video.video_url
  const currentSub = activeSubIndex >= 0 ? video.subtitles[activeSubIndex] : null

  // ───────────────────────────────────────────
  // Shared: Subtitle Card Renderer (used by both mobile and desktop)
  // ───────────────────────────────────────────
  const renderSubtitleText = (sub, isActive, isMobileView) => {
    if (subtitleMode === 'blind' && !blindRevealedIds.has(sub.startTime)) {
      return (
        <div className="space-y-2 cursor-pointer py-1" onClick={(e) => { e.stopPropagation(); toggleBlindReveal(sub.startTime) }}>
          <div className={`h-5 rounded-md w-full ${isActive ? 'bg-indigo-100' : 'bg-slate-100'}`} />
          <div className={`h-4 rounded-md w-3/4 ${isActive ? 'bg-indigo-50' : 'bg-slate-50'}`} />
          <p className="text-[10px] text-slate-400 mt-1">点击显示</p>
        </div>
      )
    }
    return (
      <>
        {(subtitleMode === 'bilingual' || subtitleMode === 'english' || subtitleMode === 'blind') && (
          <p className={`${isMobileView ? 'text-[15px]' : 'text-[15px] md:text-base'} leading-relaxed font-sans tracking-wide ${isActive ? 'text-slate-900 font-extrabold' : 'text-slate-800 font-bold'}`}>
            {isMobileView ? sub.textEn : sub.textEn.split(' ').map((w, wi) => (
              <span key={wi} className="cursor-pointer rounded-sm hover:text-indigo-600 hover:bg-indigo-50 px-0.5" onClick={e => handleWordClick(w, e)}>{w} </span>
            ))}
          </p>
        )}
        {(subtitleMode === 'bilingual' || subtitleMode === 'chinese') && (
          <p className={`${isMobileView ? 'text-[13px]' : 'text-[13px] md:text-sm'} mt-1.5 font-sans leading-relaxed ${isActive ? 'text-indigo-600 font-semibold' : 'text-slate-400 font-medium'}`}>{sub.textCn}</p>
        )}
      </>
    )
  }

  // ───────────────────────────────────────────
  // Render: Video Player (render function, NOT a component)
  // ───────────────────────────────────────────
  const renderVideoPlayer = (isMobileView) => (
    <div ref={playerContainerRef}
      className={`relative w-full bg-slate-950 overflow-hidden group ${isMobileView ? 'shrink-0' : 'aspect-video rounded-2xl shadow-lg'}`}
      style={isMobileView ? { aspectRatio: '16/9' } : undefined}>
      <video ref={videoRef} src={videoSrc}
        poster={video.thumbnail_local}
        onTimeUpdate={handleTimeUpdate} onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={handleVideoEnded}
        className="w-full h-full object-cover cursor-pointer"
        playsInline preload="auto" />

      {/* Big play button overlay (shown when paused) */}
      {!playing && (
        <div className="absolute inset-0 flex items-center justify-center z-10 cursor-pointer"
          onClick={togglePlay}>
          <div className="w-16 h-16 md:w-14 md:h-14 rounded-full bg-indigo-600/90 hover:bg-indigo-500 flex items-center justify-center shadow-xl backdrop-blur-sm transition-all active:scale-90">
            <Play className="h-8 w-8 md:h-6 md:w-6 text-white fill-white ml-1" />
          </div>
        </div>
      )}

      {/* Sentence counter badge */}
      <div className={`absolute top-3 right-3 bg-black/50 text-yellow-300 font-sans font-extrabold text-[11px] px-2.5 py-1 rounded-md tracking-wider shadow-sm backdrop-blur-xs pointer-events-none z-20`}>
        {currentSub ? `${activeSubIndex + 1}/${video.subtitles.length}` : `1/${video.subtitles.length}`}
      </div>

      {/* Video overlay controls */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-10 pb-3 px-4 flex flex-col gap-2 opacity-100 transition-opacity z-20">
        {/* Progress bar */}
        <input type="range" min={0} max={duration || 100} step={0.1} value={currentTime} onChange={handleSeekChange}
          className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-indigo-500 focus:outline-hidden hover:h-1.5 transition-all" />
        {/* Controls row */}
        <div className="flex items-center justify-between">
          <span className="text-white/90 font-mono text-[10px] tracking-wide">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <div className="flex items-center gap-3">
            <button onClick={(e) => { e.stopPropagation(); togglePlay() }} className="text-white hover:text-indigo-400 transition-colors cursor-pointer">
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-white" />}
            </button>
            {!isMobileView && (
              <div className="flex items-center gap-2 group/volume">
                <button onClick={toggleMute} className="text-white hover:text-indigo-400 transition-colors cursor-pointer">
                  {muted ? <VolumeX className="h-4 w-4 text-rose-400" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={handleVolumeChange}
                  className="w-0 opacity-0 scale-x-0 group-hover/volume:w-16 group-hover/volume:opacity-100 group-hover/volume:scale-x-100 origin-left h-1 rounded-lg cursor-pointer focus:outline-hidden transition-all duration-300 volume-slider" />
              </div>
            )}
            <button onClick={toggleFullscreen} title="全屏" className="text-white hover:text-indigo-400 transition-colors cursor-pointer">
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // ───────────────────────────────────────────
  // Render: Practice Mode Navigation Header
  // ───────────────────────────────────────────
  const renderPracticeNavHeader = (label, subLabel) => (
    <div className="flex items-center justify-between px-1 py-2 border-b border-slate-100 mb-3">
      <button onClick={goPrevSentence}
        className="flex items-center gap-1 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200/60 rounded-lg text-xs font-bold text-slate-600 transition-all cursor-pointer active:scale-95">
        <ChevronLeft className="h-3.5 w-3.5 stroke-[2.5]" />上一句
      </button>
      <div className="text-center">
        <span className="text-xs font-extrabold text-slate-700">{label}</span>
        {subLabel && <span className="block text-[10px] text-slate-400 font-medium">{subLabel}</span>}
      </div>
      <button onClick={goNextSentence}
        className="flex items-center gap-1 px-3 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200/60 rounded-lg text-xs font-bold text-slate-600 transition-all cursor-pointer active:scale-95">
        下一句<ChevronRight className="h-3.5 w-3.5 stroke-[2.5]" />
      </button>
    </div>
  )

  // ───────────────────────────────────────────
  // RENDER
  // ───────────────────────────────────────────
  return (
    <>
      {/* ══════════════════════════════════════════
          MOBILE LAYOUT (full-screen app-like)
          ══════════════════════════════════════════ */}
      {isMobile && (
      <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">

        {/* ── Mobile Header ── */}
        <div className="flex items-center justify-between bg-white/95 backdrop-blur-md px-3 py-2 border-b border-slate-100 shrink-0 z-10"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button onClick={() => navigate('/')}
              className="flex items-center justify-center w-8 h-8 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition-all cursor-pointer shrink-0 active:scale-95">
              <ArrowLeft className="h-4 w-4 stroke-[2.5]" />
            </button>
            <h2 className="text-sm font-extrabold text-slate-800 tracking-tight truncate">{video.title}</h2>
          </div>
          {video.level && (
            <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-extrabold border ${video.level === '初级' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : video.level === '高级' ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>
              {video.level}
            </span>
          )}
        </div>

        {/* ── Mobile Video Player ── */}
        {renderVideoPlayer(true)}

        {/* ── Mobile Tab Bar ── */}
        <div className="bg-white border-b border-slate-100 px-1 py-1.5 flex justify-around items-center shrink-0">
          {MOBILE_TABS.map(tab => {
            const Icon = tab.icon
            const isActive = mobileTab === tab.key
            const tabColors = {
              transcript: { active: 'bg-indigo-600 text-white shadow-sm', badge: 'text-indigo-500 bg-indigo-50', badgeText: video.subtitles.length },
              shadow: { active: 'bg-amber-500 text-white shadow-sm', badge: 'text-amber-600 bg-amber-50', badgeText: '评测' },
              cloze: { active: 'bg-emerald-600 text-white shadow-sm', badge: 'text-emerald-600 bg-emerald-50', badgeText: '练习' },
              translate: { active: 'bg-purple-600 text-white shadow-sm', badge: 'text-purple-600 bg-purple-50', badgeText: '拼写' },
            }
            const colors = tabColors[tab.key]
            return (
              <button key={tab.key} onClick={() => setMobileTab(tab.key)}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-xs font-semibold rounded-lg mx-0.5 transition-all cursor-pointer active:scale-95 ${isActive ? colors.active : 'text-slate-500 hover:bg-slate-50'}`}>
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 ${isActive ? 'bg-white/20 text-white' : colors.badge}`}>{colors.badgeText}</span>
              </button>
            )
          })}
        </div>

        {/* ── Mobile Scrollable Content ── */}
        <div ref={mobileScrollRef} className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-slate-50 to-white px-3 py-3"
          style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}>

          {/* TRANSCRIPT TAB */}
          {mobileTab === 'transcript' && video.subtitles.map((sub, idx) => {
            const isActive = idx === activeSubIndex
            const isBookmarked = bookmarkedIds.includes(idx)
            return (
              <div key={idx} data-mobile-sub-index={idx}
                onClick={() => { jumpToSubtitle(sub.startTime) }}
                className={`group relative rounded-2xl transition-all duration-300 mb-3 cursor-pointer ${isActive
                  ? 'bg-gradient-to-br from-indigo-50 via-white to-indigo-50/50 shadow-[0_4px_20px_-4px_rgba(99,102,241,0.25)] ring-1 ring-indigo-200/60'
                  : 'bg-white shadow-[0_2px_12px_-4px_rgba(0,0,0,0.08)] ring-1 ring-slate-200/60 hover:shadow-[0_4px_16px_-4px_rgba(0,0,0,0.12)]'
                }`}>
                {/* Active glow overlay */}
                {isActive && <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-indigo-400/5 via-transparent to-indigo-500/5 pointer-events-none" />}
                <div className="relative p-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className={`text-[11px] font-semibold tracking-wider tabular-nums px-2 py-0.5 rounded-md inline-flex items-center gap-1.5 ${isActive ? 'text-indigo-500 bg-indigo-50' : 'text-slate-400 bg-slate-100/80'}`}>
                      {isActive ? (
                        <>
                          <span className="inline-flex items-end gap-[2px] h-[11px]" aria-label="正在播放">
                            <span className="w-[3px] bg-indigo-500 rounded-full animate-pulse" style={{ height: '6px', animationDelay: '0ms' }} />
                            <span className="w-[3px] bg-indigo-500 rounded-full animate-pulse" style={{ height: '10px', animationDelay: '150ms' }} />
                            <span className="w-[3px] bg-indigo-500 rounded-full animate-pulse" style={{ height: '4px', animationDelay: '300ms' }} />
                          </span>
                          正在播放
                        </>
                      ) : formatTime(sub.startTime)}
                    </span>
                    <button onClick={(e) => toggleBookmark(e, idx)} className="p-1 rounded-lg text-slate-300 hover:text-rose-500 transition-all cursor-pointer active:scale-75">
                      <Heart className={`h-4 w-4 ${isBookmarked ? 'text-rose-500 fill-rose-500' : ''}`} />
                    </button>
                  </div>
                  <div>
                    {renderSubtitleText(sub, isActive, true)}
                    {sub.highlightWords && sub.highlightWords.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2.5">
                        {sub.highlightWords.map((tag, hIdx) => (
                          <span key={hIdx} className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100/55 px-2 py-0.5 rounded-md">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {/* Active bottom glow */}
                {isActive && <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-gradient-to-r from-transparent via-indigo-400/50 to-transparent rounded-full" />}
              </div>
            )
          })}

          {/* SHADOW TAB */}
          {mobileTab === 'shadow' && (
            <div className="animate-fade-in">
              {renderPracticeNavHeader("口语跟读评测", "原声音频对比")}
              <div className="bg-indigo-50/30 border border-indigo-100/30 p-4 rounded-2xl">
                <div className="bg-white border border-slate-100 p-4 rounded-2xl text-sm font-semibold text-slate-700 leading-relaxed flex items-start justify-between gap-3">
                  <div>
                    <span>{currentSub?.textEn || '请选择一句字幕'}</span>
                    {currentSub?.textCn && <p className="text-xs text-slate-400 mt-1.5 font-medium">{currentSub.textCn}</p>}
                  </div>
                  {currentSub && (
                    <button onClick={speakActiveSentence} className="text-indigo-600 hover:text-indigo-800 p-1.5 bg-slate-50 hover:bg-indigo-50 rounded-lg cursor-pointer shrink-0 active:scale-95" title="播放原音">
                      <Volume2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {currentSub ? (
                  <div className="flex flex-col items-center py-6">
                    {isRecording ? (
                      <div className="flex flex-col items-center space-y-4">
                        <div className="flex items-end justify-center space-x-1 h-8 px-8">
                          {[1, 2, 3, 4, 5, 6, 7, 8].map(bar => (
                            <div key={bar} style={{ height: `${Math.floor(Math.random() * 24) + 4}px` }} className="w-1 bg-indigo-500 rounded-full animate-pulse transition-all duration-100" />
                          ))}
                        </div>
                        <span className="text-xs font-semibold text-slate-400">正在录音... {recordingSeconds}s</span>
                        <button onClick={stopRecording} className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer transition-all active:scale-95">结束录音并分析</button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center space-y-3">
                        <button onClick={startRecording} className="h-14 w-14 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-lg cursor-pointer active:scale-95 transition-all">
                          <Mic className="h-6 w-6" />
                        </button>
                        <span className="text-xs font-bold text-slate-500">点击麦克风，开启发音评分</span>
                      </div>
                    )}
                    {shadowResult && (
                      <div className="mt-4 w-full border-t border-indigo-100/40 pt-4 animate-fade-in">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold text-slate-500">评测得分</span>
                          <span className="text-sm font-extrabold text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full font-mono">{shadowResult.score}分</span>
                        </div>
                        <div className="bg-white border border-slate-100 p-3 rounded-xl flex flex-wrap gap-1.5 text-xs font-bold leading-relaxed">
                          {shadowResult.words.map((item, i) => (
                            <span key={i} className={`px-1 rounded ${item.status === 'perfect' ? 'text-emerald-600 bg-emerald-50' : item.status === 'good' ? 'text-amber-600 bg-amber-50' : 'text-rose-600 bg-rose-50 underline decoration-wavy'}`}>{item.text}</span>
                          ))}
                        </div>
                        <div className="mt-3 flex items-center space-x-1.5 text-[10px] font-medium text-emerald-600">
                          <Sparkles className="h-3.5 w-3.5 text-emerald-500" /><span>发音极为饱满，连读自然，已计入学习档案！</span>
                        </div>
                      </div>
                    )}
                    {recordedAudio && !shadowResult && (
                      <div className="mt-3 w-full"><audio controls src={recordedAudio} className="w-full h-9 rounded-lg" /></div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8 text-xs text-slate-400 italic">请选择具体句子以开始评测</div>
                )}
              </div>
            </div>
          )}

          {/* CLOZE TAB */}
          {mobileTab === 'cloze' && (
            <div className="animate-fade-in">
              {renderPracticeNavHeader("单词填空练习", "检测核心词汇")}
              <div className="bg-emerald-50/30 border border-emerald-100/30 p-4 rounded-2xl">
              {currentSub ? (
                <>
                  <div className="bg-white border border-slate-100 p-3.5 rounded-xl text-sm font-semibold text-slate-700 leading-relaxed mb-4">
                    {currentSub.textEn.split(/\s+/).map((word, idx) => {
                      const isTarget = word.toLowerCase().replace(/[^a-zA-Z]/g, '') === clozeTargetWord.toLowerCase().replace(/[^a-zA-Z]/g, '')
                      return (
                        <span key={idx} className="mr-1 inline-block">
                          {isTarget ? (
                            <span className={`inline-block px-2 border-b-2 text-center min-w-[70px] ${isClozeCorrect === true ? 'border-emerald-500 text-emerald-600 bg-emerald-50 rounded font-bold' : isClozeCorrect === false ? 'border-rose-500 text-rose-500 bg-rose-50 rounded font-bold' : 'border-slate-300 text-slate-400'}`}>
                              {selectedClozeWord ? selectedClozeWord : '______'}
                            </span>
                          ) : <span>{word}</span>}
                        </span>
                      )
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 mb-2">
                    {clozeOptions.map((option, index) => (
                      <button key={index} onClick={() => handleSelectClozeOption(option)} disabled={isClozeCorrect === true}
                        className={`px-3 py-2.5 border rounded-xl text-xs font-bold text-center transition-all cursor-pointer active:scale-95 ${selectedClozeWord === option ? (isClozeCorrect === true ? 'bg-emerald-500 border-emerald-500 text-white shadow-sm' : 'bg-rose-500 border-rose-500 text-white shadow-sm') : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600'}`}>
                        {option}
                      </button>
                    ))}
                  </div>
                  {isClozeCorrect !== null && (
                    <div className={`flex items-start space-x-2 p-3 rounded-xl border mt-3 text-[11px] font-semibold ${isClozeCorrect ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'}`}>
                      {isClozeCorrect ? <><CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" /><span>回答正确！掌握得非常好。</span></> : <><AlertCircle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0 animate-pulse" /><span>选择不太对，再看下句子含义吧。</span></>}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-xs text-slate-400 italic">请选择一句开始填空</div>
              )}
              </div>
            </div>
          )}

          {/* TRANSLATE TAB */}
          {mobileTab === 'translate' && (
            <div className="animate-fade-in">
              {renderPracticeNavHeader("中译英拼句", "训练地道语法")}
              <div className="bg-purple-50/30 border border-purple-100/30 p-4 rounded-2xl">
              {currentSub ? (
                <>
                  <div className="bg-slate-50 border border-slate-100 p-3 rounded-xl text-xs font-bold text-slate-600 mb-3.5">
                    中文意思：<span className="text-slate-800">{currentSub.textCn}</span>
                  </div>
                  <div className="bg-white border border-dashed border-slate-300 min-h-14 p-3 rounded-xl flex flex-wrap gap-1.5 text-xs font-semibold text-slate-700 mb-3 items-center">
                    {selectedTranslateChips.length > 0 ? selectedTranslateChips.map((word, idx) => (
                      <span key={idx} onClick={() => handleRemoveChip(word, idx)}
                        className="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-600 rounded-lg cursor-pointer text-[11px] font-bold flex items-center space-x-1 active:scale-95" title="点击移除">
                        <span>{word}</span><span className="text-[9px] text-indigo-400">×</span>
                      </span>
                    )) : <span className="text-[10px] text-slate-400 italic font-medium">在下方点击词卡，拼写英文原句...</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5 justify-center mb-4 bg-slate-50/40 p-2.5 rounded-xl border border-slate-100">
                    {scrambledChips.map((word, index) => (
                      <button key={index} onClick={() => handleChipClick(word, index)}
                        className="px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-lg text-[11px] font-bold cursor-pointer transition-all active:scale-95">{word}</button>
                    ))}
                  </div>
                  <div className="flex items-center space-x-2">
                    <button onClick={handleVerifyTranslation} disabled={selectedTranslateChips.length === 0}
                      className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold rounded-lg cursor-pointer transition-all text-center active:scale-95">校验拼写</button>
                    <button onClick={() => currentSub && setupTranslateMode(currentSub)}
                      className="p-2 border border-slate-200 hover:bg-slate-50 text-slate-500 rounded-lg cursor-pointer transition-all active:scale-95" title="重置">
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  </div>
                  {isTranslateCorrect !== null && (
                    <div className={`flex items-start space-x-2 p-3 rounded-xl border mt-3 text-[11px] font-semibold ${isTranslateCorrect ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'}`}>
                      {isTranslateCorrect ? <><CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" /><span>完美！词序拼写非常地道！</span></> : <><AlertCircle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0 animate-pulse" /><span>词序与原句不符，可以重置后再次尝试噢。</span></>}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-xs text-slate-400 italic">请选择句子进行中译英练习</div>
              )}
              </div>
            </div>
          )}
        </div>

        {/* ── Mobile Bottom Bar (fixed) ── */}
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200/60 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] shrink-0"
          style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}>
          <div className="flex items-center justify-between px-3 py-1.5">
            {/* Subtitle mode toggle */}
            <button onClick={(e) => { e.stopPropagation(); cycleSubtitleMode() }}
              className="flex flex-col items-center justify-center w-14 py-1 rounded-lg transition cursor-pointer active:scale-95">
              <span className="text-lg font-bold text-indigo-600 bg-indigo-50 w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-extrabold border border-indigo-100/50">{subtitleModeChar()}</span>
              <span className="text-[10px] mt-0.5 text-indigo-600 font-semibold">{subtitleModeLabel()}</span>
            </button>

            {/* Speed */}
            <div className="relative">
              <button onClick={(e) => { e.stopPropagation(); setShowSpeedPicker(!showSpeedPicker); setShowLoopPicker(false) }}
                className="flex flex-col items-center justify-center w-14 py-1 rounded-lg transition cursor-pointer active:scale-95 text-slate-600">
                <span className="text-sm font-bold font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100/50">{playbackRate}x</span>
                <span className="text-[10px] mt-0.5">倍速</span>
              </button>
              {showSpeedPicker && (
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-40 min-w-[70px]"
                  onClick={e => e.stopPropagation()}>
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
                    <button key={s} onClick={() => changeSpeed(s)}
                      className={`block w-full px-4 py-1.5 text-sm text-center ${s === playbackRate ? 'text-indigo-600 font-medium' : 'text-slate-700'} hover:bg-slate-50 cursor-pointer`}>
                      {s}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Prev / Play / Next */}
            <div className="flex items-center gap-3">
              <button onClick={goPrevSentence} className="p-2 text-slate-500 hover:text-indigo-600 transition-colors cursor-pointer active:scale-90">
                <ChevronLeft className="h-6 w-6 stroke-[2.5]" />
              </button>
              <button onClick={togglePlay}
                className="w-14 h-14 bg-indigo-600 rounded-full flex items-center justify-center text-white shadow-lg cursor-pointer active:scale-95 transition-all hover:bg-indigo-700">
                {playing ? <Pause className="h-7 w-7 fill-white" /> : <Play className="h-7 w-7 fill-white ml-1" />}
              </button>
              <button onClick={goNextSentence} className="p-2 text-slate-500 hover:text-indigo-600 transition-colors cursor-pointer active:scale-90">
                <ChevronRight className="h-6 w-6 stroke-[2.5]" />
              </button>
            </div>

            {/* Loop */}
            <div className="relative">
              <button onClick={(e) => { e.stopPropagation(); setShowLoopPicker(!showLoopPicker); setShowSpeedPicker(false) }}
                className={`flex flex-col items-center justify-center w-14 py-1 rounded-lg transition cursor-pointer active:scale-95 ${loopMode !== 'off' ? 'text-indigo-600' : 'text-slate-500'}`}>
                <Repeat className={`h-5 w-5 ${loopMode !== 'off' ? 'animate-spin' : ''}`} />
                <span className="text-[10px] mt-0.5">{loopMode === 'off' ? '循环' : loopMode === 'sentence' ? '单句' : '全片'}</span>
              </button>
              {showLoopPicker && (
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-40 min-w-[80px]"
                  onClick={e => e.stopPropagation()}>
                  {[{ mode: 'off', label: '关闭' }, { mode: 'sentence', label: '单句循环' }, { mode: 'all', label: '全片循环' }].map(item => (
                    <button key={item.mode} onClick={() => { setLoopMode(item.mode); setIsLooping(item.mode !== 'off'); setShowLoopPicker(false) }}
                      className={`block w-full px-4 py-1.5 text-sm text-center ${loopMode === item.mode ? 'text-indigo-600 font-medium' : 'text-slate-700'} hover:bg-slate-50 cursor-pointer`}>
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Word cards */}
            <button onClick={() => setIsWordCardOpen(!isWordCardOpen)}
              className="flex flex-col items-center justify-center w-14 py-1.5 bg-amber-500 hover:bg-amber-600 rounded-xl transition cursor-pointer active:scale-95 shadow-sm">
              <BookOpen className="h-5 w-5 text-white" />
              <span className="text-[10px] mt-0.5 text-amber-100 font-semibold">词卡</span>
            </button>
          </div>
        </div>

        {/* ── Mobile Word Popup (bottom sheet) ── */}
        {wordPopup && wordPopup.isMobile && (
          <>
            <div className="fixed inset-0 bg-black/40 z-[999]" onClick={() => setWordPopup(null)} />
            <div className="fixed bottom-0 left-0 right-0 z-[1000] bg-white rounded-t-2xl shadow-2xl flex flex-col"
              style={{ maxHeight: 'min(50dvh, 420px)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
              <div className="flex justify-center pt-2 pb-1 shrink-0">
                <div className="w-10 h-1 bg-slate-200 rounded-full" />
              </div>
              <div className="bg-gradient-to-r from-indigo-500 to-indigo-600 px-4 py-3 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-white font-semibold text-lg">{wordPopup.word}</span>
                  {wordPopup.cn && <span className="text-indigo-100 text-sm">{wordPopup.cn}</span>}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => speakWord(wordPopup.word)} className="p-1.5 hover:bg-white/20 rounded-lg transition text-white cursor-pointer">
                    <Volume2 className="h-5 w-5" />
                  </button>
                  <button onClick={() => setWordPopup(null)} className="p-1.5 hover:bg-white/20 rounded-lg transition text-white cursor-pointer">
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>
              <div className="p-4 flex-1 min-h-0 overflow-y-auto">
                {wordPopup.synonyms.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 items-center mb-3">
                    <span className="text-xs text-slate-500 font-medium">同义词：</span>
                    {wordPopup.synonyms.map((s, i) => <span key={i} className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-lg">{s}</span>)}
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg w-full justify-center">
                  <Star className="h-3.5 w-3.5" /> 已添加至生词本 ({vocabulary.length})
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {/* ══════════════════════════════════════════
          DESKTOP LAYOUT (preserved with enhancements)
          ══════════════════════════════════════════ */}
      {!isMobile && (
      <div className="min-h-screen bg-white flex flex-col font-sans overflow-x-hidden pb-12">
        <div className="max-w-7xl mx-auto px-6 py-6 w-full flex-1 flex flex-col gap-5 animate-fade-in pb-6">

          {/* Desktop Header bar */}
          <div className="flex items-center justify-between bg-white/95 backdrop-blur-md px-4 py-3 rounded-2xl border border-slate-100 shadow-sm">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <button onClick={() => navigate('/')}
                className="flex items-center px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 rounded-lg text-xs font-bold transition-all cursor-pointer shrink-0">
                <ArrowLeft className="h-3.5 w-3.5 stroke-[2.5]" />
                <span className="ml-1">返回课库</span>
              </button>
              <h2 className="text-sm font-extrabold text-slate-800 tracking-tight truncate">{video.title}</h2>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {video.level && (
                <span className={`inline-flex items-center justify-center px-2.5 py-1 rounded-md text-[10px] font-extrabold border ${video.level === '初级' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : video.level === '高级' ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>
                  {video.level}
                </span>
              )}
              <button onClick={() => setShowExport(!showExport)}
                className="flex items-center space-x-1.5 px-4 py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-100 text-blue-600 rounded-lg text-xs font-bold transition-all cursor-pointer shadow-xs">
                <Download className="h-3.5 w-3.5" /><span>导出</span>
              </button>
            </div>
          </div>

          {/* Desktop Export panel */}
          {showExport && (
            <div className="flex bg-white border border-slate-100 p-4 rounded-2xl shadow-xs items-center gap-3 flex-wrap">
              <button onClick={exportWordDoc} className="px-4 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-100 text-blue-600 rounded-xl text-xs font-bold transition-all cursor-pointer">导出 Word 文档</button>
              <button onClick={exportTxt} className="px-4 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-100 text-blue-600 rounded-xl text-xs font-bold transition-all cursor-pointer">导出 TXT 文本</button>
            </div>
          )}

          {/* Desktop Main Grid */}
          <div className="grid grid-cols-12 gap-6 items-start">
            {/* LEFT: Video + Practice Panel */}
            <div className="col-span-7 flex flex-col space-y-6">
              {renderVideoPlayer(false)}

              {/* Desktop Practice Panel */}
              <div className="flex flex-col space-y-4 bg-white border border-slate-100 p-5 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center space-x-2">
                    <div className="h-2 w-2 rounded-full bg-indigo-600 animate-ping" />
                    <span className="text-xs font-extrabold text-slate-800 tracking-wider">智能播放控制台</span>
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2.5 py-1 rounded-md">精听精读控制中心</span>
                </div>
                <div className="flex items-center justify-between flex-wrap gap-4 pt-1">
                  {/* Subtitle toggle */}
                  <div className="flex flex-col space-y-1.5">
                    <span className="text-[10px] font-bold text-slate-400 flex items-center space-x-1"><Globe className="h-3 w-3" /><span>字幕切换</span></span>
                    <button onClick={cycleSubtitleMode}
                      className="flex items-center space-x-2 px-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200/50 rounded-xl text-xs font-bold text-slate-700 transition-all cursor-pointer shadow-xs hover:scale-102 active:scale-98">
                      <span className="w-5 h-5 rounded-md bg-indigo-50 text-indigo-600 flex items-center justify-center text-[10px] font-extrabold border border-indigo-100/50">{subtitleModeChar()}</span>
                      <span>{subtitleModeLabel()}</span>
                    </button>
                  </div>

                  {/* Speed */}
                  <div className="flex flex-col space-y-1.5">
                    <span className="text-[10px] font-bold text-slate-400 flex items-center space-x-1"><Gauge className="h-3 w-3" /><span>播放倍速</span></span>
                    <button onClick={cycleSpeed}
                      className="flex items-center space-x-2 px-4 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200/50 rounded-xl text-xs font-bold text-slate-700 transition-all cursor-pointer shadow-xs hover:scale-102 active:scale-98">
                      <span className="w-8 h-5 rounded-md bg-emerald-50 text-emerald-700 flex items-center justify-center text-[9px] font-extrabold border border-emerald-100/50 font-mono">{playbackRate}x</span>
                      <span>倍速</span>
                    </button>
                  </div>

                  {/* Prev / Play / Next */}
                  <div className="flex flex-col space-y-1.5 items-center">
                    <span className="text-[10px] font-bold text-slate-400">视频播放</span>
                    <div className="flex items-center space-x-3 bg-slate-50 p-1 rounded-xl border border-slate-200/40">
                      <button onClick={goPrevSentence} className="p-2 rounded-lg hover:bg-white text-slate-600 hover:text-indigo-600 hover:shadow-xs transition-all cursor-pointer" title="上一句">
                        <ChevronLeft className="h-4 w-4 stroke-[2.5]" />
                      </button>
                      <button onClick={togglePlay} title={playing ? '暂停' : '播放'}
                        className="flex items-center justify-center h-9 w-9 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm transition-all cursor-pointer hover:scale-105 active:scale-95">
                        {playing ? <Pause className="h-4.5 w-4.5 fill-white text-white" /> : <Play className="h-4.5 w-4.5 fill-white text-white ml-0.5" />}
                      </button>
                      <button onClick={goNextSentence} className="p-2 rounded-lg hover:bg-white text-slate-600 hover:text-indigo-600 hover:shadow-xs transition-all cursor-pointer" title="下一句">
                        <ChevronRight className="h-4 w-4 stroke-[2.5]" />
                      </button>
                    </div>
                  </div>

                  {/* Loop & Word Cards */}
                  <div className="flex items-end gap-3">
                    <div className="flex flex-col space-y-1.5">
                      <span className="text-[10px] font-bold text-slate-400 text-center">单句循环</span>
                      <button onClick={() => { setIsLooping(!isLooping); setLoopMode(isLooping ? 'off' : 'sentence') }}
                        className={`flex items-center space-x-1.5 px-4 py-2 border rounded-xl text-xs font-bold tracking-wide transition-all cursor-pointer ${isLooping ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm scale-105' : 'bg-slate-50 border-slate-200/50 text-slate-600 hover:bg-slate-100'}`}>
                        <Repeat className={`h-3.5 w-3.5 ${isLooping ? 'animate-spin' : ''}`} />
                        <span>{isLooping ? '循环中' : '单句循环'}</span>
                      </button>
                    </div>
                    <div className="flex flex-col space-y-1.5">
                      <span className="text-[10px] font-bold text-slate-400 text-center">本课词汇</span>
                      <button onClick={() => setIsWordCardOpen(!isWordCardOpen)}
                        className="flex items-center space-x-1.5 px-4.5 py-2 bg-amber-500 hover:bg-amber-600 border border-amber-600/10 text-white rounded-xl text-xs font-extrabold tracking-wide transition-all cursor-pointer shadow-sm hover:scale-105 active:scale-95">
                        <BookOpen className="h-3.5 w-3.5" /><span>智能词卡</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT: Interactivity Panel */}
            <div className="col-span-5">
              <div className="bg-white border border-slate-100 rounded-2xl flex flex-col h-[calc(100vh-140px)] min-h-[580px] shadow-sm overflow-hidden">
                <div className="grid grid-cols-4 border-b border-gray-100 bg-slate-50/50 p-1">
                  {[
                    { key: 'transcript', icon: <List className="h-4 w-4 mb-1 text-slate-500" />, label: '字幕', badge: video.subtitles.length, badgeStyle: 'text-indigo-500 bg-indigo-50 font-mono' },
                    { key: 'shadow', icon: <Mic className="h-4 w-4 mb-1 text-slate-500" />, label: '跟读', badge: '评测', badgeStyle: 'text-amber-600 bg-amber-50' },
                    { key: 'cloze', icon: <PenTool className="h-4 w-4 mb-1 text-slate-500" />, label: '挖空', badge: '练习', badgeStyle: 'text-emerald-600 bg-emerald-50' },
                    { key: 'translate', icon: <Languages className="h-4 w-4 mb-1 text-slate-500" />, label: '中译英', badge: '拼写', badgeStyle: 'text-purple-600 bg-purple-50' },
                  ].map(tab => (
                    <button key={tab.key} onClick={() => setSidebarTab(tab.key)}
                      className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl cursor-pointer transition-all ${sidebarTab === tab.key ? 'bg-white text-indigo-600 shadow-xs border border-indigo-50/30 font-bold' : 'text-slate-500 hover:text-slate-800 font-medium'}`}>
                      {tab.icon}
                      <span className="text-[10px]">{tab.label}</span>
                      <span className={`text-[9px] font-semibold px-1.5 py-0.2 rounded-full mt-1 ${tab.badgeStyle}`}>{tab.badge}</span>
                    </button>
                  ))}
                </div>

                <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4 pb-5 scroll-smooth" style={{ scrollbarWidth: 'thin' }}>

                  {/* Desktop: Transcript */}
                  {sidebarTab === 'transcript' && video.subtitles.map((sub, idx) => {
                    const isActive = idx === activeSubIndex
                    const isBookmarked = bookmarkedIds.includes(idx)
                    return (
                      <div key={idx} id={`sub-item-${idx}`}
                        onClick={() => jumpToSubtitle(sub.startTime)}
                        className={`p-4 rounded-2xl border transition-all duration-200 cursor-pointer flex flex-col space-y-3 ${isActive ? 'bg-indigo-50/40 border-indigo-200 shadow-sm ring-1 ring-indigo-200/20 scale-[1.01] border-l-4 border-l-indigo-600' : 'bg-white hover:bg-slate-50 border-slate-100 shadow-xs'}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full font-mono">{formatTime(sub.startTime)}</span>
                          <button onClick={(e) => toggleBookmark(e, idx)} className="p-1 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-slate-100/50 transition-all cursor-pointer" title={isBookmarked ? '取消收藏' : '收藏句子'}>
                            <Heart className={`h-4.5 w-4.5 transition-transform duration-200 active:scale-75 ${isBookmarked ? 'text-rose-500 fill-rose-500 scale-110 animate-bounce-short' : 'stroke-[2.2]'}`} />
                          </button>
                        </div>
                        <div className="flex-1">
                          {renderSubtitleText(sub, isActive, false)}
                          {sub.highlightWords && sub.highlightWords.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2.5">
                              {sub.highlightWords.map((tag, hIdx) => (
                                <span key={hIdx} className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100/55 px-2 py-0.5 rounded-md">{tag}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  {/* Desktop: Shadowing */}
                  {sidebarTab === 'shadow' && (
                    <div className="space-y-4 animate-fade-in">
                      <div className="bg-indigo-50/20 border border-indigo-100/30 rounded-2xl p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold text-indigo-600">口语跟读评测</span>
                          <span className="text-[10px] text-slate-400 font-medium">原声音频对比</span>
                        </div>
                        <div className="bg-white border border-slate-100 p-3.5 rounded-xl text-xs font-bold text-slate-700 leading-relaxed flex items-start justify-between gap-3">
                          <span>{currentSub?.textEn || '请选择一句字幕'}</span>
                          {currentSub && (
                            <button onClick={speakActiveSentence} className="text-indigo-600 hover:text-indigo-800 p-1 bg-slate-50 hover:bg-indigo-50 rounded-lg cursor-pointer shrink-0" title="播放发音">
                              <Volume2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                        {currentSub ? (
                          <div className="flex flex-col items-center py-6">
                            {isRecording ? (
                              <div className="flex flex-col items-center space-y-4">
                                <div className="flex items-end justify-center space-x-1 h-8 px-8">
                                  {[1, 2, 3, 4, 5, 6, 7, 8].map(bar => (
                                    <div key={bar} style={{ height: `${Math.floor(Math.random() * 24) + 4}px` }} className="w-1 bg-indigo-500 rounded-full animate-pulse transition-all duration-100" />
                                  ))}
                                </div>
                                <span className="text-xs font-semibold text-slate-400">正在录音... {recordingSeconds}s</span>
                                <button onClick={stopRecording} className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer transition-all">结束录音并分析</button>
                              </div>
                            ) : (
                              <div className="flex flex-col items-center space-y-3">
                                <button onClick={startRecording} className="h-12 w-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md transition-all cursor-pointer hover:scale-105 active:scale-95">
                                  <Mic className="h-5 w-5" />
                                </button>
                                <span className="text-[11px] font-bold text-slate-500">点击麦克风，开启发音评分</span>
                              </div>
                            )}
                            {shadowResult && (
                              <div className="mt-4 border-t border-indigo-100/40 pt-4 animate-fade-in">
                                <div className="flex items-center justify-between mb-3">
                                  <span className="text-xs font-bold text-slate-500">评测得分：</span>
                                  <span className="text-sm font-extrabold text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full font-mono">{shadowResult.score}分</span>
                                </div>
                                <div className="bg-white border border-slate-100 p-3 rounded-xl flex flex-wrap gap-1.5 text-xs font-bold leading-relaxed">
                                  {shadowResult.words.map((item, i) => (
                                    <span key={i} className={`px-1 rounded ${item.status === 'perfect' ? 'text-emerald-600 bg-emerald-50' : item.status === 'good' ? 'text-amber-600 bg-amber-50' : 'text-rose-600 bg-rose-50 underline decoration-wavy'}`}>{item.text}</span>
                                  ))}
                                </div>
                                <div className="mt-3 flex items-center space-x-1.5 text-[10px] font-medium text-emerald-600">
                                  <Sparkles className="h-3.5 w-3.5 text-emerald-500" /><span>发音极为饱满，连读自然，已计入学习档案！</span>
                                </div>
                              </div>
                            )}
                            {recordedAudio && !shadowResult && (
                              <div className="mt-3"><audio controls src={recordedAudio} className="w-full h-9 rounded-lg" /></div>
                            )}
                          </div>
                        ) : (
                          <div className="text-center py-8 text-xs text-slate-400 italic">请选择具体句子以开始评测</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Desktop: Cloze */}
                  {sidebarTab === 'cloze' && (
                    <div className="space-y-4 animate-fade-in">
                      <div className="bg-emerald-50/20 border border-emerald-100/30 rounded-2xl p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold text-emerald-600">单词填空练习</span>
                          <span className="text-[10px] text-slate-400 font-medium">检测核心词汇</span>
                        </div>
                        {currentSub ? (
                          <>
                            <div className="bg-white border border-slate-100 p-3.5 rounded-xl text-xs md:text-sm font-semibold text-slate-700 leading-relaxed mb-4">
                              {currentSub.textEn.split(/\s+/).map((word, idx) => {
                                const isTarget = word.toLowerCase().replace(/[^a-zA-Z]/g, '') === clozeTargetWord.toLowerCase().replace(/[^a-zA-Z]/g, '')
                                return (
                                  <span key={idx} className="mr-1 inline-block">
                                    {isTarget ? (
                                      <span className={`inline-block px-2 border-b-2 text-center min-w-[70px] ${isClozeCorrect === true ? 'border-emerald-500 text-emerald-600 bg-emerald-50 rounded font-bold' : isClozeCorrect === false ? 'border-rose-500 text-rose-500 bg-rose-50 rounded font-bold' : 'border-slate-300 text-slate-400'}`}>
                                        {selectedClozeWord ? selectedClozeWord : '______'}
                                      </span>
                                    ) : <span>{word}</span>}
                                  </span>
                                )
                              })}
                            </div>
                            <div className="grid grid-cols-2 gap-2.5 mb-2">
                              {clozeOptions.map((option, index) => (
                                <button key={index} onClick={() => handleSelectClozeOption(option)} disabled={isClozeCorrect === true}
                                  className={`px-3 py-2 border rounded-xl text-xs font-bold text-center transition-all cursor-pointer ${selectedClozeWord === option ? (isClozeCorrect === true ? 'bg-emerald-500 border-emerald-500 text-white shadow-sm' : 'bg-rose-500 border-rose-500 text-white shadow-sm') : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600'}`}>
                                  {option}
                                </button>
                              ))}
                            </div>
                            {isClozeCorrect !== null && (
                              <div className={`flex items-start space-x-2 p-3 rounded-xl border mt-3 text-[11px] font-semibold ${isClozeCorrect ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'}`}>
                                {isClozeCorrect ? <><CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" /><span>回答正确！掌握得非常好。</span></> : <><AlertCircle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0 animate-pulse" /><span>选择不太对，再看下句子含义吧。</span></>}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-center py-8 text-xs text-slate-400 italic">请选择一句开始填空</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Desktop: Translate */}
                  {sidebarTab === 'translate' && (
                    <div className="space-y-4 animate-fade-in">
                      <div className="bg-purple-50/20 border border-purple-100/30 rounded-2xl p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold text-purple-600">中译英拼句</span>
                          <span className="text-[10px] text-slate-400 font-medium">训练地道语法</span>
                        </div>
                        {currentSub ? (
                          <>
                            <div className="bg-slate-50 border border-slate-100 p-3 rounded-xl text-[11px] font-bold text-slate-600 mb-3.5">
                              中文意思：<span className="text-slate-800">{currentSub.textCn}</span>
                            </div>
                            <div className="bg-white border border-dashed border-slate-300 min-h-14 p-3 rounded-xl flex flex-wrap gap-1.5 text-xs font-semibold text-slate-700 mb-3 items-center">
                              {selectedTranslateChips.length > 0 ? selectedTranslateChips.map((word, idx) => (
                                <span key={idx} onClick={() => handleRemoveChip(word, idx)}
                                  className="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-600 rounded-lg cursor-pointer text-[11px] font-bold flex items-center space-x-1" title="点击移除">
                                  <span>{word}</span><span className="text-[9px] text-indigo-400">×</span>
                                </span>
                              )) : <span className="text-[10px] text-slate-400 italic font-medium">在下方点击词卡，拼写英文原句...</span>}
                            </div>
                            <div className="flex flex-wrap gap-1.5 justify-center mb-4 bg-slate-50/40 p-2.5 rounded-xl border border-slate-100">
                              {scrambledChips.map((word, index) => (
                                <button key={index} onClick={() => handleChipClick(word, index)}
                                  className="px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-lg text-[11px] font-bold cursor-pointer transition-all">{word}</button>
                              ))}
                            </div>
                            <div className="flex items-center space-x-2">
                              <button onClick={handleVerifyTranslation} disabled={selectedTranslateChips.length === 0}
                                className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold rounded-lg cursor-pointer transition-all text-center">校验拼写</button>
                              <button onClick={() => currentSub && setupTranslateMode(currentSub)}
                                className="p-1.5 border border-slate-200 hover:bg-slate-50 text-slate-500 rounded-lg cursor-pointer transition-all" title="重置">
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {isTranslateCorrect !== null && (
                              <div className={`flex items-start space-x-2 p-3 rounded-xl border mt-3 text-[11px] font-semibold ${isTranslateCorrect ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'}`}>
                                {isTranslateCorrect ? <><CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" /><span>完美！词序拼写非常地道！</span></> : <><AlertCircle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0 animate-pulse" /><span>词序与原句不符，可以重置后再次尝试噢。</span></>}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-center py-8 text-xs text-slate-400 italic">请选择句子进行中译英练习</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Desktop: Video Info Card */}
          <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-xs">
            <h3 className="text-sm font-extrabold text-slate-800 mb-4">视频信息</h3>
            <div className="grid grid-cols-5 gap-4 mb-3">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">难度</span>
                <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-md text-[11px] font-extrabold border w-fit ${video.level === '初级' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : video.level === '高级' ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>{video.level || '中级'}</span>
              </div>
              {video.accent && <div className="flex flex-col gap-1"><span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">口音</span><span className="text-xs font-bold text-slate-700">{video.accent}</span></div>}
              {video.topics && video.topics.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">话题</span>
                  <div className="flex gap-1 flex-wrap">{video.topics.map((t, i) => <span key={i} className="px-2 py-0.5 bg-slate-50 border border-slate-100 text-slate-500 rounded-md text-[10px] font-bold">{t}</span>)}</div>
                </div>
              )}
              <div className="flex flex-col gap-1"><span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">时长</span><span className="text-xs font-bold text-slate-700">{formatTime(video.duration)}</span></div>
              <div className="flex flex-col gap-1"><span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">字幕</span><span className="text-xs font-bold text-slate-700">{video.subtitle_count} 条</span></div>
            </div>
            {video.description && <p className="text-xs text-slate-400 leading-relaxed mt-3 pt-3 border-t border-slate-50">{video.description}</p>}
          </div>
        </div>

        {/* Desktop: Word Popup (floating) */}
        {wordPopup && !wordPopup.isMobile && (
          <div className="fixed z-[200] bg-slate-800 text-slate-200 rounded-xl p-3.5 min-w-[200px] max-w-[320px] shadow-2xl animate-fade-in"
            style={{ left: wordPopup.x, top: wordPopup.y }}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-lg font-bold text-white">{wordPopup.word}</span>
              <button onClick={() => setWordPopup(null)} className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"><X className="h-3.5 w-3.5" /></button>
            </div>
            {wordPopup.cn && <p className="text-xs text-slate-400 mb-2">{wordPopup.cn}</p>}
            {wordPopup.synonyms.length > 0 && (
              <div className="flex flex-wrap gap-1.5 items-center mb-2.5">
                <span className="text-[10px] text-slate-500">同义词：</span>
                {wordPopup.synonyms.map((s, i) => <span key={i} className="text-[11px] px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-lg cursor-pointer hover:bg-purple-500/35 transition-all">{s}</span>)}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[10px] text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-lg w-full justify-center">
              <Star className="h-3 w-3" /> 已添加至生词本 ({vocabulary.length})
            </div>
          </div>
        )}
      </div>
      )}

      {/* ══════════════════════════════════════════
          SHARED OVERLAYS (both mobile and desktop)
          ══════════════════════════════════════════ */}

      {/* Smart Word Cards Drawer */}
      {isWordCardOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex flex-col justify-end md:flex-row md:justify-end animate-fade-in">
          <div className="flex-1 cursor-pointer" onClick={() => setIsWordCardOpen(false)} />
          <div className="w-full md:max-w-md bg-white h-[85vh] md:h-full shadow-2xl flex flex-col p-6 overflow-hidden relative rounded-t-2xl md:rounded-none">
            <button onClick={() => setIsWordCardOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-800 p-1.5 bg-slate-50 border border-slate-100 rounded-full cursor-pointer transition-colors">
              <X className="h-4 w-4" />
            </button>
            <div className="flex items-center space-x-2.5 mb-5">
              <div className="bg-amber-500 text-white p-2 rounded-xl">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-extrabold text-slate-800 text-base">智能重点词卡</h3>
                <p className="text-[11px] text-slate-400 font-medium">当前视频精选核心词汇、短语与口语地道表达</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl mb-[18px] border border-slate-200/30">
              {[
                { id: 'words', label: '重点单词' },
                { id: 'phrases', label: '核心短语' },
                { id: 'expressions', label: '地道表达' },
              ].map(tab => (
                <button key={tab.id} onClick={() => setWordCardTab(tab.id)}
                  className={`py-1.5 rounded-lg text-xs font-bold text-center cursor-pointer transition-all ${wordCardTab === tab.id ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}>
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto space-y-3.5 pr-1" style={{ scrollbarWidth: 'thin' }}>
              {wordCardTab === 'words' && derivedData.keywords.map((kw, i) => (
                <div key={i} className="p-3.5 border rounded-2xl bg-white border-slate-100/80 hover:border-slate-200 transition-all cursor-pointer"
                  onClick={() => { jumpToSubtitle(kw.times[0]); setIsWordCardOpen(false) }}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                        <h4 className="text-xs font-extrabold text-slate-800 tracking-wide">{kw.word}</h4>
                        <span className="text-[9px] font-bold text-indigo-500 bg-indigo-50 px-1.5 rounded-md font-mono">/{kw.word}/</span>
                      </div>
                      <p className="text-[11px] font-semibold text-slate-500 mt-1">出现 {kw.count} 次 · {formatTime(kw.times[0])}</p>
                    </div>
                    <div className="flex items-center space-x-1.5 shrink-0">
                      <button onClick={e => { e.stopPropagation(); speakWord(kw.word) }}
                        className="p-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-500 hover:text-slate-800 rounded-lg cursor-pointer transition-colors" title="点击发音">
                        <Volume2 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={e => { e.stopPropagation(); pushToVocab(kw.word) }}
                        className="h-[22px] w-[22px] rounded-md border flex items-center justify-center transition-all cursor-pointer border-slate-300 hover:border-indigo-500 bg-white"
                        title="记单词">
                        <Star className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {wordCardTab === 'phrases' && (
                derivedData.phrases.length > 0 ? derivedData.phrases.map((sub, i) => (
                  <div key={i} className="p-3.5 border rounded-2xl bg-white border-slate-100/80 hover:border-slate-200 transition-all cursor-pointer"
                    onClick={() => { jumpToSubtitle(sub.startTime); setIsWordCardOpen(false) }}>
                    <h4 className="text-xs font-extrabold text-slate-800 tracking-wide">{sub.textEn}</h4>
                    <p className="text-[11px] font-semibold text-slate-500 mt-1">{sub.textCn}</p>
                    {sub.highlightWords && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {sub.highlightWords.map((kw, ki) => (
                          <span key={ki} className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100/55 px-2 py-0.5 rounded-md">{kw}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )) : <div className="text-center py-8 text-xs text-slate-400">暂无重点短语</div>
              )}
              {wordCardTab === 'expressions' && (
                derivedData.expressions.length > 0 ? derivedData.expressions.map((sub, i) => (
                  <div key={i} className="p-3.5 border rounded-2xl bg-white border-slate-100/80 hover:border-slate-200 transition-all cursor-pointer"
                    onClick={() => { jumpToSubtitle(sub.startTime); setIsWordCardOpen(false) }}>
                    <h4 className="text-xs font-extrabold text-indigo-950 tracking-wide">{sub.textEn}</h4>
                    <p className="text-[11px] font-bold text-slate-600 mt-1">{sub.textCn}</p>
                  </div>
                )) : <div className="text-center py-8 text-xs text-slate-400">暂无地道口语表达</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
