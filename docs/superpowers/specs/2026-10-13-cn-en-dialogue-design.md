# 设计文档 — 中译英口语对话（Video Dialogue Translation）

> 日期：2026-10-13 ｜ 项目：shadow_voice ｜ 分支：feat/cn-en-dialogue（自 main 09e233b 新建）
> 状态：已实现（2026-10-13，分支 feat/cn-en-dialogue）

---

## 1. 背景与目标

### 1.1 一句话

> 打开一个视频 → 选「中译英对话」→ AI 依据该视频字幕/主题/场景一次性写好一整段连贯的中文对话 →
> 用户逐句把中文口头翻成英文 → AI 只评这一句，区分「错了」和「不够地道」→ 全部练完看总结。

### 1.2 与现有功能的关系（复用优先，增量开发）

| 已有能力 | 位置 | 本功能怎么用 |
|---|---|---|
| AI Provider（OpenAI 兼容 fetch） | `server/services/ai/provider.cjs` | 直接用 `chat / extractJson / isConfigured`，零新依赖 |
| 单句中译英评分 | `server/services/ai/speak.cjs` | 复用 `parseReview`（分数钳制/字段容错），新增对话上下文与 verdict |
| 视频索引 + 字幕 | `server/routes/conversation.cjs` 的 `loadVideoIndex/loadSubtitles` | 同样的读法（本地 JSON，不新建数据源） |
| 场景档案缓存 | `ai_cache` + `scene-v1`（AI 对话功能写） | **只读复用**（已缓存就免一次 AI 调用），不主动提取 |
| 语音识别 | `src/utils/aliyunAsr.js` / `recallSpeech.js` | 「阿里云 ASR → Web Speech → 打字兜底」原样复用 |
| 英语播放 | `src/utils/tts.js`（服务端 TTS → 浏览器 TTS） | 参考答案卡片加 🔊 |
| 登录 / 游客 | `auth.cjs` / `AuthContext` | 与 AI 对话一致：游客引导登录 |
| 入口 | `VideoDetail` 的「💬 AI 对话」下拉（桌面 + 移动两处） | 加第三项「🔁 中译英对话」 |

**明确不做**：不重构现有页面、不改 `SpeakPracticePage`/`ConversationPage`、不动 `speak-prompts.json` 产物。

### 1.3 与「自由表达（speak）」的区别

| | 自由表达 `/video/:id/speak` | 中译英对话（本功能） |
|---|---|---|
| 题目来源 | 离线脚本预生成的零散句子 | 运行时 AI 生成的一整段**连贯对话** |
| 上下文 | 单句孤立 | 有场景、人物、前后句 |
| 反馈 | 评分 + issues | 同上 + **重试机制**（错→提示→重试→再给答案） |
| 进度 | 已练标记（句子集合） | 逐句答题记录 + 断点续练 + 完成总结 |
| 难度 | 题目标签（不可切） | 简单 / 日常 / 进阶 三档，各自独立脚本 |

---

## 2. 产品定义

### 2.1 已确认决策（用户）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 入口位置 | 视频播放页「💬 AI 对话」下拉里的新练习模式选项，不改动原有 AI 对话 |
| 2 | 生成时机 | **首次进入该视频该难度时生成并保存**；再次进入直接加载，不重复生成 |
| 3 | 生成粒度 | 整组一次生成（8–15 句，硬上限 20），**绝不每答一句重新生成整组** |
| 4 | 评估粒度 | 只评当前这一句（带上下文），1 句 = 1 次调用 |
| 5 | 评估触发 | **保留「解析我的回答」按钮**（用户确认识别文本后再评） |
| 6 | 难度切换 | 优先加载已存脚本；没有则**提示确认后生成**；不是对当前脚本做局部改写 |
| 7 | 重新生成 | 生成并保存新脚本；旧脚本 + 旧答题记录**保留但不再默认展示** |
| 8 | 完成态 | 练习总结 + 常见错误 + 需要复习的表达 |

