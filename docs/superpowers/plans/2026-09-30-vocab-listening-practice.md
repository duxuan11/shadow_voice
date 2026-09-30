# 生词本「听练一体」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在生词本中新增「听练一体」：看中文 + 听英文 TTS + 拼写/听写，逐次记录单词/短语/句子的练习次数、正确次数与熟练度。

**Architecture:** 复用现有 `/api/vocab` 与 `createSpeaker` TTS，只新增 3 个统计列 + 1 个记录接口；把 `DictationPage` 内的拼写比对引擎抽成纯函数模块，供听练页与视频听写共用；新增一个纯函数模块承载队列/熟练度/汇总逻辑，便于单测。

**Tech Stack:** React 19 + Vite 8 + react-router-dom 7 + Express 5 (CommonJS) + sql.js + Node 内置测试 (`node --test`)。

## Global Constraints

- 分支：`feat/vocab-listening-practice`（已创建）。
- 类型沿用 `word` / `phrase` / `core_phrase`；听练 UI 中 `core_phrase` 显示为「句子」，**不新增 `sentence` 类型、不做数据迁移**。
- 熟练度公式：`round(correct_count / practice_count * 100)`；`practice_count = 0` → 未练；`< 60` 生疏，`60–84` 一般，`≥ 85` 熟练。
- 每道题**只有首次提交**计入统计，「再练一次」不重复计数。
- 入口：个人中心 → 生词本（主）+ 学习记录 → 生词本（次）。
- 游客访问生词 API 返回 401；听练页对游客显示登录提示。
- 复用现有 `dictation-*` / `spell-*` / `vocab-*` CSS 类，新增样式保持 Shadow Voice 现有风格（`#2563eb` / `#f8fafc` / 圆角 8–16px）。
- 手机端按钮 ≥ 44px，`touch-action: manipulation`，不依赖 hover，长内容 `overflow-wrap: anywhere`。
- 测试运行方式：`node --test <file>`（仓库未安装 vitest/jest）。验证命令：`node --test`、`npm run lint`、`npm run build`。
- 不要提交 `data/consolidated.json`、`data/meta.json`、`data/shadow_voice.db`（工作区已有未提交改动）。

---

### Task 1: 抽取拼写比对引擎 `src/utils/spellCheck.js`

**Files:**
- Create: `src/utils/spellCheck.js`
- Create: `src/utils/spellCheck.test.js`
- Modify: `src/pages/DictationPage.jsx:1-51`（删除本地引擎，改为 import）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `normalizeText(text: string): string`
  - `tokenize(text: string): string[]`
  - `checkSpelling(userInput: string, correctText: string): Array<{type:'correct',word:string}|{type:'wrong',user:string,expected:string}|{type:'missing',expected:string}|{type:'extra',user:string}>`
  - `isAllCorrect(results: Array): boolean`

- [ ] **Step 1: 写失败测试** `src/utils/spellCheck.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, tokenize, checkSpelling, isAllCorrect } from './spellCheck.js'

test('tokenize：去标点、合并空白、保留缩写撇号', () => {
  assert.deepEqual(tokenize("Check in, please!"), ['Check', 'in', 'please'])
  assert.deepEqual(tokenize("I don't know"), ['I', "don't", 'know'])
  assert.deepEqual(tokenize('  '), [])
})

test('checkSpelling：全对', () => {
  const r = checkSpelling('I want to check in', 'I want to check in')
  assert.deepEqual(r.map(x => x.type), ['correct', 'correct', 'correct', 'correct', 'correct'])
  assert.equal(isAllCorrect(r), true)
})

test('checkSpelling：错误（user vs expected）', () => {
  const r = checkSpelling('I want too check in', 'I want to check in')
  assert.deepEqual(r[2], { type: 'wrong', user: 'too', expected: 'to' })
  assert.equal(isAllCorrect(r), false)
})

test('checkSpelling：遗漏（末尾少词）', () => {
  const r = checkSpelling('I want to', 'I want to check in')
  assert.deepEqual(r.slice(3), [
    { type: 'missing', expected: 'check' },
    { type: 'missing', expected: 'in' },
  ])
})

test('checkSpelling：多余（末尾多词）', () => {
  const r = checkSpelling('I want to check in now', 'I want to check in')
  assert.deepEqual(r[5], { type: 'extra', user: 'now' })
})

test('checkSpelling：大小写不敏感', () => {
  const r = checkSpelling('CHECK IN', 'check in')
  assert.equal(isAllCorrect(r), true)
})

test('normalizeText：只保留单词字符、空格、连字符、撇号', () => {
  assert.equal(normalizeText('Hello — world!'), 'Hello world')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/spellCheck.test.js`
Expected: FAIL（`Cannot find module './spellCheck.js'`）

- [ ] **Step 3: 实现** `src/utils/spellCheck.js`

```js
// 听写 / 听练共用的逐词比对引擎（纯函数，零依赖）。
// 把用户答案与正确原文按空格切词后逐位比较，区分：
//   correct 正确 / wrong 错误 / missing 遗漏 / extra 多余
// 该模块从 DictationPage.jsx 抽出，行为与抽取前完全一致。

export function normalizeText(text) {
  return String(text ?? '').replace(/[^\w\s'-]/g, '').replace(/\s+/g, ' ').trim()
}

export function tokenize(text) {
  const normalized = normalizeText(text)
  return normalized ? normalized.split(' ') : []
}

export function checkSpelling(userInput, correctText) {
  const userWords = tokenize(userInput)
  const correctWords = tokenize(correctText)
  const maxLen = Math.max(userWords.length, correctWords.length)
  const results = []

  for (let i = 0; i < maxLen; i++) {
    const uw = userWords[i]
    const cw = correctWords[i]

    if (uw === undefined) {
      results.push({ type: 'missing', expected: cw })
    } else if (cw === undefined) {
      results.push({ type: 'extra', user: uw })
    } else if (uw.toLowerCase() === cw.toLowerCase()) {
      results.push({ type: 'correct', word: uw })
    } else {
      results.push({ type: 'wrong', user: uw, expected: cw })
    }
  }
  return results
}

export function isAllCorrect(spellResults) {
  return spellResults.every(r => r.type === 'correct')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/spellCheck.test.js`
