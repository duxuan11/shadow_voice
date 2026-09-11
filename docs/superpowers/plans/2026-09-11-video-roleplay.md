# 视频场景 × AI Role Play 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个视频的 AI 对话自动进入该视频对应的角色扮演场景（场景识别 → 角色分配 → Role Play）。

**Architecture:** 扩展现有 `server/services/ai/conversation.cjs` 引擎，新增「场景提取」（F0b）+ 本地降级，改造开场白(F1)/回复(F2)为角色扮演；`routes/conversation.cjs` 新增 `getSceneForVideo` 缓存 + 会话 `scene_json` 列；前端 `ConversationPage` 新增场景横幅。复用现有 `ai_cache` 表、`ensureColumn` 迁移、`authFetch`、ASR/TTS/解析面板。

**Tech Stack:** Node 22 + Express 5 (CJS) + sql.js (SQLite) + React 19 + Vite 8 + node:test

## Global Constraints

- 复用现有 API / 组件 / 数据库，不重构项目结构。
- 不新增社区、排行榜、积分、课程体系等无关功能。
- 不改变现有核心 UI 风格（场景横幅沿用 indigo 配色）。
- 所有改动向后兼容：`scene` 参数可选，旧会话 `scene_json` 为空 → 不显示横幅。
- 测试命令：`node --test <file>`；后端测试文件为 `*.test.cjs`。
- 提交信息使用中文描述（沿用仓库风格 `feat:` / `fix:` 前缀）。

---

## 文件结构

- **Modify** `server/services/ai/conversation.cjs` — 场景提取 prompt + 本地降级 + 开场/回复角色扮演改造。
- **Test** `server/services/ai/conversation.test.cjs` — 场景纯函数单测。
- **Modify** `server/db.cjs` — `conversation_sessions` 新增 `scene_json` 列（幂等迁移）。
- **Modify** `server/routes/conversation.cjs` — `getSceneForVideo` + 存储/返回 scene + `pickTargetPhrase` 改造。
- **Test** `server/routes/conversation-ai.test.cjs` — 场景落库/返回集成测试。
- **Modify** `src/pages/ConversationPage.jsx` — `scene` state + 场景横幅。
- **Modify** `src/index.css` — 场景横幅样式。

---

### Task 1: 场景引擎（提取 prompt + 本地降级 + 开场/回复角色扮演）

**Files:**
- Modify: `server/services/ai/conversation.cjs`
- Test: `server/services/ai/conversation.test.cjs`

**Interfaces:**
- Consumes: 现有 `chat` / `extractJson` / `isConfigured`（来自 `./provider.cjs`）。
- Produces（供 Task 2 路由使用）：
  - `SCENE_PROMPT_VERSION`（字符串 `'scene-v1'`）
  - `buildScenePrompt({ videoTitle, description, topic, topics, level, segments })` → `{ system, user }`
  - `localDetectScene({ videoTitle, description, topic, topics })` → scene 对象（含 `source:'local'`）
  - `extractSceneProfile({ videoTitle, description, topic, topics, level, segments })` → Promise<scene 对象>
  - `buildOpeningPrompt({ videoTitle, topics, level, scene? })` / `buildReplyPrompt({ topics, history, level, scene? })` — `scene` 可选。

**Scene 对象形状（所有场景字段均为字符串，`coreExpressions` 为数组）：**
```js
{ scene, sceneCn, setting, userRole, userRoleCn, aiRole, aiRoleCn, context, contextCn, coreExpressions: [{phrase, meaning}], source }
```

- [ ] **Step 1: 在 `conversation.test.cjs` 写入失败测试**

在文件顶部 require 处补充新导出，并在末尾追加测试。先改 require：

```js
const {
  PROMPT_VERSION,
  SCENE_PROMPT_VERSION,
  buildTopicsPrompt,
  buildScenePrompt,
  buildOpeningPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  localExtractTopics,
  localDetectScene,
  buildHistory,
} = require('./conversation.cjs')
```

