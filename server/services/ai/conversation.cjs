// AI 对话引擎：主题提取(Prompt F0) + 开场白(F1) + 回复(F2) + 批量解析(F3)。
// AI 不可用时走本地降级（禁伪造）。纯函数/可测部分与 AI 调用分离。

const { chat, extractJson, isConfigured } = require('./provider.cjs')

const PROMPT_VERSION = 'topics-v1'
const SCENE_PROMPT_VERSION = 'scene-v1'

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

// ── Prompt F0b：场景提取器（场景/角色/上下文/核心表达）────────────
const SYSTEM_SCENE = `You are an expert English teaching assistant. Given a video's title, description, topic tags, and transcript, design a role-play scenario so a Chinese English learner can practice speaking in a realistic situation inspired by the video.

Return STRICT JSON only, no markdown, in this exact shape:
{
  "scene": "Hotel Check-in",
  "sceneCn": "酒店入住",
  "setting": "The front desk of a British hotel in the afternoon",
  "userRole": "guest",
  "userRoleCn": "客人",
  "aiRole": "front desk receptionist",
  "aiRoleCn": "前台接待",
  "context": "You just arrived and need to check in for your reservation",
  "contextCn": "你刚到达酒店，需要办理入住",
  "coreExpressions": [{"phrase": "check in", "meaning": "办理入住"}]
}

Rules:
- scene: a short English label for the situation.
- setting: one short English sentence describing where/when the role-play happens.
- userRole / aiRole: the learner's role and the AI's role, in English (aiRole is the character the AI will play).
- context: one short English sentence describing what is happening right now / what the learner should do.
- sceneCn/settingCn/userRoleCn/aiRoleCn/contextCn: natural Chinese translations for display.
- coreExpressions: 3-6 useful spoken expressions (2-4 words each) the learner could use in this role-play, each with a Chinese meaning.
- Pick roles that create a natural two-person dialogue. If the video is a vlog/monologue/lecture, invent a plausible conversational counterpart (e.g. a local friend, a listener asking questions).
- The scenario must feel real and specific, not generic.`

function buildScenePrompt({ videoTitle, description, topic, topics, level, segments }) {
  const transcript = segments
    .slice(0, 150)
    .map(s => `[${s.segmentIndex}] ${s.textEn}`)
    .join('\n')
  const user = [
    `video_title: ${videoTitle}`,
    `video_description: ${description || ''}`,
    `video_topic: ${topic || ''}`,
    `topic_tags: ${(topics || []).join(', ')}`,
    `learner_level: ${mapLearnerLevel(level)}`,
    'transcript_segments (segment_index | English):',
    transcript,
  ].join('\n')
  return { system: SYSTEM_SCENE, user }
}

