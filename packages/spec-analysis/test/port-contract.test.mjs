// Task 2.4 —— port 契约：用**内存 port** 跑通五个模块。
//
// 覆盖旧套件到不了的路径：旧套件里五个模块**只**经 `mount()` + `call('spec_*')` 被驱动
// （`fixtures/assertion-map.json` 的 45 条全是 not-movable），所以「同一个模块换一个 port
// 还成不成立」这件事从来没被问过。本期换的正是 port 的来源（插件的 ctx.fs → 包级契约），
// 所以这条路径值得直接钉住。
//
// 母计划把「`move` 缺失时逐文件复制且不删源」写成了散文，本期把它变成断言
// （Requirement 1.5）。同时反向钉住：有 `move` 时必须真的搬走 —— 否则「不删源」那一条
// 可能只是因为两边行为一样而通过。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { memoryPort, omitMove, snapshotTree } from './tools/memory-port.mjs'
import { MODULES, modulePath } from './tools/locate-modules.mjs'

const M = {}
for (const mod of MODULES) M[mod] = await import(modulePath(mod))

const SPEC = '/proj/.kiro/specs/demo'

const REQS = [
  '# Requirements Document',
  '',
  '## Requirements',
  '',
  '### Requirement 1: Alpha',
  '**User Story:** As a dev I want A.',
  '',
  '#### Acceptance Criteria',
  '1. WHEN x THE SYSTEM SHALL do A',
  '',
  '### Requirement 2: Beta',
  '**User Story:** As a dev I want B.',
  '',
  '#### Acceptance Criteria',
  '1. WHEN y THE SYSTEM SHALL do B',
  '',
].join('\n')

const TASKS = [
  '# Implementation Plan',
  '',
  '## Overview',
  '',
  '> 概述',
  '',
  '## Task Dependency Graph',
  '',
  '```json',
  '{"waves":[{"id":0,"tasks":["1.1"]}]}',
  '```',
  '',
  '## Tasks',
  '',
  '- [ ] 1.1 do alpha',
  '  - _Requirements: 1_',
  '',
  '## Notes',
  '',
  '- 2026-09-12 · DSH · 语料',
  '',
].join('\n')

const DESIGN = ['# Design Document', '', '## Overview', '', '> 概述', '', '第一段。', ''].join('\n')

const tree = () => ({
  [`${SPEC}/requirements.md`]: REQS,
  [`${SPEC}/tasks.md`]: TASKS,
  [`${SPEC}/design.md`]: DESIGN,
  '/proj/.kiro/specs/legacy/tasks.md': TASKS,
})

describe('Task 2.4 — 五个模块在内存 port 上跑通', () => {
  it('checklist 与 drift 只读，且报告非空', async () => {
    const port = memoryPort(tree())
    const before = snapshotTree(port)
    const report = await M.checklist.runChecklist({ port, specDir: SPEC })
    const drift = await M.drift.runDrift({ port, specDir: SPEC })
    assert.equal(report.missingFiles.length, 0, '语料齐备时不该有缺失文件')
    // 语料里 requirement 2 没被任何任务引用 —— 这正是 checklist 唯一该报的那一条。
    // 断言「恰好是它」而不是「一条都没有」：后者在语料被改动后会静默变味。
    assert.deepEqual(report.findings.map((f) => f.ruleId), ['checklist/unreferenced-requirement'])
    assert.equal(report.counts.passed, 1)
    assert.equal(drift.entries.length, 2)
    assert.deepEqual(snapshotTree(port), before, '只读模块改动了内存树')
    assert.equal(port.writes, 0)
  })

  it('checkAttribution 认得出签名，且警告只在真的没签时出现', async () => {
    const signed = await M.signature.checkAttribution({ port: memoryPort(tree()), dir: SPEC, changedFiles: ['design.md'] })
    assert.equal(signed.ok, true)
    assert.equal(signed.signatures.length, 1)

    const unsigned = await M.signature.checkAttribution({
      port: memoryPort({ [`${SPEC}/tasks.md`]: TASKS.replace(/^- 2026.*$/m, '') }),
      dir: SPEC,
      changedFiles: ['design.md'],
    })
    assert.equal(unsigned.ok, false)
    assert.equal(unsigned.finding.ruleId, 'repo/spec-unsigned')

    // 没有改动文件时「无所指」而不是「已签」——这是 live-fire 的 :004 契约。
    const nothing = await M.signature.checkAttribution({ port: memoryPort(tree()), dir: SPEC, changedFiles: [] })
    assert.equal(nothing.ok, true)
    assert.equal(nothing.applicable, false)
  })

  it('appendSignature 写入一次，且幂等（第二次不再追加）', async () => {
    const port = memoryPort(tree())
    const first = await M.signature.appendSignature({ port, dir: SPEC, summary: '第一次', env: 'DSH', date: '2026-09-12' })
    const afterFirst = port.files.get(`${SPEC}/tasks.md`)
    const second = await M.signature.appendSignature({ port, dir: SPEC, summary: '第一次', env: 'DSH', date: '2026-09-12' })
    assert.equal(first, second)
    assert.equal(port.files.get(`${SPEC}/tasks.md`), afterFirst, '重复署名不该改文件')
    assert.equal(port.writes, 1)
  })

  it('applyParamEdit 就地替换，且不改 checkbox 行', async () => {
    const port = memoryPort(tree())
    const out = await M.amendments.applyParamEdit({
      port,
      dir: SPEC,
      file: 'requirements',
      from: 'As a dev I want A.',
      to: 'As a dev I want A, revised.',
    })
    assert.ok(out.path.endsWith('requirements.md'))
    assert.match(port.files.get(`${SPEC}/requirements.md`), /revised\./)
    assert.equal(port.files.get(`${SPEC}/tasks.md`), TASKS, 'tasks.md 不该被这次调用碰过')
  })
})

