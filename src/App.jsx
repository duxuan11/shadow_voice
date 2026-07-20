import { useState, useEffect } from 'react'
import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { Home, BookOpen, Menu, X, LogOut, User, UserCircle } from 'lucide-react'
import { useAuth } from './context/AuthContext'

export default function App() {
  const [meta, setMeta] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const { user, isGuest, logout } = useAuth()

  // Hide navbar on video detail pages (mobile uses full-screen layout)
  const isVideoPage = location.pathname.startsWith('/video/')

  useEffect(() => {
    fetch('/data/meta.json')
      .then(r => r.json())
      .then(setMeta)
      .catch(console.error)
  }, [])

  return (
    <div className="app">
      <nav className={`navbar ${isVideoPage ? 'md:block hidden' : ''}`}>
        <div className="nav-inner">
          <NavLink to="/" className="nav-brand">
            <span className="brand-icon">🎬</span>
            <span className="brand-text">看视频学英语</span>
          </NavLink>

          <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>

          <div className={`nav-links ${menuOpen ? 'open' : ''}`}>
            <NavLink to="/" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
              <Home size={18} />
              <span>首页</span>
            </NavLink>
            <NavLink to="/records" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
              <BookOpen size={18} />
              <span>学习记录</span>
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
              <UserCircle size={18} />
              <span>个人中心</span>
            </NavLink>
          </div>

          <div className="nav-right">
            {meta && (
              <span className="stat-badge">{meta.total_videos} 个视频</span>
            )}
            {user && (
              <div className="nav-user">
                <User size={16} />
                <span className="nav-username">{user.username}</span>
                <button onClick={logout} className="nav-logout-btn" title="退出登录">
                  <LogOut size={16} />
                </button>
              </div>
            )}
            {isGuest && !user && (
              <div className="nav-user nav-guest">
                <User size={16} />
                <span className="nav-username">游客</span>
                <button onClick={logout} className="nav-logout-btn" title="退出游客模式">
                  <LogOut size={16} />
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <main className={`main-content ${isVideoPage ? 'md:p-6 p-0' : ''}`}>
        <Outlet context={{ meta }} />
      </main>
    </div>
  )
}
