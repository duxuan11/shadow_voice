// 每日口语挑战 AI 层（生成部分）：
//  - 一次调用产出整套五步静态任务（3 个复述题 / 5 个语块 / 5 个情境 / 1 个话题）
//  - 输出归一化 + 字幕取证：任何 chunk 的 evidence 必须能在该视频字幕里找到，
//    不足时用「字幕衍生」的兜底池补齐，仍不足则判定失败（绝不凭空编造）。
// 纯函数：零网络调用，便于单测；网络调用在 routes/challenge.cjs。

const { localExtractTopics } = require('./conversation.cjs')

const RECALL_COUNT = 3
const CHUNK_COUNT = 5
const TRANSFORMATION_COUNT = 5
const MIN_TOPIC_SECONDS = 60
const MAX_TOPIC_SECONDS = 120
const DEFAULT_TOPIC_SECONDS = 90

const MAX_SEGMENTS = 120
const CJK_RE = /[\u4e00-\u9fff]/

const SYSTEM_GENERATE = [
  '你是资深英语口语教练，为中文母语学习者设计一套「五步口语挑战」。',
  '学习者刚看完给定的视频，你要帮他把视频里的语言变成自己能说的话。',
  '',
  '硬性规则：',
  '- 一切内容必须来自给定字幕：不编造视频里没出现的人、事、观点。',
  '- 每个语块的 evidence 必须是字幕里**原样出现**的一句英文（逐字复制，不要改写）。',
  '- 语块 2–6 个词、口语高频、可迁移（例如 check in / it turns out that / hold my bags）。',
  '- 复述题问的是视频内容，必须能靠"看过视频"回答，不要问语法。',
  '- 情境题用中文写，是**新的生活情境**，不是视频原句的翻译。',
  '- 话题要能从视频主题自然延伸，让学习者能连续说 60–120 秒。',
  '- 中文说明自然口语化；英文是现代口语。',
  '- 只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释。',
].join('\n')

const LEVEL_HINT = {
  初级: '学习者水平：初级。语块用最基础的日常搭配，复述题问 who / what / where。',
  中级: '学习者水平：中级。语块可以是常见框架（it turns out that… / I’d rather…），复述题问 how / why。',
  高级: '学习者水平：高级。语块可以带态度与逻辑（the thing is… / that’s not to say…），复述题问观点与论证。',
}

function asStr(v) {
  return String(v ?? '')
}

