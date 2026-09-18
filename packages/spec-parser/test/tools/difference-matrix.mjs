// 差异矩阵的共享装配逻辑：生成器与测试都从这里取,避免「生成时的形状」与「测试重算时的形状」
// 各写一遍而漂移。
//
// 三列的含义与来源：
//   dsh / kiro —— 两个宿主**抽取前**的原实现实测输出（1.3 每次跑测试都会重算一遍做回归）
//   kiroBin    —— 真机 bundle 的判定分支复算（独立复核在 1.2）
//
// 注意：dsh / kiro 两列是**历史快照**。宿主接线（任务 5.2 / 5.3）之后重跑生成器会得到
// 归并后的值——那是改写历史，不是更新证据。生成器对此有 fail-loud 守卫。

import { __test as dsh } from '../../../../plugins/dsh-spec/lib/index.js'
import { parseTaskLine, scanTaskLines } from '../../../../plugins/codex-spec/lib/core/task-format.mjs'
import { judgeDocument } from './kiro-branch.mjs'

export const ROW_ORDER = ['A1', 'A2', 'B', 'C', 'D', 'E', 'F']

// ---------------------------------------------------------------- 两个宿主的探针

export const dshLine = (text) => {
  const parsed = dsh.parseTask(text)
  if (parsed === undefined) return null
  // 记录 dsh 的历史字段名。投影（任务 5.3）保证它们在抽取后仍原样可取。
  return { index: parsed.index, state: parsed.state, text: parsed.text, valid: parsed.valid }
}

export const kiroLine = (text) => {
  const parsed = parseTaskLine(text)
  if (parsed === undefined) return null
  if (parsed.kind !== 'task') return { kind: parsed.kind }
  return { kind: 'task', id: parsed.id, state: parsed.state, title: parsed.title, optional: parsed.optional }
}

export const dshTaskLines = (markdown) =>
  dsh
    .scanLines(markdown)
    .flatMap((line, index) => (!line.inFence && dsh.parseTask(line.raw) ? [index + 1] : []))

export const kiroTaskLines = (markdown) => {
  const { syntaxes } = scanTaskLines(markdown)
  return syntaxes.flatMap((syntax, index) => (syntax?.kind === 'task' ? [index + 1] : []))
}

// ---------------------------------------------------------------- 真机列

export const kiroBinLine = (text, branch) => {
  const verdicts = judgeDocument(`## Tasks\n${text}\n`, branch)
  const own = verdicts.find((entry) => entry.line === 2)
  return { verdict: own ? own.verdict : 'ignored' }
}

export const kiroBinDocument = (text, branch) => {
  const verdicts = judgeDocument(text, branch)
  return {
    taskLines: verdicts.filter((entry) => entry.verdict === 'ok').map((entry) => entry.line),
    errors: verdicts.filter((entry) => entry.verdict !== 'ok'),
  }
}

export const kiroBinFor = (kind, specimen, branch) =>
  kind === 'line' ? kiroBinLine(specimen.text, branch) : kiroBinDocument(specimen.text, branch)

// ---------------------------------------------------------------- 装配

const probeSpecimen = (kind, specimen, branch) =>
  kind === 'line'
    ? {
        text: specimen,
        dsh: dshLine(specimen),
        kiro: kiroLine(specimen),
        kiroBin: kiroBinLine(specimen, branch),
      }
    : {
        name: specimen.name,
        text: specimen.text,
        dsh: { taskLines: dshTaskLines(specimen.text) },
        kiro: { taskLines: kiroTaskLines(specimen.text) },
        kiroBin: kiroBinDocument(specimen.text, branch),
      }

export function buildRows(annotations, branch) {
  const byId = new Map(annotations.rows.map((row) => [row.id, row]))
  const missing = ROW_ORDER.filter((id) => !byId.has(id))
  const extra = [...byId.keys()].filter((id) => !ROW_ORDER.includes(id))
  if (missing.length || extra.length) {
    throw new Error(`差异表的行不齐：缺 ${JSON.stringify(missing)}，多 ${JSON.stringify(extra)}`)
  }

  return ROW_ORDER.map((id) => {
    const row = byId.get(id)
    const specimens = row.specimens.map((specimen) => probeSpecimen(row.kind, specimen, branch))
    return {
      id: row.id,
      kind: row.kind,
      what: row.what,
      specimens,
      merge: row.merge,
      evidence: row.evidence,
      // 与 specimens 等长的数组；null 表示「归并后与现状相同」或「尚未归并」。
      after: row.after ?? null,
    }
  })
}
