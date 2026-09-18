// Pure-function tests. These pin the invariants behind findings F1, F2, F4, F5,
// F6, F7, F8, F11, F14, F15 and F18 — each named after its finding id so a
// regression points straight back at the analysis.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { __test as T } from '../lib/index.js'

const graphMd = (json, extra = '## Tasks\n- [ ] 1.1 x\n') =>
  `## Task Dependency Graph\n\n\`\`\`json\n${json}\n\`\`\`\n\n${extra}`

describe('F1 — a grouping parent must not make `complete` unreachable', () => {
  it('counts only leaf tasks in the shipped template', () => {
    // The template emits `- [ ] 1. <area>` plus `- [ ] 1.1 <task>` while the
    // graph declares only "1.1". Counting the parent left complete unreachable.
    const stats = T.taskStats(T.tasksTemplate())
    assert.equal(stats.total, 1)
    assert.equal(stats.done, 0)
  })

  it('reaches complete once every graph task is done', () => {
    const template = T.tasksTemplate()
    const graph = T.parseDependencyGraph(template)
    const plan = T.buildWavePlan(graph, T.parseTaskList(template))
    let md = template
    for (const task of plan.waves.flat()) {
      md = md.replace(new RegExp(`- \\[ \\] ${task.index.replace('.', '\\.')} `), `- [x] ${task.index} `)
    }
    const stats = T.taskStats(md)
    assert.equal(stats.done, stats.total)
    assert.equal(
      T.phaseOf({ requirements: true, design: true, tasks: true, tasksTotal: stats.total, tasksDone: stats.done }),
      'complete',
    )
  })

  it('skips the parent label when choosing the next task', () => {
    const md = '## Tasks\n- [ ] 1. area\n- [ ] 1.1 child\n'
    assert.equal(T.nextTask(md).index, '1.1')
  })
})

describe('F2 — only id-bearing, unfenced checkbox lines are tasks', () => {
  it('ignores an un-numbered prose checklist', () => {
    // The realistic "not a task" case: acceptance-criteria style checklists in
    // prose carry no task id and were never matched.
    const md = [
      '## Overview',
      '- [ ] acceptance criteria all pass',
      '- [x] code reviewed',
      '',
      '## Tasks',
      '- [ ] 1.1 the real task',
      '',
    ].join('\n')
    assert.deepEqual(T.parseTaskList(md).map((t) => t.index), ['1.1'])
    assert.equal(T.taskStats(md).total, 1)
  })

  it('DOES count an id-bearing task appended under its own heading', () => {
    // Deliberate: a real spec in the development repository
    // appends follow-up tasks under `## Review Follow-up`. Scoping the parse to
    // `## Tasks` silently dropped task 12 there — undercounting can report
    // `complete` while work remains, which is the dangerous direction.
    const md = [
      '## Tasks',
      '- [ ] 11. wrap up',
      '',
      '## Review Follow-up',
      '- [ ] 12. fix what the review found',
      '',
    ].join('\n')
    assert.deepEqual(T.parseTaskList(md).map((t) => t.index), ['11', '12'])
    assert.equal(T.taskStats(md).total, 2)
  })

  it('ignores a checkbox inside a fenced example', () => {
    const fenced = '## Tasks\n```\n- [ ] 7.7 example\n```\n- [ ] 1.1 real\n'
    assert.deepEqual(T.parseTaskList(fenced).map((t) => t.index), ['1.1'])
  })
})

describe('F7 — parser and diagnostics agree on which lines are tasks', () => {
  const md = '## Tasks\n- [ ] 1.1 ok\n- [!] 1.2 bad state\n- [ ] 1.3 no title\n'

  it('sees fourth-state and untitled lines instead of silently dropping them', () => {
    assert.deepEqual(T.parseTaskList(md).map((t) => t.index), ['1.1', '1.2', '1.3'])
  })

  it('counts an invalid-state task toward the total but never as done', () => {
    const stats = T.taskStats(md)
    assert.equal(stats.total, 3)
    assert.equal(stats.done, 0)
  })

  it('still reports the invalid state as an error', () => {
    // `[!]` is outside Kiro's checkbox character class `[ x~-]`, so it is a
    // malformed checkbox (Kiro's own rule name), not a generic state error.
    const codes = T.diagnoseArtifact('tasks', md).map((d) => d.code)
    assert.ok(codes.includes('tasks/malformed-checkbox'), JSON.stringify(codes))
  })

  it('rejects an id glued to non-space text', () => {
    assert.equal(T.parseTask('- [ ] 1.1foo'), undefined)
  })
})