function clamp(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function cleanList(value, max) {
  if (!Array.isArray(value)) return []
  return value.map((v) => asStr(v).trim()).filter(Boolean).slice(0, max)
}

// 文本归一化：小写、统一撇号、去标点（保留词内撇号）、合并空白。
function normalizeText(text) {
  return asStr(text)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeChunkKey(text) {
  return normalizeText(text)
}

// 取证：归一化后是字幕的子串，或其词序列按顺序全部出现在字幕里。
function isEvidenceInTranscript(text, transcriptText) {
  const needle = normalizeText(text)
  const hay = normalizeText(transcriptText)
  if (!needle || !hay) return false
  if (hay.includes(needle)) return true
  const needleWords = needle.split(' ')
  const hayWords = hay.split(' ')
  let i = 0
  for (const w of hayWords) {
    if (w === needleWords[i]) i += 1
    if (i === needleWords.length) return true
  }
  return i === needleWords.length
}

// 在字幕里找一条包含该表达的行，作为 evidence。
function findEvidenceLine(phrase, segments) {
  const needle = normalizeChunkKey(phrase)
  if (!needle) return ''
  for (const s of Array.isArray(segments) ? segments : []) {
    const en = asStr(s?.textEn).replace(/\s+/g, ' ').trim()
    if (en && isEvidenceInTranscript(needle, en)) return en
  }
  return ''
}

// 兜底语块池：只用字幕里真实存在的表达，且必须有中文释义（不编造释义）。
// ① ai_cache 的 topics-v1（有就用）② 本地规则提取（conversation.cjs 的 localExtractTopics）。
function buildFallbackChunks({ segments = [], cachedTopics = null } = {}) {
  const segs = Array.isArray(segments) ? segments : []
  const transcript = segs.map((s) => asStr(s?.textEn)).join(' ')
  const out = []
  const seen = new Set()

  const push = (phrase, meaning, source) => {
    if (out.length >= CHUNK_COUNT) return
    const en = asStr(phrase).replace(/\s+/g, ' ').trim()
    const cn = asStr(meaning).trim()
    const key = normalizeChunkKey(en)
    if (!key || !cn || seen.has(key)) return
    const evidence = findEvidenceLine(en, segs)
    if (!evidence || !isEvidenceInTranscript(evidence, transcript)) return
    seen.add(key)
    out.push({ en, cn, evidence, source })
  }

  const cached = cachedTopics && typeof cachedTopics === 'object' ? cachedTopics : null
  if (cached) {
    for (const p of Array.isArray(cached.phrases) ? cached.phrases : []) {
      push(p?.phrase, p?.meaning, 'cache')
    }
    for (const c of Array.isArray(cached.collocations) ? cached.collocations : []) {
      push(c?.collocation, c?.meaning, 'cache')
    }
  }

  if (out.length < CHUNK_COUNT) {
    const local = localExtractTopics(segs)
    for (const p of Array.isArray(local?.phrases) ? local.phrases : []) {
      push(p?.phrase, p?.meaning, 'local')
    }
    for (const c of Array.isArray(local?.collocations) ? local.collocations : []) {
      push(c?.collocation, c?.meaning, 'local')
    }
  }

  return out.slice(0, CHUNK_COUNT)
}

function buildChallengePrompt({
  videoTitle, description, topic, videoLevel, segments = [], variant = 1, avoid = null,
} = {}) {
  const lines = [
    `视频标题：${asStr(videoTitle).trim() || '(未命名)'}`,
  ]
  const desc = asStr(description).trim()
  if (desc) lines.push(`视频简介：${desc.slice(0, 400)}`)
  const topicText = asStr(topic).trim()
  if (topicText) lines.push(`视频主题：${topicText}`)
  lines.push(`视频等级：${asStr(videoLevel).trim() || '未知'}`)
  lines.push(`这是这个视频的第 ${Math.max(1, Number(variant) || 1)} 套挑战，必须与之前几套明显不同。`)
  lines.push('')

  const segs = Array.isArray(segments) ? segments : []
  if (segs.length > 0) {
    lines.push('视频字幕（逐行转录，格式：行号. English || 中文）：')
    segs.slice(0, MAX_SEGMENTS).forEach((s, i) => {
      const en = asStr(s?.textEn).replace(/\s+/g, ' ').trim()
      const cn = asStr(s?.textCn).replace(/\s+/g, ' ').trim()
      if (!en && !cn) return
      lines.push(`${i + 1}. ${en}${cn ? ` || ${cn}` : ''}`)
    })
    if (segs.length > MAX_SEGMENTS) lines.push(`（后续 ${segs.length - MAX_SEGMENTS} 行字幕已省略）`)
  } else {
    lines.push('这个视频没有可用字幕。')
  }

  if (avoid && typeof avoid === 'object') {
    const chunks = cleanList(avoid.chunks, 20)
    const situations = cleanList(avoid.situations, 20)
    const questions = cleanList(avoid.questions, 20)
    if (chunks.length || situations.length || questions.length) {
      lines.push('')
      lines.push('已经用过的内容（不要再重复，换新的语块与情境）：')
      if (chunks.length) lines.push(`- 语块：${chunks.join(' / ')}`)
      if (situations.length) lines.push(`- 情境：${situations.join(' / ')}`)
      if (questions.length) lines.push(`- 复述题：${questions.join(' / ')}`)
    }
  }

  lines.push('')
  lines.push(LEVEL_HINT[asStr(videoLevel).trim()] || LEVEL_HINT['中级'])
  lines.push('')
  lines.push('输出 JSON 结构：')
  lines.push('{"title":"短标题（4–12 字）","topicEn":"话题英文短语","topicCn":"话题中文",')
  lines.push(' "recall":[{"qEn":"English question","qCn":"中文问题","focusCn":"想听到的要点"}],')
  lines.push(' "chunks":[{"en":"chunk","cn":"中文释义","evidence":"字幕原句","usageCn":"造句提示"}],')
  lines.push(' "transformations":[{"situationCn":"中文情境","targetChunkId":0,"hintCn":"提示"}],')
  lines.push(' "topicSpeaking":{"promptEn":"English topic","promptCn":"中文话题","pointsCn":["要点1","要点2"],"targetSeconds":90}}')
  lines.push(`数量硬要求：recall 恰好 ${RECALL_COUNT} 条、chunks 恰好 ${CHUNK_COUNT} 条、transformations 恰好 ${TRANSFORMATION_COUNT} 条。`)
  lines.push('chunks 里每条 evidence 必须是上面字幕里逐字出现的一句英文。')

  return { system: SYSTEM_GENERATE, user: lines.join('\n') }
}

// 归一化整组挑战；不合格返回 { ok:false, reason }，永不 throw。
function normalizeChallenge(raw, { segmentsText = '', fallbackChunks = [] } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const transcript = asStr(segmentsText)

  const recall = []
  for (const item of Array.isArray(src.recall) ? src.recall : []) {
    const qEn = asStr(item?.qEn).replace(/\s+/g, ' ').trim()
    if (!qEn || qEn.split(' ').length < 3) continue
    recall.push({
      id: recall.length,
      qEn: qEn.slice(0, 220),
      qCn: asStr(item?.qCn).trim().slice(0, 120),
      focusCn: asStr(item?.focusCn).trim().slice(0, 80),
    })
    if (recall.length >= RECALL_COUNT) break
  }
  if (recall.length < RECALL_COUNT) {
    return { ok: false, reason: `有效复述题不足 ${RECALL_COUNT} 条（${recall.length} 条）` }
  }

  const seen = new Set()
  const chunks = []
  let aiVerified = 0
  let fallbackSource = null

  const takeChunk = (en, cn, evidence, usageCn, fromFallback, source) => {
    const enText = asStr(en).replace(/\s+/g, ' ').trim()
    const cnText = asStr(cn).trim()
    const evText = asStr(evidence).replace(/\s+/g, ' ').trim()
    if (!enText || !cnText || !CJK_RE.test(cnText)) return
    const key = normalizeChunkKey(enText)
    if (!key || seen.has(key)) return
    if (!isEvidenceInTranscript(evText, transcript)) return
    seen.add(key)
    chunks.push({
      id: chunks.length,
      en: enText.slice(0, 120),
      cn: cnText.slice(0, 120),
      evidence: evText.slice(0, 300),
      usageCn: asStr(usageCn).trim().slice(0, 140),
    })
    if (fromFallback) {
      if (!fallbackSource) fallbackSource = source === 'cache' ? 'cache' : 'local'
    } else {
      aiVerified += 1
    }
  }

  for (const item of Array.isArray(src.chunks) ? src.chunks : []) {
    if (chunks.length >= CHUNK_COUNT) break
    takeChunk(item?.en, item?.cn, item?.evidence, item?.usageCn, false, null)
  }
  if (chunks.length < CHUNK_COUNT) {
    for (const f of Array.isArray(fallbackChunks) ? fallbackChunks : []) {
      if (chunks.length >= CHUNK_COUNT) break
      takeChunk(f?.en, f?.cn, f?.evidence, f?.usageCn, true, f?.source)
    }
  }
  if (chunks.length < CHUNK_COUNT) {
    return { ok: false, reason: `有效语块不足 ${CHUNK_COUNT} 条（${chunks.length} 条）` }
  }

  const transformations = []
  for (const item of Array.isArray(src.transformations) ? src.transformations : []) {
    const situationCn = asStr(item?.situationCn).trim()
    if (!CJK_RE.test(situationCn)) continue
    const t = Number(item?.targetChunkId)
    transformations.push({
      id: transformations.length,
      situationCn: situationCn.slice(0, 240),
      targetChunkId: Number.isInteger(t) && t >= 0 && t < CHUNK_COUNT ? t : null,
      hintCn: asStr(item?.hintCn).trim().slice(0, 120),
    })
    if (transformations.length >= TRANSFORMATION_COUNT) break
  }
  if (transformations.length < TRANSFORMATION_COUNT) {
    return { ok: false, reason: `有效情境不足 ${TRANSFORMATION_COUNT} 条（${transformations.length} 条）` }
  }

  const ts = src.topicSpeaking && typeof src.topicSpeaking === 'object' ? src.topicSpeaking : {}
  const promptEn = asStr(ts.promptEn).trim().slice(0, 300)
  const promptCn = asStr(ts.promptCn).trim().slice(0, 240)
  if (!promptEn && !promptCn) {
    return { ok: false, reason: '缺少话题陈述任务' }
  }

  return {
    ok: true,
    challenge: {
      version: 1,
      title: asStr(src.title).trim().slice(0, 40) || '口语挑战',
      topicEn: asStr(src.topicEn).trim().slice(0, 80),
      topicCn: asStr(src.topicCn).trim().slice(0, 40),
      source: aiVerified >= CHUNK_COUNT ? 'subtitle' : (fallbackSource || 'local'),
      recall,
      chunks,
      transformations,
      topicSpeaking: {
        promptEn,
        promptCn,
        pointsCn: cleanList(ts.pointsCn, 3),
        targetSeconds: Math.round(clamp(ts.targetSeconds || DEFAULT_TOPIC_SECONDS, MIN_TOPIC_SECONDS, MAX_TOPIC_SECONDS)),
      },
    },
  }
}

// 反馈 prompt 用的字幕摘要（逐行英文，限行限字）。
function buildTranscriptDigest(segments, maxLines = 40, maxChars = 2000) {
  const lines = (Array.isArray(segments) ? segments : [])
    .map((s) => asStr(s?.textEn).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, Math.max(0, Number(maxLines) || 0))
  return lines.join(' ').slice(0, Math.max(0, Number(maxChars) || 0)).trim()
}

// ── 分步反馈 ─────────────────────────────────────────────
const SYSTEM_STEP_FEEDBACK = [
  '你是面向中文学习者的英语口语教练，正在给「五步口语挑战」的某一步做**逐题反馈**。',
  '',
  '规则：',
  '- 先具体夸一点（praise），再指出问题；永远不要只给一个分数。',
  '- 学习者是先自己说、再看优化版：better 只写「更地道的说法」，不是唯一标准答案。',
  '- 学习者没作答的题不要杜撰答案，也不要倒填参考答案。',
  '- 语法（grammar）与地道度（naturalness）分开列：原文片段 → 更好说法 → 中文原因。',
  '- chunkUsage 只针对下面列出的语块：quality = good（用对且自然）/ partial（意思对但不自然或漏词）/ wrong（没说对或没用上）。',
  '- 关注可执行的一条改进，不要长篇大论；中文说明简明。',
  '- 只输出一个 JSON 对象，不要 Markdown、不要解释。',
  '',
  '输出结构：',
  '{"score":80,',
  ' "items":[{"index":0,"comment":"中文点评","better":"更地道的英文","grammar":[{"original":"原文片段","better":"改法","reason":"中文原因"}],"naturalness":[],"chunkRestored":true}],',
  ' "chunkUsage":[{"chunkId":0,"used":true,"quality":"good","evidence":"学习者说的片段"}],',
  ' "vocabulary":{"level":"偏基础|适中|丰富","suggestions":["更高级的替代表达"]},',
  ' "coherence":{"summary":"连贯性点评（中文）","fillers":["um"]},',
  ' "praise":"具体夸一句（中文）"}',
].join('\n')

const STEP_TASK_TEXT = {
  1: '第 1 步 Video Recall：学习者不看字幕，用英文回答 3 个关于视频内容的问题。评价重点：是否覆盖了视频里的关键观点（对照字幕摘要）、信息是否准确、语法与表达。',
  2: '第 2 步 Chunk Activation：学习者看到中文释义，先说出英文语块，再用它造一句自己的话。评价重点：语块是否还原正确（chunkRestored）、造句是否自然且语义通顺。',
  3: '第 3 步 Sentence Transformation：学习者用英文表达 5 个中文情境，不能照抄视频原句。评价重点：是否传达到情境、是否用上目标语块、句子是否自然。',
  4: '第 4 步 Topic Speaking：学习者围绕话题连续说了 60–120 秒。评价重点：观点是否展开、用了哪些语块、词汇丰富度、连贯性与填充词。',
  5: '第 5 步 AI Conversation：学习者与你就视频话题聊了几轮。评价重点：是否回应追问、是否自发复用本视频语块、表达是否自然。',
}

function stepTaskBlock(step, challenge) {
  const lines = [STEP_TASK_TEXT[step] || '']
  const chunks = Array.isArray(challenge?.chunks) ? challenge.chunks : []
  if (step === 1) {
    const recall = Array.isArray(challenge?.recall) ? challenge.recall : []
    recall.forEach((q) => lines.push(`问题 ${q.id}：${q.qEn}${q.focusCn ? `（想听到：${q.focusCn}）` : ''}`))
  }
  if (step >= 2 && chunks.length) {
    lines.push('本套语块：')
    chunks.forEach((c) => lines.push(`chunkId ${c.id}：${c.cn}（英文见字幕）`))
  }
  if (step === 3) {
    const list = Array.isArray(challenge?.transformations) ? challenge.transformations : []
    list.forEach((t) => lines.push(`情境 ${t.id}：${t.situationCn}${t.targetChunkId != null ? `（目标语块 chunkId ${t.targetChunkId}）` : ''}`))
  }
  if (step === 4 && challenge?.topicSpeaking) {
    const ts = challenge.topicSpeaking
    lines.push(`话题：${ts.promptEn || ''}${ts.promptCn ? ` / ${ts.promptCn}` : ''}`)
    if (Array.isArray(ts.pointsCn) && ts.pointsCn.length) lines.push(`要点提示：${ts.pointsCn.join('；')}`)
  }
  return lines.filter(Boolean).join('\n')
}

function answerBlock(step, answers) {
  const list = Array.isArray(answers) ? answers : []
  const lines = []
  for (const a of list) {
    if (step === 2) {
      const parts = []
      if (asStr(a?.chunkText).trim()) parts.push(`说的语块：${asStr(a.chunkText).trim()}`)
      if (asStr(a?.sentence).trim()) parts.push(`造的句子：${asStr(a.sentence).trim()}`)
      lines.push(`${Number(a?.index) + 1}. ${parts.join('｜') || '(空)'}`)
    } else {
      lines.push(`${Number(a?.index) + 1}. ${asStr(a?.text).trim() || '(空)'}`)
    }
  }
  return lines.join('\n')
}

function buildStepFeedbackPrompt({ step, challenge, videoTitle, transcriptDigest, answers, metrics } = {}) {
  const n = Number(step)
  const m = metrics && typeof metrics === 'object' ? metrics : {}
  const parts = [
    `视频标题：${asStr(videoTitle).trim() || '(未命名)'}`,
    '',
    stepTaskBlock(n, challenge),
    '',
    '视频字幕摘要（用来判断学习者是否覆盖了视频观点）：',
    asStr(transcriptDigest).trim() || '(无字幕)',
    '',
    '学习者的作答：',
    answerBlock(n, answers),
  ]
  const hasMetrics = [m.longestSeconds, m.totalSeconds, m.segments].some((v) => Number(v) > 0)
  if (hasMetrics) {
    parts.push('')
    parts.push(`本地统计：最长连续表达 ${Number(m.longestSeconds) || 0} 秒，累计 ${Number(m.totalSeconds) || 0} 秒，录音段数 ${Number(m.segments) || 0}。`)
  }
  parts.push('')
  parts.push('请按上述 JSON 给出逐题反馈。')
  return { system: SYSTEM_STEP_FEEDBACK, user: parts.join('\n') }
}

function clampScore(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, Math.round(n)))
}

