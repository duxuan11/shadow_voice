# 设计文档 — 文本练习（Text Practice）

> 日期：2026-10-26 ｜ 项目：shadow_voice ｜ 分支：feat/text-practice（自 main 436f029 新建）
> 状态：已实现（2026-10-26，分支 feat/text-practice；端到端脚本 `scripts/verify-text-practice.mjs`）

---

## 1. 背景与目标

### 1.1 一句话

> 把工作时遇到的一段英文（技术文档、论文摘要、GitHub README、邮件）粘进来 →
> 系统自动拆句并翻译成中文 → 逐句跟读练发音、看中文回译英文 → 进度独立保存，随时回来继续。

### 1.2 为什么做

视频学习受内容源限制：真实工作里要读的是自己的文档，不是库里那几十个视频。
本功能把「跟读 + 汉译英」这两项已经验证有效的训练，从视频字幕解耦到任意文本。

### 1.3 与现有功能的关系（只增不改）

| 已有能力 | 位置 | 本功能怎么用 |
|---|---|---|
| 发音评分（阿里云口语评测） | `src/components/ShadowingEvaluator.jsx` | 直接复用，`refText` = 当前句；**只加一个可选 `onResult` 回调**，不改变现有调用方行为 |
| 英语播放 TTS | `src/utils/tts.js`（`createSpeaker`） | 逐句播放原声 |
| 语音输入 | `src/utils/useSpeechInput.js`（阿里云 ASR → Web Speech → 打字兜底） | 汉译英语音作答 |
| 单句中译英评分语义 | `server/services/ai/speak.cjs`（`parseReview`） | 新 prompt（带技术文档上下文），**复用 `parseReview`** 做分数钳制/字段容错 |
| AI Provider | `server/services/ai/provider.cjs` | `chat / extractJson / isConfigured`，零新依赖 |
| 数据表迁移方式 | `server/db.cjs`（`CREATE TABLE IF NOT EXISTS`） | 新增两张表，同款写法 |
| 个人中心区块样式 | `src/index.css` 的 `.profile-section*` | 新入口沿用同一套 class |
| 路由 | `src/main.jsx` | 新增 `/texts`、`/texts/:id` 两条 |

**明确不做**：不动 `VideoDetail` / `video_*` / `vocabulary` / `dictation_records` / `practice_records` / `dialogue_*` / `speak-prompts.json`；
不改视频学习主界面结构；不做 PDF 批量导入；不做 AI 教师/多轮问答。

### 1.4 与其它练习入口的区别

| | 生词·听练 | 视频跟读 | 中译英对话 | **文本练习（本功能）** |
|---|---|---|---|---|
| 内容源 | 生词本 | 视频字幕 | AI 生成对话 | **用户粘贴的任意英文** |
| 中文来源 | 生词翻译 | 字幕自带 | AI 生成 | **AI 批量翻译（术语保真）** |
| 进度归属 | 生词条目 | `video_progress` | `dialogue_progress` | **`text_progress`（完全独立）** |

---

## 2. 产品定义

### 2.1 用户已确认的决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 入口位置 | 个人中心「生词本」**下方**新增一栏「文本练习」，点击进入列表页；不进视频学习主界面 |
| 2 | 中文翻译来源 | 保存时 AI 自动批量翻译一次；AI 不可用/失败时文本照常保存，标「中文未生成」+ 重试按钮，**绝不伪造翻译** |
| 3 | 跟读评分 | 沿用阿里云口语评测（与视频跟读同一条链路）；游客引导登录 |
| 4 | 编辑正文 | 重新切句 + 清空该文本的练习进度（前端二次确认） |
| 5 | 范围 | 只做最小闭环：列表 → 粘贴保存 → 逐句跟读 / 汉译英 → 保存进度并继续 |

