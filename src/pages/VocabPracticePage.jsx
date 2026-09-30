import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Headphones, Eye, EyeOff, Send, ChevronRight, ChevronLeft, RotateCcw, Trash2, RefreshCw, HelpCircle, X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { createSpeaker } from '../utils/tts'
import { checkSpelling, isAllCorrect } from '../utils/spellCheck'
import { normalizeVocabKey } from '../utils/vocabulary'
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
  const [userInput, setUserInput] = useState('')
  const [result, setResult] = useState(null) // { results, correct }
  const [revealed, setRevealed] = useState(false)
  const [showChinese, setShowChinese] = useState(false)
  const [round, setRound] = useState({ attempted: 0, correct: 0 })
  const [combo, setCombo] = useState({ count: 0, max: 0 })
  const [comboVisible, setComboVisible] = useState(false)
  const [comboText, setComboText] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)

  const attemptedRef = useRef(new Set())
  const inputRef = useRef(null)
  const historyRef = useRef(new Map())
  const comboRef = useRef(0)
  const comboHideRef = useRef(null)
  const speaker = useMemo(() => createSpeaker(authFetch), [authFetch])

  const current = queue[index] || null
  const currentKey = current ? (current.word || normalizeVocabKey(current.content)) : ''
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
    setUserInput('')
    setResult(null)
    setRevealed(false)
    setShowChinese(false)
    setRound({ attempted: 0, correct: 0 })
    setPhase('practice')
  }

  function startByType(type) {
    setSelectedType(type)
    startRound(buildPracticeQueue(vocabulary, { type }))
  }

  function snapshotCurrent() {
    if (!current) return
    historyRef.current.set(currentKey, { userInput, result, revealed })
  }

  function restoreFor(entry) {
    const key = entry ? (entry.word || normalizeVocabKey(entry.content)) : ''
    const snap = key ? historyRef.current.get(key) : null
    setUserInput(snap?.userInput ?? '')
    setResult(snap?.result ?? null)
    setRevealed(snap?.revealed ?? false)
  }

  function goto(newIndex) {
    snapshotCurrent()
    setIndex(newIndex)
    restoreFor(queue[newIndex] || null)
  }

  function replay() { if (current) speaker.speak(current.content) }
  function toggleChinese() { setShowChinese(v => !v) }
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

  // 出题自动聚焦
  useEffect(() => {
    if (phase === 'practice' && !result && !revealed && inputRef.current) inputRef.current.focus()
  }, [phase, index, result, revealed])

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
        revealed,
        hasResult: !!result,
        helpOpen,
        inputFocused,
      })
      if (!action) return
      e.preventDefault()
      if (action === 'start' || action === 'again') startByType(selectedType)
      else if (action === 'submit') submit()
      else if (action === 'replay') replay()
      else if (action === 'toggleChinese') toggleChinese()
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
    const trimmed = userInput.trim()
    if (!trimmed) return
    const results = checkSpelling(trimmed, current.content)
    const correct = isAllCorrect(results)
    setResult({ results, correct })
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
    setUserInput('')
    setResult(null)
    setRevealed(false)
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
    setUserInput('')
    setResult(null)
    setRevealed(false)
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

  return (
    <div className="dictation-page vocab-practice-page">
      <div className="dictation-header">
        <button onClick={() => navigate('/profile')} className="back-btn">
          <ArrowLeft size={20} />
          <span>返回</span>
        </button>
        <div className="dictation-header-center">
          <h1 className="dictation-title">生词听练</h1>
        </div>
        <div className="dictation-header-actions">
          <button
            type="button"
            className="vocab-icon-btn"
            onClick={() => setHelpOpen(true)}
            data-tip="快捷键 (?)"
            aria-label="快捷键帮助"
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </div>

      {isGuest ? (
        <div className="empty-state">
          <p>登录后可练习生词本</p>
          <button onClick={() => navigate('/login')}>去登录</button>
        </div>
      ) : loadError ? (
        <div className="empty-state"><p>{loadError}</p></div>
      ) : phase === 'setup' ? (
        <div className="vocab-practice-setup">
          {vocabulary.length === 0 ? (
            <div className="empty-state">
              <p>生词本还是空的</p>
              <span className="empty-hint">在视频的「智能重点词卡」中加入生词后即可听练</span>
              <button onClick={() => navigate('/records')}>去生词本看看</button>
            </div>
          ) : (
            <>
              <div className="vocab-filter" role="tablist" aria-label="听练类型">
                {PRACTICE_TYPE_FILTERS.map(f => (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={selectedType === f.id}
                    className={`vocab-filter-btn ${selectedType === f.id ? 'active' : ''}`}
                    onClick={() => setSelectedType(f.id)}
                  >
                    {f.label}
                    <span className="vocab-filter-count">{typeCounts[f.id]}</span>
                  </button>
                ))}
              </div>

              <div className="vocab-practice-stats-wrap">
                <table className="vocab-practice-stats">
                  <thead>
                    <tr>
                      <th>类型</th><th>数量</th><th>练习次数</th><th>正确次数</th><th>熟练度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {['word', 'phrase', 'core_phrase'].map(t => {
                      const s = summary[t]
                      return (
                        <tr key={t}>
                          <td>{PRACTICE_TYPE_LABELS[t]}</td>
                          <td className="num">{s.total}</td>
                          <td className="num">{s.practiceCount}</td>
                          <td className="num">{s.correctCount}</td>
                          <td>
                            <span className={`prof-badge prof-${s.proficiency.level}`}>
                              {s.proficiency.label}{s.proficiency.level !== 'new' ? ` ${s.proficiency.percent}%` : ''}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <button
                onClick={() => startByType(selectedType)}
                disabled={typeCounts[selectedType] === 0}
                className="dictation-action-btn submit-btn vocab-practice-start"
              >
                <Headphones size={18} />
                <span>开始练习</span>
              </button>
            </>
          )}
        </div>
      ) : phase === 'practice' && current ? (
        <>
          <div className="dictation-progress-bar">
            <div
              className="dictation-progress-fill"
              style={{ width: `${((index + (result || revealed ? 1 : 0)) / queue.length) * 100}%` }}
            />
          </div>

          <div className="dictation-stats">
            <span className="stat-item">进度 <strong>{index + 1}</strong> / {queue.length}</span>
            <span className="stat-item stat-done">已练 <strong>{round.attempted}</strong></span>
            <span className="stat-item stat-correct">正确 <strong>{round.correct}</strong></span>
            <span className="stat-item stat-accuracy">
              正确率 <strong>{round.attempted ? Math.round((round.correct / round.attempted) * 100) : 0}%</strong>
            </span>
          </div>

          <div key={currentKey} className="dictation-card vocab-card-anim">
            <div className="vocab-practice-meta">
              <span className={`vocab-type-badge type-${current.type || 'word'}`}>
                {PRACTICE_TYPE_LABELS[current.type] || '单词'}
              </span>
              <button
                type="button"
                className="vocab-practice-btn"
                onClick={() => setShowChinese(v => !v)}
              >
                {showChinese ? <EyeOff size={14} /> : <Eye size={14} />}
                <span>{showChinese ? '隐藏中文' : '显示中文'}</span>
              </button>
            </div>

            <div className={`dictation-hint ${showChinese ? 'visible' : 'hidden'}`}>
              {showChinese ? (
                <p className="dictation-chinese">{current.translation || '暂无中文释义'}</p>
              ) : (
                <p className="dictation-chinese-placeholder">
                  <EyeOff size={14} />
                  <span>中文释义已隐藏</span>
                </p>
              )}
            </div>

            <div className="dictation-audio-bar">
              <button onClick={() => speaker.speak(current.content)} className="dictation-replay-btn">
                <Headphones size={18} />
                <span>再听一次</span>
              </button>
              {current.phonetic && <span className="dictation-time">{current.phonetic}</span>}
            </div>

            {!result && !revealed && (
              <div className="dictation-input-area">
                <textarea
                  ref={inputRef}
                  value={userInput}
                  onChange={e => setUserInput(e.target.value)}
                  className="dictation-input"
                  placeholder="输入你听到的英文…"
                  rows={2}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
                <div className="dictation-action-buttons">
                  <button
                    onClick={submit}
                    disabled={!userInput.trim()}
                    className="dictation-action-btn submit-btn"
                    data-tip="提交 (Enter)"
                  >
                    <Send size={16} />
                    <span>提交</span>
                  </button>
                  <button onClick={() => speaker.speak(current.content)} className="dictation-action-btn replay-btn" data-tip="再听一次 (Ctrl+Space)">
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={() => setRevealed(true)} className="dictation-action-btn" data-tip="显示答案 (Tab)">
                    <Eye size={16} />
                    <span>显示答案</span>
                  </button>
                </div>
                <div className="vocab-keyhints">
                  <span className="vocab-keycap">Enter</span>
                  <span className="vocab-keyhint-label">提交</span>
                  <span className="vocab-keycap">Shift</span>
                  <span className="vocab-keycap">Enter</span>
                  <span className="vocab-keyhint-label">换行</span>
                  <span className="vocab-keycap">Ctrl</span>
                  <span className="vocab-keycap">Space</span>
                  <span className="vocab-keyhint-label">重听</span>
                </div>
              </div>
            )}

            {(result || revealed) && (
              <div className="dictation-review">
                {result && (
                  <div className="spell-result">
                    {result.results.map((r, i) => {
                      if (r.type === 'correct') {
                        return <span key={i} className="spell-word spell-right">{r.word}</span>
                      }
                      if (r.type === 'wrong') {
                        return (
                          <span key={i} className="spell-word-group spell-wrong">
                            <span className="spell-user-word">{r.user}</span>
                            <span className="spell-correct-word">{r.expected}</span>
                          </span>
                        )
                      }
                      if (r.type === 'missing') {
                        return (
                          <span key={i} className="spell-word-group spell-missing">
                            <span className="spell-correct-word">{r.expected}</span>
                          </span>
                        )
                      }
                      if (r.type === 'extra') {
                        return (
                          <span key={i} className="spell-word-group spell-extra">
                            <span className="spell-user-word">{r.user}</span>
                          </span>
                        )
                      }
                      return null
                    })}
                  </div>
                )}

                <div
                  className="spell-answer vocab-hoverhint"
                  data-hint={[current.phonetic, current.translation].filter(Boolean).join(' · ') || '暂无释义'}
                >
                  <span className="answer-label">正确答案：</span>
                  <span className="answer-text">{current.content}</span>
                </div>

                {result && (
                  <p className={`vocab-practice-verdict ${result.correct ? 'is-correct' : 'is-wrong'}`}>
                    {result.correct ? '✅ 完全正确' : '❌ 有出入，看看上面标红 / 标黄的部分'}
                  </p>
                )}

                <div className="dictation-nav">
                  <button
                    onClick={prev}
                    disabled={index === 0}
                    className="dictation-action-btn"
                    data-tip="上一题 (←)"
                  >
                    <ChevronLeft size={16} />
                    <span>上一题</span>
                  </button>
                  <button onClick={retry} className="dictation-action-btn" data-tip="再练一次 (3)">
                    <RotateCcw size={16} />
                    <span>再练一次</span>
                  </button>
                  <button
                    onClick={() => speaker.speak(current.content)}
                    className="dictation-action-btn replay-btn"
                    data-tip="再听一次 (1)"
                  >
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={removeCurrent} className="dictation-action-btn skip-btn" data-tip="移除生词本">
                    <Trash2 size={16} />
                    <span>移除生词本</span>
                  </button>
                  <button onClick={next} className="dictation-action-btn submit-btn" data-tip="下一题 (4 / Enter)">
                    <span>{index < queue.length - 1 ? '下一题' : '完成'}</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {comboVisible && (
            <div className="vocab-combo" role="status">连击 x{comboText}</div>
          )}
        </>
      ) : (
        <div className="dictation-finished">
          <div className="finished-icon">🎧</div>
          <h2>本轮完成！</h2>
          <div className="finished-stats">
            <div className="finished-stat">
              <span className="finished-stat-value">{round.attempted}</span>
              <span className="finished-stat-label">已练</span>
            </div>
            <div className="finished-stat">
              <span className="finished-stat-value">{round.correct}</span>
              <span className="finished-stat-label">正确</span>
            </div>
            <div className="finished-stat">
              <span className="finished-stat-value">
                {round.attempted ? Math.round((round.correct / round.attempted) * 100) : 0}%
              </span>
              <span className="finished-stat-label">正确率</span>
            </div>
            <div className="finished-stat">
              <span className="finished-stat-value">{combo.max}</span>
              <span className="finished-stat-label">最长连击</span>
            </div>
          </div>
          <div className="finished-actions">
            <button onClick={() => startByType(selectedType)} className="action-btn">
              <RefreshCw size={18} />
              <span>再来一轮</span>
            </button>
            <button onClick={() => navigate('/profile')} className="action-btn">
              <ArrowLeft size={18} />
              <span>返回个人中心</span>
            </button>
          </div>
        </div>
      )}

      {helpOpen && (
        <div className="vocab-help-mask" onClick={() => setHelpOpen(false)}>
          <div className="vocab-help" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <div className="vocab-help-head">
              <h2>键盘快捷键</h2>
              <button type="button" className="vocab-icon-btn" onClick={() => setHelpOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.title} className="vocab-help-group">
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map((item, i) => (
                    <li key={i}>
                      <span className="vocab-help-keys">
                        {item.keys.map((k, j) => <span key={j} className="vocab-keycap">{k}</span>)}
                      </span>
                      <span className="vocab-help-label">{item.label}</span>
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
