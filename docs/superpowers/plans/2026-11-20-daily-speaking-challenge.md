# Daily Speaking Challenge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Shadow Voice 里新增「每日口语挑战」：以用户在学的视频为依据生成五步主动口语训练（复述 → 语块激活 → 情境转换 → 话题连续表达 → AI 对话），每步给反馈，最后出报告，并把多轮对话模块整体下线。

**Architecture:** 服务端一次 AI 调用生成整套静态任务（`speaking_challenges`），每步提交时一次调用拿反馈（`speaking_challenge_progress`），Chunk 掌握状态由服务端确定性聚合（`chunk_mastery`）。前端是单页步骤流，复用现有 ASR / TTS / 视觉语言；分段录音只给共享音频栈加「可选参数」，默认路径行为不变。

**Tech Stack:** Express 5 + sql.js（CJS，`node --test`）、React 19 + react-router 7 + Tailwind 4 + lucide-react（Vite，ESM）、OpenAI 兼容 provider（`server/services/ai/provider.cjs`）。

**Spec:** `docs/superpowers/specs/2026-11-20-daily-speaking-challenge-design.md`

## Global Constraints

- 测试命令必须用 glob：`node --test "server/**/*.test.cjs" "src/**/*.test.js"`（Node 22 不接受目录参数）。
- 不破坏现有功能：`src/utils/useSpeechInput.js` / `pcmRecorder.js` / `aliyunAsr.js` 只**新增可选参数**，默认参数下的行为必须与现在完全一致（DialoguePage、TextDocPage 不改一行）。
- 归一化函数**永不 throw**：畸形 AI 输出只降级为 `{ ok:false }` / 空数组。
- AI 未配置（`AI_API_KEY` 空）或调用失败：写接口一律 `503`，**禁止伪造分数、报告或掌握状态**。
- AI 生成内容必须来自本视频字幕；每个 chunk 的 `evidence` 必须能在字幕文本里找到（`isEvidenceInTranscript` 为真）。
- 数据表只用 `CREATE TABLE IF NOT EXISTS` 新增；不删表、不改旧表、不回填历史数据。
- `video_id` 是 UUID 字符串，`challengeId` 是整数；路由参数不要混用。
- 作答文本单条截断 2000 字符；`durationMs` 钳制 0–600000；`segments` 钳制 0–20。
- 进入页面 0 次模型调用（`GET /api/challenge/:videoId` 不调 AI）。
- 用户可见文案用中文；代码注释用中文，与现有文件风格一致。
- 前端页面沿用 `src/pages/DialoguePage.jsx` 的视觉语言（Tailwind + lucide，卡片/胶囊按钮/浅色底）。

## Review Focus

- **同一步重复提交**：用户改答案或重录后再次提交同一步 → `steps_json[i]` 被覆盖为最后一次，`chunk_mastery.uses_count` 不因重复提交而虚增（用 `used_steps` 去重）。测试在 Task 2、Task 6。
- **60 秒切段拼字**：ASR 在 60 秒边界切开一句话 → 拼接后不丢词、不重复、不多余空格，`segments` 递增，`activeMs` 不归零。测试在 Task 8。
- **AI 幻觉的 `chunkId`**：模型返回越界/非整数的 chunkId → 丢弃，不写脏 `chunk_mastery`。测试在 Task 4、Task 6。
- **AI 未配置时每一步**：全部 503，库里只留 `answers`，不出现 0 分与空报告。测试在 Task 5、Task 6。
- **历史版本与掌握状态交叉**：练完 variant 2 再回看 variant 1 → variant 1 报告的三堆不被污染（快照），视频级 mastery 仍是最新。测试在 Task 6。

---

### Task 1: 三张新表

**Files:**
- Modify: `server/db.cjs`（在 `text_progress` 之后、`// 旧库迁移` 之前插入）
- Test: `server/db.test.cjs`（追加测试）

**Interfaces:**
- Produces（后续任务依赖的表结构与列名）：
  - `speaking_challenges(id, user_id, video_id, variant, challenge_json, model, created_at, UNIQUE(user_id, video_id, variant))`
  - `speaking_challenge_progress(id, challenge_id UNIQUE REFERENCES speaking_challenges(id), user_id, cursor DEFAULT 0, status DEFAULT 'active', steps_json DEFAULT '[]', report_json, updated_at)`
  - `chunk_mastery(id, user_id, video_id, chunk_key, chunk_en, chunk_cn, status DEFAULT 'introduced', uses_count DEFAULT 0, used_steps DEFAULT '[]', last_score, updated_at, UNIQUE(user_id, video_id, chunk_key))`

- [ ] **Step 1: 写失败的测试（追加到 `server/db.test.cjs` 末尾）**

```js
test('speaking_challenges / speaking_challenge_progress / chunk_mastery 存在且约束生效', async () => {
  await db.getDb()
  const names = db.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name)
  for (const t of ['speaking_challenges', 'speaking_challenge_progress', 'chunk_mastery']) {
    assert.ok(names.includes(t), `缺少表 ${t}`)
  }

  const c = db.run(
    'INSERT INTO speaking_challenges (user_id, video_id, variant, challenge_json) VALUES (?,?,?,?)',
    [1, 'video-a', 1, '{"version":1}']
  )
  assert.equal(db.get('SELECT variant FROM speaking_challenges WHERE id=?', [c.lastInsertRowid]).variant, 1)
  assert.throws(() => db.run(
    'INSERT INTO speaking_challenges (user_id, video_id, variant, challenge_json) VALUES (?,?,?,?)',
    [1, 'video-a', 1, '{}']), /UNIQUE/)

  const p = db.run('INSERT INTO speaking_challenge_progress (challenge_id, user_id) VALUES (?,?)',
    [c.lastInsertRowid, 1])
  const prow = db.get('SELECT * FROM speaking_challenge_progress WHERE id=?', [p.lastInsertRowid])
  assert.equal(prow.cursor, 0)
  assert.equal(prow.status, 'active')
  assert.equal(prow.steps_json, '[]')
  assert.throws(() => db.run('INSERT INTO speaking_challenge_progress (challenge_id, user_id) VALUES (?,?)',
    [c.lastInsertRowid, 1]), /UNIQUE/)

  db.run('INSERT INTO chunk_mastery (user_id, video_id, chunk_key, chunk_en, chunk_cn) VALUES (?,?,?,?,?)',
    [1, 'video-a', 'check in', 'check in', '办理入住'])
  const m = db.get('SELECT * FROM chunk_mastery WHERE chunk_key=?', ['check in'])
  assert.equal(m.status, 'introduced')
  assert.equal(m.uses_count, 0)
  assert.equal(m.used_steps, '[]')
  assert.throws(() => db.run(
    'INSERT INTO chunk_mastery (user_id, video_id, chunk_key, chunk_en, chunk_cn) VALUES (?,?,?,?,?)',
    [1, 'video-a', 'check in', 'check in', '办理入住']), /UNIQUE/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/db.test.cjs`
Expected: FAIL — `缺少表 speaking_challenges`（`no such table: speaking_challenges`）

- [ ] **Step 3: 在 `server/db.cjs` 加三张表**

