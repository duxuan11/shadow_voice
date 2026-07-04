import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { pipeline } from 'stream'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, 'data')
const VIDEOS_DIR = path.join(DATA_DIR, 'videos')

// Scan episode folders and generate consolidated.json + meta.json
function generateDataIndex() {
  if (!fs.existsSync(VIDEOS_DIR)) return

  const epDirs = fs.readdirSync(VIDEOS_DIR)
    .filter(name => {
      const full = path.join(VIDEOS_DIR, name)
      return fs.statSync(full).isDirectory()
    })
    .sort()

  const videos = []
  const allLevels = new Set()
  const allTopics = new Set()
  const allAccents = new Set()

  for (const dirName of epDirs) {
    const epDir = path.join(VIDEOS_DIR, dirName)
    const infoPath = path.join(epDir, 'info.json')

    if (!fs.existsSync(infoPath)) continue

    let info
    try {
      info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'))
    } catch { continue }

    const vid = info.id || dirName

    // Read subtitles
    let subtitles = []
    const subsPath = path.join(epDir, 'subtitles.json')
    if (fs.existsSync(subsPath)) {
      try { subtitles = JSON.parse(fs.readFileSync(subsPath, 'utf-8')) } catch { /* ignore parse error */ }
    }

    // Collect levels, topics and accents
    const level = info.level || ''
    if (level) allLevels.add(level)

    const accent = info.accent || ''
    if (accent) allAccents.add(accent)

    let topics = info.topics || []
    if (typeof topics === 'string') {
      try { topics = JSON.parse(topics) } catch { topics = [topics] }
    }
    if (!topics.length && info.tags) topics = info.tags
    if (!topics.length && info.topic) topics = [info.topic]
    if (!topics.length && info.category) topics = [info.category]
    topics.forEach(t => allTopics.add(t))

    const topic = typeof info.topic === 'string' ? info.topic
      : (info.category || topics[0] || '')

    // Paths
    const videoRel = `/data/videos/${encodeURIComponent(dirName)}/video.mp4`
    const videoExists = fs.existsSync(path.join(epDir, 'video.mp4'))

    let thumbRel = null
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const p = path.join(epDir, `cover${ext}`)
      if (fs.existsSync(p)) {
        thumbRel = `/data/videos/${encodeURIComponent(dirName)}/cover${ext}`
        break
      }
    }

    videos.push({
      id: vid,
      title: info.title || '',
      description: info.description || '',
      topic,
      topics,
      level,
      accent,
      duration: info.duration || 0,
      creator_name: info.creator || info.creator_name || '',
      subtitle_count: subtitles.length,
      subtitles,
      video_local: videoExists ? videoRel : null,
      video_url: null,
      thumbnail_local: thumbRel,
      episode_dir: dirName,
    })
  }

  // Write consolidated.json
  const consolidatedPath = path.join(DATA_DIR, 'consolidated.json')
  fs.writeFileSync(consolidatedPath, JSON.stringify(videos, null, 2), 'utf-8')

  // Write meta.json
  const meta = {
    levels: [...allLevels].sort(),
    topics: [...allTopics].sort(),
    accents: [...allAccents].sort(),
    total_videos: videos.length,
  }
  const metaPath = path.join(DATA_DIR, 'meta.json')
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

  console.log(`[data-index] Generated index: ${videos.length} videos, ${allLevels.size} levels, ${allTopics.size} topics`)
}

// Custom plugin: serve /data/ directory and auto-generate index
function dataServerPlugin() {
  let generated = false

  return {
    name: 'data-server',
    configureServer(server) {
      // Generate index once at startup
      if (!generated) {
        generateDataIndex()
        generated = true
      }

      // Watch for changes in data/videos/ and regenerate
      server.watcher.add(VIDEOS_DIR)
      server.watcher.on('add', (filePath) => {
        if (filePath.includes('/data/videos/') && !filePath.includes('node_modules')) {
          generateDataIndex()
        }
      })
      server.watcher.on('unlink', (filePath) => {
        if (filePath.includes('/data/videos/') && !filePath.includes('node_modules')) {
          generateDataIndex()
        }
      })

      // Serve /data/ files with Range request support for video seeking
      server.middlewares.use('/data/', (req, res, next) => {
        const url = new URL(req.url, `http://${req.headers.host}`).pathname
        const decoded = decodeURIComponent(url)
        const filePath = path.resolve(__dirname, decoded.substring(1))

        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase()
          const mimeTypes = {
            '.json': 'application/json',
            '.mp4': 'video/mp4',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
          }
          const mimeType = mimeTypes[ext] || 'application/octet-stream'
          const stat = fs.statSync(filePath)
          const fileSize = stat.size

          res.setHeader('Content-Type', mimeType)
          res.setHeader('Cache-Control', 'max-age=3600')
          res.setHeader('Accept-Ranges', 'bytes')

          const range = req.headers.range
          if (range) {
            const parts = range.replace(/bytes=/, '').split('-')
            const start = parseInt(parts[0], 10)
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
            const chunkSize = (end - start) + 1

            res.statusCode = 206
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
            res.setHeader('Content-Length', chunkSize)

            const stream = fs.createReadStream(filePath, { start, end })
            pipeline(stream, res, (err) => { if (err && !res.headersSent) next(err) })
          } else {
            res.setHeader('Content-Length', fileSize)
            const stream = fs.createReadStream(filePath)
            pipeline(stream, res, (err) => { if (err && !res.headersSent) next(err) })
          }
          return
        }
        next()
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), dataServerPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
