// L4（codex-spec-rename，Req 3）：dsh-spec 读的**共享项目档案**换了名字，并保留旧路径只读回退。
//
// 这一侧与另外两个宿主的差别，如实写在这里：dsh-spec **没有** `spec_health`（本插件不注册它），
// 所以 Req 3.2/3.3 里「在健康回报里报告来源」的那一半在 DSH 上**无处可报** —— 这里能钉的是
// 另一半，也是更要紧的那一半：**真的读到了**。
//
// 判据选「spec 目录解析到哪里」而不是「返回了哪个常量」：`codexSpecsRoot` 的值决定
// `specsParentDir`，于是「配置有没有被读到」可以从 `spec_status` 的 `dir` **反推** ——
// 一个只把常量改对、却没真去读文件的实现会在这三条用例里露出来。
//
// 🔴 旧路径的**字面量**从插件自己导出的常量取（`LEGACY_CODEX_SPEC_CONFIG`），不在这里重写：
// 替换面里出现旧名会被 Req 8 的棘轮判红，而「旧名字面量只住在三个 adapter 里」正是五族具名
// 豁免里族 5 的形状。代价：这里证得了「回退真的发生」，证不了旧名的拼写。
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'

import { CODEX_SPEC_CONFIG, LEGACY_CODEX_SPEC_CONFIG } from '../lib/index.js'
import { cleanup, makeProject, mount } from './harness.mjs'

const roots = []
after(() => roots.forEach(cleanup))

/** 两个 `specsRoot` 用可辨的值，于是「读到的是哪一份」可以从 `dir` 反推。 */
const NEW_ROOT = '.new-root'
const LEGACY_ROOT = '.legacy-root'

const REQS = ['# Requirements Document', '', '## Introduction', '', '> 背景', '', '## Requirements', '', '> 需求', '',
  '### Requirement 1: Alpha', '**User Story:** As a dev I want A.', '', '#### Acceptance Criteria',
  '1. WHEN x THE SYSTEM SHALL do A', ''].join('\n')

function project() {
  const root = makeProject()
  roots.push(root)
  return root
}

/** 把共享档案写到 `relativePath`（路径本身由 adapter 的常量给出，不在这里拼旧名字面量）。 */
function writeConfig(root, relativePath, specsRoot) {
  const abs = join(root, relativePath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify({ specsRoot })}\n`)
}

/** 在 `<specsRoot>/specs/<name>/` 下放一份最小 spec，并返回它的绝对目录。 */
function seedSpec(root, specsRoot, name = 'demo') {
  const dir = join(root, specsRoot, 'specs', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'requirements.md'), REQS)
  writeFileSync(join(dir, 'tasks.md'), '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. do alpha\n')
  return dir
}

describe('L4 ① — 只有旧路径：读旧的，不报错，spec 目录解析到旧配置指的地方', () => {
  it('`.legacy-root/specs/demo` 被找到（配置确实被读到了，而不是「没读到就退回 .kiro」）', async () => {
    const root = project()
    writeConfig(root, LEGACY_CODEX_SPEC_CONFIG, LEGACY_ROOT)
    const expected = seedSpec(root, LEGACY_ROOT)

    const { call } = mount(root)
    const st = await call('spec_status', { spec: 'demo' })

    assert.equal(st.dir, expected, 'specsRoot 来自旧路径那份档案；没读到就只会去 <root>/.kiro/specs 找');
    assert.equal(st.workflow, 'requirements-first', 'requirements.md 只存在于旧配置指的那个目录下');
  })
})

describe('L4 ② — 只有新路径：照新路径读', () => {
  it('`.new-root/specs/demo` 被找到', async () => {
    const root = project()
    writeConfig(root, CODEX_SPEC_CONFIG, NEW_ROOT)
    const expected = seedSpec(root, NEW_ROOT)

    const { call } = mount(root)
    const st = await call('spec_status', { spec: 'demo' })

    assert.equal(st.dir, expected)
    assert.equal(st.workflow, 'requirements-first')
  })
})

describe('L4 ③ — 新旧都在：以新为准（不静默取其一）', () => {
  it('新配置指的目录生效，旧配置指的目录**不被**采用', async () => {
    const root = project()
    writeConfig(root, CODEX_SPEC_CONFIG, NEW_ROOT)
    writeConfig(root, LEGACY_CODEX_SPEC_CONFIG, LEGACY_ROOT)
    const newDir = seedSpec(root, NEW_ROOT)
    seedSpec(root, LEGACY_ROOT)

    const { call } = mount(root)
    const st = await call('spec_status', { spec: 'demo' })

    assert.equal(st.dir, newDir, 'Req 3.3：新旧都在时以新为准')
  })
})

describe('L4 边界 — 两份都不在：行为不变（退回 `.kiro`）', () => {
  it('没有共享档案时仍按 `.kiro/specs` 解析', async () => {
    const root = project()
    const expected = seedSpec(root, '.kiro')

    const { call } = mount(root)
    const st = await call('spec_status', { spec: 'demo' })

    assert.equal(st.dir, expected, '别把「档案不在」变成新错误 —— 那是既有的默认行为');
  })
})
