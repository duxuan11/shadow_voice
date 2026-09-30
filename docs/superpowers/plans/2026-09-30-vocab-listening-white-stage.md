# 生词听练「白底舞台 + 中文常显」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把听练页改为白底 + 项目配色的居中舞台（更接近参考站结构），中文释义常显居中，并离线解决收藏单词缺中文的问题。

**Architecture:** 服务端新增 `context_cn`（句子中文兜底）列与离线回填；前端把页面重构为 `vp-*` 舞台结构，移除「显示中文」开关与 `Ctrl+H`，中文常显。统计口径、槽位判定、TTS 全部不变。

**Tech Stack:** React 19 + Vite 8 + Express 5 (CommonJS) + sql.js；Node 内置测试；纯 CSS。

## Global Constraints

- 分支：`feat/vocab-listening-practice`（继续）。
- **不改**：`src/pages/DictationPage.jsx`、`src/utils/spellCheck.js`、`src/utils/spellSlots.js`；统计口径（首次提交计入、熟练度公式）；连击规则；槽位判定。
- 中文来源优先级：`translation` → `context_cn`（标「例句」）→ 「暂无中文释义」；**移除**「显示中文」按钮、`showChinese` 状态、`Ctrl+H` 快捷键。
- 白底 + 项目配色（靛蓝 `#4f46e5` / 蓝 `#2563eb` / 紫 `#7c3aed`）；无 3D、无深色、无音效、无新依赖。
- 移动端 ≥44px、`touch-action: manipulation`、`env(safe-area-inset-bottom)`、`prefers-reduced-motion`。
- 不得复制参考站代码/样式/类名。
- 不要提交 `data/consolidated.json`、`data/meta.json`、`data/shadow_voice.db`。
- 验证：`node --test "src/utils/*.test.js"`、`node --test "server/**/*.test.cjs"`、`node --test scripts/copy-data.test.mjs`、`npm run lint`（0 error）、`npm run build`。

---

### Task 1: 离线中文上下文模块 `server/lib/vocabContext.cjs`

**Files:** Create `server/lib/vocabContext.cjs`, `server/lib/vocabContext.test.cjs`

**Interfaces (Produces):**
```js
findContextCn(word, subtitles) -> string
backfillVocabContext(dataDir) -> Promise<{ filled: number }>
```

- [ ] **Step 1: 写失败测试** `server/lib/vocabContext.test.cjs`

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-vocabctx-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const { getDb, run } = require('../db.cjs')
const { findContextCn, backfillVocabContext } = require('./vocabContext.cjs')

test('findContextCn：按词边界命中，大小写不敏感，返回该句 textCn', () => {
  const subs = [
    { textEn: 'I want to check in now', textCn: '我现在想办理入住' },
    { textEn: 'Passport, please.', textCn: '请出示护照。' },
  ]
  assert.equal(findContextCn('check in', subs), '我现在想办理入住')
  assert.equal(findContextCn('PASSPORT', subs), '请出示护照。')
})

test('findContextCn：未命中/空输入返回空串', () => {
  assert.equal(findContextCn('zzz', [{ textEn: 'hello', textCn: '你好' }]), '')
  assert.equal(findContextCn('', [{ textEn: 'hello', textCn: '你好' }]), '')
  assert.equal(findContextCn('cat', null), '')
  assert.equal(findContextCn('cat', [{ textEn: 'concatenate', textCn: '拼接' }]), '')
})

test('backfillVocabContext：为缺中文的生词补 context_cn', async () => {
  const db = await getDb()
  db.run("INSERT INTO users (id, username, email, password) VALUES (1, 'u', 'u@e.com', 'p')")
  db.run(`INSERT INTO vocabulary (user_id, word, content, type, sources, video_id)
          VALUES (1, 'passport', 'Passport', 'word', ?, 'v1')`, [JSON.stringify([{ videoId: 'v1' }])])
  db.run(`INSERT INTO vocabulary (user_id, word, content, translation, type, sources, video_id)
          VALUES (1, 'check in', 'check in', '办理入住', 'phrase', ?, 'v1')`, [JSON.stringify([{ videoId: 'v1' }])])

  fs.writeFileSync(path.join(tmpDir, 'consolidated.json'), JSON.stringify([{ id: 'v1', episode_dir: 'ep1' }]))
  fs.mkdirSync(path.join(tmpDir, 'videos', 'ep1'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'videos', 'ep1', 'subtitles.json'),
    JSON.stringify([{ textEn: 'Here is my passport.', textCn: '这是我的护照。' }]))

  const { filled } = await backfillVocabContext(tmpDir)
  assert.equal(filled, 1)
  const row = db.exec("SELECT context_cn FROM vocabulary WHERE word = 'passport'")[0].values[0][0]
  assert.equal(row, '这是我的护照。')
  // 已有 translation 的条目不回填
  const kept = db.exec("SELECT context_cn FROM vocabulary WHERE word = 'check in'")[0].values[0][0]
  assert.ok(kept == null || kept === '')
})
```

- [ ] **Step 2: 运行确认失败** — `node --test server/lib/vocabContext.test.cjs` → FAIL。

- [ ] **Step 3: 实现** `server/lib/vocabContext.cjs`

```js
// 生词「中文兜底」：把生词所在字幕句子的中文作为 context_cn。
// 纯离线，不调用 AI。findContextCn 为纯函数；backfillVocabContext 做一次性幂等回填。
const fs = require('fs')
const path = require('path')
const { getDb, all, run } = require('../db.cjs')