### 2.2 我做的决定（可在评审时推翻）

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| A | 剧本中的每一句是否都要用户翻译 | **是**。每句带 `speaker`（你/对方）标签，靠标签传达人物关系与语气，用户翻译全部句子 | 用户口径是「8–15 句」并给出「3/12」进度示例，说明分母 = 练习句数；若只翻译单方台词，分母会腰斩，与口径不符 |
| B | 难度默认值 | 跟随视频 `level`：初级→简单、中级→日常、高级→进阶；无匹配默认 **日常** | 视频本身已有难度分级，用户不用先做一次选择 |
| C | 剧本归属 | 按 `user_id + video_id + difficulty` 存服务端（登录必需） | 与 AI 对话/AI 评分一致；跨设备续练；游客本地存不下整套成绩语义 |
| D | 完成总结是否调 AI | **不调**，前端用已存答题记录确定性聚合（均分、一次通过率、高频错误类型、需复习句子） | 用户明确要求「减少不必要的模型调用」；聚合结果真实可解释，不伪造 |
| E | 是否复用场景提取 | **只读 `ai_cache` 里已有的 `scene-v1`**，没有就不提取（把场景作为生成 prompt 的自由字段） | 省一次调用；不引入跨功能依赖 |
| F | 难度枚举值 | 存 `easy | daily | advanced`，中文标签在展示层 | 避免中文入库，便于后续国际化/断言 |

### 2.3 核心流程

```
VideoDetail「💬 AI 对话」→「🔁 中译英对话」（游客 → 登录）
  → GET /api/dialogue/:videoId?difficulty=daily
      ├─ 有当前脚本 → 直接进入练习（resume：cursor + 已答记录）
      └─ 无脚本     → 自动生成（loading「正在为这个视频准备对话…」）→ 落库 → 进入练习
  → 练习卡片（每次一句）
      ├─ 上下文：上一句（谁说的 + 中文）
      ├─ 主卡：当前中文句（大字）+ speaker 标签 + 目标表达 chips
      ├─ 🎤 录音 → 识别文本进输入框（可编辑）
      ├─ 「解析我的回答」→ POST /evaluate（只评这一句）
      │     ├─ correct / minor  → 展示分数 + issues + better + 🔊参考答案
      │     └─ wrong（第 1 次）→ 只给中文问题提示，隐藏英文答案 →「再试一次」
      └─ 下一句 → 游标推进落库
  → 全部完成 → 总结卡片（均分 / 一次通过率 / 高频错误 / 需复习表达）
              → 重新开始 / 换难度 / 重新生成对话 / 返回视频
  → 顶部「⋯」菜单：重新生成对话、重新开始、切换难度
```

### 2.4 判分与重试规则（关键体验）

AI 输出 `verdict` 三档，前端据此决定按钮：

| verdict | 含义 | 展示 | 下一步 |
|---|---|---|---|
| `correct` | 意思对、语法对、地道 | 分数 + praise + 参考答案（含 alternatives） | 下一句 |
| `minor` | 意思对、语法基本对，但**不够地道/用词可优化** | 分数 + issues + better | 下一句（不强制重试） |
| `wrong` | **语义错误 / 语法实质错误 / 关键信息丢失** | 第 1 次：只给中文 hint + issues（隐藏英文修正）；第 2 次起：给 better + 参考答案 | 「再试一次」 |

- 「再试一次」= 清空输入、同一句重新录；`attempt` 计数 +1 落库。
- 「查看参考答案」：`attempt >= 1` 且已出结果时始终可点（用户有最终控制权），点击后 `revealedAnswer` 落库。
- 第 2 次仍 `wrong`：不再强制重试，直接给完整反馈 + 参考答案，可进下一句。

### 2.5 难度档位定义（写进生成 prompt）

| 难度 | 中文句 | 英文参考 | 句子长度 |
|---|---|---|---|
| 简单 easy | 短句、单一信息点、日常高频词 | 1 个从句以内 | 6–12 词 |
| 日常 daily | 正常日常对话，含少量连接词 | 允许 1 个从句 | 10–18 词 |
| 进阶 advanced | 有观点/因果/转折，接近本族语对话 | 允许 2 个从句、固定搭配 | 14–25 词 |

---

## 3. 数据模型（2 张新表，全部 `CREATE TABLE IF NOT EXISTS`）

```sql
CREATE TABLE IF NOT EXISTS dialogue_scripts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id     TEXT NOT NULL,
  difficulty   TEXT NOT NULL,              -- easy | daily | advanced
  variant      INTEGER NOT NULL DEFAULT 1, -- 同视频同难度「重新生成」的版本号
  script_json  TEXT NOT NULL,              -- {title, scene, source, lines[]}
  model        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, video_id, difficulty, variant)
);

CREATE TABLE IF NOT EXISTS dialogue_progress (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id    INTEGER NOT NULL UNIQUE REFERENCES dialogue_scripts(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cursor       INTEGER NOT NULL DEFAULT 0, -- 当前句下标
  answers_json TEXT NOT NULL DEFAULT '[]', -- 逐句答题记录
  status       TEXT NOT NULL DEFAULT 'active', -- active | completed
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);
```

