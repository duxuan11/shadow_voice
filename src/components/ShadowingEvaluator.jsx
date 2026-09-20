import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { parseResult } from '../utils/aliyunResult'
import { buildEngineSdkUrl, analyzeEngineSdkBody, micEnvironmentProblem, jssdkNotSupportMessage } from '../utils/engineSdk'
import { Mic, Square, Loader2, Volume2, ChevronDown } from 'lucide-react'

// engine.js 动态加载（模块级单例，多个挂载点共享一次加载）
let engineScriptPromise = null

// 兜底诊断：脚本触发 load 但全局未定义时，抓取同 URL 内容定位原因。
// 典型场景：生产 dist 构建于 SDK 放置之前，SPA 兜底把 index.html 当作 engine.js 返回，
// 脚本元素仍会触发 load 事件（实测验证），但 window.EngineEvaluat 未定义。
async function diagnoseEngineSdk(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      return `engine.js 请求失败（HTTP ${res.status}），请确认 public/sdk/engine.js 已放置并重新构建前端`
    }
    const text = await res.text()
    const analysis = analyzeEngineSdkBody(text)
    if (!analysis.ok) return analysis.message
    return 'engine.js 已加载但未找到 window.EngineEvaluat（脚本执行异常，请用阿里云控制台最新版 SDK 替换）'
  } catch {
    return 'engine.js 加载失败（网络错误），请检查网络后重试'
  }
}

