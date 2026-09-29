#!/usr/bin/env node
// 生成前端可用的英文音标（IPA）查找表：src/data/phonetics.js
//
// 数据来源：ipa-dict 的 en_US 词表（IPA，含词形变化）。
// 词表来源：所有视频 wordcard.json 的 keywords + 字幕 highlightWords。
//
// 用法：npm run phonetics
// 说明：wordcard.json / subtitles.json 位于 DATA_DIR（默认 ./data/videos，
// 生产为挂载卷）。生成结果提交进仓库，前端无需任何运行时依赖。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { resolveDataDir } from '../server/lib/dataDir.cjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ipa-dict 的 package.json exports 非标准，直接按路径 require。
const IPA_DICT_PATH = path.join(ROOT, 'node_modules', 'ipa-dict', 'lib', 'en_US.js')

// 规范化单词 key：小写、去标点（保留撇号）、合并空白。
export function normalizeWord(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 取词表第一个读音，统一为 /.../ 形式。
export function pickIpa(entry) {
  const raw = Array.isArray(entry) ? entry[0] : entry
  if (!raw || typeof raw !== 'string') return ''
  const core = raw.trim().replace(/^\/+|\/+$/g, '').trim()
  return core ? `/${core}/` : ''
}

function loadDictionary() {
  if (!fs.existsSync(IPA_DICT_PATH)) {
    throw new Error(`未找到 ipa-dict（${IPA_DICT_PATH}），请先 npm install`)
  }
  const mod = require(IPA_DICT_PATH)
  return mod.default || mod
}

function collectWords(videosDir) {
  const words = new Set()
  if (!fs.existsSync(videosDir)) return words
  for (const dir of fs.readdirSync(videosDir)) {
    const base = path.join(videosDir, dir)
    let stat
    try { stat = fs.statSync(base) } catch { continue }
    if (!stat.isDirectory()) continue

    const cardPath = path.join(base, 'wordcard.json')
    if (fs.existsSync(cardPath)) {
      try {
        const card = JSON.parse(fs.readFileSync(cardPath, 'utf-8'))
        for (const kw of card.keywords || []) {
          const key = normalizeWord(kw?.word)
          if (key && !key.includes(' ')) words.add(key)
        }
      } catch { /* 单文件损坏不影响其余 */ }
    }

    const subsPath = path.join(base, 'subtitles.json')
    if (fs.existsSync(subsPath)) {
      try {
        const subs = JSON.parse(fs.readFileSync(subsPath, 'utf-8'))
        for (const sub of Array.isArray(subs) ? subs : []) {
          for (const hw of sub?.highlightWords || []) {
            const key = normalizeWord(hw)
            if (key && !key.includes(' ')) words.add(key)
          }
        }
      } catch { /* ignore */ }
    }
  }
  return words
}

function main() {
  const dataDir = resolveDataDir(process.env.DATA_DIR, ROOT)
  const videosDir = path.join(dataDir, 'videos')
  const words = [...collectWords(videosDir)].sort()
  const dict = loadDictionary()

  const map = {}
  let missing = 0
  for (const word of words) {
    const ipa = pickIpa(dict.get(word) || dict.get(word.replace(/'/g, '')))
    if (ipa) map[word] = ipa
    else missing++
  }

  const outDir = path.join(ROOT, 'src', 'data')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'phonetics.js')
  const banner = '// 自动生成，请勿手改。来源：ipa-dict en_US（IPA）。\n// 重新生成：npm run phonetics\n'
  fs.writeFileSync(outPath, `${banner}export default ${JSON.stringify(map)}\n`, 'utf-8')

  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0)
  console.log(`[phonetics] 词表 ${words.length}，命中 ${Object.keys(map).length}，缺失 ${missing}，写入 ${path.relative(ROOT, outPath)}（${sizeKb} KB）`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
