// Tests for the five capability tools (spec task 5.2, part 3) and the write
// boundaries they enforce.
//
// These drive the REAL registered tools over a real temp directory, so what is
// exercised is the same code path the harness runs — not the lib modules in
// isolation (those have their own unit coverage).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { cleanup, makeProject, mount } from './harness.mjs'

const roots = []
const project = () => {
  const root = makeProject()
  roots.push(root)
  return root
}
after(() => roots.forEach(cleanup))

function snapshot(dir) {
  const out = {}
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) walk(full, rel)
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(dir, '')
  return out
}

const REQS = [
  '# Requirements Document', '', '## Introduction', '', '> 背景', '', '## Glossary', '', '> 术语', '',
  '## Requirements', '', '> 需求', '',
  '### Requirement 1: Alpha', '**User Story:** As a dev I want A.', '',
  '#### Acceptance Criteria', '1. WHEN x THE SYSTEM SHALL do A', '',
  '### Requirement 2: Beta', '**User Story:** As a dev I want B.', '',
  '#### Acceptance Criteria', '1. 系统应当合理地尽快完成适当的工作', '',
].join('\n') + '\n'

const TASKS = [
  '# Implementation Plan', '', '## Overview', '', '> 概述', '',
  '## Task Dependency Graph', '', '```json', '{ "waves": [ { "id": 0, "tasks": ["1.1"] } ] }', '```', '',
  '## Tasks', '', '> 任务', '', '- [ ] 1. parent', '  - [ ] 1.1 do alpha', '    - _Requirements: 1.1_', '',
  '## Notes', '', '',
].join('\n')

// Build a spec directory directly on disk (faster than driving spec_write for
// every test) with exactly the artifacts a case needs. `requirements: null` or
// `tasks: null` OMITS that file — a `undefined` value would trigger the
// parameter defaults above instead of omitting anything.
function seed(root, { requirements = REQS, tasks = TASKS, design } = {}) {
  const dir = join(root, '.kiro', 'specs', 'demo')
  mkdirSync(dir, { recursive: true })
  if (requirements !== null) writeFileSync(join(dir, 'requirements.md'), requirements)
  if (tasks !== null) writeFileSync(join(dir, 'tasks.md'), tasks)
  if (design !== undefined) writeFileSync(join(dir, 'design.md'), design)
  return dir
}

// 静态只读守卫（`${mod}.js has no executable write call`）随那五个模块一起搬到了
// `packages/spec-analysis/test/read-only-static.test.mjs` —— 它是本期唯一一条
// 「可整体搬」的断言（`fixtures/assertion-map.json`）。断言名逐字保留，
// 所以改造前后的测试名集合 A ⊆ B 仍然成立（记录见本期 spec 的 `## Notes`）。

