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
