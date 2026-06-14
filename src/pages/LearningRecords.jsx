import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, Clock, Trash2, Play, Star } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function LearningRecords() {
  const navigate = useNavigate()
  const { authFetch } = useAuth()
  const [videos, setVideos] = useState([])
  const [vocabulary, setVocabulary] = useState([])
  const [watchedHistory, setWatchedHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vidDict_watched') || '[]') }
    catch { return [] }
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
  }, [])

  const watchedVideos = watchedHistory
    .map(id => videos.find(v => v.id === id))
    .filter(Boolean)

  const clearWatched = () => {
    setWatchedHistory([])
    localStorage.setItem('vidDict_watched', '[]')
  }

  const clearVocabulary = () => {
    // Delete all vocab via API
    vocabulary.forEach(v => {
      authFetch(`/vocab/${encodeURIComponent(v.word)}`, { method: 'DELETE' }).catch(() => {})
    })
    setVocabulary([])
  }

  const removeVocabWord = (word) => {
    authFetch(`/vocab/${encodeURIComponent(word)}`, { method: 'DELETE' })
      .then(() => setVocabulary(prev => prev.filter(v => v.word !== word)))
      .catch(() => {})
  }

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
              <button onClick={clearVocabulary} className="danger-btn">
                <Trash2 size={16} />
                <span>清空生词本</span>
              </button>
            </div>
          )}

          {vocabulary.length === 0 ? (
            <div className="empty-state">
              <p>还没有生词</p>
              <span className="empty-hint">在观看视频时点击字幕中的单词即可添加</span>
            </div>
          ) : (
            <div className="vocab-table">
              <div className="vocab-header-row">
                <span>单词</span>
                <span>来源视频</span>
                <span>添加时间</span>
                <span>操作</span>
              </div>
              {vocabulary.map((v, i) => (
                <div key={i} className="vocab-row">
                  <span className="vocab-word-cell">{v.word}</span>
                  <span
                    className="vocab-video-cell"
                    onClick={() => v.video_id && navigate(`/video/${v.video_id}`)}
                    title={v.video_title}
                  >
                    {v.video_title?.substring(0, 20)}{v.video_title?.length > 20 ? '...' : ''}
                  </span>
                  <span className="vocab-date-cell">
                    {v.created_at ? new Date(v.created_at).toLocaleDateString('zh-CN') : '-'}
                  </span>
                  <span>
                    <button onClick={() => removeVocabWord(v.word)} className="vocab-remove-btn">
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
