# 文本练习（Text Practice）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户把任意英文技术文档粘贴进来，得到「逐句跟读 + 汉译英」两种练习，进度独立保存、随时续练。

**Architecture:** 两张新表（`text_docs` / `text_progress`）承载文本与练习进度；服务端用确定性的 Markdown 感知切句器把正文拆成句子，保存时一次性用 AI 批量补中文（失败只降级不阻塞）；前端两个新页面（列表 `/texts`、详情 `/texts/:id`），详情页复用现有 `ShadowingEvaluator` 做跟读评分、`createSpeaker` 做播放、`useSpeechInput` 做语音作答，评分语义复用 `speak.cjs` 的 `parseReview`。

**Tech Stack:** React 19 + Vite + Tailwind 4、Express 5、sql.js、`node:test`（无新增依赖）。

**Spec:** `docs/superpowers/specs/2026-10-26-text-practice-design.md`

## Global Constraints

- **只增不改**：允许修改的既有文件**仅限** `src/main.jsx`、`src/pages/Profile.jsx`、`src/components/ShadowingEvaluator.jsx`、`server/db.cjs`、`server/index.cjs`。
  禁止改动 `VideoDetail.jsx` / `DictationPage` / `ShadowingPage` / `ClozePage` / `ConversationPage` / `SpeakPracticePage` / `DialoguePage` / `Library` / `LearningRecords`、任何既有 API 路由的路径与载荷、任何既有表结构。
- **零新依赖**：AI 走 `server/services/ai/provider.cjs`，TTS/ASR/评测走既有前端工具，测试用 `node:test`。
- **不伪造 AI 结果**：AI 未配置或输出畸形时，翻译留空 + `translation: 'unavailable'`，评分返回 503 或 `score: null` —— 绝不编造分数或译文。
- **术语保真**：`SAM`、`UMAP`、`YOLO`、`U-Net`、`PaCMAP`、驼峰/下划线标识符（`getUserById`、`top_k`）在切句、翻译、评分三个环节都不许被改写。
- **游客**：所有 `/api/texts/*` 需登录（401）；前端 `/texts` 页面 `navigate('/login')`。
- **单测运行方式**：`node --test <path>`；前端 UI 无测试运行器，用 `npm run lint` + `npm run build` + 手动检查。
- **UI 文案中文**，样式沿用 Tailwind（`bg-slate-50` 页面底、白卡、`indigo-600` 主色），个人中心区块沿用 `.profile-section` 系列 class。
- 数据无关性：不改 `video_progress` / `practice_records` / `dialogue_*` / `vocabulary`，不写 `ai_cache`。

## Review Focus

1. **粘贴内容里没有可用英文**（纯代码块、纯中文、纯符号）→ 必须得到 400 与可读提示，而不是空列表或 0 句白的详情页。（Task 1、Task 3）
2. **句号出现在缩写/小数/版本号/行内代码里**（`etc.`、`e.g.`、`0.92`、`v1.2`、`U.S.`、`` `model.fit()` ``）→ 不许在这里切句。（Task 1）
3. **专业术语被翻译或改写**（`SAM` →「分割一切模型」、`U-Net` →「U 网」、`PaCMAP` →「帕克映射」）→ 译文与评分都必须原样保留术语。（Task 2 的 prompt 断言 + Task 9 手动验证）
4. **只改标题却清空全部练习进度**→ 数据丢失。改名必须非破坏性。（Task 3）
5. **删除文本后留下孤儿 `text_progress` 行**（`PRAGMA foreign_keys` 未开，CASCADE 不生效）→ 删除路由必须显式删进度行。（Task 3）

---

### Task 1: Markdown 感知切句器 + 两张新表

**Files:**
- Create: `server/lib/textSentences.cjs`
- Test: `server/lib/textSentences.test.cjs`
- Modify: `server/db.cjs`（`initSchema()` 末尾追加两张表，位置在 `dialogue_progress` 之后）

**Interfaces:**
- Consumes: 无
- Produces:
  - `splitMarkdown(text, opts?) -> { units: Array<{ en: string, section: string }>, truncated: boolean }`，`opts = { maxUnits = 200, maxChars = 180 }`
  - `splitEnglishSentences(paragraph: string) -> string[]`
  - `stripMarkdownInline(s: string) -> string`
  - 常量 `MAX_UNITS = 200`、`MAX_CHARS = 180`
  - 表 `text_docs(id, user_id, title, source_text, sentences_json, truncated, model, created_at, updated_at)`、`text_progress(id, doc_id UNIQUE, user_id, shadow_cursor, translate_cursor, shadow_json, answers_json, status, updated_at)`

- [ ] **Step 1: 写失败的测试**

```js
// server/lib/textSentences.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const { splitMarkdown, splitEnglishSentences, MAX_UNITS } = require('./textSentences.cjs')

const en = (text, opts) => splitMarkdown(text, opts).units.map(u => u.en)

test('段落按句子切分，硬换行先并成一句', () => {
  assert.deepEqual(
    en('U-Net has an encoder and a decoder. It is popular.\nIt wins benchmarks.'),
    ['U-Net has an encoder and a decoder.', 'It is popular.', 'It wins benchmarks.'],
  )
})

test('缩写 / 小数 / 版本号 / 首字母不切句', () => {
  assert.deepEqual(en('We use SAM, UMAP, etc. in the pipeline. Then we ship it.'), [
    'We use SAM, UMAP, etc. in the pipeline.', 'Then we ship it.',
  ])
  assert.deepEqual(en('Accuracy is 0.92 on v1.2. That is good.'), ['Accuracy is 0.92 on v1.2.', 'That is good.'])
  assert.deepEqual(en('e.g. this and i.e. that.'), ['e.g. this and i.e. that.'])
  assert.deepEqual(en('U.S. policy matters. Yes.'), ['U.S. policy matters.', 'Yes.'])
  assert.deepEqual(en('J. Smith wrote it. Done.'), ['J. Smith wrote it.', 'Done.'])
})

test('行内代码里的点号不切句，代码标识符原样保留', () => {
  assert.deepEqual(en('Call `model.fit()` twice. Then stop.'), ['Call `model.fit()` twice.', 'Then stop.'])
  assert.deepEqual(en('Use `top_k` and `getUserById` here. Ok.'), ['Use top_k and getUserById here.', 'Ok.'])
})

test('围栏代码块整块丢弃，标题只作为 section', () => {
  const text = '# U-Net\n\nIt is a CNN. PaCMAP is a manifold method.\n\n```js\nconst a = 1. Not a sentence.\n```\n\n## Results\n\nmIoU is 0.81.'
  const { units } = splitMarkdown(text)
  assert.deepEqual(units, [
    { en: 'It is a CNN.', section: 'U-Net' },
    { en: 'PaCMAP is a manifold method.', section: 'U-Net' },
    { en: 'mIoU is 0.81.', section: 'Results' },
  ])
})

test('列表项逐条成句，去掉标记与编号', () => {
  assert.deepEqual(en('- Install the package.\n- Run the script.'), ['Install the package.', 'Run the script.'])
  assert.deepEqual(en('1. Open the file. 2. Save it.'), ['Open the file.', 'Save it.'])
})

test('表格每行按单元格成句，分隔行丢弃', () => {
  const table = '| Method | Dataset |\n| --- | :---: |\n| SAM | COCO |'
  assert.deepEqual(en(table), ['Method', 'Dataset', 'SAM', 'COCO'])
})

test('链接 / 图片 / 强调语法被剥掉但文本与术语保留', () => {
  assert.deepEqual(en('**[U-Net](https://example.com)** is fast.'), ['U-Net is fast.'])
  assert.deepEqual(en('![figure](a.png) The architecture is simple.'), ['The architecture is simple.'])
  assert.deepEqual(en('> quoted advice here.'), ['quoted advice here.'])
})

test('无英文 / 空输入 → 0 句', () => {
  assert.deepEqual(splitMarkdown('这是一段中文。'), { units: [], truncated: false })
  assert.deepEqual(splitMarkdown(''), { units: [], truncated: false })
  assert.deepEqual(splitMarkdown(null), { units: [], truncated: false })
  assert.deepEqual(splitMarkdown('```py\nprint(1)\n```'), { units: [], truncated: false })
})

test('超长句按 maxChars 就近切开', () => {
  const long = Array.from({ length: 40 }, (_, i) => `part${i} is quite descriptive`).join(', ') + '.'
  const { units } = splitMarkdown(long, { maxChars: 120 })
  assert.ok(units.length > 1)
  for (const u of units) assert.ok(u.en.length <= 120, `${u.en.length} > 120: ${u.en}`)
})

test('超过 maxUnits 时截断并置 truncated', () => {
  const many = Array.from({ length: MAX_UNITS + 5 }, (_, i) => `Sentence number ${i} here.`).join(' ')
  const { units, truncated } = splitMarkdown(many)
  assert.equal(units.length, MAX_UNITS)
  assert.equal(truncated, true)
  assert.deepEqual(splitMarkdown('One sentence.'), { units: [{ en: 'One sentence.', section: '' }], truncated: false })
})

test('splitEnglishSentences 对空值安全', () => {
  assert.deepEqual(splitEnglishSentences(''), [])
  assert.deepEqual(splitEnglishSentences('   '), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/lib/textSentences.test.cjs`
