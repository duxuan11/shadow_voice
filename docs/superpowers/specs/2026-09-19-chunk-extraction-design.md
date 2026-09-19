# 词卡「核心语块」提取设计文档

日期：2026-09-19
状态：已批准（待实现）

## 背景与目标

视频详情页的「智能重点词卡」抽屉当前有三个 tab：

| Tab | 现状 | 问题 |
|---|---|---|
| 重点单词 | 把每条字幕自带的 `highlightWords` 做词频统计 → 单词 + 音标 + 次数 | 只有孤立单词，无法直接说 |
| 核心短语 | 把「`highlightWords.length >= 3` 的整句字幕」原样列出 | 是整句，不是语块；太长的句子无法直接搬用 |
| 地道表达 | 把「带 `annotations` 的整句字幕」列出 | 保持现状，本设计不动 |

用户痛点：**「单词太碎、整句太长」，都不是能直接拿来讲话的东西。**

期望抽出的目标形态（可迁移语块 chunk，带省略号）：

```
I don't think we're gonna...
...anytime soon
It turns out that...
much more complicated than...
```

本设计把「核心短语」tab 改造成「**核心语块**」tab，用纯本地规则从字幕中提取可迁移语块。

## 已确认的关键决策

1. **入口（方案 A）**：只改视频详情页「智能重点词卡」的「核心短语」tab → 「核心语块」。
   AI 对话页的「素材」chips 不动。
2. **提取方式（方案 B）**：纯本地规则，零成本、零延迟、无 AI 调用、无新增后端接口。
   做成 `src/utils/` 下的纯函数，用 `node:test` 覆盖。
3. **覆盖类型（方案 A）**：只做三类——句首框架 / 句尾补充 / 程度比较。
   不做高频动词框架与固定口语套话（规则库更大、假阳性更高，后续按需再加）。
4. **中文释义（方案 B）**：规则库中每条规则自带「中文模板释义」（如 `It turns out that...` →
   「结果（发现）……」，`...anytime soon` → 「……短期内（不会）」）。释义由人手写，
   不经过 AI，不会瞎编。
5. **不保留旧行为**：抽不到语块时显示空态，**不**回退成「整句当短语」——那正是被替换掉的坏行为。

## 架构总览

```
data/videos/<episode>/subtitles.json
        │  （前端已有：VideoDetail 载入 merged subtitles）
        ▼
src/pages/VideoDetail.jsx
  └─ derivedData (useMemo)
       ├─ keywords   （不变）
       ├─ chunks     ← 新增：extractChunks(video.subtitles)
       └─ expressions（不变）

src/utils/chunks.js   ← 新增纯函数模块（规则库 + 提取 + 去重排序）
src/utils/chunks.test.js ← 新增 node:test 回归测试
```

无后端改动、无数据库改动、无 AI 调用。

## ① 提取器：`src/utils/chunks.js`

### 规则库

导出 `CHUNK_RULES`，每条规则结构：

```js
{
  id: 'stem-it-turns-out',       // 稳定标识，用于测试与去重排查
  type: 'opener',                // 'opener' | 'tail' | 'degree'
  re: /^\s*it turns out that\b/i,// 匹配字幕 textEn
  gloss: '结果（发现）……',         // 中文模板释义
}
```

三类规则与拼装方式：

| type | 含义 | 匹配位置 | 拼装结果 |
|---|---|---|---|
| `opener` | 句首框架 | 句首 | `命中片段` + `...` |
| `tail` | 句尾补充 | 句尾 | `...` + `命中片段` |
| `degree` | 程度 / 比较 | 句中 | `命中片段` + `...` |

初始规则库（18 条，覆盖用户两个例子 + 常见高频框架）。**规则顺序即优先级：更具体的规则必须排在更泛化的规则前面**（例如 `stem-dont-think-gonna` 要排在 `stem-i-dont-think` 之前，否则长语块会被短语块抢先命中）：

