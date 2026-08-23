// AI 对话引擎：主题提取(Prompt F0) + 开场白(F1) + 回复(F2) + 批量解析(F3)。
// AI 不可用时走本地降级（禁伪造）。纯函数/可测部分与 AI 调用分离。

const { chat, extractJson, isConfigured } = require('./provider.cjs')

const PROMPT_VERSION = 'topics-v1'

// ── Prompt F0：主题提取器（重点单词/常用短语/搭配）────────────────
const SYSTEM_TOPICS = `You are an expert English teaching assistant. Extract the most valuable vocabulary items from a video transcript for a Chinese English learner.

Return STRICT JSON only, no markdown, in this exact shape:
{
  "words": [{"word": "concierge", "meaning": "礼宾员", "count": 3}],
  "phrases": [{"phrase": "check in", "meaning": "办理入住", "example": "We checked in at the hotel."}],
  "collocations": [{"collocation": "take care of", "meaning": "照顾/处理", "example": "The concierge took care of our bags."}]
}

Rules:
- words: 8-12 high-frequency / high-value content words (nouns, verbs, adjectives) that a Chinese learner should know. Include count of occurrences. Prefer words tied to the video's scene (objects, actions).
- phrases: 5-8 useful spoken chunks/phrases (2-4 words) from the transcript, e.g. "check in", "take the lift".
- collocations: 3-5 common word partnerships (verb+noun, adj+noun), each with a natural example.
- All meanings in Chinese. Examples must be short, natural English.
- Do NOT include trivial words (the, a, and, is, are, was).`

function buildTopicsPrompt({ videoTitle, segments }) {
  const transcript = segments
    .slice(0, 150)
    .map(s => `[${s.segmentIndex}] ${s.textEn}`)
    .join('\n')
  const user = [
    `video_title: ${videoTitle}`,
    'transcript_segments (segment_index | English):',
    transcript,
  ].join('\n')
  return { system: SYSTEM_TOPICS, user }
}

