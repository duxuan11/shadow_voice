# 生词听练「交互与视觉打磨」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把生词听练页打磨成：浅色一体化背景 + 轻量卡片动效 + 精致输入区 + 悬浮提示 + 连击反馈 + 完整键盘快捷键（含上一题）+ 快捷键帮助面板，PC 与手机均顺手。

**Architecture:** 新增一个纯函数快捷键模块 `src/utils/vocabShortcuts.js`（可单测），页面通过单一 `window.keydown` 监听调用它得到 action 再执行；所有动效用纯 CSS（零新依赖）。只改听练页与样式。

**Tech Stack:** React 19 + Vite 8 + react-router-dom 7；Node 内置测试 `node --test`；纯 CSS。

## Global Constraints

- 分支：`feat/vocab-listening-practice`（已存在，继续在其上迭代）。
- **只改**生词听练页相关文件：`src/pages/VocabPracticePage.jsx`、`src/utils/vocabShortcuts.js`(新)、`src/utils/vocabShortcuts.test.js`(新)、`src/index.css`、`README.md`。**不改** `DictationPage.jsx`、后端、数据模型、路由、统计口径。
- **不得复制参考站（comekey.com）的代码、样式表、类名或逐字文案**；颜色、键位、类名、动画参数均为本项目自行定义（借鉴交互思路即可）。
- 统计口径不变：熟练度仍 `round(correct_count / practice_count * 100)`，只有「首次提交」写入后端。
- 手机端：可点元素 ≥44px、`touch-action: manipulation`、不依赖 hover、适配安全区。
- 无新依赖；动效仅用 CSS `@keyframes`/`transition`。
- 测试：`node --test <file>`；验证：`node --test "src/utils/*.test.js"`、`npx eslint <changed files>`、`npm run build`。
- 已知预存在（不要修）：`server/lib/dataDir.test.cjs` 1 个 Windows 失败；`src/pages/VideoDetail.jsx`/`src/main.jsx` 等文件共 11 个 lint error。
- 不要提交 `data/consolidated.json`、`data/meta.json`、`data/shadow_voice.db`。

---

### Task 1: 快捷键纯函数模块 `src/utils/vocabShortcuts.js`

**Files:**
- Create: `src/utils/vocabShortcuts.js`
- Create: `src/utils/vocabShortcuts.test.js`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `SHORTCUT_GROUPS: Array<{ title: string, items: Array<{ keys: string[], label: string }> }>`
  - `resolveShortcut({ key, ctrlKey?, metaKey?, shiftKey?, altKey?, phase?, revealed?, hasResult?, helpOpen?, inputFocused? }): Action | null`，其中 `Action` ∈ `'start' | 'submit' | 'replay' | 'toggleChinese' | 'reveal' | 'retry' | 'next' | 'prev' | 'help' | 'closeHelp' | 'back' | 'again'`。