```js
// 句首框架 opener
{ id: 'stem-it-turns-out',      type: 'opener', re: /^\s*it turns out that\b/i,                       gloss: '结果（发现）……' }
{ id: 'stem-dont-think-gonna',  type: 'opener', re: /^\s*(?:i|we) don'?t think [^.]{0,40}?\bgonna\b/i, gloss: '我觉得……不会……' }
{ id: 'stem-i-dont-think',      type: 'opener', re: /^\s*i don'?t think\b/i,                          gloss: '我觉得……不……' }
{ id: 'stem-the-thing-is',      type: 'opener', re: /^\s*the thing is\b/i,                            gloss: '问题是/关键在于……' }
{ id: 'stem-the-problem-is',    type: 'opener', re: /^\s*the problem is\b/i,                          gloss: '问题在于……' }
{ id: 'stem-it-seems-like',     type: 'opener', re: /^\s*it seems like\b/i,                           gloss: '看起来好像……' }
{ id: 'stem-you-know-what',     type: 'opener', re: /^\s*you know what\b/i,                           gloss: '你知道吗……' }
{ id: 'stem-what-i-mean-is',    type: 'opener', re: /^\s*what i mean is\b/i,                          gloss: '我的意思是……' }

// 句尾补充 tail
{ id: 'tail-anytime-soon',      type: 'tail', re: /\bany ?time soon\s*[.!?]*$/i,     gloss: '……短期内（不会）' }
{ id: 'tail-for-now',           type: 'tail', re: /\bfor now\s*[.!?]*$/i,            gloss: '……暂时' }
{ id: 'tail-right-now',         type: 'tail', re: /\bright now\s*[.!?]*$/i,          gloss: '……现在/马上' }
{ id: 'tail-at-the-moment',     type: 'tail', re: /\bat the moment\s*[.!?]*$/i,      gloss: '……此刻' }
{ id: 'tail-sooner-or-later',   type: 'tail', re: /\bsooner or later\s*[.!?]*$/i,    gloss: '……迟早' }
{ id: 'tail-in-the-end',        type: 'tail', re: /\bin the end\s*[.!?]*$/i,         gloss: '……最终' }

// 程度 / 比较 degree
{ id: 'degree-much-more-than',  type: 'degree', re: /\b(?:much|far|way|a lot|even)\s+(?:\w+er|more\s+\w+)\s+than\b/i, gloss: '比……得多' }
{ id: 'degree-as-as',           type: 'degree', re: /\bas\s+\w+\s+as\b/i,                                            gloss: '和……一样……' }
{ id: 'degree-more-and-more',   type: 'degree', re: /\bmore and more\b/i,                                            gloss: '越来越……' }
{ id: 'degree-too-to',          type: 'degree', re: /\btoo\s+\w+\s+to\b/i,                                           gloss: '太……以至于不能……' }
```

> `opener` 的 `re` 用 `^` 锚定句首；`tail` 用 `$` 锚定句尾（允许尾部标点）。

### 提取流程

```
extractChunks(subtitles):
  if (!Array.isArray(subtitles)) return []
  seen = Map<key, chunk>   // key = 归一化后的 chunk 文本
  for sub of subtitles:
      en = (sub.textEn || '').trim() 并合并连续空白
      if (!en) continue
      matched = 0; matchedTypes = Set()
      for rule of CHUNK_RULES:
          if (matched >= 2) break                  // 同一句最多 2 个语块
          if (matchedTypes.has(rule.type)) continue // 同一类型每句只取一条（防止长短框架重复命中）
          m = rule.re.exec(en)
          if (!m) continue
          text = build(rule.type, m[0])
          key = normalize(text)            // 小写、去标点、合并空白
          if (seen.has(key)) { seen.get(key).count++; matched++; matchedTypes.add(rule.type); continue }
          seen.set(key, {
            text, type: rule.type, gloss: rule.gloss, count: 1,
            startTime: Number(sub.startTime) || 0,
            sentenceEn: en,
            sentenceCn: (sub.textCn || '').trim(),
          })
          matched++; matchedTypes.add(rule.type)
  list = [...seen.values()]
  list.sort((a,b) => b.count - a.count || a.startTime - b.startTime)  // 次数降序，再按首次出现
  return list.slice(0, 20)                                            // 上限 20 条
```

`build(type, raw)`：先去掉命中片段首尾空白与尾部标点，再按 type 拼接省略号：
- `opener` → `${raw}...`
- `tail` → `...${raw}`
- `degree` → `${raw}...`

`normalize(text)`：`text.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()`。
（复用 `src/utils/subtitles.js` 里 `normalizeSentence` 的思路，但该函数会保留连字符语义，
语块去重可接受更宽松的归一化，故在 `chunks.js` 内独立实现，避免耦合。）

### 语块记录结构

```js
{
  text: 'It turns out that...',   // 展示用，带 ...
  type: 'opener',                 // opener | tail | degree
  gloss: '结果（发现）……',          // 中文模板释义
  count: 1,                       // 全片出现次数
  startTime: 12.3,                // 首次出现时间 → 点击跳转
  sentenceEn: 'It turns out that the problem is much more complicated than we thought.',
  sentenceCn: '结果发现，问题比我们想的复杂得多。',   // 源句中文，可为空
}
```

### 边界处理

