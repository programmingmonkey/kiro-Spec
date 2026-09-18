// R3 · 父任务收敛（第 4 期 Task 6）。
//
// 缺口从哪来：叶子计数让 `phase: complete` 可达（F1 的目的），但 `tasks.md` 里父任务那一行
// 不会被标记，于是出现「`phase: complete` 而父任务框仍是空」的观感不一致。Kiro 真机会在其
// 子任务全部完成后自动标记父任务。
//
// 🔴 review 原文那句免责「影响面小：现有 4 份真实 spec 全是扁平结构，无父子嵌套」
// **放到今天的语料上早就不成立** —— 实测消费项目 207 份有任务的 spec 里 86 份含嵌套。
// 所以本文件的下半部分直接拿真实语料验，不再引用那句话当理由。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { parseTaskLine } from '@my-harness/spec-parser'
import { scanLines } from '@my-harness/spec-parser/scan-lines'

import { consumerAbsenceMessage, resolveConsumerSpecs } from '../../../scripts/consumer-root.mjs'
import { __test } from '../lib/index.js'
import { cleanup, makeProject, mount } from './harness.mjs'

const { convergeParents, parseTaskList, parentTaskIds, duplicateTaskIds } = __test
const roots = []
after(() => roots.forEach(cleanup))

const tasksDoc = (lines) => ['# Implementation Plan', '', '## Tasks', '', ...lines, ''].join('\n')

/** 把所有**叶子**任务标成 `[x]`，父任务保持原样 —— 用来模拟「任务都跑完了」。 */
function markLeavesDone(markdown) {
  const lines = markdown.split('\n')
  const flags = scanLines(markdown)
  const tasks = []
  lines.forEach((line, i) => {
    if (flags[i]?.inFence) return
    const parsed = parseTaskLine(line, { strictTaskState: false })
    if (parsed?.kind === 'task') tasks.push({ i, id: parsed.id, offset: parsed.stateOffset })
  })
  const isParent = (id) => tasks.some(
    (t) => t.id.startsWith(`${id}.`) && !t.id.slice(id.length + 1).includes('.'),
  )
  for (const task of tasks) {
    if (isParent(task.id)) continue
    const line = lines[task.i]
    lines[task.i] = `${line.slice(0, task.offset)}x${line.slice(task.offset + 1)}`
  }
  return lines.join('\n')
}

