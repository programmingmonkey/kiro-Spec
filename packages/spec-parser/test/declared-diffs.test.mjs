// 4.3 —— 白名单封闭。
//
// 判据是「实测差异集合 ⊆ declared-diffs 的声明集合」。这里测的差异是**共享包两个策略**的
// 差异（也就是接线后两个宿主的差异），而不是抽取前快照的差异——因为第 3.5 期要消费的正是
// 「同一份 spec 经两个宿主得到除声明外逐字段相同的 findings」。
//
// 这一条是把「这是有意的」从万能借口变成可证伪断言的地方：多出一条差异就红。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { policyFor, classifySpecimen } from './tools/policies.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'difference-matrix.json'), 'utf8'))
const COUPLING = JSON.parse(readFileSync(join(HERE, 'fixtures', 'policy-coupling.json'), 'utf8'))
const DECLARED = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'declared-diffs.json'), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

const declaredRows = new Set(DECLARED.differences.filter((e) => e.row).map((entry) => entry.row))
const declaredMechanisms = new Set(DECLARED.differences.filter((e) => e.mechanism).map((entry) => entry.mechanism))

describe('declared-diffs.json 的形状', () => {
  it('恰好三条，id 与顺序符合设计', () => {
    assert.deepEqual(
      DECLARED.differences.map((entry) => entry.id),
      ['task-state-tilde', 'task-state-illegal', 'fence-policy-coupling'],
    )
  })

  it('每条都有 hosts / justification / evidence，且都能被定位（row 或 mechanism）', () => {
    for (const entry of DECLARED.differences) {
      for (const field of ['hosts', 'justification', 'evidence']) {
        assert.ok(entry[field] !== undefined && entry[field] !== '', `${entry.id} 缺 ${field}`)
      }
      assert.ok(
        entry.row || entry.mechanism,
        `${entry.id} 既没有 row 也没有 mechanism —— 无法被任何判据定位`,
      )
      assert.ok(entry.hosts['dsh-spec'] && entry.hosts['codex-spec'], `${entry.id} 的 hosts 两侧都要有`)
    }
  })

  it('hosts 记的是可观察行为（kiro 侧写抛错，而不是内部返回值）', () => {
    for (const entry of DECLARED.differences) {
      assert.match(entry.hosts['codex-spec'], /抛/, `${entry.id} 的 kiro 侧应记可观察行为`)
    }
  })

  it('经包的 exports 暴露，消费者不必硬编码路径', () => {
    assert.equal(MANIFEST.exports['./declared-diffs.json'], './declared-diffs.json')
  })
})

describe('实测差异 ⊆ 声明差异', () => {
  it('两个策略的差异行恰好是被声明的那几行', () => {
    const measured = new Set()
    for (const row of FIXTURE.rows) {
      for (const specimen of row.specimens) {
        const dsh = policyFor(row.kind, specimen, 'dsh-spec')
        const kiro = policyFor(row.kind, specimen, 'codex-spec')
        if (JSON.stringify(dsh) !== JSON.stringify(kiro)) {
          measured.add(row.id)
          if (!declaredRows.has(row.id)) {
            assert.fail(
              `${row.id} 实测存在宿主差异，但它不在 declared-diffs.json 里 —— ` +
                '要么登记声明，要么把这条差异归并掉。实测差异超出声明的必须失败。',
            )
          }
        }
      }
    }
    // 反向也要成立：声明了却实测没有差异，说明声明在描述一个不存在的东西。
    for (const declared of declaredRows) {
      assert.ok(measured.has(declared), `${declared} 被声明为差异，但实测两个策略输出相同`)
    }
  })

  it('声明集合恰好等于实测集合（当前为 A1 / A2 两行）', () => {
    assert.deepEqual([...declaredRows].sort(), ['A1', 'A2'])
  })
})

