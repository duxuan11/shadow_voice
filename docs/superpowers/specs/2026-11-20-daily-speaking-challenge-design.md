# 设计文档 — Daily Speaking Challenge（每日口语挑战）

> 日期：2026-11-20 ｜ 项目：shadow_voice ｜ 分支：feat/daily-speaking-challenge（自 main 新建）
> 状态：设计待批准（未开工）

---

## 1. 背景与目标

### 1.1 一句话

> 以用户正在看的那个视频为素材，AI 生成一套五步主动口语挑战：
> 复述观点 → 激活语块 → 情境转换 → 话题连续表达 → 与 AI 就话题聊 5–8 轮，
> 每步给反馈，最后出一份学习报告，把「视频里的语言」变成「自己能说的话」。

### 1.2 为什么做

现有练习偏「重复原文」：跟读、听写、拼写、中译英逐句都要求贴近视频原句。
学习者能背出原句，却常常说不出自己的话。中译英对话（dialogue）虽是主动输出，
但它是「一句中文 → 一句英文」的碎片训练，缺复述、缺语块迁移、缺连续表达。

**成功标准**：完成一次挑战后，用户能不看字幕说出视频的主要观点，
能自主用上至少 2–3 个视频里的语块，并有一段 ≥60 秒的连续英文表达。

### 1.3 与现有功能的关系

| 已有能力 | 位置 | 本功能怎么用 |
|---|---|---|
| 视频索引 / 字幕 | `server/lib/videoData.cjs`（`findVideo` / `loadSubtitles`） | 生成挑战的唯一事实来源 |
| AI 调用 | `server/services/ai/provider.cjs`（`chat` / `extractJson` / `isConfigured` / `AI_MODEL`） | 零新依赖 |
| 视频主题 / 表达提取 | `server/services/ai/conversation.cjs`（`extractConversationTopics` / `extractSceneProfile`）与 `ai_cache`（`topics-v1` / `scene-v1`） | Chunk 兜底池（证据来自字幕） |
| 「整组一次生成 + 归一化 + 不合格重试」范式 | `server/routes/dialogue.cjs` + `services/ai/dialogue.cjs` | 生成/评分/进度/重练的写法照搬 |
| 单句评分容错 | `server/services/ai/speak.cjs` 的 `parseReview` | 复用分数钳制与字段容错 |
| 语音输入 | `src/utils/useSpeechInput.js`（阿里云 ASR → Web Speech → 手打兜底） | 每题作答 |
| 英语播放 | `src/utils/tts.js` 的 `createSpeaker` + `/api/tts` | 「听 AI 说」反馈语音 |
| 数据表迁移 | `server/db.cjs`（`CREATE TABLE IF NOT EXISTS` / `ensureColumn`） | 新增三张表 |
| 页面视觉语言 | `src/pages/DialoguePage.jsx`、`TextDocPage.jsx`（Tailwind + lucide） | 步骤式卡片布局沿用同一套 |

**明确不做**：不改 `video_*` / `vocabulary` / `dictation_records` / `practice_records` /
`dialogue_*` / `text_*` / 生词本 / 视频详情页主结构；不做发音评测（自由表达无参考文本）；
不做 AI 教师问答式闲聊（只围绕本视频主题）。

### 1.4 与其它入口的区别

| | 跟读 | 中译英对话 | 自由表达·看中文说英文 | **每日口语挑战（本功能）** |
|---|---|---|---|---|
| 输入 | 视频原句 | AI 生成的连贯中文对话 | 预置中文句库 | **AI 依据本视频生成的五步任务** |
| 输出要求 | 贴近原句 | 一句对一句 | 一句对一句 | **复述 / 造句 / 转换 / 60–120 秒连续表达 / 多轮对话** |
| 反馈 | 发音分 | 单句评分 | 单句评分 | **每步结构化反馈 + 最终报告 + Chunk 掌握状态** |
| 进度 | `video_progress` | `dialogue_progress` | 本地 | **`speaking_challenge_progress`（独立）** |

---

## 2. 产品定义

### 2.1 用户已确认的决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 多轮对话（ConversationPage）怎么处理 | **B：彻底下线** —— 页面、路由、API、学习记录里的「AI 对话」区块全部移除 |
| 2 | 生成策略 | 一次 AI 调用生成整套静态内容，「重新生成」= `variant + 1` |
| 3 | 五步内容是否合并评分 | Step 2 / Step 3 **整步提交一次评分**（5 项一起交、一次调用拿回 5 条反馈） |
| 4 | 入口位置 | 视频详情页「AI 对话」下拉里的第一项（原「💬 多轮对话」位置） |

### 2.2 我做的决定（评审时可推翻）

