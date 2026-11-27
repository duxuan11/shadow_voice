# 跟读发音诊断层（连读 / 失爆吞音 / 词尾辅音）— 设计规格

日期：2026-11-26
状态：待用户评审
分支：`feat/pronunciation-diagnosis`

## 背景与问题

VideoDetail「跟读」tab 已接入阿里云 SSECP 口语评测（`en.sent.score`），出总分、准确度、流利度、完整度、韵律与逐词/音素得分。但用户反馈：**发音纠正太简单，没有连读、吞音的纠正或解析** —— 而视频多为美国博主口音，正是最需要连读/失爆指导的场景。

本轮（层 1）只做**规则化发音诊断**：在不更换评测引擎、不增加 AI 调用、不改变评分口径的前提下，从已有评测结果中推导出「该连读没连」「失爆/吞音」「词尾辅音丢失」三类具体问题，并在界面上给出一条可执行的改进建议。

层 2（LLM 中文讲解 / 舌位口型指导）**不在本轮范围**，下一轮基于本轮的 dry-run 数据再做。

## 实测依据（2026-11-26 spike，真实云端返回）

Spike 用无头 Chromium + 注入 `navigator.mediaDevices.getUserMedia` 的方式，把已知音频喂给官方 `engine.js`，跑通真实评测（凭据 `a0008wy`，本地产物 `/tmp/spike/out/*.raw.json`，共 32 份响应）。关键实测结论：

| 结论 | 证据 |
|---|---|
| 评测链路可用、可自动化回归 | `overall` 96 / 94 / 89 / 95，`integrity` 恒 100 |
| **`liaisonref` 是死字段，恒为 0** | 6 种条件下（自然连读 / 人为断开 400ms·870ms / `auto_rhythm` 0·1·"1" / 加 `rhythm:1`）无一次点亮。现有 UI 的 `连读✓/✗` 徽章与五维「连读」条**从未显示过数据** |
| **总分对连读几乎不敏感** | 把自然连读全部断开（间隙 870ms），`overall` 仅 96 → 94 |
| 替代信号单调可用 | 同一位置 `get\|out`：间隙 0ms → 尾音素 `/t/` 分 **95**；间隙 480ms → **85**；间隙 870ms → **77** |
| 引擎会把他断点判为「意群」 | 上述间隙出现时 `senseref:1 / sensescore:1`；870ms 时 `fluency.pause` 0 → 1 |
| `accent` 参数真实生效 | 同一音频只改参数：`am` 94~95 / `en` 86~88（约 8 分差） |
| 文本标注记号可用 | `(t:1)` → `toneref=1`（且扣分 92→89）；`(s:1)` → `stressref=1`；`(l:1)` **不合法**（词数 11→13，对齐崩） |
| `typeThres` 生效 | 严格 95 / 默认 96 / 宽松 97 |
| 音素无时间戳 | 只有「词」有 `start/end`；`phones[]` 仅有 `char/score/pherr/ph2alpha` |
| 评分有抖动 | 同一音频重复跑出现 96/97 —— 阈值判定必须留缓冲 |
| 音素符号是混合集 | 英文结果共 47 个唯一符号，ARPAbet 与 IPA 混用且有同义重复（`ay`/`aɪ`、`aa`/`ɑ`、`aw`/`aʊ`）；另有**重音前缀形式**（如 `'p`，实测出现在 `possible` 首音素） |

结论：**层 1 不能依赖 `liaisonref`，必须基于「词间间隙 + 边界音素得分 + 意群/停顿标志」自行判定。**

## 目标 / 非目标

**目标**

1. 从 `parseResult()` 的产物推导 ①②③ 三类发音问题，给出**一条**最该改的建议。
2. 在逐词区就地标注（徽章），点击建议可高亮对应词。
3. 按视频口音传 `accent`，让美国博主视频按美音评分。
4. 落盘原始评测 JSON（dry-run），用于 30 天后标定阈值。

**非目标（本轮不做）**

- LLM 中文讲解 / 舌位口型指导 / 最小对立对练习（层 2）
- 弱读判定（④）：本轮不实现，也不在输出结构里预留半成品字段
- 句末语调（⑤）、意群停顿是否「停错」（⑥）的判定
- 更换或新增评测引擎（Azure / 自建对齐）
- 跟读分数持久化与进步曲线（`practice_records` 仍只记句子索引）
- 修改 `TextDocPage` 的文本练习评分口径

## 架构