### 2.2 我做的决定（评审时可推翻）

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | 存储 | 服务端 SQLite 两张新表，进度行随文本创建 | 与现有全部学习数据一致，跨设备可用 |
| 2 | 共享账号 | 游客可见入口，点进去引导登录 | 与「中译英对话」「自由表达」一致 |
| 3 | 切句位置 | **服务端**切句（`server/lib/textSentences.cjs`），前端只渲染结果 | 单一事实来源；翻译也要服务端做，避免前后端两套切句算法漂移 |
| 4 | 讲块粒度 | 一个练习句 = 一个 `{i, en, cn, section}` | 跟读需要单句、汉译英需要单句，天然对齐 |
| 5 | 跟读结果落库 | 只存每句**最佳分** + 练习次数（`shadow_json`） | 够用于进度展示与「这句子练过」，不膨胀 |
| 6 | 汉译英落库 | 每句一条作答记录（含分数/问题/更地道说法/是否已看原文） | 与 `dialogue_progress.answers_json` 同构，重进可回放 |
| 7 | 重练 | 不做「重置进度」按钮；要重练就编辑正文或删除重建 | 最小闭环，少一个状态机 |
| 8 | 完成态 | 最后一句点「完成练习」→ `status='completed'`，页面显示**本地统计的完成面板**（非 AI 总结），列表显示「已完成」徽章 | 只需一个字段 + 三个本地计数，不做 AI 总结 |
| 9 | 文档规模上限 | 单篇正文 ≤ 20000 字符、≤ 200 个练习句 | 控制 LLM 调用次数与 DB 体积 |
| 10 | 改名 | `PUT` 只在**正文变化**时重置进度；只改标题不动进度 | 改名把 200 句进度清空是数据丢失 |
| 11 | 级联删除 | **不开** `PRAGMA foreign_keys`（会改变所有既有表的删除语义）；`DELETE` 路由显式删 `text_progress` 再删 `text_docs` | 不引入跨功能回归 |
| 12 | 单句长度 | 切句 `maxChars = 180`（≈ 15–20 秒朗读），适配跟读 30 秒录音上限 | 跟读是主用途，超长句必然被截断 |
| 13 | 列表排序 | 按 `COALESCE(text_progress.updated_at, text_docs.updated_at) DESC` | 「最近」应指最近练过 |
| 14 | 逐句播放评分字段 | `best` = 评测 `overall`；`overall` 为 null 时不落库 | 与用户屏幕上看到的分一致 |

---

## 3. 数据模型

新增两张表（`server/db.cjs`，幂等 `CREATE TABLE IF NOT EXISTS`，随现有 `initSchema()` 执行）：

```sql
CREATE TABLE IF NOT EXISTS text_docs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  source_text    TEXT NOT NULL,           -- 用户粘贴的原始 Markdown 全文
  sentences_json TEXT NOT NULL,           -- [{ i, en, cn, section }]
  truncated      INTEGER NOT NULL DEFAULT 0, -- 1 = 正文超 200 句被截断
  model          TEXT,                    -- 翻译所用模型（可空）
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
)

CREATE TABLE IF NOT EXISTS text_progress (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id           INTEGER NOT NULL UNIQUE REFERENCES text_docs(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shadow_cursor    INTEGER NOT NULL DEFAULT 0,
  translate_cursor INTEGER NOT NULL DEFAULT 0,
  shadow_json      TEXT NOT NULL DEFAULT '[]',   -- [{ index, best, attempts, updatedAt }]
  answers_json     TEXT NOT NULL DEFAULT '[]',   -- 见 §3.3
  status           TEXT NOT NULL DEFAULT 'active', -- active | completed
  updated_at       TEXT DEFAULT (datetime('now'))
)
```

### 3.1 `sentences_json` 结构

```json
[
  { "i": 0, "en": "U-Net consists of an encoder and a decoder.", "cn": "U-Net 由编码器和解码器组成。", "section": "U-Net" },
  { "i": 1, "en": "PaCMAP preserves both local and global structure.", "cn": "", "section": "U-Net" }
]
```

- `i` 为数组下标（0 起，连续），服务端生成，客户端不可改。
- `cn` 允许为空字符串 = 「中文尚未生成」，前端据此显示重试入口。
- `section` 为最近的 Markdown 标题文本（无标题时为 `""`），仅用于 UI 分组展示，**不参与评分**。

