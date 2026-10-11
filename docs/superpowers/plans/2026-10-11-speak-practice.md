# 自由表达（看中文说英文 · 口语评分）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在视频详情页新增「自由表达」口语练习：看中文句子说英文，点「解析」由 AI 逐句评分（语法/用词/搭配/地道/更地道说法/低分提示），练习句提前落盘省 token。

**Architecture:** 复用现有 `wordcard.json` 的离线预提取模式（新脚本 `build-speak-prompts.mjs` 生成 `speak-prompts.json`），新增一个纯函数过滤工具（脚本与前端共用）、一个 AI 评分服务 + 一个 `POST /api/speak/review` 端点、一个响应式练习页；语音链路完全复用阿里云 ASR / Web Speech / 打字兜底。记录复用 `practiceRecords` 加 `speak` 任务（learningStatus 三项进度不变）。

**Tech Stack:** React 19 + Vite 8、Express 5 (CJS)、node:test、provider.cjs（OpenAI 兼容 fetch）、sql.js。零新 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-10-11-speak-practice-design.md`

## Global Constraints

- 游客不允许使用：`/api/speak/review` 用 authMiddleware（401），前端入口引导登录。
- 桌面 + 手机端交互一致：单列响应式页面、≥48px 触控按钮、无 hover 依赖、无横向滚动。
- 禁伪造评分：无 AI key → 503 提示；AI 调用失败 → 503；AI 输出畸形 → `score:null` + 提示重试。
- 静态内容提前落盘（`speak-prompts.json`），运行时零提取 token；评分调用只在点「解析」时发生。
- 参考答案 `en` 解析前隐藏；评分口径「表达对不对/能接受」，`en` 不是唯一答案。
- 复用：`provider.cjs`、`aliyunAsr`/`recallSpeech`/`pcmRecorder`、`practiceRecords`、`authMiddleware`。
- `learningStatus.js` 的 `TASKS` 保持 `['shadow','cloze','translate']` 不变（不把 speak 计入视频学习状态百分比）。

## Review Focus

1. 全部字幕都「适合」时，练习句也必须 < 字幕数（不能全量）→ Task 1 的 cap 测试。
2. AI 给越界/畸形分数（150、缺失、非数字）→ 钳制到 0-100 或置 null，前端不崩 → Task 2 的 parseReview 测试。
3. score≥70 不显示低分提示、<70 显示 → Task 2 的 parseReview 测试。
4. `speak-prompts.json` 缺失或为空 → 本地降级出字幕句 + 空态，不白屏 → Task 6 的 fallback/空态。
5. 麦克风/ASR 不可用 → 打字输入兜底，仍能解析 → Task 6 复用现有语音链。

---

### Task 1: 本地过滤纯函数 `src/utils/speakPrompts.js`

**Files:**
- Create: `src/utils/speakPrompts.js`
- Test: `src/utils/speakPrompts.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export function filterSubtitlesToPrompts(subtitles, options = {})` → `Array<{ cn:string, en:string, source:'subtitle', subIndex:number }>`；`options.maxPrompts` 默认 40。
  - `export function buildSpeakPromptsData({ videoId, title, subtitlePrompts, extensionPrompts, generatedAt })` → `{ version:1, videoId, title, generatedAt, prompts:Array<{index,cn,en,source,subIndex}> }`（`index` 为数组下标；`extensionPrompts` 的 `subIndex:null`、`source:'ai_generated'`）。

过滤规则（逐条字幕，按顺序）：`cn=String(s.textCn).trim()`、`en=String(s.textEn).replace(/\s+/g,' ').trim()`；保留当且仅当：`cn.length>=4` 且 `cn.length<=80`、`/[\u4e00-\u9fff]/.test(cn)`、`en.split(/\s+/).length>=2`、`/[a-zA-Z]/.test(en)`；结果 `slice(0, max(0, min(maxPrompts, subtitles.length-1)))`。

- [ ] **Step 1: 写失败测试**

```js
// src/utils/speakPrompts.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterSubtitlesToPrompts, buildSpeakPromptsData } from './speakPrompts.js'