```
ShadowingEvaluator (React，只负责渲染)
  ├─ engineBackResultDone → parseResult(msg) → parsed          （现有，不改）
  ├─ diagnose(parsed, { refText }) → { items, top }            ← 新增，纯函数
  ├─ 渲染：顶部一条建议 / 逐词徽章 / 底部边界计数
  └─ reportSample({ raw, parsed, diagnosis, ... })             ← 新增，fire-and-forget
        └─ POST /api/shadow-eval/samples → 表 shadow_eval_samples
```

新增文件与职责（每个单元可独立理解与测试）：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/utils/pronunciationDiagnosis.js` | `diagnose()` / `extractBoundaries()` / `pickTop()`：纯函数，无 React、无网络、无随机、无时间 | `linkRules.js`、`phoneIpa.js` |

> `accent` 不参与规则判定（它只影响下发给引擎的参数与样本记录），因此**不进 `diagnose()` 签名**。
| `src/data/linkRules.js` | 阈值常量、爆破音集合、功能词表、规则元数据 | 无 |
| `src/data/phoneIpa.js` | 音素 → IPA 映射（47 条 + 别名 + 剥离 `'` 重音前缀 + 未知降级为原符号），并导出 `isConsonant` / `isVowel` | 无 |
| `src/utils/accentParam.js` | `accentToEvalParam(accent)` 纯函数 | 无 |
| `server/routes/shadowEval.cjs` | 样本上报端点 + 30 天清理 | `db.cjs`、`auth.cjs` |

改动文件：`src/components/ShadowingEvaluator.jsx`（渲染 + 上报调用）、`src/pages/VideoDetail.jsx`（传 `accent`）、`server/index.cjs`（挂载路由）、`server/db.cjs`（建表）。

**硬性约束**

- `diagnose()` 与上报一律 `try/catch` 包裹：失败只能导致「没有新标注」，**绝不影响出分与现有 UI**。
- `diagnose()` 必须可重复（同输入同输出），便于单测与阈值回归。

## 规则规格

### 特征提取（`extractBoundaries`）

对每一对相邻词 `(cur, next)` 计算：

- `gapMs = next.start - cur.end`（任一为 `null` → 该对丢弃）
- `tail = cur.phones.at(-1)`、`head = next.phones[0]`（缺失 → 该对丢弃）；取符号前先剥离重音前缀 `'`（实测音素形如 `'p`，见下）
- `tailScore = tail.score`、`headScore = head.score`
- `isConsonant(sym)` / `isVowel(sym)`：基于剥离 `'` 后的符号查表判定；**无法归类（未知符号）→ 该词对丢弃，不猜**
- `boundaryBefore(stop)`：`next` 之前是否为意群边界（依据 `refText` 中 `next.char` 之前的标点 `, . ; : ? !` 判断）
- `curIsFunctionWord` / `nextIsFunctionWord`（功能词表）

**排除条件**（命中即丢弃该词对）：`cur.fakePron`、`next.fakePron`、`cur.dpType !== 0`、`next.dpType !== 0`。

> ⚠️ **`isPause` 不排除**（2026-11-26 验收修正）：实测人为断开 870ms 时引擎会给该词打 `is_pause:1`，
> 若因此排除词对，**最强的“该连未连”信号会被自己的过滤条件吞掉**（实测 `gapB-800` 漏报）。
> 停顿恰恰是连读失败的证据，必须参与判定。

### 三条规则

| ID | 名称 | 级别 | 触发条件 | 文案模板 |
|---|---|---|---|---|
| `link-missing` | 连读缺失 | 建议（琥珀） | `tail` 为辅音 ∧ `head` 为元音 ∧ `gapMs > GAP_LINK` ∧ `tailScore < TAIL_LINK` ∧ `!boundaryBefore` | `{cur} {next} 该连读（{tailIPA}+{headIPA} → {combinedIPA}），你中间断了 {gapMs}ms` |
| `stop-elision` | 失爆 / 吞音 | 提示（灰） | `tail` ∈ 爆破音 ∧ `head` 为辅音 ∧ `gapMs < GAP_STOP` ∧ `tailScore < TAIL_STOP` | `{cur} 的 {tailIPA} 被吃掉是美音常态（失爆），不是错；若你是整个词尾漏读，重录时给出 {tailIPA} 的起始位` |
| `coda-loss` | 词尾辅音丢失 | 错误（红） | `tailScore < TAIL_LOSS` ∧ **不处于失爆上下文** | `{cur} 词尾 {tailIPA} 没发出来（美音也会发，只是很轻）` |

判定顺序：**失爆上下文优先**（该语境最高只给 `hint`），然后 `coda-loss`，最后 `link-missing`。

