# 视频学习状态设计文档

日期：2026-09-20
状态：已批准（待实现）
分支：`feat/video-learning-status`

## 背景与目标

现在没有任何"这个视频我学到什么程度"的统一视图。用户看完/练完只能靠记忆判断，
列表页也无法按学习进度筛选。

本设计给**每个视频**增加一个学习状态，以视频为单位（不按句子）：

| 状态 | 判定 |
|---|---|
| 🔴 Not Learned（未学习） | 该视频没有任何有效练习记录 |
| 🟡 Learning（学习中） | 有练习记录，但整体完成度 < 75% |
| 🟢 Learned（已学习） | 整体完成度 ≥ 75% |

状态**动态计算**，随记录增长而升级：Not Learned → Learning → Learned。
完成度完全由现有/新增的练习记录算出，不引入 LLM 主观判断，
不新增 AI Tutor / Recall / Mastery 等系统。

## 现状调研

### 已持久化的学习数据（服务端 SQLite）

| 数据 | 表 | 字段 |
|---|---|---|
| 看视频进度 | `video_progress` | `current_time` / `duration`（`completed` 字段存在但客户端从未写入，恒为 0） |
| 听写 | `dictation_records` | `data` JSON：`{ currentIndex, history[] }` |
| AI 口语对话 | `conversation_sessions` | `status` / `review_json` |
| 观看历史 | `watch_history` | 仅记录看过 |

### 未持久化（只存在页面内存，刷新即丢）

- 跟读 `ShadowingPage`（`practiced` Set）与 VideoDetail 内联 `ShadowingEvaluator`（只展示分数）
- 挖空 `ClozePage` 与 VideoDetail 内联挖空
- 中译英（仅 VideoDetail 内联）

### 关键结论：哪些是"实际存在的功能"

- `DictationPage`(/video/:id/dictation)、`ShadowingPage`(/video/:id/shadowing)、
  `ClozePage`(/video/:id/cloze) 三个独立路由**在 UI 中没有任何入口**，是孤儿路由。
- 用户真正在用的练习只有 **VideoDetail 的三个 tab**：`跟读 / 挖空 / 中译英`。
- 因此**核心学习任务 = 跟读 + 挖空 + 中译英（3 项）**，听写不计入，
  观看进度与 AI 对话也不计入。

## 已确认的关键决策

1. **任务集合**：跟读 + 挖空 + 中译英，共 3 项。听写/观看/AI 对话不计入。
2. **完成度算法**：按任务平均。每项完成率 = 该项已练去重句数 ÷ 字幕总句数；
   整体 = 三项完成率的算术平均。
3. **阈值**：整体 ≥ **75%** → Learned（不是 80%）。
4. **记录粒度**：跟读/挖空/中译英各**每句一个布尔标志即可**，不存录音、评分、
   对错等内容。"练习过"即可，不要求答对或评测成功。
5. **存储方案**：新增 `practice_records` 表，每 user+video 一行 JSON，
   与现有 `dictation_records` 完全同构（方案 1，最小改动）。
6. **埋点位置**：只改 VideoDetail 的三个内联 tab；孤儿独立页不动。
7. **游客**：支持游客本地记录（localStorage）并显示状态；
   **不做登录后合并**（YAGNI）。登录用户在服务端，跨设备同步。

## 架构与数据流

```
┌─ VideoDetail（跟读/挖空/中译英 tab）
│    练习动作 ──► mark(task, activeSubIndex)
│                    │ 登录：POST /api/practice/:videoId {task,index}
│                    └ 游客：localStorage shadow_voice_practice
│
├─ Library 列表页
│    loadSummary() ──► 服务端 GET /api/practice/summary
│                     或 游客聚合 localStorage
│         │
│         ▼
│    learningStatus.computeVideoProgress(counts, subtitle_count)
│    learningStatus.getLearningStatus(progress)
│         │
│         ▼
│    卡片徽章 🔴🟡🟢 + 学习状态筛选
```

## 详细设计

### 1. 数据模型

`server/db.cjs` 的 `initSchema()` 新增（`CREATE TABLE IF NOT EXISTS`，无需迁移）：

