// Tool-layer integration tests. These drive the same registered tools the
// harness exposes, over a real temp directory, so stage gating, state writing
// and the `/spec` command behave here exactly as they do in a session.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { cleanup, fakeSubagents, makeProject, mount, readFile } from './harness.mjs'

const roots = []
const project = () => {
  const root = makeProject()
  roots.push(root)
  return root
}
after(() => roots.forEach(cleanup))

const OK = () => ({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] })

describe('spec_init', () => {
  it('scaffolds requirements.md, records the active spec and reports the phase', async () => {
    const root = project()
    const { call } = mount(root)
    const out = await call('spec_init', { goal: 'Add a widget', feature: 'widget' })

    assert.equal(out.phase, 'requirements')
    assert.equal(out.workflow, 'requirements-first')
    assert.ok(existsSync(join(root, '.kiro/specs/widget/requirements.md')))
    assert.match(readFile(root, '.kiro/specs/widget/_active'.replace('widget/', '')), /widget/)
    assert.ok(existsSync(join(root, '.kiro/specs/widget/tasks.meta.json')))
  })

  it('starts a bugfix spec at the analysis stage with bugfix.md', async () => {
    const root = project()
    const { call } = mount(root)
    const out = await call('spec_init', { goal: 'Fix a thing', kind: 'bugfix', feature: 'bug' })
    assert.equal(out.phase, 'analysis')
    assert.ok(existsSync(join(root, '.kiro/specs/bug/design.md')) === false)
    assert.ok(existsSync(join(root, '.kiro/specs/bug/bugfix.md')))
  })

  it('F17 — quick reports the same workflow it records on disk', async () => {
    const root = project()
    const { call } = mount(root)
    const out = await call('spec_init', {
      goal: 'Quick one',
      kind: 'quick',
      workflow: 'design-first',
      feature: 'quick1',
    })
    const meta = JSON.parse(readFile(root, '.kiro/specs/quick1/tasks.meta.json'))
    assert.equal(out.workflow, meta._workflow)
    assert.equal(out.workflow, 'requirements-first')
  })
})

describe('spec_write stage gating', () => {
  it('refuses design before requirements', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'f1' })
    // `spec_init` scaffolds requirements.md, so the gate is only reachable when
    // that file is genuinely absent (it was deleted, or init never ran).
    rmSync(join(root, '.kiro/specs/f1/requirements.md'))
    await assert.rejects(() => call('spec_write', { file: 'design', content: '# Design Document\n' }), /requirements\.md does not exist/)
  })

  it('refuses tasks before design', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'f2' })
    // Only requirements.md exists at this point — no design.md yet.
    await assert.rejects(() => call('spec_write', { file: 'tasks', content: '# Implementation Plan\n' }), /design\.md does not exist/)
  })

  it('F13 — design-first refuses requirements before design', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'g', workflow: 'design-first', feature: 'f3' })
    rmSync(join(root, '.kiro/specs/f3/design.md'))
    await assert.rejects(
      () => call('spec_write', { file: 'requirements', content: '# Requirements Document\n' }),
      /design-first derives requirements FROM the design/,
    )
  })

  it('F13 — design-first allows requirements by default (design.md was scaffolded)', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'g', workflow: 'design-first', feature: 'f3b' })
    const out = await call('spec_write', { file: 'requirements', content: '# Requirements Document\n' })
    assert.equal(out.file, 'requirements')
  })

  it('F13 — design-first allows requirements once design exists', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'g', workflow: 'design-first', feature: 'f4' })
    await call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' })
    const out = await call('spec_write', { file: 'requirements', content: '# Requirements Document\n' })
    assert.equal(out.file, 'requirements')
  })
})

