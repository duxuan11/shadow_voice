# 自由表达题目质量改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `npm run speak-prompts` 从"逐行取字幕（产出残句）+ 5 条扩展句"改成"AI 一次调用精选并合并成完整句、改写成地道英文、按视频难度打标、另给 5 条场景扩展句"，并在练习页把「场景扩展」与难度标出来。

**Architecture:** 本地确定性规则负责**数量和形状**（上限 N、字段校验、排序、截断），AI 只负责**内容判断**（挑哪些句、怎么合并、怎么写地道、什么难度）。AI 的输出契约分成 `sentences` / `extensions` 两个数组，题目来源由**数组归属**决定，不读模型自报的标签。所有校验/归一化都是纯函数（`src/utils/speakPrompts.js`，脚本与页面共用），可单测。

**Tech Stack:** Node 22（ESM 脚本 / node:test）、React 19 + Vite 8、`server/services/ai/provider.cjs`（OpenAI 兼容 fetch）、sql.js（清理已练记录用）。零新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-speak-prompts-quality-design.md`

## Global Constraints

- 字幕句上限：`N = min(20, max(5, round(字幕行数 / 2)))`。N 是**上限**，AI 宁缺毋滥。取代旧约束"练习句必须 < 字幕数"（短视频的 cap 下限 5 可能等于字幕数）。
- 场景扩展句：每视频 **5 条**。重试后 3~4 条可落盘但必须打告警；**<3 条或没有字幕句 → 判该视频失败，保留旧文件，脚本非 0 退出**。
- 无 AI key：报错跳过并保留旧文件，**禁止**再生成"纯字幕句"文件（逐行碎片正是本次要修的东西）。
- 难度映射：`info.json` 的 `初级→简单`、`中级→中等`、`高级→难`；每条带 `level`，以该档为中心、允许上下浮动一档。
- `speak-prompts.json` 的 `version` 从 1 → 2；`source` **只能**由"来自哪个数组"推导，禁止信任模型自报字段。
- 送 AI 的字幕是**全量**（删掉原来的 `MAX_TRANSCRIPT_LINES = 150` 截断），带 1-based 行号。
- 一个字不改：`server/routes/speak.cjs`、`server/services/ai/speak.cjs`、`src/utils/practiceRecords.js` 的任务集合、`learningStatus` 的三项进度。
- 练习页除新增两个标识外交互不变；标识放**中文句子上方**，不剧透参考答案。
- 数据重生由**用户**在自己练习的环境执行（`npm run speak-prompts -- --force`）；本计划只在本地 `data/` 跑一次做验收。

## Review Focus

1. AI 返回空题组（`{"sentences":[],"extensions":[]}`）或字段全是垃圾 → 归一化必须**不抛错**地返回空数组，脚本按"失败、保留旧文件"处理，绝不落盘空/畸形题组 → Task 2 空输入测试 + Task 5 的失败分支。
2. 模型给字幕句漏了 `lines` 字段 → 那句仍是字幕句（`subIndex: null`），**绝不能**被标成「场景扩展」骗用户 → Task 2 排序/归属测试 + Task 3 来源推导测试。
3. `lines` 越界 / 非整数 / 逆序 / 字符串 → `subIndex`、`subIndexEnd` 置 `null`，句子保留、不抛错 → Task 2 测试。
4. 模型改写出两条同义中文（字面不同）→ 仍可能重复出题；归一化至少要去掉**归一化后相同**的 `cn`，并给相同 `lines` 跨距打日志 → Task 2 去重测试。
5. 练习页读到**旧 v1 文件**（没有 `level`、没有 `subIndexEnd`）→ 只显示「场景扩展」、不显示难度标签、不崩 → Task 4 的 `promptBadges` 测试 + 页面容错。
6. 短视频边界：22 行 → cap 11、26 行 → cap 13、10 行 → cap 5（下限）、0/非法 → 0 → Task 1 测试。

---

### Task 1: 上限算法 `subtitleCapFor` + 兜底过滤改用该上限

**Files:**
- Modify: `src/utils/speakPrompts.js`（文件头注释也要改：兜底不再是"练习题的唯一来源"）
- Test: `src/utils/speakPrompts.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export function subtitleCapFor(subtitleCount: number) -> number`
    - `subtitleCount <= 0` 或非有限数 → `0`
    - 否则 `Math.min(20, Math.max(5, Math.round(subtitleCount / 2)))`
  - `export function filterSubtitlesToPrompts(subtitles, options = {})` 仍是**兜底**路径，产出的每条变成
    `{ cn, en, source:'subtitle', level:null, subIndex }`（新增 `level: null`），默认上限改为 `subtitleCapFor(subtitles.length)`；
    `options.maxPrompts` 存在时仍可显式覆盖（保持向后兼容）。

- [ ] **Step 1: 写失败测试**

把 `src/utils/speakPrompts.test.js` 里"上限 maxPrompts 截断"之外的旧用例保留，替换掉"总数始终小于字幕数（全部适合时也截掉）"，并新增：

```js
describe('subtitleCapFor', () => {
  it('40 行 → 20（用户例子：40 条字幕出 20 句左右）', () => {
    assert.equal(subtitleCapFor(40), 20)
  })
  it('短视频按比例：22 → 11、26 → 13、35 → 18', () => {
    assert.equal(subtitleCapFor(22), 11)
    assert.equal(subtitleCapFor(26), 13)
    assert.equal(subtitleCapFor(35), 18)
  })
  it('封顶 20：334 → 20', () => {
    assert.equal(subtitleCapFor(334), 20)
  })
  it('下限 5：10 → 5、2 → 5', () => {
    assert.equal(subtitleCapFor(10), 5)
    assert.equal(subtitleCapFor(2), 5)
  })
  it('空/非法 → 0', () => {
    assert.equal(subtitleCapFor(0), 0)
    assert.equal(subtitleCapFor(-3), 0)
    assert.equal(subtitleCapFor(null), 0)
  })
})

