// 阿里云口语评测 SDK（engine.js）加载相关纯函数，便于单测。
// engine.js 由用户从阿里云控制台"口语评测 → 管理项目 → JavaScript SDK"下载，
// 放置于 public/sdk/engine.js（vite 构建时自动复制进 dist）。

export const ENGINE_SDK_PATH = '/sdk/engine.js'

// ⚠️ 每次替换 public/sdk/engine.js 后请递增此版本号：
// 追加 ?v= 查询参数可绕过浏览器/代理对旧版本 SDK 的缓存。
export const ENGINE_SDK_VERSION = 1

export function buildEngineSdkUrl(version = ENGINE_SDK_VERSION) {
  return `${ENGINE_SDK_PATH}?v=${version}`
}

// 浏览器对麦克风采集（getUserMedia）的可用性判定。
// 关键事实：手机浏览器（Chrome/Safari/Firefox）只允许在安全上下文（HTTPS 或
// localhost）下使用 getUserMedia；明文 HTTP 的局域网 IP 页面里，navigator.mediaDevices
// 与 navigator.getUserMedia 整个不存在 —— 阿里云 engine.js 的 checkSuport 检测到
// 该缺失会回调 JSSDKNotSupport（前端曾误报"浏览器不支持"，实为环境问题）。
// 纯函数，env 参数便于单测注入模拟的 window/navigator。
export function micEnvironmentProblem(env = { window: typeof window !== 'undefined' ? window : null, navigator }) {
  const w = env.window
  const nav = env.navigator
  if (!w) return null // 非浏览器环境（如 node 单测）不判定
  if (!w.isSecureContext) {
    return {
      code: 'INSECURE_CONTEXT',
      message: '当前页面是明文 HTTP（非安全上下文），浏览器禁止网页调用麦克风。请改用 HTTPS 访问本应用（手机浏览器仅允许 HTTPS 或 localhost 下使用麦克风）',
    }
  }
  const hasGetUserMedia = !!(
    nav &&
    ((nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function') || typeof nav.getUserMedia === 'function')
  )
  if (!hasGetUserMedia) {
    return {
      code: 'NO_MEDIA_DEVICES',
      message: '当前浏览器不支持麦克风采集（getUserMedia 不可用），请使用新版 Chrome / Edge / Firefox',
    }
  }
  return null
}

// engine.js 回调 JSSDKNotSupport 时展示的提示：优先给出环境问题的可操作说明，
// 只有确认浏览器本身不支持时才提示换浏览器。env 参数供单测注入。
export function jssdkNotSupportMessage(env) {
  const problem = micEnvironmentProblem(env)
  if (problem) return problem.message
  return '当前浏览器不支持评测 SDK，请使用 Chrome / Edge / Firefox'
}

// 诊断服务器返回的 engine.js 内容是否可用。
// 背景：若生产环境 dist 构建于 SDK 放置之前，SPA 兜底会把 index.html 当作
// engine.js 返回 —— 脚本元素会触发 load 事件（而非 error），但 window.EngineEvaluat
// 未定义，前端会误报"已加载但未找到全局"。本函数把这类响应识别为可操作的错误。
export function analyzeEngineSdkBody(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return {
      ok: false,
      code: 'EMPTY',
      message: 'engine.js 内容为空，请确认 public/sdk/engine.js 已放置并重新构建前端',
    }
  }
  if (/^\s*</.test(text) || !text.includes('EngineEvaluat')) {
    return {
      ok: false,
      code: 'NOT_SDK',
      message: '服务器返回的不是 engine.js（疑似 SPA 兜底返回了 index.html），请重新构建部署前端（本地：npm run build；Docker：docker compose up --build）',
    }
  }
  return { ok: true, code: 'OK', message: '' }
}
