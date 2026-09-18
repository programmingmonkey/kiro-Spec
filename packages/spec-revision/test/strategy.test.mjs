// `spec-revision` 的策略契约与包的形状。
//
// 这个文件存在的唯一理由：**证明 `strictTaskState` 真的是入参，而不是写死的策略**。
// 计划 R4-8 记的后果是实打实的 —— 若共享包把 strict 写死，dsh 侧的 approvalFingerprint
// 会对 `[~]` 行判错，而那是审批指纹：审批被静默作废或静默保留，两个方向都难查。
//
// 所以这里的断言不是「函数能跑」，而是「换一个策略必须换一个结果」。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { computeApprovalFingerprint, computeRawRevision } from '../lib/revision.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

/** `[~]` 是两策略分道扬镳的那一行：真机四字符类含它，kiro 2026-09-08 的收紧不含它。 */
const TILDE_TASKS = [
  '# Implementation Plan',
  '',
  '## Tasks',
  '',
  '- [~] 1. A tilde task',
  '  - _Requirements: 1.1_',
  '',
].join('\n')

const fp = (markdown, strictTaskState) =>
  computeApprovalFingerprint(strictTaskState === undefined
    ? { artifact: 'tasks', markdown }
    : { artifact: 'tasks', markdown, strictTaskState })

describe('strictTaskState 是入参，不是写死的策略（Req: A1 / A2 声明分歧）', () => {
  it('🔴 换策略必须换结果 —— 写死策略时这条会红', () => {
    assert.notEqual(
      fp(TILDE_TASKS, true),
      fp(TILDE_TASKS, false),
      '`[~]` 行在两个策略下算出了同一个指纹：说明 strictTaskState 被忽略了',
    )
  })

  it('默认值是 true（codex-spec / claude-spec 的历史契约）', () => {
    assert.equal(fp(TILDE_TASKS), fp(TILDE_TASKS, true))
  })

  it('显式传 false 才是真机四字符类那一侧（dsh-spec 的契约）', () => {
    assert.notEqual(fp(TILDE_TASKS), fp(TILDE_TASKS, false))
  })

  it('策略只影响 tasks artifact —— requirements / design 不吃这个开关', () => {
    const req = '# Requirements\n\n- [~] 1. A tilde requirement\n'
    assert.equal(
      computeApprovalFingerprint({ artifact: 'requirements', markdown: req, strictTaskState: true }),
      computeApprovalFingerprint({ artifact: 'requirements', markdown: req, strictTaskState: false }),
    )
  })
})

describe('两个哈希的语义（第 3 期沿用，本节只做回归保护）', () => {
  const base = '# Plan\n\n## Tasks\n\n- [ ] 1. Task one\n  - _Requirements: 1.1_\n'

  it('rawRevision 对任意字节变化敏感', () => {
    assert.notEqual(computeRawRevision(base), computeRawRevision(base.replace('[ ]', '[x]')))
    assert.notEqual(computeRawRevision(base), computeRawRevision(`${base}\n`))
    assert.notEqual(computeRawRevision(base.replace(/\n/g, '\r\n')), computeRawRevision(base))
  })

  it('approvalFingerprint 对合法 checkbox 变化不敏感', () => {
    assert.equal(fp(base, true), fp(base.replace('[ ]', '[x]'), true))
  })

  it('approvalFingerprint 对标题变化敏感', () => {
    assert.notEqual(fp(base, true), fp(base.replace('Task one', 'Task renamed'), true))
  })
})

describe('包的形状：纯函数、零 I/O、依赖单向', () => {
  const SOURCE = readFileSync(join(PACKAGE_ROOT, 'lib', 'revision.mjs'), 'utf8')
  const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

  it('不 import node:fs / node:path（纯函数层，不碰文件系统）', () => {
    assert.equal(/from\s+['"]node:fs/.test(SOURCE), false)
    assert.equal(/from\s+['"]node:path/.test(SOURCE), false)
  })

  it('依赖方向是 spec-revision → spec-parser，没有反向', () => {
    assert.ok(MANIFEST.dependencies['@my-harness/spec-parser'], '必须声明 spec-parser')
    assert.match(SOURCE, /@my-harness\/spec-parser/)
    // 反向：共享解析层不该认得 revision
    const parser = readFileSync(join(PACKAGE_ROOT, '..', 'spec-parser', 'lib', 'task-format.js'), 'utf8')
    assert.equal(/spec-revision/.test(parser), false)
  })
})