| # | 决定 | 理由 |
|---|---|---|
| D1 | 旧 `conversation_sessions` / `conversation_messages` **表和数据保留，不删** | 删表有数据风险、零收益；只摘代码路径 |
| D2 | `server/services/ai/conversation.cjs` **保留**（只被 Chunk 兜底用到），只删 `routes/conversation.cjs` | 复用 `extractConversationTopics` / `localDetectScene`，不重复写提取器 |
| D3 | 新路由 `/video/:id/challenge`，新 API 前缀 `/api/challenge` | 与 `/dialogue`、`/speak` 同级，语义直白 |
| D4 | 「原始视频链接」= **回看视频详情页 `/video/:id`** | 全部 12 个视频 `video_url` 均为 null，只有本地 mp4；详情页即原始出处 |
| D5 | 每步作答**先落库再求反馈** | AI 不可用时用户答案不丢，`feedback = null` 可重试 |
| D6 | 无字幕视频 → 生成返回 503 | 遵守「不得凭空编造」；当前 12 个视频全有字幕，实际不触发 |
| D7 | 流利度只做**可测量**的事 | ASR 无时间戳，不伪造发音/流利度分数 |
| D8 | 学段难度沿用 `video.level`（初级/中级/高级）影响任务难度，不单独让用户选 | 与 dialogue 的默认难度语义一致 |
| D9 | **60 秒分段录音改共享音频栈**（用户批准方案 A）：`pcmRecorder.stop({ keepStream: true })` + `aliyunAsr` / `useSpeechInput` 透传 `onSegmentEnd` 可选参数，**默认路径行为完全不变** | 说话到 60 秒静默切段、麦克风不断，`segments` 才是真实停顿；DialoguePage / TextDocPage 零影响 |
| D10 | Chunk 兜底池改为**纯本地** `localExtractTopics`（零网络零 AI），`ai_cache` 有就优先用 | 唯一写 `ai_cache` 的就是被删的 conversation 路由；兜底不能依赖一个没人写、12 个视频只有 1 条命中的缓存 |
| D11 | 报告的三堆是 `finish` 时刻的**快照**，写进 `report_json`；`chunk_mastery` 是**视频级**跨挑战状态，`/restart` 不动它 | 重练同一套不该显示上一轮的成绩，旧 variant 的历史也不该被新成绩污染 |
| D12 | Step 2 每张卡两个输入：`{ index, chunkText, sentence }`，可只填其一；反馈分别判「语块还原」与「造句自然度」 | 「先说出语块 + 再造句」是这步的教学目的，合并成一个输入会丢掉一半信号 |
| D13 | 「英文隐藏」只做在 UI 层：`GET` 返回完整 `challenge_json`（与 dialogue 返回参考英文一致），**不新增 reveal 端点**；反馈文案不复述英文答案 | 不增加接口与状态机，防作弊强度与现有页面一致 |
| D14 | Step 4 完全没识别到文字时，允许只凭「时长 ≥ 5 秒」提交：只记本地统计、不调 AI、`feedback = null` | 一次识别失败不能卡死流程；但也不能因此伪造一段点评 |

### 2.3 五步定义

| 步 | 名称 | 内容（AI 生成） | 用户要做 | 反馈重点 |
|---|---|---|---|---|
| 1 | **Video Recall** | 3 个关于视频内容的问题（英文 + 中文） | 不看字幕，口头回答（每题 ≤60 秒 × 可多段）或打字 | 是否覆盖视频观点（对照字幕）、语法、地道度 |
| 2 | **Chunk Activation** | 5 个语块：中文释义 + 出处字幕 + 造句提示，**英文隐藏** | 每题先「说出英文语块」，再用它造一句自己的话 | 语块还原度、造句是否自然、Chunk 使用判定 |
| 3 | **Sentence Transformation** | 5 个中文情境（含 1 个目标语块，但不许照抄原句） | 用英语表达该情境 | 是否传达情境、是否用上目标语块、语法/地道 |
| 4 | **Topic Speaking** | 1 个开放话题 + 3 个要点提示 + 目标时长 | 连续说 60–120 秒（分段录音自动累加） | 用了哪些语块、词汇丰富度、连贯性、语速/停顿 |
| 5 | **AI Conversation** | 无（开场白由 AI 依据话题即时生成） | 与 AI 就话题聊 5–8 轮 | 追问响应、Chunk 自发复用、语法/地道 |

每步完成后展示反馈卡片；用户可「重说这一题」（Step 1/2/3 单题重试）或「再练一次这一步」。
全部五步完成后生成**最终报告**。

### 2.4 页面结构（文字草图）