| 情况 | 行为 |
|---|---|
| `subtitles` 为空 / 非数组 | 返回 `[]` |
| 某条字幕 `textEn` 为空 | 跳过 |
| 源句 `textCn` 为空 | `sentenceCn` 为 `''`，UI 只显示英文源句 |
| 一条都没抽到 | 返回 `[]`，UI 显示空态（不回退旧整句行为） |
| 同一句命中 3 条以上规则 | 同类型只取 1 条，整体只取前 2 条（按 `CHUNK_RULES` 顺序），如 opener + tail |
| 同一语块多次出现 | 合并为 1 条，`count++`，保留首次的 `startTime` 与源句 |

## ② UI 接线：`src/pages/VideoDetail.jsx`

### derivedData

把 `phrases` 换成 `chunks`：

```js
const derivedData = useMemo(() => {
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

（删除 `sub.highlightWords.length >= 3 → phrases` 及其 fallback 分支。）

### Tab

| 旧 | 新 |
|---|---|
| id `phrases`，label `核心短语` | id `chunks`，label `核心语块` |

抽屉副标题：「当前视频精选核心词汇、短语与口语地道表达」→
「当前视频精选核心词汇、语块与口语地道表达」。

### 语块卡片

```
┌─────────────────────────────────────────────┐
│ It turns out that...   [句首框架] ×2    🔊  │
│ 结果（发现）……                               │
│ ─────────────────────────────────────────── │
│ It turns out that the problem is much more… │
│ 结果发现，问题比我们想的复杂得多。             │
│                              01:23          │
└─────────────────────────────────────────────┘
```

- 类型徽章文案：`opener` → 句首框架 / `tail` → 句尾补充 / `degree` → 程度比较
- `count > 1` 时显示 `×N`
- 点卡片 → `jumpToSubtitle(chunk.startTime)` + `setIsWordCardOpen(false)`（与现有 tab 一致）
- 🔊 → `speakWord(chunk.text.replace(/\.\.\./g, ' ').replace(/\s+/g, ' ').trim())`（去掉省略号再 TTS）
- 视觉沿用词卡既有 Tailwind 语言：`p-3.5 border rounded-2xl bg-white border-slate-100/80 hover:border-slate-200`
- 空态：`暂未提取到语块`

## ③ 测试：`src/utils/chunks.test.js`

用 `node:test` + `node:assert/strict`（与 `src/utils/subtitles.test.js` 同款）。
运行命令：`node --test src/utils/chunks.test.js`。

| 用例 | 断言 |
|---|---|
| 例 1：`I don't think we're gonna see that anytime soon.` | 抽出 `I don't think we're gonna...`(opener) + `...anytime soon`(tail)，且**不**出现 `I don't think...` |
| 例 2：`It turns out that the problem is much more complicated than we thought.` | 抽出 `It turns out that...`(opener) + `much more complicated than...`(degree) |
| 去重 | 同一语块出现在 2 条字幕 → 1 条，`count=2`，`startTime` 取首次 |
| 同类型去重 | 同时命中 `stem-dont-think-gonna` 与 `stem-i-dont-think` 时，只保留更具体的长语块 |
| 一句最多 2 个 | 一条字幕同时命中 opener / tail / degree 时只留前 2 个类型 |
| 大小写/标点差异 | `it turns out that...!` 仍命中，chunk 文本取源字幕大小写 |
| 空输入 | `[]`、`undefined`、`null` → `[]` |
| 不误伤 | `I saw a movie yesterday.` → `[]` |
| 排序 | `count` 降序，其次 `startTime` 升序 |

## 不在本次范围（YAGNI）

- 高频动词框架（`end up ...ing`、`come up with...`）
- 固定口语套话（`to be honest`、`at the end of the day`）
- 跨字幕拼接语块（当前每条字幕独立匹配）
- AI 提取或本地/AI 混合
- 语块收藏到生词本（当前只做发音 + 跳转）
- AI 对话页「素材」chips 展示语块

## 验证

1. `node --test src/utils/chunks.test.js` → 全绿
2. `npm run lint` → 无新增告警
3. 浏览器开一个视频 → 点开「智能重点词卡」→ 看「核心语块」tab：
   卡片带 `...`、类型徽章、中文模板释义、源句英中、点击跳转、🔊 发音
4. 抽查一个不含任何规则的视频 → 显示空态「暂未提取到语块」

> 注意：本仓库 checkout 内 `data/videos/` 不存在（只有 `data/consolidated.json` / `data/meta.json`），
> 无法用真实字幕跑自动化验证；测试用用户提供的两个例句当 fixture。
> 步骤 3/4 需要本地存在 `data/videos/<episode>/subtitles.json` 时人工确认。
