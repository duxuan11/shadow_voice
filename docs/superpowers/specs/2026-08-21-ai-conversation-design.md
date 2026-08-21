# 设计文档 — 视频主题多轮 AI 对话(Speaking Conversation)

> 日期：2026-08-21 ｜ 项目：shadow_voice ｜ 分支：feature/ai-conversation（自 main 0da038c 新建）
> 状态：设计稿，待用户确认后进入实施

---

## 1. 背景与动机

### 1.1 为什么重做

此前 V1「口语训练」（Listen→Shadow→Recall→Mutate→Speak 五步闭环，feature/v1-speaking-loop，
30 commits）已整体实现并审查通过，但用户实测后判定：

> **不符合需求。** 五步流程是"拆解式训练"，用户要的是**真实的多轮对话**——AI 说一句、用户说一句、
> 连续交流，最后一次性解析用户说的每一句有哪些问题、怎么改进。

用户明确要求：丢弃 feature/v1-speaking-loop 方向，从 main 重新开始，只做 AI 对话功能。
（旧分支/worktree 保留待用户确认后删除，main 不受影响。）

### 1.2 参考产品

Sprout Language（https://sproutlanguage.com）的 **Video Discussion** 模式：

```
选视频 → "Discuss this video" → Connecting with 🤖 AI → 多轮对话 → "Analyzing your conversation..."
→ 会话后逐句反馈页（"Complete a conversation to see your feedback here"）
```

其 how-to 页面为 8 步设备自检（播放/麦克风/轮流切换/抢话/尾音/快速循环/码率矩阵），
本质是保障"播放→录音"语音切换可靠性——本项目已具备（阿里云评测录音链路），无需重做。

### 1.3 与现有功能的关系

main 分支已有（保留复用）：
- 阿里云口语评测：ShadowingEvaluator.jsx / routes/aliyun.cjs / engineSdk.js —— **发音评测继续留在 Shadow 步骤**
- 视频库 / 播放 / 双语字幕 / 听写 / 挖空 / 中译英 / 跟读 / 生词 / 登录（JWT）/ sql.js 4 表

main 分支没有（本功能新增）：
- AI provider（server/services/ai/）
- optionalAuthMiddleware（游客可练）
- Web Speech 语音识别封装（recallSpeech）
- AI 对话相关的一切

---

## 2. 产品定义

### 2.1 一句话

> 打开一个视频，和 AI 围绕视频里的常用句子、表达、物品进行多轮英语对话；
> 说完点「解析」，逐句看自己哪里有问题、怎么改进。

### 2.2 用户决策（已确认 2026-08-21）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | AI 服务配置 | 配置 .env（AI_BASE_URL/AI_API_KEY/AI_MODEL，DeepSeek 默认）；**AI_API_KEY 必填，无 key 时功能不可用并提示配置** |
| 2 | 对话主题 | **视频主题版**：围绕该视频 AI 提取的重点单词、常用短语、搭配（自由话题留 V2） |
| 3 | 录音方式 | Web Speech 识别成文字，解析聚焦"说什么"（语法/用词/自然度）；**发音评测留在现有 Shadow 步骤** |
| 4 | 解析时机 | **用户手动点「解析」**（不做自动轮数触发） |
| 5 | 游客策略 | **游客不可用 AI 对话**（与阿里云评测一致：conversation API 用 authMiddleware，游客 401 提示登录） |
| 6 | 主题素材来源 | **AI 重新从字幕提取**重点单词/常用短语/搭配（新 Prompt F0），并结合词卡既有重点单词；AI 不可用时本地降级 |

### 2.3 核心流程

```
视频详情页 → 💬 AI 对话 → /video/:id/conversation
  → 系统取该视频 Expressions + 物品名词作为对话主题
  → AI 开场白（结合视频，自然抛出表达）
  → 多轮交替：AI 说一句 → 用户 🎤 说/⌨️ 打 → AI 顺着回（5~8 轮左右，无强制上限）
  → 用户随时点「🔍 解析」
  → Analyzing your conversation...（AI 批量分析全部用户轮次）
  → 逐句反馈页：每句 score + issues（类型/位置/问题/建议/better）+ praise
  → [再来一轮] [返回视频] [查看反馈]
```

