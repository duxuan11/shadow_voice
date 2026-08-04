# 阿里云口语评测接入（跟读真实评分 + Native 诊断）— 设计规格

日期：2026-08-04
状态：待用户评审

## 背景与问题

VideoDetail（视频详情页）的「跟读」tab 目前是**假评分**：`stopRecording` 里用随机数生成得分和单词状态（`score: Math.floor(Math.random()*12)+87`），并显示虚假夸赞文案"发音极为饱满，连读自然"。用户希望接入阿里云**智能科教内容生成平台（SSECP）口语评测**，获得真实的：总分、流利度、连读、单词发音准确度等反馈，并展示"哪里不够 native"。

已确认的事实（源自阿里云官方文档）：

- 评测类型 `en.sent.score`（英文句子）返回：`overall`（总分）、`accuracy/pron`（准确度）、`integrity`（完整度）、`fluency`（流利度：总分+停顿次数+语速）、`rhythm`（韵律：意群/重音/升降调）、`details[]`（逐词：得分、漏读/重复读 `dp_type`、停顿 `is_pause`、连读 `liaisonref/liaisonscore`、重读 `stressref/stressscore`、升降调 `toneref/tonescore`、意群停顿 `senseref/sensescore`、音素级 `phone[]`（含 `pherr` 音素检错、`ph2alpha` 对应字母））、`info.tipId`（录音质量提示）、`audioUrl`（录音文件，云端保留 1 个月）。
- **连读检测默认关闭**：请求参数必须带 `auto_rhythm: 1`，否则 `liaisonref` 全为 0，无连读反馈。
- **音素级输出默认关闭**：需 `outputPhones: 1`，音素检错需 `phdet: 1`。
- 鉴权：客户端先向**我们的后端**申请授权，后端用 `app_secret` 签名（MD5）调 `https://api.cloud.ssapi.cn/auth/authorize` 换取 `warrant_id`（默认 7200 秒有效、可复用），前端拿 `warrant_id` 直连评测引擎。官方明确要求密钥仅存服务端。

## 范围

**改**：VideoDetail 内联「跟读」面板（移动端 tab + 桌面端侧边栏，共用一套逻辑）。

**不改**（本次非目标）：
- ShadowingPage 独立页（无入口的孤儿页）
- 大模型 AI 评语（`classTaskSubmit`，仅白名单客户开放）——预留但不实现
- 评测结果服务端持久化（先纯前端展示）
- 后端可视化界面（不需要）

## 架构

```
浏览器(React)
 ├─ authFetch POST /api/aliyun/authorize ──> 我们的后端 (Express)
 │      │ 校验 JWT → MD5签名 → Form POST 到阿里云 authorize 接口
 │      │ 返回 warrant_id（后端内存缓存，TTL 内复用）
 │      ▼
 ├─ engine.js (window.EngineEvaluat)   ← 阿里云官方 JS SDK，封装录音+speex压缩+WebSocket流式上传
 │      └── WebSocket 直连评测引擎 ──> 阿里云评测服务器
 │             └── 返回 JSON 结果（overall/fluency/details[]...）
 ▼
 VideoDetail 跟读面板：解析结果 → Native 诊断 UI
```

- `app_secret` 只在后端；前端只持有短期 `warrant_id`。
- 音频流不经过我们服务器（低延迟、省带宽）。

## 后端设计

新增 `server/routes/aliyun.cjs`，在 `server/index.cjs` 挂载 `app.use('/api/aliyun', aliyunRoutes)`。

### POST `/api/aliyun/authorize`

- 中间件：`authMiddleware`（复用 `server/auth.cjs`，JWT 中已有 `userId`）。
- 请求体：无（`userId` 从 JWT 取，保证与评测时一致）。
- 逻辑：
  1. 查内存缓存 `Map<userId, { warrantId, expiresAt }>`，未过期（提前 60s 视为过期）直接返回。
  2. 组装参数（Form 字段）：`appid`（env `SSECP_APP_ID`）、`timestamp`（10 位秒字符串）、`user_id`（JWT userId 字符串）、`user_client_ip`（`req.ip`，注意 `X-Forwarded-For` 代理场景）、`request_sign`、`warrant_available`（可选，默认 7200）。
  3. 签名算法（官方 PHP/Java/Python/Go 示例一致，已验证）：
     ```js
     // 对 5 个参数按键名升序排序后拼接，再 MD5（小写 hex）
     // 参数：appid, timestamp(字符串), user_id, user_client_ip, app_secret
     // 注意：app_secret 以 key=value 形式参与拼接，值不做 URL 编码
     const pairs = Object.entries({
       appid, timestamp, user_id, user_client_ip, app_secret
     }).sort(([a],[b]) => a.localeCompare(b))
       .map(([k,v]) => `${k}=${v}`)
     const sign = md5(pairs.join('&'))
     ```
     即：`md5("appid=..&app_secret=..&timestamp=..&user_client_ip=..&user_id=..")`（排序后顺序）。
  4. 以 `application/x-www-form-urlencoded` POST 到 `SSECP_AUTH_URL`（env，默认 `https://api.cloud.ssapi.cn/auth/authorize`）。开发期可用官方测试环境 `http://trial.cloud.ssapi.cn:8080/auth/authorize`。
  5. 阿里云返回 `code === 0` → 响应体含 `data.warrant_id` 与 `data.expire_at`（**绝对过期时间戳**，直接用于缓存）→ 存缓存 → 返回 `{ warrantId, expiresAt, applicationId }`（`applicationId` 即 `SSECP_APP_ID`，前端构造 EngineEvaluat 需要）；否则 → 503 + `msg`。
