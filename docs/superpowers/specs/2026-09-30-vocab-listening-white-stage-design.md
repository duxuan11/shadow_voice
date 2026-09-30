# 生词听练「白底舞台 + 中文常显」设计文档

日期：2026-09-30
分支：feat/vocab-listening-practice
状态：待实现
关联：
- `2026-09-30-vocab-listening-practice-design.md`（听练一体基础）
- `2026-09-30-vocab-listening-interaction-polish-design.md`（B 档交互）
- `2026-09-30-vocab-listening-dark-stage-design.md`（A 档深色舞台，本次**废弃其深色主题**）

## 背景与目标

深色舞台方向不符合预期。本次改为：

1. **白底 + 项目配色**：背景纯白，控件颜色沿用项目靛蓝/蓝/紫，与全站一致。
2. **结构进一步靠拢参考站**：居中舞台大卡、右上角图标组、顶部工具条、主体垂直居中、两栏完成页、手机端顶部条。
3. **中文常显**：不再用「显示中文」开关，中文释义**直接居中显示**；并解决“许多收藏单词没有中文”的数据问题（离线兜底）。

**仅借鉴参考站的交互与布局思路，不复制其代码、样式表、类名或文案。**

## 范围

**改**
- 听练页视觉与结构：`src/pages/VocabPracticePage.jsx`、`src/index.css`
- 中文常显与兜底：同上 + `src/pages/LearningRecords.jsx`、`src/pages/Profile.jsx`
- 收藏时记录句子中文：`src/pages/VideoDetail.jsx`
- 离线中文数据：`server/db.cjs`、`server/routes/vocab.cjs`、新增 `server/lib/vocabContext.cjs`、`server/index.cjs`
- 快捷键说明：`src/utils/vocabShortcuts.js`(±)、`README.md`

**不改 / 不做**
- 视频听写页 `DictationPage.jsx`、`spellCheck.js`、槽位判定纯函数 `spellSlots.js`
- 统计口径（首次提交计入、熟练度公式）、连击规则
- AI 翻译、音效、新依赖

## 视觉设计（白底 + 项目配色）

### 设计令牌（沿用项目色）

```
--vp-bg:        #ffffff        页面背景（纯白）
--vp-ink:       #1e293b        主文字
--vp-ink-soft:  #64748b        次要文字
--vp-primary:   #4f46e5        靛蓝主色
--vp-accent:    #2563eb        蓝（聚焦/播放）
--vp-violet:    #7c3aed        强调（进度/CTA）
--vp-line:      #e8ecf7        边框/分隔
--vp-card:      #ffffff        卡片
--vp-shadow:    0 20px 50px rgba(40, 58, 110, 0.12)
```

### 舞台与卡片

- 页面纯白，内容水平居中；舞台宽 `min(860px, calc(100vw - 32px))`。
- 卡片：白底、圆角 `28px`、边框 `1px solid var(--vp-line)`、阴影 `--vp-shadow`、
  `min-height ≈ 520px`、内边距 `28px 40px 24px`（手机 `20px 16px`）。
- 主体在卡片内**垂直居中**（`flex: 1; justify-content: center`，`min-height ≈ 340px`）。
- 动效弱化：卡片仅轻微淡入（`opacity + translateY(10px)`，~0.28s）；
  `prefers-reduced-motion` 关闭。不做 3D 透视、不做卡后光晕。

### 顶部与角落

- 顶部工具条：左侧类型标签（单词/短语/句子），右侧进度文字 + 细渐变进度条
  （`--vp-primary → --vp-violet`）。
- 右上角**图标按钮组**（36–44px、圆角 12、白底描边、`touch-action: manipulation`）：
  1. **再听一次**（播放态变青/蓝）
  2. **快捷键帮助**
  3. **退出**（返回个人中心）
  （「显示中文」按钮**移除**——中文常显。）

### 完成页（两栏）

- 桌面两栏 `grid-template-columns: 1.02fr .98fr`，手机单栏。
- 左：标题 + 统计卡网格（已练 / 正确 / 正确率 / 最长连击）。
- 右：反馈文案 + 本轮总结 + 主/次 CTA（`再来一轮` / `返回个人中心`）。
- 手机：单栏、统计卡纵向、CTA 全宽、底部安全区 `env(safe-area-inset-bottom)`。

## 中文显示（常显、居中）

- 位置：拼写槽位上方，**水平居中**、字号约 `15–16px`、`--vp-ink-soft`。
- 内容来源优先级：
  1. `translation`（词义）→ 直接显示；
  2. 否则 `context_cn`（该词所在句子的中文）→ 显示并前置小标签「例句」；
  3. 都没有 → 显示「暂无中文释义」。
