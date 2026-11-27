# 跟读发音诊断层（层 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从阿里云口语评测结果中推导「连读缺失 / 失爆吞音 / 词尾辅音丢失」三类发音问题，在跟读面板给出一条可执行建议并逐词标注，同时把原始评测数据落盘供 30 天后标定阈值。

**Architecture:** 全部判定逻辑放在前端纯函数 `diagnose(parsed, { refText })` 中（无网络、无随机、可单测），`ShadowingEvaluator` 只负责渲染；原始评测 JSON 通过独立的 fire-and-forget 端点写入 SQLite 新表，失败静默。规则不参与评分，五维条里也不新增"连读"维度。

**Tech Stack:** React 19 + Tailwind（前端，ESM）、Express 5 + sql.js（后端，CJS）、Node 22 原生 `node:test`、Playwright（仅人工/脚本验收）

**Spec:** `docs/superpowers/specs/2026-11-26-pronunciation-diagnosis-design.md`

## Global Constraints

- 前端源码为 ESM（`import`/`export`），后端为 CJS（`require`/`module.exports`）；不要混用。
- 测试用 Node 22 原生 `node:test`：前端 `node --test src/utils/x.test.js`，后端 `node --test server/routes/x.test.cjs`。
- **`diagnose()` 必须是纯函数**：无网络、无 `Date.now()`、无随机、同输入同输出。
- **诊断与上报一律 `try/catch`**：任何失败只能导致"没有新标注"，绝不影响出分与现有 UI。
- 阈值只能出现在 `src/data/linkRules.js` 的 `THRESHOLDS`，不得散落在逻辑里。初值：`GAP_LINK 60`、`TAIL_LINK 90`、`GAP_STOP 80`、`TAIL_STOP 80`、`TAIL_LOSS 60`（ms / 分数）。
- 上报数据**必须剔除 `result.audioUrl`**；样本保留 **30 天**。
- 不新增第五个评分维度；底部只显示真实计数（`可判定连读边界 N 处 · M 处待改进`）。
- 文案语气：`error` 用陈述句；`hint`（失爆）必须显式说明"**是美音常态，不是错**"。所有面向用户的文本用中文。
- 提交粒度：每个任务一次 commit，均在分支 `feat/pronunciation-diagnosis` 上。

## Review Focus

以下是 spec 隐含、但用户最容易踩到的输入/失败模式，每条都在对应任务里钉了测试：

1. **单句只有一个词 / 没有相邻词对** —— 应返回空结果且不抛错，UI 显示"未发现连读/吞音问题"（Task 2）。
2. **音素缺失、未知符号、重音前缀 `'p`** —— 实测存在 `'p`（`possible` 首音素）与混合符号集；不能把它们当辅音/元音，不能崩（Task 1、Task 2）。
3. **词 `start`/`end` 为 `null`** —— 该词对直接丢弃，不参与判定（Task 2）。
4. **整句跳读 / 大量漏读（`dp_type=1`、`integrity<100`）** —— 不能刷出一屏"连读缺失"噪音（Task 2）。
5. **意群边界（逗号/句号）** —— 正常的换气停顿不能被报成"连读缺失"（Task 2）。
6. **上报失败 / 未登录 / `result` 超大** —— 静默丢弃，评测结果照常显示（Task 4、Task 5）。

---

## 文件结构

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/data/phoneIpa.js`（新） | 音素→IPA 映射、剥离 `'` 前缀、辅音/元音判定 | 1 |
| `src/data/phoneIpa.test.js`（新） | 映射与分类单测 | 1 |
| `src/data/linkRules.js`（新） | 阈值、爆破音集合、功能词表 | 1 |
| `src/utils/pronunciationDiagnosis.js`（新） | 特征提取 + 三条规则 + `pickTop` | 2 |
| `src/utils/pronunciationDiagnosis.test.js`（新） | 规则/排除/边界单测 | 2 |
| `src/utils/accentParam.js`（新） | `accentToEvalParam` | 3 |
| `src/utils/accentParam.test.js`（新） | 映射单测 | 3 |
| `server/db.cjs`（改） | 新增 `shadow_eval_samples` 表 + 索引 | 4 |
| `server/routes/shadowEval.cjs`（新） | 上报端点 + 30 天清理 | 4 |
| `server/routes/shadowEval.test.cjs`（新） | 鉴权/校验/剔除/清理 | 4 |
| `server/index.cjs`（改） | 挂载 `/api/shadow-eval` | 4 |
| `src/components/ShadowingEvaluator.jsx`（改） | 渲染改造 + 上报 + `accent` | 5 |
| `src/pages/VideoDetail.jsx`（改） | 传 `video.accent` | 5 |