describe('convergeParents · 精确语义（Task 6 Step 1）', () => {
  it('同级全 [x] → 父任务收敛', () => {
    const before = tasksDoc(['- [ ] 1. Parent', '  - [x] 1.1 A', '  - [x] 1.2 B'])
    assert.match(convergeParents(before), /^- \[x\] 1\. Parent/m)
  })

  it('🔴 反向（Step 4）：同级未全 [x] → 父任务**不得**收敛', () => {
    const before = tasksDoc(['- [ ] 1. Parent', '  - [x] 1.1 A', '  - [ ] 1.2 B'])
    assert.equal(
      convergeParents(before),
      before,
      '同级还有未完成的任务，父任务却被收敛了 —— 恒真的「无条件收敛」实现也会通过正向测试',
    )
  })

  it('反向：父任务是 [-] 而同级未全 [x]，同样不动', () => {
    const before = tasksDoc(['- [-] 1. Parent', '  - [ ] 1.1 A', '  - [x] 1.2 B'])
    assert.equal(convergeParents(before), before)
  })

  it('逐级向上：深层全完成时中间层与祖父一起收敛（不动点，不是只查一层）', () => {
    const before = tasksDoc([
      '- [ ] 1. Grandparent',
      '  - [ ] 1.1 Parent',
      '    - [x] 1.1.1 Leaf',
      '    - [x] 1.1.2 Leaf',
    ])
    const after = convergeParents(before)
    assert.match(after, /^- \[x\] 1\. Grandparent/m, '祖父未收敛')
    assert.match(after, /^  - \[x\] 1\.1 Parent/m, '中间层未收敛 —— 只查一层会停在这里')
  })

  it('只收敛不反收敛：父已 [x]、子被退回 [ ]，父不动', () => {
    const before = tasksDoc(['- [x] 1. Parent', '  - [ ] 1.1 A', '  - [ ] 1.2 B'])
    assert.equal(
      convergeParents(before),
      before,
      '回退父任务会把「曾经全部完成」这件事抹掉 —— Kiro 真机也不回退',
    )
  })

  it('围栏内的示例行不参与判定', () => {
    const before = tasksDoc([
      '- [ ] 1. Parent',
      '  - [x] 1.1 Real and done',
      '',
      '```md',
      '  - [ ] 1.2 Fenced example (must not count)',
      '```',
    ])
    assert.match(
      convergeParents(before),
      /^- \[x\] 1\. Parent/m,
      '围栏内的示例行被当成了未完成的子任务',
    )
  })

  it('非任务行逐字保留（只动 checkbox 那一个字符）', () => {    const before = tasksDoc(['- [ ] 1. Parent', '  - [x] 1.1 A', '  note: keep me verbatim'])
    const after = convergeParents(before)
    assert.ok(after.includes('  note: keep me verbatim'))
    assert.equal(after.replace(/^- \[x\] 1\. Parent/m, '- [ ] 1. Parent'), before)
  })

  it('🔴 重复 id 时拒绝收敛 —— 与 `setTaskState` 的 F18 守卫一致（2026-09-13 补）', () => {
    // 对抗性审查实测到的行为不一致：`setTaskState` 早就有「重复 id 无法唯一定位」的守卫，
    // 而 `convergeParents` 没有 —— 一份含两行 `- [ ] 1. dup parent` 的 tasks.md，在标记
    // **唯一**的 `2.` 之后，**两行 `1.`** 都会被改写成 `[x]`。新增行为不该比既有行为更宽松。
    const before = tasksDoc([
      '- [ ] 1. dup parent',
      '  - [x] 1.1 a',
      '- [ ] 1. dup parent again',
      '- [ ] 2. other',
    ])
    assert.throws(() => convergeParents(before), /defined more than once/)
  })
})

