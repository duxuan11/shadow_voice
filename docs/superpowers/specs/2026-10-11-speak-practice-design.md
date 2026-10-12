# 设计文档 — 自由表达（看中文说英文 · 口语评分）

> 日期：2026-10-11 ｜ 项目：shadow_voice ｜ 分支：feat/speak-practice（自 main b19f066 新建）
> 状态：设计稿，待用户确认后进入实施

---

## 1. 背景与动机

在现有「💬 AI 对话」（多轮对话）、「跟读」（发音评测）、「中译英」（拼句/打字练习）之外，新增一种
**「看中文说英文」口语练习**：系统给出一句视频里的中文，用户用麦克风说英文，点「解析」后由 AI 评分并
逐句反馈（用词/搭配地不地道、有没有更地道的说法、低分给提示），允许反复说。

关键诉求：练习内容（中文句子 + 标准英文答案）**提前批量提取落盘**，不在用户使用时临时调 AI 提取，省 token；
只有「按你说的英文打分」那次 AI 调用发生在点「解析」时（这是功能本身，无法预提取）。

### 1.1 与现有功能的关系

| 现有功能 | 定位 | 本功能是否取代 |
|---|---|---|
| 💬 AI 对话 | 多轮对话 + 手动解析 | 否，保留；与自由表达并列入口 |
| 跟读（Shadow） | 跟读英文，阿里云发音评测 | 否，保留 |
| 中译英（Translate） | 看中文、把英文单词拼成句（打字） | 否，保留 |

### 1.2 已确认决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 入口 | 视频详情页「💬 AI 对话」按钮改为弹菜单：多轮对话 / 自由表达（方案 A） |
| 2 | 玩法数量 | 仅一种玩法「看中文说英文」；「自由表达」是它的名字，不是第二个玩法 |
| 3 | 内容模型 | 中英对照句为主 + AI 少量场景扩展句（都带标准答案）；总练习句数 < 字幕数 |
| 4 | 评分口径 | 评「表达对不对/能不能接受」，不要求逐字对齐原文；`en` 只是参考答案之一 |
| 5 | 鉴权 | 游客不允许使用（authMiddleware 401 + 前端引导登录） |
| 6 | 设备 | 电脑端与手机端都可用，交互尽量一致（一个响应式页面同时适配两端） |
| 7 | 记录 | 已练句跨设备持久化（practiceRecords 加 `speak` 任务）；learningStatus 三项进度不变 |

---

## 2. 产品定义

一句话：进入一个视频，看中文句子说英文，点「解析」看 AI 逐句评分与地道表达建议，可反复练习。

### 2.1 核心流程

```
视频详情页 → 点「💬 AI 对话」→ 选「🗣 自由表达·看中文说英文」→ /video/:id/speak
  → 看一句中文（参考答案隐藏）
  → 🎤 点击录音 / 点击停止（阿里云 ASR → Web Speech → 打字兜底）
  → 识别结果可编辑修正
  → 点「🔍 解析」→ AI 评分
  → 分数 + 问题（语法/用词/搭配/地道）+ 更地道说法 + 参考答案 + praise + 低分提示
  → [🔁 重说] / [← 上一句] / [下一句 →]
```

---

## 3. 技术架构（复用，不重建）

### 3.1 模块划分

| 模块 | 动作 | 说明 |
|---|---|---|
| `scripts/build-speak-prompts.mjs` | 新建 | 预提取脚本，产出每视频练习句（对齐 `build-wordcards.mjs` 用法） |
| `src/utils/speakPrompts.js` | 新建 | 纯函数：本地规则过滤字幕 → 练习句（脚本与页面共用） |
| `server/services/ai/speak.cjs` | 新建 | 评分 prompt + 结果解析（纯函数可单测） |
| `server/routes/speak.cjs` | 新建 | `POST /api/speak/review`，挂到 `index.cjs` |
| `src/pages/SpeakPracticePage.jsx` | 新建 | 练习页，路由 `/video/:id/speak` |
| `src/utils/practiceRecords.js` | 修改 | `PRACTICE_TASKS` 加 `speak` |
| `server/routes/practice.cjs` | 修改 | `TASKS`/`emptyData`/`parseData`/`summary` 加 `speak` |
| `src/pages/VideoDetail.jsx` | 修改 | 两处「AI 对话」按钮改为弹菜单 |
| `src/main.jsx` | 修改 | 注册 `/video/:id/speak` 路由 |
| 复用 | — | `provider.cjs`（AI）、`aliyunAsr`/`recallSpeech`/`pcmRecorder`（语音）、`auth` 中间件、`practiceRecords` |

### 3.2 预提取产物 `data/videos/<episode_dir>/speak-prompts.json`

```json
{
  "version": 1,
  "videoId": "33650c75-...",
  "title": "出国旅行的日常",
  "generatedAt": "2026-10-11T...",
  "prompts": [
    { "index": 0, "cn": "我们今天办理了入住。", "en": "We checked in today.", "source": "subtitle", "subIndex": 3 },
    { "index": 1, "cn": "我的航班是九点半的。", "en": "My flight is at 9:30.", "source": "ai_generated", "subIndex": null }
  ]
}
```

