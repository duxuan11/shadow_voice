# 词卡「核心语块」提取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把视频详情页「智能重点词卡」的「核心短语」tab 改造成「核心语块」，用纯本地规则从字幕抽出带省略号、能直接开口说的语块。

**Architecture:** 新增 `src/utils/chunks.js`（纯函数 + 规则库 + 去重/排序/上限），`VideoDetail.jsx` 的 `derivedData` 用它替换旧的「整句当短语」逻辑，抽屉里渲染语块卡片。无后端 / 数据库 / AI 改动。

**Tech Stack:** React 19 + Vite；测试用 Node 22 原生 `node:test`（**不是** vitest/jest），运行命令 `node --test <file>`。

**设计文档：** `docs/superpowers/specs/2026-09-19-chunk-extraction-design.md`

## Global Constraints

- 纯本地规则提取：不新增后端接口、不写数据库、不调用 AI。
- 不改 AI 对话页（`ConversationPage.jsx`）的「素材」chips。
- 抽不到语块时显示空态，**不**回退成旧的「整句当短语」行为。
- 三类语块（固定）：`opener` 句首框架 / `degree` 程度比较 / `tail` 句尾补充。
- `CHUNK_RULES` 数组顺序即优先级：**opener → degree → tail**；更具体的规则排在更泛化的规则前面。
- 同一条字幕：同类型最多 1 条，整体最多 2 条语块。
- 结果按 `count` 降序、其次 `startTime` 升序，最多 20 条。
- 代码注释与 UI 文案用中文，沿用现有文件风格。
- 测试命令：`node --test src/utils/chunks.test.js`；lint：`npm run lint`。
- 提交时注意：本仓库工作区文件是 CRLF，而 HEAD 是 LF。暂存既有文件请用 `git -c core.autocrlf=input add <file>`，避免把整文件行尾变更提交进去（新文件不受影响）。

## File Structure

| 文件 | 责任 |
|---|---|
| `src/utils/chunks.js`（新建） | 语块规则库 + `extractChunks()` 纯函数：匹配、拼装、去重、排序、限额 |
| `src/utils/chunks.test.js`（新建） | `node:test` 回归测试：规则命中、同类型去重、每句限额、去重计数、排序、边界、不误伤 |
| `src/pages/VideoDetail.jsx`（修改） | `derivedData.chunks` 接线；tab 改名「核心语块」；语块卡片渲染 + 发音 + 跳转；空态 |

---

### Task 1: 提取器骨架 + 句首框架（opener）

**Files:**
- Create: `src/utils/chunks.js`
- Test: `src/utils/chunks.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CHUNK_TYPE_LABELS: { opener: string, degree: string, tail: string }`
  - `CHUNK_RULES: Array<{ id: string, type: 'opener'|'degree'|'tail', re: RegExp, gloss: string }>`
  - `extractChunks(subtitles: Array<{textEn?:string,textCn?:string,startTime?:number}>, options?: { limit?: number }): Chunk[]`
  - `Chunk = { text: string, type: string, gloss: string, count: number, startTime: number, sentenceEn: string, sentenceCn: string }`

- [ ] **Step 1: 写失败的测试**

Create `src/utils/chunks.test.js`:

```js
// 语块提取 util 回归测试：句首框架命中、具体规则优先、大小写、边界、不误伤。
// 背景：词卡「核心短语」原来把整句字幕原样列出，改为本地规则抽可迁移语块。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractChunks } from './chunks.js'

const sub = (textEn, startTime, extra = {}) => ({
  id: String(startTime), startTime, endTime: startTime + 2, textEn, textCn: '', ...extra,
})

describe('extractChunks - 句首框架', () => {
  it('抽出 It turns out that... 并带模板释义与源句', () => {
    const out = extractChunks([
      sub('It turns out that the problem is much more complicated than we thought.', 12.3, {
        textCn: '结果发现，问题比我们想的复杂得多。',
      }),
    ])
    const opener = out.find(c => c.type === 'opener')
    assert.equal(opener.text, 'It turns out that...')
    assert.equal(opener.gloss, '结果（发现）……')
    assert.equal(opener.startTime, 12.3)
    assert.equal(opener.sentenceEn, 'It turns out that the problem is much more complicated than we thought.')
    assert.equal(opener.sentenceCn, '结果发现，问题比我们想的复杂得多。')
  })

  it('更具体的 gonna 框架优先于泛化的 I don\'t think', () => {
    const out = extractChunks([sub("I don't think we're gonna see that anytime soon.", 5)])
    const openers = out.filter(c => c.type === 'opener').map(c => c.text)
    assert.deepEqual(openers, ["I don't think we're gonna..."])
  })

  it('大小写不敏感，语块文本保留源字幕大小写', () => {
    const out = extractChunks([sub('it turns out that he lied', 0)])
    assert.equal(out[0].text, 'it turns out that...')
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(extractChunks([]), [])
    assert.deepEqual(extractChunks(undefined), [])
    assert.deepEqual(extractChunks(null), [])
  })

  it('不含规则的普通句不产出语块', () => {
    assert.deepEqual(extractChunks([sub('I saw a movie yesterday.', 0)]), [])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/utils/chunks.test.js`
Expected: FAIL —— `Cannot find module .../src/utils/chunks.js`（模块还不存在）

- [ ] **Step 3: 写最小实现**

Create `src/utils/chunks.js`:

```js
// 语块（chunk）提取：从字幕里抽出「可迁移、能直接开口说」的语块。
//
// 背景：视频详情页「智能重点词卡」原来的「核心短语」直接把整句字幕原样列出——
//      单词太碎、整句太长，都不是能直接搬去说话的东西。
// 这里用纯本地规则库抽出带省略号的语块，例如：
//   It turns out that...          （句首框架）
//   ...anytime soon               （句尾补充）
//   much more complicated than... （程度比较）
// 设计文档：docs/superpowers/specs/2026-09-19-chunk-extraction-design.md
// 纯函数：零依赖、零网络、零 AI 调用。

export const CHUNK_TYPE_LABELS = {
  opener: '句首框架',
  degree: '程度比较',
  tail: '句尾补充',
}

// 规则顺序即优先级：opener → degree → tail。
// 更具体的规则必须排在更泛化的规则前面（如 stem-dont-think-gonna 在 stem-i-dont-think 之前），
// 否则长语块会被短语块抢先命中。
export const CHUNK_RULES = [
  // 句首框架 opener
  { id: 'stem-it-turns-out', type: 'opener', re: /^\s*it turns out that\b/i, gloss: '结果（发现）……' },
  { id: 'stem-dont-think-gonna', type: 'opener', re: /^\s*(?:i|we) don['’]?t think [^.]{0,40}?\bgonna\b/i, gloss: '我觉得……不会……' },
  { id: 'stem-i-dont-think', type: 'opener', re: /^\s*i don['’]?t think\b/i, gloss: '我觉得……不……' },
  { id: 'stem-the-thing-is', type: 'opener', re: /^\s*the thing is\b/i, gloss: '问题是/关键在于……' },
  { id: 'stem-the-problem-is', type: 'opener', re: /^\s*the problem is\b/i, gloss: '问题在于……' },
  { id: 'stem-it-seems-like', type: 'opener', re: /^\s*it seems like\b/i, gloss: '看起来好像……' },
  { id: 'stem-you-know-what', type: 'opener', re: /^\s*you know what\b/i, gloss: '你知道吗……' },
  { id: 'stem-what-i-mean-is', type: 'opener', re: /^\s*what i mean is\b/i, gloss: '我的意思是……' },
]

const MAX_CHUNKS_PER_SENTENCE = 2
const DEFAULT_LIMIT = 20

// 语块去重 key：小写、去标点、合并空白。
function normalizeChunkKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 拼装展示文本：去掉命中片段首尾空白/标点，再按类型加省略号。
function buildChunkText(type, raw) {
  const core = String(raw ?? '')
    .replace(/^[\s'"“”‘’]+/, '')
    .replace(/[\s.!?,;:'"“”‘’]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!core) return ''
  return type === 'tail' ? `...${core}` : `${core}...`
}

/**
 * 从字幕提取可迁移语块。
 * @param {Array<{textEn?:string,textCn?:string,startTime?:number}>} subtitles
 * @param {{limit?:number}} [options]
 * @returns {Array<{text:string,type:string,gloss:string,count:number,startTime:number,sentenceEn:string,sentenceCn:string}>}
 */
export function extractChunks(subtitles, { limit = DEFAULT_LIMIT } = {}) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return []
  const seen = new Map()

  for (const sub of subtitles) {
    if (!sub || typeof sub !== 'object') continue
    const en = String(sub.textEn ?? '').replace(/\s+/g, ' ').trim()
    if (!en) continue

    const matchedTypes = new Set()
    let matched = 0

    for (const rule of CHUNK_RULES) {
      if (matched >= MAX_CHUNKS_PER_SENTENCE) break
      if (matchedTypes.has(rule.type)) continue
      const m = rule.re.exec(en)
      if (!m) continue
      const text = buildChunkText(rule.type, m[0])
      if (!text) continue

      matchedTypes.add(rule.type)
      matched++

      const key = normalizeChunkKey(text)
      const existing = seen.get(key)
      if (existing) {
        existing.count++
        continue
      }
      seen.set(key, {
        text,
        type: rule.type,
        gloss: rule.gloss,
        count: 1,
        startTime: Number(sub.startTime) || 0,
        sentenceEn: en,
        sentenceCn: String(sub.textCn ?? '').trim(),
      })
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.startTime - b.startTime)
    .slice(0, limit)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/utils/chunks.test.js`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/utils/chunks.js src/utils/chunks.test.js
