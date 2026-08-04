# 阿里云口语评测接入（跟读真实评分 + Native 诊断）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 VideoDetail「跟读」面板的随机假评分替换为阿里云口语评测真实评分，并展示 Native 诊断反馈（总分/流利度/连读/音素级错误）。

**Architecture:** 后端新增 `/api/aliyun/authorize`（JWT → MD5 签名 → 阿里云授权接口 → 缓存返回 warrant_id + applicationId）；前端新增 `ShadowingEvaluator` 组件：动态加载阿里云官方 `engine.js`（`window.EngineEvaluat`），拿 warrant 后直连评测引擎（WebSocket 流式上传），`en.sent.score` 评测 + `auto_rhythm=1` 连读检测，结果经纯函数 `parseResult` 归一化后渲染诊断 UI。移动端 tab 与桌面端侧边栏两处共用组件。

**Tech Stack:** Node 22（内置 `node:crypto` MD5、全局 `fetch`、`node:test`）、Express 5（CommonJS）、React 19 + Tailwind（项目已有）、阿里云 SSECP 口语评测 `engine.js`（外部 SDK，用户下载至 `public/sdk/`）。

## Global Constraints

- **零新增 npm 依赖**：MD5 用 `node:crypto`，签名基准值已由官方示例参数验证（`65d9845fdc085bc45828b5cc16806d98`）。
- **密钥红线**：`SSECP_APP_SECRET` 只出现在 `server/`；前端只能拿到 `warrant_id`。
- **评测参数固定**：`coreType='en.sent.score'`、`auto_rhythm=1`（连读检测，默认关闭）、`outputPhones=1`、`phdet=1`、`attachAudioUrl=1`。
- **前置文件**：`public/sdk/engine.js` 需用户从阿里云控制台下载；缺失时组件须给出明确报错而不是白屏。
- **后端遵循 CommonJS**（`server/*.cjs`）；前端遵循项目现有 ESM JSX 与 Tailwind 风格。
- **游客模式**：无 JWT → authorize 401 → 前端提示"请先登录"。
- 测试命令：后端 `node --test server/routes/aliyun.test.cjs`；前端解析函数 `node --test src/utils/aliyunResult.test.js`（Node 22 原生）。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `server/routes/aliyun.cjs` | authorize 路由 + MD5 签名 + warrant 内存缓存 | 新建 |
| `server/routes/aliyun.test.cjs` | buildSign 单元测试（官方示例基准值） | 新建 |
| `server/index.cjs` | 挂载 `/api/aliyun` | 修改 |
| `src/utils/aliyunResult.js` | `parseResult(msg)` 纯函数：API 原始 JSON → 归一化 UI 数据 | 新建 |
| `src/utils/aliyunResult.test.js` | parseResult 单元测试 | 新建 |
| `src/components/ShadowingEvaluator.jsx` | 评测全流程组件（SDK 加载/录音/评测/结果渲染/错误处理） | 新建 |
| `src/pages/VideoDetail.jsx` | 移动端 + 桌面端两处跟读面板替换，清理旧假评分状态 | 修改 |
| `public/sdk/engine.js` | 阿里云官方 JS SDK（用户下载，构建自动复制进 dist） | 外部前置 |

---

### Task 1: 后端授权路由（含签名单元测试）

**Files:**
- Create: `server/routes/aliyun.cjs`
- Create: `server/routes/aliyun.test.cjs`
- Modify: `server/index.cjs`（挂载路由）

**Interfaces:**
- Consumes: `server/auth.cjs` 的 `authMiddleware`（JWT payload 为 `{ userId }`）；env `SSECP_APP_ID` / `SSECP_APP_SECRET` / `SSECP_AUTH_URL` / `SSECP_WARRANT_TTL`。
- Produces: `buildSign({ appid, timestamp, userId, clientIp, secret }) → string`（供测试）；`POST /api/aliyun/authorize` 返回 `{ warrantId, expiresAt, applicationId }`（Task 3 前端消费）。

- [ ] **Step 1: 写失败测试 `server/routes/aliyun.test.cjs`**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSign } = require('./aliyun.cjs')

test('buildSign 与官方示例基准值一致', () => {
  const sign = buildSign({
    appid: 'a111',
    timestamp: '1603885321',
    userId: 'w9egtDf3PMAOaxZVGSlQUip12no6WCvu',
    clientIp: '111.111.XXX.XXX',
    secret: 'wHkC1SMmDLrVO86vcydG2ax4oPYuqiIh',
  })
  // 官方 Python 示例参数对应的 MD5（已独立验证）
  assert.equal(sign, '65d9845fdc085bc45828b5cc16806d98')
})