describe('Task 2.4 — port.move 缺失时的降级（Requirement 1.5，母计划只写成散文）', () => {
  it('有 move：源被移走，目标出现，sourceRemoved=true', async () => {
    const port = memoryPort(tree())
    const report = await M.archive.archiveSpec({
      port,
      specDir: '/proj/.kiro/specs/legacy',
      archiveRoot: '/proj/.kiro/specs/_archive',
    })
    assert.equal(report.sourceRemoved, true)
    assert.equal(report.filesCopied, 0)
    assert.equal(report.archiveRootVia, 'mkdir')
    assert.equal(await port.exists('/proj/.kiro/specs/legacy'), false, '源目录应当已经不在了')
    assert.ok(await port.exists('/proj/.kiro/specs/_archive/legacy/tasks.md'))
  })

  it('缺 move：逐文件复制、**不删源**、在报告里说清楚要宿主自己删', async () => {
    const port = omitMove(memoryPort(tree()))
    const report = await M.archive.archiveSpec({
      port,
      specDir: '/proj/.kiro/specs/legacy',
      archiveRoot: '/proj/.kiro/specs/_archive',
    })
    assert.equal(report.sourceRemoved, false)
    assert.equal(report.filesCopied, 1)
    assert.match(report.note, /was NOT removed/)
    assert.match(report.note, /must delete the source directory itself/)
    // 「不删源」不能只看字段：文件必须真的还在，且复制品也对。
    assert.equal(await port.readText('/proj/.kiro/specs/legacy/tasks.md'), TASKS)
    assert.equal(await port.readText('/proj/.kiro/specs/_archive/legacy/tasks.md'), TASKS)
  })

  it('两种 port 下目标内容一致（降级只影响「源删不删」，不影响搬过去的字节）', async () => {
    const a = memoryPort(tree())
    await M.archive.archiveSpec({ port: a, specDir: '/proj/.kiro/specs/legacy', archiveRoot: '/proj/.kiro/specs/_archive' })
    const b = omitMove(memoryPort(tree()))
    await M.archive.archiveSpec({ port: b, specDir: '/proj/.kiro/specs/legacy', archiveRoot: '/proj/.kiro/specs/_archive' })
    assert.equal(a.files.get('/proj/.kiro/specs/_archive/legacy/tasks.md'), b.files.get('/proj/.kiro/specs/_archive/legacy/tasks.md'))
  })

  // 第 9 期 T3 —— `.config.kiro` 必须跟着 spec 一起归档。
  //
  // 它是真机写在 spec 目录里的类型元数据（`research/15` §3），盘上实测 `_archive/` 下
  // 9 例都带着它。归档漏掉它不会报错，只会让被归档的 spec **丢掉类型信息** —— 而归档后的
  // spec 正是最没人再看一遍的那一类。
  //
  // 两条 port 路径都钉，因为风险只在其中一条上：有 `move` 时是整目录 rename，点文件天然
  // 跟着走；缺 `move` 时走 `copyTree`，逐个 `listDir` + `readText`/`writeText` ——
  // 只有那条路上「点文件会不会被 listDir 过滤掉」才是个真问题。
  it('归档带上 .config.kiro（点文件不得丢），两条 port 路径都成立', async () => {
    const CONFIG =
      '{"specId": "f0dd330a-2bb2-45eb-80c4-0355e147f8da", "workflowType": "requirements-first", "specType": "bugfix"}'
    const withConfig = () => ({ ...tree(), '/proj/.kiro/specs/legacy/.config.kiro': CONFIG })
    for (const [label, port] of [
      ['有 move', memoryPort(withConfig())],
      ['缺 move（逐文件复制）', omitMove(memoryPort(withConfig()))],
    ]) {
      const report = await M.archive.archiveSpec({
        port,
        specDir: '/proj/.kiro/specs/legacy',
        archiveRoot: '/proj/.kiro/specs/_archive',
      })
      assert.equal(
        await port.readText('/proj/.kiro/specs/_archive/legacy/.config.kiro'),
        CONFIG,
        `${label}：归档后 .config.kiro 丢失或内容不一致`,
      )
      // 顺带钉住「两个文件都搬了」，否则上面那条可能是靠 `filesCopied` 少算而通过的。
      assert.ok(report.filesCopied === 0 || report.filesCopied === 2, `${label}: filesCopied=${report.filesCopied}`)
    }
  })

  it('archiveConflict 是纯查询：目标已存在时报冲突，且什么都不改', async () => {
    const port = memoryPort(tree(), { dirs: ['/proj/.kiro/specs/_archive/legacy'] })
    const before = snapshotTree(port)
    assert.equal(await M.archive.archiveConflict({ port, specDir: '/proj/.kiro/specs/legacy', archiveRoot: '/proj/.kiro/specs/_archive' }), true)
    assert.deepEqual(snapshotTree(port), before)
    const empty = memoryPort(tree())
    assert.equal(await M.archive.archiveConflict({ port: empty, specDir: '/proj/.kiro/specs/legacy', archiveRoot: '/proj/.kiro/specs/_archive' }), false)
  })

  it('冲突时 archiveSpec 拒绝，且逐字节什么都没发生', async () => {
    const port = memoryPort(tree(), { dirs: ['/proj/.kiro/specs/_archive/legacy'] })
    const before = snapshotTree(port)
    await assert.rejects(
      () => M.archive.archiveSpec({ port, specDir: '/proj/.kiro/specs/legacy', archiveRoot: '/proj/.kiro/specs/_archive' }),
      /already exists/,
    )
    assert.deepEqual(snapshotTree(port), before)
  })
})

