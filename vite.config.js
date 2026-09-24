import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { pipeline } from 'stream'
import process from 'node:process'
import { fileURLToPath } from 'url'
import { resolveDataDir } from './server/lib/dataDir.cjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Scan episode folders and generate consolidated.json + meta.json
function generateDataIndex(DATA_DIR, VIDEOS_DIR) {
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

    // Count subtitles (don't embed them — VideoDetail loads per-episode)
    let subtitleCount = 0
    const subsPath = path.join(epDir, 'subtitles.json')
    if (fs.existsSync(subsPath)) {
      try {
        const subs = JSON.parse(fs.readFileSync(subsPath, 'utf-8'))
        subtitleCount = Array.isArray(subs) ? subs.length : 0
      } catch { /* ignore parse error */ }
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
    // info.tags may be a JSON-encoded string (e.g., "[\"tag1\"]")
    if (typeof topics === 'string') {
      try { topics = JSON.parse(topics) } catch { topics = [topics] }
    }
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
      subtitle_count: subtitleCount,
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
function dataServerPlugin(DATA_DIR, VIDEOS_DIR) {
  let generated = false

  return {
    name: 'data-server',
    configureServer(server) {
      // Generate index once at startup
      if (!generated) {
        generateDataIndex(DATA_DIR, VIDEOS_DIR)
        generated = true
      }

      // Watch for changes in <DATA_DIR>/videos/ and regenerate.
      // 用原生 fs.watch 浅监听顶层目录(仅 1 个 inotify 实例,不递归子目录):
      // 新增/删除视频目录会触发父目录 rename 事件 → 重建索引。
      // 不要用 server.watcher.add() —— chokidar 递归会占满 inotify 配额(EMFILE)。
      // 目录不存在时跳过（可用 .env 的 DATA_DIR 指定；缺失不应让 dev server 崩溃）。
      if (fs.existsSync(VIDEOS_DIR)) {
        const videosWatcher = fs.watch(VIDEOS_DIR, (_event, filename) => {
          if (filename && !String(filename).includes('node_modules')) {
            generateDataIndex(DATA_DIR, VIDEOS_DIR)
          }
        })
        server.httpServer?.on('close', () => {
          try { videosWatcher.close() } catch { /* ignore */ }
        })
      } else {
        console.log(`[data-server] 未找到数据目录，跳过监听：${VIDEOS_DIR}（可在 .env 用 DATA_DIR 指定）`)
      }

      // Serve /data/ files with Range request support for video seeking.
      // 路径统一从 DATA_DIR 解析，并做越界防护（decodeURIComponent 可能含 ..）。
      server.middlewares.use('/data/', (req, res, next) => {
        const rawPath = req.originalUrl || req.url || ''
        const url = new URL(rawPath, `http://${req.headers.host || 'localhost'}`).pathname
        const rel = decodeURIComponent(url).replace(/^\/data(?=\/|$)/, '').replace(/^\/+/, '')
        const filePath = path.resolve(DATA_DIR, rel)
        const withinData = filePath === DATA_DIR || filePath.startsWith(DATA_DIR + path.sep)
        if (!withinData) return next()

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

export default defineConfig(({ mode }) => {
  // 读取 .env（含 DATA_DIR）；空值默认 <root>/data。前缀 '' 表示读取全部变量。
  // 优先级：进程环境变量 > .env（便于 shell/CI 临时覆盖）。
  const env = loadEnv(mode, __dirname, '')
  const DATA_DIR = resolveDataDir(process.env.DATA_DIR || env.DATA_DIR, __dirname)
  const VIDEOS_DIR = path.join(DATA_DIR, 'videos')

  return {
    plugins: [react(), tailwindcss(), dataServerPlugin(DATA_DIR, VIDEOS_DIR)],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': 'http://localhost:3001'
      }
    }
  }
})