```sql
CREATE TABLE IF NOT EXISTS practice_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id   TEXT NOT NULL,
  data       TEXT NOT NULL,   -- {"shadow":[0,2,5],"cloze":[...],"translate":[...]}
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, video_id)
)
```

`data` 是三个任务到"已练句子索引数组"的映射。句子索引统一为**字幕合并清洗后数组
的下标**（`mergeAdjacentDuplicateSubtitles` 的结果），与各练习面板的
`activeSubIndex` 一致。

### 2. API（`server/routes/practice.cjs`，注册到 `/api/practice`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/summary` | — | `{ summary: { "<videoId>": {"shadow":n,"cloze":n,"translate":n} } }` |
| GET | `/:videoId` | — | `{ data: {"shadow":[],"cloze":[],"translate":[]} }`（无记录返回空对象） |
| POST | `/:videoId` | `{ task, index }` | `{ ok: true, data }`（合并去重后的最新值） |

约束与行为：

- `/summary` 必须**注册在 `/:videoId` 之前**，否则被参数路由吞掉。
- `task` 必须 ∈ `{shadow, cloze, translate}`，否则 `400`。
- `index` 必须是非负整数，否则 `400`。
- POST 采用**读-合并-写**：读取该 user+video 行的 JSON，把 `index` 并入对应任务
  数组（`Set` 去重），再 upsert 写回。同用户写入在 sql.js 单连接内串行，无需加锁。
- `/summary` 扫描该用户全部 `practice_records` 行，对每个任务返回去重后的句数
  （去重已在写入时保证，读取时仅计数）。
- 所有接口经 `authMiddleware`；未登录/游客无 token → `401`。
- 损坏 JSON 容错：解析失败视为空 `{}`，不抛错。

### 3. 完成度算法（`src/utils/learningStatus.js`，纯函数）

```js
export const TASKS = ['shadow', 'cloze', 'translate']
export const LEARNED_THRESHOLD = 0.75

// counts: { shadow, cloze, translate }（已在服务端/本地去重的句数）
// subtitleCount: consolidated.json 的 subtitle_count
export function computeVideoProgress(counts, subtitleCount) {
  const total = Number(subtitleCount)
  if (!Number.isFinite(total) || total <= 0) return 0
  const rates = TASKS.map(t => {
    const n = Number(counts?.[t]) || 0
    return Math.min(1, n / total)   // 夹到 1，防超 100%
  })
  return rates.reduce((a, b) => a + b, 0) / TASKS.length
}

// 判定状态：'not_learned' | 'learning' | 'learned'
export function getLearningStatus(counts, progress) {
  const any = TASKS.some(t => (Number(counts?.[t]) || 0) > 0)
  if (!any) return 'not_learned'
  return progress >= LEARNED_THRESHOLD ? 'learned' : 'learning'
}
```

判定规则（严格按此顺序）：

1. 三项计数全为 0 → `not_learned`（保证"从未产生有效学习记录"）。
2. 有任一计数 > 0 且 `progress < 0.75` → `learning`（不会误标 Learned）。
3. `progress >= 0.75` → `learned`。

示例：

| shadow | cloze | translate | subtitle_count | progress | status |
|---|---|---|---|---|---|
| 0 | 0 | 0 | 100 | 0% | 🔴 Not Learned |
| 100 | 80 | 50 | 100 | (100+80+50)/3 = 76.7% | 🟢 Learned |
| 100 | 50 | 0 | 100 | 50% | 🟡 Learning |
| 74 | 75 | 75 | 100 | 74.7% | 🟡 Learning（差一点） |

**分母说明**：用 `subtitle_count`（列表页已从 `consolidated.json` 加载，无需服务端
计算）。全库 12 个视频里有 3 个的"合并后句数"比 `subtitle_count` 少 1
（如 218→217），对应视频最高可达 ≈99.5%，不影响 75% 判定。

### 4. 客户端记录封装（`src/utils/practiceRecords.js`）

- 纯合并函数（可单测）：`addIndex(data, task, index)` → 返回去重后的新 data，
  非法 task/index 原样返回。
- 登录用户：`loadSummary(authFetch)` / `loadOne(authFetch, videoId)` /
  `mark(authFetch, isGuest, videoId, task, index)`，分别调 `/api/practice/*`。
