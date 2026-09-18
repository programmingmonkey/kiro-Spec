// F28 · 写侧工具的显式 `spec`（第 4 期 Task 7）。
//
// F28 的现场事故（review 原文）：`_active` 是**单一可变指针**，并发会话一改，
// `spec_task_set` 就把状态写到了**别人的** `tasks.md` 上 ——「当时幸免只因 id 不重合」。
// 也就是说，那次没出事靠的是运气，不是机制。
//
// 修法是给写侧五个工具加可选 `spec`，解析顺序保持既有约定：
// 显式参数 → `_active` → 唯一目录 → 报错（Req 7.5）。
//
// 🔴 判别力最强的那条是**反向**的：传了 `spec` 之后，无论 `_active` 怎么变，目标都不许跟着变。
// 只测「传 spec 能定位」是恒真陷阱 —— 一个「先记住 spec 再被 `_active` 覆盖」的实现也能通过。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { cleanup, makeProject, mount } from './harness.mjs'

const roots = []
after(() => roots.forEach(cleanup))

const TASKS = (firstState = ' ', secondState = ' ') => [
  '# Implementation Plan',
  '',
  '## Tasks',
  '',
  `- [${firstState}] 1. First`,
  '  - _Requirements: 1.1_',
  '',
  `- [${secondState}] 2. Second`,
  '  - _Requirements: 2.1_',
  '',
].join('\n')

function seedSpec(root, name, tasks) {
  const dir = join(root, '.kiro', 'specs', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'requirements.md'), '# Requirements Document\n\n## Introduction\n\n## Requirements\n')
  writeFileSync(join(dir, 'design.md'), '# Design Document\n\n## Architecture\n')
  writeFileSync(join(dir, 'tasks.md'), tasks)
  return dir
}

const setActive = (root, name) => writeFileSync(join(root, '.kiro', 'specs', '_active'), name)