- [ ] **Step 1: 写失败测试** `src/utils/vocabShortcuts.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { SHORTCUT_GROUPS, resolveShortcut } from './vocabShortcuts.js'

const t = (over) => resolveShortcut({ phase: 'typing', ...over })
const r = (over) => resolveShortcut({ phase: 'review', ...over })

test('SHORTCUT_GROUPS：包含三个分组与键位数据', () => {
  assert.deepEqual(SHORTCUT_GROUPS.map(g => g.title), ['答题中', '对照中', '全局'])
  const labels = SHORTCUT_GROUPS.flatMap(g => g.items.map(i => i.label))
  assert.ok(labels.includes('提交'))
  assert.ok(labels.includes('再听一次'))
  assert.ok(labels.includes('上一题'))
})

test('答题中（输入框聚焦）：只处理不打字冲突的键', () => {
  assert.equal(t({ key: 'Enter', inputFocused: true }), 'submit')
  assert.equal(t({ key: 'Enter', shiftKey: true, inputFocused: true }), null)
  assert.equal(t({ key: 'Enter', ctrlKey: true, inputFocused: true }), null)
  assert.equal(t({ key: ' ', ctrlKey: true, inputFocused: true }), 'replay')
  assert.equal(t({ key: 'R', altKey: true, inputFocused: true }), 'replay')
  assert.equal(t({ key: 'h', ctrlKey: true, inputFocused: true }), 'toggleChinese')
  assert.equal(t({ key: '?', inputFocused: true }), null)
  assert.equal(t({ key: '/', inputFocused: true }), null)
  assert.equal(t({ key: '1', inputFocused: true }), null)
})

test('答题中（未聚焦）：Enter 提交、Ctrl+Space/Alt+R 重听、Ctrl+H 中文', () => {
  assert.equal(t({ key: 'Enter' }), 'submit')
  assert.equal(t({ key: 'Enter', shiftKey: true }), null)
  assert.equal(t({ key: ' ', ctrlKey: true }), 'replay')
  assert.equal(t({ key: 'r', altKey: true }), 'replay')
  assert.equal(t({ key: 'H', metaKey: true }), 'toggleChinese')
})

test('对照中：Enter/Space 下一题，数字 1-4，← 上一题', () => {
  assert.equal(r({ key: 'Enter' }), 'next')
  assert.equal(r({ key: ' ' }), 'next')
  assert.equal(r({ key: '1' }), 'replay')
  assert.equal(r({ key: '3' }), 'retry')
  assert.equal(r({ key: '4' }), 'next')
  assert.equal(r({ key: 'ArrowLeft' }), 'prev')
})

test('对照中：2 显示答案，但已有结果/已显示时为 null', () => {
  assert.equal(r({ key: '2', hasResult: false, revealed: false }), 'reveal')
  assert.equal(r({ key: '2', hasResult: true }), null)
  assert.equal(r({ key: '2', revealed: true }), null)
})

test('对照中：数字键带修饰键不触发', () => {
  assert.equal(r({ key: '1', ctrlKey: true }), null)
  assert.equal(r({ key: 'ArrowLeft', shiftKey: true }), null)
})

test('setup / finished：Enter 开始 / 再来一轮', () => {
  assert.equal(resolveShortcut({ key: 'Enter', phase: 'setup' }), 'start')
  assert.equal(resolveShortcut({ key: 'Enter', phase: 'finished' }), 'again')
  assert.equal(resolveShortcut({ key: 'x', phase: 'setup' }), null)
})

test('全局：?// 打开帮助（已打开则吞掉其他键），Esc 关面板或返回', () => {
  assert.equal(r({ key: '?' }), 'help')
  assert.equal(r({ key: '/' }), 'help')
  assert.equal(r({ key: '?', helpOpen: true }), null)
  assert.equal(r({ key: 'Enter', helpOpen: true }), null)
  assert.equal(r({ key: '1', helpOpen: true }), null)
  assert.equal(r({ key: 'Escape', helpOpen: true }), 'closeHelp')
  assert.equal(r({ key: 'Escape', helpOpen: false }), 'back')
  assert.equal(t({ key: 'Escape' }), 'back')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/vocabShortcuts.test.js`
Expected: FAIL（Cannot find module './vocabShortcuts.js'）

- [ ] **Step 3: 实现** `src/utils/vocabShortcuts.js`

