# 生词本（词卡 → 生词本）设计文档

日期：2026-09-29
状态：已实现

## 背景与目标

视频详情页「智能重点词卡」有三个 tab（单词 / 短语 / 核心短语），但此前只有字幕点词的
popup 能存生词，词卡本身无法收藏；生词本也只存单词、只有单个来源。本次把词卡三个 tab
做成完整的「加入生词本 → 持久化 → 多来源 → 可移除 → 状态同步」闭环。

**明确不做**：字幕点击查词、AI 自动加词、间隔重复、单词测试、记忆曲线、新学习模块。

## 统一数据模型

```
{
  id: number,
  content: string,          // 展示原文（保留大小写）
  word: string,             // 去重规范化 key（小写、去标点、合并空白）
  translation: string,      // 中文释义
  type: 'word'|'phrase'|'core_phrase',
  phonetic: string,         // 单词 IPA，如 "/ˈpæsˌpɔɹt/"
  sources: [{ videoId, videoTitle }],
  created_at: string
}
```

- `word` 复用旧 `vocabulary.word` 列与其 `UNIQUE(user_id, word)` 约束，作为跨类型去重 key。
- 旧库通过 `ensureColumn` 补 `content/translation/type/phonetic/sources`，并回填
  `content=word`、`type='word'`；旧行的 `sources` 由 `video_id/video_title` 兜底合成。

## 后端（server/routes/vocab.cjs）

- `GET /api/vocab`：返回统一模型数组（解析 `sources` JSON）。
- `POST /api/vocab`：`{content, translation, type, phonetic, videoId, videoTitle}`（兼容旧 `word`）。
  - 命中同 key：合并来源视频（按 videoId 去重），补齐缺失的 translation/phonetic/type，不覆盖已有值。
  - 未命中：插入。
- `DELETE /api/vocab/:word`：按规范化 key 删除（支持含空格短语，前端 encodeURIComponent）。
- 多用户隔离沿用 `user_id`；游客 401。

## 前端

- `src/utils/vocabulary.js`：`normalizeVocabKey`、`buildVocabPayload`（把 keywords/phrases/expressions
  统一成载荷）、`findVocabEntry`、`filterVocabByType`、`countVocabByType`。
- `src/pages/VideoDetail.jsx`：词卡每个条目渲染收藏按钮，三种状态：
  1. 未加入 → 「加入生词本」；
  2. 已加入但本视频不是来源 → 「加入本视频」（补记来源）；
  3. 本视频已是来源 → 「已加入」（禁用）。
  全局移除只在生词本页面做，避免在词卡误删多来源条目。收藏操作 `stopPropagation`，不跳转、不关闭抽屉；
  底部 toast 给出「已加入 / 已移除」反馈。单词显示音标。
  支持 `?card=1&word=…&type=…` 深链：自动打开词卡并滚动定位到该条目。
- `src/pages/LearningRecords.jsx`：生词本卡片列表，支持 全部/单词/短语/核心短语 筛选、
  显示英文、音标、中文释义、类型徽章、来源视频（可点击跳回词卡）、加入时间、触屏移除。
- `src/pages/Profile.jsx`：最近生词用 `content`。

## 音标

- `scripts/build-phonetics.mjs`（`npm run phonetics`）用 `ipa-dict` 的 en_US 词表，为 DATA_DIR 下
  所有 wordcard keywords 与字幕 highlightWords 生成 `src/data/phonetics.js`（约 7700 词，提交仓库）。
- `src/utils/phonetics.js` 的 `getPhonetic()` 供展示与收藏写入，前端零网络依赖。

## 手机端

- 收藏 / 发音 / 移除 / 来源 / 筛选按钮均 ≥ 44px，`touch-action: manipulation`，不依赖 hover。
- 词卡按钮 `stopPropagation`，收藏不触发跳转或关闭抽屉。
- 生词本分类在窄屏横向滚动（不换行溢出）；长单词/短语 `overflow-wrap: anywhere` 换行；
  来源 chip 可换行；PC / 手机同一份服务端数据。

## 验证

- 单元测试：`src/utils/vocabulary.test.js`、`src/utils/phonetics.test.js`、`server/routes/vocab.test.cjs`。
- 端到端：`scripts/verify-vocab-e2e.mjs`（Playwright，桌面 1280×800 + 手机 390×844 触屏），
  覆盖 加入 → 刷新仍在 → 去重 → 多视频来源 → 来源跳回 → 移除同步 → 手机布局。
