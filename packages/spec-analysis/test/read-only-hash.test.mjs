// 只读性的**包级契约**（Requirement 4.1 / 4.2；Task 0.2 的处置）。
//
// 旧套件里这条断言是有的，三处：`capabilities.test.mjs` 的
// 「reports findings with anchors and leaves the directory byte-identical」与
// 「never writes and always states its evidence strength」、以及
// `regression-live-fire.test.mjs` 的「3.7 the read-only tools still write nothing」。
// ⚠️ 这里**点名测试而不是行号** —— 行号在搬移/新增断言之后就烂了（初版引的是 93/149，
// HEAD 上那两行已经是别的 `it`；本轮 review 抓到过）。
// Task 0.2 把它**提升成包级契约**：不是「dsh-spec 的工具层没写」，而是「这三个入口在
// 任何 port 下都不写」。差别在于被测对象从工具壳换成了模块本身。
//
// 旧套件到不了这条路径：它在旧套件里必须经过 `mount()` + `call('spec_*')`，也就是断言的是
// 「插件的工具没写」；模块被单独驱动时的只读性从来没有被直接断言过。而本期换的正是模块的
// 注入来源（插件的 ctx.fs → port 契约），所以这一层值得自己钉。
//
// ⚠️ 与 `freeze.test.mjs` 的 `port.writes === 0` 不重复：那条证明「没有调 writeText」，
// 这条证明「目录逐文件 sha256 相同」—— 它还能抓到绕过 port 的直接写入。两条都留。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { runChecklist } from '../lib/checklist.js'
import { runDrift } from '../lib/drift.js'
import { checkAttribution } from '../lib/signature.js'
import { fsPort, hashTree, portThatSecretlyWrites } from './tools/fs-port.mjs'

const roots = []
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-analysis-readonly-'))
  roots.push(root)
  return root
}
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })))

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
  '1. 系统应当合理地尽快完成适当的工作',
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

/** 在真实磁盘上种一份 spec，返回它的目录。 */
function seed(root) {
  const dir = join(root, '.kiro', 'specs', 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'requirements.md'), REQS)
  writeFileSync(join(dir, 'tasks.md'), TASKS)
  writeFileSync(join(dir, 'design.md'), '# Design Document\n\n## Overview\n\n> 概述\n\n正文。\n')
  writeFileSync(join(dir, 'notes-extra.md'), '# 附注\n\n- 2026-09-12 · DSH · 附注里的署名\n')
  return dir
}

describe('Requirement 4.1 — 三个只读入口跑前跑后目录逐文件 sha256 相同', () => {
  it('runChecklist：目录 hash 不变', async () => {
    const dir = seed(makeRoot())
    const before = hashTree(join(dir, '..', '..'))
    const report = await runChecklist({ port: fsPort(), specDir: dir })
    assert.ok(report.findings.length > 0, '语料应当能报出 finding，否则这条断言在空跑')
    assert.deepEqual(hashTree(join(dir, '..', '..')), before, 'checklist 改动了 spec 目录')
  })

  it('runDrift：目录 hash 不变', async () => {
    const dir = seed(makeRoot())
    const before = hashTree(join(dir, '..', '..'))
    const report = await runDrift({ port: fsPort(), specDir: dir })
    assert.equal(report.entries.length, 2, '语料应当有 2 条需求，否则这条断言在空跑')
    assert.deepEqual(hashTree(join(dir, '..', '..')), before, 'drift 改动了 spec 目录')
  })

  it('checkAttribution：目录 hash 不变（用了 changedFiles，走的是「要判未署名」那条路）', async () => {
    const dir = seed(makeRoot())
    const before = hashTree(join(dir, '..', '..'))
    const report = await checkAttribution({ port: fsPort(), dir, changedFiles: ['requirements.md'] })
    assert.equal(report.ok, true)
    assert.equal(report.signatures.length, 2, '两个文件各一条署名')
    assert.deepEqual(hashTree(join(dir, '..', '..')), before, 'checkAttribution 改动了 spec 目录')
  })

  it('三个入口连着跑，目录仍然一个字节没动', async () => {
    const dir = seed(makeRoot())
    const specs = join(dir, '..', '..')
    const before = hashTree(specs)
    const port = fsPort()
    await runChecklist({ port, specDir: dir })
    await runDrift({ port, specDir: dir })
    await checkAttribution({ port, dir, changedFiles: ['design.md'] })
    assert.deepEqual(hashTree(specs), before)
  })
})

describe('Requirement 4.2 — 这条断言不是恒真的（注入一次写入就必须红）', () => {
  it('把 port 换成「每次写都偷偷落一份」的变体后，hash 断言确实会失败', async () => {
    const dir = seed(makeRoot())
    const specs = join(dir, '..', '..')
    const before = hashTree(specs)
    const sneaky = portThatSecretlyWrites(fsPort(), dir)
    // `appendSignature` 是这三个模块里唯一会写的入口；用它触发那个偷偷写入。
    const { appendSignature } = await import('../lib/signature.js')
    await appendSignature({ port: sneaky, dir, summary: '故意写一次', env: 'DSH', date: '2026-09-12' })
    assert.notDeepEqual(hashTree(specs), before, '注入的写入没有被 hash 断言看见 —— 那条断言是恒真的')
  })

  it('对照组：同一次调用走正常 port 时，hash 只因为那次**有意的**签名而变化（且变化可解释）', async () => {
    const dir = seed(makeRoot())
    const specs = join(dir, '..', '..')
    const before = hashTree(specs)
    const { appendSignature } = await import('../lib/signature.js')
    await appendSignature({ port: fsPort(), dir, summary: '有意签名', env: 'DSH', date: '2026-09-12' })
    const after = hashTree(specs)
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k])
    // hashTree 的键是相对 specs 根的路径，所以带一层目录名。
    assert.deepEqual(changed, ['specs/demo/tasks.md'], '署名只该动 tasks.md')
  })
})
