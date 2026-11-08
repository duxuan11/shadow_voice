# 字幕句子收藏 + 生词本编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 视频页字幕句子可收藏进生词本「句子」分类（服务端持久化、按来源管理），生词本条目可编辑笔记（≤200 字）与中文释义（≤300 字）。

**Architecture:** 复用现有生词本管线：字幕收藏以新类型 `sentence` 写入 `vocabulary` 表，`core_phrase` 与 `sentence` 在展示层合并为「句子」；新增 PATCH 接口编辑笔记/释义；DELETE 支持按 `?videoId=` 移除单个来源。

**Tech Stack:** React 19 + Vite（前端）、Express 5 + SQLite(sql.js)（后端）、node:test（单测）、TDD。

**Spec:** `docs/superpowers/specs/2026-11-08-subtitle-sentence-collection-vocab-editing-design.md`

**测试命令：**
- 后端：`node --test server/routes/vocab.test.cjs`
- 前端工具：`node --test "src/utils/*.test.js"`
- Lint：`npm run lint`

---

### Task 1: DB 迁移 — vocabulary.note 列

**Files:**
- Modify: `server/db.cjs`（迁移块，约 173-190 行区域）

- [ ] **Step 1: 加迁移行**

在 `server/db.cjs` 的 vocabulary 迁移块（`ensureColumn('vocabulary', 'context_cn', 'TEXT')` 之后）追加：

```js
  ensureColumn('vocabulary', 'note', 'TEXT')
```

注意：`note` 不做回填（老数据为 NULL，读取时 `toEntry` 兜底为空串）。

- [ ] **Step 2: 回归验证**

Run: `node --test server/routes/vocab.test.cjs`
Expected: 全部 PASS（新增列为空列，不影响既有行为）

- [ ] **Step 3: Commit**

```bash
git add server/db.cjs
git commit -m "feat(db): vocabulary 表新增 note 列（生词本笔记）"
```

---

### Task 2: 后端 API — sentence 类型 + PATCH 笔记/释义 + 按来源删除

**Files:**
- Test: `server/routes/vocab.test.cjs`（文件末尾追加）
- Modify: `server/routes/vocab.cjs`

- [ ] **Step 1: 写失败测试**

在 `server/routes/vocab.test.cjs` 的 `add` 辅助函数之后追加 `patch` 辅助函数：

```js
async function patch(word, body, userId = USER_ID) {
  const res = await fetch(`${baseUrl}/api/vocab/${encodeURIComponent(word)}`, {
    method: 'PATCH', headers: authHeaders(userId), body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}
```

在文件末尾追加测试：

```js
test('句子收藏：type=sentence，来源带 startTime', async () => {
  const { status, body } = await add({
    content: 'Could you tell me where the station is?',
    translation: '你能告诉我车站在哪里吗？',
    type: 'sentence',
    videoId: 'sv1', videoTitle: 'Street Asking', startTime: 12.5,
  })
  assert.equal(status, 200)
  assert.equal(body.entry.type, 'sentence')
  assert.deepEqual(body.entry.sources, [{ videoId: 'sv1', videoTitle: 'Street Asking', startTime: 12.5 }])
})

test('句子收藏：同一句多视频合并来源', async () => {
  await add({ content: 'Thanks a lot.', type: 'sentence', videoId: 'sv2', videoTitle: 'A', startTime: 3 })
  await add({ content: 'thanks a lot', type: 'sentence', videoId: 'sv3', videoTitle: 'B', startTime: 9 })
  const { body } = await list()
  const entry = body.vocabulary.find(v => v.word === 'thanks a lot')
  assert.equal(entry.sources.length, 2)
  assert.deepEqual(entry.sources.map(s => s.videoId).sort(), ['sv2', 'sv3'])
})

test('PATCH：更新笔记与释义', async () => {
  await add({ content: 'patchnote', type: 'word', videoId: 'pv', videoTitle: 'P' })
  const { status, body } = await patch('patchnote', { note: '容易拼错', translation: '新释义' })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.entry.note, '容易拼错')
  assert.equal(body.entry.translation, '新释义')

  const { body: listBody } = await list()
  assert.equal(listBody.vocabulary.find(v => v.word === 'patchnote').note, '容易拼错')
})

test('PATCH：只传 note 不动释义；只传 translation 不动笔记', async () => {
  await add({ content: 'partpatch', translation: '原释义', type: 'word', videoId: 'pv', videoTitle: 'P' })
  await patch('partpatch', { note: '只有笔记' })
  await patch('partpatch', { translation: '只有释义' })
  const { body } = await list()
  const entry = body.vocabulary.find(v => v.word === 'partpatch')
  assert.equal(entry.note, '只有笔记')
  assert.equal(entry.translation, '只有释义')
})

test('PATCH：笔记超 200 字 → 400', async () => {
  await add({ content: 'longnote', type: 'word', videoId: 'pv', videoTitle: 'P' })
  const { status } = await patch('longnote', { note: '字'.repeat(201) })
  assert.equal(status, 400)
})

test('PATCH：释义超 300 字 → 400', async () => {
  await add({ content: 'longtr', type: 'word', videoId: 'pv', videoTitle: 'P' })
  const { status } = await patch('longtr', { translation: '译'.repeat(301) })
  assert.equal(status, 400)
})

test('PATCH：条目不存在 → 404', async () => {
  const { status } = await patch('no-such-entry', { note: 'x' })
  assert.equal(status, 404)
})

test('DELETE ?videoId=：只移除该来源；最后一个来源移除后删除整条', async () => {
  await add({ content: 'src-word', type: 'sentence', videoId: 's1', videoTitle: 'S1', startTime: 1 })
  await add({ content: 'src-word', type: 'sentence', videoId: 's2', videoTitle: 'S2', startTime: 2 })

  let res = await fetch(`${baseUrl}/api/vocab/src-word?videoId=s1`, { method: 'DELETE', headers: authHeaders() })
  assert.equal(res.status, 200)
  let { body } = await list()
  let entry = body.vocabulary.find(v => v.word === 'src word')
  assert.deepEqual(entry.sources.map(s => s.videoId), ['s2'])

  res = await fetch(`${baseUrl}/api/vocab/src-word?videoId=s2`, { method: 'DELETE', headers: authHeaders() })
  assert.equal(res.status, 200)
  ;({ body } = await list())
  assert.ok(!body.vocabulary.some(v => v.word === 'src word'))
})

test('DELETE ?videoId=：来源不存在 → 条目不动', async () => {
  await add({ content: 'keep-word', type: 'word', videoId: 'k1', videoTitle: 'K' })
  const res = await fetch(`${baseUrl}/api/vocab/keep-word?videoId=nope`, { method: 'DELETE', headers: authHeaders() })
  assert.equal(res.status, 200)
  const { body } = await list()
  assert.equal(body.vocabulary.find(v => v.word === 'keep word').sources.length, 1)
})

test('DELETE ?videoId=：无 sources 的老数据走兜底合成来源', async () => {
  // 直接造一条无 sources JSON 的老数据行
  const { getDb, run } = require('../db.cjs')
  await getDb()
  run('INSERT INTO vocabulary (user_id, word, content, type, video_id, video_title) VALUES (?, ?, ?, ?, ?, ?)',
    [USER_ID, 'legacyrow', 'legacyrow', 'word', 'lg1', 'Legacy'])
  const res = await fetch(`${baseUrl}/api/vocab/legacyrow?videoId=lg1`, { method: 'DELETE', headers: authHeaders() })
  assert.equal(res.status, 200)
  const { body } = await list()
  assert.ok(!body.vocabulary.some(v => v.word === 'legacyrow'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/routes/vocab.test.cjs`