```
┌──────────────────────────────────────────────────────────────┐
│ ← 返回视频    出国旅行的日常   [初级]        [历史] [重新生成] │
│ ┌────────┐ 已完成 1/5 · 本套挑战 #2                           │
│ │缩略图  │ ▸ 打开原视频回看                                     │
│ └────────┘                                                   │
├──────────────────────────────────────────────────────────────┤
│ ① Recall ✓  ② Chunk ●  ③ Transform ○  ④ Topic ○  ⑤ Chat ○    │
├──────────────────────────────────────────────────────────────┤
│ 第 2 步 · Chunk Activation                    进度 2/5        │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 1. 「结果（发现）……」          [🎤 说英文] [看答案]      │ │
│ │    ______________________________                        │ │
│ │    用它造句：____________________________________        │ │
│ └──────────────────────────────────────────────────────────┘ │
│ …… 共 5 张卡                                                │
│ [ 提交这一步，看反馈 ]  （AI 未配置时按钮禁用 + 提示）        │
├──────────────────────────────────────────────────────────────┤
│ 反馈：语块还原 3/5 · 造句自然 4/5                             │
│ ✗ 语法：I very like it → I really like it（very 不能修饰动词）│
│ ✓ 用了 it turns out that… 然而语气偏书面                      │
│ [🔊 听地道说法] [重说这一题]                                  │
└──────────────────────────────────────────────────────────────┘
```

完成后的报告卡：

```
┌ 本次学习报告 ───────────────────────────────┐
│ 综合 82 分 · 连续表达 78 秒 · 语速 96 wpm    │
│ ✅ 已掌握（3）：it turns out that… / …       │
│ 🟡 能自主使用（2）：…                        │
│ 🔁 需要复习（2）：…（附中文提示）             │
│ 💡 下次建议：…（AI 生成 2–3 条）              │
│ [再练一次] [换一套新挑战] [看历史]            │
└──────────────────────────────────────────────┘
```

---

## 3. 数据模型（`server/db.cjs` 三张新表）

```sql
CREATE TABLE IF NOT EXISTS speaking_challenges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id       TEXT NOT NULL,
  variant        INTEGER NOT NULL DEFAULT 1,
  challenge_json TEXT NOT NULL,
  model          TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, video_id, variant)
);

CREATE TABLE IF NOT EXISTS speaking_challenge_progress (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL UNIQUE REFERENCES speaking_challenges(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cursor       INTEGER NOT NULL DEFAULT 0,       -- 0..4 当前步；5 = 五步走完待出报告
  status       TEXT NOT NULL DEFAULT 'active',    -- active | completed
  steps_json   TEXT NOT NULL DEFAULT '[]',        -- 五步作答 + 反馈
  report_json  TEXT,                              -- 最终报告
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunk_mastery (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL,
  chunk_key   TEXT NOT NULL,                      -- 归一化英文，去重用
  chunk_en    TEXT NOT NULL,
  chunk_cn    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'introduced', -- introduced|activated|mastered|review
  uses_count  INTEGER NOT NULL DEFAULT 0,           -- = used_steps 的长度
  used_steps  TEXT NOT NULL DEFAULT '[]',           -- 成功使用过它的训练步编号（去重，防重复提交虚增）
  last_score  INTEGER,
  updated_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, video_id, chunk_key)
);
```

> 与 `text_progress` 同款注意：本库未开 `PRAGMA foreign_keys`，CASCADE 不生效。
> 挑战不提供删除功能，因此无需显式级联删除。

### 3.1 `challenge_json`

```json
{
  "version": 1,
  "title": "酒店入住 · 主动输出挑战",
  "topicEn": "traveling abroad and staying in a hotel",
  "topicCn": "出国旅行与酒店入住",
  "source": "subtitle",
  "recall": [
    { "id": 0, "qEn": "What does the traveler need at the front desk?", "qCn": "旅行者在前台需要做什么？", "focusCn": "办理入住 / 取房卡" }
  ],
  "chunks": [
    {
      "id": 0,
      "en": "check in",
      "cn": "办理入住",
      "evidence": "We'd like to check in, please.",
      "usageCn": "说说你最近一次办入住/值机的经历"
    }
  ],
  "transformations": [
    { "id": 0, "situationCn": "你到酒店时房间还没准备好，想请前台先帮你寄存行李。", "targetChunkId": 0, "hintCn": "先说明来意，再提要求" }
  ],
  "topicSpeaking": {
    "promptEn": "Describe a time when a small travel problem turned out fine.",
    "promptCn": "讲一次旅行中的小麻烦最后顺利解决的经历。",
    "pointsCn": ["发生了什么", "你当时怎么处理", "结果和感受"],
    "targetSeconds": 90
  }
}
```

