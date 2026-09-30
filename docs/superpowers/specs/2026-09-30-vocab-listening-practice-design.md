# 生词本「听练一体」设计文档

日期：2026-09-30
分支：feat/vocab-listening-practice
状态：待实现

## 背景与目标

生词本此前已实现「词卡 → 生词本」的收藏、去重、多来源、可移除与状态同步
（见 `2026-09-29-vocabulary-notebook-design.md`）。本次在此基础上新增
「听练一体」：**看中文 + 听英文 TTS + 拼写/听写**，提升生词本中单词、短语、
句子的熟练度。

交互参考 ComeKey 的听音拼写，但**只借鉴交互逻辑，不复制代码**。

**功能入口：个人中心 → 生词本。**

**明确不做**：间隔重复算法、记忆曲线、AI 自动出题、「只练生疏词」模式、
新的生词数据来源。

## 术语与类型映射

现有 `vocabulary.type` 只有 `word` / `phrase` / `core_phrase` 三种。听练页面把
`core_phrase` 展示为「句子」，**不新增 `sentence` 类型、不做数据迁移**：

| 存储 type | 听练 UI 名称 |
| --- | --- |
| `word` | 单词 |
| `phrase` | 短语 |
| `core_phrase` | 句子 |

## 数据模型（最小迁移）

`vocabulary` 表新增 3 列，沿用 `server/db.cjs` 的 `ensureColumn` 迁移机制，
并做幂等回填：

```
vocabulary.practice_count     INTEGER DEFAULT 0
vocabulary.correct_count      INTEGER DEFAULT 0
vocabulary.last_practiced_at  TEXT
```

- 统计与生词条目同生命周期：移除生词 → 统计一并删除，符合「与现有生词本关联」。
- `GET /api/vocab` 的 `toEntry` 增加返回这 3 个字段。
- **熟练度不落库**，由 `correct_count / practice_count` 实时推导，避免状态不一致。

## 后端 API

复用现有 `/api/vocab`（GET / POST / DELETE）不变，仅新增一个接口：

```
POST /api/vocab/practice
body: { word: string, correct: boolean }
```

- `authMiddleware` 鉴权，游客 401。
- 对 `word` 做 `normalizeKey`；查不到当前用户的条目 → 404。
- `practice_count += 1`；`correct_count += correct ? 1 : 0`；
  `last_practiced_at = datetime('now')`。
- 返回 `{ ok: true, entry }`（`entry` 含最新统计）。
- `correct` 非布尔值 → 400。

各类型合计由前端基于**已拉取的** `/api/vocab` 列表本地汇总，不新增 GET 接口。

## 前端

### 新增文件

- `src/utils/spellCheck.js`：把 `DictationPage.jsx` 内的
  `checkSpelling` / `tokenize` / `normalizeText` / `isAllCorrect` 抽成纯函数模块。
- `src/utils/vocabPractice.js`：纯函数 —— 按类型筛选、洗牌组轮、熟练度与等级、
  按类型汇总统计、构建单条成轮队列。
- `src/pages/VocabPracticePage.jsx`：听练页。
- 路由 `/vocab/practice`（挂在 `ProtectedRoute` 内）。

### 修改文件

- `src/pages/DictationPage.jsx`：改为 import 抽取后的引擎（视频听写行为不变）。
- `src/pages/Profile.jsx`：把「最近生词」区升级为「生词本」区，加入「听练」主入口。
- `src/pages/LearningRecords.jsx`：生词本 tab 增加「听练」按钮；每张卡片增加
  「听练」快捷入口与统计徽章（`练习 n 次 · 正确率 x%`）。
- `src/index.css`：听练页样式（尽量复用现有 `dictation-*` / `spell-*` 类）。
- `src/main.jsx`：注册路由。

### 页面流程

1. **准备**
   - 类型选择：单词 / 短语 / 句子 / 全部（带数量）。
   - 按类型统计表：练习次数 / 正确次数 / 熟练度。
   - 「开始练习」；生词本为空 → 提示先添加生词。
   - 支持深链 `?word=<content>&type=<type>` → 单条成轮（从卡片快捷入口进入）。
2. **出题**
   - 题目队列 = 符合类型的全部条目，开始本轮时**洗牌一次**，一轮过一遍。
   - 自动播放英文 TTS：复用 `createSpeaker(authFetch)`（服务端 Edge/Aliyun → mp3，
     失败降级浏览器 SpeechSynthesis）。不为 TTS 写新逻辑。
   - 中文释义默认隐藏，「显示中文」可切换。
   - 输入框 + Enter 提交；「再听一次」重播。
3. **比对**（复用现有 `.spell-*` 样式）
   - 逐词区分 **正确 / 错误 / 遗漏 / 多余**，并给出正确原文、中文释义、
     单词音标。
   - 操作按钮：**再听一次 / 显示答案 / 再练一次 / 下一题**。
   - 支持**移除生词本**：调用现有 `DELETE /api/vocab/:word`，移除后从队列剔除
     并刷新列表。
4. **一轮完成**
   - 本轮回顾：已练 / 正确 / 正确率；「再来一轮」重新洗牌。

### 计分规则

每道题的**首次提交**才写入统计；「再练一次」是对同一题的重练，不重复计数。
熟练度即「首次作答正确率」，避免重练刷高熟练度。

### 熟练度

```
proficiency = round(correct_count / practice_count * 100)   // practice_count = 0 → 未练
```

等级：`< 60` 生疏；`60–84` 一般；`≥ 85` 熟练。

## 入口

- **主入口**：个人中心 → 生词本 区的「听练」按钮 → `/vocab/practice`。
- **次级入口**：生词本页面（学习记录 → 生词本）提供同样的「听练」按钮，
  并支持单条卡片快捷听练。

两处指向同一页面、同一份服务端数据。

## 手机端与错误处理

- 按钮 ≥ 44px，`touch-action: manipulation`，不依赖 hover；统计表窄屏横向滚动；
  长单词/短语 `overflow-wrap: anywhere` 换行。
- TTS 失败静默降级浏览器合成；双降级失败仍可手动输入，不阻塞练习。
- 游客生词本为空（401）→ 提示「登录后可练习生词本」。
- 所选类型无条目 → 友好空状态。

## 测试与验证

- `src/utils/spellCheck.test.js`：正确 / 错误 / 遗漏 / 多余、标点、缩写，
  锁定抽取重构不回归。
- `src/utils/vocabPractice.test.js`：类型筛选 + 洗牌、单条成轮、熟练度阈值、
  按类型汇总。
- `server/routes/vocab.test.cjs` 增补：练习计数（正确 / 错误）、未收录 404、
  游客 401、多用户隔离、列表返回统计字段。
- 运行：`node --test`、`npm run lint`、`npm run build`。
  （Playwright 未安装，本次不做 E2E。）

## 修改文件清单

**新增**

- `src/pages/VocabPracticePage.jsx`
- `src/utils/spellCheck.js`
- `src/utils/spellCheck.test.js`
- `src/utils/vocabPractice.js`
- `src/utils/vocabPractice.test.js`

**修改**

- `server/db.cjs`
- `server/routes/vocab.cjs`
- `server/routes/vocab.test.cjs`
- `src/pages/DictationPage.jsx`
- `src/pages/Profile.jsx`
- `src/pages/LearningRecords.jsx`
- `src/main.jsx`
- `src/index.css`
- `README.md`