/** 在字幕里找首个包含该词（大小写不敏感、按词边界）的句子，返回其 textCn。 */
function findContextCn(word, subtitles) {
  const needle = String(word ?? '').trim().toLowerCase()
  if (!needle || !Array.isArray(subtitles)) return ''
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[^a-z0-9'])${esc}([^a-z0-9']|$)`, 'i')
  for (const s of subtitles) {
    if (s && typeof s.textEn === 'string' && s.textCn && re.test(s.textEn)) {
      return String(s.textCn).trim()
    }
  }
  return ''
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 为 translation 为空且 context_cn 为空的生词行补写句子中文（幂等）。 */
async function backfillVocabContext(dataDir) {
  await getDb()
  const rows = all(
    `SELECT id, word, sources, video_id FROM vocabulary
     WHERE (translation IS NULL OR translation = '')
       AND (context_cn IS NULL OR context_cn = '')`
  )
  if (rows.length === 0) return { filled: 0 }

  const consolidated = loadJson(path.join(dataDir, 'consolidated.json')) || []
  const episodeById = new Map()
  for (const v of consolidated) if (v && v.id) episodeById.set(v.id, v.episode_dir)
  const subCache = new Map()
  const subsFor = (ep) => {
    if (!ep) return []
    if (!subCache.has(ep)) {
      subCache.set(ep, loadJson(path.join(dataDir, 'videos', ep, 'subtitles.json')) || [])
    }
    return subCache.get(ep)
  }

  let filled = 0
  for (const row of rows) {
    let sources = []
    try { sources = JSON.parse(row.sources || '[]') } catch { sources = [] }
    const ids = sources.map(s => s && s.videoId).filter(Boolean)
    if (ids.length === 0 && row.video_id) ids.push(row.video_id)
    let cn = ''
    for (const vid of ids) {
      cn = findContextCn(row.word, subsFor(episodeById.get(vid)))
      if (cn) break
    }
    if (cn) { run('UPDATE vocabulary SET context_cn = ? WHERE id = ?', [cn, row.id]); filled += 1 }
  }
  return { filled }
}

module.exports = { findContextCn, backfillVocabContext }
```

- [ ] **Step 4: 运行确认通过** — `node --test server/lib/vocabContext.test.cjs` → PASS。

- [ ] **Step 5: 提交** — `git add server/lib/vocabContext.cjs server/lib/vocabContext.test.cjs && git commit -m "feat(vocab): 离线中文上下文模块与回填"`

---

### Task 2: 数据列 + 接口 + 启动回填

**Files:** Modify `server/db.cjs`, `server/routes/vocab.cjs`, `server/routes/vocab.test.cjs`, `server/index.cjs`

**Interfaces:**
- `POST /api/vocab` body 新增可选 `contextCn`；命中已有条目不覆盖已有 `context_cn`。
- `toEntry` 返回 `context_cn`。

- [ ] **Step 1: 失败测试** — 在 `server/routes/vocab.test.cjs` 末尾追加：

```js
test('中文兜底：POST 保存 contextCn，GET 返回 context_cn', async () => {
  await add({ content: 'contextword', type: 'word', contextCn: '这是上下文中文', videoId: 'cx', videoTitle: 'CX' })
  const { body } = await list()
  const entry = body.vocabulary.find(v => v.word === 'contextword')
  assert.equal(entry.context_cn, '这是上下文中文')
})

test('中文兜底：重复添加不覆盖已有 context_cn', async () => {
  await add({ content: 'contextkeep', type: 'word', contextCn: '第一句', videoId: 'cx', videoTitle: 'CX' })
  await add({ content: 'contextkeep', type: 'word', contextCn: '第二句', videoId: 'cx', videoTitle: 'CX' })
  const { body } = await list()
  assert.equal(body.vocabulary.find(v => v.word === 'contextkeep').context_cn, '第一句')
})

test('中文兜底：未传 contextCn 时为「空字符串」', async () => {
  await add({ content: 'noctx', type: 'word', videoId: 'cx', videoTitle: 'CX' })
  const { body } = await list()
  assert.equal(body.vocabulary.find(v => v.word === 'noctx').context_cn, '')
})
```