```js
// 生词听练页键盘快捷键映射（纯函数，零依赖，不读 DOM，便于单测）。
// 页面只负责监听 keydown → 调用 resolveShortcut → 执行返回的 action。

export const SHORTCUT_GROUPS = [
  {
    title: '答题中',
    items: [
      { keys: ['Enter'], label: '提交' },
      { keys: ['Shift', 'Enter'], label: '换行' },
      { keys: ['Ctrl/⌘', 'Space'], label: '再听一次' },
      { keys: ['Alt', 'R'], label: '再听一次' },
      { keys: ['Ctrl/⌘', 'H'], label: '显示 / 隐藏中文' },
      { keys: ['Esc'], label: '返回' },
    ],
  },
  {
    title: '对照中',
    items: [
      { keys: ['Enter'], label: '下一题' },
      { keys: ['Space'], label: '下一题' },
      { keys: ['1'], label: '再听一次' },
      { keys: ['2'], label: '显示答案' },
      { keys: ['3'], label: '再练一次' },
      { keys: ['4'], label: '下一题' },
      { keys: ['←'], label: '上一题' },
      { keys: ['Esc'], label: '返回' },
    ],
  },
  {
    title: '全局',
    items: [
      { keys: ['?'], label: '快捷键帮助' },
      { keys: ['Esc'], label: '关闭帮助 / 返回' },
      { keys: ['Enter'], label: '开始练习 / 再来一轮' },
    ],
  },
]

/**
 * 把一次按键解析成动作 id；返回 null 表示不拦截（交给浏览器/输入框）。
 * inputFocused 为 true 时只处理不会与打字冲突的键。
 */
export function resolveShortcut({
  key,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
  altKey = false,
  phase = 'setup',
  revealed = false,
  hasResult = false,
  helpOpen = false,
  inputFocused = false,
} = {}) {
  const mod = ctrlKey || metaKey
  const plain = !ctrlKey && !metaKey && !altKey

  // Esc 在任何聚焦状态下都可用：优先关面板，否则返回
  if (key === 'Escape') return helpOpen ? 'closeHelp' : 'back'
  // 帮助面板打开时吞掉其他按键，避免误触题目操作
  if (helpOpen) return null

  if (inputFocused) {
    // 输入框聚焦：只处理不产生可见字符的键
    if (phase === 'typing') {
      if (key === 'Enter') {
        if (shiftKey || mod || altKey) return null
        return 'submit'
      }
      if (mod && key === ' ') return 'replay'
      if (altKey && (key === 'r' || key === 'R')) return 'replay'
      if (mod && (key === 'h' || key === 'H')) return 'toggleChinese'
    }
    return null
  }

  // 以下为「输入框未聚焦」
  if (key === '?' || key === '/') return 'help'

  if (phase === 'typing') {
    if (key === 'Enter') {
      if (shiftKey) return null
      return 'submit'
    }
    if (mod && key === ' ') return 'replay'
    if (altKey && (key === 'r' || key === 'R')) return 'replay'
    if (mod && (key === 'h' || key === 'H')) return 'toggleChinese'
    return null
  }

  if (phase === 'review') {
    if (key === 'Enter' || key === ' ') return 'next'
    if (key === 'ArrowLeft' && plain) return 'prev'
    if (key === '1' && plain) return 'replay'
    if (key === '2' && plain) return hasResult || revealed ? null : 'reveal'
    if (key === '3' && plain) return 'retry'
    if (key === '4' && plain) return 'next'
    if (altKey && (key === 'r' || key === 'R')) return 'replay'
    if (mod && (key === 'h' || key === 'H')) return 'toggleChinese'
    return null
  }

  if (phase === 'setup') return key === 'Enter' ? 'start' : null
  if (phase === 'finished') return key === 'Enter' ? 'again' : null
  return null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/vocabShortcuts.test.js`
Expected: PASS（8 个测试全部通过）

- [ ] **Step 5: 提交**

```bash
git add src/utils/vocabShortcuts.js src/utils/vocabShortcuts.test.js
git commit -m "feat(vocab): 听练页快捷键纯函数模块"
```

---

### Task 2: 页面接入快捷键 / 连击 / 上一题 / 帮助面板

**Files:**
- Modify: `src/pages/VocabPracticePage.jsx`（多处定点替换）

**Interfaces:**
- Consumes: Task 1 的 `resolveShortcut`、`SHORTCUT_GROUPS`；已有 `speaker.speak`、`checkSpelling`、`buildPracticeQueue` 等。
- Produces: 触发 `data-tip`/`.vocab-keycap`/`.vocab-combo`/`.vocab-help*`/`.vocab-icon-btn`/`.vocab-hoverhint`/`.vocab-card-anim` 等类名，供 Task 3 定义样式。