describe('spec_checklist — requirements quality, read-only', () => {
  it('reports findings with anchors and leaves the directory byte-identical', async () => {
    const root = project()
    const dir = seed(root)
    const before = snapshot(dir)
    const { call } = mount(root)
    const out = await call('spec_checklist')

    // Requirement 2 is deliberately untestable, so all three content rules fire.
    assert.equal(out.report.counts.error, 0)
    assert.ok(out.report.counts.warning >= 3, out.rendered)
    const ids = out.report.findings.map((f) => f.ruleId)
    assert.ok(ids.includes('checklist/no-ears-keyword'), out.rendered)
    assert.ok(ids.includes('checklist/vague-quantifier'), out.rendered)
    assert.ok(ids.includes('checklist/unreferenced-requirement'), out.rendered)
    // Every dimension carries a locatable anchor (Req 4.4).
    for (const f of out.report.findings) assert.ok(f.anchor, `no anchor on ${f.ruleId}`)
    assert.deepEqual(snapshot(dir), before, 'checklist must not write')
  })

  it('separates Kiro verdicts from repo conventions', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_checklist')
    const byRule = Object.fromEntries(out.report.findings.map((f) => [f.ruleId, f]))
    // A missing criteria block is Kiro's own error level; the EARS/vague checks
    // are this repo's taste and must never masquerade as Kiro (Req 4.6).
    assert.equal(byRule['checklist/no-ears-keyword'].source, 'repo-convention')
    assert.equal(byRule['checklist/vague-quantifier'].source, 'repo-convention')
  })

  it('records a missing artifact instead of throwing', async () => {
    const root = project()
    seed(root, { requirements: null, tasks: null })
    const { call } = mount(root)
    const out = await call('spec_checklist')
    assert.ok(out.report.missingFiles.length > 0, out.rendered)
  })

  it('can inspect an existing but completely EMPTY spec directory', async () => {
    // Req 4.7 / Req 5: a missing artifact is recorded and the run continues.
    // Requiring an artifact to exist before resolving the directory made this
    // impossible — you could not run a checklist on a spec that had not written
    // requirements.md yet, which is exactly when the checklist is most useful.
    //
    // 🔴 2026-09-14 订正（`.kiro/specs/acceptance-net-firing` 的 Expected 2.5）：
    // 原断言 `drift.report.entries.length === 0` 钉的是**旧输出形状** —— 那时"零条目"
    // 与"查过且没有漂移"逐字同形。本 spec 刻意改掉这个形状：不适用时返回 `applicable:false`
    // 且**不再**给出 `entries`（空数组会被读成"零漂移"）。
    // 「缺什么文件照样报」这条**意图**原样保留，见下面两条 missingFiles 断言。
    const root = project()
    mkdirSync(join(root, '.kiro', 'specs', 'empty'), { recursive: true })
    const { call } = mount(root)
    const checklist = await call('spec_checklist', { spec: 'empty' })
    assert.ok(checklist.report.missingFiles.length > 0, checklist.rendered)
    assert.equal(checklist.report.applicable, false)
    assert.equal(checklist.report.reason, 'NO_REQUIREMENTS_FILE')
    const drift = await call('spec_drift', { spec: 'empty' })
    assert.equal(drift.report.applicable, false, drift.rendered)
    assert.equal(drift.report.reason, 'NO_REQUIREMENTS_FILE')
    assert.equal(drift.report.entries, undefined, '不适用时不该给出 entries —— 空数组会被读成"零漂移"')
    assert.ok(drift.report.missingFiles.length > 0, drift.rendered)
  })
})

describe('spec_drift — read-only, with mandatory evidence strength', () => {
  it('never writes and always states its evidence strength (Req 5.2, 5.4)', async () => {
    const root = project()
    const dir = seed(root)
    const before = snapshot(dir)
    const { call } = mount(root)
    const out = await call('spec_drift')
    assert.ok(out.report.entries.length >= 2, out.rendered)
    for (const e of out.report.entries) {
      assert.equal(e.evidence, 'weak', 'file-level evidence is unobtainable in this corpus')
      assert.ok(e.recommendation, 'both escape routes must be offered (Req 5.3)')
    }
    assert.deepEqual(snapshot(dir), before, 'drift must not write')
  })

  it('offers BOTH ways forward, and gates the amendment route on landed code', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_drift')
    for (const e of out.report.entries) {
      assert.match(e.recommendation, /demo-v2/, 'route 1: a fresh spec')
      assert.match(e.recommendation, /already landed|append-amendment/i, 'route 2: amendment channel')
    }
  })

  it('suppresses severity for a frozen spec (Req 5.5)', async () => {
    // "Frozen" means EVERY task line is [x] — including the grouping parent,
    // which is itself a task line. The boundary case is all-done, not typical.
    const frozenTasks = TASKS
      .replace('- [ ] 1. parent', '- [x] 1. parent')
      .replace('- [ ] 1.1 do alpha', '- [x] 1.1 do alpha')
    const frozenRoot = project()
    seed(frozenRoot, { tasks: frozenTasks })
    const frozen = await mount(frozenRoot).call('spec_drift')
    assert.equal(frozen.report.frozen, true)

    const unfrozenRoot = project()
    seed(unfrozenRoot)
    const unfrozen = await mount(unfrozenRoot).call('spec_drift')
    assert.equal(unfrozen.report.frozen, false)

    // Compare the SAME requirement across the two specs: the frozen edition's
    // severity must be strictly lower for every entry it reports.
    const rank = { error: 0, warning: 1, info: 2, hint: 3 }
    const byReq = (r) => Object.fromEntries(r.report.entries.map((e) => [e.requirement, e]))
    const f = byReq(frozen)
    const u = byReq(unfrozen)
    assert.ok(Object.keys(f).length > 0, frozen.rendered)
    for (const req of Object.keys(f)) {
      assert.ok(u[req], `requirement ${req} missing from the unfrozen report`)
      assert.ok(
        rank[f[req].severity] > rank[u[req].severity],
        `frozen ${req} severity ${f[req].severity} must be strictly lower than unfrozen ${u[req].severity}`,
      )
    }
  })
})

