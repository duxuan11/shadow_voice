#!/usr/bin/env node
// 端到端校验：每日口语挑战（生成 → 五步 → 对话 → 报告 → 换一套 → 历史）+ 多轮对话已下线。
//
// 自带假 AI：它从 prompt 里解析该视频的字幕行，用**真实字幕原句**当 evidence 造语块，
// 所以能真正走通服务端的「字幕取证」路径（而不是用一个假挑战绕过校验）。
//
// 前置：
//   1) 后端带假 AI 跑：AI_API_KEY=test AI_BASE_URL=http://127.0.0.1:3999/v1 npm run server
//   2) （可选）前端在跑 + Chrome 开了远程调试，才会做页面级校验
//   3) SV_TOKEN=<登录后的 jwt>
//
// 用法：
//   SV_TOKEN=<jwt> node scripts/verify-speaking-challenge.mjs
//   SV_TOKEN=<jwt> APP_URL=http://localhost:5174 CDP_URL=http://127.0.0.1:9222 node scripts/verify-speaking-challenge.mjs
import http from 'node:http'
import fs from 'node:fs'

const API = process.env.API_URL || 'http://localhost:3001'
const APP = process.env.APP_URL || 'http://localhost:5173'
const CDP = process.env.CDP_URL || ''
const TOKEN = process.env.SV_TOKEN || ''
const STUB_PORT = Number(process.env.STUB_PORT || 3999)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok: Boolean(ok), extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `（${extra}）` : ''}`)
}

function firstVideoId() {
  if (process.env.VIDEO_ID) return process.env.VIDEO_ID
  try {
    return JSON.parse(fs.readFileSync('data/consolidated.json', 'utf-8'))[0]?.id || ''
  } catch {
    return ''
  }
}

// ── 假 AI：按 system 关键字分流，生成内容取自 prompt 里的真实字幕 ──
function parseSubtitleLines(userPrompt) {
  const out = []
  for (const line of String(userPrompt).split('\n')) {
    const m = line.match(/^\s*(\d+)\.\s+(.+)$/)
    if (!m) continue
    const body = m[2]
    const sep = body.indexOf(' || ')
    const en = (sep >= 0 ? body.slice(0, sep) : body).replace(/\s+/g, ' ').trim()
    const cn = sep >= 0 ? body.slice(sep + 4).trim() : ''
    if (en.split(' ').length < 3) continue
    out.push({ en, cn: cn || '这句话的意思' })
  }
  return out
}

function buildChallengeFromPrompt(userPrompt) {
  const lines = parseSubtitleLines(userPrompt)
  const picked = lines.slice(0, 5)
  const chunks = picked.map((l, i) => ({
    en: l.en.split(' ').slice(0, 4).join(' '),
    cn: l.cn.slice(0, 20),
    evidence: l.en,
    usageCn: '用它说说你自己的一次经历',
    id: i,
  }))
  return {
    title: '端到端校验挑战',
    topicEn: 'the topic of this video',
    topicCn: '这个视频的话题',
    recall: [1, 2, 3].map((n) => ({
      qEn: `What does the video say in part ${n}?`,
      qCn: `视频第 ${n} 部分说了什么？`,
      focusCn: '视频里的关键信息',
    })),
    chunks,
    transformations: [0, 1, 2, 3, 4].map((i) => ({
      situationCn: `情境${i + 1}：用英语说一件和视频主题有关的小事。`,
      targetChunkId: i,
      hintCn: '先说来意再补充细节',
    })),
    topicSpeaking: {
      promptEn: 'Talk about something the video reminded you of.',
      promptCn: '讲一件这个视频让你想到的经历。',
      pointsCn: ['发生了什么', '你怎么处理', '结果如何'],
      targetSeconds: 90,
    },
  }
}

function startStub() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { payload = {} }
      const messages = payload.messages || []
      const sys = String(messages[0]?.content || '')
      const user = String(messages[1]?.content || '')
      let content = '{"reply":"Tell me more about that."}'
      // 注意顺序：收尾 prompt 里也提到「五步口语挑战」，必须先匹配更具体的「学习报告」
      if (sys.includes('学习报告')) {
        content = JSON.stringify({
          chatFeedback: { score: 80, praise: '对话自然', chunkUsage: [{ chunkId: 0, used: true, quality: 'good' }] },
          report: {
            score: 82,
            summary: '整体不错：能说完整句，也能用上视频里的语块。',
            nextSuggestions: ['先列两个要点再开口', '注意时态一致'],
          },
        })
      } else if (sys.includes('逐题反馈')) {
        content = JSON.stringify({
          score: 80,
          items: [{ index: 0, comment: '意思说到了，句子再顺一点。', grammar: [], naturalness: [] }],
          chunkUsage: [{ chunkId: 0, used: true, quality: 'good', evidence: 'check in' }],
          vocabulary: { level: '适中', suggestions: ['make it'] },
          coherence: { summary: '连贯', fillers: [] },
          praise: '敢于开口',
        })
      } else if (sys.includes('五步口语挑战')) {
        content = JSON.stringify(buildChallengeFromPrompt(user))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  return new Promise((resolve) => server.listen(STUB_PORT, () => resolve(server)))
}

// ── HTTP ──────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch { data = null }
  return { status: res.status, data }
}

// ── 页面校验（可选） ───────────────────────────────────
async function verifyPage(videoId) {
  if (!CDP) return 'skip'
  let tab
  try {
    tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
  } catch {
    return 'skip'
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return res.result?.result?.value
  }
  await new Promise((r) => { ws.onopen = r })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: `${APP}/login` })
  await sleep(2000)
  await evaluate(`localStorage.setItem('shadow_voice_token', ${JSON.stringify(TOKEN)}); 'ok'`)
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__calls=[];const f=window.fetch;window.fetch=function(...a){window.__calls.push(String(a[0]));return f.apply(this,a)};',
  })
  await send('Page.navigate', { url: `${APP}/video/${videoId}/challenge` })

  let text = ''
  for (let i = 0; i < 25; i += 1) {
    await sleep(1000)
    text = (await evaluate('document.body.innerText.slice(0, 400)')) || ''
    if (text && !text.includes('加载中')) break
  }
  const calls = JSON.parse((await evaluate('JSON.stringify(window.__calls || [])')) || '[]')
  ws.close()

  check('页面离开加载态', Boolean(text) && !text.includes('加载中'), text.split('\n')[1] || text.split('\n')[0])
  check('页面显示「每日口语挑战」', text.includes('每日口语挑战'))
  check('页面发起 /api/challenge 请求', calls.some((u) => String(u).includes('/api/challenge/')))
  check('页面不再请求 /api/conversation', !calls.some((u) => String(u).includes('/api/conversation')))
  return 'done'
}

// ── 主流程 ────────────────────────────────────────────
const videoId = firstVideoId()
if (!TOKEN || !videoId) {
  console.error('需要 SV_TOKEN（登录 token）与可用的 VIDEO_ID（或 data/consolidated.json）')
  process.exit(2)
}

const stub = await startStub()
console.log(`假 AI 已启动：http://127.0.0.1:${STUB_PORT}/v1（后端要用 AI_BASE_URL 指向它）`)

