# 字幕句子收藏 + 生词本编辑设计

> 日期：2026-11-08
> 状态：已确认

## 背景与目标

两个需求：

1. **字幕句子收藏**：视频页每条字幕都有收藏按钮，收藏的句子进入生词本的「句子」分类（服务端持久化，跨设备同步）。
2. **生词本可编辑**：对收藏的单词/短语/句子可添加个人笔记（限 200 字），中文释义也可修改。

现状：

- 字幕行已有 ♥ 按钮，但只是会话内本地 state（`bookmarkedIds`，按下标记录，刷新即丢），与生词本无关联。
- 生词本（`vocabulary` 表）已有完整管线：按内容去重、多来源合并、服务端同步、听练统计。类型为 word / phrase / core_phrase（听练页把 core_phrase 展示为「句子」）。
- 生词本没有任何编辑/笔记能力。

## 方案

复用现有生词本管线（方案 A）：字幕收藏直接写入 `vocabulary` 表（新增 `sentence` 类型），`core_phrase` 与 `sentence` 在展示层合并为「句子」；笔记/释义编辑通过新增 PATCH 接口完成。

### 1. 数据模型（server/db.cjs + 迁移）

- `vocabulary` 表新增 `note TEXT` 列（`ensureColumn` 迁移，老数据为 NULL）。
- `sources` JSON 来源对象新增可选字段 `startTime`（秒）：仅句子收藏时写入，用于从生词本跳回视频对应位置。
- 新增类型 `sentence`（字幕句子收藏）。已有 `core_phrase` 数据**不做迁移**，仅在展示层与 `sentence` 合并为「句子」。

### 2. 后端 API（server/routes/vocab.cjs）

- `POST /api/vocab`：类型集合 `VOCAB_TYPES` 加入 `sentence`。句子条目：content=英文原句、translation=中文译文（textCn）、来源带 startTime。
- 新增 `PATCH /api/vocab/:word`：body `{ note, translation }` 更新释义/笔记。笔记上限 200 字、释义上限 300 字，超限返回 400。`toEntry` 补返回 `note`。
- 扩展 `DELETE /api/vocab/:word` 支持 `?videoId=xxx`：仅移除该来源；条目再无来源则删除整条。不带参数时保持现有「整条删除」行为（生词本页移除按钮沿用）。

### 3. 视频页字幕收藏（src/pages/VideoDetail.jsx）

- 删除 `bookmarkedIds` 本地 state；♥ 状态从 `vocabulary` 派生：该句英文的规范化 key 存在（**不限定类型**，如该句恰好已作为核心短语存在同样算已收藏）且 `sources` 含本视频 id。
- 点 ♥：游客 → toast「登录后才能收藏句子」；未收藏 → `POST /vocab`（type=sentence + startTime）；已收藏 → `DELETE /vocab/:key?videoId=当前视频`（按来源移除）。
- 桌面与手机两处 transcript 的 ♥ 按钮都接入，复用 `vocabBusy` 忙碌态防重复点击。
- 新增 `?t=<秒>` 深链：进入视频页后 seek 到该时间（配合生词本来源跳转）；有 `?t=` 时跳过进度续播。

### 4. 生词本（src/pages/LearningRecords.jsx + src/utils/vocabulary.js）

- 分类 tab 改为 **全部 / 单词 / 短语 / 句子**；「句子」= core_phrase + sentence，类型徽章统一显示「句子」。
- 每个卡片加「编辑」按钮 → 展开内联编辑区：释义输入框（300 字上限）+ 笔记 textarea（maxLength=200，实时「x/200」计数）+ 保存/取消。保存调 PATCH，成功后更新本地列表。
- 已有笔记的卡片在释义下方以便签样式展示笔记。
- 句子条目的「来源视频」点击 → `/video/<id>?t=<startTime>` 直接跳到该句；无 startTime 的旧数据仍走词卡深链（`?card=1&word=...`）。

### 5. 听练适配（src/utils/vocabPractice.js / src/pages/VocabPracticePage.jsx）

- 「句子」练习类型：统计与队列同时包含 `core_phrase` 和 `sentence`；标签统一「句子」。
- `summarizePracticeByType` 与 `buildPracticeQueue` 相应归并。

### 6. 边界与错误处理

- 同一句英文出现在多个视频：合并来源；在视频 A 取消收藏只移除 A 的来源，条目仍保留其他来源；再无来源则删除条目。
- 字幕句子收藏不限制句长（与现有规范化去重 key 逻辑一致）。
- PATCH 超字数 → 服务端 400 + toast「笔记不能超过 200 字」。
- 编辑保存失败 → toast 提示，表单内容保留不丢失。
- 游客点 ♥ → toast 引导登录，不发请求。

### 7. 测试

- `server/routes/vocab.test.cjs`：sentence 类型收藏、去重合并来源、按 videoId 移除来源、无来源后删除、PATCH 更新笔记与释义、字数上限。
- `src/utils/vocabulary.js`：句子分类归并辅助函数单测。
- 手动验证清单：桌面+手机端收藏 → 生词本出现 → 来源跳转 → 编辑笔记/释义 → 听练句子队列包含新句子。

## 不在本次范围

- 句子收藏的本地离线缓存（游客不可收藏，与生词本整体登录制一致）。
- 编辑词条内容本身（content 是去重 key，不可改）。
- 笔记的富文本/图片/标签。