### 3.2 `shadow_json` 结构

```json
[{ "index": 0, "best": 86, "attempts": 2, "updatedAt": "2026-10-26T09:12:00.000Z" }]
```

`best` 取历史最高分（`Math.max`），`attempts` 服务端累加。

### 3.3 `answers_json` 结构（汉译英）

```json
[{
  "index": 0,
  "userText": "U-Net is made of an encoder and a decoder.",
  "score": 88,
  "verdict": "correct",
  "issues": [{ "type": "naturalness", "location": "is made of", "problem": "...", "suggestion": "...", "better": "consists of" }],
  "better": "U-Net consists of an encoder and a decoder.",
  "praise": "术语保留正确。",
  "attempts": 1,
  "revealedAnswer": false,
  "updatedAt": "2026-10-26T09:20:00.000Z"
}]
```

`verdict ∈ correct | minor | wrong`；`score` 可为 `null`（AI 输出畸形时不伪造分数）。

> 注：`PRAGMA foreign_keys` 全局未开启（`sql.js` 默认 off），因此上面的 `ON DELETE CASCADE` 只是文档性声明；
> 删除文本时由路由**显式**删除 `text_progress` 行，不依赖级联。

---

## 4. 切句器（`server/lib/textSentences.cjs`）

导出：

| 函数 | 签名 | 说明 |
|---|---|---|
| `splitMarkdown` | `(text, opts?) -> { units, truncated }` | 主入口；`units: Array<{en, section}>`；`opts = { maxUnits = 200, maxChars = 180 }`；`truncated = 有句子被上限丢弃` |
| `splitEnglishSentences` | `(paragraph) -> string[]` | 段落内按句切分（含缩写/小数/版本号保护） |
| `stripMarkdownInline` | `(s) -> string` | 去行内 Markdown 语法、保留可见文本与术语 |
| `MAX_UNITS` | `200` | 硬上限 |

### 4.1 处理规则（顺序执行）

1. 归一化：`\r\n|\r → \n`，制表符 → 空格，连续 3+ 空行 → 1 空行。
2. 丢弃围栏代码块 ``` ``` … ``` ```（整块，含内容）和 HTML 注释 `<!-- … -->`。
3. 逐行处理：
   - ATX 标题 `^#{1,6}\s+`：**只**更新 `section`（去 `#` 后的文本），不产生练习句。
   - 竖线分隔行（`| --- | :---: |`）与水平线（`---`、`***`、`___`）：丢弃。
   - 表格行 `^\s*\|`：按 `|` 切单元格，**每个非空单元格各自成为一句**（不拼接，避免 TTS/翻译读出怪异长串）。
   - 列表项 `^(\s*)([-*+]|\d+[.)])\s+`：去掉标记后按段落处理；有序列表的编号不保留在句子里。
   - 引用 `^>\s?`：去掉 `>` 后按段落处理。
   - 块级 HTML 标签行：丢弃标签，保留文本。
   - 空行：分段。
   - 其余：并入当前段落缓冲区。
4. 段落内：多行用单空格拼接 → `stripMarkdownInline` → `splitEnglishSentences`。
5. 后处理：
   - 丢弃不含 `[A-Za-z]` 的片段（纯中文/纯数字/纯符号）。
   - 丢弃 `trim().length < 2` 的片段。
   - 单句超过 `maxChars`（默认 180，≈ 15–20 秒朗读 < 跟读 30 秒上限）时在 `"; "` → `" — "` → `", "` → 空格 的优先顺序就近切分（保证跟读不至于一口气 400 字符）。
   - 按出现顺序取前 `maxUnits` 句，重排 `i`。

### 4.2 句末判定与保护（`splitEnglishSentences`）

切分点：`[.!?…]` 后跟闭引号/括号（`"'”’)`）任意个，再看是否为空白或结尾。

**不切**的情形：

