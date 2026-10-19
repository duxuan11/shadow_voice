// 中译英口语对话 AI 层：
//  - 整组生成（1 次调用，产出连贯对话脚本）
//  - 单句评估（每次作答 1 次调用，带上下文与重试次数）
// 纯函数部分（prompt 构建 + 输出归一化）与网络调用分离，便于单测。
// 归一化永不 throw：畸形输入只丢条目或返回 { ok:false }，由路由层决定报错文案。

const { parseReview } = require('./speak.cjs')

const DIFFICULTIES = ['easy', 'daily', 'advanced']
const DIFFICULTY_LABELS = { easy: '简单', daily: '日常', advanced: '进阶' }
const MIN_LINES = 5
const MAX_LINES = 20
const TARGET_MIN = 8
const TARGET_MAX = 15
const MAX_SEGMENTS = 120

const LEVEL_TO_DIFFICULTY = { 初级: 'easy', 中级: 'daily', 高级: 'advanced' }

const DIFFICULTY_GUIDE = {
  easy: '中文用短句、单一信息点；参考英文 6–12 词，最多一个从句，只用日常高频词。',
  daily: '正常日常对话，可以有连接词；参考英文 10–18 词，允许一个从句。',
  advanced: '有观点、因果或转折，接近本族语对话；参考英文 14–25 词，允许两个从句和固定搭配。',
}

const CJK_RE = /[\u4e00-\u9fff]/
const LETTER_RE = /[a-zA-Z]/

const SYSTEM_SCRIPT = [
  '你是资深的英语口语教材作者，为中文母语学习者编写「中译英」对话练习。',
  '学习者会看到一句中文，然后口头把它翻译成英文。',
  '',
  '规则：',
  `- 生成一整段连贯、自然的对话（不是零散句子集合），共 ${TARGET_MIN}–${TARGET_MAX} 句，最多不超过 ${MAX_LINES} 句。`,
  '- 每一句都是学习者需要翻译的中文句子，每句都要能对应一个自然、地道的英文说法。',
  '- 用 speaker 区分说话人：user = 学习者扮演的角色，other = 对话另一方；speakerCn 写中文称呼（如「你」「前台」）。',
  '- 必须贴合给定视频的字幕、主题、场景与人物关系，不要跑题。',
  '- en 是参考英文；alternatives 给 1–2 条语义相同、同样可接受的说法；keyPoints 给 0–2 条中文纠错要点（时态、搭配、语气）。',
  '- 中文要自然完整，不要书面翻译腔；英文要现代口语。',
  '- 只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释。',
].join('\n')

const SYSTEM_REVIEW = [
  '你是面向中国英语学习者的英语口语教练。学习者看到一句中文，用英语把它说出来；你要评价他说得对不对、地不地道。',
  '',
  '评分规则：',
  '- 给出的「参考英文」只是其中一种正确说法，不是唯一答案——凡是语法正确、自然、且意思吻合的英文都应给高分。',
  '- 重点检查：语法、用词、搭配是否地道、是否漏掉或曲解关键信息、句子是否完整。',
  '- 用 verdict 区分两类问题：语义或语法上的实质错误 → "wrong"；意思对但不够地道 → "minor"；又对又自然 → "correct"。',
  '- 如果学习者说的英文传达了不同的意思，属于正确性问题，要在 issues 里指出。',
  '',
  '只输出一个 JSON 对象，结构如下：',
  '{"verdict":"correct|minor|wrong","score":85,"issues":[{"type":"grammar|word_choice|collocation|naturalness|incomplete","location":"学习者说的片段","problem":"问题描述（中文）","suggestion":"修改建议（中文）","better":"该片段更地道的英文"}],"better":"整句更地道的英文说法","praise":"具体夸一句（中文）","hint":"verdict=wrong 时给一句中文提示，指出该注意什么但不要写出英文答案；否则为空字符串"}',
].join('\n')

function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : null
}

function difficultyOf(videoLevel) {
  return LEVEL_TO_DIFFICULTY[String(videoLevel ?? '').trim()] || 'daily'
}

