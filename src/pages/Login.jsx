import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      if (mode === 'register') {
        await register(username, email, password)
      } else {
        await login(username, password)
      }
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-icon">🎬</span>
          <h1>看视频学英语</h1>
        </div>

        <div className="login-tabs">
          <button
            className={`login-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => { setMode('login'); setError('') }}
          >
            登录
          </button>
          <button
            className={`login-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => { setMode('register'); setError('') }}
          >
            注册
          </button>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label>用户名</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="输入用户名"
              required
              autoFocus
            />
          </div>

          {mode === 'register' && (
            <div className="form-group">
              <label>邮箱</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="输入邮箱"
                required
              />
            </div>
          )}

          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === 'register' ? '至少6位密码' : '输入密码'}
              required
              minLength={6}
            />
          </div>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-submit" disabled={submitting}>
            {submitting ? '请稍候...' : mode === 'register' ? '注册' : '登录'}
          </button>
        </form>

        <p className="login-switch">
          {mode === 'login' ? (
            <>还没有账号？<button onClick={() => setMode('register')}>去注册</button></>
          ) : (
            <>已有账号？<button onClick={() => setMode('login')}>去登录</button></>
          )}
        </p>
      </div>
    </div>
  )
}