- 失败兜底：阿里云超时/网络错误 → 502；不泄露 `app_secret`。

### 环境变量（.env 已建）

| 变量 | 说明 |
|---|---|
| `SSECP_APP_ID` | 阿里云控制台口语评测项目 AppKey |
| `SSECP_APP_SECRET` | 应用密钥（仅服务端） |
| `SSECP_AUTH_URL` | 授权接口地址（默认即可） |
| `SSECP_WARRANT_TTL` | 授权有效期秒数（默认 7200） |

## 前端设计

### 新组件 `src/components/ShadowingEvaluator.jsx`

把评测全流程封装成独立组件，移动端 tab 和桌面端侧边栏两处复用，避免现有代码的双份复制。

- Props：`{ refText, textCn, onSpeakOriginal }`。
- 内部状态：`phase`（`loading-engine | ready | recording | evaluating | result | error`）、`result`、`error`、`tipId`、`volume`（麦克风音量，驱动录音动画条，替换现有随机波浪高度）。
- 流程：
  1. **加载 engine.js**：首次进入组件时动态注入 `<script src="/sdk/engine.js">`，`window.EngineEvaluat` 就绪后进入 `ready`。engine.js 由用户从阿里云控制台"口语评测项目 → JavaScript SDK"下载，放到 `public/sdk/engine.js`（构建时自动进 dist）。
  2. **取 warrant**：`authFetch('/api/aliyun/authorize', { method: 'POST' })`；`useRef` 缓存 `{ warrantId, expiresAt, applicationId }`，距过期 60s 内重新申请；401（游客无 token）→ 提示"请先登录后使用口语评测"。
  3. **开始评测**：`myRecord.startRecord(params)`，`params`：
     ```js
     {
       coreType: 'en.sent.score',
       refText,            // currentSub.textEn
       rank: 100,
       precision: 1,
       auto_rhythm: 1,     // 连读检测（关键开关）
       outputPhones: 1,    // 音素级得分
       phdet: 1,           // 音素检错
       attachAudioUrl: 1,  // 返回录音地址供回放
     }
     ```
     `accent`（en/am）暂不传（引擎默认），预留配置位。
  4. **停止评测**：`myRecord.stopRecord()` → `evaluating`。
  5. **回调**：`engineBackResultDone(msg)` → `parseResult(msg)` 存结果；`engineBackResultFail(msg)` → 错误态 + tipId；`micForbidCallback` → 提示麦克风权限；`micVolumeCallback` → 更新音量条。
  6. **录音时长**：移除现有 4 秒自动停止；保留安全上限 30s（超时自动停止）。切换句子/组件卸载时中止评测并销毁引擎实例。
  7. **录音回放**：用结果里的 `audioUrl`（云端保留 1 个月）渲染 `<audio controls>`。

### 结果解析 `src/utils/aliyunResult.js`（纯函数，可单测）

`parseResult(msg)` 归一化为：

```js
{
  overall, accuracy, integrity,          // 数字
  fluency: { overall, pause, speed },    // speed: 0慢 1正常 2快
  rhythm: { overall, sense, stress, tone },
  liaison: { expected, ok },             // expected=liaisonref===1 的词数; ok=其中 liaisonscore===1 数
  words: [{
    char, score, start, end,
    dpType,          // 0正常 1漏读 2重复读
    isPause,
    liaison: { ref, score },
    stress:  { ref, score },
    tone:    { ref, score },
    sense:   { ref, score },
    phones: [{ char, score, pherr, ph2alpha }],
    fakePron,
  }],
  audioUrl, tipId,
}
```