追加测试（文件末尾）：

```js
test('SCENE_PROMPT_VERSION 稳定用于场景缓存键', () => {
  assert.equal(SCENE_PROMPT_VERSION, 'scene-v1')
})

test('buildScenePrompt 包含标题/描述/话题/字幕', () => {
  const p = buildScenePrompt({ videoTitle: '酒店日常', description: '出国旅行酒店英语', topic: '旅游出行', topics: ['旅行'], level: '初级', segments })
  assert.ok(p.system.includes('design a role-play scenario'))
  assert.ok(p.user.includes('酒店日常'))
  assert.ok(p.user.includes('出国旅行酒店英语'))
  assert.ok(p.user.includes('checked in'))
})

test('localDetectScene 酒店关键词 → 前台场景', () => {
  const s = localDetectScene({ videoTitle: '酒店英语课程', description: '如何在酒店办理入住', topic: '出行', topics: ['旅行'] })
  assert.equal(s.scene, 'Hotel Check-in')
  assert.equal(s.aiRole, 'front desk receptionist')
  assert.equal(s.userRole, 'guest')
  assert.equal(s.source, 'local')
  assert.ok(Array.isArray(s.coreExpressions) && s.coreExpressions.length >= 1)
})

test('localDetectScene 无匹配 → 通用场景兜底', () => {
  const s = localDetectScene({ videoTitle: '海边风景', description: '', topic: '自然风光', topics: [] })
  assert.ok(s.scene)
  assert.ok(s.aiRole)
  assert.ok(s.userRole)
  assert.equal(s.source, 'local')
})

test('buildOpeningPrompt 有 scene → 角色扮演 system prompt + 场景信息', () => {
  const scene = { scene: 'Hotel Check-in', setting: 'hotel front desk', userRole: 'guest', aiRole: 'front desk receptionist', context: 'check in', coreExpressions: [{ phrase: 'check in', meaning: '办理入住' }] }
  const p = buildOpeningPrompt({ videoTitle: '酒店日常', topics: { words: [] }, level: '中级', scene })
  assert.ok(p.system.includes('Stay in character'))
  assert.ok(p.user.includes('front desk receptionist'))
  assert.ok(p.user.includes('guest'))
  assert.ok(p.user.includes('check in'))
})

test('buildOpeningPrompt 无 scene → 原自由对话 prompt（向后兼容）', () => {
  const p = buildOpeningPrompt({ videoTitle: '酒店日常', topics: { words: [] }, level: '中级' })
  assert.ok(p.system.includes('conversation partner'))
  assert.ok(!p.system.includes('Stay in character'))
})

test('buildReplyPrompt 有 scene → 保持角色', () => {
  const history = [{ role: 'ai', text: 'q' }, { role: 'user', text: 'a' }]
  const scene = { scene: 'Hotel Check-in', aiRole: 'front desk receptionist' }
  const p = buildReplyPrompt({ topics: { words: [] }, history, scene })
  assert.ok(p.system.includes('Stay in character'))
  assert.ok(p.user.includes('front desk receptionist'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/services/ai/conversation.test.cjs`
Expected: 新测试 FAIL（`SCENE_PROMPT_VERSION`/`buildScenePrompt`/`localDetectScene` 未导出；`buildOpeningPrompt`/`buildReplyPrompt` 的 system 不含 'Stay in character'）。

- [ ] **Step 3: 实现 `conversation.cjs` 新增与改造**

在 `PROMPT_VERSION` 声明下方新增场景版本常量：

```js
const PROMPT_VERSION = 'topics-v1'
const SCENE_PROMPT_VERSION = 'scene-v1'
```

在 `localExtractTopics` 函数之后、`SYSTEM_OPENING` 之前，插入「场景提取 + 本地降级」整段：

```js
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
```

