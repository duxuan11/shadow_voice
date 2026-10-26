#!/usr/bin/env node
// 文本练习端到端校验（CDP + 真浏览器 + 真后端 + 假 AI）。
//
// 前置：
//   1) 后端在跑，并且把 AI 指向本脚本起的假 AI：
//        AI_API_KEY=test AI_BASE_URL=http://127.0.0.1:3999/v1 SHADOW_VOICE_DB=<临时库> npm run server
//      前端用 `npm run build` 的产物（后端 3001 直接托管 dist）。
//   2) 本机有 Chrome（可用 CHROME_PATH 覆盖），脚本自己以 headless 起远程调试。
//
// 覆盖：个人中心入口 → 粘贴保存（含 Markdown 表格/术语）→ 中文生成 → 汉译英提交与评分
//      → 刷新后进度仍在 → 移动端无横向溢出 → 改名保留进度 → 删除 → 既有关键页面无控制台错误。
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP = process.env.APP_URL || 'http://localhost:3001'
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const AI_PORT = Number(process.env.AI_STUB_PORT || 3999)
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const SAMPLE = [
  '# U-Net',
  '',
  'U-Net has an encoder and a decoder. PaCMAP preserves structure.',
  '',
  '| Method | Dataset |',
  '| --- | --- |',
  '| SAM | COCO |',
  '',
  '```js',
  'const notASentence = 1. Never practiced.',
  '```',
].join('\n')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 假 AI：只回 chat/completions，记录收到的 prompt 以便断言术语保真 ──
const seenPrompts = []
const aiServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let messages = []
    try { messages = JSON.parse(body).messages || [] } catch { /* ignore */ }
    const system = messages[0]?.content || ''
    const user = messages[messages.length - 1]?.content || ''
    seenPrompts.push(user)

    let content
    if (system.includes('译者')) {
      const idx = [...user.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
      content = JSON.stringify({ items: idx.map((i) => ({ i, cn: `第${i}句中文` })) })
    } else {
      content = JSON.stringify({
        verdict: 'correct',
        score: 92,
        issues: [{ type: 'term', location: 'Unet', problem: '术语被改写', suggestion: '写回 U-Net', better: 'U-Net' }],
        better: 'U-Net consists of an encoder and a decoder.',
        praise: '术语保留正确。',
      })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
})

// ── CDP 极简客户端（Node 22 自带 WebSocket）──
let ws, seq = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return undefined
  return res.result?.result?.value
}
const waitFor = async (expression, timeout = 12000, step = 150) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true
    await sleep(step)
  }
  return false
}

