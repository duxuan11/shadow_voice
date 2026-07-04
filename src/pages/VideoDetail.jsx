import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ArrowLeft, Play, Pause, Volume2, VolumeX, Maximize, SkipBack, SkipForward,
         Download, Star, Repeat, Gauge,
         BookOpen, Sparkles, MessageSquare, List, X, Volume1 } from 'lucide-react'

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const SYNONYMS = {
  'good': { synonyms: ['great', 'excellent', 'wonderful', 'nice'], cn: '好的，优秀的' },
  'bad': { synonyms: ['terrible', 'awful', 'poor', 'horrible'], cn: '坏的，糟糕的' },
  'big': { synonyms: ['large', 'huge', 'massive', 'enormous'], cn: '大的' },
  'small': { synonyms: ['tiny', 'little', 'miniature', 'compact'], cn: '小的' },
  'beautiful': { synonyms: ['gorgeous', 'stunning', 'lovely', 'pretty'], cn: '美丽的' },
  'happy': { synonyms: ['glad', 'joyful', 'delighted', 'pleased'], cn: '快乐的' },
  'sad': { synonyms: ['unhappy', 'sorrowful', 'miserable', 'upset'], cn: '悲伤的' },
  'important': { synonyms: ['crucial', 'vital', 'essential', 'significant'], cn: '重要的' },
  'difficult': { synonyms: ['hard', 'challenging', 'tough', 'tricky'], cn: '困难的' },
  'easy': { synonyms: ['simple', 'effortless', 'straightforward', 'basic'], cn: '容易的' },
  'fast': { synonyms: ['quick', 'rapid', 'swift', 'speedy'], cn: '快的' },
  'slow': { synonyms: ['sluggish', 'leisurely', 'gradual', 'unhurried'], cn: '慢的' },
  'interesting': { synonyms: ['fascinating', 'intriguing', 'engaging', 'captivating'], cn: '有趣的' },
  'amazing': { synonyms: ['incredible', 'astonishing', 'remarkable', 'extraordinary'], cn: '惊人的' },
}

