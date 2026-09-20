# 视频学习状态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个视频增加 Not Learned / Learning / Learned 动态学习状态（3 项练习任务，完成度 ≥75%），并在视频列表显示徽章与筛选。

**Architecture:** 新增 `practice_records` 表（每 user+video 一行 JSON，复用 `dictation_records` 模式）与 `/api/practice` 路由；前端纯函数 `learningStatus.js` 计算完成度与状态，`practiceRecords.js` 封装登录/游客读写；VideoDetail 三个内联练习 tab 埋点，Library 显示徽章和筛选。

**Tech Stack:** Express 5 + sql.js（CJS `.cjs`）、React 19 + Vite（ESM）、`node:test`（Node 22 原生，无新增依赖）。

## Global Constraints

- 分支：`feat/video-learning-status`（已创建）。
- 核心任务集合固定为三项：`shadow`（跟读）、`cloze`（挖空）、`translate`（中译英）。**不计**听写、观看进度、AI 对话。
- 状态键固定：`not_learned` / `learning` / `learned`；阈值固定 `0.75`。
- 完成度 = 三项完成率的算术平均；每项完成率 = 该任务去重句数 ÷ `subtitle_count`，并夹到 `1`。
- 状态判定顺序：三项计数全 0 → `not_learned`；否则 `progress >= 0.75` → `learned`；其余 → `learning`。
- 不新增任何 npm 依赖。
- 前端为 ESM（`type: module`），后端为 CJS（`.cjs`）。
- 测试命令统一用 `node --test <file>`；每个后端测试文件在自身文件顶部设置 `process.env.SHADOW_VOICE_DB` 指向临时库（照 `server/routes/history.test.cjs`）。
- 提交信息用中文 `type(scope): 描述` 风格（与本仓库一致）。
- 只提交本功能相关文件；**不要**提交 `data/consolidated.json`、`data/meta.json`、`data/shadow_voice.db` 这三个已存在的本地改动。

---

### Task 1: 后端 `practice_records` 表 + `/api/practice` 路由

**Files:**
- Modify: `server/db.cjs`（`initSchema()` 内新增表）
- Modify: `server/db.test.cjs`（表存在性清单加入 `practice_records`）
- Create: `server/routes/practice.cjs`
- Modify: `server/index.cjs`（require + `app.use('/api/practice', ...)`）
- Test: `server/routes/practice.test.cjs`

**Interfaces:**
- Consumes: `server/db.cjs` 的 `getDb/run/get/all`；`server/auth.cjs` 的 `authMiddleware/signToken`。
- Produces:
  - 表 `practice_records(user_id, video_id, data TEXT, updated_at, UNIQUE(user_id,video_id))`，`data` 形如 `{ "shadow": number[], "cloze": number[], "translate": number[] }`。
  - `GET /api/practice/summary → { summary: { [videoId]: { shadow, cloze, translate } } }`（值为去重句数）。
  - `GET /api/practice/:videoId → { data: { shadow:[], cloze:[], translate:[] } }`。
  - `POST /api/practice/:videoId` body `{ task, index } → { ok:true, data }`。

- [ ] **Step 1: 写失败测试**

创建 `server/routes/practice.test.cjs`：

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

// 临时库，避免污染真实 data/shadow_voice.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-practice-test-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb, run } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const practiceRoutes = require('./practice.cjs')

const app = express()
app.use(express.json())
app.use('/api/practice', practiceRoutes)

let server, baseUrl
const USER_ID = 7
const OTHER_ID = 8

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise(res => server.once('listening', res))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => { if (server) server.close() })

function authHeaders(userId = USER_ID) {
  return { Authorization: `Bearer ${signToken(userId)}`, 'Content-Type': 'application/json' }
}

function post(videoId, body, userId = USER_ID) {
  return fetch(`${baseUrl}/api/practice/${videoId}`, {
    method: 'POST', headers: authHeaders(userId), body: JSON.stringify(body),
  })
}

test('游客访问 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/practice/summary`)
  assert.equal(res.status, 401)
})

test('无记录 GET 返回空数组', async () => {
  const res = await fetch(`${baseUrl}/api/practice/v-empty`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.data, { shadow: [], cloze: [], translate: [] })
})

