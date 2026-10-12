#!/usr/bin/env node
// 为每条视频生成 speak-prompts.json（自由表达「看中文说英文」练习句），
// 落盘到 data/videos/<episode_dir>/speak-prompts.json。
//
// 流程：读字幕 → 本地规则过滤出适合中译英练习的句子（零 token）→
// 配了 AI key 时再生成 ≤5 条场景相关扩展句（唯一一次 AI 调用）→ 组装写文件。
//
// 用法：
//   npm run speak-prompts                 # 只生成缺失的（有 AI key 才有扩展句）
//   npm run speak-prompts -- --force      # 全部重新生成
//   npm run speak-prompts -- --video <id> # 只处理某条视频（按 info.id 或目录名匹配）
//   npm run speak-prompts -- --dry        # 只打印，不写文件
//
// 前置：.env 配好 AI_API_KEY / AI_BASE_URL / AI_MODEL（可选，无 key 时纯字幕句也能生成）。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { resolveDataDir } from '../server/lib/dataDir.cjs'
import { filterSubtitlesToPrompts, buildSpeakPromptsData } from '../src/utils/speakPrompts.js'

const require = createRequire(import.meta.url)
const { chat, extractJson, isConfigured, AI_MODEL } = require('../server/services/ai/provider.cjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const DRY = args.includes('--dry')
const videoArgIdx = args.indexOf('--video')
const VIDEO_FILTER = videoArgIdx >= 0 ? args[videoArgIdx + 1] : null

const MAX_PROMPTS = 40
const MAX_EXTENSIONS = 5
const MAX_TRANSCRIPT_LINES = 150

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

function buildExtensionsPrompt(title, subtitles) {
  const system = [
    '你是英语学习内容编辑。根据视频标题与字幕内容，为「看中文说英文」练习生成少量与该视频场景相关的日常中文口语句及其标准英文翻译。',
    '只输出一个紧凑的单行 JSON 对象，不要换行、不要缩进、不要 Markdown 代码块、不要任何解释。',
  ].join('\n')
  const user = [
    `视频标题：${title || '(未命名)'}`,
    '',
    '任务：生成 3~5 条与该视频场景相关的日常口语句（如航班、酒店、旅行等场景），',
    '要求：中文自然、英文地道、长度适中（英文 6~18 词）、不要与字幕原句完全重复。',
    '',
    '字幕（格式：序号. English || 中文）：',
    buildTranscript(subtitles),
    '',
    '输出 JSON 结构：',
    '{"sentences":[{"cn":"中文句子","en":"标准英文翻译"}]}',
  ].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// 生成 + 解析 AI 返回的 JSON；解析失败反馈给模型重试（对齐 build-wordcards）。
const MAX_JSON_ATTEMPTS = 3

async function generateJsonWithRetry(messages) {
  let lastError = null
  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    const content = await chat(messages, { temperature: 0.3, maxTokens: 4000, timeoutMs: 120000 })
    try {
      return extractJson(content)
    } catch (err) {
      lastError = err
      messages.push(
        { role: 'assistant', content },
        { role: 'user', content: `你刚才的输出无法解析为 JSON（错误：${err.message}）。请重新只输出一个合法的 JSON 对象，不要包含任何解释、注释、Markdown 代码块或多余内容。` },
      )
    }
  }
  throw new Error(`AI 连续 ${MAX_JSON_ATTEMPTS} 次输出非法 JSON：${lastError?.message}`)
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
  const outPath = path.join(videosDir, epDir, 'speak-prompts.json')

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
  const title = info.title || epDir

  if (VIDEO_FILTER && videoId !== VIDEO_FILTER && epDir !== VIDEO_FILTER) {
    return { epDir, status: 'skip', reason: 'filtered' }
  }
  if (fs.existsSync(outPath) && !FORCE) {
    return { epDir, status: 'skip', reason: 'speak-prompts.json exists (--force to overwrite)' }
  }

  const subtitlePrompts = filterSubtitlesToPrompts(subtitles, { maxPrompts: MAX_PROMPTS })

  let extensionPrompts = []
  if (isConfigured() && subtitlePrompts.length > 0) {
    const aiJson = await generateJsonWithRetry(buildExtensionsPrompt(title, subtitles))
    const sentences = Array.isArray(aiJson?.sentences) ? aiJson.sentences : []
    extensionPrompts = sentences
      .slice(0, MAX_EXTENSIONS)
      .filter((s) => String(s?.cn ?? '').trim() && String(s?.en ?? '').trim())
      .map((s) => ({ cn: String(s.cn).trim(), en: String(s.en).trim(), source: 'ai_generated', subIndex: null }))
  }

  const data = buildSpeakPromptsData({
    videoId,
    title,
    subtitlePrompts,
    extensionPrompts,
    generatedAt: new Date().toISOString(),
  })

  if (DRY) {
    return {
      epDir,
      status: 'dry',
      subtitle: subtitlePrompts.length,
      generated: extensionPrompts.length,
      model: extensionPrompts.length > 0 ? AI_MODEL : null,
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  return {
    epDir,
    status: 'written',
    subtitle: subtitlePrompts.length,
    generated: extensionPrompts.length,
  }
}

async function main() {
  const dataDir = resolveDataDir(process.env.DATA_DIR, ROOT)
  const videosDir = path.join(dataDir, 'videos')
  const episodes = listEpisodes(videosDir)
  if (episodes.length === 0) {
    console.log(`[speak-prompts] 未找到视频目录：${videosDir}`)
    return
  }

  let written = 0
  let failed = 0
  for (const epDir of episodes) {
    try {
      const r = await processEpisode(epDir, videosDir)
      if (r.status === 'written') {
        written++
        console.log(`[speak-prompts] ✓ ${r.epDir}  字幕句${r.subtitle} 扩展句${r.generated}`)
      } else if (r.status === 'dry') {
        console.log(`[speak-prompts] (dry) ${r.epDir}  字幕句${r.subtitle} 扩展句${r.generated}${r.model ? ` (${r.model})` : ''}`)
      } else {
        console.log(`[speak-prompts] - ${r.epDir} 跳过：${r.reason}`)
      }
    } catch (err) {
      failed++
      console.error(`[speak-prompts] ✗ ${epDir} 失败：${err.message}`)
    }
  }
  console.log(`[speak-prompts] 完成：写入 ${written}，失败 ${failed}，共 ${episodes.length} 条`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[speak-prompts] 异常：', err)
  process.exit(1)
})
