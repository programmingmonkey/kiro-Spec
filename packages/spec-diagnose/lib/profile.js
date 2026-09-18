// Profile（第 3.5 期 Task 2）。
//
// profile 是「项目自己的约定」那一层：母计划 0.7 的字段表里，新项目只需提供自己的 profile，
// L0/L1 一行不改。本文件只做**归一化**：缺字段给安全默认，绝不抛。
//
// 零 I/O、恒不抛。

const EMPTY = Object.freeze({ name: 'default', conventions: Object.freeze([]), overrides: Object.freeze({}), optOuts: Object.freeze([]) })

/** 归一化一个 profile。任何非对象输入都退化成空 profile，而不是抛。 */
export function normalizeProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return EMPTY
  return Object.freeze({
    name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : EMPTY.name,
    conventions: Object.freeze(
      Array.isArray(profile.conventions)
        ? profile.conventions.filter((code) => typeof code === 'string' && code.length > 0)
        : [],
    ),
    overrides: Object.freeze(
      profile.overrides && typeof profile.overrides === 'object' && !Array.isArray(profile.overrides)
        ? { ...profile.overrides }
        : {},
    ),
    optOuts: Object.freeze(
      Array.isArray(profile.optOuts) ? profile.optOuts.filter((code) => typeof code === 'string') : [],
    ),
  })
}

/** 应用 profile 的 overrides / optOuts。`overrides` 只改 severity，不改 code 与 source。 */
export function applyProfile(findings, profile) {
  const { overrides, optOuts } = normalizeProfile(profile)
  const optedOut = new Set(optOuts)
  const out = []
  for (const finding of findings) {
    if (optedOut.has(finding.code)) continue
    const override = overrides[finding.code]
    if (override === 'error' || override === 'warning') out.push({ ...finding, severity: override })
    else out.push(finding)
  }
  return out
}
