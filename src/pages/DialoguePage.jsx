import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, MoreHorizontal, RefreshCw, RotateCcw, AlertTriangle, Volume2,
  Mic, Square, Sparkles, ChevronRight, ChevronLeft, Lightbulb, ThumbsUp, CheckCircle2,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import { createSpeaker } from '../utils/tts'
import { useSpeechInput } from '../utils/useSpeechInput'
import {
  DIFFICULTIES, DIFFICULTY_LABELS, difficultyFromVideoLevel, progressLabel,
  contextOf, primaryAction, summarizeAnswers, prevIndex, nextIndex, reviewFromSavedAnswer,
} from '../utils/dialoguePractice'

const ISSUE_TYPE_LABELS = {
  grammar: '语法',
  word_choice: '用词',
  collocation: '搭配',
  naturalness: '地道',
  incomplete: '不完整',
  other: '问题',
}

const VERDICT_STYLE = {
  correct: { label: '说对了', cls: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  minor: { label: '意思对，可以更地道', cls: 'bg-amber-50 text-amber-700 border-amber-100' },
  wrong: { label: '再试一次', cls: 'bg-rose-50 text-rose-700 border-rose-100' },
}

function scoreTone(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 80) return 'text-emerald-600'
  if (score >= 60) return 'text-amber-600'
  return 'text-rose-600'
}

