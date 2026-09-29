#!/usr/bin/env node
// 词卡 → 生词本 端到端验证（Playwright + 真实后端 + 真实数据）。
//
// 前置：
//   1) npm install --no-save playwright && npx playwright install chromium
//   2) npm run build && npm run server   （服务在 http://localhost:3001）
// 用法：node scripts/verify-vocab-e2e.mjs
//
// 覆盖：加入 → 刷新仍在 → 去重 → 多视频来源 → 来源跳回词卡 → 移除同步 → 手机竖屏。
import { chromium } from 'playwright'

const APP = 'http://localhost:3001'
const VIDEO_A = 'bca7e412-25c6-4813-9cb8-361457844874' // 机场出行英语场景（passport）
const VIDEO_B = '9c54d1b7-2291-46c9-a218-2acfc7c60bec' // 里斯本悠闲漫游日记（excited）
const VIDEO_C = 'd4f438e2-c9df-4ab5-9c25-d7f297b6bc46' // 布拉迪斯拉旅行（excited）

let failures = 0
function check(name, cond, detail = '') {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

async function registerUser() {
  const username = `ve2e${Date.now().toString(36)}`
  const res = await fetch(`${APP}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: 'test123456' }),
  })
  if (!res.ok) throw new Error(`注册失败：${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.token
}

async function openWordCard(page) {
  await page.locator('button', { hasText: '词卡' }).first().click()
  await page.getByText('智能重点词卡').waitFor({ state: 'visible', timeout: 8000 })
}

async function toggleFor(page, word) {
  return page.locator(`#wc-${word} .vocab-toggle`)
}

async function isAdded(toggle) {
  return (await toggle.getAttribute('class') || '').includes('is-added')
}

async function runDesktop(browser, token) {
  console.log('\n===== 桌面端（1280×800） =====')
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(t => localStorage.setItem('shadow_voice_token', t), token)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

  // 1. 视频 A：加入 passport
  await page.goto(`${APP}/video/${VIDEO_A}`, { waitUntil: 'domcontentloaded' })
  await openWordCard(page)
  const passport = await toggleFor(page, 'passport')
  await passport.waitFor({ state: 'visible', timeout: 8000 })
  check('词卡单词显示音标', await page.locator('#wc-passport .vocab-phonetic').count() > 0)
  check('加入前不是已加入', !(await isAdded(passport)))
  await passport.click()
  await page.waitForFunction(() => document.querySelector('#wc-passport .vocab-toggle')?.classList.contains('is-added'), null, { timeout: 8000 })
  check('点击加入后按钮变为已加入', await isAdded(passport))

  // 2. 刷新后仍在（持久化到服务端）
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openWordCard(page)
  const passport2 = await toggleFor(page, 'passport')
  await passport2.waitFor({ state: 'visible', timeout: 8000 })
  check('刷新页面后收藏状态仍在', await isAdded(passport2))

  // 3. 多视频来源：excited 从 B、C 两个视频加入
  await page.goto(`${APP}/video/${VIDEO_B}`, { waitUntil: 'domcontentloaded' })
  await openWordCard(page)
  const excitedB = await toggleFor(page, 'excited')
  await excitedB.waitFor({ state: 'visible', timeout: 8000 })
  await excitedB.click()
  await page.waitForFunction(() => document.querySelector('#wc-excited .vocab-toggle')?.classList.contains('is-added'), null, { timeout: 8000 })

  await page.goto(`${APP}/video/${VIDEO_C}`, { waitUntil: 'domcontentloaded' })
  await openWordCard(page)
  const excitedC = await toggleFor(page, 'excited')
  await excitedC.waitFor({ state: 'visible', timeout: 8000 })
  check('已收藏的词在第二个视频不算本视频来源', !(await isAdded(excitedC)))
  check('第二个视频按钮提示「加入本视频」', (await excitedC.textContent() || '').includes('加入本视频'))
  await excitedC.click()
  await page.waitForFunction(() => document.querySelector('#wc-excited .vocab-toggle')?.classList.contains('is-added'), null, { timeout: 8000 })

  // 4. 生词本页面
  await page.goto(`${APP}/records`, { waitUntil: 'domcontentloaded' })
  await page.locator('.tab-btn', { hasText: '生词本' }).click()
  await page.locator('.vocab-card').first().waitFor({ timeout: 8000 })
  const cardCount = await page.locator('.vocab-card').count()
  check('生词本含 passport 与 excited 两条', cardCount === 2, `实际 ${cardCount}`)

  const excitedCard = page.locator('.vocab-card', { hasText: 'excited' })
  check('生词本显示音标', await excitedCard.locator('.vocab-phonetic').count() > 0)
  const sourceCount = await excitedCard.locator('.vocab-source-chip').count()
  check('excited 去重为一个条目且有两个来源', sourceCount === 2, `来源数 ${sourceCount}`)

  // 分类筛选
  await page.locator('.vocab-filter-btn').filter({ hasText: /^短语/ }).click()
  check('切到「短语」后过滤掉单词', await page.locator('.vocab-card').count() === 0)
  await page.locator('.vocab-filter-btn').filter({ hasText: /^全部/ }).click()
  check('切回「全部」恢复', await page.locator('.vocab-card').count() === 2)

  // 5. 来源跳回视频词卡位置
  await excitedCard.locator('.vocab-source-chip').first().click()
  await page.waitForURL(/card=1/, { timeout: 8000 })
  await page.getByText('智能重点词卡').waitFor({ state: 'visible', timeout: 8000 })
  check('来源跳转打开词卡', await page.locator('#wc-excited').count() > 0)

  // 6. 从生词本移除 excited → 视频词卡同步
  await page.goto(`${APP}/records`, { waitUntil: 'domcontentloaded' })
  await page.locator('.tab-btn', { hasText: '生词本' }).click()
  await page.locator('.vocab-card').first().waitFor({ timeout: 8000 })
  await page.locator('.vocab-card', { hasText: 'excited' }).locator('.vocab-remove-btn').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.vocab-card-word')].some(e => e.textContent === 'excited'), null, { timeout: 8000 })
  check('移除后生词本不再有 excited', await page.locator('.vocab-card', { hasText: 'excited' }).count() === 0)

  await page.goto(`${APP}/video/${VIDEO_B}`, { waitUntil: 'domcontentloaded' })
  await openWordCard(page)
  const excitedAfter = await toggleFor(page, 'excited')
  await excitedAfter.waitFor({ state: 'visible', timeout: 8000 })
  check('移除后视频词卡收藏状态同步取消', !(await isAdded(excitedAfter)))

  check('桌面端无页面级 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '))
  await context.close()
}

async function runMobile(browser, token) {
  console.log('\n===== 手机端（390×844，触屏） =====')
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  await context.addInitScript(t => localStorage.setItem('shadow_voice_token', t), token)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))

  await page.goto(`${APP}/video/${VIDEO_A}`, { waitUntil: 'domcontentloaded' })
  await page.locator('button', { hasText: '词卡' }).first().click()
  await page.getByText('智能重点词卡').waitFor({ state: 'visible', timeout: 8000 })

  const toggle = page.locator('#wc-economy .vocab-toggle')
  await toggle.waitFor({ state: 'visible', timeout: 8000 })
  const box = await toggle.boundingBox()
  check('手机端收藏按钮点击区足够大（≥40px）', box && box.height >= 40 && box.width >= 100, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '无')

  await toggle.click()
  await page.waitForFunction(() => document.querySelector('#wc-economy .vocab-toggle')?.classList.contains('is-added'), null, { timeout: 8000 })
  check('手机端点击加入成功', await isAdded(toggle))
  check('加入后词卡未关闭（抽屉仍在）', await page.getByText('智能重点词卡').isVisible())

  // 生词本页面手机布局
  await page.goto(`${APP}/records`, { waitUntil: 'domcontentloaded' })
  await page.locator('.tab-btn', { hasText: '生词本' }).click()
  await page.locator('.vocab-card').first().waitFor({ timeout: 8000 })
  check('生词本手机端显示 economy', await page.locator('.vocab-card', { hasText: 'economy' }).count() > 0)
  const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
  check('手机端无横向溢出', overflow <= 1, `溢出 ${overflow}px`)
  const filterBox = await page.locator('.vocab-filter').boundingBox()
  check('分类筛选不破坏布局', filterBox && filterBox.width <= 391)

  // 触屏移除
  await page.locator('.vocab-card', { hasText: 'economy' }).locator('.vocab-remove-btn').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.vocab-card-word')].some(e => e.textContent === 'economy'), null, { timeout: 8000 })
  check('手机端触屏移除成功', await page.locator('.vocab-card', { hasText: 'economy' }).count() === 0)

  await page.goto(`${APP}/video/${VIDEO_A}`, { waitUntil: 'domcontentloaded' })
  await page.locator('button', { hasText: '词卡' }).first().click()
  await page.getByText('智能重点词卡').waitFor({ state: 'visible', timeout: 8000 })
  const economyAfter = page.locator('#wc-economy .vocab-toggle')
  await economyAfter.waitFor({ state: 'visible', timeout: 8000 })
  check('手机端移除后视频词卡状态同步', !(await isAdded(economyAfter)))

  await page.screenshot({ path: '/tmp/sv-vocab-mobile.png', fullPage: false })
  check('手机端无页面级 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '))
  await context.close()
}

async function main() {
  const token = await registerUser()
  const browser = await chromium.launch()
  try {
    await runDesktop(browser, token)
    await runMobile(browser, token)
  } finally {
    await browser.close()
  }
  console.log(`\n===== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} =====`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
