#!/usr/bin/env node
// 为每条视频生成 speak-prompts.json（自由表达「看中文说英文」练习句），
// 落盘到 data/videos/<episode_dir>/speak-prompts.json（version 2）。
//
// 流程：读字幕 → **一次 AI 调用**（挑句 + 合并被逐行切开的残句 + 改写成地道英文 + 打难度
//      + 另给 5 条场景扩展句）→ 纯函数归一化校验 → 组装落盘。
//
// 用法：
//   npm run speak-prompts -- --force      # 全部重新生成（不加 --force 时已存在的文件会被跳过）
//   npm run speak-prompts -- --video <id> # 只处理某条视频（按 info.id 或目录名匹配）
//   npm run speak-prompts -- --dry        # 只打印整组题目，不写文件（不受"已存在则跳过"限制；会真的调 AI）
//
// 前置：.env 配好 AI_API_KEY / AI_BASE_URL / AI_MODEL。
// 无 key 时直接跳过并**保留旧文件**：逐行碎片正是本脚本要修的问题，没有 AI 就不该生成新文件。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { resolveDataDir } from '../server/lib/dataDir.cjs'
import { subtitleCapFor, normalizeSpeakPrompts, extractionVerdict, buildSpeakPromptsData } from '../src/utils/speakPrompts.js'