export default function VideoDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const subtitleContainerRef = useRef(null)
  const { authFetch } = useAuth()

  const [video, setVideo] = useState(null)
  const [allVideos, setAllVideos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [loopMode, setLoopMode] = useState('off')
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)

  const [subtitleMode, setSubtitleMode] = useState('bilingual')
  const [activeSubIndex, setActiveSubIndex] = useState(-1)
  const [sidebarTab, setSidebarTab] = useState('subtitles')
  const [wordPopup, setWordPopup] = useState(null)
  const [showExport, setShowExport] = useState(false)
  const [showVideo, setShowVideo] = useState(true)
  const [abLoopA, setAbLoopA] = useState(null)
  const [abLoopB, setAbLoopB] = useState(null)
  const [sentenceGap, setSentenceGap] = useState(0)
  const [autoPauseSentence, setAutoPauseSentence] = useState(false)
  const [subtitleFontSize, setSubtitleFontSize] = useState(() => {
    try { return parseInt(localStorage.getItem('shadow_voice_fontsize') || '16') }
    catch { return 16 }
  })
  const [showMobileMore, setShowMobileMore] = useState(false)
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)

  // ── Learning mode ──
  const [learningMode, setLearningMode] = useState('normal')
  const mediaRecorderRef = useRef(null)
  const [recording, setRecording] = useState(false)
  const [recordedAudio, setRecordedAudio] = useState(null)
  const [clozeItems, setClozeItems] = useState([])
  const [clozeAnswers, setClozeAnswers] = useState({})
  const [clozeSubmitted, setClozeSubmitted] = useState(false)
  const [clozeDifficulty, setClozeDifficulty] = useState(2)
  const [translateAnswers, setTranslateAnswers] = useState({})
  const [translateSubmitted, setTranslateSubmitted] = useState(false)

  const [vocabulary, setVocabulary] = useState([])
  // eslint-disable-next-line no-unused-vars
  const [watchedHistory, setWatchedHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('shadow_voice_watched') || '[]') }
    catch { return [] }
  })

  useEffect(() => {
    fetch('/data/consolidated.json').then(r => r.json()).then(videos => {
      setAllVideos(videos)
      const found = videos.find(v => v.id === id)
      if (found) {
        setVideo(found)
        setWatchedHistory(prev => {
          const updated = [found.id, ...prev.filter(vid => vid !== found.id)].slice(0, 50)
          localStorage.setItem('shadow_voice_watched', JSON.stringify(updated))
          return updated
        })
      } else { setError('视频未找到') }
      setLoading(false)
    }).catch(() => { setError('加载失败'); setLoading(false) })
  }, [id])

  useEffect(() => {
    authFetch('/vocab').then(r => r.json()).then(d => setVocabulary(d.vocabulary || [])).catch(() => {})
  }, [id, authFetch])

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
      expressions: expressions.length > 0 ? expressions : video.subtitles.filter(s => s.textEn.length > 40).slice(0, 20),
    }
  }, [video])

  useEffect(() => {
    if (!video || !video.subtitles) return
    const idx = video.subtitles.findIndex(s => currentTime >= s.startTime && currentTime <= s.endTime)
    setActiveSubIndex(idx)
    if (idx >= 0 && subtitleContainerRef.current) {
      const el = document.getElementById(`sub-${idx}`)
      if (el) {
        const c = subtitleContainerRef.current, cr = c.getBoundingClientRect(), er = el.getBoundingClientRect()
        c.scrollTo({ top: er.top - cr.top + c.scrollTop - cr.height / 2 + er.height / 2, behavior: 'smooth' })
      }
    }
  }, [currentTime, video])

  const [loopStart, setLoopStart] = useState(null)
  const [loopEnd, setLoopEnd] = useState(null)
  useEffect(() => {
    if (loopMode !== 'sentence' || !video || activeSubIndex < 0) return
    const sub = video.subtitles[activeSubIndex]
    if (sub) { setLoopStart(sub.startTime); setLoopEnd(sub.endTime) }
  }, [activeSubIndex, loopMode, video])

  const handleTimeUpdate = () => {
    if (!videoRef.current) return
    const t = videoRef.current.currentTime; setCurrentTime(t)
    if (loopMode === 'sentence' && loopEnd && t >= loopEnd) videoRef.current.currentTime = loopStart || 0
  }
  const handleLoadedMetadata = () => { if (videoRef.current) setDuration(videoRef.current.duration) }
  const togglePlay = () => { if (!videoRef.current) return; playing ? videoRef.current.pause() : videoRef.current.play(); setPlaying(!playing) }
  const handleSeek = (e) => { const t = ((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.getBoundingClientRect().width) * duration; if (videoRef.current) videoRef.current.currentTime = t; setCurrentTime(t) }
  const jumpToSubtitle = (st) => { if (videoRef.current) { videoRef.current.currentTime = st; videoRef.current.play(); setPlaying(true) } }
  const toggleMute = () => { if (videoRef.current) { videoRef.current.muted = !muted; setMuted(!muted) } }
  const handleVolumeChange = (e) => { const v = parseFloat(e.target.value); if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0 } setVolume(v); setMuted(v === 0) }
  const handleFullscreen = () => { const el = videoRef.current?.parentElement; if (!el) return; document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen() }
  const changeSpeed = (s) => { if (videoRef.current) videoRef.current.playbackRate = s; setPlaybackRate(s); setShowSpeedMenu(false) }
  const cycleLoop = () => { const m = ['off','sentence','all']; const n = m[(m.indexOf(loopMode)+1)%3]; setLoopMode(n); if (videoRef.current) videoRef.current.loop = n==='all'; if (n!=='sentence'){setLoopStart(null);setLoopEnd(null)} }
  const goToNextVideo = () => { if (!allVideos.length) return; const i = allVideos.findIndex(v=>v.id===id); if (i>=0&&i<allVideos.length-1) navigate(`/video/${allVideos[i+1].id}`) }
  const handleVideoEnded = () => { setPlaying(false); if (loopMode==='all'&&videoRef.current) videoRef.current.play(); else goToNextVideo() }
  const skipTime = (s) => { if (videoRef.current) videoRef.current.currentTime = Math.max(0,Math.min(duration,videoRef.current.currentTime+s)) }
  const goPrevSentence = () => { if (!video?.subtitles) return; const idx = activeSubIndex>0?activeSubIndex-1:0; jumpToSubtitle(video.subtitles[idx].startTime) }
  const goNextSentence = () => { if (!video?.subtitles) return; const idx = activeSubIndex<video.subtitles.length-1?activeSubIndex+1:activeSubIndex; jumpToSubtitle(video.subtitles[idx].startTime) }
  const replaySentence = () => { if (activeSubIndex>=0&&video?.subtitles) jumpToSubtitle(video.subtitles[activeSubIndex].startTime); else if (videoRef.current) { videoRef.current.currentTime=0; videoRef.current.play(); setPlaying(true) } }
  const setABPoint = (pt) => { if (pt==='A'){setAbLoopA(currentTime);setAbLoopB(null)}else{if(abLoopA!==null&&currentTime>abLoopA)setAbLoopB(currentTime)} }
  const cycleABLoop = () => {
    if (abLoopA === null) { setAbLoopA(currentTime) }
    else if (abLoopB === null) { if (currentTime > abLoopA) setAbLoopB(currentTime) }
    else { clearABLoop() }
  }
  const clearABLoop = () => { setAbLoopA(null);setAbLoopB(null);if(videoRef.current)videoRef.current.loop=loopMode==='all';setLoopStart(null);setLoopEnd(null) }
  useEffect(() => { if (abLoopA!==null&&abLoopB!==null&&videoRef.current&&videoRef.current.currentTime>=abLoopB) videoRef.current.currentTime=abLoopA }, [currentTime,abLoopA,abLoopB])
  const [lastSubIdx, setLastSubIdx] = useState(-1)
  useEffect(() => { if (!autoPauseSentence||!video||!playing) return; if (activeSubIndex!==lastSubIdx&&lastSubIdx>=0&&sentenceGap>0) { videoRef.current?.pause(); setPlaying(false); setTimeout(()=>{if(videoRef.current){videoRef.current.play();setPlaying(true)}},sentenceGap*1000) } setLastSubIdx(activeSubIndex) }, [activeSubIndex,autoPauseSentence,playing])

  const handleWordClick = (word, e) => {
    if (!e) return; e.stopPropagation()
    const cw = word.replace(/[^a-zA-Z']/g,'').toLowerCase(); if (cw.length<2) return
    const sd = SYNONYMS[cw]; const r = e.target.getBoundingClientRect()
    setWordPopup({ word:cw, synonyms:sd?.synonyms||[], cn:sd?.cn||'', x:r.left, y:r.bottom+4 })
    authFetch('/vocab',{method:'POST',body:JSON.stringify({word:cw,videoId:id,videoTitle:video?.title})}).then(r=>r.json()).then(d=>{if(d.ok)authFetch('/vocab').then(r=>r.json()).then(d=>setVocabulary(d.vocabulary||[])).catch(()=>{})}).catch(()=>{})
  }

  const exportWordDoc = () => { if(!video)return; const c=`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${video.title}</title><style>body{font-family:"Microsoft YaHei",sans-serif;font-size:14pt;line-height:1.8;margin:40px;color:#333}h1{font-size:18pt;font-weight:bold;text-align:center;margin-bottom:10px}.info{text-align:center;color:#666;font-size:11pt;margin-bottom:30px;border-bottom:2px solid #e5e5e5;padding-bottom:20px}.time{color:#999;font-size:10pt}.english{font-size:14pt;color:#1a1a1a;margin:4px 0}.chinese{font-size:13pt;color:#666;margin:4px 0 16px 0}hr{border:none;border-top:1px solid #e5e5e5;margin:16px 0}</style></head><body><h1>${video.title} - 学习笔记</h1><div class="info">共 ${video.subtitles.length} 条字幕</div>${video.subtitles.map(s=>`${subtitleMode!=='chinese'?`<p class="english">${s.textEn}</p>`:''}${subtitleMode!=='english'?`<p class="chinese">${s.textCn}</p>`:''}<p class="time">${formatTime(s.startTime)}</p><hr/>`).join('')}</body></html>`; const b=new Blob([c],{type:'application/msword'}); const u=URL.createObjectURL(b); const a=document.createElement('a');a.href=u;a.download=`${video.title} - 学习笔记.doc`;a.click();URL.revokeObjectURL(u) }
  const exportTxt = () => { if (!video) return; let t=`${video.title} - 学习笔记\n${'='.repeat(40)}\n\n`; video.subtitles.forEach(s=>{t+=`[${formatTime(s.startTime)}]\n`; if(subtitleMode!=='chinese')t+=`${s.textEn}\n`; if(subtitleMode!=='english')t+=`${s.textCn}\n`; t+='\n'}); const b=new Blob([t],{type:'text/plain'}); const u=URL.createObjectURL(b); const a=document.createElement('a');a.href=u;a.download=`${video.title} - 字幕.txt`;a.click();URL.revokeObjectURL(u) }

  // Shadowing
  const startRecording = async () => { try { const s=await navigator.mediaDevices.getUserMedia({audio:true}); const r=new MediaRecorder(s); const ch=[]; r.ondataavailable=e=>ch.push(e.data); r.onstop=()=>{ const b=new Blob(ch,{type:'audio/webm'}); setRecordedAudio(URL.createObjectURL(b)); s.getTracks().forEach(t=>t.stop()) }; mediaRecorderRef.current=r; r.start(); setRecording(true); setRecordedAudio(null) } catch {} }
  const stopRecording = () => { if (mediaRecorderRef.current&&recording) { mediaRecorderRef.current.stop(); setRecording(false) } }

  // Cloze
  const generateCloze = (txt, diff) => { const w=txt.split(' '); if(w.length<4)return w.map(w=>({word:w,blank:false})); const n=Math.max(1,Math.floor(w.length*diff*0.15)); const s=new Set(); while(s.size<n){ const i=Math.floor(Math.random()*w.length); if(w[i].length>2&&!/^[',.!?;:]+$/.test(w[i]))s.add(i) } return w.map((w,i)=>({word:w,blank:s.has(i)})) }
  useEffect(() => { if(learningMode==='cloze'&&currentSub){setClozeItems(generateCloze(currentSub.textEn,clozeDifficulty));setClozeAnswers({});setClozeSubmitted(false)} if(learningMode==='translate'&&currentSub){setTranslateAnswers({});setTranslateSubmitted(false)} if(learningMode==='shadowing'){setRecordedAudio(null);setRecording(false)} }, [activeSubIndex,learningMode,clozeDifficulty])
  const submitCloze = () => setClozeSubmitted(true)

  useEffect(() => { if(!wordPopup)return; const t=setTimeout(()=>setWordPopup(null),4000); const c=()=>setWordPopup(null); document.addEventListener('click',c,{once:true}); return()=>{clearTimeout(t);document.removeEventListener('click',c)} }, [wordPopup])

  if (loading) return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>
  if (error) return <div className="error-container"><p>{error}</p><button onClick={() => navigate('/')}>返回首页</button></div>
  if (!video) return null

  const videoSrc = video.video_local || video.video_url
  const currentSub = activeSubIndex >= 0 ? video.subtitles[activeSubIndex] : null
  const englishWords = currentSub ? currentSub.textEn.split(' ') : []
  const submitTranslate = () => setTranslateSubmitted(true)

  const renderSidebarContent = () => (
    <>
      {sidebarTab === 'subtitles' && (
        <div className="subtitle-list-new">
          {video.subtitles.map((sub, idx) => (
            <div key={sub.id||idx} id={`sub-${idx}`} className={`subtitle-item-new ${idx===activeSubIndex?'active':''}`} onClick={()=>jumpToSubtitle(sub.startTime)}>
              <span className="sub-time-new">{formatTime(sub.startTime)}</span>
              <div className="sub-body-new">
                <div className="sub-texts-new">
                  {subtitleMode!=='chinese'&&<p className="sub-english-new">{sub.textEn.split(' ').map((w,wi)=><span key={wi} className="sub-word-new" onClick={e=>handleWordClick(w,e)}>{w} </span>)}</p>}
                  {subtitleMode!=='english'&&<p className="sub-chinese-new">{sub.textCn}</p>}
                </div>
                {sub.highlightWords&&sub.highlightWords.length>0&&<div className="sub-keywords-new">{sub.highlightWords.map((kw,ki)=><span key={ki} className="keyword-tag-new">{kw}</span>)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {sidebarTab === 'words' && (
        <div className="keywords-panel">
          {derivedData.keywords.length===0?<p className="sidebar-empty">暂无重点单词</p>:derivedData.keywords.map((kw,i)=>
            <div key={i} className="keyword-item-new" onClick={()=>jumpToSubtitle(kw.times[0])}>
              <div className="keyword-main"><span className="keyword-word">{kw.word}</span><span className="keyword-phonetic">/{kw.word}/</span></div>
              <div className="keyword-meta"><span className="keyword-count">出现 {kw.count} 次</span><span className="keyword-time">{formatTime(kw.times[0])}</span></div>
              <button className="keyword-add-vocab" onClick={e=>{e.stopPropagation();authFetch('/vocab',{method:'POST',body:JSON.stringify({word:kw.word,videoId:id,videoTitle:video?.title})}).then(r=>r.json()).then(d=>{if(d.ok)authFetch('/vocab').then(r=>r.json()).then(d=>setVocabulary(d.vocabulary||[])).catch(()=>{})}).catch(()=>{})}}><Star size={14}/></button>
            </div>
          )}
        </div>
      )}
      {sidebarTab === 'phrases' && (
        <div className="keywords-panel">
          {derivedData.phrases.length===0?<p className="sidebar-empty">暂无重点短句</p>:derivedData.phrases.map((sub,i)=>
            <div key={i} className="phrase-item-new" onClick={()=>jumpToSubtitle(sub.startTime)}>
              <span className="phrase-time">{formatTime(sub.startTime)}</span>
              <p className="phrase-en">{sub.textEn}</p><p className="phrase-cn">{sub.textCn}</p>
              {sub.highlightWords&&<div className="sub-keywords-new" style={{marginTop:6}}>{sub.highlightWords.map((kw,ki)=><span key={ki} className="keyword-tag-new">{kw}</span>)}</div>}
            </div>
          )}
        </div>
      )}
      {sidebarTab === 'expressions' && (
        <div className="keywords-panel">
          {derivedData.expressions.length===0?<p className="sidebar-empty">暂无地道表达</p>:derivedData.expressions.map((sub,i)=>
            <div key={i} className="phrase-item-new" onClick={()=>jumpToSubtitle(sub.startTime)}>
              <span className="phrase-time">{formatTime(sub.startTime)}</span>
              <p className="phrase-en">{sub.textEn}</p><p className="phrase-cn">{sub.textCn}</p>
            </div>
          )}
        </div>
      )}
    </>
  )

  return (
    <div className="video-detail-page">
      <div className="video-detail-header">
        <button onClick={() => navigate('/')} className="back-btn"><ArrowLeft size={20} /><span>返回</span></button>
        <h1 className="video-detail-title">{video.title}</h1>
        <div className="video-detail-actions">
          <button onClick={() => setShowExport(!showExport)} className="action-btn"><Download size={16} /><span>导出</span></button>
        </div>
      </div>

      {showExport && (
        <div className="export-panel-new">
          <button onClick={exportWordDoc} className="export-btn-new">📄 导出 Word 文档</button>
          <button onClick={exportTxt} className="export-btn-new">📝 导出 TXT 文本</button>
        </div>
      )}

      <div className="video-content-new">
        {/* ── LEFT COLUMN: video + controls + mode ── */}
        <div className="video-left-col">
          <div className="video-player-section-new">
            <div className="video-wrapper-new" style={{ display: showVideo ? 'block' : 'none' }}>
              <video ref={videoRef} src={videoSrc}
                onTimeUpdate={handleTimeUpdate} onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                onEnded={handleVideoEnded} className="video-element-new" playsInline crossOrigin="anonymous" preload="auto" />

              {currentSub && subtitleMode !== 'hidden' && (
                <div className="video-overlay-subtitles-new" onClick={togglePlay} style={{ fontSize: subtitleFontSize + 'px' }}>
                  {subtitleMode !== 'chinese' && <p className="overlay-english-new">{currentSub.textEn}</p>}
                  {subtitleMode !== 'english' && <p className="overlay-chinese-new">{currentSub.textCn}</p>}
                </div>
              )}

              <div className="video-controls-new">
                <div className="progress-bar-new" onClick={handleSeek}>
                  <div className="progress-filled-new" style={{ width: `${(currentTime / duration) * 100}%` }} />
                </div>
                <div className="controls-row-new">
                  <div className="controls-left-new">
                    <button onClick={() => skipTime(-5)} className="ctrl-btn-new"><SkipBack size={18} /></button>
                    <button onClick={togglePlay} className="ctrl-btn-new ctrl-play-new">{playing ? <Pause size={22} /> : <Play size={22} />}</button>
                    <button onClick={() => skipTime(5)} className="ctrl-btn-new"><SkipForward size={18} /></button>
                    <button onClick={toggleMute} className="ctrl-btn-new">{muted ? <VolumeX size={18} /> : volume < 0.5 ? <Volume1 size={18} /> : <Volume2 size={18} />}</button>
                    <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={handleVolumeChange} className="volume-slider-new" />
                    <span className="time-display-new">{formatTime(currentTime)} / {formatTime(duration)}</span>
                  </div>
                  <div className="controls-right-new">
                    <div className="subtitle-tabs-new">
                      {['bilingual','english','chinese','hidden'].map(m => <button key={m} className={`subtitle-tab-new ${subtitleMode===m?'active':''}`} onClick={()=>setSubtitleMode(m)}>{m==='bilingual'?'双语':m==='english'?'EN':m==='chinese'?'中':'关'}</button>)}
                    </div>
                    <button onClick={handleFullscreen} className="ctrl-btn-new"><Maximize size={16} /></button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Sentence Control Bar (single row) ── */}
          <div className="sentence-controls-bar desktop-only">
            <div className="sentence-controls-left">
              <button onClick={() => setShowVideo(!showVideo)} className="sc-btn sc-toggle" title={showVideo?'隐藏视频':'显示视频'}>{showVideo?'🙈':'👁'}<span>{showVideo?'隐藏':'显示'}</span></button>
              <button onClick={cycleABLoop} className={`sc-btn sc-ab ${abLoopB!==null?'sc-ab-active':abLoopA!==null?'sc-ab-active':''}`}>
                {abLoopA === null ? 'A' : abLoopB === null ? 'B' : '✕'}
              </button>
              <button onClick={cycleLoop} className={`sc-btn ${loopMode!=='off'?'sc-active':''}`}><Repeat size={14}/><span>{loopMode==='off'?'循环':loopMode==='sentence'?'单句':'全部'}</span></button>
              <button onClick={()=>setAutoPauseSentence(!autoPauseSentence)} className={`sc-btn ${autoPauseSentence?'sc-active':''}`}>⏸<span>单句暂停</span></button>
              <select className="sc-gap-select" value={sentenceGap} onChange={e=>setSentenceGap(Number(e.target.value))}>
                <option value={0}>间隔 0s</option><option value={1}>间隔 1s</option><option value={2}>间隔 2s</option><option value={3}>间隔 3s</option><option value={5}>间隔 5s</option>
              </select>
            </div>
            <div className="sentence-controls-center">
              <button onClick={goPrevSentence} className="sc-btn"><SkipBack size={14} /><span>上一句</span></button>
              <button onClick={togglePlay} className="sc-btn sc-play">{playing?<Pause size={16}/>:<Play size={16}/>}<span>{playing?'暂停':'播放'}</span></button>
              <button onClick={goNextSentence} className="sc-btn"><span>下一句</span><SkipForward size={14}/></button>
            </div>
            <div className="sentence-controls-right">
              <div className="speed-control-wrapper">
                <button className="sc-btn" onClick={() => setShowSpeedMenu(!showSpeedMenu)}><Gauge size={14} /><span>{playbackRate}x</span></button>
                {showSpeedMenu && <div className="speed-menu">{SPEEDS.map(s => <button key={s} className={`speed-option ${playbackRate===s?'active':''}`} onClick={()=>changeSpeed(s)}>{s}x</button>)}</div>}
              </div>
              <select className="sc-gap-select" value={subtitleFontSize} onChange={e => { const v = Number(e.target.value); setSubtitleFontSize(v); localStorage.setItem('shadow_voice_fontsize', v) }}>
                <option value={12}>Aa 12</option><option value={14}>Aa 14</option><option value={16}>Aa 16</option><option value={18}>Aa 18</option><option value={20}>Aa 20</option><option value={22}>Aa 22</option>
              </select>
            </div>
          </div>

          {/* ── Mode Tabs ── */}
          <div className="mode-bar desktop-only">
            {[
              { key: 'normal', icon: '📖', label: '正常泛听' },
              { key: 'shadowing', icon: '🎤', label: '跟读' },
              { key: 'cloze', icon: '✏️', label: '挖空' },
              { key: 'translate', icon: '🔄', label: '中译英' },
            ].map(m => (
              <button key={m.key} className={`mode-tab-btn ${learningMode===m.key?'active':''}`} onClick={()=>setLearningMode(m.key)}>
                <span>{m.icon}</span><span>{m.label}</span>
              </button>
            ))}
          </div>

          {/* ── Mode Content ── */}
          {learningMode !== 'normal' && currentSub && (
            <div className="mode-content">
              {learningMode === 'shadowing' && (
                <div className="mode-shadowing">
                  <p className="mode-sentence-en">{currentSub.textEn}</p>
                  <p className="mode-sentence-cn">{currentSub.textCn}</p>
                  <div className="mode-shadowing-actions">
                    {!recording ? <button onClick={startRecording} className="mode-action-btn record">🎙️ 开始录音</button>
                      : <button onClick={stopRecording} className="mode-action-btn recording">⏹ 停止录音</button>}
                    {recordedAudio && <audio controls src={recordedAudio} className="mode-audio-preview" />}
                  </div>
                </div>
              )}

              {learningMode === 'cloze' && (
                <div className="mode-cloze">
                  <p className="mode-sentence-cn">{currentSub.textCn}</p>
                  <div className="mode-cloze-text">
                    {clozeItems.map((item, i) => (
                      <span key={i} className="cloze-word-wrap">
                        {item.blank ? (
                          clozeSubmitted ? (
                            <span className={`cloze-reveal ${(clozeAnswers[i]||'').toLowerCase()===item.word.replace(/[^a-zA-Z]/g,'').toLowerCase()?'correct':'wrong'}`}>
                              <span className="cloze-user-answer">{clozeAnswers[i]||'___'}</span>
                              <span className="cloze-correct-answer">{item.word}</span>
                            </span>
                          ) : (
                            <input className="cloze-blank-input" value={clozeAnswers[i]||''}
                              onChange={e=>setClozeAnswers({...clozeAnswers,[i]:e.target.value})}
                              style={{width:Math.max(40,item.word.length*12+8)+'px'}}
                              autoFocus={i===clozeItems.findIndex(w=>w.blank)} />
                          )
                        ) : <span className="cloze-word">{item.word}</span>}
                      </span>
                    ))}
                  </div>
                  <div className="mode-cloze-actions">
                    <select className="sc-gap-select" value={clozeDifficulty} onChange={e=>setClozeDifficulty(Number(e.target.value))}>
                      <option value={1}>简单</option><option value={2}>中等</option><option value={3}>困难</option>
                    </select>
                    <button onClick={submitCloze} className="mode-action-btn check">✅ 检查</button>
                  </div>
                </div>
              )}

              {learningMode === 'translate' && (
                <div className="mode-translate">
                  <p className="mode-sentence-cn mode-translate-cn">{currentSub.textCn}</p>
                  <div className="mode-translate-inputs">
                    {englishWords.map((word, i) => {
                      const cw = word.replace(/[^a-zA-Z']/g,''); if (cw.length===0) return <span key={i} className="translate-punct">{word}</span>
                      const uv = translateAnswers[i]||''; const ok = translateSubmitted&&uv.toLowerCase()===cw.toLowerCase(); const wr = translateSubmitted&&uv&&!ok
                      return <span key={i} className="translate-word-wrap">
                        <input className={`translate-word-input ${ok?'correct':''} ${wr?'wrong':''}`} value={uv}
                          onChange={e=>setTranslateAnswers({...translateAnswers,[i]:e.target.value})}
                          style={{width:Math.max(28,cw.length*14+8)+'px'}} disabled={translateSubmitted} placeholder={translateSubmitted?cw:''} />
                      </span>
                    })}
                  </div>
                  <div className="mode-cloze-actions">
                    <button onClick={submitTranslate} className="mode-action-btn check">✅ 检查</button>
                    {translateSubmitted && <button onClick={()=>{setTranslateAnswers({});setTranslateSubmitted(false)}} className="mode-action-btn retry">🔄 重试</button>}
                  </div>
            </div>
          )}

          {/* ── Mobile: Core Nav Bar ── */}
          <div className="mobile-nav-bar">
            <button onClick={goPrevSentence} className="mnav-btn"><SkipBack size={24} /></button>
            <button onClick={togglePlay} className="mnav-btn mnav-play">{playing ? <Pause size={32} /> : <Play size={32} />}</button>
            <button onClick={goNextSentence} className="mnav-btn"><SkipForward size={24} /></button>
          </div>

          {/* ── Mobile: Quick Settings Bar ── */}
          <div className="mobile-settings-bar">
            <select className="ms-select" value={learningMode} onChange={e => setLearningMode(e.target.value)}>
              <option value="normal">📖 正常</option>
              <option value="shadowing">🎤 跟读</option>
              <option value="cloze">✏️ 挖空</option>
              <option value="translate">🔄 中译英</option>
            </select>
            <button onClick={() => setSubtitleMode(subtitleMode==='bilingual'?'english':subtitleMode==='english'?'chinese':subtitleMode==='chinese'?'hidden':'bilingual')} className="ms-btn">
              {subtitleMode==='bilingual'?'🌐':subtitleMode==='english'?'EN':subtitleMode==='chinese'?'中':'关'}
            </button>
            <div className="speed-control-wrapper">
              <button className="ms-btn" onClick={() => setShowSpeedMenu(!showSpeedMenu)}>{playbackRate}x</button>
              {showSpeedMenu && <div className="speed-menu">{SPEEDS.map(s => <button key={s} className={`speed-option ${playbackRate===s?'active':''}`} onClick={()=>changeSpeed(s)}>{s}x</button>)}</div>}
            </div>
            <button onClick={() => setShowMobileMore(!showMobileMore)} className={`ms-btn ${showMobileMore?'active':''}`}>⚙</button>
          </div>

          {/* ── Mobile: More Panel ── */}
          {showMobileMore && (
            <div className="mobile-more-panel">
              <button onClick={() => setShowVideo(!showVideo)} className="sc-btn sc-toggle">{showVideo?'🙈 隐藏':'👁 显示'}</button>
              <button onClick={cycleABLoop} className={`sc-btn sc-ab ${abLoopB!==null?'sc-ab-active':abLoopA!==null?'sc-ab-active':''}`}>
                {abLoopA===null?'A':abLoopB===null?'B':'✕'}
              </button>
              <button onClick={cycleLoop} className={`sc-btn ${loopMode!=='off'?'sc-active':''}`}><Repeat size={14}/> {loopMode==='off'?'循环':loopMode==='sentence'?'单句':'全部'}</button>
              <button onClick={()=>setAutoPauseSentence(!autoPauseSentence)} className={`sc-btn ${autoPauseSentence?'sc-active':''}`}>⏸ 单句暂停</button>
              <select className="sc-gap-select" value={sentenceGap} onChange={e=>setSentenceGap(Number(e.target.value))}>
                <option value={0}>间隔 0s</option><option value={1}>间隔 1s</option><option value={2}>间隔 2s</option><option value={3}>间隔 3s</option><option value={5}>间隔 5s</option>
              </select>
              <select className="sc-gap-select" value={subtitleFontSize} onChange={e=>{const v=Number(e.target.value);setSubtitleFontSize(v);localStorage.setItem('shadow_voice_fontsize',v)}}>
                <option value={12}>Aa 12</option><option value={14}>Aa 14</option><option value={16}>Aa 16</option><option value={18}>Aa 18</option><option value={20}>Aa 20</option>
              </select>
            </div>
          )}
        </div>
          )}
        </div>

        {/* ── RIGHT COLUMN: Sidebar (Desktop) ── */}
        <div className="sidebar-panel-new desktop-sidebar">
          <div className="sidebar-tabs">
            {[
              { key: 'subtitles', icon: <List size={15} />, label: '字幕', count: video.subtitle_count },
              { key: 'words', icon: <BookOpen size={15} />, label: '重点单词', count: derivedData.keywords.length },
              { key: 'phrases', icon: <MessageSquare size={15} />, label: '重点短句', count: derivedData.phrases.length },
              { key: 'expressions', icon: <Sparkles size={15} />, label: '地道表达', count: derivedData.expressions.length },
            ].map(tab => (
              <button key={tab.key} className={`sidebar-tab-btn ${sidebarTab===tab.key?'active':''}`} onClick={()=>setSidebarTab(tab.key)}>
                {tab.icon}<span>{tab.label}</span><span className="sidebar-tab-count">{tab.count}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-content" ref={subtitleContainerRef} style={{ fontSize: subtitleFontSize + 'px' }}>
            {renderSidebarContent()}
          </div>
        </div>
      </div>

      {/* ── Video Info (below grid, full width) ── */}
      <div className="video-info-section-new">
        <div className="info-card-new">
          <h3>视频信息</h3>
          <div className="info-grid-new">
            <div className="info-item-new"><span className="info-label-new">难度</span><span className={`level-badge level-${video.level}`}>{video.level}</span></div>
            {video.accent && <div className="info-item-new"><span className="info-label-new">口音</span><span className="video-accent-detail">{video.accent}</span></div>}
            <div className="info-item-new"><span className="info-label-new">话题</span><div className="topic-tags-new">{video.topics.map((t,i)=><span key={i} className="topic-tag-new">{t}</span>)}</div></div>
            <div className="info-item-new"><span className="info-label-new">时长</span><span>{formatTime(video.duration)}</span></div>
            <div className="info-item-new"><span className="info-label-new">字幕</span><span>{video.subtitle_count} 条</span></div>
            {video.creator_name&&<div className="info-item-new"><span className="info-label-new">作者</span><span>{video.creator_name}</span></div>}
          </div>
          {video.description&&<p className="info-description-new">{video.description}</p>}
        </div>
      </div>

      {/* ── Mobile: Bottom Panel ── */}
      <div className="mobile-bottom-panel">
        <div className="mobile-panel-tabs">
          {[
            { key: 'subtitles', icon: <List size={18} />, label: '字幕' },
            { key: 'words', icon: <BookOpen size={18} />, label: '单词' },
            { key: 'phrases', icon: <MessageSquare size={18} />, label: '短句' },
            { key: 'expressions', icon: <Sparkles size={18} />, label: '表达' },
          ].map(tab => (
            <button key={tab.key} className={`mp-tab-btn ${sidebarTab===tab.key&&mobilePanelOpen?'active':''}`}
              onClick={() => {
                if (sidebarTab === tab.key) setMobilePanelOpen(!mobilePanelOpen)
                else { setSidebarTab(tab.key); setMobilePanelOpen(true) }
              }}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
        {mobilePanelOpen && (
          <div className="mobile-panel-sheet">
            <div className="mobile-panel-header">
              <div className="mobile-panel-handle" />
              <button onClick={() => setMobilePanelOpen(false)} className="mp-close-btn"><X size={20} /></button>
            </div>
            <div className="mobile-panel-body" style={{ fontSize: subtitleFontSize + 'px' }}>
              {renderSidebarContent()}
            </div>
          </div>
        )}
      </div>

      {wordPopup && (
        <div className="word-popup-new" style={{ position:'fixed', left:wordPopup.x, top:wordPopup.y, zIndex:200 }}>
          <div className="word-popup-header"><span className="word-popup-word">{wordPopup.word}</span><button onClick={()=>setWordPopup(null)}><X size={14}/></button></div>
          {wordPopup.cn&&<p className="word-popup-cn">{wordPopup.cn}</p>}
          {wordPopup.synonyms.length>0&&<div className="word-popup-synonyms"><span className="word-popup-label">同义词：</span>{wordPopup.synonyms.map((s,i)=><span key={i} className="word-synonym-tag">{s}</span>)}</div>}
          <button className="word-popup-add" onClick={()=>setWordPopup(null)}><Star size={12}/> 已添加至生词本 ({vocabulary.length})</button>
        </div>
      )}
    </div>
  )
}