---

### Task 1: 音素数据层（`phoneIpa.js` + `linkRules.js`）

**Files:**
- Create: `src/data/phoneIpa.js`
- Create: `src/data/linkRules.js`
- Test: `src/data/phoneIpa.test.js`

**Interfaces:**
- Produces（Task 2 依赖，签名必须一致）:
  - `export function stripStress(sym) -> string` —— `"'p" → "p"`，非字符串或空返回 `''`
  - `export function toIPA(sym) -> string` —— 先 `stripStress` 再查表；未收录则原样返回剥离后的符号
  - `export function isConsonant(sym) -> boolean` —— 未收录符号返回 `false`
  - `export function isVowel(sym) -> boolean` —— 未收录符号返回 `false`
  - `export const THRESHOLDS = { GAP_LINK: 60, TAIL_LINK: 90, GAP_STOP: 80, TAIL_STOP: 80, TAIL_LOSS: 60 }`
  - `export const STOP_CONSONANTS = new Set([...])` —— 元素是 **IPA** 形式（`p b t d k g`）
  - `export const FUNCTION_WORDS = new Set([...])` —— 小写功能词（`to of and a the that for with his her him was were is are ...`）

- [ ] **Step 1: 写失败测试**

创建 `src/data/phoneIpa.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { stripStress, toIPA, isConsonant, isVowel } from './phoneIpa.js'

test('stripStress 剥离重音前缀', () => {
  assert.equal(stripStress("'p"), 'p')
  assert.equal(stripStress('p'), 'p')
  assert.equal(stripStress(''), '')
  assert.equal(stripStress(null), '')
})

test('toIPA 覆盖实测混合符号集', () => {
  assert.equal(toIPA('ay'), 'aɪ')
  assert.equal(toIPA('aɪ'), 'aɪ')      // 别名归一
  assert.equal(toIPA('aa'), 'ɑ')
  assert.equal(toIPA('aw'), 'aʊ')
  assert.equal(toIPA('ax'), 'ə')
  assert.equal(toIPA('iy'), 'i')
  assert.equal(toIPA('uw'), 'u')
  assert.equal(toIPA("'p"), 'p')        // 实测 possible 首音素
  assert.equal(toIPA('ɪə'), 'ɪə')
})

test('toIPA 未收录符号原样返回（降级不崩）', () => {
  assert.equal(toIPA('zzz'), 'zzz')
})

test('辅音/元音分类', () => {
  assert.equal(isConsonant('t'), true)
  assert.equal(isVowel('aw'), true)
  assert.equal(isVowel('aʊ'), true)
  assert.equal(isConsonant('aw'), false)
  assert.equal(isVowel('t'), false)
  assert.equal(isConsonant('zzz'), false)   // 未知不算辅音
  assert.equal(isVowel('zzz'), false)       // 未知不算元音
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/data/phoneIpa.test.js`
Expected: FAIL —— `Cannot find module './phoneIpa.js'` 或 `SyntaxError: does not provide an export named 'stripStress'`

- [ ] **Step 3: 实现 `src/data/phoneIpa.js`**

映射表必须覆盖 spec 实测的 47 个符号（ARPAbet 与 IPA 混用）。要点：`PHONE_IPA` 同时收录别名（`ay` 与 `aɪ`、`aa` 与 `ɑ`、`aw` 与 `aʊ`、`ax` 与 `ə`），`VOWEL_IPA` / `CONSONANT_IPA` 两个集合按 **IPA** 归类，`isVowel`/`isConsonant` 都先 `stripStress → toIPA` 再查集合。

