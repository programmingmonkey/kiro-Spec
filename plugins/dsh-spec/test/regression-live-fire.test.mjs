// Regression locks for the 2026-09-11 live-fire review (spec
// `dsh-spec-live-fire-fixes`, Properties 1–7).
//
// Every defect these lock was INVISIBLE to the rest of this suite, and for one
// shared reason: the suite calls the pure lib modules directly, while the real
// failure mode lives one layer up — in what `execute()` RETURNS. That layer is
// where DSH applies its lossless-JSON contract and where the session's project
// root (not `process.cwd()`) is the path basis. `test/harness.mjs` now asserts
// the JSON half on every call; this file covers the rest.
//
// Tags `:001`–`:007` map 1:1 onto bugfix.md's Current Behavior list. Each was
// confirmed RED against the pre-fix code.
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
  if (existsSync(dir)) walk(dir, '')
  return out
}

const REQS = [
  '# Requirements Document', '', '## Introduction', '', '> 背景', '', '## Glossary', '', '> 术语', '',
  '## Requirements', '', '> 需求', '',
  '### Requirement 1: Alpha', '**User Story:** As a dev I want A.', '',
  '#### Acceptance Criteria', '1. WHEN x THE SYSTEM SHALL do A', '',
].join('\n') + '\n'

const TASKS = [
  '# Implementation Plan', '', '## Overview', '', '> 概述', '',
  '## Task Dependency Graph', '', '```json', '{ "waves": [ { "id": 0, "tasks": ["1.1"] } ] }', '```', '',
  '## Tasks', '', '> 任务', '', '- [ ] 1. parent', '  - [ ] 1.1 do alpha', '    - _Requirements: 1.1_', '',
  '## Notes', '', '',
].join('\n')

function seed(root, name = 'demo', { requirements = REQS, tasks = TASKS } = {}) {
  const dir = join(root, '.kiro', 'specs', name)
  mkdirSync(dir, { recursive: true })
  if (requirements !== null) writeFileSync(join(dir, 'requirements.md'), requirements)
  if (tasks !== null) writeFileSync(join(dir, 'tasks.md'), tasks)
  return dir
}

// ---------------------------------------------------------------------------
// Property 1 / :001 — the archive tool result must be lossless JSON
// ---------------------------------------------------------------------------
describe('Property 1 / :001 — a tool result survives a JSON round-trip', () => {
  it(':001 archive report loses no key to JSON.stringify', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_archive', { spec: 'demo' })
    const report = out.result

    // The defect: `note: undefined`. `in` still sees the key, so only a
    // round-trip exposes it — exactly what the runtime rejects on.
    assert.deepEqual(
      Object.keys(report).filter((k) => report[k] === undefined),
      [],
      'no property of a tool result may be undefined',
    )
    assert.deepEqual(
      Object.keys(JSON.parse(JSON.stringify(report))).sort(),
      Object.keys(report).sort(),
      'JSON round-trip must preserve every key',
    )
    assert.ok('note' in report, 'the note key is part of the report contract')
    assert.equal(report.note, null, 'a real move leaves no note, spelled as null not undefined')
  })

  it(':001b the move path is the one that produced the defect', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    await call('spec_archive', { spec: 'demo' })
    assert.ok(!existsSync(dir), 'the port exposes move(), so the real move path ran')
    assert.ok(existsSync(join(root, '.kiro/specs/_archive/demo/requirements.md')))
  })
})