Expected: PASS（7 个测试全部通过）

- [ ] **Step 5: 让 `DictationPage.jsx` 改用抽取后的引擎**

在 `src/pages/DictationPage.jsx` 顶部 import 区（`import { mergeAdjacentDuplicateSubtitles } from '../utils/subtitles'` 之后）加一行：

```js
import { checkSpelling, isAllCorrect } from '../utils/spellCheck'
```

然后删除文件中 `// --- Spell-check engine ---` 到 `// --- Main component ---` 之间的整段本地定义（即 `normalizeText` / `tokenize` / `checkSpelling` / `isAllCorrect` 四个函数，约原文件第 11–51 行）。保留其余代码不变。

- [ ] **Step 6: 运行 lint 与构建确认无回归**

Run: `npm run lint && npm run build`
Expected: 无 error（`no-unused-vars` 不应报 `normalizeText`/`tokenize`，因为页面未使用它们）。

- [ ] **Step 7: 提交**

```bash
git add src/utils/spellCheck.js src/utils/spellCheck.test.js src/pages/DictationPage.jsx
git commit -m "refactor(dictation): 抽取拼写比对引擎为纯函数模块"
```

---

### Task 2: 听练纯函数 `src/utils/vocabPractice.js`

**Files:**
- Create: `src/utils/vocabPractice.js`
- Create: `src/utils/vocabPractice.test.js`

**Interfaces:**
- Consumes: `normalizeVocabKey` from `src/utils/vocabulary.js`。
- Produces:
  - `PRACTICE_TYPE_LABELS: { word:'单词', phrase:'短语', core_phrase:'句子' }`
  - `PRACTICE_TYPE_FILTERS: Array<{id:'all'|'word'|'phrase'|'core_phrase', label:string}>`
  - `shuffle(list: T[], rand?: () => number): T[]`
  - `buildPracticeQueue(vocabulary: object[], { type?: string, word?: string }): object[]`
  - `proficiencyFrom(correctCount: number, practiceCount: number): { percent:number, level:'new'|'weak'|'fair'|'good', label:string }`
  - `proficiencyOf(entry: object): { percent:number, level:string, label:string }`
  - `summarizePracticeByType(vocabulary: object[]): Record<'word'|'phrase'|'core_phrase', { type:string, total:number, practiceCount:number, correctCount:number, proficiency:{percent:number,level:string,label:string} }>`

- [ ] **Step 1: 写失败测试** `src/utils/vocabPractice.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRACTICE_TYPE_LABELS,
  shuffle,
  buildPracticeQueue,
  proficiencyFrom,
  proficiencyOf,
  summarizePracticeByType,
} from './vocabPractice.js'

const VOCAB = [
  { word: 'check in', content: 'check in', type: 'phrase', practice_count: 2, correct_count: 2 },
  { word: 'passport', content: 'Passport', type: 'word', practice_count: 4, correct_count: 1 },
  { word: 'it turns out that', content: 'It turns out that ...', type: 'core_phrase', practice_count: 0, correct_count: 0 },
]

test('PRACTICE_TYPE_LABELS：core_phrase 显示为句子', () => {
  assert.equal(PRACTICE_TYPE_LABELS.core_phrase, '句子')
  assert.equal(PRACTICE_TYPE_LABELS.word, '单词')
  assert.equal(PRACTICE_TYPE_LABELS.phrase, '短语')
})

test('shuffle：不改动原数组且保留全部元素', () => {
  const input = [1, 2, 3, 4, 5]
  const out = shuffle(input)
  assert.deepEqual(input, [1, 2, 3, 4, 5])
  assert.deepEqual([...out].sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

test('buildPracticeQueue：按类型筛选', () => {
  assert.equal(buildPracticeQueue(VOCAB, { type: 'all' }).length, 3)
  assert.equal(buildPracticeQueue(VOCAB, { type: 'word' }).length, 1)
  assert.equal(buildPracticeQueue(VOCAB, { type: 'core_phrase' })[0].word, 'it turns out that')
})

test('buildPracticeQueue：?word= 单条成轮（忽略大小写与标点）', () => {
  const q = buildPracticeQueue(VOCAB, { word: 'Check In!' })
  assert.equal(q.length, 1)
  assert.equal(q[0].word, 'check in')
})

test('buildPracticeQueue：未收录 → 空队列', () => {
  assert.deepEqual(buildPracticeQueue(VOCAB, { word: 'nope' }), [])
})

test('proficiencyFrom：未练与等级阈值', () => {
  assert.deepEqual(proficiencyFrom(0, 0), { percent: 0, level: 'new', label: '未练' })
  assert.equal(proficiencyFrom(1, 3).label, '生疏')   // 33
  assert.equal(proficiencyFrom(3, 4).label, '一般')   // 75
  assert.equal(proficiencyFrom(9, 10).label, '熟练')  // 90
})

test('proficiencyFrom：边界 60 / 85', () => {
  assert.equal(proficiencyFrom(3, 5).label, '一般')    // 60
  assert.equal(proficiencyFrom(84, 100).label, '一般') // 84
  assert.equal(proficiencyFrom(85, 100).label, '熟练') // 85
})

test('proficiencyOf：读取条目统计', () => {
  assert.equal(proficiencyOf(VOCAB[1]).label, '生疏') // 1/4 = 25
  assert.equal(proficiencyOf(VOCAB[2]).label, '未练')
})

test('summarizePracticeByType：按类型汇总', () => {
  const s = summarizePracticeByType(VOCAB)
  assert.equal(s.word.total, 1)
  assert.equal(s.word.practiceCount, 4)
  assert.equal(s.word.correctCount, 1)
  assert.equal(s.word.proficiency.percent, 25)
  assert.equal(s.phrase.practiceCount, 2)
  assert.equal(s.core_phrase.proficiency.level, 'new')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/vocabPractice.test.js`
Expected: FAIL（`Cannot find module './vocabPractice.js'`）

- [ ] **Step 3: 实现** `src/utils/vocabPractice.js`

