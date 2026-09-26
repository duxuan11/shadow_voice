# 视频「智能重点词卡」数据落盘设计文档

日期：2026-09-26
状态：已实现

## 背景与目标

视频详情页「智能重点词卡」抽屉有三个 tab，原先数据全部在运行时推导：

| Tab | 原数据来源 | 问题 |
|---|---|---|
| 重点单词 | 字幕自带 `highlightWords` 做词频统计 | 源数据没有关键词的视频（如「机场实用英语」293 条全为 `highlightWords: []`）该 tab 完全空白，且没有空状态 |
| 核心语块 | `src/utils/chunks.js` 本地规则 | 规则库小，能给出的语块有限 |
| 地道表达 | 字幕 `annotations`，无则取长句兜底 | 还算可用 |

用户诉求：**把每条视频的重点单词、常用短语等存到视频文件夹里，进页面时自动加载**；重点单词要带中文释义。

## 已确认的关键决策

1. **生成方式**：用现有 AI Provider（OpenAI 兼容，`.env` 已配 DeepSeek）**一次性离线生成，落盘**。不在运行时调 AI（启动即联网/花钱不可控）。
2. **存放位置**：`data/videos/<episode_dir>/wordcard.json`，与 `subtitles.json` 同目录。
3. **加载方式**：进视频页时**按需 fetch**（与 `subtitles.json` 一致），缺失/失败回退运行时推导，不阻塞主流程。
4. **AI 只负责选词与写释义，不给时间戳**：时间戳/频次/例句全部由本地字幕扫描回填；扫不到的条目丢弃，避免点击跳错位置。
5. **重点单词带中文释义**（`meaning`）。

## 架构

```
data/videos/<episode>/subtitles.json
        │  scripts/build-wordcards.mjs（离线，npm run wordcards）
        │      ├─ AI 选词/释义（server/services/ai/provider.cjs）
        │      └─ src/utils/wordcard.js 本地回填时间/频次/例句
        ▼
data/videos/<episode>/wordcard.json   ← 落盘（data/videos 为 gitignore，随数据卷分发）
        │  前端进视频页 fetch（同 subtitles.json）
        ▼
src/pages/VideoDetail.jsx
   ├─ wordcard state
   └─ derivedData：有 wordcard 用它；无则回退 highlightWords / extractChunks
```

数据文件不入库、不并入 `consolidated.json`：`data/videos` 已 gitignore，生产 Docker 挂载 `./data:/app/data`，`/data` 由 `express.static` 直接托管，新文件零配置即可访问。

## ① 纯逻辑：`src/utils/wordcard.js`

- `normalizeText(text)`：小写、去标点（保留撇号）、合并空白 —— 匹配 AI 给的词/短语。
- `countKeyword(subtitles, word)`：**整词**统计出现次数与每次的句起点时间。
- `locatePhrase(subtitles, phrase)`：子串定位短语，返回首次命中时间与例句。
- `buildWordcard(subtitles, aiJson, meta)`：组装 `wordcard.json`，去重、排序、裁剪上限。

排序：关键词按次数降序；短语按次数降序、再首现时间升序；表达按时间升序。
上限：关键词 30 / 短语 25 / 表达 20。

## ② 生成脚本：`scripts/build-wordcards.mjs`

- 命令：`npm run wordcards`，支持 `--force`、`--video <id|目录名>`、`--dry`。
- 字幕按 `序号. English || 中文` 压缩后交给 AI；prompt 约束词/短语必须真实出现、只输出 JSON。
- `AI_API_KEY` 未配置时直接报错退出，不产出伪造内容。
- 逐视频容错：单条失败继续，最后汇总。

## ③ 前端：`src/pages/VideoDetail.jsx`

- 载入字幕时并发 fetch `wordcard.json`（可选增强）。
- `derivedData`：`wordcard` 存在时用它的 `keywords/phrases/expressions`；否则回退旧逻辑（`highlightWords` + `extractChunks` + 长句兜底），保证老数据不回归。
- tab：`words`（显示 `meaning`）/ `phrases`（原「核心语块」→「常用短语」，显示 `meaning`）/ `expressions`（显示 `meaning`）。
- 三个 tab 都补空状态（此前 `words` 没有）。

## 测试

- `src/utils/wordcard.test.js`（node:test）：归一化、整词匹配（不误命中 `booked`）、短语定位、`buildWordcard` 回填/丢弃/去重/排序、空输入。
- 端到端：无头 Chrome（390×844 移动端）打开「机场实用英语」→ 打开词卡 → 三个 tab 均有内容 → 点击卡片跳转并关闭抽屉。

## 后续可选项

- 需要更高质量的「常用短语」时可扩大 AI prompt 或引入词典。
- 若要支持纯静态 dist 部署（不走 `/data` 静态托管），需把 `wordcard.json` 一并纳入 `copy-data`。