约束（归一化时强制）：`recall` 恰好 3 条、`chunks` 恰好 5 条、`transformations` 恰好 5 条、
`topicSpeaking` 必须存在；任何一条缺 `en`/`cn` 直接丢弃；丢弃后数量不足 → 判定生成失败。

### 3.2 `steps_json`（长度 5，index 0..4）

```json
[
  {
    "step": 1,
    "status": "completed",
    "answers": [
      { "index": 0, "text": "...", "durationMs": 42000, "segments": 2, "source": "asr" }
    ],
    "feedback": {
      "score": 78,
      "items": [
        { "index": 0, "covered": ["办理入住"], "missing": ["房卡押金"], "grammar": [{ "original": "...", "better": "...", "reason": "..." }], "naturalness": [], "comment": "..." }
      ],
      "chunkUsage": [{ "chunkId": 0, "used": true, "quality": "good", "evidence": "..." }],
      "vocabulary": { "level": "偏基础", "suggestions": ["put down a deposit", "hold my bags"] },
      "coherence": { "summary": "...", "fillers": ["uh", "like"] },
      "praise": "..."
    },
    "updatedAt": "2026-11-20T10:00:00.000Z"
  }
]
```

- Step 2 的 `answers` 每项是 `{ index, chunkText, sentence, durationMs, segments }`：
  `chunkText` = 用户说/打出的英文语块，`sentence` = 造句；两者都可单独为空，但不能同时为空。
- Step 3 的 `answers` 每项是 `{ index, text }`；Step 4 是 `{ index: 0, text, durationMs, segments }`。
- `status`：`empty`（未开始）| `answered`（已提交但 AI 反馈缺失/失败）| `completed`（含反馈）
- Step 5 的 `answers` 是消息数组 `{ role: 'ai'|'user', text, durationMs?, segments? }`，`feedback` 为收尾点评。

### 3.3 `report_json`

```json
{
  "score": 82,
  "summary": "中文 2–3 句总评",
  "mastered": [{ "chunkId": 0, "en": "check in", "cn": "办理入住", "evidence": "..." }],
  "selfUsed": [{ "chunkId": 2, "en": "it turns out that…", "cn": "结果……" }],
  "review": [{ "chunkId": 1, "en": "hold my bags", "cn": "帮我存包", "whyCn": "造句时漏了 hold" }],
  "introduced": [{ "chunkId": 4, "en": "in the end", "cn": "最终" }],
  "speaking": { "longestSeconds": 78, "totalSeconds": 214, "wpm": 96, "segments": 6 },
  "nextSuggestions": ["下次先列 3 个要点再说，减少 um", "复习 hold / keep 的区别"],
  "generatedAt": "2026-11-20T10:20:00.000Z",
  "aiFallback": false
}
```

`speaking` 全部由服务端从 `answers` 的 `durationMs` / `segments` / 词数**本地计算**，不调 AI、不编造。

- `longestSeconds` = **单次尝试内各段时长之和**的最大值（不是单段最大值）；
  重录过 Step 4 就取各次尝试的最大值。`wpm` = 总词数 / 累计说话时长（不含两次尝试之间的空白）。
- `mastered / selfUsed / review` 是 `finish` 时刻从 `chunk_mastery` 取的**快照**（D11），
  此后 `chunk_mastery` 再变化也不回写到旧报告。仍处于 `introduced` 的语块不进任何一堆，
  前端在报告里单独列为「本次新引入」。

---

## 4. AI 服务层（`server/services/ai/challenge.cjs`，新文件）

写法照搬 `dialogue.cjs`：prompt 构建与输出归一化是纯函数，网络调用在路由层；
**归一化永不 throw**，只返回 `{ ok: false, reason }`。

### 4.1 生成（`buildChallengePrompt` / `normalizeChallenge`）

输入：`videoTitle` / `description` / `topic` / `topics` / `videoLevel` / `segments`（最多 120 行）/ `variant` / `avoid`。

`avoid` 来自该用户该视频**最近 2 套**挑战的 `chunks[].en`、`transformations[].situationCn`、
`recall[].qEn`（各截断到 300 字符），prompt 里明确「不要重复下列已用过的内容」——
这是「同一视频多次生成不同挑战」的主要机制（另用 `variant` 提高 temperature 起点）。

Prompt 关键约束（写进 system）：
- 全部依据给定字幕；`evidence` 必须是字幕里真实出现的句子片段（原样引用）。
- 语块 2–6 词、口语高频、可迁移；中文释义写学习者看得懂的短句。
- 情境题 5 条各不相同，必须能用英语表达，不能是原句翻译。
- 话题要能从视频主题自然延伸，能讲 60–120 秒。
- 只输出一个 JSON 对象，无 Markdown、无解释。

