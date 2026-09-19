// 语块（chunk）提取：从字幕里抽出「可迁移、能直接开口说」的语块。
//
// 背景：视频详情页「智能重点词卡」原来的「核心短语」直接把整句字幕原样列出——
//      单词太碎、整句太长，都不是能直接搬去说话的东西。
// 这里用纯本地规则库抽出带省略号的语块，例如：
//   It turns out that...          （句首框架）
//   ...anytime soon               （句尾补充）
//   much more complicated than... （程度比较）
// 设计文档：docs/superpowers/specs/2026-09-19-chunk-extraction-design.md
// 纯函数：零依赖、零网络、零 AI 调用。

export const CHUNK_TYPE_LABELS = {
  opener: '句首框架',
  degree: '程度比较',
  tail: '句尾补充',
}

// 规则顺序即优先级：opener → degree → tail。
// 更具体的规则必须排在更泛化的规则前面（如 stem-dont-think-gonna 在 stem-i-dont-think 之前），
// 否则长语块会被短语块抢先命中。
export const CHUNK_RULES = [
  // 句首框架 opener
  { id: 'stem-it-turns-out', type: 'opener', re: /^\s*it turns out that\b/i, gloss: '结果（发现）……' },
  { id: 'stem-dont-think-gonna', type: 'opener', re: /^\s*(?:i|we) don['’]?t think [^.]{0,40}?\bgonna\b/i, gloss: '我觉得……不会……' },
  { id: 'stem-i-dont-think', type: 'opener', re: /^\s*i don['’]?t think\b/i, gloss: '我觉得……不……' },
  { id: 'stem-the-thing-is', type: 'opener', re: /^\s*the thing is\b/i, gloss: '问题是/关键在于……' },
  { id: 'stem-the-problem-is', type: 'opener', re: /^\s*the problem is\b/i, gloss: '问题在于……' },
  { id: 'stem-it-seems-like', type: 'opener', re: /^\s*it seems like\b/i, gloss: '看起来好像……' },
  { id: 'stem-you-know-what', type: 'opener', re: /^\s*you know what\b/i, gloss: '你知道吗……' },
  { id: 'stem-what-i-mean-is', type: 'opener', re: /^\s*what i mean is\b/i, gloss: '我的意思是……' },

  // 程度 / 比较 degree（排在 tail 之前：程度/比较结构的迁移价值高于 right now/for now 这类时间尾巴，
  // 每句上限 2 条时优先保住它有释义、更值得练的那条）
  { id: 'degree-much-more-than', type: 'degree', re: /\b(?:much|far|way|a lot|even)\s+(?:\w+er|more\s+\w+)\s+than\b/i, gloss: '比……得多' },
  { id: 'degree-as-as', type: 'degree', re: /\bas\s+(?!(?:soon|long|far|much)\b)\w+\s+as\b/i, gloss: '和……一样……' },
  { id: 'degree-more-and-more', type: 'degree', re: /\bmore and more\b/i, gloss: '越来越……' },
  { id: 'degree-too-to', type: 'degree', re: /\btoo\s+\w+\s+to\b/i, gloss: '太……以至于不能……' },

  // 句尾补充 tail
  { id: 'tail-anytime-soon', type: 'tail', re: /\bany ?time soon\s*[.!?]*$/i, gloss: '……短期内（不会）' },
  { id: 'tail-for-now', type: 'tail', re: /\bfor now\s*[.!?]*$/i, gloss: '……暂时' },
  { id: 'tail-right-now', type: 'tail', re: /\bright now\s*[.!?]*$/i, gloss: '……现在/马上' },
  { id: 'tail-at-the-moment', type: 'tail', re: /\bat the moment\s*[.!?]*$/i, gloss: '……此刻' },
  { id: 'tail-sooner-or-later', type: 'tail', re: /\bsooner or later\s*[.!?]*$/i, gloss: '……迟早' },
  { id: 'tail-in-the-end', type: 'tail', re: /\bin the end\s*[.!?]*$/i, gloss: '……最终' },
]

const MAX_CHUNKS_PER_SENTENCE = 2
const DEFAULT_LIMIT = 20

// 语块去重 key：小写、去标点、合并空白。
function normalizeChunkKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 拼装展示文本：去掉命中片段首尾空白/标点，再按类型加省略号。
function buildChunkText(type, raw) {
  const core = String(raw ?? '')
    .replace(/^[\s'"“”‘’]+/, '')
    .replace(/[\s.!?,;:'"“”‘’]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!core) return ''
  return type === 'tail' ? `...${core}` : `${core}...`
}

/**
 * 从字幕提取可迁移语块。
 * @param {Array<{textEn?:string,textCn?:string,startTime?:number}>} subtitles
 * @param {{limit?:number}} [options]
 * @returns {Array<{text:string,type:string,gloss:string,count:number,startTime:number,sentenceEn:string,sentenceCn:string}>}
 */
export function extractChunks(subtitles, { limit = DEFAULT_LIMIT } = {}) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return []
  const seen = new Map()

  for (const sub of subtitles) {
    if (!sub || typeof sub !== 'object') continue
    const en = String(sub.textEn ?? '').replace(/\s+/g, ' ').trim()
    if (!en) continue

    const matchedTypes = new Set()
    let matched = 0

    for (const rule of CHUNK_RULES) {
      if (matched >= MAX_CHUNKS_PER_SENTENCE) break
      if (matchedTypes.has(rule.type)) continue
      const m = rule.re.exec(en)
      if (!m) continue
      const text = buildChunkText(rule.type, m[0])
      if (!text) continue

      matchedTypes.add(rule.type)
      matched++

      const key = normalizeChunkKey(text)
      const existing = seen.get(key)
      if (existing) {
        existing.count++
        continue
      }
      seen.set(key, {
        text,
        type: rule.type,
        gloss: rule.gloss,
        count: 1,
        startTime: Number(sub.startTime) || 0,
        sentenceEn: en,
        sentenceCn: String(sub.textCn ?? '').trim(),
      })
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.startTime - b.startTime)
    .slice(0, limit)
}
