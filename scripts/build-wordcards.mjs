#!/usr/bin/env node
// 为每条视频生成 wordcard.json（智能重点词卡数据），落盘到
// data/videos/<episode_dir>/wordcard.json。
//
// 流程：读字幕 → 把「序号. English | 中文」交给 AI 选词/写释义 → 本地回填
// 时间戳与频次（见 src/utils/wordcard.js）→ 写文件。
//
// 用法：
//   npm run wordcards                 # 只生成缺失的（有 AI 调用）
//   npm run wordcards -- --force      # 全部重新生成
//   npm run wordcards -- --video <id> # 只处理某条视频（按 info.id 或目录名匹配）
//   npm run wordcards -- --dry        # 只打印，不写文件
//
// 前置：.env 配好 AI_API_KEY / AI_BASE_URL / AI_MODEL。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { resolveDataDir } from '../server/lib/dataDir.cjs'
import { buildWordcard } from '../src/utils/wordcard.js'

const require = createRequire(import.meta.url)
const { chat, extractJson, isConfigured, AI_MODEL } = require('../server/services/ai/provider.cjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const DRY = args.includes('--dry')
const videoArgIdx = args.indexOf('--video')
const VIDEO_FILTER = videoArgIdx >= 0 ? args[videoArgIdx + 1] : null

const MAX_TRANSCRIPT_LINES = 400

function buildTranscript(subtitles) {
  return subtitles
    .slice(0, MAX_TRANSCRIPT_LINES)
    .map((s, i) => {
      const en = String(s.textEn ?? '').replace(/\s+/g, ' ').trim()
      const cn = String(s.textCn ?? '').replace(/\s+/g, ' ').trim()
      return `${i + 1}. ${en}${cn ? ` || ${cn}` : ''}`
    })
    .join('\n')
}

function buildPrompt(title, subtitles) {
  const system = [
    '你是英语学习内容编辑。根据给定视频字幕，挑选值得学习的重点单词、常用短语和地道表达。',
    '只输出 JSON，不要任何解释或 Markdown 代码块。',
  ].join('\n')
  const user = [
    `视频标题：${title || '(未命名)'}`,
    '',
    '任务：',
    '1. keywords：15~25 个重点单词。必须是字幕中真实出现的英文单词原形（按字幕里的形式，可含 -ing/-ed）。',
    '   word 只放单词本身，meaning 给简体中文释义（2~6 字）。',
    '2. phrases：10~20 个常用短语/固定搭配（2~5 个词），必须能在字幕里原样（忽略大小写/标点）找到。',
    '   text 放英文短语，meaning 给简体中文释义。',
    '3. expressions：5~15 条地道口语句子。textEn 必须是字幕里完整的一句英文，meaning 给该句的中文含义/用法点拨。',
    '不要输出时间戳，时间由程序回填。宁缺毋滥，找不到的不要编。',
    '',
    '字幕（格式：序号. English || 中文）：',
    buildTranscript(subtitles),
    '',
    '输出 JSON 结构：',
    '{"keywords":[{"word":"","meaning":""}],"phrases":[{"text":"","meaning":""}],"expressions":[{"textEn":"","meaning":""}]}',
  ].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

function listEpisodes(videosDir) {
  if (!fs.existsSync(videosDir)) return []
  return fs
    .readdirSync(videosDir)
    .filter((name) => fs.statSync(path.join(videosDir, name)).isDirectory())
    .sort()
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

async function processEpisode(epDir, videosDir) {
  const subsPath = path.join(videosDir, epDir, 'subtitles.json')
  const infoPath = path.join(videosDir, epDir, 'info.json')
  const outPath = path.join(videosDir, epDir, 'wordcard.json')

  if (!fs.existsSync(subsPath)) return { epDir, status: 'skip', reason: 'no subtitles.json' }
  const subtitles = readJson(subsPath)
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    return { epDir, status: 'skip', reason: 'empty subtitles' }
  }
  let info = {}
  if (fs.existsSync(infoPath)) {
    try { info = readJson(infoPath) } catch { info = {} }
  }
  const videoId = info.id || epDir

  if (VIDEO_FILTER && videoId !== VIDEO_FILTER && epDir !== VIDEO_FILTER) {
    return { epDir, status: 'skip', reason: 'filtered' }
  }
  if (fs.existsSync(outPath) && !FORCE) {
    return { epDir, status: 'skip', reason: 'wordcard.json exists (--force to overwrite)' }
  }

  const content = await chat(buildPrompt(info.title, subtitles), { temperature: 0.3, maxTokens: 3000 })
  const aiJson = extractJson(content)
  const wordcard = buildWordcard(subtitles, aiJson, {
    videoId,
    generatedAt: new Date().toISOString(),
    model: AI_MODEL,
  })

  if (DRY) {
    return {
      epDir,
      status: 'dry',
      keywords: wordcard.keywords.length,
      phrases: wordcard.phrases.length,
      expressions: wordcard.expressions.length,
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(wordcard, null, 2) + '\n', 'utf-8')
  return {
    epDir,
    status: 'written',
    keywords: wordcard.keywords.length,
    phrases: wordcard.phrases.length,
    expressions: wordcard.expressions.length,
  }
}

async function main() {
  if (!isConfigured()) {
    console.error('[wordcards] 未配置 AI_API_KEY，无法生成。请在 .env 配置后重试。')
    process.exit(1)
  }
  const dataDir = resolveDataDir(process.env.DATA_DIR, ROOT)
  const videosDir = path.join(dataDir, 'videos')
  const episodes = listEpisodes(videosDir)
  if (episodes.length === 0) {
    console.error(`[wordcards] 未找到视频目录：${videosDir}`)
    process.exit(1)
  }

  let written = 0
  let failed = 0
  for (const epDir of episodes) {
    try {
      const r = await processEpisode(epDir, videosDir)
      if (r.status === 'written') {
        written++
        console.log(`[wordcards] ✓ ${r.epDir}  单词${r.keywords} 短语${r.phrases} 表达${r.expressions}`)
      } else if (r.status === 'dry') {
        console.log(`[wordcards] (dry) ${r.epDir}  单词${r.keywords} 短语${r.phrases} 表达${r.expressions}`)
      } else {
        console.log(`[wordcards] - ${r.epDir} 跳过：${r.reason}`)
      }
    } catch (err) {
      failed++
      console.error(`[wordcards] ✗ ${epDir} 失败：${err.message}`)
    }
  }
  console.log(`[wordcards] 完成：写入 ${written}，失败 ${failed}，共 ${episodes.length} 条`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[wordcards] 异常：', err)
  process.exit(1)
})