> 说明：本任务只改逻辑与结构，**样式在 Task 3**。改完后页面功能可用，仅视觉暂未生效。

- [ ] **Step 1: 改 import**

把这一行：
```jsx
import { ArrowLeft, Headphones, Eye, EyeOff, Send, ChevronRight, RotateCcw, Trash2, RefreshCw } from 'lucide-react'
```
替换为：
```jsx
import { ArrowLeft, Headphones, Eye, EyeOff, Send, ChevronRight, ChevronLeft, RotateCcw, Trash2, RefreshCw, HelpCircle, X } from 'lucide-react'
```
并在 `import { ... } from '../utils/vocabPractice'` 之后新增：
```jsx
import { resolveShortcut, SHORTCUT_GROUPS } from '../utils/vocabShortcuts'
```

- [ ] **Step 2: 新增状态与 ref**

在 `const [round, setRound] = useState({ attempted: 0, correct: 0 })` 之后新增：
```jsx
  const [combo, setCombo] = useState({ count: 0, max: 0 })
  const [comboVisible, setComboVisible] = useState(false)
  const [comboText, setComboText] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
```
在 `const inputRef = useRef(null)` 之后新增：
```jsx
  const historyRef = useRef(new Map())
  const comboRef = useRef(0)
  const comboHideRef = useRef(null)
```

- [ ] **Step 3: `startRound` 重置新状态**

在 `startRound` 内 `attemptedRef.current = new Set()` 之后新增：
```jsx
    historyRef.current = new Map()
    comboRef.current = 0
    setCombo({ count: 0, max: 0 })
    setComboVisible(false)
```

- [ ] **Step 4: 新增导航/连击辅助函数**

在 `startByType` 函数之后新增：
```jsx
  function snapshotCurrent() {
    if (!current) return
    historyRef.current.set(currentKey, { userInput, result, revealed })
  }

  function restoreFor(entry) {
    const key = entry ? (entry.word || normalizeVocabKey(entry.content)) : ''
    const snap = key ? historyRef.current.get(key) : null
    setUserInput(snap?.userInput ?? '')
    setResult(snap?.result ?? null)
    setRevealed(snap?.revealed ?? false)
  }

  function goto(newIndex) {
    snapshotCurrent()
    setIndex(newIndex)
    restoreFor(queue[newIndex] || null)
  }

  function replay() { if (current) speaker.speak(current.content) }
  function toggleChinese() { setShowChinese(v => !v) }
  function revealAnswer() { setRevealed(true) }
  function goBack() { navigate('/profile') }

  function showCombo(n) {
    setComboText(n)
    setComboVisible(true)
    if (comboHideRef.current) clearTimeout(comboHideRef.current)
    comboHideRef.current = setTimeout(() => setComboVisible(false), 1000)
  }
```

- [ ] **Step 5: `submit` 里累计连击**

在 `submit` 的 `if (!attemptedRef.current.has(currentKey)) { ... }` 块内，`setRound(prev => ...)` 之后新增：
```jsx
      const nextCombo = correct ? comboRef.current + 1 : 0
      comboRef.current = nextCombo
      setCombo(prev => ({ count: nextCombo, max: Math.max(prev.max, nextCombo) }))
      if (correct && nextCombo >= 2) showCombo(nextCombo)
```

- [ ] **Step 6: `next` 改用 `goto` 并新增 `prev`**

把：
```jsx
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
```
替换为：
```jsx
  function next() {
    if (index < queue.length - 1) {
      goto(index + 1)
    } else {
      speaker.stop()
      setPhase('finished')
    }
  }

  function prev() {
    if (index > 0) goto(index - 1)
  }
```

