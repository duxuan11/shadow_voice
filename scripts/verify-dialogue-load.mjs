#!/usr/bin/env node
// CDP 校验：中译英对话页能离开「加载中…」并真正发起 /api/dialogue 请求。
//
// 这个脚本守的是一类只在 dev 出现的 bug：React StrictMode 会 mount→cleanup→mount，
// 若启动流程在 cleanup 里被标记取消、又在第二次 mount 被"已启动"挡掉，
// 页面会永久停在「加载中…」（请求日志里能看到 /data/consolidated.json，但没有 /api/dialogue）。
//
// 前置：
//   1) Chrome 已开远程调试：chrome --headless=new --remote-debugging-port=9222
//   2) 应用在跑（dev 或 build 后由 server 提供），并且后端 /api 可用
//   3) 准备一个登录 token（curl 注册/登录拿 token）
//
// 用法：
//   SV_TOKEN=<jwt> node scripts/verify-dialogue-load.mjs
//   SV_TOKEN=<jwt> APP_URL=http://localhost:5180 VIDEO_ID=<id> node scripts/verify-dialogue-load.mjs
import fs from 'node:fs'

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const APP = process.env.APP_URL || 'http://localhost:5173'
const TOKEN = process.env.SV_TOKEN || ''
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const LOADING_TEXT = '加载中'

function firstVideoId() {
  if (process.env.VIDEO_ID) return process.env.VIDEO_ID
  try {
    const videos = JSON.parse(fs.readFileSync('data/consolidated.json', 'utf-8'))
    return videos[0]?.id || ''
  } catch {
    return ''
  }
}

const VIDEO_ID = firstVideoId()

if (!TOKEN || !VIDEO_ID) {
  console.error('需要 SV_TOKEN（登录 token）与可用的 VIDEO_ID（或 data/consolidated.json）')
  process.exit(2)
}

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const calls = []

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
  source: `window.__calls=[];const f=window.fetch;window.fetch=function(...a){window.__calls.push(String(a[0]));return f.apply(this,a)};`,
})
await send('Page.navigate', { url: `${APP}/video/${VIDEO_ID}/dialogue` })

let text = ''
for (let i = 0; i < 25; i++) {
  await sleep(1000)
  text = (await evaluate('document.body.innerText.slice(0, 200)')) || ''
  if (text && !text.includes(LOADING_TEXT)) break
}
calls.push(...JSON.parse((await evaluate('JSON.stringify(window.__calls || [])')) || '[]'))

const hitDialogueApi = calls.some((u) => String(u).includes('/api/dialogue/'))
const leftLoading = !!text && !text.includes(LOADING_TEXT)

console.log(`${leftLoading ? 'PASS' : 'FAIL'}  离开加载态（当前文案：${leftLoading ? text.split('\n')[0] : '仍在加载中'}）`)
console.log(`${hitDialogueApi ? 'PASS' : 'FAIL'}  发起过 /api/dialogue 请求（共 ${calls.length} 次 fetch）`)
if (!leftLoading || !hitDialogueApi) {
  console.log('FETCH:', JSON.stringify(calls))
  ws.close()
  process.exit(1)
}
ws.close()
process.exit(0)