// ── Task 0.1：把封闭性的语料从 7 行定值换成属性化笛卡尔积 ─────────────────────
//
// 第 3 期那条判据只遍历 difference-matrix 的 7 行定值样本，而 scan-lines.js 自己承认的
// 「taskIndents 随策略而变 → 围栏判定随策略而变」按构造不在那 7 行里。这里用
// `policy-coupling.json`（288 份笛卡尔积）把那一类穷举出来。
//
// 判据（先于取数写死在 spec 的 Task 0.1 Step 3 表里）：
//   · 没有 UNCLASSIFIED —— 出现即「多出的形态跨多个不相关机制」，STOP，回第 3 期补轴；
//   · `fence-policy-coupling` 这一类必须**非空**，否则第三条声明是在描述一个不存在的东西。
describe('Task 0.1 — 属性化语料下的策略耦合', () => {
  const classified = COUPLING.specimens.map((specimen) => ({
    id: specimen.id,
    axes: specimen.axes,
    ...classifySpecimen(specimen.text),
  }))

  it('语料是 288 份的笛卡尔积，且与生成器逐字节相同', () => {
    assert.equal(COUPLING.count, 288)
    assert.equal(COUPLING.specimens.length, 288)
    const shape = new Set(COUPLING.specimens.map((s) => Object.keys(s.axes).join(',')))
    assert.deepEqual([...shape], ['state,subjectIndent,fenceIndent,openRun,closeRun,guard'])
    // 生成器在 `gen-policy-coupling.mjs` 的 `--check` 下自比；这里只钉住计数与口径。
    assert.deepEqual(
      Object.fromEntries(COUPLING.axes.map((axis) => [axis.name, axis.values.length])),
      { state: 6, subjectIndent: 3, fenceIndent: 2, openRun: 2, closeRun: 2, guard: 2 },
    )
  })

  it('没有无法归类的差异形态（跨机制即 STOP）', () => {
    const unclassified = classified.filter((entry) => entry.label === 'UNCLASSIFIED')
    assert.deepEqual(
      unclassified.map((entry) => ({ id: entry.id, axes: entry.axes, residual: entry.residual })),
      [],
      '出现了 A1/A2 与「围栏判定差异」都解释不了的残留差异 —— 说明共享层的策略参数化漏了轴，应回第 3 期补，不在 3.5 打补丁',
    )
  })

  it('第三类（策略耦合导致的围栏判定差异）非空，且被 mechanism 声明覆盖', () => {
    const coupling = classified.filter((entry) => entry.label === 'G')
    assert.ok(coupling.length > 0, 'fence-policy-coupling 被声明了，但属性化语料里一份都测不到')
    assert.ok(
      declaredMechanisms.has('fence-judgment-coupling'),
      'declared-diffs.json 缺少 fence-judgment-coupling 这条 mechanism 声明',
    )
    for (const entry of coupling) {
      assert.ok(entry.fenceDiffers, `${entry.id} 归入策略耦合，但两策略的围栏判定相同`)
      assert.ok(entry.residual.length > 0, `${entry.id} 归入策略耦合，但没有 A1/A2 之外的残留差异`)
    }
  })

  it('被计为差异的每一份语料都能落到某条声明上（A1 / A2 / G）', () => {
    for (const entry of classified) {
      if (entry.label === 'none') continue
      const covered =
        entry.label === 'G' || entry.declaredState === 'A1' || entry.declaredState === 'A2'
      assert.ok(covered, `${entry.id}（${JSON.stringify(entry.axes)}）有差异却落不到任何声明上`)
    }
  })

  it('第一类只由 `~` / `/` 触发，其余状态在两策略下完全一致', () => {
    const byState = new Map()
    for (const entry of classified) {
      const state = entry.axes.state
      if (!byState.has(state)) byState.set(state, new Set())
      byState.get(state).add(entry.label)
    }
    assert.deepEqual([...byState.get(' ') ], ['none'])
    assert.deepEqual([...byState.get('x') ], ['none'])
    assert.deepEqual([...byState.get('X') ], ['none'])
    assert.deepEqual([...byState.get('-') ], ['none'])
    assert.ok(byState.get('~').has('A1') || byState.get('~').has('G'))
    assert.ok(byState.get('/').has('A2') || byState.get('/').has('G'))
  })

  it('声明的复现件确实在语料里（不是纸面例子）', () => {
    const repro = classified.find(
      (entry) =>
        entry.axes.state === '~' &&
        entry.axes.subjectIndent === 2 &&
        entry.axes.fenceIndent === 4 &&
        entry.axes.openRun === 3 &&
        entry.axes.closeRun === 3 &&
        entry.axes.guard === false,
    )
    assert.ok(repro, '声明里引用的复现件在属性化语料里找不到')
    assert.equal(repro.label, 'G')
    assert.deepEqual(repro.dshTasks, [1, 5])
    assert.deepEqual(repro.kiroTasks, [3, 5])
  })
})
