import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Filter, Clock, ChevronDown, X, Play } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { loadSummary } from '../utils/practiceRecords'
import { computeVideoProgress, hasAnyPractice, getLearningStatus } from '../utils/learningStatus'

const STATUS_FILTERS = [
  { label: 'All', key: null },
  { label: 'Not Learned', key: 'not_learned' },
  { label: 'Learning', key: 'learning' },
  { label: 'Learned', key: 'learned' },
]
const STATUS_BADGE = {
  not_learned: '🔴 Not Learned',
  learning: '🟡 Learning',
  learned: '🟢 Learned',
}

export default function Library() {
  const [videos, setVideos] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('全部')
  const [topicFilter, setTopicFilter] = useState('全部')
  const [accentFilter, setAccentFilter] = useState('全部')
  const [page, setPage] = useState(1)
  const [showFilters, setShowFilters] = useState(false)
  const { authFetch, isGuest } = useAuth()
  const [practiceSummary, setPracticeSummary] = useState({})
  const [summaryLoaded, setSummaryLoaded] = useState(false)
  const [statusFilter, setStatusFilter] = useState('All')
  const navigate = useNavigate()
  const PER_PAGE = 20

  useEffect(() => {
    Promise.all([
      fetch('/data/consolidated.json').then(r => r.json()),
      fetch('/data/meta.json').then(r => r.json()),
    ]).then(([v, m]) => {
      setVideos(v)
      setMeta(m)
      setLoading(false)
    }).catch(err => {
      console.error(err)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    loadSummary(authFetch, isGuest)
      .then(setPracticeSummary)
      .catch(() => {})
      .finally(() => setSummaryLoaded(true))
  }, [authFetch, isGuest])

  const statusByVideo = useMemo(() => {
    const map = {}
    for (const v of videos) {
      const counts = practiceSummary[v.id] || {}
      const progress = computeVideoProgress(counts, v.subtitle_count)
      map[v.id] = { progress, status: getLearningStatus(counts, progress), hasAny: hasAnyPractice(counts) }
    }
    return map
  }, [videos, practiceSummary])

  const filteredVideos = useMemo(() => {
    let result = videos
    
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(v =>
        v.title.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        v.topic.toLowerCase().includes(q) ||
        v.topics.some(t => t.toLowerCase().includes(q))
      )
    }
    
    if (levelFilter !== '全部') {
      result = result.filter(v => v.level === levelFilter)
    }
    
    if (topicFilter !== '全部') {
      result = result.filter(v => v.topics.includes(topicFilter))
    }

    if (accentFilter !== '全部') {
      result = result.filter(v => v.accent === accentFilter)
    }

    const statusKey = STATUS_FILTERS.find(f => f.label === statusFilter)?.key
    if (statusKey) {
      result = result.filter(v => statusByVideo[v.id]?.status === statusKey)
    }
    
    return result
  }, [videos, search, levelFilter, topicFilter, accentFilter, statusByVideo, statusFilter])

  const totalPages = Math.ceil(filteredVideos.length / PER_PAGE)
  const paginatedVideos = filteredVideos.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>加载中...</p>
      </div>
    )
  }

  return (
    <div className="library-page">
      <div className="library-header">
        <div className="search-bar">
          <Search size={20} className="search-icon" />
          <input
            type="text"
            placeholder="搜索视频、话题、描述..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="search-input"
          />
          {search && (
            <button onClick={() => setSearch('')} className="search-clear">
              <X size={18} />
            </button>
          )}
        </div>
        <button
          className={`filter-toggle ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter size={18} />
          <span>筛选</span>
          <ChevronDown size={16} className={`chevron ${showFilters ? 'open' : ''}`} />
        </button>
      </div>

      {showFilters && meta && (
        <div className="filters-panel">
          <div className="filter-group">
            <label className="filter-label">难度等级</label>
            <div className="filter-options">
              <button
                className={`filter-btn ${levelFilter === '全部' ? 'active' : ''}`}
                onClick={() => { setLevelFilter('全部'); setPage(1) }}
              >全部</button>
              {meta.levels.map(l => (
                <button
                  key={l}
                  className={`filter-btn ${levelFilter === l ? 'active' : ''}`}
                  onClick={() => { setLevelFilter(l); setPage(1) }}
                >{l}</button>
              ))}
            </div>
          </div>
          <div className="filter-group">
            <label className="filter-label">话题分类</label>
            <div className="filter-options">
              <button
                className={`filter-btn ${topicFilter === '全部' ? 'active' : ''}`}
                onClick={() => { setTopicFilter('全部'); setPage(1) }}
              >全部</button>
              {meta.topics.map(t => (
                <button
                  key={t}
                  className={`filter-btn ${topicFilter === t ? 'active' : ''}`}
                  onClick={() => { setTopicFilter(t); setPage(1) }}
                >{t}</button>
              ))}
            </div>
          </div>
          {meta.accents && meta.accents.length > 0 && (
            <div className="filter-group">
              <label className="filter-label">口音地区</label>
              <div className="filter-options">
                <button
                  className={`filter-btn ${accentFilter === '全部' ? 'active' : ''}`}
                  onClick={() => { setAccentFilter('全部'); setPage(1) }}
                >全部</button>
                {meta.accents.map(a => (
                  <button
                    key={a}
                    className={`filter-btn ${accentFilter === a ? 'active' : ''}`}
                    onClick={() => { setAccentFilter(a); setPage(1) }}
                  >{a}</button>
                ))}
              </div>
            </div>
          )}
          <div className="filter-group">
            <label className="filter-label">学习状态</label>
            <div className="filter-options">
              {STATUS_FILTERS.map(f => (
                <button
                  key={f.label}
                  className={`filter-btn ${statusFilter === f.label ? 'active' : ''}`}
                  onClick={() => { setStatusFilter(f.label); setPage(1) }}
                >{f.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="results-info">
        <span>共 {filteredVideos.length} 个视频</span>
        {(levelFilter !== '全部' || topicFilter !== '全部' || accentFilter !== '全部' || statusFilter !== 'All') && (
          <span className="active-filters">
            {levelFilter !== '全部' && <span className="filter-tag" onClick={() => setLevelFilter('全部')}>{levelFilter} ×</span>}
            {topicFilter !== '全部' && <span className="filter-tag" onClick={() => setTopicFilter('全部')}>{topicFilter} ×</span>}
            {accentFilter !== '全部' && <span className="filter-tag" onClick={() => setAccentFilter('全部')}>{accentFilter} ×</span>}
            {statusFilter !== 'All' && <span className="filter-tag" onClick={() => setStatusFilter('All')}>{statusFilter} ×</span>}
          </span>
        )}
      </div>

      <div className="video-grid">
        {paginatedVideos.map(video => (
          <div key={video.id} className="video-card" onClick={() => navigate(`/video/${video.id}`)}>
            <div className="video-thumb">
              <img
                src={video.thumbnail_local || video.thumbnail}
                alt={video.title}
                loading="lazy"
                onError={e => { e.target.style.display = 'none' }}
              />
              <div className="video-duration">
                <Clock size={12} />
                <span>{Math.floor(video.duration / 60)}:{(video.duration % 60).toString().padStart(2, '0')}</span>
              </div>
              <div className="play-overlay">
                <Play size={32} />
              </div>
            </div>
            <div className="video-info">
              <h3 className="video-title">{video.title}</h3>
              <p className="video-desc">{video.description.length > 80 ? video.description.substring(0, 80) + '...' : video.description}</p>
              <div className="video-meta">
                <span className={`level-badge level-${video.level}`}>{video.level}</span>
                <span className="topic-badge">{video.topic}</span>
                <span className="subtitle-count">{video.subtitle_count} 条字幕</span>
                {summaryLoaded && (
                  <span className={`learn-badge learn-badge-${statusByVideo[video.id]?.status || 'not_learned'}`}>
                    {STATUS_BADGE[statusByVideo[video.id]?.status || 'not_learned']}
                  </span>
                )}
              </div>
              {video.accent && <span className="video-accent">{video.accent}</span>}
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="page-btn"
          >上一页</button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              className={`page-btn ${p === page ? 'active' : ''}`}
              onClick={() => setPage(p)}
            >{p}</button>
          ))}
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="page-btn"
          >下一页</button>
        </div>
      )}

      {filteredVideos.length === 0 && (
        <div className="empty-state">
          <p>没有找到匹配的视频</p>
          <button onClick={() => { setSearch(''); setLevelFilter('全部'); setTopicFilter('全部'); setAccentFilter('全部'); setStatusFilter('All'); }}>清除筛选</button>
        </div>
      )}
    </div>
  )
}