### 2.4 对话示例（视频：出国旅行的日常，表达 check in / This is a... / 物品 lift·concierge·bags）

```
AI:   "So you just checked in at the hotel. Was the check-in process quick?"
你:   "Yes, it was quick. The concierge helped us with our bags."
AI:   "Nice, that's what they're for! Is this your first time staying in this hotel?"
你:   "No, I stay here before, but this time is different because..."
AI:   "Interesting! What makes this time different?"
   ...
你:   [🔍 解析]
```

解析输出（节选，第 3 轮你的一句）：
```json
{
  "turn": 3,
  "user_text": "No, I stay here before, but this time is different because...",
  "score": 76,
  "issues": [
    {
      "type": "grammar",
      "location": "I stay here before",
      "problem": "时态错误：'before' 表过去，需用过去时",
      "suggestion": "I stayed here before",
      "better": "No, I've stayed here before, but this time is different..."
    },
    {
      "type": "naturalness",
      "location": "this time is different because...",
      "problem": "句子中断，AI 无法接话；可补全原因",
      "suggestion": "补全原因从句，如 'because the hotel has a new spa'"
    }
  ],
  "praise": "Good — you used 'stay here' naturally. Keep going!"
}
```

---

## 3. 技术架构（extend，不重建）

### 3.1 技术栈（不变）

React 19 / Vite 8 / Express 5 CJS / sql.js / JWT / 纯 CSS+Tailwind v4 / node:test。
零新 npm 依赖（AI 调用走 fetch）。

### 3.2 模块划分

```
server/
├── auth.cjs                      修改：新增 optionalAuthMiddleware（游客 req.userId=null 放行；无效 token 401）
├── db.cjs                        修改：追加 2 张表（IF NOT EXISTS）
├── services/ai/
│   ├── provider.cjs              新建：OpenAI 兼容 chat/extractJson/isConfigured（30s 超时，禁伪造）
│   └── conversation.cjs          新建：对话引擎 + 批量解析（核心）
├── routes/conversation.cjs       新建：4 个 API
└── index.cjs                     修改：挂载 /api/conversation

src/
├── pages/ConversationPage.jsx    新建：对话页（<600 行）
├── components/conversation/
│   ├── ChatBubble.jsx            新建：AI/用户气泡
│   ├── ReviewPanel.jsx           新建：解析结果逐句展示
│   └── ConversationProgress.jsx  新建：轮次指示
├── utils/recallSpeech.js         新建：Web Speech 封装（语音输入，失败降级打字）
├── pages/VideoDetail.jsx         修改：加「💬 AI 对话」按钮（纯加法）
├── main.jsx                      修改：注册 /video/:id/conversation
└── index.css                     修改：追加 .conv-* 样式
```

### 3.3 对话主题素材（视频主题版的关键）

对话开始时从视频提取主题素材，**主路径由 AI 提取（Prompt F0）**，AI 不可用时本地降级：

| 素材 | 来源 | 用途 |
|------|------|------|
| 重点单词（8~12 个） | Prompt F0：AI 从字幕选高频/高价值单词（如 concierge/lift/bags） | 对话话题、AI 提问素材、解析时检查是否用到 |
| 常用短语（5~8 个） | Prompt F0：AI 从字幕提取 chunk/短语（如 check in/take the lift） | 对话中自然抛出、解析检查 |
| 搭配（3~5 个） | Prompt F0：AI 提取词伙/固定搭配（如 take care of/check in at） | 对话深化素材 |
| 词卡既有重点单词 | VideoDetail 词卡 highlightWords 数据 | 合并进 topics（若该视频已有） |

实现：
- **Prompt F0（主题提取器）**：输入视频标题 + 字幕段（截断到 ~150 段），输出严格 JSON：
  ```json
  {
    "words": [{"word":"concierge","meaning":"礼宾员","count":3}],
    "phrases": [{"phrase":"check in","meaning":"办理入住","example":"We checked in at the hotel."}],
    "collocations": [{"collocation":"take care of","meaning":"照顾/处理","example":"The concierge took care of our bags."}]
  }
  ```