- 缩写表命中（大小写不敏感，覆盖 `e.g.` `i.e.` `etc.` `vs.` `Fig.` `Eq.` `Sec.` `Tab.` `Ref.` `al.` `et al.` `cf.` `resp.` `approx.` `Dr.` `Mr.` `Mrs.` `Ms.` `Prof.` `Inc.` `Ltd.` `Co.` `St.` `No.` `min.` `max.` `avg.`）。
- 点号前后都是数字（`3.5`、`v1.2`、`0.92`）。
- 点号链形态的缩写（`U.S.`、`Ph.D.`、`A.I.`）：`/(?:[A-Za-z]\.){2,}$/`。
- 单字母首字母（`J. Smith`）：前一个 token 为单个大写字母。
- 位于行内代码 `` ` `` 内：切分前把 `` `…` `` 内容替换为占位符，切分后还原（术语里的点绝不切句）。

### 4.3 术语保真（切句层）

`stripMarkdownInline` 只去掉语法符号，**不改写内容**：`` `SAM` `` → `SAM`，`[PaCMAP](url)` → `PaCMAP`，`**[U-Net](url)**` → `U-Net`，
`**bold**`/`*it*`/`~~del~~` 去标记留字。`SAM`、`UMAP`、`YOLO`、`U-Net`、`PaCMAP` 等原样保留，不做大小写/连字符「修正」。

> 实现取舍：句子载荷**不携带** `terms` 字段。反引号在切句后即被去除，代码标识符作为普通词留在 `en` 里；
> 「不翻译代码标识符」由翻译 prompt 的通用规则约束（§5.1），而不是靠占位符（占位符会污染 TTS/评测文本）。

---

## 5. AI 服务（`server/services/ai/textPractice.cjs`）

| 函数 | 签名 | 说明 |
|---|---|---|
| `buildTranslatePrompt` | `({ title, sentences }) -> { system, user }` | `sentences: string[]`，要求逐句译成中文并保术语 |
| `normalizeTranslations` | `(json, { count }) -> { ok, items, missing }` | `items: Array<{i, cn}>`；`ok` = 全部 `count` 句都有非空 `cn` |
| `buildSentenceReviewPrompt` | `({ title, en, cn, userText, attempt }) -> { system, user }` | 汉译英评分 |
| `normalizeSentenceReview` | `(json) -> review` | 复用 `speak.cjs` 的 `parseReview`，补 `verdict`（attempt 只进 prompt，不参与归一化） |
| `TRANSLATE_CHUNK` | `50` | 每 50 句一次 AI 调用，串行 |

### 5.1 翻译 prompt 关键约束

- 输入是「技术/学术英语」，输出是给中国工程师看的**自然口语化中文**（便于回头做回译）。
- **原样保留**：专有名词与缩写（SAM、UMAP、YOLO、U-Net、PaCMAP、GPT、Transformer 等）、模型/库/产品名、代码标识符与函数名、URL、数字、版本号、单位。
- 驼峰/下划线/连字符形态的标识符（`getUserById`、`top_k`、`U-Net`、`mIoU@0.5`）**绝不翻译、不改大小写、不加空格**。
- 不增删信息、不解释、不加译注。
- 只输出 JSON：`{"items":[{"i":0,"cn":"..."}]}`，覆盖全部 `i`。

### 5.2 评分 prompt 关键约束（允许同义表达）

- 原文只是**一种**正确说法，语义等价、语法正确、术语保真的其它英文同样给高分。
- 检查项：语法、用词/搭配、是否漏译或曲解、术语是否被错误改写（如把 `U-Net` 写成 `Unet` 要指出）。
- 输出 JSON：`{"verdict":"correct|minor|wrong","score":0-100,"issues":[{"type":"grammar|word_choice|collocation|naturalness|incomplete|term","location":"","problem":"","suggestion":"","better":""}],"better":"","praise":"","lowScoreHint":""}`。
- `verdict` 非法时按分数派生：`>=85 correct`、`>=60 minor`、否则 `wrong`；`score === null` 时 `wrong` + `answerHidden=false`（不伪造，但也不隐藏原文）。

---

## 6. API（`server/routes/texts.cjs`，挂载 `/api/texts`）

全部 `authMiddleware`；游客 401。所有"自己的文档"校验失败 → 403，不存在 → 404。

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/texts` | — | `{ docs: DocSummary[], aiConfigured }` |
| POST | `/api/texts` | `{ title, text }` | 201 `{ doc, progress, translation }` |
| GET | `/api/texts/:id` | — | `{ doc, progress, aiConfigured }` |
| PUT | `/api/texts/:id` | `{ title?, text? }` | `{ doc, progress, translation }` |
| DELETE | `/api/texts/:id` | — | 204 |
| POST | `/api/texts/:id/translate` | — | `{ doc, translation }` |
| POST | `/api/texts/:id/review` | `{ index, userText }` | `{ review, attempts, progress }` |
| POST | `/api/texts/:id/reveal` | `{ index }` | `{ progress }` |
| POST | `/api/texts/:id/shadow` | `{ index, score }` | `{ progress }` |
| PUT | `/api/texts/:id/progress` | `{ shadowCursor?, translateCursor?, status? }` | `{ progress }` |

