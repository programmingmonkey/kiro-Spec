#!/usr/bin/env node
// 生成 test/fixtures/difference-matrix.json —— 第 3 期差异表的机器部分。
//
// 输入：test/fixtures/difference-matrix.annotations.json（**人工**：merge / evidence / after）
// 输出：test/fixtures/difference-matrix.json（**机器**：dsh / kiro / kiroBin 三列）
//
// 分两个文件的理由：本期设计初稿的 D 行是读码写的，写成「dsh 静默丢弃」，实跑后发现 dsh 的
// 诊断层照常报 `tasks/invalid-task-line`——「静默」二字错，而该行的归并理由原本正押在它上面。
// 把现状列做成**生成物**（而不是人写的常量），这类错误就无法再进 fixture。
//
// ⚠️ dsh / kiro 两列是**抽取前的历史快照**。宿主接线（任务 5.2 / 5.3）之后重跑本脚本会得到
// 归并后的值——那是改写历史。故本脚本对「探针值与已有 fixture 不一致」fail loud：确认是有意
// 重捕时加 `--force`，否则不许覆盖。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRows, ROW_ORDER } from './difference-matrix.mjs'
import { loadKiroBranch } from './kiro-branch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'fixtures')
const ANNOTATIONS = join(FIXTURES, 'difference-matrix.annotations.json')
const OUTPUT = join(FIXTURES, 'difference-matrix.json')

const force = process.argv.includes('--force')

const probe = (rows) =>
  rows.map((row) => ({
    id: row.id,
    specimens: row.specimens.map((specimen) => ({
      key: specimen.text ?? specimen.name,
      dsh: specimen.dsh,
      kiro: specimen.kiro,
      kiroBin: specimen.kiroBin,
    })),
  }))

// 只比探针三列：merge / evidence / after / about 由人工维护，改了不该触发守卫。
function assertProbeUnchanged(previous, rows) {
  const before = JSON.stringify(probe(previous.rows))
  const now = JSON.stringify(probe(rows))
  if (before === now) return
  const drift = []
  const previousRows = new Map(previous.rows.map((row) => [row.id, row]))
  for (const row of probe(rows)) {
    const old = previousRows.get(row.id)
    row.specimens.forEach((specimen, index) => {
      const oldSpecimen = old?.specimens?.[index]
      if (JSON.stringify(oldSpecimen && { dsh: oldSpecimen.dsh, kiro: oldSpecimen.kiro, kiroBin: oldSpecimen.kiroBin }) !==
          JSON.stringify({ dsh: specimen.dsh, kiro: specimen.kiro, kiroBin: specimen.kiroBin })) {
        drift.push(`  ${row.id} · ${specimen.key}`)
      }
    })
  }
  throw new Error(
    [
      '探针三列与已入库的 fixture 不一致：',
      ...drift,
      '',
      '可能的原因，先判明再动手：',
      '  (a) 某个宿主已经被接线到共享包 —— 那么 dsh / kiro 两列已是归并后的值，',
      '      重生成等于改写「抽取前」这份历史证据。此时不该重跑本脚本。',
      '  (b) fixture 被人手改过 —— 从 git 取回它，改 annotations 而不是改产物。',
      '  (c) 确实要有意重捕（例如本机换了 Kiro 版本）—— 复核差异表后加 --force。',
    ].join('\n'),
  )
}

const branch = loadKiroBranch()
const annotations = JSON.parse(readFileSync(ANNOTATIONS, 'utf8'))
const rows = buildRows(annotations, branch)

if (existsSync(OUTPUT) && !force) {
  assertProbeUnchanged(JSON.parse(readFileSync(OUTPUT, 'utf8')), rows)
}

const matrix = {
  schemaVersion: 1,
  generatedBy: 'packages/spec-parser/test/tools/gen-difference-matrix.mjs',
  about: [
    '本文件是生成物，不要手改。重跑生成器（不带 --force）必须得到逐字节相同的结果。',
    '人工输入在 difference-matrix.annotations.json（merge / evidence / after 三列）。',
    'dsh / kiro 两列是抽取前两个宿主解析器的实测输出；kiroBin 列由真机 bundle 的判定分支复算。',
    'after 是与 specimens 等长的数组，每项 null 或 { dsh?, kiro? }（部分覆盖）；null 表示「归并后与现状相同」或「尚未归并」。',
    '读取期望值时：prior = specimen 的现状列；after[i] 里给了哪一侧就用哪一侧覆盖它（用 in 判断，null 是有效覆盖）。',
  ],
  kiroBundle: branch.bundle,
  rows,
}

writeFileSync(OUTPUT, `${JSON.stringify(matrix, null, 2)}\n`)
process.stdout.write(`wrote ${OUTPUT}\n`)
for (const row of rows) {
  process.stdout.write(`  ${row.id.padEnd(3)} ${row.kind.padEnd(9)} specimens=${row.specimens.length}\n`)
}
for (const id of ROW_ORDER) {
  if (!rows.some((row) => row.id === id)) throw new Error(`行 ${id} 丢失`)
}