Expected: FAIL — `Cannot find module './textSentences.cjs'`

- [ ] **Step 3: 实现 `server/lib/textSentences.cjs`**

导出 `splitMarkdown`、`splitEnglishSentences`、`stripMarkdownInline`、`MAX_UNITS`、`MAX_CHARS`。实现要点（顺序执行，别省略）：

1. 归一化 `\r\n|\r → \n`，`\t → ' '`，连续 3+ 空行 → 2 个换行。
2. 用 `/\n```[\s\S]*?\n```/g` 与 `/<!--[\s\S]*?-->/g` 删掉围栏代码块与 HTML 注释；**行内单个反引号不动**。
3. 逐行分类：ATX 标题 `/^#{1,6}\s+/` → 只更新 `section`；表格分隔行 `/^\s*\|?[\s:|-]+\|?\s*$/`（且含 `-`）与水平线 `/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/` → 丢弃；表格行 `/^\s*\|/` → 按 `|` 切单元格、每格一次 push；列表项 `/^\s*(?:[-*+]|\d+[.)])\s+/` → 去标记后进段落缓冲；引用 `/^\s*>\s?/` → 去 `>` 后进缓冲；空行 → flush 缓冲；其余 → 追加进缓冲（行间用单空格拼接）。
4. `stripMarkdownInline` 顺序：图片 `!\[([^\]]*)\]\([^)]*\)` → `$1`；链接 `\[([^\]]*)\]\([^)]*\)` → `$1`；强调 `[*_~]{1,3}` 删除；HTML 标签 `<[^>]+>` 删除；剩余反引号删除；实体 `&amp; &lt; &gt; &quot; &#39;` 还原；多空格压成一个。
5. `splitEnglishSentences`：先把 `` `…` `` 段替换成占位符 `\u0000{n}\u0000`（防点号被切），再按「`[.!?…]` + 可选收尾引号括号 + 空白/结尾」扫描切分；命中下列任一保护条件则**不切**并继续找下一个候选点：
   - 该点前 token（小写比较）在缩写表内（`e.g.`、`i.e.`、`etc.`、`vs.`、`fig.`、`figs.`、`eq.`、`eqs.`、`sec.`、`tab.`、`ref.`、`refs.`、`al.`、`cf.`、`resp.`、`approx.`、`dr.`、`mr.`、`mrs.`、`ms.`、`prof.`、`inc.`、`ltd.`、`co.`、`st.`、`no.`、`min.`、`max.`、`avg.`）；
   - 点号前后都是数字；或点号链 `/(?:[A-Za-z]\.){2,}$/`；
   - 前一个 token 是单个大写字母（人名首字母）；
   - 点号后第一个非空白字符是小写字母。
   切完还原占位符、逐句 trim。
6. 后处理：丢弃不含 `[A-Za-z]` 或 `length < 2` 的句子；超 `maxChars` 的句子用 `splitLong(text, maxChars)` 处理——优先在 `"; "`，其次 `" — "`，其次 `", "`，最后空格，从最靠近 `maxChars` 的位置切，递归处理剩余；取前 `maxUnits` 句并置 `truncated = 总句数 > maxUnits`。
7. 输出 `{ units, truncated }`，`units[i].section` 取该句所属的最近标题（无标题为 `''`）。

- [ ] **Step 4: 在 `server/db.cjs` 的 `initSchema()` 里加两张表**

放在 `dialogue_progress` 的 `db.run(...)` 之后、迁移段之前，字段与注释照 spec §3 原文（含 `truncated INTEGER NOT NULL DEFAULT 0`）。不新增 `PRAGMA foreign_keys`。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test server/lib/textSentences.test.cjs`
Expected: PASS（全部用例）。再跑 `node --test server/db.test.cjs` 确认没弄坏既有 DB 测试。

- [ ] **Step 6: Commit**

```bash
git add server/lib/textSentences.cjs server/lib/textSentences.test.cjs server/db.cjs
git commit -m "feat(texts): Markdown 感知切句器与文本练习数据表"
```

---

### Task 2: AI 服务（批量翻译 + 单句评分）

**Files:**
- Create: `server/services/ai/textPractice.cjs`
- Test: `server/services/ai/textPractice.test.cjs`

**Interfaces:**
- Consumes: `server/services/ai/speak.cjs` 的 `parseReview`
- Produces:
  - `TRANSLATE_CHUNK = 50`
  - `buildTranslatePrompt({ title, sentences }) -> { system, user }`（`sentences: string[]`）
  - `normalizeTranslations(json, { count }) -> { ok: boolean, items: Array<{ i: number, cn: string }>, missing: number[] }`
  - `buildSentenceReviewPrompt({ title, en, cn, userText, attempt }) -> { system, user }`
  - `normalizeSentenceReview(json) -> { verdict, score, issues, better, praise, hint, parseError }`

- [ ] **Step 1: 写失败的测试**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildTranslatePrompt, normalizeTranslations, buildSentenceReviewPrompt, normalizeSentenceReview,
} = require('./textPractice.cjs')

test('翻译 prompt 要求保留术语且只输出 JSON', () => {
  const { system, user } = buildTranslatePrompt({ title: 'U-Net 论文摘要', sentences: ['U-Net beats FCN.'] })
  assert.match(system, /原样保留/)
  assert.match(system, /SAM/)
  assert.match(system, /只输出/)
  assert.match(user, /U-Net 论文摘要/)
  assert.match(user, /U-Net beats FCN\./)
})

test('normalizeTranslations：全齐 → ok', () => {
  const r = normalizeTranslations({ items: [{ i: 0, cn: '甲。' }, { i: 1, cn: ' 乙。 ' }] }, { count: 2 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.items, [{ i: 0, cn: '甲。' }, { i: 1, cn: '乙。' }])
  assert.deepEqual(r.missing, [])
})

test('normalizeTranslations：缺项 / 空串 / 越界 i / 脏数据', () => {
  const r = normalizeTranslations({ items: [{ i: 0, cn: '甲。' }, { i: 9, cn: '越界' }, { i: 1, cn: '  ' }, null] }, { count: 2 })
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, [1])
  assert.deepEqual(r.items, [{ i: 0, cn: '甲。' }])
  assert.deepEqual(normalizeTranslations(null, { count: 1 }), { ok: false, items: [], missing: [0] })
})

test('评分 prompt：中文为空时不出现中文行，重试时提示 attempt', () => {
  const a = buildSentenceReviewPrompt({ title: 'T', en: 'It works.', cn: '', userText: 'It works', attempt: 1 })
  assert.doesNotMatch(a.user, /中文/)
  assert.match(a.system, /同义|等价|高分/)
  const b = buildSentenceReviewPrompt({ title: 'T', en: 'It works.', cn: '它能工作。', userText: 'x', attempt: 2 })
  assert.match(b.user, /它能工作。/)
  assert.match(b.user, /2/)
})

test('normalizeSentenceReview：verdict 合法保留，非法按分数派生', () => {
  assert.equal(normalizeSentenceReview({ verdict: 'minor', score: 70 }).verdict, 'minor')
  assert.equal(normalizeSentenceReview({ verdict: 'whatever', score: 92 }).verdict, 'correct')
  assert.equal(normalizeSentenceReview({ verdict: 'whatever', score: 61 }).verdict, 'minor')
  assert.equal(normalizeSentenceReview({ verdict: 'whatever', score: 40 }).verdict, 'wrong')
  const nullScore = normalizeSentenceReview({ score: null })
  assert.equal(nullScore.score, null)
  assert.equal(nullScore.verdict, 'wrong')
  assert.equal(normalizeSentenceReview(null).parseError, true)
  assert.equal(normalizeSentenceReview({ score: 80, praise: 'good' }).praise, 'good')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/services/ai/textPractice.test.cjs`
