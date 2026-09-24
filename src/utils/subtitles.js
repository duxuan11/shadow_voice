// 字幕清洗：合并「相邻且同一句」的重复字幕条目。
//
// 背景：字幕源数据（shadowtalk.top 的 /api/videos/:id/subtitles，经 download_videos.py
// 原样落盘为 data/videos/<episode>/subtitles.json）里存在少量“相邻两条英文完全相同”的
// 记录——同一句话被切成两段连续时间轴（有的视频是内容本身把该句念了两遍）。
// 前端各练习面板（跟读 / 填空 / 中译英 / 听写）都是按索引逐句取
// subtitles[activeSubIndex] 渲染，于是逐句切换时会看到同一句连着出现两次。
//
// 这里在“数据入口”统一合并：把连续重复的条目并成一条，startTime 取最早、
// endTime 取最晚（保留第一段的 id / 中文 / 高亮词），既不重复显示、也不丢音频。
//
// 检测脚本见 scripts/check-duplicate-subtitles.mjs。

// 归一化：去标点、统一小写、合并空白——用于判定“是否同一句”。
// 与 scripts/check-duplicate-subtitles.mjs 中的 norm() 保持一致。
export function normalizeSentence(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function toTime(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 合并相邻重复字幕。
 * @param {Array} subs 原始 subtitles 数组
 * @returns {Array} 合并后的新数组（不修改入参）
 */
export function mergeAdjacentDuplicateSubtitles(subs) {
  if (!Array.isArray(subs) || subs.length === 0) return []

  const out = []
  for (const sub of subs) {
    if (!sub || typeof sub !== 'object') continue
    const prev = out[out.length - 1]
    const key = normalizeSentence(sub.textEn)

    if (prev && key && normalizeSentence(prev.textEn) === key) {
      // 与上一条同句 → 合并时间区间，不新增条目
      const pStart = toTime(prev.startTime)
      const pEnd = toTime(prev.endTime)
      const sStart = toTime(sub.startTime)
      const sEnd = toTime(sub.endTime)
      if (sStart != null) prev.startTime = pStart == null ? sStart : Math.min(pStart, sStart)
      if (pEnd != null || sEnd != null) {
        prev.endTime = Math.max(pEnd ?? -Infinity, sEnd ?? -Infinity)
      }
      // 第一条缺中文时，用重复条目的中文补上
      if (!prev.textCn && sub.textCn) prev.textCn = sub.textCn
      continue
    }

    out.push({ ...sub })
  }
  return out
}

// 起止边界的容差（秒）。视频时间轴按 timescale 量化、浏览器 currentTime 又按
// 微秒取整，seek 到字幕 startTime 时实际值常比 startTime 小 1~2µs。相邻字幕首尾
// 相接（上句 endTime === 下句 startTime）时，这点偏差会让时间落回上一句区间，
// 于是「下一句」跳转后又被判定回上一句。比较下界时留一点容差即可。
const START_BOUNDARY_EPSILON = 1e-3

/**
 * 找出时间 t 对应的当前字幕下标。
 *
 * 相邻字幕的时间轴可能重叠：数据本身就有重叠，相邻重复合并后又会把 endTime 拉宽，
 * 重叠更常见。若像 findIndex 那样取「第一个命中」，在重叠区间里跳到下一句的起点时
 * 仍会命中上一句，导致 activeSubIndex 退回上一句（看起来就是同一句又出现一次）。
 * 因此这里取「最后一个命中」——较晚开始、仍覆盖 t 的那条。
 *
 * 另外，t 落在某句 startTime 略前一点点（seek 量化误差，见 START_BOUNDARY_EPSILON）
 * 时也视为命中该句，避免首尾相接的边界上「下一句」跳转失效。
 *
 * @param {Array} subs 字幕数组
 * @param {number} time 当前播放时间（秒）
 * @returns {number} 命中的下标；无命中返回 -1
 */
export function findActiveSubtitleIndex(subs, time) {
  if (!Array.isArray(subs) || subs.length === 0) return -1
  const t = Number(time)
  if (!Number.isFinite(t)) return -1
  for (let i = subs.length - 1; i >= 0; i--) {
    const sub = subs[i]
    if (!sub) continue
    const start = Number(sub.startTime)
    const end = Number(sub.endTime)
    if (t >= start - START_BOUNDARY_EPSILON && t <= end) return i
  }
  return -1
}
