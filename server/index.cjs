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

// API routes
app.use('/api/auth', authRoutes)
app.use('/api/dictation', dictationRoutes)
app.use('/api/vocab', vocabRoutes)

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`VidDict API server running on http://localhost:${PORT}`)
})