改造 F1 开场白：在现有 `SYSTEM_OPENING` 定义之后，`buildOpeningPrompt` 之前，新增角色扮演 system prompt；并改造 `buildOpeningPrompt` 支持 `scene`。将现有：

```js
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
```

替换为：

```js
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
```

改造 F2 回复：在现有 `SYSTEM_REPLY` 定义之后新增角色扮演回复 prompt，并改造 `buildReplyPrompt`。将现有：

```js
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
```

替换为：

```js
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
```

更新文件末尾 `module.exports`，加入新导出：

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/services/ai/conversation.test.cjs`
Expected: 全部 PASS（含新增 8 个场景测试与原有 11 个）。

- [ ] **Step 5: 提交**

```bash
git add server/services/ai/conversation.cjs server/services/ai/conversation.test.cjs
git commit -m "feat(ai): 场景提取(F0b)+本地降级+开场/回复角色扮演 prompt"
```

---

### Task 2: 路由 + 数据库（scene 缓存、存储、返回）

**Files:**
- Modify: `server/db.cjs`
- Modify: `server/routes/conversation.cjs`
- Test: `server/routes/conversation-ai.test.cjs`

**Interfaces:**
- Consumes: Task 1 导出的 `SCENE_PROMPT_VERSION`、`extractSceneProfile`、改造后的 `buildOpeningPrompt`/`buildReplyPrompt`。
- Produces: `/start` 与 `/:sessionId` 响应新增 `scene` 字段；`conversation_sessions.scene_json` 列存储场景 JSON。

- [ ] **Step 1: 在 `conversation-ai.test.cjs` 写入失败测试**

改动 mock fetch（识别场景提取 prompt，返回场景 JSON），并在文件末尾追加测试。

先改 mock fetch 中 `if` 链（原文件 `let content` 处之前，新增读取 system 消息并前置场景分支）。将现有：

```js
  const body = JSON.parse(opts.body)
  const userContent = body.messages[1].content
  let content
  if (userContent.includes('Review the learner')) {
```

替换为：

```js
  const body = JSON.parse(opts.body)
  const sysContent = body.messages[0].content
  const userContent = body.messages[1].content
  let content
  if (sysContent.includes('design a role-play scenario')) {
    content = JSON.stringify({
      scene: 'Hotel Check-in', sceneCn: '酒店入住',
      setting: 'front desk', userRole: 'guest', userRoleCn: '客人',
      aiRole: 'front desk receptionist', aiRoleCn: '前台接待',
      context: 'check in', contextCn: '办理入住',
      coreExpressions: [{ phrase: 'check in', meaning: '办理入住' }],
    })
  } else if (userContent.includes('Review the learner')) {
```

文件末尾追加测试：

```js
test('场景：/start 提取场景并落库 scene_json + 返回 scene', async () => {
  const res = await fetch(`${baseUrl}/api/conversation/start`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ videoId: 'v1', newSession: true }),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.scene.scene, 'Hotel Check-in')
  assert.equal(body.scene.aiRole, 'front desk receptionist')
  const sess = get('SELECT scene_json FROM conversation_sessions WHERE id=?', [body.session.id])
  assert.ok(sess.scene_json)
  assert.equal(JSON.parse(sess.scene_json).scene, 'Hotel Check-in')
})

test('场景：GET /:sessionId 返回 scene', async () => {
  const sid = seedSession()
  run('UPDATE conversation_sessions SET scene_json=? WHERE id=?',
    [JSON.stringify({ scene: 'Hotel Check-in', aiRole: 'front desk receptionist' }), sid])
  const res = await fetch(`${baseUrl}/api/conversation/${sid}`, { headers: authHeaders() })
  const data = await res.json()
  assert.equal(data.scene.scene, 'Hotel Check-in')
})

