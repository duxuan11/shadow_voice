const path = require('path')

/**
 * 解析数据目录（视频/字幕/缩略图/JSON/DB 所在目录）。
 * 空值 → <root>/data；
 * 相对路径 → 相对 root 解析；
 * 绝对路径 → 原样返回。
 *
 * 供 vite.config.js（开发）、server/index.cjs（生产）与 scripts/copy-data.mjs（构建）
 * 共用，保证三处的 DATA_DIR 行为一致。
 *
 * @param {string} value DATA_DIR 环境变量值
 * @param {string} root 项目根目录
 * @returns {string} 规范化后的绝对路径
 */
function resolveDataDir(value, root) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return path.join(root, 'data')
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(root, v)
}

module.exports = { resolveDataDir }
