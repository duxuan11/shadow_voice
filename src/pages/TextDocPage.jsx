import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, MoreHorizontal, ChevronLeft, ChevronRight, Volume2, Mic, Square,
  AlertTriangle, CheckCircle2, Loader2, Lightbulb, ThumbsUp, Eye, Trash2, RefreshCw, PencilLine,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import { createSpeaker } from '../utils/tts'
import { useSpeechInput } from '../utils/useSpeechInput'
import ShadowingEvaluator from '../components/ShadowingEvaluator'
import {
  missingCnCount, shadowDoneCount, translateDoneCount, percent, resumeIndex,
  findShadow, reviewFromSavedAnswer, avgScore, initialTab,
} from '../utils/textPractice'

const ISSUE_TYPE_LABELS = {
  grammar: '语法',
  word_choice: '用词',
  collocation: '搭配',
  naturalness: '地道',
  incomplete: '不完整',
  term: '术语',
  other: '问题',
}

const VERDICT_STYLE = {
  correct: { label: '写对了', cls: 'bg-emerald-50 text-emerald-700 border-emerald-100', tone: 'text-emerald-600' },
  minor: { label: '意思对，可以更地道', cls: 'bg-amber-50 text-amber-700 border-amber-100', tone: 'text-amber-600' },
  wrong: { label: '再改一次', cls: 'bg-rose-50 text-rose-700 border-rose-100', tone: 'text-rose-600' },
}

function scoreTone(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 80) return 'text-emerald-600'
  if (score >= 60) return 'text-amber-600'
  return 'text-rose-600'
}