describe('F4 — a task declared in two waves is dispatched once', () => {
  it('keeps the first declaration and warns', () => {
    const md = graphMd('{"waves":[{"id":0,"tasks":["1.1"]},{"id":1,"tasks":["1.1","1.2"]}]}',
      '## Tasks\n- [ ] 1.1 shared\n- [ ] 1.2 other\n')
    const plan = T.buildWavePlan(T.parseDependencyGraph(md), T.parseTaskList(md))
    const flat = plan.waves.flat().map((t) => t.index)
    assert.deepEqual(flat, ['1.1', '1.2'])
    assert.equal(new Set(flat).size, flat.length)
    assert.equal(plan.warnings.length, 1)
  })
})

describe('F8 — an explicitly empty graph is not "run everything"', () => {
  it('produces no plan and explains why', () => {
    const md = graphMd('{"waves":[]}')
    const graph = T.parseDependencyGraph(md)
    assert.equal(T.buildWavePlan(graph, T.parseTaskList(md)).waves.length, 0)
    assert.match(graph.warnings.join(' '), /empty array/)
    assert.ok(T.diagnoseArtifact('tasks', md).some((d) => d.code === 'tasks/waves-schema'))
  })

  // 🔴 这条钉的是这段文案**对用户说的那件事**（不是它的措辞）。
  // 由来（2026-09-16 晚整体 review 实测）：原句说省略图会「runs every task in a single wave」——
  // 那是 T7 **之前**的语义。T7 把「无图」裁决成「一任务一波（严格串行）」之后，那句话成了反话
  // （读起来像「省略图会跑并发」）。**没有任何测试钉着它**，所以它安静地错了。
  // 共享诊断层里还有一份同义的消息，也一并钉住（`packages/spec-diagnose/test/rule-reachability.test.mjs`）：
  // 两处是独立实现，只钉一边，另一边仍会悄悄漂。
  it('空图那条 warning 不再把「省略图」说成会跑并发', () => {
    const messages = T.parseDependencyGraph(graphMd('{"waves":[]}')).warnings.join(' ')
    assert.match(messages, /empty array/, '这条 warning 还在（否则下面是恒真）')
    assert.match(messages, /one at a time/, '必须说清省略图的读法是「一次一个」')
    assert.doesNotMatch(messages, /single wave|one wave/, '不许再把省略图说成「塞进一个 wave」')
  })

  it('treats "no graph section at all" as STRICTLY SERIAL (2026-09-16 ruling)', () => {
    const md = '## Tasks\n- [ ] 1.1 x\n'
    assert.equal(T.parseDependencyGraph(md), undefined)
    // ⚠️ 单任务时两种读法同形，这条断言**单独看不出裁决** —— 所幸下面补了多任务。
    // （原用例名是 "preserves the legacy ... behavior"，它用的正是单任务语料，
    //   所以它对「一 wave 装下全部」与「一任务一 wave」都不鉴别。）
    assert.equal(T.buildWavePlan(undefined, T.parseTaskList(md)).waves.flat().length, 1)

    // 裁决的要害在**多任务**：无图必须一任务一 wave（串行），而不是「一 wave 装下全部」。
    const multi = '## Tasks\n- [ ] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n'
    const plan = T.buildWavePlan(undefined, T.parseTaskList(multi))
    assert.equal(plan.waves.length, 3, '无图 ⇒ 一任务一 wave')
    assert.ok(plan.waves.every((w) => w.length === 1), '每个 wave 只能有一个任务（否则会被并发派发）')
    // 且必须**说出来**为什么串行、以及怎么拿到并发 —— 否则用户会以为那是性能问题。
    assert.match(plan.warnings.join(' '), /没有 `## Task Dependency Graph`/)
    assert.match(plan.warnings.join(' '), /想要波内并发/)

    // 对照组：**声明的** wave 仍然波内并发。裁决只动「无图」这一态，别顺手削掉既有能力。
    const declared = graphMd(
      '{"waves":[{"id":0,"tasks":["1.1","1.2"]},{"id":1,"tasks":["1.3"]}]}',
      '## Tasks\n- [ ] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n',
    )
    const plan2 = T.buildWavePlan(T.parseDependencyGraph(declared), T.parseTaskList(declared))
    assert.equal(plan2.waves.length, 2)
    assert.equal(plan2.waves[0].length, 2, '声明的 wave 内必须保住并发能力')
  })
})

describe('F5 — the graph heading is matched exactly, like the diagnostics do', () => {
  it('does not accept a heading that merely starts with it', () => {
    const md = graphMd('{"waves":[{"id":0,"tasks":["1.1"]}]}')
      .replace('## Task Dependency Graph', '## Task Dependency Graph Notes')
    assert.equal(T.parseDependencyGraph(md), undefined)
    // Kiro's own code for a missing graph section, not the old generic
    // `tasks/missing-section` template code.
    assert.ok(T.diagnoseArtifact('tasks', md).some((d) => d.code === 'tasks/missing-dependency-graph'))
  })
})

