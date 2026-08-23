// TTS 实机验证脚本（有凭据后跑）：
//   node scripts/tts-live-test.cjs
// 默认验证当前 TTS_PROVIDER；可传参覆盖：node scripts/tts-live-test.cjs aliyun
const tts = require('../server/services/tts/tts.cjs')

async function main() {
  const text = 'Hi there! Let us practice speaking English together.'
  console.log('TTS status:', JSON.stringify(tts.getStatus()))
  const buf = await tts.synthesize(text)
  console.log('合成成功，字节数:', buf.length)
  const out = `/tmp/tts-live-${Date.now()}.mp3`
  require('fs').writeFileSync(out, buf)
  console.log('已写入:', out)
}

main().catch((err) => {
  console.error('TTS 实机验证失败:', err.message)
  process.exit(1)
})