function cleanList(value, max) {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .slice(0, max)
}

// 去重键：去掉空白与常见中英标点（同一句只差标点/空格视为重复）
function dedupeKey(cn) {
  return String(cn).replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:'"「」（）()…—]/g, '')
}

function buildScriptPrompt({ videoTitle, description, videoLevel, difficulty, segments, scene } = {}) {
  const diff = normalizeDifficulty(difficulty) || 'daily'
  const segs = Array.isArray(segments) ? segments : []
  const lines = [
    `视频标题：${String(videoTitle ?? '').trim() || '(未命名)'}`,
  ]
  const desc = String(description ?? '').trim()
  if (desc) lines.push(`视频简介：${desc.slice(0, 600)}`)
  lines.push(`视频等级：${String(videoLevel ?? '').trim() || '未知'}｜本次目标难度：${DIFFICULTY_LABELS[diff]}`)
  if (scene && (scene.scene || scene.aiRole || scene.userRole || scene.context)) {
    const parts = [scene.scene, scene.aiRole ? `对方角色：${scene.aiRole}` : '', scene.userRole ? `学习者角色：${scene.userRole}` : '']
      .filter(Boolean)
    if (parts.length) lines.push(`场景参考：${parts.join('；')}`)
  }
  lines.push('')

  if (segs.length > 0) {
    lines.push('视频字幕（逐行转录，格式：行号. English || 中文。字幕未做断句，一句话可能被拆成相邻多行）：')
    segs.slice(0, MAX_SEGMENTS).forEach((s, i) => {
      const en = String(s?.textEn ?? '').replace(/\s+/g, ' ').trim()
      const cn = String(s?.textCn ?? '').replace(/\s+/g, ' ').trim()
      if (!en && !cn) return
      lines.push(`${i + 1}. ${en}${cn ? ` || ${cn}` : ''}`)
    })
    if (segs.length > MAX_SEGMENTS) lines.push(`（后续 ${segs.length - MAX_SEGMENTS} 行字幕已省略）`)
  } else {
    lines.push('这个视频没有字幕可用。请只依据上面的标题、简介与难度信息设计一段日常场景对话；不要编造视频里的人物、地点或情节，也不要假装看过视频内容。')
  }

  lines.push('')
  lines.push(`难度要求：${DIFFICULTY_GUIDE[diff]}`)
  lines.push('')
  lines.push('输出 JSON 结构：')
  lines.push('{"title":"短标题（4-10 字）","scene":"场景英文名","settingCn":"一句中文场景说明","userRole":"学习者角色（中文）","otherRole":"对方角色（中文）","lines":[{"speaker":"other|user","speakerCn":"对方|你","cn":"中文句子","en":"English sentence","alternatives":["另一种可接受说法"],"keyPoints":["中文纠错要点"]}]}')
  lines.push(`lines 共 ${TARGET_MIN}–${TARGET_MAX} 句（硬上限 ${MAX_LINES} 句）。`)
  return { system: SYSTEM_SCRIPT, user: lines.join('\n') }
}