Expected: FAIL — `Cannot find module './textPractice.cjs'`

- [ ] **Step 3: 实现 `server/services/ai/textPractice.cjs`**

- `SYSTEM_TRANSLATE` 用 `join('\n')` 写：技术文档译者 → 中文自然口语化便于回译 → 「原样保留：SAM / UMAP / YOLO / U-Net / PaCMAP 等缩写、模型与库名、驼峰/下划线标识符、URL、数字、版本号、单位；不增删信息、不加译注」→ `只输出 JSON {"items":[{"i":0,"cn":"..."}]}`。
- `buildTranslatePrompt` 的 `user`：`标题：${title}` + 空行 + `共 ${n} 句，请逐句翻译，i 从 0 开始：` + 每行 `${i}. ${en}`。
- `normalizeTranslations`：`json?.items` 必须是数组，否则 `{ ok:false, items:[], missing: 0..count-1 }`；逐项取整数 `i`（`0 <= i < count`）、`cn = String(cn ?? '').trim()`，空串跳过；同 `i` 后者覆盖前者；最后 `sort((a,b)=>a.i-b.i)`，`missing` = 未覆盖的下标。
- `SYSTEM_REVIEW` = 复用 `speak.cjs` 的评分语义（原文只是**一种**正确说法，语义等价的其它英文同样给高分；检查语法/用词/漏译/曲解/术语被改写）+ JSON 结构（`verdict`、`score`、`issues[{type,location,problem,suggestion,better}]`、`better`、`praise`、`lowScoreHint`），并额外要求 `type` 可为 `term`（术语被改动）。
- `buildSentenceReviewPrompt` 的 `user`：`文档标题：…`、`英文原文：…`、`中文参考：…`（`cn` 为空时省略该行）、`学习者写的英文：…`、`这是第 ${attempt} 次尝试`（attempt > 1 时才加）、`请只输出上述 JSON`。
- `normalizeSentenceReview`：`json` 非对象 → `{ verdict:'wrong', score:null, issues:[], better:'', praise:'', hint:'', parseError:true }`；否则 `review = parseReview(json)`（复用），`verdict` 合法则保留，否则按 `score >= 85 → 'correct'`、`>= 60 → 'minor'`、其余（含 `null`）`→ 'wrong'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/services/ai/textPractice.test.cjs server/services/ai/speak.test.cjs`
Expected: 两个文件全 PASS（后者确认没改坏 `parseReview`）

- [ ] **Step 5: Commit**

```bash
git add server/services/ai/textPractice.cjs server/services/ai/textPractice.test.cjs
git commit -m "feat(texts): 批量翻译与单句回译评分 AI 服务"
```

---

### Task 3: 文本 CRUD + 翻译 API

**Files:**
- Create: `server/routes/texts.cjs`
- Test: `server/routes/texts.test.cjs`
- Modify: `server/index.cjs`（引入并挂载 `/api/texts`，放在 `dialogueRoutes` 之后一行）

**Interfaces:**
- Consumes: Task 1 的 `splitMarkdown` / `MAX_UNITS`；Task 2 的 `buildTranslatePrompt`、`normalizeTranslations`、`TRANSLATE_CHUNK`；`db.cjs` 的 `getDb/run/get/all`；`auth.cjs` 的 `authMiddleware`；`ai/provider.cjs` 的 `chat/extractJson/isConfigured/AI_MODEL`
- Produces（供 Task 4 与前端使用）：
  - `router`（`module.exports = { router }`）
  - `serializeDoc(row) -> Doc`：`{ id, title, sourceText, sentences, truncated, cnReady, missingCn, createdAt, updatedAt }`
  - `serializeProgress(row) -> Progress`：`{ docId, shadowCursor, translateCursor, status, shadow, answers, updatedAt }`
  - `serializeSummary(docRow, progressRow) -> DocSummary`：`{ id, title, sentenceCount, cnReady, truncated, status, shadowDone, translateDone, updatedAt }`
  - `ensureProgress(docRow) -> progressRow`（缺行则 `INSERT`）
  - `requireOwnDoc(req, res, id) -> docRow | null`（非法/不存在 404 `文本不存在`，非本人 403 `无权访问该文本`）
  - `translateDoc(docRow, { onlyMissing = false }) -> { translation: 'ok'|'partial'|'unavailable', sentences }`

- [ ] **Step 1: 写失败的测试**