test('POST 后 GET 可读', async () => {
  const res = await post('v1', { task: 'shadow', index: 2 })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.data.shadow, [2])

  const get = await fetch(`${baseUrl}/api/practice/v1`, { headers: authHeaders() })
  const got = await get.json()
  assert.deepEqual(got.data.shadow, [2])
})

test('重复 POST 幂等（同句只记一次）', async () => {
  await post('v2', { task: 'cloze', index: 5 })
  await post('v2', { task: 'cloze', index: 5 })
  await post('v2', { task: 'cloze', index: 1 })
  const res = await fetch(`${baseUrl}/api/practice/v2`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual([...body.data.cloze].sort((a, b) => a - b), [1, 5])
})

test('summary 返回各视频三项计数', async () => {
  await post('v3', { task: 'shadow', index: 0 })
  await post('v3', { task: 'shadow', index: 1 })
  await post('v3', { task: 'translate', index: 4 })
  const res = await fetch(`${baseUrl}/api/practice/summary`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual(body.summary.v3, { shadow: 2, cloze: 0, translate: 1 })
})

test('非法 task → 400', async () => {
  const res = await post('v4', { task: 'hack', index: 0 })
  assert.equal(res.status, 400)
})

test('负 index / 非整数 → 400', async () => {
  assert.equal((await post('v4', { task: 'shadow', index: -1 })).status, 400)
  assert.equal((await post('v4', { task: 'shadow', index: 1.5 })).status, 400)
  assert.equal((await post('v4', { task: 'shadow', index: '0' })).status, 400)
})

test('跨用户隔离', async () => {
  await post('v5', { task: 'shadow', index: 0 }, OTHER_ID)
  const res = await fetch(`${baseUrl}/api/practice/v5`, { headers: authHeaders(USER_ID) })
  const body = await res.json()
  assert.deepEqual(body.data.shadow, [])
})

test('损坏 JSON 容错为空', async () => {
  await getDb()
  run('INSERT INTO practice_records (user_id, video_id, data) VALUES (?, ?, ?)', [USER_ID, 'v-corrupt', '{bad json'])
  const res = await fetch(`${baseUrl}/api/practice/v-corrupt`, { headers: authHeaders() })
  const body = await res.json()
  assert.deepEqual(body.data, { shadow: [], cloze: [], translate: [] })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/routes/practice.test.cjs`
Expected: FAIL —— `Cannot find module './practice.cjs'`。

- [ ] **Step 3: 建表**

在 `server/db.cjs` 的 `initSchema()` 里，紧跟 `video_progress` 表定义之后加入：

```js
  db.run(`CREATE TABLE IF NOT EXISTS practice_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id   TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, video_id)
  )`)
```

并修改 `server/db.test.cjs` 的表清单数组，把 `'practice_records'` 加进去：

```js
  for (const t of ['users', 'dictation_records', 'vocabulary', 'video_progress',
    'conversation_sessions', 'conversation_messages', 'ai_cache', 'watch_history',
    'practice_records']) {
```

- [ ] **Step 4: 实现路由**

创建 `server/routes/practice.cjs`：

```js
const express = require('express')
const router = express.Router()
const { authMiddleware } = require('../auth.cjs')
const { getDb, run, get, all } = require('../db.cjs')

const TASKS = ['shadow', 'cloze', 'translate']

const emptyData = () => ({ shadow: [], cloze: [], translate: [] })

// 解析 data JSON，过滤非法项并按任务去重；损坏时返回空结构
function parseData(raw) {
  if (!raw) return emptyData()
  try {
    const obj = JSON.parse(raw)
    const out = emptyData()
    for (const t of TASKS) {
      if (Array.isArray(obj?.[t])) {
        out[t] = [...new Set(obj[t].filter(n => Number.isInteger(n) && n >= 0))]
      }
    }
    return out
  } catch {
    return emptyData()
  }
}

// GET /api/practice/summary — 必须注册在 /:videoId 之前
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const rows = all('SELECT video_id, data FROM practice_records WHERE user_id = ?', [req.userId])
    const summary = {}
    for (const row of rows) {
      const data = parseData(row.data)
      summary[row.video_id] = {
        shadow: data.shadow.length,
        cloze: data.cloze.length,
        translate: data.translate.length,
      }
    }
    res.json({ summary })
  } catch (err) {
    console.error('Failed to load practice summary:', err)
    res.status(500).json({ error: '加载学习状态失败' })
  }
})

// GET /api/practice/:videoId
router.get('/:videoId', authMiddleware, async (req, res) => {
  try {
    await getDb()
    const row = get(
      'SELECT data FROM practice_records WHERE user_id = ? AND video_id = ?',
      [req.userId, req.params.videoId]
    )
    res.json({ data: row ? parseData(row.data) : emptyData() })
  } catch (err) {
    console.error('Failed to load practice record:', err)
    res.status(500).json({ error: '加载练习记录失败' })
  }
})

// POST /api/practice/:videoId  body: { task, index }
router.post('/:videoId', authMiddleware, async (req, res) => {
  try {
    const { task, index } = req.body || {}
    if (!TASKS.includes(task)) return res.status(400).json({ error: '无效的练习类型' })
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: '无效的句子索引' })

    await getDb()
    const row = get(
      'SELECT data FROM practice_records WHERE user_id = ? AND video_id = ?',
      [req.userId, req.params.videoId]
    )
    const data = row ? parseData(row.data) : emptyData()
    if (!data[task].includes(index)) data[task].push(index)

    run(
      `INSERT INTO practice_records (user_id, video_id, data, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, video_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`,
      [req.userId, req.params.videoId, JSON.stringify(data)]
    )
    res.json({ ok: true, data })
  } catch (err) {
    console.error('Failed to save practice record:', err)
    res.status(500).json({ error: '保存练习记录失败' })
  }
})