`normalizeChallenge(raw, { hasSubtitles, segmentsText })`：
1. 逐项清洗、按 3/5/5 截断或补足判定（不足即 `ok:false`）。
2. **字幕取证**：`evidence` 归一化后必须能在字幕全文里找到；找不到则该 chunk 视为未取证。
3. 取证通过的 chunk < 3 → `ok:false`（路由重试一次；第二次仍不足则用兜底池）。
4. **兜底池**（不调 AI，D10）：① 读 `ai_cache` 的 `topics-v1` 的 `phrases` / `collocations`（有就用）；
   ② 调 `conversation.cjs` 里现成的 `localExtractTopics(segments)` 拿规则匹配短语 + 高频实词；
   ③ 仍不足则从字幕按词频补高频实词。补满 5 条即止；`source: "cache" | "local"`。
   兜底出来的每条 `en` 同样要过第 2 步的字幕取证。
5. 兜底后仍 < 5 → 路由返回 503「无法从该视频提取足够的语块」，不落库。

### 4.2 分步反馈（`buildStepFeedbackPrompt` / `normalizeStepFeedback`）

一个 system prompt，按 `step` 切换评价重点（prompt 里带：视频字幕摘要、该步任务原文、用户作答）。
Step 1 额外给 3 个问题的 `focusCn`；Step 2 额外给 5 个 chunk 的 `en`/`cn`；
Step 3 给 5 个情境 + 目标语块；Step 4 给话题 + 要点 + 本地统计（秒数/词数/段数）。

统一输出结构（缺少的字段按空处理，分数钳制 0–100，复刻 `speak.cjs:parseReview` 的容错思路）：

```json
{
  "score": 80,
  "items": [{ "index": 0, "comment": "...", "grammar": [], "naturalness": [], "better": "..." }],
  "chunkUsage": [{ "chunkId": 0, "used": true, "quality": "good|partial|wrong", "evidence": "..." }],
  "vocabulary": { "level": "...", "suggestions": ["..."] },
  "coherence": { "summary": "...", "fillers": ["um"] },
  "praise": "..."
}
```

- **不直接展示标准答案**：`better` 只是「优化版」，且 Step 1/2/3 里用户没作答的项不倒填答案。
- Step 2 的反馈文案**不复述英文答案**（D13）：说错的只写「这个语块没说出来 / 少了 hold」，
  英文原文由前端在「提交后」自己显示（`challenge_json` 里本来就有）。

### 4.3 对话轮次（`buildChatTurnPrompt` / `normalizeChatTurn`）

system：以视频话题为背景的对话伙伴；每次 1–2 句；先用一句话回应再说，然后提一个追问；
自然带出 1 个目标语块；不纠错、不翻译、不出戏。
输出 `{"reply": "..."}`（解析失败直接用文本）。

### 4.4 收尾 + 报告（`buildFinishPrompt` / `normalizeReport`）

一次调用同时产出「第 5 步反馈」和「最终报告」。输入：五步 feedback 摘要、对话全文、本地统计。
输出：

```json
{
  "chatFeedback": { "score": 80, "items": [], "chunkUsage": [], "coherence": {}, "praise": "" },
  "report": { "score": 82, "summary": "...", "masteredChunkIds": [], "selfUsedChunkIds": [], "reviewChunkIds": [], "nextSuggestions": [] }
}
```

归一化后与本地计算的 `speaking` 统计合并；AI 缺失时整段返回 `ok:false`，路由 503（不编造报告）。

---

## 5. API（`server/routes/challenge.cjs`，挂载 `/api/challenge`）

| 方法 | 路径 | 说明 | 模型调用 |
|---|---|---|---|
| GET | `/:videoId?variant=N` | 该用户该视频的挑战 + 进度 + 历史列表 + 该视频 chunk 掌握状态；`variant` 省略则取最新一套（历史抽屉用它回看旧版本） | 0 |
| POST | `/:videoId/generate` | 生成新挑战（`variant+1`），建进度行，写 `chunk_mastery` 初始行 | 1–2 |
| POST | `/:challengeId/step/:step` | 提交第 1–4 步作答 → 反馈；先落库再调 AI | 1 |
| POST | `/:challengeId/chat` | 第 5 步：首调返回开场白，之后传 `{text}` 返回 `{reply}` | 1/轮 |
| POST | `/:challengeId/finish` | 收尾：第 5 步反馈 + 最终报告 + `status='completed'` | 1 |
| PUT | `/:challengeId/progress` | 推进 `cursor`（0–5）/ 状态（恢复用） | 0 |
| POST | `/:challengeId/restart` | 同一套挑战重练：清 `steps_json`/`report_json`/`cursor`，不动 `challenge_json` | 0 |