- **当前脚本** = 该 `(user_id, video_id, difficulty)` 下 `variant` 最大的那行。重新生成 = `variant + 1`，
  旧行与其 `dialogue_progress` 原样保留（满足「旧脚本和答题记录保留但不默认展示」）。
- `answers_json` 每条：
  ```json
  { "index": 2, "attempts": 2, "userText": "I just checked in...", "score": 82,
    "verdict": "minor", "issues": [ ... ], "better": "...", "praise": "...",
    "revealedAnswer": false, "updatedAt": "2026-10-13T10:00:00.000Z" }
  ```
  同一句重复作答只保留**最后一次**的评估结果，`attempts` 累加（记录会膨胀，但没有回放需求）。

---

## 4. API（全部 `authMiddleware`，游客 401）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dialogue/:videoId?difficulty=daily` | 取当前脚本 + 进度。未生成 → `{ script: null, aiConfigured }` |
| POST | `/api/dialogue/:videoId/generate`，body `{ difficulty }` | 生成新剧本（`variant+1`）并建进度行 → 201 |
| POST | `/api/dialogue/:scriptId/evaluate`，body `{ index, userText, attempt }` | 评一句；写回 `answers_json` → 200 `{ review }` |
| PUT | `/api/dialogue/:scriptId/progress`，body `{ cursor, status? }` | 推进游标 / 标记完成 |
| POST | `/api/dialogue/:scriptId/restart` | 清空 `answers_json`、`cursor=0`、`status=active` |

校验与降级：

| 场景 | 行为 |
|---|---|
| `videoId` 不存在 | 404 `视频不存在` |
| `difficulty` 非法 | 400 `无效难度`（默认补 `daily`） |
| 脚本不属于当前用户 | 403 `无权访问该脚本` |
| AI 未配置 | `/generate` → 503 `AI 未配置（AI_API_KEY 为空）`；GET 仍返回 `aiConfigured:false`，前端给「配置后可生成」态 |
| AI 调用失败 / 连续 2 次 JSON 畸形 | 503 `生成失败（AI 服务暂不可用），请重试`；**不落盘半成品** |
| 生成结果不合格（有效句 < 5） | 同上 503，不伪造 |
| 字幕不可用 | 正常生成，`script.source = 'video-info'`，前端标注「无字幕，依据视频信息生成」 |
| `/evaluate` AI 失败 | 503 `评分失败，请稍后重试`，前端保留识别文本可再点 |
| `/evaluate` 输出畸形 | 200 `{ review: { score:null, parseError:true } }`，不伪造分数 |
| 无字幕且无标题/简介 | 404 `视频信息不足，无法生成对话` |

### 4.1 成本

| 动作 | 模型调用 |
|---|---|
| 首次进入（无脚本） | 1 次（整组） |
| 再次进入 | 0 |
| 切难度且已有脚本 | 0 |
| 每答一句 | 1 次 |
| 「再试一次」 | 1 次（用户主动） |
| 重新生成 | 1 次（用户主动） |
| 完成总结 | 0 |

---

## 5. AI 层（`server/services/ai/dialogue.cjs`）

### 5.1 纯函数（可单测，不发请求）

| 函数 | 职责 |
|---|---|
| `difficultyOf(videoLevel)` | 视频等级 → 难度档 |
| `buildScriptPrompt({ videoTitle, description, videoLevel, difficulty, segments, scene })` | 整组生成 prompt |
| `normalizeDialogueScript(raw, { difficulty, hasSubtitles })` | 校验/去重/截断/编号；不合格返回 `{ ok:false, reason }`，**不抛错** |
| `buildLineReviewPrompt({ line, contextLines, difficulty, userText, attempt })` | 单句评分 prompt（含上下文、可接受表达、重试次数） |
| `normalizeLineReview(raw, { attempt })` | verdict 归一 + 分数钳制 + 重试期隐藏英文答案 |
| `summarizeAnswers(answers, lines)` | 服务端只用于「是否可标记完成」的最小判断（总结在前端算） |

