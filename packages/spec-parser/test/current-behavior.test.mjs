// 1.3 —— 现状锁定 + 归并任务的期望列机制。
//
// 这个文件与生成器**共用同一套探针**（test/tools/difference-matrix.mjs）。因此要说清它的作用：
// 它**不是**对生成值的独立复核（独立于生成器的那条路径才是 test/kiro-ground-truth.test.mjs）；
// 它的作用是两件：
//   ① 把「抽取前两个宿主怎么解析」锁进**每次测试运行**——任何宿主的解析行为变化都会在这里暴露，
//      而不是等到生成器被谁重跑时才发现；
//   ② 给出归并任务（3.x）翻期望列的机制：改 annotations 里的 `after`，本文件随即断言新行为。
//
// 期望值取 `row.after?.[i] ?? { dsh: specimen.dsh, kiro: specimen.kiro }`：
// `after` 为 null 表示「归并后与现状相同」或「尚未归并」。
//
// 宿主接线（任务 5.2 / 5.3）之后，两个探针会跟着变成共享包的策略输出——那时 `after` 必须已经
// 被 3.x 填好，本文件才能继续绿。这是设计与执行上的一处刻意耦合：先把期望写死，再改行为。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { dshLine, dshTaskLines, kiroLine, kiroTaskLines } from './tools/difference-matrix.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'difference-matrix.json'), 'utf8'))

const probe = (row, specimen) =>
  row.kind === 'line'
    ? { dsh: dshLine(specimen.text), kiro: kiroLine(specimen.text) }
    : { dsh: { taskLines: dshTaskLines(specimen.text) }, kiro: { taskLines: kiroTaskLines(specimen.text) } }

// 期望值：`after` 是「部分覆盖」——每项 null 或 { dsh?, kiro? }，缺哪一侧就沿用现状列。
// 用 `'kiro' in override` 而不是 `??`：D 行的 kiro 侧期望就是显式 null（不再是任务），
// 而 `??` 会把 null 当成「没给」。
//
// 接线状态是**显式判定**的，不靠「测试刚好都过」蒙过去：宿主源码里出现共享包说明符之前，
// 它们的解析结果应当等于**现状列**；那一天之后必须等于 `after` 列。于是 3.x 可以把期望先写死
// （test-first），而每波都收在绿上；接线若接错，本文件立刻红。
const ROOT = join(HERE, '..', '..', '..')
// 接线判定是**链式**的：第 7 期把宿主 `lib/core/task-format.mjs` 变成 `@my-harness/spec-state`
// 的 shim，再由那一层转发到 `@my-harness/spec-parser`。只认 `@my-harness/spec-parser` 会让
// kiro 侧被判成「未接线」，于是本文件回头去断言合并**之前**的旧列 —— 而探针读的是合并之后的
// 实现（实测：改这一处之前 B / C / D 三行红）。
const WIRING_MARKERS = ['@my-harness/spec-parser', '@my-harness/spec-state/core/task-format']
const wired = (relativePath) => {
  const source = readFileSync(join(ROOT, relativePath), 'utf8')
  return WIRING_MARKERS.some((marker) => source.includes(marker))
}
const REGIME = {
  dsh: wired('plugins/dsh-spec/lib/index.js'),
  kiro: wired('plugins/codex-spec/lib/core/task-format.mjs'),
}

const expectedFor = (row, specimen, index) => {
  const override = row.after?.[index]
  const pick = (host) => {
    if (!REGIME[host]) return specimen[host]
    return override && host in override ? override[host] : specimen[host]
  }
  return { dsh: pick('dsh'), kiro: pick('kiro') }
}

describe('两个宿主的解析器与差异矩阵的期望列一致', () => {
  for (const row of FIXTURE.rows) {
    it(`${row.id} · ${row.what}`, () => {
      row.specimens.forEach((specimen, index) => {
        const tag = row.kind === 'line' ? specimen.text : specimen.name
        const expected = expectedFor(row, specimen, index)
        const actual = probe(row, specimen)
        assert.deepEqual(actual.dsh, expected.dsh, `${row.id} · ${tag} 的 dsh 侧`)
        assert.deepEqual(actual.kiro, expected.kiro, `${row.id} · ${tag} 的 kiro 侧`)
      })
    })
  }
})

describe('差异矩阵自身的一致性', () => {
  it('七行齐全且 id 有序', () => {
    assert.deepEqual(
      FIXTURE.rows.map((row) => row.id),
      ['A1', 'A2', 'B', 'C', 'D', 'E', 'F'],
    )
  })

  it('每行都有归并方向与依据，且 after 长度与 specimens 对齐', () => {
    for (const row of FIXTURE.rows) {
      assert.equal(typeof row.merge, 'string', `${row.id} 缺 merge`)
      assert.ok(row.merge.length > 0, `${row.id} 的 merge 为空`)
      assert.equal(typeof row.evidence, 'string', `${row.id} 缺 evidence`)
      assert.ok(row.evidence.length > 0, `${row.id} 的 evidence 为空`)
      if (row.after !== null) {
        assert.equal(row.after.length, row.specimens.length, `${row.id} 的 after 与 specimens 不等长`)
      }
    }
  })

  it('A1 / A2 是本期唯一保留分歧的两行（declared-diffs 的两条）', () => {
    const retained = FIXTURE.rows.filter((row) => row.merge.includes('保留分歧')).map((row) => row.id)
    assert.deepEqual(retained, ['A1', 'A2'])
  })

  it('E / F 的依据标为 repo-convention，其余五行的依据必须来自真机（需求 3.7）', () => {
    // 真机对 E / F 根本没有行为（它的 tasks 校验循环没有围栏状态），所以这两行的依据只能是
    // 本仓约定；反过来，A1/A2/B/C/D 的依据必须是真机的判定 —— 标错方向会让第 3.5 期
    // 「source: 'kiro-binary' 的 findings 必须是 41 条子集」这条门槛失真。
    for (const row of FIXTURE.rows) {
      const isRepoConvention = /^repo-convention/.test(row.evidence)
      assert.equal(
        isRepoConvention,
        ['E', 'F'].includes(row.id),
        `${row.id} 的 evidence 开头是 ${JSON.stringify(row.evidence.slice(0, 24))}`,
      )
    }
  })
})