module.exports = router
```

- [ ] **Step 5: 注册路由**

在 `server/index.cjs`：顶部 require 区加一行

```js
const practiceRoutes = require('./routes/practice.cjs')
```

在 `app.use('/api/asr', asrRoutes.router)` 之后加

```js
app.use('/api/practice', practiceRoutes)
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test server/routes/practice.test.cjs server/db.test.cjs`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add server/db.cjs server/db.test.cjs server/routes/practice.cjs server/routes/practice.test.cjs server/index.cjs
git commit -m "feat(practice): 新增练习记录表与 /api/practice 路由"
```

---

### Task 2: 前端完成度纯函数 `learningStatus.js`

**Files:**
- Create: `src/utils/learningStatus.js`
- Test: `src/utils/learningStatus.test.js`

**Interfaces:**
- Produces:
  - `TASKS: string[]` = `['shadow','cloze','translate']`
  - `LEARNED_THRESHOLD: number` = `0.75`
  - `computeVideoProgress(counts: {shadow?:number,cloze?:number,translate?:number}, subtitleCount: number): number`（返回 0..1）
  - `hasAnyPractice(counts): boolean`
  - `getLearningStatus(counts, progress): 'not_learned'|'learning'|'learned'`

- [ ] **Step 1: 写失败测试**

创建 `src/utils/learningStatus.test.js`：

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASKS, LEARNED_THRESHOLD, computeVideoProgress, hasAnyPractice, getLearningStatus,
} from './learningStatus.js'

describe('computeVideoProgress', () => {
  it('无记录为 0', () => {
    assert.equal(computeVideoProgress({}, 100), 0)
    assert.equal(computeVideoProgress(null, 100), 0)
  })

  it('三项完成率取算术平均', () => {
    const p = computeVideoProgress({ shadow: 100, cloze: 80, translate: 50 }, 100)
    assert.ok(Math.abs(p - (1 + 0.8 + 0.5) / 3) < 1e-9)
  })

  it('单项完成率夹到 1（防超 100%）', () => {
    const p = computeVideoProgress({ shadow: 150, cloze: 0, translate: 0 }, 100)
    assert.ok(Math.abs(p - 1 / 3) < 1e-9)
  })

  it('subtitleCount 非法或为 0 时返回 0', () => {
    assert.equal(computeVideoProgress({ shadow: 5 }, 0), 0)
    assert.equal(computeVideoProgress({ shadow: 5 }, undefined), 0)
    assert.equal(computeVideoProgress({ shadow: 5 }, NaN), 0)
  })

  it('缺少任务字段按 0 处理', () => {
    assert.ok(Math.abs(computeVideoProgress({ shadow: 30 }, 100) - 0.1) < 1e-9)
  })
})