function normalizeIssues(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 4).map((i) => ({
    original: asStr(i?.original).trim().slice(0, 200),
    better: asStr(i?.better).trim().slice(0, 200),
    reason: asStr(i?.reason).trim().slice(0, 200),
  })).filter((i) => i.original || i.better || i.reason)
}

function emptyItem(index) {
  return { index, comment: '', better: '', grammar: [], naturalness: [], chunkRestored: null }
}

// 归一化某一步的反馈；永不 throw，缺项补空。
function normalizeStepFeedback(raw, { itemCount = 0, chunks = [] } = {}) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const total = Math.max(0, Number(itemCount) || 0)

  const items = []
  for (let i = 0; i < total; i += 1) items.push(emptyItem(i))
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const idx = Number(it?.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue
    if (items[idx].comment || items[idx].grammar.length) continue
    items[idx] = {
      index: idx,
      comment: asStr(it?.comment).trim().slice(0, 400),
      better: asStr(it?.better).trim().slice(0, 300),
      grammar: normalizeIssues(it?.grammar),
      naturalness: normalizeIssues(it?.naturalness),
      chunkRestored: typeof it?.chunkRestored === 'boolean' ? it.chunkRestored : null,
    }
  }

  const validIds = new Set((Array.isArray(chunks) ? chunks : [])
    .map((c) => Number(c?.id)).filter((n) => Number.isInteger(n)))
  const chunkUsage = []
  const seenIds = new Set()
  for (const u of Array.isArray(o.chunkUsage) ? o.chunkUsage : []) {
    const chunkId = Number(u?.chunkId)
    if (!Number.isInteger(chunkId) || !validIds.has(chunkId) || seenIds.has(chunkId)) continue
    seenIds.add(chunkId)
    const used = u?.used === true
    const quality = ['good', 'partial', 'wrong'].includes(u?.quality)
      ? u.quality
      : (used ? 'partial' : 'wrong')
    chunkUsage.push({ chunkId, used, quality, evidence: asStr(u?.evidence).trim().slice(0, 200) })
  }

  const vocab = o.vocabulary && typeof o.vocabulary === 'object' ? o.vocabulary : {}
  const coh = o.coherence && typeof o.coherence === 'object' ? o.coherence : {}

  return {
    score: clampScore(o.score),
    items,
    chunkUsage,
    vocabulary: { level: asStr(vocab.level).trim().slice(0, 20), suggestions: cleanList(vocab.suggestions, 3) },
    coherence: { summary: asStr(coh.summary).trim().slice(0, 400), fillers: cleanList(coh.fillers, 6) },
    praise: asStr(o.praise).trim().slice(0, 300),
  }
}