// 本地降级：标题/话题关键词 → 场景档案（source: 'local'，不伪造 AI 结果）
const LOCAL_SCENES = [
  {
    re: /酒店|hotel|check[-\s]?in|入住|front desk|reception|房间|room service/i,
    scene: 'Hotel Check-in', sceneCn: '酒店入住',
    setting: 'At the front desk of a hotel', settingCn: '在一家酒店的前台',
    userRole: 'guest', userRoleCn: '客人',
    aiRole: 'front desk receptionist', aiRoleCn: '前台接待',
    context: 'You just arrived at the hotel and need to check in', contextCn: '你刚到达酒店，需要办理入住',
    coreExpressions: [
      { phrase: 'check in', meaning: '办理入住' },
      { phrase: 'I have a reservation', meaning: '我预订了房间' },
      { phrase: 'under the name of ...', meaning: '以……的名字预订' },
      { phrase: 'What time is breakfast?', meaning: '早餐几点？' },
    ],
  },
  {
    re: /点餐|餐厅|饭店|restaurant|order(?:ing)? food|waiter|waitress|menu|菜单|服务员|dinner|lunch/i,
    scene: 'Ordering Food', sceneCn: '餐厅点餐',
    setting: 'At a restaurant, ready to order', settingCn: '在一家餐厅，准备点餐',
    userRole: 'customer', userRoleCn: '顾客',
    aiRole: 'waiter', aiRoleCn: '服务员',
    context: 'You are ready to order your food and drinks', contextCn: '你准备点餐',
    coreExpressions: [
      { phrase: 'Could I see the menu?', meaning: '可以看下菜单吗？' },
      { phrase: "I'd like to order", meaning: '我想点餐' },
      { phrase: 'What do you recommend?', meaning: '有什么推荐？' },
      { phrase: 'the bill, please', meaning: '请结账' },
    ],
  },
  {
    re: /面试|interview/i,
    scene: 'Job Interview', sceneCn: '求职面试',
    setting: 'In an interview room', settingCn: '在一间面试室里',
    userRole: 'job candidate', userRoleCn: '求职者',
    aiRole: 'interviewer', aiRoleCn: '面试官',
    context: 'The interview has just begun', contextCn: '面试刚刚开始',
    coreExpressions: [
      { phrase: 'I have experience in ...', meaning: '我在……方面有经验' },
      { phrase: 'my strengths are ...', meaning: '我的优势是……' },
      { phrase: 'I am a quick learner', meaning: '我学得很快' },
      { phrase: 'tell me about yourself', meaning: '介绍一下你自己' },
    ],
  },
  {
    re: /机场|airport|flight|boarding|值机|登机|航班|check[-\s]?in counter/i,
    scene: 'Airport Check-in', sceneCn: '机场值机',
    setting: 'At the airport check-in counter', settingCn: '在机场值机柜台',
    userRole: 'passenger', userRoleCn: '乘客',
    aiRole: 'check-in agent', aiRoleCn: '值机员',
    context: 'You need to check in for your flight and check your luggage', contextCn: '你需要办理登机并托运行李',
    coreExpressions: [
      { phrase: 'check in', meaning: '办理值机' },
      { phrase: 'window seat', meaning: '靠窗座位' },
      { phrase: 'carry-on luggage', meaning: '随身行李' },
      { phrase: 'boarding pass', meaning: '登机牌' },
    ],
  },
  {
    re: /购物|shopping|store|shop|mall|超市|商场|买|店/i,
    scene: 'Shopping', sceneCn: '购物',
    setting: 'In a clothing store', settingCn: '在一家服装店',
    userRole: 'shopper', userRoleCn: '顾客',
    aiRole: 'shop assistant', aiRoleCn: '店员',
    context: 'You are looking for something to buy', contextCn: '你想买点东西',
    coreExpressions: [
      { phrase: "I'm looking for ...", meaning: '我在找……' },
      { phrase: 'Can I try this on?', meaning: '我可以试穿吗？' },
      { phrase: 'Do you have this in another size?', meaning: '这个有别的尺码吗？' },
      { phrase: 'How much is it?', meaning: '多少钱？' },
    ],
  },
  {
    re: /咖啡|coffee|cafe|café|星巴克|starbucks|拿铁|latte/i,
    scene: 'Ordering Coffee', sceneCn: '咖啡店点单',
    setting: 'At a coffee shop counter', settingCn: '在咖啡店柜台',
    userRole: 'customer', userRoleCn: '顾客',
    aiRole: 'barista', aiRoleCn: '咖啡师',
    context: 'You want to order a drink', contextCn: '你想点一杯饮品',
    coreExpressions: [
      { phrase: 'Can I get a ...?', meaning: '我要一杯……' },
      { phrase: 'to go', meaning: '带走' },
      { phrase: 'for here', meaning: '堂食' },
      { phrase: 'decaf', meaning: '无咖啡因' },
    ],
  },
  {
    re: /演讲|speech|talk|ted|speaker|采访|访谈|专访|脱口秀/i,
    scene: 'After-talk Q&A', sceneCn: '演讲后问答',
    setting: 'After a talk, the speaker is taking questions', settingCn: '演讲结束后，讲者在接受提问',
    userRole: 'audience member', userRoleCn: '听众',
    aiRole: 'speaker', aiRoleCn: '演讲者',
    context: 'You want to ask the speaker a question', contextCn: '你想向演讲者提问',
    coreExpressions: [
      { phrase: 'Could you tell us more about ...?', meaning: '你能多讲讲……吗？' },
      { phrase: "I'm curious about ...", meaning: '我对……很好奇' },
      { phrase: 'What inspired you to ...?', meaning: '是什么启发你……？' },
      { phrase: 'Thanks for sharing', meaning: '谢谢分享' },
    ],
  },
  {
    re: /旅行|travel|trip|vlog|漫游|游记|tour|旅程|度假|holiday/i,
    scene: 'Travel Chat', sceneCn: '旅行闲聊',
    setting: 'Chatting with a friendly local you just met', settingCn: '和刚认识的当地朋友聊天',
    userRole: 'traveler', userRoleCn: '旅行者',
    aiRole: 'local friend', aiRoleCn: '当地朋友',
    context: 'You are exploring a new place and chatting with a local', contextCn: '你在探索一个新地方，和当地人聊天',
    coreExpressions: [
      { phrase: 'Could you recommend ...?', meaning: '你能推荐……吗？' },
      { phrase: 'How do I get to ...?', meaning: '去……怎么走？' },
      { phrase: "I've always wanted to visit", meaning: '我一直想去' },
      { phrase: "What's this place famous for?", meaning: '这里以什么闻名？' },
    ],
  },
  {
    re: /医疗|医生|医院|doctor|hospital|health|急诊|急救|medicine/i,
    scene: "Doctor's Visit", sceneCn: '看医生',
    setting: "At a doctor's office", settingCn: '在诊所里',
    userRole: 'patient', userRoleCn: '病人',
    aiRole: 'doctor', aiRoleCn: '医生',
    context: 'You need to tell the doctor how you feel', contextCn: '你需要向医生描述你的症状',
    coreExpressions: [
      { phrase: "I've been feeling ...", meaning: '我一直感觉……' },
      { phrase: 'I have a headache', meaning: '我头疼' },
      { phrase: 'How long will it take?', meaning: '要多久才能好？' },
    ],
  },
  {
    re: /商务|职场|工作|office|business|meeting|同事|老板|manager|项目/i,
    scene: 'Work Conversation', sceneCn: '职场对话',
    setting: 'At the office, talking with a colleague', settingCn: '在办公室和同事聊天',
    userRole: 'new team member', userRoleCn: '新同事',
    aiRole: 'colleague', aiRoleCn: '同事',
    context: 'You are meeting a colleague to talk about work', contextCn: '你和同事聊工作',
    coreExpressions: [
      { phrase: 'Could you help me with ...?', meaning: '你能帮我……吗？' },
      { phrase: "I'll get it done by ...", meaning: '我会在……前完成' },
      { phrase: 'Let me check', meaning: '我确认一下' },
    ],
  },
]

