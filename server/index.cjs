const express = require('express')
const cors = require('cors')
const path = require('path')

const authRoutes = require('./routes/auth.cjs')
const dictationRoutes = require('./routes/dictation.cjs')
const vocabRoutes = require('./routes/vocab.cjs')

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// ── API routes ──────────────────────────────────────────────
app.use('/api/auth', authRoutes)
app.use('/api/dictation', dictationRoutes)
app.use('/api/vocab', vocabRoutes)

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

// API 404 — return JSON, never the SPA
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

// ── Static data (videos, JSON, thumbnails) ─────────────────
// This serves the bind-mounted volume in Docker, or the local
// data/ directory during development without Vite.
const dataDir = path.join(__dirname, '..', 'data')
app.use('/data', express.static(dataDir, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Accept-Ranges', 'bytes')
    }
  }
}))

// ── Built frontend (dist/) ──────────────────────────────────
const distDir = path.join(__dirname, '..', 'dist')
app.use(express.static(distDir))

// SPA fallback — client-side routing (/video/:id, /records, …)
// Use middleware (not a route) to avoid Express 5 path-to-regexp wildcard issues.
app.use((req, res, next) => {
  // Only handle GET; pass non-GET to 404
  if (req.method !== 'GET') return next()
  // Already matched? (static file or data file already sent)
  if (res.headersSent) return
  res.sendFile(path.join(distDir, 'index.html'))
})

// ── Error handling ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: '服务器内部错误' })
})

app.listen(PORT, () => {
  console.log(`Shadow Voice API server running on http://localhost:${PORT}`)
})