describe('spec_sign — attribution, warn-only, per spec directory', () => {
  it('a design.md change is satisfied by a signature in tasks.md (Req 3.2)', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    await call('spec_sign', { summary: 'design.md：补 Req 2 判据' })
    const check = await call('spec_sign', { action: 'check', changedFiles: 'design.md' })
    assert.equal(check.report.ok, true)
    assert.equal(check.report.finding, null)
  })

  it('warns without blocking when unsigned', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_sign', { action: 'check', changedFiles: 'design.md' })
    assert.equal(out.report.ok, false)
    assert.equal(out.report.finding.severity, 'warning')
    assert.equal(out.report.finding.source, 'repo-convention')
  })

  it('writes the documented format with the middle-dot separator', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    const out = await call('spec_sign', { summary: '补点什么' })
    assert.match(out.line, /^- \d{4}-\d{2}-\d{2} · DSH · 补点什么$/)
    assert.match(readFileSync(join(dir, 'tasks.md'), 'utf8'), /^- \d{4}-\d{2}-\d{2} · DSH · 补点什么$/m)
  })

  it('is idempotent — signing twice does not duplicate the line', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    await call('spec_sign', { summary: 'same' })
    await call('spec_sign', { summary: 'same' })
    const hits = readFileSync(join(dir, 'tasks.md'), 'utf8').split('\n').filter((l) => l.includes('· DSH · same'))
    assert.equal(hits.length, 1)
  })

  it('rejects an unknown environment rather than inventing one', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    await assert.rejects(() => call('spec_sign', { summary: 'x', env: 'Windows' }), /unknown env/i)
  })
})