```js
// server/routes/texts.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

delete process.env.AI_API_KEY
delete process.env.AI_BASE_URL
delete process.env.AI_MODEL

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-texts-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb, get } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const textsRoutes = require('./texts.cjs')

const app = express()
app.use(express.json())
app.use('/api/texts', textsRoutes.router)

let server, baseUrl
const USER_ID = 7, OTHER = 8
const SAMPLE = '# U-Net\n\nU-Net has an encoder and a decoder. PaCMAP preserves structure.'

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

const H = (u = USER_ID) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${signToken(u)}` })
const api = async (method, p, body, u = USER_ID) => {
  const res = await fetch(`${baseUrl}/api/texts${p}`, { method, headers: H(u), ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const create = (body = { title: 'U-Net 摘要', text: SAMPLE }, u = USER_ID) => api('POST', '', body, u)

test('未登录 → 401', async () => {
  for (const [m, p] of [['GET', ''], ['POST', ''], ['GET', '/1'], ['PUT', '/1'], ['DELETE', '/1'], ['POST', '/1/translate']]) {
    const res = await fetch(`${baseUrl}/api/texts${p}`, { method: m, headers: { 'Content-Type': 'application/json' } })
    assert.equal(res.status, 401, `${m} ${p}`)
  }
})

test('标题/正文校验', async () => {
  assert.equal((await create({ title: '', text: SAMPLE })).status, 400)
  assert.equal((await create({ title: 'x'.repeat(101), text: SAMPLE })).status, 400)
  assert.equal((await create({ title: 'ok', text: '' })).status, 400)
  assert.equal((await create({ title: 'ok', text: 'x'.repeat(20001) })).status, 400)
  const noEn = await create({ title: 'ok', text: '```py\nprint(1)\n```' })
  assert.equal(noEn.status, 400)
  assert.match(noEn.body.error, /没有找到可练习的英文句子/)
})

test('保存 → 列表 → 详情（AI 未配置时 translation=unavailable）', async () => {
  const { status, body } = await create()
  assert.equal(status, 201)
  assert.equal(body.translation, 'unavailable')
  assert.equal(body.doc.sentences.length, 2)
  assert.deepEqual(body.doc.sentences.map(s => s.en), ['U-Net has an encoder and a decoder.', 'PaCMAP preserves structure.'])
  assert.deepEqual(body.doc.sentences.map(s => s.cn), ['', ''])
  assert.equal(body.doc.cnReady, false)
  assert.equal(body.doc.missingCn, 2)
  assert.equal(body.progress.shadowCursor, 0)
  assert.equal(body.progress.status, 'active')

  const list = await api('GET', '')
  const summary = list.body.docs.find(d => d.id === body.doc.id)
  assert.deepEqual(
    { title: summary.title, sentenceCount: summary.sentenceCount, cnReady: summary.cnReady, shadowDone: summary.shadowDone, translateDone: summary.translateDone, status: summary.status },
    { title: 'U-Net 摘要', sentenceCount: 2, cnReady: false, shadowDone: 0, translateDone: 0, status: 'active' },
  )

  const detail = await api('GET', `/${body.doc.id}`)
  assert.equal(detail.body.doc.sourceText, SAMPLE)
  assert.equal(detail.body.doc.sentences[0].section, 'U-Net')
  assert.equal(detail.body.aiConfigured, false)
})

test('详情：不存在 404、他人 403', async () => {
  const id = (await create()).body.doc.id
  assert.equal((await api('GET', '/9999')).status, 404)
  assert.equal((await api('GET', `/${id}`, null, OTHER)).status, 403)
})

test('只改标题不重切句', async () => {
  const created = (await create()).body
  const renamed = await api('PUT', `/${created.doc.id}`, { title: '新标题' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.doc.title, '新标题')
  assert.equal(renamed.body.doc.sentences.length, 2)
  assert.deepEqual(renamed.body.doc.sentences.map(s => s.en), created.doc.sentences.map(s => s.en))
  assert.equal(renamed.body.progress.shadowCursor, 0)
})

test('改正文 → 重切句且进度归零', async () => {
  const created = (await create()).body
  const rewritten = await api('PUT', `/${created.doc.id}`, { text: 'One brand new sentence here.' })
  assert.equal(rewritten.status, 200)
  assert.equal(rewritten.body.doc.sentences.length, 1)
  assert.equal(rewritten.body.progress.shadowCursor, 0)
  assert.equal(rewritten.body.progress.translateCursor, 0)
  assert.equal(rewritten.body.progress.status, 'active')
  assert.equal(rewritten.body.progress.shadow.length, 0)
  assert.equal(rewritten.body.progress.answers.length, 0)
})

test('删除 → 204，文档与进度行都没了', async () => {
  const id = (await create()).body.doc.id
  assert.equal((await api('DELETE', `/${id}`)).status, 204)
  assert.equal((await api('GET', `/${id}`)).status, 404)
  assert.equal(get('SELECT id FROM text_progress WHERE doc_id=?', [id]), undefined)
})

test('translate：AI 未配置 → 503', async () => {
  const id = (await create()).body.doc.id
  const res = await api('POST', `/${id}/translate`)
  assert.equal(res.status, 503)
  assert.match(res.body.error, /AI 未配置/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/routes/texts.test.cjs`
Expected: FAIL — `Cannot find module './texts.cjs'`

- [ ] **Step 3: 实现 `server/routes/texts.cjs` 的这 6 个端点**

`POST /` 流程：校验 → `splitMarkdown(text)` → 0 句则 400 → `INSERT INTO text_docs (user_id,title,source_text,sentences_json,truncated,model)`（`model` 先写 `null`）→ `ensureProgress` → `translateDoc(docRow)` → 201 `{ doc, progress, translation }`。
`PUT /:id`：`text` 存在才重切句并重置（`UPDATE text_docs` + `UPDATE text_progress SET shadow_cursor=0, translate_cursor=0, shadow_json='[]', answers_json='[]', status='active'`），否则只更新 `title`；两者都更新 `updated_at=datetime('now')`；正文变了才 `translateDoc`。
`DELETE /:id`：**先** `run('DELETE FROM text_progress WHERE doc_id=?')` **再** `DELETE FROM text_docs WHERE id=?`（不依赖 CASCADE）；返回 204。
`GET /`：按 `COALESCE(p.updated_at, d.updated_at) DESC, d.id DESC` 排序返回 `{ docs, aiConfigured }`；列表项只算 `count`，**不返回 `sourceText`/`sentences`**。
`GET /:id`：`{ doc, progress, aiConfigured }`（进度缺行时 `ensureProgress`）。
`POST /:id/translate`：`isConfigured()` 为假 → 503 `AI 未配置（AI_API_KEY 为空）`；否则 `translateDoc(row, { onlyMissing: true })` 返回 `{ doc, translation }`。
`translateDoc`：`isConfigured()` 为假 → `{ translation: 'unavailable', sentences }`；有 `cn` 的句子在 `onlyMissing` 时跳过；按 50 句分块 `chat([...], { temperature: 0.3, maxTokens: 4000, timeoutMs: 60000 })`，每块最多 2 次尝试（第二次在 user 后追加「上一轮缺第 X 句，请补齐并只输出 JSON」）；所有块成功后合并回写 `sentences_json` 与 `model = AI_MODEL`；`translation` = 全有 `ok` / 有部分 `partial` / 一句没有 `unavailable`。任何异常都 `console.error` 后降级，**不让路由 500**。

- [ ] **Step 4: 挂载路由**

`server/index.cjs`：`const textRoutes = require('./routes/texts.cjs')` 与 `app.use('/api/texts', textRoutes.router)`。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test server/routes/texts.test.cjs`
Expected: PASS（本任务只测本任务实现的 6 个端点；练习写入端点在 Task 4 加）

- [ ] **Step 6: Commit**

```bash
git add server/routes/texts.cjs server/routes/texts.test.cjs server/index.cjs
git commit -m "feat(texts): 文本 CRUD 与批量中文翻译 API"
```

---

### Task 4: 练习写入 API（跟读评分 / 回译评分 / 查看原文 / 进度）

**Files:**
- Modify: `server/routes/texts.cjs`（在 `module.exports` 前追加 4 个端点 + 两个常量）
- Test: `server/routes/texts-ai.test.cjs`

**Interfaces:**
- Consumes: Task 2 的 `buildSentenceReviewPrompt` / `normalizeSentenceReview`；Task 3 的 `requireOwnDoc` / `ensureProgress` / `serializeProgress` / `translateDoc`
- Produces: `POST /:id/shadow { index, score }`、`POST /:id/review { index, userText }`、`POST /:id/reveal { index }`、`PUT /:id/progress { shadowCursor?, translateCursor?, status? }`

- [ ] **Step 1: 写失败的测试**

```js
// server/routes/texts-ai.test.cjs —— 有 AI 的路径：stub fetch，全程不调真实接口
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

process.env.AI_API_KEY = 'test-key-for-unit-tests'
process.env.AI_BASE_URL = 'https://mock.invalid/v1'
process.env.AI_MODEL = 'mock-model'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-texts-ai-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

let translateMode = 'ok' // 'ok' | 'fail'
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes('/chat/completions')) return realFetch(url, opts)
  const body = JSON.parse(opts.body)
  const system = body.messages[0].content
  const user = body.messages.at(-1).content
  if (translateMode === 'fail') return { ok: false, status: 500, text: async () => 'boom' }
  if (system.includes('译者') || user.includes('i 从 0 开始')) {
    const idx = [...user.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]))
    const items = idx.map(i => ({ i, cn: `中文${i}` }))
    if (translateMode === 'partial') items.splice(1)
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }] }) }
  }
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      verdict: 'minor', score: 78,
      issues: [{ type: 'term', location: 'Unet', problem: '术语被改写', suggestion: '写回 U-Net', better: 'U-Net' }],
      better: 'U-Net has an encoder and a decoder.', praise: '意思对', lowScoreHint: '',
    }) } }] }),
  }
}

const express = require('express')
const { getDb } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const textsRoutes = require('./texts.cjs')
const app = express()
app.use(express.json())
app.use('/api/texts', textsRoutes.router)

let server, baseUrl
const USER_ID = 7, OTHER = 8
const SAMPLE = '# U-Net\n\nU-Net has an encoder and a decoder. PaCMAP preserves structure.'

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

const H = (u = USER_ID) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${signToken(u)}` })
const api = async (method, p, body, u = USER_ID) => {
  const res = await fetch(`${baseUrl}/api/texts${p}`, { method, headers: H(u), ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
let docId
before(async () => { docId = (await api('POST', '', { title: 'T', text: SAMPLE })).body.doc.id })

test('保存时翻译成功 → translation=ok 且 cn 落库', async () => {
  const created = await api('POST', '', { title: 'ok', text: SAMPLE })
  assert.equal(created.status, 201)
  assert.equal(created.body.translation, 'ok')
  assert.deepEqual(created.body.doc.sentences.map(s => s.cn), ['中文0', '中文1'])
  assert.equal(created.body.doc.cnReady, true)
  assert.equal(created.body.doc.missingCn, 0)
})

test('翻译部分失败 → partial，缺的中文可再次补齐', async () => {
  translateMode = 'partial'
  const created = await api('POST', '', { title: 'p', text: SAMPLE })
  assert.equal(created.body.translation, 'partial')
  assert.equal(created.body.doc.sentences[1].cn, '')
  translateMode = 'ok'
  const fixed = await api('POST', `/${created.body.doc.id}/translate`)
  assert.equal(fixed.status, 200)
  assert.equal(fixed.body.translation, 'ok')
  assert.deepEqual(fixed.body.doc.sentences.map(s => s.cn), ['中文0', '中文1'])
})

test('翻译全部失败 → unavailable，但文本仍然保存成功', async () => {
  translateMode = 'fail'
  const created = await api('POST', '', { title: 'f', text: SAMPLE })
  assert.equal(created.status, 201)
  assert.equal(created.body.translation, 'unavailable')
  assert.equal(created.body.doc.sentences.length, 2)
  translateMode = 'ok'
})

test('跟读评分：best 取历史最高，attempts 累加', async () => {
  let r = await api('POST', `/${docId}/shadow`, { index: 0, score: 82 })
  assert.equal(r.status, 200)
  assert.deepEqual(
    r.body.progress.shadow.map(s => ({ index: s.index, best: s.best, attempts: s.attempts })),
    [{ index: 0, best: 82, attempts: 1 }],
  )
  r = await api('POST', `/${docId}/shadow`, { index: 0, score: 91 })
  assert.equal(r.body.progress.shadow[0].best, 91)
  assert.equal(r.body.progress.shadow[0].attempts, 2)
  r = await api('POST', `/${docId}/shadow`, { index: 0, score: 60 })
  assert.equal(r.body.progress.shadow[0].best, 91)
  assert.equal(r.body.progress.shadow[0].attempts, 3)
})

test('跟读评分入参校验', async () => {
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 0, score: 101 })).status, 400)
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 0, score: 'abc' })).status, 400)
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 99, score: 80 })).status, 400)
  assert.equal((await api('POST', `/${docId}/shadow`, { index: 0, score: 80 }, OTHER)).status, 403)
})