- [ ] **Step 2: 运行确认失败** — `node --test server/routes/vocab.test.cjs` → 新用例 FAIL。

- [ ] **Step 3: 迁移列** — `server/db.cjs`，在 `ensureColumn('vocabulary', 'sources', 'TEXT')` 之后加：
```js
  ensureColumn('vocabulary', 'context_cn', 'TEXT')
```

- [ ] **Step 4: 接口** — `server/routes/vocab.cjs`：
  - `toEntry` 返回对象加 `context_cn: row.context_cn || '',`。
  - POST 里新增 `const contextCn = String(body.contextCn ?? '').trim()`。
  - 已有条目 UPDATE 改为（新增 `context_cn = ?` 与参数 `existing.context_cn || contextCn`）：
```js
      run(
        `UPDATE vocabulary
           SET content = ?, translation = ?, context_cn = ?, type = ?, phonetic = ?, sources = ?,
               video_id = COALESCE(video_id, ?), video_title = COALESCE(video_title, ?)
         WHERE id = ?`,
        [
          existing.content || rawContent,
          existing.translation || translation,
          existing.context_cn || contextCn,
          existing.type || type,
          existing.phonetic || phonetic,
          JSON.stringify(sources),
          videoId,
          videoTitle,
          existing.id,
        ]
      )
```
  - 新条目 INSERT 加 `context_cn` 列与值：
```js
    const result = run(
      `INSERT INTO vocabulary (user_id, word, content, translation, context_cn, type, phonetic, sources, video_id, video_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, key, rawContent, translation, contextCn, type, phonetic, JSON.stringify(sources), videoId, videoTitle]
    )
```

- [ ] **Step 5: 启动回填** — `server/index.cjs`：顶部 require 加
```js
const { backfillVocabContext } = require('./lib/vocabContext.cjs')
```
在 `const dataDir = resolveDataDir(...)` 之后加：
```js
// 一次性离线回填：为缺中文的生词补 context_cn（失败不阻塞启动）
getDb().then(() => backfillVocabContext(dataDir)).catch(err => console.error('[vocabContext] 回填失败:', err?.message || err))
```

- [ ] **Step 6: 运行确认通过** — `node --test server/routes/vocab.test.cjs` → PASS；`node --test server/lib/vocabContext.test.cjs` → PASS。

- [ ] **Step 7: 提交** — `git add server/db.cjs server/routes/vocab.cjs server/routes/vocab.test.cjs server/index.cjs && git commit -m "feat(vocab): context_cn 列/接口与启动回填"`

---

### Task 3: 字幕点词收藏时记录句子中文

**Files:** Modify `src/pages/VideoDetail.jsx`

- [ ] **Step 1: `pushToVocab` 接收句子中文**

把函数签名与 payload 改为（保留其余字段）：
```jsx
  const pushToVocab = (word, sentenceCn = '') => {
    const content = String(word ?? '').trim()
    const key = normalizeVocabKey(content)
    if (!content || !key) return
    addToVocab({
      content,
      word: key,
      translation: SYNONYMS[key]?.cn || '',
      contextCn: String(sentenceCn ?? '').trim(),
      type: 'word',
      phonetic: getPhonetic(content),
      videoId: id,
      videoTitle: video?.title,
    })
  }