Expected: 新增测试 FAIL（`patch` 接口 404 / sentence 类型回退 word / DELETE 忽略 videoId 参数）

- [ ] **Step 3: 实现**

`server/routes/vocab.cjs` 修改：

（1）类型集合加入 sentence：

```js
const VOCAB_TYPES = new Set(['word', 'phrase', 'core_phrase', 'sentence'])
```

（2）`toEntry` 补 note 字段（在 `phonetic` 之后加一行）：

```js
    note: row.note || '',
```

（3）POST 处理器中，把 startTime 带进来源。把现有的：

```js
  const videoId = body.videoId ?? null
  const videoTitle = body.videoTitle ?? null
```

改为：

```js
  const videoId = body.videoId ?? null
  const videoTitle = body.videoTitle ?? null
  // 句子收藏附带时间戳，用于从生词本跳回视频对应位置
  const startTime = type === 'sentence' && body.startTime != null && Number.isFinite(Number(body.startTime))
    ? Number(body.startTime)
    : null
  const makeSource = () => {
    const s = { videoId, videoTitle }
    if (startTime != null) s.startTime = startTime
    return s
  }
```

并把合并与插入两处的来源构造换成 `makeSource()`。

第一处（UPDATE 合并分支），把：

```js
      const sources = mergeSources(parseSources(existing), [{ videoId, videoTitle }])
```

改为：

```js
      const sources = mergeSources(parseSources(existing), [makeSource()])
```

第二处（INSERT 新建分支），把：

```js
    const sources = mergeSources([], [{ videoId, videoTitle }])
```

改为：

```js
    const sources = mergeSources([], [makeSource()])
```

（4）在 `router.post('/practice', ...)` 之后、`router.delete` 之前新增 PATCH 路由：

```js
// PATCH /api/vocab/:word — 编辑笔记（≤200 字）与中文释义（≤300 字），可只传其一
router.patch('/:word', authMiddleware, async (req, res) => {
  const body = req.body || {}
  const key = normalizeKey(req.params.word)
  if (!key) return res.status(400).json({ error: '无效内容' })

  await getDb()
  try {
    const existing = get('SELECT * FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, key])
    if (!existing) return res.status(404).json({ error: '条目不存在' })

    const note = body.note != null ? String(body.note).trim() : (existing.note || '')
    const translation = body.translation != null ? String(body.translation).trim() : (existing.translation || '')
    if (note.length > 200) return res.status(400).json({ error: '笔记不能超过 200 字' })
    if (translation.length > 300) return res.status(400).json({ error: '释义不能超过 300 字' })

    run('UPDATE vocabulary SET note = ?, translation = ? WHERE id = ?', [note, translation, existing.id])
    const entry = toEntry(get('SELECT * FROM vocabulary WHERE id = ?', [existing.id]))
    res.json({ ok: true, entry })
  } catch {
    res.status(500).json({ error: '保存失败' })
  }
})
```