// 归一化整组剧本；不合格返回 { ok:false, reason }，不 throw。
function normalizeDialogueScript(raw, { difficulty = 'daily', hasSubtitles = true } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const rawLines = Array.isArray(src.lines) ? src.lines : []
  const lines = []
  const seen = new Set()

  for (const item of rawLines) {
    const cn = String(item?.cn ?? '').trim()
    const en = String(item?.en ?? '').replace(/\s+/g, ' ').trim()
    if (!cn || !en) continue
    if (!CJK_RE.test(cn)) continue
    if (!LETTER_RE.test(en) || en.split(/\s+/).length < 2) continue
    const key = dedupeKey(cn)
    if (seen.has(key)) continue
    seen.add(key)

    const isOther = item?.speaker === 'other'
    const fallbackSpeaker = isOther ? '对方' : '你'
    lines.push({
      index: lines.length,
      speaker: isOther ? 'other' : 'user',
      speakerCn: String(item?.speakerCn ?? fallbackSpeaker).trim().slice(0, 12) || fallbackSpeaker,
      cn,
      en,
      alternatives: cleanList(item?.alternatives, 2),
      keyPoints: cleanList(item?.keyPoints, 2),
    })
    if (lines.length >= MAX_LINES) break
  }

  if (lines.length < MIN_LINES) {
    return { ok: false, reason: `有效句子不足 ${MIN_LINES} 句（${lines.length} 句）` }
  }

  return {
    ok: true,
    script: {
      version: 1,
      difficulty: normalizeDifficulty(difficulty) || 'daily',
      title: String(src.title ?? '').trim().slice(0, 40) || '场景对话',
      scene: String(src.scene ?? '').trim().slice(0, 60),
      settingCn: String(src.settingCn ?? '').trim().slice(0, 160),
      userRole: String(src.userRole ?? '').trim().slice(0, 24),
      otherRole: String(src.otherRole ?? '').trim().slice(0, 24),
      source: hasSubtitles ? 'subtitle' : 'video-info',
      lines,
    },
  }
}

function buildLineReviewPrompt({ line, contextLines = [], difficulty, userText, attempt = 1 } = {}) {
  const l = line && typeof line === 'object' ? line : {}
  const ctx = (Array.isArray(contextLines) ? contextLines : []).filter(Boolean)
  const parts = []

  if (ctx.length > 0) {
    parts.push('对话上下文（已经发生的对话）：')
    for (const c of ctx) parts.push(`${String(c.speakerCn ?? '对方')}：${String(c.cn ?? '')}`)
    parts.push('')
  }

  parts.push(`目标难度：${DIFFICULTY_LABELS[normalizeDifficulty(difficulty) || 'daily']}`)
  parts.push(`中文句子：${String(l.cn ?? '')}`)
  parts.push(`参考英文：${String(l.en ?? '')}`)

  const alternatives = cleanList(l.alternatives, 3)
  if (alternatives.length > 0) parts.push(`其他可接受说法：${alternatives.join(' / ')}`)

  const keyPoints = cleanList(l.keyPoints, 3)
  if (keyPoints.length > 0) parts.push(`关键纠错要点：${keyPoints.join('；')}`)

  parts.push('')
  parts.push(`学习者说的英文：${String(userText ?? '').trim()}`)
  parts.push(`这是学习者第 ${Math.max(1, Number(attempt) || 1)} 次作答。`)
  parts.push('')
  parts.push('请评分，并只输出上述 JSON。')
  return { system: SYSTEM_REVIEW, user: parts.join('\n') }
}

function inferVerdict(score) {
  if (typeof score !== 'number') return 'wrong'
  if (score >= 80) return 'correct'
  if (score >= 60) return 'minor'
  return 'wrong'
}

// 归一化单句评分；wrong 且首次作答时剥离英文答案（先让用户重试，不直接给答案）。
function normalizeLineReview(raw, { attempt = 1 } = {}) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const base = parseReview(o)
  const rawVerdict = String(o.verdict ?? '').trim().toLowerCase()
  const verdict = ['correct', 'minor', 'wrong'].includes(rawVerdict) ? rawVerdict : inferVerdict(base.score)
  const hint = String(o.hint ?? base.lowScoreHint ?? '').trim()

  if (verdict === 'wrong' && Number(attempt) < 2) {
    return {
      verdict,
      score: base.score,
      issues: base.issues.map((i) => ({ ...i, better: '' })),
      better: '',
      praise: base.praise,
      hint,
      answerHidden: true,
    }
  }

  return {
    verdict,
    score: base.score,
    issues: base.issues,
    better: base.better,
    praise: base.praise,
    hint,
    answerHidden: false,
  }
}

module.exports = {
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  MIN_LINES,
  MAX_LINES,
  TARGET_MIN,
  TARGET_MAX,
  normalizeDifficulty,
  difficultyOf,
  buildScriptPrompt,
  normalizeDialogueScript,
  buildLineReviewPrompt,
  normalizeLineReview,
}