- 字段只有 `cn / en / source / subIndex`，不额外存 keyPhrases——评分时 AI 拿 `en` 自己识别目标搭配，省预提取 token。
- `source: subtitle`：字幕原句，`en` 即原文字幕英文（标准答案）。
- `source: ai_generated`：AI 按视频场景新造的中文句 + 标准英文，`subIndex` 为 null。

### 3.3 生成脚本规则（`npm run speak-prompts`）

对齐 `build-wordcards.mjs` 用法：`--force` 全量重生成 / `--video <id>` 单视频 / `--dry` 只打印。

1. **本地规则过滤字幕**（零 token、确定性，逻辑在 `src/utils/speakPrompts.js`）：
   剔除中文为空 / 过短（<4 字）/ 过长 / 英文为空 / 纯数字或纯专名 / 明显不完整句；
   按字幕顺序保留，总数 < 字幕数（若过滤后仍偏多则按上限截断，上限可调，默认 ≤ 40 句/视频）。
2. **AI 只做一件事**：配了 AI key 时，生成 ≤5 条场景相关扩展句（`cn`+`en`），附在末尾；无 key 则跳过，纯字幕句也能练。
3. 落盘 `speak-prompts.json`；已有则跳过（除非 `--force`）。

> 预提取里 AI 用量压到最低（每视频最多 1 次调用、只造 ≤5 句扩展）。

---

## 4. 评分 API 与 Prompt

### 4.1 API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/speak/review` | authMiddleware（游客 401） | body `{ cn, en, userText }` → 200 `{ review }` |

- `cn`/`en` 由前端从已加载的 `speak-prompts.json` 取（页面已拿到），服务端只做评分，不去磁盘重复查句子——端点保持纯函数、无状态。
- `userText` 为空 → 400；AI 未配置 → 503 `{error:'AI 未配置（AI_API_KEY 为空）'}`。

### 4.2 评分 Prompt（`server/services/ai/speak.cjs`，复用 `provider.cjs` 的 `extractJson`）

输入：`cn`、`en`、`userText`。系统提示词要点：

> `en` 只是**一种**正确说法，不是唯一答案——凡是语法正确、自然、意思吻合的英文都应给高分。
> 重点评：语法、用词、**搭配是否地道**、是否漏掉/曲解关键信息、是否完整。

严格 JSON 输出：

```json
{
  "score": 85,
  "issues": [
    { "type": "grammar|word_choice|collocation|naturalness|incomplete",
      "location": "I stay here before",
      "problem": "时态错误：before 表过去，需用过去时",
      "suggestion": "I stayed here before",
      "better": "I've stayed here before" }
  ],
  "better": "整句更地道的说法（英文）",
  "praise": "具体夸一句（中文）",
  "lowScoreHint": "score<70 时给具体提示（中文），否则空字符串"
}
```

- `issues[].type` 含 `collocation`（搭配用得对不对）；`better` 满足「这句话也可以这样表达更地道」。
- 反馈语言：`problem/suggestion/praise/lowScoreHint` 用中文，`better` 用英文。
- `lowScoreHint`：`score < 70` 才给，≥70 为空。

### 4.3 降级（禁伪造分数，对齐 AI 对话口径）

| 场景 | 行为 |
|---|---|
| 无 AI key | 503 提示配置；前端显示「配置 AI key 后可用评分」 |
| AI 调用失败 | 503 `{error:'AI 服务暂不可用，请稍后重试'}`；前端**保留识别文本**，可原句重试 |
| AI 输出畸形 | 返回 `score:null` + 提示重试，**不编造分数** |
| 游客 | 401 引导登录 |
| 麦克风不可用 | 打字输入兜底（同现有语音链路） |

### 4.4 Token 控制

一次解析只送 1 句中文 + 1 句英文 + 1 句你说的话；单句独立评分、不带历史上下文。

---

## 5. 页面交互（桌面/手机端统一）

新页面 `src/pages/SpeakPracticePage.jsx`，路由 `/video/:id/speak`。

单列卡片式布局，桌面和手机用**同一套 DOM/CSS**（`max-w-2xl` 居中，只调字号与间距），无 hover 依赖、无横向滚动。

```
┌────────────────────────────────────────────┐
│ ← 返回    自由表达 · 出国旅行的日常   3/28   │
├────────────────────────────────────────────┤
│                                            │
│         我们今天办理了入住。                │   ← 中文大字，居中
│                                            │
│        [🎤 点击录音 / ⏹ 点击停止]           │   ← ≥48px 大按钮
│        识别结果（可编辑文本框）              │   ← ASR 可改错
│                                            │
│            [🔍 解析]                        │
│                                            │
│  ┌─ 解析结果（解析后才出现）──────────────┐  │
│  │  85 分（绿/黄/红按分数着色）           │  │
│  │  你说：We checked in today.           │  │
│  │  参考答案：We checked in today.        │  │
│  │  💡 问题：…（location→suggestion→better）│  │
│  │  ✨ 更地道：…                          │  │
│  │  👍 praise                             │  │
│  │  ⚠️ 低分提示（<70 时）                 │  │
│  └──────────────────────────────────────┘  │
├────────────────────────────────────────────┤
│      [← 上一句]  [🔁 重说]  [下一句 →]      │
└────────────────────────────────────────────┘
```