describe('filterSubtitlesToPrompts', () => {
  it('非数组 / 空数组 → []', () => {
    assert.deepEqual(filterSubtitlesToPrompts(null), [])
    assert.deepEqual(filterSubtitlesToPrompts([]), [])
  })
  it('剔除空/短/单词/无中文/无字母', () => {
    const subs = [
      { textEn: 'We checked in today.', textCn: '我们今天办理了入住。' },     // keep
      { textEn: 'Hi', textCn: '嗨' },                                        // cn<4 且 en 单词
      { textEn: '', textCn: '空的英文' },                                     // en 空
      { textEn: 'Nice view', textCn: '' },                                   // cn 空
      { textEn: '123 456', textCn: '一二三四五六' },                          // en 无字母
      { textEn: 'The concierge took our bags.', textCn: '礼宾员拿了行李。' }, // keep
    ]
    assert.deepEqual(filterSubtitlesToPrompts(subs), [
      { cn: '我们今天办理了入住。', en: 'We checked in today.', source: 'subtitle', subIndex: 0 },
      { cn: '礼宾员拿了行李。', en: 'The concierge took our bags.', source: 'subtitle', subIndex: 5 },
    ])
  })
  it('上限 maxPrompts 截断', () => {
    const subs = Array.from({ length: 10 }, (_, i) => ({ textEn: `This is sentence ${i} here.`, textCn: `这是第${i}个句子。` }))
    assert.equal(filterSubtitlesToPrompts(subs, { maxPrompts: 3 }).length, 3)
  })
  it('总数始终小于字幕数（全部适合时也截掉）', () => {
    const subs = Array.from({ length: 5 }, (_, i) => ({ textEn: `This is sentence ${i} here.`, textCn: `这是第${i}个句子。` }))
    assert.equal(filterSubtitlesToPrompts(subs).length, 4)
  })
})