```js
export const PHONE_IPA = { aa: 'ɑ', aɪ: 'aɪ', ay: 'aɪ', ah: 'ʌ', aw: 'aʊ', aʊ: 'aʊ', ax: 'ə', ә: 'ə',
  b: 'b', d: 'd', e: 'e', eh: 'ɛ', ɛ: 'ɛ', ey: 'eɪ', f: 'f', g: 'g', h: 'h', hh: 'h', i: 'i',
  ih: 'ɪ', ɪ: 'ɪ', ir: 'ɪr', iy: 'i', j: 'dʒ', k: 'k', l: 'l', m: 'm', n: 'n', ng: 'ŋ',
  oo: 'u', ow: 'oʊ', p: 'p', r: 'r', s: 's', t: 't', u: 'u', 'u:': 'u', uw: 'u',
  v: 'v', w: 'w', y: 'j', z: 'z', æ: 'æ', ɑ: 'ɑ', ɒ: 'ɒ', ɪə: 'ɪə' }
```

同时导出 `VOWEL_IPA`（元音：`ɑ aɪ ʌ aʊ ə e ɛ eɪ i ɪ ɪr oʊ u ɪə ɘ æ`）与 `CONSONANT_IPA`（辅音：`p b t d k g f v s z h m n l r w j ŋ dʒ`），`isVowel`/`isConsonant` 都先 `stripStress → toIPA` 再查集合。注意 `j`/`y` 都归到 `j`（半元音，算辅音），`oo`/`u:`/`uw` 都归到 `u`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/data/phoneIpa.test.js`
Expected: PASS（4 个测试全绿）

- [ ] **Step 5: 写 `src/data/linkRules.js`（纯数据，无逻辑）**

按 Global Constraints 的阈值填 `THRESHOLDS`；`STOP_CONSONANTS = new Set(['p','b','t','d','k','g'])`；`FUNCTION_WORDS` 至少包含：`a an the to of and or but for with at in on as that this these those his her him them he she it we you they was were is are am do does did have has had not no so if then than about from by into over under out up down`。文件顶部注释写明"阈值初值来自 2026-11-26 spike 实测，待 30 天样本标定"。

- [ ] **Step 6: Commit**

```bash
git add src/data/phoneIpa.js src/data/phoneIpa.test.js src/data/linkRules.js
git commit -m "feat(pronunciation): 音素→IPA 映射与诊断阈值数据层"
```

---

### Task 2: 诊断纯函数 `diagnose()`

**Files:**
- Create: `src/utils/pronunciationDiagnosis.js`
- Test: `src/utils/pronunciationDiagnosis.test.js`

**Interfaces:**
- Consumes（Task 1）：`toIPA`, `stripStress`, `isConsonant`, `isVowel` from `../data/phoneIpa.js`；`THRESHOLDS`, `STOP_CONSONANTS` from `../data/linkRules.js`
- Produces（Task 5 依赖）:
  - `export function diagnose(parsed, { refText } = {}) -> { items, top, stats }`
  - `items[i] = { id: 'link-missing'|'stop-elision'|'coda-loss', level: 'error'|'suggestion'|'hint', wordIndex: number, pair: [number, number], text: string, message: string, evidence: { gapMs: number|null, tailPhone: string, tailScore: number|null, headPhone: string, headScore: number|null } }`
  - `top` = `items[0]` 或 `null`；`stats = { boundaries: number, problematic: number }`（`boundaries` = 参与判定的词对数，`problematic` = `items.length`）
  - `evidence.tailPhone` / `headPhone` 为**已剥离 `'` 前缀的原始音素符号**（如 `'p` → `p`）；`gapMs = next.start - cur.end`
  - 级别映射：`coda-loss → 'error'`，`link-missing → 'suggestion'`，`stop-elision → 'hint'`

**判定顺序（spec 第 2 节，必须严格照此实现）：**

1. 逐对相邻词，跳过 `start/end` 缺失、`phones` 为空、`isPause`、`fakePron`、`dpType !== 0` 的词对。
2. `tail = cur.phones.at(-1)`、`head = next.phones[0]`；`tailSym = stripStress(tail.char)`、`headSym = stripStress(head.char)`；两者任一既非辅音也非元音 → 丢弃该词对（不猜）。
3. 按分数区间互斥判定：`tailScore < TAIL_LOSS` → `coda-loss`；否则若「`tailIPA` ∈ `STOP_CONSONANTS` ∧ `isConsonant(headSym)` ∧ `gapMs < GAP_STOP` ∧ `TAIL_LOSS ≤ tailScore < TAIL_STOP`」→ `stop-elision`；否则若「`isConsonant(tailSym)` ∧ `isVowel(headSym)` ∧ `gapMs > GAP_LINK` ∧ `tailScore < TAIL_LINK` ∧ 非意群边界」→ `link-missing`。
4. 意群边界判定：`refText` 中 `next.char` 出现位置的**前一个非空字符**是 `, . ; : ? !` → 视为边界（找不到位置时视为非边界）。
5. `pickTop`：级别权重（error 3 / suggestion 2 / hint 1）降序 → `100 - tailScore` 降序 → `wordIndex` 升序。

- [ ] **Step 1: 写失败测试（覆盖 6 条 Review Focus 中的 1、2、3、4、5）**

创建 `src/utils/pronunciationDiagnosis.test.js`。fixture 用 2026-11-26 spike 的真实数值（`s1-us` 连读版与 `gapB-400` 断开版）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnose } from './pronunciationDiagnosis.js'

const w = (char, score, start, end, phones, extra = {}) => ({
  char, score, start, end,
  phones: phones.map(([c, s]) => ({ char: c, score: s, pherr: 0, ph2alpha: c })),
  dpType: 0, isPause: false, fakePron: false, ...extra,
})
const parsed = (words) => ({ overall: 96, words })

// 真实连读版：get 510-720 (t:95) → out 720-870 (aw:99)，间隙 0ms
const linked = parsed([
  w('get', 97, 510, 720, [['g', 98], ['eh', 99], ['t', 95]]),
  w('out', 100, 720, 870, [['aw', 99], ['t', 100]]),
])
// 断开版（spike gapB-400）：get 510-960 (t:85) → out 1440-1680，间隙 480ms
const split = parsed([
  w('get', 94, 510, 960, [['g', 100], ['eh', 96], ['t', 85]]),
  w('out', 99, 1440, 1680, [['aw', 99], ['t', 99]]),
])

test('自然连读（间隙 0ms）不报问题', () => {
  const r = diagnose(linked, { refText: 'get out' })
  assert.equal(r.items.length, 0)
  assert.equal(r.top, null)
  assert.equal(r.stats.boundaries, 1)
})

test('断开 480ms → link-missing（suggestion）', () => {
  const r = diagnose(split, { refText: 'get out' })
  assert.equal(r.items.length, 1)
  const it = r.items[0]
  assert.equal(it.id, 'link-missing')
  assert.equal(it.level, 'suggestion')
  assert.equal(it.wordIndex, 0)
  assert.deepEqual(it.pair, [0, 1])
  assert.equal(it.text, 'get out')
  assert.equal(it.evidence.gapMs, 480)
  assert.equal(it.evidence.tailScore, 85)
  assert.match(it.message, /连读/)
  assert.match(it.message, /480/)
  assert.equal(r.top.id, 'link-missing')
})

test('失爆：爆破音 + 辅音开头 + 间隙小 + 70 分 → hint 且文案说明不是错', () => {
  const p = parsed([
    w('get', 90, 0, 200, [['g', 95], ['eh', 90], ['t', 70]]),
    w('to', 90, 210, 330, [['t', 95], ['ax', 92]]),
  ])
  const r = diagnose(p, { refText: 'get to' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, 'stop-elision')
  assert.equal(r.items[0].level, 'hint')
  assert.match(r.items[0].message, /不是错/)
})

test('词尾辅音 45 分 → coda-loss（error），失爆上下文也照报', () => {
  const p = parsed([
    w('asked', 70, 0, 300, [['ae', 90], ['s', 90], ['k', 88], ['t', 45]]),
    w('to', 90, 310, 400, [['t', 92], ['ax', 90]]),
  ])
  const r = diagnose(p, { refText: 'asked to' })
  assert.equal(r.items[0].id, 'coda-loss')
  assert.equal(r.items[0].level, 'error')
})

test('意群边界（逗号后）不报 link-missing', () => {
  const r = diagnose(split, { refText: 'get, out' })
  assert.equal(r.items.length, 0)
})

test('dp_type!=0 / isPause / fakePron 的词对全部排除', () => {
  const variants = [
    parsed([w('get', 94, 510, 960, [['t', 85]], { dpType: 1 }), w('out', 99, 1440, 1680, [['aw', 99]])]),
    parsed([w('get', 94, 510, 960, [['t', 85]], { isPause: true }), w('out', 99, 1440, 1680, [['aw', 99]])]),
    parsed([w('get', 94, 510, 960, [['t', 85]]), w('out', 99, 1440, 1680, [['aw', 99]], { fakePron: true })]),
  ]
  for (const v of variants) assert.equal(diagnose(v, { refText: 'get out' }).items.length, 0)
})

test('Review Focus 1/3：单词句、start/end 为 null、phones 为空都不崩', () => {
  assert.deepEqual(diagnose(parsed([w('get', 90, 0, 100, [['t', 80]])]), { refText: 'get' }),
    { items: [], top: null, stats: { boundaries: 0, problematic: 0 } })
  assert.equal(diagnose(parsed([w('a', 90, null, null, [['t', 85]]), w('out', 99, 100, 200, [['aw', 99]])]), { refText: 'a out' }).items.length, 0)
  assert.equal(diagnose(parsed([w('a', 90, 0, 100, []), w('out', 99, 400, 500, [['aw', 99]])]), { refText: 'a out' }).items.length, 0)
  assert.equal(diagnose({}, { refText: '' }).items.length, 0)
})

test('Review Focus 2：未知音素符号不误判（不猜辅音/元音）', () => {
  const p = parsed([w('get', 94, 0, 300, [['zzz', 40]]), w('out', 99, 900, 1000, [['aw', 99]])])
  assert.equal(diagnose(p, { refText: 'get out' }).items.length, 0)
})

test('多问题排序：error 优先于 suggestion', () => {
  const p = parsed([
    w('get', 94, 0, 300, [['t', 85]]),
    w('out', 99, 800, 900, [['aw', 99]]),
    w('asked', 70, 950, 1150, [['t', 40]]),
    w('to', 90, 1160, 1250, [['t', 92]]),
  ])
  const r = diagnose(p, { refText: 'get out asked to' })
  assert.equal(r.top.id, 'coda-loss')
  assert.equal(r.stats.problematic, r.items.length)
  assert.ok(r.stats.boundaries >= 2)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/utils/pronunciationDiagnosis.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/utils/pronunciationDiagnosis.js`**