describe('spec_task_set', () => {
  const seed = async (root, tasks) => {
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', feature: 'tf' })
    await m.call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' })
    await m.call('spec_write', { file: 'tasks', content: tasks })
    return m
  }

  it('invariant 1 — changes only the checkbox, byte-for-byte otherwise', async () => {
    const root = project()
    const original = [
      '# Implementation Plan',
      '',
      '## Tasks',
      '',
      '- [ ] 1. area',
      '- [ ] 1.1 do the thing',
      '  - step one',
      '',
    ].join('\n')
    const { call } = await seed(root, original)
    await call('spec_task_set', { index: '1.1', state: 'done' })

    const after = readFile(root, '.kiro/specs/tf/tasks.md')
    // 🔴 2026-09-13 · 第 4 期 Task 6（R3）**有意**扩展了这条 invariant：
    // 标记 1.1 之后，父任务 1 的子任务已全部完成，于是它被**收敛**为 `[x]`
    // （对齐 Kiro 真机）。所以期望是**两处** checkbox 变化，其余仍逐字节不变 ——
    // 这条断言的全部价值就在「其余仍逐字节不变」，收敛不是它的松动。
    const expected = original
      .replace('- [ ] 1.1 do the thing', '- [x] 1.1 do the thing')
      .replace('- [ ] 1. area', '- [x] 1. area')
    assert.equal(after, expected)
    // 反向：父任务**不该**被无条件收敛 —— 同级还有未完成时它必须留在 `[ ]`。
    // （完整的反向覆盖在 test/parent-convergence.test.mjs，这里只钉住本 fixture 的形态。）
    assert.equal((after.match(/\[x\]/g) ?? []).length, 2, '只应有目标子任务与它的父任务被标为 [x]')
  })

  it('F18 — refuses to mark a duplicated id', async () => {
    const root = project()
    const { call } = await seed(root, '## Tasks\n- [ ] 1.1 a\n- [ ] 1.1 b\n')
    await assert.rejects(() => call('spec_task_set', { index: '1.1', state: 'done' }), /defined 2 times/)
  })

  it('repairs a fourth-state line', async () => {
    const root = project()
    const { call } = await seed(root, '## Tasks\n- [!] 1.1 odd\n')
    const out = await call('spec_task_set', { index: '1.1', state: 'active' })
    assert.equal(out.state, '[-]')
    assert.match(readFile(root, '.kiro/specs/tf/tasks.md'), /- \[-\] 1\.1 odd/)
  })

  it('still rejects a non-integer numeric id', async () => {
    const root = project()
    const { call } = await seed(root, '## Tasks\n- [ ] 1.1 a\n')
    await assert.rejects(() => call('spec_task_set', { index: 1.1, state: 'done' }), /must be passed as a string/)
  })
})