describe('hasAnyPractice', () => {
  it('全 0 / 空 → false', () => {
    assert.equal(hasAnyPractice({}), false)
    assert.equal(hasAnyPractice({ shadow: 0, cloze: 0, translate: 0 }), false)
    assert.equal(hasAnyPractice(null), false)
  })
  it('有任一非 0 → true', () => {
    assert.equal(hasAnyPractice({ translate: 1 }), true)
  })
})

describe('getLearningStatus', () => {
  it('全 0 → not_learned', () => {
    assert.equal(getLearningStatus({}, 0), 'not_learned')
  })
  it('有记录但 <75% → learning', () => {
    assert.equal(getLearningStatus({ shadow: 10 }, 0.5), 'learning')
    assert.equal(getLearningStatus({ shadow: 10 }, 0.749), 'learning')
  })
  it('>=75% → learned', () => {
    assert.equal(getLearningStatus({ shadow: 10 }, 0.75), 'learned')
    assert.equal(getLearningStatus({ shadow: 10 }, 1), 'learned')
  })
  it('有记录但 progress 为 0（分母异常）→ learning', () => {
    assert.equal(getLearningStatus({ shadow: 5 }, 0), 'learning')
  })
})

describe('常量', () => {
  it('任务与阈值固定', () => {
    assert.deepEqual(TASKS, ['shadow', 'cloze', 'translate'])
    assert.equal(LEARNED_THRESHOLD, 0.75)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/learningStatus.test.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `src/utils/learningStatus.js`：

```js
// 视频学习状态：以视频为单位，由三项练习记录算出完成度。
// 任务：跟读 / 挖空 / 中译英。完成度 = 三项（去重句数 / 字幕总句数）的算术平均。
// 状态：全 0 → not_learned；>= 75% → learned；其余 → learning。

export const TASKS = ['shadow', 'cloze', 'translate']
export const LEARNED_THRESHOLD = 0.75

function countOf(counts, task) {
  const n = Number(counts?.[task])
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function computeVideoProgress(counts, subtitleCount) {
  const total = Number(subtitleCount)
  if (!Number.isFinite(total) || total <= 0) return 0
  const sum = TASKS.reduce((acc, task) => acc + Math.min(1, countOf(counts, task) / total), 0)
  return sum / TASKS.length
}

export function hasAnyPractice(counts) {
  return TASKS.some(task => countOf(counts, task) > 0)
}

export function getLearningStatus(counts, progress) {
  if (!hasAnyPractice(counts)) return 'not_learned'
  return progress >= LEARNED_THRESHOLD ? 'learned' : 'learning'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/learningStatus.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/utils/learningStatus.js src/utils/learningStatus.test.js
git commit -m "feat(learning): 新增视频完成度与状态纯函数"
```

---

### Task 3: 前端练习记录封装 `practiceRecords.js`

**Files:**
- Create: `src/utils/practiceRecords.js`
- Test: `src/utils/practiceRecords.test.js`

**Interfaces:**
- Produces:
  - `PRACTICE_TASKS: string[]`
  - `emptyPracticeData(): { shadow:[], cloze:[], translate:[] }`
  - `addIndex(data, task, index): object`（纯函数；非法参数原样返回，合法时返回去重后的新对象）
  - `loadSummary(authFetch, isGuest): Promise<{ [videoId]: {shadow,cloze,translate} }>`
  - `loadOne(authFetch, isGuest, videoId): Promise<data>`
  - `mark(authFetch, isGuest, videoId, task, index): void`（乐观、静默失败）
  - `markLocal(videoId, task, index)`, `loadLocalOne(videoId)`, `loadLocalSummary()`, `resetLocalPractice()`

- [ ] **Step 1: 写失败测试**

创建 `src/utils/practiceRecords.test.js`：

```js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRACTICE_TASKS, emptyPracticeData, addIndex,
  markLocal, loadLocalOne, loadLocalSummary, resetLocalPractice,
} from './practiceRecords.js'

// 最小 localStorage 替身，供 node:test 环境使用
beforeEach(() => {
  const store = {}
  globalThis.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: k => { delete store[k] },
  }
})

describe('addIndex', () => {
  it('加入新索引并返回新对象', () => {
    const before = emptyPracticeData()
    const after = addIndex(before, 'shadow', 3)
    assert.deepEqual(after.shadow, [3])
    assert.deepEqual(before.shadow, []) // 不可变
  })
  it('重复索引不变', () => {
    const data = addIndex({ shadow: [1] }, 'shadow', 1)
    assert.deepEqual(data.shadow, [1])
  })
  it('非法 task / index 原样返回', () => {
    const data = { shadow: [1] }
    assert.equal(addIndex(data, 'hack', 0), data)
    assert.equal(addIndex(data, 'shadow', -1), data)
    assert.equal(addIndex(data, 'shadow', 1.5), data)
    assert.equal(addIndex(data, 'shadow', '2'), data)
  })
  it('任务与常量一致', () => {
    assert.deepEqual(PRACTICE_TASKS, ['shadow', 'cloze', 'translate'])
  })
})

describe('游客本地存储', () => {
  it('markLocal 去重，loadLocalOne / loadLocalSummary 可读', () => {
    resetLocalPractice()
    markLocal('v1', 'cloze', 2)
    markLocal('v1', 'cloze', 2)
    markLocal('v1', 'translate', 5)
    assert.deepEqual(loadLocalOne('v1').cloze, [2])
    assert.deepEqual(loadLocalSummary().v1, { shadow: 0, cloze: 1, translate: 1 })
  })
  it('无记录返回空结构', () => {
    resetLocalPractice()
    assert.deepEqual(loadLocalOne('nope'), { shadow: [], cloze: [], translate: [] })
    assert.deepEqual(loadLocalSummary(), {})
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/practiceRecords.test.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `src/utils/practiceRecords.js`：

```js
// 练习记录读写：登录用户走 /api/practice，游客存 localStorage。
// 记录粒度是"每句一个标志"，只用于算学习状态，不存录音/评分。

export const PRACTICE_TASKS = ['shadow', 'cloze', 'translate']
const STORAGE_KEY = 'shadow_voice_practice'

export function emptyPracticeData() {
  return { shadow: [], cloze: [], translate: [] }
}

// 纯函数：把 index 并入 task 数组，去重；非法参数原样返回
export function addIndex(data, task, index) {
  const base = data && typeof data === 'object' ? data : {}
  if (!PRACTICE_TASKS.includes(task)) return base
  if (!Number.isInteger(index) || index < 0) return base
  const current = Array.isArray(base[task]) ? base[task] : []
  if (current.includes(index)) return base
  return { ...base, [task]: [...current, index] }
}

function readLocalStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeLocalStore(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)) } catch { /* ignore */ }
}

export function loadLocalOne(videoId) {
  return readLocalStore()[videoId] || emptyPracticeData()
}

export function markLocal(videoId, task, index) {
  const store = readLocalStore()
  store[videoId] = addIndex(store[videoId] || emptyPracticeData(), task, index)
  writeLocalStore(store)
}

export function loadLocalSummary() {
  const summary = {}
  for (const [videoId, data] of Object.entries(readLocalStore())) {
    summary[videoId] = {
      shadow: Array.isArray(data?.shadow) ? data.shadow.length : 0,
      cloze: Array.isArray(data?.cloze) ? data.cloze.length : 0,
      translate: Array.isArray(data?.translate) ? data.translate.length : 0,
    }
  }
  return summary
}

export function resetLocalPractice() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

export async function loadSummary(authFetch, isGuest) {
  if (isGuest) return loadLocalSummary()
  try {
    const res = await authFetch('/practice/summary')
    if (!res.ok) return {}
    const body = await res.json()
    return body.summary || {}
  } catch {
    return {}
  }
}

export async function loadOne(authFetch, isGuest, videoId) {
  if (isGuest) return loadLocalOne(videoId)
  try {
    const res = await authFetch(`/practice/${encodeURIComponent(videoId)}`)
    if (!res.ok) return emptyPracticeData()
    const body = await res.json()
    return { ...emptyPracticeData(), ...(body.data || {}) }
  } catch {
    return emptyPracticeData()
  }
}

// 乐观记录：本地/服务端失败都不阻塞练习 UI
export function mark(authFetch, isGuest, videoId, task, index) {
  if (isGuest) {
    markLocal(videoId, task, index)
    return
  }
  authFetch(`/practice/${encodeURIComponent(videoId)}`, {
    method: 'POST',
    body: JSON.stringify({ task, index }),
  }).catch(() => {})
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/practiceRecords.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/utils/practiceRecords.js src/utils/practiceRecords.test.js
git commit -m "feat(learning): 新增练习记录前端封装（登录/游客）"
```

---

### Task 4: VideoDetail 三处埋点 + ShadowingEvaluator 回调

**Files:**
- Modify: `src/components/ShadowingEvaluator.jsx`
- Modify: `src/pages/VideoDetail.jsx`

**Interfaces:**
- Consumes: `practiceRecords.mark(authFetch, isGuest, videoId, task, index)`（Task 3）。
- Produces: 完成练习后写入记录：
  - 跟读：`ShadowingEvaluator` 新增可选 prop `onPracticed?: () => void`，在录音结束（手动停 / 超时自动停）时调用。
  - 挖空：`handleSelectClozeOption` 内记录 `('cloze', activeSubIndex)`。
  - 中译英：`handleVerifyTranslation` 内记录 `('translate', activeSubIndex)`。

- [ ] **Step 1: 给 ShadowingEvaluator 加回调**

修改 `src/components/ShadowingEvaluator.jsx`：

1) 函数签名（第 75 行）：

```js
export default function ShadowingEvaluator({ refText, onPracticed }) {
```

2) `stop` 回调（约第 256 行）加入 `onPracticed`：

```js
  const stop = useCallback(() => {
    clearTimers()
    if (engineRef.current) engineRef.current.stopRecord()
    setPhaseSafe('evaluating')
    onPracticed?.()
  }, [clearTimers, setPhaseSafe, onPracticed])
```

3) `start` 内的超时自动停止也要标记。把（约第 236 行）

```js
      timerRef.current = setTimeout(() => { if (engineRef.current) { engineRef.current.stopRecord(); setPhaseSafe('evaluating') } }, MAX_RECORD_MS)
```

改为

```js
      timerRef.current = setTimeout(() => { if (engineRef.current) { engineRef.current.stopRecord(); setPhaseSafe('evaluating') } onPracticed?.() }, MAX_RECORD_MS)
```

4) `start` 的依赖数组（约第 250 行）加入 `onPracticed`：

```js
  }, [clearTimers, getWarrant, ensureEngine, waitInit, refText, setPhaseSafe, onPracticed])
```

- [ ] **Step 2: VideoDetail 引入并定义记录函数**

修改 `src/pages/VideoDetail.jsx`：

1) import 区加入：

```js
import { mark as markPractice } from '../utils/practiceRecords'
```

2) 在 `handleSelectClozeOption` 之前（`currentSub` 计算在更后面，`activeSubIndex` state 已定义）定义回调：

```js
  // ── 学习状态埋点：练习过即记录（不要求答对/评测成功）──
  const recordPractice = useCallback((task, index) => {
    if (!id || !Number.isInteger(index) || index < 0) return
    markPractice(authFetch, isGuest, id, task, index)
  }, [id, authFetch, isGuest])
```

3) 挖空 handler 加一行：

```js
  const handleSelectClozeOption = (option) => {
    setSelectedClozeWord(option)
    setIsClozeCorrect(option.toLowerCase().replace(/[^a-zA-Z]/g, '') === clozeTargetWord.toLowerCase().replace(/[^a-zA-Z]/g, ''))
    recordPractice('cloze', activeSubIndex)
  }
```

4) 中译英 handler 加一行：

```js
  const handleVerifyTranslation = () => {
    if (!currentSub) return
    const cleanText = currentSub.textEn.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim()
    setIsTranslateCorrect(selectedTranslateChips.join(' ').toLowerCase().trim() === cleanText)
    recordPractice('translate', activeSubIndex)
  }
```

5) 两处 `<ShadowingEvaluator ... />`（分别约第 690、1089 行）都加上回调：

```jsx
<ShadowingEvaluator key={currentSub.id} refText={currentSub.textEn} onPracticed={() => recordPractice('shadow', activeSubIndex)} />
```

- [ ] **Step 3: 静态检查**

Run: `npm run lint`
Expected: 无新增 error（`onPracticed` 已在依赖数组、无未使用变量）。

- [ ] **Step 4: 手动验证（需后端）**

```bash
npm run server   # 终端 A
npm run dev      # 终端 B，登录一个账号
```

在浏览器：进入任一视频 → 分别做一次「跟读录音停止」「挖空选一个选项」「中译英提交」→ 打开 DevTools Network，确认每次出现 `POST /api/practice/<id>` 且 body 为 `{"task":"shadow|cloze|translate","index":N}`；刷新后 `GET /api/practice/summary` 返回该视频对应计数 > 0。

- [ ] **Step 5: 提交**

```bash
git add src/components/ShadowingEvaluator.jsx src/pages/VideoDetail.jsx
git commit -m "feat(practice): 视频详情页三处练习埋点"
```

---

### Task 5: Library 状态徽章 + 学习状态筛选

**Files:**
- Modify: `src/pages/Library.jsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `loadSummary`（Task 3）、`computeVideoProgress/hasAnyPractice/getLearningStatus`（Task 2）、`useAuth`。
- Produces: 列表卡片显示 `🔴 Not Learned / 🟡 Learning / 🟢 Learned`，筛选面板新增 `All / Not Learned / Learning / Learned`。

- [ ] **Step 1: Library 引入依赖与状态**

修改 `src/pages/Library.jsx`：

1) 顶部 import：