按上面的「判定顺序」实现；文案模板照 spec 第 2 节，其中 `{tailIPA}`/`{headIPA}` 用 `toIPA()` 结果、`{combinedIPA}` 用 `tailIPA + headIPA` 直接拼接（近似提示，不用"标准发音是"语气）。`pickTop` 与 `extractBoundaries` 作为同文件内的非导出函数（除非测试需要，不导出）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/utils/pronunciationDiagnosis.test.js`
Expected: PASS（10 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add src/utils/pronunciationDiagnosis.js src/utils/pronunciationDiagnosis.test.js
git commit -m "feat(pronunciation): 连读/失爆/词尾辅音规则诊断纯函数"
```

---

### Task 3: `accentToEvalParam`

**Files:**
- Create: `src/utils/accentParam.js`
- Test: `src/utils/accentParam.test.js`

**Interfaces:**
- Produces（Task 5 依赖）：`export function accentToEvalParam(accent) -> 'am' | 'en' | null`
  - `/美|US|USA|America|American/i` → `'am'`
  - `/英|UK|GB|Britain|British/i` → `'en'`
  - 其它/空/非字符串 → `null`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { accentToEvalParam } from './accentParam.js'

test('美音 / 英音 / 未知', () => {
  assert.equal(accentToEvalParam('美音'), 'am')
  assert.equal(accentToEvalParam('US'), 'am')
  assert.equal(accentToEvalParam('American English'), 'am')
  assert.equal(accentToEvalParam('英音'), 'en')
  assert.equal(accentToEvalParam('uk'), 'en')
  assert.equal(accentToEvalParam('British'), 'en')
  assert.equal(accentToEvalParam('澳洲'), null)
  assert.equal(accentToEvalParam(''), null)
  assert.equal(accentToEvalParam(undefined), null)
  assert.equal(accentToEvalParam(null), null)
  assert.equal(accentToEvalParam(42), null)
})
```

- [ ] **Step 2: 跑测试确认失败** → Run: `node --test src/utils/accentParam.test.js`，Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/utils/accentParam.js`**（正则见 Interfaces；非字符串输入直接返 `null`，字符串先 `trim()` 再匹配）

