# 生词听练「沉浸式深色舞台（A 档）」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把生词听练页升级为沉浸式深色 3D 舞台，并把拼写输入从 textarea 换成「逐词下划线槽位」，判定直接显示在槽位上。

**Architecture:** 新增纯函数模块 `spellSlots.js`（槽位拆分/判定/粘贴）与受控组件 `SpellSlots.jsx`；页面替换输入区并保留统计/连击/上一题/快捷键；深色视觉纯 CSS 写进 `index.css`；`App.jsx` 在该路由隐藏全局导航。

**Tech Stack:** React 19 + Vite 8 + react-router-dom 7；Node 内置测试；纯 CSS（零新依赖）。

## Global Constraints

- 分支：`feat/vocab-listening-practice`（继续在其上迭代）。
- **只改**：`src/pages/VocabPracticePage.jsx`、`src/index.css`、`src/App.jsx`、`src/components/SpellSlots.jsx`(新)、`src/utils/spellSlots.js`(新)、`src/utils/spellSlots.test.js`(新)、`README.md`。**不改**后端、`DictationPage.jsx`、`src/utils/spellCheck.js`、其他页面。
- 统计口径不变：只有「首次提交」写后端；熟练度公式不变。
- 快捷键保留：`Tab` 显示答案、`Ctrl+Space`/`Alt+R` 重听、`Ctrl+H` 中文、`1/3/4`、`←` 上一题、`?` 帮助、`Esc` 返回。槽位内 `Enter/空格/方向键/退格` 由槽位组件处理。
- **不得复制参考站代码/样式/类名**；全部自研。
- 零新依赖、无音效；`prefers-reduced-motion` 兜底；手机端 ≥44px、`touch-action: manipulation`、安全区。
- 测试：`node --test "src/utils/*.test.js"`、`npx eslint <changed>`、`npm run build`。
- 不要提交 `data/consolidated.json`、`data/meta.json`、`data/shadow_voice.db`。

---

### Task 1: 纯函数模块 `src/utils/spellSlots.js`

**Files:** Create `src/utils/spellSlots.js`, `src/utils/spellSlots.test.js`

**Interfaces (Produces):**
```js
splitToSlots(expected) -> string[]
slotCountFor(expected) -> number
compareSlots(values, expectedWords) -> Array<{status:'correct'|'wrong'|'missing', expected:string, user:string}>
distributePaste(text, count, startIndex = 0, base = []) -> string[]
joinSlots(values) -> string
slotsAllCorrect(statuses) -> boolean
```

- [ ] **Step 1: 写失败测试** `src/utils/spellSlots.test.js`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitToSlots, slotCountFor, compareSlots, distributePaste, joinSlots, slotsAllCorrect,
} from './spellSlots.js'

test('splitToSlots / slotCountFor：去标点、合并空白、至少 1 槽', () => {
  assert.deepEqual(splitToSlots('It turns out that ...'), ['It', 'turns', 'out', 'that'])
  assert.equal(slotCountFor('check in'), 2)
  assert.equal(slotCountFor(''), 1)
})

test('compareSlots：correct / wrong / missing', () => {
  const r = compareSlots(['check', '', 'now'], ['check', 'in', 'now'])
  assert.deepEqual(r.map(x => x.status), ['correct', 'missing', 'wrong'])
  assert.equal(r[2].expected, 'now')
  assert.equal(r[1].expected, 'in')
})

test('compareSlots：大小写与标点不敏感', () => {
  const r = compareSlots(['Check-in'], ['check in'])
  assert.equal(r.length, 1)
  assert.equal(r[0].status, 'wrong') // 槽位是逐词，'Check-in' 归一为 'check-in' != 'check'
  assert.equal(compareSlots(['CHECK'], ['check'])[0].status, 'correct')
})

test('distributePaste：从中间开始，超出并入末槽', () => {
  assert.deepEqual(distributePaste('a b c', 2, 0), ['a', 'b c'])
  assert.deepEqual(distributePaste('x y', 3, 1), ['', 'x', 'y'])
  assert.deepEqual(distributePaste('  one   two  ', 2, 0, ['base', '']), ['one', 'two'])
})