- 游客：同结构存 localStorage，键 `shadow_voice_practice`，
  值 `{ [videoId]: { shadow:[], cloze:[], translate:[] } }`；
  `loadSummary` 聚合全部本地条目为计数。
- `mark` 采用乐观更新：已在内存/本地集合中的句子不重复发请求；POST 失败静默忽略
  （练习不因记录失败而中断）。

### 5. 埋点（VideoDetail）

三处，均用当前 `activeSubIndex` 作为句子索引（`currentSub = video.subtitles[activeSubIndex]`）：

| 任务 | 触发点 | 说明 |
|---|---|---|
| 跟读 | 给 `ShadowingEvaluator` 新增 `onPracticed` prop，在录音结束（手动停止或自动停止）时调用 | 不要求评测成功、不看分数；阿里云未配置也能算 |
| 挖空 | `handleSelectClozeOption` 选中任一选项时 | 不要求答对 |
| 中译英 | `handleVerifyTranslation` 校验时 | 不要求答对 |

`ShadowingEvaluator` 两个布局实例（移动端 / 桌面端）都要传 `onPracticed`。

### 6. 列表页（Library）

- 挂载时 `loadSummary(authFetch, isGuest)` 得到 `{ [videoId]: counts }`，存入 state。
- 为每个 video 计算 `progress` 与 `status`（派生，不写回 JSON）。
- 卡片徽章：在现有 `.video-meta` 内新增
  `<span class="learn-badge learn-badge-{status}">🔴 Not Learned</span>` 等；
  新增 CSS `.learn-badge-not_learned`（红）、`.learn-badge-learning`（黄）、
  `.learn-badge-learned`（绿）。
- 筛选面板新增「学习状态」分组：`全部 / Not Learned / Learning / Learned`，
  与 level/topic/accent 同构：state `statusFilter`，参与 `filteredVideos` 的
  `useMemo`，并纳入顶部 active-filters 标签与"清除筛选"。

### 7. 错误处理

- 练习记录接口失败：客户端静默忽略，不阻塞练习 UI，不弹错。
- 损坏 JSON：服务端与本地读取都容错为空对象。
- `subtitle_count` 非法/为 0：`computeVideoProgress` 返回 0。
- 游客访问 `/api/practice`：返回 401，客户端本就不对游客发请求。

### 8. 测试

| 文件 | 覆盖 |
|---|---|
| `src/utils/learningStatus.test.js` | 0 → Not Learned；0.749 → Learning；0.75 → Learned；三项平均；rate 夹到 1；subtitle_count=0/非法保护；缺任务字段 |
| `src/utils/practiceRecords.test.js` | `addIndex` 去重、非法 task/index 原样返回、不可变 |
| `server/routes/practice.test.cjs` | 游客 401；POST 后 GET 可读；重复 POST 幂等；`/summary` 计数正确；非法 task/负 index → 400；跨用户隔离；损坏 JSON 容错 |

测试命令：

```bash
node --test src/utils/learningStatus.test.js src/utils/practiceRecords.test.js
node --test server/routes/practice.test.cjs
npm run lint
```

## 不做的事（YAGNI）

- 不按句子判断学习状态。
- 不引入 AI Tutor / Recall / Mastery。
- 不存储录音、评分、发音细节。
- 不计入听写、观看进度、AI 对话。
- 不为孤儿独立页（ShadowingPage/ClozePage/DictationPage）加埋点。
- 不做游客记录的登录合并。

## 改动文件清单

新增：

- `server/routes/practice.cjs`
- `server/routes/practice.test.cjs`
- `src/utils/learningStatus.js`
- `src/utils/learningStatus.test.js`
- `src/utils/practiceRecords.js`
- `src/utils/practiceRecords.test.js`

修改：

- `server/db.cjs`（新增 `practice_records` 表）
- `server/index.cjs`（注册 `/api/practice`）
- `src/pages/VideoDetail.jsx`（三处埋点 + 传 `onPracticed`）
- `src/components/ShadowingEvaluator.jsx`（新增 `onPracticed` 回调）
- `src/pages/Library.jsx`（状态徽章 + 学习状态筛选）
- `src/index.css`（`.learn-badge-*` 样式）