describe('F6 — headings inside a fence are not sections', () => {
  it('does not let an example heading mask a missing section', () => {
    const md = [
      '# Design Document',
      '',
      '## Overview',
      '```',
      '## Architecture',
      '```',
      '## Data Models',
      '',
      '## Components and Interfaces',
      '',
    ].join('\n')
    const missing = T.diagnoseArtifact('design', md)
      .filter((d) => d.code === 'design/missing-architecture')
      .map((d) => d.message)
    assert.ok(missing.some((m) => m.includes('Architecture')), JSON.stringify(missing))
  })
})

describe('an unterminated fence is reported, not silently swallowed', () => {
  // Scanning is fence-aware, so a stray ``` hides every task after it. That
  // undercounts (and can let phase report complete), so it must be loud.
  it('flags the imbalance', () => {
    const md = '## Tasks\n- [ ] 1.1 before\n```\n- [ ] 1.2 after\n'
    assert.equal(T.hasUnterminatedFence(md), true)
    assert.ok(T.diagnoseArtifact('tasks', md).some((d) => d.code === 'tasks/unterminated-fence'))
  })

  it('stays quiet on a balanced document', () => {
    const md = '## Tasks\n```\n- [ ] 9.9 example\n```\n- [ ] 1.1 real\n'
    assert.equal(T.hasUnterminatedFence(md), false)
    assert.ok(!T.diagnoseArtifact('tasks', md).some((d) => d.code === 'tasks/unterminated-fence'))
    // ...and the fenced example is still excluded from the count.
    assert.deepEqual(T.parseTaskList(md).map((t) => t.index), ['1.1'])
  })
})

describe('F18 — duplicate task ids are refused rather than guessed', () => {
  const md = '## Tasks\n- [ ] 1.1 first\n- [ ] 1.1 second\n'

  it('throws from the planner', () => {
    assert.throws(() => T.buildWavePlan(undefined, T.parseTaskList(md)), /duplicate task id/i)
  })

  it('is reported by the diagnostics', () => {
    assert.ok(T.diagnoseArtifact('tasks', md).some((d) => d.code === 'tasks/duplicate-task-id'))
  })
})

describe('F11 — the runner owns task state, not the child', () => {
  it('tells the child explicitly not to mark its own task', () => {
    const prompt = T.buildTaskPrompt({ index: '1.1', text: 'do it', detail: [] })
    assert.match(prompt, /Do NOT edit tasks\.md or call spec_task_set/)
    assert.doesNotMatch(prompt, /Mark the task done/)
  })
})

describe('F14 — spec context is narrowed and bounded', () => {
  const requirements = '## Requirements\n\n### 1. First\nWHEN a THE SYSTEM SHALL b\n\n### 2. Second\nWHEN c THE SYSTEM SHALL d\n'

  it('reads the cited requirement ids out of the detail lines', () => {
    assert.deepEqual(T.referencedRequirementIds(['- _Requirements: 2.1, 3.4_']), ['2', '3'])
  })

  it('injects only the cited block', () => {
    const prompt = T.buildTaskPrompt({
      index: '1.1',
      text: 't',
      detail: ['- _Requirements: 2.1_'],
      requirements,
    })
    assert.match(prompt, /### 2\. Second/)
    assert.doesNotMatch(prompt, /### 1\. First/)
  })

  it('falls back to the whole document when nothing is cited', () => {
    const prompt = T.buildTaskPrompt({ index: '1.1', text: 't', detail: [], requirements })
    assert.match(prompt, /### 1\. First/)
  })

  it('keeps the total context within the byte budget', () => {
    const prompt = T.buildTaskPrompt({
      index: '1',
      text: 't',
      detail: [],
      requirements: 'x'.repeat(5000),
      design: 'y'.repeat(5000),
      maxBytes: 1000,
    })
    assert.ok(Buffer.byteLength(prompt, 'utf8') < 2500, `got ${Buffer.byteLength(prompt, 'utf8')}`)
    assert.match(prompt, /truncated/)
  })

  it('truncates on a code-point boundary', () => {
    assert.doesNotMatch(T.clipContext('日本語テキスト'.repeat(50), 10), /\uFFFD/)
  })
})

describe('F15 — wave concurrency is capped', () => {
  it('never exceeds the limit and preserves result order', async () => {
    let live = 0
    let peak = 0
    const outcomes = await T.runBatched([...Array(9).keys()], 3, async (i) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live -= 1
      if (i === 7) throw new Error('boom')
      return i
    })
    assert.ok(peak <= 3, `peak=${peak}`)
    assert.equal(outcomes.length, 9)
    assert.equal(outcomes.filter((o) => o.status === 'rejected').length, 1)
    assert.equal(
      outcomes.map((o) => (o.status === 'fulfilled' ? o.value : 'X')).join(','),
      '0,1,2,3,4,5,6,X,8',
    )
  })
})

describe('featureName — path traversal is slugged away', () => {
  it('strips separators and dots', () => {
    assert.equal(T.featureName('../../../etc/passwd', ''), 'etc-passwd')
    assert.equal(T.featureName(undefined, ''), 'feature')
  })
})
