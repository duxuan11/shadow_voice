// 文本练习的 AI 服务（纯函数：prompt 构建 + 输出归一化），不直接发请求。
// 两条能力：
//  1. 保存文档时把整篇英文一次性批量译成中文（术语必须原样保留）；
//  2. 汉译英逐句评分（原文只是「一种」正确说法，语义等价照样高分）。
// AI 输出畸形时永不伪造结果：翻译缺项返回 missing，评分返回 score=null/parseError。
// 评分字段归一化复用 speak.cjs 的 parseReview（分数钳制、issues 容错），避免两套口径。

const { parseReview } = require('./speak.cjs')

// 每批送进模型的句数上限：控制单次 token 与失败重试的代价
const TRANSLATE_CHUNK = 50

const SYSTEM_TRANSLATE = [
  '你是面向中国软件开发者的技术英语译者。用户会给你一份英文技术文档（论文摘要、README、邮件、规格说明）拆好的句子列表，请逐句译成中文。',
  '',
  '翻译要求：',
  '- 译文是给中国工程师看的自然中文，句子完整、可以直接照着回译成英文；不要逐字硬译。',
  '- 术语必须原样保留、绝不翻译：专有名词与缩写（SAM、UMAP、YOLO、U-Net、PaCMAP、GPT、Transformer 等）、模型/库/产品名、代码标识符与函数名、URL、数字、版本号、单位。',
  '- 驼峰、下划线、连字符形态的标识符（getUserById、top_k、U-Net、mIoU@0.5）不改大小写、不加空格、不拆词。',
  '- 不增删信息，不加译注，不做解释。',
  '- 只输出一个 JSON 对象，不要输出任何其它文字：',
  '{"items":[{"i":0,"cn":"第一句的中文"},{"i":1,"cn":"第二句的中文"}]}',
].join('\n')

const SYSTEM_REVIEW = [
  '你是面向中国英语学习者的技术英语写作教练。学习者看到一句中文（原文是英文技术文档里的一句），要写出对应的英文；你评价他写得对不对、地不地道。',
  '',
  '评分规则：',
  '- 给出的「英文原文」只是其中一种正确说法，不是唯一答案：语义等价、语法正确、术语保真的其它英文同样给高分（例如同义动词、主动/被动互换、从句改写）。',
  '- 重点检查：语法、用词与搭配、是否漏译或曲解关键信息、句子是否完整。',
  '- 术语检查：缩写与标识符必须原样保留（U-Net 不能写成 Unet，PaCMAP 不能写成 PacMAP），被改动时在 issues 里用 type="term" 指出。',
  '- 如果学习者表达的意思与原文不同，属于正确性问题，要扣分并指出。',
  '',
  '只输出一个 JSON 对象：',
  '{"verdict":"correct|minor|wrong","score":85,"issues":[{"type":"grammar|word_choice|collocation|naturalness|incomplete|term","location":"学习者写的片段","problem":"问题描述（中文）","suggestion":"修改建议（中文）","better":"该片段更地道的英文"}],"better":"整句更地道的英文说法","praise":"具体夸一句（中文）","lowScoreHint":"score<70 时给一句具体提示（中文），否则空字符串"}',
].join('\n')

/**
 * 构建批量翻译 prompt。
 * @param {{ title: string, sentences: string[] }} input
 * @returns {{ system: string, user: string }}
 */
function buildTranslatePrompt({ title, sentences }) {
  const list = Array.isArray(sentences) ? sentences.map((s) => String(s ?? '')) : []
  const numbered = list.map((s, i) => `${i}. ${s}`).join('\n')
  const user = [
    `标题：${String(title ?? '').trim()}`,
    '',
    `共 ${list.length} 句，请逐句翻译，i 从 0 开始：`,
    numbered,
    '',
    '只输出 {"items":[...]}，items 必须覆盖上面每一个 i。',
  ].join('\n')
  return { system: SYSTEM_TRANSLATE, user }
}

/**
 * 归一化翻译结果。永不 throw。
 * @param {unknown} json
 * @param {{ count: number }} input
 * @returns {{ ok: boolean, items: Array<{ i: number, cn: string }>, missing: number[] }}
 */
function normalizeTranslations(json, { count }) {
  const total = Math.max(0, Math.floor(Number(count) || 0))
  const all = Array.from({ length: total }, (_, i) => i)
  const raw = json && typeof json === 'object' && Array.isArray(json.items) ? json.items : []

  const byIndex = new Map()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const index = Number(item.i)
    if (!Number.isInteger(index) || index < 0 || index >= total) continue
    const cn = String(item.cn ?? '').trim()
    if (!cn) continue
    byIndex.set(index, cn)
  }

  const items = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, cn]) => ({ i, cn }))
  const missing = all.filter((i) => !byIndex.has(i))
  return { ok: total > 0 && missing.length === 0, items, missing }
}

/**
 * 构建单句汉译英评分 prompt。中文缺失时省略中文行（仍可评）。
 * @param {{ title: string, en: string, cn?: string, userText: string, attempt?: number }} input
 * @returns {{ system: string, user: string }}
 */
function buildSentenceReviewPrompt({ title, en, cn, userText, attempt }) {
  const lines = [`文档标题：${String(title ?? '').trim()}`, '', `英文原文：${String(en ?? '').trim()}`]
  const cnText = String(cn ?? '').trim()
  if (cnText) lines.push(`中文参考：${cnText}`)
  lines.push(`学习者写的英文：${String(userText ?? '').trim()}`)
  const attempts = Math.floor(Number(attempt) || 0)
  if (attempts > 1) lines.push(`这是第 ${attempts} 次尝试，请依据历史指出仍存在的问题。`)
  lines.push('', '请评分，并只输出上述 JSON。')
  return { system: SYSTEM_REVIEW, user: lines.join('\n') }
}

/**
 * 归一化单句评分。永不 throw；score 缺失时绝不编造。
 * @param {unknown} json
 * @returns {{ verdict: 'correct'|'minor'|'wrong', score: number|null, issues: object[], better: string, praise: string, hint: string, parseError: boolean }}
 */
function normalizeSentenceReview(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { verdict: 'wrong', score: null, issues: [], better: '', praise: '', hint: '', parseError: true }
  }
  const parsed = parseReview(json)
  const score = parsed.score
  const verdict = ['correct', 'minor', 'wrong'].includes(json.verdict)
    ? json.verdict
    : score === null
      ? 'wrong'
      : score >= 85
        ? 'correct'
        : score >= 60
          ? 'minor'
          : 'wrong'
  return {
    verdict,
    score,
    issues: parsed.issues,
    better: parsed.better,
    praise: parsed.praise,
    hint: parsed.lowScoreHint,
    parseError: false,
  }
}

module.exports = {
  TRANSLATE_CHUNK,
  buildTranslatePrompt,
  normalizeTranslations,
  buildSentenceReviewPrompt,
  normalizeSentenceReview,
}