test('场景：无 scene_json 的旧会话 GET 返回 scene=null 且 reply 正常', async () => {
  const sid = seedSession()
  const res = await fetch(`${baseUrl}/api/conversation/${sid}`, { headers: authHeaders() })
  const data = await res.json()
  assert.equal(data.scene, null)
  const reply = await fetch(`${baseUrl}/api/conversation/${sid}/reply`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'Yes, the concierge took our bags' }),
  })
  assert.equal(reply.status, 200)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/routes/conversation-ai.test.cjs`
Expected: 前两个新测试 FAIL（`/start` 无 `scene` 字段；`INSERT ... scene_json` 报「no column named scene_json」→ 500）。

- [ ] **Step 3: 实现 db 迁移**

在 `server/db.cjs` 的 `initSchema` 末尾（`ensureColumn('conversation_sessions', 'review_json', 'TEXT')` 之后）追加：

```js
  ensureColumn('conversation_sessions', 'scene_json', 'TEXT')
```

- [ ] **Step 4: 实现路由改造**

`server/routes/conversation.cjs`：

1) 顶部 require 补充新导出。将：

```js
const {
  PROMPT_VERSION,
  extractConversationTopics,
  buildOpeningPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  buildHistory,
} = require('../services/ai/conversation.cjs')
```

替换为：

```js
const {
  PROMPT_VERSION,
  SCENE_PROMPT_VERSION,
  extractConversationTopics,
  extractSceneProfile,
  buildOpeningPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  buildHistory,
} = require('../services/ai/conversation.cjs')
```

2) 在 `getTopicsForVideo` 之后新增 `getSceneForVideo`：

```js
// ── 场景提取（ai_cache 按 video_id + SCENE_PROMPT_VERSION 缓存）──
async function getSceneForVideo(videoId, video) {
  const cached = get('SELECT result FROM ai_cache WHERE video_id=? AND prompt_version=?', [videoId, SCENE_PROMPT_VERSION])
  if (cached) {
    try {
      const parsed = JSON.parse(cached.result)
      if (parsed && parsed.scene) return { ...parsed, fromCache: true }
    } catch { /* 缓存损坏则重新提取 */ }
  }
  const subs = loadSubtitles(video.episode_dir)
    .map((s, i) => ({ segmentIndex: i, textEn: s.textEn, textCn: s.textCn, startTime: s.startTime }))
    .filter((s) => s.textEn && s.textEn.trim())
  const scene = await extractSceneProfile({
    videoTitle: video.title,
    description: video.description || '',
    topic: video.topic || '',
    topics: video.topics || [],
    level: video.level,
    segments: subs,
  })
  run(
    `INSERT INTO ai_cache (video_id, prompt_version, model, result) VALUES (?,?,?,?)
     ON CONFLICT(video_id, prompt_version) DO UPDATE SET result=excluded.result, model=excluded.model, created_at=datetime('now')`,
    [videoId, SCENE_PROMPT_VERSION, scene.source === 'ai' ? 'llm' : 'local-heuristic', JSON.stringify(scene)]
  )
  return { ...scene, fromCache: false }
}
```

3) 改造 `pickTargetPhrase`（优先 scene.coreExpressions）。将现有：

```js
function pickTargetPhrase(topics, userCount) {
  const phrases = Array.isArray(topics.phrases) ? topics.phrases : []
  if (phrases.length === 0) return null
  const p = phrases[userCount % phrases.length]
  return { phrase: p.phrase, meaning: p.meaning || '' }
}
```

替换为：

```js
function pickTargetPhrase(scene, topics, userCount) {
  const expressions = (scene && Array.isArray(scene.coreExpressions)) ? scene.coreExpressions : []
  const phrases = Array.isArray(topics.phrases) ? topics.phrases : []
  const pool = expressions.length > 0 ? expressions : phrases
  if (pool.length === 0) return null
  const p = pool[userCount % pool.length]
  return { phrase: p.phrase, meaning: p.meaning || '' }
}
```

4) `/start`：提取并存储场景。将现有：

```js
    const topics = await getTopicsForVideo(videoId, video)
    const r = run(
      'INSERT INTO conversation_sessions (user_id, video_id, topics_json) VALUES (?,?,?)',
      [req.userId, videoId, JSON.stringify(topics)]
    )
    const session = get('SELECT * FROM conversation_sessions WHERE id=?', [r.lastInsertRowid])

    let opening = null
    let aiUnavailable = false
    if (isConfigured()) {
      try {
        const prompt = buildOpeningPrompt({ videoTitle: video.title, topics, level: video.level })
```

替换为：

```js
    const topics = await getTopicsForVideo(videoId, video)
    const scene = await getSceneForVideo(videoId, video)
    const r = run(
      'INSERT INTO conversation_sessions (user_id, video_id, topics_json, scene_json) VALUES (?,?,?,?)',
      [req.userId, videoId, JSON.stringify(topics), JSON.stringify(scene)]
    )
    const session = get('SELECT * FROM conversation_sessions WHERE id=?', [r.lastInsertRowid])

    let opening = null
    let aiUnavailable = false
    if (isConfigured()) {
      try {
        const prompt = buildOpeningPrompt({ videoTitle: video.title, topics, level: video.level, scene })
```

5) `/start` 的 resumed 分支与成功响应补充 scene。将现有：

```js
      if (existing) {
        const cnt = get('SELECT COUNT(*) c FROM conversation_messages WHERE session_id=?', [existing.id])
        if (cnt.c > 0) {
          const topics = JSON.parse(existing.topics_json || '{}')
          return res.status(200).json({
            session: { id: existing.id, videoId: existing.video_id, status: existing.status },
            topics,
            opening: null,
            resumed: true,
            aiUnavailable: !isConfigured(),
          })
        }
      }
```

替换为：

```js
      if (existing) {
        const cnt = get('SELECT COUNT(*) c FROM conversation_messages WHERE session_id=?', [existing.id])
        if (cnt.c > 0) {
          const topics = JSON.parse(existing.topics_json || '{}')
          let scene = null
          if (existing.scene_json) { try { scene = JSON.parse(existing.scene_json) } catch { scene = null } }
          return res.status(200).json({
            session: { id: existing.id, videoId: existing.video_id, status: existing.status },
            topics,
            scene,
            opening: null,
            resumed: true,
            aiUnavailable: !isConfigured(),
          })
        }
      }
```

将现有：

```js
    res.status(201).json({
      session: { id: session.id, videoId: session.video_id, status: session.status },
      topics,
      opening,
      aiUnavailable,
    })
```

替换为：

```js
    res.status(201).json({
      session: { id: session.id, videoId: session.video_id, status: session.status },
      topics,
      scene,
      opening,
      aiUnavailable,
    })
```

6) `/reply`：读取 scene 传给 F2，并更新 `pickTargetPhrase` 调用。将现有：

```js
    const messages = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const topics = JSON.parse(session.topics_json || '{}')
    const video = findVideo(session.video_id)
    const history = buildHistory([...messages.map(m => ({ role: m.role, text: m.text })), { role: 'user', text: userText }])
    const prompt = buildReplyPrompt({ topics: { ...topics, videoTitle: video ? video.title : '' }, history, level: video ? video.level : undefined })
```

替换为：

```js
    const messages = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const topics = JSON.parse(session.topics_json || '{}')
    let scene = null
    if (session.scene_json) { try { scene = JSON.parse(session.scene_json) } catch { scene = null } }
    const video = findVideo(session.video_id)
    const history = buildHistory([...messages.map(m => ({ role: m.role, text: m.text })), { role: 'user', text: userText }])
    const prompt = buildReplyPrompt({ topics: { ...topics, videoTitle: video ? video.title : '' }, history, level: video ? video.level : undefined, scene })
```

将现有：

```js
    const updated = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const targetPhrase = pickTargetPhrase(topics, userCount)
    res.json({ aiReply, history: updated, targetPhrase })
```

替换为：

```js
    const updated = all('SELECT * FROM conversation_messages WHERE session_id=? ORDER BY id', [session.id])
    const targetPhrase = pickTargetPhrase(scene, topics, userCount)
    res.json({ aiReply, history: updated, targetPhrase })
```

7) `GET /:sessionId`：返回 scene。将现有：

```js
    let review = null
    if (session.review_json) {
      try { review = JSON.parse(session.review_json) } catch { /* 忽略损坏 */ }
    }
    res.json({
```

替换为：

```js
    let review = null
    if (session.review_json) {
      try { review = JSON.parse(session.review_json) } catch { /* 忽略损坏 */ }
    }
    let scene = null
    if (session.scene_json) { try { scene = JSON.parse(session.scene_json) } catch { /* 忽略损坏 */ } }
    res.json({
```

将现有：

```js
      topics: (() => { try { return JSON.parse(session.topics_json || '{}') } catch { return {} } })(),
      messages,
      aiUnavailable: !isConfigured(),
    })
```

替换为：

```js
      topics: (() => { try { return JSON.parse(session.topics_json || '{}') } catch { return {} } })(),
      messages,
      scene,
      aiUnavailable: !isConfigured(),
    })
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test server/routes/conversation-ai.test.cjs`
Expected: 全部 PASS（含原有 8 个 + 新增 3 个）。

- [ ] **Step 6: 提交**

```bash
git add server/db.cjs server/routes/conversation.cjs server/routes/conversation-ai.test.cjs
git commit -m "feat(api): 会话存储/返回场景档案，reply 走角色扮演 prompt"
```

---

### Task 3: 前端场景横幅

**Files:**
- Modify: `src/pages/ConversationPage.jsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `/start` 与 `/:sessionId` 响应新增的 `scene` 字段（形状见 Task 1）。
- Produces: `scene` state + 场景横幅 UI（不影响 ASR/TTS/解析/回看）。

- [ ] **Step 1: 新增 `scene` state 与数据接入（`ConversationPage.jsx`）**

1) 在 `const [topics, setTopics] = useState(null)` 之后新增：

```js
  const [scene, setScene] = useState(null)
```

2) `loadSession` 内：在 `setTopics(data.topics || null)` 之后新增：

```js
      setScene(data.scene || null)
```

3) `startConversation` 内：在 `setTopics(data.topics)` 之后新增：

```js
      setScene(data.scene || null)
```

4) `newConversation` 内：在 `setTopics(null)` 之后新增：