（5）DELETE 支持 `?videoId=` 按来源移除：

```js
// DELETE /api/vocab/:word?videoId=xxx — 仅移除该来源；条目再无来源则整条删除。
// 不带 videoId 时保持旧行为：整条删除（生词本页「移除」按钮沿用）。
router.delete('/:word', authMiddleware, async (req, res) => {
  await getDb()
  const key = normalizeKey(req.params.word)
  if (!key) return res.status(400).json({ error: '无效内容' })

  const videoId = req.query.videoId
  if (videoId) {
    const existing = get('SELECT * FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, key])
    if (!existing) return res.json({ ok: true })
    const sources = parseSources(existing).filter(s => s.videoId !== videoId)
    if (sources.length === 0) {
      run('DELETE FROM vocabulary WHERE id = ?', [existing.id])
    } else {
      run(
        'UPDATE vocabulary SET sources = ?, video_id = ?, video_title = ? WHERE id = ?',
        [JSON.stringify(sources), sources[0].videoId || null, sources[0].videoTitle || null, existing.id]
      )
    }
    return res.json({ ok: true })
  }

  run('DELETE FROM vocabulary WHERE user_id = ? AND word = ?', [req.userId, key])
  res.json({ ok: true })
})
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/routes/vocab.test.cjs`
Expected: 全部 PASS（含既有测试回归）

- [ ] **Step 5: Commit**

```bash
git add server/routes/vocab.cjs server/routes/vocab.test.cjs
git commit -m "feat(vocab): 句子类型收藏 + PATCH 笔记/释义 + 按来源删除"
```

---

### Task 3: 前端工具 — vocabulary.js 句子分类归并

**Files:**
- Test: `src/utils/vocabulary.test.js`
- Modify: `src/utils/vocabulary.js`

- [ ] **Step 1: 写失败测试**

`src/utils/vocabulary.test.js` 修改三处：

（1）import 增加 `SENTENCE_TYPES, isSentenceType`：

```js
import {
  normalizeVocabKey,
  buildVocabPayload,
  findVocabEntry,
  vocabKeys,
  filterVocabByType,
  countVocabByType,
  VOCAB_TYPE_LABELS,
  SENTENCE_TYPES,
  isSentenceType,
} from './vocabulary.js'
```

（2）更新既有断言（countVocabByType 输出形状改为 sentence 桶；core_phrase 标签改为「句子」）：

把：

```js
  assert.deepEqual(countVocabByType(vocab), { all: 5, word: 3, phrase: 1, core_phrase: 1 })
```

改为：

```js
  assert.deepEqual(countVocabByType(vocab), { all: 5, word: 3, phrase: 1, sentence: 1 })
```

把：

```js
  assert.equal(VOCAB_TYPE_LABELS.core_phrase, '核心短语')
```

改为：

```js
  assert.equal(VOCAB_TYPE_LABELS.core_phrase, '句子')
  assert.equal(VOCAB_TYPE_LABELS.sentence, '句子')
```

（3）文件末尾追加：

```js
test('isSentenceType / SENTENCE_TYPES：core_phrase 与 sentence 都是句子', () => {
  assert.deepEqual(SENTENCE_TYPES, ['core_phrase', 'sentence'])
  assert.equal(isSentenceType('core_phrase'), true)
  assert.equal(isSentenceType('sentence'), true)
  assert.equal(isSentenceType('word'), false)
  assert.equal(isSentenceType('phrase'), false)
})

test('filterVocabByType：sentence 归并 core_phrase 与 sentence', () => {
  const list = [
    { word: 'a', type: 'word' },
    { word: 'b', type: 'phrase' },
    { word: 'c', type: 'core_phrase' },
    { word: 'd', type: 'sentence' },
  ]
  assert.deepEqual(filterVocabByType(list, 'sentence').map(v => v.word), ['c', 'd'])
  assert.deepEqual(filterVocabByType(list, 'core_phrase').map(v => v.word), ['c'])
  assert.deepEqual(filterVocabByType(list, 'all').length, 4)
})

test('countVocabByType：sentence 桶合并两类', () => {
  const counts = countVocabByType([
    { type: 'word' },
    { type: 'core_phrase' },
    { type: 'sentence' },
    { type: 'sentence' },
  ])
  assert.equal(counts.all, 4)
  assert.equal(counts.word, 1)
  assert.equal(counts.phrase, 0)
  assert.equal(counts.sentence, 3)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/vocabulary.test.js`
Expected: FAIL（`SENTENCE_TYPES`/`isSentenceType` 未导出；counts 形状不匹配）

- [ ] **Step 3: 实现**

`src/utils/vocabulary.js` 修改：

（1）标签与常量（`VOCAB_TYPES` 加 sentence；`VOCAB_TYPE_LABELS` 更新；新增 SENTENCE_TYPES）：