function loadEngineJs() {
  if (window.EngineEvaluat) return Promise.resolve()
  if (engineScriptPromise) return engineScriptPromise
  const url = buildEngineSdkUrl()
  engineScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = url
    s.onload = () => {
      if (window.EngineEvaluat) { resolve(); return }
      // 失败后重置单例，让 retry 可以重新尝试加载
      engineScriptPromise = null
      diagnoseEngineSdk(url).then((msg) => reject(new Error(msg)))
    }
    s.onerror = () => {
      engineScriptPromise = null
      reject(new Error(`无法加载 ${url}（网络错误或文件不存在），请确认 public/sdk/engine.js 已放置并重新构建前端`))
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
// micForbidCallback 拒绝 mic 就绪 promise 时使用的哨兵错误，用于区分
//「麦克风权限被拒绝」（micForbidCallback 已展示错误 UI）与其他启动失败
const MIC_FORBIDDEN_SENTINEL = 'MIC_FORBIDDEN'
// JSSDKNotSupport 回调拒绝 mic 就绪 promise 时使用的哨兵：
// 浏览器环境不支持（如明文 HTTP 下 engine.js checkSuport 失败）时，SDK 既不会调
// micAllowCallback 也不会调 micForbidCallback，不 reject 的话 start() 会永远卡在
// await micReady（重试后停留在"正在获取麦克风权限"）。该回调已展示错误 UI。
const JSSDK_NOT_SUPPORT_SENTINEL = 'JSSDK_NOT_SUPPORT'

function wordColor(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 85) return 'text-emerald-600 bg-emerald-50'
  if (score >= 75) return 'text-amber-600 bg-amber-50'
  if (score >= 55) return 'text-slate-500 bg-slate-100'
  return 'text-rose-600 bg-rose-50 underline decoration-wavy'
}

export default function ShadowingEvaluator({ refText, onPracticed }) {
  const { authFetch, user } = useAuth()
  const [phase, setPhase] = useState('ready') // ready | recording | evaluating | result | error
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [volume, setVolume] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [expandedWord, setExpandedWord] = useState(null)
  const [micWaiting, setMicWaiting] = useState(false)

  const engineRef = useRef(null)
  const initRef = useRef({ done: false, resolvers: [] })
  // { promise, resolve, reject }：engine 初始化时 getUserMedia 的 stream 就绪信号。
  // engine.js 的 engineFirstInitDone 先于 getUserMedia 完成触发，移动端慢速授权时
  // 直接 startRecord 会 createMediaStreamSource(null) 报类型错误，必须等它。
  const micReadyRef = useRef(null)
  const warrantRef = useRef(null)
  const timerRef = useRef(null)
  const secondsRef = useRef(null)
  const mountedRef = useRef(true)
  const busyRef = useRef(false)

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
    // 新引擎：初始化状态与 mic 就绪信号复位（权限被拒后丢弃引擎重试时，
    // 不能沿用旧引擎的 init.done / 已拒绝的 promise）
    initRef.current = { done: false, resolvers: [] }
    const micReady = {}
    micReady.promise = new Promise((resolve, reject) => { micReady.resolve = resolve; micReady.reject = reject })
    micReadyRef.current = micReady
    const engine = new window.EngineEvaluat({
      applicationId: warrantRef.current.applicationId,
      userId: String(user.id),
      warrantId: warrantRef.current.warrantId,
      // engine.js 保证 getUserMedia 成功后先赋值 e._audio.stream 再回调 micAllowCallback，
      // 因此以它为 stream 就绪信号，startRecord 前 await（闭包捕获本引擎的 micReady，
      // 避免旧引擎的迟到回调误触发新引擎的信号）
      micAllowCallback: () => { micReady.resolve() },
      micForbidCallback: () => {
        clearTimers()
        setMicWaiting(false)
        setPhaseSafe('error')
        setError('麦克风权限被拒绝，请在浏览器设置中允许麦克风访问')
        micReady.reject(new Error(MIC_FORBIDDEN_SENTINEL))
      },
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
      JSSDKNotSupport: () => {
        clearTimers()
        setMicWaiting(false)
        setPhaseSafe('error')
        setError(jssdkNotSupportMessage())
        // 拒绝 mic 就绪信号：明文 HTTP 等不支持环境下 SDK 不会回调 micAllow/micForbid，
        // 不 reject 会让 start() 的 await micReady 永远挂起（重试后卡在"正在获取麦克风权限"）
        micReadyRef.current?.reject(new Error(JSSDK_NOT_SUPPORT_SENTINEL))
        // 丢弃该引擎：环境问题重试时重新走完整流程（再次 checkSuport，同样报环境错误）
        engineRef.current = null
      },
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
    if (busyRef.current || !mountedRef.current) return
    busyRef.current = true
    setError(null)
    setResult(null)
    setExpandedWord(null)
    try {
      // 环境预检：明文 HTTP（非 localhost）下手机浏览器无 getUserMedia，
      // 阿里云 engine.js 会误报"浏览器不支持"。提前给出可操作的 HTTPS 提示，
      // 避免加载 SDK/申请权限后才失败。
      const envProblem = micEnvironmentProblem()
      if (envProblem) throw new Error(envProblem.message)
      await loadEngineJs()
      if (!mountedRef.current) { busyRef.current = false; return }
      await getWarrant()
      if (!mountedRef.current) { busyRef.current = false; return }
      const engine = ensureEngine()
      await waitInit()
      if (!mountedRef.current) { busyRef.current = false; return }
      // 等待 getUserMedia 就绪后再 startRecord（见 micReadyRef 注释）；等待期间给用户提示
      setMicWaiting(true)
      await micReadyRef.current.promise
      if (!mountedRef.current) { busyRef.current = false; return }
      setMicWaiting(false)
      // 先置 recording UI 与定时器，再调 startRecord：
      // 避免 SDK 在 startRecord 内同步触发失败回调/抛错时，后面的 setPhaseSafe('recording') 覆盖错误态
      setPhaseSafe('recording')
      setSeconds(0)
      secondsRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
      timerRef.current = setTimeout(() => { if (engineRef.current) { engineRef.current.stopRecord(); setPhaseSafe('evaluating') } onPracticed?.() }, MAX_RECORD_MS)
      busyRef.current = false
      try {
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
      } catch (e) {
        busyRef.current = false
        clearTimers()
        setPhaseSafe('error')
        setError(e.message || '启动录音失败')
      }
    } catch (e) {
      busyRef.current = false
      clearTimers()
      setMicWaiting(false)
      if (e?.message === MIC_FORBIDDEN_SENTINEL || e?.message === JSSDK_NOT_SUPPORT_SENTINEL) {
        // micForbidCallback / JSSDKNotSupport 已展示错误 UI；丢弃该引擎，重试时重新发起 getUserMedia
        engineRef.current = null
        return
      }
      setPhaseSafe('error')
      setError(e.message || '启动评测失败')
    }
  }, [clearTimers, getWarrant, ensureEngine, waitInit, refText, setPhaseSafe, onPracticed])

  // ── 停止评测 ──
  const stop = useCallback(() => {
    clearTimers()
    if (engineRef.current) engineRef.current.stopRecord()
    setPhaseSafe('evaluating')
    onPracticed?.()
  }, [clearTimers, setPhaseSafe, onPracticed])

  // ── 重试 ──
  const retry = useCallback(() => {
    busyRef.current = false
    clearTimers()
    setMicWaiting(false)
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
      busyRef.current = false
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
          {micWaiting ? (
            <>
              <Loader2 className="h-6 w-6 text-indigo-500 animate-spin" />
              <span className="text-[11px] font-bold text-slate-400">正在获取麦克风权限...</span>
            </>
          ) : (
            <>
              <button onClick={start} className="h-12 w-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md transition-all cursor-pointer hover:scale-105 active:scale-95">
                <Mic className="h-5 w-5" />
              </button>
              <span className="text-[11px] font-bold text-slate-500">点击麦克风，朗读这句英文</span>
            </>
          )}
        </div>
      )}

      {phase === 'recording' && (
        <div className="flex flex-col items-center space-y-4">
          <div className="flex items-end justify-center space-x-1 h-8 px-8">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
              // micVolumeCallback 量程未公开，按 0-100 假设归一化；联调时若条不动，校准下面的 100
              const v = Math.min(1, Math.max(0, (typeof volume === 'number' ? volume : 0) / 100))
              return (
                <div key={i} style={{ height: `${Math.max(6, Math.min(32, Math.round(6 + v * 26 * (0.6 + (i % 3) * 0.2))))}px` }} className="w-1 bg-indigo-500 rounded-full animate-pulse transition-all duration-100" />
              )
            })}
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
