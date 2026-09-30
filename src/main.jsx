import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import App from './App'
import Library from './pages/Library'
import VideoDetail from './pages/VideoDetail'
import DictationPage from './pages/DictationPage'
import ShadowingPage from './pages/ShadowingPage'
import ClozePage from './pages/ClozePage'
import LearningRecords from './pages/LearningRecords'
import Profile from './pages/Profile'
import VocabPracticePage from './pages/VocabPracticePage'
import Login from './pages/Login'
import ConversationPage from './pages/ConversationPage'
import './index.css'

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
            <Route path="video/:id/shadowing" element={<ShadowingPage />} />
            <Route path="video/:id/cloze" element={<ClozePage />} />
            <Route path="video/:id/conversation" element={<ConversationPage />} />
            <Route path="records" element={<LearningRecords />} />
            <Route path="profile" element={<Profile />} />
            <Route path="vocab/practice" element={<VocabPracticePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