try {
  const hub0 = await api('GET', `/api/challenge/${videoId}`)
  check('GET 挑战中心可用', hub0.status === 200 && Boolean(hub0.data?.video?.id))

  const gen = await api('POST', `/api/challenge/${videoId}/generate`, {})
  check('生成挑战 201', gen.status === 201, `HTTP ${gen.status}`)
  const ch = gen.data || {}
  const challenge = ch.challenge || {}
  check('3 个复述题', challenge.recall?.length === 3)
  check('5 个语块且都带字幕证据', challenge.chunks?.length === 5 && challenge.chunks.every((c) => c.evidence))
  check('5 个中文情境', challenge.transformations?.length === 5)
  check('话题陈述任务存在', Boolean(challenge.topicSpeaking?.promptEn || challenge.topicSpeaking?.promptCn))
  const masteryCount = ['mastered', 'selfUsed', 'review', 'introduced']
    .reduce((n, k) => n + (ch.mastery?.[k]?.length || 0), 0)
  check('生成后该视频累计登记 5 个语块', masteryCount >= 5, `${masteryCount} 条`)

  const challengeId = ch.challengeId
  const s1 = await api('POST', `/api/challenge/${challengeId}/step/1`, {
    answers: challenge.recall.map((q, i) => ({ index: i, text: `In part ${i + 1} of the video, the speaker explains the situation.`, durationMs: 12000, segments: 1 })),
  })
  check('第 1 步反馈 200', s1.status === 200 && s1.data?.feedback, `HTTP ${s1.status}`)

  const s2 = await api('POST', `/api/challenge/${challengeId}/step/2`, {
    answers: challenge.chunks.map((c, i) => ({ index: i, chunkText: c.en, sentence: `I want to ${c.en} today.`, durationMs: 8000, segments: 1 })),
  })
  check('第 2 步反馈 200', s2.status === 200 && Boolean(s2.data?.feedback), `HTTP ${s2.status}`)

  const s3 = await api('POST', `/api/challenge/${challengeId}/step/3`, {
    answers: challenge.transformations.map((t, i) => ({ index: i, text: `I would say something about situation ${i + 1}.`, durationMs: 9000, segments: 1 })),
  })
  check('第 3 步反馈 200', s3.status === 200 && Boolean(s3.data?.feedback), `HTTP ${s3.status}`)

  const s4 = await api('POST', `/api/challenge/${challengeId}/step/4`, {
    text: 'Once I lost my way in a new city and a local helped me get back.',
    durationMs: 75000,
    segments: 2,
  })
  check('第 4 步反馈 200', s4.status === 200 && Boolean(s4.data?.feedback), `HTTP ${s4.status}`)

  const open = await api('POST', `/api/challenge/${challengeId}/chat`, {})
  check('对话开场白', open.status === 200 && Boolean(open.data?.reply), `HTTP ${open.status}`)
  let last = null
  for (let i = 0; i < 5; i += 1) {
    last = await api('POST', `/api/challenge/${challengeId}/chat`, { text: `Turn ${i + 1}: it happened last summer.`, durationMs: 6000, segments: 1 })
  }
  check('对话满 5 轮', last?.status === 200 && last.data?.userTurns === 5 && last.data?.canFinish === true)

  const fin = await api('POST', `/api/challenge/${challengeId}/finish`, {})
  check('收尾出报告', fin.status === 200 && Boolean(fin.data?.report), `HTTP ${fin.status}`)
  const report = fin.data?.report || {}
  check('报告有本地统计', Number(report.speaking?.longestSeconds) >= 70, `最长 ${report.speaking?.longestSeconds}s`)
  check('报告四堆齐全', ['mastered', 'selfUsed', 'review', 'introduced'].every((k) => Array.isArray(report[k])))
  check('对话里用好语块 → mastered', report.mastered.length >= 1, `已掌握 ${report.mastered.length} 个`)
  check('进度标记完成', fin.data?.progress?.status === 'completed' && fin.data?.progress?.cursor === 5)

  const gen2 = await api('POST', `/api/challenge/${videoId}/generate`, {})
  check('换一套 → variant 递增', gen2.status === 201 && gen2.data?.variant === (ch.variant || 0) + 1,
    `第 ${gen2.data?.variant} 套`)

  const old = await api('GET', `/api/challenge/${videoId}?variant=${ch.variant}`)
  check('历史版本仍有报告', old.data?.variant === ch.variant && Boolean(old.data?.progress?.report?.summary),
    `variant ${old.data?.variant}`)

  const gone = await api('GET', '/api/conversation/recent')
  check('多轮对话接口已下线（404）', gone.status === 404, `HTTP ${gone.status}`)

  const page = await verifyPage(videoId)
  console.log(page === 'skip' ? 'SKIP  页面级校验（未设置 CDP_URL 或 Chrome 未开调试端口）' : '')
} catch (err) {
  check('脚本执行未抛异常', false, err?.message || String(err))
} finally {
  stub.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}${f.extra ? `（${f.extra}）` : ''}`)
  process.exit(1)
}