- [ ] **Step 7: 删除输入框本地 Enter 处理（改为全局统一）**

删除整个函数：
```jsx
  function handleInputKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
```
并删除 `<textarea ...>` 上的属性 `onKeyDown={handleInputKeyDown}`。

- [ ] **Step 8: 新增全局快捷键 effect + 定时器清理**

在「出题自动聚焦」那个 `useEffect` 之后新增：
```jsx
  // 全局快捷键：单一入口，交给纯函数 resolveShortcut 决定动作
  useEffect(() => {
    const handler = (e) => {
      const el = document.activeElement
      const inputFocused = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
      const action = resolveShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        phase,
        revealed,
        hasResult: !!result,
        helpOpen,
        inputFocused,
      })
      if (!action) return
      e.preventDefault()
      if (action === 'start' || action === 'again') startByType(selectedType)
      else if (action === 'submit') submit()
      else if (action === 'replay') replay()
      else if (action === 'toggleChinese') toggleChinese()
      else if (action === 'reveal') revealAnswer()
      else if (action === 'retry') retry()
      else if (action === 'next') next()
      else if (action === 'prev') prev()
      else if (action === 'help') setHelpOpen(true)
      else if (action === 'closeHelp') setHelpOpen(false)
      else if (action === 'back') goBack()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  useEffect(() => () => { if (comboHideRef.current) clearTimeout(comboHideRef.current) }, [])
```
（该 effect 故意不写依赖数组：每次渲染重新注册，保证闭包里的 `phase/result/index` 都是最新的。）

- [ ] **Step 9: 头部加「快捷键」按钮**

把：
```jsx
        <div className="dictation-header-center">
          <h1 className="dictation-title">生词听练</h1>
        </div>
      </div>
```
替换为：
```jsx
        <div className="dictation-header-center">
          <h1 className="dictation-title">生词听练</h1>
        </div>
        <div className="dictation-header-actions">
          <button
            type="button"
            className="vocab-icon-btn"
            onClick={() => setHelpOpen(true)}
            data-tip="快捷键 (?)"
            aria-label="快捷键帮助"
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </div>
```

- [ ] **Step 10: 卡片加动画 key/类、键帽提示、按钮 tooltip**

把 `<div className="dictation-card">` 替换为：
```jsx
          <div key={currentKey} className="dictation-card vocab-card-anim">
```
把输入区提示：
```jsx
                <div className="dictation-input-hints">
                  <span className="input-hint">Enter 提交</span>
                  <span className="input-hint">Shift+Enter 换行</span>
                </div>
```
替换为：
```jsx
                <div className="vocab-keyhints">
                  <span className="vocab-keycap">Enter</span>
                  <span className="vocab-keyhint-label">提交</span>
                  <span className="vocab-keycap">Shift</span>
                  <span className="vocab-keycap">Enter</span>
                  <span className="vocab-keyhint-label">换行</span>
                  <span className="vocab-keycap">Ctrl</span>
                  <span className="vocab-keycap">Space</span>
                  <span className="vocab-keyhint-label">重听</span>
                </div>
```
给答题态按钮加 `data-tip`：`提交` 按钮加 `data-tip="提交 (Enter)"`；答题态「再听一次」按钮加 `data-tip="再听一次 (Ctrl+Space)"`；「显示答案」按钮加 `data-tip="显示答案 (2)"`。

- [ ] **Step 11: 正确答案区加悬浮提示**

把：
```jsx
                <div className="spell-answer">
                  <span className="answer-label">正确答案：</span>
                  <span className="answer-text">{current.content}</span>
                </div>
```
替换为：
```jsx
                <div
                  className="spell-answer vocab-hoverhint"
                  data-hint={[current.phonetic, current.translation].filter(Boolean).join(' · ') || '暂无释义'}
                >
                  <span className="answer-label">正确答案：</span>
                  <span className="answer-text">{current.content}</span>
                </div>
```

- [ ] **Step 12: 对照操作区加「上一题」与 tooltip**