在 `text_progress` 那段 `db.run(...)` 之后、`// 旧库迁移：已有 conversation_sessions…` 之前插入，SQL 与设计文档 §3 一致，并且 `chunk_mastery` 必须含 `used_steps TEXT NOT NULL DEFAULT '[]'`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test "server/**/*.test.cjs" "src/**/*.test.js"`
Expected: 全部 PASS（新表不影响旧表断言）

- [ ] **Step 5: 提交**

```bash
git add server/db.cjs server/db.test.cjs
git commit -m "feat(db): add speaking challenge tables"
```

---

### Task 2: Chunk 掌握状态（确定性迁移）

**Files:**
- Create: `server/lib/chunkMastery.cjs`
- Test: `server/lib/chunkMastery.test.cjs`

**Interfaces:**
- Produces（Task 5 / Task 6 使用）：
  - `STATUSES: string[]` = `['introduced','activated','mastered','review']`
  - `normalizeChunkKey(text: string): string`（小写、去首尾省略号与标点、合并空白）
  - `nextStatus(current: string, { step: number, used: boolean, quality: string }): string`
  - `countsAsUse({ used: boolean, quality: string }): boolean`
  - `upsertIntroduced({ userId: number, videoId: string, chunks: Array<{en: string, cn: string}> }): void`
  - `applyUsage({ userId: number, videoId: string, chunks: Array<{id: number, en: string}>, chunkUsage: Array<{chunkId: number, used: boolean, quality: string}>, step: number, score?: number|null }): void`
  - `listForVideo(userId: number, videoId: string): Array<{chunk_key, chunk_en, chunk_cn, status, uses_count, used_steps, last_score}>`
  - `bucketsOf(rows: any[]): { mastered: any[], selfUsed: any[], review: any[], introduced: any[] }`
- Consumes: `server/db.cjs` 的 `get/run/all`（`require('../db.cjs')`）

**状态迁移规则（实现必须逐条对上）**
- `mastered` 是终态：任何后续事件都不改状态（只在「好」的使用时更新 `uses_count`）。
- step 2 / step 3：`quality === 'good'` → `activated`；`'partial' | 'wrong'` → `review`。
- step 4 / step 5：`used === true && quality === 'good'` → `mastered`；其余不变。
- 只有 step 2–5 且 `countsAsUse` 为真才把 `step` 记进 `used_steps`；`uses_count = used_steps.length`（同一 step 重复提交不会重复计数；改判为错时把该 step 移出）。
- `chunkUsage` 里非整数或不在 `chunks` 范围内的 `chunkId` 直接丢弃。

- [ ] **Step 1: 写失败的测试**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-chunk-mastery-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const cm = require('./chunkMastery.cjs')
const db = require('../db.cjs')

test('normalizeChunkKey 去掉省略号、标点与大小写差异', () => {
  assert.equal(cm.normalizeChunkKey('It turns out that...'), 'it turns out that')
  assert.equal(cm.normalizeChunkKey('  check   IN! '), 'check in')
  assert.equal(cm.normalizeChunkKey(''), '')
})

test('nextStatus 覆盖六条迁移规则且 mastered 为终态', () => {
  assert.equal(cm.nextStatus('introduced', { step: 2, used: true, quality: 'good' }), 'activated')
  assert.equal(cm.nextStatus('introduced', { step: 2, used: false, quality: 'wrong' }), 'review')
  assert.equal(cm.nextStatus('review', { step: 3, used: true, quality: 'good' }), 'activated')
  assert.equal(cm.nextStatus('activated', { step: 3, used: false, quality: 'partial' }), 'review')
  assert.equal(cm.nextStatus('activated', { step: 4, used: true, quality: 'good' }), 'mastered')
  assert.equal(cm.nextStatus('activated', { step: 5, used: false, quality: 'wrong' }), 'activated')
  assert.equal(cm.nextStatus('mastered', { step: 2, used: false, quality: 'wrong' }), 'mastered')
})

test('countsAsUse 只认「用了且用得好」', () => {
  assert.equal(cm.countsAsUse({ used: true, quality: 'good' }), true)
  assert.equal(cm.countsAsUse({ used: true, quality: 'partial' }), false)
  assert.equal(cm.countsAsUse({ used: false, quality: 'good' }), false)
})

test('upsertIntroduced 幂等，重复生成不产生多行', async () => {
  await db.getDb()
  const chunks = [{ en: 'check in', cn: '办理入住' }, { en: 'it turns out that...', cn: '结果……' }]
  cm.upsertIntroduced({ userId: 7, videoId: 'v1', chunks })
  cm.upsertIntroduced({ userId: 7, videoId: 'v1', chunks })
  const rows = cm.listForVideo(7, 'v1')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.status === 'introduced'))
})

test('applyUsage 更新状态、uses_count 与 used_steps（重复提交同一步不重复计数）', async () => {
  await db.getDb()
  cm.upsertIntroduced({ userId: 8, videoId: 'v2', chunks: [{ en: 'check in', cn: '办理入住' }] })
  const chunks = [{ id: 0, en: 'check in' }]
  const usage = [{ chunkId: 0, used: true, quality: 'good' }]
  cm.applyUsage({ userId: 8, videoId: 'v2', chunks, chunkUsage: usage, step: 2, score: 80 })
  cm.applyUsage({ userId: 8, videoId: 'v2', chunks, chunkUsage: usage, step: 2, score: 90 })
  let row = cm.listForVideo(8, 'v2')[0]
  assert.equal(row.status, 'activated')
  assert.equal(row.uses_count, 1)
  assert.equal(row.last_score, 90)
  assert.deepEqual(JSON.parse(row.used_steps), [2])

  cm.applyUsage({ userId: 8, videoId: 'v2', chunks, chunkUsage: usage, step: 4 })
  row = cm.listForVideo(8, 'v2')[0]
  assert.equal(row.status, 'mastered')
  assert.equal(row.uses_count, 2)

  cm.applyUsage({ userId: 8, videoId: 'v2', chunks: [{ id: 0, en: 'check in' }],
    chunkUsage: [{ chunkId: 99, used: true, quality: 'good' }], step: 2 })
  assert.equal(cm.listForVideo(8, 'v2')[0].uses_count, 2, '越界 chunkId 不记账')
})

test('bucketsOf 按状态分四堆', () => {
  const rows = [
    { chunk_key: 'a', status: 'mastered' }, { chunk_key: 'b', status: 'activated' },
    { chunk_key: 'c', status: 'review' }, { chunk_key: 'd', status: 'introduced' },
  ]
  const b = cm.bucketsOf(rows)
  assert.deepEqual(b.mastered.map(r => r.chunk_key), ['a'])
  assert.deepEqual(b.selfUsed.map(r => r.chunk_key), ['b'])
  assert.deepEqual(b.review.map(r => r.chunk_key), ['c'])
  assert.deepEqual(b.introduced.map(r => r.chunk_key), ['d'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/lib/chunkMastery.test.cjs`
Expected: FAIL — `Cannot find module './chunkMastery.cjs'`

- [ ] **Step 3: 实现 `server/lib/chunkMastery.cjs`**

导出上面 Interfaces 列出的全部名字。`applyUsage` 用 `get('SELECT * FROM chunk_mastery WHERE user_id=? AND video_id=? AND chunk_key=?')` 取行；不存在则跳过（不凭空建行，行只由 `upsertIntroduced` 建）。只在 `countsAsUse` 时写 `last_score`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/lib/chunkMastery.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add server/lib/chunkMastery.cjs server/lib/chunkMastery.test.cjs
git commit -m "feat(challenge): deterministic chunk mastery transitions"
```

---

### Task 3: 挑战生成（prompt / 归一化 / 字幕取证 / 本地兜底）

**Files:**
- Create: `server/services/ai/challenge.cjs`（本任务只写生成部分）
- Test: `server/services/ai/challenge.test.cjs`

**Interfaces:**
- Produces（Task 4 在同一文件追加；Task 5/6 使用）：
  - `RECALL_COUNT = 3`、`CHUNK_COUNT = 5`、`TRANSFORMATION_COUNT = 5`、`DEFAULT_TOPIC_SECONDS = 90`、`MIN_TOPIC_SECONDS = 60`、`MAX_TOPIC_SECONDS = 120`
  - `normalizeChunkKey(text: string): string`
  - `isEvidenceInTranscript(text: string, transcriptText: string): boolean`
  - `buildFallbackChunks({ segments: Array<{textEn:string}>, cachedTopics?: object }): Array<{en:string, cn:string, evidence:string}>`（最多 5 条）
  - `buildChallengePrompt({ videoTitle, description, topic, videoLevel, segments, variant, avoid }): { system: string, user: string }`
  - `normalizeChallenge(raw: any, { segmentsText?: string, fallbackChunks?: any[] }): { ok: true, challenge: object } | { ok: false, reason: string }`
  - `buildTranscriptDigest(segments: Array<{textEn:string}>, maxLines = 40, maxChars = 2000): string`
- Prompt 标记（Task 5/6 的测试桩靠它分流）：生成用的 system **必须包含** `五步口语挑战`。

**`challenge` 结构（后续所有任务共用）**
```js
{
  version: 1, title: string, topicEn: string, topicCn: string,
  source: 'subtitle' | 'cache' | 'local',
  recall: [{ id: 0, qEn: string, qCn: string, focusCn: string }],            // 恰好 3
  chunks: [{ id: 0, en: string, cn: string, evidence: string, usageCn: string }], // 恰好 5
  transformations: [{ id: 0, situationCn: string, targetChunkId: number|null, hintCn: string }], // 恰好 5
  topicSpeaking: { promptEn: string, promptCn: string, pointsCn: string[], targetSeconds: number }
}
```

**取证规则（实现必须逐条对上）**
- 归一化：小写、`’`→`'`、去所有标点（保留 `'`）、合并空白。
- 通过 = 归一化后的子串命中，**或**其词序列按顺序全部出现在字幕文本里（允许中间夹别的词）。
- `evidence` 必须通过取证；`en` 不强制（可以带省略号框架，如 `let's ...`）。

- [ ] **Step 1: 写失败的测试**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  RECALL_COUNT, CHUNK_COUNT, TRANSFORMATION_COUNT, DEFAULT_TOPIC_SECONDS,
  normalizeChunkKey, isEvidenceInTranscript, buildFallbackChunks,
  buildChallengePrompt, normalizeChallenge, buildTranscriptDigest,
} = require('./challenge.cjs')

const SEGMENTS = [
  { textEn: "We'd like to check in, please.", textCn: '我们想办理入住。' },
  { textEn: 'It turns out that the room is not ready.', textCn: '结果房间还没准备好。' },
  { textEn: "Let's take the lift to the 21st floor.", textCn: '我们坐电梯到21楼吧。' },
  { textEn: 'Could you hold my bags for now?', textCn: '你能先帮我存包吗？' },
  { textEn: 'In the end we got a bigger room.', textCn: '最后我们换到了更大的房间。' },
]
const TRANSCRIPT = SEGMENTS.map(s => s.textEn).join(' ')