```js
import { useAuth } from '../context/AuthContext'
import { loadSummary } from '../utils/practiceRecords'
import { computeVideoProgress, hasAnyPractice, getLearningStatus } from '../utils/learningStatus'
```

2) 文件顶部（组件外）加常量：

```js
const STATUS_FILTERS = [
  { label: 'All', key: null },
  { label: 'Not Learned', key: 'not_learned' },
  { label: 'Learning', key: 'learning' },
  { label: 'Learned', key: 'learned' },
]
const STATUS_BADGE = {
  not_learned: '🔴 Not Learned',
  learning: '🟡 Learning',
  learned: '🟢 Learned',
}
```

> 注意：`All` 用 `key: null` 表示不过滤；`statusFilter` 存 label。

3) 组件内加：

```js
  const { authFetch, isGuest } = useAuth()
  const [practiceSummary, setPracticeSummary] = useState({})
  const [statusFilter, setStatusFilter] = useState('All')
```

4) 在现有加载 `consolidated/meta` 的 useEffect 之后加：

```js
  useEffect(() => {
    loadSummary(authFetch, isGuest).then(setPracticeSummary).catch(() => {})
  }, [authFetch, isGuest])
```

5) 计算状态 map（放在 `filteredVideos` 之前）：

```js
  const statusByVideo = useMemo(() => {
    const map = {}
    for (const v of videos) {
      const counts = practiceSummary[v.id] || {}
      const progress = computeVideoProgress(counts, v.subtitle_count)
      map[v.id] = { progress, status: getLearningStatus(counts, progress), hasAny: hasAnyPractice(counts) }
    }
    return map
  }, [videos, practiceSummary])
```