把整个 `<div className="dictation-nav"> ... </div>`（对照态那组按钮）替换为：
```jsx
                <div className="dictation-nav">
                  <button
                    onClick={prev}
                    disabled={index === 0}
                    className="dictation-action-btn"
                    data-tip="上一题 (←)"
                  >
                    <ChevronLeft size={16} />
                    <span>上一题</span>
                  </button>
                  <button onClick={retry} className="dictation-action-btn" data-tip="再练一次 (3)">
                    <RotateCcw size={16} />
                    <span>再练一次</span>
                  </button>
                  <button
                    onClick={() => speaker.speak(current.content)}
                    className="dictation-action-btn replay-btn"
                    data-tip="再听一次 (1)"
                  >
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={removeCurrent} className="dictation-action-btn skip-btn" data-tip="移除生词本">
                    <Trash2 size={16} />
                    <span>移除生词本</span>
                  </button>
                  <button onClick={next} className="dictation-action-btn submit-btn" data-tip="下一题 (4 / Enter)">
                    <span>{index < queue.length - 1 ? '下一题' : '完成'}</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
```

- [ ] **Step 13: 连击浮层**

在练习态 fragment 收尾处：
```jsx
          </div>
        </>
      ) : (
```
替换为：
```jsx
          </div>

          {comboVisible && (
            <div className="vocab-combo" role="status">连击 x{comboText}</div>
          )}
        </>
      ) : (
```

- [ ] **Step 14: 完成页加「最长连击」**

在完成页「正确率」统计卡之后新增：
```jsx
            <div className="finished-stat">
              <span className="finished-stat-value">{combo.max}</span>
              <span className="finished-stat-label">最长连击</span>
            </div>
```

- [ ] **Step 15: 帮助面板**

把页面末尾：
```jsx
      )}
    </div>
  )
}
```
替换为：
```jsx
      )}

      {helpOpen && (
        <div className="vocab-help-mask" onClick={() => setHelpOpen(false)}>
          <div className="vocab-help" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <div className="vocab-help-head">
              <h2>键盘快捷键</h2>
              <button type="button" className="vocab-icon-btn" onClick={() => setHelpOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.title} className="vocab-help-group">
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map((item, i) => (
                    <li key={i}>
                      <span className="vocab-help-keys">
                        {item.keys.map((k, j) => <span key={j} className="vocab-keycap">{k}</span>)}
                      </span>
                      <span className="vocab-help-label">{item.label}</span>
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
}
```

- [ ] **Step 16: 验证**

Run:
```bash
npx eslint src/pages/VocabPracticePage.jsx
npm run build
node --test "src/utils/*.test.js"
```
Expected: eslint 0 error/0 warning；build 成功；117 + 8 个测试全绿。

- [ ] **Step 17: 提交**

```bash
git add src/pages/VocabPracticePage.jsx
git commit -m "feat(vocab): 听练页快捷键/连击/上一题/帮助面板"
```

---

### Task 3: 听练页样式（背景一体化 / 卡片动效 / 输入区 / 键帽 / tooltip / 连击 / 帮助面板 / 移动端）

**Files:**
- Modify: `src/index.css`（文件末尾追加）

**Interfaces:**
- Consumes: Task 2 定义的类名：`.vocab-icon-btn`、`.vocab-keyhints`、`.vocab-keycap`、`.vocab-keyhint-label`、`.vocab-card-anim`、`.vocab-hoverhint`、`.vocab-combo`、`.vocab-help-mask`、`.vocab-help`、`.vocab-help-head`、`.vocab-help-group`、`.vocab-help-keys`、`.vocab-help-label`。
- Produces: 视觉与动效；不改任何 JS。

- [ ] **Step 1: 追加样式**（`src/index.css` 末尾）

