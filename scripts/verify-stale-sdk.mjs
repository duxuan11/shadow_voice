#!/usr/bin/env node
// CDP 验证：过期 dist 场景下（/sdk/engine.js 被 SPA 兜底返回 index.html），
// 点击麦克风应显示可操作的诊断错误（"服务器返回的不是 engine.js"），而非误导性的
// "engine.js 已加载但未找到 window.EngineEvaluat"。
// 前置：chromium --remote-debugging-port=9222 已启动
import { spawn } from 'node:child_process'

const BASE = 'http://127.0.0.1:9222'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
function check(name, cond, detail) {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
  if (!ok) failures++
}

// 1) 启动模拟过期 dist 的服务器（/sdk/* → index.html）
const server = spawn('node', ['/tmp/sdktest/stale-server.js'], { stdio: 'ignore' })
await sleep(1500)

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
  // 2) 打开过期服务器上的视频页（先设游客模式再导航）
  const tab = await newTab('http://localhost:8898/')
  const cdp = await connect(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await sleep(2500)
  await ev(cdp, `sessionStorage.setItem('shadow_voice_guest','true')`)
  await cdp.send('Page.navigate', { url: 'http://localhost:8898/video/33650c75-6deb-4911-bea8-a9645e4a836b' })
  await sleep(6000)

  // 3) 播放+seek 到 41s 激活字幕，切「跟读」面板，点麦克风
  await ev(cdp, `document.querySelector('video') && document.querySelector('video').play()`)
  await sleep(800)
  await ev(cdp, `document.querySelector('video').currentTime = 41`)
  await sleep(1200)
  await ev(cdp, `document.querySelector('video').pause()`)
  await sleep(500)
  await ev(cdp, `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('跟读')); b && b.click(); return !!b })()`)
  await sleep(1500)
  const micClicked = await ev(cdp, `(() => { const b = document.querySelector('button[title*="麦克风"], .rounded-full'); const target = [...document.querySelectorAll('button')].find(x => x.className.includes('bg-indigo-600') && x.className.includes('rounded-full')); target && target.click(); return !!target })()`)
  check('找到并点击麦克风按钮', micClicked === true)
  await sleep(3000)

  // 4) 错误信息应为可操作的诊断（NOT_SDK），而非误导性提示
  const bodyText = await ev(cdp, `document.body.textContent`)
  const hasActionable = typeof bodyText === 'string' && bodyText.includes('服务器返回的不是 engine.js')
  const hasMisleading = typeof bodyText === 'string' && bodyText.includes('已加载但未找到 window.EngineEvaluat')
  check('显示可操作诊断「服务器返回的不是 engine.js…请重新构建部署」', hasActionable)
  check('不再显示误导性「已加载但未找到 window.EngineEvaluat」', !hasMisleading)

  cdp.close()
  try { await fetch(`${BASE}/json/close/${tab.id}`) } catch { /* ignore */ }
} catch (e) {
  console.log('FAIL  验证执行异常: ' + e.message)
  failures++
} finally {
  server.kill()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
