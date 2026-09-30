import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, Clock, Trash2, Play, Star, MessageSquare, Headphones } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { proficiencyOf } from '../utils/vocabPractice'
import {
  normalizeVocabKey,
  filterVocabByType,
  countVocabByType,
  VOCAB_TYPE_LABELS,
} from '../utils/vocabulary'

const VOCAB_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'word', label: '单词' },
  { id: 'phrase', label: '短语' },
  { id: 'core_phrase', label: '核心短语' },
]

// SQLite datetime('now') 为 UTC（"YYYY-MM-DD HH:MM:SS"），补 T/Z 再本地化。
function formatVocabDate(value) {
  if (!value) return '-'
  const raw = String(value)
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function LearningRecords() {
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()
  const [videos, setVideos] = useState([])
  const [vocabulary, setVocabulary] = useState([])
  const [conversations, setConversations] = useState([])
  const [vocabFilter, setVocabFilter] = useState('all')
  const [vocabBusy, setVocabBusy] = useState(() => new Set())
  const [watchedHistory, setWatchedHistory] = useState(() => {
    if (isGuest) {
      try { return JSON.parse(localStorage.getItem('shadow_voice_watched') || '[]') }
      catch { return [] }
    }
    return []
  })
  const [activeTab, setActiveTab] = useState('watched')

  useEffect(() => {
    fetch('/data/consolidated.json')
      .then(r => r.json())
      .then(setVideos)
      .catch(console.error)
  }, [])

  // Load vocabulary from API
  useEffect(() => {
    authFetch('/vocab')
      .then(r => r.json())
      .then(data => setVocabulary(data.vocabulary || []))
      .catch(() => {})
  }, [authFetch])

  // 观看历史：登录用户从服务端拉取（跨设备同步）；游客读 localStorage
  useEffect(() => {
    if (isGuest) return
    authFetch('/history')
      .then(r => r.json())
      .then(data => setWatchedHistory(data.history || []))
      .catch(() => {})
  }, [authFetch, isGuest])

  // Load AI 对话记录（游客 401 → 空列表）
  useEffect(() => {
    authFetch('/conversation/recent')
      .then(r => (r.ok ? r.json() : { conversations: [] }))
      .then(data => setConversations(data.conversations || []))
      .catch(() => {})
  }, [authFetch])

  const watchedVideos = watchedHistory
    .map(id => videos.find(v => v.id === id))
    .filter(Boolean)

  const clearWatched = () => {
    if (isGuest) {
      setWatchedHistory([])
      localStorage.setItem('shadow_voice_watched', '[]')
    } else {
      authFetch('/history', { method: 'DELETE' })
        .then(() => setWatchedHistory([]))
        .catch(() => {})
    }
  }

  const clearVocabulary = async () => {
    const list = [...vocabulary]
    if (list.length === 0) return
    setVocabulary([])
    await Promise.all(list.map(v => {
      const key = v.word || normalizeVocabKey(v.content)
      return authFetch(`/vocab/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {})
    }))
  }

  const removeVocabWord = (entry) => {
    const key = entry.word || normalizeVocabKey(entry.content)
    if (!key) return
    setVocabBusy(prev => new Set(prev).add(key))
    authFetch(`/vocab/${encodeURIComponent(key)}`, { method: 'DELETE' })
      .then(r => {
        if (r.ok) setVocabulary(prev => prev.filter(v => (v.word || normalizeVocabKey(v.content)) !== key))
      })
      .catch(() => {})
      .finally(() => setVocabBusy(prev => { const n = new Set(prev); n.delete(key); return n }))
  }

  // 点来源回到对应视频词卡位置
  const openSource = (entry, source) => {
    if (!source?.videoId) return
    const word = encodeURIComponent(entry.content || entry.word)
    navigate(`/video/${source.videoId}?card=1&word=${word}&type=${entry.type || 'word'}`)
  }

  const counts = countVocabByType(vocabulary)
  const filteredVocab = filterVocabByType(vocabulary, vocabFilter)

  return (
    <div className="records-page">
      <div className="records-header">
        <h1>
          <BookOpen size={24} />
          <span>学习记录</span>
        </h1>
      </div>

      <div className="records-tabs">
        <button
          className={`tab-btn ${activeTab === 'watched' ? 'active' : ''}`}
          onClick={() => setActiveTab('watched')}
        >
          <Clock size={16} />
          <span>观看历史</span>
          <span className="tab-count">{watchedHistory.length}</span>
        </button>
        <button
          className={`tab-btn ${activeTab === 'vocab' ? 'active' : ''}`}
          onClick={() => setActiveTab('vocab')}
        >
          <Star size={16} />
          <span>生词本</span>
          <span className="tab-count">{vocabulary.length}</span>
        </button>
        <button
          className={`tab-btn ${activeTab === 'conv' ? 'active' : ''}`}
          onClick={() => setActiveTab('conv')}
        >
          <MessageSquare size={16} />
          <span>AI 对话</span>
          <span className="tab-count">{conversations.length}</span>
        </button>
      </div>

      {activeTab === 'watched' && (
        <div className="records-content">
          {watchedVideos.length > 0 && (
            <div className="records-actions">
              <button onClick={clearWatched} className="danger-btn">
                <Trash2 size={16} />
                <span>清除历史</span>
              </button>
            </div>
          )}
          
          {watchedVideos.length === 0 ? (
            <div className="empty-state">
              <p>还没有观看记录</p>
              <button onClick={() => navigate('/')}>去浏览视频</button>
            </div>
          ) : (
            <div className="video-list">
              {watchedVideos.map(video => (
                <div key={video.id} className="watched-item" onClick={() => navigate(`/video/${video.id}`)}>
                  <img
                    src={video.thumbnail_local || video.thumbnail}
                    alt={video.title}
                    className="watched-thumb"
                    onError={e => { e.target.style.display = 'none' }}
                  />
                  <div className="watched-info">
                    <h3>{video.title}</h3>
                    <div className="watched-meta">
                      <span className={`level-badge level-${video.level}`}>{video.level}</span>
                      <span>{Math.floor(video.duration / 60)}:{(video.duration % 60).toString().padStart(2, '0')}</span>
                      <span>{video.subtitle_count} 条字幕</span>
                    </div>
                  </div>
                  <Play size={20} className="watched-play" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'vocab' && (
        <div className="records-content">
          {vocabulary.length > 0 && (
            <div className="records-actions">
              <button type="button" onClick={() => navigate('/vocab/practice')} className="vocab-practice-btn">
                <Headphones size={16} />
                <span>听练</span>
              </button>
              <button onClick={clearVocabulary} className="danger-btn">
                <Trash2 size={16} />
                <span>清空生词本</span>
              </button>
            </div>
          )}

          {vocabulary.length === 0 ? (
            <div className="empty-state">
              <p>还没有生词</p>
              <span className="empty-hint">在视频的「智能重点词卡」中点击「加入生词本」</span>
            </div>
          ) : (
            <>
              <div className="vocab-filter" role="tablist" aria-label="生词分类">
                {VOCAB_FILTERS.map(f => (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={vocabFilter === f.id}
                    className={`vocab-filter-btn ${vocabFilter === f.id ? 'active' : ''}`}
                    onClick={() => setVocabFilter(f.id)}
                  >
                    {f.label}
                    <span className="vocab-filter-count">{counts[f.id]}</span>
                  </button>
                ))}
              </div>

              {filteredVocab.length === 0 ? (
                <div className="empty-state">
                  <p>该分类下暂无生词</p>
                </div>
              ) : (
                <div className="vocab-book">
                  {filteredVocab.map(entry => {
                    const key = entry.word || normalizeVocabKey(entry.content)
                    const busy = vocabBusy.has(key)
                    const sources = Array.isArray(entry.sources) ? entry.sources : []
                    return (
                      <div key={entry.id || key} className="vocab-card">
                        <div className="vocab-card-head">
                          <div className="vocab-card-content">
                            <span className="vocab-card-word">{entry.content || entry.word}</span>
                            {entry.phonetic && <span className="vocab-phonetic">{entry.phonetic}</span>}
                          </div>
                          <span className={`vocab-type-badge type-${entry.type || 'word'}`}>
                            {VOCAB_TYPE_LABELS[entry.type] || '单词'}
                          </span>
                        </div>

                        {entry.translation && (
                          <p className="vocab-card-translation">{entry.translation}</p>
                        )}

                        <div className="vocab-card-sources">
                          <span className="vocab-sources-label">来源视频</span>
                          <div className="vocab-source-list">
                            {sources.length === 0 && <span className="vocab-source-empty">未知来源</span>}
                            {sources.map((s, i) => (
                              s.videoId ? (
                                <button
                                  key={i}
                                  type="button"
                                  className="vocab-source-chip"
                                  onClick={() => openSource(entry, s)}
                                >
                                  <Play size={12} />
                                  <span>{s.videoTitle || s.videoId}</span>
                                </button>
                              ) : (
                                <span key={i} className="vocab-source-chip is-static">
                                  {s.videoTitle || '来源'}
                                </span>
                              )
                            ))}
                          </div>
                        </div>

                        <div className="vocab-card-foot">
                          <span className="vocab-date-cell">
                            加入于 {formatVocabDate(entry.created_at)}
                            {(() => {
                              const p = proficiencyOf(entry)
                              return (
                                <span className="vocab-stat-badge">
                                  练习 {entry.practice_count || 0} 次
                                  {entry.practice_count ? ` · 正确率 ${p.percent}% · ${p.label}` : ' · 未练'}
                                </span>
                              )
                            })()}
                          </span>
                          <div className="vocab-card-actions">
                            <button
                              type="button"
                              className="vocab-practice-btn"
                              onClick={() => navigate(
                                `/vocab/practice?word=${encodeURIComponent(entry.content || entry.word)}&type=${entry.type || 'word'}`
                              )}
                            >
                              <Headphones size={14} />
                              <span>听练</span>
                            </button>
                            <button
                              type="button"
                              className="vocab-remove-btn"
                              onClick={() => removeVocabWord(entry)}
                              disabled={busy}
                              aria-label="移除生词"
                            >
                              <Trash2 size={16} />
                              <span>{busy ? '移除中' : '移除'}</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {activeTab === 'conv' && (
        <div className="records-content">
          {conversations.length === 0 ? (
            <div className="empty-state">
              <p>还没有 AI 对话记录</p>
              <span className="empty-hint">在视频详情页点「💬 AI 对话」开始练习</span>
            </div>
          ) : (
            <div className="conv-records-list">
              {conversations.map(c => (
                <div key={c.id} className="conv-record-item" onClick={() => navigate(`/video/${c.videoId}/conversation?session=${c.id}`)}>
                  <div className="conv-record-info">
                    <h3>{c.videoTitle}</h3>
                    <p className="conv-record-meta">
                      <span className={`conv-record-status ${c.status === 'completed' ? 'done' : ''}`}>
                        {c.status === 'completed' ? '已完成' : '进行中'}
                      </span>
                      <span>{c.userTurns} 轮</span>
                      <span>{c.updatedAt ? new Date(c.updatedAt.replace(' ', 'T')).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                    </p>
                    {c.lastUserText && <p className="conv-record-last">「{c.lastUserText.slice(0, 40)}{c.lastUserText.length > 40 ? '...' : ''}」</p>}
                    {c.summary && <p className="conv-record-summary">{c.summary}</p>}
                  </div>
                  <Play size={18} className="watched-play" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