```css
/* ===== Vocab Practice — interaction polish ===== */
.vocab-practice-page {
  background:
    radial-gradient(680px 340px at 50% 20%, rgba(99, 102, 241, 0.10), transparent 70%),
    linear-gradient(180deg, #eef2ff 0%, #f8fafc 42%, #f5f3ff 100%);
}
.vocab-practice-page .dictation-card {
  border-radius: 20px;
  border-color: #e8ecf7;
  box-shadow: 0 18px 44px rgba(40, 58, 110, 0.10);
}
@keyframes vocabCardIn {
  from { opacity: 0; transform: translateY(16px) scale(0.97); }
  to   { opacity: 1; transform: none; }
}
.vocab-card-anim { animation: vocabCardIn 0.3s ease-out both; }
@keyframes vocabFadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}
.vocab-card-anim .spell-result,
.vocab-card-anim .spell-answer,
.vocab-card-anim .vocab-practice-verdict {
  animation: vocabFadeUp 0.28s ease-out both;
  animation-delay: 0.08s;
}

/* 精致输入区 */
.vocab-practice-page .dictation-input {
  font-size: 22px;
  border-radius: 14px;
  padding: 18px 20px;
}
.vocab-practice-page .dictation-input:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
}

/* 键帽 */
.vocab-keyhints { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vocab-keycap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid #c7d2fe;
  background: #eef2ff;
  color: #4338ca;
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, 'SF Mono', 'Fira Code', monospace;
}
.vocab-keyhint-label { font-size: 11px; color: #94a3b8; margin-right: 6px; }

/* 图标按钮 + 纯 CSS tooltip */
.vocab-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #475569;
  cursor: pointer;
  touch-action: manipulation;
}
.vocab-icon-btn:hover { background: #f8fafc; border-color: #cbd5e1; color: #2563eb; }
[data-tip] { position: relative; }
[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  left: 50%;
  top: calc(100% + 8px);
  transform: translateX(-50%) translateY(4px);
  background: #1e293b;
  color: #fff;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 6px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s, transform 0.15s;
  z-index: 50;
}
[data-tip]:hover::after,
[data-tip]:focus-visible::after { opacity: 1; transform: translateX(-50%) translateY(0); }

/* 正确答案悬浮：音标 + 释义 */
.vocab-hoverhint { cursor: help; position: relative; }
.vocab-hoverhint::before {
  content: attr(data-hint);
  position: absolute;
  left: 16px;
  bottom: calc(100% + 8px);
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
  z-index: 40;
}
.vocab-hoverhint:hover::before { opacity: 1; }

/* 连击 */
@keyframes vocabComboIn {
  0%   { opacity: 0; transform: translate(-50%, 12px) scale(0.6); }
  60%  { opacity: 1; transform: translate(-50%, 0) scale(1.08); }
  100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
.vocab-combo {
  position: fixed;
  left: 50%;
  bottom: 120px;
  z-index: 900;
  transform: translate(-50%, 0);
  padding: 8px 18px;
  border-radius: 999px;
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  color: #fff;
  font-weight: 800;
  font-size: 16px;
  box-shadow: 0 10px 26px rgba(79, 70, 229, 0.35);
  pointer-events: none;
  animation: vocabComboIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
}

/* 帮助面板 */
.vocab-help-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
@keyframes vocabHelpIn {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
.vocab-help {
  width: min(560px, 100%);
  max-height: 85vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 18px;
  padding: 22px 24px;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.3);
  animation: vocabHelpIn 0.25s ease-out both;
}
.vocab-help-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.vocab-help-head h2 { font-size: 18px; font-weight: 700; color: #1e293b; }
.vocab-help-group { margin-top: 14px; }
.vocab-help-group h3 { font-size: 13px; color: #64748b; font-weight: 600; margin-bottom: 8px; }
.vocab-help-group ul { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.vocab-help-group li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.vocab-help-keys { display: inline-flex; gap: 4px; }
.vocab-help-label { font-size: 13px; color: #334155; }

/* 完成页四张统计卡自适应 */
.vocab-practice-page .finished-stats { flex-wrap: wrap; }

@media (max-width: 640px) {
  .vocab-keyhints { display: none; }
  .vocab-combo { bottom: calc(96px + env(safe-area-inset-bottom)); }
  .vocab-practice-page .dictation-input { font-size: 18px; }
  .vocab-help { padding: 18px; }
  .vocab-practice-page { padding-bottom: calc(40px + env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) {
  .vocab-card-anim,
  .vocab-card-anim .spell-result,
  .vocab-card-anim .spell-answer,
  .vocab-card-anim .vocab-practice-verdict,
  .vocab-combo,
  .vocab-help { animation: none; }
}
```