describe('spec_status / spec_read / spec_diagnostics', () => {
  it('reports complete once all leaves are done', async () => {
    const root = project()
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', kind: 'quick', feature: 'st' })
    for (const id of ['1.1']) await m.call('spec_task_set', { index: id, state: 'done' })

    const status = await m.call('spec_status', {})
    assert.equal(status.tasks.total, 1)
    assert.equal(status.phase, 'complete')
  })

  it('reads one file and the meta file', async () => {
    const root = project()
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', feature: 'rd' })
    const req = await m.call('spec_read', { file: 'requirements' })
    assert.match(req.content, /# Requirements Document/)
    const meta = await m.call('spec_read', { file: 'meta' })
    assert.match(meta.content, /_workflow/)
  })

  it('lints the spec without blocking', async () => {
    const root = project()
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', feature: 'dg' })
    const out = await m.call('spec_diagnostics', {})
    assert.match(out.rendered, /finding\(s\)/)
  })
})

describe('spec_meta', () => {
  it('F25 — rejects an invalid timestamp and records nothing', async () => {
    const root = project()
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', feature: 'mt' })
    // Two lines of defense, asserted as one observable contract: the tool
    // parameter schema rejects a non-number, a non-finite number and null, and
    // the handler's own guard backs that up for direct callers.
    for (const bad of ['yesterday', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => m.call('spec_meta', { action: 'record', task: 't', timestamp: bad }),
        /timestamp/,
        `expected ${String(bad)} to be rejected`,
      )
    }
    const read = JSON.parse((await m.call('spec_meta', { action: 'read' })).rendered)
    assert.deepEqual(read.executionHistory, {})
  })

  it('records and reads back an execution', async () => {
    const root = project()
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', feature: 'mt2' })
    const rec = await m.call('spec_meta', { action: 'record', task: 'task one', timestamp: 123 })
    assert.match(rec.rendered, /task one/)
    const read = await m.call('spec_meta', { action: 'read' })
    const meta = JSON.parse(read.rendered)
    assert.equal(meta.executionHistory['task one'][0].timestamp, 123)
    assert.ok(meta.executionHistory['task one'][0].executionId)
  })

  // 第 9 期 T5 / T8 —— 每条任务的记录上限 10，与真机**逐字一致**（旧代与新代 store 都在
  // 写入时 `length > 10 && slice(-10)`，两处独立实测）。
  //
  // 钉它不是为了好看：我们写的是**同一个文件、同一个字段**，规则不同会让「这份文件里到底
  // 能有多少条」取决于最后写它的是谁。
  it('每个任务最多留 10 条，且截断会说出来', async () => {
    const root = project()
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', feature: 'cap' })

    let last
    for (let i = 1; i <= 11; i += 1) {
      last = await m.call('spec_meta', { action: 'record', task: 't', timestamp: i })
    }
    // 第 11 条触发截断，且**要说出来** —— 真机是静默截的，而静默丢记录正是本仓在别处
    // 反复拒绝的那种降级；调用方至少该知道少了几条。
    assert.match(last.rendered, /10 total, trimmed 1 oldest/)

    const meta = JSON.parse((await m.call('spec_meta', { action: 'read' })).rendered)
    assert.equal(meta.executionHistory.t.length, 10)
    // 留的是**最近** 10 条（`slice(-10)` 的语义）：时间戳 1 被丢，2..11 保留。
    assert.deepEqual(
      meta.executionHistory.t.map((r) => r.timestamp),
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    )
  })

  // 第 9 期 T5 的裁决有一半落在**口径**上：这个工具的描述曾经写 "(Kiro execution history
  // + pbtResults)"，而读它的 agent 会以为这就是当前 Kiro 的数据 —— 它其实是**1.1.28 之前**
  // 的形状，真机已把数据挪走。
  //
  // 钉住描述而不是钉 README：描述是**运行时面**（agent 每次会话都读它），README 是给人看的。
  // 没有这条网，「位置不动、口径要准」这条裁决会被一次顺手的措辞改写悄悄推翻。
  it('工具描述点明当前 Kiro 的 store 在别处（口径回归网）', () => {
    const root = project()
    const m = mount(root)
    const d = m.tools.get('spec_meta').description
    assert.match(d, /~\/\.kiro\/tasks\//, '必须点出当前 Kiro 的 store 位置')
    assert.match(d, /never writes/, '必须说明本插件不写那个 store')
    assert.doesNotMatch(d, /Kiro execution history/, '不许再用「就是 Kiro 的执行历史」这种口径')
  })

  it('刚好 10 条时不截断、也不改口径（边界两侧都钉）', async () => {
    const root = project()
    const m = mount(root)
    await m.call('spec_init', { goal: 'g', feature: 'cap10' })
    for (let i = 1; i <= 10; i += 1) {
      const rec = await m.call('spec_meta', { action: 'record', task: 't', timestamp: i })
      assert.doesNotMatch(rec.rendered, /trimmed/, `第 ${i} 条还不到上限，不该报截断`)
    }
    const meta = JSON.parse((await m.call('spec_meta', { action: 'read' })).rendered)
    assert.equal(meta.executionHistory.t.length, 10)
  })
})

describe('spec_run', () => {
  const seedRunnable = async (root, tasks, subagents) => {
    const m = mount(root, { subagentProvider: 'spawn' }, { subagents })
    await m.call('spec_init', { goal: 'g', feature: 'rn' })
    await m.call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' })
    await m.call('spec_write', {
      file: 'tasks',
      content: `## Task Dependency Graph\n\n\`\`\`json\n{"waves":[{"id":0,"tasks":["1.1","1.2"]}]}\n\`\`\`\n\n## Tasks\n\n${tasks}`,
    })
    return m
  }

  // 第 9 期 T7 的**端到端**断言。计划层「一任务一 wave」只是把串行**推断**出来；真正的风险是
  // 「并发子代理同时改同一批文件」，那只在派发那一刻发生 —— 所以这里直接量并发度。
  it('无图 ⇒ 实测严格串行（并发峰值 1）；声明的 wave 内仍 >1', async () => {
    const instrument = () => {
      let inFlight = 0
      let peak = 0
      const subagents = fakeSubagents(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }
      })
      return { subagents, peak: () => peak }
    }
    const mountWith = async (feature, graphBlock, tasks) => {
      const inst = instrument()
      const root = project()
      const m = mount(root, { subagentProvider: 'spawn' }, { subagents: inst.subagents })
      await m.call('spec_init', { goal: 'g', feature })
      await m.call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' })
      await m.call('spec_write', { file: 'tasks', content: `${graphBlock}\n\n## Tasks\n\n${tasks}` })
      return { m, peak: inst.peak }
    }

    // 对照组先行：声明的 wave 内两任务**应当**并发。没有它，下面的「峰值 1」可能只是
    // 观测手段看不见并发 —— 那种恒真断言比没有断言更糟。
    const ctl = await mountWith(
      'ctl',
      '## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1.1","1.2"]}]}\n```',
      '- [ ] 1.1 a\n- [ ] 1.2 b\n',
    )
    await ctl.m.call('spec_run', {})
    assert.ok(ctl.peak() > 1, `对照组应当观测到并发，实测峰值 ${ctl.peak()} —— 观测手段本身失效了`)

    // 被测：无图 ⇒ 峰值必须是 1，且输出要说清为什么是串行、怎么拿到并发。
    const ng = await mountWith('ng', '', '- [ ] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n')
    const out = await ng.m.call('spec_run', {})
    assert.match(out.rendered, /严格串行/, '必须说明为什么串行、以及怎么拿到并发')
    assert.equal(ng.peak(), 1, `无图必须实测串行，实测并发峰值 ${ng.peak()}`)
  })

  it('dryRun neither dispatches nor mutates (invariant 7)', async () => {
    const root = project()
    const subagents = fakeSubagents(OK)
    const m = await seedRunnable(root, '- [ ] 1.1 a\n- [ ] 1.2 b\n', subagents)
    const before = readFile(root, '.kiro/specs/rn/tasks.md')
    const out = (await m.call('spec_run', { dryRun: true })).rendered

    assert.match(out, /Wave plan/)
    assert.equal(subagents.calls.length, 0)
    assert.equal(readFile(root, '.kiro/specs/rn/tasks.md'), before)
  })

  it('marks successes done and reverts failures to pending', async () => {
    const root = project()
    const subagents = fakeSubagents((request) =>
      request.label === 'spec task 1.2' ? Promise.reject(new Error('child exploded')) : OK())
    const m = await seedRunnable(root, '- [ ] 1.1 a\n- [ ] 1.2 b\n', subagents)
    const out = (await m.call('spec_run', {})).rendered

    const md = readFile(root, '.kiro/specs/rn/tasks.md')
    assert.match(md, /- \[x\] 1\.1 a/)
    assert.match(md, /- \[ \] 1\.2 b/)
    assert.doesNotMatch(md, /- \[-\]/)
    assert.match(out, /1 done, 1 failed/)
  })

  it('F10 — surfaces a task-state write failure instead of swallowing it', async () => {
    const root = project()
    const subagents = fakeSubagents(OK)
    const m = await seedRunnable(root, '- [ ] 1.1 a\n- [ ] 1.2 b\n', subagents)
    // Break the state writer for one id: the child will still run and succeed,
    // but marking it must not vanish without a trace.
    const realWrite = m.ctx.fs.writeText.bind(m.ctx.fs)
    m.ctx.fs.writeText = async (target, content, ...rest) => {
      if (String(content).includes('[x] 1.1') && !String(content).includes('[x] 1.2')) {
        throw new Error('disk on fire')
      }
      return realWrite(target, content, ...rest)
    }
    const out = (await m.call('spec_run', {})).rendered
    assert.match(out, /task-state write\(s\) failed/)
    assert.match(out, /disk on fire/)
  })

  it('F12 — reverts the wave to pending when the run aborts abnormally', async () => {
    const root = project()
    // Two distinct abort shapes, both must leave no task in [-]:
    //   (a) start() throws SYNCHRONOUSLY -> runBatched rejects -> the runner's
    //       catch/finally reverts the wave and rethrows;
    //   (b) start() returns a REJECTED promise -> Promise.allSettled absorbs it
    //       and the task is reported failed and reverted individually.
    // This test pins (a); the "marks successes done and reverts failures" test
    // covers (b).
    const subagents = {
      calls: [],
      start() {
        throw new Error('provider exploded')
      },
    }
    const m = await seedRunnable(root, '- [ ] 1.1 a\n- [ ] 1.2 b\n', subagents)
    await assert.rejects(() => m.call('spec_run', {}), /provider exploded/)

    const md = readFile(root, '.kiro/specs/rn/tasks.md')
    assert.doesNotMatch(md, /- \[-\]/, 'no task may be left in-progress')
    assert.match(md, /- \[ \] 1\.1 a/)
    assert.match(md, /- \[ \] 1\.2 b/)
  })

  it('F12 — an async-rejecting provider also leaves no task in-progress', async () => {
    const root = project()
    const subagents = fakeSubagents(() => Promise.reject(new Error('boom')))
    const m = await seedRunnable(root, '- [ ] 1.1 a\n- [ ] 1.2 b\n', subagents)
    const out = (await m.call('spec_run', {})).rendered
    assert.match(out, /0 done, 2 failed/)
    assert.doesNotMatch(readFile(root, '.kiro/specs/rn/tasks.md'), /- \[-\]/)
  })

  it('runs waves serially and each wave exactly once', async () => {
    const root = project()
    const order = []
    const subagents = fakeSubagents((request) => {
      order.push(request.label)
      return OK()
    })
    const m = mount(root, { subagentProvider: 'spawn' }, { subagents })
    await m.call('spec_init', { goal: 'g', feature: 'rn2' })
    await m.call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' })
    await m.call('spec_write', {
      file: 'tasks',
      content:
        '## Task Dependency Graph\n\n```json\n' +
        '{"waves":[{"id":0,"tasks":["1.1"]},{"id":1,"tasks":["1.2"]}]}\n' +
        '```\n\n## Tasks\n- [ ] 1.1 first\n- [ ] 1.2 second\n',
    })
    const out = (await m.call('spec_run', {})).rendered

    assert.deepEqual(order, ['spec task 1.1', 'spec task 1.2'])
    assert.match(out, /2 done, 0 failed/)
    const md = readFile(root, '.kiro/specs/rn2/tasks.md')
    assert.match(md, /- \[x\] 1\.1 first/)
    assert.match(md, /- \[x\] 1\.2 second/)
  })

  it('refuses to run without a configured provider', async () => {
    const root = project()
    const m = mount(root, {}, { subagents: fakeSubagents(OK) })
    await m.call('spec_init', { goal: 'g', feature: 'np' })
    await m.call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' })
    await m.call('spec_write', { file: 'tasks', content: '# Implementation Plan\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1.1"]}]}\n```\n\n## Tasks\n- [ ] 1.1 a\n' })
    await assert.rejects(() => m.call('spec_run', {}), /requires config\.subagentProvider/)
  })

  it('respects a single-wave selection out of range', async () => {
    const root = project()
    const m = await seedRunnable(root, '- [ ] 1.1 a\n- [ ] 1.2 b\n', fakeSubagents(OK))
    await assert.rejects(() => m.call('spec_run', { wave: 9 }), /out of range/)
  })
})