function goodRaw() {
  return {
    title: '酒店入住 · 主动输出挑战', topicEn: 'staying in a hotel', topicCn: '酒店入住',
    recall: [
      { qEn: 'What do they want at the front desk?', qCn: '他们在前台想做什么？', focusCn: '办理入住' },
      { qEn: 'Why is the room not ready?', qCn: '房间为什么没准备好？', focusCn: '房间未就绪' },
      { qEn: 'What do they do in the end?', qCn: '他们最后做了什么？', focusCn: '换到更大房间' },
    ],
    chunks: [
      { en: "We'd like to check in", cn: '我们想办理入住', evidence: "We'd like to check in, please.", usageCn: '说说你最近一次办入住' },
      { en: 'it turns out that', cn: '结果（发现）……', evidence: 'It turns out that the room is not ready.', usageCn: '说一件出乎意料的事' },
      { en: 'hold my bags', cn: '帮我存包', evidence: 'Could you hold my bags for now?', usageCn: '请人帮你保管东西' },
      { en: 'in the end', cn: '最终', evidence: 'In the end we got a bigger room.', usageCn: '讲一件事情的结局' },
      { en: 'take the lift', cn: '坐电梯', evidence: "Let's take the lift to the 21st floor.", usageCn: '说说你怎么上楼' },
    ],
    transformations: Array.from({ length: 5 }, (_, i) => ({
      situationCn: `情境${i + 1}：你在酒店前台需要提出一个请求。`, targetChunkId: i, hintCn: '先说明来意',
    })),
    topicSpeaking: {
      promptEn: 'Describe a travel problem that turned out fine.',
      promptCn: '讲一次旅行中的小麻烦最后顺利解决的经历。',
      pointsCn: ['发生了什么', '你怎么处理', '结果和感受'], targetSeconds: 200,
    },
  }
}

test('normalizeChunkKey 与证据匹配容忍大小写/标点', () => {
  assert.equal(normalizeChunkKey('It Turns Out THAT...'), 'it turns out that')
  assert.equal(isEvidenceInTranscript('turns out that the room', TRANSCRIPT), true)
  assert.equal(isEvidenceInTranscript('turns that out', TRANSCRIPT), false)
  assert.equal(isEvidenceInTranscript('completely invented line', TRANSCRIPT), false)
})

test('buildChallengePrompt 带字幕、难度、套数与避免重复清单', () => {
  const { system, user } = buildChallengePrompt({
    videoTitle: '出国旅行的日常', description: '酒店入住', topic: '旅游出行',
    videoLevel: '中级', segments: SEGMENTS, variant: 2, avoid: { chunks: ['check in'] },
  })
  assert.ok(system.includes('五步口语挑战'))
  assert.ok(user.includes('出国旅行的日常'))
  assert.ok(user.includes("We'd like to check in, please."))
  assert.ok(user.includes('第 2 套'))
  assert.ok(user.includes('check in'), 'avoid 清单要进 prompt')
  assert.ok(user.includes('"recall"') && user.includes('"chunks"') && user.includes('"topicSpeaking"'))
})

test('normalizeChallenge 正常输入产出 3/5/5 并夹紧话题时长', () => {
  const r = normalizeChallenge(goodRaw(), { segmentsText: TRANSCRIPT })
  assert.equal(r.ok, true)
  assert.equal(r.challenge.recall.length, RECALL_COUNT)
  assert.equal(r.challenge.chunks.length, CHUNK_COUNT)
  assert.equal(r.challenge.transformations.length, TRANSFORMATION_COUNT)
  assert.equal(r.challenge.topicSpeaking.targetSeconds, 120, '200 秒夹到 120')
  assert.equal(r.challenge.source, 'subtitle')
  assert.deepEqual(r.challenge.chunks.map(c => c.id), [0, 1, 2, 3, 4])
})

test('normalizeChallenge 缺题/缺情境直接失败', () => {
  const raw = goodRaw()
  raw.recall = raw.recall.slice(0, 2)
  const r = normalizeChallenge(raw, { segmentsText: TRANSCRIPT })
  assert.equal(r.ok, false)
  assert.match(r.reason, /复述题/)

  const raw2 = goodRaw()
  raw2.transformations = raw2.transformations.slice(0, 4)
  const r2 = normalizeChallenge(raw2, { segmentsText: TRANSCRIPT })
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /情境/)
})

test('normalizeChallenge 证据全部造假时用兜底池补满', () => {
  const raw = goodRaw()
  raw.chunks = raw.chunks.map(c => ({ ...c, evidence: 'invented sentence not in video' }))
  // 兜底池由路由从「字幕衍生」构造：这里用真实字幕行当证据
  const fallbackChunks = SEGMENTS.map((s, i) => ({
    en: `fallback ${i}`, cn: `兜底语块${i}`, evidence: s.textEn, source: i === 0 ? 'cache' : 'local',
  }))
  const r = normalizeChallenge(raw, { segmentsText: TRANSCRIPT, fallbackChunks })
  assert.equal(r.ok, true)
  assert.ok(['cache', 'local'].includes(r.challenge.source))
  assert.equal(r.challenge.chunks.length, CHUNK_COUNT)
  for (const c of r.challenge.chunks) {
    assert.ok(isEvidenceInTranscript(c.evidence, TRANSCRIPT))
  }
})

