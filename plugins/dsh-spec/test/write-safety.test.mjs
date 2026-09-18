// Write-safety tests (spec task 5.2, part 2) — the destructive boundaries.
//
// Two places in this plugin can destroy data rather than merely report on it:
//   1. `spec_init` — the only entry point that batch-writes a spec directory, and
//      which used to write `tasks.meta.json` unconditionally, OUTSIDE its own
//      "already exists, keep it" guard (Req 9). Kiro stores a spec's entire
//      `executionHistory` in that file, so re-running init on an existing spec
//      could wipe the only record of every task run against it.
//   2. The amendment writers — which must never touch a task body (Req 6.4).
//
// These tests hash the WHOLE directory before and after, rather than checking
// one field, because the failure mode is "a file we did not think about changed".
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// Deterministic snapshot of every file under `dir`, keyed by relative path.
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

function writeSpecWithHistory(root, feature, historyLength, { workflow } = {}) {
  const dir = join(root, '.kiro', 'specs', feature)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'requirements.md'), '# Requirements Document\n\n## Introduction\n\n## Requirements\n')
  const history = {}
  for (let i = 0; i < historyLength; i++) {
    history[`task ${i}`] = [
      { executionId: `exec-${i}`, chatSessionId: `chat-${i}`, timestamp: 1700000000000 + i },
    ]
  }
  const meta = { pbtResults: {}, executionHistory: history }
  // A spec that has been through this plugin already carries `_workflow`; Kiro
  // does not write it. Including it models the realistic "existing spec" that
  // Req 9.1 is about, where init must be a genuine no-op.
  if (workflow !== undefined) meta._workflow = workflow
  writeFileSync(join(dir, 'tasks.meta.json'), JSON.stringify(meta, null, 2) + '\n')
  return { dir, meta, history }
}

describe('Req 9 — spec_init is non-destructive on an existing spec directory', () => {
  for (const n of [1, 10]) {
    it(`leaves every existing byte untouched (executionHistory length ${n})`, async () => {
      const root = project()
      const { dir } = writeSpecWithHistory(root, 'keepme', n, { workflow: 'requirements-first' })
      const before = snapshot(dir)

      const { call } = mount(root)
      // Init re-targets the same feature dir. Before the fix this rewrote
      // tasks.meta.json with a fresh empty object, destroying the history.
      await call('spec_init', { goal: 're-init the same thing', feature: 'keepme' })

      const afterSnap = snapshot(dir)
      // Directory-level, not field-level: the failure mode is "a file we did not
      // think about changed". Nothing at all may differ.
      assert.deepEqual(afterSnap, before, 'a file changed across spec_init')
    })
  }

  it('preserves every executionHistory ENTRY, not merely the file', async () => {
    const root = project()
    const { dir, history } = writeSpecWithHistory(root, 'hist', 10, { workflow: 'requirements-first' })
    const { call } = mount(root)
    await call('spec_init', { goal: 'again', feature: 'hist' })

    const meta = JSON.parse(readFileSync(join(dir, 'tasks.meta.json'), 'utf8'))
    // n stays n — an empty-object replacement is the failure this guards.
    assert.equal(Object.keys(meta.executionHistory).length, Object.keys(history).length)
    for (const [task, records] of Object.entries(history)) {
      assert.deepEqual(meta.executionHistory[task], records, `history for "${task}" was altered`)
    }
  })

  it('does NOT add its own marker to an existing meta file (byte-identity wins)', async () => {
    const root = project()
    // No `_workflow`: the shape Kiro itself writes. An earlier revision merged
    // that marker in, preserving every Kiro FIELD while still changing the
    // file's BYTES — which is what Req 9.1 actually forbids. The workflow must
    // instead be recoverable from the artifacts on disk.
    const { dir, history } = writeSpecWithHistory(root, 'marker', 2)
    const before = readFileSync(join(dir, 'tasks.meta.json'), 'utf8')
    const { call } = mount(root)
    await call('spec_init', { goal: 'again', feature: 'marker' })

    assert.equal(readFileSync(join(dir, 'tasks.meta.json'), 'utf8'), before, 'meta bytes must not change')
    const meta = JSON.parse(before)
    assert.ok(!('_workflow' in meta), 'the fixture deliberately has no marker')
    assert.deepEqual(Object.keys(meta.executionHistory).sort(), Object.keys(history).sort())
  })

  it('recovers a bugfix workflow from disk when meta carries no marker', async () => {
    // The fallback that makes the strict guard safe: a Kiro-made bugfix spec has
    // bugfix.md and (from Kiro) no `_workflow`, so gating must still see bugfix.
    const root = project()
    const dir = join(root, '.kiro', 'specs', 'kfx')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bugfix.md'), '# Bugfix Requirements Document\n')
    writeFileSync(join(dir, 'tasks.meta.json'), JSON.stringify({ pbtResults: {}, executionHistory: {} }, null, 2) + '\n')
    const before = readFileSync(join(dir, 'tasks.meta.json'), 'utf8')
    const { call } = mount(root)
    await call('spec_init', { goal: 'again', feature: 'kfx' })
    assert.equal(readFileSync(join(dir, 'tasks.meta.json'), 'utf8'), before)
    // Design is now writable for this bugfix spec without a `_workflow` marker.
    await call('spec_write', { file: 'design', content: '' })
    assert.ok(statSync(join(dir, 'design.md')).isFile())
  })

  it('does not touch an unparseable meta file', async () => {
    const root = project()
    const dir = join(root, '.kiro', 'specs', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'requirements.md'), '# Requirements Document\n')
    const garbage = '{ this is not json'
    writeFileSync(join(dir, 'tasks.meta.json'), garbage)
    const { call } = mount(root)
    await call('spec_init', { goal: 'again', feature: 'broken' })
    assert.equal(readFileSync(join(dir, 'tasks.meta.json'), 'utf8'), garbage)
  })

  it('reports what it preserved, so the caller knows what happened', async () => {
    const root = project()
    writeSpecWithHistory(root, 'report', 1)
    const { call } = mount(root)
    const out = await call('spec_init', { goal: 'again', feature: 'report' })
    assert.match(out.next, /Kept existing file|kept existing keys|tasks\.meta\.json/i)
  })
})