// 本地降级：复用口语模式字典提取短语 + 词频统计提取高频实词
const LOCAL_PHRASE_PATTERNS = [
  { re: /\bcheck(?:ed)? in\b/i, phrase: 'check in', meaning: '办理入住/值机', example: 'We checked in at the hotel.' },
  { re: /\blet'?s (?:go|take|see|try|get)\b/i, phrase: "let's ...", meaning: '我们……吧', example: "Let's take the lift." },
  { re: /\bthere'?s (?:a|an|some|no)\b/i, phrase: "there's ...", meaning: '有……', example: "There's a lot of wind." },
  { re: /\bneed to\b/i, phrase: 'need to ...', meaning: '需要……', example: 'I need to go to my room.' },
  { re: /\bwant to\b/i, phrase: 'want to ...', meaning: '想……', example: 'I want to see the beach.' },
  { re: /\bgoing to\b/i, phrase: 'going to ...', meaning: '将要……', example: 'We are going to the 21st floor.' },
  { re: /\blooks? like\b/i, phrase: 'looks like ...', meaning: '看起来像……', example: 'It looks like rain.' },
  { re: /\b(?:this|that) is (?:a|an|the|my|your)\b/i, phrase: 'this is a ...', meaning: '这是一个……', example: 'This is a railing.' },
  { re: /\byou can (?:see|use|find)\b/i, phrase: 'you can see ...', meaning: '你可以看到……', example: 'You can see the lake.' },
  { re: /\bmade of\b/i, phrase: 'made of ...', meaning: '由……制成', example: 'It is made of stone.' },
  { re: /\bwelcome to\b/i, phrase: 'welcome to ...', meaning: '欢迎来到……', example: 'Welcome to the hotel.' },
  { re: /\bthank(?:s| you)\b/i, phrase: 'thank you', meaning: '谢谢', example: 'Thank you very much.' },
  { re: /\bno problem\b/i, phrase: 'no problem', meaning: '没问题', example: 'No problem, I can help.' },
  { re: /\bof course\b/i, phrase: 'of course', meaning: '当然', example: 'Of course, this way please.' },
  { re: /\bgood (?:morning|afternoon|evening)\b/i, phrase: 'good morning', meaning: '早上好', example: 'Good morning, sir.' },
]

const STOP_WORDS = new Set(('the a an and or but is are was were be been being to of in on at for with from by as it its this that these those i you he she we they them his her their my your our do does did have has had can could would should will shall may might not no yes so there here what when where who why how which if then than just very really about into over under again all any both each few more most other some such only own same too up down out off on in').split(' '))

function localExtractTopics(segments) {
  // 短语：模式匹配（去重，最多 6）
  const phrases = []
  const seenPhrases = new Set()
  for (const seg of segments) {
    const en = (seg.textEn || '').trim()
    if (!en || en.split(/\s+/).length < 2) continue
    for (const p of LOCAL_PHRASE_PATTERNS) {
      if (p.re.test(en) && !seenPhrases.has(p.phrase)) {
        seenPhrases.add(p.phrase)
        phrases.push({ phrase: p.phrase, meaning: p.meaning, example: p.example })
        break
      }
    }
    if (phrases.length >= 6) break
  }
  // 单词：词频统计（去停用词，去纯数字/标点，取 top 10）
  const freq = new Map()
  for (const seg of segments) {
    const words = String(seg.textEn || '').toLowerCase().match(/[a-z']{3,}/g) || []
    for (const w of words) {
      if (STOP_WORDS.has(w)) continue
      freq.set(w, (freq.get(w) || 0) + 1)
    }
  }
  const words = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }))
  // 搭配：本地降级不产出（AI 主路径才产出），保持结构完整
  // 短语兜底：完全没有短语匹配的视频（实测 ~10.6%）用高频词当目标表达，
  // 保证「试试用」提示与 missing_expression 解析在这些视频上仍可用
  if (phrases.length === 0) {
    for (const w of words.slice(0, 3)) {
      if (!seenPhrases.has(w.word)) {
        seenPhrases.add(w.word)
        phrases.push({ phrase: w.word, meaning: '', example: '', fromWord: true })
      }
    }
  }
  return { words, phrases, collocations: [], source: 'local' }
}

// ── Prompt F1：开场白 ────────────────────────────────────
const SYSTEM_OPENING = `You are a friendly English conversation partner. Start a natural conversation with a Chinese English learner about the video they just watched.

Rules:
- Speak in natural, simple English (short sentences, 1-2 sentences max).
- Tie the opening to the video's topic/words/phrases listed below.
- Naturally use at least one of the provided phrases.
- Ask an open question so the learner can reply.
- Do NOT translate into Chinese. Do NOT greet formally. Start with the conversation directly.`

// 中文等级标签 → 英文（prompt 面向英文模型，避免 gpt-4o-mini 等不理解「中级」）
function mapLearnerLevel(level) {
  const s = String(level || '')
  if (/初/.test(s)) return 'beginner'
  if (/高/.test(s)) return 'advanced'
  return 'intermediate'
}

function buildOpeningPrompt({ videoTitle, topics, level }) {
  const topicText = [
    `video_title: ${videoTitle}`,
    `learner_level: ${mapLearnerLevel(level)}`,
    `key_words: ${(topics.words || []).map(w => w.word).join(', ')}`,
    `key_phrases: ${(topics.phrases || []).map(p => p.phrase).join(', ')}`,
    `collocations: ${(topics.collocations || []).map(c => c.collocation).join(', ')}`,
  ].join('\n')
  return { system: SYSTEM_OPENING, user: topicText }
}

// ── Prompt F2：AI 回复 ───────────────────────────────────
const SYSTEM_REPLY = `You are a friendly English conversation partner. Continue the conversation naturally.

Rules:
- Reply in natural, simple English (1-2 short sentences).
- Acknowledge what the learner said, then ask a follow-up question that keeps the conversation going.
- If the learner made a small mistake, do NOT correct them harshly — model the correct form naturally in your reply.
- Try to use one of the target phrases naturally if it fits.
- Do NOT translate. Do NOT lecture. Keep it conversational.`

function buildReplyPrompt({ topics, history, level }) {
  const topicText = [
    `video_title: ${topics.videoTitle || ''}`,
    `learner_level: ${mapLearnerLevel(level)}`,
    `key_words: ${(topics.words || []).map(w => w.word).join(', ')}`,
    `key_phrases: ${(topics.phrases || []).map(p => p.phrase).join(', ')}`,
    `collocations: ${(topics.collocations || []).map(c => c.collocation).join(', ')}`,
  ].join('\n')
  const historyText = history.map(m => `${m.role.toUpperCase()}: ${m.content ?? m.text}`).join('\n')
  const user = `${topicText}\n\nConversation so far:\n${historyText}\n\nContinue:`
  return { system: SYSTEM_REPLY, user }
}

// ── Prompt F3：批量解析 ──────────────────────────────────
const SYSTEM_REVIEW = `You are a friendly English speaking coach (NOT a grammar teacher). Review the learner's turns in a conversation and give helpful, encouraging feedback.

Return STRICT JSON only, no markdown, in this exact shape:
{
  "turns": [
    {
      "turn": 3,
      "score": 76,
      "issues": [
        {
          "type": "grammar|word_choice|naturalness|missing_expression|incomplete",
          "location": "the problematic text",
          "problem": "what's wrong (in Chinese, brief)",
          "suggestion": "how to fix (in Chinese, brief)",
          "better": "a corrected natural English version of this part"
        }
      ],
      "praise": "one encouraging sentence about what they did well"
    }
  ],
  "summary": "overall assessment in Chinese (2-3 sentences, mention the 1 most important thing to improve)",
  "best_turn": 3
}

Rules:
- One entry per learner (user) turn. Set "turn" to the learner turn index: 1 for the first learner message, 2 for the second, and so on.
- Before each message you may see an [id] number in brackets — use it ONLY to disambiguate repeated text; the "turn" field must still be the 1-based learner index.
- score 0-100: 90+ = excellent, 75-89 = good with small issues, 60-74 = understandable but needs work, <60 = hard to understand.
- Focus on grammar, word choice, naturalness. Only flag "missing_expression" when the conversation clearly called for a target phrase.
- Naturalness matters more than perfect grammar. Never say "wrong" harshly.
- Keep issues focused: 0-3 per turn. praise is mandatory (short, genuine).
- If a turn is unparseable, still include it with score null and empty issues.`

function buildReviewPrompt({ topics, history }) {
  const topicText = [
    `video_title: ${topics.videoTitle || ''}`,
    `key_words: ${(topics.words || []).map(w => w.word).join(', ')}`,
    `key_phrases: ${(topics.phrases || []).map(p => p.phrase).join(', ')}`,
    `collocations: ${(topics.collocations || []).map(c => c.collocation).join(', ')}`,
  ].join('\n')
  const historyText = history.map(m => `${m.role.toUpperCase()}: ${m.content ?? m.text}`).join('\n')
  const user = `${topicText}\n\nFull conversation:\n${historyText}\n\nReview the learner's turns.`
  return { system: SYSTEM_REVIEW, user }
}

// ── 历史组装（DB 行 → AI 消息数组；review 时只送用户轮次 + 最近 2 条 AI）──
function buildHistory(messages, { forReview = false } = {}) {
  if (forReview) {
    // DB 行按 id 有序；取最近 2 条 AI + 全部用户轮次，保持原始时间顺序。
    // 每条带 [id] 前缀供 AI 引用消歧（写回按位置映射，不依赖 AI 编号）。
    const userMsgs = messages.filter(m => m.role === 'user')
    const aiMsgs = messages.filter(m => m.role === 'ai').slice(-2)
    const all = [...aiMsgs, ...userMsgs].sort((a, b) => (a.id || 0) - (b.id || 0))
    return all.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: `[${m.id}] ${m.text}` }))
  }
  return messages.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text }))
}

// ── 主题提取主入口（AI 或本地降级）────────────────────────
async function extractConversationTopics({ videoTitle, level, segments }) {
  if (isConfigured()) {
    try {
      const prompt = buildTopicsPrompt({ videoTitle, segments })
      const content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.3, maxTokens: 1200 }
      )
      const json = extractJson(content)
      const topics = {
        words: Array.isArray(json.words) ? json.words.slice(0, 12) : [],
        phrases: Array.isArray(json.phrases) ? json.phrases.slice(0, 8) : [],
        collocations: Array.isArray(json.collocations) ? json.collocations.slice(0, 5) : [],
        source: 'ai',
      }
      if (topics.words.length > 0 || topics.phrases.length > 0) return topics
    } catch (err) {
      console.error('[conversation] 主题提取 AI 失败，走本地兜底:', err.message)
    }
  }
  return localExtractTopics(segments)
}

module.exports = {
  PROMPT_VERSION,
  buildTopicsPrompt,
  buildOpeningPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  localExtractTopics,
  buildHistory,
  extractConversationTopics,
}