const bodyText = () => evaluate('document.body.innerText')
const clickByText = (selector, text) => evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}) && !e.disabled)
  if (!el) return false
  el.click()
  return true
})()`)
const setField = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
const goto = async (url) => {
  await send('Page.navigate', { url })
  await sleep(400)
}
const currentUrl = () => evaluate('location.href')

async function api(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// ── 启动 ───────────────────────────────────────────────
await new Promise((r) => aiServer.listen(AI_PORT, r))
console.log(`fake AI 已监听 :${AI_PORT}`)

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svtexts-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' })

let version = null
for (let i = 0; i < 60; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
    break
  } catch { await sleep(250) }
}
if (!version) {
  console.error('无法连接 Chrome 调试端口，请检查 CHROME_PATH / CDP_PORT')
  process.exit(2)
}

const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method === 'Page.javascriptDialogOpening') {
    const dialog = msg.params
    send('Page.handleJavaScriptDialog', {
      accept: true,
      ...(dialog.type === 'prompt' ? { promptText: '改名后的文本' } : {}),
    })
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'exception')
  }
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

// 注册一次性用户，前端直接注入 token（跳过登录 UI）
const username = `tp${Date.now().toString(36)}`
const registered = await api('/api/auth/register', {
  method: 'POST',
  body: { username, email: `${username}@example.com`, password: 'test123456' },
})
const token = registered.body?.token
if (!token) {
  console.error('注册失败：', registered)
  process.exit(2)
}

await goto(`${APP}/login`)
await evaluate(`localStorage.setItem('shadow_voice_token', ${JSON.stringify(token)})`)

// 1) 个人中心入口
await goto(`${APP}/profile`)
const profileReady = await waitFor(`document.body.innerText.includes('文本练习')`)
check('个人中心出现「文本练习」入口', profileReady)
check('生词本入口仍在（未破坏既有区块）', (await bodyText())?.includes('生词本'))
check('非游客空态提示', (await bodyText())?.includes('还没有文本'))

// 2) 进入列表页
await clickByText('button', '全部文本')
const listReady = await waitFor(`location.pathname === '/texts'`)
check('点「全部文本」进入 /texts', listReady, await currentUrl())

// 3) 粘贴保存
await clickByText('button', '粘贴新文本')
await waitFor(`!!document.querySelector('input')`)
await setField('input', 'U-Net 摘要练习')
await setField('textarea', SAMPLE)
await clickByText('button', '保存并生成中文')
const detailReady = await waitFor(`location.pathname.startsWith('/texts/')`, 20000)
check('保存后进入详情页', detailReady, await currentUrl())

const docId0 = (await currentUrl()).split('/texts/')[1]
const created = await api(`/api/texts/${docId0}`, { token })
const sentences = created.body?.doc?.sentences || []
const enList = sentences.map((s) => s.en)
const detailText = await bodyText()
check('句子渲染且代码块被丢弃', detailText.includes('U-Net has an encoder and a decoder.') && !enList.some((e) => e.includes('notASentence')))
check('表格单元格成为练习句', enList.includes('SAM') && enList.includes('COCO'))
check('中文译文已生成', sentences[0]?.cn === '第0句中文' && sentences.every((s) => s.cn))
check('术语原样进入翻译 prompt', seenPrompts.some((p) => p.includes('U-Net') && p.includes('PaCMAP')))
await clickByText('button', '显示中文')
check('跟读页可展开中文对照', await waitFor(`document.body.innerText.includes('第0句中文')`, 5000))
check('跟读评测组件已挂载', (await bodyText()).includes('点击麦克风'))

// 3b) 个人中心能看到最近文本
await goto(`${APP}/profile`)
check('个人中心列出最近文本', await waitFor(`document.body.innerText.includes('U-Net 摘要练习')`, 8000))
await goto(`${APP}/texts/${docId0}`)
await waitFor(`document.body.innerText.includes('逐句跟读')`)

// 4) 汉译英：未提交时「对照原文」禁用
await clickByText('button', '汉译英')
await waitFor(`document.body.innerText.includes('第0句中文')`)
const revealDisabled = await evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('对照原文'))
  return !!el && el.disabled
})()`)
check('未提交答案时「对照原文」禁用', revealDisabled)

await setField('textarea', 'Unet has an encoder and a decoder.')
await clickByText('button', '提交答案')
const reviewReady = await waitFor(`document.body.innerText.includes('92分')`, 15000)
check('提交后出评分卡', reviewReady)
const afterReview = await bodyText()
check('评分显示 verdict 与更地道说法', afterReview.includes('写对了') && afterReview.includes('consists of'))
check('术语问题被指出', afterReview.includes('术语'))

const docId = (await currentUrl()).split('/texts/')[1]
const saved = await api(`/api/texts/${docId}`, { token })
check('作答已落库（answers 1 条）', saved.body?.progress?.answers?.length === 1)
check('回译游标已前进', saved.body?.progress?.translateCursor === 1)