- [ ] **Step 4: 跑测试确认通过** → Run: `node --test src/utils/accentParam.test.js`，Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/accentParam.js src/utils/accentParam.test.js
git commit -m "feat(pronunciation): 视频口音→评测 accent 参数映射"
```

---

### Task 4: 后端样本表与上报端点

**Files:**
- Modify: `server/db.cjs`（在建表区追加 `shadow_eval_samples` + 索引）
- Create: `server/routes/shadowEval.cjs`
- Create: `server/routes/shadowEval.test.cjs`
- Modify: `server/index.cjs`（`app.use('/api/shadow-eval', shadowEvalRoutes.router)`，紧跟 `/api/speak` 之后）

**Interfaces:**
- Produces: `POST /api/shadow-eval/samples`
  - 请求体：`{ videoId, subIndex, refText, accent, evalAccent, overall, accuracy, integrity, params, result, diagnosis }`
  - 201 → `{ ok: true, id }`；401 未登录；400 参数非法 / `JSON.stringify(result).length > 65536`
  - 服务端**强制剔除** `result.audioUrl` 后再入库
  - 每次插入后执行 30 天清理
- 模块导出：`module.exports = { router }`（与 `asr.cjs` / `aliyun.cjs` 一致）

- [ ] **Step 1: 写失败测试**

`server/routes/shadowEval.test.cjs`，照 `asr.test.cjs` 的写法（临时 `SHADOW_VOICE_DB`、`app.listen(0)`、`signToken`）：

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { before, after } = require('node:test')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-shadow-eval-'))
process.env.SHADOW_VOICE_DB = path.join(tmpDir, 'test.db')

const express = require('express')
const { getDb, all, run } = require('../db.cjs')
const { signToken } = require('../auth.cjs')
const shadowEvalRoutes = require('./shadowEval.cjs')
const app = express()
app.use(express.json({ limit: '1mb' }))
app.use('/api/shadow-eval', shadowEvalRoutes.router)

let server, baseUrl
const auth = () => ({ Authorization: `Bearer ${signToken(11)}`, 'Content-Type': 'application/json' })
const body = (over = {}) => ({
  videoId: 'v1', subIndex: 3, refText: 'get out', accent: '美音', evalAccent: 'am',
  overall: 96, accuracy: 97, integrity: 100,
  params: { coreType: 'en.sent.score' },
  result: { result: { overall: 96 }, audioUrl: 'https://files.cloud.ssapi.cn/x.mp3' },
  diagnosis: { items: [] }, ...over,
})

before(async () => {
  await getDb()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(() => { if (server) server.close() })

test('未登录 → 401', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
  })
  assert.equal(res.status, 401)
})

test('正常写入 → 201，且 audioUrl 被剔除', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(), body: JSON.stringify(body()),
  })
  assert.equal(res.status, 201)
  const { id } = await res.json()
  const rows = all('SELECT result FROM shadow_eval_samples WHERE id = ?', [id])
  assert.equal(rows.length, 1)
  assert.ok(!rows[0].result.includes('audioUrl'), 'audioUrl 必须被剔除')
})

test('result 超过 64KB → 400', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(),
    body: JSON.stringify(body({ result: { blob: 'x'.repeat(70000) } })),
  })
  assert.equal(res.status, 400)
})

test('缺 refText → 400', async () => {
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(), body: JSON.stringify(body({ refText: '' })),
  })
  assert.equal(res.status, 400)
})

test('30 天前的样本在写入后被清理', async () => {
  run('INSERT INTO shadow_eval_samples (user_id, ref_text, result, created_at) VALUES (?, ?, ?, datetime(\'now\',\'-40 days\'))',
    [11, 'old', '{}'])
  const res = await fetch(`${baseUrl}/api/shadow-eval/samples`, {
    method: 'POST', headers: auth(), body: JSON.stringify(body()),
  })
  assert.equal(res.status, 201)
  const old = all('SELECT id FROM shadow_eval_samples WHERE ref_text = ?', ['old'])
  assert.equal(old.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/routes/shadowEval.test.cjs`