test('joinSlots：拼接并去尾空白', () => {
  assert.equal(joinSlots(['check', '', 'in']), 'check  in')
  assert.equal(joinSlots(['a', 'b']), 'a b')
})

test('slotsAllCorrect', () => {
  assert.equal(slotsAllCorrect([{ status: 'correct' }]), true)
  assert.equal(slotsAllCorrect([{ status: 'correct' }, { status: 'wrong' }]), false)
  assert.equal(slotsAllCorrect([]), false)
})
```

- [ ] **Step 2: 运行确认失败** — `node --test src/utils/spellSlots.test.js` → FAIL（模块不存在）。

- [ ] **Step 3: 实现** `src/utils/spellSlots.js`

```js
// 生词听练「逐词槽位」纯函数：拆分期望答案、逐槽判定、粘贴分配。
// 零依赖；复用 spellCheck 的 normalizeText/tokenize（只读，不改该文件）。
import { normalizeText, tokenize } from './spellCheck'

export function splitToSlots(expected) {
  return tokenize(expected)
}

export function slotCountFor(expected) {
  return Math.max(1, splitToSlots(expected).length)
}

export function compareSlots(values, expectedWords) {
  const list = Array.isArray(values) ? values : []
  const expected = Array.isArray(expectedWords) ? expectedWords : []
  const n = Math.max(list.length, expected.length)
  const out = []
  for (let i = 0; i < n; i++) {
    const user = String(list[i] ?? '').trim()
    const exp = String(expected[i] ?? '')
    if (!user) out.push({ status: 'missing', expected: exp, user: '' })
    else if (normalizeText(user).toLowerCase() === normalizeText(exp).toLowerCase()) {
      out.push({ status: 'correct', expected: exp, user })
    } else {
      out.push({ status: 'wrong', expected: exp, user })
    }
  }
  return out
}

export function distributePaste(text, count, startIndex = 0, base = []) {
  const n = Math.max(1, Number(count) || 1)
  const out = Array.from({ length: n }, (_, k) => String(base[k] ?? ''))
  const start = Math.min(Math.max(0, Number(startIndex) || 0), n - 1)
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  let i = start
  for (const w of words) {
    if (i >= n - 1) {
      out[n - 1] = out[n - 1] ? `${out[n - 1]} ${w}` : w
      i = n
    } else {
      out[i] = w
      i += 1
    }
  }
  return out
}

export function joinSlots(values) {
  return (Array.isArray(values) ? values : []).map(v => String(v ?? '').trim()).join(' ').trim()
}

export function slotsAllCorrect(statuses) {
  return Array.isArray(statuses) && statuses.length > 0 && statuses.every(s => s.status === 'correct')
}
```

- [ ] **Step 4: 运行确认通过** — `node --test src/utils/spellSlots.test.js` → PASS。

- [ ] **Step 5: 提交** — `git add src/utils/spellSlots.js src/utils/spellSlots.test.js && git commit -m "feat(vocab): 听练槽位拆分/判定纯函数"`

---

### Task 2: 槽位输入组件 `src/components/SpellSlots.jsx`

**Files:** Create `src/components/SpellSlots.jsx`

**Interfaces:**
- Consumes: `distributePaste` from `../utils/spellSlots`。
- Produces: `<SpellSlots expectedWords value onChange onSubmit disabled statuses revealed />`（默认导出）。

**Props**
- `expectedWords: string[]` — 期望词（槽数、揭示、错误提示）
- `value: string[]` — 受控槽值
- `onChange(next: string[]): void`
- `onSubmit(): void` — 最后一槽 Enter
- `disabled?: boolean` — 提交后/揭示后只读
- `statuses?: Array<{status:'correct'|'wrong'|'missing', expected:string, user:string}> | null`
- `revealed?: boolean`

- [ ] **Step 1: 创建组件**

```jsx
import { useEffect, useRef } from 'react'
import { distributePaste } from '../utils/spellSlots'