// 文本练习详情：同一份文本两种练法（逐句跟读 / 汉译英），进度各自独立保存。
// 跟读评分复用 ShadowingEvaluator（阿里云口语评测），播放复用 createSpeaker，
// 语音作答复用 useSpeechInput（ASR → Web Speech → 打字兜底）。
export default function TextDocPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()

  const [doc, setDoc] = useState(null)
  const [progress, setProgress] = useState(null)
  const [aiConfigured, setAiConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [fatal, setFatal] = useState(null) // 'notfound' | null

  const [tab, setTab] = useState('shadow') // shadow | translate
  const [shadowIdx, setShadowIdx] = useState(0)
  const [translateIdx, setTranslateIdx] = useState(0)
  const [showCn, setShowCn] = useState(false)

  const [answer, setAnswer] = useState('')
  const [review, setReview] = useState(null)
  const [revealed, setRevealed] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [savingCursor, setSavingCursor] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [toast, setToast] = useState(null)

  const speakerRef = useRef(null)
  const speech = useSpeechInput(authFetch)

  const sentences = doc?.sentences || []
  const total = sentences.length
  const current = sentences[tab === 'shadow' ? shadowIdx : translateIdx] || null

  const [reloadKey, setReloadKey] = useState(0)

  // 首屏加载：effect 内自取，避免同步 setState
  useEffect(() => {
    if (isGuest) {
      navigate('/login', { state: { from: `/texts/${id}` } })
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await authFetch(`/texts/${id}`)
        if (res.status === 404) { if (!cancelled) setFatal('notfound'); return }
        if (!res.ok) throw new Error('加载失败，请重试')
        const data = await res.json()
        if (cancelled) return
        const list = data.doc?.sentences || []
        setDoc(data.doc)
        setProgress(data.progress)
        setAiConfigured(!!data.aiConfigured)
        setTab(initialTab(data.progress))
        setShadowIdx(resumeIndex(data.progress?.shadow, data.progress?.shadowCursor, list.length))
        setTranslateIdx(resumeIndex(data.progress?.answers, data.progress?.translateCursor, list.length))
      } catch (err) {
        if (!cancelled) setError(err.message || '加载失败，请重试')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [authFetch, id, isGuest, navigate, reloadKey])

  // 说话器：在 effect 里建/销毁（与 DialoguePage 同款，避免渲染期读 ref）
  useEffect(() => {
    speakerRef.current = createSpeaker(authFetch)
    return () => speakerRef.current?.stop()
  }, [authFetch])

  // 提示条 3 秒后自动消失
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  // 从当前进度恢复该句已保存的作答
  const hydrateTranslate = (index, nextProgress = progress) => {
    const record = (nextProgress?.answers || []).find((a) => a.index === index) || null
    setAnswer(record?.userText || '')
    setReview(reviewFromSavedAnswer(record))
    setRevealed(!!record?.revealedAnswer)
  }

  const switchTab = (next) => {
    if (next === tab || !doc) return
    speakerRef.current?.stop()
    setTab(next)
    setShowCn(false)
    if (next === 'translate') hydrateTranslate(translateIdx)
  }

  const goShadow = (index) => {
    if (index < 0 || index >= total) return
    speakerRef.current?.stop()
    setShadowIdx(index)
  }

  const goTranslate = (index) => {
    if (index < 0 || index >= total) return
    setTranslateIdx(index)
    hydrateTranslate(index)
  }

  const playSentence = () => {
    if (!current?.en) return
    speakerRef.current?.speak(current.en)
  }

  const putProgress = async (body) => {
    const res = await authFetch(`/texts/${id}/progress`, { method: 'PUT', body: JSON.stringify(body) })
    if (!res.ok) throw new Error('进度保存失败')
    const data = await res.json()
    setProgress(data.progress)
    return data.progress
  }

  // 跟读出分 → 落库（只存最佳分）；失败不阻塞继续练
  const saveShadow = async (index, result) => {
    const overall = Number(result?.overall)
    if (!Number.isFinite(overall)) return
    setSavingCursor(true)
    try {
      const res = await authFetch(`/texts/${id}/shadow`, {
        method: 'POST',
        body: JSON.stringify({ index, score: Math.round(overall) }),
      })
      if (!res.ok) throw new Error('分数保存失败')
      const data = await res.json()
      setProgress(data.progress)
      const nextCursor = Math.min(index + 1, total)
      const res2 = await authFetch(`/texts/${id}/progress`, {
        method: 'PUT',
        body: JSON.stringify({ shadowCursor: nextCursor }),
      })
      if (res2.ok) setProgress((await res2.json()).progress)
    } catch (err) {
      setToast(err.message || '分数保存失败')
    } finally {
      setSavingCursor(false)
    }
  }

  const onSpeech = () => {
    speech.start((text) => {
      if (!text) return
      setAnswer((prev) => (prev ? `${prev} ${text}`.trim() : text))
    })
  }

  const submitAnswer = async () => {
    if (!current || !answer.trim() || reviewing) return
    setReviewing(true)
    try {
      const res = await authFetch(`/texts/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ index: translateIdx, userText: answer.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 503) throw new Error(data.error || 'AI 服务暂不可用，请稍后重试')
      if (!res.ok) throw new Error(data.error || '评分失败，请重试')
      setReview(data.review)
      setProgress(data.progress)
      try {
        await putProgress({ translateCursor: Math.min(translateIdx + 1, total) })
      } catch { /* 游标失败不影响本次评分展示 */ }
    } catch (err) {
      setToast(err.message || '评分失败，请重试')
    } finally {
      setReviewing(false)
    }
  }

  const revealAnswer = async () => {
    const record = (progress?.answers || []).find((a) => a.index === translateIdx)
    if (!record) {
      setToast('先提交一次答案再看原文')
      return
    }
    setRevealed(true)
    try {
      const res = await authFetch(`/texts/${id}/reveal`, {
        method: 'POST',
        body: JSON.stringify({ index: translateIdx }),
      })
      if (res.ok) setProgress((await res.json()).progress)
    } catch { /* 记录失败不影响查看 */ }
  }

  const completePractice = async () => {
    try {
      await putProgress({ status: 'completed', translateCursor: translateIdx })
    } catch (err) {
      setToast(err.message || '操作失败，请重试')
    }
  }

  const resumePractice = async () => {
    try {
      await putProgress({ status: 'active' })
      setTab('translate')
      hydrateTranslate(translateIdx)
    } catch (err) {
      setToast(err.message || '操作失败，请重试')
    }
  }

  const regenerateChinese = async () => {
    if (translating) return
    setTranslating(true)
    setShowMenu(false)
    try {
      const res = await authFetch(`/texts/${id}/translate`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '生成失败，请稍后重试')
      setDoc(data.doc)
      setToast(data.translation === 'ok' ? '中文已生成' : '部分句子仍未生成，可稍后重试')
    } catch (err) {
      setToast(err.message || '生成失败，请稍后重试')
    } finally {
      setTranslating(false)
    }
  }

  const renameTitle = async () => {
    setShowMenu(false)
    const next = window.prompt('编辑标题', doc?.title || '')
    if (next === null) return
    const title = next.trim()
    if (!title) { setToast('标题不能为空'); return }
    try {
      const res = await authFetch(`/texts/${id}`, { method: 'PUT', body: JSON.stringify({ title }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '保存失败，请重试')
      setDoc(data.doc)
      setToast('标题已更新')
    } catch (err) {
      setToast(err.message || '保存失败，请重试')
    }
  }

  const removeDoc = async () => {
    setShowMenu(false)
    if (!window.confirm('删除后进度不可恢复，确定删除这份文本？')) return
    try {
      const res = await authFetch(`/texts/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error('删除失败，请重试')
      navigate('/texts')
    } catch (err) {
      setToast(err.message || '删除失败，请重试')
    }
  }

  // ── 状态分支 ────────────────────────────────────────────
  if (isGuest) return null

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3">
        <div className="h-9 w-9 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
        <p className="text-xs font-bold text-slate-500">加载中...</p>
      </div>
    )
  }

  if (fatal === 'notfound') {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <p className="text-sm text-slate-600">文本不存在或已删除</p>
        <button type="button" onClick={() => navigate('/texts')} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer">
          返回列表
        </button>
      </div>
    )
  }

  if (error && !doc) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="h-8 w-8 text-rose-500" />
        <p className="text-sm text-slate-600">{error}</p>
        <button
          type="button"
          onClick={() => { setError(null); setLoading(true); setReloadKey((k) => k + 1) }}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer"
        >
          重试
        </button>
      </div>
    )
  }

  const missing = missingCnCount(sentences)
  const done = tab === 'shadow' ? shadowDoneCount(progress) : translateDoneCount(progress)
  const completedView = tab === 'translate' && progress?.status === 'completed'
  const verdict = review ? (VERDICT_STYLE[review.verdict] || VERDICT_STYLE.wrong) : null
  const hasSavedAnswer = (progress?.answers || []).some((a) => a.index === translateIdx)

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-md border-b border-slate-100">
        <div className="mx-auto w-full max-w-3xl px-3 py-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/texts')}
            className="flex items-center justify-center w-9 h-9 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg shrink-0 active:scale-95 cursor-pointer"
            title="返回列表"
          >
            <ArrowLeft className="h-4 w-4 stroke-[2.5]" />
          </button>
          <button
            type="button"
            onClick={renameTitle}
            className="min-w-0 flex-1 text-left cursor-pointer"
            title="点击修改标题"
          >
            <h1 className="text-sm font-extrabold text-slate-800 tracking-tight truncate">{doc?.title}</h1>
            <p className="text-[10px] text-slate-400">{total} 句 · {doc?.truncated ? '仅前 200 句' : '点击标题可改名'}</p>
          </button>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setShowMenu((v) => !v)}
              className="flex items-center justify-center w-9 h-9 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg active:scale-95 cursor-pointer"
              title="更多"
            >
              {translating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-20">
                  <button type="button" onClick={regenerateChinese} className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer">
                    <RefreshCw className="h-3.5 w-3.5" />重新生成中文
                  </button>
                  <button type="button" onClick={renameTitle} className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer">
                    <PencilLine className="h-3.5 w-3.5" />编辑标题
                  </button>
                  <button type="button" onClick={removeDoc} className="flex items-center gap-2 w-full px-3 py-2.5 text-left text-xs font-bold text-rose-600 hover:bg-rose-50 cursor-pointer">
                    <Trash2 className="h-3.5 w-3.5" />删除文本
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-3 pb-2 flex items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => switchTab('shadow')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-bold cursor-pointer ${tab === 'shadow' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500'}`}
            >
              逐句跟读
            </button>
            <button
              type="button"
              onClick={() => switchTab('translate')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-bold cursor-pointer ${tab === 'translate' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500'}`}
            >
              汉译英
            </button>
          </div>
          <div className="flex-1 flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${percent(done, total)}%` }} />
            </div>
            <span className="text-[10px] font-bold text-slate-400 tabular-nums shrink-0">
              {done}/{total}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-3 py-3 space-y-3">
        {missing > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-[11px] font-semibold text-amber-700 flex-1">
              有 {missing} 句还没有中文翻译
            </p>
            <button
              type="button"
              onClick={regenerateChinese}
              disabled={translating || !aiConfigured}
              className="shrink-0 px-2 py-1 bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 text-white rounded-md text-[10px] font-bold cursor-pointer disabled:cursor-not-allowed"
            >
              {translating ? '生成中…' : '生成中文翻译'}
            </button>
          </div>
        )}

        {!aiConfigured && (
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-500">
            AI 未配置，中文翻译与回译评分暂不可用；跟读练习不受影响。
          </div>
        )}

        {completedView ? (
          <section className="rounded-2xl bg-white border border-emerald-100 px-4 py-8 text-center space-y-3">
            <CheckCircle2 className="h-9 w-9 text-emerald-500 mx-auto" />
            <h2 className="text-sm font-extrabold text-slate-800">这份文本已经练完了</h2>
            <p className="text-[11px] text-slate-500">
              跟读 {shadowDoneCount(progress)}/{total} · 翻译 {translateDoneCount(progress)}/{total} · 平均分 {avgScore(progress?.answers) ?? '—'}
            </p>
            <div className="flex items-center justify-center gap-2">
              <button type="button" onClick={resumePractice} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer">
                继续练习
              </button>
              <button type="button" onClick={() => navigate('/texts')} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-bold cursor-pointer">
                返回列表
              </button>
            </div>
          </section>
        ) : (
          <>
            {!current && (
              <div className="rounded-2xl bg-white border border-slate-200 px-4 py-10 text-center text-sm text-slate-500">
                这份文本没有可练习的句子
              </div>
            )}

            {current && tab === 'shadow' && (
              <section className="space-y-3">
                <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
                  {current.section && (
                    <span className="inline-block text-[10px] font-bold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">
                      {current.section}
                    </span>
                  )}
                  <p className="text-base font-bold text-slate-800 leading-relaxed break-words">{current.en}</p>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={playSentence}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-[11px] font-bold cursor-pointer"
                    >
                      <Volume2 className="h-3.5 w-3.5" />播放原音
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCn((v) => !v)}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-[11px] font-bold cursor-pointer"
                    >
                      {showCn ? '隐藏中文' : '显示中文'}
                    </button>
                    {findShadow(progress?.shadow, shadowIdx) && (
                      <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                        最佳 {findShadow(progress?.shadow, shadowIdx).best} 分
                      </span>
                    )}
                    {savingCursor && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
                  </div>

                  {showCn && (
                    <p className="text-xs text-slate-500 leading-relaxed border-t border-slate-100 pt-2">
                      {current.cn || '（这句还没有中文译文）'}
                    </p>
                  )}

                  <div className="border-t border-slate-100 pt-3">
                    <ShadowingEvaluator
                      key={`shadow-${shadowIdx}`}
                      refText={current.en}
                      onResult={(result) => saveShadow(shadowIdx, result)}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => goShadow(shadowIdx - 1)}
                    disabled={shadowIdx <= 0}
                    className="flex items-center gap-1 px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 text-slate-600 rounded-lg text-xs font-bold cursor-pointer"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />上一句
                  </button>
                  <span className="text-[11px] font-bold text-slate-400 tabular-nums">
                    {shadowIdx + 1}/{total}
                  </span>
                  <button
                    type="button"
                    onClick={() => goShadow(shadowIdx + 1)}
                    disabled={shadowIdx >= total - 1}
                    className="ml-auto flex items-center gap-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg text-xs font-bold cursor-pointer disabled:cursor-not-allowed"
                  >
                    下一句<ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-1 overflow-x-auto pb-1">
                  {sentences.map((s) => {
                    const doneItem = !!findShadow(progress?.shadow, s.i)
                    const active = s.i === shadowIdx
                    return (
                      <button
                        key={s.i}
                        type="button"
                        onClick={() => goShadow(s.i)}
                        title={`第 ${s.i + 1} 句`}
                        className={`h-5 w-5 shrink-0 rounded-full text-[9px] font-bold tabular-nums cursor-pointer border ${
                          active
                            ? 'bg-indigo-600 border-indigo-600 text-white'
                            : doneItem
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                              : 'bg-white border-slate-200 text-slate-400'
                        }`}
                      >
                        {s.i + 1}
                      </button>
                    )
                  })}
                </div>
              </section>
            )}

            {current && tab === 'translate' && (
              <section className="space-y-3">
                <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
                  {current.section && (
                    <span className="inline-block text-[10px] font-bold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">
                      {current.section}
                    </span>
                  )}
                  <p className="text-base font-bold text-slate-800 leading-relaxed break-words">
                    {current.cn || '（这句还没有中文译文，可先用跟读模式练这句）'}
                  </p>

                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    rows={3}
                    placeholder="用英文表达这句话…"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400"
                  />

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={onSpeech}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold cursor-pointer ${
                        speech.listening ? 'bg-rose-600 text-white' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                      }`}
                    >
                      {speech.listening ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                      {speech.listening ? '停止' : '说英文'}
                    </button>
                    <button
                      type="button"
                      onClick={revealAnswer}
                      disabled={!hasSavedAnswer}
                      title={hasSavedAnswer ? '查看英文原文' : '先提交一次答案'}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-600 rounded-lg text-[11px] font-bold cursor-pointer disabled:cursor-not-allowed"
                    >
                      <Eye className="h-3.5 w-3.5" />对照原文
                    </button>
                    <button
                      type="button"
                      onClick={submitAnswer}
                      disabled={!answer.trim() || reviewing}
                      className="ml-auto flex items-center gap-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg text-[11px] font-bold cursor-pointer disabled:cursor-not-allowed"
                    >
                      {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      {reviewing ? '评分中…' : '提交答案'}
                    </button>
                  </div>

                  {speech.error && <p className="text-[10px] font-semibold text-rose-500">{speech.error}</p>}

                  {revealed && (
                    <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2">
                      <p className="text-[10px] font-bold text-slate-400 mb-1">英文原文</p>
                      <p className="text-xs text-slate-700 leading-relaxed break-words">{current.en}</p>
                    </div>
                  )}
                </div>

                {review && verdict && (
                  <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${verdict.cls}`}>{verdict.label}</span>
                      <span className={`ml-auto text-sm font-extrabold font-mono ${scoreTone(review.score)}`}>
                        {review.score == null ? '—' : `${Math.round(review.score)}分`}
                      </span>
                    </div>

                    {review.parseError && (
                      <p className="text-[11px] font-semibold text-rose-600">评分解析失败，请重试</p>
                    )}

                    {review.issues.length > 0 && (
                      <ul className="space-y-1.5">
                        {review.issues.map((issue, i) => (
                          <li key={i} className="rounded-xl bg-slate-50 px-2.5 py-2 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-bold text-slate-500 bg-white border border-slate-200 px-1.5 rounded">
                                {ISSUE_TYPE_LABELS[issue.type] || issue.type || '问题'}
                              </span>
                              {issue.location && <span className="text-[10px] font-mono text-slate-500 truncate">{issue.location}</span>}
                            </div>
                            {issue.problem && <p className="text-[11px] text-slate-600">{issue.problem}</p>}
                            {issue.suggestion && <p className="text-[11px] text-slate-500">建议：{issue.suggestion}</p>}
                            {issue.better && <p className="text-[11px] font-bold text-emerald-700">{issue.better}</p>}
                          </li>
                        ))}
                      </ul>
                    )}

                    {review.better && (
                      <div className="flex items-start gap-1.5 rounded-xl bg-indigo-50 px-2.5 py-2">
                        <Lightbulb className="h-3.5 w-3.5 text-indigo-500 shrink-0 mt-0.5" />
                        <p className="text-[11px] font-bold text-indigo-700 leading-relaxed break-words">{review.better}</p>
                      </div>
                    )}

                    {review.praise && (
                      <p className="flex items-start gap-1.5 text-[11px] font-semibold text-emerald-700">
                        <ThumbsUp className="h-3.5 w-3.5 shrink-0 mt-0.5" />{review.praise}
                      </p>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => goTranslate(translateIdx - 1)}
                    disabled={translateIdx <= 0}
                    className="flex items-center gap-1 px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 text-slate-600 rounded-lg text-xs font-bold cursor-pointer"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />上一句
                  </button>
                  <span className="text-[11px] font-bold text-slate-400 tabular-nums">
                    {translateIdx + 1}/{total}
                  </span>
                  {translateIdx >= total - 1 ? (
                    <button
                      type="button"
                      onClick={completePractice}
                      className="ml-auto flex items-center gap-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold cursor-pointer"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />完成练习
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => goTranslate(translateIdx + 1)}
                      className="ml-auto flex items-center gap-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer"
                    >
                      下一句<ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {toast && (
        <div className="fixed left-1/2 bottom-6 z-30 -translate-x-1/2 rounded-full bg-slate-900/90 px-4 py-2 text-[11px] font-bold text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