// ── 对话轮次 ─────────────────────────────────────────────
const SYSTEM_CHAT = [
  '你是学习者的英语**对话伙伴**，不是老师。你们在聊他刚看完的那个视频里的话题。',
  '',
  '规则：',
  '- 每次只说 1–2 句自然口语英文，先回应他说的内容，再追问一个能让他继续说的开放问题。',
  '- 顺着话题走，像真人聊天；不要纠错、不要讲解、不要翻译成中文。',
  '- 如果合适，自然带出本视频的一个语块，但不要硬塞。',
  '- 不要重复学习者原话，不要出戏，不要自称 AI。',
  '- 只输出 JSON：{"reply":"..."}',
].join('\n')

function buildChatTurnPrompt({ challenge, videoTitle, history } = {}) {
  const parts = [
    `视频标题：${asStr(videoTitle).trim() || '(未命名)'}`,
  ]
  const ts = challenge?.topicSpeaking || {}
  if (ts.promptEn) parts.push(`视频话题：${ts.promptEn}`)
  if (ts.promptCn) parts.push(`话题中文：${ts.promptCn}`)
  const chunks = Array.isArray(challenge?.chunks) ? challenge.chunks : []
  if (chunks.length) parts.push(`可以自然带出的语块：${chunks.map((c) => c.en).join(' / ')}`)
  parts.push('')

  const list = Array.isArray(history) ? history : []
  if (list.length === 0) {
    parts.push('对话还没开始。请你开场：用 1–2 句英文把话题抛出来，再问一个开放问题。')
  } else {
    parts.push('已经发生的对话：')
    for (const m of list) {
      const who = m?.role === 'user' ? 'LEARNER' : 'YOU'
      const text = asStr(m?.text).replace(/\s+/g, ' ').trim()
      if (text) parts.push(`${who}: ${text}`)
    }
    parts.push('')
    parts.push('请回应学习者的最后一句，再追问一个能让他继续说下去的问题。')
  }
  return { system: SYSTEM_CHAT, user: parts.join('\n') }
}