describe('F28 · 写侧工具的显式 `spec`（Task 7 Step 1/2）', () => {
  it('五个写侧工具都接受可选 `spec`，且都不是必填', () => {
    const { tools } = mount('/tmp')
    for (const name of ['spec_write', 'spec_read', 'spec_status', 'spec_task_set', 'spec_meta']) {
      const def = tools.get(name)
      assert.ok(def, `${name} 没注册`)
      const props = def.parameters?.properties ?? {}
      assert.ok('spec' in props, `${name} 没有 spec 参数`)
      const required = def.parameters?.required ?? []
      assert.ok(!required.includes('spec'), `${name} 把 spec 设成了必填 —— 既有调用会当场失败`)
    }
  })

  it('🔴 反向（Step 3）：传了 spec 之后，改 `_active` 不影响目标', async () => {
    const root = makeProject()
    roots.push(root)
    const alpha = seedSpec(root, 'alpha', TASKS())
    const beta = seedSpec(root, 'beta', TASKS())
    setActive(root, 'alpha')
    const { call } = mount(root)

    // `_active` 指向 alpha，但显式要求写 beta。
    await call('spec_task_set', { spec: 'beta', index: '1', state: 'done' })
    assert.match(readFileSync(join(beta, 'tasks.md'), 'utf8'), /- \[x\] 1\. First/, 'beta 没被写到')
    assert.match(readFileSync(join(alpha, 'tasks.md'), 'utf8'), /- \[ \] 1\. First/, 'alpha 被误写了 —— 显式 spec 没生效')

    // 现在把 `_active` 翻到 beta，再显式要求写 alpha 的**另一个**任务。
    setActive(root, 'beta')
    await call('spec_task_set', { spec: 'alpha', index: '2', state: 'done' })

    const alphaAfter = readFileSync(join(alpha, 'tasks.md'), 'utf8')
    const betaAfter = readFileSync(join(beta, 'tasks.md'), 'utf8')
    assert.match(alphaAfter, /- \[x\] 2\. Second/, 'alpha 的第二个任务没被写到')
    assert.match(betaAfter, /- \[ \] 2\. Second/, 'beta 被误写了 —— 目标跟着 `_active` 跑了')
    assert.match(betaAfter, /- \[x\] 1\. First/, 'beta 先前的写入被覆盖了')
  })

  it('不传 spec 时 `_active` 仍然生效（既有约定没被改掉）', async () => {
    const root = makeProject()
    roots.push(root)
    seedSpec(root, 'alpha', TASKS())
    const beta = seedSpec(root, 'beta', TASKS())
    setActive(root, 'beta')
    const { call } = mount(root)

    await call('spec_task_set', { index: '1', state: 'done' })
    assert.match(readFileSync(join(beta, 'tasks.md'), 'utf8'), /- \[x\] 1\. First/)
  })

  it('spec_read 的显式 spec 决定它读哪一份，而不是 `_active` 指的那份', async () => {
    const root = makeProject()
    roots.push(root)
    seedSpec(root, 'alpha', TASKS(' ', 'x'))
    seedSpec(root, 'beta', TASKS('x', ' '))
    setActive(root, 'alpha')
    const { call } = mount(root)

    assert.equal((await call('spec_read', { spec: 'alpha', file: 'tasks' })).content, TASKS(' ', 'x'))
    assert.equal((await call('spec_read', { spec: 'beta', file: 'tasks' })).content, TASKS('x', ' '))
  })

  it('spec_status 报的是显式 spec 的阶段，不是 `_active` 指的', async () => {
    const root = makeProject()
    roots.push(root)
    // alpha 三件套齐全且任务全完成（complete）；beta 只有 requirements（阶段 requirements）。
    seedSpec(root, 'alpha', TASKS('x', 'x'))
    const betaDir = join(root, '.kiro', 'specs', 'beta')
    mkdirSync(betaDir, { recursive: true })
    writeFileSync(join(betaDir, 'requirements.md'), '# Requirements Document\n\n## Introduction\n\n## Requirements\n')
    setActive(root, 'alpha')
    const { call } = mount(root)

    assert.equal((await call('spec_status', { spec: 'alpha' })).phase, 'complete')
    assert.equal((await call('spec_status', { spec: 'beta' })).phase, 'requirements')
  })

  it('传一个不存在的 spec 名时报错，不静默回落到 `_active`', async () => {
    const root = makeProject()
    roots.push(root)
    seedSpec(root, 'alpha', TASKS())
    setActive(root, 'alpha')
    const { call } = mount(root)

    await assert.rejects(
      () => call('spec_task_set', { spec: 'ghost', index: '1', state: 'done' }),
      /ghost/,
      '显式给了一个不存在的 spec，却静默写到了 `_active` 指的那份上',
    )
  })

  it('spec_write 写进显式 spec 的目录', async () => {
    const root = makeProject()
    roots.push(root)
    seedSpec(root, 'alpha', TASKS())
    const beta = seedSpec(root, 'beta', TASKS())
    setActive(root, 'alpha')
    const { call } = mount(root)

    await call('spec_write', { spec: 'beta', file: 'tasks', content: TASKS('x', 'x') })
    assert.match(readFileSync(join(beta, 'tasks.md'), 'utf8'), /- \[x\] 1\. First/)
  })

  it('spec_meta 把执行历史记进显式 spec 的 tasks.meta.json', async () => {
    const root = makeProject()
    roots.push(root)
    const alpha = seedSpec(root, 'alpha', TASKS())
    const beta = seedSpec(root, 'beta', TASKS())
    setActive(root, 'alpha')
    const { call } = mount(root)

    await call('spec_meta', { spec: 'beta', action: 'record', task: '1. First', executionId: 'exec-1' })
    assert.match(readFileSync(join(beta, 'tasks.meta.json'), 'utf8'), /exec-1/)
    assert.throws(
      () => readFileSync(join(alpha, 'tasks.meta.json'), 'utf8'),
      /ENOENT/,
      'spec_meta 按 `_active` 而不是显式 spec 落了盘',
    )
  })
})
