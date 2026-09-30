import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Headphones, Eye, Send, ChevronRight, ChevronLeft, RotateCcw, Trash2, HelpCircle, X, Volume2,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import { createSpeaker } from '../utils/tts'
import { normalizeVocabKey } from '../utils/vocabulary'
import SpellSlots from '../components/SpellSlots'
import { splitToSlots, compareSlots, joinSlots, slotsAllCorrect } from '../utils/spellSlots'
import {
  PRACTICE_TYPE_FILTERS,
  PRACTICE_TYPE_LABELS,
  buildPracticeQueue,
  summarizePracticeByType,
} from '../utils/vocabPractice'
import { resolveShortcut, SHORTCUT_GROUPS } from '../utils/vocabShortcuts'

export default function VocabPracticePage() {
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()
  const [searchParams] = useSearchParams()

  const [vocabulary, setVocabulary] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [selectedType, setSelectedType] = useState(() => {
    const t = searchParams.get('type')
    return ['all', 'word', 'phrase', 'core_phrase'].includes(t) ? t : 'all'
  })
  const [phase, setPhase] = useState('setup') // setup | practice | finished
  const [queue, setQueue] = useState([])
  const [index, setIndex] = useState(0)
  const [slotValues, setSlotValues] = useState([])
  const [result, setResult] = useState(null) // { statuses, correct }
  const [revealed, setRevealed] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [round, setRound] = useState({ attempted: 0, correct: 0 })
  const [combo, setCombo] = useState({ count: 0, max: 0 })
  const [comboVisible, setComboVisible] = useState(false)
  const [comboText, setComboText] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  const attemptedRef = useRef(new Set())
  const historyRef = useRef(new Map())
  const comboRef = useRef(0)
  const comboHideRef = useRef(null)
  const speaker = useMemo(() => createSpeaker(authFetch), [authFetch])

  const current = queue[index] || null
  const currentKey = current ? (current.word || normalizeVocabKey(current.content)) : ''
  const expectedWords = useMemo(() => splitToSlots(current?.content || ''), [current])
  const deepWord = searchParams.get('word') || ''
  // 页面 phase → resolveShortcut 的快捷键阶段（practice 下再分答题/对照）
  const shortcutPhase = phase === 'practice'
    ? ((result || revealed) ? 'review' : 'typing')
    : phase

  // 加载生词本；若带 ?word= 深链，加载完成后直接单条成轮
  useEffect(() => {
    if (isGuest) return
    authFetch('/vocab')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('unauthorized'))))
      .then(data => {
        const list = data.vocabulary || []
        setVocabulary(list)
        if (deepWord) {
          const items = buildPracticeQueue(list, { word: deepWord })
          if (items.length > 0) startRound(items)
        }
      })
      .catch(() => setLoadError('加载生词本失败'))
      .finally(() => setLoading(false))
  }, [authFetch, isGuest, deepWord])

  // 离开页面停止 TTS
  useEffect(() => () => speaker.stop(), [speaker])

  function startRound(items) {
    if (!items || items.length === 0) return
    attemptedRef.current = new Set()
    historyRef.current = new Map()
    comboRef.current = 0
    setCombo({ count: 0, max: 0 })
    setComboVisible(false)
    setQueue(items)
    setIndex(0)
    setSlotValues([])
    setResult(null)
    setRevealed(false)
    setRound({ attempted: 0, correct: 0 })
    setPhase('practice')
  }

  function startByType(type) {
    setSelectedType(type)
    startRound(buildPracticeQueue(vocabulary, { type }))
  }

  function snapshotCurrent() {
    if (!current) return
    historyRef.current.set(currentKey, { slotValues, result, revealed })
  }

  function restoreFor(entry) {
    const key = entry ? (entry.word || normalizeVocabKey(entry.content)) : ''
    const snap = key ? historyRef.current.get(key) : null
    setSlotValues(snap?.slotValues ?? [])
    setResult(snap?.result ?? null)
    setRevealed(snap?.revealed ?? false)
  }

  function goto(newIndex) {
    snapshotCurrent()
    setSpeaking(false)
    setIndex(newIndex)
    restoreFor(queue[newIndex] || null)
  }

  function replay() {
    if (!current) return
    setSpeaking(true)
    speaker.speak(current.content, { onEnd: () => setSpeaking(false) })
  }
  function revealAnswer() { setRevealed(true) }
  function goBack() { navigate('/profile') }

  function showCombo(n) {
    setComboText(n)
    setComboVisible(true)
    if (comboHideRef.current) clearTimeout(comboHideRef.current)
    comboHideRef.current = setTimeout(() => setComboVisible(false), 1000)
  }

  // 出题自动播放 TTS
  useEffect(() => {
    if (phase !== 'practice' || !current) return
    speaker.speak(current.content)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, index, queue])

  // 全局快捷键：单一入口，交给纯函数 resolveShortcut 决定动作
  useEffect(() => {
    const handler = (e) => {
      const el = document.activeElement
      const tag = el?.tagName
      const isButton = !!el && typeof el.closest === 'function' && !!el.closest('button')
      // 按钮聚焦时把 Enter/Space 交回按钮原生激活，避免顶掉点击
      if (isButton && (e.key === 'Enter' || e.key === ' ')) return
      const inputFocused = !isButton && !!el && (tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable)
      const action = resolveShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        phase: shortcutPhase,
        helpOpen,
        inputFocused,
      })
      if (!action) return
      e.preventDefault()
      if (action === 'start' || action === 'again') startByType(selectedType)
      else if (action === 'submit') submit()
      else if (action === 'replay') replay()
      else if (action === 'reveal') revealAnswer()
      else if (action === 'retry') retry()
      else if (action === 'next') next()
      else if (action === 'prev') prev()
      else if (action === 'help') setHelpOpen(true)
      else if (action === 'closeHelp') setHelpOpen(false)
      else if (action === 'back') goBack()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  useEffect(() => () => { if (comboHideRef.current) clearTimeout(comboHideRef.current) }, [])

  async function submit() {
    if (!current) return
    if (!joinSlots(slotValues)) return
    const statuses = compareSlots(slotValues, expectedWords)
    const correct = slotsAllCorrect(statuses)
    setResult({ statuses, correct })
    // 每道题仅首次提交计入统计
    if (attemptedRef.current.has(currentKey)) return
    attemptedRef.current.add(currentKey)
    setRound(prev => ({ attempted: prev.attempted + 1, correct: prev.correct + (correct ? 1 : 0) }))
    const nextCombo = correct ? comboRef.current + 1 : 0
    comboRef.current = nextCombo
    setCombo(prev => ({ count: nextCombo, max: Math.max(prev.max, nextCombo) }))
    if (correct && nextCombo >= 2) showCombo(nextCombo)
    try {
      const res = await authFetch('/vocab/practice', {
        method: 'POST',
        body: JSON.stringify({ word: current.word || currentKey, correct }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.entry) {
          setVocabulary(prev => prev.map(v =>
            ((v.word || normalizeVocabKey(v.content)) === currentKey ? { ...v, ...data.entry } : v)))
        }
      }
    } catch { /* 统计失败不阻塞练习 */ }
  }

  function retry() {
    setSlotValues(Array.from({ length: expectedWords.length }, () => ''))
    setResult(null)
    setRevealed(false)
    setRetryToken(t => t + 1)
  }

  function next() {
    if (index < queue.length - 1) {
      goto(index + 1)
    } else {
      speaker.stop()
      setPhase('finished')
    }
  }

  function prev() {
    if (index > 0) goto(index - 1)
  }

  async function removeCurrent() {
    if (!current) return
    const key = currentKey
    try { await authFetch(`/vocab/${encodeURIComponent(key)}`, { method: 'DELETE' }) } catch { /* ignore */ }
    const nextQueue = queue.filter(v => (v.word || normalizeVocabKey(v.content)) !== key)
    setVocabulary(prev => prev.filter(v => (v.word || normalizeVocabKey(v.content)) !== key))
    setSlotValues([])
    setResult(null)
    setRevealed(false)
    setSpeaking(false)
    if (nextQueue.length === 0 || index >= nextQueue.length) {
      speaker.stop()
      setQueue(nextQueue)
      setPhase('finished')
      return
    }
    setQueue(nextQueue)
    setIndex(index)
  }

  if (loading && !isGuest) {
    return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>
  }

  const summary = summarizePracticeByType(vocabulary)
  const typeCounts = { all: vocabulary.length }
  for (const f of PRACTICE_TYPE_FILTERS) if (f.id !== 'all') typeCounts[f.id] = summary[f.id].total

  const cnText = current ? (current.translation || current.context_cn || '') : ''
  const cnIsContext = current ? (!current.translation && !!current.context_cn) : false
  const typeLabel = current ? (PRACTICE_TYPE_LABELS[current.type] || '单词') : ''

  return (
    <div className="vp-page">
      <div className="vp-stage">
        <div className="vp-card">
          <div className="vp-toolbar">
            <span className="vp-type">{phase === 'practice' ? typeLabel : '生词听练'}</span>
            {phase === 'practice' && (
              <div className="vp-progress">
                <span className="vp-progress-text">{index + 1} / {queue.length}</span>
                <div className="vp-progress-bar">
                  <div className="vp-progress-fill" style={{ width: `${((index + (result || revealed ? 1 : 0)) / Math.max(1, queue.length)) * 100}%` }} />
                </div>
              </div>
            )}
          </div>

          <div className="vp-corner">
            <button type="button" className={`vp-icon-btn${speaking ? ' is-playing' : ''}`} data-tip="再听一次 (Ctrl+Space)" aria-label="再听一次" onClick={replay}><Volume2 size={18} /></button>
            <button type="button" className="vp-icon-btn" data-tip="快捷键 (?)" aria-label="快捷键帮助" onClick={() => setHelpOpen(true)}><HelpCircle size={18} /></button>
            <button type="button" className="vp-icon-btn" data-tip="退出 (Esc)" aria-label="退出" onClick={goBack}><X size={18} /></button>
          </div>

          {isGuest ? (
            <div className="vp-main"><div className="vp-empty"><p>登录后可练习生词本</p><button className="vp-btn vp-btn--primary" onClick={() => navigate('/login')}>去登录</button></div></div>
          ) : loadError ? (
            <div className="vp-main"><div className="vp-empty"><p>{loadError}</p></div></div>
          ) : phase === 'setup' ? (
            <div className="vp-main" style={{ justifyContent: 'flex-start' }}>
              {vocabulary.length === 0 ? (
                <div className="vp-empty">
                  <p>生词本还是空的</p>
                  <p>在视频的「智能重点词卡」中加入生词后即可听练</p>
                  <button className="vp-btn" onClick={() => navigate('/records')}>去生词本看看</button>
                </div>
              ) : (
                <div className="vp-setup">
                  <div className="vp-filter" role="tablist" aria-label="听练类型">
                    {PRACTICE_TYPE_FILTERS.map(f => (
                      <button key={f.id} role="tab" aria-selected={selectedType === f.id}
                        className={`vp-filter-btn${selectedType === f.id ? ' active' : ''}`}
                        onClick={() => setSelectedType(f.id)}>
                        {f.label}<span className="vp-filter-count">{typeCounts[f.id]}</span>
                      </button>
                    ))}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="vp-stats-table">
                      <thead><tr><th>类型</th><th>数量</th><th>练习次数</th><th>正确次数</th><th>熟练度</th></tr></thead>
                      <tbody>
                        {['word', 'phrase', 'core_phrase'].map(t => {
                          const s = summary[t]
                          return (
                            <tr key={t}>
                              <td>{PRACTICE_TYPE_LABELS[t]}</td>
                              <td>{s.total}</td><td>{s.practiceCount}</td><td>{s.correctCount}</td>
                              <td><span className={`prof-badge prof-${s.proficiency.level}`}>{s.proficiency.label}{s.proficiency.level !== 'new' ? ` ${s.proficiency.percent}%` : ''}</span></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button className="vp-btn vp-btn--primary" disabled={typeCounts[selectedType] === 0} onClick={() => startByType(selectedType)}>
                    <Headphones size={18} /><span>开始练习</span>
                  </button>
                </div>
              )}
            </div>
          ) : phase === 'practice' && current ? (
            <div className="vp-main">
              <p className="vp-cn">{cnText || '暂无中文释义'}{cnIsContext && <span className="vp-cn-tag">例句</span>}</p>
              {current.phonetic && <p className="vp-phonetic">{current.phonetic}</p>}
              <SpellSlots
                key={`${currentKey}:${retryToken}`}
                expectedWords={expectedWords}
                value={slotValues}
                onChange={setSlotValues}
                onSubmit={submit}
                disabled={!!result || revealed}
                statuses={result?.statuses ?? null}
                revealed={revealed && !result}
              />
              {!result && !revealed ? (
                <div className="vp-actions">
                  <button className="vp-btn vp-btn--primary" disabled={!joinSlots(slotValues)} data-tip="提交 (Enter)" onClick={submit}><Send size={16} /><span>提交</span></button>
                  <button className="vp-btn" data-tip="再听一次 (Ctrl+Space)" onClick={replay}><Volume2 size={16} /><span>再听一次</span></button>
                  <button className="vp-btn" data-tip="显示答案 (Tab)" onClick={() => setRevealed(true)}><Eye size={16} /><span>显示答案</span></button>
                </div>
              ) : (
                <div className="vp-actions">
                  <button className="vp-btn" disabled={index === 0} data-tip="上一题 (←)" onClick={prev}><ChevronLeft size={16} /><span>上一题</span></button>
                  <button className="vp-btn" data-tip="再练一次 (3)" onClick={retry}><RotateCcw size={16} /><span>再练一次</span></button>
                  <button className="vp-btn" data-tip="再听一次 (1)" onClick={replay}><Volume2 size={16} /><span>再听一次</span></button>
                  <button className="vp-btn vp-btn--danger" data-tip="移除生词本" onClick={removeCurrent}><Trash2 size={16} /><span>移除</span></button>
                  <button className="vp-btn vp-btn--primary" data-tip="下一题 (4 / Enter)" onClick={next}><span>{index < queue.length - 1 ? '下一题' : '完成'}</span><ChevronRight size={16} /></button>
                </div>
              )}
              {result && (
                <p className={`vp-verdict${result.correct ? ' is-correct' : ' is-wrong'}`} role="status">
                  {result.correct ? '✅ 完全正确' : '❌ 有出入，看槽位上的提示'}
                </p>
              )}
              {!result && !revealed && (
                <div className="vp-keyhints">
                  <span className="vp-keycap">Space</span><span className="vp-keyhint-label">下一词</span>
                  <span className="vp-keycap">Enter</span><span className="vp-keyhint-label">下一词 / 提交</span>
                  <span className="vp-keycap">Tab</span><span className="vp-keyhint-label">显示答案</span>
                </div>
              )}
            </div>
          ) : (
            <div className="vp-main">
              <div className="vp-finish">
                <div className="vp-finish-left">
                  <h2 className="vp-finish-title">本轮完成！</h2>
                  <div className="vp-stats">
                    <div className="vp-stat"><span className="vp-stat-value">{round.attempted}</span><span className="vp-stat-label">已练</span></div>
                    <div className="vp-stat"><span className="vp-stat-value">{round.correct}</span><span className="vp-stat-label">正确</span></div>
                    <div className="vp-stat"><span className="vp-stat-value">{round.attempted ? Math.round((round.correct / round.attempted) * 100) : 0}%</span><span className="vp-stat-label">正确率</span></div>
                    <div className="vp-stat"><span className="vp-stat-value">{combo.max}</span><span className="vp-stat-label">最长连击</span></div>
                  </div>
                </div>
                <div className="vp-finish-right">
                  <p className="vp-finish-feedback">{round.correct === 0 ? '继续加油，多听几遍会更好。' : round.correct === round.attempted ? '全部正确，太棒了！' : '不错，错的地方再听一遍。'}</p>
                  <p className="vp-finish-summary">本轮共 {round.attempted} 题，答对 {round.correct} 题。</p>
                  <div className="vp-finish-actions">
                    <button className="vp-cta" onClick={() => startByType(selectedType)}>再来一轮</button>
                    <button className="vp-cta vp-cta--secondary" onClick={() => navigate('/profile')}>返回个人中心</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {comboVisible && <div key={comboText} className="vp-combo" role="status">连击 x{comboText}</div>}
        </div>
      </div>

      {helpOpen && (
        <div className="vp-help-mask" onClick={() => setHelpOpen(false)}>
          <div className="vp-help" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <div className="vp-help-head">
              <h2>键盘快捷键</h2>
              <button type="button" className="vp-icon-btn" onClick={() => setHelpOpen(false)} aria-label="关闭"><X size={18} /></button>
            </div>
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.title} className="vp-help-group">
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map((item, i) => (
                    <li key={i}>
                      <span className="vp-help-keys">{item.keys.map((k, j) => <span key={j} className="vp-keycap">{k}</span>)}</span>
                      <span className="vp-help-label">{item.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