describe('Task 2.4 — port 缺方法必须 loud（Requirement 1.4）', () => {
  it('archive 在缺 readText 时点名方法，不回落直连文件', async () => {
    await assert.rejects(
      () => M.archive.archiveSpec({ port: { listDir: async () => [], exists: async () => false }, specDir: '/a/b', archiveRoot: '/a/_archive' }),
      /port\.readText is required/,
    )
  })

  it('amendments 在缺 writeTextIfUnchanged 时点名方法（读得到、写不了）', async () => {
    // 🔴 2026-09-14（第 7 期 §9 欠账 ⑤）：读-改-写的入口卡的是 `writeTextIfUnchanged`，
    // 不再是 `writeText`。这条区别是**有意的**：普通 `writeText` 写得进去，但写的是
    // 「基于 T0 算出来、落在 T1 上」的内容 —— 那正是要消灭的静默覆盖。
    // 契约把它做成**必填**，缺它就在这里当场报错，而不是在某次并发里悄悄丢一份改动。
    const port = memoryPort(tree())
    delete port.writeTextIfUnchanged
    await assert.rejects(
      () => M.amendments.applyParamEdit({ port, dir: SPEC, file: 'requirements', from: '背景', to: '背景（改）' }),
      /port\.writeTextIfUnchanged is required/,
    )
  })

  it('checklist 在 port 完全没有 readText 时报错里带方法名（TypeError 也是 loud）', async () => {
    await assert.rejects(() => M.checklist.runChecklist({ port: {}, specDir: SPEC }), /readText/)
    await assert.rejects(() => M.drift.runDrift({ port: {}, specDir: SPEC }), /readText/)
  })

  it('checkAttribution 的既有契约是 never-throw，但它必须把读不到的**报出来**', async () => {
    // 这一条是 Requirement 1.4 的边界：它不抛（契约如此），所以「坏 port」不能是静默降级
    // —— report.missingFiles 必须逐份点名，调用方一眼能看出「什么都没读到」。
    const report = await M.signature.checkAttribution({ port: {}, dir: SPEC, changedFiles: ['design.md'] })
    assert.equal(report.ok, false, '什么都没读到却报 ok:true 就是静默降级')
    assert.equal(report.missingFiles.length, 4, '四个规范 artifact 都该被点名')
    assert.match(report.finding.ruleId, /spec-unsigned/)
  })
})
