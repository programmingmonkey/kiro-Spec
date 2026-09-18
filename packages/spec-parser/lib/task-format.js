// 共享识别层：单行 → 统一结果对象。零 I/O、恒不抛、零依赖。
//
// 差异表的七行差异里，本文件承担 `A1` / `A2` 两行（状态字符集，由 strictTaskState 承载），
// 并把 `B` / `C` 归并到「状态合法即成任务」——即归并后**不再有格式判定**，故 codex-spec
// 原有的 `invalid-format` 枚举成员被删除（它只剩两个生产者，正是 B / C 两行）。
//
// 判定顺序：① 复选框形状 ② 状态合法性（按模式）。第 ② 步之后没有第 ③ 步。
//
// `valid` 与 `kind` 并存是必要的：`valid` 是 dsh-spec 诊断的既有语义（state 是否落在真机
// 四字符类 `[ x~-]` 内），与模式无关；`kind` 是「这条行算不算任务」的三态中的两态。

const KIRO_CHECKBOX_CHARS = [' ', 'x', '~', '-']
// codex-spec 的收紧：四字符类里去掉 `~`。原始实现对**未小写**的字符判定，故大小写 `X` 都算合法。
const KIRO_STRICT_STATES = [' ', 'x', '-']

const TASK_LINE_RE = /^(\s*)-\s+\[([^\]])\](\\?\*?)\s+(\d+(?:\.\d+)*)(.*)$/

function taskRemainder(rest) {
  const after = String(rest ?? '')
  if (after === '') return ''
  if (after[0] === '.') return after.slice(1).trim()
  if (/^\s/.test(after)) return after.trim()
  // id 与正文粘连（`- [ ] 1.1foo`）：不是任务。两个宿主的现行实现都如此。
  return undefined
}

/**
 * @param {string} line
 * @param {{ strictTaskState?: boolean }} [options]
 */
export function parseTaskLine(line, options = {}) {
  const strict = options?.strictTaskState === true
  const text = String(line ?? '')
  const match = TASK_LINE_RE.exec(text)
  if (!match) return undefined

  const [, indent, rawState, marker, id, rest] = match
  const remainder = taskRemainder(rest)
  if (remainder === undefined) return undefined

  const state = rawState.toLowerCase()
  const kind = strict && !KIRO_STRICT_STATES.includes(state) ? 'invalid-state' : 'task'

  return {
    kind,
    id,
    state,
    indent,
    optional: marker.length > 0,
    title: remainder,
    stateOffset: text.indexOf('[', indent.length) + 1,
    valid: KIRO_CHECKBOX_CHARS.includes(state),
  }
}

function metadataPatterns(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    new RegExp(`^\\s*(?:[-*+]\\s+)?_${escaped}:\\s*(.+?)_\\s*$`, 'm'),
    new RegExp(`^\\s*_${escaped}:_\\s*(.+?)\\s*$`, 'm'),
  ]
}

/** 从任务体里抽 `_Requirements:_` / `_Dependencies:_` 这类标注。纯函数，随本层移入。 */
export function metadataValue(body, label) {
  for (const pattern of metadataPatterns(label)) {
    const match = pattern.exec(body)
    if (match) return match[1].trim()
  }
  return undefined
}