### 5.2 剧本 JSON（生成 prompt 输出）

```json
{
  "title": "酒店入住",
  "scene": "Hotel Check-in",
  "settingCn": "你在英国酒店前台办理入住，接待员在确认你的预订",
  "userRole": "客人",
  "otherRole": "前台接待",
  "lines": [
    { "speaker": "other", "speakerCn": "前台",
      "cn": "您好，请问有预订吗？",
      "en": "Good afternoon. Do you have a reservation with us?",
      "alternatives": ["Hi there, are you checking in?"],
      "keyPoints": ["reservation 比 booking 更常用于酒店", "开场用 Good afternoon 更自然"] }
  ]
}
```

生成规则（写死在 prompt 里）：
- **必须基于提供的字幕内容**；无字幕时只依据标题/简介/主题，**禁止编造视频里不存在的情节、人名、地点**。
- 一整段**连贯**对话，前后有来有回，不是零散句子集合；句数 8–15（上限 20）。
- 每句中文必须是用户可以用英文说出口的完整句子；参考英文按难度档控制长度与复杂度。
- `alternatives` 1–2 条同义可接受说法；`keyPoints` 0–2 条中文纠错要点（时态/搭配/语气）。

### 5.3 单句评分 JSON（评分 prompt 输出）

```json
{ "verdict": "correct|minor|wrong", "score": 82,
  "issues": [{"type":"grammar|word_choice|collocation|naturalness|incomplete",
              "location":"...","problem":"中文说明","suggestion":"中文建议","better":"英文修正"}],
  "better": "整句更地道的英文",
  "praise": "具体夸一句（中文）",
  "hint": "verdict=wrong 时给的中文提示（不含英文答案），否则空字符串" }
```

- prompt 明确：参考英文只是**一种**正确说法，语义等价且自然即高分。
- `normalizeLineReview`：`score` 钳到 0–100；`verdict` 非法 → 按 score 推（≥80 correct / 60–79 minor / <60 wrong）；
  **`verdict === 'wrong' && attempt < 2` 时剥离所有 `better` 字段并置 `answerHidden: true`**。
- 与 `speak.cjs` 的关系：复用其 `extractJson` + 分数钳制思路；`speak.cjs` 一行不改。

---

## 6. 前端

### 6.1 文件

```
src/pages/DialoguePage.jsx          新建：逐句练习页（<600 行）
src/utils/dialoguePractice.js       新建：纯逻辑（难度映射、进度、总结聚合、答案可见性）+ 单测
src/utils/useSpeechInput.js         新建：ASR 复用 hook（阿里云 → Web Speech → 打字兜底）
src/main.jsx                        改：注册 /video/:id/dialogue
src/pages/VideoDetail.jsx           改：两处「💬 AI 对话」下拉各加一项（纯加法）
server/db.cjs                       改：+2 表
server/services/ai/dialogue.cjs     新建：prompt + 归一化 + 单测
server/routes/dialogue.cjs          新建：5 个端点 + 单测
server/index.cjs                    改：挂载 /api/dialogue
```

### 6.2 界面（移动优先）

```
┌───────────────────────────────────────────┐
│ ←  🔁 中译英对话   简单 日常 进阶   ⋯  3/12 │
├───────────────────────────────────────────┤
│ 🎬 酒店入住 · 你是「客人」                 │
│ 上一句（前台）：您好，请问有预订吗？        │
│                                           │
│        你（客人）                          │
│    我刚办好入住，现在想去房间。             │
│    [check in] [head up to]                │
│                                           │
│              ( 🎤 )                        │
│  ┌─────────────────────────────────────┐  │
│  │ 识别文本，可手动修改…                │  │
│  └─────────────────────────────────────┘  │
│         [ ✨ 解析我的回答 ]                │
├───────────────────────────────────────────┤
│ 结果卡：verdict 徽章 / 分数 / issues        │
│  [ 再试一次 ] [ 查看参考答案 ] [ 下一句 → ] │
└───────────────────────────────────────────┘
```

- 完成态：换成总结卡（均分环 / 一次通过率 / 高频错误 top3 / 需复习表达列表，可点 🔊）。
- 顶部 `⋯` → 重新生成对话 / 重新开始 / 返回视频。
- 难度 chip 点击：该档已有脚本 → 直接切；没有 → 弹确认「该难度还没有脚本，需要生成一组（约 10–20 秒）」。
- 重新生成：确认弹窗说明「旧对话会保留，但不再显示」。
- 无 PDF/无横向滚动、按钮 ≥44px、不依赖 hover。

