// 发音诊断阈值与音素集合（纯数据，不含判定逻辑）。
//
// ⚠️ 阈值来源：2026-11-26 spike 实测（真机跑通阿里云 en.sent.score）。
//    同位置 `get|out`：自然连读（间隙 0ms）尾音素 /t/ 得 95 分；人为断开 480ms → 85 分；
//    断开 870ms → 77 分，且 fluency.pause 0→1。
//    当前**只有 TTS 美音数据，没有真实学习者数据**，全部数值为初值，待 30 天 dry-run 样本标定。
//    调参只改这里，不要改 pronunciationDiagnosis.js 的逻辑。

export const THRESHOLDS = {
  GAP_LINK: 60, // ms：词间间隙超过此值才算"断开"（实测 90ms 时引擎已判为边界）
  TAIL_LINK: 90, // 触发"连读缺失"的尾音素分上限
  GAP_STOP: 80, // ms：小于此值视为"紧挨着"（失爆语境）
  TAIL_STOP: 80, // 触发"失爆提示"的尾音素分上限
  TAIL_LOSS: 60, // 尾音素分低于此值 → 判定词尾辅音丢失（错误）
}

// 爆破音（IPA）：p b t d k g。失爆/吞音只在这类音上讨论。
export const STOP_CONSONANTS = new Set(['p', 'b', 't', 'd', 'k', 'g'])

// 注：弱读规则（层 2）需要的功能词表本轮不实现（层 1 三条规则都不使用它）。