describe('filterSubtitlesToPrompts 兜底上限', () => {
  const subs = Array.from({ length: 40 }, (_, i) => ({
    textEn: `This is sentence number ${i}.`,
    textCn: `这是第${i}个句子。`,
  }))
  it('默认按 subtitleCapFor 截断（40 行 → 20），不再是固定 40', () => {
    assert.equal(filterSubtitlesToPrompts(subs).length, 20)
  })
  it('产出的每条都带 level: null（页面据此不显示难度标签）', () => {
    assert.deepEqual(filterSubtitlesToPrompts(subs, { maxPrompts: 2 })[0], {
      cn: '这是第0个句子。', en: 'This is sentence number 0.', source: 'subtitle', level: null, subIndex: 0,
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: FAIL —— `subtitleCapFor is not a function`（或 import 报错）

- [ ] **Step 3: 实现**

`src/utils/speakPrompts.js` 里新增 `subtitleCapFor`（实现就是 Interfaces 里那三行），把 `filterSubtitlesToPrompts` 的
`const maxPrompts = ...` 默认值分支改成 `subtitleCapFor(subtitles.length)`，删除 `DEFAULT_MAX_PROMPTS = 40`，
并在 push 的对象里加 `level: null`。同时删掉原来 `Math.min(maxPrompts, subtitles.length - 1)` 里的 `subtitles.length - 1`
——N 已经自带下限，不再需要"必须小于字幕数"。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: PASS（含旧用例；旧用例里 `filterSubtitlesToPrompts(subs)` 断言 4 条的那条已被 Step 1 替换）

- [ ] **Step 5: Commit**

```bash
git add src/utils/speakPrompts.js src/utils/speakPrompts.test.js
git commit -m "feat(speak): 题目上限算法 subtitleCapFor，兜底过滤同步改造"
```

---

### Task 2: 归一化纯函数 `normalizeSpeakPrompts`

**Files:**
- Modify: `src/utils/speakPrompts.js`
- Test: `src/utils/speakPrompts.test.js`

**Interfaces:**
- Consumes: `subtitleCapFor`（Task 1）
- Produces:
  - `export function normalizeSpeakPrompts(raw, { cap, targetLevel, subtitleCount } = {})`
    → `{ subtitlePrompts: Array<{cn,en,level,subIndex,subIndexEnd}>, extensionPrompts: Array<{cn,en,level}>, stats: {subtitle:number, extension:number, dropped:number}, warnings: string[] }`
  - 按此顺序处理（顺序是有意的，别调换）：
    1. **分类**：`raw.sentences` → 字幕句；`raw.extensions` → 扩展句；非数组一律当空数组。
    2. **丢弃**：`cn`/`en` trim 后为空、`cn` 不含 CJK、`en` 不含字母、`en` 词数 <3 或 >30。
    3. **level**：不在 `['简单','中等','难']` → 用 `targetLevel`；`targetLevel` 也不合法 → `null`。
    4. **lines**：过滤成合法下标（`Number.isInteger` 且 `0 <= i < subtitleCount`）；取 `subIndex = min(lines) - 1`、
       `subIndexEnd = max(lines) - 1`。允许非相邻。缺失或全部非法 → 两者都 `null`（句子保留）。
    5. **去重**：`cn` 按 `replace(/\s+/g,'')` + 去掉 `/[\s，。、！？!?,.;:'"「」（）()]/g` 归一化后相同 → 只留第一条；
       两条字幕句跨距完全相同 → 保留但往 `warnings` 推一条（形如 `字幕句跨距重复：[2,4]`）。
    6. **排序**：字幕句先按 `subIndex` 升序、`subIndex` 为 `null` 的按原顺序排在其后；扩展句整体在后。
    7. **截断**：字幕句取前 `cap` 条（`cap` 非法时用 `subtitleCapFor(subtitleCount)`）；扩展句取前 5 条。
    8. **warnings**：`subtitlePrompts` 为空时推 `没有可用的字幕句`；`extensionPrompts.length < 5` 时推
       `扩展句不足 5 条（N 条）`。

- [ ] **Step 1: 写失败测试**

```js
describe('normalizeSpeakPrompts', () => {
  const raw = () => ({
    sentences: [
      { lines: [9, 9], cn: '通常礼宾员会帮你拿行李。', en: 'Normally the concierge takes your bags.', level: '中等' },
      { lines: [3, 5], cn: '这个东西是行李推车，用来放行李的。', en: 'This is a luggage trolley, where you put your bags.', level: '简单' },
      { cn: '字幕句但模型漏了行号。', en: 'A sentence with no line numbers.', level: '很难' },
      { lines: ['x', 999], cn: '行号越界或非整数。', en: 'Lines out of range.', level: '难' },
      { cn: '', en: 'Empty cn.' },
      { cn: '没有英文。', en: '' },
      { cn: 'English only', en: 'no cjk here' },
      { cn: '词太少。', en: 'too' },
    ],
    extensions: [
      { cn: '我订了一间带早餐的房间。', en: 'I booked a room with breakfast included.', level: '中等' },
      { cn: '行李可以寄存在前台。', en: 'You can leave your luggage at the front desk.', level: '困难' },
    ],
  })

  it('空/畸形输入不抛错 → 空数组 + 告警', () => {
    const r = normalizeSpeakPrompts(null, { subtitleCount: 3, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts, [])
    assert.deepEqual(r.extensionPrompts, [])
    assert.equal(r.stats.subtitle, 0)
    assert.ok(r.warnings.includes('没有可用的字幕句'))
  })

  it('丢弃空/无中文/无英文/词数不足的条目', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.cn), [
      '这个东西是行李推车，用来放行李的。',
      '通常礼宾员会帮你拿行李。',
      '字幕句但模型漏了行号。',
      '行号越界或非整数。',
    ])
    assert.equal(r.stats.dropped, 4)
  })

  it('排序：按 subIndex 升序，漏行号的排在其后', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.subIndex), [2, 8, null, null])
    assert.deepEqual(r.subtitlePrompts.map(p => p.subIndexEnd), [4, 8, null, null])
  })

  it('level：非法值回落到 targetLevel，targetLevel 也非法则 null', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '中等' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.level), ['简单', '中等', '中等', '难'])
    const r2 = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '超难' })
    assert.deepEqual(r2.subtitlePrompts.map(p => p.level), ['简单', '中等', null, '难'])
  })

  it('漏行号的字幕句留在字幕句里（不会被当成扩展句）', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.ok(r.subtitlePrompts.some(p => p.cn === '字幕句但模型漏了行号。'))
    assert.ok(!r.extensionPrompts.some(p => p.cn === '字幕句但模型漏了行号。'))
  })

  it('截断：cap 先排序再截断，留下视频靠前的句子', () => {
    const r = normalizeSpeakPrompts(raw(), { cap: 2, subtitleCount: 10, targetLevel: '简单' })
    assert.deepEqual(r.subtitlePrompts.map(p => p.subIndex), [2, 8])
  })

  it('去重：cn 归一化后相同只留第一条（去空白与标点）', () => {
    const r = normalizeSpeakPrompts({
      sentences: [
        { lines: [1], cn: '你好，世界。', en: 'Hello world today.' },
        { lines: [2], cn: ' 你好世界 ', en: 'Hello, world, today.' },
      ],
      extensions: [],
    }, { subtitleCount: 5, targetLevel: '简单' })
    assert.equal(r.subtitlePrompts.length, 1)
  })

  it('扩展句 ≤5 且不足 5 条时给告警', () => {
    const r = normalizeSpeakPrompts(raw(), { subtitleCount: 10, targetLevel: '简单' })
    assert.equal(r.extensionPrompts.length, 2)
    assert.ok(r.warnings.includes('扩展句不足 5 条（2 条）'))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: FAIL —— `normalizeSpeakPrompts is not a function`

- [ ] **Step 3: 实现 `normalizeSpeakPrompts`**

在 `src/utils/speakPrompts.js` 里实现 Interfaces 里那 8 条；常量 `LEVELS = ['简单','中等','难']`、
`EN_MIN_WORDS = 3`、`EN_MAX_WORDS = 30`、`MAX_EXTENSIONS = 5`。归一化去重键用一个内部函数
`dedupeKey(cn) = cn.replace(/\s+/g,'').replace(/[\s，。、！？!?,.;:'"「」（）()]/g,'')`。
注意第 4 条：`lines` 要为**每条句子**单独算，`subtitleCount` 非法（非正数）时一律把 `subIndex` 置 `null`（不要抛错）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/speakPrompts.js src/utils/speakPrompts.test.js
git commit -m "feat(speak): normalizeSpeakPrompts 校验/排序/截断/去重纯函数"
```

---

### Task 3: 产物组装 v2 `buildSpeakPromptsData`

**Files:**
- Modify: `src/utils/speakPrompts.js`
- Test: `src/utils/speakPrompts.test.js`

**Interfaces:**
- Consumes: `normalizeSpeakPrompts` 的输出（Task 2）
- Produces:
  - `export function buildSpeakPromptsData({ videoId, title, level = null, model = null, subtitlePrompts = [], extensionPrompts = [], generatedAt })`
    → `{ version: 2, videoId, title, level, model, generatedAt, prompts: Array<{index, cn, en, source, level, subIndex, subIndexEnd}> }`
  - `source` **由数组归属**决定：`subtitlePrompts[]` → `'subtitle'`，`extensionPrompts[]` → `'ai_generated'`（函数的入参名就是归属，不再读 item 上的 `source` 字段）。
  - `index` = 合并后数组下标；`subIndex`/`subIndexEnd` 透传，扩展句一律 `null`；`level` 透传（缺失 → `null`）。

- [ ] **Step 1: 写失败测试**

替换旧的 `buildSpeakPromptsData` 用例：

```js
describe('buildSpeakPromptsData', () => {
  const data = () => buildSpeakPromptsData({
    videoId: 'v1', title: '出国旅行的日常', level: '初级', model: 'deepseek-chat',
    generatedAt: '2026-10-12T00:00:00Z',
    subtitlePrompts: [
      { cn: '这个东西是行李推车，用来放行李的。', en: 'This is a luggage trolley.', level: '简单', subIndex: 2, subIndexEnd: 4 },
      { cn: '字幕句但漏了行号。', en: 'No line numbers.', level: null, subIndex: null, subIndexEnd: null },
    ],
    extensionPrompts: [
      { cn: '我订了一间带早餐的房间。', en: 'I booked a room with breakfast included.', level: '中等' },
    ],
  })

  it('version 2 + 顶层字段透传', () => {
    const d = data()
    assert.equal(d.version, 2)
    assert.equal(d.videoId, 'v1')
    assert.equal(d.level, '初级')
    assert.equal(d.model, 'deepseek-chat')
  })

  it('source 由数组归属决定（漏行号的字幕句仍是 subtitle）', () => {
    assert.deepEqual(data().prompts.map(p => p.source), ['subtitle', 'subtitle', 'ai_generated'])
  })

  it('index 连续、扩展句 subIndex/subIndexEnd 为 null、level 透传', () => {
    const p = data().prompts
    assert.deepEqual(p.map(x => x.index), [0, 1, 2])
    assert.deepEqual(p[0], {
      index: 0, cn: '这个东西是行李推车，用来放行李的。', en: 'This is a luggage trolley.',
      source: 'subtitle', level: '简单', subIndex: 2, subIndexEnd: 4,
    })
    assert.deepEqual(p[2], {
      index: 2, cn: '我订了一间带早餐的房间。', en: 'I booked a room with breakfast included.',
      source: 'ai_generated', level: '中等', subIndex: null, subIndexEnd: null,
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: FAIL —— `version` 仍是 1 / 无 `subIndexEnd` / 缺 `source` 推导

- [ ] **Step 3: 实现**

改写 `buildSpeakPromptsData`：两个入参数组各自 map 成条目（分别硬编码 `source`），`[...subtitle, ...extension]`
统一补 `index`。删掉原来"读 `p.source` 判断"的逻辑。更新文件头注释里的产物示例。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/speakPrompts.js src/utils/speakPrompts.test.js
git commit -m "feat(speak): speak-prompts.json 升级 version 2（来源按数组归属、带难度与行跨距）"
```

---

### Task 4: 练习页标识（`promptBadges` + 渲染 + 兜底传上限）

**Files:**
- Modify: `src/utils/speakPrompts.js`、`src/utils/speakPrompts.test.js`
- Modify: `src/pages/SpeakPracticePage.jsx:65-85`（兜底调用处）、`:190-200`（中文卡片）

**Interfaces:**
- Consumes: Task 1 的 `subtitleCapFor`
- Produces:
  - `export function promptBadges(prompt) -> Array<{ kind:'extension'|'level', text:string }>`
    - `prompt?.source === 'ai_generated'` → 先推 `{ kind:'extension', text:'场景扩展' }`
    - `prompt?.level` 为 `'简单'|'中等'|'难'` 之一 → 再推 `{ kind:'level', text: prompt.level }`
    - 其余（`level` 为 `null`/缺失、`prompt` 为 `null`）→ 不推。返回新数组，永不抛错。

- [ ] **Step 1: 写失败测试**

```js
describe('promptBadges', () => {
  it('扩展句 + 难度 → 两个标签，顺序固定', () => {
    assert.deepEqual(promptBadges({ source: 'ai_generated', level: '中等' }), [
      { kind: 'extension', text: '场景扩展' },
      { kind: 'level', text: '中等' },
    ])
  })
  it('字幕句只有难度', () => {
    assert.deepEqual(promptBadges({ source: 'subtitle', level: '简单' }), [{ kind: 'level', text: '简单' }])
  })
  it('旧 v1 文件（有 source 无 level）只显示场景扩展', () => {
    assert.deepEqual(promptBadges({ source: 'ai_generated' }), [{ kind: 'extension', text: '场景扩展' }])
  })
  it('兜底题目（level:null）不显示难度', () => {
    assert.deepEqual(promptBadges({ source: 'subtitle', level: null }), [])
  })
  it('非法 level 不显示、null 输入不抛错', () => {
    assert.deepEqual(promptBadges({ source: 'ai_generated', level: '超难' }), [{ kind: 'extension', text: '场景扩展' }])
    assert.deepEqual(promptBadges(null), [])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: FAIL —— `promptBadges is not a function`

- [ ] **Step 3: 实现 `promptBadges`**

按 Interfaces 实现（用 Task 2 已经有的 `LEVELS` 常量判断合法难度）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/speakPrompts.test.js`
Expected: PASS

- [ ] **Step 5: 页面接入**

`src/pages/SpeakPracticePage.jsx`：

1. import 增加 `promptBadges`，兜底那段改成
   `prompts = filterSubtitlesToPrompts(subs, { maxPrompts: subtitleCapFor(subs.length) })`（`subtitleCapFor` 一并 import）。
2. 中文卡片里「看中文，说英文」那一行下方加一行标签（**在中文句子上面**）：

```jsx
{(() => {
  const badges = promptBadges(prompt)
  if (badges.length === 0) return null
  return (
    <div className="flex items-center justify-center gap-1.5 mb-2">
      {badges.map(b => (
        <span key={b.kind} className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
          b.kind === 'extension'
            ? 'bg-violet-50 text-violet-600 border-violet-100'
            : b.text === '简单' ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
            : b.text === '中等' ? 'bg-amber-50 text-amber-600 border-amber-100'
            : 'bg-rose-50 text-rose-600 border-rose-100'
        }`}>{b.text}</span>
      ))}
    </div>
  )
})()}
```

（若 `prompt` 为 `undefined`（题组为空）时不应崩：`promptBadges` 容忍 `null`，`prompt?.level` 写法保持不变。）

- [ ] **Step 6: lint + 构建验证**

Run: `npm run lint && npm run build`
Expected: lint 无 error（允许既有 warn），build 成功

- [ ] **Step 7: Commit**

```bash
git add src/utils/speakPrompts.js src/utils/speakPrompts.test.js src/pages/SpeakPracticePage.jsx
git commit -m "feat(speak): 练习页显示场景扩展与难度标识"
```

---

### Task 5: 脚本改为 AI 一次性提取（含 README）

**Files:**
- Modify: `scripts/build-speak-prompts.mjs`（整体改写 `buildTranscript` 之后的流程）
- Modify: `README.md`（"数据来源与处理"补第 7 步）

**Interfaces:**
- Consumes: `subtitleCapFor`、`normalizeSpeakPrompts`、`buildSpeakPromptsData`（Task 1–3）
- Produces: 与旧用法完全一致的 CLI —— `npm run speak-prompts [-- --force] [-- --video <id|目录名>] [-- --dry]`；
  退出码非 0 当且仅当有视频失败。

**要删掉的**：`MAX_PROMPTS`、`MAX_EXTENSIONS`、`MAX_TRANSCRIPT_LINES`、`buildExtensionsPrompt`、
"本地过滤 + AI 造扩展句"两段式（`filterSubtitlesToPrompts` 不再被脚本使用，它只服务页面兜底）。

**要新增的**：

1. `buildTranscript(subtitles)` → **全量**、1-based 行号：`${i + 1}. ${en} || ${cn}`（沿用现有格式，去掉 `.slice(0, MAX_TRANSCRIPT_LINES)`）。
2. `buildExtractionPrompt({ title, level, cap, subtitles })` → `[{role:'system'...},{role:'user'...}]`，文案照抄：

```
system:
你是英语学习内容编辑，为「看中文说英文」口语练习出题。读者是中文母语者，目标是能把日常英语说出口。
只输出一个紧凑的 JSON 对象，不要换行缩进、不要 Markdown 代码块、不要任何解释。

user:
视频标题：<title>
本视频难度：<简单|中等|难>（每条句子的 level 以这一档为中心，允许上下浮动一档）
字幕（逐行转录，格式：行号. English || 中文。注意：字幕未做断句，一句话常被拆成相邻的多行）：
<transcript>

任务一：挑出最多 <cap> 条最适合练口语的完整句子。宁缺毋滥——值得练的不足 cap 条就给更少。
- 优先：日常生活高频、口语常用、学了马上能用上的表达。
- 跳过：人名地名作品名等专名、纯称呼或语气词、没有完整意思的残片、需要大量背景才懂的句子、转录噪声无法修复的句子。
- 合并：把属于同一句话的相邻行合并成一句完整的话（例：第 3~5 行是 "this guys is a" / "luggage trolley" / "where you put your bags"，应合成一句），并在 lines 里写出用到的行号（1-based）。
- 改写英文：改成地道、自然、语法正确的现代口语英文；字幕可能有转录错误（如 "this guys is a" 要修正）。只修正表达，不要新增原文没有的信息。
- 改写中文：补成完整自然的中文，不要保留残句语气；必须与英文同义。
任务二：另外给 5 条「场景扩展句」：围绕本视频的场景（如航班、酒店、旅行、日常）再造 5 句日常生活里常用、马上能用上的口语，中英对照；不要与任务一挑出的句子重复或近似。

level 只能取「简单」「中等」「难」。

输出 JSON 结构：
{"sentences":[{"lines":[3,5],"cn":"中文句子","en":"English sentence","level":"简单"}],"extensions":[{"cn":"中文句子","en":"English sentence","level":"中等"}]}
```

3. `generateJsonWithRetry(messages)` 改为 `return { json, content }`（`content` 是模型原始输出，供反馈重试用）；
   `extractPrompts(messages, { cap, subtitleCount, targetLevel })` → `{ norm, content }`：先调 `generateJsonWithRetry`，
   再 `normalizeSpeakPrompts(json, { cap, targetLevel, subtitleCount })`；
   **不合格（`subtitlePrompts.length === 0` 或 `extensionPrompts.length < 5`）时，往 `messages` 追一轮反馈并整体重试一次**：

```js
messages.push(
  { role: 'assistant', content: lastContent },
  { role: 'user', content: `上一轮不合格：${norm.warnings.join('；')}。请重新输出完整 JSON 对象，字幕句不超过 ${cap} 条且至少 1 条、extensions 必须正好 5 条。` },
)
```

   第二轮仍不合格时返回该次结果（由调用方决定失败或带告警落盘）。

4. `processEpisode` 的规则：
   - `if (!isConfigured())` → `return { epDir, status: 'skip', reason: 'AI 未配置，无法精选题目（旧文件保留）' }`。
   - `cap = subtitleCapFor(subtitles.length)`；`targetLevel = LEVEL_BY_VIDEO_LEVEL[info.level] || null`（映射表 `{初级:'简单',中级:'中等',高级:'难'}`）。
   - 归一化结果若 `subtitlePrompts.length === 0 || extensionPrompts.length < 3` → `status: 'failed'`，
     **不写文件**，`main()` 里按失败计数并 `process.exit(1)`。
   - `extensionPrompts.length` 为 3~4 → 正常落盘，但把 `warnings` 打到 console.warn。
   - 落盘走 `buildSpeakPromptsData({ videoId, title, level: info.level || null, model: AI_MODEL, subtitlePrompts, extensionPrompts, generatedAt })`。
   - 日志：`✓ <目录> 字幕句 N/cap 扩展句 5/5 难度 简单×a/中等×b/难×c`（难度计数从 `prompts` 里统计）。
   - `--dry` 时**打印整组题目**（`index. [level|来源] cn → en`，来源打 `字幕` / `扩展`），供人工过目。

5. `README.md` 的"数据来源与处理"加第 7 步：
   `7. **生成口语练习句** → npm run speak-prompts -- --force（读取每条视频的 subtitles.json，由 AI 精选并合并成完整句、改写地道英文、另加 5 条场景扩展句，落盘 data/videos/<episode_dir>/speak-prompts.json；产物不入库，需对目标 DATA_DIR 执行）`

- [ ] **Step 1: 改写脚本（按上面的 Interfaces）**

- [ ] **Step 2: 用最短的视频做一次真实集成验证**

Run: `npm run speak-prompts -- --dry --video 06_如何在每天3点起来`
Expected: 打印出该条视频的整组题目；字幕句 ≤ 13 条、扩展句 5 条、每条都有 `level`；无异常栈、无 JSON 解析告警。

- [ ] **Step 3: 用 01 号视频验证"合并残句"这个核心诉求**

Run: `npm run speak-prompts -- --dry --video 01_出国旅行的日常`
Expected: 输出里**不再出现**「这个东西是」/「行李推车」/「用来放行李的」这类残句；应出现一条覆盖第 3~5 行的完整句，
英文是修正过的地道说法（不是 `this guys is a luggage trolley`）。若未达成，只调整 `buildExtractionPrompt` 的措辞后重跑
（这是本任务唯一需要迭代的地方）。

- [ ] **Step 4: 把 01 的整组题目贴给用户过目，等他点头**

（这一步是人工 gate：挑句是否值得练、合并对不对、英文地不地道、难度合不合理。用户认可后才继续全量重生。）

- [ ] **Step 5: Commit**

```bash
git add scripts/build-speak-prompts.mjs README.md
git commit -m "feat(speak): 预提取改为 AI 精选合并 + 改写 + 难度标注（每视频 1 次调用）"
```

---

### Task 6: 一次性清理已练记录 `scripts/reset-practice-task.mjs`

**Files:**
- Create: `scripts/reset-practice-task.mjs`
- Test: `scripts/reset-practice-task.test.mjs`

**Interfaces:**
- Consumes: `server/db.cjs` 的 `getDb/all/run`（`run()` 自带落盘）；表 `practice_records(id, user_id, video_id, data, updated_at)`，`data` 是 JSON 文本
- Produces:
  - `export function clearTaskInData(json, task) -> { json: string, changed: boolean }`
    - `json` 解析失败或不是对象 → `{ json: String(json ?? ''), changed: false }`
    - `data[task]` 非数组或已为空 → 原样返回、`changed: false`
    - 否则把 `data[task]` 置为 `[]`、其余键不动，返回重新 `JSON.stringify` 的文本、`changed: true`
  - CLI：`node scripts/reset-practice-task.mjs --task speak [--dry]`
    - 默认 `task` 为 `speak`；`--dry` 只打印会改几行，不写库
    - 用 `SHADOW_VOICE_DB` / `DATA_DIR` 定位库（`server/db.cjs` 已支持 `SHADOW_VOICE_DB`）
    - 输出：`[reset-practice-task] 扫描 N 行，清理 M 行（task=speak）` + dry 时附 `（--dry，未写库）`

- [ ] **Step 1: 写失败测试**

```js
// scripts/reset-practice-task.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clearTaskInData } from './reset-practice-task.mjs'

describe('clearTaskInData', () => {
  it('清掉指定任务，其余任务不动', () => {
    const r = clearTaskInData(JSON.stringify({ shadow: [1, 2], cloze: [], translate: [], speak: [0, 1, 2] }), 'speak')
    assert.equal(r.changed, true)
    assert.deepEqual(JSON.parse(r.json), { shadow: [1, 2], cloze: [], translate: [], speak: [] })
  })
  it('已经为空 → 不改', () => {
    const r = clearTaskInData(JSON.stringify({ shadow: [1], speak: [] }), 'speak')
    assert.equal(r.changed, false)
  })
  it('缺该任务 / 非数组 → 不改', () => {
    assert.equal(clearTaskInData(JSON.stringify({ shadow: [1] }), 'speak').changed, false)
    assert.equal(clearTaskInData(JSON.stringify({ speak: null }), 'speak').changed, false)
  })
  it('非法 JSON / 非对象不抛错', () => {
    assert.equal(clearTaskInData('not json', 'speak').changed, false)
    assert.equal(clearTaskInData(null, 'speak').changed, false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/reset-practice-task.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现脚本**

纯函数 `clearTaskInData` 按 Interfaces 实现；底部 CLI 用 `createRequire` 引入 `../server/db.cjs`，
`await getDb()` → `all('SELECT id, data FROM practice_records')` → 逐行 `clearTaskInData` → `changed` 的行
`run('UPDATE practice_records SET data = ?, updated_at = datetime(\'now\') WHERE id = ?', [json, row.id])`。
脚本被 `import` 时不执行 CLI（`if (process.argv[1] && process.argv[1].endsWith('reset-practice-task.mjs'))` 守卫）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test scripts/reset-practice-task.test.mjs`
Expected: PASS

- [ ] **Step 5: 对本地库干跑**

Run: `node --env-file-if-exists=.env scripts/reset-practice-task.mjs --task speak --dry`
Expected: 打印扫描/待清理行数，**不写库**（`--dry`）

- [ ] **Step 6: Commit**

```bash
git add scripts/reset-practice-task.mjs scripts/reset-practice-task.test.mjs
git commit -m "chore(speak): 一次性清理已练记录的脚本（清 speak，不动其他任务）"
```

---

### Task 7: 本地全量重生 + 抽查（交付验收）

**Files:**
- 产物（不入库）：`data/videos/*/speak-prompts.json` × 12

**Interfaces:**
- Consumes: Task 1–5 的全部产物
- Produces: 12 个 version 2 的 `speak-prompts.json`，以及一份交付说明（写进回复，不进 git）

- [ ] **Step 1: 全量重生**

Run: `npm run speak-prompts -- --force`
Expected: 12 条全部 `✓`；每条 `字幕句 ≤ cap`、`扩展句 5/5`；无 `✗`；退出码 0。
（若某条重试后扩展句仍 3~4 条，记下目录名，Step 4 的交付说明里列出。）

- [ ] **Step 2: 结构抽查（12 条一起过）**

```bash
node -e "
const fs=require('fs');
const dirs=fs.readdirSync('data/videos').filter(d=>fs.statSync('data/videos/'+d).isDirectory()).sort();
for(const d of dirs){
  const f='data/videos/'+d+'/speak-prompts.json'; if(!fs.existsSync(f)) { console.log('缺文件',d); continue }
  const j=JSON.parse(fs.readFileSync(f,'utf8'));
  const sub=j.prompts.filter(p=>p.source==='subtitle'), ext=j.prompts.filter(p=>p.source==='ai_generated');
  const bad=j.prompts.filter(p=>!p.cn||!p.en||!['简单','中等','难'].includes(p.level));
  const oob=j.prompts.filter(p=>p.subIndex!=null&&(p.subIndex<0));
  console.log(d.padEnd(34),'v'+j.version,'字幕',sub.length,'扩展',ext.length,'level缺失/非法',bad.length,'越界',oob.length);
}
"
```

Expected: 每条 `v2`、扩展 5、`level缺失/非法 0`、`越界 0`。

- [ ] **Step 3: 合并正确性抽查（人工看 01）**

对照 `data/videos/01_出国旅行的日常/subtitles.json` 的第 3~5 行，确认 01 的题组里有一条 `subIndex:2 / subIndexEnd:4`
且中文完整、英文地道。再随手看 02（高级）一条，确认难度标为「难」为主。

- [ ] **Step 4: 交付说明**

在回复里写清：重生到哪个 `DATA_DIR`、哪些视频扩展句不足 5（若有）、以及**用户需在自己练习的环境里**
执行 `npm run speak-prompts -- --force`（不带 `--force` 会静默跳过）与
`node --env-file-if-exists=.env scripts/reset-practice-task.mjs --task speak`（清旧已练记录）。

- [ ] **Step 5: 全量测试 + lint + 构建**

Run: `node --test src/utils server/routes server/services server/lib scripts && npm run lint && npm run build`
Expected: 全绿；lint 无新增 error

- [ ] **Step 6: Commit（只有代码/文档有变更时才需要；数据文件不入库）**

```bash
git status --porcelain   # 期望：除 data/ 外无其他未提交变更
```

---

## 验收对照（Spec §12）

| Spec 要求 | 落在哪 |
|---|---|
| DoD 1 人工把关优先 | Task 5 Step 4 |
| DoD 2 12 条结构正确 | Task 7 Step 1–2 |
| DoD 3 合并正确性抽查 | Task 7 Step 3 |
| DoD 4 无 AI key 报错不伪造 | Task 5 Step 1（`!isConfigured()` 分支） |
| DoD 5 页面标识 | Task 4 Step 5 |
| DoD 6 单测 | Task 1/2/3/4/6 |
| DoD 7 lint/build | Task 4 Step 6、Task 7 Step 5 |
| DoD 8 端到端（可选） | 本次不做；Task 7 Step 3 用人工抽查替代 |
| DoD 9 现有功能零退化 | Task 7 Step 5 全量测试 + Global Constraints 的"一个字不改"清单 |
| DoD 10 README | Task 5 Step 1 第 5 条 |
| DoD 11 清理脚本 | Task 6 |
| DoD 12 交付说明 | Task 7 Step 4 |