test('buildSign 对相同参数幂等', () => {
  const p = { appid: 'a1', timestamp: '123', userId: 'u1', clientIp: '1.2.3.4', secret: 's1' }
  assert.equal(buildSign(p), buildSign(p))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/routes/aliyun.test.cjs`
Expected: FAIL（`Cannot find module './aliyun.cjs'` 或 `buildSign is not a function`）

- [ ] **Step 3: 实现 `server/routes/aliyun.cjs`**

```js
const express = require('express')
const crypto = require('node:crypto')
const { authMiddleware } = require('../auth.cjs')

const router = express.Router()

const APP_ID = process.env.SSECP_APP_ID || ''
const APP_SECRET = process.env.SSECP_APP_SECRET || ''
const AUTH_URL = process.env.SSECP_AUTH_URL || 'https://api.cloud.ssapi.cn/auth/authorize'
const WARRANT_TTL = Number(process.env.SSECP_WARRANT_TTL) || 7200

// userId -> { warrantId, expiresAt }（内存缓存，重启即失效，可接受）
const cache = new Map()

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

// 官方签名：5 参数按键名升序拼 key=value 以 & 连接（值不做 URL 编码），整串 MD5 小写
function buildSign({ appid, timestamp, userId, clientIp, secret }) {
  const params = {
    appid,
    timestamp,
    user_id: userId,
    user_client_ip: clientIp,
    app_secret: secret,
  }
  const signString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return md5(signString)
}

// POST /api/aliyun/authorize
router.post('/authorize', authMiddleware, async (req, res) => {
  if (!APP_ID || !APP_SECRET) {
    return res.status(500).json({ error: '服务器未配置阿里云口语评测凭据（SSECP_APP_ID / SSECP_APP_SECRET）' })
  }

  const userId = String(req.userId)
  const cached = cache.get(userId)
  if (cached && cached.expiresAt - 60 * 1000 > Date.now()) {
    return res.json({ warrantId: cached.warrantId, expiresAt: cached.expiresAt, applicationId: APP_ID })
  }

  const timestamp = String(Math.floor(Date.now() / 1000))
  const clientIp = req.ip || req.socket.remoteAddress || ''
  const requestSign = buildSign({ appid: APP_ID, timestamp, userId, clientIp, secret: APP_SECRET })

  const form = new URLSearchParams({
    appid: APP_ID,
    timestamp,
    user_id: userId,
    user_client_ip: clientIp,
    request_sign: requestSign,
    warrant_available: String(WARRANT_TTL),
  })

  let resp
  try {
    resp = await fetch(AUTH_URL, { method: 'POST', body: form.toString() })
  } catch {
    return res.status(502).json({ error: '阿里云授权服务不可达' })
  }

  let data
  try {
    data = await resp.json()
  } catch {
    return res.status(502).json({ error: '阿里云授权服务响应异常' })
  }

  if (data.code !== 0 || !data.data || !data.data.warrant_id) {
    return res.status(503).json({ error: `阿里云授权失败: ${data.message || data.msg || data.code}` })
  }

  const expiresAt = (data.data.expire_at || Math.floor(Date.now() / 1000) + WARRANT_TTL) * 1000
  cache.set(userId, { warrantId: data.data.warrant_id, expiresAt })
  res.json({ warrantId: data.data.warrant_id, expiresAt, applicationId: APP_ID })
})

module.exports = { router, buildSign }
```

- [ ] **Step 4: 挂载路由到 `server/index.cjs`**

在 `const progressRoutes = require('./routes/progress.cjs')` 后新增一行：

```js
const aliyunRoutes = require('./routes/aliyun.cjs')
```

在 `app.use('/api/progress', progressRoutes)` 后新增：

```js
app.use('/api/aliyun', aliyunRoutes.router)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test server/routes/aliyun.test.cjs`
Expected: PASS（2 个用例）

- [ ] **Step 6: 手动联调（真实凭据，需 `npm run server` 已启动）**

Run:
```bash
# 用你已注册的账号登录拿 token（替换 username/password）
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"你的用户名","password":"你的密码"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
# 首次请求应返回 warrantId（打阿里云）
curl -s -X POST http://localhost:3001/api/aliyun/authorize -H "Authorization: Bearer $TOKEN"
# 期望形如: {"warrantId":"5aec...","expiresAt":1754... ,"applicationId":"a148"}
# 无 token 应 401
curl -s -X POST http://localhost:3001/api/aliyun/authorize
```
Expected: 有 token 返回 `warrantId/expiresAt/applicationId`；无 token 返回 `401 {"error":"未登录"}`。

- [ ] **Step 7: Commit**

```bash
git add server/routes/aliyun.cjs server/routes/aliyun.test.cjs server/index.cjs
git commit -m "feat(server): 阿里云口语评测授权路由（MD5签名换 warrant_id + 缓存）"
```

---

### Task 2: 评测结果解析纯函数（TDD）

**Files:**
- Create: `src/utils/aliyunResult.js`
- Create: `src/utils/aliyunResult.test.js`

**Interfaces:**
- Consumes: `engineBackResultDone(msg)` 回调的原始 JSON（`en.sent.score` 返回结构，字段见设计文档"已确认的事实"）。
- Produces: `parseResult(msg) → { overall, accuracy, integrity, fluency:{overall,pause,speed}, rhythm:{overall,sense,stress,tone}, liaison:{expected,ok}, words:[...], audioUrl, tipId }`（Task 3 组件直接消费）。

- [ ] **Step 1: 写失败测试 `src/utils/aliyunResult.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResult } from './aliyunResult.js'

const sample = JSON.stringify({
  result: {
    overall: 86,
    accuracy: 92,
    integrity: 100,
    fluency: { overall: 78, pause: 3, speed: 1 },
    rhythm: { overall: 71, sense: 70, stress: 80, tone: 62 },
    details: [
      { char: 'I', score: 95, start: 0, end: 100, dur: 100 },
      {
        char: 'want', score: 60, start: 100, end: 300, dur: 200,
        liaisonref: 1, liaisonscore: 0,
        stressref: 1, stressscore: 1,
        toneref: 0, tonescore: 0,
        senseref: 0, sensescore: 0,
        phone: [
          { char: 'w', score: 90, pherr: 0, ph2alpha: 'w' },
          { char: 'aa', score: 45, pherr: 1, ph2alpha: 'a' },
        ],
      },
      {
        char: 'to', score: 88, start: 300, end: 420, dur: 120,
        liaisonref: 1, liaisonscore: 1,
        dp_type: 2,
      },
      { char: 'OOVword', score: 0, start: 420, end: 500, dur: 80, fake_pron: 1 },
    ],
    info: { tipId: 10004, snr: 20, clip: 0, volume: 40 },
  },
  audioUrl: 'http://files.cloud.ssapi.cn/a148/abc123',
})

test('完整样例：所有字段归一化正确', () => {
  const r = parseResult(sample)
  assert.equal(r.overall, 86)
  assert.equal(r.accuracy, 92)
  assert.equal(r.integrity, 100)
  assert.deepEqual(r.fluency, { overall: 78, pause: 3, speed: 1 })
  assert.deepEqual(r.rhythm, { overall: 71, sense: 70, stress: 80, tone: 62 })
  assert.equal(r.liaison.expected, 2)
  assert.equal(r.liaison.ok, 1)
  assert.equal(r.words.length, 4)
  assert.equal(r.audioUrl, 'http://files.cloud.ssapi.cn/a148/abc123')
  assert.equal(r.tipId, 10004)
})

test('单词字段：连读/重读/漏读/音素/集外词', () => {
  const r = parseResult(sample)
  const want = r.words[1]
  assert.deepEqual(want.liaison, { ref: 1, score: 0 })
  assert.deepEqual(want.stress, { ref: 1, score: 1 })
  assert.equal(want.phones.length, 2)
  assert.equal(want.phones[1].pherr, 1)
  assert.equal(want.phones[1].ph2alpha, 'a')
  const to = r.words[2]
  assert.equal(to.dpType, 2)
  assert.equal(r.words[3].fakePron, true)
})

test('空 details / 缺字段不抛异常', () => {
  const r1 = parseResult(JSON.stringify({ result: {} }))
  assert.deepEqual(r1.words, [])
  assert.equal(r1.overall, null)
  assert.equal(r1.accuracy, null)
  assert.equal(r1.liaison.expected, 0)
  const r2 = parseResult('{}')
  assert.deepEqual(r2.words, [])
})

test('对象入参与字符串入参等价', () => {
  const asObj = parseResult(JSON.parse(sample))
  const asStr = parseResult(sample)
  assert.deepEqual(asObj, asStr)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/utils/aliyunResult.test.js`
Expected: FAIL（`Cannot find module './aliyunResult.js'`）

- [ ] **Step 3: 实现 `src/utils/aliyunResult.js`**

```js
// 阿里云口语评测（en.sent.score）原始结果 → 前端 UI 归一化数据结构
// 字段说明见 docs/superpowers/specs/2026-08-04-aliyun-oral-evaluation-design.md

export function parseResult(msg) {
  const raw = typeof msg === 'string' ? JSON.parse(msg) : msg
  const r = (raw && raw.result) || {}
  const details = Array.isArray(r.details) ? r.details : []

  const words = details.map((w) => ({
    char: w.char || '',
    score: typeof w.score === 'number' ? w.score : null,
    start: w.start ?? null,
    end: w.end ?? null,
    dpType: w.dp_type ?? 0,            // 0 正常 / 1 漏读 / 2 重复读
    isPause: w.is_pause === 1,
    fakePron: w.fake_pron === 1,       // 集外词（不在词典）
    liaison: { ref: w.liaisonref ?? 0, score: w.liaisonscore ?? 0 },
    stress: { ref: w.stressref ?? 0, score: w.stressscore ?? 0 },
    tone: { ref: w.toneref ?? 0, score: w.tonescore ?? 0 },
    sense: { ref: w.senseref ?? 0, score: w.sensescore ?? 0 },
    phones: Array.isArray(w.phone)
      ? w.phone.map((p) => ({
          char: p.char || '',
          score: typeof p.score === 'number' ? p.score : null,
          pherr: p.pherr ?? 0,         // 音素检错 0/1（需 phdet=1）
          ph2alpha: p.ph2alpha || '',  // 音素对应的单词字母
        }))
      : [],
  }))

  const liaisonWords = words.filter((w) => w.liaison.ref === 1)

  return {
    overall: typeof r.overall === 'number' ? r.overall : null,
    accuracy: typeof r.accuracy === 'number' ? r.accuracy : (typeof r.pron === 'number' ? r.pron : null),
    integrity: typeof r.integrity === 'number' ? r.integrity : null,
    fluency: {
      overall: r.fluency && typeof r.fluency.overall === 'number' ? r.fluency.overall : null,
      pause: r.fluency && typeof r.fluency.pause === 'number' ? r.fluency.pause : null,
      speed: r.fluency && typeof r.fluency.speed === 'number' ? r.fluency.speed : null, // 0慢 1正常 2快
    },
    rhythm: {
      overall: r.rhythm && typeof r.rhythm.overall === 'number' ? r.rhythm.overall : null,
      sense: r.rhythm && typeof r.rhythm.sense === 'number' ? r.rhythm.sense : null,
      stress: r.rhythm && typeof r.rhythm.stress === 'number' ? r.rhythm.stress : null,
      tone: r.rhythm && typeof r.rhythm.tone === 'number' ? r.rhythm.tone : null,
    },
    liaison: { expected: liaisonWords.length, ok: liaisonWords.filter((w) => w.liaison.score === 1).length },
    words,
    audioUrl: (raw && raw.audioUrl) || null,
    tipId: (r.info && r.info.tipId) || 0,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/utils/aliyunResult.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/utils/aliyunResult.js src/utils/aliyunResult.test.js
git commit -m "feat: 口语评测结果解析纯函数 parseResult + 单测"
```

---

### Task 3: ShadowingEvaluator 评测组件

**Files:**
- Create: `src/components/ShadowingEvaluator.jsx`

**Interfaces:**
- Consumes: `useAuth().authFetch`（`POST /api/aliyun/authorize`，返回 `{ warrantId, expiresAt, applicationId }`）、`useAuth().user.id`（与后端 JWT userId 一致）、`parseResult`（Task 2）、`public/sdk/engine.js`（`window.EngineEvaluat`，外部前置）。
- Produces: 自包含评测组件 `<ShadowingEvaluator refText={string} />`（Task 4 两处使用）。渲染：麦克风按钮 / 录音动画 / 评测中 / 结果诊断面板 / 错误提示；内部管理评测生命周期。

**前置说明：** `public/sdk/engine.js` 需用户从阿里云控制台下载。若缺失，`loadEngineJs` 会 reject，组件展示明确错误（含放置路径提示），不影响页面其他功能。

- [ ] **Step 1: 实现组件（本步含完整实现，下一步为手工验证）**

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { parseResult } from '../utils/aliyunResult'
import { Mic, Square, Loader2, Volume2, Play, ChevronDown, ChevronUp } from 'lucide-react'

// engine.js 动态加载（模块级单例，多个挂载点共享一次加载）
let engineScriptPromise = null
function loadEngineJs() {
  if (window.EngineEvaluat) return Promise.resolve()
  if (engineScriptPromise) return engineScriptPromise
  engineScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/sdk/engine.js'
    s.onload = () => (window.EngineEvaluat ? resolve() : reject(new Error('engine.js 已加载但未找到 window.EngineEvaluat')))
    s.onerror = () => reject(new Error('无法加载 /sdk/engine.js，请确认 public/sdk/engine.js 已放置'))
    document.head.appendChild(s)
  })
  return engineScriptPromise
}

const SPEED_LABEL = { 0: '偏慢', 1: '正常', 2: '偏快' }
const TIP_MESSAGES = {
  10004: '音量偏低，可能离麦克风太远，建议靠近一些重试',
  10005: '音频截幅（音量过高），建议离麦克风远一些重试',
  10006: '音频信噪比低（环境嘈杂），建议在安静环境重试',
  10008: '音频模拟信号截幅，建议调整麦克风音量重试',
}
const MAX_RECORD_MS = 30 * 1000

function wordColor(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 85) return 'text-emerald-600 bg-emerald-50'
  if (score >= 75) return 'text-amber-600 bg-amber-50'
  if (score >= 55) return 'text-slate-500 bg-slate-100'
  return 'text-rose-600 bg-rose-50 underline decoration-wavy'
}

export default function ShadowingEvaluator({ refText }) {
  const { authFetch, user } = useAuth()
  const [phase, setPhase] = useState('ready') // ready | recording | evaluating | result | error
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [volume, setVolume] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [expandedWord, setExpandedWord] = useState(null)

  const engineRef = useRef(null)
  const initRef = useRef({ done: false, resolvers: [] })
  const warrantRef = useRef(null)
  const timerRef = useRef(null)
  const secondsRef = useRef(null)

  const setPhaseSafe = useCallback((p) => setPhase(p), [])

  // ── warrant 获取（缓存 + 过期前 60s 刷新 + 401 提示）──
  const getWarrant = useCallback(async () => {
    const w = warrantRef.current
    if (w && w.expiresAt - 60 * 1000 > Date.now()) return w
    const res = await authFetch('/aliyun/authorize', { method: 'POST' })
    if (res.status === 401) throw new Error('请先登录后使用口语评测（游客模式不支持）')
    if (!res.ok) {
      let msg = '授权服务异常'
      try { msg = (await res.json()).error || msg } catch {}
      throw new Error(msg)
    }
    const data = await res.json()
    warrantRef.current = data
    return data
  }, [authFetch])

  // ── engine 实例（懒创建，等 engineFirstInitDone；用 initRef.done 避免二次评测死等）──
  const ensureEngine = useCallback(() => {
    if (engineRef.current) return engineRef.current
    const engine = new window.EngineEvaluat({
      applicationId: warrantRef.current.applicationId,
      userId: String(user.id),
      warrantId: warrantRef.current.warrantId,
      micAllowCallback: () => {},
      micForbidCallback: () => { setPhaseSafe('error'); setError('麦克风权限被拒绝，请在浏览器设置中允许麦克风访问') },
      micVolumeCallback: (v) => setVolume(typeof v === 'number' ? v : 0),
      engineFirstInitDone: () => {
        initRef.current.done = true
        initRef.current.resolvers.forEach((fn) => fn())
        initRef.current.resolvers = []
      },
      engineBackResultDone: (msg) => {
        try {
          setResult(parseResult(msg))
          setPhaseSafe('result')
        } catch {
          setPhaseSafe('error'); setError('评测结果解析失败，请重试')
        }
      },
      engineBackResultFail: (msg) => {
        setPhaseSafe('error')
        setError(`评测失败：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
      },
      JSSDKNotSupport: () => { setPhaseSafe('error'); setError('当前浏览器不支持评测 SDK，请使用 Chrome / Edge / Firefox') },
      noNetwork: () => { setPhaseSafe('error'); setError('网络不可用，评测需要联网') },
    })
    engineRef.current = engine
    return engine
  }, [user, setPhaseSafe])

  const waitInit = useCallback(() => {
    if (initRef.current.done) return Promise.resolve()
    return new Promise((resolve) => {
      initRef.current.resolvers.push(resolve)
    })
  }, [])

  // ── 开始评测 ──
  const start = useCallback(async () => {
    setError(null)
    setResult(null)
    setExpandedWord(null)
    try {
      await loadEngineJs()
      await getWarrant()
      const engine = ensureEngine()
      await waitInit()
      engine.startRecord({
        coreType: 'en.sent.score',
        refText,
        warrantId: warrantRef.current.warrantId,
        rank: 100,
        precision: 1,
        auto_rhythm: 1,      // 连读检测（关键开关）
        outputPhones: 1,     // 音素级得分
        phdet: 1,            // 音素检错
        attachAudioUrl: 1,   // 返回录音地址供回放
      })
      setPhaseSafe('recording')
      setSeconds(0)
      secondsRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
      timerRef.current = setTimeout(() => { if (engineRef.current) { engineRef.current.stopRecord(); setPhaseSafe('evaluating') } }, MAX_RECORD_MS)
    } catch (e) {
      setPhaseSafe('error')
      setError(e.message || '启动评测失败')
    }
  }, [authFetch, getWarrant, ensureEngine, waitInit, refText, setPhaseSafe])

  // ── 停止评测 ──
  const stop = useCallback(() => {
    clearTimeout(timerRef.current)
    clearInterval(secondsRef.current)
    if (engineRef.current) engineRef.current.stopRecord()
    setPhaseSafe('evaluating')
  }, [setPhaseSafe])

  // ── 重试 ──
  const retry = useCallback(() => {
    setPhase('ready')
    setError(null)
    setResult(null)
    setVolume(0)
  }, [])

  // ── 卸载清理 ──
  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current)
      clearInterval(secondsRef.current)
      if (engineRef.current) {
        try { engineRef.current.stopRecord() } catch {}
        engineRef.current = null
      }
    }
  }, [])

  // ── 渲染 ──
  if (!refText) {
    return <div className="text-center py-8 text-xs text-slate-400 italic">请选择具体句子以开始评测</div>
  }

  return (
    <div className="flex flex-col items-center">
      {phase === 'error' && (
        <div className="w-full text-center py-4 space-y-2">
          <p className="text-xs font-semibold text-rose-600">{error}</p>
          <button onClick={retry} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer">重试</button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="flex flex-col items-center space-y-3">
          <button onClick={start} className="h-12 w-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md transition-all cursor-pointer hover:scale-105 active:scale-95">
            <Mic className="h-5 w-5" />
          </button>
          <span className="text-[11px] font-bold text-slate-500">点击麦克风，朗读这句英文</span>
        </div>
      )}

      {phase === 'recording' && (
        <div className="flex flex-col items-center space-y-4">
          <div className="flex items-end justify-center space-x-1 h-8 px-8">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} style={{ height: `${Math.max(6, Math.min(32, 6 + (volume * (0.5 + (i % 3) * 0.2))))}px` }} className="w-1 bg-indigo-500 rounded-full animate-pulse transition-all duration-100" />
            ))}
          </div>
          <span className="text-xs font-semibold text-slate-400">正在录音... {seconds}s</span>
          <button onClick={stop} className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer transition-all">
            <Square className="inline h-3.5 w-3.5 mr-1" />结束录音并评测
          </button>
        </div>
      )}

      {phase === 'evaluating' && (
        <div className="flex flex-col items-center space-y-3 py-4">
          <Loader2 className="h-6 w-6 text-indigo-500 animate-spin" />
          <span className="text-xs font-semibold text-slate-400">评测中...</span>
        </div>
      )}

      {phase === 'result' && result && (
        <div className="w-full space-y-3 animate-fade-in">
          {result.tipId > 0 && TIP_MESSAGES[result.tipId] && (
            <p className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
              ⚠ {TIP_MESSAGES[result.tipId]}
            </p>
          )}

          {/* 总分 + 五维条 */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">评测得分</span>
            <span className="text-sm font-extrabold text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full font-mono">
              {result.overall != null ? `${Math.round(result.overall)}分` : '—'}
            </span>
          </div>
          <div className="space-y-1.5">
            {[
              ['准确度', result.accuracy],
              ['流利度', result.fluency.overall],
              ['完整度', result.integrity],
              ['韵律', result.rhythm.overall],
              ['连读', result.liaison.expected > 0 ? (result.liaison.ok / result.liaison.expected) * 100 : null],
            ].map(([label, val]) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-10 text-[10px] font-semibold text-slate-400 shrink-0">{label}</span>
                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  {val != null && <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.max(0, Math.min(100, val))}%` }} />}
                </div>
                <span className="w-8 text-right text-[10px] font-mono text-slate-500">{val != null ? Math.round(val) : '—'}</span>
              </div>
            ))}
          </div>

          {/* 逐词着色 + 徽章 */}
          <div className="bg-white border border-slate-100 p-3 rounded-xl flex flex-wrap gap-1.5 text-xs font-bold leading-relaxed">
            {result.words.map((w, i) => (
              <span key={i} className="relative inline-block">
                <button onClick={() => setExpandedWord(expandedWord === i ? null : i)} className={`px-1 rounded cursor-pointer ${wordColor(w.score)}`}>
                  {w.char}
                </button>
                {w.liaison.ref === 1 && (
                  <span className={`ml-0.5 align-top text-[8px] font-bold px-1 rounded ${w.liaison.score === 1 ? 'text-emerald-600 bg-emerald-100' : 'text-rose-600 bg-rose-100'}`} title={w.liaison.score === 1 ? '连读到位' : '此处应连读'}>
                    {w.liaison.score === 1 ? '连读✓' : '连读✗'}
                  </span>
                )}
                {w.stress.ref !== w.stress.score && (
                  <span className="ml-0.5 align-top text-[8px] font-bold text-amber-600 bg-amber-100 rounded px-1" title="重音与预期不一致">重音</span>
                )}
                {w.tone.ref !== w.tone.score && (
                  <span className="ml-0.5 align-top text-[8px] font-bold text-indigo-600 bg-indigo-100 rounded px-1" title="升降调与预期不一致">升降调</span>
                )}
                {w.sense.ref === 1 && w.sense.score === 0 && (
                  <span className="ml-0.5 align-top text-[8px] font-bold text-sky-600 bg-sky-100 rounded px-1" title="此处应有意群停顿">意群停顿</span>
                )}
                {w.dpType === 1 && <span className="ml-0.5 align-top text-[8px] font-bold text-rose-600 bg-rose-100 rounded px-1">漏读</span>}
                {w.dpType === 2 && <span className="ml-0.5 align-top text-[8px] font-bold text-amber-600 bg-amber-100 rounded px-1">重复</span>}
                {w.isPause && <span className="ml-0.5 align-top text-[8px] font-bold text-slate-500 bg-slate-100 rounded px-1">⏸停顿</span>}
                {w.fakePron && <span className="ml-0.5 align-top text-[8px] font-bold text-slate-400 bg-slate-100 rounded px-1">未收录</span>}
                {w.phones.length > 0 && (
                  <ChevronDown className="inline h-2.5 w-2.5 text-slate-400" />
                )}
                {/* 音素明细 */}
                {expandedWord === i && (
                  <span className="absolute left-0 top-full z-10 mt-1 block w-48 bg-white border border-slate-200 rounded-lg shadow-lg p-2 space-y-0.5 text-left">
                    {w.phones.map((p, pi) => (
                      <span key={pi} className="block text-[10px] font-mono">
                        <span className={p.pherr === 1 ? 'text-rose-600 font-extrabold underline decoration-wavy' : 'text-emerald-600'}>
                          {p.ph2alpha || p.char}
                        </span>
                        <span className="text-slate-400"> /{p.char}/ </span>
                        <span className="text-slate-500">{p.score != null ? Math.round(p.score) : '—'}{p.pherr === 1 ? ' 发错' : ''}</span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
            ))}
          </div>

          {/* 动态小结 + 流利度统计 */}
          <div className="text-[10px] font-medium text-slate-500 space-y-0.5">
            {result.liaison.expected > 0 && (
              <p className={result.liaison.ok === result.liaison.expected ? 'text-emerald-600' : 'text-amber-600'}>
                连读 {result.liaison.ok}/{result.liaison.expected} 处到位{result.liaison.ok < result.liaison.expected ? '，注意标 ✗ 的词要连起来读' : ''}
              </p>
            )}
            {result.fluency.pause != null && (
              <p>本句停顿 {result.fluency.pause} 次{result.fluency.speed != null ? `，语速${SPEED_LABEL[result.fluency.speed] || ''}` : ''}</p>
            )}
            {result.overall != null && (
              <p className="text-indigo-500">{result.overall >= 85 ? '整体很棒，继续保持！' : result.overall >= 70 ? '读得不错，按上面提示再练一遍会更好' : '还有提升空间，对照原声多跟读几遍'}</p>
            )}
          </div>

          {/* 录音回放（云端保留 1 个月） */}
          {result.audioUrl && (
            <div className="flex items-center gap-2">
              <Volume2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              <audio controls src={result.audioUrl} className="w-full h-8" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 静态检查**

1. Run: `npm run lint`
   Expected: 无新增错误。
2. 确认 `public/sdk/engine.js` 已放置（用户从阿里云控制台下载）。若未放置，本步改为验证**错误提示分支**：临时在页面某处渲染 `<ShadowingEvaluator refText="test" />`，点击麦克风 → 应显示"无法加载 /sdk/engine.js…"而非白屏，验证后移除临时渲染。

> 说明：组件的完整端到端验证（录音→评测→结果面板）依赖 Task 4 挂载到真实面板后统一进行。

- [ ] **Step 3: Commit**

```bash
git add src/components/ShadowingEvaluator.jsx
git commit -m "feat: ShadowingEvaluator 口语评测组件（engine.js 加载/warrant/录音/结果诊断 UI）"
```

---

### Task 4: VideoDetail 接入（替换两处假评分面板 + 清理旧状态）

**Files:**
- Modify: `src/pages/VideoDetail.jsx`

**Interfaces:**
- Consumes: `<ShadowingEvaluator refText={string} />`（Task 3）；`currentSub.textEn`、`currentSub.id`。
- Produces: 无（组件自包含）。

- [ ] **Step 1: 新增 import**

在 `VideoDetail.jsx` 现有 import 区域（lucide 图标等之后）新增：

```jsx
import ShadowingEvaluator from '../components/ShadowingEvaluator'
```

- [ ] **Step 2: 删除旧跟读状态与假评分逻辑**

删除以下代码块（当前行号约 81-87、180-207，以实际为准）：

1. 状态声明块：
```jsx
  // Shadowing state
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [shadowResult, setShadowResult] = useState(null)
  const [recordedAudio, setRecordedAudio] = useState(null)
  const mediaRecorderRef = useRef(null)
```
2. 4 秒自动停止 useEffect（`// ── Recording ──` 注释起的整个 useEffect，含 `[isRecording]` 依赖）。
3. `startRecording` 与 `stopRecording` 两个函数（`// ── Recording ──` 之后到 `// ── Cloze / Translate handlers ──` 之前）。

> 删除前先 `grep -n "isRecording\|shadowResult\|recordedAudio\|mediaRecorderRef\|recordingSeconds" src/pages/VideoDetail.jsx` 确认引用点只剩跟读面板两处；若有其他引用（如 `setPlaying(false)` 之外的），一并按下面 Step 3/4 的替换消除。

- [ ] **Step 3: 移动端面板替换**

将移动端 `{mobileTab === 'shadow' && (...)}` 内、`currentSub ? (...)` 分支中的整个 `<div className="flex flex-col items-center py-6"> ... </div>`（含 isRecording 分支、shadowResult 结果块、recordedAudio 回放块）替换为：

```jsx
                {currentSub ? (
                  <ShadowingEvaluator key={currentSub.id} refText={currentSub.textEn} />
                ) : (
                  <div className="text-center py-8 text-xs text-slate-400 italic">请选择具体句子以开始评测</div>
                )}
```

- [ ] **Step 4: 桌面端面板替换**

将桌面端 `{sidebarTab === 'shadow' && (...)}` 内、`currentSub ? (...)` 分支中的整个 `<div className="flex flex-col items-center py-6"> ... </div>` 替换为：

```jsx
                        {currentSub ? (
                          <ShadowingEvaluator key={currentSub.id} refText={currentSub.textEn} />
                        ) : (
                          <div className="text-center py-8 text-xs text-slate-400 italic">请选择具体句子以开始评测</div>
                        )}
```

> 两处保留外层句子卡（textEn + speakActiveSentence 播放按钮）不动；`key={currentSub.id}` 保证切换句子时组件重建、结果自动重置。

- [ ] **Step 5: 静态检查**

Run: `npm run lint`
Expected: 无新增错误（若 eslint 报未使用变量，按报错清理，如 `Sparkles` 图标若不再使用需从 import 移除）。

- [ ] **Step 6: 端到端手工验证（真实凭据）**

1. `npm run server` + `npm run dev`
2. Chrome 打开视频页 → 跟读 tab（桌面端侧边栏）：
   - 点击麦克风 → 允许麦克风 → 录音动画（音量驱动）→ 朗读一句 → 结束
   - 期望：出现总分 + 五维条 + 逐词着色 + 连读/重音等徽章 + 音素明细（点击单词）+ 录音回放
   - 与阿里云控制台/官方示例结果字段核对（overall/accuracy/fluency/rhythm/liaison/phones）
3. 移动端视口（DevTools 切 iPhone）重复以上流程（移动端 tab）。
4. 错误分支：断网评测 → 错误提示；游客模式（登出后以游客进入）→ "请先登录后使用口语评测"。
5. 切换句子 → 结果重置、回到麦克风状态。

- [ ] **Step 7: Commit**

```bash
git add src/pages/VideoDetail.jsx
git commit -m "feat: VideoDetail 跟读面板接入阿里云真实评测，移除随机假评分"
```

---

### Task 5: 收尾验证与文档

**Files:**
- Modify: `README.md`（可选）

- [ ] **Step 1: 全量回归**

Run: `npm run lint && node --test server/routes/aliyun.test.cjs && node --test src/utils/aliyunResult.test.js`
Expected: 全部通过；页面核心功能（视频播放/字幕/听写/查词）无回归。

- [ ] **Step 2: 更新 README（可选）**

在"功能概览 → 视频播放 + 双语字幕"或听写模式之后补充：

```markdown
### 🎙️ 跟读评测（阿里云口语评测）
- 逐句跟读，真实发音评分（总分/准确度/流利度/完整度/韵律）
- Native 诊断：连读/重音/升降调/意群停顿徽章 + 音素级错误定位
- 录音回放与原声对比
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 补充跟读评测功能说明"
```