### 6.1 载荷结构

```ts
DocSummary = { id, title, sentenceCount, cnReady, status, shadowDone, translateDone, updatedAt }
Doc        = { id, title, sourceText, sentences: Sentence[], cnReady, missingCn, aiConfigured, createdAt, updatedAt }
Progress   = { docId, shadowCursor, translateCursor, status, shadow: ShadowRecord[], answers: Answer[], updatedAt }
translation = 'ok' | 'partial' | 'unavailable'   // unavailable = AI 未配置/调用失败
```

### 6.2 校验与边界

| 场景 | 结果 |
|---|---|
| `title` 空 / > 100 字符 | 400 `标题不能为空（最多 100 字）` |
| `text` 空 / > 20000 字符 | 400 `正文不能为空（最多 20000 字符）` |
| 切句后 0 句 | 400 `没有找到可练习的英文句子`（典型：只贴了代码块） |
| 切句后 > 200 句 | 截断前 200 句，`truncated=1` 落库，`Doc`/`DocSummary` 带 `truncated` |
| `index` 非整数 / 越界 | 400 `句子索引无效` |
| `userText` 空 / > 1000 字符 | 400 `缺少你的英文答案` |
| `score` 非 0–100 有限数字 | 400 `评分无效` |
| `PUT /progress` cursor 越界（合法区间 `0..total`） | 400 `进度无效` |
| AI 未配置 | 读写照常；`translation: 'unavailable'`；`review` → 503 |
| AI 调用失败/输出畸形 | 翻译：保留已成功分块，`partial`；评分：503 `评分失败，请稍后重试` |
| 翻译分块重试 | 每块最多 2 次（对齐 `dialogue.cjs` 的做法） |

### 6.3 保存流程（POST / PUT 共用 `translateDoc`）

1. `splitMarkdown(text)` → 句子 `[{i, en, cn:'', section}]`
2. 写库：POST 建行 + 建 `text_progress`；PUT **只在 `text` 被传入时**重新切句并重置进度行（cursors=0、shadow/answers=`[]`、status=active），
   只传 `title` 时仅更新标题与 `updated_at`，**不碰 `sentences_json` 与进度**
3. 若 `isConfigured()`：按 50 句分块串行翻译；每块 `chat(...)` → `extractJson` → `normalizeTranslations`；失败块最多重试 1 次；合并后回写 `sentences_json`（只写非空 `cn`）
4. 返回 `translation`：全有 = `ok`；部分有 = `partial`；一句都没有 = `unavailable`
5. `POST /translate`：只补 `cn` 为空的句子（已翻译的不重译），语义与 3 相同；AI 未配置时返回 **503**（这是用户主动发起的 AI 动作），
   而保存路径仍返回 `translation: 'unavailable'` 且 200

