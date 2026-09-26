// 词卡数据构建：把 AI 产出的「重点单词 / 常用短语 / 地道表达 + 中文释义」
// 与本地字幕对齐，回填出现时点、频次与例句。
//
// 背景：视频详情页「智能重点词卡」原来只依赖字幕自带的 highlightWords，
// 像「机场实用英语」这类源数据没有关键词的视频，重点单词 tab 就是空的。
// 现在改为每条视频目录下放一份 wordcard.json（由 scripts/build-wordcards.mjs
// 用 AI 一次性生成、落盘），前端按需加载。
//
// 设计要点：AI 只负责「选词 + 写中文释义」，不给时间戳（给不准）。
// 时间戳/频次/例句全部由本模块在字幕里本地扫描回填；扫不到的条目直接丢弃，
// 避免点击后跳转到错误的位置。
//
// 纯函数、零依赖，脚本与前端共用；见 docs/superpowers/specs/*-video-wordcard-design.md。

const MAX_KEYWORDS = 30
const MAX_PHRASES = 25
const MAX_EXPRESSIONS = 20

// 归一化：小写、去标点（保留撇号）、合并空白——用于匹配 AI 给的词/短语。
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(text) {
  const n = normalizeText(text)
  return n ? n.split(' ') : []
}

function asArray(v) {
  return Array.isArray(v) ? v : []
}

function cleanStr(v) {
  return String(v ?? '').trim()
}

/**
 * 统计单个关键词在字幕里的出现次数与每次出现的句起点时间。
 * 按「整词」匹配（忽略大小写与标点），避免 book 命中 booking 之类。
 *
 * @param {Array} subtitles 字幕数组（含 textEn / startTime）
 * @param {string} word 关键词
 * @returns {{count:number, times:number[]}}
 */
export function countKeyword(subtitles, word) {
  const key = normalizeText(word)
  if (!key) return { count: 0, times: [] }
  let count = 0
  const times = []
  for (const sub of asArray(subtitles)) {
    const hits = tokenize(sub?.textEn).filter((t) => t === key).length
    if (hits > 0) {
      count += hits
      times.push(Number(sub?.startTime) || 0)
    }
  }
  return { count, times }
}

/**
 * 在字幕里定位短语（忽略大小写/标点，子串匹配），返回首次命中及例句。
 *
 * @param {Array} subtitles 字幕数组
 * @param {string} phrase 短语原文
 * @returns {{count:number,startTime:number,sentenceEn:string,sentenceCn:string}|null}
 */
export function locatePhrase(subtitles, phrase) {
  const key = normalizeText(phrase)
  if (!key) return null
  let count = 0
  let first = null
  for (const sub of asArray(subtitles)) {
    const en = normalizeText(sub?.textEn)
    if (!en) continue
    let from = 0
    let hits = 0
    let at
    while ((at = en.indexOf(key, from)) !== -1) {
      hits++
      from = at + key.length
    }
    if (hits > 0) {
      count += hits
      if (!first) first = sub
    }
  }
  if (!first) return null
  return {
    count,
    startTime: Number(first.startTime) || 0,
    sentenceEn: cleanStr(first.textEn),
    sentenceCn: cleanStr(first.textCn),
  }
}

/**
 * 组装 wordcard.json 内容。
 *
 * @param {Array} subtitles 该视频字幕
 * @param {{keywords?:Array,phrases?:Array,expressions?:Array}} aiJson AI 产出的原始结构
 * @param {{videoId?:string,generatedAt?:string,model?:string}} [meta]
 * @returns {object} wordcard 数据（version 1）
 */
export function buildWordcard(subtitles, aiJson, meta = {}) {
  const subs = asArray(subtitles)
  const src = aiJson && typeof aiJson === 'object' ? aiJson : {}

  const keywords = []
  const seenKw = new Set()
  for (const item of asArray(src.keywords)) {
    const word = cleanStr(item?.word)
    const key = normalizeText(word)
    if (!key || seenKw.has(key)) continue
    const stat = countKeyword(subs, word)
    if (stat.count === 0) continue
    seenKw.add(key)
    keywords.push({ word, meaning: cleanStr(item?.meaning), count: stat.count, times: stat.times })
  }
  keywords.sort((a, b) => b.count - a.count || (a.times[0] ?? 0) - (b.times[0] ?? 0))

  const phrases = []
  const seenPh = new Set()
  for (const item of asArray(src.phrases)) {
    const text = cleanStr(item?.text)
    const key = normalizeText(text)
    if (!key || seenPh.has(key)) continue
    const loc = locatePhrase(subs, text)
    if (!loc) continue
    seenPh.add(key)
    phrases.push({
      text,
      meaning: cleanStr(item?.meaning),
      count: loc.count,
      startTime: loc.startTime,
      sentenceEn: loc.sentenceEn,
      sentenceCn: loc.sentenceCn,
    })
  }
  phrases.sort((a, b) => b.count - a.count || a.startTime - b.startTime)

  const expressions = []
  const seenEx = new Set()
  for (const item of asArray(src.expressions)) {
    const textEn = cleanStr(item?.textEn)
    const key = normalizeText(textEn)
    if (!key || seenEx.has(key)) continue
    const exact = subs.find((s) => normalizeText(s?.textEn) === key)
    if (exact) {
      seenEx.add(key)
      expressions.push({
        textEn: cleanStr(exact.textEn),
        textCn: cleanStr(exact.textCn),
        meaning: cleanStr(item?.meaning),
        startTime: Number(exact.startTime) || 0,
      })
      continue
    }
    const loc = locatePhrase(subs, textEn)
    if (loc) {
      seenEx.add(key)
      expressions.push({
        textEn: loc.sentenceEn,
        textCn: loc.sentenceCn,
        meaning: cleanStr(item?.meaning),
        startTime: loc.startTime,
      })
    }
  }
  expressions.sort((a, b) => a.startTime - b.startTime)

  return {
    version: 1,
    videoId: cleanStr(meta.videoId),
    generatedAt: cleanStr(meta.generatedAt) || new Date().toISOString(),
    model: cleanStr(meta.model),
    keywords: keywords.slice(0, MAX_KEYWORDS),
    phrases: phrases.slice(0, MAX_PHRASES),
    expressions: expressions.slice(0, MAX_EXPRESSIONS),
  }
}
