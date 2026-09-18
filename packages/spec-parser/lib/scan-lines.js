// 共享扫描层：围栏判定 + 各宿主的历史视图。零 I/O、不抛。
//
// 围栏取 **kiro 的缩进式语义**（差异表 E / F 的方向在 2026-09-12 执行期订正过）：
//
//   1. 一个 ``` / ~~~ 只在外层无围栏、且（缩进 <= 3 或它能被"认闭合"）时才算围栏开启；
//   2. 闭合要求**同字符且 run 长度 >= 开 run**；
//   3. "认闭合"要求闭合之前不出现缩进更小的任务行（避免把文档里的示例块当成围栏）。
//
// 为什么不取 dsh 的无条件语义：`plugins/codex-spec/lib/core/revision.mjs` 用同一套
// `nextFenceMarker` / `hasFenceClose` 跑 `semanticTokens`，而它产出的是 approval
// fingerprint —— 改这套语义会让已记录的审批失效。故本层是那套语义的唯一实现，
// 两个宿主与（第 4 期抽出的）revision 层都应收敛到这里。
//
// 唯一判定是内部的 `scanFence`；`computeFenceState` 是它的行级投影，其余都是它的视图。

import { parseTaskLine } from './task-format.js'

const FENCE_RE = /^( *)(`{3,}|~{3,})/

const DEFAULT_OPTIONS = { strictTaskState: false }
// `nextFenceMarker` / `hasFenceClose` 是 kiro 侧的历史原语（revision.mjs 直接调它们算
// approval fingerprint），故它们的默认策略是 **strict** —— 也就是它们在本仓原有的语义。
// 只有 `scanFence` 会显式把自己的 options 传进来。改这个默认值等于改哈希，是事故。
const STRICT_OPTIONS = { strictTaskState: true }

export function taskIndentStack(taskIndents, task) {
  if (task?.kind !== 'task') return taskIndents
  const depth = task.id.split('.').length
  const next = taskIndents.slice(0, depth - 1)
  next[depth - 1] = task.indent.length
  return next
}

export function nextFenceMarker(line, fenceMarker, taskIndents = []) {
  const fence = FENCE_RE.exec(line)
  if (!fence) return fenceMarker
  if (fenceMarker) {
    return fence[2][0] === fenceMarker[0] && fence[2].length >= fenceMarker.length ? undefined : fenceMarker
  }
  const indent = fence[1].length
  return indent <= 3 || taskIndents.some((taskIndent) => indent >= taskIndent) ? fence[2] : undefined
}

export function hasFenceClose(lines, startIndex, fenceMarker, options = STRICT_OPTIONS) {
  const openingIndent = FENCE_RE.exec(lines[startIndex])?.[1].length ?? 0
  for (const line of lines.slice(startIndex + 1)) {
    const task = parseTaskLine(line, options)
    if (task?.kind === 'task' && task.indent.length < openingIndent) return false
    const fence = FENCE_RE.exec(line)
    if (fence?.[2][0] === fenceMarker[0] && fence[2].length >= fenceMarker.length) return true
  }
  return false
}

/**
 * 唯一围栏判定。返回每行是否落在围栏内、每行的语法判定、以及全文围栏是否未闭合。
 *
 * 注：`taskIndents` 由任务行累积，而「哪些行是任务」依策略而不同（例如 `[~]` 在 dsh 模式下
 * 是任务）。故围栏判定在极少数含 `[~]` 且伴随缩进围栏的文档上会随策略不同——这是既有语义的
 * 真实耦合，不额外造一个开关去掩盖它。
 */
function scanFence(lines, options = DEFAULT_OPTIONS) {
  const inFence = []
  const syntaxes = []
  let fenceMarker
  let taskIndents = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    if (fenceMarker) {
      inFence[index] = true
      fenceMarker = nextFenceMarker(line, fenceMarker, taskIndents)
      continue
    }

    const nextMarker = nextFenceMarker(line, undefined, taskIndents)
    if (nextMarker && (line.length - line.trimStart().length <= 3 || hasFenceClose(lines, index, nextMarker, options))) {
      inFence[index] = true
      fenceMarker = nextMarker
      continue
    }

    inFence[index] = false
    const syntax = parseTaskLine(line, options)
    syntaxes[index] = syntax
    taskIndents = taskIndentStack(taskIndents, syntax)
  }

  return { inFence, syntaxes, open: fenceMarker !== undefined }
}

/** `scanFence` 的行级投影：每行是否在围栏内。 */
export function computeFenceState(lines, options = DEFAULT_OPTIONS) {
  return scanFence(lines, options).inFence
}

/** dsh-spec 的历史形状（它有 11 个调用点：parseTaskList、诊断、setTaskState）。 */
export function scanLines(markdown) {
  const raw = String(markdown ?? '').split('\n')
  const { inFence } = scanFence(raw, DEFAULT_OPTIONS)
  return raw.map((line, index) => ({ raw: line, inFence: inFence[index] === true }))
}

/** codex-spec 的历史形状。 */
export function scanTaskLines(markdown, options = DEFAULT_OPTIONS) {
  const lines = String(markdown ?? '').split('\n')
  const { syntaxes } = scanFence(lines, options)
  return { lines, syntaxes }
}

/** 全文围栏是否未闭合。少算只能靠它可见（真机没有围栏概念，这是本仓约定）。 */
export function hasUnterminatedFence(markdown, options = DEFAULT_OPTIONS) {
  return scanFence(String(markdown ?? '').split('\n'), options).open
}

/** 按 id 重写某个任务的复选框状态，只动那一个字符。 */
export function replaceTaskState(markdown, taskId, from, to) {
  const options = { strictTaskState: true }
  const parts = String(markdown ?? '').split(/(\r?\n)/)
  const lines = parts.filter((_, index) => index % 2 === 0)
  const { inFence } = scanFence(lines, options)

  let found = false
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (inFence[lineIndex]) continue
    const task = parseTaskLine(lines[lineIndex], options)
    if (!task || task.kind !== 'task' || task.id !== taskId) continue
    if (found) throw Object.assign(new Error('DUPLICATE_TASK_ID'), { code: 'DUPLICATE_TASK_ID' })
    found = true
    if (task.state !== from) {
      throw Object.assign(new Error(`TASK_STATE_CONFLICT: expected ${from}, found ${task.state}`), {
        code: 'TASK_STATE_CONFLICT',
      })
    }
    const line = lines[lineIndex]
    parts[lineIndex * 2] = `${line.slice(0, task.stateOffset)}${to}${line.slice(task.stateOffset + 1)}`
  }

  if (!found) throw Object.assign(new Error(`TASK_NOT_FOUND: ${taskId}`), { code: 'TASK_NOT_FOUND' })
  return parts.join('')
}
