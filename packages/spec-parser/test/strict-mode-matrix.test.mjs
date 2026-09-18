// 4.1 —— 判别力矩阵。
//
// 这是本期**判别力的唯一落点**：5 份真实 spec 的语料 golden 实测在两模式下取值全同
// （见 test/corpus-golden.test.mjs），一个把 strictTaskState 单边写死的实现能通过那套 golden。
// 所以「两个模式各自正确」必须由本文件守着，而且本文件的把关方式是**断言两者不同**：
//
//   · 差异表 A1 / A2 两行：两个策略的输出**必须不同**（开关没被用上就会红）
//   · 已实测一致的形态：两个策略的输出**必须相同**（否则说明实现按无关的理由在分叉）
//
// 另有一次性的人工实测（写在 commit message 里）：把包复制到临时目录、在副本里把开关单边
// 写死、对副本跑本文件并断言它失败。那一步不放进测试，因为测试不该改源码。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { policyFor } from './tools/policies.mjs'
import { hasUnterminatedFence } from '../lib/scan-lines.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'difference-matrix.json'), 'utf8'))
const DECLARED = JSON.parse(readFileSync(join(HERE, '..', 'declared-diffs.json'), 'utf8'))
const DECLARED_ROWS = new Set(DECLARED.differences.map((entry) => entry.row))
const row = (id) => FIXTURE.rows.find((entry) => entry.id === id)

const HOSTS = ['dsh-spec', 'codex-spec']
const DIFFERING_ROWS = ['A1', 'A2']
const AGREEING_ROWS = ['B', 'C', 'D', 'E', 'F']

// 差异表「已实测为一致」清单里的形态：两模式必须给出相同结果。
const SAME_IN_BOTH_MODES = [
  '- [ ] 1. task',
  '- [x] 1. task',
  '- [X] 1. task',
  '- [-] 1. task',
  '- [ ] 1.1 sub',
  '- [ ] 1.2.3 deep',
  '- [ ] 1.1 * 1.1 s',
  '- [ ]* 1.1 s',
  '- [ ]\\* 1.1 s',
  '  - [ ] 1.1 indented',
  '    - [ ] 1.1 four-space',
  '\t- [ ] 1.1 tab',
  '- [ ] 01.1 leading-zero',
  '- [ ] 1.1. trailing-dot',
  '- [ ]  1.1 double-space',
  '- [ ] 1.1 foo   ',
  '- [ ] 1.1foo',
  '- [] 1.1 x',
  '- [ab] 1.1 x',
  '- [ ] task',
  '* [ ] 1.1 x',
  '-[ ] 1.1 x',
  '- [x]1.1 nospace',
  '+ [ ] 1.1 plus',
  '',
  '## Tasks',
]

describe('判别力：差异行必须在两个模式下不同', () => {
  for (const id of DIFFERING_ROWS) {
    it(`${id} 的两策略输出不同（开关被单边写死时本断言必红）`, () => {
      const entry = row(id)
      for (const specimen of entry.specimens) {
        const tag = entry.kind === 'line' ? specimen.text : specimen.name
        const dsh = policyFor(entry.kind, specimen, 'dsh-spec')
        const kiro = policyFor(entry.kind, specimen, 'codex-spec')
        assert.notDeepEqual(dsh, kiro, `${id} · ${tag}`)
      }
    })
  }
})

describe('判别力：归并后的行在两个模式下必须一致', () => {
  for (const id of AGREEING_ROWS) {
    it(`${id} 的两策略输出相同（归并到单边行为）`, () => {
      const entry = row(id)
      for (const specimen of entry.specimens) {
        const tag = entry.kind === 'line' ? specimen.text : specimen.name
        assert.deepEqual(
          policyFor(entry.kind, specimen, 'dsh-spec'),
          policyFor(entry.kind, specimen, 'codex-spec'),
          `${id} · ${tag}`,
        )
      }
    })
  }
})

describe('判别力：已实测一致的形态不得按无关理由分叉', () => {
  for (const line of SAME_IN_BOTH_MODES) {
    it(JSON.stringify(line), () => {
      const results = HOSTS.map((host) => policyFor('line', { text: line }, host))
      assert.deepEqual(results[0], results[1], `${line} 在两模式下取值不同 —— 说明开关的作用面超出了 A1 / A2`)
    })
  }
})

describe('判别力矩阵自身的完整性', () => {
  it('差异行与归并行的集合恰好覆盖差异表七行', () => {
    assert.deepEqual(
      [...DIFFERING_ROWS, ...AGREEING_ROWS].sort(),
      FIXTURE.rows.map((entry) => entry.id).sort(),
    )
  })
})

describe('Property 7 · 不得比真机更严', () => {
  // 需求 3.4 的可判定形式，也是第 3.5 期完成门槛的先决条件。它必须把**真机的判定**
  // （fixture 的 kiroBin 列）与**两个策略的输出**关联起来——只断言 fixture 的 kiroBin
  // 等于重算值是不够的（那只是自洽，不是约束）。
  it('真机判 ok 的复选框行，任一策略都不得把它判成非任务', () => {
    let checked = 0
    for (const entry of FIXTURE.rows) {
      if (DECLARED_ROWS.has(entry.id)) continue // A1 / A2：已在 declared-diffs 里声明
      if (entry.kind === 'document') continue // 文档行由下一条断言管
      for (const specimen of entry.specimens) {
        if (specimen.kiroBin.verdict !== 'ok') continue // 真机自己就报错的行不在此约束内
        for (const host of HOSTS) {
          const got = policyFor('line', specimen, host)
          assert.equal(
            got?.kind,
            'task',
            `${entry.id} · ${JSON.stringify(specimen.text)} 在 ${host} 下是 ${JSON.stringify(got)}，而真机判它为 ok`,
          )
          checked += 1
        }
      }
    }
    // 当前唯一落在约束内的是 B 行（2 个样本 × 2 个策略）。数字写死是刻意的：将来谁动了
    // 这一行，必须来看一眼是不是把约束范围悄悄改空了。
    assert.equal(checked, 4, `受约束的样本数是 ${checked}，期望 4（B 行的两行文本 × 两个策略）`)
  })

  it('文档行：少判真机判 ok 的行，只在未闭合围栏探针触发时才允许（需求 3.5 的成立条件）', () => {
    // E 不该被整体排除：它其实**满足**约束（两策略都判 [3] / [3,5]，与真机一致）。
    // 真正被需求 3.5 豁免的只有「围栏内被跳过」这一种偏离，而它的成立条件是探针可见。
    let deviations = 0
    for (const entry of FIXTURE.rows) {
      if (DECLARED_ROWS.has(entry.id)) continue
      if (entry.kind !== 'document') continue
      for (const specimen of entry.specimens) {
        const okLines = specimen.kiroBin.taskLines
        for (const host of HOSTS) {
          const got = policyFor('document', specimen, host)
          const skipped = okLines.filter((line) => !got.taskLines.includes(line))
          if (skipped.length === 0) continue
          deviations += 1
          assert.equal(
            hasUnterminatedFence(specimen.text),
            true,
            `${entry.id} · ${specimen.name} 在 ${host} 下少判了真机判 ok 的行 ${JSON.stringify(skipped)}，` +
              '但未闭合围栏探针没有触发 —— 少算就成了静默的',
          )
        }
      }
    }
    assert.equal(deviations, 2, `受豁免的偏离样本数是 ${deviations}，期望 2（F 文档 × 两个策略）`)
  })
})