describe('/spec command', () => {
  it('F16 — refuses a traversing file argument', async () => {
    const root = project()
    const { commands, exec } = mount(root)
    const out = await commands.get('spec').handler({ rawInput: 'view somefeature ../../../etc/hosts', ...exec })
    assert.equal(out.kind, 'error')
    assert.match(out.text, /invalid spec file/)
  })

  it('F16 — refuses to read /etc/passwd via an absolute-ish argument', async () => {
    const root = project()
    mkdirSync(join(root, '.kiro/specs/x'), { recursive: true })
    writeFileSync(join(root, '.kiro/specs/x/requirements.md'), '# Requirements Document\n')
    const { commands, exec } = mount(root)
    const out = await commands.get('spec').handler({ rawInput: 'view x ../../../../../../etc/passwd', ...exec })
    assert.equal(out.kind, 'error')
  })

  it('still views an allowed file', async () => {
    const root = project()
    const { commands, exec, call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'vw' })
    const out = await commands.get('spec').handler({ rawInput: 'view vw requirements', ...exec })
    assert.equal(out.kind, 'success')
    assert.match(out.text, /# Requirements Document/)
  })

  it('accepts a trailing .md on the file argument', async () => {
    const root = project()
    const { commands, exec, call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'vw2' })
    const out = await commands.get('spec').handler({ rawInput: 'view vw2 requirements.md', ...exec })
    assert.equal(out.kind, 'success')
  })

  it('F16 follow-up — "meta" is rejected honestly, not mapped to meta.md', async () => {
    // `meta` is whitelisted nowhere because the real file is tasks.meta.json;
    // advertising it and then reading `meta.md` produced a misleading
    // "meta.md not found".
    const root = project()
    const { commands, exec, call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'vw3' })
    const out = await commands.get('spec').handler({ rawInput: 'view vw3 meta', ...exec })
    assert.equal(out.kind, 'error')
    assert.match(out.text, /invalid spec file/)
    assert.doesNotMatch(out.text, /meta\.md not found/)
  })
})

