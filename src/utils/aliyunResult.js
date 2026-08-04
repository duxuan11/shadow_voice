// 阿里云口语评测（en.sent.score）原始结果 → 前端 UI 归一化数据结构
// 字段说明见 docs/superpowers/specs/2026-08-04-aliyun-oral-evaluation-design.md

export function parseResult(msg) {
  const raw = typeof msg === 'string' ? JSON.parse(msg) : msg
  const r = (raw && raw.result) || {}
  const details = Array.isArray(r.details) ? r.details : []

  const words = details.map((w) => ({
    char: w.char || '',
    score: typeof w.score === 'number' ? w.score : null,
    start: w.start ?? null,
    end: w.end ?? null,
    dpType: w.dp_type ?? 0,            // 0 正常 / 1 漏读 / 2 重复读
    isPause: w.is_pause === 1,
    fakePron: w.fake_pron === 1,       // 集外词（不在词典）
    liaison: { ref: w.liaisonref ?? 0, score: w.liaisonscore ?? 0 },
    stress: { ref: w.stressref ?? 0, score: w.stressscore ?? 0 },
    tone: { ref: w.toneref ?? 0, score: w.tonescore ?? 0 },
    sense: { ref: w.senseref ?? 0, score: w.sensescore ?? 0 },
    phones: Array.isArray(w.phone)
      ? w.phone.map((p) => ({
          char: p.char || '',
          score: typeof p.score === 'number' ? p.score : null,
          pherr: p.pherr ?? 0,         // 音素检错 0/1（需 phdet=1）
          ph2alpha: p.ph2alpha || '',  // 音素对应的单词字母
        }))
      : [],
  }))

  const liaisonWords = words.filter((w) => w.liaison.ref === 1)

  return {
    overall: typeof r.overall === 'number' ? r.overall : null,
    accuracy: typeof r.accuracy === 'number' ? r.accuracy : (typeof r.pron === 'number' ? r.pron : null),
    integrity: typeof r.integrity === 'number' ? r.integrity : null,
    fluency: {
      overall: r.fluency && typeof r.fluency.overall === 'number' ? r.fluency.overall : null,
      pause: r.fluency && typeof r.fluency.pause === 'number' ? r.fluency.pause : null,
      speed: r.fluency && typeof r.fluency.speed === 'number' ? r.fluency.speed : null, // 0慢 1正常 2快
    },
    rhythm: {
      overall: r.rhythm && typeof r.rhythm.overall === 'number' ? r.rhythm.overall : null,
      sense: r.rhythm && typeof r.rhythm.sense === 'number' ? r.rhythm.sense : null,
      stress: r.rhythm && typeof r.rhythm.stress === 'number' ? r.rhythm.stress : null,
      tone: r.rhythm && typeof r.rhythm.tone === 'number' ? r.rhythm.tone : null,
    },
    liaison: { expected: liaisonWords.length, ok: liaisonWords.filter((w) => w.liaison.score === 1).length },
    words,
    // audioUrl 优先取响应字段；缺失时按官方 SDK 约定拼接
    // https://files.cloud.ssapi.cn/<applicationId>/<recordId>.mp3（SDK 文档 2873513）
    audioUrl:
      (raw && raw.audioUrl) ||
      (raw && raw.applicationId && raw.recordId
        ? `https://files.cloud.ssapi.cn/${raw.applicationId}/${raw.recordId}.mp3`
        : null),
    tipId: (r.info && r.info.tipId) || 0,
  }
}