```js
// 生词「听练一体」纯函数：类型标签、洗牌组轮、熟练度、按类型汇总。
// 零副作用，便于单测；页面组件只负责渲染与请求。
import { normalizeVocabKey } from './vocabulary'

// 听练 UI 名称：core_phrase 展示为「句子」（存储 type 不变，不做数据迁移）。
export const PRACTICE_TYPE_LABELS = { word: '单词', phrase: '短语', core_phrase: '句子' }

export const PRACTICE_TYPE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'word', label: '单词' },
  { id: 'phrase', label: '短语' },
  { id: 'core_phrase', label: '句子' },
]

const PRACTICE_TYPES = ['word', 'phrase', 'core_phrase']

/** Fisher-Yates 洗牌；返回新数组，不改动入参。rand 可注入以便测试。 */
export function shuffle(list, rand = Math.random) {
  const out = (list || []).slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * 组装本轮题目队列。
 * - 传 word：单条成轮（按规范化 key 匹配，忽略大小写/标点）。
 * - 否则按 type 筛选后洗牌；type 为 'all' 或空 → 全部。
 */
export function buildPracticeQueue(vocabulary, { type = 'all', word = '' } = {}) {
  const list = vocabulary || []
  const key = normalizeVocabKey(word)
  if (key) {
    const entry = list.find(v => (v.word || normalizeVocabKey(v.content)) === key)
    return entry ? [entry] : []
  }
  const filtered = type && type !== 'all'
    ? list.filter(v => (v.type || 'word') === type)
    : list.slice()
  return shuffle(filtered)
}

/** 由正确/练习次数推导熟练度。不落库，避免状态不一致。 */
export function proficiencyFrom(correctCount, practiceCount) {
  const practice = Number(practiceCount) || 0
  const correct = Number(correctCount) || 0
  if (practice <= 0) return { percent: 0, level: 'new', label: '未练' }
  const percent = Math.round((correct / practice) * 100)
  if (percent < 60) return { percent, level: 'weak', label: '生疏' }
  if (percent < 85) return { percent, level: 'fair', label: '一般' }
  return { percent, level: 'good', label: '熟练' }
}

/** 读取单个生词条目的熟练度。 */
export function proficiencyOf(entry) {
  return proficiencyFrom(entry?.correct_count, entry?.practice_count)
}

/** 按类型汇总练习次数 / 正确次数 / 熟练度（各类型之和）。 */
export function summarizePracticeByType(vocabulary) {
  const out = {}
  for (const type of PRACTICE_TYPES) {
    out[type] = { type, total: 0, practiceCount: 0, correctCount: 0, proficiency: proficiencyFrom(0, 0) }
  }
  for (const entry of vocabulary || []) {
    const type = entry.type || 'word'
    const bucket = out[type]
    if (!bucket) continue
    bucket.total += 1
    bucket.practiceCount += Number(entry.practice_count) || 0
    bucket.correctCount += Number(entry.correct_count) || 0
  }
  for (const type of Object.keys(out)) {
    const b = out[type]
    b.proficiency = proficiencyFrom(b.correctCount, b.practiceCount)
  }
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/vocabPractice.test.js`
Expected: PASS（9 个测试全部通过）

- [ ] **Step 5: 提交**

```bash
git add src/utils/vocabPractice.js src/utils/vocabPractice.test.js
git commit -m "feat(vocab): 听练队列/熟练度/汇总纯函数"
```

---

### Task 3: 后端统计列 + 听练接口

**Files:**
- Modify: `server/db.cjs`（`initSchema` 末尾，生词本迁移段之后）
- Modify: `server/routes/vocab.cjs`（`toEntry` 与新增路由）
- Modify: `server/routes/vocab.test.cjs`（追加测试）

**Interfaces:**
- Consumes: `getDb/run/get/all` from `server/db.cjs`；`authMiddleware`。
- Produces:
  - `GET /api/vocab` 每条 entry 新增 `practice_count:number`、`correct_count:number`、`last_practiced_at:string|null`。
  - `POST /api/vocab/practice` body `{ word: string, correct: boolean }` → `200 {ok:true, entry}`；`400`（空 word / correct 非布尔）；`404`（该用户无此条目）；游客 `401`。

- [ ] **Step 1: 写失败测试** — 在 `server/routes/vocab.test.cjs` 的 `list()` 辅助函数之后追加 `practice()` 辅助函数：

```js
async function practice(word, correct, userId = USER_ID) {
  const res = await fetch(`${baseUrl}/api/vocab/practice`, {
    method: 'POST', headers: authHeaders(userId), body: JSON.stringify({ word, correct }),
  })
  return { status: res.status, body: await res.json() }
}
```

在文件末尾追加测试：

```js
test('听练：首次正确 → practice_count=1 / correct_count=1 / last_practiced_at', async () => {
  await add({ content: 'practice-ok', type: 'word', videoId: 'p1', videoTitle: 'P' })
  const { status, body } = await practice('practice-ok', true)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.entry.practice_count, 1)
  assert.equal(body.entry.correct_count, 1)
  assert.ok(body.entry.last_practiced_at)
})

test('听练：累计正确与错误次数', async () => {
  await add({ content: 'practice-count', type: 'word', videoId: 'p1', videoTitle: 'P' })
  await practice('practice-count', true)
  await practice('practice-count', true)
  await practice('practice-count', false)
  const { body } = await list()
  const entry = body.vocabulary.find(v => v.word === 'practice-count')
  assert.equal(entry.practice_count, 3)
  assert.equal(entry.correct_count, 2)
})

test('听练：未收录单词 → 404', async () => {
  const { status } = await practice('not-in-book', true)
  assert.equal(status, 404)
})

test('听练：correct 非布尔 → 400', async () => {
  await add({ content: 'practice-bad', type: 'word', videoId: 'p1', videoTitle: 'P' })
  const { status } = await practice('practice-bad', 'yes')
  assert.equal(status, 400)
})

test('听练：游客 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/vocab/practice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: 'practice-ok', correct: true }),
  })
  assert.equal(res.status, 401)
})

test('听练：多用户隔离（只统计本人）', async () => {
  // 'privateword' 在上方「多用户隔离」测试中已加入 OTHER_USER
  await practice('privateword', true, OTHER_USER)
  const mine = await list(USER_ID)
  assert.ok(!mine.body.vocabulary.some(v => v.word === 'privateword'))
  const other = await list(OTHER_USER)
  assert.equal(other.body.vocabulary.find(v => v.word === 'privateword').practice_count, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/routes/vocab.test.cjs`