test('回译评分：写入作答记录，第二次 attempts 递增', async () => {
  let r = await api('POST', `/${docId}/review`, { index: 1, userText: 'Unet has encoder and decoder.' })
  assert.equal(r.status, 200)
  assert.equal(r.body.review.verdict, 'minor')
  assert.equal(r.body.review.score, 78)
  assert.equal(r.body.attempts, 1)
  assert.equal(r.body.progress.answers[0].index, 1)
  assert.equal(r.body.progress.answers[0].revealedAnswer, false)
  r = await api('POST', `/${docId}/review`, { index: 1, userText: 'U-Net has an encoder and a decoder.' })
  assert.equal(r.body.attempts, 2)
  assert.equal(r.body.progress.answers.length, 1)
})

test('回译评分入参校验', async () => {
  assert.equal((await api('POST', `/${docId}/review`, { index: 1, userText: '   ' })).status, 400)
  assert.equal((await api('POST', `/${docId}/review`, { index: 1, userText: 'x'.repeat(1001) })).status, 400)
  assert.equal((await api('POST', `/${docId}/review`, { index: 42, userText: 'hi' })).status, 400)
})

test('reveal：未作答不造假，已作答置 revealedAnswer', async () => {
  const fresh = (await api('POST', '', { title: 'fresh', text: SAMPLE })).body.doc.id
  const before = await api('POST', `/${fresh}/reveal`, { index: 0 })
  assert.equal(before.status, 200)
  assert.equal(before.body.progress.answers.length, 0)

  await api('POST', `/${fresh}/review`, { index: 0, userText: 'Unet.' })
  const shown = await api('POST', `/${fresh}/reveal`, { index: 0 })
  assert.equal(shown.body.progress.answers[0].revealedAnswer, true)
})

test('进度：部分更新、cursor=total 合法、越界与非法状态', async () => {
  const fresh = (await api('POST', '', { title: 'progress', text: SAMPLE })).body.doc.id
  let r = await api('PUT', `/${fresh}/progress`, { shadowCursor: 2 })
  assert.equal(r.body.progress.shadowCursor, 2)
  assert.equal(r.body.progress.translateCursor, 0)
  r = await api('PUT', `/${fresh}/progress`, { translateCursor: 1 })
  assert.equal(r.body.progress.shadowCursor, 2)
  assert.equal(r.body.progress.translateCursor, 1)
  r = await api('PUT', `/${fresh}/progress`, { status: 'completed' })
  assert.equal(r.body.progress.status, 'completed')
  r = await api('PUT', `/${fresh}/progress`, { translateCursor: 3 })
  assert.equal(r.status, 400)
  assert.equal((await api('PUT', `/${fresh}/progress`, { status: 'weird' })).status, 400)
  assert.equal((await api('PUT', `/${fresh}/progress`, { shadowCursor: -1 })).status, 400)
})