6) `filteredVideos` 的 `useMemo` 内，在 accent 过滤之后加：

```js
    const statusKey = STATUS_FILTERS.find(f => f.label === statusFilter)?.key
    if (statusKey) {
      result = result.filter(v => statusByVideo[v.id]?.status === statusKey)
    }
```

并把 `statusByVideo, statusFilter` 加进该 `useMemo` 依赖数组。

- [ ] **Step 2: 加筛选 UI**

在 `filters-panel` 里「口音地区」分组之后、`showFilters` 块内追加：

```jsx
          <div className="filter-group">
            <label className="filter-label">学习状态</label>
            <div className="filter-options">
              {STATUS_FILTERS.map(f => (
                <button
                  key={f.label}
                  className={`filter-btn ${statusFilter === f.label ? 'active' : ''}`}
                  onClick={() => { setStatusFilter(f.label); setPage(1) }}
                >{f.label}</button>
              ))}
            </div>
          </div>
```

- [ ] **Step 3: 卡片徽章**

在卡片 `.video-meta` 内、`subtitle-count` 之后加：

```jsx
                <span className={`learn-badge learn-badge-${statusByVideo[video.id]?.status || 'not_learned'}`}>
                  {STATUS_BADGE[statusByVideo[video.id]?.status || 'not_learned']}
                </span>
```

