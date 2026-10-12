// 自由表达（看中文说英文）评分服务：
// 输入中文原句 + 参考答案 + 学习者说的英文，输出结构化评分。
// 纯函数/可测部分（prompt 构建、结果归一化）与 AI 调用分离；
// AI 输出畸形时不伪造分数（score=null + parseError），由路由层提示重试。

const { extractJson } = require('./provider.cjs')

const SYSTEM = [
  '你是面向中国英语学习者的英语口语教练。学习者看到一句中文，用英语把它说出来；你要评价他说得对不对、地不地道。',
  '',
  '评分规则：',
  '- 给出的「参考答案」只是其中一种正确说法，不是唯一答案——凡是语法正确、自然、且意思吻合的英文都应给高分。',
  '- 重点检查：语法、用词、搭配是否地道、是否漏掉或曲解了关键信息、句子是否完整。',
  '- 如果学习者说的英文传达了不同的意思，属于正确性问题，要扣分并在 issues 里指出。',
  '',
  '只输出一个 JSON 对象，结构如下：',
  '{"score":85,"issues":[{"type":"grammar|word_choice|collocation|naturalness|incomplete","location":"学习者说的片段","problem":"问题描述（中文）","suggestion":"修改建议（中文）","better":"该片段更地道的英文"}],"better":"整句更地道的英文说法","praise":"具体夸一句（中文）","lowScoreHint":"score<70 时给一句具体提示（中文），否则给空字符串"}',
].join('\n')

function buildReviewPrompt({ cn, en, userText }) {
  const user = [
    `中文句子：${cn}`,
    '',
    `参考答案：${en}`,
    '',
    `学习者说的英文：${userText}`,
    '',
    '请评分，并只输出上述 JSON。',
  ].join('\n')
  return { system: SYSTEM, user }
}

function clampScore(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, n))
}

function asStr(v) {
  return String(v ?? '')
}

// 归一化 AI 返回的评分对象；永不 throw，坏字段逐项降级。
function parseReview(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const score = clampScore(o.score)
  const issues = Array.isArray(o.issues)
    ? o.issues.map((i) => ({
        type: asStr(i?.type),
        location: asStr(i?.location),
        problem: asStr(i?.problem),
        suggestion: asStr(i?.suggestion),
        better: asStr(i?.better),
      }))
    : []
  const better = asStr(o.better)
  const praise = asStr(o.praise)
  const lowScoreHint = score !== null && score < 70 ? asStr(o.lowScoreHint) : ''
  return { score, issues, better, praise, lowScoreHint }
}

// 把 AI 原文解析为 { review }；解析失败 → parseError（不伪造分数）。
function reviewFromContent(content) {
  try {
    return { review: parseReview(extractJson(content)) }
  } catch {
    return { review: { score: null, issues: [], better: '', praise: '', lowScoreHint: '', parseError: true } }
  }
}

module.exports = { buildReviewPrompt, parseReview, reviewFromContent }
