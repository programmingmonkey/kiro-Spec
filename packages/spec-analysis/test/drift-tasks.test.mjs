// Task 3.3 —— drift 的任务行判定与共享层**同解**（Correctness Property 2）。
//
// 旧套件到不了这条路径：drift 在旧套件里只经 `spec_drift` 工具被驱动，而工具层喂给它的
// 语料里没有 `- [ ] * 1.x` / `- [ ] 1.x` 这类边界形态（`fixtures/assertion-map.json`
// 把它的 5 条断言全判为 not-movable）。所以「收敛后是否真的同解」必须自己测。
//
// 判别力靠**形状空间**而不是几个定值样本：定值样本只能证明「我想到的那几行对了」，
// 而收敛的意义是「这一类都不再分叉」。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseTaskLine } from '@my-harness/spec-parser'
import { parseTaskEntries } from '../lib/drift.js'

const isTask = (line) => {
  const parsed = parseTaskLine(line)
  return parsed !== undefined && parsed.kind === 'task'
}
const driftSees = (line) => parseTaskEntries(line).length > 0

describe('Task 3.3 — 形状空间上逐行同解（2160 例）', () => {
  const AXES = {
    indent: ['', '  ', '    '],
    state: [' ', 'x', '-', '~', '/'],
    postBracket: ['', ' ', '*', '* ', ' * ', '\\*', '\\* ', ' \\* '],
    id: ['1', '1.1', '1.1.2'],
    afterId: ['', ' x', '. x', 'foo', '.', '.foo'],
  }
  const space = []
  for (const indent of AXES.indent)
    for (const state of AXES.state)
      for (const postBracket of AXES.postBracket)
        for (const id of AXES.id)
          for (const afterId of AXES.afterId) space.push(`${indent}- [${state}]${postBracket}${id}${afterId}`)

  it(`空间大小是 ${Object.values(AXES).reduce((n, xs) => n * xs.length, 1)}，与 Task 0.3 的探针同口径`, () => {
    assert.equal(space.length, 2160)
  })

  it('每一行：drift 判它是任务 ⟺ 共享层判它是任务', () => {
    const disagreements = space.filter((line) => driftSees(line) !== isTask(line))
    assert.deepEqual(disagreements, [], `与共享层判定不同的行：${JSON.stringify(disagreements.slice(0, 10))}`)
  })

  it('Task 0.3 点名的那两行，收敛后都对齐到共享层', () => {
    // `]` 与 `*` 之间有空格的**不是**任务（spec-parser 的 D 行已断言决定）。
    assert.equal(driftSees('- [ ] * 1.1 x'), false)
    assert.equal(isTask('- [ ] * 1.1 x'), false)
    // 尾点后直接跟正文的**是**任务（旧 drift 的窄正则漏掉它 —— 漏算比多算危险）。
    assert.equal(driftSees('- [ ] 1.foo'), true)
    assert.equal(isTask('- [ ] 1.foo'), true)
    // 仓库自己的取子任务记法仍被两边同时认下。
    assert.equal(driftSees('- [ ]* 1.1 x'), true)
    assert.equal(isTask('- [ ]* 1.1 x'), true)
  })
})

describe('Task 3.3 — 收敛没有顺手动到别的语义', () => {
  it('`valid` 仍是本仓的三态，不是共享层的四字符类（`[~]` 是任务但不合法）', () => {
    const [entry] = parseTaskEntries('- [~] 1.1 x')
    assert.equal(entry.state, '~')
    assert.equal(entry.done, false)
    assert.equal(entry.valid, false, '`[~]` 能解析，但不是本仓承认的合法状态')
  })

  it('缩进详情行仍归属上一条任务，`---` 仍然结束任务块', () => {
    const md = ['- [ ] 1.1 a', '    - _Requirements: 1, 2_', '    - _Requirements: 3_', '', '- [ ] 1.2 b', '', '---', '', '  - _Requirements: 9_'].join('\n')
    const entries = parseTaskEntries(md)
    assert.deepEqual(entries.map((e) => e.index), ['1.1', '1.2'])
    assert.deepEqual(entries[0].requirements, ['1', '2', '3'])
    assert.deepEqual(entries[1].requirements, [], '`---` 之后不再归属任何任务')
  })

  it('粘连 id 仍不是任务（共享层与旧 drift 在这件事上本来就一致）', () => {
    assert.deepEqual(parseTaskEntries('- [ ] 1.2foo').map((e) => e.index), [])
  })
})