- `extractConversationTopics(segments)` 纯函数（可单测）：
  - `isConfigured()` 时走 Prompt F0，解析失败/无 key 时降级本地
  - 本地降级：复用 expressionExtractor 的 PATTERNS/GENERIC_PATTERNS 提取短语；词频统计 + 停用词过滤提取高频实词作为 words
  - 输出 `{ words, phrases, collocations, source: 'ai'|'local' }`，随 start 接口返回

### 3.4 AI Prompt（conversation.cjs 内，4 个）

**Prompt F0 — 主题提取器**（start 时调用一次，见 3.3）

**Prompt F1 — 开场白**（start 时调用一次）
输入：视频标题、主题素材（words/phrases/collocations）、用户等级
输出：AI 第一句（自然口语、结合视频、尽量用 1 个目标短语）

**Prompt F2 — AI 回复**（每轮调用一次）
输入：视频主题、完整对话历史（AI+用户交替）、目标短语提示
输出：AI 下一句（顺着用户说、提问式推进、难度匹配；不重复自己；保持简短 1~2 句）
- 用 JSON 输出 `{ reply: "..." }` 或纯文本（容错：非 JSON 直接当文本）

**Prompt F3 — 批量解析**（用户点「解析」时调用一次，分析全部用户轮次）
输入：视频主题（words/phrases/collocations）、完整对话历史
输出严格 JSON：
```json
{
  "turns": [
    {
      "turn": 3,
      "score": 76,
      "issues": [
        { "type": "grammar|word_choice|naturalness|missing_expression|incomplete",
          "location": "...", "problem": "...", "suggestion": "...", "better": "..." }
      ],
      "praise": "..."
    }
  ],
  "summary": "整体表现 + 最需要改进的 1 点",
  "best_turn": 3
}
```

### 3.5 数据库（2 张新表，全部 CREATE TABLE IF NOT EXISTS）