function normalizeChatReply(raw) {
  const text = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? asStr(raw.reply)
    : (typeof raw === 'string' ? raw : '')
  const reply = text.replace(/\s+/g, ' ').trim().slice(0, 400)
  return reply ? { ok: true, reply } : { ok: false, reply: '' }
}

// ── 收尾 + 报告 ──────────────────────────────────────────
const SYSTEM_FINISH = [
  '你是英语口语教练，要给一次「五步口语挑战」收尾：先评价最后的对话环节，再写一份**学习报告**。',
  '',
  '规则：',
  '- chatFeedback 与逐题反馈同结构（逐轮点评可放 items，没有就留空数组）。',
  '- 报告要具体、可执行：只给 2–3 条下次训练建议，不要空话。',
  '- 不要自己编造「掌握状态」：掌握清单由系统根据实际使用情况统计，你只写建议。',
  '- 中文写总结与建议；英文只出现在 better / 语块示例里。',
  '- 只输出一个 JSON 对象，不要 Markdown、不要解释。',
  '',
  '输出结构：',
  '{"chatFeedback":{"score":80,"items":[],"chunkUsage":[],"vocabulary":{"level":"","suggestions":[]},"coherence":{"summary":"","fillers":[]},"praise":""},',
  ' "report":{"score":82,"summary":"2–3 句中文总评","nextSuggestions":["下次训练建议"]}}',
].join('\n')

