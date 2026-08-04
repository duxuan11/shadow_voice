import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { parseResult } from '../utils/aliyunResult'
import { Mic, Square, Loader2, Volume2, ChevronDown } from 'lucide-react'

// engine.js 动态加载（模块级单例，多个挂载点共享一次加载）
let engineScriptPromise = null
function loadEngineJs() {
  if (window.EngineEvaluat) return Promise.resolve()
  if (engineScriptPromise) return engineScriptPromise
  engineScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/sdk/engine.js'
    s.onload = () => {
      if (window.EngineEvaluat) { resolve(); return }
      // 失败后重置单例，让 retry 可以重新尝试加载
      engineScriptPromise = null
      reject(new Error('engine.js 已加载但未找到 window.EngineEvaluat'))
    }
    s.onerror = () => {
      engineScriptPromise = null
      reject(new Error('无法加载 /sdk/engine.js，请确认 public/sdk/engine.js 已放置'))
    }
    document.head.appendChild(s)
  })
  return engineScriptPromise
}

const SPEED_LABEL = { 0: '偏慢', 1: '正常', 2: '偏快' }
const TIP_MESSAGES = {
  10004: '音量偏低，可能离麦克风太远，建议靠近一些重试',
  10005: '音频截幅（音量过高），建议离麦克风远一些重试',
  10006: '音频信噪比低（环境嘈杂），建议在安静环境重试',
  10008: '音频模拟信号截幅，建议调整麦克风音量重试',
}
const MAX_RECORD_MS = 30 * 1000

function wordColor(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 85) return 'text-emerald-600 bg-emerald-50'
  if (score >= 75) return 'text-amber-600 bg-amber-50'
  if (score >= 55) return 'text-slate-500 bg-slate-100'
  return 'text-rose-600 bg-rose-50 underline decoration-wavy'
}

