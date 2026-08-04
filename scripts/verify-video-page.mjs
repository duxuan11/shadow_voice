#!/usr/bin/env node
// CDP 验证：shadow_voice 视频页 字幕跟随 / 全屏失败路径 行为
// 前置：
//   1) chromium --headless=new --remote-debugging-port=9222 已启动（加 --no-sandbox --autoplay-policy=no-user-gesture-required）
//   2) 应用已构建并运行在 http://localhost:3001（npm run build && node server/index.cjs）
// 用法：node scripts/verify-video-page.mjs [desktop|mobile|all]
const BASE = 'http://127.0.0.1:9222'
const APP = 'http://localhost:3001'
const PAGE = `${APP}/video/33650c75-6deb-4911-bea8-a9645e4a836b` // 出国旅行的日常

const mode = process.argv[2] || 'all'
const modes = mode === 'all' ? ['desktop', 'mobile'] : [mode]
const sleep = ms => new Promise(r => setTimeout(r, ms))
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
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.text }
  return r.result.value
}

async function runMode(modeName) {
  console.log(`\n=== ${modeName.toUpperCase()} ===`)
  const isMobile = modeName === 'mobile'
  const tab = await newTab(APP + '/')
  const cdp = await connect(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await sleep(2500)
  await ev(cdp, `sessionStorage.setItem('shadow_voice_guest','true')`)
  if (isMobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  }
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(5000)

  const cardSel = isMobile ? '[data-mobile-sub-index]' : '[id^="sub-item-"]'
  const activeCls = isMobile ? 'bg-gradient-to-br' : 'border-l-indigo-600'
  const snapExpr = `(() => {
    const cards = [...document.querySelectorAll('${cardSel}')]
    const activeIdx = cards.findIndex(c => c.className.includes('${activeCls}'))
    const scroller = cards[0]?.parentElement
    const cRect = scroller?.getBoundingClientRect()
    const eRect = activeIdx >= 0 ? cards[activeIdx].getBoundingClientRect() : null
    return {
      cardCount: cards.length,
      activeIdx,
      winScrollY: Math.round(window.scrollY),
      docScrollH: document.documentElement.scrollHeight,
      docClientH: document.documentElement.clientHeight,
      scrollerScrollTop: Math.round(scroller?.scrollTop ?? -1),
      topGap: eRect && cRect ? Math.round(eRect.top - cRect.top) : null,
      videoContain: document.querySelector('video')?.className.includes('object-contain') ?? false
    }
  })()`

  // 1) 页面加载
  let s = await ev(cdp, snapExpr)
  check(`[${modeName}] 字幕渲染 35 条`, s.cardCount === 35, `count=${s.cardCount}`)
  if (isMobile) {
    check(`[${modeName}] 文档无溢出 docScrollH<=docClientH`, s.docScrollH <= s.docClientH, `${s.docScrollH} vs ${s.docClientH}`)
  }
  check(`[${modeName}] 初始 window.scrollY==0`, s.winScrollY === 0, `y=${s.winScrollY}`)

  // 2) seek 41s（字幕17 内）→ 温和跟随：整页不动、容器滚动、当前句置顶
  await ev(cdp, `(() => { const v = document.querySelector('video'); if (v) v.currentTime = 41 })()`)
  await sleep(2400)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 整页未被拖动 winScrollY==0`, s.winScrollY === 0, `y=${s.winScrollY}`)
  check(`[${modeName}] 字幕容器已滚动`, s.scrollerScrollTop > 1000, `top=${s.scrollerScrollTop}`)
  check(`[${modeName}] 当前字幕置顶 topGap∈[0,20]`, s.topGap !== null && s.topGap >= 0 && s.topGap <= 20, `gap=${s.topGap}`)
  check(`[${modeName}] 当前字幕=17`, s.activeIdx === 17, `idx=${s.activeIdx}`)

  // 3) 间隙保留：38s→16，40.0s（间隙）→仍16
  await ev(cdp, `(() => { const v = document.querySelector('video'); if (v) v.currentTime = 38 })()`)
  await sleep(1500)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 38s 激活字幕=16`, s.activeIdx === 16, `idx=${s.activeIdx}`)
  await ev(cdp, `(() => { const v = document.querySelector('video'); if (v) v.currentTime = 40 })()`)
  await sleep(1500)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 间隙 40.0s 保留上一条=16`, s.activeIdx === 16, `idx=${s.activeIdx}`)

  // 4) 全屏失败路径（无头环境 requestFullscreen 必失败）→ isFullscreen 不置真
  await ev(cdp, `(() => { const b = document.querySelector('button[title="全屏"]'); if (b) b.click() })()`)
  await sleep(800)
  s = await ev(cdp, snapExpr)
  check(`[${modeName}] 全屏失败后视频仍 object-cover`, s.videoContain === false)

  cdp.close()
  // 关闭标签页，避免重复运行累积内存
  try { await fetch(`${BASE}/json/close/${tab.id}`) } catch { /* ignore */ }
}

;(async () => {
  for (const m of modes) await runMode(m)
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})()