### 6.3 语音与播放

- 录音按钮复用现有三段式：`/asr/status` 探测 → `createAsrSpeechInput` → 失败降级 `createSpeechInput` → 再失败提示手打。
- 只会用 `en-US`。
- 「解析」按钮在 `userText` 为空时禁用；解析中禁用并显示 loading。
- 参考答案行 + 需复习表达支持 🔊（`createSpeaker`，服务端 TTS → 浏览器 TTS）。

---

## 7. 异常与降级清单

| 场景 | 表现 |
|---|---|
| 游客点入口 | 跳登录，`from=/video/:id/dialogue` |
| AI 未配置 | 页面显示「AI 未配置，无法生成对话」+ 返回视频；不显示假题目 |
| 生成超时（30s） | 显示「生成失败，请重试」，可重试，不落盘 |
| 无字幕 | 正常生成，卡片标注「无字幕 · 依据视频信息生成」 |
| 音频权限被拒 | 中文提示 + 手打兜底 |
| 识别为空 | 不自动评分，提示「没听到声音，再说一次或直接输入」 |
| 网络断开 | evaluate 失败保留文本 + 重试按钮；progress 失败不阻塞翻页（下次进入按 cursor 恢复，可能回退一句，可接受） |
| 进度写入失败 | 静默 + 下次 GET 覆盖本地状态，不弹错 |
| 脚本被删 / 403 | 提示并重新拉取当前难度脚本 |

---

## 8. 测试（`node:test`，不调真实 AI）

| 文件 | 覆盖 |
|---|---|
| `server/services/ai/dialogue.test.cjs` | prompt 含字幕/难度/人物关系；`normalizeDialogueScript` 去重/截断 20/丢非法/不足 5 判不合格/无字幕标记；`normalizeLineReview` verdict 归一 + 分数钳制 + **wrong+attempt1 隐藏 better** |
| `server/routes/dialogue.test.cjs` | GET 无脚本 → `script:null`；generate 落库 + `variant=1`；再 generate → `variant=2` 且旧行仍在；GET 返回最新；难度隔离；evaluate 写回 answers；重试 attempt 累加；progress/restart；403 归属；401 游客；AI 未配置 503；字幕缺失走 `video-info`；AI 连续畸形 503 且不落盘 |
| `src/utils/dialoguePractice.test.js` | 难度映射；`progressLabel`；`summarizeAnswers`（均分/一次通过率/高频错误/需复习去重）；`canRevealAnswer` 规则 |

验证命令：
```bash
node --test server/services/ai/dialogue.test.cjs server/routes/dialogue.test.cjs src/utils/dialoguePractice.test.js
npm run lint && npm run build
```

---

## 9. 验收（Definition of Done）

1. 视频页「💬 AI 对话」下拉出现「🔁 中译英对话」，桌面/移动两处入口都可用；游客引导登录。
2. 首次进入自动生成 8–15 句连贯对话并落库；刷新/重进 **0 次模型调用**，直接恢复上次那句。
3. 每次只显示一句中文 + 上下文；录音 → 解析 → 分档反馈；错误时先只给中文提示并可重试，第 2 次或点「查看参考答案」后给答案。
4. 「简单/日常/进阶」按档独立：已有则加载，没有则确认后生成，**不局部改写**当前脚本。
5. 「重新生成对话」生成 `variant+1`，旧脚本 + 旧答题记录仍在库中但不默认展示。
6. 全部练完展示总结（均分 / 一次通过率 / 高频错误 / 需复习表达），可重新开始。
7. 无字幕视频可生成且标注来源；AI 未配置/失败/网络异常均明确提示，不伪造分数或台词。
8. 现有功能零退化；新增单测全绿；`npm run lint` 不新增 error；`npm run build` 通过。

---

## 10. 明确不做

- 不做发音评测（留在跟读）、不做多轮自由聊天（已有 AI 对话）、不做角色扮演（已有 roleplay）。
- 不做剧本编辑、导出、分享、语音回放存档。
- 不做离线脚本预生成（`scripts/` 不加批处理），不做未进入视频的提前生成。
- 不改现有 `SpeakPracticePage` / `ConversationPage` / `speak-prompts.json`。
