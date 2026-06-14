import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

const API_BASE = '/api'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem('vidDict_token'))
  const [loading, setLoading] = useState(true)

  // Verify token on mount
  useEffect(() => {
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
        localStorage.removeItem('vidDict_token')
      })
      .finally(() => setLoading(false))
  }, [])

  const login = async (username, password) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    setToken(data.token)
    setUser(data.user)
    localStorage.setItem('vidDict_token', data.token)
    return data.user
  }

  const register = async (username, email, password) => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    setToken(data.token)
    setUser(data.user)
    localStorage.setItem('vidDict_token', data.token)
    return data.user
  }

  const logout = () => {
    setToken(null)
    setUser(null)
    localStorage.removeItem('vidDict_token')
  }

  const authFetch = (url, options = {}) => {
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
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, authFetch }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