边界处理：`details` 缺失/空数组 → 空 words；`fake_pron`（集外词）→ 该词标记"未收录词典"不参与评分；`eof` 多帧 → 以 `engineBackResultDone` 回调 msg 为准（最终结果）。

### UI（替换现有两个跟读面板，共用 ShadowingEvaluator）

1. **句子卡**：保留现有 `currentSub.textEn` + 原音播放按钮（`speakActiveSentence` 不动）。
2. **得分区**：`overall` 大字 + 五维条：准确度 / 流利度 / 完整度 / 韵律 / 连读完成度（`liaison.ok/liaison.expected`）。
3. **逐词着色**：`score ≥85` 绿、`≥75` 琥珀、`≥55` 灰、`<55` 红（沿用现有 perfect/good/poor 配色语义）。
4. **词上徽章（Native 检查清单）**：
   - 连读：`liaison.ref===1` 标「连读」，`score===0` 红✗"应连读未连读"，`===1` 绿✓
   - 重读：`stress.ref` 与 `stress.score` 不一致 → 标「重音」
   - 升降调：`tone.ref` 与 `tone.score` 不一致 → 标「升降调」
   - 意群停顿：`sense.ref===1 && sense.score===0` → 标「意群停顿」
   - `dpType===1` → 标「漏读」；`dpType===2` → 标「重复」；`isPause===1` → 标「⏸停顿」
   - **分层展示**：音素错误/漏读/完整度用实色（高可靠）；连读/重音/升降调/意群用"提示"样式（虚线框/浅色），UI 上不渲染成"判错"语气。
5. **点击单词展开音素明细**：`ph2alpha` 显示对应字母 + `score` + `pherr` 状态（"字母 `t` 的音发错"）。可选增强：内置 音素→IPA 对照表（源自官方《音素对照表》）展示国际音标。
6. **流利度统计**：停顿次数、语速（慢/正常/快）小字提示。
7. **音频质量**：`tipId > 0` → 显示对应提示（10004 音量偏低 / 10005 截幅 / 10006 信噪比低，见官方 tipId 说明）。
8. **移除假夸赞文案**，替换为动态小结行：如"连读 2/3 处到位，注意 want→to 的连读"。
9. **清理旧代码**：移除 VideoDetail 中 `isRecording/recordingSeconds/shadowResult/recordedAudio/mediaRecorderRef` 及 4 秒自动停止逻辑（仅跟读面板使用，无其他引用）。切换 `currentSub` 时重置结果（现有代码切句不重置是 bug，一并修复）。

## 错误处理

| 场景 | 处理 |
|---|---|
| engine.js 未下载 | 明确提示"请将 engine.js 放到 public/sdk/ 后重启" |
| warrant 获取失败 | 重试一次，仍失败 → 显示错误，不阻塞其他功能 |
| 评测失败 | `engineBackResultFail` msg + tipId 展示 |
| 麦克风权限拒绝 | `micForbidCallback` → 引导开启权限 |
| 评测中切换句子 | 中止评测、销毁引擎、重置结果 |
| 无 `currentSub` | 沿用现有"请选择具体句子以开始评测" |

## 测试计划

1. **后端**：`curl` 登录拿 token → `POST /api/aliyun/authorize` → 校验返回 `warrantId` 及缓存命中（第二次调用不再打阿里云）；错误 token → 401。
2. **结果解析**：用文档示例 JSON + 真实返回做单测（`node --test` 或最小断言脚本），覆盖空 details、fake_pron、连读统计。
3. **前端联调**（真实凭据）：dev server 上完成 录音→评测→Native 面板渲染 全流程；核对面板字段与文档字段一一对应（overall/accuracy/integrity/fluency/rhythm/liaison/phones）。
4. **错误分支**：断网、拒麦、无 SDK、tipId 提示。
5. **浏览器**：Chrome/Firefox/Edge；`localhost` 属安全上下文麦克风可用；局域网 HTTP 访问麦克风受限（提示用户，沿用既有认知）。

## 需要用户提供的资源

- ✅ 已配：`SSECP_APP_ID` / `SSECP_APP_SECRET`（.env）
- ⬜ 待提供：从阿里云控制台"口语评测 → 管理项目 → JavaScript SDK"下载 `engine.js`，放入 `public/sdk/`

## 实施顺序

1. 后端 `server/routes/aliyun.cjs` + 挂载 + `.env` 校验
2. `public/sdk/engine.js` 就位（用户下载）
3. `src/utils/aliyunResult.js` + 解析单测
4. `src/components/ShadowingEvaluator.jsx`
5. VideoDetail 两处面板替换 + 旧状态清理 + 切句重置
6. 全流程联调、错误分支打磨