```js
export const VOCAB_TYPES = ['word', 'phrase', 'core_phrase', 'sentence']

export const VOCAB_TYPE_LABELS = {
  word: '单词',
  phrase: '短语',
  core_phrase: '句子',
  sentence: '句子',
}

// 展示层「句子」分类 = 存储层的 core_phrase（词卡核心短语）+ sentence（字幕收藏句子）
export const SENTENCE_TYPES = ['core_phrase', 'sentence']

export function isSentenceType(type) {
  return SENTENCE_TYPES.includes(type)
}
```

（2）`filterVocabByType` 支持 `sentence` 归并：

```js
/** 按类型筛选生词（'all' 或空 → 全部；'sentence' → core_phrase + sentence 归并）。 */
export function filterVocabByType(vocabulary, type) {
  const list = vocabulary || []
  if (!type || type === 'all') return list
  if (type === 'sentence') return list.filter((v) => isSentenceType(v.type || 'word'))
  return list.filter((v) => (v.type || 'word') === type)
}
```

（3）`countVocabByType` 输出 sentence 桶：

```js
/** 统计各类型数量（sentence 桶 = core_phrase + sentence）。 */
export function countVocabByType(vocabulary) {
  const counts = { all: (vocabulary || []).length, word: 0, phrase: 0, sentence: 0 }
  for (const v of vocabulary || []) {
    const type = v.type || 'word'
    if (isSentenceType(type)) counts.sentence += 1
    else if (counts[type] != null) counts[type] += 1
  }
  return counts
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/vocabulary.test.js`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/vocabulary.js src/utils/vocabulary.test.js
git commit -m "feat(vocab): 展示层句子分类归并（core_phrase + sentence）"
```

---

### Task 4: 听练归并 — vocabPractice.js + VocabPracticePage.jsx

**Files:**
- Test: `src/utils/vocabPractice.test.js`
- Modify: `src/utils/vocabPractice.js`
- Modify: `src/pages/VocabPracticePage.jsx`

- [ ] **Step 1: 写失败测试**

`src/utils/vocabPractice.test.js` 修改两处：

（1）更新既有汇总断言（buckets 改为 word/phrase/sentence）：

把：

```js
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

改为：

```js
test('summarizePracticeByType：按类型汇总', () => {
  const s = summarizePracticeByType(VOCAB)
  assert.equal(s.word.total, 1)
  assert.equal(s.word.practiceCount, 4)
  assert.equal(s.word.correctCount, 1)
  assert.equal(s.word.proficiency.percent, 25)
  assert.equal(s.phrase.practiceCount, 2)
  assert.equal(s.sentence.total, 1)
  assert.equal(s.sentence.proficiency.level, 'new')
})
```

（2）文件末尾追加：

```js
test('buildPracticeQueue：type=sentence 归并 core_phrase 与 sentence', () => {
  const list = [
    { word: 'a', type: 'word' },
    { word: 'c', type: 'core_phrase' },
    { word: 'd', type: 'sentence' },
  ]
  const q = buildPracticeQueue(list, { type: 'sentence' })
  assert.deepEqual(q.map(v => v.word).sort(), ['c', 'd'])
})

test('buildPracticeQueue：type=core_phrase 仍只筛核心短语（兼容旧深链）', () => {
  const list = [
    { word: 'c', type: 'core_phrase' },
    { word: 'd', type: 'sentence' },
  ]
  assert.deepEqual(buildPracticeQueue(list, { type: 'core_phrase' }).map(v => v.word), ['c'])
})

test('summarizePracticeByType：sentence 桶合并两类统计', () => {
  const summary = summarizePracticeByType([
    { type: 'core_phrase', practice_count: 2, correct_count: 1 },
    { type: 'sentence', practice_count: 3, correct_count: 2 },
    { type: 'word', practice_count: 1, correct_count: 1 },
  ])
  assert.equal(summary.sentence.total, 2)
  assert.equal(summary.sentence.practiceCount, 5)
  assert.equal(summary.sentence.correctCount, 3)
})

test('PRACTICE_TYPE_LABELS：sentence 显示为句子', () => {
  assert.equal(PRACTICE_TYPE_LABELS.sentence, '句子')
})

test('PRACTICE_TYPE_FILTERS：句子筛选 id 为 sentence', () => {
  assert.deepEqual(PRACTICE_TYPE_FILTERS.map(f => f.id), ['all', 'word', 'phrase', 'sentence'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/vocabPractice.test.js`
Expected: FAIL（sentence 桶/筛选不存在）

- [ ] **Step 3: 实现工具函数**

`src/utils/vocabPractice.js` 修改：

（1）import 行改为：

```js
import { normalizeVocabKey, isSentenceType } from './vocabulary.js'
```

（2）标签与筛选列表：

```js
// 听练 UI 名称：core_phrase 与 sentence 展示为「句子」。
export const PRACTICE_TYPE_LABELS = { word: '单词', phrase: '短语', core_phrase: '句子', sentence: '句子' }

export const PRACTICE_TYPE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'word', label: '单词' },
  { id: 'phrase', label: '短语' },
  { id: 'sentence', label: '句子' },
]

const PRACTICE_BUCKETS = ['word', 'phrase', 'sentence']
```

