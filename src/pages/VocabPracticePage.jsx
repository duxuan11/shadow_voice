import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Headphones, Eye, EyeOff, Send, ChevronRight, RotateCcw, Trash2, RefreshCw,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { createSpeaker } from '../utils/tts'
import { checkSpelling, isAllCorrect } from '../utils/spellCheck'
import { normalizeVocabKey, VOCAB_TYPE_LABELS } from '../utils/vocabulary'
import {
  PRACTICE_TYPE_FILTERS,
  PRACTICE_TYPE_LABELS,
  buildPracticeQueue,
  summarizePracticeByType,
} from '../utils/vocabPractice'

export default function VocabPracticePage() {
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()
  const [searchParams] = useSearchParams()

  const [vocabulary, setVocabulary] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [selectedType, setSelectedType] = useState('all')
  const [phase, setPhase] = useState('setup') // setup | practice | finished
  const [queue, setQueue] = useState([])
  const [index, setIndex] = useState(0)
  const [userInput, setUserInput] = useState('')
  const [result, setResult] = useState(null) // { results, correct }
  const [revealed, setRevealed] = useState(false)
  const [showChinese, setShowChinese] = useState(false)
  const [round, setRound] = useState({ attempted: 0, correct: 0 })

  const attemptedRef = useRef(new Set())
  const deepStartedRef = useRef(false)
  const inputRef = useRef(null)
  const speaker = useMemo(() => createSpeaker(authFetch), [authFetch])

  const current = queue[index] || null
  const currentKey = current ? (current.word || normalizeVocabKey(current.content)) : ''
  const deepWord = searchParams.get('word') || ''

  // 加载生词本
  useEffect(() => {
    if (isGuest) { setLoading(false); return }
    authFetch('/vocab')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('unauthorized'))))
      .then(data => setVocabulary(data.vocabulary || []))
      .catch(() => setLoadError('加载生词本失败'))
      .finally(() => setLoading(false))
  }, [authFetch, isGuest])

  // 离开页面停止 TTS
  useEffect(() => () => speaker.stop(), [speaker])

  function startRound(items) {
    if (!items || items.length === 0) return
    attemptedRef.current = new Set()
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

  // 深链 ?word= → 单条成轮
  useEffect(() => {
    if (deepStartedRef.current || loading || !deepWord || vocabulary.length === 0) return
    deepStartedRef.current = true
    const items = buildPracticeQueue(vocabulary, { word: deepWord })
    if (items.length > 0) startRound(items)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, vocabulary, deepWord])

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
      setIndex(i => i + 1)
      setUserInput('')
      setResult(null)
      setRevealed(false)
    } else {
      speaker.stop()
      setPhase('finished')
    }
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

  function handleInputKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  if (loading) {
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

          <div className="dictation-card">
            <div className="vocab-practice-meta">
              <span className={`vocab-type-badge type-${current.type || 'word'}`}>
                {VOCAB_TYPE_LABELS[current.type] || '单词'}
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
                  onKeyDown={handleInputKeyDown}
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
                  >
                    <Send size={16} />
                    <span>提交</span>
                  </button>
                  <button onClick={() => speaker.speak(current.content)} className="dictation-action-btn replay-btn">
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={() => setRevealed(true)} className="dictation-action-btn">
                    <Eye size={16} />
                    <span>显示答案</span>
                  </button>
                </div>
                <div className="dictation-input-hints">
                  <span className="input-hint">Enter 提交</span>
                  <span className="input-hint">Shift+Enter 换行</span>
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

                <div className="spell-answer">
                  <span className="answer-label">正确答案：</span>
                  <span className="answer-text">{current.content}</span>
                </div>

                {result && (
                  <p className={`vocab-practice-verdict ${result.correct ? 'is-correct' : 'is-wrong'}`}>
                    {result.correct ? '✅ 完全正确' : '❌ 有出入，看看上面标红 / 标黄的部分'}
                  </p>
                )}

                <div className="dictation-nav">
                  <button onClick={retry} className="dictation-action-btn">
                    <RotateCcw size={16} />
                    <span>再练一次</span>
                  </button>
                  <button onClick={() => speaker.speak(current.content)} className="dictation-action-btn replay-btn">
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={removeCurrent} className="dictation-action-btn skip-btn">
                    <Trash2 size={16} />
                    <span>移除生词本</span>
                  </button>
                  <button onClick={next} className="dictation-action-btn submit-btn">
                    <span>{index < queue.length - 1 ? '下一题' : '完成'}</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
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
    </div>
  )
}
