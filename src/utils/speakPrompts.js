// 自由表达（看中文说英文）练习句构建：
// 从双语字幕里本地过滤出「适合中译英练习」的句子，供预提取脚本与前端兜底共用。
//
// 纯函数、零依赖。过滤是确定性的本地规则（零 token），不依赖 AI；
// AI 只负责在脚本里额外生成少量场景扩展句（见 scripts/build-speak-prompts.mjs）。

const DEFAULT_MAX_PROMPTS = 40
const CN_MIN_LEN = 4
const CN_MAX_LEN = 80
const CJK_RE = /[\u4e00-\u9fff]/
const LETTER_RE = /[a-zA-Z]/

/**
 * 从字幕数组里过滤出适合「中译英口语练习」的句子。
 * @param {Array} subtitles 字幕数组（含 textEn / textCn）
 * @param {{ maxPrompts?: number }} [options]
 * @returns {Array<{cn:string,en:string,source:'subtitle',subIndex:number}>}
 */
export function filterSubtitlesToPrompts(subtitles, options = {}) {
  if (!Array.isArray(subtitles)) return []
  const maxPrompts = Number.isFinite(options?.maxPrompts) && options.maxPrompts >= 0
    ? options.maxPrompts
    : DEFAULT_MAX_PROMPTS

  const prompts = []
  for (let i = 0; i < subtitles.length; i++) {
    const cn = String(subtitles[i]?.textCn ?? '').trim()
    const en = String(subtitles[i]?.textEn ?? '').replace(/\s+/g, ' ').trim()
    if (cn.length < CN_MIN_LEN || cn.length > CN_MAX_LEN) continue
    if (!CJK_RE.test(cn)) continue
    if (en.split(/\s+/).length < 2) continue
    if (!LETTER_RE.test(en)) continue
    prompts.push({ cn, en, source: 'subtitle', subIndex: i })
  }

  const cap = Math.max(0, Math.min(maxPrompts, subtitles.length - 1))
  return prompts.slice(0, cap)
}

/**
 * 组装 speak-prompts.json 的完整数据结构（字幕句 + AI 扩展句），给每条加数组下标 index。
 * @param {{videoId:string,title:string,subtitlePrompts:Array,extensionPrompts:Array,generatedAt:string}} args
 * @returns {{version:number,videoId:string,title:string,generatedAt:string,prompts:Array}}
 */
export function buildSpeakPromptsData({ videoId, title, subtitlePrompts = [], extensionPrompts = [], generatedAt }) {
  const prompts = [...subtitlePrompts, ...extensionPrompts].map((p, index) => ({
    index,
    cn: String(p.cn ?? ''),
    en: String(p.en ?? ''),
    source: p.source === 'ai_generated' ? 'ai_generated' : 'subtitle',
    subIndex: p.source === 'ai_generated' ? null : (Number.isInteger(p.subIndex) ? p.subIndex : null),
  }))
  return { version: 1, videoId, title, generatedAt, prompts }
}