```js
    setScene(null)
```

- [ ] **Step 2: 渲染场景横幅**

在 `ConversationPage.jsx` 的 `{!error && (<>` 之后、`{/* A2：视频回看面板 */}` 之前插入横幅 JSX：

```jsx
          {/* 场景横幅（视频 → AI Role Play） */}
          {scene && scene.scene && (
            <div className="conv-scene">
              <div className="conv-scene-head">
                <span className="conv-scene-icon">🎭</span>
                <b className="conv-scene-title">{scene.sceneCn || scene.scene}</b>
                {scene.sceneCn && scene.scene && scene.sceneCn !== scene.scene && (
                  <span className="conv-scene-en">{scene.scene}</span>
                )}
              </div>
              <div className="conv-scene-roles">
                <span className="conv-scene-role">你扮演：<b>{scene.userRoleCn || scene.userRole}</b></span>
                <span className="conv-scene-role">AI 扮演：<b>{scene.aiRoleCn || scene.aiRole}</b></span>
              </div>
              {(scene.contextCn || scene.context) && (
                <p className="conv-scene-context">{scene.contextCn || scene.context}</p>
              )}
              {Array.isArray(scene.coreExpressions) && scene.coreExpressions.length > 0 && (
                <div className="conv-scene-exprs">
                  {scene.coreExpressions.map((e, i) => (
                    <span key={i} className="conv-scene-expr">
                      {e.phrase}
                      {e.meaning ? <em>{e.meaning}</em> : null}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 3: 新增样式（`src/index.css`）**

在「A4：目标表达提示条」样式块之前（`.conv-hint {` 那行之前）插入：

```css
/* 场景横幅（视频 → AI Role Play） */
.conv-scene { display: flex; flex-direction: column; gap: 0.375rem; background: linear-gradient(135deg, #eef2ff, #f5f3ff); border: 1px solid #e0e7ff; border-radius: 0.875rem; padding: 0.75rem 0.875rem; }
.conv-scene-head { display: flex; align-items: center; gap: 0.375rem; }
.conv-scene-icon { font-size: 1rem; }
.conv-scene-title { color: #4338ca; font-size: 0.875rem; font-weight: 800; }
.conv-scene-en { color: #94a3b8; font-size: 0.75rem; }
.conv-scene-roles { display: flex; flex-wrap: wrap; gap: 0.375rem 0.875rem; font-size: 0.8125rem; color: #475569; }
.conv-scene-role b { color: #4f46e5; }
.conv-scene-context { margin: 0; font-size: 0.75rem; color: #64748b; line-height: 1.5; }
.conv-scene-exprs { display: flex; flex-wrap: wrap; gap: 0.3125rem; }
.conv-scene-expr { display: inline-flex; align-items: center; gap: 0.25rem; background: #fff; border: 1px solid #c7d2fe; color: #4338ca; border-radius: 9999px; padding: 0.125rem 0.5rem; font-size: 0.6875rem; font-weight: 700; }
.conv-scene-expr em { font-style: normal; color: #a78bfa; font-weight: 600; }
```

- [ ] **Step 4: 验证（lint + build + 手动冒烟）**

Run: `npm run lint`
Expected: 无新增错误。

Run: `npm run build`
Expected: 构建成功。

手动冒烟（有 AI key 时）：
```bash
npm run server   # 终端 1
npm run dev      # 终端 2
```
打开 http://localhost:5173 → 任意视频 → 点「💬 AI 对话」→ 顶部出现 🎭 场景横幅（场景/你扮演/AI扮演/核心表达），AI 以角色身份开场。

- [ ] **Step 5: 提交**

```bash
git add src/pages/ConversationPage.jsx src/index.css
git commit -m "feat(ui): AI 对话页顶部展示视频角色扮演场景横幅"
```

---

### Task 4: 全量回归 + 收尾

- [ ] **Step 1: 跑全部后端测试**

Run: `node --test server/services/ai/conversation.test.cjs server/routes/conversation-ai.test.cjs server/routes/conversation.test.cjs`
Expected: 全部 PASS。

- [ ] **Step 2: lint + build**

Run: `npm run lint && npm run build`
Expected: 无错误。

- [ ] **Step 3: 检查 git 状态并确认无遗漏文件**

Run: `git status --short`
Expected: 仅剩预期改动（或无未提交改动）。

- [ ] **Step 4: 最终提交（如有遗漏改动）**

```bash
git add -A
git commit -m "feat: 视频场景 × AI Role Play 完整链路" --allow-empty
```

---

## 自审记录

- **Spec 覆盖**：① 场景档案结构 → Task 1；② 引擎改动 → Task 1；③ 路由/缓存/存储 → Task 2；④ 本地降级 → Task 1；⑤ 前端横幅 → Task 3；⑥ 测试 → Task 1/2。全部覆盖。
- **占位符扫描**：无 TBD/TODO/「适当处理」类占位。
- **类型一致性**：`scene` 对象字段名（scene/sceneCn/setting/userRole/userRoleCn/aiRole/aiRoleCn/context/contextCn/coreExpressions/source）在 Task 1 定义、Task 2 消费、Task 3 展示三处一致；`SCENE_PROMPT_VERSION='scene-v1'`、`pickTargetPhrase(scene, topics, userCount)` 签名一致。