// 逐词下划线槽位输入。
// 槽位内处理 Enter/空格/方向键/退格，并 stopPropagation，避免与全局快捷键冲突；
// Tab / Ctrl+Space / Alt+R / Ctrl+H / Esc 不拦截，交给页面全局监听。
export default function SpellSlots({
  expectedWords = [],
  value = [],
  onChange,
  onSubmit,
  disabled = false,
  statuses = null,
  revealed = false,
}) {
  const refs = useRef([])
  const slots = expectedWords.length > 0 ? expectedWords.length : Math.max(1, value.length)
  const readOnly = disabled || revealed

  useEffect(() => {
    if (!disabled && refs.current[0]) refs.current[0].focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const focusSlot = (i) => {
    const idx = Math.max(0, Math.min(slots - 1, i))
    const el = refs.current[idx]
    if (el) { el.focus(); el.select?.() }
  }

  const setAt = (i, v) => {
    const next = Array.from({ length: slots }, (_, k) => value[k] ?? '')
    next[i] = v
    onChange?.(next)
  }

  const handleKeyDown = (e, i) => {
    if (readOnly) return
    const modified = e.ctrlKey || e.metaKey || e.altKey
    if (e.key === ' ' && !modified) {
      e.preventDefault(); e.stopPropagation()
      if (i < slots - 1) focusSlot(i + 1)
      return
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); focusSlot(i + 1); return }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); focusSlot(i - 1); return }
    if (e.key === 'Backspace' && !(value[i] ?? '')) { e.preventDefault(); e.stopPropagation(); focusSlot(i - 1); return }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      if (i < slots - 1) focusSlot(i + 1)
      else onSubmit?.()
      return
    }
    // 其余按键（含 Tab/Ctrl+Space/Alt+R/Ctrl+H/Esc）冒泡给全局
  }

  const handlePaste = (e, i) => {
    if (readOnly) return
    const text = e.clipboardData?.getData('text') ?? ''
    if (!text || !/\s/.test(text.trim())) return
    e.preventDefault()
    onChange?.(distributePaste(text, slots, i, value))
  }

  return (
    <div className="spell-slots" role="group" aria-label="拼写输入">
      {Array.from({ length: slots }).map((_, i) => {
        const st = statuses?.[i]?.status
        const shown = revealed && !statuses ? (expectedWords[i] ?? '') : (value[i] ?? '')
        const cls = ['spell-slot']
        if (st) cls.push(`is-${st}`)
        if (revealed && !statuses) cls.push('is-revealed')
        return (
          <span key={i} className="spell-slot-wrap">
            <input
              ref={el => { refs.current[i] = el }}
              type="text"
              className={cls.join(' ')}
              value={shown}
              readOnly={readOnly}
              disabled={readOnly}
              onChange={e => setAt(i, e.target.value)}
              onKeyDown={e => handleKeyDown(e, i)}
              onPaste={e => handlePaste(e, i)}
              onFocus={e => e.target.select()}
              style={{ width: `${Math.max(4, shown.length + 1)}ch` }}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              aria-label={`第 ${i + 1} 个词`}
            />
            {st === 'wrong' && <span className="spell-slot-hint">{expectedWords[i]}</span>}
          </span>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: 验证** — `npx eslint src/components/SpellSlots.jsx` 无 error；`npm run build` 成功。

- [ ] **Step 3: 提交** — `git add src/components/SpellSlots.jsx && git commit -m "feat(vocab): 逐词下划线槽位输入组件"`

---

### Task 3: 页面接入槽位（替换 textarea 与比对区）

**Files:** Modify `src/pages/VocabPracticePage.jsx`

**Interfaces:**
- Consumes: Task 1 的 `splitToSlots/compareSlots/joinSlots/slotsAllCorrect`，Task 2 的 `SpellSlots`。
- Produces: `.spell-slots`/`.spell-slot`/`.spell-slot-hint` 等类名供 Task 4 使用。

> 只改逻辑与结构；样式在 Task 4。

- [ ] **Step 1: import 调整**
  - 删除 `import { checkSpelling, isAllCorrect } from '../utils/spellCheck'`。
  - 新增：
```jsx
import SpellSlots from '../components/SpellSlots'
import { splitToSlots, compareSlots, joinSlots, slotsAllCorrect } from '../utils/spellSlots'
```

- [ ] **Step 2: 状态改名** — 把 `const [userInput, setUserInput] = useState('')` 改为：
```jsx
  const [slotValues, setSlotValues] = useState([])
```

- [ ] **Step 3: 期望词与槽值派生** — 在 `const currentKey = ...` 之后新增：
```jsx
  const expectedWords = useMemo(() => splitToSlots(current?.content || ''), [current])
```

- [ ] **Step 4: `startRound` / `retry` / 快照**
  - `startRound` 里 `setUserInput('')` → `setSlotValues([])`。
  - `retry()` 改为：
```jsx
  function retry() {
    setSlotValues(Array.from({ length: expectedWords.length }, () => ''))
    setResult(null)
    setRevealed(false)
  }
```
  - `snapshotCurrent` 存 `slotValues`：`historyRef.current.set(currentKey, { slotValues, result, revealed })`。
  - `restoreFor` 恢复：`setSlotValues(snap?.slotValues ?? [])`。
  - `goto`/`next`/`prev` 中原先的 `setUserInput('')` 删除（由 `restoreFor` 统一设置）。

- [ ] **Step 5: `submit` 改用槽位判定**
```jsx
  async function submit() {
    if (!current) return
    if (!joinSlots(slotValues)) return
    const statuses = compareSlots(slotValues, expectedWords)
    const correct = slotsAllCorrect(statuses)
    setResult({ statuses, correct })
    if (attemptedRef.current.has(currentKey)) return
    attemptedRef.current.add(currentKey)
    setRound(prev => ({ attempted: prev.attempted + 1, correct: prev.correct + (correct ? 1 : 0) }))
    const nextCombo = correct ? comboRef.current + 1 : 0
    comboRef.current = nextCombo
    setCombo(prev => ({ count: nextCombo, max: Math.max(prev.max, nextCombo) }))
    if (correct && nextCombo >= 2) showCombo(nextCombo)
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
```

- [ ] **Step 6: 渲染替换** — 把卡片内「输入区」与「比对区」整段替换为：
```jsx
            <SpellSlots
              key={currentKey}
              expectedWords={expectedWords}
              value={slotValues}
              onChange={setSlotValues}
              onSubmit={submit}
              disabled={!!result || revealed}
              statuses={result?.statuses ?? null}
              revealed={revealed && !result}
            />

            {!result && !revealed && (
              <div className="dictation-input-area">
                <div className="dictation-action-buttons">
                  <button
                    onClick={submit}
                    disabled={!joinSlots(slotValues)}
                    className="dictation-action-btn submit-btn"
                    data-tip="提交 (Enter)"
                  >
                    <Send size={16} />
                    <span>提交</span>
                  </button>
                  <button
                    onClick={() => speaker.speak(current.content)}
                    className="dictation-action-btn replay-btn"
                    data-tip="再听一次 (Ctrl+Space)"
                  >
                    <Headphones size={16} />
                    <span>再听一次</span>
                  </button>
                  <button onClick={() => setRevealed(true)} className="dictation-action-btn" data-tip="显示答案 (Tab)">
                    <Eye size={16} />
                    <span>显示答案</span>
                  </button>
                </div>
                <div className="vocab-keyhints">
                  <span className="vocab-keycap">Space</span><span className="vocab-keyhint-label">下一词</span>
                  <span className="vocab-keycap">Enter</span><span className="vocab-keyhint-label">提交</span>
                  <span className="vocab-keycap">Tab</span><span className="vocab-keyhint-label">显示答案</span>
                </div>
              </div>
            )}

            {(result || revealed) && (
              <div className="dictation-review">
                {result && (
                  <p className={`vocab-practice-verdict ${result.correct ? 'is-correct' : 'is-wrong'}`}>
                    {result.correct ? '✅ 完全正确' : '❌ 有出入，看槽位上的提示'}
                  </p>
                )}
                <div className="dictation-nav">
                  <button onClick={prev} disabled={index === 0} className="dictation-action-btn" data-tip="上一题 (←)">
                    <ChevronLeft size={16} /><span>上一题</span>
                  </button>
                  <button onClick={retry} className="dictation-action-btn" data-tip="再练一次 (3)">
                    <RotateCcw size={16} /><span>再练一次</span>
                  </button>
                  <button
                    onClick={() => speaker.speak(current.content)}
                    className="dictation-action-btn replay-btn"
                    data-tip="再听一次 (1)"
                  >
                    <Headphones size={16} /><span>再听一次</span>
                  </button>
                  <button onClick={removeCurrent} className="dictation-action-btn skip-btn" data-tip="移除生词本">
                    <Trash2 size={16} /><span>移除生词本</span>
                  </button>
                  <button onClick={next} className="dictation-action-btn submit-btn" data-tip="下一题 (4 / Enter)">
                    <span>{index < queue.length - 1 ? '下一题' : '完成'}</span>
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
```
  - 删除原 textarea 区块、原 `spell-result` 比对行、原 `.spell-answer` 正确答案行、原 `dictation-hint` 保持（中文开关保留）。
  - 删除不再使用的 `Send`? 仍用。确认删除未用 import（如有）。
  - **清理残留**：`rg -n "userInput|setUserInput|checkSpelling|isAllCorrect" src/pages/VocabPracticePage.jsx` 必须无结果（全部改为 `slotValues/setSlotValues`）。

- [ ] **Step 7: 校验全局快捷键仍通** — 槽位组件已 `stopPropagation` Enter/空格/方向键；`resolveShortcut` 不改。

- [ ] **Step 8: 验证** — `npx eslint src/pages/VocabPracticePage.jsx` 无 error；`npm run build` 成功；`node --test "src/utils/*.test.js"` 全绿。

- [ ] **Step 9: 提交** — `git add src/pages/VocabPracticePage.jsx && git commit -m "feat(vocab): 听练页接入逐词槽位输入"`

---

### Task 4: 沉浸式深色样式 + 隐藏导航

**Files:** Modify `src/index.css`, `src/App.jsx`

- [ ] **Step 1: `App.jsx` 隐藏该页导航**
  - 在 `const isVideoPage = ...` 之后新增：`const isVocabPractice = location.pathname.startsWith('/vocab/practice')`。
  - `<nav className={...}>` 改为：当 `isVocabPractice` 时用 `hidden`（全断点隐藏），否则沿用原逻辑。
  - `<main className={...}>`：`isVocabPractice` 时去掉内边距（全屏）。

- [ ] **Step 2: 追加深色样式**（`src/index.css` 末尾）

```css
/* ===== Vocab Practice — dark immersive stage (A) ===== */
.vocab-practice-page {
  color: #e8ecf8;
  background:
    radial-gradient(900px 520px at 50% 12%, rgba(99, 102, 241, 0.22), transparent 62%),
    linear-gradient(180deg, #0b1020 0%, #131a35 46%, #1a1440 100%);
  min-height: 100vh;
  perspective: 1200px;
}
.vocab-practice-page .dictation-title,
.vocab-practice-page .back-btn { color: #cbd5f5; }
.vocab-practice-page .dictation-card {
  position: relative;
  overflow: hidden;
  min-height: 520px;
  border-radius: 28px;
  border: 1px solid rgba(148, 163, 255, 0.16);
  background: linear-gradient(180deg, #181f3a 0%, #141b33 100%);
  box-shadow: 0 28px 70px rgba(4, 8, 24, 0.6);
  display: flex;
  flex-direction: column;
}
.vocab-practice-page .dictation-card::before {
  content: '';
  position: absolute;
  left: 50%; top: 46%;
  width: 78%; height: 62%;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle, rgba(99, 102, 241, 0.28), transparent 68%);
  filter: blur(30px);
  pointer-events: none;
}
.vocab-practice-page .dictation-card::after {
  content: '';
  position: absolute; inset: -40% -20% auto;
  height: 70%;
  background: linear-gradient(120deg, transparent 22%, rgba(255, 255, 255, 0.06) 48%, transparent 74%);
  transform: rotate(-8deg);
  pointer-events: none;
}
.vocab-practice-page .dictation-card > * { position: relative; z-index: 1; }
@keyframes vocabStageIn {
  from { opacity: 0; transform: translateY(36px) scale(0.9) rotateX(12deg); }
  to   { opacity: 1; transform: none; }
}
.vocab-card-anim { animation: vocabStageIn 0.5s cubic-bezier(0.16, 1.2, 0.3, 1) both; }

/* 槽位 */
.spell-slots {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: center;
  gap: 18px 16px;
  margin: 28px 0 8px;
}
.spell-slot-wrap { position: relative; display: inline-flex; flex-direction: column; align-items: center; }
.spell-slot {
  box-sizing: content-box;
  min-width: 2ch;
  padding: 2px 4px 6px;
  border: 0;
  border-bottom: 2px solid rgba(203, 213, 245, 0.35);
  background: transparent;
  color: #fff;
  font-size: clamp(26px, 4vw, 40px);
  font-weight: 700;
  text-align: center;
  outline: none;
  caret-color: #22d3ee;
}
.spell-slot:focus { border-bottom-color: #22d3ee; box-shadow: 0 6px 18px -8px rgba(34, 211, 238, 0.9); }
.spell-slot.is-correct { border-bottom-color: #34d399; color: #6ee7b7; }
.spell-slot.is-wrong { border-bottom-color: #f87171; color: #fca5a5; }
.spell-slot.is-missing { border-bottom-style: dashed; border-bottom-color: #fbbf24; }
.spell-slot.is-revealed { border-bottom-color: #fbbf24; color: #fde68a; }
.spell-slot-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #fca5a5;
  font-weight: 600;
}

/* 深色下的辅助元素 */
.vocab-practice-page .dictation-hint .dictation-chinese { background: rgba(255,255,255,0.06); color: #cbd5f5; border-left-color: #6366f1; }
.vocab-practice-page .dictation-chinese-placeholder { background: rgba(255,255,255,0.04); color: #94a3b8; border-color: rgba(255,255,255,0.15); }
.vocab-practice-page .dictation-audio-bar { background: rgba(99,102,241,0.14); }
.vocab-practice-page .dictation-action-btn { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.16); color: #dbe3fb; }
.vocab-practice-page .dictation-action-btn:hover { background: rgba(255,255,255,0.12); }
.vocab-practice-page .dictation-action-btn.submit-btn { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-color: transparent; color: #fff; }
.vocab-practice-page .vocab-practice-btn { background: rgba(99,102,241,0.18); border-color: rgba(148,163,255,0.35); color: #c7d2fe; }
.vocab-practice-page .vocab-type-badge { background: rgba(99,102,241,0.2); color: #c7d2fe; }
.vocab-practice-page .dictation-progress-bar { background: rgba(255,255,255,0.1); }
.vocab-practice-page .vocab-keycap { border-color: rgba(148,163,255,0.4); background: rgba(99,102,241,0.16); color: #c7d2fe; }
.vocab-practice-page .vocab-keyhint-label { color: #94a3b8; }
.vocab-practice-page .stat-item { color: #a5b4fc; }
.vocab-practice-page .stat-item strong { color: #fff; }
.vocab-practice-page .finished-stat-value { color: #fff; }
.vocab-practice-page .finished-stat-label { color: #a5b4fc; }
.vocab-practice-page .vocab-practice-verdict.is-correct { color: #6ee7b7; }
.vocab-practice-page .vocab-practice-verdict.is-wrong { color: #fca5a5; }

/* 连击加强 */
.vocab-practice-page .vocab-combo {
  font-size: 20px;
  padding: 10px 24px;
  box-shadow: 0 0 30px rgba(139, 92, 246, 0.65), 0 10px 26px rgba(0,0,0,0.4);
}

/* 帮助面板深色 */
.vocab-practice-page .vocab-help { background: #161d33; color: #e8ecf8; box-shadow: 0 24px 60px rgba(0,0,0,0.6); }
.vocab-practice-page .vocab-help-head h2 { color: #fff; }
.vocab-practice-page .vocab-help-group h3 { color: #a5b4fc; }
.vocab-practice-page .vocab-help-label { color: #cbd5f5; }
.vocab-practice-page .vocab-icon-btn { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.16); color: #cbd5f5; }
.vocab-practice-page .vocab-icon-btn:hover { color: #22d3ee; }

/* 工具栏/设置页深色 */
.vocab-practice-page .vocab-filter-btn { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.14); color: #cbd5f5; }
.vocab-practice-page .vocab-filter-btn.active { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-color: transparent; color: #fff; }
.vocab-practice-page .vocab-practice-stats { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.12); color: #e8ecf8; }
.vocab-practice-page .vocab-practice-stats th { background: rgba(255,255,255,0.05); color: #a5b4fc; }
.vocab-practice-page .vocab-practice-stats td { color: #e8ecf8; border-bottom-color: rgba(255,255,255,0.08); }

@media (max-width: 640px) {
  .spell-slots { gap: 14px 12px; margin-top: 20px; }
  .spell-slot { font-size: 22px; }
  .vocab-practice-page { perspective: none; }
  .vocab-practice-page .dictation-card { min-height: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .vocab-card-anim { animation: none; }
}
```

- [ ] **Step 3: 验证** — `npm run build` 成功；`npx eslint src/pages/VocabPracticePage.jsx src/components/SpellSlots.jsx src/utils/spellSlots.js` 无 error。

- [ ] **Step 4: 提交** — `git add src/index.css src/App.jsx && git commit -m "style(vocab): 听练页沉浸式深色舞台与槽位样式"`

---

### Task 5: 文档 + 全量验证

**Files:** Modify `README.md`

- [ ] **Step 1: README** — 在「### 🎧 生词听练（听练一体）」小节补一行：
```markdown
- **拼写输入**：答案按词拆成下划线槽位，`空格`/`→` 跳下一词、最后一词 `Enter` 提交；判定直接显示在槽位（正确绿 / 错误红+正确词 / 遗漏黄虚线）
```

- [ ] **Step 2: 全量验证**
```bash
node --test "src/utils/*.test.js"
node --test "server/**/*.test.cjs"
node --test scripts/copy-data.test.mjs
npm run lint
npm run build
```
Expected：`src/utils` 全绿（含 6 个新槽位用例）；`server` 114/114；`scripts` 3/3；lint 0 error；build 成功。

- [ ] **Step 3: 提交** — `git add README.md && git commit -m "docs: 生词听练槽位输入说明"`

---

## 自查记录（spec 覆盖对照）

- 深色沉浸主题 / 3D 卡片 / 光晕 / 斜向高光 / 大圆角大投影 / min-height 520 → Task 4。
- 顶部工具栏 / 连击加强 / 完成页 / 帮助面板深色 → Task 4。
- 拼写输入重做为逐词下划线槽位 + 判定在槽上 → Task 1 + Task 2 + Task 3。
- 槽位交互（空格/方向键/退格/Enter/粘贴） → Task 2。
- 隐藏全局导航栏 → Task 4 Step 1。
- 统计/连击/上一题/快捷键保留 → Task 3（不改 `resolveShortcut`）。
- 移动端 / reduced-motion / ≥44px → Task 4。
- 零新依赖 / 无音效 / 不抄参考站 → Global Constraints。
