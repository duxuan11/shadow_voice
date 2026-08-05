#!/usr/bin/env node
// e2e（CDP）：明文 HTTP 源（非 localhost）下点击跟读麦克风，
// 应显示可操作的 HTTPS 提示（而非误导性"请使用 Chrome / Edge / Firefox"），
// 且不再卡在"正在获取麦克风权限"。
// 前置：chromium --remote-debugging-port=9222 已启动；dist 已构建并由
// 局域网 IP 上的静态服务器提供（python3 -m http.server 8899 --bind 0.0.0.0）。
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = 'http://127.0.0.1:9222'
const APP = 'http://192.168.12.45:8899'
let failures = 0
function check(name, cond, detail) {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
  if (!ok) failures++
}

async function newTab(url) {
  const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  return res.json()
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id
          pending.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      close() { ws.close() }
    })
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
      }
    }
    ws.onerror = reject
  })
}
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
  return r.result.value
}

try {
  const tab = await newTab(APP + '/')
  const cdp = await connect(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await sleep(2500)
  await ev(cdp, `sessionStorage.setItem('shadow_voice_guest','true')`)
  await cdp.send('Page.navigate', { url: APP + '/video/33650c75-6deb-4911-bea8-a9645e4a836b' })
  await sleep(6000)

  // 播放+seek 到 41s 激活字幕，切「跟读」面板
  await ev(cdp, `document.querySelector('video') && document.querySelector('video').play()`)
  await sleep(800)
  await ev(cdp, `document.querySelector('video').currentTime = 41`)
  await sleep(1200)
  await ev(cdp, `document.querySelector('video').pause()`)
  await sleep(500)
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('跟读')); b && b.click(); return !!b })()`)
  await sleep(1500)
  const micClicked = await ev(cdp, `(() => { const target = [...document.querySelectorAll('button')].find(x => x.className.includes('bg-indigo-600') && x.className.includes('rounded-full')); target && target.click(); return !!target })()`)
  check('找到并点击麦克风按钮', micClicked === true)
  await sleep(3000)

  const bodyText = await ev(cdp, `document.body.textContent`)
  const hasHttpsHint = typeof bodyText === 'string' && bodyText.includes('HTTPS')
  const hasMisleading = typeof bodyText === 'string' && bodyText.includes('请使用 Chrome / Edge / Firefox')
  const stuckPermission = typeof bodyText === 'string' && bodyText.includes('正在获取麦克风权限')
  check('显示可操作的 HTTPS 提示（而非误导性换浏览器提示）', hasHttpsHint && !hasMisleading)
  check('不再卡在「正在获取麦克风权限」', !stuckPermission)
  if (typeof bodyText === 'string') console.log('页面包含: ' + bodyText.split('\n').filter(l => l.includes('HTTPS') || l.includes('麦克风') || l.includes('Chrome')).join(' | ').slice(0, 300))

  cdp.close()
  try { await fetch(`${BASE}/json/close/${tab.id}`) } catch { /* ignore */ }
} catch (e) {
  console.log('FAIL  验证执行异常: ' + e.message)
  failures++
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
