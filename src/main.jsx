import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import App from './App'
import Library from './pages/Library'
import VideoDetail from './pages/VideoDetail'
import DictationPage from './pages/DictationPage'
import LearningRecords from './pages/LearningRecords'
import Login from './pages/Login'
import './index.css'

// Route guard: redirect to /login if not authenticated
function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="loading-container">
        <div className="loading-spinner" />
        <p>加载中...</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return children
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<ProtectedRoute><App /></ProtectedRoute>}>
            <Route index element={<Library />} />
            <Route path="video/:id" element={<VideoDetail />} />
            <Route path="video/:id/dictation" element={<DictationPage />} />
            <Route path="records" element={<LearningRecords />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