> 翻译是**保存路径的副作用**，失败绝不让保存失败。

### 6.4 review 流程

1. 取 doc（校验归属）→ `sentences[index]`
2. `cn` 为空时仍可评分（`buildSentenceReviewPrompt` 的 `cn` 允许空，prompt 自动省略中文行）
3. `attempts` 服务端从已有记录 +1（上限 20）
4. `chat` → `extractJson` → `normalizeSentenceReview`；解析失败返回 `review.parseError=true` + `score=null`（不写库，让用户重试）
5. 成功则 upsert `answers_json`（保留 `revealedAnswer`）、更新 `updated_at`；**不改 `status`**
6. `reveal`：只给**已存在**的记录置 `revealedAnswer=true`（未作答不建假记录，对齐 `dialogue.cjs`）

### 6.5 `status` 与 cursor 语义

- `PUT /progress` 接受**部分** body：只更新传入的 `shadowCursor` / `translateCursor` / `status`，其余保持原值。
- cursor 合法区间 `0..总句数`（`total` 合法 = 「已练到末尾」），**不会**因 cursor 到 `total` 而自动变 `completed`（只有显式传 `status` 才变）。
- `POST /shadow`、`POST /review` **不碰** `status`：完成后回来重练不会把徽章弄丢；只有前端点「继续练习」时显式 `PUT { status:'active' }`。
- 允许在仍有未答句时被标记 `completed`（用户的判断）；面板里的计数用真实条数，不假设 `N == total`。

---

## 7. 前端

### 7.1 路由（`src/main.jsx`）

```jsx
<Route path="texts" element={<TextPracticePage />} />
<Route path="texts/:id" element={<TextDocPage />} />
```

两条都在 `App` 壳内（保留顶部导航），页面自身 `min-h-screen bg-slate-50`。

### 7.2 个人中心入口（`src/pages/Profile.jsx`）

「生词本」区块**之后**新增同结构区块：

- 标题：`<FileText size={18} /> 文本练习`
- 右侧：`<button className="profile-section-link">全部文本 ›</button>` → `/texts`
- 内容：
  - 游客：`登录后可保存并跨设备同步文本练习` + 「登录 / 注册」按钮 → `/login`
  - 非游客且无文本：`还没有文本` + 提示 `粘贴英文技术文档、论文摘要、README 或邮件，生成跟读与汉译英练习`
  - 非游客且有文本：最多 4 条最近文档（标题 + `N 句 · 跟读 x/N · 翻译 y/N` + 状态徽章），点击 → `/texts/:id`
- 数据：Profile 的 `Promise.all` 增加 `isGuest ? { docs: [] } : authFetch('/texts')`；失败降级为空列表（不影响整页）
- 排序/显示的 `updatedAt` 取服务端返回的 `COALESCE(progress.updated_at, docs.updated_at)`（服务端排序，前端不再排）

### 7.3 列表页 `src/pages/TextPracticePage.jsx`（`/texts`）

- 顶部：返回个人中心（`ArrowLeft` → `/profile`）+ 标题「📄 文本练习」
- 「+ 粘贴新文本」按钮 → 同页展开编辑卡（`mode: 'list' | 'new'`）：
  - 标题输入（`maxLength=100`）、正文 `textarea`（`maxLength=20000`，`rows≈10`，提示支持 Markdown/列表/表格）
  - 实时字数；「保存并生成中文」主按钮（保存中禁用 + spinner）
  - 保存成功 → 跳到 `/texts/:id`；失败 → 卡内红字错误
- 文档卡：标题、`12 句`、`跟读 3/12`、`翻译 5/12`、中文未生成时黄色徽标「中文未生成」、状态徽章（进行中/已完成）、更新时间
  - 操作：「继续学习」（主按钮 → `/texts/:id`）、「编辑」（标题/正文，**改标题不清进度**；改正文会清进度并弹确认）、「删除」（`confirm` 二次确认）
  - 编辑复用同一编辑卡（`mode:'edit'`，预填标题与 `sourceText`）