- [ ] **Step 4: active-filters 与清除**

1) 在 `results-info` 的 active-filters 条件与内容里加入 statusFilter：

条件改为：

```jsx
        {(levelFilter !== '全部' || topicFilter !== '全部' || accentFilter !== '全部' || statusFilter !== 'All') && (
```

标签内加入：

```jsx
            {statusFilter !== 'All' && <span className="filter-tag" onClick={() => setStatusFilter('All')}>{statusFilter} ×</span>}
```

2) 空态的"清除筛选"按钮 onClick 加 `setStatusFilter('All')`：

```jsx
          <button onClick={() => { setSearch(''); setLevelFilter('全部'); setTopicFilter('全部'); setAccentFilter('全部'); setStatusFilter('All'); }}>清除筛选</button>
```

- [ ] **Step 5: 加 CSS**

在 `src/index.css` 的 `.subtitle-count` 规则之后加：

```css
.learn-badge {
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.learn-badge-not_learned { background: #fee2e2; color: #dc2626; }
.learn-badge-learning { background: #fef3c7; color: #d97706; }
.learn-badge-learned { background: #dcfce7; color: #16a34a; }
```

- [ ] **Step 6: 静态检查**

Run: `npm run lint`
Expected: 无新增 error。

- [ ] **Step 7: 手动验证（需后端）**

