// 视频索引与字幕读取（本地 JSON 数据目录）。
// 从 routes/conversation.cjs 抽出，供 conversation / dialogue 两个路由共用。
const fs = require('fs')
const path = require('path')

const DATA_DIR = process.env.SHADOW_VOICE_DATA_DIR || path.join(__dirname, '..', '..', 'data')

let indexCache = { at: 0, videos: null }

function resolveDataDirPath() {
  return DATA_DIR
}

function loadVideoIndex() {
  const p = path.join(DATA_DIR, 'consolidated.json')
  if (!fs.existsSync(p)) return []
  const mtime = fs.statSync(p).mtimeMs
  if (indexCache.videos && mtime === indexCache.at) return indexCache.videos
  const videos = JSON.parse(fs.readFileSync(p, 'utf-8'))
  indexCache = { at: mtime, videos }
  return videos
}

function loadSubtitles(episodeDir) {
  const p = path.join(DATA_DIR, 'videos', episodeDir, 'subtitles.json')
  if (!fs.existsSync(p)) return []
  const subs = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return Array.isArray(subs) ? subs : []
}

function findVideo(videoId) {
  const videos = loadVideoIndex()
  return videos.find((v) => v.id === videoId) || null
}

module.exports = { loadVideoIndex, loadSubtitles, findVideo, resolveDataDirPath }