git commit -m "feat(wordcard): 新增语块提取器与句首框架规则"
```

---

### Task 2: 句尾补充 + 程度比较 + 每句限额

**Files:**
- Modify: `src/utils/chunks.js`（在 `CHUNK_RULES` 里 opener 之后插入 degree，再插入 tail）
- Test: `src/utils/chunks.test.js`（追加 describe 块）

**Interfaces:**
- Consumes: Task 1 的 `extractChunks` / `CHUNK_RULES`
- Produces: `Chunk.type` 新增取值 `'degree'`、`'tail'`；产出文本形如 `much more complicated than...`、`...anytime soon`

- [ ] **Step 1: 追加失败的测试**

在 `src/utils/chunks.test.js` 末尾追加：

```js
describe('extractChunks - 句尾补充与程度比较', () => {
  it('例 1 同时抽出句首框架与句尾补充', () => {
    const out = extractChunks([sub("I don't think we're gonna see that anytime soon.", 5)])
    assert.deepEqual(
      out.map(c => c.text).sort(),
      ["I don't think we're gonna...", '...anytime soon'].sort()
    )
  })

  it('例 2 同时抽出句首框架与程度比较', () => {
    const out = extractChunks([sub('It turns out that the problem is much more complicated than we thought.', 0)])
    assert.deepEqual(
      out.map(c => c.text).sort(),
      ['It turns out that...', 'much more complicated than...'].sort()
    )
  })

  it('同一句最多 2 个语块（degree 优先于 tail）', () => {
    const out = extractChunks([sub('It turns out that she is much more careful than me right now.', 0)])
    assert.equal(out.length, 2)
    assert.deepEqual(out.map(c => c.type).sort(), ['degree', 'opener'])
  })

  it('同一语块多次出现合并为一条并计数，startTime 取首次', () => {
    const out = extractChunks([
      sub("I don't think we're gonna win.", 3),
      sub('It turns out that he won.', 9),
      sub('It turns out that she lost.', 12),
    ])
    const openers = out.filter(c => c.text === 'It turns out that...')
    assert.equal(openers.length, 1)
    assert.equal(openers[0].count, 2)
    assert.equal(openers[0].startTime, 9)
  })

  it('count 降序、其次 startTime 升序', () => {
    const out = extractChunks([
      sub("I don't think we're gonna win.", 3),
      sub('It turns out that he won.', 9),
      sub('It turns out that she lost.', 12),
    ])
    assert.equal(out[0].text, 'It turns out that...')
    assert.equal(out[0].count, 2)
    assert.equal(out[1].startTime, 3)
  })

  it('as soon as 不会被 as...as 误判为程度比较', () => {
    assert.deepEqual(extractChunks([sub('Please call me as soon as possible.', 0)]), [])
  })

  it('句尾补充可独立命中（无句首框架时）', () => {
    const out = extractChunks([sub('I will finish it for now.', 0)])
    assert.deepEqual(out.map(c => c.text), ['...for now'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/utils/chunks.test.js`
Expected: FAIL —— 例 1 缺少 `...anytime soon`、例 2 缺少 `much more complicated than...`（degree/tail 规则尚未实现）

- [ ] **Step 3: 加规则（degree 在 tail 之前）**

在 `src/utils/chunks.js` 的 `CHUNK_RULES` 中，把 opener 最后一条 `stem-what-i-mean-is` 之后、数组 `]` 之前，插入：

```js
  // 程度 / 比较 degree（排在 tail 之前：程度/比较结构的迁移价值高于 right now/for now 这类时间尾巴，
  // 每句上限 2 条时优先保住它有释义、更值得练的那条）
  { id: 'degree-much-more-than', type: 'degree', re: /\b(?:much|far|way|a lot|even)\s+(?:\w+er|more\s+\w+)\s+than\b/i, gloss: '比……得多' },
  { id: 'degree-as-as', type: 'degree', re: /\bas\s+(?!(?:soon|long|far|much)\b)\w+\s+as\b/i, gloss: '和……一样……' },
  { id: 'degree-more-and-more', type: 'degree', re: /\bmore and more\b/i, gloss: '越来越……' },
  { id: 'degree-too-to', type: 'degree', re: /\btoo\s+\w+\s+to\b/i, gloss: '太……以至于不能……' },

  // 句尾补充 tail
  { id: 'tail-anytime-soon', type: 'tail', re: /\bany ?time soon\s*[.!?]*$/i, gloss: '……短期内（不会）' },
  { id: 'tail-for-now', type: 'tail', re: /\bfor now\s*[.!?]*$/i, gloss: '……暂时' },
  { id: 'tail-right-now', type: 'tail', re: /\bright now\s*[.!?]*$/i, gloss: '……现在/马上' },
  { id: 'tail-at-the-moment', type: 'tail', re: /\bat the moment\s*[.!?]*$/i, gloss: '……此刻' },
  { id: 'tail-sooner-or-later', type: 'tail', re: /\bsooner or later\s*[.!?]*$/i, gloss: '……迟早' },
  { id: 'tail-in-the-end', type: 'tail', re: /\bin the end\s*[.!?]*$/i, gloss: '……最终' },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/utils/chunks.test.js`
Expected: PASS（12 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git -c core.autocrlf=input add src/utils/chunks.js src/utils/chunks.test.js
git commit -m "feat(wordcard): 补齐句尾补充与程度比较语块规则"
```

---

### Task 3: VideoDetail 接「核心语块」tab

**Files:**
- Modify: `src/pages/VideoDetail.jsx`
  - 顶部 import（约第 11 行后）
  - `derivedData`（约第 211-230 行）
  - 抽屉副标题（约第 1257 行）
  - tab 数组（约第 1263-1266 行）
  - 「核心短语」渲染块（约第 1299-1315 行）

**Interfaces:**
- Consumes: Task 1/2 的 `extractChunks`、`CHUNK_TYPE_LABELS`；现有 `jumpToSubtitle(time)`、`speakWord(text)`、`formatTime(sec)`
- Produces: `derivedData.chunks: Chunk[]`；tab id `'chunks'`

- [ ] **Step 1: 加 import**

在 `src/pages/VideoDetail.jsx` 里，把：

```js
import { mergeAdjacentDuplicateSubtitles } from '../utils/subtitles'
```

改成：

```js
import { mergeAdjacentDuplicateSubtitles } from '../utils/subtitles'
import { extractChunks, CHUNK_TYPE_LABELS } from '../utils/chunks'
```

- [ ] **Step 2: 替换 derivedData**

把 `derivedData` 的 useMemo 整块（从 `if (!video || !video.subtitles) return { keywords: [], phrases: [], expressions: [] }` 到 `}, [video])`）替换为：

```js
    if (!video || !video.subtitles) return { keywords: [], chunks: [], expressions: [] }
    const keywordMap = new Map(); const expressions = []
    for (const sub of video.subtitles) {
      if (sub.highlightWords) {
        for (const kw of sub.highlightWords) {
          if (!keywordMap.has(kw)) keywordMap.set(kw, { word: kw, count: 1, times: [sub.startTime] })
          else { const e = keywordMap.get(kw); e.count++; e.times.push(sub.startTime) }
        }
      }
      if (sub.annotations && Object.keys(sub.annotations).length > 0) expressions.push(sub)
    }
    return {
      keywords: [...keywordMap.values()].sort((a, b) => b.count - a.count),
      chunks: extractChunks(video.subtitles),
      expressions: expressions.length > 0 ? expressions : video.subtitles.filter(s => s.textEn && s.textEn.length > 40).slice(0, 20),
    }
  }, [video])
```

（删除 `const phrases = []`、`if (sub.highlightWords && sub.highlightWords.length >= 3) phrases.push(sub)` 与返回里的 `phrases` 两项。）

- [ ] **Step 3: 改抽屉副标题与 tab**

把：

```jsx
                <p className="text-[11px] text-slate-400 font-medium">当前视频精选核心词汇、短语与口语地道表达</p>
```

改成：

```jsx
                <p className="text-[11px] text-slate-400 font-medium">当前视频精选核心词汇、语块与口语地道表达</p>
```

把 tab 数组里的：

```jsx
                { id: 'phrases', label: '核心短语' },
```

改成：

```jsx
                { id: 'chunks', label: '核心语块' },
```

- [ ] **Step 4: 替换「核心短语」渲染块**

把：

```jsx
              {wordCardTab === 'phrases' && (
                derivedData.phrases.length > 0 ? derivedData.phrases.map((sub, i) => (
                  <div key={i} className="p-3.5 border rounded-2xl bg-white border-slate-100/80 hover:border-slate-200 transition-all cursor-pointer"
                    onClick={() => { jumpToSubtitle(sub.startTime); setIsWordCardOpen(false) }}>
                    <h4 className="text-xs font-extrabold text-slate-800 tracking-wide">{sub.textEn}</h4>
                    <p className="text-[11px] font-semibold text-slate-500 mt-1">{sub.textCn}</p>
                    {sub.highlightWords && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {sub.highlightWords.map((kw, ki) => (
                          <span key={ki} className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-100/55 px-2 py-0.5 rounded-md">{kw}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )) : <div className="text-center py-8 text-xs text-slate-400">暂无重点短语</div>
              )}
```

改成：

```jsx
              {wordCardTab === 'chunks' && (
                derivedData.chunks.length > 0 ? derivedData.chunks.map((chunk, i) => (
                  <div key={i} className="p-3.5 border rounded-2xl bg-white border-slate-100/80 hover:border-slate-200 transition-all cursor-pointer"
                    onClick={() => { jumpToSubtitle(chunk.startTime); setIsWordCardOpen(false) }}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                          <h4 className="text-xs font-extrabold text-slate-800 tracking-wide">{chunk.text}</h4>
                          <span className="text-[9px] font-bold text-amber-600 bg-amber-50 border border-amber-100/55 px-1.5 rounded-md">{CHUNK_TYPE_LABELS[chunk.type] || chunk.type}</span>
                          {chunk.count > 1 && <span className="text-[9px] font-bold text-slate-400">×{chunk.count}</span>}
                        </div>
                        <p className="text-[11px] font-bold text-slate-600 mt-1">{chunk.gloss}</p>
                      </div>
                      <button onClick={e => { e.stopPropagation(); speakWord(chunk.text.replace(/\.\.\./g, ' ').replace(/\s+/g, ' ').trim()) }}
                        className="p-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-500 hover:text-slate-800 rounded-lg cursor-pointer transition-colors shrink-0" title="点击发音">
                        <Volume2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2 pt-2 border-t border-slate-50">
                      <p className="text-[11px] text-slate-400 font-medium leading-relaxed">{chunk.sentenceEn}</p>
                      {chunk.sentenceCn && <p className="text-[11px] text-slate-400 leading-relaxed">{chunk.sentenceCn}</p>}
                    </div>
                    <p className="text-[10px] font-bold text-slate-300 mt-1.5 font-mono">{formatTime(chunk.startTime)}</p>
                  </div>
                )) : <div className="text-center py-8 text-xs text-slate-400">暂未提取到语块</div>
              )}
```

- [ ] **Step 5: 确认没有遗留引用**

Run: `grep -n "derivedData.phrases\|wordCardTab === 'phrases'\|暂无重点短语" src/pages/VideoDetail.jsx`
Expected: 无输出（0 行）

- [ ] **Step 6: lint**

Run: `npm run lint`
Expected: 无新增 error（特别是没有 `phrases` 未使用变量告警）

- [ ] **Step 7: 提交**

```bash
git -c core.autocrlf=input add src/pages/VideoDetail.jsx
git commit -m "feat(wordcard): 核心短语 tab 改为本地规则核心语块"
```

---

### Task 4: 回归验证

**Files:**
- 无改动（只跑验证）

**Interfaces:**
- Consumes: 前三个任务的成果
- Produces: 验证结论

- [ ] **Step 1: 跑本功能测试**

Run: `node --test src/utils/chunks.test.js`
Expected: PASS，12 个用例全绿

- [ ] **Step 2: 跑既有前端 util 测试确认零退化**

Run: `node --test src/utils/subtitles.test.js src/utils/watchedHistory.test.js src/utils/aliyunResult.test.js src/utils/engineSdk.test.js src/utils/pcmRecorder.test.js`
Expected: PASS（与改动前一致）

- [ ] **Step 3: lint**

Run: `npm run lint`
Expected: 无新增 error

- [ ] **Step 4: 人工检查清单（需要本地有 `data/videos/<episode>/subtitles.json`）**

本仓库 checkout 内 `data/videos/` 不存在，无法自动验证真实字幕，需人工：

1. `npm run server` + `npm run dev`，打开任意视频详情页。
2. 点开「智能重点词卡」→ 选「核心语块」tab：
   - 卡片带 `...`、类型徽章（句首框架/程度比较/句尾补充）、中文模板释义、源句英中、时间戳。
   - 点卡片 → 视频跳到对应时间且抽屉关闭。
   - 🔊 → 读出语块（不含省略号）。
3. 找一条命中 `It turns out that...` 的视频，确认源句中文来自该字幕 `textCn`。
4. 找一个不含任何规则句式的视频 → 显示空态「暂未提取到语块」。
5. 抽一条高频语块确认 `×N` 计数与首次时间正确。

- [ ] **Step 5: 记录验证结果**

把 Step 1-3 的实际命令输出贴进 PR/会话总结。若 Step 4 因缺数据无法执行，明确说明「真实字幕人工验证未执行（缺 data/videos）」。