const require = createRequire(import.meta.url)
const { chat, extractJson, isConfigured, AI_MODEL } = require('../server/services/ai/provider.cjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const DRY = args.includes('--dry')
const videoArgIdx = args.indexOf('--video')
const VIDEO_FILTER = videoArgIdx >= 0 ? args[videoArgIdx + 1] : null

const MAX_EXTENSIONS = 5
const MAX_JSON_ATTEMPTS = 3
const MAX_EXTRACT_ATTEMPTS = 2
const LEVEL_BY_VIDEO_LEVEL = { 初级: '简单', 中级: '中等', 高级: '难' }

// 字幕全文（带 1-based 行号），不截断：长视频被截掉大半就挑不出全片最值得练的句子
function buildTranscript(subtitles) {
  return subtitles
    .map((s, i) => {
      const en = String(s.textEn ?? '').replace(/\s+/g, ' ').trim()
      const cn = String(s.textCn ?? '').replace(/\s+/g, ' ').trim()
      return `${i + 1}. ${en}${cn ? ` || ${cn}` : ''}`
    })
    .join('\n')
}

function buildExtractionPrompt({ title, targetLevel, cap, subtitles }) {
  const system = [
    '你是英语学习内容编辑，为「看中文说英文」口语练习出题。读者是中文母语者，目标是能把日常英语说出口。',
    '只输出一个紧凑的 JSON 对象，不要换行缩进、不要 Markdown 代码块、不要任何解释。',
  ].join('\n')
  const user = [
    `视频标题：${title || '(未命名)'}`,
    `本视频难度：${targetLevel || '简单'}（每条句子的 level 以这一档为中心，允许上下浮动一档）`,
    '',
    '字幕（逐行转录，格式：行号. English || 中文。注意：字幕未做断句，一句话常被拆成相邻的多行）：',
    buildTranscript(subtitles),
    '',
    `任务一：挑出最多 ${cap} 条最适合练口语的完整句子。宁缺毋滥——值得练的不足 ${cap} 条就给更少。`,
    '- 优先：日常生活高频、口语常用、学了马上能用上的表达。',
    '- 跳过：人名地名作品名等专名、纯称呼或语气词、没有完整意思的残片、需要大量背景才懂的句子、转录噪声无法修复的句子。',
    '- 合并：把属于同一句话的相邻行合并成一句完整的话（例：第 3~5 行是 "this guys is a" / "luggage trolley" / "where you put your bags"，应合成一句），并在 lines 里写出用到的行号（1-based）。',
    '- 改写英文：改成地道、自然、语法正确的现代口语英文；字幕可能有转录错误（如 "this guys is a" 要修正）。只修正表达，不要新增原文没有的信息。',
    '- 改写中文：补成完整自然的中文，不要保留残句语气；必须与英文同义。',
    `任务二：另外给 ${MAX_EXTENSIONS} 条「场景扩展句」：围绕本视频的场景（如航班、酒店、旅行、日常）再造 ${MAX_EXTENSIONS} 句日常生活里常用、马上能用上的口语，中英对照；不要与任务一挑出的句子重复或近似。`,
    '',
    'level 只能取「简单」「中等」「难」。',
    '',
    '输出 JSON 结构：',
    '{"sentences":[{"lines":[3,5],"cn":"中文句子","en":"English sentence","level":"简单"}],"extensions":[{"cn":"中文句子","en":"English sentence","level":"中等"}]}',
  ].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// 生成 + 解析 AI 返回的 JSON；解析失败把原始输出反馈给模型重试（对齐 build-wordcards）。
async function generateJsonWithRetry(messages) {
  let lastContent = ''
  let lastError = null
  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    const content = await chat(messages, { temperature: 0.3, maxTokens: 4000, timeoutMs: 120000 })
    lastContent = content
    try {
      return { json: extractJson(content), content }
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

// 提取 + 归一化；题量不合格（没有字幕句 / 扩展句不足 5 条）时带原因重试一轮
async function extractPrompts(messages, { cap, subtitleCount, targetLevel }) {
  let last = null
  for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
    const { json, content } = await generateJsonWithRetry(messages)
    const norm = normalizeSpeakPrompts(json, { cap, targetLevel, subtitleCount })
    last = norm
    const ok = norm.subtitlePrompts.length > 0 && norm.extensionPrompts.length >= MAX_EXTENSIONS
    if (ok || attempt === MAX_EXTRACT_ATTEMPTS) return norm
    messages.push(
      { role: 'assistant', content },
      { role: 'user', content: `上一轮不合格：${norm.warnings.join('；')}。请重新输出完整的 JSON 对象：字幕句不超过 ${cap} 条且至少 1 条，extensions 必须正好 ${MAX_EXTENSIONS} 条。` },
    )
  }
  return last
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

function difficultyTally(prompts) {
  return ['简单', '中等', '难'].map((lv) => `${lv}×${prompts.filter((p) => p.level === lv).length}`).join('/')
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
  if (fs.existsSync(outPath) && !FORCE && !DRY) {
    return { epDir, status: 'skip', reason: 'speak-prompts.json exists (--force to overwrite)' }
  }
  const cap = subtitleCapFor(subtitles.length)
  const targetLevel = LEVEL_BY_VIDEO_LEVEL[info.level] || null
  const messages = buildExtractionPrompt({ title, targetLevel, cap, subtitles })
  const norm = await extractPrompts(messages, { cap, subtitleCount: subtitles.length, targetLevel })

  const verdict = extractionVerdict(norm.subtitlePrompts.length, norm.extensionPrompts.length)
  if (!verdict.ok) {
    return {
      epDir,
      status: 'failed',
      reason: `题目不合格：${verdict.reason}（字幕句 ${norm.subtitlePrompts.length} / 扩展句 ${norm.extensionPrompts.length}）：${norm.warnings.join('；')}`,
    }
  }

  const data = buildSpeakPromptsData({
    videoId,
    title,
    level: info.level || null,
    model: AI_MODEL,
    subtitlePrompts: norm.subtitlePrompts,
    extensionPrompts: norm.extensionPrompts,
    generatedAt: new Date().toISOString(),
  })

  if (DRY) {
    console.log(`[speak-prompts] (dry) ${epDir}  字幕句 ${norm.stats.subtitle}/${cap} 扩展句 ${norm.stats.extension}  难度 ${difficultyTally(data.prompts)}`)
    for (const p of data.prompts) {
      const tag = p.source === 'ai_generated' ? '扩展' : '字幕'
      const span = p.subIndex === null ? '' : ` [${p.subIndex}${p.subIndexEnd !== p.subIndex ? `~${p.subIndexEnd}` : ''}]`
      console.log(`  ${String(p.index + 1).padStart(2)}. [${p.level || '无难度'}|${tag}]${span} ${p.cn} → ${p.en}`)
    }
    return { epDir, status: 'dry', subtitle: norm.stats.subtitle, generated: norm.stats.extension }
  }

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  return {
    epDir,
    status: 'written',
    subtitle: norm.stats.subtitle,
    generated: norm.stats.extension,
    levels: difficultyTally(data.prompts),
    warnings: norm.warnings,
  }
}

async function main() {
  if (!isConfigured()) {
    console.error('[speak-prompts] 未配置 AI_API_KEY，无法精选题目。请在 .env 配置后重试（旧文件保留）。')
    process.exit(1)
  }
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
        for (const w of r.warnings || []) console.warn(`[speak-prompts] ⚠ ${r.epDir} ${w}`)
        console.log(`[speak-prompts] ✓ ${r.epDir}  字幕句${r.subtitle} 扩展句${r.generated}  难度 ${r.levels}`)
      } else if (r.status === 'dry') {
        // 题目已在 processEpisode 里逐条打印
      } else if (r.status === 'failed') {
        failed++
        console.error(`[speak-prompts] ✗ ${r.epDir} 失败：${r.reason}`)
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
