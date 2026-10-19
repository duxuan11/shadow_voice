// 语音输入源选择：服务端 ASR 已配置 → aliyun；否则浏览器识别 → web；都没有 → none。
// 纯函数，页面/hook 据此决定降级路径（最终兜底是打字输入）。
export function selectSpeechSource(options) {
  const { configured, hasWebSpeech } = options && typeof options === 'object' ? options : {}
  if (configured === true) return 'aliyun'
  if (hasWebSpeech === true) return 'web'
  return 'none'
}