describe('真实嵌套语料（Task 6 Step 2/3 —— 不再引用「现有 spec 全是扁平」那句免责）', () => {
  const { specs, resolved } = resolveConsumerSpecs()

  /** 能被干净处理的嵌套语料：无非法态、无重复 id、确有父子结构。 */
  const nestedCorpora = () => {
    const out = []
    for (const entry of readdirSync(specs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const abs = join(specs, entry.name, 'tasks.md')
      if (!existsSync(abs)) continue
      const markdown = readFileSync(abs, 'utf8')
      let entries
      try {
        entries = parseTaskList(markdown)
      } catch {
        continue
      }
      if (entries.length === 0) continue
      if (entries.some((e) => !e.valid)) continue
      if (duplicateTaskIds(entries).length > 0) continue
      const parents = parentTaskIds(entries)
      if (!entries.some((e) => parents.has(e.index))) continue
      out.push({ name: entry.name, markdown, parents })
    }
    return out
  }

  it('每份嵌套语料的父任务，在叶子全完成后都收敛（且不误伤未全完成的）', (t) => {
    if (!resolved) {
      t.skip(consumerAbsenceMessage('消费项目嵌套语料'))
      return
    }
    const corpora = nestedCorpora()
    assert.ok(
      corpora.length >= 50,
      `只找到 ${corpora.length} 份可用的嵌套语料 —— 语料本身可能变了，或者筛选条件写错了`,
    )
    for (const { name, markdown, parents } of corpora) {
      const converged = convergeParents(markLeavesDone(markdown))
      const after = parseTaskList(converged)
      const stillPending = after.filter((e) => parents.has(e.index) && e.state !== 'x')
      assert.deepEqual(
        stillPending.map((e) => e.index),
        [],
        `${name}：叶子全完成后仍有父任务停在非 [x]`,
      )
    }
  })

  it('反向：真实语料上「不是全部完成」时，父任务同样不被收敛', (t) => {
    if (!resolved) {
      t.skip(consumerAbsenceMessage('消费项目嵌套语料'))
      return
    }
    const corpora = nestedCorpora()
    let exercised = 0
    for (const { name, markdown, parents } of corpora) {
      const entries = parseTaskList(markdown)
      // 只挑「当前确实还有未完成的叶子」的语料：这种语料上收敛**不该**发生。
      const unfinishedLeaves = entries.filter((e) => !parents.has(e.index) && e.state !== 'x')
      if (unfinishedLeaves.length === 0) continue
      const after = parseTaskList(convergeParents(markdown))
      const beforeById = new Map(entries.map((e) => [e.index, e]))
      for (const e of after) {
        if (!parents.has(e.index)) continue
        // 只追究「本次收敛**新**标成 [x]」的父任务；本来就完成的不算。
        if (e.state !== 'x' || beforeById.get(e.index)?.state === 'x') continue
        // 🔴 用**收敛后**的子任务状态判断，而不是原始状态（2026-09-13 对抗性审查修正）。
        // 收敛是**迭代**的：`- [ ] 1. P` / `- [x] 1.1` / `- [ ] 1.2 mid` / `- [x] 1.2.1`
        // 这种两级级联会被合法地收敛成 `1=x, 1.2=x`；若用原始状态判断，1.2 当时还是 `[ ]`，
        // 谓词就会对**合法**的收敛 assert.fail。原写法今天全绿只是因为抽样的 20 份语料里
        // 没有这个形状 —— 那是「换语料就假红」，不是「断言有效」。
        const children = after.filter(
          (c) => c.index.startsWith(`${e.index}.`) && !c.index.slice(e.index.length + 1).includes('.'),
        )
        assert.ok(
          children.length > 0 && children.every((c) => c.state === 'x'),
          `${name}：父任务 ${e.index} 在子任务未全完成时被收敛`,
        )
      }
      exercised += 1
      if (exercised >= 20) break
    }
    assert.ok(exercised > 0, '没有语料能演练这条反向断言')
  })

  it('F1 复验：嵌套结构下 spec_init 起盘 → 跑完全部任务 → phase 为 complete', async (t) => {
    if (!resolved) {
      t.skip(consumerAbsenceMessage('消费项目嵌套语料'))
      return
    }
    const sample = nestedCorpora()[0]
    assert.ok(sample, '没有可用的嵌套语料')

    const root = makeProject()
    roots.push(root)
    const { call } = mount(root)
    await call('spec_init', { goal: 'nested corpus replay', feature: 'nested-replay' })
    await call('spec_write', { file: 'design', content: '# Design Document\n\n## Architecture\n\n## Data Flow\n' })
    // 🔴 用**真实**语料的 tasks.md，不是自造玩具 fixture。
    await call('spec_write', { file: 'tasks', content: sample.markdown })

    const leaves = parseTaskList(sample.markdown)
      .filter((e) => !parentTaskIds(parseTaskList(sample.markdown)).has(e.index))
    for (const leaf of leaves) {
      await call('spec_task_set', { index: leaf.index, state: 'done' })
    }

    const status = await call('spec_status', {})
    assert.equal(status.phase, 'complete', `${sample.name}：嵌套结构下 phase 未到达 complete（F1 的缺口）`)

    const finalTasks = readFileSync(join(root, '.kiro', 'specs', 'nested-replay', 'tasks.md'), 'utf8')
    const parents = parentTaskIds(parseTaskList(finalTasks))
    const pendingParents = parseTaskList(finalTasks).filter((e) => parents.has(e.index) && e.state !== 'x')
    assert.deepEqual(
      pendingParents.map((e) => e.index),
      [],
      'phase 说 complete，但父任务框还空着 —— 这正是 R3 要消灭的观感不一致',
    )
  })
})