```

- [ ] **Step 2: 点击处传入句子中文**

`handleWordClick(word, e)` 增加第三参 `sentenceCn`，并把弹窗中文兜底改为 `sd?.cn || sentenceCn || ''`：
```jsx
  const handleWordClick = (word, e, sentenceCn = '') => {
    e.stopPropagation()
    const cw = word.replace(/[^a-zA-Z']/g, '').toLowerCase(); if (cw.length < 2) return
    const sd = SYNONYMS[cw]; const r = e.target.getBoundingClientRect()
    const x = Math.min(r.left, window.innerWidth - 210)
    const y = Math.min(r.bottom + 4, window.innerHeight - 180)
    setWordPopup({ word: cw, synonyms: sd?.synonyms || [], cn: sd?.cn || sentenceCn || '', x, y, isMobile: window.innerWidth < 768 })
    pushToVocab(cw, sentenceCn)
  }
```
并在渲染字幕词时把当前句中文传入（找到调用 `handleWordClick(...)` 的位置，传入该句的 `textCn`；两处按钮调用 `pushToVocab(wordPopup.word)` 也可传 `wordPopup.cn`）。

- [ ] **Step 3: 验证** — `npx eslint src/pages/VideoDetail.jsx` 无 error；`npm run build` 成功。

- [ ] **Step 4: 提交** — `git add src/pages/VideoDetail.jsx && git commit -m "feat(vocab): 字幕点词收藏记录句子中文"`

---

### Task 4: 移除 Ctrl+H / toggleChinese

**Files:** Modify `src/utils/vocabShortcuts.js`, `src/utils/vocabShortcuts.test.js`, `src/pages/VocabPracticePage.jsx`

- [ ] **Step 1: 快捷键模块** — `src/utils/vocabShortcuts.js`：
  - `SHORTCUT_GROUPS` 的「答题中」删除 `{ keys: ['Ctrl/⌘', 'H'], label: '显示 / 隐藏中文' },` 行。
  - `resolveShortcut` 删除三处 `if (mod && (key === 'h' || key === 'H')) return 'toggleChinese'`（inputFocused typing / typing / review 各一处）。
  - Action 注释里去掉 `'toggleChinese'`。

- [ ] **Step 2: 测试** — `src/utils/vocabShortcuts.test.js`：删除/替换断言 `t({ key: 'h', ctrlKey: true, inputFocused: true }) === 'toggleChinese'` 与 `t({ key: 'H', metaKey: true }) === 'toggleChinese'`，改为 `=== null`。

- [ ] **Step 3: 页面** — `src/pages/VocabPracticePage.jsx`：删除 `showChinese` 状态、`setShowChinese(false)`、`toggleChinese()` 函数、keydown 里 `else if (action === 'toggleChinese') toggleChinese()` 分支；中文改为常显（Task 5 一并做渲染）。

- [ ] **Step 4: 验证** — `node --test src/utils/vocabShortcuts.test.js` 全绿；`npx eslint src/utils/vocabShortcuts.js src/pages/VocabPracticePage.jsx` 无 error。

- [ ] **Step 5: 提交** — `git add src/utils/vocabShortcuts.js src/utils/vocabShortcuts.test.js src/pages/VocabPracticePage.jsx && git commit -m "refactor(vocab): 移除中文开关与 Ctrl+H"`

---

### Task 5: 白底舞台重构 + 中文常显

**Files:** Modify `src/index.css`（替换深色主题）, `src/pages/VocabPracticePage.jsx`

- [ ] **Step 1: 删除深色主题 CSS** — `src/index.css`：删除从 `/* ===== Vocab Practice — dark immersive stage (A) ===== */`（约 3992 行）到文件末尾的**全部**内容（含其后的所有 dark/fix 规则）。

- [ ] **Step 2: 追加白底舞台 CSS**（`src/index.css` 末尾，整块）：

```css
/* ===== Vocab Practice — white stage ===== */
.vp-page {
  --vp-ink: #1e293b;
  --vp-ink-soft: #64748b;
  --vp-primary: #4f46e5;
  --vp-accent: #2563eb;
  --vp-violet: #7c3aed;
  --vp-line: #e8ecf7;
  min-height: 100vh;
  background: #ffffff;
  color: var(--vp-ink);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
}
.vp-stage { width: min(860px, 100%); }
@keyframes vpCardIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.vp-card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 520px;
  padding: 22px 40px 28px;
  border: 1px solid var(--vp-line);
  border-radius: 28px;
  background: #fff;
  box-shadow: 0 20px 50px rgba(40, 58, 110, 0.12);
  animation: vpCardIn 0.28s ease-out both;
}
.vp-toolbar { display: flex; align-items: center; gap: 12px; padding-right: 140px; min-height: 40px; }
.vp-type { font-size: 15px; font-weight: 700; color: var(--vp-ink-soft); }
.vp-progress { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.vp-progress-text { font-size: 12px; color: var(--vp-ink-soft); font-variant-numeric: tabular-nums; }
.vp-progress-bar { width: 120px; height: 6px; border-radius: 999px; background: #eef2ff; overflow: hidden; }
.vp-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--vp-primary), var(--vp-violet)); transition: width 0.3s ease; }
.vp-corner { position: absolute; top: 16px; right: 16px; display: flex; gap: 6px; z-index: 2; }
.vp-icon-btn {
  width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--vp-line); border-radius: 12px; background: #fff; color: var(--vp-ink-soft);
  cursor: pointer; touch-action: manipulation; position: relative;
}
.vp-icon-btn:hover { color: var(--vp-accent); border-color: #c7d2fe; background: #f8faff; }
.vp-icon-btn.is-playing { color: var(--vp-accent); background: rgba(37, 99, 235, 0.08); }
.vp-main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 340px; gap: 18px; padding-top: 34px; }
.vp-cn { font-size: 16px; color: var(--vp-ink-soft); text-align: center; line-height: 1.6; overflow-wrap: anywhere; margin: 0; }
.vp-cn-tag { display: inline-block; margin-left: 6px; font-size: 11px; color: var(--vp-primary); background: #eef2ff; border-radius: 6px; padding: 1px 6px; vertical-align: middle; }
.vp-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.vp-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; border-radius: 10px;
  border: 1px solid var(--vp-line); background: #fff; color: #475569; font-size: 13px; font-weight: 600;
  cursor: pointer; touch-action: manipulation; position: relative;
}
.vp-btn:hover { background: #f8faff; border-color: #c7d2fe; }
.vp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.vp-btn--primary { background: linear-gradient(135deg, var(--vp-primary), var(--vp-violet)); border-color: transparent; color: #fff; }
.vp-btn--danger { color: #dc2626; }
.vp-btn--danger:hover { background: #fef2f2; border-color: #fca5a5; }
.vp-keyhints { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: center; }
.vp-keycap { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 6px; border: 1px solid #c7d2fe; background: #eef2ff; color: #4338ca; font-size: 11px; font-weight: 700; font-family: ui-monospace, monospace; }
.vp-keyhint-label { font-size: 11px; color: #94a3b8; margin-right: 6px; }

.spell-slots { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: center; gap: 16px 14px; margin: 4px 0; }
.spell-slot-wrap { position: relative; display: inline-flex; flex-direction: column; align-items: center; }
.spell-slot {
  box-sizing: content-box; min-width: 2ch; min-height: 44px; padding: 2px 4px 6px;
  border: 0; border-bottom: 2px solid #cbd5e1; background: transparent; color: #1e293b;
  font-size: clamp(26px, 4vw, 40px); font-weight: 700; text-align: center; outline: none;
  touch-action: manipulation; caret-color: #2563eb;
}
.spell-slot:focus { border-bottom-color: #2563eb; }
.spell-slot:focus-visible { outline: 2px solid rgba(37, 99, 235, 0.5); outline-offset: 4px; }
.spell-slot.is-correct { border-bottom-color: #16a34a; color: #15803d; }
.spell-slot.is-wrong { border-bottom-color: #dc2626; color: #b91c1c; }
.spell-slot.is-missing { border-bottom-style: dashed; border-bottom-color: #d97706; }
.spell-slot.is-revealed { border-bottom-color: #d97706; color: #b45309; }
.spell-slot-hint { margin-top: 4px; font-size: 12px; color: #b91c1c; font-weight: 600; }
.spell-slot-hint.is-missing-hint { color: #b45309; }

.vp-finish { display: grid; grid-template-columns: 1.02fr 0.98fr; gap: 28px; align-items: center; width: 100%; }
.vp-finish-title { font-size: clamp(28px, 3.6vw, 40px); font-weight: 900; letter-spacing: -0.02em; color: var(--vp-ink); margin: 0 0 18px; }
.vp-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.vp-stat { border: 1px solid var(--vp-line); border-radius: 14px; padding: 14px 16px; background: #fbfcff; }
.vp-stat-value { display: block; font-size: 28px; font-weight: 800; color: var(--vp-primary); }
.vp-stat-label { font-size: 12px; color: var(--vp-ink-soft); }
.vp-finish-right { display: flex; flex-direction: column; gap: 16px; }
.vp-finish-feedback { font-size: 15px; color: var(--vp-ink); margin: 0; }
.vp-finish-summary { font-size: 13px; color: var(--vp-ink-soft); margin: 0; }
.vp-finish-actions { display: flex; flex-direction: column; gap: 10px; }
.vp-cta { height: 50px; border: 0; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; touch-action: manipulation; background: linear-gradient(135deg, var(--vp-primary), var(--vp-violet)); color: #fff; }
.vp-cta--secondary { background: #fff; color: var(--vp-primary); border: 1px solid var(--vp-line); }

.vp-help-mask { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 23, 42, 0.35); display: flex; align-items: center; justify-content: center; padding: 20px; }
.vp-help { width: min(560px, 100%); max-height: 85vh; overflow-y: auto; background: #fff; border-radius: 18px; padding: 22px 24px; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.25); }
.vp-help-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.vp-help-head h2 { font-size: 18px; font-weight: 700; color: var(--vp-ink); }
.vp-help-group { margin-top: 14px; }
.vp-help-group h3 { font-size: 13px; color: var(--vp-ink-soft); font-weight: 600; margin-bottom: 8px; }
.vp-help-group ul { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.vp-help-group li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.vp-help-keys { display: inline-flex; gap: 4px; }
.vp-help-label { font-size: 13px; color: #334155; }

@keyframes vpComboIn { 0% { opacity: 0; transform: translate(-50%, 12px) scale(0.6); } 60% { opacity: 1; transform: translate(-50%, 0) scale(1.08); } 100% { opacity: 1; transform: translate(-50%, 0) scale(1); } }
.vp-combo { position: fixed; left: 50%; bottom: 120px; z-index: 900; transform: translate(-50%, 0); padding: 10px 22px; border-radius: 999px; background: linear-gradient(135deg, var(--vp-primary), var(--vp-violet)); color: #fff; font-weight: 800; font-size: 18px; box-shadow: 0 10px 26px rgba(79, 70, 229, 0.35); pointer-events: none; animation: vpComboIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) both; }

.vp-setup { width: 100%; display: flex; flex-direction: column; gap: 16px; }
.vp-filter { display: flex; flex-wrap: wrap; gap: 8px; }
.vp-filter-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--vp-line); background: #fff; color: #475569; font-size: 13px; font-weight: 600; cursor: pointer; touch-action: manipulation; }
.vp-filter-btn.active { background: linear-gradient(135deg, var(--vp-primary), var(--vp-violet)); border-color: transparent; color: #fff; }
.vp-filter-count { font-size: 12px; opacity: 0.8; }
.vp-stats-table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--vp-line); border-radius: 12px; overflow: hidden; }
.vp-stats-table th, .vp-stats-table td { padding: 10px 14px; font-size: 13px; text-align: left; border-bottom: 1px solid #f1f5f9; white-space: nowrap; }
.vp-stats-table th { background: #f8faff; color: var(--vp-ink-soft); font-weight: 600; }
.prof-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.prof-badge.prof-new { background: #f1f5f9; color: #64748b; }
.prof-badge.prof-weak { background: #fee2e2; color: #dc2626; }
.prof-badge.prof-fair { background: #fef3c7; color: #92400e; }
.prof-badge.prof-good { background: #dcfce7; color: #166534; }
.vp-empty { text-align: center; color: var(--vp-ink-soft); padding: 40px 0; }

@media (max-width: 640px) {
  .vp-page { padding: 12px 10px calc(16px + env(safe-area-inset-bottom)); align-items: flex-start; }
  .vp-card { min-height: 0; padding: 18px 16px 22px; border-radius: 20px; }
  .vp-main { min-height: 0; padding-top: 40px; }
  .vp-progress-bar { width: 80px; }
  .vp-cn { font-size: 15px; }
  .vp-finish { grid-template-columns: 1fr; gap: 20px; }
  .vp-finish-title { font-size: 26px; }
  .vp-finish-actions .vp-cta { width: 100%; }
  .vp-keyhints { display: none; }
  .spell-slot { font-size: 22px; }
}
@media (prefers-reduced-motion: reduce) {
  .vp-card, .vp-combo { animation: none; }
}
```

- [ ] **Step 3: 页面重构** — `src/pages/VocabPracticePage.jsx`：把整个 `return (...)` 替换为下述结构（保留其上所有逻辑；已按 Task 4 移除 showChinese/toggleChinese）。新增派生：
```jsx
  const cnText = current ? (current.translation || current.context_cn || '') : ''
  const cnIsContext = current ? (!current.translation && !!current.context_cn) : false
  const typeLabel = current ? (PRACTICE_TYPE_LABELS[current.type] || '单词') : ''
```
  `return`：
```jsx
  return (
    <div className="vp-page">
      <div className="vp-stage">
        <div className="vp-card">
          <div className="vp-toolbar">
            <span className="vp-type">{phase === 'practice' ? typeLabel : '生词听练'}</span>
            {phase === 'practice' && (
              <div className="vp-progress">
                <span className="vp-progress-text">{index + 1} / {queue.length}</span>
                <div className="vp-progress-bar">
                  <div className="vp-progress-fill" style={{ width: `${((index + (result || revealed ? 1 : 0)) / Math.max(1, queue.length)) * 100}%` }} />
                </div>
              </div>
            )}
          </div>

          <div className="vp-corner">
            <button type="button" className="vp-icon-btn" data-tip="再听一次 (Ctrl+Space)" aria-label="再听一次" onClick={replay}><Volume2 size={18} /></button>
            <button type="button" className="vp-icon-btn" data-tip="快捷键 (?)" aria-label="快捷键帮助" onClick={() => setHelpOpen(true)}><HelpCircle size={18} /></button>
            <button type="button" className="vp-icon-btn" data-tip="退出 (Esc)" aria-label="退出" onClick={goBack}><X size={18} /></button>
          </div>

          {isGuest ? (
            <div className="vp-main"><div className="vp-empty"><p>登录后可练习生词本</p><button className="vp-btn vp-btn--primary" onClick={() => navigate('/login')}>去登录</button></div></div>
          ) : loadError ? (
            <div className="vp-main"><div className="vp-empty"><p>{loadError}</p></div></div>
          ) : phase === 'setup' ? (
            <div className="vp-main" style={{ justifyContent: 'flex-start' }}>
              {vocabulary.length === 0 ? (
                <div className="vp-empty">
                  <p>生词本还是空的</p>
                  <p>在视频的「智能重点词卡」中加入生词后即可听练</p>
                  <button className="vp-btn" onClick={() => navigate('/records')}>去生词本看看</button>
                </div>
              ) : (
                <div className="vp-setup">
                  <div className="vp-filter" role="tablist" aria-label="听练类型">
                    {PRACTICE_TYPE_FILTERS.map(f => (
                      <button key={f.id} role="tab" aria-selected={selectedType === f.id}
                        className={`vp-filter-btn${selectedType === f.id ? ' active' : ''}`}
                        onClick={() => setSelectedType(f.id)}>
                        {f.label}<span className="vp-filter-count">{typeCounts[f.id]}</span>
                      </button>
                    ))}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="vp-stats-table">
                      <thead><tr><th>类型</th><th>数量</th><th>练习次数</th><th>正确次数</th><th>熟练度</th></tr></thead>
                      <tbody>
                        {['word', 'phrase', 'core_phrase'].map(t => {
                          const s = summary[t]
                          return (
                            <tr key={t}>
                              <td>{PRACTICE_TYPE_LABELS[t]}</td>
                              <td>{s.total}</td><td>{s.practiceCount}</td><td>{s.correctCount}</td>
                              <td><span className={`prof-badge prof-${s.proficiency.level}`}>{s.proficiency.label}{s.proficiency.level !== 'new' ? ` ${s.proficiency.percent}%` : ''}</span></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button className="vp-btn vp-btn--primary" disabled={typeCounts[selectedType] === 0} onClick={() => startByType(selectedType)}>
                    <Headphones size={18} /><span>开始练习</span>
                  </button>
                </div>
              )}
            </div>
          ) : phase === 'practice' && current ? (
            <div className="vp-main">
              <p className="vp-cn">{cnText || '暂无中文释义'}{cnIsContext && <span className="vp-cn-tag">例句</span>}</p>
              <SpellSlots
                key={`${currentKey}:${retryToken}`}
                expectedWords={expectedWords}
                value={slotValues}
                onChange={setSlotValues}
                onSubmit={submit}
                disabled={!!result || revealed}
                statuses={result?.statuses ?? null}
                revealed={revealed && !result}
              />
              {!result && !revealed ? (
                <div className="vp-actions">
                  <button className="vp-btn vp-btn--primary" disabled={!joinSlots(slotValues)} data-tip="提交 (Enter)" onClick={submit}><Send size={16} /><span>提交</span></button>
                  <button className="vp-btn" data-tip="再听一次 (Ctrl+Space)" onClick={replay}><Volume2 size={16} /><span>再听一次</span></button>
                  <button className="vp-btn" data-tip="显示答案 (Tab)" onClick={() => setRevealed(true)}><Eye size={16} /><span>显示答案</span></button>
                </div>
              ) : (
                <div className="vp-actions">
                  <button className="vp-btn" disabled={index === 0} data-tip="上一题 (←)" onClick={prev}><ChevronLeft size={16} /><span>上一题</span></button>
                  <button className="vp-btn" data-tip="再练一次 (3)" onClick={retry}><RotateCcw size={16} /><span>再练一次</span></button>
                  <button className="vp-btn" data-tip="再听一次 (1)" onClick={replay}><Volume2 size={16} /><span>再听一次</span></button>
                  <button className="vp-btn vp-btn--danger" data-tip="移除生词本" onClick={removeCurrent}><Trash2 size={16} /><span>移除</span></button>
                  <button className="vp-btn vp-btn--primary" data-tip="下一题 (4 / Enter)" onClick={next}><span>{index < queue.length - 1 ? '下一题' : '完成'}</span><ChevronRight size={16} /></button>
                </div>
              )}
              {result && (
                <p className={`vp-verdict${result.correct ? ' is-correct' : ' is-wrong'}`} role="status">
                  {result.correct ? '✅ 完全正确' : '❌ 有出入，看槽位上的提示'}
                </p>
              )}
              {!result && !revealed && (
                <div className="vp-keyhints">
                  <span className="vp-keycap">Space</span><span className="vp-keyhint-label">下一词</span>
                  <span className="vp-keycap">Enter</span><span className="vp-keyhint-label">下一词 / 提交</span>
                  <span className="vp-keycap">Tab</span><span className="vp-keyhint-label">显示答案</span>
                </div>
              )}
            </div>
          ) : (
            <div className="vp-main">
              <div className="vp-finish">
                <div className="vp-finish-left">
                  <h2 className="vp-finish-title">本轮完成！</h2>
                  <div className="vp-stats">
                    <div className="vp-stat"><span className="vp-stat-value">{round.attempted}</span><span className="vp-stat-label">已练</span></div>
                    <div className="vp-stat"><span className="vp-stat-value">{round.correct}</span><span className="vp-stat-label">正确</span></div>
                    <div className="vp-stat"><span className="vp-stat-value">{round.attempted ? Math.round((round.correct / round.attempted) * 100) : 0}%</span><span className="vp-stat-label">正确率</span></div>
                    <div className="vp-stat"><span className="vp-stat-value">{combo.max}</span><span className="vp-stat-label">最长连击</span></div>
                  </div>
                </div>
                <div className="vp-finish-right">
                  <p className="vp-finish-feedback">{round.correct === 0 ? '继续加油，多听几遍会更好。' : round.correct === round.attempted ? '全部正确，太棒了！' : '不错，错的地方再听一遍。'}</p>
                  <p className="vp-finish-summary">本轮共 {round.attempted} 题，答对 {round.correct} 题。</p>
                  <div className="vp-finish-actions">
                    <button className="vp-cta" onClick={() => startByType(selectedType)}>再来一轮</button>
                    <button className="vp-cta vp-cta--secondary" onClick={() => navigate('/profile')}>返回个人中心</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {comboVisible && <div key={comboText} className="vp-combo" role="status">连击 x{comboText}</div>}
        </div>
      </div>

      {helpOpen && (
        <div className="vp-help-mask" onClick={() => setHelpOpen(false)}>
          <div className="vp-help" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <div className="vp-help-head">
              <h2>键盘快捷键</h2>
              <button type="button" className="vp-icon-btn" onClick={() => setHelpOpen(false)} aria-label="关闭"><X size={18} /></button>
            </div>
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.title} className="vp-help-group">
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map((item, i) => (
                    <li key={i}>
                      <span className="vp-help-keys">{item.keys.map((k, j) => <span key={j} className="vp-keycap">{k}</span>)}</span>
                      <span className="vp-help-label">{item.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
```

  - import 调整：新增 `Volume2`、`HelpCircle`、`X`、`Eye`、`Send`、`ChevronLeft`、`ChevronRight`、`RotateCcw`、`Trash2`、`Headphones`（lucide-react）；移除未再使用的图标。
  - 在追加的 CSS 里补：`.vp-verdict { font-size: 14px; font-weight: 600; text-align: center; margin: 0; } .vp-verdict.is-correct { color: #16a34a; } .vp-verdict.is-wrong { color: #dc2626; }`
  - 删除旧 CSS 相关类名的引用。
  - 删除未用变量/导入，确保 `npx eslint src/pages/VocabPracticePage.jsx` 0 error。

- [ ] **Step 4: 验证** — `npx eslint src/pages/VocabPracticePage.jsx src/components/SpellSlots.jsx src/utils/vocabShortcuts.js` 无 error；`npm run build` 成功；`node --test "src/utils/*.test.js"` 全绿。

- [ ] **Step 5: 提交** — `git add src/index.css src/pages/VocabPracticePage.jsx && git commit -m "style(vocab): 听练页白底舞台与中文常显"`

---

### Task 6: 生词本/个人中心中文兜底 + 文档 + 全量验证

**Files:** Modify `src/pages/LearningRecords.jsx`, `src/pages/Profile.jsx`, `README.md`

- [ ] **Step 1: LearningRecords 中文兜底** — 卡片释义显示改为：
```jsx
{(entry.translation || entry.context_cn) && (
  <p className="vocab-card-translation">
    {entry.translation || entry.context_cn}
    {!entry.translation && entry.context_cn && <span className="vocab-cn-tag">例句</span>}
  </p>
)}
```
并在 `src/index.css` 末尾加 `.vocab-cn-tag { display:inline-block; margin-left:6px; font-size:11px; color:#4f46e5; background:#eef2ff; border-radius:6px; padding:1px 6px; }`

- [ ] **Step 2: Profile 最近生词显示中文** — 标签内容改为 `{(v.translation || v.context_cn || v.content || v.word)}`。

- [ ] **Step 3: README** — 「### 🎧 生词听练（听练一体）」小节补一行：
```markdown
- **中文释义**：听练页常显居中；优先显示词义，缺失时显示该词所在句子的中文（标注「例句」）
```

- [ ] **Step 4: 全量验证**
```bash
node --test "src/utils/*.test.js"
node --test "server/**/*.test.cjs"
node --test scripts/copy-data.test.mjs
npm run lint
npm run build
```
Expected：全绿；lint 0 error（仅剩预存在 warnings）；build 成功。

- [ ] **Step 5: 提交** — `git add src/pages/LearningRecords.jsx src/pages/Profile.jsx src/index.css README.md && git commit -m "feat(vocab): 生词本中文兜底与文档"`

---

## 自查记录（spec 覆盖对照）

- 白底 + 项目配色 / 舞台卡 / 角落图标 / 工具条 / 居中主体 / 两栏完成页 / 手机端 → Task 5。
- 中文常显居中 + 优先级（词义→例句→暂无） → Task 4 + Task 5。
- 移除「显示中文」按钮与 `Ctrl+H` → Task 4（模块/测试）+ Task 5（页面）。
- `context_cn` 列 / 收藏存储 / 启动离线回填 / API 返回 → Task 1 + Task 2 + Task 3。
- 生词本与个人中心中文兜底 → Task 6。
- 不改视频听写页 / 统计口径 / 无 AI / 无新依赖 / ≥44px / reduced-motion → Global Constraints。
- 验证（单测/lint/build） → 各任务 + Task 6。