Expected: FAIL（新增测试 404/400，因为接口还不存在；Express 对未知 POST 返回 404）

- [ ] **Step 3: 数据库迁移** — 在 `server/db.cjs` 的 `initSchema()` 末尾（`db.run("UPDATE vocabulary SET type = 'word' ...")` 之后）加入：

```js
  // 听练统计：与生词条目同生命周期（移除生词 → 统计一并删除）。
  ensureColumn('vocabulary', 'practice_count', 'INTEGER DEFAULT 0')
  ensureColumn('vocabulary', 'correct_count', 'INTEGER DEFAULT 0')
  ensureColumn('vocabulary', 'last_practiced_at', 'TEXT')
  // 回填历史行（幂等）。
  db.run('UPDATE vocabulary SET practice_count = 0 WHERE practice_count IS NULL')
  db.run('UPDATE vocabulary SET correct_count = 0 WHERE correct_count IS NULL')
```

- [ ] **Step 4: `toEntry` 返回统计字段** — 在 `server/routes/vocab.cjs` 的 `toEntry` 返回对象中，`phonetic: row.phonetic || '',` 之后加入：

```js
    practice_count: row.practice_count || 0,
    correct_count: row.correct_count || 0,
    last_practiced_at: row.last_practiced_at || null,
```

- [ ] **Step 5: 新增听练接口** — 在 `server/routes/vocab.cjs` 的 `POST /` 路由之后、`DELETE /:word` 之前插入：

```js
// POST /api/vocab/practice — 记录一次听练结果（每道题仅首次提交由前端保证）
// body: { word: string, correct: boolean }
router.post('/practice', authMiddleware, async (req, res) => {
  const body = req.body || {}
  const key = normalizeKey(body.word)
  if (!key) return res.status(400).json({ error: '单词/短语不能为空' })
  if (typeof body.correct !== 'boolean') return res.status(400).json({ error: 'correct 必须为布尔值' })

  await getDb()
  try {
    const existing = get('SELECT * FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, key])
    if (!existing) return res.status(404).json({ error: '生词不存在' })

    run(
      `UPDATE vocabulary
         SET practice_count = COALESCE(practice_count, 0) + 1,
             correct_count = COALESCE(correct_count, 0) + ?,
             last_practiced_at = datetime('now')
       WHERE id = ?`,
      [body.correct ? 1 : 0, existing.id]
    )
    const entry = toEntry(get('SELECT * FROM vocabulary WHERE id = ?', [existing.id]))
    res.json({ ok: true, entry })
  } catch {
    res.status(500).json({ error: '记录失败' })
  }
})
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test server/routes/vocab.test.cjs`
Expected: PASS（原有测试 + 6 个新测试全部通过）

- [ ] **Step 7: 全量后端测试 + lint**

Run: `node --test server && npm run lint`
Expected: 全部通过，无 lint error。

- [ ] **Step 8: 提交**

```bash
git add server/db.cjs server/routes/vocab.cjs server/routes/vocab.test.cjs
git commit -m "feat(vocab): 听练统计列与记录接口"
```

---

### Task 4: 听练页面 + 路由 + 样式

**Files:**
- Create: `src/pages/VocabPracticePage.jsx`
- Modify: `src/main.jsx`（import + 路由）
- Modify: `src/index.css`（文件末尾追加样式）

**Interfaces:**
- Consumes: `createSpeaker` (`src/utils/tts.js`)、`checkSpelling`/`isAllCorrect` (`src/utils/spellCheck.js`)、`normalizeVocabKey`/`VOCAB_TYPE_LABELS` (`src/utils/vocabulary.js`)、Task 2 的 `vocabPractice.js` 全部导出、`useAuth().authFetch/isGuest`。
- Produces: 路由 `/vocab/practice`，支持查询参数 `?word=<content>&type=<type>`（单条成轮）。

- [ ] **Step 1: 创建页面** `src/pages/VocabPracticePage.jsx`

