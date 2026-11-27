// 视频口音字段 → 评测引擎的 accent 参数。
//
// 官方取值（阿里云口语评测「句子跟读」参数表）：
//   "accent":"en" → 按英式发音评测；"accent":"am" → 按美式发音评测；不传 → 引擎默认。
// 实测（2026-11-26 spike）：同一段美音音频，只改该参数，总分差约 8 分（am 94~95 / en 86~88），
//   所以只能按视频口音传，不能全局固定。
// 注意：真实视频数据的 accent 字段取值尚未验证（本机 DATA_DIR 无数据），故用宽松匹配，
//   识别不出就返回 null（不传），等 30 天样本里观察到实际取值后再收紧。

const AMERICAN = /美|US|USA|America|American/i
const BRITISH = /英|UK|GB|Britain|British/i

/**
 * @param {unknown} accent 视频的 accent 原始值，如「美音」「US」「英音」
 * @returns {'am'|'en'|null}
 */
export function accentToEvalParam(accent) {
  if (typeof accent !== 'string') return null
  const v = accent.trim()
  if (!v) return null
  if (AMERICAN.test(v)) return 'am'
  if (BRITISH.test(v)) return 'en'
  return null
}
