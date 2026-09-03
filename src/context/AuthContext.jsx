import { createContext, useContext, useState, useEffect, useCallback } from 'react'

const AuthContext = createContext(null)

const API_BASE = '/api'

// 二进制/表单 body：让 fetch 按 body 类型推断 Content-Type（Blob.type / FormData boundary）。
// 若硬标 application/json，PCM 音频上传会被服务端全局 express.json()（100KB 限制）拦截 → 500
const isBinaryBody = (body) =>
  body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams ||
  body instanceof ArrayBuffer || ArrayBuffer.isView(body)

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

  // 登录/注册成功后，把本机 localStorage 里累积的观看历史一次性并入账号
  const mergeLocalHistory = useCallback(async (authToken) => {
    let local
    try { local = JSON.parse(localStorage.getItem('shadow_voice_watched') || '[]') } catch { local = [] }
    if (!Array.isArray(local) || local.length === 0) return
    try {
      const res = await fetch(`${API_BASE}/history/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ ids: local })
      })
      if (res.ok) localStorage.removeItem('shadow_voice_watched')
    } catch {
      // 合并失败不阻塞登录
    }
  }, [])

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
    mergeLocalHistory(data.token)
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
    mergeLocalHistory(data.token)
    return data.user
  }

  const logout = () => {
    setToken(null)
    setUser(null)
    setIsGuest(false)
    localStorage.removeItem('shadow_voice_token')
    sessionStorage.removeItem('shadow_voice_guest')
  }

  const authFetch = useCallback((url, options = {}) => {
    const { headers = {}, body, ...rest } = options
    const finalHeaders = { ...headers }
    if (!isBinaryBody(body) && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json'
    }
    if (!isGuest) finalHeaders.Authorization = `Bearer ${token}`
    return fetch(`${API_BASE}${url}`, { ...rest, body, headers: finalHeaders })
  }, [isGuest, token])

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