describe('Req 9.4 — a brand-new spec directory is still fully scaffolded', () => {
  it('creates the artifact and a Kiro-compatible meta file', async () => {
    const root = project()
    const { call } = mount(root)
    await call('spec_init', { goal: 'brand new', feature: 'fresh' })
    const dir = join(root, '.kiro', 'specs', 'fresh')
    assert.ok(statSync(join(dir, 'requirements.md')).isFile())
    const meta = JSON.parse(readFileSync(join(dir, 'tasks.meta.json'), 'utf8'))
    // The two top-level keys Kiro's own `loadMetadata` default provides, so
    // Kiro can consume this file without throwing.
    assert.ok('pbtResults' in meta)
    assert.ok('executionHistory' in meta)
  })
})

describe('Req 7.2 / 7.3 — the meta tool never destroys history', () => {
  // Each case gets its OWN project with exactly one spec, so the resolver finds
  // it without an `_active` pointer (which is how a single-spec repo behaves).
  it('spec_meta read leaves the file byte-identical', async () => {
    const root = project()
    const { dir } = writeSpecWithHistory(root, 'readonly', 3)
    const before = readFileSync(join(dir, 'tasks.meta.json'), 'utf8')
    const { call } = mount(root)
    await call('spec_meta', { action: 'read' })
    assert.equal(readFileSync(join(dir, 'tasks.meta.json'), 'utf8'), before)
  })

  it('a record APPENDS and never replaces existing entries', async () => {
    const root = project()
    const { dir, history } = writeSpecWithHistory(root, 'append', 2)
    const { call } = mount(root)
    await call('spec_meta', { action: 'record', task: 'task 0' })
    const meta = JSON.parse(readFileSync(join(dir, 'tasks.meta.json'), 'utf8'))
    // The untouched sibling entry survives byte-for-byte (deep-equal)…
    assert.deepEqual(meta.executionHistory['task 1'], history['task 1'])
    // …and the targeted one gained exactly one appended record (1 → 2).
    assert.equal(meta.executionHistory['task 0'].length, 2)
    assert.deepEqual(meta.executionHistory['task 0'][0], history['task 0'][0])
  })
})