const LOCAL_SCENE_FALLBACK = {
  scene: 'Everyday Chat', sceneCn: '日常闲聊',
  setting: 'A casual everyday conversation', settingCn: '一场轻松的日常对话',
  userRole: 'yourself', userRoleCn: '你自己',
  aiRole: 'a friendly English speaker', aiRoleCn: '一位友好的英语母语者',
  context: 'You are having a casual conversation', contextCn: '你们在随意聊天',
  coreExpressions: [
    { phrase: 'What do you think?', meaning: '你怎么看？' },
    { phrase: 'That sounds ...', meaning: '听起来……' },
    { phrase: 'I agree', meaning: '我同意' },
  ],
}

function localDetectScene({ videoTitle, description, topic, topics }) {
  const text = [videoTitle, description, topic, ...(topics || [])].filter(Boolean).join(' ')
  for (const s of LOCAL_SCENES) {
    if (s.re.test(text)) {
      const { re, ...scene } = s
      return { ...scene, source: 'local' }
    }
  }
  return { ...LOCAL_SCENE_FALLBACK, source: 'local' }
}

// 场景提取主入口（AI 或本地降级）
async function extractSceneProfile({ videoTitle, description, topic, topics, level, segments }) {
  if (isConfigured()) {
    try {
      const prompt = buildScenePrompt({ videoTitle, description, topic, topics, level, segments })
      const content = await chat(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.3, maxTokens: 800 }
      )
      const json = extractJson(content)
      if (json && json.scene) {
        return {
          scene: String(json.scene || ''),
          sceneCn: String(json.sceneCn || ''),
          setting: String(json.setting || ''),
          userRole: String(json.userRole || ''),
          userRoleCn: String(json.userRoleCn || ''),
          aiRole: String(json.aiRole || ''),
          aiRoleCn: String(json.aiRoleCn || ''),
          context: String(json.context || ''),
          contextCn: String(json.contextCn || ''),
          coreExpressions: Array.isArray(json.coreExpressions) ? json.coreExpressions.slice(0, 6) : [],
          source: 'ai',
        }
      }
    } catch (err) {
      console.error('[conversation] 场景提取 AI 失败，走本地兜底:', err.message)
    }
  }
  return localDetectScene({ videoTitle, description, topic, topics })
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

