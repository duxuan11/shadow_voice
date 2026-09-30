import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/auth-context'

// 路由守卫：未登录且非游客时跳转登录页。
export default function ProtectedRoute({ children }) {
  const { user, isGuest, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>加载中...</p>
      </div>
    )
  }

  if (!user && !isGuest) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return children
}