### 5.1 交互流程

1. **进入**：加载 `speak-prompts.json`（懒加载，同 `wordcard.json`）；若文件不存在，用
   `src/utils/speakPrompts.js` 的本地规则从字幕即时过滤出「字幕原句」练习句（纯本地、零 AI、零 token），
   保证功能始终可用。
2. **看中文 → 说英文**：参考答案（`en`）**解析前隐藏**，点「解析」后才显示。
3. **录音**：点击开始 / 点击停止（桌面鼠标、手机触摸通用）。链路复用现有：
   阿里云 ASR（若配置）→ Web Speech → 打字输入兜底；识别结果进可编辑文本框，ASR 听错可手动改。
4. **重复说**：解析前可随时重录覆盖；解析后点「🔁 重说」清空结果、同一句再来。
5. **解析**：点「🔍 解析」→ `/api/speak/review`，期间按钮禁用 + 「解析中…」；返回后展示分数
   （按高低绿/黄/红着色）、你说的、参考答案、问题列表、更地道说法、praise、低分提示。
6. **导航**：上一句/下一句、进度「3/28」；解析成功后标记该句已练（`speak` 任务，按 prompt index）。
7. **空态**：整条视频没有可练句时显示「该视频暂无可练习的句子」+ 返回按钮。

### 5.2 边界

- 游客点入口 → 登录引导（同 AI 对话）。
- `userText` 为空时「解析」禁用。
- 无 AI key / AI 失败 → 按 4.3 降级提示，识别文本保留可重试。

### 5.3 不做（V1 范畴外）

键盘快捷键、录音回放、句子乱序、SRS 调度、评分历史落库与回看、自由话题（无视频）。

---

## 6. 入口与命名

- 命名：新模式叫 **「自由表达」**，菜单/副标题带「看中文说英文」说明，页面标题「自由表达」。
  （「AI 对话」已被现有多轮对话占用，不复用。）
- 入口：`VideoDetail` 两处「AI 对话」按钮（移动端 header 图标按钮 + 桌面端「💬 AI 对话」文字按钮）
  改为弹菜单二选一：
  - **💬 多轮对话** → `/video/:id/conversation`（现有，不动）
  - **🗣 自由表达 · 看中文说英文** → `/video/:id/speak`（新增）
- 游客点「AI 对话」按钮 → 直接跳登录（与现在一致，不弹菜单）。

---

## 7. 记录集成

- 客户端 `src/utils/practiceRecords.js`：`PRACTICE_TASKS` 加 `speak`，`emptyPracticeData` 加 `speak: []`。
- 服务端 `server/routes/practice.cjs`：`TASKS`/`emptyData`/`parseData`/`summary` 各加 `speak`（按 prompt index 记录）。
- 页面用 `firstUnpracticedIndex` 自动续练到第一句没练过的；已练句显示标记。
- **`learningStatus.js` 的 `TASKS` 保持不变**（仍为 shadow/cloze/translate）——自由表达的
  `prompt 下标 ≠ 字幕下标`，不能塞进按字幕句数算的百分比里，故不影响视频学习状态进度。
- 相关单测同步更新（practiceRecords / practice.cjs / learningStatus 的 TASKS 断言按需调整）。

---

## 8. 验证（Definition of Done）

1. `npm run speak-prompts` 生成 `speak-prompts.json`（本地过滤 + AI ≤5 扩展句；无 AI key 时纯字幕句也能生成）
2. 视频详情页点「AI 对话」→ 弹出「多轮对话 / 自由表达」菜单，两项各进各的页面
3. 游客点入口 → 登录引导；`/api/speak/review` 游客 401
4. 练习页全流程：看中文 → 录音（阿里云 ASR / Web Speech / 打字兜底）→ 可编辑 → 解析 → 分数 + 问题(含搭配) + 更地道 + 参考答案 + praise + 低分提示
5. 允许重复说（解析前重录、解析后「重说」）
6. 参考答案解析前隐藏
7. `speak-prompts.json` 缺失时本地降级出字幕句，功能仍可用
8. 无 AI key / AI 失败 → 明确提示、不伪造分数
9. 桌面 + 手机端都能用且交互一致（响应式单页、≥48px 触控按钮、无 hover 依赖、无横向滚动）
10. 已练句跨设备记录（`speak` 任务）；learningStatus 三项进度不变
11. 现有功能零退化；`npm run lint` 无新增 error、`npm run build` 通过、相关单测通过

---

## 9. 前置条件

- [x] AI_API_KEY 已填入 `.env`（复用现有 AI 对话的 provider 配置）
- [x] 分支 `feat/speak-practice` 已自 main 创建
- [x] 数据目录 `data/` 本地已就绪（字幕 `subtitles.json` 含 `textEn`/`textCn`）