- 状态：loading（spinner）/ error（重试）/ 空态
- 游客：`useEffect` 里 `navigate('/login', { state: { from: '/texts' } })`

### 7.4 详情页 `src/pages/TextDocPage.jsx`（`/texts/:id`）

- sticky 头部：返回（→ `/texts`）、文档标题（truncate）、Tab 切换「逐句跟读 / 汉译英」、`⋯` 菜单（重新生成中文 / 编辑标题 / 删除）
  - 「编辑标题」只 `PUT { title }`，不清进度
  - 「重新生成中文」调 `POST /translate`（只补空 `cn`）
- 进度条：当前 tab 的 `done/total` + 百分比
- 顶部横幅（按需）：
  - 中文未生成：「有 N 句还没有中文翻译」+「生成中文翻译」按钮（`POST /translate`）
  - 截断提示（若 `truncated`）：`正文较长，仅保留前 200 句`
  - AI 未配置：`AI 未配置，中文翻译与评分不可用`
- **逐句跟读 Tab**
  - 当前句卡：`section` 小标 + 英文原句（大字号）+ 🔊 播放（`createSpeaker`，切换句子时 `stop()`）+ `ShadowingEvaluator key={index} refText={en} onResult={saveShadow}`
  - 上一句 / 下一句 / 跳句条（横向可滚动的句号点，已练过的点变绿、当前点高亮）
  - `saveShadow`：仅当 `result.overall` 是有限数字才 `POST /texts/:id/shadow { index, score: overall }`（失败静默提示，不阻塞跟读）；成功后 `best` 取历史最大值，游标推进到下一句
  - 中文可折叠显示（「显示中文」小按钮），用于对照
- **汉译英 Tab**
  - 当前句卡：中文译文（大字号；为空时显示「中文未生成，可先练跟读或点击生成」）+ 输入框（`textarea`）+ 🎤 语音输入（`useSpeechInput`）+ 「对照原文」（切换显示英文）+
    「提交答案」（`POST /review`）
  - 结果卡：`verdict` 徽章 + 分数 + `issues` 列表（类型标签 + 问题 + 建议 + 更地道说法）+ `better` + `praise`；`parseError` 时提示重试
  - 「对照原文」：该句**已有作答记录**后才可点，点击时调 `POST /reveal` 落 `revealedAnswer`；未作答时按钮禁用并提示「先提交一次答案」（对应需求「输入英文答案后，可查看原文」）
  - 上一句 / 下一句；最后一句显示「完成练习」（`PUT /progress { status:'completed' }`）→ 完成面板（`跟读 x/N · 翻译 y/N · 平均分` +「继续练习 / 返回列表」）；
    `status==='completed'` 时重进默认显示该面板，「继续练习」→ `PUT { status:'active' }` 并回到 `resumeIndex`
  - 重新进入时按 `translate_cursor` 恢复（`resumeIndex`），并回显该句已存作答（`reviewFromSavedAnswer`）
- 删除后 `navigate('/texts')`
- 错误：404 → 「文本不存在或已删除」+ 返回列表；网络错误 → 重试

### 7.5 工具模块 `src/utils/textPractice.js`

| 函数 | 签名 | 说明 |
|---|---|---|
| `cnReady` | `(sentences) -> boolean` | 全部 `cn` 非空 |
| `missingCnCount` | `(sentences) -> number` | 空 `cn` 的句数 |
| `shadowDoneCount` | `(progress) -> number` | `shadow` 条数 |
| `translateDoneCount` | `(progress) -> number` | `answers` 条数 |
| `percent` | `(done, total) -> number` | 0–100 整数，`total<=0 → 0` |
| `resumeIndex` | `(records, cursor, total) -> number` | 从 `cursor` 起找第一条无记录的句子；`cursor >= total` 或都练完则返回 `min(cursor, total-1)` |
| `findShadow` | `(shadow, index) -> record\|null` | 该句最佳分记录 |
| `reviewFromSavedAnswer` | `(answer) -> review\|null` | 把落库记录还原成结果卡数据结构 |
| `avgScore` | `(answers) -> number\|null` | 忽略 `score===null` |
| `statusLabel` | `(status) -> string` | `进行中` / `已完成` |