```bash
npm run server
npm run dev
```

1. 游客模式进入首页：全部视频显示 🔴 Not Learned（本地无记录）。
2. 进入某视频，做几次「挖空」后返回首页：该视频变 🟡 Learning。
3. 用登录账号，通过 `/api/practice` 反复 POST 使某视频三项都达 75%（例：`subtitle_count=35` 时每项 POST 27 个不同 index）→ 首页该视频变 🟢 Learned。
4. 筛选 `Learned` 只显示该视频；`Not Learned` 不含它；点 active-filter 的 `×` 或「清除筛选」可复位。

- [ ] **Step 8: 提交**

```bash
git add src/pages/Library.jsx src/index.css
git commit -m "feat(learning): 视频列表学习状态徽章与筛选"
```

---

### Task 6: 全量验证

- [ ] **Step 1: 跑全部相关测试**

Run:
```bash
node --test src/utils/learningStatus.test.js src/utils/practiceRecords.test.js server/routes/practice.test.cjs
```
Expected: 全部 PASS。

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 无 error。

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 构建成功，无报错。

---

## Self-Review

**Spec coverage：**
- 视频级三状态 → Task 2/5 ✅
- 75% 阈值、按任务平均 → Task 2 ✅
- 复用/新增最小记录（practice_records，dictation_records 同构） → Task 1 ✅
- 跟读/挖空/中译英逐句标志、不存录音评分 → Task 1/3/4 ✅
- 动态状态、不误标 Learned → Task 2 判定顺序 + Task 5 每次挂载重算 ✅
- 列表徽章 + All/Not Learned/Learning/Learned 筛选 → Task 5 ✅
- 不做听写/观看/AI 对话、不做孤儿页埋点、不做游客合并 → Global Constraints + Task 4 范围 ✅
- 测试 → Task 1/2/3 + Task 6 ✅

**Placeholder scan：** 无 TBD/TODO；每个代码步骤均给出完整代码与命令。

**Type consistency：** 状态键 `not_learned/learning/learned` 在 util、CSS、Library、测试中一致；任务键 `shadow/cloze/translate` 在 db/route/util/埋点中一致；`mark(authFetch, isGuest, videoId, task, index)` 与 Task 4 调用一致；`loadSummary(authFetch, isGuest)` 与 Task 5 调用一致。
