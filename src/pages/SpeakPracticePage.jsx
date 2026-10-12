import { useState, useRef, useCallback, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Mic, Square, ChevronLeft, ChevronRight, RotateCcw, Sparkles, Lightbulb, ThumbsUp, AlertTriangle } from 'lucide-react'
import { useAuth } from '../context/auth-context'
import { createAsrSpeechInput } from '../utils/aliyunAsr'
import { createSpeechInput } from '../utils/recallSpeech'
import { filterSubtitlesToPrompts } from '../utils/speakPrompts'
import { loadOne, mark, firstUnpracticedIndex } from '../utils/practiceRecords'

const ISSUE_TYPE_LABELS = {
  grammar: '语法',
  word_choice: '用词',
  collocation: '搭配',
  naturalness: '地道',
  incomplete: '不完整',
}

function scoreTone(score) {
  if (score == null) return 'text-slate-500'
  if (score >= 80) return 'text-emerald-600'
  if (score >= 60) return 'text-amber-600'
  return 'text-rose-600'
}

// 自由表达（看中文说英文）：看一句中文 → 说英文 → 点「解析」看 AI 评分。
export default function SpeakPracticePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()

  const [video, setVideo] = useState(null)
  const [prompts, setPrompts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [idx, setIdx] = useState(0)
  const [practiced, setPracticed] = useState(null) // null = 未加载

  const [userText, setUserText] = useState('')
  const [listening, setListening] = useState(false)
  const [speechSource, setSpeechSource] = useState(null)
  const [speechError, setSpeechError] = useState(null)

  const [review, setReview] = useState(null)
  const [reviewing, setReviewing] = useState(false)

  const speechRef = useRef(null)
  const idxInitRef = useRef(false)

  // 游客：引导登录
  useEffect(() => {
    if (isGuest) navigate('/login', { state: { from: `/video/${id}/speak` } })
  }, [isGuest, navigate, id])

  // 加载视频 + 练习句（speak-prompts.json → 缺失时本地降级字幕）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/data/consolidated.json')
        const videos = await res.json()
        const found = videos.find(v => v.id === id)
        if (!found) { if (!cancelled) setError('视频未找到'); return }
        if (cancelled) return
        setVideo(found)

        let prompts = []
        try {
          const r = await fetch(`/data/videos/${found.episode_dir}/speak-prompts.json`)
          if (r.ok) {
            const d = await r.json()
            prompts = Array.isArray(d.prompts) ? d.prompts : []
          }
        } catch { prompts = [] }

        if (prompts.length === 0) {
          try {
            const r = await fetch(`/data/videos/${found.episode_dir}/subtitles.json`)
            const subs = r.ok ? await r.json() : []
            prompts = filterSubtitlesToPrompts(subs)
          } catch { prompts = [] }
        }
        if (!cancelled) setPrompts(prompts)
      } catch {
        if (!cancelled) setError('加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [id])

  // 已练标记（登录用户跨设备）
  useEffect(() => {
    if (!video || isGuest) return
    let cancelled = false
    loadOne(authFetch, isGuest, video.id)
      .then(d => { if (!cancelled) setPracticed(new Set(Array.isArray(d.speak) ? d.speak : [])) })
      .catch(() => { if (!cancelled) setPracticed(new Set()) })
    return () => { cancelled = true }
  }, [video, authFetch, isGuest])

  // 首次进入：续练到第一句没练过的（只初始化一次）
  useEffect(() => {
    if (prompts.length && practiced && !idxInitRef.current) {
      idxInitRef.current = true
      setIdx(firstUnpracticedIndex(practiced, prompts.length))
    }
  }, [prompts.length, practiced])

  // 卸载时停止录音
  useEffect(() => () => { speechRef.current?.stop() }, [])

  // 录音：点击开始 / 点击停止；阿里云 ASR → Web Speech → 打字兜底
  const beginSpeech = useCallback(async () => {
    if (listening) { speechRef.current?.stop(); return }
    setSpeechError(null)
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
      if (src === 'none') { setSpeechError('当前浏览器不支持语音输入，请直接输入英文'); return }
      if (src === 'aliyun') {
        const s = await createAsrSpeechInput(authFetch)
        if (!s.ok) {
          const w = createSpeechInput()
          if (!w.ok) { setSpeechError(w.error || '语音输入不可用，请直接输入'); return }
          speechRef.current = w
          setSpeechSource('web')
        } else {
          speechRef.current = s
        }
      } else {
        const w = createSpeechInput()
        if (!w.ok) { setSpeechError(w.error || '语音输入不可用，请直接输入'); return }
        speechRef.current = w
      }
    }
    setListening(true)
    speechRef.current.start(
      (text) => { setUserText(text); setListening(false) },
      (err) => { setListening(false); setSpeechError(err) },
      () => setListening(false)
    )
  }, [listening, authFetch, speechSource])

  // 解析
  const runReview = useCallback(async () => {
    const prompt = prompts[idx]
    const text = userText.trim()
    if (!prompt || !text || reviewing) return
    setReviewing(true)
    setSpeechError(null)
    try {
      const res = await authFetch('/speak/review', {
        method: 'POST',
        body: JSON.stringify({ cn: prompt.cn, en: prompt.en, userText: text }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) { navigate('/login', { state: { from: `/video/${id}/speak` } }); return }
      if (!res.ok) { setSpeechError(data.error || '评分失败，请重试'); return }
      setReview(data.review)
      mark(authFetch, isGuest, video?.id || id, 'speak', idx)
      setPracticed(prev => { const n = new Set(prev || []); n.add(idx); return n })
    } catch {
      setSpeechError('评分失败，请稍后重试')
    } finally {
      setReviewing(false)
    }
  }, [prompts, idx, userText, reviewing, authFetch, isGuest, video, id, navigate])

  // 导航 / 重说
  const goTo = useCallback((nextIdx) => {
    if (nextIdx < 0 || nextIdx >= prompts.length) return
    speechRef.current?.stop()
    setListening(false)
    setIdx(nextIdx)
    setUserText('')
    setReview(null)
    setSpeechError(null)
  }, [prompts.length])

  const redo = useCallback(() => {
    setReview(null)
    setUserText('')
    setSpeechError(null)
  }, [])

  if (loading) return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 px-6">
        <p className="text-slate-600 text-sm">{error}</p>
        <button onClick={() => navigate(`/video/${id}`)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-bold">返回视频</button>
      </div>
    )
  }

  const prompt = prompts[idx]
  const isLast = idx >= prompts.length - 1
  const isFirst = idx <= 0
  const parseError = review?.parseError

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 bg-white/95 backdrop-blur-md px-3 py-2 border-b border-slate-100 shrink-0 z-10"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <button onClick={() => navigate(`/video/${id}`)}
          className="flex items-center justify-center w-8 h-8 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition-all cursor-pointer shrink-0 active:scale-95">
          <ArrowLeft className="h-4 w-4 stroke-[2.5]" />
        </button>
        <h2 className="text-sm font-extrabold text-slate-800 tracking-tight truncate flex-1">🗣 自由表达</h2>
        <span className="text-xs font-bold text-slate-400 tabular-nums shrink-0">{prompts.length > 0 ? `${idx + 1}/${prompts.length}` : '0/0'}</span>
      </div>

      {/* 空态 */}
      {prompts.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-slate-500 text-sm">该视频暂无可练习的句子</p>
          <button onClick={() => navigate(`/video/${id}`)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold">返回视频</button>
        </div>
      ) : (
        <div className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 flex flex-col gap-5">
          {/* 中文句子 */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-xs px-6 py-8 text-center">
            <p className="text-slate-400 text-xs font-bold mb-2 tracking-wider">看中文，说英文</p>
            <p className="text-2xl md:text-3xl font-extrabold text-slate-800 leading-relaxed">{prompt.cn}</p>
            {video?.title && <p className="text-xs text-slate-400 mt-3 truncate">{video.title}</p>}
          </div>

          {/* 录音 + 输入 */}
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={beginSpeech}
              className={`flex items-center justify-center gap-2 w-20 h-20 rounded-full text-white text-sm font-bold shadow-lg transition-all active:scale-95 ${listening ? 'bg-rose-500 shadow-rose-200' : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200'}`}
              title={listening ? '点击停止' : '点击开始录音'}
            >
              {listening ? <Square className="h-6 w-6" /> : <Mic className="h-7 w-7" />}
            </button>
            <p className="text-xs text-slate-400">{listening ? '录音中，再点一次结束' : '点击麦克风说英文'}</p>
            <textarea
              value={userText}
              onChange={e => setUserText(e.target.value)}
              placeholder="识别结果会显示在这里，可手动修改后点解析"
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none"
            />
            <button
              onClick={runReview}
              disabled={!userText.trim() || reviewing}
              className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-bold transition-all flex items-center justify-center gap-2"
            >
              <Sparkles className="h-4 w-4" />{reviewing ? '解析中...' : '解析我的回答'}
            </button>
            {speechError && <p className="text-xs text-rose-500 text-center">{speechError}</p>}
          </div>

          {/* 解析结果 */}
          {review && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-xs p-5 flex flex-col gap-4">
              {parseError ? (
                <div className="flex items-center gap-2 text-rose-600 text-sm">
                  <AlertTriangle className="h-4 w-4" />评分解析失败，请重试
                </div>
              ) : (
                <>
                  <div className="flex items-end justify-between">
                    <span className="text-xs font-bold text-slate-400 tracking-wider">评分</span>
                    <span className={`text-4xl font-extrabold tabular-nums ${scoreTone(review.score)}`}>
                      {review.score == null ? '—' : review.score}
                    </span>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-400 mb-1">你说</p>
                    <p className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">{userText}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-400 mb-1">参考答案</p>
                    <p className="text-sm text-slate-700 bg-indigo-50/60 rounded-lg px-3 py-2">{prompt.en}</p>
                  </div>

                  {Array.isArray(review.issues) && review.issues.length > 0 && (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs font-bold text-slate-400">问题与建议</p>
                      {review.issues.map((issue, i) => (
                        <div key={i} className="rounded-lg border border-slate-100 p-3 flex flex-col gap-1.5">
                          <span className="text-[11px] font-bold text-indigo-600 bg-indigo-50 self-start px-2 py-0.5 rounded">
                            {ISSUE_TYPE_LABELS[issue.type] || issue.type || '问题'}
                          </span>
                          {issue.location && <p className="text-sm text-slate-700"><span className="text-slate-400">片段：</span>{issue.location}</p>}
                          {issue.problem && <p className="text-sm text-slate-700"><span className="text-slate-400">问题：</span>{issue.problem}</p>}
                          {issue.suggestion && <p className="text-sm text-slate-700"><span className="text-slate-400">建议：</span>{issue.suggestion}</p>}
                          {issue.better && <p className="text-sm text-emerald-700"><span className="text-slate-400">更好：</span>{issue.better}</p>}
                        </div>
                      ))}
                    </div>
                  )}

                  {review.better && (
                    <div className="rounded-lg bg-emerald-50 p-3 flex gap-2">
                      <Lightbulb className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-bold text-emerald-700 mb-1">更地道的说法</p>
                        <p className="text-sm text-emerald-800">{review.better}</p>
                      </div>
                    </div>
                  )}

                  {review.praise && (
                    <div className="rounded-lg bg-slate-50 p-3 flex gap-2">
                      <ThumbsUp className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-slate-600">{review.praise}</p>
                    </div>
                  )}

                  {review.lowScoreHint && (
                    <div className="rounded-lg bg-amber-50 p-3 flex gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                      <p className="text-sm text-amber-700">{review.lowScoreHint}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 底部导航 */}
          <div className="flex items-center justify-between gap-3 mt-auto pb-2">
            <button onClick={() => goTo(idx - 1)} disabled={isFirst}
              className="flex items-center gap-1 px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-bold disabled:opacity-40 transition-all active:scale-95">
              <ChevronLeft className="h-4 w-4" />上一句
            </button>
            <button onClick={redo} disabled={!userText && !review}
              className="flex items-center gap-1 px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-bold disabled:opacity-40 transition-all active:scale-95">
              <RotateCcw className="h-4 w-4" />重说
            </button>
            <button onClick={() => goTo(idx + 1)} disabled={isLast}
              className="flex items-center gap-1 px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-bold disabled:opacity-40 transition-all active:scale-95">
              下一句<ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
