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
