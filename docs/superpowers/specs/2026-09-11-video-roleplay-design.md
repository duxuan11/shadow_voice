# 视频学习场景 × AI Role Play 设计文档

日期：2026-09-11
状态：已批准（待实现）

## 背景与目标

Shadow Voice 现有 AI 对话是「围绕视频主题的自由聊天」——AI 只做英语对话伙伴，不扮演任何角色。
本功能把每个视频学习场景与 AI Role Play 深度绑定：

> 看一个视频 → 点击 AI 对话按钮 → AI 自动进入该视频对应的真实场景（如酒店前台、服务员、面试官）→ 用户直接开口交流。

核心约束（用户明确要求）：
- 最大化复用现有 API / 组件 / 数据库；不重构整个项目。
- 不新增社区、排行榜、积分、课程体系等无关功能。
- 不改变现有核心 UI 风格。
- 不凭空创建已有功能的重复实现。
- 优先完成「视频 → 场景理解 → AI Role Play」完整链路。

## 已确认的关键决策

1. **场景覆盖范围（方案 A）**：所有视频都由 AI 自动生成一个合理角色 + 场景。
   旅行 vlog → 旅伴/向导；演讲 → 演讲者（用户是提问听众）；点餐 → 服务员等。
2. **入口时机（方案 A）**：保持现状——「💬 AI 对话」按钮始终可见，随时可点。
3. **实现方案（方案一）**：扩展现有对话引擎，新增「场景档案 Scene Profile」，
   不另起独立模块、不重复造轮子。

## 架构总览

```
VideoDetail(看视频) ──点击按钮──▶ ConversationPage
                                   │  POST /conversation/start
                                   ▼
                          route/conversation.cjs
                          ├─ getTopicsForVideo()      (已有, topics-v1)
                          ├─ getSceneForVideo()       (新增, scene-v1)
                          └─ 开场白 buildOpeningPrompt(scene)  (改造)
                                   │
                                   ▼
                          services/ai/conversation.cjs
                          ├─ F0b 场景提取 extractSceneProfile()  (新增)
                          ├─ F1 开场白（角色扮演）               (改造)
                          ├─ F2 回复（保持角色、推进剧情）        (改造)
                          └─ F3 解析（不变）
                                   │
                                   ▼
                          DB: ai_cache(scene-v1) + conversation_sessions.scene_json(新列)
```

## ① 场景档案数据结构（Scene Profile）

```json
{
  "scene": "Hotel Check-in",
  "sceneCn": "酒店入住",
  "setting": "The front desk of a British hotel in the afternoon",
  "userRole": "guest",
  "userRoleCn": "客人",
  "aiRole": "front desk receptionist",
  "aiRoleCn": "前台接待",
  "context": "You just arrived and need to check in for your reservation",
  "contextCn": "你刚到达酒店，需要办理入住",
  "coreExpressions": [{"phrase":"check in","meaning":"办理入住"}],
  "source": "ai"
}
```

覆盖维度：场景（scene/setting）、人物角色（userRole/aiRole）、上下文（context）、核心表达（coreExpressions）。
对话内容通过把字幕片段一并喂给 AI 来理解。

## ② 后端：AI 引擎改动（server/services/ai/conversation.cjs）

- 新增 `SCENE_PROMPT_VERSION = 'scene-v1'`（独立于 `PROMPT_VERSION = 'topics-v1'`）。
- 新增 `SYSTEM_SCENE` + `buildScenePrompt({ videoTitle, description, topic, topics, level, segments })`
  + `extractSceneProfile(...)`（AI 主路径 + 本地降级）。
- 改造 `buildOpeningPrompt({ videoTitle, topics, level, scene })`：
  system prompt 改为「你就是 aiRole，正在 setting 场景中，用自然口语开启对话，问一个开放问题」。
- 改造 `buildReplyPrompt({ topics, history, level, scene })`：
  要求 AI 保持角色、根据用户回答自然推进剧情，并明确「不要复述视频台词」。
- `buildReviewPrompt` / F3 解析保持不变（评分仍针对用户表达）。
- 向后兼容：`scene` 参数可选，缺省时退回原「自由对话」行为，旧测试不破。

## ③ 后端：路由 + 缓存 + 存储（routes/conversation.cjs + db.cjs）

- 新增 `getSceneForVideo(videoId, video)`：缓存进现有 `ai_cache` 表，`prompt_version = 'scene-v1'`
  （与 `topics-v1` 并存，互不影响）。
- `conversation_sessions` 新增列 `scene_json TEXT`（用现有 `ensureColumn` 幂等迁移）。
- `/start`：同时提取并存储场景，响应返回 `scene`。
- `/:sessionId/reply`：读 `scene_json` 传给 F2。
- `/:sessionId`：响应返回 `scene`。
- `/recent`：不变。
- `pickTargetPhrase(scene, topics, userCount)`：优先 `scene.coreExpressions`，回退 `topics.phrases`。

## ④ 本地降级（无 AI key 时）

新增 `localDetectScene({ videoTitle, description, topic, topics })`：基于标题/话题关键词的
场景映射表：
- 酒店/hotel/check in → 前台（AI）/ 客人（user）
- 点餐/order/restaurant/waiter/food → 服务员 / 顾客
- 面试/interview → 面试官 / 求职者
- 机场/airport/flight → 值机员 / 乘客
- 购物/shopping → 店员 / 顾客
- 咖啡/coffee → 咖啡师 / 顾客
- 旅行/vlog/travel → 当地旅伴 / 旅行者
- 演讲/speech/TED → 演讲者 / 听众
- 其余按话题给通用角色；再兜底一个通用场景。

标记 `source:'local'`，只用于展示场景卡；对话本身仍需 AI key（保持现状，不伪造）。

## ⑤ 前端改动（src/pages/ConversationPage.jsx + src/index.css）

- 新增 `scene` state，从 `/start` 和 `loadSession` 读入。
- 对话区顶部新增「场景横幅」（沿用现有 indigo 风格）：
  `🎭 场景：酒店入住 ｜ 你扮演：客人 ｜ AI 扮演：前台` + 一句 `context` + 核心表达 chips。
- 其余全部不动：ASR（阿里云/Web Speech）、TTS、解析面板、视频回看、素材条、退出返回。

## ⑥ 测试

- `conversation.test.cjs`：新增 `buildScenePrompt` / `localDetectScene` 测试；
  更新 `buildOpeningPrompt` / `buildReplyPrompt` 断言包含场景信息。
- `conversation-ai.test.cjs`：mock fetch 增加对「场景提取 prompt」的识别，返回场景 JSON；
  断言 `scene_json` 落库、`/start` 与 `/:sessionId` 返回 `scene`。

## 兼容性

- 旧会话 `scene_json` 为空 → 前端不显示横幅，行为不变。
- 现有测试全部保持通过。

## 范围外（明确不做）

- 不新增社区、排行榜、积分、课程体系等无关功能。
- 不改动视频播放器、跟读评测、听写等既有功能。
- 不重构项目结构。