> ⚠️ **失爆上下文内不给红色错误**（2026-11-26 验收修正）：实测 native 朗读 "eat yet"、"get to" 时
> `/t/` 只有 49~76 分（/t/+/j/ 合流与失爆），**与“真漏读”在分数上不可区分**；把这种情况报成错误就是教错。
> 原设计"真失爆也会留起始位，不该低于 60"的假设被实测推翻（native 语料出现 49 分）。

`{combinedIPA}` 用拼接近似（`tailIPA + headIPA` 连写），属于「提示性近似」，文案中不使用「标准发音是」这类断言语气。

**去重与排序**：同一词对只产出 1 条（条件互斥 + 优先级兜底）；`pickTop()` 排序键依次为（`级别权重` 错误 3 > 建议 2 > 提示 1）→（`100 - tailScore` 降序）→（`wordIndex` 升序），只取第 1 条。

### 阈值（`linkRules.js`，初值来自 spike 实测）

```js
export const THRESHOLDS = {
  GAP_LINK: 60,   // ms；实测 90ms 时引擎已判为边界
  TAIL_LINK: 90,  // 尾音素分上限
  GAP_STOP: 80,   // ms
  TAIL_STOP: 80,
  TAIL_LOSS: 60,
}
```

阈值集中在一处导出，**标注为初值，待 30 天真实样本标定**（当前只有 TTS 美音数据，无真实学习者数据）。

### 输出结构

```js
{
  items: [{
    id: 'link-missing',      // 规则 id
    level: 'suggestion',     // error | suggestion | hint
    wordIndex: 3,            // cur 在 words[] 的索引
    pair: [3, 4],            // 相邻词对
    text: 'get out',         // 原文片段
    message: '…中文文案…',
    evidence: { gapMs: 480, tailPhone: 't', tailScore: 85, headPhone: 'aw', headScore: 99 },
  }],
  top: { /* items[0] 或 null */ },
  stats: { boundaries: 5, problematic: 2 },   // boundaries = 参与判定的词对数；problematic = items.length
}
```

## UI 规格

1. **顶部一条「优先改进」**：位于总分与五维条之间。级别决定配色（错误 rose / 建议 amber / 提示 slate）。文案后缀附证据（如「中间断了 480ms」）。点击 → 设置 `expandedWord = wordIndex` 并高亮该词对。
2. **逐词徽章**：
   - 删除现有 `连读✓/✗` 徽章（数据源 `w.liaison.ref` 恒 0）。
   - 新增三枚：`连读`（琥珀）/`吞音·正常`（灰，中性）/`尾音丢失`（红）。
   - 保留 `漏读`/`重复`/`⏸停顿`/`未收录`/`意群停顿` 现有徽章。
   - `重音`/`升降调` 徽章保留，但 title 注明「仅文本预标注时有效」（当前自动评测下 `ref` 恒 0，不会显示）。
3. **五维条**：删除「连读」维度（永远 `—`），保留 准确度/流利度/完整度/韵律。
4. **底部小字**：`可判定连读边界 {stats.boundaries} 处 · {stats.problematic} 处待改进`（真实计数，不换算成百分比、不伪装成评分维度）。
5. 无诊断结果（`items.length === 0`）时：不显示顶部建议，底部小字显示 `未发现连读/吞音问题`。

## 数据采集（dry-run）

```sql
CREATE TABLE IF NOT EXISTS shadow_eval_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  video_id TEXT,
  sub_index INTEGER,
  ref_text TEXT,
  accent TEXT,          -- 视频原始 accent 字段
  eval_accent TEXT,     -- 实际下发的 am/en/null
  overall REAL, accuracy REAL, integrity REAL,
  params TEXT,          -- 下发给 engine 的参数 JSON
  result TEXT,          -- 云端原始 JSON（已剔除 audioUrl）
  diagnosis TEXT,       -- diagnose() 输出 JSON
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shadow_eval_created ON shadow_eval_samples(created_at);
```

- `POST /api/shadow-eval/samples`，`authMiddleware`。
- 请求体：上述除 `id/created_at` 外的字段；`result` 序列化后 **> 64KB → 400**。
- **服务端强制剔除 `result.audioUrl`**（阿里云侧录音 1 个月失效，且涉及用户语音的存储合规）。
- 写入时顺带清理：`DELETE FROM shadow_eval_samples WHERE created_at < datetime('now','-30 days')`。
- 前端 fire-and-forget：`authFetch(...).catch(() => {})`，不阻塞、不弹错、不重试。

## accent 传递

`accentToEvalParam(accent)`：