describe('buildSpeakPromptsData', () => {
  it('组装 index/version/title/generatedAt', () => {
    const data = buildSpeakPromptsData({
      videoId: 'v1', title: '测试', generatedAt: '2026-10-11T00:00:00Z',
      subtitlePrompts: [{ cn: 'a', en: 'A', source: 'subtitle', subIndex: 3 }],
      extensionPrompts: [{ cn: 'b', en: 'B', source: 'ai_generated', subIndex: null }],
    })
    assert.equal(data.version, 1)
    assert.equal(data.videoId, 'v1')
    assert.deepEqual(data.prompts.map(p => p.index), [0, 1])
    assert.deepEqual(data.prompts[0], { index: 0, cn: 'a', en: 'A', source: 'subtitle', subIndex: 3 })
    assert.deepEqual(data.prompts[1], { index: 1, cn: 'b', en: 'B', source: 'ai_generated', subIndex: null })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `filterSubtitlesToPrompts` / `buildSpeakPromptsData`** 在 `src/utils/speakPrompts.js`

按上述签名与规则写函数体。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/speakPrompts.js src/utils/speakPrompts.test.js
git commit -m "feat(speak): 字幕→练习句本地过滤纯函数"
```

---

### Task 2: 评分服务 `server/services/ai/speak.cjs`

**Files:**
- Create: `server/services/ai/speak.cjs`
- Test: `server/services/ai/speak.test.cjs`

**Interfaces:**
- Consumes: `require('./provider.cjs')` 的 `extractJson`
- Produces:
  - `module.exports = { buildReviewPrompt, parseReview, reviewFromContent }`
  - `buildReviewPrompt({ cn, en, userText })` → `{ system, user }`（system 为中文规则，含「参考答案只是其中一种正确说法，不是唯一答案」「搭配」「地道」；user 含 cn/en/userText 三段原文与输出 JSON 结构）。
  - `parseReview(obj)` → `{ score:number|null, issues:Array, better:string, praise:string, lowScoreHint:string }`；score 非有限数→null，否则 `Math.min(100, Math.max(0, score))`；issues 非数组→`[]`，每项归一化为 `{type,location,problem,suggestion,better}` 字符串；`lowScoreHint` 仅当 `score!==null && score<70` 时取字符串否则 `''`；永不 throw。
  - `reviewFromContent(content)` → `{ review }`；`extractJson` 成功→`{ review: parseReview(obj) }`；失败→`{ review: { score:null, issues:[], better:'', praise:'', lowScoreHint:'', parseError:true } }`。

- [ ] **Step 1: 写失败测试**

```js
// server/services/ai/speak.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildReviewPrompt, parseReview, reviewFromContent } = require('./speak.cjs')

test('buildReviewPrompt 包含 cn/en/userText 与关键规则', () => {
  const p = buildReviewPrompt({ cn: '我们办理了入住。', en: 'We checked in.', userText: 'We check in.' })
  assert.ok(p.system.includes('不是唯一答案'))
  assert.ok(p.system.includes('搭配'))
  assert.ok(p.user.includes('我们办理了入住。'))
  assert.ok(p.user.includes('We checked in.'))
  assert.ok(p.user.includes('We check in.'))
})

test('parseReview 正常对象逐字段保留', () => {
  const r = parseReview({ score: 85, issues: [{ type: 'collocation', location: 'x', problem: 'p', suggestion: 's', better: 'b' }], better: 'B', praise: '不错', lowScoreHint: '提示' })
  assert.equal(r.score, 85)
  assert.equal(r.issues[0].type, 'collocation')
  assert.equal(r.better, 'B')
  assert.equal(r.praise, '不错')
  assert.equal(r.lowScoreHint, '') // score>=70 强制清空
})

test('parseReview 钳制越界分数', () => {
  assert.equal(parseReview({ score: 150 }).score, 100)
  assert.equal(parseReview({ score: -5 }).score, 0)
  assert.equal(parseReview({ score: 'abc' }).score, null)
  assert.equal(parseReview({}).score, null)
})

test('parseReview 低分才给提示', () => {
  assert.equal(parseReview({ score: 60, lowScoreHint: '注意时态' }).lowScoreHint, '注意时态')
  assert.equal(parseReview({ score: 70, lowScoreHint: 'x' }).lowScoreHint, '')
  assert.equal(parseReview({ score: null, lowScoreHint: 'x' }).lowScoreHint, '')
})

test('parseReview 容忍缺失字段', () => {
  assert.deepEqual(parseReview(null), { score: null, issues: [], better: '', praise: '', lowScoreHint: '' })
  assert.deepEqual(parseReview({ score: 80, issues: 'not-array' }).issues, [])
})

test('reviewFromContent 解析畸形 → parseError', () => {
  assert.equal(reviewFromContent('not json at all').review.parseError, true)
  assert.equal(reviewFromContent('not json at all').review.score, null)
  const ok = reviewFromContent('{"score":90,"issues":[],"better":"B","praise":"好","lowScoreHint":""}')
  assert.equal(ok.review.score, 90)
  assert.equal(ok.review.parseError, undefined)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/services/ai/speak.test.cjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `buildReviewPrompt` / `parseReview` / `reviewFromContent`** 在 `server/services/ai/speak.cjs`

system 用中文描述规则与 JSON 结构（字段：`score/issues[type,location,problem,suggestion,better]/better/praise/lowScoreHint`）；user 拼 `中文句子：`/`参考答案：`/`学习者说的英文：` 三段 + 结构要求。`parseReview` 按上面归一化规则写。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/services/ai/speak.test.cjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/services/ai/speak.cjs server/services/ai/speak.test.cjs
git commit -m "feat(speak): AI 评分 prompt + 解析/归一化服务"
```

---

### Task 3: 评分路由 `server/routes/speak.cjs` + 挂载

**Files:**
- Create: `server/routes/speak.cjs`
- Modify: `server/index.cjs`
- Test: `server/routes/speak.test.cjs`

**Interfaces:**
- Consumes: `speak.cjs` 的 `buildReviewPrompt`/`reviewFromContent`；`provider.cjs` 的 `chat`/`isConfigured`；`auth.cjs` 的 `authMiddleware`
- Produces: `module.exports = { router }`；`POST /review`（挂到 `/api/speak`）。

路由行为：`authMiddleware`；`cn`/`en`/`userText` 任一 `String(x).trim()` 为空 → 400；`!isConfigured()` → 503 `{error:'AI 未配置（AI_API_KEY 为空）'}`；`const prompt = buildReviewPrompt({cn,en,userText}); const content = await chat([{role:'system',content:prompt.system},{role:'user',content:prompt.user}], { temperature:0.3, maxTokens:800, timeoutMs:30000 })` 成功 → `res.json({ review: reviewFromContent(content).review })`；`chat` 抛错 → 503 `{error:'AI 服务暂不可用，请稍后重试'}`。

- [ ] **Step 1: 写失败测试**

```js
// server/routes/speak.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
// 测试封闭：清除 AI env（provider 模块加载时捕获 env），保证走「未配置」分支
delete process.env.AI_API_KEY
delete process.env.AI_BASE_URL
delete process.env.AI_MODEL

const express = require('express')
const { signToken } = require('../auth.cjs')
const speakRoutes = require('./speak.cjs')
const app = express()
app.use(express.json())
app.use('/api/speak', speakRoutes.router)

const { before, after } = require('node:test')
let server, baseUrl
before(async () => {
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

const headers = (token) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) })
const valid = { cn: '我们办理了入住。', en: 'We checked in.', userText: 'We check in.' }

test('游客 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers(), body: JSON.stringify(valid) })
  assert.equal(res.status, 401)
})
test('无效 token → 401', async () => {
  const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers('bad.token.x'), body: JSON.stringify(valid) })
  assert.equal(res.status, 401)
})
test('缺 cn/en/userText → 400', async () => {
  const tok = signToken(7)
  for (const body of [{ en: 'a', userText: 'b' }, { cn: 'a', userText: 'b' }, { cn: 'a', en: 'b' }, { cn: '', en: 'b', userText: 'c' }]) {
    const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers(tok), body: JSON.stringify(body) })
    assert.equal(res.status, 400)
  }
})
test('未配置 AI key → 503', async () => {
  const res = await fetch(`${baseUrl}/api/speak/review`, { method: 'POST', headers: headers(signToken(7)), body: JSON.stringify(valid) })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /AI 未配置/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/routes/speak.test.cjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/routes/speak.cjs`**

按上面路由行为写 `router.post('/review', authMiddleware, async (req,res)=>{...})`，外层 try/catch 兜底 500。

- [ ] **Step 4: 挂载到 `server/index.cjs`**

在 `const practiceRoutes = require('./routes/practice.cjs')` 附近加 `const speakRoutes = require('./routes/speak.cjs')`，并在 `app.use('/api/practice', practiceRoutes)` 附近加 `app.use('/api/speak', speakRoutes.router)`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test server/routes/speak.test.cjs`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/routes/speak.cjs server/routes/speak.test.cjs server/index.cjs
git commit -m "feat(speak): 新增 POST /api/speak/review 评分端点"
```

---

### Task 4: practiceRecords / practice.cjs 增加 `speak` 任务

**Files:**
- Modify: `src/utils/practiceRecords.js`
- Modify: `src/utils/practiceRecords.test.js`
- Modify: `server/routes/practice.cjs`
- Modify: `server/routes/practice.test.cjs`

**Interfaces:**
- Consumes: 现有 practice 存储（sql.js `practice_records` 表 / localStorage）
- Produces: `PRACTICE_TASKS`（客户端）与 `TASKS`（服务端）均为 `['shadow','cloze','translate','speak']`；`emptyPracticeData()`/`emptyData()` 增加 `speak: []`；`/api/practice/summary` 返回对象增加 `speak` 计数。

- [ ] **Step 1: 改断言为失败（先改测试）**

`src/utils/practiceRecords.test.js`：
- `'任务与常量一致'` 改为 `assert.deepEqual(PRACTICE_TASKS, ['shadow','cloze','translate','speak'])`
- 新增：`assert.deepEqual(emptyPracticeData(), { shadow:[], cloze:[], translate:[], speak:[] })`；`assert.deepEqual(addIndex(emptyPracticeData(), 'speak', 2).speak, [2])`

`server/routes/practice.test.cjs`：
- `'无记录 GET 返回空数组'` 的断言改为 `{ shadow:[], cloze:[], translate:[], speak:[] }`
- `'summary 返回各视频三项计数'` 改为四项：`assert.deepEqual(body.summary.v3, { shadow:2, cloze:0, translate:1, speak:0 })`
- `'损坏 JSON 容错为空'` 断言改为 `{ shadow:[], cloze:[], translate:[], speak:[] }`
- 新增测试：`POST {task:'speak', index:1}` 后 GET `data.speak` 为 `[1]`；`summary` 里 `speak:1`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/practiceRecords.test.js server/routes/practice.test.cjs`
Expected: FAIL（TASKS 不含 speak）

- [ ] **Step 3: 改实现**

`src/utils/practiceRecords.js`：`PRACTICE_TASKS` 加 `'speak'`；`emptyPracticeData()` 加 `speak: []`。
`server/routes/practice.cjs`：`TASKS` 加 `'speak'`；`emptyData()` 加 `speak: []`；`summary` 的映射对象加 `speak: data.speak.length`。（`parseData` 已按 `TASKS` 遍历，无需改。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/practiceRecords.test.js server/routes/practice.test.cjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/practiceRecords.js src/utils/practiceRecords.test.js server/routes/practice.cjs server/routes/practice.test.cjs
git commit -m "feat(speak): practiceRecords 增加 speak 任务（跨设备已练标记）"
```

---

### Task 5: 预提取脚本 `scripts/build-speak-prompts.mjs`

**Files:**
- Create: `scripts/build-speak-prompts.mjs`
- Modify: `package.json`（scripts 加一项）

**Interfaces:**
- Consumes: `speakPrompts.js` 的 `filterSubtitlesToPrompts`/`buildSpeakPromptsData`；`provider.cjs` 的 `chat`/`extractJson`/`isConfigured`/`AI_MODEL`；`server/lib/dataDir.cjs` 的 `resolveDataDir`
- Produces: CLI `npm run speak-prompts [-- --force|--video <id>|--dry]`，写 `data/videos/<episode_dir>/speak-prompts.json`

脚本流程（对齐 `build-wordcards.mjs`）：读 `.env`（靠 `--env-file-if-exists`）；对每个 episode 目录：读 `subtitles.json` → `filterSubtitlesToPrompts(subs, { maxPrompts: 40 })`；读 `info.json` 取 `id`/`title`（回退 `epDir`）；若 `isConfigured()` 则调一次 AI（中文 system：按视频标题/场景生成 ≤5 条日常口语扩展句，输出 `{"sentences":[{"cn":"","en":""}]}`，重试 3 次）得到 `extensionPrompts`，否则空数组；`buildSpeakPromptsData(...)` 组装并写文件（`--dry` 只打印）。已存在且非 `--force` 跳过。

- [ ] **Step 1: 添加 npm script**

`package.json` scripts 加：`"speak-prompts": "node --env-file-if-exists=.env scripts/build-speak-prompts.mjs"`

- [ ] **Step 2: 实现脚本**

按上面流程写；复用 `build-wordcards.mjs` 的 `createRequire`/`listEpisodes`/`readJson`/`generateJsonWithRetry` 模式（可复制精简版）。

- [ ] **Step 3: 冒烟验证（本地无 data/ 时优雅退出）**

Run: `node scripts/build-speak-prompts.mjs --dry`
Expected: 打印 `[speak-prompts] 未找到视频目录：…` 或对每个 episode 打印 dry 结果；exit 0，不抛错。

- [ ] **Step 4: lint**

Run: `npx eslint scripts/build-speak-prompts.mjs`
Expected: 无 error

- [ ] **Step 5: 提交**

```bash
git add scripts/build-speak-prompts.mjs package.json
git commit -m "feat(speak): 新增 build-speak-prompts 预提取脚本"
```

---

### Task 6: 练习页 `src/pages/SpeakPracticePage.jsx` + 路由 + 样式

**Files:**
- Create: `src/pages/SpeakPracticePage.jsx`
- Modify: `src/main.jsx`（注册 `/video/:id/speak`）
- Modify: `src/index.css`（追加 `.speak-*` 样式，若 Tailwind 类不够用）

**Interfaces:**
- Consumes: `useAuth`（`authFetch`/`isGuest`）、`createAsrSpeechInput(authFetch)`/`createSpeechInput()`、`filterSubtitlesToPrompts`、`practiceRecords` 的 `loadOne(authFetch, isGuest, videoId)`/`mark(authFetch, isGuest, videoId, task, index)`/`firstUnpracticedIndex(practicedSet, total)`、`POST /api/speak/review`
- Produces: 页面组件（默认导出），路由路径 `/video/:id/speak`

组件要点（对齐 ConversationPage 的结构与语音链）：
- 加载：fetch `/data/consolidated.json` → 找到视频 → fetch `/data/videos/<episode_dir>/speak-prompts.json`；404/失败时 fetch `/data/videos/<episode_dir>/subtitles.json` + `filterSubtitlesToPrompts` 本地降级；两者皆空 → 空态「该视频暂无可练习的句子」+ 返回。
- 语音：进入时探活——先 `createAsrSpeechInput(authFetch)`（`/asr/status` 预检），失败则 `createSpeechInput()`（Web Speech），再失败则打字输入；`speechSource` 状态 `'aliyun'|'web'|'none'`，识别文本进可编辑输入框。
- 状态：`prompts`、`idx`、`userText`、`listening`、`speechSource`、`review`、`reviewing`、`error`、`aiUnavailable`、`practiced`（Set，加载自 `loadOne(authFetch, isGuest, videoId).speak` 数组，续练用 `firstUnpracticedIndex(new Set(practiced), prompts.length)`）。
- 解析：`userText.trim()` 非空才可点；`POST /api/speak/review { cn, en, userText }` → `setReview`；401 → 跳登录；503 → 提示、保留文本可重试；`review.parseError` → 提示「评分解析失败，请重试」；成功后 `mark(authFetch, isGuest, videoId, 'speak', idx)` 更新 `practiced`。
- 渲染：按 spec 第 5 节布局（中文大字居中、≥48px 录音按钮、解析结果卡片：分数绿/黄/红着色、你说/参考答案/问题列表/更地道/praise/低分提示、底部上一句/重说/下一句 + 「第 x/N 句」）。参考答案 `en` 解析前不渲染。
- 游客守卫：`isGuest` → `navigate('/login', { state: { from: '/video/'+id+'/speak' } })`。

- [ ] **Step 1: 注册路由**

`src/main.jsx`：`import SpeakPracticePage from './pages/SpeakPracticePage'`；在 conversation 路由旁加 `<Route path="video/:id/speak" element={<SpeakPracticePage />} />`。

- [ ] **Step 2: 实现页面**

按上面要点写组件（含空态、fallback、语音兜底、可编辑输入、解析结果渲染、导航/重说）。

- [ ] **Step 3: 样式**

`src/index.css` 追加页面所需样式；优先 Tailwind 工具类，仅补布局/着色缺口。

- [ ] **Step 4: lint + build**

Run: `npm run lint` → 无新增 error
Run: `npm run build` → 成功

- [ ] **Step 5: 提交**

```bash
git add src/pages/SpeakPracticePage.jsx src/main.jsx src/index.css
git commit -m "feat(speak): 自由表达练习页 + 路由 + 样式"
```

---

### Task 7: 入口菜单 `src/pages/VideoDetail.jsx`

**Files:**
- Modify: `src/pages/VideoDetail.jsx`

**Interfaces:**
- Consumes: 现有 `navigate`/`isGuest`；新增路由 `/video/:id/speak`
- Produces: 两处「AI 对话」按钮（移动端 header 图标按钮、桌面端「💬 AI 对话」文字按钮）点后弹二选一菜单

要点：新增 `const [showSpeakMenu, setShowSpeakMenu] = useState(false)`；两处按钮 `onClick`：游客 → 仍 `navigate('/login', { state: { from: '/video/'+id+'/conversation' } })`；登录 → `setShowSpeakMenu(!showSpeakMenu)`。弹出小菜单（绝对定位，复用项目既有 popover 样式类）：「💬 多轮对话」→ `/video/:id/conversation`；「🗣 自由表达 · 看中文说英文」→ `/video/:id/speak`；点外部关闭。

- [ ] **Step 1: 实现入口菜单**

改两处按钮 + 加菜单 JSX（桌面/移动共用同一菜单状态与渲染）。

- [ ] **Step 2: lint + build**

Run: `npm run lint` → 无新增 error
Run: `npm run build` → 成功

- [ ] **Step 3: 提交**

```bash
git add src/pages/VideoDetail.jsx
git commit -m "feat(speak): 视频详情页 AI 对话按钮改为二选一菜单"
```

---

### Task 8: 文档 + 全量验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 文档**

README 增补：功能概览加「🎙️ 自由表达（看中文说英文）」一节（玩法、入口、`npm run speak-prompts` 预生成、评分口径）；页面路由表加 `/video/:id/speak`；脚本列表加 `build-speak-prompts.mjs`。

- [ ] **Step 2: 全量单测**

Run: `node --test src/utils server/routes server/services server/lib scripts`
Expected: 全部 PASS（含既有测试无回归）

- [ ] **Step 3: lint + build**

Run: `npm run lint` → 无新增 error
Run: `npm run build` → 成功

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs(speak): README 增补自由表达功能说明"
```

---

## 完成定义（对照 spec 第 8 节）

1. `npm run speak-prompts` 生成 `speak-prompts.json`（本地过滤 + AI ≤5 扩展句；无 key 时纯字幕句也能生成）→ Task 5
2. 视频详情页点「AI 对话」→ 弹「多轮对话 / 自由表达」菜单 → Task 7
3. 游客点入口 → 登录引导；`/api/speak/review` 游客 401 → Task 3 / 6 / 7
4. 看中文 → 录音（阿里云 ASR / Web Speech / 打字）→ 可编辑 → 解析 → 分数+问题+更地道+参考答案+praise+低分提示 → Task 6
5. 允许重复说（解析前重录、解析后「重说」）→ Task 6
6. 参考答案解析前隐藏 → Task 6
7. `speak-prompts.json` 缺失时本地降级 + 空态 → Task 6
8. 无 AI key / AI 失败 → 明确提示、不伪造分数 → Task 2 / 3
9. 桌面 + 手机端一致（响应式单页、≥48px 按钮、无 hover 依赖、无横向滚动）→ Task 6
10. 已练句跨设备记录（`speak` 任务）；learningStatus 三项不变 → Task 4
11. 现有功能零退化；lint/build/单测通过 → Task 8