```jsx
import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Headphones, Eye, EyeOff, Send, ChevronRight, RotateCcw, Trash2, RefreshCw,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { createSpeaker } from '../utils/tts'
import { checkSpelling, isAllCorrect } from '../utils/spellCheck'
import { normalizeVocabKey, VOCAB_TYPE_LABELS } from '../utils/vocabulary'
import {
  PRACTICE_TYPE_FILTERS,
  PRACTICE_TYPE_LABELS,
  buildPracticeQueue,
  summarizePracticeByType,
} from '../utils/vocabPractice'

export default function VocabPracticePage() {
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()
  const [searchParams] = useSearchParams()

  const [vocabulary, setVocabulary] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [selectedType, setSelectedType] = useState('all')
  const [phase, setPhase] = useState('setup') // setup | practice | finished
  const [queue, setQueue] = useState([])
  const [index, setIndex] = useState(0)
  const [userInput, setUserInput] = useState('')
  const [result, setResult] = useState(null) // { results, correct }
  const [revealed, setRevealed] = useState(false)
  const [showChinese, setShowChinese] = useState(false)
  const [round, setRound] = useState({ attempted: 0, correct: 0 })

  const attemptedRef = useRef(new Set())
  const deepStartedRef = useRef(false)
  const inputRef = useRef(null)
  const speaker = useMemo(() => createSpeaker(authFetch), [authFetch])

  const current = queue[index] || null
  const currentKey = current ? (current.word || normalizeVocabKey(current.content)) : ''
  const deepWord = searchParams.get('word') || ''

  // 加载生词本
  useEffect(() => {
    if (isGuest) { setLoading(false); return }
    authFetch('/vocab')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('unauthorized'))))
      .then(data => setVocabulary(data.vocabulary || []))
      .catch(() => setLoadError('加载生词本失败'))
      .finally(() => setLoading(false))
  }, [authFetch, isGuest])

  // 离开页面停止 TTS
  useEffect(() => () => speaker.stop(), [speaker])

  function startRound(items) {
    if (!items || items.length === 0) return
    attemptedRef.current = new Set()
    setQueue(items)
    setIndex(0)
    setUserInput('')
    setResult(null)
    setRevealed(false)
    setShowChinese(false)
    setRound({ attempted: 0, correct: 0 })
    setPhase('practice')
  }

  function startByType(type) {
    setSelectedType(type)
    startRound(buildPracticeQueue(vocabulary, { type }))
  }

  // 深链 ?word= → 单条成轮
  useEffect(() => {
    if (deepStartedRef.current || loading || !deepWord || vocabulary.length === 0) return
    deepStartedRef.current = true
    const items = buildPracticeQueue(vocabulary, { word: deepWord })
    if (items.length > 0) startRound(items)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, vocabulary, deepWord])

  // 出题自动播放 TTS
  useEffect(() => {
    if (phase !== 'practice' || !current) return
    speaker.speak(current.content)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, index, queue])

  // 出题自动聚焦
  useEffect(() => {
    if (phase === 'practice' && !result && !revealed && inputRef.current) inputRef.current.focus()
  }, [phase, index, result, revealed])

  async function submit() {
    if (!current) return
    const trimmed = userInput.trim()
    if (!trimmed) return
    const results = checkSpelling(trimmed, current.content)
    const correct = isAllCorrect(results)
    setResult({ results, correct })
    // 每道题仅首次提交计入统计
    if (attemptedRef.current.has(currentKey)) return
    attemptedRef.current.add(currentKey)
    setRound(prev => ({ attempted: prev.attempted + 1, correct: prev.correct + (correct ? 1 : 0) }))
    try {
      const res = await authFetch('/vocab/practice', {
        method: 'POST',
        body: JSON.stringify({ word: current.word || currentKey, correct }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.entry) {
          setVocabulary(prev => prev.map(v =>
            ((v.word || normalizeVocabKey(v.content)) === currentKey ? { ...v, ...data.entry } : v)))
        }
      }
    } catch { /* 统计失败不阻塞练习 */ }
  }

  function retry() {
    setUserInput('')
    setResult(null)
    setRevealed(false)
  }

  function next() {
    if (index < queue.length - 1) {
      setIndex(i => i + 1)
      setUserInput('')
      setResult(null)
      setRevealed(false)
    } else {
      speaker.stop()
      setPhase('finished')
    }
  }

  async function removeCurrent() {
    if (!current) return
    const key = currentKey
    try { await authFetch(`/vocab/${encodeURIComponent(key)}`, { method: 'DELETE' }) } catch { /* ignore */ }
    const nextQueue = queue.filter(v => (v.word || normalizeVocabKey(v.content)) !== key)
    setVocabulary(prev => prev.filter(v => (v.word || normalizeVocabKey(v.content)) !== key))
    setUserInput('')
    setResult(null)
    setRevealed(false)
    if (nextQueue.length === 0 || index >= nextQueue.length) {
      speaker.stop()
      setQueue(nextQueue)
      setPhase('finished')
      return
    }
    setQueue(nextQueue)
    setIndex(index)
  }

  function handleInputKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  if (loading) {
    return <div className="loading-container"><div className="loading-spinner" /><p>加载中...</p></div>
  }

  const summary = summarizePracticeByType(vocabulary)
  const typeCounts = { all: vocabulary.length }
  for (const f of PRACTICE_TYPE_FILTERS) if (f.id !== 'all') typeCounts[f.id] = summary[f.id].total

  return (
    <div className="dictation-page vocab-practice-page">
      <div className="dictation-header">
        <button onClick={() => navigate('/profile')} className="back-btn">
          <ArrowLeft size={20} />
          <span>返回</span>
        </button>
        <div className="dictation-header-center">
          <h1 className="dictation-title">生词听练</h1>
        </div>
      </div>

      {isGuest ? (
        <div className="empty-state">
          <p>登录后可练习生词本</p>
          <button onClick={() => navigate('/login')}>去登录</button>
        </div>
      ) : loadError ? (
        <div className="empty-state"><p>{loadError}</p></div>
      ) : phase === 'setup' ? (
        <div className="vocab-practice-setup">
          {vocabulary.length === 0 ? (
            <div className="empty-state">
              <p>生词本还是空的</p>
              <span className="empty-hint">在视频的「智能重点词卡」中加入生词后即可听练</span>
              <button onClick={() => navigate('/records')}>去生词本看看</button>
            </div>
          ) : (
            <>
              <div className="vocab-filter" role="tablist" aria-label="听练类型">
                {PRACTICE_TYPE_FILTERS.map(f => (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={selectedType === f.id}
                    className={`vocab-filter-btn ${selectedType === f.id ? 'active' : ''}`}
                    onClick={() => setSelectedType(f.id)}
                  >
                    {f.label}
                    <span className="vocab-filter-count">{typeCounts[f.id]}</span>
                  </button>
                ))}
              </div>

              <div className="vocab-practice-stats-wrap">
                <table className="vocab-practice-stats">
                  <thead>
                    <tr>
                      <th>类型</th><th>数量</th><th>练习次数</th><th>正确次数</th><th>熟练度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {['word', 'phrase', 'core_phrase'].map(t => {
                      const s = summary[t]
                      return (
                        <tr key={t}>
                          <td>{PRACTICE_TYPE_LABELS[t]}</td>
                          <td className="num">{s.total}</td>
                          <td className="num">{s.practiceCount}</td>
                          <td className="num">{s.correctCount}</td>
                          <td>
                            <span className={`prof-badge prof-${s.proficiency.level}`}>
                              {s.proficiency.label}{s.proficiency.level !== 'new' ? ` ${s.proficiency.percent}%` : ''}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <button
                onClick={() => startByType(selectedType)}
                disabled={typeCounts[selectedType] === 0}
                className="dictation-action-btn submit-btn vocab-practice-start"
              >
                <Headphones size={18} />
                <span>开始练习</span>
              </button>
            </>
          )}
        </div>
      ) : phase === 'practice' && current ? (
        <>
          <div className="dictation-progress-bar">
            <div
              className="dictation-progress-fill"
              style={{ width: `${((index + (result || revealed ? 1 : 0)) / queue.length) * 100}%` }}
            />
          </div>

          <div className="dictation-stats">
            <span className="stat-item">进度 <strong>{index + 1}</strong> / {queue.length}</span>
            <span className="stat-item stat-done">已练 <strong>{round.attempted}</strong></span>
            <span className="stat-item stat-correct">正确 <strong>{round.correct}</strong></span>
            <span className="stat-item stat-accuracy">
              正确率 <strong>{round.attempted ? Math.round((round.correct / round.attempted) * 100) : 0}%</strong>
            </span>
          </div>

          <div className="dictation-card">
            <div className="vocab-practice-meta">
              <span className={`vocab-type-badge type-${current.type || 'word'}`}>
                {VOCAB_TYPE_LABELS[current.type] || '单词'}
              </span>
              <button
                type="button"
                className="vocab-practice-btn"
                onClick={() => setShowChinese(v => !v)}
              >
                {showChinese ? <EyeOff size={14} /> : <Eye size={14} />}
                <span>{showChinese ? '隐藏中文' : '显示中文'}</span>
              </button>
            </div>

            <div className={`dictation-hint ${showChinese ? 'visible' : 'hidden'}`}>
              {showChinese ? (
                <p className="dictation-chinese">{current.translation || '暂无中文释义'}</p>
              ) : (
                <p className="dictation-chinese-placeholder">
                  <EyeOff size={14} />
                  <span>中文释义已隐藏</span>
                </p>
              )}
            </div>

            <div className="dictation-audio-bar">
              <button onClick={() => speaker.speak(current.content)} className="dictation-replay-btn">
                <Headphones size={18} />
                <span>再听一次</span>
              </button>
              {current.phonetic && <span className="dictation-time">{current.phonetic}</span>}
            </div>

            {!result && !revealed && (
              <div className="dictation-input-area">
                <textarea
                  ref={inputRef}
                  value={userInput}
                  onChange={e => setUserInput(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  className="dictation-input"
                  placeholder="输入你听到的英文…"
                  rows={2}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
                <div className="dictation-action-buttons">
                  <button
                    onClick={submit}
                    disabled={!userInput.trim()}
                    className="dictation-action-btn submit-btn"
                  >
                    <Send size={16} />
                    <span>提交</span>
                  </button>
                  <button onClick={() => speaker.speak(current.content)} className="dictation-action-btn replay-btn">
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={() => setRevealed(true)} className="dictation-action-btn">
                    <Eye size={16} />
                    <span>显示答案</span>
                  </button>
                </div>
                <div className="dictation-input-hints">
                  <span className="input-hint">Enter 提交</span>
                  <span className="input-hint">Shift+Enter 换行</span>
                </div>
              </div>
            )}

            {(result || revealed) && (
              <div className="dictation-review">
                {result && (
                  <div className="spell-result">
                    {result.results.map((r, i) => {
                      if (r.type === 'correct') {
                        return <span key={i} className="spell-word spell-right">{r.word}</span>
                      }
                      if (r.type === 'wrong') {
                        return (
                          <span key={i} className="spell-word-group spell-wrong">
                            <span className="spell-user-word">{r.user}</span>
                            <span className="spell-correct-word">{r.expected}</span>
                          </span>
                        )
                      }
                      if (r.type === 'missing') {
                        return (
                          <span key={i} className="spell-word-group spell-missing">
                            <span className="spell-correct-word">{r.expected}</span>
                          </span>
                        )
                      }
                      if (r.type === 'extra') {
                        return (
                          <span key={i} className="spell-word-group spell-extra">
                            <span className="spell-user-word">{r.user}</span>
                          </span>
                        )
                      }
                      return null
                    })}
                  </div>
                )}

                <div className="spell-answer">
                  <span className="answer-label">正确答案：</span>
                  <span className="answer-text">{current.content}</span>
                </div>

                {result && (
                  <p className={`vocab-practice-verdict ${result.correct ? 'is-correct' : 'is-wrong'}`}>
                    {result.correct ? '✅ 完全正确' : '❌ 有出入，看看上面标红 / 标黄的部分'}
                  </p>
                )}

                <div className="dictation-nav">
                  <button onClick={retry} className="dictation-action-btn">
                    <RotateCcw size={16} />
                    <span>再练一次</span>
                  </button>
                  <button onClick={() => speaker.speak(current.content)} className="dictation-action-btn replay-btn">
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={removeCurrent} className="dictation-action-btn skip-btn">
                    <Trash2 size={16} />
                    <span>移除生词本</span>
                  </button>
                  <button onClick={next} className="dictation-action-btn submit-btn">
                    <span>{index < queue.length - 1 ? '下一题' : '完成'}</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="dictation-finished">
          <div className="finished-icon">🎧</div>
          <h2>本轮完成！</h2>
          <div className="finished-stats">
            <div className="finished-stat">
              <span className="finished-stat-value">{round.attempted}</span>
              <span className="finished-stat-label">已练</span>
            </div>
            <div className="finished-stat">
              <span className="finished-stat-value">{round.correct}</span>
              <span className="finished-stat-label">正确</span>
            </div>
            <div className="finished-stat">
              <span className="finished-stat-value">
                {round.attempted ? Math.round((round.correct / round.attempted) * 100) : 0}%
              </span>
              <span className="finished-stat-label">正确率</span>
            </div>
          </div>
          <div className="finished-actions">
            <button onClick={() => startByType(selectedType)} className="action-btn">
              <RefreshCw size={18} />
              <span>再来一轮</span>
            </button>
            <button onClick={() => navigate('/profile')} className="action-btn">
              <ArrowLeft size={18} />
              <span>返回个人中心</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 注册路由** — `src/main.jsx`：在 `import Profile from './pages/Profile'` 之后加：

```jsx
import VocabPracticePage from './pages/VocabPracticePage'
```

在 `<Route path="profile" element={<Profile />} />` 之后加：

```jsx
            <Route path="vocab/practice" element={<VocabPracticePage />} />
