import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

const API_BASE = '/api'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem('shadow_voice_token'))
  const [isGuest, setIsGuest] = useState(() => sessionStorage.getItem('shadow_voice_guest') === 'true')
  const [loading, setLoading] = useState(true)

  // Verify token on mount
  useEffect(() => {
    if (isGuest) {
      setLoading(false)
      return
    }
    if (!token) {
      setLoading(false)
      return
    }
    fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setUser(data.user))
      .catch(() => {
        setToken(null)
        localStorage.removeItem('shadow_voice_token')
      })
      .finally(() => setLoading(false))
  }, [])

  const loginAsGuest = () => {
    setIsGuest(true)
    sessionStorage.setItem('shadow_voice_guest', 'true')
    setLoading(false)
  }

  const login = async (username, password) => {
    setIsGuest(false)
    sessionStorage.removeItem('shadow_voice_guest')
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    let data
    try {
      data = await res.json()
    } catch {
      throw new Error('服务器未响应，请确认后端服务已启动 (npm run server)')
    }
    if (!res.ok) throw new Error(data.error || '登录失败')
    setToken(data.token)
    setUser(data.user)
    localStorage.setItem('shadow_voice_token', data.token)
    return data.user
  }

  const register = async (username, email, password) => {
    setIsGuest(false)
    sessionStorage.removeItem('shadow_voice_guest')
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    })
    let data
    try {
      data = await res.json()
    } catch {
      throw new Error('服务器未响应，请确认后端服务已启动 (npm run server)')
    }
    if (!res.ok) throw new Error(data.error || '注册失败')
    setToken(data.token)
    setUser(data.user)
    localStorage.setItem('shadow_voice_token', data.token)
    return data.user
  }

  const logout = () => {
    setToken(null)
    setUser(null)
    setIsGuest(false)
    localStorage.removeItem('shadow_voice_token')
    sessionStorage.removeItem('shadow_voice_guest')
  }

  const authFetch = (url, options = {}) => {
    // Guest mode: skip auth, request will get 401 which callers handle
    if (isGuest) {
      return fetch(`${API_BASE}${url}`, {
        ...options,
        headers: {
          ...options.headers,
          'Content-Type': 'application/json'
        }
      })
    }
    return fetch(`${API_BASE}${url}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    })
  }

  return (
    <AuthContext.Provider value={{ user, token, isGuest, loading, login, loginAsGuest, register, logout, authFetch }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