// 中译英口语对话：AI 一次性生成一组连贯中文对话，用户逐句口头翻成英文。
// 每次只显示当前这一句（+ 上一句作上下文）；评分与整组生成分开调用。
export default function DialoguePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()

  const [difficulty, setDifficulty] = useState('daily')
  const [available, setAvailable] = useState([])
  const [aiConfigured, setAiConfigured] = useState(true)
  const [script, setScript] = useState(null)
  const [progress, setProgress] = useState(null)
  const [cursor, setCursor] = useState(0)

  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [showMenu, setShowMenu] = useState(false)

  const [userText, setUserText] = useState('')
  const [review, setReview] = useState(null)
  const [attempts, setAttempts] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [done, setDone] = useState(false)
  const [summary, setSummary] = useState(null)

  const speakerRef = useRef(null)
  const bootedIdRef = useRef(null)
  const cursorRef = useRef(0)
  const speech = useSpeechInput(authFetch)

  useEffect(() => { cursorRef.current = cursor }, [cursor])

  const loginRedirect = useCallback(() => {
    navigate('/login', { state: { from: `/video/${id}/dialogue` } })
  }, [navigate, id])

  useEffect(() => {
    if (isGuest) loginRedirect()
  }, [isGuest, loginRedirect])

  useEffect(() => {
    speakerRef.current = createSpeaker(authFetch)
    return () => speakerRef.current?.stop()
  }, [authFetch])

  const resetAnswer = useCallback(() => {
    speech.stop()
    setUserText('')
    setReview(null)
    setAttempts(0)
    setRevealed(false)
    setActionError(null)
  }, [speech])

  const applyScript = useCallback((nextScript, nextProgress) => {
    setScript(nextScript)
    setProgress(nextProgress || null)
    resetAnswer()
    const total = nextScript?.lines?.length || 0
    const rawCursor = Number(nextProgress?.cursor) || 0
    setCursor(total > 0 ? Math.min(Math.max(rawCursor, 0), total - 1) : 0)
    // 上次已经练完：直接回到完成总结，而不是停在一句已答过的句子上
    if (nextProgress?.status === 'completed') {
      setDone(true)
      setSummary(summarizeAnswers(nextProgress?.answers, nextScript?.lines))
    } else {
      setDone(false)
      setSummary(null)
    }
  }, [resetAnswer])

  const generateScript = useCallback(async (d) => {
    setGenerating(true)
    setError(null)
    setLoading(false)
    try {
      const res = await authFetch(`/dialogue/${encodeURIComponent(id)}/generate`, {
        method: 'POST',
        body: JSON.stringify({ difficulty: d }),
      })
      if (res.status === 401) { loginRedirect(); return }
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.script) {
        setError(data.error || '生成失败，请重试')
        return
      }
      setDifficulty(d)
      setAvailable(prev => (prev.includes(d) ? prev : DIFFICULTIES.filter(x => x === d || prev.includes(x))))
      applyScript(data.script, data.progress)
    } catch {
      setError('网络异常，生成失败，请重试')
    } finally {
      setGenerating(false)
      setLoading(false)
    }
  }, [authFetch, id, loginRedirect, applyScript])

  const loadScript = useCallback(async (d) => {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(`/dialogue/${encodeURIComponent(id)}?difficulty=${d}`)
      if (res.status === 401) { loginRedirect(); return }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || '加载失败')
        return
      }
      setAvailable(Array.isArray(data.available) ? data.available : [])
      setAiConfigured(data.aiConfigured !== false)
      setDifficulty(data.difficulty || d)

      if (!data.script || !Array.isArray(data.script.lines) || data.script.lines.length === 0) {
        await generateScript(d)
        return
      }
      applyScript(data.script, data.progress)
    } catch {
      setError('网络异常，请重试')
    } finally {
      setLoading(false)
    }
  }, [authFetch, id, loginRedirect, applyScript, generateScript])

  // 首次进入：读视频等级作为默认难度，然后拉取 / 自动生成。
  // 不用「cleanup 置 cancelled」来取消启动：React StrictMode（dev）会 mount→cleanup→mount，
  // 第 1 次启动被标记取消、第 2 次又被已启动标记挡掉，页面就永远停在「加载中…」。
  // 改为按 id 记住是否已启动，且不主动取消（卸载后的 setState 是无害的空操作）。
  useEffect(() => {
    if (isGuest) return
    if (bootedIdRef.current === id) return
    bootedIdRef.current = id
    ;(async () => {
      try {
        const res = await fetch('/data/consolidated.json')
        const videos = await res.json()
        const found = Array.isArray(videos) ? videos.find(v => v.id === id) : null
        if (!found) {
          setError('视频未找到')
          setLoading(false)
          return
        }
        await loadScript(difficultyFromVideoLevel(found.level))
      } catch {
        setError('加载失败，请重试')
        setLoading(false)
      }
    })()
  }, [id, isGuest, loadScript])

  const pickDifficulty = useCallback(async (d) => {
    if (d === difficulty) return
    if (available.includes(d)) {
      setDifficulty(d)
      await loadScript(d)
      return
    }
    if (!window.confirm(`「${DIFFICULTY_LABELS[d]}」还没有对话脚本，需要生成一组新的（约 10–20 秒），继续？`)) return
    setDifficulty(d)
    await generateScript(d)
  }, [available, difficulty, loadScript, generateScript])

  const regenerate = useCallback(async () => {
    setShowMenu(false)
    if (!window.confirm('将生成一组新对话，旧对话与答题记录会保留但不再显示。继续？')) return
    await generateScript(difficulty)
  }, [difficulty, generateScript])

  const evaluate = useCallback(async () => {
    const text = userText.trim()
    const scriptId = progress?.scriptId
    if (!text || !scriptId || evaluating) return
    const lineIndex = cursorRef.current
    setEvaluating(true)
    setActionError(null)
    try {
      const res = await authFetch(`/dialogue/${scriptId}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({ index: lineIndex, userText: text }),
      })
      if (res.status === 401) { loginRedirect(); return }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setActionError(data.error || '评分失败，请重试')
        return
      }
      if (cursorRef.current !== lineIndex) return
      setReview(data.review || null)
      setAttempts(Number(data.attempts) || 0)
      setRevealed(data.review?.answerHidden === false)
      if (data.progress) setProgress(data.progress)
    } catch {
      setActionError('网络异常，评分失败，请稍后重试')
    } finally {
      setEvaluating(false)
    }
  }, [userText, progress, evaluating, authFetch, loginRedirect])

  const saveCursor = useCallback(async (next, status) => {
    const scriptId = progress?.scriptId
    if (!scriptId) return
    try {
      const res = await authFetch(`/dialogue/${scriptId}/progress`, {
        method: 'PUT',
        body: JSON.stringify(status ? { cursor: next, status } : { cursor: next }),
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        if (data.progress) setProgress(data.progress)
      }
    } catch {
      // 进度写入失败不阻塞练习：下次进入按游标恢复，可能回退一句
    }
  }, [authFetch, progress])

  const finish = useCallback(async () => {
    if (!script) return
    const total = script.lines.length
    setDone(true)
    setSummary(summarizeAnswers(progress?.answers, script.lines))
    await saveCursor(total, 'completed')
  }, [script, progress, saveCursor])

  // 跳到任意一句：回看已答过的句子时把当时的反馈一起还原
  const gotoLine = useCallback(async (target) => {
    if (!script || !Number.isInteger(target)) return
    speech.stop()
    setActionError(null)
    setRevealed(false)
    setCursor(target)
    const saved = (progress?.answers || []).find(a => a && a.index === target)
    const restored = reviewFromSavedAnswer(saved)
    if (restored) {
      setUserText(String(saved.userText ?? ''))
      setReview(restored)
      setAttempts(Number(saved.attempts) || 0)
    } else {
      setUserText('')
      setReview(null)
      setAttempts(0)
    }
    await saveCursor(target)
  }, [script, speech, progress, saveCursor])

  const handlePrev = useCallback(async () => {
    if (!script || evaluating) return
    const target = prevIndex(cursor, script.lines.length)
    if (target === null) return
    await gotoLine(target)
  }, [script, evaluating, cursor, gotoLine])

  const handleNext = useCallback(async () => {
    if (!script || evaluating) return
    const target = nextIndex(cursor, script.lines.length)
    if (target === null) {
      await finish()
      return
    }
    await gotoLine(target)
  }, [script, evaluating, cursor, finish, gotoLine])

  const restart = useCallback(async () => {
    setShowMenu(false)
    if (!progress?.scriptId) return
    if (!window.confirm('重新开始会清空本次练习的答题记录，继续？')) return
    try {
      const res = await authFetch(`/dialogue/${progress.scriptId}/restart`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setActionError(data.error || '重新开始失败，请重试'); return }
      if (data.progress) setProgress(data.progress)
      setCursor(0)
      setDone(false)
      setSummary(null)
      resetAnswer()
    } catch {
      setActionError('网络异常，请稍后重试')
    }
  }, [authFetch, progress, resetAnswer])

  const speak = useCallback((text) => {
    if (text) speakerRef.current?.speak(text)
  }, [])

  const toggleReveal = useCallback(() => {
    const next = !revealed
    setRevealed(next)
    const scriptId = progress?.scriptId
    if (!next || !scriptId || !review) return
    authFetch(`/dialogue/${scriptId}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ index: cursorRef.current }),
    })
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (data?.progress) setProgress(data.progress) })
      .catch(() => { /* 记录失败不影响看答案 */ })
  }, [revealed, progress, review, authFetch])

  // ── 状态页 ──────────────────────────────────────────────
  if (loading || generating) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4 px-6">
        <div className="h-10 w-10 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
        <p className="text-sm font-bold text-slate-600">
          {generating ? '正在为这个视频准备对话…' : '加载中…'}
        </p>
        {generating && <p className="text-xs text-slate-400 text-center">大约需要 10–20 秒，只需要生成一次</p>}
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <AlertTriangle className="h-8 w-8 text-rose-500" />
        <p className="text-sm text-slate-600 max-w-sm">{error}</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => loadScript(difficulty)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold cursor-pointer"
          >
            重试
          </button>
          <button
            onClick={() => navigate(`/video/${id}`)}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-bold cursor-pointer"
          >
            返回视频
          </button>
        </div>
      </div>
    )
  }

  // 只在「没有已存剧本」时才用 AI 未配置挡住页面；已有剧本仍然可以打开浏览/练习
  if (!aiConfigured && !script) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <p className="text-sm text-slate-600 max-w-sm">AI 未配置，无法生成对话。请在服务端配置 AI_API_KEY 后再试。</p>
        <button
          onClick={() => navigate(`/video/${id}`)}
          className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-bold cursor-pointer"
        >
          返回视频
        </button>
      </div>
    )
  }

  if (!script || script.lines.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-slate-600">这个视频还没有可练习的对话</p>
        <button
          onClick={() => generateScript(difficulty)}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold cursor-pointer"
        >
          生成对话
        </button>
      </div>
    )
  }

  const total = script.lines.length
  const line = script.lines[Math.min(cursor, total - 1)]
  const context = contextOf(script.lines, cursor)
  const verdictStyle = VERDICT_STYLE[review?.verdict] || null
  const action = primaryAction(review, attempts)

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <div
        className="sticky top-0 z-20 bg-white/95 backdrop-blur-md border-b border-slate-100 px-3 py-2 flex items-center gap-2"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <button
          onClick={() => navigate(`/video/${id}`)}
          className="flex items-center justify-center w-9 h-9 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg shrink-0 active:scale-95 cursor-pointer"
          title="返回视频"
        >
          <ArrowLeft className="h-4 w-4 stroke-[2.5]" />
        </button>
        <h2 className="text-sm font-extrabold text-slate-800 tracking-tight truncate">🔁 中译英对话</h2>
        <span className="ml-auto text-xs font-bold text-slate-400 tabular-nums shrink-0">
          {progressLabel(cursor, total)}
        </span>
        <div className="relative shrink-0">
          <button
            onClick={() => setShowMenu(v => !v)}
            className="flex items-center justify-center w-9 h-9 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg active:scale-95 cursor-pointer"
            title="更多"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 mt-1 w-48 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-20">
                <button
                  onClick={regenerate}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <RefreshCw className="h-4 w-4" />重新生成对话
                </button>
                <button
                  onClick={restart}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <RotateCcw className="h-4 w-4" />重新开始
                </button>
                <button
                  onClick={() => { setShowMenu(false); navigate(`/video/${id}`) }}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  <ArrowLeft className="h-4 w-4" />返回视频
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 难度 */}
      <div className="flex items-center justify-center gap-2 px-4 pt-3">
        {DIFFICULTIES.map(d => (
          <button
            key={d}
            onClick={() => pickDifficulty(d)}
            className={`inline-flex items-center min-h-[44px] px-4 rounded-lg text-xs font-bold transition-all active:scale-95 cursor-pointer border ${
              d === difficulty
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-200'
            }`}
          >
            {DIFFICULTY_LABELS[d]}
            {available.includes(d) && d !== difficulty && <span className="ml-1 text-emerald-500">•</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 w-full max-w-2xl mx-auto px-4 py-4 flex flex-col gap-4 pb-8">
        {/* 场景 */}
        <div className="rounded-xl bg-indigo-50/70 border border-indigo-100 px-3 py-2">
          <p className="text-xs font-bold text-indigo-700">
            🎬 {script.title || '场景对话'}
            {script.userRole && <span className="font-medium text-indigo-500"> ｜ 你是「{script.userRole}」</span>}
            {script.otherRole && <span className="font-medium text-indigo-500"> ｜ 对方是「{script.otherRole}」</span>}
          </p>
          {script.settingCn && <p className="text-[11px] text-indigo-500/90 mt-0.5">{script.settingCn}</p>}
          {script.source === 'video-info' && (
            <p className="text-[11px] text-amber-600 mt-0.5">无字幕 · 依据视频信息生成</p>
          )}
        </div>

        {done ? (
          /* ── 完成总结 ── */
          <div className="flex flex-col gap-4">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-xs px-5 py-6 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto" />
              <p className="text-base font-extrabold text-slate-800 mt-2">这组对话练完了</p>
              <div className="grid grid-cols-3 gap-2 mt-5">
                <div>
                  <p className={`text-2xl font-extrabold tabular-nums ${scoreTone(summary?.averageScore)}`}>
                    {summary?.averageScore ?? '—'}
                  </p>
                  <p className="text-[11px] font-bold text-slate-400 mt-0.5">平均分</p>
                </div>
                <div>
                  <p className="text-2xl font-extrabold tabular-nums text-slate-700">
                    {summary ? `${summary.answered}/${summary.total}` : '—'}
                  </p>
                  <p className="text-[11px] font-bold text-slate-400 mt-0.5">完成句数</p>
                </div>
                <div>
                  <p className="text-2xl font-extrabold tabular-nums text-slate-700">
                    {summary?.firstTryRate == null ? '—' : `${summary.firstTryRate}%`}
                  </p>
                  <p className="text-[11px] font-bold text-slate-400 mt-0.5">一次通过</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-xs px-5 py-4">
              <p className="text-xs font-bold text-slate-400 tracking-wider mb-2">常见错误</p>
              {summary?.topIssues?.length ? (
                <div className="flex flex-wrap gap-2">
                  {summary.topIssues.map(i => (
                    <span key={i.type} className="text-xs font-bold px-2.5 py-1 rounded-lg bg-rose-50 text-rose-600 border border-rose-100">
                      {ISSUE_TYPE_LABELS[i.type] || i.type} × {i.count}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">没有明显集中的错误，保持这个状态。</p>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-xs px-5 py-4">
              <p className="text-xs font-bold text-slate-400 tracking-wider mb-2">需要复习的表达</p>
              {summary?.reviewLines?.length ? (
                <div className="flex flex-col gap-2">
                  {summary.reviewLines.map(r => (
                    <div key={r.index} className="rounded-lg border border-slate-100 px-3 py-2">
                      <div className="flex items-start gap-2">
                        <p className="flex-1 text-sm text-slate-700">{r.cn}</p>
                        <span className={`text-xs font-bold tabular-nums ${scoreTone(r.score)}`}>{r.score ?? '—'}</span>
                        <button
                          onClick={() => speak(r.en)}
                          className="p-1 rounded-md text-slate-400 hover:bg-slate-50 cursor-pointer"
                          title="发音"
                        >
                          <Volume2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="text-xs text-indigo-600 mt-1">{r.en}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">这一组都说得不错，可以换一组新的继续。</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={restart}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold active:scale-95 cursor-pointer"
              >
                重新开始这组对话
              </button>
              <button
                onClick={() => { setDone(false); resetAnswer(); setCursor(0); saveCursor(0) }}
                className="w-full py-3 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-bold active:scale-95 cursor-pointer"
              >
                再看一遍这组对话
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 上下文 + 当前句 */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-xs px-5 py-6 text-center">
              {context && (
                <p className="text-xs text-slate-400 mb-4 line-clamp-2">
                  上一句（{context.speakerCn || '对方'}）：{context.cn}
                </p>
              )}
              <p className="text-[11px] font-bold text-slate-400 tracking-wider mb-2">{line.speakerCn || '你'}</p>
              <p className="text-2xl md:text-3xl font-extrabold text-slate-800 leading-relaxed break-words">{line.cn}</p>
              {Array.isArray(line.keyPoints) && line.keyPoints.length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-1.5 mt-4">
                  {line.keyPoints.map((k, i) => (
                    <span key={i} className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-slate-50 text-slate-500 border border-slate-100">{k}</span>
                  ))}
                </div>
              )}
            </div>

            {/* 语音作答 */}
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={() => speech.start(text => setUserText(text))}
                className={`flex items-center justify-center w-20 h-20 rounded-full text-white shadow-lg transition-all active:scale-95 cursor-pointer ${
                  speech.listening ? 'bg-rose-500 shadow-rose-200' : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200'
                }`}
                title={speech.listening ? '点击停止' : '点击开始录音'}
              >
                {speech.listening ? <Square className="h-6 w-6" /> : <Mic className="h-7 w-7" />}
              </button>
              <p className="text-xs text-slate-400">{speech.listening ? '录音中，再点一次结束' : '点击麦克风说英文'}</p>

              <textarea
                value={userText}
                onChange={e => setUserText(e.target.value)}
                placeholder="识别结果会显示在这里，可手动修改后点解析"
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none"
              />

              <button
                onClick={evaluate}
                disabled={!userText.trim() || evaluating}
                className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-bold transition-all flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed"
              >
                <Sparkles className="h-4 w-4" />{evaluating ? '解析中...' : '解析我的回答'}
              </button>

              {speech.error && <p className="text-xs text-rose-500 text-center">{speech.error}</p>}
              {actionError && <p className="text-xs text-rose-500 text-center">{actionError}</p>}
            </div>

            {/* 评估结果 */}
            {review && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-xs p-5 flex flex-col gap-4">
                {review.parseError ? (
                  <div className="flex items-center gap-2 text-rose-600 text-sm">
                    <AlertTriangle className="h-4 w-4" />这句没评出来，请再点一次解析
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      {verdictStyle && (
                        <span className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border ${verdictStyle.cls}`}>
                          {verdictStyle.label}
                        </span>
                      )}
                      <span className={`ml-auto text-3xl font-extrabold tabular-nums ${scoreTone(review.score)}`}>
                        {review.score == null ? '—' : review.score}
                      </span>
                    </div>

                    <div>
                      <p className="text-xs font-bold text-slate-400 mb-1">你说</p>
                      <p className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">{userText}</p>
                    </div>

                    {review.hint && review.answerHidden && (
                      <div className="rounded-lg bg-amber-50 p-3 flex gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                        <p className="text-sm text-amber-700">{review.hint}</p>
                      </div>
                    )}

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
                  </>
                )}

                {revealed && (
                  <div className="rounded-lg bg-indigo-50/70 border border-indigo-100 p-3">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-bold text-indigo-700 flex-1">参考答案</p>
                      <button
                        onClick={() => speak(line.en)}
                        className="p-1 rounded-md text-indigo-500 hover:bg-white/60 cursor-pointer"
                        title="发音"
                      >
                        <Volume2 className="h-4 w-4" />
                      </button>
                    </div>
                    <p className="text-sm text-indigo-800 mt-1">{line.en}</p>
                    {Array.isArray(line.alternatives) && line.alternatives.length > 0 && (
                      <p className="text-xs text-indigo-500 mt-1">也可以说：{line.alternatives.join(' / ')}</p>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  {action === 'retry' ? (
                    <button
                      onClick={resetAnswer}
                      className="flex-1 py-3 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-sm font-bold active:scale-95 cursor-pointer"
                    >
                      再试一次
                    </button>
                  ) : (
                    <button
                      onClick={handleNext}
                      className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold active:scale-95 cursor-pointer flex items-center justify-center gap-1"
                    >
                      {cursor + 1 >= total ? '完成练习' : '下一句'}<ChevronRight className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={toggleReveal}
                    className="px-3 py-3 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-bold active:scale-95 cursor-pointer"
                  >
                    {revealed ? '收起答案' : '查看参考答案'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 上一句 / 重说 / 下一句：常驻底部，随时可跳过或回看 */}
      {!done && (
        <div
          className="sticky bottom-0 z-10 bg-white/95 backdrop-blur border-t border-slate-100 px-4 py-2 flex items-center gap-2"
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={handlePrev}
            disabled={prevIndex(cursor, total) === null || evaluating}
            className="flex-1 min-h-[44px] flex items-center justify-center gap-1 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-bold disabled:opacity-40 active:scale-95 cursor-pointer disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />上一句
          </button>
          <button
            onClick={resetAnswer}
            disabled={(!userText && !review) || evaluating}
            className="flex-1 min-h-[44px] flex items-center justify-center gap-1 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-bold disabled:opacity-40 active:scale-95 cursor-pointer disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-4 w-4" />重说
          </button>
          <button
            onClick={handleNext}
            disabled={evaluating}
            className="flex-[1.2] min-h-[44px] flex items-center justify-center gap-1 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold disabled:opacity-40 active:scale-95 cursor-pointer disabled:cursor-not-allowed"
          >
            {nextIndex(cursor, total) === null ? '完成练习' : '下一句'}<ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
