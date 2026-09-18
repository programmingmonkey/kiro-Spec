// dsh-spec 的 dual-hash 接入（第 4 期 Task 5）。
//
// 🔴 **红测先行**：本文件在「加依赖 + 接线」之前必须红 —— 首行 import
// `@my-harness/spec-revision` 会因为 dsh-spec 未声明该依赖而 ERR_MODULE_NOT_FOUND。
// 这不是形式：dsh-spec 到 2026-09-13 为止**完全没有** dual-hash（零实现、零版本守卫）。
//
// 为什么 dsh 侧需要它 —— 把 F11「已有修」这件事看清楚：
// review 表记的是 ✅ 已修，但修法是「删掉子代理自标状态的指令，状态由 runner 独占」，
// 也就是**把并发写者拿掉**（流程约定），而不是**让并发写安全**（机制）。
// `setTaskState` 至今仍是「读整文件 → 改一个字符 → 整文件回写，无锁无版本守卫」。
// **约定挡不住第二个会话** —— 这正是本期给 dsh-spec 上 dual-hash 的理由。
//
// 本期**只做**「能判断语义有没有变」；CAS / stateEpoch 留给第 7 期（spec-state 本来就要
// 处理状态与并发）。加 CAS 会改变所有写工具的调用契约，影响面远大于本期的抽包。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { computeApprovalFingerprint, computeRawRevision } from '@my-harness/spec-revision'

import { cleanup, makeProject, mount } from './harness.mjs'

const roots = []
after(() => roots.forEach(cleanup))

/** dsh 的策略：**真机四字符类**（含 `~`）。这是 declared-diffs 里 A1/A2 两条声明分歧的 dsh 侧。 */
const DSH_STRICT = false

const fp = (markdown) =>
  computeApprovalFingerprint({ artifact: 'tasks', markdown, strictTaskState: DSH_STRICT })

const TASKS = [
  '# Implementation Plan',
  '',
  '## Tasks',
  '',
  '- [ ] 1. First task',
  '  - _Requirements: 1.1_',
  '',
  '- [ ] 1.1 A leaf under one',
  '  - _Requirements: 1.2_',
  '',
  '- [ ] 2. Second task',
  '  - _Requirements: 2.1_',
  '',
  '## Task Dependency Graph',
  '',
  '```json',
  '{ "waves": [{ "id": 0, "tasks": ["1.1"] }, { "id": 1, "tasks": ["2"] }] }',
  '```',
  '',
].join('\n')

describe('dsh 策略下的两个哈希（纯函数层）', () => {
  it('[ ] → [x] 改 rawRevision，但不改 approvalFingerprint', () => {
    const done = TASKS.replace('- [ ] 1. First task', '- [x] 1. First task')
    assert.notEqual(computeRawRevision(TASKS), computeRawRevision(done))
    assert.equal(fp(TASKS), fp(done))
  })

  it('改任务标题：两者都改', () => {
    const retitled = TASKS.replace('First task', 'Renamed task')
    assert.notEqual(computeRawRevision(TASKS), computeRawRevision(retitled))
    assert.notEqual(fp(TASKS), fp(retitled))
  })

  it('🔴 dsh 与 kiro 在 `[~]` 行上确实分道扬镳（A1/A2 两条声明分歧仍在册）', () => {
    const tilde = TASKS.replace('- [ ] 1. First task', '- [~] 1. First task')
    assert.notEqual(
      computeApprovalFingerprint({ artifact: 'tasks', markdown: tilde, strictTaskState: false }),
      computeApprovalFingerprint({ artifact: 'tasks', markdown: tilde, strictTaskState: true }),
      '两个策略在 [~] 上算出同一个指纹 —— 声明分歧被抹平了',
    )
  })
})