（3）`buildPracticeQueue` 的筛选部分改为：

```js
  const filtered = (() => {
    if (!type || type === 'all') return list.slice()
    if (type === 'sentence') return list.filter(v => isSentenceType(v.type || 'word'))
    return list.filter(v => (v.type || 'word') === type)
  })()
  return shuffle(filtered)
```

（4）`summarizePracticeByType` 改为：

```js
/** 按类型汇总练习次数 / 正确次数 / 熟练度（sentence 桶 = core_phrase + sentence）。 */
export function summarizePracticeByType(vocabulary) {
  const out = {}
  for (const type of PRACTICE_BUCKETS) {
    out[type] = { type, total: 0, practiceCount: 0, correctCount: 0, proficiency: proficiencyFrom(0, 0) }
  }
  for (const entry of vocabulary || []) {
    const type = entry.type || 'word'
    const bucket = isSentenceType(type) ? 'sentence' : type
    const b = out[bucket]
    if (!b) continue
    b.total += 1
    b.practiceCount += Number(entry.practice_count) || 0
    b.correctCount += Number(entry.correct_count) || 0
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
Expected: 全部 PASS

- [ ] **Step 5: 适配 VocabPracticePage.jsx**

（1）`selectedType` 初始化接受 sentence（旧 core_phrase 深链归一为 sentence）。把：

```js
  const [selectedType, setSelectedType] = useState(() => {
    const t = searchParams.get('type')
    return ['all', 'word', 'phrase', 'core_phrase'].includes(t) ? t : 'all'
  })
```

改为：

```js
  const [selectedType, setSelectedType] = useState(() => {
    const t = searchParams.get('type')
    if (t === 'core_phrase') return 'sentence' // 旧深链归一
    return ['all', 'word', 'phrase', 'sentence'].includes(t) ? t : 'all'
  })