// ---------------------------------------------------------------------------
// Property 2 / :002 — an explicit path resolves against the PROJECT ROOT
// ---------------------------------------------------------------------------
describe('Property 2 / :002 — relative spec paths do not follow process.cwd()', () => {
  it(':002 a relative path resolves inside the project, not the harness cwd', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    // process.cwd() during a test run is the PLUGIN directory, which is a
    // different tree from this temp project — so resolving against cwd could
    // never find this spec.
    assert.notEqual(process.cwd(), root)
    const out = await call('spec_checklist', { spec: '.kiro/specs/demo' })
    assert.ok(
      out.rendered.includes(join(root, '.kiro/specs/demo')),
      `resolved outside the project root:\n${out.rendered}`,
    )
  })

  it(':002b an absolute path inside the project still works', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_checklist', { spec: join(root, '.kiro/specs/demo') })
    assert.ok(out.rendered.includes(join(root, '.kiro/specs/demo')))
  })

  it(':002c a path escaping the specs parent is refused', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    for (const spec of ['../../elsewhere', '/etc', join(root, 'apps')]) {
      await assert.rejects(() => call('spec_checklist', { spec }), /not a spec directory inside/)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 3 / :003 — a missing path is an error, never a clean report
// ---------------------------------------------------------------------------
describe('Property 3 / :003 — "not found" is never rendered as "clean"', () => {
  it(':003 a non-existent path inside the specs parent throws', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    await assert.rejects(
      () => call('spec_checklist', { spec: join(root, '.kiro/specs/ghost') }),
      /not found under/,
    )
  })

  it(':003b the same holds for every other tool that takes a spec', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const ghost = join(root, '.kiro/specs/ghost')
    for (const [tool, args] of [
      ['spec_checklist', { spec: ghost }],
      ['spec_drift', { spec: ghost }],
      ['spec_sign', { spec: ghost, action: 'check' }],
      ['spec_amend', { spec: ghost, kind: 'param' }],
      ['spec_archive', { spec: ghost }],
    ]) {
      await assert.rejects(() => call(tool, args), /not found under/, `${tool} reported a ghost as found`)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 4 / :004 — the signature check has three states, not two
// ---------------------------------------------------------------------------
describe('Property 4 / :004 — "nothing to attribute" is not "signed"', () => {
  it(':004 zero signatures + no changedFiles must not render SIGNED', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_sign', { spec: 'demo', action: 'check' })
    assert.match(out.rendered, /NOT CHECKED/)
    assert.ok(!out.rendered.includes('SIGNED'), `claimed a signature it does not have:\n${out.rendered}`)
    assert.equal(out.report.signatures.length, 0)
    assert.equal(out.report.applicable, false)
  })

  it(':004b unchanged files are UNSIGNED and carry the warning finding', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_sign', { spec: 'demo', action: 'check', changedFiles: 'requirements.md' })
    assert.match(out.rendered, /UNSIGNED/)
    assert.equal(out.report.applicable, true)
    assert.equal(out.report.ok, false)
    assert.equal(out.report.finding.ruleId, 'repo/spec-unsigned')
  })

  it(':004c a real signature still reads SIGNED', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    await call('spec_sign', { spec: 'demo', action: 'sign', summary: 'requirements.md：补 Req 1 的判据' })
    const out = await call('spec_sign', { spec: 'demo', action: 'check', changedFiles: 'requirements.md' })
    assert.match(out.rendered, /SIGNED/)
    assert.equal(out.report.ok, true)
  })
})

// ---------------------------------------------------------------------------
// Property 5 / :005 — a scaffolded spec is signable out of the box
// ---------------------------------------------------------------------------
describe('Property 5 / :005 — the scaffold and the signature channel agree', () => {
  it(':005 spec_init output can be signed without hand-adding ## Notes', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'scaffold signability probe', feature: 'fresh', kind: 'quick' })
    const tasksPath = join(root, '.kiro/specs/fresh/tasks.md')
    assert.match(readFileSync(tasksPath, 'utf8'), /^## Notes$/m, 'the template must ship ## Notes')

    const signed = await call('spec_sign', { spec: 'fresh', action: 'sign', summary: 'tasks.md：初始落实' })
    assert.match(signed.line, /- \d{4}-\d{2}-\d{2} · DSH · tasks\.md：初始落实/)
    assert.match(readFileSync(tasksPath, 'utf8'), /^- \d{4}-\d{2}-\d{2} · DSH · /m)
  })

  it(':005b the added section does not inflate the executable-unit count', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'unit count probe', feature: 'fresh', kind: 'quick' })
    // `spec_status` returns the status object itself (its `render` takes `v`),
    // unlike the tools that wrap their payload in `{ rendered }`.
    const status = await call('spec_status')
    assert.equal(status.units.count, 1, '## Notes must not be counted as an executable unit')
    assert.equal(status.tasks.total, 1, '## Notes must not be counted as a task')
  })
})

// ---------------------------------------------------------------------------
// Property 6 + 7 / :006, :007 — archive bookkeeping
// ---------------------------------------------------------------------------
describe('Property 6 / :006 — archiving the active spec clears the pointer', () => {
  it(':006 a dangling _active pointer is not left behind', async () => {
    const root = project()
    seed(root)
    const activePath = join(root, '.kiro/specs/_active')
    writeFileSync(activePath, 'demo\n')
    const { call } = mount(root)
    await call('spec_archive', { spec: 'demo' })
    assert.equal(
      readFileSync(activePath, 'utf8').trim(),
      '',
      'the pointer still names a spec that is no longer in the active area',
    )
  })

  it(':006b an _active pointer naming something else is left alone', async () => {
    const root = project()
    seed(root)
    seed(root, 'other')
    const activePath = join(root, '.kiro/specs/_active')
    writeFileSync(activePath, 'other\n')
    const { call } = mount(root)
    await call('spec_archive', { spec: 'demo' })
    assert.equal(readFileSync(activePath, 'utf8').trim(), 'other')
  })
})

describe('Property 7 / :007 — the archive report field is the one that is rendered', () => {
  it(':007 the rendered destination equals report.destination', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_archive', { spec: 'demo' })
    assert.equal(out.result.destination, join(root, '.kiro/specs/_archive/demo'))
    assert.ok(out.rendered.includes(out.result.destination), `rendered a different path:\n${out.rendered}`)
  })
})