export default function ShadowingEvaluator({ refText }) {
  const { authFetch, user } = useAuth()
  const [phase, setPhase] = useState('ready') // ready | recording | evaluating | result | error
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [volume, setVolume] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [expandedWord, setExpandedWord] = useState(null)

  const engineRef = useRef(null)
  const initRef = useRef({ done: false, resolvers: [] })
  const warrantRef = useRef(null)
  const timerRef = useRef(null)
  const secondsRef = useRef(null)
  const mountedRef = useRef(true)

  const setPhaseSafe = useCallback((p) => setPhase(p), [])

  // ── 清理秒表与自动停止定时器（幂等，可重复调用）──
  const clearTimers = useCallback(() => {
    clearTimeout(timerRef.current)
    clearInterval(secondsRef.current)
    timerRef.current = null
    secondsRef.current = null
  }, [])

  // ── warrant 获取（缓存 + 过期前 60s 刷新 + 401 提示）──
  const getWarrant = useCallback(async () => {
    const w = warrantRef.current
    if (w && w.expiresAt - 60 * 1000 > Date.now()) return w
    const res = await authFetch('/aliyun/authorize', { method: 'POST' })
    if (res.status === 401) throw new Error('请先登录后使用口语评测（游客模式不支持）')
    if (!res.ok) {
      let msg = '授权服务异常'
      try { msg = (await res.json()).error || msg } catch { /* ignore */ }
      throw new Error(msg)
    }
    const data = await res.json()
    warrantRef.current = data
    return data
  }, [authFetch])

  // ── engine 实例（懒创建，等 engineFirstInitDone；用 initRef.done 避免二次评测死等）──
  const ensureEngine = useCallback(() => {
    if (engineRef.current) return engineRef.current
    const engine = new window.EngineEvaluat({
      applicationId: warrantRef.current.applicationId,
      userId: String(user.id),
      warrantId: warrantRef.current.warrantId,
      micAllowCallback: () => { /* 授权成功无需处理 */ },
      micForbidCallback: () => { clearTimers(); setPhaseSafe('error'); setError('麦克风权限被拒绝，请在浏览器设置中允许麦克风访问') },
      micVolumeCallback: (v) => setVolume(typeof v === 'number' ? v : 0),
      engineFirstInitDone: () => {
        initRef.current.done = true
        initRef.current.resolvers.forEach((fn) => fn())
        initRef.current.resolvers = []
      },
      engineBackResultDone: (msg) => {
        try {
          clearTimers()
          setResult(parseResult(msg))
          setPhaseSafe('result')
        } catch {
          setPhaseSafe('error'); setError('评测结果解析失败，请重试')
        }
      },
      engineBackResultFail: (msg) => {
        clearTimers()
        setPhaseSafe('error')
        setError(`评测失败：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
      },
      JSSDKNotSupport: () => { clearTimers(); setPhaseSafe('error'); setError('当前浏览器不支持评测 SDK，请使用 Chrome / Edge / Firefox') },
      noNetwork: () => { clearTimers(); setPhaseSafe('error'); setError('网络不可用，评测需要联网') },
    })
    engineRef.current = engine
    return engine
  }, [user, setPhaseSafe, clearTimers])

  const waitInit = useCallback(() => {
    if (initRef.current.done) return Promise.resolve()
    return new Promise((resolve) => {
      initRef.current.resolvers.push(resolve)
    })
  }, [])

  // ── 开始评测 ──
  const start = useCallback(async () => {
    setError(null)
    setResult(null)
    setExpandedWord(null)
    try {
      await loadEngineJs()
      if (!mountedRef.current) return
      await getWarrant()
      if (!mountedRef.current) return
      const engine = ensureEngine()
      await waitInit()
      if (!mountedRef.current) return
      engine.startRecord({
        coreType: 'en.sent.score',
        refText,
        warrantId: warrantRef.current.warrantId,
        rank: 100,
        precision: 1,
        auto_rhythm: 1,      // 连读检测（关键开关）
        outputPhones: 1,     // 音素级得分
        phdet: 1,            // 音素检错
        attachAudioUrl: 1,   // 返回录音地址供回放
      })
      setPhaseSafe('recording')
      setSeconds(0)
      secondsRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
      timerRef.current = setTimeout(() => { if (engineRef.current) { engineRef.current.stopRecord(); setPhaseSafe('evaluating') } }, MAX_RECORD_MS)
    } catch (e) {
      clearTimers()
      setPhaseSafe('error')
      setError(e.message || '启动评测失败')
    }
  }, [clearTimers, getWarrant, ensureEngine, waitInit, refText, setPhaseSafe])

  // ── 停止评测 ──
  const stop = useCallback(() => {
    clearTimers()
    if (engineRef.current) engineRef.current.stopRecord()
    setPhaseSafe('evaluating')
  }, [clearTimers, setPhaseSafe])

  // ── 重试 ──
  const retry = useCallback(() => {
    clearTimers()
    setPhase('ready')
    setError(null)
    setResult(null)
    setVolume(0)
  }, [clearTimers])

  // ── 卸载清理 ──
  useEffect(() => {
    // StrictMode 下同一实例会 mount → 模拟 unmount → remount，ref 保留；
    // 每次 effect 运行时重新武装，避免 mountedRef 永远为 false 导致 start() 静默失效
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(timerRef.current)
      clearInterval(secondsRef.current)
      if (engineRef.current) {
        // cancelRecord：取消录音且不返回结果，避免卸载后仍触发回调
        try { engineRef.current.cancelRecord() } catch { try { engineRef.current.stopRecord() } catch { /* ignore */ } }
        engineRef.current = null
      }
    }
  }, [])

  // ── 渲染 ──
  if (!refText) {
    return <div className="text-center py-8 text-xs text-slate-400 italic">请选择具体句子以开始评测</div>
  }

  return (
    <div className="flex flex-col items-center">
      {phase === 'error' && (
        <div className="w-full text-center py-4 space-y-2">
          <p className="text-xs font-semibold text-rose-600">{error}</p>
          <button onClick={retry} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer">重试</button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="flex flex-col items-center space-y-3">
          <button onClick={start} className="h-12 w-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md transition-all cursor-pointer hover:scale-105 active:scale-95">
            <Mic className="h-5 w-5" />
          </button>
          <span className="text-[11px] font-bold text-slate-500">点击麦克风，朗读这句英文</span>
        </div>
      )}

      {phase === 'recording' && (
        <div className="flex flex-col items-center space-y-4">
          <div className="flex items-end justify-center space-x-1 h-8 px-8">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} style={{ height: `${Math.max(6, Math.min(32, 6 + (volume * (0.5 + (i % 3) * 0.2))))}px` }} className="w-1 bg-indigo-500 rounded-full animate-pulse transition-all duration-100" />
            ))}
          </div>
          <span className="text-xs font-semibold text-slate-400">正在录音... {seconds}s</span>
          <button onClick={stop} className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer transition-all">
            <Square className="inline h-3.5 w-3.5 mr-1" />结束录音并评测
          </button>
        </div>
      )}

      {phase === 'evaluating' && (
        <div className="flex flex-col items-center space-y-3 py-4">
          <Loader2 className="h-6 w-6 text-indigo-500 animate-spin" />
          <span className="text-xs font-semibold text-slate-400">评测中...</span>
        </div>
      )}

      {phase === 'result' && result && (
        <div className="w-full space-y-3 animate-fade-in">
          {result.tipId > 0 && TIP_MESSAGES[result.tipId] && (
            <p className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              ⚠ {TIP_MESSAGES[result.tipId]}
            </p>
          )}

          {/* 总分 + 五维条 */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">评测得分</span>
            <span className="text-sm font-extrabold text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full font-mono">
              {result.overall != null ? `${Math.round(result.overall)}分` : '—'}
            </span>
          </div>
          <div className="space-y-1.5">
            {[
              ['准确度', result.accuracy],
              ['流利度', result.fluency.overall],
              ['完整度', result.integrity],
              ['韵律', result.rhythm.overall],
              ['连读', result.liaison.expected > 0 ? (result.liaison.ok / result.liaison.expected) * 100 : null],
            ].map(([label, val]) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-10 text-[10px] font-semibold text-slate-400 shrink-0">{label}</span>
                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  {val != null && <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.max(0, Math.min(100, val))}%` }} />}
                </div>
                <span className="w-8 text-right text-[10px] font-mono text-slate-500">{val != null ? Math.round(val) : '—'}</span>
              </div>
            ))}
          </div>

          {/* 逐词着色 + 徽章 */}
          <div className="bg-white border border-slate-100 p-3 rounded-xl flex flex-wrap gap-1.5 text-xs font-bold leading-relaxed">
            {result.words.map((w, i) => (
              <span key={i} className="relative inline-block">
                <button onClick={() => setExpandedWord(expandedWord === i ? null : i)} className={`px-1 rounded cursor-pointer ${wordColor(w.score)}`}>
                  {w.char}
                </button>
                {w.liaison.ref === 1 && (
                  <span className={`ml-0.5 align-top text-[8px] font-bold px-1 rounded ${w.liaison.score === 1 ? 'text-emerald-600 bg-emerald-100' : 'text-rose-600 bg-rose-100'}`} title={w.liaison.score === 1 ? '连读到位' : '此处应连读'}>
                    {w.liaison.score === 1 ? '连读✓' : '连读✗'}
                  </span>
                )}
                {w.stress.ref !== w.stress.score && (
                  <span className="ml-0.5 align-top text-[8px] font-bold text-amber-600 bg-amber-100 rounded px-1" title="重音与预期不一致">重音</span>
                )}
                {w.tone.ref !== w.tone.score && (
                  <span className="ml-0.5 align-top text-[8px] font-bold text-indigo-600 bg-indigo-100 rounded px-1" title="升降调与预期不一致">升降调</span>
                )}
                {w.sense.ref === 1 && w.sense.score === 0 && (
                  <span className="ml-0.5 align-top text-[8px] font-bold text-sky-600 bg-sky-100 rounded px-1" title="此处应有意群停顿">意群停顿</span>
                )}
                {w.dpType === 1 && <span className="ml-0.5 align-top text-[8px] font-bold text-rose-600 bg-rose-100 rounded px-1">漏读</span>}
                {w.dpType === 2 && <span className="ml-0.5 align-top text-[8px] font-bold text-amber-600 bg-amber-100 rounded px-1">重复</span>}
                {w.isPause && <span className="ml-0.5 align-top text-[8px] font-bold text-slate-500 bg-slate-100 rounded px-1">⏸停顿</span>}
                {w.fakePron && <span className="ml-0.5 align-top text-[8px] font-bold text-slate-400 bg-slate-100 rounded px-1">未收录</span>}
                {w.phones.length > 0 && (
                  <ChevronDown className="inline h-2.5 w-2.5 text-slate-400" />
                )}
                {/* 音素明细 */}
                {expandedWord === i && (
                  <span className="absolute left-0 top-full z-10 mt-1 block w-48 bg-white border border-slate-200 rounded-lg shadow-lg p-2 space-y-0.5 text-left">
                    {w.phones.map((p, pi) => (
                      <span key={pi} className="block text-[10px] font-mono">
                        <span className={p.pherr === 1 ? 'text-rose-600 font-extrabold underline decoration-wavy' : 'text-emerald-600'}>
                          {p.ph2alpha || p.char}
                        </span>
                        <span className="text-slate-400"> /{p.char}/ </span>
                        <span className="text-slate-500">{p.score != null ? Math.round(p.score) : '—'}{p.pherr === 1 ? ' 发错' : ''}</span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
            ))}
          </div>

          {/* 动态小结 + 流利度统计 */}
          <div className="text-[10px] font-medium text-slate-500 space-y-0.5">
            {result.liaison.expected > 0 && (
              <p className={result.liaison.ok === result.liaison.expected ? 'text-emerald-600' : 'text-amber-600'}>
                连读 {result.liaison.ok}/{result.liaison.expected} 处到位{result.liaison.ok < result.liaison.expected ? '，注意标 ✗ 的词要连起来读' : ''}
              </p>
            )}
            {result.fluency.pause != null && (
              <p>本句停顿 {result.fluency.pause} 次{result.fluency.speed != null ? `，语速${SPEED_LABEL[result.fluency.speed] || ''}` : ''}</p>
            )}
            {result.overall != null && (
              <p className="text-indigo-500">{result.overall >= 85 ? '整体很棒，继续保持！' : result.overall >= 70 ? '读得不错，按上面提示再练一遍会更好' : '还有提升空间，对照原声多跟读几遍'}</p>
            )}
          </div>

          {/* 录音回放（云端保留 1 个月） */}
          {result.audioUrl && (
            <div className="flex items-center gap-2">
              <Volume2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              <audio controls src={result.audioUrl} className="w-full h-8" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