function buildFinishPrompt({ challenge, feedbacks, chatMessages, metrics } = {}) {
  const parts = [
    `视频标题：${asStr(challenge?.topicCn).trim() || '(未命名)'}`,
  ]
  const ts = challenge?.topicSpeaking || {}
  if (ts.promptEn || ts.promptCn) parts.push(`视频话题：${ts.promptEn || ''}${ts.promptCn ? ` / ${ts.promptCn}` : ''}`)
  const chunks = Array.isArray(challenge?.chunks) ? challenge.chunks : []
  if (chunks.length) {
    parts.push('本套语块：')
    chunks.forEach((c) => parts.push(`chunkId ${c.id}：${c.cn}`))
  }
  parts.push('')

  const list = Array.isArray(feedbacks) ? feedbacks : []
  parts.push('前四步的反馈摘要：')
  list.forEach((fb, i) => {
    if (!fb) { parts.push(`第 ${i + 1} 步：未完成`); return }
    const issues = []
    for (const it of Array.isArray(fb.items) ? fb.items : []) {
      if (it.comment) issues.push(it.comment)
      for (const g of [...(it.grammar || []), ...(it.naturalness || [])]) {
        if (g.better) issues.push(`${g.original}→${g.better}`)
      }
    }
    const used = (Array.isArray(fb.chunkUsage) ? fb.chunkUsage : [])
      .filter((u) => u.used).map((u) => `chunkId ${u.chunkId}`)
    parts.push(`第 ${i + 1} 步：分数 ${fb.score ?? '无'}｜用到 ${used.join(',') || '无'}｜要点：${issues.slice(0, 6).join('；') || '—'}`)
  })
  parts.push('')

  parts.push('最后的对话全文：')
  for (const m of Array.isArray(chatMessages) ? chatMessages : []) {
    const who = m?.role === 'user' ? 'LEARNER' : 'YOU'
    const text = asStr(m?.text).replace(/\s+/g, ' ').trim()
    if (text) parts.push(`${who}: ${text}`)
  }

  const mt = metrics && typeof metrics === 'object' ? metrics : {}
  parts.push('')
  parts.push(`本地统计：最长连续表达 ${Number(mt.longestSeconds) || 0} 秒，累计 ${Number(mt.totalSeconds) || 0} 秒，录音段数 ${Number(mt.segments) || 0}。`)
  parts.push('')
  parts.push('请输出上面的 JSON。')
  return { system: SYSTEM_FINISH, user: parts.join('\n') }
}