- 不再有开关；`showChinese` 状态、对应按钮、以及快捷键 `Ctrl+H`（toggleChinese）一并移除。
- 长句中文允许换行，`overflow-wrap: anywhere`。

## 离线中文数据

### 数据列

`vocabulary` 表新增 `context_cn TEXT`（沿用 `ensureColumn` 迁移，幂等回填为 NULL）。

### 收藏时记录

- 字幕点词收藏 `pushToVocab(word, sentenceCn)`：把该词所在句子的 `textCn` 作为
  `contextCn` 提交，`POST /api/vocab` 接受并存储。
- 收藏弹窗展示的释义同样优先用该句中文兜底（不再只依赖内置 `SYNONYMS`）。

### 旧数据回填（离线，启动时一次）

- 新增 `server/lib/vocabContext.cjs`：
  - `findContextCn(word, subtitles) -> string`（纯函数：在字幕里找首个英文字幕包含该词
    （大小写不敏感、按词边界）的条目，返回其 `textCn`）。
  - `backfillVocabContext()`：读取 `DATA_DIR/consolidated.json`（videoId → `episode_dir`）
    与各视频 `subtitles.json`，为 `translation` 为空且 `context_cn` 为空的生词行补写
    `context_cn`。幂等，只补缺失；找不到则跳过。
- `server/index.cjs` 启动时（`getDb()` 之后）调用一次，失败只记日志、不阻塞启动。

### API

- `toEntry` 增加返回 `context_cn`（空则为 `''`）。
- `POST /api/vocab` 接受 `contextCn`；命中已有条目时**不覆盖**已存在的 `context_cn`
  （与现有 translation/phonetic 的“补齐不覆盖”一致）。

## 交互

- 右上角图标组承载：再听 / 帮助 / 退出（中文常显，无按钮）。
- 槽位输入保持现状：`空格`/`→` 下一词、`←`/空槽退格回上一词、最后一词 `Enter` 提交、
  粘贴按空格分配到各槽；提交后槽位直接着色（正确绿 / 错误红+正确词 / 遗漏黄虚线）。
- 快捷键（更新后）：`空格`/`→` 下一词、`Enter` 下一词/提交、`Tab` 显示答案、
  `Ctrl/⌘+Space`/`Alt+R` 再听、`1/3/4` 再听/再练/下一题、`←` 上一题、`?` 帮助、`Esc` 返回。
  **移除** `Ctrl+H`（显示/隐藏中文）。
- `src/utils/vocabShortcuts.js`：从 `SHORTCUT_GROUPS` 删除 `Ctrl/⌘+H` 行；
  `resolveShortcut` 删除 `toggleChinese` 分支与其测试；帮助面板同步。

## 移动端

- 单列；卡片内边距与字号自适应；槽位自动换行；右上角图标 ≥44px。
- 完成页单列、CTA 全宽、底部安全区；不依赖 hover。
- 中文常显，长句换行不溢出。

## 测试与验证

- `server/routes/vocab.test.cjs` 增补：`POST` 存 `contextCn`、不覆盖已有值；
  `GET` 返回 `context_cn`。
- 新增 `server/lib/vocabContext.test.cjs`：`findContextCn` 命中/未命中/大小写/短语。
- `src/utils/vocabShortcuts.test.js`：移除 `Ctrl+H` 相关断言，保持其余通过。
- 回归：`node --test "src/utils/*.test.js"`、`node --test "server/**/*.test.cjs"`、
  `node --test scripts/copy-data.test.mjs` 全绿；`npm run lint` 0 error；`npm run build` 成功。
- 无浏览器环境：舞台/角落图标/两栏完成页/手机端走手动冒烟清单。

## 改动文件清单

**新增**
- `server/lib/vocabContext.cjs`、`server/lib/vocabContext.test.cjs`

**修改**
- `server/db.cjs`、`server/routes/vocab.cjs`、`server/routes/vocab.test.cjs`、`server/index.cjs`
- `src/pages/VocabPracticePage.jsx`、`src/index.css`
- `src/pages/VideoDetail.jsx`、`src/pages/LearningRecords.jsx`、`src/pages/Profile.jsx`
- `src/utils/vocabShortcuts.js`、`src/utils/vocabShortcuts.test.js`
- `README.md`

## 自查记录

- 参考站仅用于理解交互与布局；配色、令牌、类名、尺寸均为本项目自定，未复制其代码或样式表。
- 与既有约束一致：不改视频听写页、不改统计口径、无新依赖、无音效、≥44px、reduced-motion。
- 已知取舍：中文常显会降低听写难度（用户明确要求）；`context_cn` 是“句子中文”语境，
  非严格词义，UI 以「例句」标签区分。