test('normalizeChallenge 兜底也不够时失败（不编造）', () => {
  const raw = goodRaw()
  raw.chunks = raw.chunks.map(c => ({ ...c, evidence: 'invented' }))
  const r = normalizeChallenge(raw, { segmentsText: TRANSCRIPT, fallbackChunks: [] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /语块/)
})

test('buildFallbackChunks 只用字幕里真实存在的表达', () => {
  const chunks = buildFallbackChunks({ segments: SEGMENTS })
  assert.ok(chunks.length > 0 && chunks.length <= 5)
  for (const c of chunks) {
    assert.ok(isEvidenceInTranscript(c.evidence, TRANSCRIPT), `证据不在字幕里: ${c.evidence}`)
    assert.ok(c.en && c.cn, '兜底也要有英文与中文')
  }
})

test('buildTranscriptDigest 截断行数与字符', () => {
  const digest = buildTranscriptDigest(SEGMENTS, 2, 50)
  assert.ok(digest.length <= 50)
  assert.ok(!digest.includes('In the end'), '第 3 行起被截掉')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/services/ai/challenge.test.cjs`
Expected: FAIL — `Cannot find module './challenge.cjs'`

- [ ] **Step 3: 实现生成部分**

`buildFallbackChunks` 顺序：① `cachedTopics.phrases` / `.collocations`（`{phrase, meaning, example}`）→ `en=phrase`、`cn=meaning`、`evidence` 取 `example` 或字幕里第一条包含它的句子，再过取证，不通过就丢；② `require('./conversation.cjs').localExtractTopics(segments)` 的 `phrases`（形如 `let's ...`，含模板省略号）→ `evidence` = 第一条命中该短语首词的副字幕原文；③ 去重（`normalizeChunkKey`）后截断 5 条。**不产出 `cn` 为空的条目**。

`normalizeChallenge` 顺序：清洗 → 数量校验（3/5/5）→ 逐条字段校验（`qEn` ≥3 词、`cn`/`situationCn` 含 CJK）→ chunk 取证 → 未取证数 >2 时用 `fallbackChunks` 补到 5（仍不足 → `{ok:false, reason:'有效语块不足 5 条'}`）→ `source` = 全部来自 AI 且取证通过时为 `'subtitle'`，用了兜底为 `'cache'`（来自 `cachedTopics`）或 `'local'`。

`buildChallengePrompt` 的 user 段顺序：视频标题/简介/主题/等级 → 本套序号（`第 N 套`）→ 字幕（`行号. English || 中文`，最多 120 行）→ 避免重复清单（有就写）→ 输出 JSON 结构与数量硬要求 → 难度要求（按 `videoLevel` 给出句子长度区间）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/services/ai/challenge.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add server/services/ai/challenge.cjs server/services/ai/challenge.test.cjs
git commit -m "feat(challenge): generate challenge prompt with subtitle evidence"
```

---

### Task 4: 分步反馈 / 对话轮次 / 收尾报告（归一化）

**Files:**
- Modify: `server/services/ai/challenge.cjs`（追加导出）
- Test: `server/services/ai/challenge.test.cjs`（追加测试）

**Interfaces:**
- Produces（Task 6 使用）：
  - `buildStepFeedbackPrompt({ step, challenge, videoTitle, transcriptDigest, answers, metrics }): { system, user }`
  - `normalizeStepFeedback(raw: any, { step, itemCount, chunks }): Feedback`
  - `buildChatTurnPrompt({ challenge, videoTitle, history }): { system, user }`
  - `normalizeChatReply(raw: any): { ok: boolean, reply: string }`
  - `buildFinishPrompt({ challenge, feedbacks, chatMessages, metrics }): { system, user }`
  - `normalizeFinish(raw: any, { metrics }): { ok: boolean, chatFeedback: Feedback|null, report: { score: number|null, summary: string, nextSuggestions: string[] } | null }`
- `Feedback` 结构（前端与 `steps_json` 共用）：
```js
{
  score: number|null,
  items: [{ index: number, comment: string, better: string,
            grammar: [{ original: string, better: string, reason: string }],
            naturalness: [{ original: string, better: string, reason: string }],
            chunkRestored: boolean|null }],
  chunkUsage: [{ chunkId: number, used: boolean, quality: 'good'|'partial'|'wrong', evidence: string }],
  vocabulary: { level: string, suggestions: string[] },
  coherence: { summary: string, fillers: string[] },
  praise: string
}
```
- Prompt 标记（Task 6 的测试桩靠它分流）：分步反馈 system 含 `逐题反馈`；对话 system 含 `对话伙伴`；收尾 system 含 `学习报告`。

**归一化规则（实现必须逐条对上）**
- 分数：非数字 → `null`；数字夹到 0–100。
- `items` 按 `index` 去重后截断到 `itemCount`，缺的项补 `{ index, comment:'', better:'', grammar:[], naturalness:[], chunkRestored:null }`。
- `chunkUsage`：`chunkId` 必须是 `chunks` 里存在的整数 id，否则丢弃；`used` 只认 `=== true`；`quality` 非法时，`used` 为真给 `'partial'`，否则给 `'wrong'`。
- `normalizeChatReply`：对象取 `.reply`，字符串直接用；空 → `{ok:false, reply:''}`；截断 400 字符。
- `normalizeFinish`：`report.nextSuggestions` 最多 3 条非空字符串；`summary` 非空才 `ok:true`；`metrics` 原样挂在 `report.speaking` 上（`{ longestSeconds, totalSeconds, segments }`）。
- 全部函数永不 throw。

- [ ] **Step 1: 写失败的测试（追加到 `server/services/ai/challenge.test.cjs`）**

```js
const { buildStepFeedbackPrompt, normalizeStepFeedback, buildChatTurnPrompt,
  normalizeChatReply, buildFinishPrompt, normalizeFinish } = require('./challenge.cjs')

const CHALLENGE = normalizeChallenge(goodRaw(), { segmentsText: TRANSCRIPT }).challenge

test('buildStepFeedbackPrompt 带任务原文与本地统计', () => {
  const { system, user } = buildStepFeedbackPrompt({
    step: 2, challenge: CHALLENGE, videoTitle: '出国旅行的日常', transcriptDigest: DIGEST,
    answers: [{ index: 0, chunkText: 'check in', sentence: 'I checked in at noon.' }],
    metrics: { longestSeconds: 12, totalSeconds: 30, segments: 1 },
  })
  assert.ok(system.includes('逐题反馈'))
  assert.ok(user.includes(CHALLENGE.chunks[0].cn))
  assert.ok(user.includes('I checked in at noon.'))
  assert.ok(user.includes('12'))
})

test('normalizeStepFeedback 丢弃越界 chunkId 并补齐 items', () => {
  const fb = normalizeStepFeedback({
    score: 130,
    items: [{ index: 0, comment: '不错', grammar: [{ original: 'a', better: 'b', reason: 'c' }] }],
    chunkUsage: [{ chunkId: 0, used: true, quality: 'good' }, { chunkId: 42, used: true, quality: 'good' }],
    vocabulary: { level: '偏基础', suggestions: ['deposit', 'lobby'] },
    coherence: { summary: '连贯', fillers: ['um'] },
    praise: '敢于开口',
  }, { step: 2, itemCount: 5, chunks: CHALLENGE.chunks })
  assert.equal(fb.score, 100)
  assert.equal(fb.items.length, 5)
  assert.equal(fb.items[1].comment, '')
  assert.equal(fb.items[0].grammar[0].better, 'b')
  assert.deepEqual(fb.chunkUsage.map(u => u.chunkId), [0])
  assert.equal(fb.vocabulary.suggestions.length, 2)
})

test('normalizeStepFeedback 对垃圾输入不抛错', () => {
  for (const raw of [null, 'x', 42, [], { items: 'nope', chunkUsage: [{}] }]) {
    const fb = normalizeStepFeedback(raw, { step: 3, itemCount: 5, chunks: CHALLENGE.chunks })
    assert.equal(fb.items.length, 5)
    assert.equal(fb.score, null)
    assert.deepEqual(fb.chunkUsage, [])
  }
})

test('normalizeChatReply 兼容对象与纯文本', () => {
  assert.deepEqual(normalizeChatReply({ reply: 'Nice! What happened next?' }),
    { ok: true, reply: 'Nice! What happened next?' })
  assert.deepEqual(normalizeChatReply('Just text.'), { ok: true, reply: 'Just text.' })
  assert.deepEqual(normalizeChatReply('   '), { ok: false, reply: '' })
})

test('buildChatTurnPrompt 空历史时要求开场', () => {
  const { system, user } = buildChatTurnPrompt({ challenge: CHALLENGE, videoTitle: 't', history: [] })
  assert.ok(system.includes('对话伙伴'))
  assert.ok(user.includes('开场'))
  const second = buildChatTurnPrompt({
    challenge: CHALLENGE, videoTitle: 't',
    history: [{ role: 'ai', text: 'Hi' }, { role: 'user', text: 'Hello' }],
  })
  assert.ok(second.user.includes('Hello'))
})

test('normalizeFinish 带上本地统计并限制建议条数', () => {
  const r = normalizeFinish({
    chatFeedback: { score: 80, praise: '自然' },
    report: { score: 82, summary: '整体不错', nextSuggestions: ['a', 'b', 'c', 'd'], masteredChunkIds: [0] },
  }, { metrics: { longestSeconds: 78, totalSeconds: 200, segments: 4 } })
  assert.equal(r.ok, true)
  assert.equal(r.report.nextSuggestions.length, 3)
  assert.deepEqual(r.report.speaking, { longestSeconds: 78, totalSeconds: 200, segments: 4 })
  assert.equal(r.chatFeedback.score, 80)
})

test('normalizeFinish 缺 summary 时判定失败', () => {
  assert.equal(normalizeFinish({ report: {} }, { metrics: {} }).ok, false)
  assert.equal(normalizeFinish(null, { metrics: {} }).ok, false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/services/ai/challenge.test.cjs`
Expected: FAIL — `buildStepFeedbackPrompt is not a function`

- [ ] **Step 3: 实现三组 prompt + 归一化**

分步反馈 prompt 按 `step` 切换评价重点（1 复述覆盖度对照字幕观点、2 语块还原 + 造句、3 情境传达 + 目标语块、4 连贯/词汇/语块；5 只在收尾用）。JSON schema 与 `Feedback` 一致；step 2 额外要求 `items[].chunkRestored`。

收尾声明的输出结构：`{"chatFeedback": <Feedback>, "report": {"score":…, "summary":…, "nextSuggestions":[…], "masteredChunkIds":[…], "selfUsedChunkIds":[…], "reviewChunkIds":[…]}}`；`normalizeFinish` 依据 D11 **忽略** 三个 id 数组（掌握分堆由服务端决定），只取 score/summary/nextSuggestions。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/services/ai/challenge.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add server/services/ai/challenge.cjs server/services/ai/challenge.test.cjs
git commit -m "feat(challenge): step feedback, chat turn and report normalizers"
```

---

### Task 5: 路由骨架（GET / generate / progress / restart）

**Files:**
- Create: `server/routes/challenge.cjs`
- Modify: `server/index.cjs`（`require('./routes/challenge.cjs')` + `app.use('/api/challenge', challengeRoutes.router)`，放在 `/api/texts` 之后）
- Test: `server/routes/challenge.test.cjs`

**Interfaces:**
- Produces（Task 6 在同一路由文件追加；Task 9–12 前端使用）：
  - `router`（CommonJS，`module.exports = { router }`）
  - `GET /api/challenge/:videoId?variant=N` →
    ```js
    {
      video: { id, title, thumbnail, level, duration, topic },
      aiConfigured: boolean,
      challengeId: number|null, variant: number|null,
      challenge: object|null,
      progress: { challengeId, cursor, status, steps, report, updatedAt } | null,
      history: [{ challengeId, variant, status, cursor, score, createdAt, completedAt }],
      mastery: { mastered: [], selfUsed: [], review: [], introduced: [] }   // 行 = { chunkKey, chunkEn, chunkCn, status, usesCount, lastScore }
    }
    ```
  - `POST /api/challenge/:videoId/generate` → `201 { challengeId, variant, challenge, progress, mastery }`
  - `PUT /api/challenge/:challengeId/progress` body `{ cursor: 0..5 }` → `{ progress }`
  - `POST /api/challenge/:challengeId/restart` → `{ progress }`
  - `progress.steps` 恒为长度 5 的数组，未开始的步为 `null`
- Consumes：`server/lib/videoData.cjs`（`findVideo`/`loadSubtitles`）、`server/lib/chunkMastery.cjs`、`server/services/ai/challenge.cjs`、`server/services/ai/provider.cjs`、`require('../auth.cjs').authMiddleware`

**生成流程（实现必须逐条对上）**
1. `findVideo` 失败 → 404；`loadSubtitles` 为空 → `503 { error: '该视频没有字幕，暂不支持生成口语挑战' }`。
2. `avoid` = 该用户该视频最近 2 套的 `chunks[].en` + `transformations[].situationCn` + `recall[].qEn`（各数组截断到 20 条、合计字符串 ≤2000）。
3. 最多 2 次尝试：`chat`（`temperature: 0.9, maxTokens: 4000, timeoutMs: 60000`）→ `extractJson` → `normalizeChallenge({ ..., segmentsText, fallbackChunks })`；第 2 次把上一次的 `reason` 追加进消息（与 `routes/dialogue.cjs` 同款写法）。
   `fallbackChunks` 来自 `buildFallbackChunks({ segments, cachedTopics })`，`cachedTopics` = `ai_cache` 里该视频的 `topics-v1`（没有就传 `null`）。
4. 生成成功：`variant = MAX(variant)+1`，插入 `speaking_challenges`（`model = AI_MODEL`），冲突重试 1 次；插入 `speaking_challenge_progress`；`upsertIntroduced`。
5. 失败 → `503 { error: '生成失败（AI 服务暂不可用），请重试' }`，**不写任何表**。

- [ ] **Step 1: 写失败的测试**

按 `server/routes/dialogue.test.cjs` 的骨架（临时 DB + 临时数据目录 + stub `global.fetch` + `app.listen(0)`），新建 `server/routes/challenge.test.cjs`。测试桩按 system 关键字分流：

```js
function challengeRaw() {
  return {
    title: '酒店入住 · 挑战', topicEn: 'hotel', topicCn: '酒店入住',
    recall: [0, 1, 2].map(i => ({ qEn: `What happens in part ${i + 1} of the video?`, qCn: `第${i + 1}个问题？`, focusCn: '要点' })),
    chunks: [0, 1, 2, 3, 4].map(i => ({
      en: ['check in', 'it turns out that', 'hold my bags', 'in the end', 'take the lift'][i],
      cn: ['办理入住', '结果……', '帮我存包', '最终', '坐电梯'][i],
      evidence: ["We'd like to check in, please.", 'It turns out that the room is not ready.',
        'Could you hold my bags for now?', 'In the end we got a bigger room.',
        "Let's take the lift to the 21st floor."][i],
      usageCn: '造句提示',
    })),
    transformations: [0, 1, 2, 3, 4].map(i => ({ situationCn: `情境${i + 1}：需要向酒店提出请求。`, targetChunkId: i, hintCn: '先说来意' })),
    topicSpeaking: { promptEn: 'Describe a travel problem.', promptCn: '讲一次旅行小麻烦。', pointsCn: ['发生什么'], targetSeconds: 90 },
  }
}
```

测试用例（每条一个 `test()`）：
1. 游客 → 401；无效 token → 401。
2. `GET /api/challenge/v1` 无挑战 → `challenge: null`、`history: []`、`aiConfigured: true`、`mastery` 四堆皆空。
3. 视频不存在 → 404。
4. `POST /api/challenge/v1/generate` → 201，`variant === 1`，`progress.cursor === 0`，`chunk_mastery` 5 行 `introduced`。
5. 再生成一次 → `variant === 2`，且测试桩捕获的 user prompt 含第 1 套的 `check in`（avoid 生效）。
6. 无字幕视频 → 503，`speaking_challenges` 无新增行。
7. `generate` AI 连续失败 → 503 且无新增行。
8. 用户 2 拿用户 1 的 challengeId 调 `PUT /progress` → 403。
9. `PUT /progress` `cursor: 3` → `progress.cursor === 3`；`cursor: 9` → 400。
10. `POST /restart` → `steps` 全 null、`cursor === 0`、`status === 'active'`，`challenge_json` 不变，`chunk_mastery` 行数不变。
11. `GET /api/challenge/v1?variant=1` 在已生成两套后仍返回 variant 1 的 challenge。
12. 手工把某套 `challenge_json` 改成非法 JSON 后调 `PUT /progress` → 500「挑战数据已损坏，请重新生成」，服务不崩。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/routes/challenge.test.cjs`
Expected: FAIL — `Cannot find module './challenge.cjs'`

- [ ] **Step 3: 实现路由骨架 + 挂载**

辅助函数：`parseJson(text, fallback)`、`challengePayload(row)`（解析失败返回 null）、`parseSteps(json)`（返回长度 5、缺项 null）、`serializeProgress(row)`、`ensureProgress(row)`、`requireOwnChallenge(req, res, id)`（404 / 403 / `challenge_json` 损坏时 500「挑战数据已损坏，请重新生成」）、`serializeMastery(userId, videoId)`（用 `bucketsOf` + 行映射）、`buildAvoid(userId, videoId)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/routes/challenge.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add server/routes/challenge.cjs server/routes/challenge.test.cjs server/index.cjs
git commit -m "feat(api): challenge GET, generate, progress and restart"
```

---

### Task 6: 路由（step 反馈 / chat / finish）

**Files:**
- Modify: `server/routes/challenge.cjs`
- Test: `server/routes/challenge.test.cjs`（追加）

**Interfaces:**
- `POST /api/challenge/:challengeId/step/:step`（step 1–4）
  - step 1 body `{ answers: [{index, text, durationMs, segments}] }`（3 条，任一 `text` 空 → 400）
  - step 2 body `{ answers: [{index, chunkText, sentence, durationMs, segments}] }`（5 条，两个都空 → 400）
  - step 3 body `{ answers: [{index, text}] }`（5 条）
  - step 4 body `{ text, durationMs, segments }`
  - 成功 → `200 { feedback, progress, mastery }`；AI 不可用/失败 → `503 { error, hasAnswers: true }`（答案已落库）；step 4 无文字且 `durationMs >= 5000` → `200 { feedback: null, note, progress, mastery }`，**不调 AI**
- `POST /api/challenge/:challengeId/chat` body `{ text?, durationMs?, segments? }` → `200 { reply, messages, userTurns, canFinish }`；`messages` 为空时视为取开场白（忽略 `text`）；`messages` 非空而 `text` 为空 → 400；`userTurns >= 8` → 400
- `POST /api/challenge/:challengeId/finish` → `200 { report, progress, mastery }`；`userTurns < 5` → 400；步骤 1–4 有任一 `status !== 'completed'` → 400 `{ error: '还有未完成的训练环节' }`
- Consumes：Task 4 的 prompt/归一化、Task 2 的 `applyUsage`

**落库顺序（关键）**
- step：先写 `steps_json[step-1] = { step, status:'answered', answers, feedback:null, updatedAt }` 并保存 → 再调 AI → 成功则补 `feedback` 并把 `status` 改 `'completed'`，再 `applyUsage({ ..., step, score: feedback.score })`。
- chat：AI 成功后才同时写入 user 与 ai 两条消息（不留孤儿消息，与 `routes/conversation.cjs` 一致）。
- finish：`applyUsage({ step: 5, ... })` → 生成 `report_json`（三堆 + introduced 用 `bucketsOf` 快照 + `speaking` 统计 + AI 的 summary/score/nextSuggestions）→ `progress.status='completed'`、`cursor=5`。

- [ ] **Step 1: 写失败的测试（追加到 `server/routes/challenge.test.cjs`）**

测试桩需新增分支：system 含 `逐题反馈` 返回 Feedback JSON；含 `对话伙伴` 返回 `{"reply":"Nice, tell me more."}`；含 `学习报告` 返回 `{chatFeedback:{score:80},report:{score:82,summary:'不错',nextSuggestions:['再说慢一点']}}`。用例：
1. `step/9` → 400；`step/0` → 400。
2. step 1 少一条答案 / 有空 `text` → 400 且 `steps` 未变。
3. step 1 正常 → 200、`feedback.items.length === 3`、`progress.steps[0].status === 'completed'`、反馈里的 `chunkUsage`（amount good）让对应 chunk 变 `activated`。
4. step 2 同一 `chunkId` 反馈重复提交两次 → `uses_count === 1`（Review Focus 1）。
5. 步骤反馈 AI 抛错 → 503、`hasAnswers === true`、`progress.steps[0].status === 'answered'`、`feedback === null`；随后重提交成功 → `completed`。
6. Ai 未配置（临时把 `process.env.AI_API_KEY` 置空再还原）→ 503，且 `steps[0].status === 'answered'`（Review Focus 4）。
7. step 4 空文本 + `durationMs: 6000` → 200、`feedback === null`、`note` 非空，且 AI 调用计数不变。
8. step 4 空文本 + `durationMs: 1000` → 400。
9. chat 首调（无 text）→ `reply` 非空、`messages` 长度为 1（只有 AI 开场白）、`userTurns === 0`。
10. chat 正常一轮 → `userTurns === 1`；连续 8 轮后第 9 轮 → 400。
11. finish 在 `userTurns < 5` 时 → 400；步骤 1–4 有未完成时也 → 400（`error` 含「未完成」）。
12. 打满 5 轮后 finish → 200、`report.speaking` 有本地统计、`report.mastered/selfUsed/review/introduced` 四堆存在、`progress.status === 'completed'`、`progress.cursor === 5`。
13. finish 后 `GET ?variant=2` 与 `GET ?variant=1` 的 `report` 互不影响（Review Focus 5）：先在第一套完成到 finish 记录三堆，再生成第二套并让它把某个 chunk 练到 `mastered`，`GET ?variant=1` 的该 chunk 仍在原来的堆里。
14. AI 返回的 `chunkUsage` 用 `chunkId: 77`（越界）→ 200 且 `chunk_mastery` 行数/状态不变（Review Focus 3）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/routes/challenge.test.cjs`
Expected: FAIL — `step` 相关用例 404

- [ ] **Step 3: 实现三个接口**

`parseStepAnswers(step, body)` 做逐 step 校验并返回 `{ ok, answers }` 或 `{ ok:false, error }`；`collectSpeakingAttempts(steps)` 扫过五步所有 `answers`（每项算一次尝试，`durationMs`/`segments` 直接取），再用 `{ longestSeconds, totalSeconds, segments }` 聚合（与前端 `aggregateSpeaking` 同语义）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/routes/challenge.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add server/routes/challenge.cjs server/routes/challenge.test.cjs
git commit -m "feat(api): challenge step feedback, chat and finish report"
```

---

### Task 7: 音频栈「可选分段」能力 + 分段录音 hook

**Files:**
- Modify: `src/utils/pcmRecorder.js`（`stop` 增加可选参数）
- Modify: `src/utils/aliyunAsr.js`（`keepStream` 模式）
- Modify: `src/utils/useSpeechInput.js`（可选参数与分段回调）
- Create: `src/utils/useSegmentSpeechInput.js`
- Test: `src/utils/pcmRecorder.test.js`（现有测试必须继续通过；如需补测只测纯函数）

**Interfaces:**
- `createPcmRecorder(): { start(): void, stop(opts?: { keepStream?: boolean }): Promise<ArrayBuffer> }`
  - `keepStream: true` → 取出当前缓冲并清空，**不断开 media stream、不关闭 AudioContext**，可继续录制；
  - 省略/`false` → 现有行为（断开、关闭、返回全部 PCM）。
- `createAsrSpeechInput(authFetch, { keepStream?: boolean } = {})`（默认 `false`，行为不变）
- `useSpeechInput(authFetch, { segmented?: boolean, onSegmentEnd?: (text: string) => void } = {})`
  → 仍是 `{ listening, error, source, start, stop }`；`segmented` 为假时行为与现在完全一致。
- `useSegmentSpeechInput(authFetch)` →
  ```js
  {
    listening, error, source,
    text,            // 已合并的各段文本
    segments,        // 段数（含最后一段）
    activeMs,        // 累计说话时长（毫秒）
    elapsedMs,       // 当前正在录的这一段已过时间（1s 心跳，用于计时器）
    start(),         // 清空 text/segments/activeMs 并开始
    stop(),          // 结束当前段并停止（不会再自动续录）
    reset(),         // 清空全部本地状态
  }
  ```

**分段切段规则（实现必须对上）**
- 阿里云路径：每满 `MAX_SECONDS`（60s）自动 `stop({keepStream:true})` → 上传识别 → 结果交给 `onSegmentEnd` → 继续录；用户手动停 → 最后一段用 `stop()`（关流）并同样交付。
- Web Speech 路径（`source === 'web'`）：`onend` 触发时若仍 `listening`，把该段文本交给 `onSegmentEnd` 并立刻重新 `start()` 同一个实例，实现连续识别。

- [ ] **Step 1: 改 `pcmRecorder.stop`（无需新测试，跑现有测试确认不回归）**

Run: `node --test src/utils/pcmRecorder.test.js`
Expected: 现有 `linearDecimate` 用例 PASS

- [ ] **Step 2: 改 `aliyunAsr` 支持 `keepStream`**

`submit({ cont })`：`pcm = await rec.stop({ keepStream: cont })`；上传成功后 `onFinal(text)`；`cont && active` 时重排 60s 定时器，否则 `onEnd()`。`start()` 里记录 `active = true` 并把定时器设为 `MAX_SECONDS * 1000`。

- [ ] **Step 3: 改 `useSpeechInput` 接收可选参数**

`createAsrSpeechInput(authFetch, { keepStream: segmented })`；`start()` 里的 `onFinal` 回调在 `segmented` 时调用 `onSegmentEnd(text)` 并保持 `listening`（不 `setActive(false)`），非分段时保持现状；`stop()` 在分段模式下调用 `speechRef.current.stop()` 后 `setActive(false)`。用 `useRef` 保存 `onSegmentEnd`，避免 effect 依赖抖动。

- [ ] **Step 4: 写 `useSegmentSpeechInput`**

基于 `useSpeechInput(authFetch, { segmented: true, onSegmentEnd })` + 一段文本合并与计时逻辑；文本合并调用 Task 8 的 `mergeSegmentText`（先写 `mergeSegmentText` 的最小实现也可以，Task 8 会补测试）。`elapsedMs` 用 `setInterval(…, 1000)`，仅在 `listening` 时启动，清理在 effect return 里。

- [ ] **Step 5: 验证编译与不回归**

Run: `npm run lint`
Run: `npm run build`
Expected: 均通过；`git diff` 里 `useSpeechInput` 的既有分支没有语义变化。
手工冒烟（写进 PR 描述）：`DialoguePage` 与 `TextDocPage` 的打字/麦克风仍正常（默认参数路径）。

- [ ] **Step 6: 提交**

```bash
git add src/utils/pcmRecorder.js src/utils/aliyunAsr.js src/utils/useSpeechInput.js src/utils/useSegmentSpeechInput.js
git commit -m "feat(audio): optional 60s segment recording without closing the mic"
```

---

### Task 8: 前端纯逻辑（`speakingChallenge.js`）

**Files:**
- Create: `src/utils/speakingChallenge.js`
- Test: `src/utils/speakingChallenge.test.js`

**Interfaces:**
- Produces（Task 9–12 使用）：
  - `STEP_META: Array<{ step, key, title, cn }>`（1 recall / 2 chunks / 3 transform / 4 topic / 5 chat）
  - `CHAT_MIN_TURNS = 5`、`CHAT_MAX_TURNS = 8`
  - `FILLER_WORDS: string[]`
  - `stepStatus(steps, step): 'done' | 'answered' | 'todo'`
  - `resumeStep(progress): 0..5`（`status === 'completed'` → 5；否则第一个非 `'completed'` 的步）
  - `countWords(text): number`
  - `wpm(words: number, activeMs: number): number|null`（`activeMs < 5000` → `null`）
  - `mergeSegmentText(prev: string, next: string): string`
  - `aggregateSpeaking(attempts: Array<{durationMs?: number, segments?: number}>): { longestSeconds, totalSeconds, segments }`
    入参是**每次尝试一项**（调用方先把该次尝试的各段 `durationMs` 相加），`longestSeconds = max(durationMs)/1000`、`totalSeconds = sum/1000`、`segments = sum(segments)`。
  - `countFillers(text: string, list?: string[]): string[]`（返回命中的填充词，去重）
  - `chatUserTurns(messages: any[]): number`
  - `canFinishChat(messages: any[]): { can: boolean, reason: string, userTurns: number }`
  - `reportBuckets(mastery: object): { mastered: any[], selfUsed: any[], review: any[], introduced: any[] }`
  - `formatDuration(ms: number): string`（`"58s"` / `"1:18"`）
  - `clampServerText(text: string, max = 2000): string`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STEP_META, CHAT_MIN_TURNS, CHAT_MAX_TURNS, stepStatus, resumeStep, countWords,
  wpm, mergeSegmentText, aggregateSpeaking, countFillers, chatUserTurns,
  canFinishChat, reportBuckets, formatDuration, clampServerText,
} from './speakingChallenge.js'

test('STEP_META 五步顺序固定', () => {
  assert.deepEqual(STEP_META.map(s => s.step), [1, 2, 3, 4, 5])
  assert.equal(STEP_META[0].title, 'Video Recall')
  assert.equal(STEP_META[4].cn, 'AI 对话')
})

test('stepStatus 区分 done/answered/todo', () => {
  const steps = [{ status: 'completed' }, null, { status: 'answered' }, null, null]
  assert.equal(stepStatus(steps, 1), 'done')
  assert.equal(stepStatus(steps, 2), 'todo')
  assert.equal(stepStatus(steps, 3), 'answered')
  assert.equal(stepStatus(null, 1), 'todo')
})

test('resumeStep 优先回到第一个未完成的步，或报告', () => {
  assert.equal(resumeStep({ status: 'completed', steps: [] }), 5)
  assert.equal(resumeStep({ status: 'active', steps: [{ status: 'completed' }, { status: 'answered' }] }), 1)
  assert.equal(resumeStep({ status: 'active', steps: [] }), 0)
  assert.equal(resumeStep(null), 0)
  assert.equal(resumeStep({ status: 'active', steps: [1, 2, 3, 4].map(() => ({ status: 'completed' })) }), 4)
})

test('countWords / wpm / formatDuration', () => {
  assert.equal(countWords('  I   checked in at noon. '), 5)
  assert.equal(countWords(''), 0)
  assert.equal(wpm(90, 60000), 90)
  assert.equal(wpm(10, 3000), null)
  assert.equal(formatDuration(58000), '58s')
  assert.equal(formatDuration(78000), '1:18')
})

test('mergeSegmentText 切段拼接不丢词不重复不多空格', () => {
  assert.equal(mergeSegmentText('', 'hello'), 'hello')
  assert.equal(mergeSegmentText('hello', ' world'), 'hello world')
  assert.equal(mergeSegmentText('hello ', 'world'), 'hello world')
  assert.equal(mergeSegmentText('we checked', 'in at noon'), 'we checked in at noon')
  assert.equal(mergeSegmentText('abc', ''), 'abc')
})

test('aggregateSpeaking 取单次尝试的最大时长，累计总时长与段数', () => {
  const r = aggregateSpeaking([
    { durationMs: 90000, segments: 2 },   // 一次尝试：两段录音累加 90 秒
    { durationMs: 40000, segments: 1 },   // 另一次尝试（重录）
  ])
  assert.equal(r.longestSeconds, 90)
  assert.equal(r.totalSeconds, 130)
  assert.equal(r.segments, 3)
  assert.deepEqual(aggregateSpeaking([]), { longestSeconds: 0, totalSeconds: 0, segments: 0 })
})

test('countFillers 命中去重且忽略大小写', () => {
  assert.deepEqual(countFillers('Um, I think, um, like it works'), ['um', 'like'])
  assert.deepEqual(countFillers('no fillers here'), [])
})

test('chat 轮次与结束条件', () => {
  const msgs = (n) => Array.from({ length: n * 2 - 1 }, (_, i) => ({ role: i % 2 === 0 ? 'ai' : 'user' }))
  assert.equal(chatUserTurns(msgs(3)), 3)
  assert.equal(canFinishChat(msgs(4)).can, false)
  assert.equal(canFinishChat(msgs(CHAT_MIN_TURNS)).can, true)
  assert.equal(canFinishChat(msgs(CHAT_MAX_TURNS)).reason, 'max')
})

test('reportBuckets 从 mastery 取四堆', () => {
  const b = reportBuckets({ mastered: [1], selfUsed: [2], review: [3], introduced: [4] })
  assert.deepEqual([b.mastered.length, b.selfUsed.length, b.review.length, b.introduced.length], [1, 1, 1, 1])
  assert.deepEqual(reportBuckets(null), { mastered: [], selfUsed: [], review: [], introduced: [] })
})

test('clampServerText 截断到上限', () => {
  assert.equal(clampServerText('abcdef', 3), 'abc')
  assert.equal(clampServerText('abc', 10), 'abc')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/utils/speakingChallenge.test.js`
Expected: FAIL — `Cannot find module './speakingChallenge.js'`

- [ ] **Step 3: 实现 `speakingChallenge.js`**

`aggregateSpeaking` 的入参约定为**每次尝试一条**（页面与路由在提交前把同一次尝试的各段 `durationMs` 相加、`segments` 相加）。实现：`longestSeconds = Math.round(max(durationMs)/1000)`、`totalSeconds = Math.round(sum/1000)`、`segments = sum`；空数组返回全 0。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/utils/speakingChallenge.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/speakingChallenge.js src/utils/speakingChallenge.test.js
git commit -m "feat(challenge): pure helpers for speaking challenge UI"
```

---

### Task 9: 反馈卡 + 录音输入组件

**Files:**
- Create: `src/components/challenge/StepFeedback.jsx`
- Create: `src/components/challenge/AnswerInput.jsx`

**Interfaces:**
- `StepFeedback({ step, feedback, chunks, onRetry })`
  - `chunks` = `challenge.chunks`（用于把 `chunkId` 翻成中文释义；**不显示英文**，遵守 D13）
  - `feedback === null` 时渲染「已作答，等待反馈」+ 「重试反馈」按钮（`onRetry`）
  - 有 `feedback` 时渲染：分数、`items[].grammar/naturalness`（原文 → 更好说法 + 中文原因）、`chunkUsage` 打勾/打叉、`vocabulary.suggestions`、`coherence.summary` + `fillers`、`praise`
  - 每条 `grammar/naturalness/better` 右侧一个「🔊 听地道说法」按钮，用 `createSpeaker(authFetch)` 播英文（组件内部 `useRef` + `useEffect` 清理 `stop()`）
- `AnswerInput({ value, onChange(text, meta), placeholder, rows = 3, disabled, showTimer, targetSeconds })`
  - 内部用 `useSegmentSpeechInput(authFetch)`；麦克风按钮切换 `start()/stop()`
  - 每次段结束把合并文本与 `{ durationMs: activeMs, segments }` 通过 `onChange` 交给父组件
  - `showTimer` 时显示 `formatDuration(elapsedMs)` 与目标时长的进度条

- [ ] **Step 1: 实现 `StepFeedback.jsx`**

纯展示组件（无网络、无 hook 副作用：`createSpeaker` 只在点击时创建）。文案全中文，图标用 lucide（`CheckCircle2` / `AlertTriangle` / `Volume2` / `RotateCcw`）。

- [ ] **Step 2: 实现 `AnswerInput.jsx`**

`useSegmentSpeechInput` + `<textarea>`；麦克风用 `Mic` / `Square` 图标；错误用 `text-rose-600` 小字。

- [ ] **Step 3: 验证编译**

Run: `npm run lint`
Run: `npm run build`
Expected: 均通过（无未使用导入、无 hook 依赖警告）

- [ ] **Step 4: 提交**

```bash
git add src/components/challenge/StepFeedback.jsx src/components/challenge/AnswerInput.jsx
git commit -m "feat(challenge): feedback card and segmented recording input"
```

---

### Task 10: Step 1 / 2 界面（复述 + 语块激活）

**Files:**
- Create: `src/components/challenge/StageList.jsx`（Step 1 与 Step 3 共用）
- Create: `src/components/challenge/StageChunks.jsx`

**Interfaces:**
- `StageList({ step, items, record, onSubmit, busy, submitLabel })`
  - `items` = `[{ index, title, subtitle, hint }]`（Step 1 传英文问题 + 中文 + `focusCn`；Step 3 传中文情境 + 空 subtitle + `hintCn`）
  - 本地 state：`drafts`（`{ [index]: { text, durationMs, segments } }`），初值取 `record?.answers`
  - 提交：所有 `text` 非空才可点；`onSubmit(items.map(i => ({ index: i.index, ...drafts[i.index] })))`
  - 提交后传 `step` 与 `record?.feedback` 给 `<StepFeedback />`；`busy` 时按钮禁用并显示「AI 评分中…」
- `StageChunks({ step = 2, chunks, record, onSubmit, busy })`
  - 每张卡：`cn` 中文释义 + `evidence` 用 `maskEvidence()` 遮挡（见 Step 1）+ 两个 `AnswerInput`（「说出英文语块」与「用它造一句」）
  - `record?.feedback` 存在时卡片显示英文 `en` 与「语块说对了/没说对」
  - 提交：每张卡 `chunkText` 与 `sentence` 至少一个非空

- [ ] **Step 1: 在 `src/utils/speakingChallenge.js` 加 `maskEvidence(text)` 并补测试**

```js
export function maskEvidence(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  return s.replace(/[A-Za-z][A-Za-z'’]*/g, (w) => '•'.repeat(Math.max(2, Math.min(w.length, 6))))
}
```
测试：`maskEvidence('Hold my bags')` 不含任何字母且长度 > 0；空输入 → `''`。
Run: `node --test src/utils/speakingChallenge.test.js` → PASS

- [ ] **Step 2: 实现 `StageList.jsx`**

- [ ] **Step 3: 实现 `StageChunks.jsx`**

- [ ] **Step 4: 验证编译**

Run: `npm run lint && npm run build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/utils/speakingChallenge.js src/utils/speakingChallenge.test.js \
  src/components/challenge/StageList.jsx src/components/challenge/StageChunks.jsx
git commit -m "feat(challenge): recall and chunk activation stages"
```

---

### Task 11: Step 4 / 5 界面（话题表达 + AI 对话）

**Files:**
- Create: `src/components/challenge/StageTopic.jsx`
- Create: `src/components/challenge/StageChat.jsx`

**Interfaces:**
- `StageTopic({ topic, record, onSubmit, busy })`
  - 展示 `promptEn` / `promptCn` / `pointsCn` / `targetSeconds`
  - 一个 `showTimer` 的 `AnswerInput`（`rows={6}`）；计时到 `targetSeconds` 时进度条变绿并提示「可以提交了（也可继续说）」
  - 提交 `{ text, durationMs, segments }`；`record?.note` 存在时显示该提示（如「未识别到语音内容，只记录时长」）
  - 本地词数：`countWords(text)` 与 `wpm(...)` 实时显示
- `StageChat({ messages, onSend, onFinish, busy, canFinish, finishReason })`
  - `messages` 为 `[{ role: 'ai'|'user', text, durationMs?, segments? }]`
  - 空列表 → 显示话题卡与「开始对话」按钮（`onSend()` 无参数）
  - 输入框 + 麦克风（`AnswerInput` 单行模式或独立按钮）+ 发送；`userTurns` 用 `chatUserTurns` 计算并显示「第 N/8 轮」
  - 「结束对话并生成报告」按钮：`canFinish === false` 时禁用并显示 `finishReason`（「还需要 X 轮」/「已达上限」）

- [ ] **Step 1: 实现 `StageTopic.jsx`**

- [ ] **Step 2: 实现 `StageChat.jsx`**

- [ ] **Step 3: 验证编译**

Run: `npm run lint && npm run build`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/components/challenge/StageTopic.jsx src/components/challenge/StageChat.jsx
git commit -m "feat(challenge): topic speaking and AI conversation stages"
```

---

### Task 12: 报告卡 + 页面（串联全流程）

**Files:**
- Create: `src/components/challenge/ChallengeReport.jsx`
- Create: `src/pages/SpeakingChallengePage.jsx`
- Modify: `src/main.jsx`（新增 `video/:id/challenge` 路由 + import）

**Interfaces:**
- `ChallengeReport({ report, onRestart, onRegenerate, onOpenHistory })`
  - 内部先用 `reportBuckets(report)` 取四堆（兼容老报告缺 `introduced`）
  - 顶部：`score`、`summary`、`speaking.longestSeconds / totalSeconds / segments`
  - 四堆：已掌握 / 能自主使用 / 需要复习（带 `whyCn`）/ 本次新引入
  - `nextSuggestions` 列表；`speaking.longestSeconds === 0` 时用它位置换文案「未检测到连续语音（本次只用打字或未开麦）」；三个按钮
- `SpeakingChallengePage()` 路由 `/video/:id/challenge`
  - state：`hub`（GET 载荷）、`loading`、`error`、`busy`（`'generate'|'step'|'chat'|'finish'|'restart'`）、`actionError`、`stepIndex`（0–5，5 = 报告）、`historyOpen`
  - 加载 effect **按 id 记忆且不取消**（避免 dev StrictMode 双挂载把首次启动掐掉）：`bootedIdRef.current === id` 时直接 return；不要写 `cancelled` 早退
  - `load(variant?)` → `authFetch('/challenge/' + encodeURIComponent(id) + (variant ? '?variant=' + variant : ''))`
  - `generate()` → `POST /challenge/:videoId/generate` → 替换 hub 并 `setStepIndex(0)`
  - `submitStep(step, payload)` → `POST /challenge/:challengeId/step/:step` → 合并 `progress`/`mastery`，成功后**停在当前步**看反馈（`stepIndex` 不变，`step` 是 1-based、`stepIndex` 是 0-based）
  - `sendChat(text?)` → `POST /challenge/:challengeId/chat`
  - `finishChat()` → `POST /challenge/:challengeId/finish` → `setStepIndex(5)`
  - `restart()` → `POST /challenge/:challengeId/restart` → `setStepIndex(0)`
  - 顶部：缩略图（`hub.video.thumbnail`）、标题、等级、「⟵ 回看原视频」（`navigate('/video/' + id)`）、「历史」抽屉（`hub.history`，点击 `load(variant)`）、「重新生成」（有 challenge 时才显示，二次确认文案「会生成一套全新任务，当前这套会保留在历史里」）
  - 步骤条：五步 `STEP_META` + `stepStatus(steps, step)`；点击已完成/已作答的步可跳转（未解锁的步禁用）
  - 步内容按 `stepIndex` 渲染 `StageList`（1、3）、`StageChunks`（2）、`StageTopic`（4）、`StageChat`（5）、`ChallengeReport`（5 且 `progress.status === 'completed'`）
  - `aiConfigured === false` → 顶部黄色横幅「AI 未配置，暂时无法生成或评分」并禁用所有写操作
  - 无挑战时 → 引导卡 + 「生成挑战」

- [ ] **Step 1: 实现 `ChallengeReport.jsx`**

- [ ] **Step 2: 实现 `SpeakingChallengePage.jsx`**

- [ ] **Step 3: 在 `src/main.jsx` 注册路由**

- [ ] **Step 4: 验证编译与手测（后端 dev + 假 AI 可稍后由 Task 14 覆盖）**

Run: `npm run lint && npm run build`
Expected: 通过
手测：`npm run server` + `npm run dev` → 打开 `/video/<id>/challenge` → 生成 → 五步走完 → 报告 → 再练一次 → 重新生成（variant 递增）→ 历史回看 variant 1。

- [ ] **Step 5: 提交**

```bash
git add src/pages/SpeakingChallengePage.jsx src/components/challenge/ChallengeReport.jsx src/main.jsx
git commit -m "feat(challenge): speaking challenge page wired to API"
```

---

### Task 13: 换入口 + 下线多轮对话

**Files:**
- Modify: `src/pages/VideoDetail.jsx`（两处下拉菜单：移动端 `~line 888-901`、桌面端 `~line 1249-1263`）
- Modify: `src/main.jsx`（删 `video/:id/conversation` 路由与 import）
- Modify: `src/pages/LearningRecords.jsx`（删 `conversations` state、`/conversation/recent` 请求、Tab 计数、对话记录区块）
- Modify: `server/index.cjs`（删 `conversationRoutes` require 与 `app.use('/api/conversation', …)`）
- Delete: `src/pages/ConversationPage.jsx`、`src/components/conversation/ChatBubble.jsx`、`src/components/conversation/ReviewPanel.jsx`、`server/routes/conversation.cjs`、`server/routes/conversation.test.cjs`、`server/routes/conversation-ai.test.cjs`

**Interfaces:**
- 入口：下拉第一项 `🎯 每日口语挑战` → `/video/${id}/challenge`；`isGuest` 时 `from` 也改成 `/video/${id}/challenge`
- 保留：`server/services/ai/conversation.cjs` 与 `conversation.test.cjs`（兜底池用）、`conversation_*` 表与数据、`src/index.css` 的 `.conv-*` 样式

- [ ] **Step 1: 替换 `VideoDetail.jsx` 两处菜单项**

两处都改成：
```jsx
<button onClick={() => { setShowSpeakMenu(false); navigate(`/video/${id}/challenge`) }}
  className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer">🎯 每日口语挑战</button>
```
并把两处 `onClick` 里 `isGuest` 的 `from` 改成 `/video/${id}/challenge`。

- [ ] **Step 2: 删前端对话页与路由**

删文件 + 删 `src/main.jsx` 里的 import 与 `<Route path="video/:id/conversation" …>`。

- [ ] **Step 3: 删学习记录里的对话区块**

删 `conversations` state、`useEffect` 里的 `/conversation/recent` 请求、Tab 计数与列表区块。检查空态文案里是否还提「AI 对话」，有则删掉那句话。

- [ ] **Step 4: 删后端对话路由与测试**

删 `server/routes/conversation.cjs` + 两个测试文件 + `server/index.cjs` 的两行。

- [ ] **Step 5: 验证**

Run: `grep -rn "api/conversation\|ConversationPage\|conversation/recent\|video/:id/conversation" src server scripts`
Expected: 无输出
Run: `node --test "server/**/*.test.cjs" "src/**/*.test.js"`
Expected: 全部 PASS（`conversation-ai.test.cjs` 已删）
Run: `npm run lint && npm run build`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: replace multi-turn conversation entry with daily speaking challenge"
```

---

### Task 14: 端到端校验脚本 + 全量验收

**Files:**
- Create: `scripts/verify-speaking-challenge.mjs`
- Modify: `README.md`（「开发 / 脚本」一节补一行用法，若该节存在）

**Interfaces:**
- 用法：`SV_TOKEN=<jwt> APP_URL=http://localhost:5174 node scripts/verify-speaking-challenge.mjs`
- 依赖：Chrome `--remote-debugging-port=9222`；后端 `AI_API_KEY=test AI_BASE_URL=http://127.0.0.1:3999/v1`（脚本自带 stub 服务）
- 断言清单（对照设计 §9.2）：
  1. `/video/:id/challenge` 渲染出「生成挑战」按钮
  2. 点击生成 → 网络面板里出现 `POST /api/challenge/<uuid>/generate`，且没有 `/api/conversation` 请求
  3. 五步依次提交（stub AI 返回固定 JSON）→ 每步出现反馈卡
  4. 对话 5 轮后点结束 → 出现报告卡，含「已掌握 / 能自主使用 / 需要复习」三堆
  5. 点「重新生成」→ 出现 `POST .../generate` 第二次，页面显示新挑战
  6. 历史抽屉里能看到上一套（variant 1）

- [ ] **Step 1: 以 `scripts/verify-text-practice.mjs` 为模板写脚本**

沿用它的三件套：自带 stub AI server（按 system 关键字返回固定 JSON）+ 启动 headless Chrome + CDP 断言；末尾按失败项数 `process.exit(1)`。

- [ ] **Step 2: 跑脚本**

Run（另开两个终端）：
```bash
AI_API_KEY=test AI_BASE_URL=http://127.0.0.1:3999/v1 npm run server
npm run dev
```
然后：
```bash
SV_TOKEN=<从 dev 登录后 localStorage 取的 jwt> APP_URL=http://localhost:5174 node scripts/verify-speaking-challenge.mjs
```
Expected: 全部断言 PASS，退出码 0；把输出贴进 PR 描述。

- [ ] **Step 3: 全量回归**

Run: `node --test "server/**/*.test.cjs" "src/**/*.test.js"`
Run: `npm run lint`
Run: `npm run build`
Expected: 全 PASS。

- [ ] **Step 4: 手工验收（设计 §9.3）**

逐条走一遍并记录结果：3 个不同视频生成；同视频连续生成两套差异明显；AI 未配置环境不产生假分数；375px 移动端五步可操作；90 秒分段录音得到 `longestSeconds ≈ 90` 且 `segments ≥ 2`。

- [ ] **Step 5: 提交**

```bash
git add scripts/verify-speaking-challenge.mjs README.md
git commit -m "test(challenge): end-to-end verification script"
```

---

## 交付顺序小结

1. 数据层（Task 1–2）→ 2. AI 层（Task 3–4）→ 3. API 层（Task 5–6）→ 4. 音频与纯逻辑（Task 7–8）→ 5. 界面（Task 9–12）→ 6. 换入口与下线（Task 13）→ 7. 端到端验收（Task 14）。

Task 1–6 是纯服务端，可先合并后端；Task 7–13 依赖后端接口形状，顺序执行。