describe('接入：写工具的返回值带 dual-hash（Task 5 Step 3）', () => {
  const withSpec = () => {
    const root = makeProject()
    roots.push(root)
    const dir = join(root, '.kiro', 'specs', 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'requirements.md'), '# Requirements Document\n\n## Introduction\n\n## Requirements\n')
    writeFileSync(join(dir, 'design.md'), '# Design Document\n\n## Architecture\n\n## Data Flow\n')
    writeFileSync(join(dir, 'tasks.md'), TASKS)
    return { root, dir, ...mount(root) }
  }

  it('spec_task_set 只更新 rawRevision，approvalFingerprint 保持不变', async () => {
    const { dir, call } = withSpec()
    const before = readFileSync(join(dir, 'tasks.md'), 'utf8')
    const result = await call('spec_task_set', { index: '1', state: 'done' })
    const after = readFileSync(join(dir, 'tasks.md'), 'utf8')

    assert.notEqual(computeRawRevision(before), computeRawRevision(after), '原始字节必须变')
    assert.equal(result.rawRevision, computeRawRevision(after), '返回值要带上写后的 rawRevision')
    assert.equal(result.approvalFingerprint, fp(after), '返回值要带上写后的 approvalFingerprint')
    assert.equal(
      result.approvalFingerprint,
      fp(before),
      '勾选一个 checkbox 不该改变审批指纹 —— 改了就是审批被静默作废',
    )
  })

  it('spec_write 报告语义到底有没有变', async () => {
    const { call } = withSpec()
    const retitled = TASKS.replace('First task', 'Renamed task')
    const result = await call('spec_write', { file: 'tasks', content: retitled })
    assert.equal(result.semanticChanged, true, '改了任务标题却报告语义没变')
    assert.equal(result.rawRevision, computeRawRevision(retitled))
    assert.equal(result.approvalFingerprint, fp(retitled))
  })

  it('spec_write 覆盖成「只有 checkbox 不同」的内容时，语义没变要报出来', async () => {
    const { call } = withSpec()
    const done = TASKS.replace('- [ ] 1. First task', '- [x] 1. First task')
    const result = await call('spec_write', { file: 'tasks', content: done })
    assert.equal(result.semanticChanged, false, '只有 checkbox 状态不同，却报告语义变了')
    assert.equal(result.previousApprovalFingerprint, fp(TASKS))
  })

  it('首次写入没有可比对的旧内容，semanticChanged 是 null 而不是谎报 false', async () => {
    const root = makeProject()
    roots.push(root)
    const dir = join(root, '.kiro', 'specs', 'fresh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'requirements.md'), '# Requirements Document\n\n## Introduction\n\n## Requirements\n')
    writeFileSync(join(dir, 'design.md'), '# Design Document\n\n## Architecture\n\n## Data Flow\n')
    const { call } = mount(root)
    const result = await call('spec_write', { file: 'tasks', content: TASKS })
    assert.equal(result.semanticChanged, null, '没有旧内容可比时，不许把「不知道」报成 false')
    assert.equal(result.previousApprovalFingerprint, null)
  })

  it('🔴 R4-8 的绊线：调用点漏传 strictTaskState 会被这条抓到', async () => {
    // 🔴 这条 fixture 的**形状**是必须的，不是随手写的 —— 第一版写错了，把教训记下来：
    //
    // 第一版直接把待 toggle 的那一条写成 `[~]`，然后断言 after === before。**抓不到漏传。**
    // 原因：`[x]` 在两种策略下都合法（strict 集是 `[ x-]`），所以 after 侧**永远**是 task token，
    // 不会因为漏传而退化；会退化成 text token 的是 `[~]`，而它已经被 toggle 掉了、只在 before 出现。
    // 实测四个指纹（审查者受控变异所得，我复核）：
    //   before([~], strict=true ) = 60384672e2f2…
    //   before([~], strict=false) = cd93b6fe7c40…
    //   after ([x], strict=true ) = cd93b6fe7c40…
    //   after ([x], strict=false) = cd93b6fe7c40…
    // → fp(before,false) 恰好等于 fp(after,true)，断言照样成立 —— **一条恒真的绊线**。
    //
    // 正确的形状：**保留一条不被 toggle 的 `[~]` 行**，让策略差异在 after 侧也看得见。
    //   non-strict：那一行始终是 task token（且 state 不入 token）→ after === before ✅
    //   strict    ：那一行是 text token（整行文本），与 before 的 task token 形态不同 → after ≠ before 🔴
    const root = makeProject()
    roots.push(root)
    const dir = join(root, '.kiro', 'specs', 'tilde')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'requirements.md'), '# Requirements Document\n\n## Introduction\n\n## Requirements\n')
    writeFileSync(join(dir, 'design.md'), '# Design Document\n\n## Architecture\n\n## Data Flow\n')
    writeFileSync(join(dir, 'tasks.md'), [
      '# Implementation Plan', '', '## Tasks', '',
      '- [~] 1. Tilde task',
      '  - _Requirements: 1.1_',
      '',
      '- [ ] 2. Second task',
      '  - _Requirements: 2.1_',
      '',
    ].join('\n'))
    const { call } = mount(root)

    // toggle 的是 2，不是 1：让 `[~]` 行同时留在 before 与 after 里。
    const result = await call('spec_task_set', { index: '2', state: 'done' })
    assert.equal(
      result.approvalFingerprint,
      result.previousApprovalFingerprint,
      'dsh 侧把 `[~]` 行按 strict 处理了 —— 某个调用点漏传了 strictTaskState: false，'
      + '这正是 R4-8 说的「审批被静默作废」形态',
    )
  })
})
