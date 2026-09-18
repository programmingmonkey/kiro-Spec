// 只针对**共享包**两个策略的探针：用来做判别力矩阵（4.1）与白名单封闭（4.3）。
//
// 与 test/tools/difference-matrix.mjs 的区别：那个模块探的是两个宿主**抽取前**的原实现
// （历史快照，接完线就再也取不回来了）；本模块探的是共享包在 `strictTaskState` 两种取值下
// 的行为。两者服务不同问题，不要混。

import { computeFenceState, scanTaskLines } from '../../lib/scan-lines.js'
import { parseTaskLine } from '../../lib/task-format.js'

/** dsh-spec 走 false，codex-spec 走 true —— 这两项绑定就是差异表 A1 / A2 的全部内容。 */
export const POLICY = { 'dsh-spec': false, 'codex-spec': true }

const normalizeLine = (parsed) => {
  if (parsed === undefined) return null
  if (parsed.kind !== 'task') return { kind: parsed.kind }
  return { kind: 'task', id: parsed.id, state: parsed.state, title: parsed.title, optional: parsed.optional }
}

export const policyLine = (text, host) => normalizeLine(parseTaskLine(text, { strictTaskState: POLICY[host] }))

export const policyDocument = (text, host) => {
  const { syntaxes } = scanTaskLines(text, { strictTaskState: POLICY[host] })
  return { taskLines: syntaxes.flatMap((syntax, index) => (syntax?.kind === 'task' ? [index + 1] : [])) }
}

export const policyFor = (kind, specimen, host) =>
  kind === 'line' ? policyLine(specimen.text, host) : policyDocument(specimen.text, host)

// ── 属性化语料（Task 0.1）用的两个附加投影 ────────────────────────────────────
// 「差异」在 3.5 期是**完整 findings** 的差异,而围栏判定本身随策略而变(scan-lines.js 自陈的
// 已知耦合)。故分类不能只看 taskLines —— 还要看 inFence。

/** 该策略下被算作任务的 id 列表（按出现顺序）。 */
export const policyTaskIds = (text, host) => {
  const { syntaxes } = scanTaskLines(text, { strictTaskState: POLICY[host] })
  return syntaxes.flatMap((syntax) => (syntax?.kind === 'task' ? [syntax.id] : []))
}

/** 该策略下逐行的围栏判定（`1`/`0` 串，便于直接比对）。 */
export const policyFenceState = (text, host) =>
  computeFenceState(String(text).split('\n'), { strictTaskState: POLICY[host] })
    .map((inside) => (inside ? 1 : 0))
    .join('')

/**
 * 把一份属性化语料的**策略差异形态**分类。判据先于取数写死在 spec 的 Task 0.1 Step 3 表里：
 *   · `none`           两策略的任务集合与围栏判定都相同
 *   · `A1` / `A2`      taskLines 的差异**只有**主语任务行自身（`~` → A1、`/` → A2）
 *   · `G`              在 A1/A2 之外还有残留差异，且两策略的围栏判定不同 → 策略耦合
 *   · `UNCLASSIFIED`   有残留差异但围栏判定相同 → **跨机制，STOP**
 * 注意 A1/A2 与 G 可以同时成立（A1 复现件正是如此），此时归 `G`——因为「多出的形态」才是判据要问的。
 */
export function classifySpecimen(text) {
  const dshIds = policyTaskIds(text, 'dsh-spec')
  const kiroIds = policyTaskIds(text, 'codex-spec')
  const dshTasks = policyDocument(text, 'dsh-spec').taskLines
  const kiroTasks = policyDocument(text, 'codex-spec').taskLines
  const dshFence = policyFenceState(text, 'dsh-spec')
  const kiroFence = policyFenceState(text, 'codex-spec')
  const fenceDiffers = dshFence !== kiroFence

  const subjectId = /- \[([^\]])\]\s*(\d+(?:\.\d+)*)/.exec(text.split('\n')[0] ?? '')
  const subjectState = subjectId?.[1]
  const declaredState = subjectState === '~' ? 'A1' : subjectState === '/' ? 'A2' : null

  const symmetric = [...new Set([...dshIds, ...kiroIds])].filter((id) => dshIds.includes(id) !== kiroIds.includes(id))
  const residual = declaredState ? symmetric.filter((id) => id !== subjectId[2]) : symmetric

  const taskDiffers = JSON.stringify(dshTasks) !== JSON.stringify(kiroTasks)
  let label
  if (!taskDiffers && !fenceDiffers) label = 'none'
  else if (residual.length === 0 && declaredState && !fenceDiffers) label = declaredState
  else if (fenceDiffers) label = 'G'
  else label = 'UNCLASSIFIED'

  return { label, declaredState, residual, symmetric, dshTasks, kiroTasks, dshFence, kiroFence, fenceDiffers }
}