// 5) 刷新后仍能恢复：续练落在第一句未作答处，点「上一句」能回看已保存的评分
await goto(`${APP}/texts/${docId}`)
await clickByText('button', '汉译英')
await waitFor(`document.body.innerText.includes('汉译英')`)
const resumedAt = await evaluate(`document.body.innerText.includes('2/')`)
check('刷新后从第一条未作答句续练', resumedAt)
await clickByText('button', '上一句')
const restored = await waitFor(`document.body.innerText.includes('92分')`, 15000)
check('回看上一句时回显已保存的评分', restored)

// 6) 移动端 390px 无横向溢出
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await goto(`${APP}/texts/${docId}`)
await sleep(800)
const overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth')
check('移动端无横向溢出', overflow <= 1, `溢出 ${overflow}px`)
const mobileDetail = await bodyText()
check('移动端详情页可用', mobileDetail.includes('逐句跟读') && mobileDetail.includes('汉译英'))
await send('Emulation.clearDeviceMetricsOverride')

// 7) 改名保留进度
await goto(`${APP}/texts/${docId}`)
await waitFor(`document.body.innerText.includes('逐句跟读')`)
await clickByText('h1', 'U-Net 摘要练习')
await sleep(600)
const renamed = await waitFor(`document.body.innerText.includes('改名后的文本')`)
check('点标题可改名', renamed)
const afterRename = await api(`/api/texts/${docId}`, { token })
check('改名后进度保留', afterRename.body?.progress?.answers?.length === 1)

// 7b) 列表页「编辑」只改标题 → 进度必须保留（回归：曾经会清空）
await goto(`${APP}/texts`)
await waitFor(`document.body.innerText.includes('改名后的文本')`, 10000)
await clickByText('button', '编辑')
await waitFor(`!!document.querySelector('input')`, 10000)
await sleep(400)
await setField('input', '列表改名')
await clickByText('button', '保存')
await waitFor(`location.pathname.startsWith('/texts/')`, 15000)
const afterListEdit = await api(`/api/texts/${docId}`, { token })
check('列表页只改标题不清进度', afterListEdit.body?.progress?.answers?.length === 1 && afterListEdit.body?.doc?.title === '列表改名')

// 7c) 完成练习 → 出完成面板，重进仍显示（回归：曾经回到跟读卡片）
await goto(`${APP}/texts/${docId}`)
await clickByText('button', '汉译英')
await waitFor(`document.body.innerText.includes('汉译英')`, 10000)
for (let i = 0; i < 12; i++) {
  const atEnd = await evaluate(`[...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('完成练习'))`)
  if (atEnd) break
  await clickByText('button', '下一句')
  await sleep(250)
}
await clickByText('button', '完成练习')
check('点「完成练习」出现完成面板', await waitFor(`document.body.innerText.includes('这份文本已经练完了')`, 10000))
await goto(`${APP}/texts/${docId}`)
check('重进默认显示完成面板', await waitFor(`document.body.innerText.includes('这份文本已经练完了')`, 12000))

// 8) 删除回到列表
await evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === '更多')
  if (el) el.click()
  return !!el
})()`)
await sleep(300)
await clickByText('button', '删除文本')
const backToList = await waitFor(`location.pathname === '/texts'`, 10000)
check('删除后回到列表', backToList, await currentUrl())
const emptyAgain = await waitFor(`document.body.innerText.includes('还没有文本')`)
check('列表已清空', emptyAgain)

// 9) 既有页面回归（无控制台报错）
consoleErrors.length = 0
pageErrors.length = 0
const videos = JSON.parse(fs.readFileSync('data/consolidated.json', 'utf-8'))
const videoPath = `/video/${videos[0].id}`
for (const pathname of ['/', '/profile', '/records', videoPath]) {
  await goto(`${APP}${pathname}`)
  await sleep(1200)
  check(`既有页面可打开：${pathname}`, (await bodyText())?.length > 0)
}
await goto(`${APP}/profile`)
await sleep(1200)
check('既有页面无控制台错误', consoleErrors.length === 0 && pageErrors.length === 0, [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))

// ── 收尾 ───────────────────────────────────────────────
chrome.kill()
aiServer.close()
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