### 5.1 校验与边界

- 未登录 401（`authMiddleware`）；非本人 `challenge_id` → 403；不存在 → 404。
- `videoId` 不存在 → 404；无字幕 → 503「该视频没有字幕，暂不支持生成口语挑战」。
- `step` 必须是 1–4（第 5 步走 `/chat` + `/finish`），否则 400。
- 作答为空/全空白 → 400。单条文本截断 2000 字符；`durationMs` 钳制 0–600000；`segments` 钳制 0–20。
- `finish` 要求步骤 1–4 全部 `status === 'completed'`，否则 400「还有未完成的训练环节」。
- Step 2 允许 `chunkText` 与 `sentence` 只有一个非空；两个都空 → 400。
- **Step 4 特例（D14）**：`text` 为空但 `durationMs ≥ 5000` 时接受提交，
  写 `status='answered'`、`feedback=null`、`note='未识别到语音内容，只记录时长'`，**不调 AI**、不返回分数；
  前端显示本地统计 + 「重录」。`durationMs < 5000` 且 `text` 为空 → 400。
- 未配置 AI（`isConfigured()=false`）：`generate`、`step`、`chat`、`finish` 全部 503；
  `GET` 返回 `aiConfigured:false`，前端显示横幅并禁用按钮。
- AI 调用失败：`step` 已把 `answers` 写库、`feedback=null`、`status='answered'`，
  返回 503 + `{ hasAnswers: true }`，用户可稍后点「重试反馈」。
- 生成失败（2 次不合格/调用异常）→ 503，**不落任何库**（同 dialogue 的语义）。
- `variant` 冲突（并发）→ 读 MAX(variant)+1 重试 1 次，复刻 dialogue 写法。

### 5.2 Chunk 掌握状态更新（服务端确定性逻辑，`server/lib/chunkMastery.cjs`）

| 事件 | 状态迁移 |
|---|---|
| 生成挑战 | 该套 5 个 chunk upsert 为 `introduced`（已存在则只更新 `chunk_en/chunk_cn`，不回退状态） |
| Step 2 反馈 `quality='good'` | → `activated`，`uses_count+1` |
| Step 2 反馈 `quality in ('partial','wrong')` | → `review` |
| Step 3 反馈 `quality='good'` | → `activated`（`review` 也升回 `activated`） |
| Step 4/5 反馈 `used=true && quality='good'` | → `mastered` |
| Step 4/5 反馈 `used=false` | 状态不变（没用到不算错） |

报告里的三堆分类在 `finish` 时由 `chunk_mastery` 读一次并**冻结进 `report_json`**（D11）：`mastered` → 已掌握；`activated` → 能自主使用；`review` → 需要复习；`introduced` → 「本次新引入」。
AI 返回的 `masteredChunkIds` 只做**补集提示**（写进 `nextSuggestions`），不覆盖确定性状态。

`/restart` 只清 `steps_json` / `report_json` / `cursor`，**不回退 `chunk_mastery`**（掌握程度属于视频级长期状态）。

---

## 6. 前端

### 6.1 路由与入口

- `src/main.jsx`：新增 `<Route path="video/:id/challenge" element={<SpeakingChallengePage />} />`。
- `src/pages/VideoDetail.jsx`：下拉第一项由「💬 多轮对话」替换为「🎯 每日口语挑战」
  → `/video/${id}/challenge`；另两项（自由表达 / 中译英对话）不变。
  `isGuest` 时跳 `/login` 的 `from` 同步改为 `/video/${id}/challenge`。

### 6.2 页面 `src/pages/SpeakingChallengePage.jsx`

结构：`header`（缩略图 + 标题 + 等级 + 回看原视频 + 历史 + 重新生成）→ `step rail` → 当前步内容 → 反馈卡 → 报告卡。
移动端单列、桌面居中窄栏（`max-w-3xl`），全部用 Tailwind + lucide 图标，沿用 DialoguePage 的卡片/按钮配色。

未生成时：一张引导卡（这套挑战会做什么 + 「生成挑战」按钮 + AI 未配置提示）。
已完成时：直接进报告卡（并给「再练一次 / 换一套」）。

各步交互：