test('改名保留进度；改正文才清空进度', async () => {
  const fresh = (await api('POST', '', { title: 'rename', text: SAMPLE })).body.doc.id
  await api('POST', `/${fresh}/shadow`, { index: 0, score: 88 })
  await api('POST', `/${fresh}/review`, { index: 1, userText: 'Unet.' })
  await api('PUT', `/${fresh}/progress`, { shadowCursor: 2, translateCursor: 1 })

  const renamed = await api('PUT', `/${fresh}`, { title: '新标题' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.doc.title, '新标题')
  assert.equal(renamed.body.progress.shadowCursor, 2)
  assert.equal(renamed.body.progress.translateCursor, 1)
  assert.equal(renamed.body.progress.shadow.length, 1)
  assert.equal(renamed.body.progress.answers.length, 1)

  const rewritten = await api('PUT', `/${fresh}`, { text: 'One brand new sentence here.' })
  assert.equal(rewritten.body.progress.shadowCursor, 0)
  assert.equal(rewritten.body.progress.translateCursor, 0)
  assert.equal(rewritten.body.progress.shadow.length, 0)
  assert.equal(rewritten.body.progress.answers.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/routes/texts-ai.test.cjs`
Expected: FAIL — `/shadow` 返回 404（端点未实现）

- [ ] **Step 3: 实现 4 个端点**

- `POST /:id/shadow`：`requireOwnDoc` → 校验 `index` 为 `0..total-1` 整数、`score` 为有限 `0..100`（否则 400 `评分无效`）→ 读 `shadow_json`，同 `index` 存在则 `best = Math.max(旧, score)`、`attempts+1`，否则追加 `{ index, best: score, attempts: 1 }` → `sort((a,b)=>a.index-b.index)` → 回写 `updated_at=datetime('now')` → `{ progress }`。
- `POST /:id/review`：校验 `index`、`userText`（`1..1000`，否则 400 `缺少你的英文答案`）→ `isConfigured()` 假 → 503 `AI 未配置（AI_API_KEY 为空）` → `attempts = min(20, 旧 attempts + 1)` → `buildSentenceReviewPrompt({ title, en, cn, userText, attempt: attempts })` → `chat(..., { temperature: 0.2, maxTokens: 800, timeoutMs: 30000 })`；
  - `chat` 抛错 → 503 `评分失败，请稍后重试`（不写库）
  - `extractJson` 抛错 → 200 `{ review: { verdict:'wrong', score:null, issues:[], better:'', praise:'', hint:'', parseError:true }, attempts, progress }`（不写库）
  - 成功 → upsert `answers_json`（保留旧 `revealedAnswer`），`updated_at=datetime('now')`，返回 `{ review, attempts, progress }`
- `POST /:id/reveal`：校验 `index` → 仅当已存在该 `index` 的作答记录时置 `revealedAnswer=true` 并写库 → `{ progress }`。
- `PUT /:id/progress`：三个字段都可选，**只更新传入的**；`shadowCursor`/`translateCursor` 若传入必须是 `0..total` 整数（否则 400 `进度无效`）；`status` 若传入必须是 `active|completed`（否则 400 `状态无效`）；**不因 cursor 到 total 自动改 status**。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/routes/texts-ai.test.cjs server/routes/texts.test.cjs`
Expected: 两个文件全 PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/texts.cjs server/routes/texts-ai.test.cjs
git commit -m "feat(texts): 跟读评分、回译评分、查看原文与进度 API"
```

---

### Task 5: 前端纯函数工具

**Files:**
- Create: `src/utils/textPractice.js`
- Test: `src/utils/textPractice.test.js`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces（Task 7/8 使用）：`cnReady`、`missingCnCount`、`shadowDoneCount`、`translateDoneCount`、`percent`、`resumeIndex`、`findShadow`、`reviewFromSavedAnswer`、`avgScore`、`statusLabel`

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cnReady, missingCnCount, shadowDoneCount, translateDoneCount, percent,
  resumeIndex, findShadow, reviewFromSavedAnswer, avgScore, statusLabel,
} from './textPractice.js'

const S = [{ i: 0, en: 'a', cn: '甲', section: '' }, { i: 1, en: 'b', cn: '', section: '' }]

test('cnReady / missingCnCount', () => {
  assert.equal(cnReady([{ cn: '甲' }]), true)
  assert.equal(cnReady(S), false)
  assert.equal(cnReady([]), false)
  assert.equal(missingCnCount(S), 1)
  assert.equal(missingCnCount(undefined), 0)
})

test('已完成计数与百分比', () => {
  assert.equal(shadowDoneCount({ shadow: [{ index: 0 }, { index: 1 }] }), 2)
  assert.equal(shadowDoneCount(null), 0)
  assert.equal(translateDoneCount({ answers: [{ index: 0 }] }), 1)
  assert.equal(translateDoneCount({}), 0)
  assert.equal(percent(3, 12), 25)
  assert.equal(percent(0, 0), 0)
  assert.equal(percent(5, 3), 100)
})

test('resumeIndex：从游标起找第一条没练过的，末尾回退', () => {
  const answers = [{ index: 0 }, { index: 1 }]
  assert.equal(resumeIndex(answers, 0, 4), 2)
  assert.equal(resumeIndex(answers, 2, 4), 2)
  assert.equal(resumeIndex(answers, 4, 4), 3)
  assert.equal(resumeIndex([], 9, 4), 3)
  assert.equal(resumeIndex([], 0, 0), 0)
  assert.equal(resumeIndex([{ index: 0 }, { index: 1 }, { index: 2 }], 0, 3), 0)
})

test('findShadow / reviewFromSavedAnswer / avgScore / statusLabel', () => {
  assert.deepEqual(findShadow([{ index: 1, best: 77 }], 1), { index: 1, best: 77 })
  assert.equal(findShadow([], 3), null)
  assert.equal(findShadow(null, 0), null)
  assert.equal(reviewFromSavedAnswer(null), null)
  assert.deepEqual(
    reviewFromSavedAnswer({ index: 0, score: 80, verdict: 'minor', issues: [], better: 'B', praise: 'P' }),
    { verdict: 'minor', score: 80, issues: [], better: 'B', praise: 'P', hint: '', parseError: false },
  )
  assert.equal(avgScore([{ score: 80 }, { score: null }, { score: 90 }]), 85)
  assert.equal(avgScore([{ score: null }]), null)
  assert.equal(statusLabel('completed'), '已完成')
  assert.equal(statusLabel('active'), '进行中')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/utils/textPractice.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/utils/textPractice.js`**

按签名实现，注意：`percent` 对 `total <= 0` 返回 `0`、超过 100 钳到 100、结果 `Math.round`；`resumeIndex(records, cursor, total)` 中 `total <= 0 → 0`，起始 `start = Math.min(Math.max(Math.floor(cursor) || 0, 0), total - 1)`，从 `start` 往上找第一条不在 `records` 里的下标，找不到就返回 `start`；`avgScore` 忽略 `score` 非有限数字的项，全部无效返回 `null`，否则 `Math.round`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/utils/textPractice.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/textPractice.js src/utils/textPractice.test.js
git commit -m "feat(texts): 文本练习前端纯函数工具"
```

---

### Task 6: `ShadowingEvaluator` 增加可选 `onResult` 回调

**Files:**
- Modify: `src/components/ShadowingEvaluator.jsx:75`（签名）与 `engineBackResultDone` 回调（约 `:148-159`）

**Interfaces:**
- Consumes: `parseResult(msg)`
- Produces: `ShadowingEvaluator({ refText, onPracticed, onResult })`，`onResult(parsed)` 在解析成功后调用；不传时行为与现在完全一致

- [ ] **Step 1: 改签名与回调**

`export default function ShadowingEvaluator({ refText, onPracticed, onResult })`；在 `engineBackResultDone` 里：

```js
const parsed = parseResult(msg)
setResult(parsed)
setPhaseSafe('result')
onResult?.(parsed)
```

`engineBackResultDone` 已在 `useCallback` 依赖里，补 `onResult`。不改任何渲染逻辑、不改 `onPracticed` 的调用时机。

- [ ] **Step 2: 验证既有调用方未受影响**

Run: `npx eslint src/components/ShadowingEvaluator.jsx src/pages/VideoDetail.jsx`
Expected: 0 error（`VideoDetail` 两处调用仍只传 `refText`/`onPracticed`）

- [ ] **Step 3: Commit**

```bash
git add src/components/ShadowingEvaluator.jsx
git commit -m "feat(shadow): ShadowingEvaluator 支持可选 onResult 回调"
```

---

### Task 7: 文本练习列表页（粘贴 / 编辑 / 删除 / 继续）

**Files:**
- Create: `src/pages/TextPracticePage.jsx`

**Interfaces:**
- Consumes: `useAuth()` 的 `authFetch`/`isGuest`；API `GET /texts`、`POST /texts`、`PUT /texts/:id`、`DELETE /texts/:id`；Task 5 的 `shadowDoneCount`/`translateDoneCount`/`percent`/`statusLabel`
- Produces: 路由组件（Task 9 挂载）

- [ ] **Step 1: 实现页面**

结构（Tailwind，参考 `DialoguePage` 的卡片语言）：

- 外层 `min-h-screen bg-slate-50`；内容容器 `mx-auto w-full max-w-3xl px-4 py-5 space-y-4`。
- 头部：`ArrowLeft`（→ `/profile`）、标题「📄 文本练习」、右侧「+ 粘贴新文本」按钮（`bg-indigo-600 text-white`）。
- 游客：`useEffect` 内 `navigate('/login', { state: { from: '/texts' } })`（照 `SpeakPracticePage` 写法）。
- 编辑卡（`mode: 'list' | 'new' | 'edit'`）：标题 `input`（`maxLength=100`）、正文 `textarea`（`maxLength=20000`, `rows={10}`, `font-mono text-xs`）、字数 `{text.length}/20000`（超过 18000 变 `text-rose-600`）、提示「支持 Markdown：标题、列表、表格会被正确拆分；代码块会被忽略」、主按钮（保存中 `disabled` + spinner，文案「保存并生成中文」/「保存」）、取消、错误红字。
- 提交：`POST /texts` 或 `PUT /texts/:id`（编辑时若正文有改动，先 `window.confirm('修改正文会重新拆句并清空这篇文本的练习进度，继续？')`；只改标题不弹）。成功后 `navigate('/texts/' + id)`。
- 文档列表卡：标题、`{sentenceCount} 句`、`跟读 {shadowDone}/{sentenceCount}`、`翻译 {translateDone}/{sentenceCount}`、`truncated` 时「仅前 200 句」、`!cnReady` 时黄色徽标「中文未生成」、`statusLabel` 徽章（`completed` 用 emerald，`active` 用 slate）、更新时间（`toLocaleDateString('zh-CN')`）。
- 卡内按钮：「继续学习」（→ `/texts/:id`）、「编辑」（预填标题与 `sourceText`；正文区提示「改正文会清空进度」）、「删除」（`window.confirm('删除后进度不可恢复，确定删除《标题》？')` → `DELETE` → 从列表移除，失败保留并提示）。
- 状态：loading（`border-indigo-200 border-t-indigo-600 animate-spin` 圆环 + 「加载中...」）、error（`AlertTriangle` + 重试按钮重新 `load()`）、空态（「还没有文本」+ 引导文案 + 「粘贴第一段」按钮）。
- 所有 API 失败：`setError` 一律显示中文可读文案（`res.status === 401` → 「登录已过期，请重新登录」）。

- [ ] **Step 2: 验证**

Run: `npx eslint src/pages/TextPracticePage.jsx && npm run build`
Expected: lint 0 error，构建成功

- [ ] **Step 3: 手动检查（桌面 + 移动）**

`npm run server` + `npm run dev` 后，浏览器开 `/texts`：粘贴一段含表格与 `SAM`/`U-Net` 的 README → 保存 → 自动进详情；返回列表能看到 `N 句` 与两个计数；只改标题不弹确认；改正文弹确认；删除弹确认并消失。在 390px 宽度下按钮不换行、textarea 不溢出。

- [ ] **Step 4: Commit**

```bash
git add src/pages/TextPracticePage.jsx
git commit -m "feat(texts): 文本练习列表页（粘贴/编辑/删除/继续学习）"
```

---

### Task 8: 文本详情页（逐句跟读 + 汉译英）

**Files:**
- Create: `src/pages/TextDocPage.jsx`

**Interfaces:**
- Consumes: `GET /texts/:id`、`POST /texts/:id/translate`、`POST /texts/:id/review`、`POST /texts/:id/reveal`、`POST /texts/:id/shadow`、`PUT /texts/:id/progress`、`PUT /texts/:id`、`DELETE /texts/:id`；`createSpeaker`；`useSpeechInput`；`ShadowingEvaluator`（`onResult`）；Task 5 工具函数
- Produces: 路由组件（Task 9 挂载）

- [ ] **Step 1: 实现页面骨架与数据流**

- 路由参数 `const { id } = useParams()`；`load()` 拉 `GET /texts/:id` → `{ doc, progress, aiConfigured }`；`doc.sentences`、`progress` 存 state；`tab` state（`'shadow' | 'translate'`）；`idx` 初始 `resumeIndex(progress.answers, progress.translateCursor, doc.sentences.length)`（切到跟读 tab 时用 `resumeIndex(progress.shadow, progress.shadowCursor, total)`）。
- `status === 'completed'` 且 `tab === 'translate'` → 默认渲染完成面板（不渲染句卡）。
- loading / 404（`res.status === 404` → 「文本不存在或已删除」）/ 其它错误（重试）。
- sticky 头部 `sticky top-0 z-20 bg-white/95 backdrop-blur border-b`：返回（→ `/texts`）、标题（`truncate`，点击弹 `prompt('编辑标题', title)` → `PUT { title }`）、`⋯` 菜单（重新生成中文 / 删除 / 回列表）。
- 横幅：`missingCnCount > 0` → 黄色卡「有 N 句还没有中文翻译」+「生成中文翻译」；`doc.truncated` → 「正文较长，仅保留前 200 句」；`!aiConfigured` → 「AI 未配置，中文翻译与评分不可用」。

- [ ] **Step 2: 实现「逐句跟读」Tab**

- 进度条：`percent(shadowDone, total)` + `跟读 {shadowDone}/{total}`。
- 当前句卡：`section` 小标（空则不显示）→ 英文原句（`text-lg font-bold leading-relaxed`）→ 行内按钮：`Volume2` 播放（`speaker.speak(en)`）、「显示中文」（toggle，`text-xs text-slate-500`）→ `ShadowingEvaluator key={idx} refText={sentence.en} onResult={r => saveShadow(idx, r)}`。
- `saveShadow(index, result)`：`const overall = Number(result?.overall)`；`if (!Number.isFinite(overall)) return`；`POST /texts/:id/shadow` → `setProgress`；随后 `PUT /progress { shadowCursor: Math.min(index + 1, total) }`；失败只 `setToast('分数保存失败')`，不阻断。
- 跳句条：`doc.sentences.map(...)` 生成小圆点按钮，`findShadow(progress.shadow, i)` 有记录 → emerald，当前 → indigo，其余 slate；横向 `overflow-x-auto`。
- 上一句/下一句按钮（首尾禁用）；切换时 `speaker.stop()`。
- `useEffect(() => () => speaker.stop(), [])` 防卸载后继续播。

- [ ] **Step 3: 实现「汉译英」Tab**

- 进度条：`translate {translateDone}/{total}`。
- 当前句卡：中文译文（`sentence.cn || '（中文未生成）'`，`text-lg font-bold`）→ `textarea`（`value={answer}`，`rows={3}`，`placeholder="用英文表达这句话"`）→ 工具行：`Mic`/`Square` 语音输入（`useSpeechInput`，识别结果**追加**到 `answer`；`listening` 时按钮变红）、「对照原文」（当 `reviewFromSavedAnswer(findAnswer(idx))` 为空时 `disabled`，`title="先提交一次答案"`；点击后 `POST /reveal` 再显示 `sentence.en`）、「提交答案」（`POST /review`，`disabled` 条件：`!answer.trim() || submitting`）。
- 结果卡（`review` 非空）：`verdict` 徽章（correct/minor/wrong 三色）、分数（`font-mono`，null 显示 `—`）、`issues` 列表（类型中文标签：`grammar 语法` / `word_choice 用词` / `collocation 搭配` / `naturalness 地道` / `incomplete 不完整` / `term 术语`）、`better`、`praise`；`parseError` → 「解析失败，请重试」。
- 切换句子：清空 `answer`/`reveal`/`review`，若该句已有作答则用 `reviewFromSavedAnswer` 回填 `review` 与 `userText`。
- 上一句/下一句；最后一句按钮文案「完成练习」→ `PUT /progress { status:'completed' }` → 完成面板。
- 完成面板：`跟读 {shadowDone}/{total} · 翻译 {translateDone}/{total} · 平均分 {avgScore(answers) ?? '—'}`，按钮「继续练习」（`PUT { status:'active' }` 并回到 `resumeIndex` 的位置）、「返回列表」。
- 每次切换句子/提交后 `PUT /progress { translateCursor: idx }`（失败静默）。
- 删除：`window.confirm` → `DELETE` → `navigate('/texts')`。

- [ ] **Step 4: 验证**

Run: `npx eslint src/pages/TextDocPage.jsx && npm run build`
Expected: lint 0 error，构建成功

- [ ] **Step 5: 手动检查**

桌面 1280px 与移动 390px：两个 Tab 都能练；跟读出分后圆点变绿、进度条前进；刷新页面后能回到同一句且显示已保存的评分卡；「对照原文」在未提交时禁用；最后一句点「完成练习」出现面板，刷新后仍显示面板；删掉文本后回到列表。(AI 未配置时横幅正确、不崩。)

- [ ] **Step 6: Commit**

```bash
git add src/pages/TextDocPage.jsx
git commit -m "feat(texts): 文本详情页（逐句跟读 + 汉译英 + 进度续练）"
```

---

### Task 9: 路由接线 + 个人中心入口 + 全量回归

**Files:**
- Modify: `src/main.jsx`（import 两个页面 + 两条 route，放在 `vocab/practice` 之前）
- Modify: `src/pages/Profile.jsx`（`Promise.all` 增加 `/texts`；「生词本」区块后新增「文本练习」区块）
- Modify: `docs/superpowers/specs/2026-10-26-text-practice-design.md`（状态行改「已实现（日期，分支 feat/text-practice）」）

**Interfaces:**
- Consumes: Task 7/8 的页面组件；`GET /texts` 返回 `{ docs, aiConfigured }`
- Produces: `/texts`、`/texts/:id` 可用；个人中心入口可点

- [ ] **Step 1: 加路由**

```jsx
<Route path="texts" element={<TextPracticePage />} />
<Route path="texts/:id" element={<TextDocPage />} />
```

- [ ] **Step 2: 个人中心入口**

- `Promise.all` 里加 `isGuest ? Promise.resolve({ docs: [] }) : authFetch('/texts').then(r => r.json()).catch(() => ({ docs: [] }))`，存 `textDocs`。
- 在「生词本」区块之后追加区块（复用 `.profile-section` / `.profile-section-header` / `.profile-section-link` / `.profile-empty`）：

```jsx
<div className="profile-section">
  <div className="profile-section-header">
    <h2><FileText size={18} /><span>文本练习</span></h2>
    <button type="button" className="profile-section-link" onClick={() => navigate('/texts')}>
      <span>全部文本</span><ChevronRight size={16} />
    </button>
  </div>
  {isGuest ? (
    <div className="profile-empty">
      <p>登录后可保存文本练习进度</p>
      <button onClick={() => navigate('/login')}>登录 / 注册</button>
    </div>
  ) : textDocs.length === 0 ? (
    <div className="profile-empty">
      <p>还没有文本</p>
      <span className="empty-hint">粘贴英文技术文档、论文摘要、README 或邮件，生成跟读与汉译英练习</span>
    </div>
  ) : (
    <div className="profile-video-list">
      {textDocs.slice(0, 4).map(d => (
        <div key={d.id} className="profile-video-item" onClick={() => navigate(`/texts/${d.id}`)}>
          <div className="profile-video-info">
            <h3>{d.title}</h3>
            <div className="profile-video-meta">
              <span>{d.sentenceCount} 句</span>
              <span>跟读 {d.shadowDone}/{d.sentenceCount}</span>
              <span>翻译 {d.translateDone}/{d.sentenceCount}</span>
              {!d.cnReady && <span>中文未生成</span>}
            </div>
          </div>
          <ChevronRight size={18} className="profile-video-play" />
        </div>
      ))}
    </div>
  )}
</div>
```

`lucide-react` 已依赖，`FileText` 直接 import。

- [ ] **Step 3: 全量自动回归**

Run: `node --test src/utils server/routes server/services server/lib`
Expected: 全 PASS（含 Task 1–5 新增的 5 个测试文件）

Run: `npm run lint && npm run build`
Expected: 0 error / 构建成功

- [ ] **Step 4: 端到端手动回归**

1. 登录账号 → 个人中心：生词本下方出现「文本练习」，空态文案正确；游客账号看到登录引导。
2. 粘贴一段真实技术 README（含 `#` 标题、列表、`|` 表格、`` `inline code` ``、`SAM`/`U-Net`/`PaCMAP`）→ 保存 → 中文生成，术语**未被翻译**，表格每格成句，代码块被忽略。
3. 跟读一句（点麦克风 → 结束录音）→ 出分 → 圆点变绿、进度前进；刷新页面仍在同一句。
4. 汉译英一句：故意把 `U-Net` 写成 `Unet` → 评分指出术语问题；换一种同义但正确的说法 → 得高分/`correct`。
5. 未提交时「对照原文」禁用；提交后可查看原文，刷新后仍记得已查看。
6. 只改标题 → 进度保留；改正文 → 弹确认 → 进度清零、中文重新生成。
7. 删除文本 → 回列表且消失；`GET /api/texts/:id` 404。
8. 回归既有功能：视频详情页跟读（拖到句末不跳句）、听写、完形、AI 对话、中译英对话、自由表达、生词听练各打开一次，控制台无报错。
9. 375px / 768px / 1280px 三档宽度检查两个新页面布局。

- [ ] **Step 5: Commit**

```bash
git add src/main.jsx src/pages/Profile.jsx docs/superpowers/specs/2026-10-26-text-practice-design.md
git commit -m "feat(texts): 路由与个人中心入口，文本练习文档定稿"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 数据模型 → Task 1；§4 切句 → Task 1；§5 AI → Task 2；§6 API（10 端点）→ Task 3/4；§7.1/7.2/7.3/7.4 → Task 9/9/7/8；§7.5 → Task 5；§8 异常 1–12 → 分别在 Task 3（AI 降级/校验/删除）、Task 4（评分/进度/越权）、Task 7（超长/重复点击）、Task 8（麦克风/AI 横幅/移动端）、Task 9（回归）落地；§9 验证 → Task 9 Step 3/4。
- **Review Focus 测试**：1 → Task 1「无英文 / 空输入」+ Task 3「标题/正文校验」；2 → Task 1「缩写 / 小数 / 版本号 / 首字母」与「行内代码里的点号」；3 → Task 2「翻译 prompt 要求保留术语」+ Task 4「回译评分」；4 → Task 4「改名保留进度；改正文才清空进度」；5 → Task 3「删除 → 204，文档与进度行都没了」。
- **接口一致性**：`splitMarkdown` 返回 `{ units, truncated }`（Task 1 产出、Task 3 消费）；`serializeDoc` 的 `sentences` 直传前端（Task 8 读 `.en`/`.cn`/`.section`）；`progress.shadow[].best`（Task 4 写、Task 5 `findShadow` 读）；`reviewFromSavedAnswer` 输出字段与 `normalizeSentenceReview` 对齐（`verdict/score/issues/better/praise/hint/parseError`）。