// ---------------------------------------------------------------------------
// Unchanged Behavior 3.1–3.7
// ---------------------------------------------------------------------------
describe('Unchanged Behavior — the pre-fix outcomes still hold', () => {
  it('3.1 an existing archive is still refused, byte-for-byte nothing changes', async () => {
    const root = project()
    const dir = seed(root)
    const existing = join(root, '.kiro/specs/_archive/demo')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'SENTINEL.md'), 'do not touch')
    const beforeExisting = snapshot(existing)
    const beforeSource = snapshot(dir)

    const { call } = mount(root)
    await assert.rejects(() => call('spec_archive', { spec: 'demo' }), /already exists/i)

    assert.deepEqual(snapshot(existing), beforeExisting)
    assert.deepEqual(snapshot(dir), beforeSource)
  })

  it('3.2 a bare feature name still resolves under the specs parent', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const out = await call('spec_checklist', { spec: 'demo' })
    assert.ok(out.rendered.includes(join(root, '.kiro/specs/demo')))
  })

  it('3.3 an existing but EMPTY spec directory is still inspectable', async () => {
    const root = project()
    seed(root)
    mkdirSync(join(root, '.kiro/specs/hollow'), { recursive: true })
    const { call } = mount(root)
    const out = await call('spec_checklist', { spec: 'hollow' })
    assert.match(out.rendered, /hollow/)
    assert.match(out.rendered, /Missing: .*requirements\.md/)
  })

  it('3.4 spec_init still leaves an existing spec directory byte-identical', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'first init', feature: 'demo', kind: 'quick' })
    await call('spec_meta', { action: 'record', task: '1.1 <task description>' })
    const before = snapshot(join(root, '.kiro/specs/demo'))

    await call('spec_init', { goal: 'second init', feature: 'demo', kind: 'quick' })
    assert.deepEqual(snapshot(join(root, '.kiro/specs/demo')), before, 'a re-init rewrote an existing spec')
  })

  it('3.6 spec_task_set still touches only the checkbox character', async () => {
    const root = project()
    const dir = seed(root)
    const before = readFileSync(join(dir, 'tasks.md'), 'utf8')
    const { call } = mount(root)
    await call('spec_task_set', { index: '1.1', state: 'done' })
    const after = readFileSync(join(dir, 'tasks.md'), 'utf8')
    // 🔴 2026-09-13 · 第 4 期 Task 6（R3）：`1.1` 是本 fixture 里 `1.` 的**唯一**子任务，
    // 它一完成，父任务就满足「同级全 [x]」并被收敛（对齐 Kiro 真机）。所以这是两处
    // checkbox 变化 —— 第 1 期这条「只动 checkbox 字符」的保证仍然成立，只是现在
    // **动的可以是两个**。括号之外的字节依旧逐字不变，那才是这条断言的判别力所在。
    const expected = before
      .replace('- [ ] 1.1 do alpha', '- [x] 1.1 do alpha')
      .replace('- [ ] 1. parent', '- [x] 1. parent')
    assert.equal(after, expected)
  })

  it('3.7 the read-only tools still write nothing', async () => {
    const root = project()
    seed(root)
    const dir = join(root, '.kiro/specs/demo')
    const before = snapshot(dir)
    const { call } = mount(root)
    await call('spec_checklist', { spec: 'demo' })
    await call('spec_drift', { spec: 'demo' })
    await call('spec_sign', { spec: 'demo', action: 'check' })
    await call('spec_diagnostics')
    assert.deepEqual(snapshot(dir), before)
  })
})

// ---------------------------------------------------------------------------
// Found by the adversarial re-read of the P0-2 patch itself: the first
// containment version let the specs PARENT through (only "outside" was
// rejected), and archiving it created `_archive/` before failing on the
// self-nesting rename — a reported failure with a real side effect.
// ---------------------------------------------------------------------------
describe('Review follow-up — the specs parent is a container, not a spec', () => {
  it('refuses the specs parent itself, with no side effect', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    const specsParent = join(root, '.kiro/specs')
    for (const spec of [specsParent, '.kiro/specs', '.kiro/specs/', '.kiro/specs/.', join(specsParent, 'demo', '..')]) {
      await assert.rejects(
        () => call('spec_archive', { spec }),
        /not a spec directory inside/,
        `the specs parent was accepted from ${spec}`,
      )
    }
    assert.ok(!existsSync(join(specsParent, '_archive')), 'a refused archive must not create the archive root')
    assert.ok(existsSync(join(specsParent, 'demo')), 'the specs parent must still be there')
  })

  it('a read tool refuses it too instead of reporting a clean scan of the parent', async () => {
    const root = project()
    seed(root)
    const { call } = mount(root)
    await assert.rejects(
      () => call('spec_checklist', { spec: '.kiro/specs' }),
      /not a spec directory inside/,
    )
  })

  it('refuses an archive root nested inside the spec, with no side effect', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    await assert.rejects(
      () => call('spec_archive', { spec: 'demo', archiveRoot: join(dir, 'sub') }),
      /lies inside the source/,
    )
    assert.ok(!existsSync(join(dir, 'sub')), 'the nesting check must run before mkdir')
    assert.ok(existsSync(join(dir, 'tasks.md')), 'the spec must be untouched')
  })

  it('still allows the normal archive root', async () => {
    const root = project()
    const dir = seed(root)
    const { call } = mount(root)
    await call('spec_archive', { spec: 'demo', archiveRoot: join(root, 'attic') })
    assert.ok(!existsSync(dir))
    assert.ok(existsSync(join(root, 'attic/demo/tasks.md')))
  })
})