Expected: FAIL —— 路由模块不存在 / 表不存在

- [ ] **Step 3: 在 `server/db.cjs` 建表**

在建表区（现有 `chunk_mastery` 之后）追加 spec 第 4 节的 DDL 与索引 `idx_shadow_eval_created`。列名必须与 spec 完全一致（`eval_accent`、`sub_index` 等）；**不声明外键**（与 spec 一致，避免测试造数据时踩约束）。

- [ ] **Step 4: 实现 `server/routes/shadowEval.cjs`**

流程：`authMiddleware` → 校验 `refText` 非空、`subIndex` 为整数 → 克隆 `result` 并 `delete clone.audioUrl` → `JSON.stringify(clone).length > 65536` 则 400 → `run(INSERT ...)` → `run(DELETE ... created_at < datetime('now','-30 days'))` → 201 `{ ok: true, id: Number(lastInsertRowid) }`。错误统一 500 + `console.error`。`params`/`result`/`diagnosis` 用 `JSON.stringify` 存文本列。

- [ ] **Step 5: 在 `server/index.cjs` 挂载**

`const shadowEvalRoutes = require('./routes/shadowEval.cjs')` + `app.use('/api/shadow-eval', shadowEvalRoutes.router)`。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test server/routes/shadowEval.test.cjs`
Expected: PASS（5 个测试全绿）

- [ ] **Step 7: Commit**

```bash
git add server/db.cjs server/routes/shadowEval.cjs server/routes/shadowEval.test.cjs server/index.cjs
git commit -m "feat(pronunciation): 评测样本落库端点与 30 天保留"
```

---

### Task 5: 跟读面板渲染改造 + 口音传递

**Files:**
- Modify: `src/components/ShadowingEvaluator.jsx`
- Modify: `src/pages/VideoDetail.jsx`（`<ShadowingEvaluator … />` 处，约 1001 行）

**Interfaces:**
- Consumes: `diagnose`（Task 2）、`accentToEvalParam`（Task 3）、`POST /api/shadow-eval/samples`（Task 4）
- Produces: 组件新 prop `accent`（可选字符串）；`onResult` 行为不变（`TextDocPage` 仍在用）

- [ ] **Step 1: 接入诊断与上报**

在 `engineBackResultDone` 里，`parseResult` 之后：

```js
const diag = diagnoseSafely(parsed, refText)
setDiagnosis(diag)
reportSample({ parsed, diagnosis: diag, refText, accent, evalAccent, params: lastParamsRef.current })
```

`diagnoseSafely` 与 `reportSample` **都定义在本组件文件内**（不新建模块）：

- `diagnoseSafely(parsed, refText)`：`try { return diagnose(parsed, { refText }) } catch { return { items: [], top: null, stats: { boundaries: 0, problematic: 0 } } }`
- `reportSample(payload)`：`authFetch('/shadow-eval/samples', { method: 'POST', body: JSON.stringify({...}) })` 后直接 `.catch(() => {})`，**不 await、不 setState**。`lastParamsRef` 保存 `startRecord` 实际下发的参数。

- [ ] **Step 2: `accent` 传入 `startRecord`**

`const evalAccent = accentToEvalParam(accent)`；`startRecord({ …, ...(evalAccent ? { accent: evalAccent } : {}) })`。**不要**给 `TextDocPage` 传 `accent`（该页不传即不生效）。

- [ ] **Step 3: 删除死代码（两处数据源缺失的 UI）**

1. 删除 `w.liaison.ref === 1` 的连读徽章（数据源恒 0）。
2. 删除五维条里的 `['连读', …]` 项（保留 准确度/流利度/完整度/韵律）。
3. 删除底部原「连读 X/Y 处到位」小字。

- [ ] **Step 4: 新增诊断徽章**

按 `diagnosis.items` 建 `Map<number, item>`（key = `wordIndex`），在词上渲染：`error` → 红 `尾音丢失`、`suggestion` → 琥珀 `连读`、`hint` → 灰 `吞音·正常`。

- [ ] **Step 5: 新增顶部「优先改进」与底部计数**

1. 总分下方插入「优先改进」块（仅 `diagnosis.top` 存在时）：级别配色（error rose / suggestion amber / hint slate）+ `message`；`onClick` → `setExpandedWord(top.wordIndex)`。
2. 底部小字：`可判定连读边界 {stats.boundaries} 处 · {stats.problematic} 处待改进`；`stats.problematic === 0` 时显示 `未发现连读/吞音问题`。
3. `retry()` 时同时重置 `diagnosis`（切句由 `key={currentSub.id}` 重挂载保证）。

- [ ] **Step 6: `VideoDetail.jsx` 传 accent**

`<ShadowingEvaluator key={currentSub.id} refText={currentSub.textEn} accent={video?.accent} onPracticed={…} />`。

- [ ] **Step 7: 验证（无组件测试框架，用 lint + 构建）**

```bash
npm run lint
npx vite build
```
Expected: 两者均无 error，build 产物成功生成。

- [ ] **Step 8: 手动冒烟（dev server）**

`npm run dev` + `npm run server` 后进入任一视频「跟读」tab，点麦克风读一句：
- 结果区顶部出现建议或 ┄ 无建议时底部显示「未发现连读/吞音问题」
- 五维条不再有「连读」项
- 逐词区没有 `连读✓/✗` 死徽章
- 数据库有新增样本：`sqlite3` 不可用时用 `node -e` 查 `SELECT count(*) FROM shadow_eval_samples`

- [ ] **Step 9: Commit**

```bash
git add src/components/ShadowingEvaluator.jsx src/pages/VideoDetail.jsx
git commit -m "feat(pronunciation): 跟读面板接入连读/吞音诊断与样本上报"
```

---

### Task 6: 全量回归 + 人工验收

**Files:** 无代码改动（发现问题回流到对应任务）

- [ ] **Step 1: 全量测试**

```bash
node --test server/routes/shadowEval.test.cjs src/data/phoneIpa.test.js src/utils/pronunciationDiagnosis.test.js src/utils/accentParam.test.js
node --test
```
Expected: 新测试全绿，且既有测试（含 `aliyunResult.test.js`）无回归。

- [ ] **Step 2: lint**

Run: `npm run lint`
Expected: 无 error

- [ ] **Step 3: 人工验收（spec 的成功标准）**

取 10 句真实美国博主字幕句子，各录 1 次，逐条记录：

| # | 句子 | 建议内容 | 是否成立 | 是否唯一 |
|---|---|---|---|---|

判定：**≥ 8 句建议成立且唯一，且没有把"美音正常失爆"报成错误** → 通过。
未通过则回 Task 1（调阈值）/ Task 2（调规则），改完重跑 Step 1-2。

- [ ] **Step 4: Commit（若 Step 3 触发了阈值调整）**

```bash
git add src/data/linkRules.js
git commit -m "chore(pronunciation): 按人工验收结果标定阈值"
```