const SYSTEM_OPENING_ROLEPLAY = `You are role-playing in an English conversation practice for a Chinese English learner. You MUST stay in character as the role given below.

Rules:
- Stay in character at all times. You are playing the AI role; the learner is playing their own role.
- Start the role-play naturally in character: set the scene the way a real person in this role would, and ask an open question that keeps the conversation going.
- Speak in natural, simple English (1-2 short sentences).
- Match the learner's level (beginner/intermediate/advanced).
- Naturally use at least one of the target expressions if it fits, but do not force it.
- Do NOT recite the video script. Do NOT translate into Chinese. Do NOT break character. Do NOT greet formally like an assistant.`

function buildOpeningPrompt({ videoTitle, topics, level, scene }) {
  const topicText = [
    `video_title: ${videoTitle}`,
    `learner_level: ${mapLearnerLevel(level)}`,
    `key_words: ${(topics.words || []).map(w => w.word).join(', ')}`,
    `key_phrases: ${(topics.phrases || []).map(p => p.phrase).join(', ')}`,
    `collocations: ${(topics.collocations || []).map(c => c.collocation).join(', ')}`,
  ].join('\n')
  if (scene && scene.scene) {
    const roleText = [
      'ROLE-PLAY SCENARIO',
      `scene: ${scene.scene}`,
      `setting: ${scene.setting || ''}`,
      `you (AI) play: ${scene.aiRole || ''}`,
      `the learner plays: ${scene.userRole || ''}`,
      `current context: ${scene.context || ''}`,
      `target expressions: ${(scene.coreExpressions || []).map(e => `${e.phrase} (${e.meaning || ''})`).join(', ')}`,
      '',
      topicText,
    ].join('\n')
    return { system: SYSTEM_OPENING_ROLEPLAY, user: roleText }
  }
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

const SYSTEM_REPLY_ROLEPLAY = `You are role-playing in an English conversation practice for a Chinese English learner. You MUST stay in character as the role given below.

Rules:
- Stay in character at all times — never step out of the role.
- Acknowledge what the learner said in character, then advance the scenario naturally with a follow-up question or action.
- Do NOT recite the video script. Do NOT repeat the learner's words back verbatim.
- If the learner made a small mistake, model the correct form naturally in your reply (do not correct harshly).
- Try to use one of the target expressions naturally if it fits.
- Speak in natural, simple English (1-2 short sentences). Do NOT translate. Keep it conversational.`

function buildReplyPrompt({ topics, history, level, scene }) {
  const topicText = [
    `video_title: ${topics.videoTitle || ''}`,
    `learner_level: ${mapLearnerLevel(level)}`,
    `key_words: ${(topics.words || []).map(w => w.word).join(', ')}`,
    `key_phrases: ${(topics.phrases || []).map(p => p.phrase).join(', ')}`,
    `collocations: ${(topics.collocations || []).map(c => c.collocation).join(', ')}`,
  ].join('\n')
  const historyText = history.map(m => `${m.role.toUpperCase()}: ${m.content ?? m.text}`).join('\n')
  if (scene && scene.scene) {
    const roleText = [
      'ROLE-PLAY SCENARIO',
      `scene: ${scene.scene}`,
      `you (AI) play: ${scene.aiRole || ''}`,
      `the learner plays: ${scene.userRole || ''}`,
      `current context: ${scene.context || ''}`,
      `target expressions: ${(scene.coreExpressions || []).map(e => `${e.phrase} (${e.meaning || ''})`).join(', ')}`,
      '',
      topicText,
      '',
      `Conversation so far:\n${historyText}`,
      '',
      'Continue in character:',
    ].join('\n')
    return { system: SYSTEM_REPLY_ROLEPLAY, user: roleText }
  }
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
  SCENE_PROMPT_VERSION,
  buildTopicsPrompt,
  buildScenePrompt,
  buildOpeningPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  localExtractTopics,
  localDetectScene,
  extractSceneProfile,
  buildHistory,
  extractConversationTopics,
}