| 步 | 交互 |
|---|---|
| 1 | 3 个问题依次卡片：英文问题 + 中文提示 + 🎤（`useSegmentSpeechInput`）+ 文本框；全部有内容才能提交 |
| 2 | 5 张卡：中文释义 + 出处字幕（模糊/虚线遮挡）+ 「说英文」+ 「造句」两个输入；提交后才显示英文答案与反馈 |
| 3 | 5 个情境卡（列表滚动）：情境中文 + 目标语块中文提示 + 一个输入 |
| 4 | 话题卡：英文+中文话题、3 个要点、计时器（60/90/120 秒刻度）、分段录音（每 60 秒自动续录）、累计时长与词数；停止后可「再说一遍」；提交 |
| 5 | 聊天气泡（AI/用户）+ 每轮 🎤/输入 + 轮次计数（**最多 8 轮用户发言，满 5 轮才允许「结束对话」**）；结束时调 `/finish` |

反馈卡统一组件：分数环、`grammar` / `naturalness` 逐条（原文 → 更好说法 + 中文原因）、
`chunkUsage` 打勾/打叉、词汇建议、连贯性点评、「🔊 听地道说法」（`createSpeaker` 读 `better`）、
「重说这一题」/「重试反馈」。

报告卡：`speaking` 统计、三堆 chunk、`nextSuggestions`、按钮（再练一次 = `/restart`、换一套 = `/generate`、历史）。

历史抽屉：该视频所有 `variant`（日期、状态、分数、是否完成），点击切换查看/继续；历史记录里有答案与报告，只读展示 + 「再练一次」。

### 6.3 语音与录音

- 复用 `useSpeechInput`，新增 `src/utils/useSegmentSpeechInput.js`（D9，用户批准改共享音频栈）：
  - `pcmRecorder.stop()` 新增可选参数 `{ keepStream: true }`：不 `stream.getTracks().stop()`、不 `ctx.close()`，
    只断开节点并把已录 PCM 交回，**默认 `stop()` 行为保持原样**；
  - `aliyunAsr` 在 `keepStream` 模式下连续收段：第 1 段到 60 秒自动 `stop({keepStream:true})` → 上传识别 →
    重连节点继续录，**麦克风不断**、`segments` 计真实段数；
  - `useSpeechInput(authFetch)` 增加一个可选参 `{ segmented: false }` 与 `onSegmentEnd(text, ms)` 回调，
    默认 `false` 时走原路径（DialoguePage / TextDocPage 不改一行代码）；
  - `useSegmentSpeechInput` 把各段文本用空格拼接、累计 `activeMs`、统计 `segments`；
    组件卸载 / 停止 / 提交时把当前段并入；
  - 任何一段识别失败：保留已有文本 + `error`，不丢整段答案；`aliyunAsr` 不可用时降级到
    Web Speech（此时 `segments` 由 Web Speech 的自动断句决定，报告里标注 `source`）。
- 词数：`text.trim().split(/\s+/).filter(Boolean).length`（纯本地）。
- 不做发音评分：Step 1–5 都没有参考文本，`ShadowingEvaluator` 不适用。

### 6.4 纯逻辑工具 `src/utils/speakingChallenge.js`

无副作用、不抛错，配套 `speakingChallenge.test.js`：

- `STEP_META`（五步标题/副标题/图标名）
- `stepStatus(steps, cursor)` → `done|active|todo`
- `resumeStep(progress)` → 恢复时该进哪一步（`completed` → 报告；`status='answered'` 的步 → 该步反馈重试）
- `countWords(text)` / `wpm(words, ms)` / `countFillers(text, list)` / `formatDuration(ms)`
- `reportBuckets(chunkMasteryRows)` → `{ mastered, selfUsed, review }`
- `canFinishChat(turns)` / `chatTurnsUsed(messages)`
- `aggregateSpeaking(answers)` → `{ longestSeconds, totalSeconds, segments }`

---

## 7. 下线多轮对话（决策 B 的完整清单）

删除：

| 文件 / 位置 | 处理 |
|---|---|
| `src/pages/ConversationPage.jsx` | 删除 |
| `src/components/conversation/ChatBubble.jsx`、`ReviewPanel.jsx` | 删除（仅 ConversationPage 引用） |
| `src/main.jsx` 的 `video/:id/conversation` 路由 + import | 删除 |
| `server/routes/conversation.cjs` | 删除 |
| `server/index.cjs` 的 `require` + `app.use('/api/conversation', …)` | 删除 |
| `src/pages/LearningRecords.jsx`：`/conversation/recent` 请求、`conversations` state、Tab 计数、记录列表区块（及 `conv-*` 样式引用） | 删除 |
| `server/routes/conversation.test.cjs`、`server/routes/conversation-ai.test.cjs` | 删除 |

保留：