---

## 8. 异常与边界（实现清单）

1. **AI 未配置**：保存成功、列表正常、详情页显示禁用态提示；评分按钮点击后 503 → 提示「AI 服务暂不可用」。
2. **翻译部分失败**：保留成功块，`partial`；横幅按 `missingCn` 显示，可重试（重试只补空 `cn` 的句子）。
3. **只粘代码块 / 没有英文**：400，输入卡内红字，不清空输入。
4. **超长正文**：> 20000 字符前端 `maxLength` 拦截 + 计数变红；切句 > 200 句截断并提示。
5. **重复点击保存/评分**：按钮 `disabled` + 进行中标记，避免并发写库。
6. **麦克风/ASR 不可用**：`useSpeechInput` 已回退到打字；错误显示为小字提示，不阻塞提交。
7. **阿里云评测不可用/明文 HTTP**：`ShadowingEvaluator` 已有错误 UI 与重试；本页不额外处理。
8. **编辑正文**：前端 `window.confirm` 明确「会重新拆句并清空本模板进度」；取消则不提交。
9. **删除**：`window.confirm`；成功回列表并移除该卡。
10. **越权/不存在**：403/404 → 详情页错误卡 + 返回列表。
11. **移动端**：375–430px 下按钮不换行错位、句卡内 `textarea` 不溢出、sticky 头部不遮挡内容；桌面端 1280px 下卡片 `max-w-3xl` 居中。
12. **不影响现有功能**：`ShadowingEvaluator` 的 `onResult` 为可选参数；**允许修改的既有文件仅限**
    `src/main.jsx`（加两条路由）、`src/pages/Profile.jsx`（加一个区块）、`src/components/ShadowingEvaluator.jsx`（加可选回调）、
    `server/db.cjs`（加两张表）、`server/index.cjs`（挂载路由）；
    不得改动 `VideoDetail.jsx` / `DictationPage` / `ShadowingPage` / `ClozePage` / `ConversationPage` / `SpeakPracticePage` / `DialoguePage` / `Library` / `LearningRecords` / 既有路由与既有表。

---

## 9. 验证计划

- 单测（`node --test`）：
  - `server/lib/textSentences.test.cjs`：段落/列表/表格/标题/代码块、缩写与小数、术语保留、长句切分、空输入、上限截断。
  - `server/services/ai/textPractice.test.cjs`：prompt 含术语保真指令、`normalizeTranslations` 缺项/脏数据、`normalizeSentenceReview` verdict 派生与 `parseError`。
  - `server/routes/texts.test.cjs`：401/400/403/404、保存→列表→详情、**改名不清进度**、改正文清进度、delete 显式删进度行、shadow（best 取最大）、review（未配置 503）、reveal 不造假、progress 部分更新与越界。
  - `src/utils/textPractice.test.js`：上述工具函数（含 `resumeIndex` 在 `cursor>=total` 时的回退）。
- 回归：`node --test "server/**/*.test.cjs" "src/**/*.test.js"`（本机 Node 22 不接受目录参数）、`npm run lint`、`npm run build`。
- 浏览器端到端：`node scripts/verify-text-practice.mjs`（自带假 AI + headless Chrome，覆盖入口/保存/翻译/评分/续练/移动端/改名/删除/既有页面无控制台错误）。
- 手动：个人中心 → 文本练习 → 粘贴一段含 Markdown 表格与 `SAM`/`U-Net`/`PaCMAP` 的 README → 保存 → 中文生成正确、术语未被翻译 → 跟读一句出分 → 汉译英一句出评分（换一种合理说法仍高分）→ 退出重进进度还在 → 只改标题进度不丢 → 改正文确认后进度清零 → 删除回到列表 → 「完成练习」后重进仍显示完成面板 → 视频学习各页面无变化。