| 输入 | 输出 |
|---|---|
| 匹配 `/美\|US\|USA\|America\|American/i` | `'am'` |
| 匹配 `/英\|UK\|GB\|Britain\|British/i` | `'en'` |
| 其他 / 空 / 未定义 | `null`（不传该参数，走引擎默认） |

- `VideoDetail` → `<ShadowingEvaluator accent={video.accent} …>` → `startRecord({ …, ...(evalAccent ? { accent: evalAccent } : {}) })`。
- `TextDocPage` 的跟读**不传** `accent`，保证 `text_progress` 历史最佳分前后可比。
- 由于本地 `DATA_DIR` 无数据，真实 `accent` 取值未验证 → 用宽松正则 + 不匹配不传，**待确认真实取值后收紧**。

## 错误处理

| 场景 | 处理 |
|---|---|
| `diagnose()` 抛错 | 捕获 → 返回空 items（`stats` 为 0），UI 退回现状，无任何提示 |
| `words` 为空 / 只有 1 个词 | 返回空 items |
| 音素符号未知 | `phoneIpa` 降级为原符号，文案照常展示 |
| 上报失败 / 401 / 超时 | 静默丢弃，不影响评测 |
| `result` 超过 64KB | 服务端 400；前端静默 |
| 未登录 | 评测本身已有「请先登录」逻辑；上报遇 401 静默 |

## 测试计划

**单测（`node:test`，与仓库现有模式一致）**

1. `pronunciationDiagnosis.test.js`：以 spike 的真实 raw JSON 裁为 fixture，覆盖
   - `link-missing` 命中（gap 480ms，尾音素 85）
   - `stop-elision` 命中（间隙小 + 爆破音 + 辅音开头，含极低分 45 分也只给 hint）
   - `coda-loss` 命中（非失爆上下文 + 尾音素 45）
   - `is_pause: true` 的词对**仍参与判定**（间隙 870ms → link-missing）
   - 意群边界（后词前有逗号）不报 `link-missing`
   - `dp_type≠0` / `isPause` / `fakePron` 词对全部排除
   - 单词句子、`start/end` 缺失、`phones` 为空 → 返回空 items 且不抛错
   - 同词对只出 1 条、级别优先级正确、`pickTop` 排序正确
2. `phoneIpa.test.js`：已知符号映射、别名（`ay`/`aɪ` 得同一 IPA）、未知符号降级。
3. `accentParam.test.js`：美/英/未知/空/大小写。
4. `shadowEval.test.cjs`（后端）：401、体积超限 400、`audioUrl` 被剔除、30 天清理生效。

**人工验收（本轮的成功标准）**

取 10 句真实美国博主字幕句子，各录 1 次，逐条人工判断：
**其中 ≥ 8 句的「优先改进」建议成立且唯一；不允许把「美音正常失爆」报成错误。**

样本来源优先级：用户真实录音 > TTS 美音（`en-US`）合成音频。用 TTS 时需注明：TTS 朗读过于标准，误报率会比真人低，**只能作为下限验证**；最终验收仍需真人录音。

**回归**：`npm run lint` + 全量 `node --test`。

**不动的东西**：`src/utils/aliyunResult.js` 与 `aliyunResult.test.js` 保持原样（解析层仍解析 `liaisonref` 等字段，只是 UI 不再使用）。

## 风险与未决

| 风险 | 应对 |
|---|---|
| 阈值只有 TTS 数据支撑，真实学习者数据未验证 | 30 天 dry-run 后标定；`linkRules.js` 阈值集中可改，不改逻辑 |
| 规则误报（尤其把意群停顿判成连读缺失） | 已排除「后词前有标点」的场景；后续用 `senseref=1` 做二次过滤（需样本验证后再加） |
| 引擎评分抖动 ±1~2 分 | 阈值留 10 分缓冲；单条判定不影响总分展示 |
| `accent` 切换导致分数分布变化 | 只在视频跟读传；`shadow_eval_samples` 同时记 `accent`/`eval_accent`，便于对比分布 |
| 真实 `video.accent` 取值未知 | 宽松正则 + 不匹配不传，先观察 30 天样本中的实际值 |

## 实施顺序（供下一阶段写计划）

1. `src/data/phoneIpa.js` + `linkRules.js`（纯数据）→ 单测
2. `src/utils/pronunciationDiagnosis.js` → fixture 单测（TDD）
3. `src/utils/accentParam.js` → 单测
4. `server/db.cjs` 建表 + `server/routes/shadowEval.cjs` + 挂载 → 后端单测
5. `ShadowingEvaluator.jsx` 渲染改造 + 上报调用；`VideoDetail.jsx` 传 `accent`
6. 人工验收 10 句 + `lint` + 全量测试
