const test = require('node:test')
const assert = require('node:assert/strict')

const { extractJson, isConfigured, AI_MODEL } = require('./provider.cjs')

test('extractJson 剥离 markdown 代码块', () => {
  const text = '```json\n{"a": 1}\n```'
  assert.deepEqual(extractJson(text), { a: 1 })
})

test('extractJson 从多余文本中提取', () => {
  const text = '好的，以下是结果：{"turns": [{"score": 76}]} 希望对你有帮助'
  assert.deepEqual(extractJson(text).turns[0].score, 76)
})

test('extractJson 无 JSON 时抛错', () => {
  assert.throws(() => extractJson('没有 JSON 的纯文本'))
})

test('isConfigured 反映 AI_API_KEY', () => {
  assert.equal(typeof isConfigured(), 'boolean')
})

test('AI_MODEL 有默认值', () => {
  assert.ok(AI_MODEL.length > 0)
})

// ── chat() 请求构造 / 错误路径（fetch stub，零新依赖）──

// 重载 provider 模块（清 env + require.cache），返回 chat/isConfigured
function loadProvider(env) {
  const providerPath = require.resolve('./provider.cjs')
  const saved = {}
  for (const k of Object.keys(process.env)) if (k.startsWith('AI_')) saved[k] = process.env[k]
  for (const k of Object.keys(saved)) delete process.env[k]
  Object.assign(process.env, env)
  delete require.cache[providerPath]
  const mod = require('./provider.cjs')
  // 恢复 env（不恢复 require.cache——测试进程内最后一个加载版本可复用）
  for (const k of Object.keys(process.env)) if (k.startsWith('AI_')) delete process.env[k]
  Object.assign(process.env, saved)
  return mod
}

test('chat() 成功路径：URL/method/headers/body 正确', async () => {
  const savedFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    }
  }
  try {
    const { chat } = loadProvider({ AI_API_KEY: 'test-key', AI_BASE_URL: 'https://api.deepseek.com/v1', AI_MODEL: 'deepseek-chat' })
    const out = await chat([{ role: 'user', content: 'hi' }], { temperature: 0.4, maxTokens: 500 })
    assert.equal(out, 'hello')
    assert.equal(captured.url, 'https://api.deepseek.com/v1/chat/completions')
    assert.equal(captured.opts.method, 'POST')
    assert.equal(captured.opts.headers.Authorization, 'Bearer test-key')
    assert.match(captured.opts.headers['Content-Type'], /application\/json/)
    const body = JSON.parse(captured.opts.body)
    assert.equal(body.model, 'deepseek-chat')
    assert.equal(body.messages[0].content, 'hi')
    assert.equal(body.temperature, 0.4)
    assert.equal(body.max_tokens, 500)
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('chat() HTTP 非 2xx 抛错含状态码', async () => {
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  try {
    const { chat } = loadProvider({ AI_API_KEY: 'test-key' })
    await assert.rejects(() => chat([{ role: 'user', content: 'x' }]), /HTTP 500/)
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('chat() 无 content 抛错', async () => {
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: {} }] }) })
  try {
    const { chat } = loadProvider({ AI_API_KEY: 'test-key' })
    await assert.rejects(() => chat([{ role: 'user', content: 'x' }]), /AI 响应为空/)
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('chat() 未配置抛错且不调 fetch', async () => {
  const savedFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('should not be called') }
  try {
    const { chat } = loadProvider({})
    await assert.rejects(() => chat([{ role: 'user', content: 'x' }]), /AI 未配置/)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('chat() 超时中止（30s mock timers）', async () => {
  const { mock } = require('node:test')
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    await new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  try {
    const { chat } = loadProvider({ AI_API_KEY: 'test-key' })
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const p = assert.rejects(() => chat([{ role: 'user', content: 'x' }]))
      mock.timers.tick(30000)
      await p
    } finally {
      mock.timers.reset()
    }
  } finally {
    globalThis.fetch = savedFetch
  }
})