```

（2）统计表映射改为 sentence 桶。把：

```js
                        {['word', 'phrase', 'core_phrase'].map(t => {
```

改为：

```js
                        {['word', 'phrase', 'sentence'].map(t => {
```

- [ ] **Step 6: 回归 + lint**

Run: `node --test "src/utils/*.test.js" && npm run lint`
Expected: 全部 PASS，lint 无错误

- [ ] **Step 7: Commit**

```bash
git add src/utils/vocabPractice.js src/utils/vocabPractice.test.js src/pages/VocabPracticePage.jsx
git commit -m "feat(practice): 听练句子类型归并 sentence 与 core_phrase"
```

---

### Task 5: 视频页字幕收藏 + ?t= 深链

**Files:**
- Modify: `src/pages/VideoDetail.jsx`

说明：删除本地 `bookmarkedIds` state，♥ 状态改为从 `vocabulary` 派生（该句规范化 key 存在且 sources 含本视频）。桌面（约 1306-1315 行）与手机（约 868-893 行）两处 transcript 的 ♥ 按钮都接入。

- [ ] **Step 1: 删除本地 bookmark state**

删除这一行：

```js
  const [bookmarkedIds, setBookmarkedIds] = useState([])
```

- [ ] **Step 2: 替换 toggleBookmark 为服务端收藏逻辑**

把（约 637-638 行）：

```js
  // ── Bookmark ──
  const toggleBookmark = (e, subId) => { e.stopPropagation(); setBookmarkedIds(p => p.includes(subId) ? p.filter(id => id !== subId) : [...p, subId]) }
```

替换为（放在 Vocabulary 区块的 `removeFromVocab` 之后、`pushToVocab` 之前）：

```js
  // ── 字幕句子收藏（♥ → 生词本 sentence 条目，按来源管理）──
  const isSentenceBookmarked = (sub) => {
    const key = normalizeVocabKey(sub?.textEn)
    if (!key) return false
    const entry = vocabulary.find(v => (v.word || normalizeVocabKey(v.content)) === key)
    return !!entry && Array.isArray(entry.sources) && entry.sources.some(s => s && s.videoId === id)
  }

  const toggleSentenceFav = async (e, sub) => {
    e.stopPropagation()
    const content = String(sub?.textEn ?? '').trim()
    const key = normalizeVocabKey(content)
    if (!key) return
    if (isGuest) { notify('登录后才能收藏句子'); return }
    if (vocabBusy.has(key)) return
    setVocabBusy(prev => new Set(prev).add(key))
    try {
      if (isSentenceBookmarked(sub)) {
        const r = await authFetch(`/vocab/${encodeURIComponent(key)}?videoId=${encodeURIComponent(id)}`, { method: 'DELETE' })
        if (r.ok) {
          setVocabulary(prev => {
            const entry = prev.find(v => (v.word || normalizeVocabKey(v.content)) === key)
            if (!entry) return prev
            const sources = (entry.sources || []).filter(s => s && s.videoId !== id)
            if (sources.length === 0) return prev.filter(v => (v.word || normalizeVocabKey(v.content)) !== key)
            return prev.map(v => (v.word || normalizeVocabKey(v.content)) === key ? { ...v, sources } : v)
          })
          notify('已取消收藏该句')
        } else {
          notify('取消收藏失败，请重试')
        }
      } else {
        const r = await authFetch('/vocab', {
          method: 'POST',
          body: JSON.stringify({
            content,
            word: key,
            type: 'sentence',
            translation: String(sub.textCn ?? '').trim(),
            videoId: id,
            videoTitle: video?.title,
            startTime: sub.startTime ?? null,
          }),
        })
        if (r.ok) {
          const d = await r.json().catch(() => ({}))
          setVocabulary(prev => {
            const rest = prev.filter(v => (v.word || normalizeVocabKey(v.content)) !== key)
            return d.entry ? [d.entry, ...rest] : rest
          })
          notify('句子已收藏，可在生词本查看')
        } else {
          notify('收藏失败，请重试')
        }
      }
    } catch {
      notify('网络错误，请重试')
    } finally {
      setVocabBusy(prev => { const n = new Set(prev); n.delete(key); return n })
    }
  }
```

- [ ] **Step 3: 接入桌面 transcript ♥ 按钮**

把（约 1306-1315 行）：

```jsx
                  {sidebarTab === 'transcript' && video.subtitles.map((sub, idx) => {
                    const isActive = idx === activeSubIndex
                    const isBookmarked = bookmarkedIds.includes(idx)
```

改为：

```jsx
                  {sidebarTab === 'transcript' && video.subtitles.map((sub, idx) => {
                    const isActive = idx === activeSubIndex
                    const isBookmarked = isSentenceBookmarked(sub)
```

把：

```jsx
                          <button onClick={(e) => toggleBookmark(e, idx)} className="p-1 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-slate-100/50 transition-all cursor-pointer" title={isBookmarked ? '取消收藏' : '收藏句子'}>
```

改为：

```jsx
                          <button onClick={(e) => toggleSentenceFav(e, sub)} disabled={vocabBusy.has(normalizeVocabKey(sub.textEn))} className="p-1 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-slate-100/50 transition-all cursor-pointer disabled:opacity-50" title={isBookmarked ? '取消收藏' : '收藏句子'}>
```

- [ ] **Step 4: 接入手机 transcript ♥ 按钮**

把（约 868 行）：

```jsx
          {mobileTab === 'transcript' && video.subtitles.map((sub, idx) => {
            const isActive = idx === activeSubIndex
            const isBookmarked = bookmarkedIds.includes(idx)
```

改为：

```jsx
          {mobileTab === 'transcript' && video.subtitles.map((sub, idx) => {
            const isActive = idx === activeSubIndex
            const isBookmarked = isSentenceBookmarked(sub)
```

把（约 892 行）：

```jsx
                    <button onClick={(e) => toggleBookmark(e, idx)} className="p-1 rounded-lg text-slate-300 hover:text-rose-500 transition-all cursor-pointer active:scale-75">
```

改为：

```jsx
                    <button onClick={(e) => toggleSentenceFav(e, sub)} disabled={vocabBusy.has(normalizeVocabKey(sub.textEn))} className="p-1 rounded-lg text-slate-300 hover:text-rose-500 transition-all cursor-pointer active:scale-75 disabled:opacity-50">
```

- [ ] **Step 5: ?t= 深链（跳到指定时间）**

（1）进度续播 effect 跳过 ?t=。在进度续播 effect（约 184-198 行）开头加两行：

```js
  useEffect(() => {
    if (isGuest || !id) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('t')) return // ?t= 深链优先：由 handleLoadedMetadata 处理，跳过进度续播
    authFetch(`/progress/${id}`).then(r => r.json()).then(d => {
```

（2）`handleLoadedMetadata` 支持深链 seek。把：

```js
  const handleLoadedMetadata = () => {
    const vid = videoRef.current; if (!vid) return
    setDuration(vid.duration)
    // Resume from saved position if available
    const savedTime = sessionStorage.getItem(`shadow_voice_resume_${id}`)
    if (savedTime) {
      const t = parseFloat(savedTime)
      vid.currentTime = t
      setCurrentTime(t)
      sessionStorage.removeItem(`shadow_voice_resume_${id}`)
    }
  }
```

改为：

```js
  const handleLoadedMetadata = () => {
    const vid = videoRef.current; if (!vid) return
    setDuration(vid.duration)
    // ?t= 深链：跳到指定时间（生词本句子来源跳转）
    const params = new URLSearchParams(window.location.search)
    const tParam = parseFloat(params.get('t') || '')
    if (Number.isFinite(tParam) && !deepSeekDoneRef.current) {
      deepSeekDoneRef.current = true
      vid.currentTime = tParam
      setCurrentTime(tParam)
      return
    }
    // Resume from saved position if available
    const savedTime = sessionStorage.getItem(`shadow_voice_resume_${id}`)
    if (savedTime) {
      const t = parseFloat(savedTime)
      vid.currentTime = t
      setCurrentTime(t)
      sessionStorage.removeItem(`shadow_voice_resume_${id}`)
    }
  }
```

（3）在 refs 区（`notifyTimerRef` 附近）加：

```js
  const deepSeekDoneRef = useRef(false)
```

- [ ] **Step 6: lint + 构建**

Run: `npm run lint && npm run build`
Expected: lint 无错误，构建成功

- [ ] **Step 7: Commit**

```bash
git add src/pages/VideoDetail.jsx
git commit -m "feat(video): 字幕句子收藏接入生词本（服务端持久化 + ?t= 深链）"
```

---

### Task 6: 生词本 UI — 句子分类 + 内联编辑（笔记/释义）

**Files:**
- Modify: `src/pages/LearningRecords.jsx`
- Modify: `src/index.css`

- [ ] **Step 1: LearningRecords.jsx 头部调整**

（1）import 增加 `Pencil`。把：

```js
import { BookOpen, Clock, Trash2, Play, Star, MessageSquare, Headphones } from 'lucide-react'
```

改为：

```js
import { BookOpen, Clock, Trash2, Play, Star, MessageSquare, Headphones, Pencil } from 'lucide-react'
```

（2）VOCAB_FILTERS 改为：

```js
const VOCAB_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'word', label: '单词' },
  { id: 'phrase', label: '短语' },
  { id: 'sentence', label: '句子' },
]
```

（3）组件内新增编辑 state（`vocabFilter` state 之后）：

```js
  const [editingKey, setEditingKey] = useState(null)
  const [editTranslation, setEditTranslation] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState(null)
```

- [ ] **Step 2: 编辑逻辑与来源跳转**

（1）`openSource` 支持句子 startTime 跳转。把：

```js
  // 点来源回到对应视频词卡位置
  const openSource = (entry, source) => {
    if (!source?.videoId) return
    const word = encodeURIComponent(entry.content || entry.word)
    navigate(`/video/${source.videoId}?card=1&word=${word}&type=${entry.type || 'word'}`)
  }
```

改为：

```js
  // 点来源回到对应视频：句子（有 startTime）直达该句时间；其余回词卡定位
  const openSource = (entry, source) => {
    if (!source?.videoId) return
    if (source.startTime != null) {
      navigate(`/video/${source.videoId}?t=${source.startTime}`)
      return
    }
    const word = encodeURIComponent(entry.content || entry.word)
    navigate(`/video/${source.videoId}?card=1&word=${word}&type=${entry.type || 'word'}`)
  }
```

（2）`removeVocabWord` 之后追加编辑函数：

```js
  const openEdit = (entry) => {
    const key = entry.word || normalizeVocabKey(entry.content)
    if (!key) return
    setEditingKey(key)
    setEditTranslation(entry.translation || '')
    setEditNote(entry.note || '')
    setEditError(null)
  }

  const cancelEdit = () => {
    if (editBusy) return
    setEditingKey(null)
    setEditError(null)
  }

  const saveEdit = async (entry) => {
    const key = entry.word || normalizeVocabKey(entry.content)
    if (!key) return
    setEditBusy(true)
    setEditError(null)
    try {
      const r = await authFetch(`/vocab/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        body: JSON.stringify({ note: editNote, translation: editTranslation }),
      })
      if (r.ok) {
        const d = await r.json().catch(() => ({}))
        setVocabulary(prev => prev.map(v =>
          (v.word || normalizeVocabKey(v.content)) === key
            ? (d.entry || { ...v, note: editNote, translation: editTranslation })
            : v
        ))
        setEditingKey(null)
      } else {
        const d = await r.json().catch(() => ({}))
        setEditError(d.error || '保存失败，请重试')
      }
    } catch {
      setEditError('网络错误，保存失败')
    } finally {
      setEditBusy(false)
    }
  }
```

- [ ] **Step 3: 卡片渲染（笔记展示 + 编辑按钮 + 编辑面板）**

（1）在释义段落之后加笔记展示。把：

```jsx
                        {(entry.translation || entry.context_cn) && (
                          <p className="vocab-card-translation">
                            {entry.translation || entry.context_cn}
                            {!entry.translation && entry.context_cn && <span className="vocab-cn-tag">例句</span>}
                          </p>
                        )}
```

改为：

```jsx
                        {(entry.translation || entry.context_cn) && (
                          <p className="vocab-card-translation">
                            {entry.translation || entry.context_cn}
                            {!entry.translation && entry.context_cn && <span className="vocab-cn-tag">例句</span>}
                          </p>
                        )}

                        {entry.note && editingKey !== key && (
                          <p className="vocab-card-note">{entry.note}</p>
                        )}

                        {editingKey === key && (
                          <div className="vocab-edit-panel" onClick={(e) => e.stopPropagation()}>
                            <label className="vocab-edit-label">
                              <span>中文释义</span>
                              <input
                                className="vocab-edit-input"
                                value={editTranslation}
                                maxLength={300}
                                onChange={(e) => setEditTranslation(e.target.value)}
                                placeholder="修改释义（可选）"
                              />
                              <span className="vocab-edit-count">{editTranslation.length}/300</span>
                            </label>
                            <label className="vocab-edit-label">
                              <span>笔记</span>
                              <textarea
                                className="vocab-edit-textarea"
                                rows={3}
                                value={editNote}
                                maxLength={200}
                                onChange={(e) => setEditNote(e.target.value)}
                                placeholder="记下用法、记忆技巧……（200 字以内）"
                              />
                              <span className="vocab-edit-count">{editNote.length}/200</span>
                            </label>
                            {editError && <p className="vocab-edit-error">{editError}</p>}
                            <div className="vocab-edit-actions">
                              <button type="button" className="vocab-edit-save" disabled={editBusy} onClick={() => saveEdit(entry)}>
                                {editBusy ? '保存中…' : '保存'}
                              </button>
                              <button type="button" className="vocab-edit-cancel" disabled={editBusy} onClick={cancelEdit}>
                                取消
                              </button>
                            </div>
                          </div>
                        )}
```

（2）操作区加「编辑」按钮。把：

```jsx
                          <div className="vocab-card-actions">
                            <button
                              type="button"
                              className="vocab-practice-btn"
```

改为：

```jsx
                          <div className="vocab-card-actions">
                            <button
                              type="button"
                              className="vocab-edit-btn"
                              onClick={() => openEdit(entry)}
                              disabled={editingKey === key}
                              aria-label="编辑笔记"
                            >
                              <Pencil size={14} />
                              <span>{editingKey === key ? '编辑中' : '编辑'}</span>
                            </button>
                            <button
                              type="button"
                              className="vocab-practice-btn"
```

- [ ] **Step 4: CSS**

在 `src/index.css` 的 `.vocab-card-actions` 规则（约 3772 行）附近追加：

```css
/* ── 生词本笔记与编辑 ── */
.vocab-card-note {
  margin-top: 6px;
  padding: 8px 10px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-left: 3px solid #f59e0b;
  border-radius: 8px;
  font-size: 13px;
  color: #78350f;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.vocab-edit-panel {
  margin-top: 10px;
  padding: 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.vocab-edit-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: #475569; }
.vocab-edit-input,
.vocab-edit-textarea {
  font: inherit;
  font-size: 14px;
  padding: 8px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
  color: #1f2937;
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
}
.vocab-edit-input:focus,
.vocab-edit-textarea:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15); }
.vocab-edit-count { align-self: flex-end; font-size: 11px; font-weight: 500; color: #94a3b8; }
.vocab-edit-error { font-size: 12px; color: #dc2626; margin: 0; }
.vocab-edit-actions { display: flex; gap: 8px; justify-content: flex-end; }
.vocab-edit-save,
.vocab-edit-cancel {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.vocab-edit-save { background: #4f46e5; color: #fff; }
.vocab-edit-save:hover:not(:disabled) { background: #4338ca; }
.vocab-edit-save:disabled { opacity: 0.6; cursor: progress; }
.vocab-edit-cancel { background: #fff; color: #475569; border-color: #cbd5e1; }
.vocab-edit-cancel:hover { background: #f1f5f9; }
.vocab-edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #475569;
  font-size: 13px;
  cursor: pointer;
}
.vocab-edit-btn:hover:not(:disabled) { border-color: #6366f1; color: #4338ca; }
.vocab-edit-btn:disabled { opacity: 0.6; cursor: default; }
```

- [ ] **Step 5: lint + 构建**

Run: `npm run lint && npm run build`
Expected: lint 无错误，构建成功

- [ ] **Step 6: Commit**

```bash
git add src/pages/LearningRecords.jsx src/index.css
git commit -m "feat(records): 生词本句子分类 + 笔记/释义内联编辑"
```

---

### Task 7: 全量回归 + 手动验证清单

**Files:** 无新改动（验证 + 可能的修复）

- [ ] **Step 1: 全量自动化测试**

Run: `node --test server/routes/vocab.test.cjs && node --test "src/utils/*.test.js" && npm run lint && npm run build`
Expected: 全部 PASS / 构建成功

- [ ] **Step 2: 手动验证清单（本地 `npm run server` + `npm run dev`）**

1. 打开任一视频 → 桌面字幕 tab 点某句 ♥ → 变红实心 → toast「句子已收藏」
2. 手机宽度（浏览器设备模拟）→ 手机 transcript 同样操作 ♥ → 生效
3. 学习记录 → 生词本 → 「句子」tab → 出现该句（含中文译文、来源视频）
4. 点来源视频 → 跳到该句时间（`?t=` 深链）
5. 再点一次 ♥ 取消 → 生词本中该来源消失；只有单来源时条目消失
6. 生词本卡片点「编辑」→ 改释义 + 写笔记（试输入超过 200 字，应被 maxLength 截断且计数停在 200/200）→ 保存 → 卡片显示便签笔记
7. 刷新页面 → 笔记仍在（服务端持久化）
8. 单词/短语条目同样可编辑笔记
9. 听练页 → 类型筛选「句子」→ 队列包含新收藏的句子与核心短语；统计表句子行数量正确
10. 游客身份点 ♥ → toast「登录后才能收藏句子」
11. 词卡收藏单词/短语（回归）→ 正常加入生词本；「全部」tab 计数正确

- [ ] **Step 3: 修复发现的问题后 Commit**

```bash
git add -A
git commit -m "fix: 回归验证修复"
```

---

## 完成标准

- 字幕句子收藏/取消收藏与生词本「句子」分类实时一致（服务端持久化、按来源管理）
- 生词本条目可编辑笔记（≤200 字）与中文释义（≤300 字），超限被前后端双重限制
- 听练「句子」类型包含核心短语与收藏句子
- 全部自动化测试、lint、build 通过
