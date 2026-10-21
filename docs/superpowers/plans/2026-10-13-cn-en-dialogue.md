# 中译英口语对话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在视频页 AI 对话入口下新增「中译英对话」练习：AI 按视频一次性生成一组连贯中文对话并持久化，用户逐句口头翻译成英文，单句评估、错误重试、断点续练与完成总结。

**Architecture:** 后端新增 `dialogue_scripts`（按 `user+video+difficulty+variant` 存整组剧本）与 `dialogue_progress`（游标 + 逐句答题记录）；AI 层拆成「整组生成」与「单句评估」两条独立 prompt，评估复用 `speak.cjs` 的分数容错；前端新增独立页面 `/video/:id/dialogue`，ASR/TTS 复用现有封装。

**Tech Stack:** React 19 + Vite + Tailwind v4（前端）、Express 5 CJS + sql.js（后端）、Node 22 原生 `node:test`（测试）、零新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-10-13-cn-en-dialogue-design.md`

## Global Constraints

- 零新增 npm 依赖；服务端一律 CJS（`require`/`module.exports`），`src/` 一律 ESM。
- 测试用 `node --test <file>`，**绝不允许**真实调用 AI：AI 路径测试必须 stub `global.fetch`（参照 `server/routes/conversation-ai.test.cjs`）。
- 所有后端接口走 `authMiddleware`；游客 401。AI 未配置 → 503，**不伪造任何剧本或分数**。
- 入库难度值固定为 `easy | daily | advanced`；中文标签 简单 / 日常 / 进阶。
- 剧本有效句下限 5，上限 20；重新生成 = 同 `(user, video, difficulty)` 的 `variant + 1`，旧行与旧进度绝不删除、不改写。
- 提交信息用中文 `feat:` / `test:` / `docs:` 前缀；一次提交只含本任务文件。
- 不改动 `src/pages/SpeakPracticePage.jsx`、`src/pages/ConversationPage.jsx`、`server/services/ai/speak.cjs`、`speak-prompts.json`。
- UI 文案中文；移动端按钮 ≥44px、无横向滚动、不依赖 hover、录音失败必须有手打兜底。

## Review Focus

1. **AI 生成的句子数量越界或重复**（>20 / <5 / 同一句重复出现）→ 必须不落盘并返回明确错误，而不是只练 3 句或重复练同一句。
2. **无字幕视频**（`subtitles.json` 缺失或为空）→ 生成仍应成功，`script.source === 'video-info'`，且 prompt 不得让模型编造视频情节。
3. **AI 返回非 JSON / 断网 / 超时** → `/generate` 不产生半成品行，`/evaluate` 不返回假分数，前端保留用户已说内容可重试。
4. **同一视频同难度并发生成**（同一用户快速点两次「重新生成」）→ `variant` 冲突不得 500，也不得吞掉已存剧本。
5. **切难度 / 重新进入** → 必须加载该难度下 `variant` 最大的剧本及其进度，不能把 easy 的进度串到 advanced 上。
6. **语音识别失败或被拒权限** → 用户仍能用手打完成整组练习；识别为空不得自动评分。

---

### Task 1: 两张持久化表

**Files:**
- Modify: `server/db.cjs`（`initSchema()` 内，`ai_cache` 之后）
- Test: `server/db.test.cjs`

**Interfaces:**
- Produces: 表 `dialogue_scripts(id, user_id, video_id, difficulty, variant, script_json, model, created_at)` 与 `dialogue_progress(id, script_id, user_id, cursor, answers_json, status, created_at, updated_at)`，唯一约束 `UNIQUE(user_id, video_id, difficulty, variant)` 与 `UNIQUE(script_id)`。

- [ ] **Step 1: 写失败测试**

在 `server/db.test.cjs` 追加（沿用文件顶部已有的临时库设置）：

```js
test('dialogue_scripts / dialogue_progress 存在且唯一约束生效', async () => {
  await db.getDb()
  const names = db.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name)
  assert.ok(names.includes('dialogue_scripts'))
  assert.ok(names.includes('dialogue_progress'))

  const s = db.run(
    'INSERT INTO dialogue_scripts (user_id, video_id, difficulty, variant, script_json) VALUES (?,?,?,?,?)',
    [1, 'video-a', 'daily', 1, '{"lines":[]}']
  )
  assert.equal(db.get('SELECT difficulty FROM dialogue_scripts WHERE id=?', [s.lastInsertRowid]).difficulty, 'daily')
  assert.throws(() => db.run(
    'INSERT INTO dialogue_scripts (user_id, video_id, difficulty, variant, script_json) VALUES (?,?,?,?,?)',
    [1, 'video-a', 'daily', 1, '{}']), /UNIQUE/)

  const p = db.run('INSERT INTO dialogue_progress (script_id, user_id) VALUES (?,?)', [s.lastInsertRowid, 1])
  assert.equal(db.get('SELECT cursor FROM dialogue_progress WHERE id=?', [p.lastInsertRowid]).cursor, 0)
  assert.throws(() => db.run('INSERT INTO dialogue_progress (script_id, user_id) VALUES (?,?)',
    [s.lastInsertRowid, 1]), /UNIQUE/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/db.test.cjs`
Expected: FAIL —`dialogue_scripts` 不在 `names` 里（`assert.ok` 失败）。

- [ ] **Step 3: 加表**

在 `initSchema()` 中新增（照抄 Spec 第 3 节 DDL，全部 `CREATE TABLE IF NOT EXISTS`）：`dialogue_scripts`、`dialogue_progress`。`answers_json` 用 `TEXT NOT NULL DEFAULT '[]'`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/db.test.cjs`
Expected: 全部 PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add server/db.cjs server/db.test.cjs
git commit -m "feat: 中译英对话剧本与进度表"
```

---

### Task 2: AI 纯函数层（生成 prompt + 单句评估 prompt + 归一化）

**Files:**
- Create: `server/services/ai/dialogue.cjs`
- Test: `server/services/ai/dialogue.test.cjs`

**Interfaces:**
- Consumes: `parseReview` from `./speak.cjs`（返回 `{score, issues, better, praise, lowScoreHint}`）。
- Produces（后续任务按这些签名调用）：
  - `DIFFICULTIES = ['easy','daily','advanced']`
  - `DIFFICULTY_LABELS = { easy:'简单', daily:'日常', advanced:'进阶' }`
  - `MIN_LINES = 5`, `MAX_LINES = 20`
  - `normalizeDifficulty(value) -> 'easy'|'daily'|'advanced'|null`
  - `difficultyOf(videoLevel) -> 'easy'|'daily'|'advanced'`（初级→easy，中级→daily，高级→advanced，其余→daily）
  - `buildScriptPrompt({ videoTitle, description, videoLevel, difficulty, segments, scene }) -> { system, user }`
  - `normalizeDialogueScript(raw, { difficulty, hasSubtitles }) -> { ok:true, script } | { ok:false, reason }`
    ，`script = { version, difficulty, title, scene, settingCn, userRole, otherRole, source:'subtitle'|'video-info', lines }`
    ，`lines[i] = { index, speaker:'user'|'other', speakerCn, cn, en, alternatives:string[], keyPoints:string[] }`
  - `buildLineReviewPrompt({ line, contextLines, difficulty, userText, attempt }) -> { system, user }`
  - `normalizeLineReview(raw, { attempt }) -> { verdict:'correct'|'minor'|'wrong', score:number|null, issues, better, praise, hint, answerHidden:boolean }`

- [ ] **Step 1: 写失败测试**

`server/services/ai/dialogue.test.cjs`：

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DIFFICULTIES, DIFFICULTY_LABELS, MIN_LINES, MAX_LINES,
  normalizeDifficulty, difficultyOf,
  buildScriptPrompt, normalizeDialogueScript,
  buildLineReviewPrompt, normalizeLineReview,
} = require('./dialogue.cjs')

const line = (n, extra = {}) => ({
  speaker: 'user', cn: `第${n}句中文`, en: `This is sentence number ${n}`,
  alternatives: ['a'], keyPoints: ['k'], ...extra,
})

test('难度枚举与视频等级映射', () => {
  assert.deepEqual(DIFFICULTIES, ['easy', 'daily', 'advanced'])
  assert.equal(DIFFICULTY_LABELS.advanced, '进阶')
  assert.equal(normalizeDifficulty('daily'), 'daily')
  assert.equal(normalizeDifficulty('中等'), null)
  assert.equal(difficultyOf('初级'), 'easy')
  assert.equal(difficultyOf('中级'), 'daily')
  assert.equal(difficultyOf('高级'), 'advanced')
  assert.equal(difficultyOf(undefined), 'daily')
})

test('生成 prompt 带上字幕、难度与人物关系要求', () => {
  const p = buildScriptPrompt({
    videoTitle: '出国旅行的日常', description: '机场与酒店', videoLevel: '中级',
    difficulty: 'daily',
    segments: [{ textEn: "we've just checked in", textCn: '我们刚办好入住' }],
    scene: { scene: 'Hotel Check-in', userRole: '客人', aiRole: '前台接待' },
  })
  assert.ok(p.user.includes('出国旅行的日常'))
  assert.ok(p.user.includes('我们刚办好入住'))
  assert.ok(p.user.includes('日常'))
  assert.ok(p.user.includes('前台接待'))
  assert.ok(p.system.includes('8'))
  assert.ok(p.system.includes('20'))
})

test('无字幕时 prompt 禁止编造视频内容并声明信息不足', () => {
  const p = buildScriptPrompt({ videoTitle: 'X', description: '', videoLevel: null, difficulty: 'easy', segments: [], scene: null })
  assert.ok(p.user.includes('没有字幕'))
  assert.ok(p.user.includes('不要编造'))
})

test('normalizeDialogueScript 去重、编号、截断到 20 并标记来源', () => {
  const raw = { title: '酒店入住', scene: 'Hotel', lines: Array.from({ length: 25 }, (_, i) => line(i + 1)) }
  raw.lines.push(line(1)) // 重复句
  const r = normalizeDialogueScript(raw, { difficulty: 'daily', hasSubtitles: true })
  assert.equal(r.ok, true)
  assert.equal(r.script.lines.length, MAX_LINES)
  assert.equal(r.script.lines[0].index, 0)
  assert.equal(r.script.lines[MAX_LINES - 1].index, MAX_LINES - 1)
  assert.equal(r.script.source, 'subtitle')
  assert.equal(r.script.difficulty, 'daily')
  assert.equal(new Set(r.script.lines.map(l => l.cn)).size, MAX_LINES)
})

test('normalizeDialogueScript 丢弃非法句，不足 5 句判不合格', () => {
  const bad = { lines: [{ cn: '只有中文' }, { cn: '', en: 'x y' }, line(1), line(2), line(3), line(4)] }
  assert.equal(normalizeDialogueScript(bad, { difficulty: 'easy', hasSubtitles: false }).ok, false)
  const ok = normalizeDialogueScript({ lines: Array.from({ length: MIN_LINES }, (_, i) => line(i + 1)) },
    { difficulty: 'easy', hasSubtitles: false })
  assert.equal(ok.ok, true)
  assert.equal(ok.script.source, 'video-info')
  assert.equal(ok.script.lines[0].speaker, 'user')
})

test('normalizeDialogueScript 对畸形输入不抛错', () => {
  for (const v of [null, undefined, 'x', 42, { lines: 'nope' }]) {
    const r = normalizeDialogueScript(v, { difficulty: 'daily', hasSubtitles: true })
    assert.equal(r.ok, false)
    assert.ok(r.reason.length > 0)
  }
})

test('单句评分 prompt 带上下文、可接受表达与重试次数', () => {
  const p = buildLineReviewPrompt({
    line: { cn: '我刚办好入住。', en: "I've just checked in.", alternatives: ['I just checked in.'], keyPoints: ['现在完成时'] },
    contextLines: [{ speakerCn: '前台', cn: '您好，请问有预订吗？' }],
    difficulty: 'daily', userText: 'I check in just now', attempt: 2,
  })
  assert.ok(p.user.includes('我刚办好入住。'))
  assert.ok(p.user.includes("I've just checked in."))
  assert.ok(p.user.includes('I just checked in.'))
  assert.ok(p.user.includes('您好，请问有预订吗？'))
  assert.ok(p.user.includes('I check in just now'))
  assert.ok(p.user.includes('2'))
  assert.ok(p.system.includes('不是唯一'))
  assert.ok(p.system.includes('verdict'))
})

test('normalizeLineReview：verdict 归一 + 分数钳制', () => {
  assert.equal(normalizeLineReview({ verdict: 'correct', score: 92 }, { attempt: 1 }).verdict, 'correct')
  assert.equal(normalizeLineReview({ score: 85 }, { attempt: 1 }).verdict, 'correct')
  assert.equal(normalizeLineReview({ score: 70 }, { attempt: 1 }).verdict, 'minor')
  assert.equal(normalizeLineReview({ score: 40 }, { attempt: 1 }).verdict, 'wrong')
  assert.equal(normalizeLineReview({ score: 999, verdict: 'correct' }, { attempt: 1 }).score, 100)
  assert.equal(normalizeLineReview({}, { attempt: 1 }).score, null)
})

test('normalizeLineReview：wrong 且首次作答 → 隐藏英文答案并给中文提示', () => {
  const r = normalizeLineReview({
    verdict: 'wrong', score: 45, hint: '注意时态', better: 'I have just checked in.',
    issues: [{ type: 'grammar', location: 'check in', problem: '时态', suggestion: '用完成时', better: 'checked in' }],
    praise: '',
  }, { attempt: 1 })
  assert.equal(r.answerHidden, true)
  assert.equal(r.better, '')
  assert.equal(r.issues[0].better, '')
  assert.equal(r.issues[0].problem, '时态')
  assert.equal(r.hint, '注意时态')
})

test('normalizeLineReview：第二次或非 wrong → 不隐藏答案', () => {
  const wrong2 = normalizeLineReview({ verdict: 'wrong', better: 'B', hint: 'h' }, { attempt: 2 })
  assert.equal(wrong2.answerHidden, false)
  assert.equal(wrong2.better, 'B')
  const minor = normalizeLineReview({ verdict: 'minor', score: 72, better: 'B2' }, { attempt: 1 })
  assert.equal(minor.answerHidden, false)
  assert.equal(minor.better, 'B2')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/services/ai/dialogue.test.cjs`
Expected: FAIL — `Cannot find module './dialogue.cjs'`。

- [ ] **Step 3: 实现 `server/services/ai/dialogue.cjs`**

要点（不含完整代码）：
- `SYSTEM_SCRIPT`：要求「一整段连贯对话」「8–15 句、最多 20」「每句都是用户可以用英文说出口的完整中文句」「给出 speaker/user|other 与 speakerCn」「en 为参考英文、alternatives 1–2 条可接受说法、keyPoints 0–2 条中文纠错要点」「只输出 JSON，不要 Markdown」；并写明三档难度对应的句长与从句数量（Spec 2.5）。**无字幕分支**必须出现「没有字幕」与「不要编造」。
- `buildScriptPrompt`：user 段依次包含视频标题、简介（可空）、视频等级、目标难度中文标签、场景档案（可空，取 `scene.scene/userRole/aiRole`）、字幕段落（`1. EN || CN` 逐行，最多 120 行，超出截断并注明），最后是 JSON 结构说明。
- `normalizeDialogueScript`：按 Spec 5.1 规则实现——`cn` 含中日韩字符、`en` 含字母且 ≥2 词、按去标点后的 `cn` 去重、`speaker` 非法回落 `'user'`、`alternatives`/`keyPoints` 截断 2 条、超过 `MAX_LINES` 立即 break、`< MIN_LINES` 返回 `{ok:false, reason}`、任何畸形输入走 `{ok:false}` 而非 throw；`source` 由 `hasSubtitles` 决定。
- `SYSTEM_REVIEW`：复用 `speak.cjs` 的评分口径（「参考答案只是其中一种正确说法」、`issues` 五类、区分语义/语法错误与「不地道」），额外要求输出 `verdict`（`correct|minor|wrong`）与 `hint`（`wrong` 时给中文提示，**不得含英文答案**）。
- `buildLineReviewPrompt`：user 段包含目标难度、上下文逐行（`speakerCn：cn`）、当前中文、参考英文、可接受说法、纠错要点、学习者英文、`第 ${attempt} 次作答`。
- `normalizeLineReview`：先 `parseReview(raw)` 拿容错后的 `{score, issues, better, praise, lowScoreHint}`；`verdict` 合法则用，否则按分数推断（≥80 correct / ≥60 minor / 其余 wrong，`score===null` → wrong）；`wrong && attempt < 2` 时把 `better` 与每个 `issues[].better` 清空、`answerHidden=true`、`hint = raw.hint || lowScoreHint`；否则 `answerHidden=false`、`hint = raw.hint`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/services/ai/dialogue.test.cjs`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add server/services/ai/dialogue.cjs server/services/ai/dialogue.test.cjs
git commit -m "feat: 中译英对话生成与单句评估 AI 层"
```

---

### Task 3: 视频数据读取抽取 + `/api/dialogue` 五个端点

**Files:**
- Create: `server/lib/videoData.cjs`
- Create: `server/routes/dialogue.cjs`
- Create: `server/routes/dialogue.test.cjs`
- Modify: `server/routes/conversation.cjs`（把 `loadVideoIndex/loadSubtitles/findVideo` 换成 import，行为不变）
- Modify: `server/index.cjs`（挂载 `/api/dialogue`）

**Interfaces:**
- Consumes: Task 1 的表；Task 2 的 `normalizeDifficulty`、`difficultyOf`、`buildScriptPrompt`、`normalizeDialogueScript`、`buildLineReviewPrompt`、`normalizeLineReview`。
- Produces:
  - `server/lib/videoData.cjs` -> `{ loadVideoIndex(), loadSubtitles(episodeDir), findVideo(videoId), resolveDataDirPath() }`（读 `SHADOW_VOICE_DATA_DIR`，默认 `data/`，带 mtime 缓存）
  - `server/routes/dialogue.cjs` -> `{ router }`，端点与响应形状：
    - `GET /api/dialogue/:videoId?difficulty=daily` -> `{ difficulty, aiConfigured, available:string[], script:Script|null, progress:Progress|null }`
    - `POST /api/dialogue/:videoId/generate` `{difficulty}` -> 201 `{ script, progress }`
    - `POST /api/dialogue/:scriptId/evaluate` `{index, userText}` -> `{ review, attempts, progress }`
    - `PUT /api/dialogue/:scriptId/progress` `{cursor, status?}` -> `{ progress }`
    - `POST /api/dialogue/:scriptId/restart` -> `{ progress }`
    - `Script` = Task 2 的 script；`Progress = { scriptId, cursor, status, answers:Answer[], updatedAt }`，`Answer = { index, attempts, userText, score, verdict, issues, better, praise, revealedAnswer }`

- [ ] **Step 1: 写失败测试**

`server/routes/dialogue.test.cjs`（结构照 `conversation-ai.test.cjs`：临时库 + 临时 data 目录 + `app.listen(0)` + `signToken`）：

前置：
```js
process.env.AI_API_KEY = 'test-key-for-unit-tests'
process.env.AI_BASE_URL = 'https://mock.invalid/v1'
process.env.AI_MODEL = 'mock-model'
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')
// data 目录写 consolidated.json：v1(中级,有字幕) / v2(初级,无字幕文件) / v3(高级,字幕为空数组)
```
stub `global.fetch`：只拦 `/chat/completions`，按 `messages[0].content` 判断——
- 含 `中译英对话脚本` → 返回 `{title:'酒店入住', scene:'Hotel', settingCn:'前台', userRole:'客人', otherRole:'前台', lines:[12 条]}`（每句 `cn:"第N句"`,`en:"Sentence number N"`）；
- 含 `verdict` 且含 `学习者` → 返回 `{verdict:'wrong', score:45, hint:'注意时态', better:'I have just checked in.', issues:[{type:'grammar',location:'x',problem:'时态',suggestion:'用完成时',better:'checked in'}]}`；
- 用变量 `scriptMode` 控制 `'ok' | 'bad-json' | 'too-few' | 'fail'`。

用例（每条独立 `user_id` 或重置表，避免串数据）：
```js
test('游客 / 无效 token → 401')
test('GET 无脚本 → script:null 且 aiConfigured:true')
test('generate 落库 variant=1 并建进度行（source=subtitle）')
test('再次 generate → variant=2，旧行仍在，GET 返回 variant=2')
test('难度隔离：easy 生成的脚本不出现在 daily 的 GET 里')
test('模拟 variant 并发冲突：库里已有 variant=2 时 generate 得到 variant=3 且不 500')
test('无字幕视频生成 → script.source === "video-info"')
test('生成结果不足 5 句 → 503 且不落盘')
test('AI 连续非法 JSON → 503 且不落盘')
test('无 AI key → generate 503，GET 返回 aiConfigured:false')
test('evaluate 首次 wrong → review.answerHidden 且 better 为空，落库 attempts=1')
test('evaluate 第二次 → answerHidden=false 且 better 有值，attempts=2')
test('evaluate index 越界 → 400')
test('evaluate userText 为空（识别失败路径）→ 400 且不写库')
test('PUT progress 推进游标；cursor 到尾部自动 completed')
test('restart 清空 answers 且 cursor=0')
test('跨用户访问他人 script → 403')
```
（测试中用 `get('SELECT ...')` 直接断言库里的 `variant`、`answers_json`、`dialogue_progress.status`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/routes/dialogue.test.cjs`
Expected: FAIL — `Cannot find module './dialogue.cjs'`。

- [ ] **Step 3: 抽取视频数据读取 + 实现路由**

`server/lib/videoData.cjs`：把 `server/routes/conversation.cjs` 顶部三个函数原样搬过来（含 `indexCache`、`DATA_DIR`），再 `module.exports`。
`server/routes/conversation.cjs`：删掉这三个函数与 `fs/path` 引入（若不再使用），改为
`const { loadVideoIndex, loadSubtitles, findVideo } = require('../lib/videoData.cjs')`；跑一遍 `node --test server/routes/conversation.test.cjs server/routes/conversation-ai.test.cjs` 确认零回归。

`server/routes/dialogue.cjs` 要点：
- `requireOwnScript(req,res,scriptId)`：查 `dialogue_scripts`，不存在 404 `脚本不存在`，`user_id !== req.userId` 403 `无权访问该脚本`；返回行。
- `currentScript(userId, videoId, difficulty)`：`ORDER BY variant DESC LIMIT 1`。
- `ensureProgress(scriptRow)`：无进度行则插入 `(script_id, user_id, cursor=0, answers_json='[]', status='active')`；返回序列化后的 `Progress`（`answers` 从 JSON 解析，损坏时回落 `[]`）。
- `GET`：`await getDb()`；`difficulty = normalizeDifficulty(req.query.difficulty) || difficultyOf(video.level)`；`available` = 该 user+video 下 `GROUP BY difficulty` 的难度数组（按 easy/daily/advanced 排序）；未生成 → `script:null, progress:null`。
- `generate`：解析难度（缺省按视频等级）；字幕 = `loadSubtitles(video.episode_dir)` 过滤 `textEn` 非空，`segments` 取前 120 条 `{textEn, textCn}`；`scene` 从 `ai_cache` 只读（`prompt_version='scene-v1'`，`JSON.parse` 失败当无）；**最多 2 次** `chat(..., {temperature:0.8, maxTokens:3000, timeoutMs:60000})` + `extractJson` + `normalizeDialogueScript`，第 1 次不合格把原因追加给模型重试一次；两次都失败 → 503 `生成失败（AI 服务暂不可用），请重试`；成功后 `variant = (SELECT COALESCE(MAX(variant),0)+1 ...)` 插入，`UNIQUE` 冲突时重算 `variant` 重试一次（再不成功 503）；插入后 `ensureProgress` 并 201。
- `evaluate`：`index` 必须为 0..lines.length-1 的整数否则 400 `句子索引无效`；`userText` 去空白后为空 → 400 `缺少学习者说的英文`；读进度的 `answers`，`attempts = (prev?.attempts || 0) + 1`（**服务端权威，忽略客户端传值**，上限 20）；`contextLines` = 前 2 句 `{speakerCn, cn}`；调 `chat(..., {temperature:0.2, maxTokens:800, timeoutMs:30000})`，`normalizeLineReview(extractJson(content), {attempt})`；`extractJson` 抛错 → 返回 `{ score:null, verdict:'wrong', issues:[], better:'', praise:'', hint:'', answerHidden:true, parseError:true }`（**不写库**）并 200；正常时 upsert 该 index 的答案记录（`userText` 存原文）并 `UPDATE dialogue_progress SET answers_json=?, updated_at=datetime('now')`；返回 `{review, attempts, progress}`；AI 抛错 → 503 `评分失败，请稍后重试`。
- `PUT /:scriptId/progress`：`cursor` 非整数或 <0 或 > `lines.length` → 400；`status` 仅接受 `active|completed`，缺省时 `cursor >= lines.length ? 'completed' : 'active'`；更新并返回 `{progress}`。
- `POST /:scriptId/restart`：`cursor=0, answers_json='[]', status='active'`，返回 `{progress}`。
- 所有 handler 外层 `try/catch`，500 `{error:'服务器内部错误'}` + `console.error`。

`server/index.cjs`：`const dialogueRoutes = require('./routes/dialogue.cjs')` + `app.use('/api/dialogue', dialogueRoutes.router)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/routes/dialogue.test.cjs server/routes/conversation.test.cjs server/routes/conversation-ai.test.cjs`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add server/lib/videoData.cjs server/routes/dialogue.cjs server/routes/dialogue.test.cjs server/routes/conversation.cjs server/index.cjs
git commit -m "feat: 中译英对话 API 与视频数据读取复用"
```

---

### Task 4: 前端纯逻辑（进度 / 动作策略 / 完成总结）

**Files:**
- Create: `src/utils/dialoguePractice.js`
- Test: `src/utils/dialoguePractice.test.js`

**Interfaces:**
- Produces（页面按这些签名调用）：
  - `DIFFICULTIES = ['easy','daily','advanced']`
  - `DIFFICULTY_LABELS = { easy:'简单', daily:'日常', advanced:'进阶' }`
  - `difficultyFromVideoLevel(level) -> 'easy'|'daily'|'advanced'`
  - `progressLabel(cursor, total) -> string`（`0/12`，越界钳制）
  - `contextOf(lines, index) -> {speakerCn, cn}|null`（取前一句）
  - `primaryAction(review, attempts) -> 'retry'|'next'`（`verdict==='wrong' && attempts < 2` → retry）
  - `summarizeAnswers(answers, lines) -> { total, answered, averageScore, firstTryRate, topIssues:[{type,count}], reviewLines:[{index,cn,en,score}] }`

- [ ] **Step 1: 写失败测试**

`src/utils/dialoguePractice.test.js`：
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIFFICULTY_LABELS, difficultyFromVideoLevel, progressLabel, contextOf,
  primaryAction, summarizeAnswers,
} from './dialoguePractice.js'

const lines = [
  { index: 0, speakerCn: '前台', cn: '您好，请问有预订吗？', en: 'Do you have a reservation?' },
  { index: 1, speakerCn: '你', cn: '我刚办好入住。', en: "I've just checked in." },
  { index: 2, speakerCn: '前台', cn: '祝您入住愉快。', en: 'Enjoy your stay.' },
]

test('难度文案与视频等级映射', () => {
  assert.deepEqual(DIFFICULTY_LABELS, { easy: '简单', daily: '日常', advanced: '进阶' })
  assert.equal(difficultyFromVideoLevel('初级'), 'easy')
  assert.equal(difficultyFromVideoLevel('高级'), 'advanced')
  assert.equal(difficultyFromVideoLevel('中级'), 'daily')
  assert.equal(difficultyFromVideoLevel(null), 'daily')
})

test('progressLabel 显示当前句 / 总数并钳制越界', () => {
  assert.equal(progressLabel(2, 12), '3/12')
  assert.equal(progressLabel(0, 0), '0/0')
  assert.equal(progressLabel(99, 12), '12/12')
  assert.equal(progressLabel(-3, 12), '1/12')
})

test('contextOf 取前一句，第一句无上下文', () => {
  assert.equal(contextOf(lines, 0), null)
  assert.deepEqual(contextOf(lines, 1), { speakerCn: '前台', cn: '您好，请问有预订吗？' })
  assert.equal(contextOf(lines, 99), null)
  assert.equal(contextOf(null, 1), null)
})

test('primaryAction：wrong 且第一次 → retry；其余 → next', () => {
  assert.equal(primaryAction({ verdict: 'wrong', answerHidden: true }, 1), 'retry')
  assert.equal(primaryAction({ verdict: 'wrong', answerHidden: false }, 2), 'next')
  assert.equal(primaryAction({ verdict: 'minor', score: 72 }, 1), 'next')
  assert.equal(primaryAction({ verdict: 'correct', score: 95 }, 1), 'next')
  assert.equal(primaryAction(null, 0), 'next')
})

test('summarizeAnswers 聚合均分 / 一次通过率 / 高频错误 / 需复习', () => {
  const answers = [
    { index: 0, attempts: 1, score: 90, verdict: 'correct', issues: [] },
    { index: 1, attempts: 2, score: 60, verdict: 'wrong', issues: [{ type: 'grammar' }, { type: 'grammar' }] },
    { index: 2, attempts: 1, score: 78, verdict: 'minor', issues: [{ type: 'naturalness' }] },
  ]
  const s = summarizeAnswers(answers, lines)
  assert.equal(s.total, 3)
  assert.equal(s.answered, 3)
  assert.equal(s.averageScore, 76)
  assert.equal(s.firstTryRate, 33)              // 只有 index 0 是一次通过（>=80）
  assert.deepEqual(s.topIssues, [{ type: 'grammar', count: 2 }, { type: 'naturalness', count: 1 }])
  assert.deepEqual(s.reviewLines.map(r => r.index), [1, 2])
  assert.equal(s.reviewLines[0].en, "I've just checked in.")
})

test('summarizeAnswers 容忍空/畸形输入', () => {
  assert.deepEqual(summarizeAnswers(null, null),
    { total: 0, answered: 0, averageScore: null, firstTryRate: null, topIssues: [], reviewLines: [] })
  const s = summarizeAnswers([{ index: 0, attempts: 1, score: null }], lines)
  assert.equal(s.averageScore, null)
  assert.equal(s.answered, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/dialoguePractice.test.js`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/utils/dialoguePractice.js`**

要点：纯函数、无副作用、不抛错；`averageScore` 用 `Math.round(已评分句的 score 均值)`，无已评分句 → `null`；`firstTryRate` = `attempts===1 && score>=80` 的句数 / `total` 取整百分比，`total===0` → `null`；`reviewLines` 按 `index` 升序，条件 `score < 80 || attempts >= 2`，字段 `{index, cn, en, score}`；`topIssues` 按次数降序取前 3，次数相同按 type 字典序。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/dialoguePractice.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/utils/dialoguePractice.js src/utils/dialoguePractice.test.js
git commit -m "feat: 中译英对话前端进度与总结纯逻辑"
```

---

### Task 5: 语音输入 hook（阿里云 ASR → Web Speech → 手打兜底）

**Files:**
- Create: `src/utils/speechSource.js`
- Create: `src/utils/speechSource.test.js`
- Create: `src/utils/useSpeechInput.js`

**Interfaces:**
- Consumes: `createAsrSpeechInput(authFetch)` from `./aliyunAsr.js`、`createSpeechInput()` from `./recallSpeech.js`。
- Produces:
  - `selectSpeechSource({ configured, hasWebSpeech }) -> 'aliyun'|'web'|'none'`
  - `useSpeechInput(authFetch) -> { listening, error, source, start(onText), stop() }`
  - `start` 签名沿用现有：`start(onResult, onError, onEnd)`。

- [ ] **Step 1: 写失败测试**

`src/utils/speechSource.test.js`：
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSpeechSource } from './speechSource.js'

test('服务端 ASR 已配置 → aliyun', () => {
  assert.equal(selectSpeechSource({ configured: true, hasWebSpeech: true }), 'aliyun')
  assert.equal(selectSpeechSource({ configured: true, hasWebSpeech: false }), 'aliyun')
})

test('未配置但有浏览器识别 → web', () => {
  assert.equal(selectSpeechSource({ configured: false, hasWebSpeech: true }), 'web')
})

test('都没有 → none，且容忍畸形入参', () => {
  assert.equal(selectSpeechSource({ configured: false, hasWebSpeech: false }), 'none')
  assert.equal(selectSpeechSource(null), 'none')
  assert.equal(selectSpeechSource(undefined), 'none')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/speechSource.test.js`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `speechSource.js` 与 `useSpeechInput.js`**

`speechSource.js`：纯函数，`configured === true ? 'aliyun' : (hasWebSpeech === true ? 'web' : 'none')`。

`useSpeechInput.js`：
- 内部 `useRef` 持有 speech 实例、`useState` 持有 `listening/error/source`。
- `start(onResult)`：若已在录音 → `stop()` 返回；否则首次调用先 `authFetch('/asr/status')` 取 `configured`（请求失败按 `false`），`hasWebSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition)`，用 `selectSpeechSource` 选源；`aliyun` 走 `await createAsrSpeechInput(authFetch)`，`ok===false` 时降级 `createSpeechInput()` 并把 source 记为 `'web'`；`none` → 设 `error='当前浏览器不支持语音输入，请直接输入英文'` 并返回。
- 实例的 `start(onText, onErr, onEnd)` 包一层：`onText` 里 `setListening(false)` 并回调；`onErr` 里 `setListening(false)` + `setError(err)`；`onEnd` 里 `setListening(false)`。
- `stop()`：`speechRef.current?.stop()` + `setListening(false)`；`useEffect(() => () => stop(), [])` 卸载清理。
- 不要改 `aliyunAsr.js` / `recallSpeech.js`。

- [ ] **Step 4: 运行测试 + lint 确认通过**

Run: `node --test src/utils/speechSource.test.js && npx eslint src/utils/useSpeechInput.js src/utils/speechSource.js`
Expected: 测试 PASS，eslint 无 error（hooks 依赖警告也不允许新增）。

- [ ] **Step 5: 提交**

```bash
git add src/utils/speechSource.js src/utils/speechSource.test.js src/utils/useSpeechInput.js
git commit -m "feat: 中译英对话语音输入复用 hook"
```

---

### Task 6: 练习页骨架（加载 / 生成 / 难度切换 / 重新生成 / 卡片 / 续练）

**Files:**
- Create: `src/pages/DialoguePage.jsx`
- Modify: `src/main.jsx`（注册 `/video/:id/dialogue`）

**Interfaces:**
- Consumes: `useAuth()` 的 `authFetch/isGuest`；Task 4 的 `DIFFICULTIES/DIFFICULTY_LABELS/difficultyFromVideoLevel/progressLabel/contextOf`；Task 3 的 GET/generate 接口。
- Produces: 页面组件（默认导出 `DialoguePage`），状态供 Task 7 扩展：`script, progress, cursor, difficulty, loading, generating, error`。

- [ ] **Step 1: 写骨架**

`DialoguePage.jsx` 首屏流程：
1. `useParams` 取 `id`；`isGuest` → `navigate('/login', { state: { from: '/video/'+id+'/dialogue' } })`。
2. `fetch('/data/consolidated.json')` 找视频（`episode_dir/title/level`），失败 → `error='加载失败'`。
3. `difficulty` 初始值 = `difficultyFromVideoLevel(video.level)`。
4. `load(d)` = `authFetch('/dialogue/'+id+'?difficulty='+d)`：401 → 跳登录；`!ok` → `error`；成功：
   - 保存 `available`（难度 chips 据此判断是否需要确认）与 `aiConfigured`；
   - `script` 存在 → 设置 `script/progress`，`cursor = progress.cursor`（钳制到 `0..lines.length-1`）；
   - `script === null` → 自动 `generate(d)`（首次进入自动生成，不弹确认）。
5. `generate(d)` = `authFetch('/dialogue/'+id+'/generate', { method:'POST', body: JSON.stringify({ difficulty: d }) })`；`generating=true` 时页面显示「正在为这个视频准备对话…（约 10–20 秒）」；503/失败 → `error` 文案直接用服务端 `error` 字段。
6. 难度 chip（简单/日常/进阶）：点击后 `setDifficulty(d)`；若 `available` 含该档 → `load(d)`；否则弹确认（`window.confirm`，文案「该难度还没有对话脚本，需要生成一组新的（约 10–20 秒），继续？」），确认后 `generate(d)`，取消则回滚选中态。
7. `⋯` 菜单（用一个 `showMenu` state + 遮罩点击关闭）：`重新生成对话` → `window.confirm('将生成一组新对话，旧对话与答题记录会保留但不再显示，继续？')` → `generate(difficulty)`；`重新开始` → 本期不做（Task 7 实现），先只渲染 `返回视频`。
8. 卡片区：场景横幅（`script.scene` / `settingCn` / `userRole` / `otherRole`，缺失不渲染）、无字幕提示（`script.source === 'video-info'` → 「无字幕 · 依据视频信息生成」）、上下文（`contextOf(script.lines, cursor)`，灰字 `speakerCn：cn`）、主卡（`lines[cursor].speakerCn` 小标签 + `cn` 大字 + `keyPoints` chips）、进度 `progressLabel(cursor, script.lines.length)` 在 header 右侧。
9. 空态/错误态：统一 `error` 卡片 + 「重试」「返回视频」按钮；`aiConfigured === false` 时给「AI 未配置，无法生成对话」而不是重试。

`src/main.jsx`：`import DialoguePage from './pages/DialoguePage'` + `<Route path="video/:id/dialogue" element={<DialoguePage />} />`（放在 speak 路由之后）。

- [ ] **Step 2: 验证编译与 lint**

Run: `npm run lint && npm run build`
Expected: 无新增 error；build 成功。

- [ ] **Step 3: 手动冒烟（可选，无 AI key 也能验证）**

Run: `npm run dev` + `npm run server`，登录后打开 `/video/<任一 id>/dialogue`：
- 无 AI key → 出现「AI 未配置」提示，不出现假题目；
- 无脚本且 AI 可用 → 出现生成中状态（本轮可手动插入一行 `dialogue_scripts` 验证加载路径）。

- [ ] **Step 4: 提交**

```bash
git add src/pages/DialoguePage.jsx src/main.jsx
git commit -m "feat: 中译英对话练习页骨架与路由"
```

---

### Task 7: 评分交互（解析 / 重试 / 参考答案 / 进度落库 / 完成总结）

**Files:**
- Modify: `src/pages/DialoguePage.jsx`

**Interfaces:**
- Consumes: Task 5 `useSpeechInput`；Task 4 `primaryAction/summarizeAnswers`；Task 3 `evaluate/progress/restart` 接口；`createSpeaker` from `../utils/tts.js`。
- Produces: 完整练习交互。

- [ ] **Step 1: 接入语音与解析**

- `const speech = useSpeechInput(authFetch)`；点击麦克风 → `speech.start(text => setUserText(text))`；`speech.error` 渲染在输入框下方，麦克风按钮 72–80px 圆形，`listening` 时变红并显示 `Square`，文案「点击麦克风说英文 / 录音中，再点一次结束」。
- `<textarea>` 绑定 `userText`，placeholder「识别结果会显示在这里，可手动修改后点解析」。
- 「✨ 解析我的回答」：`disabled = !userText.trim() || evaluating`；点击 `POST /dialogue/:scriptId/evaluate`，body `{ index: cursor, userText }`；`401` → 跳登录；`!res.ok` → `setError(data.error)` 且**保留 `userText`**；成功 → `setReview(data.review)`、`setAttempts(data.attempts)`、`setProgress(data.progress)`、`setRevealed(false)`。
- 解析中按钮文案「解析中...」；解析成功后清 `error`。
- 切句/重开时必须 `speech.stop()` 并清空 `userText/review/attempts/revealed`。

- [ ] **Step 2: 结果卡与动作按钮**

- 结果卡结构：verdict 徽章（`correct` 绿「说对了」/`minor` 琥珀「意思对，可以更地道」/`wrong` 玫红「再试一次」；`parseError` → 「这句没评出来，请再点一次解析」）+ 分数（`score` 为 null 显示 `—`）+ 「你说」（`userText`）+ issues 列表（类型中文标签 + 片段/问题/建议/更好，`better` 为空则不渲染）+ `praise` + `hint`（`answerHidden` 时高亮显示为「提示」）。
- `primaryAction(review, attempts)`：
  - `'retry'` → 主按钮「再试一次」（清 `userText/review/attempts/revealed`），次按钮「查看参考答案」；
  - `'next'` → 主按钮「下一句」（最后一句时文案「完成练习」），次按钮「查看参考答案」。
- 「查看参考答案」切换 `revealed`，显示 `lines[cursor].en` + `alternatives` + 🔊（`speakerRef.current.speak(en)`）；`revealed` 时把 `revealedAnswer:true` 合并进本地 `progress.answers`（服务端只在下一次 evaluate 落库，可接受）。
- 「上一句」（可选，返回上一句只读查看答案与记录）。

- [ ] **Step 3: 进度与总结**

- `goNext()`：`next = cursor + 1`；若 `next >= lines.length` → `PUT /dialogue/:scriptId/progress { cursor: lines.length, status: 'completed' }`，成功后 `setSummary(summarizeAnswers(progress.answers, lines))`、`setDone(true)`；否则 `PUT { cursor: next }`（失败静默）→ `setCursor(next)` 并清空作答态。
- 完成态整页替换为总结卡：
  - 均分（`averageScore ?? '—'`）、完成句数 `answered/total`、一次通过率 `firstTryRate`%（null 显示 `—`）；
  - 「常见错误」：`topIssues` 用中文类型标签 + 次数；为空显示「没有明显集中错误」；
  - 「需要复习的表达」：`reviewLines` 列表（中文 + 英文 + 分数 + 🔊）；
  - 按钮：「重新开始」（`POST restart` → 重置 `cursor=0/answers=[]/done=false`）、「换难度」（回到顶部难度 chips 的确认流程即可，直接 `setDone(false)`）、「返回视频」。
- 关闭未完成页面前的进度：`cursor` 变化已即时 `PUT`，无需额外处理。

- [ ] **Step 4: 验证**

Run: `npm run lint && npm run build`
Expected: 无新增 error；build 成功。

- [ ] **Step 5: 手动冒烟（AI 可用时）**

1. 进入 → 自动生成 12 句 → 只显示第 1 句 + 上下文。
2. 故意说错 → 只看到中文提示、看不到英文修正 → 「再试一次」→ 说对 → 显示分数 + 更好说法。
3. 刷新页面 → 回到同一句，`3/12` 进度不变。
4. 全部做完 → 总结卡出现且数字与实际作答一致。
5. 「换难度」→ 未生成档位弹确认；确认后生成新脚本，切回原难度仍加载旧脚本与进度。

- [ ] **Step 6: 提交**

```bash
git add src/pages/DialoguePage.jsx
git commit -m "feat: 中译英对话评分重试与完成总结"
```

---

### Task 8: 入口、文档与全量验证

**Files:**
- Modify: `src/pages/VideoDetail.jsx`（两处「💬 AI 对话」下拉，行号约 824 与 1183）
- Modify: `README.md`（功能列表里加一行，若已有同类条目）
- Modify: `docs/superpowers/specs/2026-10-13-cn-en-dialogue-design.md`（状态改为「已实现」）

**Interfaces:**
- Consumes: 路由 `/video/:id/dialogue`。

- [ ] **Step 1: 加入口**

两处下拉里各加一项，紧跟「🗣 自由表达」之后：
```jsx
<button onClick={() => { setShowSpeakMenu(false); navigate(`/video/${id}/dialogue`) }}
  className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 cursor-pointer">🔁 中译英对话</button>
```
游客逻辑与同菜单既有项一致（外层按钮已经把 `isGuest` 导向登录，子项无需重复判断）。

- [ ] **Step 2: 全量测试**

Run:
```bash
node --test server/db.test.cjs server/services/ai/dialogue.test.cjs server/routes/dialogue.test.cjs \
  server/routes/conversation.test.cjs server/routes/conversation-ai.test.cjs \
  src/utils/dialoguePractice.test.js src/utils/speechSource.test.js
```
Expected: 全部 PASS。

- [ ] **Step 3: lint + build**

Run: `npm run lint && npm run build`
Expected: eslint 无 error（与改动前基线一致），build 成功。

- [ ] **Step 4: 回归冒烟**

按 Spec 第 9 节逐条过一遍（入口两处、首次生成、重进 0 调用、难度隔离、重新生成 variant+1、无字幕标注、无 key 提示、游客登录、总结卡）。记录每条结论。

- [ ] **Step 5: 提交**

```bash
git add src/pages/VideoDetail.jsx README.md docs/superpowers/specs/2026-10-13-cn-en-dialogue-design.md
git commit -m "feat: 中译英对话入口与文档"
```