function normalizeFinish(raw, { metrics, chunks = [] } = {}) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const rep = o.report && typeof o.report === 'object' ? o.report : {}
  const summary = asStr(rep.summary).trim().slice(0, 600)
  if (!summary) return { ok: false, chatFeedback: null, report: null }

  const m = metrics && typeof metrics === 'object' ? metrics : {}
  return {
    ok: true,
    chatFeedback: normalizeStepFeedback(o.chatFeedback, { itemCount: 0, chunks }),
    report: {
      score: clampScore(rep.score),
      summary,
      nextSuggestions: cleanList(rep.nextSuggestions, 3),
      speaking: {
        longestSeconds: Math.max(0, Math.round(Number(m.longestSeconds) || 0)),
        totalSeconds: Math.max(0, Math.round(Number(m.totalSeconds) || 0)),
        segments: Math.max(0, Math.round(Number(m.segments) || 0)),
      },
    },
  }
}

module.exports = {
  RECALL_COUNT,
  CHUNK_COUNT,
  TRANSFORMATION_COUNT,
  MIN_TOPIC_SECONDS,
  MAX_TOPIC_SECONDS,
  DEFAULT_TOPIC_SECONDS,
  normalizeChunkKey,
  isEvidenceInTranscript,
  buildFallbackChunks,
  buildChallengePrompt,
  normalizeChallenge,
  buildTranscriptDigest,
  buildStepFeedbackPrompt,
  normalizeStepFeedback,
  buildChatTurnPrompt,
  normalizeChatReply,
  buildFinishPrompt,
  normalizeFinish,
}
