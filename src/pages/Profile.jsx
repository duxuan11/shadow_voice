import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { User, Mail, Calendar, BarChart3, BookOpen, Star, Clock, Play, ChevronRight, LogOut, Shield } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Profile() {
  const { user, isGuest, logout, authFetch } = useAuth()
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [videos, setVideos] = useState([])
  const [vocabulary, setVocabulary] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Watched history from localStorage
  const [watchedHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('shadow_voice_watched') || '[]') }
    catch { return [] }
  })

  useEffect(() => {
    const loadData = async () => {
      try {
        const [videosRes, statsRes, vocabRes] = await Promise.all([
          fetch('/data/consolidated.json').then(r => r.json()),
          isGuest ? Promise.resolve(null) : authFetch('/auth/stats').then(r => r.json()).catch(() => null),
          isGuest ? Promise.resolve({ vocabulary: [] }) : authFetch('/vocab').then(r => r.json()).catch(() => ({ vocabulary: [] })),
        ])
        setVideos(videosRes)
        setStats(statsRes)
        setVocabulary(vocabRes.vocabulary || [])
      } catch {
        setError('加载数据失败')
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [authFetch, isGuest])

  const watchedVideos = watchedHistory
    .map(id => videos.find(v => v.id === id))
    .filter(Boolean)
    .slice(0, 5)

  const joinDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : null

  const avatarLetter = (user?.username || '?')[0].toUpperCase()

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>加载中...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="error-container">
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>重试</button>
      </div>
    )
  }

  return (
    <div className="profile-page">
      {/* User Info Card */}
      <div className="profile-card">
        <div className="profile-avatar">
          {isGuest ? (
            <User size={36} />
          ) : (
            <span className="profile-avatar-text">{avatarLetter}</span>
          )}
        </div>
        <div className="profile-info">
          <h1 className="profile-name">{isGuest ? '游客' : user?.username}</h1>
          {!isGuest && user?.email && (
            <div className="profile-detail">
              <Mail size={14} />
              <span>{user.email}</span>
            </div>
          )}
          {joinDate && (
            <div className="profile-detail">
              <Calendar size={14} />
              <span>{joinDate} 加入</span>
            </div>
          )}
          {isGuest && (
            <p className="profile-guest-hint">登录后可同步学习进度和数据</p>
          )}
        </div>
        <div className="profile-actions">
          {isGuest ? (
            <button className="profile-action-btn primary" onClick={() => navigate('/login')}>
              <Shield size={16} />
              <span>登录 / 注册</span>
            </button>
          ) : (
            <button className="profile-action-btn danger" onClick={() => { logout(); navigate('/') }}>
              <LogOut size={16} />
              <span>退出登录</span>
            </button>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="profile-stats-grid">
        <div className="profile-stat-card">
          <div className="profile-stat-icon watch">
            <Play size={20} />
          </div>
          <div className="profile-stat-body">
            <span className="profile-stat-number">{watchedHistory.length}</span>
            <span className="profile-stat-label">已观看视频</span>
          </div>
        </div>
        <div className="profile-stat-card">
          <div className="profile-stat-icon vocab">
            <Star size={20} />
          </div>
          <div className="profile-stat-body">
            <span className="profile-stat-number">{vocabulary.length}</span>
            <span className="profile-stat-label">生词本</span>
          </div>
        </div>
        {!isGuest && stats && (
          <>
            <div className="profile-stat-card">
              <div className="profile-stat-icon practice">
                <BookOpen size={20} />
              </div>
              <div className="profile-stat-body">
                <span className="profile-stat-number">{stats.totalDictations}</span>
                <span className="profile-stat-label">听写练习</span>
              </div>
            </div>
            <div className="profile-stat-card">
              <div className="profile-stat-icon score">
                <BarChart3 size={20} />
              </div>
              <div className="profile-stat-body">
                <span className="profile-stat-number">{stats.averageScore}%</span>
                <span className="profile-stat-label">平均正确率</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Recent Watched */}
      <div className="profile-section">
        <div className="profile-section-header">
          <h2>
            <Clock size={18} />
            <span>最近观看</span>
          </h2>
          {watchedHistory.length > 0 && (
            <button className="profile-section-link" onClick={() => navigate('/records')}>
              <span>查看全部</span>
              <ChevronRight size={16} />
            </button>
          )}
        </div>
        {watchedVideos.length === 0 ? (
          <div className="profile-empty">
            <p>还没有观看记录</p>
            <button onClick={() => navigate('/')}>去浏览视频</button>
          </div>
        ) : (
          <div className="profile-video-list">
            {watchedVideos.map(video => (
              <div key={video.id} className="profile-video-item" onClick={() => navigate(`/video/${video.id}`)}>
                <img
                  src={video.thumbnail_local || video.thumbnail}
                  alt={video.title}
                  className="profile-video-thumb"
                  onError={e => { e.target.style.display = 'none' }}
                />
                <div className="profile-video-info">
                  <h3>{video.title}</h3>
                  <div className="profile-video-meta">
                    <span className={`level-badge level-${video.level}`}>{video.level}</span>
                    <span>{Math.floor(video.duration / 60)}:{(video.duration % 60).toString().padStart(2, '0')}</span>
                    <span>{video.subtitle_count} 条字幕</span>
                  </div>
                </div>
                <Play size={18} className="profile-video-play" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Vocabulary */}
      {vocabulary.length > 0 && (
        <div className="profile-section">
          <div className="profile-section-header">
            <h2>
              <Star size={18} />
              <span>最近生词</span>
            </h2>
            <button className="profile-section-link" onClick={() => navigate('/records')}>
              <span>查看全部</span>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="profile-vocab-tags">
            {vocabulary.slice(0, 12).map((v, i) => (
              <span key={i} className="profile-vocab-tag">{v.word}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
