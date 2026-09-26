# 视频重点词卡落盘 实施计划

日期：2026-09-26
关联设计：`docs/superpowers/specs/2026-09-26-video-wordcard-design.md`
状态：已完成

## Task 1：词卡纯逻辑

**Files**
- 新增 `src/utils/wordcard.js`
- 新增 `src/utils/wordcard.test.js`

**Steps**
- [x] `normalizeText` / `countKeyword`（整词）/ `locatePhrase`（子串）/ `buildWordcard`（回填+去重+排序+裁剪）
- [x] `node:test` 覆盖：归一化、不误命中 `booked`、短语定位、条目丢弃、空输入

**Verify**
- [x] `node --test src/utils/wordcard.test.js` 全绿

## Task 2：AI 生成脚本

**Files**
- 新增 `scripts/build-wordcards.mjs`
- `package.json` 加 `wordcards` 命令

**Steps**
- [x] 复用 `server/services/ai/provider.cjs` 的 `chat`/`extractJson`
- [x] 读 `subtitles.json` → 压缩字幕 → AI 选词/释义 → `buildWordcard` 回填 → 写 `wordcard.json`
- [x] 支持 `--force` / `--video` / `--dry`；未配 `AI_API_KEY` 报错退出

**Verify**
- [x] `npm run wordcards` 为 3 条视频各生成 `wordcard.json`
- [x] 抽查机场视频：`airport/机场`、`check in/办理登机托运`、例句齐全

## Task 3：前端接入

**Files**
- `src/pages/VideoDetail.jsx`

**Steps**
- [x] 载入字幕时并发 fetch `wordcard.json`（失败忽略）
- [x] `derivedData`：优先 `wordcard`，否则回退旧逻辑
- [x] tab：`phrases`（「核心语块」→「常用短语」），三个 tab 显示 `meaning` 并补空状态

**Verify**
- [x] `npx vite build` 通过
- [x] 无头 Chrome 移动端：三个 tab 有内容；点击卡片跳转到对应句并关闭抽屉

## Task 4：回归与文档

**Files**
- 本 plan + 设计文档

**Steps**
- [x] `node --test`（src + server）全绿
- [x] 新增文件 eslint 无报错
- [x] 补设计文档与本计划

## 备注

- `data/videos` 为 gitignore，`wordcard.json` 随数据卷分发；生产 Docker 挂载 `/app/data` 后由 `/data` 静态托管，无需改 `server/index.cjs` 或 `copy-data.mjs`。
- 纯静态 dist 部署（不走 `/data`）需额外把 `wordcard.json` 纳入 `copy-data`（当前未做）。
