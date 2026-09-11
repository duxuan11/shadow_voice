#!/usr/bin/env node
// 检查字幕数据里是否存在「同一句英文出现多次」的问题。
//
// 背景：跟读 / 填空(挖空) / 中译英 三个练习面板都取 video.subtitles[activeSubIndex]
// 逐句显示。如果 subtitles.json 里有两行相邻且英文完全相同的字幕，
// 逐句切换时就会看到同一句话连着出现两次（字幕列表里也会重复）。
//
// 用法：
//   node scripts/check-duplicate-subtitles.mjs            # 扫描本地 data/videos/*/subtitles.json
//   node scripts/check-duplicate-subtitles.mjs --api      # 扫描线上源站(与本地数据同源) shadowtalk.top
//   node scripts/check-duplicate-subtitles.mjs --all      # 同时扫描本地与线上
//
// 退出码：发现重复 → 1；没有重复 → 0。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const VIDEOS_DIR = path.join(DATA_DIR, 'videos')
const API_BASE = process.env.SHADOWTALK_BASE || 'https://shadowtalk.top'

const args = process.argv.slice(2)
const USE_API = args.includes('--api') || args.includes('--all')
const USE_LOCAL = args.includes('--all') || !USE_API

// 归一化：去掉标点、统一小写、合并空白，用于判定「是否同一句」
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function analyze(name, subs) {
  const rows = Array.isArray(subs) ? subs : []
  const adjacent = [] // 相邻重复：{index, text, prevTime, curTime}
  for (let i = 1; i < rows.length; i++) {
    const a = norm(rows[i - 1].textEn)
    const b = norm(rows[i].textEn)
    if (a && a === b) {
      adjacent.push({
        index: i,
        text: rows[i].textEn,
        prevTime: `${rows[i - 1].startTime}-${rows[i - 1].endTime}`,
        curTime: `${rows[i].startTime}-${rows[i].endTime}`,
      })
    }
  }
  // 任意位置重复（只统计出现次数 >=2 的句子）
  const seen = new Map()
  for (const r of rows) {
    const t = norm(r.textEn)
    if (!t) continue
    seen.set(t, (seen.get(t) || 0) + 1)
  }
  const scattered = [...seen.entries()].filter(([, c]) => c > 1)
  return { name, total: rows.length, adjacent, scattered }
}

async function fetchApiSubtitles(id, retries = 3) {
  let lastErr
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/api/videos/${id}/subtitles`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      return json?.data?.subtitles || []
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastErr
}

async function scanLocal() {
  if (!fs.existsSync(VIDEOS_DIR)) {
    console.log(`[local] 未找到数据目录：${VIDEOS_DIR}`)
    console.log('        （data/videos 被 .gitignore 忽略，请在部署了数据的机器上运行本脚本）')
    return { ran: false, results: [] }
  }
  const dirs = fs.readdirSync(VIDEOS_DIR).filter((d) =>
    fs.statSync(path.join(VIDEOS_DIR, d)).isDirectory()
  )
  const results = []
  for (const dir of dirs) {
    const p = path.join(VIDEOS_DIR, dir, 'subtitles.json')
    if (!fs.existsSync(p)) continue
    try {
      const subs = JSON.parse(fs.readFileSync(p, 'utf-8'))
      results.push(analyze(dir, subs))
    } catch (e) {
      console.log(`[local] ${dir}: 解析失败 ${e.message}`)
    }
  }
  return { ran: true, results }
}

async function scanApi() {
  const consPath = path.join(DATA_DIR, 'consolidated.json')
  const cons = JSON.parse(fs.readFileSync(consPath, 'utf-8'))
  const results = []
  const concurrency = 5
  let done = 0
  for (let i = 0; i < cons.length; i += concurrency) {
    const batch = cons.slice(i, i + concurrency)
    const settled = await Promise.all(
      batch.map(async (v) => {
        try {
          const subs = await fetchApiSubtitles(v.id)
          return analyze(v.episode_dir || v.id, subs)
        } catch {
          return null
        }
      })
    )
    for (const r of settled) if (r) results.push(r)
    done += batch.length
    process.stdout.write(`\r[api] 已检查 ${done}/${cons.length} ...`)
  }
  process.stdout.write('\n')
  return { ran: true, results }
}

function report(tag, results) {
  const withAdj = results.filter((r) => r.adjacent.length > 0)
  const withScatter = results.filter((r) => r.scattered.length > 0)
  const adjRows = withAdj.reduce((s, r) => s + r.adjacent.length, 0)
  console.log(`\n===== ${tag} =====`)
  console.log(`视频数：${results.length}`)
  console.log(`含【相邻重复句】的视频：${withAdj.length} 个，共 ${adjRows} 处重复`)
  console.log(`含【任意位置重复句】的视频：${withScatter.length} 个`)
  if (withAdj.length) {
    console.log('\n相邻重复样例（跟读/填空/中译英 逐句切换时会连读两次的就是这些）：')
    for (const r of withAdj.sort((a, b) => b.adjacent.length - a.adjacent.length).slice(0, 20)) {
      console.log(`  ${r.name}  (相邻重复 ${r.adjacent.length} 处 / 共 ${r.total} 句)`)
      for (const d of r.adjacent.slice(0, 3)) {
        console.log(`      #${d.index}: "${d.text}"`)
        console.log(`          前一段 ${d.prevTime}  ⇄  本段 ${d.curTime}`)
      }
    }
  }
  return withAdj.length > 0
}

async function main() {
  let found = false
  let checked = 0
  if (USE_LOCAL) {
    const { ran, results } = await scanLocal()
    if (ran) { checked += results.length; found = report('本地 data/videos', results) || found }
  }
  if (USE_API) {
    const { results } = await scanApi()
    checked += results.length
    found = report(`线上源站 ${API_BASE}`, results) || found
  }
  if (checked === 0) {
    console.log('\n结论：没有可检查的数据（本地数据缺失）——无法判定 ❓')
    process.exit(2)
  }
  console.log('\n结论：' + (found ? '存在「同一句重复」的语句 ❌' : '未发现重复 ✅'))
  process.exit(found ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