- [ ] **Step 2: 验证**

Run:
```bash
npm run build
npx eslint src/pages/VocabPracticePage.jsx src/utils/vocabShortcuts.js
```
Expected: build 成功；eslint 0 error。

- [ ] **Step 3: 手动冒烟（桌面 1280×800 + 手机 390×844）**

- 背景为浅色一体化渐变，卡片有轻阴影；切题时卡片有淡入动画。
- 输入框聚焦有蓝色描边 + 外发光；下方键帽提示正确。
- hover 图标按钮出 tooltip（含快捷键）；hover 正确答案出「音标 · 释义」气泡。
- 连续首次答对 ≥2 出现「连击 xN」浮层并约 1s 后消失；答错清零。
- `?` 打开帮助面板、`Esc` 关闭；对照态 `1/2/3/4`、`←` 上一题、`Enter` 下一题均生效。
- 手机视口：键帽隐藏、按钮换行、连击不遮挡、帮助面板可滚动。

- [ ] **Step 4: 提交**

```bash
git add src/index.css
git commit -m "style(vocab): 听练页一体化背景/动效/键帽/连击/帮助面板"
```

---

### Task 4: 文档 + 全量验证

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 前 3 个任务成果。
- Produces: 更新后的文档与验证结果。

- [ ] **Step 1: README 补充快捷键说明**

在 `README.md` 的「### 🎧 生词听练（听练一体）」小节里追加一行：
```markdown
- **快捷键**：`Enter` 提交/下一题、`Shift+Enter` 换行、`Ctrl+Space`/`Alt+R` 再听一次、`Ctrl+H` 显示中文、`1/2/3/4` 再听/显示答案/再练/下一题、`←` 上一题、`?` 快捷键帮助、`Esc` 返回
```

- [ ] **Step 2: 全量验证**

Run:
```bash
node --test "src/utils/*.test.js"
node --test "server/**/*.test.cjs"
node --test scripts/copy-data.test.mjs
npm run lint
npm run build
```
Expected:
- `src/utils`：117 + 8（新）全绿。
- `server`：113/114（1 个预存在 dataDir Windows 失败）。
- `scripts`：3/3。
- `npm run lint`：11 个预存在 error（0 个来自本功能文件）。
- `npm run build`：成功。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: 生词听练快捷键说明"
```

---

## 自查记录（spec 覆盖对照）

- 背景一体化 / 卡片动效 / 输入区 / 悬浮提示 / 顶部进度 → Task 3。
- 快捷键（含 `Ctrl+Space` 与 `Alt+R`、`?` 帮助、`Esc` 分层） → Task 1 + Task 2 Step 8。
- 连击 + 完成页最长连击 → Task 2 Step 5/13/14 + Task 3。
- 上一题（恢复该题作答、统计不重复计入） → Task 2 Step 4/6/12。
- 快捷键帮助面板 → Task 2 Step 9/15 + Task 3。
- 手机端（隐藏键帽、按钮换行、安全区、≥44px） → Task 3。
- 不改视频听写页 / 不改统计口径 / 无新依赖 / 未复制参考站 → Global Constraints + 各任务范围。
- 验证（eslint/build/单测） → Task 2 Step 16、Task 3 Step 2、Task 4 Step 2。