describe('F27 — legacy spec migration', () => {
  it('actually copies requirements.md (the original loop forgot the extension)', async () => {
    const root = project()
    // A pre-Kiro legacy single spec living at <root>/.spec/
    mkdirSync(join(root, '.spec'), { recursive: true })
    writeFileSync(join(root, '.spec/requirements.md'), '# Requirements Document\n\nlegacy body\n')

    const { call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'mig' })

    assert.match(readFile(root, '.kiro/specs/mig/requirements.md'), /legacy body/)
  })

  it('migrates a legacy spec that only has design.md', async () => {
    const root = project()
    mkdirSync(join(root, '.spec'), { recursive: true })
    writeFileSync(join(root, '.spec/design.md'), '# Design Document\n\nlegacy design\n')

    const { call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'mig2' })
    assert.match(readFile(root, '.kiro/specs/mig2/design.md'), /legacy design/)
  })

  it('does not clobber a file already present in the feature dir', async () => {
    const root = project()
    mkdirSync(join(root, '.spec'), { recursive: true })
    writeFileSync(join(root, '.spec/requirements.md'), 'LEGACY')
    mkdirSync(join(root, '.kiro/specs/mig3'), { recursive: true })
    writeFileSync(join(root, '.kiro/specs/mig3/requirements.md'), 'CURRENT')

    const { call } = mount(root)
    await call('spec_init', { goal: 'g', feature: 'mig3' })
    assert.equal(readFile(root, '.kiro/specs/mig3/requirements.md'), 'CURRENT')
  })
})

describe('mount surface', () => {
  it('registers every documented tool and injects the workflow section', () => {
    const { tools, sections } = mount(project())
    for (const name of [
      'spec_init',
      'spec_write',
      'spec_read',
      'spec_status',
      'spec_task_set',
      'spec_meta',
      'spec_run',
      'spec_diagnostics',
    ]) {
      assert.ok(tools.has(name), `missing tool ${name}`)
    }
    assert.ok(sections.some((s) => s.name === 'spec:workflow'))
  })
})
