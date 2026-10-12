// 自由表达（看中文说英文）练习句构建：
// 正式题组由 scripts/build-speak-prompts.mjs 用 AI 精选生成到 speak-prompts.json；
// 本模块的逐行过滤只做**前端降级兜底**（零 token、确定性）。
//
// 兜底路径**不合并相邻行**：实测字幕无句末标点，本地启发式合并会并错句子，
// 并错会造出视频里根本不存在的句子，比碎片更糟。

const CAP_MAX = 20
const CAP_MIN = 5
const CN_MIN_LEN = 4
const CN_MAX_LEN = 80
const CJK_RE = /[\u4e00-\u9fff]/
const LETTER_RE = /[a-zA-Z]/

/**
 * 一条视频的字幕句数量上限：min(20, max(5, round(字幕行数 / 2)))。
 * 对齐用户口径：40 行字幕 → 20 句；短视频按比例降（22 行 → 11 句）。
 * @param {number} subtitleCount 字幕行数
 * @returns {number} 上限（非正数/非法 → 0）
 */
export function subtitleCapFor(subtitleCount) {
  const n = Number(subtitleCount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(CAP_MAX, Math.max(CAP_MIN, Math.round(n / 2)))
}

/**
 * 从字幕数组里过滤出适合「中译英口语练习」的句子（**降级兜底路径**）。
 * 逐行取、不合并相邻行；上限默认 subtitleCapFor(字幕行数)，可用 options.maxPrompts 覆盖。
 * @param {Array} subtitles 字幕数组（含 textEn / textCn）
 * @param {{ maxPrompts?: number }} [options]
 * @returns {Array<{cn:string,en:string,source:'subtitle',level:null,subIndex:number}>}
 */
export function filterSubtitlesToPrompts(subtitles, options = {}) {
  if (!Array.isArray(subtitles)) return []
  const maxPrompts = Number.isFinite(options?.maxPrompts) && options.maxPrompts >= 0
    ? options.maxPrompts
    : subtitleCapFor(subtitles.length)

  const prompts = []
  for (let i = 0; i < subtitles.length; i++) {
    const cn = String(subtitles[i]?.textCn ?? '').trim()
    const en = String(subtitles[i]?.textEn ?? '').replace(/\s+/g, ' ').trim()
    if (cn.length < CN_MIN_LEN || cn.length > CN_MAX_LEN) continue
    if (!CJK_RE.test(cn)) continue
    if (en.split(/\s+/).length < 2) continue
    if (!LETTER_RE.test(en)) continue
    prompts.push({ cn, en, source: 'subtitle', level: null, subIndex: i })
  }

  return prompts.slice(0, Math.max(0, maxPrompts))
}

const LEVELS = ['简单', '中等', '难']
const EN_MIN_WORDS = 3
const EN_MAX_WORDS = 30
const MAX_EXTENSIONS = 5

// 去重键：去掉空白与常见中英标点后比较（模型改写过的同义句往往只差标点/空格）
function dedupeKey(cn) {
  return String(cn).replace(/\s+/g, '').replace(/[\s，。、！？!?,.;:'"「」（）()]/g, '')
}

// lines（模型给的 1-based 字幕行号）→ 0-based 跨距；缺失/非法一律 null，不抛错
function normalizeLines(lines, subtitleCount) {
  const total = Number(subtitleCount)
  if (!Array.isArray(lines) || !Number.isFinite(total) || total <= 0) return { subIndex: null, subIndexEnd: null }
  const hits = lines
    .map((v) => (Number.isInteger(v) ? v - 1 : null))
    .filter((v) => v !== null && v >= 0 && v < total)
  if (hits.length === 0) return { subIndex: null, subIndexEnd: null }
  return { subIndex: Math.min(...hits), subIndexEnd: Math.max(...hits) }
}

/**
 * 归一化 AI 的提取结果：分类 → 丢弃 → 难度回落 → 行号跨距 → 去重 → 排序 → 截断。
 * 顺序是有意的（先排序再截断，保证留下的是视频靠前的句子）；任何畸形输入都不抛错，只丢条目。
 * 题目来源由**入参数组**决定（sentences → 字幕句，extensions → 扩展句），不读 item.source。
 * @param {{sentences?:Array,extensions?:Array}} raw AI 返回的原始 JSON
 * @param {{cap?:number,targetLevel?:string,subtitleCount?:number}} [options]
 * @returns {{subtitlePrompts:Array,extensionPrompts:Array,stats:{subtitle:number,extension:number,dropped:number},warnings:string[]}}
 *          stats 是**截断后**的条数（与两个数组长度一致）
 */
export function normalizeSpeakPrompts(raw, { cap, targetLevel, subtitleCount } = {}) {
  const warnings = []
  const src = raw && typeof raw === 'object' ? raw : {}
  const rawSentences = Array.isArray(src.sentences) ? src.sentences : []
  const rawExtensions = Array.isArray(src.extensions) ? src.extensions : []
  const target = LEVELS.includes(targetLevel) ? targetLevel : null
  let dropped = 0

  const keep = (item) => {
    const cn = String(item?.cn ?? '').trim()
    const en = String(item?.en ?? '').replace(/\s+/g, ' ').trim()
    if (!cn || !en) { dropped++; return null }
    if (!CJK_RE.test(cn)) { dropped++; return null }
    if (!LETTER_RE.test(en)) { dropped++; return null }
    const words = en.split(/\s+/).length
    if (words < EN_MIN_WORDS || words > EN_MAX_WORDS) { dropped++; return null }
    return { cn, en }
  }
  const levelOf = (item) => (LEVELS.includes(item?.level) ? item.level : target)

  const seen = new Set()
  const subtitlePrompts = []
  for (const item of rawSentences) {
    const base = keep(item)
    if (!base) continue
    const key = dedupeKey(base.cn)
    if (seen.has(key)) { dropped++; continue }
    seen.add(key)
    subtitlePrompts.push({ ...base, level: levelOf(item), ...normalizeLines(item?.lines, subtitleCount) })
  }
  const extensionPrompts = []
  for (const item of rawExtensions) {
    const base = keep(item)
    if (!base) continue
    const key = dedupeKey(base.cn)
    if (seen.has(key)) { dropped++; continue }
    seen.add(key)
    extensionPrompts.push({ ...base, level: levelOf(item) })
  }

  // 排序：有行号的按行号升序，漏行号的按原顺序排在其后（sort 稳定）
  subtitlePrompts.sort((a, b) => {
    if (a.subIndex === null && b.subIndex === null) return 0
    if (a.subIndex === null) return 1
    if (b.subIndex === null) return -1
    return a.subIndex - b.subIndex
  })

  // 跨距重复：模型重复出题，只记日志不丢题
  const spans = new Set()
  for (const p of subtitlePrompts) {
    if (p.subIndex === null) continue
    const span = p.subIndex + ',' + p.subIndexEnd
    if (spans.has(span)) warnings.push('字幕句跨距重复：[' + p.subIndex + ',' + p.subIndexEnd + ']')
    spans.add(span)
  }

  const limit = Number.isFinite(cap) && cap >= 0 ? cap : subtitleCapFor(subtitleCount)
  const keptSubtitles = subtitlePrompts.slice(0, Math.max(0, limit))
  const keptExtensions = extensionPrompts.slice(0, MAX_EXTENSIONS)

  if (keptSubtitles.length === 0) warnings.push('没有可用的字幕句')
  if (keptExtensions.length < MAX_EXTENSIONS) warnings.push('扩展句不足 ' + MAX_EXTENSIONS + ' 条（' + keptExtensions.length + ' 条）')

  return {
    subtitlePrompts: keptSubtitles,
    extensionPrompts: keptExtensions,
    stats: { subtitle: keptSubtitles.length, extension: keptExtensions.length, dropped },
    warnings,
  }
}

/**
 * 组装 speak-prompts.json（version 2），给每条加数组下标 index。
 * 题目来源由**入参数组**决定（subtitlePrompts → subtitle，extensionPrompts → ai_generated），
 * 不读条目上的 source 字段——模型漏字段时按来源猜会把字幕句标成扩展句，那会骗到用户。
 * @param {{videoId:string,title:string,level?:string|null,model?:string|null,subtitlePrompts?:Array,extensionPrompts?:Array,generatedAt:string}} args
 * @returns {{version:number,videoId:string,title:string,level:string|null,model:string|null,generatedAt:string,prompts:Array}}
 */
export function buildSpeakPromptsData({
  videoId, title, level = null, model = null,
  subtitlePrompts = [], extensionPrompts = [], generatedAt,
}) {
  const mapOne = (p, source) => {
    const isSubtitle = source === 'subtitle'
    return {
      cn: String(p?.cn ?? ''),
      en: String(p?.en ?? ''),
      source,
      level: p?.level ?? null,
      subIndex: isSubtitle && Number.isInteger(p?.subIndex) ? p.subIndex : null,
      subIndexEnd: isSubtitle && Number.isInteger(p?.subIndexEnd) ? p.subIndexEnd : null,
    }
  }
  const prompts = [
    ...subtitlePrompts.map((p) => mapOne(p, 'subtitle')),
    ...extensionPrompts.map((p) => mapOne(p, 'ai_generated')),
  ].map((p, index) => ({ index, ...p }))
  return { version: 2, videoId, title, level, model, generatedAt, prompts }
}

/**
 * 练习页要显示的标识：来源标识（场景扩展）+ 难度标识。
 * 只认 `source === 'ai_generated'` 与合法的 `level`；旧 v1 文件没有 level → 只显示来源标识，
 * 兜底题目 `level` 为 null → 不显示难度，都不抛错。
 * @param {{source?:string,level?:string|null}|null|undefined} prompt
 * @returns {Array<{kind:'extension'|'level',text:string}>} 新数组
 */
export function promptBadges(prompt) {
  const badges = []
  if (prompt?.source === 'ai_generated') badges.push({ kind: 'extension', text: '场景扩展' })
  if (LEVELS.includes(prompt?.level)) badges.push({ kind: 'level', text: prompt.level })
  return badges
}
const MIN_EXTENSIONS = 3

/**
 * 判定一次 AI 提取结果能不能落盘：没有字幕句、或扩展句少于 minExtensions → 不合格。
 * 脚本据此保留旧文件并以非 0 退出（绝不落盘空/畸形的题组）。
 * @param {number} subtitleCount 归一化后的字幕句条数
 * @param {number} extensionCount 归一化后的扩展句条数
 * @param {number} [minExtensions] 扩展句下限，默认 3（3~4 条算合格，只告警）
 * @returns {{ok:boolean, reason:string}} 不合格时 reason 说明原因
 */
export function extractionVerdict(subtitleCount, extensionCount, minExtensions = MIN_EXTENSIONS) {
  const subs = Number(subtitleCount)
  const exts = Number(extensionCount)
  const min = Number(minExtensions)
  if (!Number.isFinite(subs) || subs <= 0) return { ok: false, reason: '没有可用的字幕句' }
  if (!Number.isFinite(exts) || exts < min) {
    return { ok: false, reason: `扩展句不足 ${min} 条（${Number.isFinite(exts) ? exts : 0} 条）` }
  }
  return { ok: true, reason: '' }
}