describe('spec_amend — incremental correction channel', () => {
  it('edits a parameter IN PLACE, not by appending prose (Req 6.1)', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    await call('spec_amend', { kind: 'param', file: 'requirements', from: 'As a dev I want A.', to: 'As a dev I want A2.' })
    const text = readFileSync(join(dir, 'requirements.md'), 'utf8')
    assert.ok(text.includes('As a dev I want A2.'))
    assert.ok(!text.includes('As a dev I want A.'))
    // In place: the file grew by exactly the one character the replacement added
    // (A. → A2.), so nothing was appended at the end.
    assert.equal(text.length, REQS.length + 1)
  })

  it('continues requirement numbering past the existing maximum (Req 6.2)', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    await call('spec_amend', {
      kind: 'requirement',
      title: 'Gamma',
      body: '**User Story:** As a dev I want C.\n\n#### Acceptance Criteria\n1. WHEN z THE SYSTEM SHALL do C',
    })
    const text = readFileSync(join(dir, 'requirements.md'), 'utf8')
    assert.match(text, /^### Requirement 3: Gamma$/m, 'numbering must continue 2 → 3')
    // Existing requirements keep their numbers and content verbatim.
    assert.match(text, /^### Requirement 1: Alpha$/m)
    assert.match(text, /^### Requirement 2: Beta$/m)
    assert.ok(text.startsWith(REQS), 'the original document must remain an exact prefix')
  })

  it('writes `## Amendments` with the repo sub-title and an in-place pointer (Req 6.3)', async () => {
    const root = project()
    const dir = seed(root, { design: '# Design Document\n\n## Overview\n\n> o\n\n## Data Models\n\n> d\n' })
    const { call } = mount(root)
    await call('spec_amend', {
      kind: 'design',
      heading: '2026-09-11 · DSH · 补数据模型',
      body: '新增 Gamma 字段。',
      anchor: '> d',
      pointer: '> 修正：见 ## Amendments',
    })
    const text = readFileSync(join(dir, 'design.md'), 'utf8')
    assert.match(text, /^## Amendments$/m)
    assert.match(text, /^> 补充修正$/m)
    // The pointer follows the anchor line, and the anchor is untouched.
    const lines = text.split('\n')
    const at = lines.indexOf('> d')
    assert.equal(lines[at + 1], '> 修正：见 ## Amendments')
  })

  it('names `anchor` (not `pointer.text`) when a design amendment omits the pointer target', async () => {
    const root = project()
    seed(root, { design: '# Design Document\n\n## Overview\n\n> o\n' })
    const { call } = mount(root)
    // Req 6.3 wants a pointer at the amended original position, so the anchor is
    // genuinely required — but reporting the omission as "pointer.text" made a
    // correct refusal look like a tool bug.
    await assert.rejects(
      () => call('spec_amend', { kind: 'design', heading: 'H', body: 'B' }),
      /requires `anchor`/,
    )
  })

  it('REFUSES to touch a task body, naming the three machine consequences (Req 6.4)', async () => {
    const root = project()
    const dir = seed(root)
    const before = snapshot(dir)
    const { call } = mount(root)
    await assert.rejects(
      () => call('spec_amend', { kind: 'param', file: 'tasks', from: 'parent', to: 'renamed' }),
      (e) => {
        assert.match(e.message, /task body/i)
        // All three consequences must be spelled out, not just "refused".
        assert.match(e.message, /waves/i)
        assert.match(e.message, /executionHistory/i)
        assert.match(e.message, /FIRST|first/i)
        return true
      },
    )
    assert.deepEqual(snapshot(dir), before, 'a refused amendment must write nothing')
  })

  it('leaves the checkbox lines and waves JSON byte-identical after any writer', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    const bodyOf = (t) => t.split('\n').filter((l) => /^\s*-\s*\[/.test(l) || /waves/.test(l)).join('\n')
    const before = bodyOf(readFileSync(join(dir, 'tasks.md'), 'utf8'))
    await call('spec_amend', {
      kind: 'requirement',
      title: 'Gamma',
      body: '#### Acceptance Criteria\n1. WHEN z THE SYSTEM SHALL do C',
    })
    await call('spec_sign', { summary: 'amended' })
    assert.equal(bodyOf(readFileSync(join(dir, 'tasks.md'), 'utf8')), before)
  })
})

describe('spec_archive — move whole dir, refuse to clobber (Req 6.5)', () => {
  it('moves the directory and removes the source', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    await call('spec_archive')
    assert.ok(!existsSync(dir), 'source must be gone after a real move')
    assert.ok(existsSync(join(root, '.kiro/specs/_archive/demo/requirements.md')))
    assert.ok(existsSync(join(root, '.kiro/specs/_archive/demo/tasks.md')))
  })

  it('refuses when the archive name exists and changes nothing', async () => {
    const root = project()
    const dir = seed(root)
    const existing = join(root, '.kiro/specs/_archive/demo')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'SENTINEL.md'), 'do not touch')
    const before = snapshot(existing)
    const sourceBefore = snapshot(dir)

    const { call } = mount(root)
    await assert.rejects(() => call('spec_archive'), /already exists/i)

    assert.deepEqual(snapshot(existing), before, 'the existing archive must be untouched')
    assert.deepEqual(snapshot(dir), sourceBefore, 'the source spec must be untouched')
    assert.equal(readFileSync(join(existing, 'SENTINEL.md'), 'utf8'), 'do not touch')
  })

  it('refuses a spec already under _archive/', async () => {
    const root = project()
    seed(root)
    // The archived copy has to EXIST: an explicit `spec` path is now resolved against
    // the project root (not cwd) and reported as not-found when absent, so a
    // non-existent path would satisfy /archive/i by accident.
    mkdirSync(join(root, '.kiro/specs/_archive/demo'), { recursive: true })
    writeFileSync(join(root, '.kiro/specs/_archive/demo/SENTINEL.md'), 'archived')
    const { call } = mount(root)
    // Point the tool at an archived spec explicitly.
    await assert.rejects(
      () => call('spec_archive', { spec: '.kiro/specs/_archive/demo' }),
      /already under _archive/i,
    )
  })
})

describe('the new tools resolve a spec without an _active pointer (Req 7.5)', () => {
  it('finds the sole spec directory', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_checklist')
    assert.match(out.rendered, /demo/)
  })

  it('errors clearly instead of guessing when several specs exist', async () => {
    const root = project()
    seed(root)
    const other = join(root, '.kiro', 'specs', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'requirements.md'), '# Requirements Document\n')
    const { call } = mount(root)
    await assert.rejects(() => call('spec_checklist'), /No active spec|holds 2 specs/i)
  })

  it('resolves an explicitly named spec among many', async () => {
    const root = project()
    seed(root)
    const other = join(root, '.kiro', 'specs', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'requirements.md'), '# Requirements Document\n\n## Introduction\n\n## Requirements\n')
    const { call } = mount(root)
    const out = await call('spec_checklist', { spec: 'other' })
    assert.match(out.rendered, /other/)
  })
})