```

- [ ] **Step 3: 追加样式** — 在 `src/index.css` 文件末尾追加：

```css
/* ===== Vocab Practice Page ===== */
.vocab-practice-setup { display: flex; flex-direction: column; gap: 16px; }
.vocab-practice-start { align-self: flex-start; padding: 12px 22px; font-size: 15px; touch-action: manipulation; }
.vocab-practice-stats-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.vocab-practice-stats {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  overflow: hidden;
}
.vocab-practice-stats th,
.vocab-practice-stats td {
  padding: 10px 14px;
  font-size: 13px;
  text-align: left;
  border-bottom: 1px solid #f1f5f9;
  white-space: nowrap;
}
.vocab-practice-stats th { background: #f8fafc; color: #64748b; font-weight: 600; }
.vocab-practice-stats tr:last-child td { border-bottom: none; }
.vocab-practice-stats td.num { font-variant-numeric: tabular-nums; color: #1e293b; }
.prof-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.prof-badge.prof-new { background: #f1f5f9; color: #64748b; }
.prof-badge.prof-weak { background: #fee2e2; color: #dc2626; }
.prof-badge.prof-fair { background: #fef3c7; color: #92400e; }
.prof-badge.prof-good { background: #dcfce7; color: #166534; }
.vocab-practice-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.vocab-practice-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 8px 12px;
  border: 1px solid #c7d2fe;
  color: #4338ca;
  background: #eef2ff;
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
  transition: background 0.15s;
}
.vocab-practice-btn:hover { background: #e0e7ff; }
.vocab-practice-verdict { font-size: 13px; font-weight: 500; }
.vocab-practice-verdict.is-correct { color: #16a34a; }
.vocab-practice-verdict.is-wrong { color: #dc2626; }
.vocab-card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vocab-stat-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #64748b;
  background: #f1f5f9;
  border-radius: 999px;
  padding: 2px 8px;
}
.records-actions { gap: 8px; }
@media (max-width: 640px) {
  .vocab-practice-stats th,
  .vocab-practice-stats td { padding: 8px 10px; font-size: 12px; }
  .vocab-practice-start { width: 100%; justify-content: center; }
}
```

- [ ] **Step 4: 构建 + lint 验证**

Run: `npm run lint && npm run build`
Expected: 无 error，构建产物生成到 `dist/`。

- [ ] **Step 5: 手动冒烟（可选但推荐）**

启动 `npm run server` + `npm run dev`，登录后访问 `/vocab/practice`：能看到类型筛选与统计表；开始练习后自动朗读、可输入、提交后出现逐词比对；点「再听一次 / 显示答案 / 再练一次 / 下一题」均正常。

- [ ] **Step 6: 提交**

```bash
git add src/pages/VocabPracticePage.jsx src/main.jsx src/index.css
git commit -m "feat(vocab): 生词听练页面与路由"
```

---

### Task 5: 入口（个人中心 + 学习记录）

**Files:**
- Modify: `src/pages/Profile.jsx`（import、生词本区标题与按钮、始终渲染该区）
- Modify: `src/pages/LearningRecords.jsx`（import、生词本操作行按钮、卡片听练按钮与统计徽章）

**Interfaces:**
- Consumes: `proficiencyOf` from `src/utils/vocabPractice`；路由 `/vocab/practice`；词条字段 `practice_count`/`correct_count`。
- Produces: 主入口（个人中心 → 生词本）+ 次级入口（学习记录 → 生词本）+ 单条快捷听练。

- [ ] **Step 1: `Profile.jsx` 增加主入口**

在 `import { ... } from 'lucide-react'` 那一行的图标列表中加入 `Headphones`（即改为 `..., Star, Headphones, ...`）。

把「最近生词」整段：

```jsx
      {/* Recent Vocabulary */}
      {vocabulary.length > 0 && (
        <div className="profile-section">
          <div className="profile-section-header">
            <h2>
              <Star size={18} />
              <span>最近生词</span>
            </h2>
            <button className="profile-section-link" onClick={() => navigate('/records')}>
              <span>查看全部</span>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="profile-vocab-tags">
            {vocabulary.slice(0, 12).map((v, i) => (
              <span key={i} className="profile-vocab-tag">{v.content || v.word}</span>
            ))}
          </div>
        </div>
      )}
```

替换为：

```jsx
      {/* 生词本（主入口：个人中心 → 生词本 → 听练） */}
      <div className="profile-section">
        <div className="profile-section-header">
          <h2>
            <Star size={18} />
            <span>生词本</span>
          </h2>
          <div className="profile-section-actions">
            <button className="profile-section-link" onClick={() => navigate('/vocab/practice')}>
              <Headphones size={16} />
              <span>听练</span>
            </button>
            <button className="profile-section-link" onClick={() => navigate('/records')}>
              <span>查看全部</span>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        {vocabulary.length === 0 ? (
          <div className="profile-empty">
            <p>还没有生词</p>
            <span className="empty-hint">在视频的「智能重点词卡」中点击「加入生词本」</span>
          </div>
        ) : (
          <div className="profile-vocab-tags">
            {vocabulary.slice(0, 12).map((v, i) => (
              <span key={i} className="profile-vocab-tag">{v.content || v.word}</span>
            ))}
          </div>
        )}
      </div>
```

- [ ] **Step 2: `Profile.jsx` 增加 `.profile-section-actions` 样式** — 在 `src/index.css` 的 `.profile-section-link` 规则附近追加：

```css
.profile-section-actions { display: flex; align-items: center; gap: 8px; }

.profile-section-actions .profile-section-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  touch-action: manipulation;
}
```

- [ ] **Step 3: `LearningRecords.jsx` 增加次级入口与卡片快捷听练**

把 import 行：

```jsx
import { BookOpen, Clock, Trash2, Play, Star, MessageSquare } from 'lucide-react'
```

改为：

```jsx
import { BookOpen, Clock, Trash2, Play, Star, MessageSquare, Headphones } from 'lucide-react'
```

并新增一行：

```jsx
import { proficiencyOf } from '../utils/vocabPractice'
```

把生词本 tab 的操作行：

```jsx
          {vocabulary.length > 0 && (
            <div className="records-actions">
              <button onClick={clearVocabulary} className="danger-btn">
                <Trash2 size={16} />
                <span>清空生词本</span>
              </button>
            </div>
          )}
```

替换为：

```jsx
          {vocabulary.length > 0 && (
            <div className="records-actions">
              <button onClick={() => navigate('/vocab/practice')} className="vocab-practice-btn">
                <Headphones size={16} />
                <span>听练</span>
              </button>
              <button onClick={clearVocabulary} className="danger-btn">
                <Trash2 size={16} />
                <span>清空生词本</span>
              </button>
            </div>
          )}
```

把卡片底部：

```jsx
                        <div className="vocab-card-foot">
                          <span className="vocab-date-cell">加入于 {formatVocabDate(entry.created_at)}</span>
                          <button
                            type="button"
                            className="vocab-remove-btn"
                            onClick={() => removeVocabWord(entry)}
                            disabled={busy}
                            aria-label="移除生词"
                          >
                            <Trash2 size={16} />
                            <span>{busy ? '移除中' : '移除'}</span>
                          </button>
                        </div>
```

替换为：

```jsx
                        <div className="vocab-card-foot">
                          <span className="vocab-date-cell">
                            加入于 {formatVocabDate(entry.created_at)}
                            {(() => {
                              const p = proficiencyOf(entry)
                              return (
                                <span className="vocab-stat-badge">
                                  练习 {entry.practice_count || 0} 次
                                  {entry.practice_count ? ` · 正确率 ${p.percent}% · ${p.label}` : ' · 未练'}
                                </span>
                              )
                            })()}
                          </span>
                          <div className="vocab-card-actions">
                            <button
                              type="button"
                              className="vocab-practice-btn"
                              onClick={() => navigate(
                                `/vocab/practice?word=${encodeURIComponent(entry.content || entry.word)}&type=${entry.type || 'word'}`
                              )}
                            >
                              <Headphones size={14} />
                              <span>听练</span>
                            </button>
                            <button
                              type="button"
                              className="vocab-remove-btn"
                              onClick={() => removeVocabWord(entry)}
                              disabled={busy}
                              aria-label="移除生词"
                            >
                              <Trash2 size={16} />
                              <span>{busy ? '移除中' : '移除'}</span>
                            </button>
                          </div>
                        </div>
```

- [ ] **Step 4: 构建 + lint 验证**

Run: `npm run lint && npm run build`
Expected: 无 error。

- [ ] **Step 5: 手动冒烟**

登录后：个人中心出现「生词本」区与「听练」按钮 → 进入听练页；学习记录 → 生词本 tab 出现「听练」按钮；单张卡片「听练」进入单条练习并自动朗读。

- [ ] **Step 6: 提交**

```bash
git add src/pages/Profile.jsx src/pages/LearningRecords.jsx src/index.css
git commit -m "feat(vocab): 个人中心与生词本听练入口"
```

---

### Task 6: 文档 + 全量验证

**Files:**
- Modify: `README.md`（功能概览、页面路由、API 接口）

**Interfaces:**
- Consumes: 前 5 个任务的成果。
- Produces: 更新后的文档与绿灯验证结果。

- [ ] **Step 1: 功能概览加一节** — 在 README 的 `### 📊 学习记录` 小节之后（`### 🔐 用户系统` 之前）插入：

```markdown
### 🎧 生词听练（听练一体）
- **入口**：个人中心 → 生词本 → 听练；学习记录 → 生词本 也有「听练」按钮，单张卡片可快捷听练
- **玩法**：听英文 TTS → 拼写/听写 → 立即逐词比对（正确 / 错误 / 遗漏 / 多余）→ 再听一次 / 显示答案 / 再练一次 / 下一题
- **类型**：单词 / 短语 / 句子（句子即词卡的「核心短语」）/ 全部
- **统计**：单词、短语、句子分别记录练习次数、正确次数与熟练度（首次提交计入），刷新或重新登录后保持；可在听练中直接移除生词
```

- [ ] **Step 2: 页面路由加一行** — 在 `| /records | 学习记录 |` 之后插入：

```markdown
| `/vocab/practice` | 生词听练（支持 `?word=&type=` 单条成轮） |
```

- [ ] **Step 3: API 接口加一行** — 在 `| DELETE | `/api/vocab/:word` | 按规范化内容删除生词 | ✅ |` 之后插入：

```markdown
| POST | `/api/vocab/practice` | 记录一次听练（`{word, correct}`，累计练习/正确次数） | ✅ |
```

- [ ] **Step 4: 全量验证**

Run:
```bash
node --test
npm run lint
npm run build
```
Expected:
- `node --test`：所有 `*.test.js` / `*.test.cjs` / `*.test.mjs` 通过。
- `npm run lint`：无 error。
- `npm run build`：构建成功。

如果任一失败，先在当前分支修复，再重新运行，直到三项全绿。

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: 生词听练功能说明"
```

- [ ] **Step 6: 汇总改动**

Run: `git log --oneline main..HEAD && git diff --stat main..HEAD`
把修改文件清单与测试结果整理成最终汇报。

---

## 自查记录（spec 覆盖对照）

- 「入口放在个人中心 → 生词本」→ Task 5 Step 1（主入口）；次级入口 Task 5 Step 3。
- 「单词 / 短语 / 句子 / 全部 选择」→ Task 2 `PRACTICE_TYPE_FILTERS` + Task 4 选择器。
- 「播放 TTS、输入英文、中文提示可切换」→ Task 4（`createSpeaker` + `显示中文` 开关）。
- 「提交后区分正确/错误/遗漏/多余 + 四个操作」→ Task 1 引擎 + Task 4 review 区。
- 「单词/短语/句子分别记录练习次数/正确次数/熟练度，刷新/重新登录保持，与生词本关联」→ Task 3（列 + 接口）+ Task 2（汇总）+ Task 4（统计表）。
- 「复用 /api/vocab、TTS、认证、数据库、现有听写逻辑」→ Task 1（抽引擎）+ Task 3（复用 vocab 路由）+ Task 4（复用 `createSpeaker`）。
- 「PC 与手机适配」→ Task 4 样式（≥44px、横向滚动、媒体查询）。
- 「保持简单、不加多余功能」→ 未引入 SRS/记忆曲线/AI 出题。
- 「运行 lint/build 并修复」→ Task 4/5/6 的验证步骤。
