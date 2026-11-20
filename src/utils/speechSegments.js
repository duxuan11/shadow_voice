// 分段语音输入的续识判定（纯函数，便于单测）：
// Web Speech 每轮识别在安静一会儿后就 onend，分段模式必须自己续识，
// 否则第一段之后麦克风静默失效——用户以为还在录音，实际全丢。
// 阿里云路径不需要它：那边是 60 秒自动切段、麦克风不断。
export function shouldRestartSegment({ segmented, source, listening } = {}) {
  return Boolean(segmented) && source === 'web' && Boolean(listening)
}
