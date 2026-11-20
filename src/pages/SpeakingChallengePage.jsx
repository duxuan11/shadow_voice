// 每日口语挑战（/video/:id/challenge）：五步主动口语训练 + 每步反馈 + 最终报告。
// 进入页面 0 次模型调用；生成/每步反馈/对话/收尾各自单独请求。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, Circle, History, Loader2,
  PlayCircle, RefreshCw, Sparkles, Target, X,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import {
  STEP_META, REPORT_STEP, stepStatus, resumeStep, formatDuration,
} from '../utils/speakingChallenge'
import StageList from '../components/challenge/StageList'
import StageChunks from '../components/challenge/StageChunks'
import StageTopic from '../components/challenge/StageTopic'
import StageChat from '../components/challenge/StageChat'
import ChallengeReport from '../components/challenge/ChallengeReport'

function replaceStep(steps, index, record) {
  const next = Array.isArray(steps) ? [...steps] : [null, null, null, null, null]
  while (next.length < STEP_META.length) next.push(null)
  next[index] = record
  return next
}

export default function SpeakingChallengePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()

  const [hub, setHub] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const bootedIdRef = useRef(null)

  const loginRedirect = useCallback(() => {
    navigate('/login', { state: { from: `/video/${id}/challenge` } })
  }, [navigate, id])

  useEffect(() => {
    if (isGuest) loginRedirect()
  }, [isGuest, loginRedirect])

  const load = useCallback(async (variant) => {
    setError(null)
    try {
      const qs = variant ? `?variant=${encodeURIComponent(variant)}` : ''
      const res = await authFetch(`/challenge/${encodeURIComponent(id)}${qs}`)
      if (res.status === 401) { loginRedirect(); return }
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        setError(data?.error || '加载挑战失败，请重试')
        return
      }
      setHub(data)
      setStepIndex(resumeStep(data.progress))
    } catch {
      setError('网络异常，请重试')
    } finally {
      setLoading(false)
    }
  }, [authFetch, id, loginRedirect])

  // React StrictMode 下 effect 会跑两次：按 id 记忆已启动，且不做「取消」早退
  useEffect(() => {
    if (bootedIdRef.current === id) return
    bootedIdRef.current = id
    setLoading(true)
    load()
  }, [id, load])

  const generate = async () => {
    if (busy) return
    if (hub?.challenge && !window.confirm('会生成一套全新任务，当前这套会保留在历史里。继续？')) return
    setBusy('generate')
    setActionError(null)
    try {
      const res = await authFetch(`/challenge/${encodeURIComponent(id)}/generate`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        setActionError(data?.error || '生成失败，请重试')
        return
      }
      setHub((prev) => ({
        ...(prev || {}),
        challengeId: data.challengeId,
        variant: data.variant,
        challenge: data.challenge,
        progress: data.progress,
        mastery: data.mastery,
        history: [
          { challengeId: data.challengeId, variant: data.variant, status: 'active', cursor: 0, score: null },
          ...((prev?.history || []).filter((h) => h.challengeId !== data.challengeId)),
        ],
      }))
      setStepIndex(0)
    } catch {
      setActionError('网络异常，请重试')
    } finally {
      setBusy(null)
    }
  }

  const submitStep = async (step, payload) => {
    if (busy || !hub?.challengeId) return
    setBusy('step')
    setActionError(null)
    try {
      const res = await authFetch(`/challenge/${hub.challengeId}/step/${step}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        setActionError(data?.error || '评分失败，请重试')
        if (data?.progress) setHub((p) => ({ ...p, progress: data.progress }))
        return
      }
      setHub((p) => ({ ...p, progress: data.progress, mastery: data.mastery }))
    } catch {
      setActionError('网络异常，请重试')
    } finally {
      setBusy(null)
    }
  }

  const sendChat = async (payload) => {
    if (busy || !hub?.challengeId) return
    setBusy('chat')
    setActionError(null)
    try {
      const res = await authFetch(`/challenge/${hub.challengeId}/chat`, {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        setActionError(data?.error || '对话失败，请重试')
        return
      }
      setHub((p) => {
        const steps = replaceStep(p?.progress?.steps, 4, {
          step: 5,
          status: 'answered',
          answers: data.messages,
          feedback: null,
        })
        return { ...p, progress: { ...(p?.progress || {}), steps } }
      })
    } catch {
      setActionError('网络异常，请重试')
    } finally {
      setBusy(null)
    }
  }

  const finishChat = async () => {
    if (busy || !hub?.challengeId) return
    setBusy('finish')
    setActionError(null)
    try {
      const res = await authFetch(`/challenge/${hub.challengeId}/finish`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        setActionError(data?.error || '生成报告失败，请重试')
        return
      }
      setHub((p) => ({ ...p, progress: data.progress, mastery: data.mastery }))
      setStepIndex(REPORT_STEP)
    } catch {
      setActionError('网络异常，请重试')
    } finally {
      setBusy(null)
    }
  }

  const restart = async () => {
    if (busy || !hub?.challengeId) return
    setBusy('restart')
    setActionError(null)
    try {
      const res = await authFetch(`/challenge/${hub.challengeId}/restart`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) {
        setActionError(data?.error || '重练失败，请重试')
        return
      }
      setHub((p) => ({ ...p, progress: data.progress }))
      setStepIndex(0)
    } catch {
      setActionError('网络异常，请重试')
    } finally {
      setBusy(null)
    }
  }

  const openVariant = async (variant) => {
    setHistoryOpen(false)
    setLoading(true)
    await load(variant)
  }

  if (isGuest) return null

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 px-6">
        <div className="h-10 w-10 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
        <p className="text-sm font-bold text-slate-600">加载中…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="h-8 w-8 text-rose-500" />
        <p className="text-sm text-slate-600 max-w-sm">{error}</p>
        <div className="flex items-center gap-2">
          <button onClick={() => { setLoading(true); load() }} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold cursor-pointer">重试</button>
          <button onClick={() => navigate(`/video/${id}`)} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold cursor-pointer">返回视频</button>
        </div>
      </div>
    )
  }

  const video = hub?.video || { id }
  const challenge = hub?.challenge || null
  const progress = hub?.progress || null
  const steps = progress?.steps || []
  const aiConfigured = hub?.aiConfigured !== false
  const report = progress?.report || null
  const currentStep = STEP_META[Math.min(stepIndex, STEP_META.length - 1)]

  const stepItems = (step) => {
    if (!challenge) return []
    if (step === 1) {
      return (challenge.recall || []).map((q) => ({
        index: q.id, title: q.qEn, subtitle: q.qCn, hint: q.focusCn,
      }))
    }
    return (challenge.transformations || []).map((t) => {
      const target = (challenge.chunks || []).find((c) => Number(c.id) === Number(t.targetChunkId))
      const hint = [target ? `用到语块：${target.cn}` : '', t.hintCn].filter(Boolean).join(' · ')
      return { index: t.id, title: t.situationCn, subtitle: '', hint }
    })
  }

  const renderStage = () => {
    if (!challenge) return null
    if (stepIndex === REPORT_STEP) {
      if (!report) {
        return (
          <div className="rounded-2xl border border-slate-100 bg-white px-4 py-6 text-center space-y-2">
            <p className="text-sm font-bold text-slate-700">五步都练完了，报告还没生成</p>
            <p className="text-xs text-slate-500">回到第 5 步结束对话，就会生成报告。</p>
            <button onClick={() => setStepIndex(4)} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold cursor-pointer">回到 AI 对话</button>
          </div>
        )
      }
      return (
        <ChallengeReport
          report={report}
          onRestart={restart}
          onRegenerate={generate}
          onOpenHistory={() => setHistoryOpen(true)}
        />
      )
    }

    if (stepIndex === 0) {
      return (
        <StageList
          step={1}
          items={stepItems(1)}
          record={steps[0]}
          chunks={challenge.chunks}
          onSubmit={(answers) => submitStep(1, { answers })}
          busy={busy === 'step'}
        />
      )
    }
    if (stepIndex === 1) {
      return (
        <StageChunks
          step={2}
          chunks={challenge.chunks}
          record={steps[1]}
          onSubmit={(answers) => submitStep(2, { answers })}
          busy={busy === 'step'}
        />
      )
    }
    if (stepIndex === 2) {
      return (
        <StageList
          step={3}
          items={stepItems(3)}
          record={steps[2]}
          chunks={challenge.chunks}
          onSubmit={(answers) => submitStep(3, { answers })}
          busy={busy === 'step'}
          submitLabel="提交这一步，看反馈"
        />
      )
    }
    if (stepIndex === 3) {
      return (
        <StageTopic
          step={4}
          topic={challenge.topicSpeaking}
          record={steps[3]}
          chunks={challenge.chunks}
          onSubmit={(answer) => submitStep(4, answer)}
          busy={busy === 'step'}
        />
      )
    }
    return (
      <StageChat
        step={5}
        messages={steps[4]?.answers || []}
        record={steps[4]}
        chunks={challenge.chunks}
        onSend={sendChat}
        onFinish={finishChat}
        busy={busy === 'chat'}
        finishing={busy === 'finish'}
      />
    )
  }

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
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-extrabold text-slate-800 tracking-tight truncate">🎯 每日口语挑战</h2>
          <p className="text-[11px] font-bold text-slate-400 truncate">{video.title}</p>
        </div>
        {hub?.variant && (
          <span className="shrink-0 rounded-md bg-indigo-50 border border-indigo-100 px-2 py-0.5 text-[10px] font-extrabold text-indigo-600">
            第 {hub.variant} 套
          </span>
        )}
        <button
          onClick={() => setHistoryOpen(true)}
          disabled={!hub?.history?.length}
          className="shrink-0 flex items-center justify-center w-9 h-9 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg disabled:opacity-40 cursor-pointer"
          title="历史挑战"
        >
          <History className="h-4 w-4" />
        </button>
        <button
          onClick={generate}
          disabled={Boolean(busy) || !aiConfigured}
          className="shrink-0 flex items-center justify-center w-9 h-9 bg-indigo-600 text-white rounded-lg disabled:opacity-40 cursor-pointer active:scale-95"
          title={challenge ? '重新生成一套挑战' : '生成挑战'}
        >
          {busy === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex-1 w-full max-w-3xl mx-auto px-3 py-3 space-y-3 pb-8">
        {!aiConfigured && (
          <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700 flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            AI 未配置：可以浏览已有内容，但暂时无法生成新挑战或获得反馈。
          </div>
        )}
        {actionError && (
          <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-700">
            {actionError}
          </div>
        )}

        {/* 视频信息 */}
        <div className="rounded-2xl border border-slate-100 bg-white px-3 py-2 flex items-center gap-3">
          {video.thumbnail ? (
            <img src={video.thumbnail} alt="" className="h-12 w-20 rounded-lg object-cover bg-slate-100 shrink-0" />
          ) : (
            <div className="h-12 w-20 rounded-lg bg-slate-100 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-800 truncate">{video.title}</p>
            <p className="text-[11px] font-bold text-slate-400 truncate">
              {[video.level, video.topic, video.duration ? formatDuration(video.duration * 1000) : ''].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button
            onClick={() => navigate(`/video/${id}`)}
            className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
          >
            <PlayCircle className="h-3.5 w-3.5" /> 回看原视频
          </button>
        </div>

        {!challenge ? (
          <div className="rounded-2xl border border-slate-100 bg-white px-4 py-6 space-y-3 text-center">
            <Target className="h-7 w-7 text-indigo-500 mx-auto" />
            <p className="text-sm font-extrabold text-slate-800">给这个视频来一套主动口语挑战</p>
            <ul className="text-xs text-slate-500 space-y-1 text-left max-w-md mx-auto">
              {STEP_META.map((s) => (
                <li key={s.step} className="flex items-start gap-1.5">
                  <span className="text-[11px] font-extrabold text-indigo-500">{s.step}.</span>
                  <span><b className="text-slate-700">{s.title}</b> · {s.cn}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-slate-400">任务全部依据这个视频的字幕生成，同一视频可以生成多套不同挑战。</p>
            <button
              onClick={generate}
              disabled={Boolean(busy) || !aiConfigured}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold cursor-pointer disabled:opacity-40 active:scale-95"
            >
              {busy === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {busy === 'generate' ? '正在生成…' : '生成挑战'}
            </button>
            {busy === 'generate' && <p className="text-[11px] text-slate-400">大约需要 10–20 秒，只需要生成一次</p>}
            {hub?.history?.length > 0 && (
              <button onClick={() => setHistoryOpen(true)} className="text-xs font-bold text-slate-500 hover:text-slate-700 cursor-pointer">
                看历史挑战（{hub.history.length}）
              </button>
            )}
          </div>
        ) : (
          <>
            {/* 步骤条 */}
            <div className="rounded-2xl border border-slate-100 bg-white px-2 py-2 flex items-center gap-1 overflow-x-auto">
              {STEP_META.map((meta, i) => {
                const status = stepStatus(steps, meta.step)
                const active = stepIndex === i
                const clickable = status !== 'todo' || i <= Math.max(0, resumeStep(progress))
                return (
                  <button
                    key={meta.step}
                    onClick={() => clickable && setStepIndex(i)}
                    disabled={!clickable}
                    className={`flex-1 min-w-[68px] flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-xl transition-all ${active ? 'bg-indigo-600 text-white' : clickable ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'}`}
                    title={meta.cn}
                  >
                    <span className="flex items-center gap-1 text-[10px] font-extrabold">
                      {status === 'done' ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                      {meta.step}
                    </span>
                    <span className="text-[10px] font-bold truncate max-w-full">{meta.cn}</span>
                  </button>
                )
              })}
              <button
                onClick={() => setStepIndex(REPORT_STEP)}
                disabled={!report}
                className={`flex-1 min-w-[68px] flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-xl ${stepIndex === REPORT_STEP ? 'bg-emerald-600 text-white' : report ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'}`}
              >
                <BookOpen className="h-3 w-3" />
                <span className="text-[10px] font-bold">报告</span>
              </button>
            </div>

            {/* 当前步骤（key 跟着挑战走：换一套后旧草稿必须一起重置） */}
            <div className="space-y-2" key={hub.challengeId}>
              <div className="flex items-center gap-2">
                <p className="text-sm font-extrabold text-slate-800">
                  {stepIndex === REPORT_STEP ? '学习报告' : `第 ${currentStep.step} 步 · ${currentStep.title}`}
                </p>
                {stepIndex !== REPORT_STEP && (
                  <span className="text-[11px] font-bold text-slate-400">{currentStep.cn}</span>
                )}
                {stepIndex !== REPORT_STEP && report && (
                  <button onClick={() => setStepIndex(REPORT_STEP)} className="ml-auto text-[11px] font-bold text-emerald-600 hover:text-emerald-800 cursor-pointer">
                    看报告
                  </button>
                )}
              </div>
              {renderStage()}
            </div>
          </>
        )}
      </div>

      {/* 历史抽屉 */}
      {historyOpen && (
        <div className="fixed inset-0 z-40 bg-slate-900/30 flex items-end md:items-center justify-center" onClick={() => setHistoryOpen(false)}>
          <div className="w-full md:max-w-md bg-white rounded-t-2xl md:rounded-2xl px-4 py-4 space-y-2 max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-slate-500" />
              <p className="text-sm font-extrabold text-slate-800">历史挑战</p>
              <button onClick={() => setHistoryOpen(false)} className="ml-auto text-slate-400 hover:text-slate-600 cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>
            {(hub?.history || []).length === 0 && <p className="text-xs text-slate-500">还没有历史挑战。</p>}
            <ul className="space-y-1.5">
              {(hub?.history || []).map((h) => (
                <li key={h.challengeId}>
                  <button
                    onClick={() => openVariant(h.variant)}
                    className={`w-full text-left rounded-xl border px-3 py-2 cursor-pointer hover:border-indigo-200 ${h.variant === hub?.variant ? 'border-indigo-200 bg-indigo-50/50' : 'border-slate-100'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-extrabold text-slate-700">第 {h.variant} 套</span>
                      <span className={`text-[10px] font-extrabold rounded-full px-2 py-0.5 ${h.status === 'completed' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                        {h.status === 'completed' ? '已完成' : '未完成'}
                      </span>
                      {h.score != null && <span className="ml-auto text-xs font-black text-indigo-600 tabular-nums">{h.score}</span>}
                    </div>
                    <p className="text-[11px] font-bold text-slate-400 mt-0.5">
                      {h.createdAt ? String(h.createdAt).replace('T', ' ').slice(0, 16) : ''}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