- `server/services/ai/conversation.cjs`（+ `conversation.test.cjs`）：只保留被 `challenge.cjs` 兜底池用到的
  `localExtractTopics`（纯本地）。文件顶部注释改一行说明现状；`extractConversationTopics` / `extractSceneProfile`
  暂不删除（`localDetectScene` 仍可能被后续功能复用），但不再有调用方。
- `conversation_sessions` / `conversation_messages` 建表语句与历史数据（D1）；`server/db.test.cjs` 保持不动。
- `src/index.css` 里 `.conv-*` 样式暂留（无引用、无副作用；避免动一个 4000 行的 CSS 文件）。

`LearningRecords` 里其余区块（生词、跟读、听写等）不受影响；Tab 数量从 N 变 N-1，需同步检查空态文案。

---

## 8. 异常与边界（实现清单）

1. AI 未配置：`GET` 横幅「AI 未配置，无法生成/评分」；所有写接口 503；**不产生假数据**。
2. 生成失败 2 次：503，库中无记录（前端提示重试）。
3. 生成第二个挑战时 `avoid` 为空（首次）：正常生成；第 3 套起必须带 avoid。
4. Step 反馈失败：答案已存，`status='answered'`；再次进入该步直接显示「已作答，重试反馈」。
5. 刷新/断线：`GET` 恢复 `cursor` 与各步 `steps_json`；Step 5 恢复聊天记录。
6. 中途换视频：各视频独立（`video_id` 维度），互不影响。
7. 重复提交同一步：允许，`steps_json[step-1]` 被覆盖（保留最后一次反馈）；chunk 状态按最后一次结果更新。
8. 空作答：400，不写库。
9. 超长作答：单条 2000 字符截断；超长文本不报错。
10. `challenge_json` 损坏（JSON 解析失败）：500「挑战数据已损坏，请重新生成」，不崩溃。
11. 计时全 0（用户只打字）：报告 `speaking` 显示「未检测到连续语音」，不出 0 秒结论。
12. 移动端 60 秒段切换时不打断用户（静默续录，只更新段计数）。

---

## 9. 验证计划

### 9.1 单元测试（`node --test "server/**/*.test.cjs" "src/**/*.test.js"`）

- `server/services/ai/challenge.test.cjs`：prompt 含字幕与 avoid；`normalizeChallenge` 对
  缺字段 / 数量不足 / 取证失败的降级；`normalizeStepFeedback` 对畸形输出不 throw；`normalizeReport` 合并本地统计。
- `server/lib/chunkMastery.test.cjs`：六种状态迁移 + 幂等（同一步重复提交）。
- `server/routes/challenge.test.cjs`：鉴权 401/403/404、step 越界 400、空作答 400、
  未配 AI 503、反馈失败时答案仍落库、restart 清空但保留 `challenge_json`。
- `src/utils/speakingChallenge.test.js`：`stepStatus` / `resumeStep` / `aggregateSpeaking`（含多段累加、
  重录取最大）/ `reportBuckets` / `countWords` / `wpm`。
- `src/utils/useSegmentSpeechInput.test.js`：段文本拼接、`activeMs` 累加、单段失败不丢已得文本（用假 hook 驱动）。
- 回归：`server/db.test.cjs` 仍通过（新表不破坏旧表）；`pcmRecorder` / `useSpeechInput` 默认路径的行为
  由现有 `pcmRecorder.test.js` + DialoguePage/TextDocPage 手工冒烟覆盖（默认参数不得改动）。

### 9.2 端到端脚本（`scripts/verify-speaking-challenge.mjs`）

CDP + 假 AI（stub `AI_BASE_URL=http://127.0.0.1:3999/v1`），复刻 `verify-dialogue-load.mjs` 的做法：
启动 stub（按 prompt 关键字回不同 JSON）→ 登录拿 token → 生成挑战 → 逐步提交 → 聊天 5 轮 →
finish → 断言报告三堆 chunk、`speaking` 统计、库中 `chunk_mastery` 行；
再断言「重新生成」后 `variant=2` 且 avoid 生效；最后断言 `/api/conversation/*` 已 404、`/video/:id/conversation` 不再渲染页面。

### 9.3 手工验收清单

1. 12 个视频各生成一次（脚本抽样 3 个即可），Chunk 的 `evidence` 都能在字幕里找到。
2. 同一视频连续生成 2 套：语块与情境明显不同。
3. 每步反馈都在 AI 返回后出现，且「先自己说、再看优化版」顺序正确。
4. 60 秒分段录音：说满 90 秒后 `longestSeconds ≈ 90`、`segments ≥ 2`。
5. AI 未配置环境：全流程不产生假分数，按钮禁用、提示明确。
6. 移动端 375px：五步都能单列滚动，麦克风与提交按钮可点。