```sql
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- 游客不可用，必填
  video_id TEXT NOT NULL,
  topics_json TEXT NOT NULL,                                -- {words, phrases, collocations, source}
  status TEXT DEFAULT 'active',                             -- active | completed
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                       -- 'ai' | 'user'
  text TEXT NOT NULL,
  score REAL,                                               -- 解析后填充（user 轮次）
  issues_json TEXT,                                         -- 解析后填充（user 轮次）
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 3.6 API（全部 authMiddleware，游客 401 提示登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/conversation/start | body `{videoId}` → 201 `{ session, topics, opening }`（AI 开场白；无 AI key 时 opening=null + `aiUnavailable: true`） |
| POST | /api/conversation/:sessionId/reply | body `{text}` → 200 `{ aiReply, history }`（追加 user+ai 两条；无 AI key → 503 提示） |
| POST | /api/conversation/:sessionId/review | → 200 `{ review }`（批量解析全部 user 轮次，逐条写回 score/issues_json；无 AI key → 本地降级，见 3.7） |
| GET  | /api/conversation/:sessionId | → 200 `{ session, messages }`（刷新恢复历史） |

归属校验（同 V1 模式）：requireOwnSession —— 登录用户只能访问自己的会话（user_id 匹配）。
`GET /:sessionId` 需在 start 路由之后（无通配冲突风险，路径不同）。

### 3.7 失败降级（禁 fake score）

| 场景 | 行为 |
|------|------|
| 无 AI_API_KEY（isConfigured=false） | start：opening=null + `aiUnavailable:true`，前端显示"配置 AI key 后可使用"；reply/review：503 `{error:'AI 未配置（AI_API_KEY 为空）'}`。**不伪造** |
| AI 调用失败 | reply/review catch → 503 `{error:'AI 服务暂不可用，请稍后重试'}`；前端保留已说内容，可重试 |
| review 的 AI 输出畸形 | 逐轮降级：score=null + 无 issues，标注"该句未能解析"；turns 数组其余正常 |
| 麦克风不可用 | 打字输入（recallSpeech 预检，与 RecallStep 同模式） |
| 游客 | **401 提示登录**（authMiddleware 拦截，前端引导登录） |
| 主题提取 AI 不可用 | extractConversationTopics 本地降级（source:'local'），对话仍可进行 |

### 3.8 成本控制

- 主题提取 1 次（ai_cache 按 video_id 缓存，同视频二次进入不重提取）+ 开场白 1 次 + 每轮 1 次 + 解析 1 次（**非每轮解析**）
- 轮次上限：前端提示 + 后端 reply 拒绝超过 20 轮（防失控）
- 解析时 history 截断：只送用户轮次 + 最近 2 条 AI 轮次（控制 token）
- 同一会话 review 可重复点（重新解析覆盖写回），但 30 秒内不重复调 AI（简单节流）

### 3.9 前端页面（ConversationPage）

```
┌──────────────────────────────────────┐
│ ← 返回    💬 AI 对话   视频标题  3轮   │
├──────────────────────────────────────┤
│  🤖 So you just checked in...         │
│  🎤 Yes, it was quick...              │
│  🤖 Nice, that's what they're for!    │
│        (滚动区,最新在底部,自动滚)       │
├──────────────────────────────────────┤
│ [🎤 按住说话] 或 [⌨️ 打字]  [发送]     │
│                [🔍 解析]               │
└──────────────────────────────────────┘
```

- 语音：recallSpeech 封装（Web Speech en-US；识别结果进输入框可编辑后发送）
- 解析中：顶部 "Analyzing your conversation..." 状态
- 解析后：跳转/切换 ReviewPanel（逐句：你说了什么 → 分数 → issues 列表 → better 版本 → praise）
- 移动端：拇指大按钮、无横向滚动、不依赖 hover（沿用项目移动端约定）

---

## 4. 实施步骤（每步 TDD + review）

| 任务 | 内容 | 交付 |
|------|------|------|
| A | db.cjs 追加 2 表（user_id NOT NULL）+ ai_cache 表（主题缓存） | 测试：新表存在 |
| B | provider.cjs（OpenAI 兼容 fetch） | 测试：chat/extractJson/超时/未配置 |
| C | conversation.cjs：extractConversationTopics（Prompt F0 + 本地降级）+ 3 个 Prompt + 历史组装 | 测试：主题提取/提示词/降级 |
| D | routes/conversation.cjs 4 端点 + 挂载（authMiddleware，游客 401） | 测试：start/reply/review/get、归属、游客、无 key |
| E | recallSpeech.js + ConversationPage 骨架 + ChatBubble | lint/build |
| F | ReviewPanel 逐句反馈 + 解析交互 | lint/build |
| G | VideoDetail 按钮 + 路由 + CSS + .env.example/README | 全量验证 |

## 5. 验证（Definition of Done）

1. 视频详情页出现「💬 AI 对话」入口，点击进入 /video/:id/conversation（游客点击提示登录）
2. 系统从视频提取主题（重点单词 + 常用短语 + 搭配；AI 主路径，本地降级），同视频二次进入命中 ai_cache
3. AI 开场白结合视频内容
4. 多轮交替对话：AI 说一句 → 用户语音/打字 → AI 顺着回
5. 用户手动点「解析」→ 逐句 score + issues（类型/位置/问题/建议/better）+ praise + summary
6. 解析结果落库（conversation_messages.score/issues_json），刷新可恢复历史
7. 无 AI key：明确提示配置，不伪造、不崩溃
8. 游客 401 提示登录；无效 token 401
9. 现有功能零退化（视频库/字幕/听写/挖空/中译英/跟读/生词/阿里云评测/登录/词卡）
10. 全部单测通过、npm run lint 不新增 error、npm run build 通过
11. 移动端可用（拇指按钮、无横向滚动、语音降级打字）

## 6. 明确不做（V2 范畴）

- 自由话题对话（General Conversation）
- AI 角色扮演（Role Play 场景库）
- 发音评测融入对话（留在 Shadow 步骤）
- 自动轮数触发解析（用户手动）
- 对话录音文件存储与回放
- SRS/推荐/等级/游戏化

## 7. 前置条件

- [x] AI_API_KEY 已填入 .env（AI_BASE_URL=https://api.deepseek.com/v1、AI_MODEL=deepseek-chat 已配，key 已验证可用）
- [x] 旧分支 feature/v1-speaking-loop 及 worktree 已删除（2026-08-21 确认）
- [ ] 对话功能需登录（游客 401）——前端入口对游客引导登录
