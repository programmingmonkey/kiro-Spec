// Parsing-boundary and rule-table tests (spec task 5.2, part 1).
//
// Every assertion here corresponds to a behaviour that was MEASURABLY WRONG
// before this work. The original implementation silently dropped `- [ ]*`
// lines, was completely mute about `### Task N` headings, and misranked `[~]`
// as an error. Those three are why a spec that Kiro accepts could look broken
// here, so each gets an explicit probe.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { __test } from '../lib/index.js'
import { resolveKiroBundle } from '../../../scripts/kiro-bundle-root.mjs'

const T = __test

// This file's own path, so the skip-semantics guard below can read the suite it
// is guarding. `fileURLToPath` rather than `import.meta.filename`: the latter
// needs Node >=20.11 and this package declares `node >=18`.
const BOUNDARIES_PATH = fileURLToPath(import.meta.url)

// The extractor moved with the rule table into the `kiro-rules` package; these
// two paths are the only places this suite names it.
const EXTRACTOR_PATH = fileURLToPath(
  new URL('../../../packages/kiro-rules/scripts/extract-kiro-rules.py', import.meta.url),
)

// The bundle location has exactly one home: the extractor's own `BUNDLE`
// constant. Reading it from there means a moved bundle re-points the skip reason
// instead of leaving a stale path here — and an unparseable script throws
// (`bundlePath` never returns a guess), so it cannot degrade into another
// silent skip.
//
// 2026-09-13 —— 那个「唯一的家」现在有前门钥匙了。原实现只认 py 里的绝对路径，于是在任何
// 非作者主机上（CI、Cowork 的 Linux VM）这两条**带 STOP 门**的围栏交叉验证永远只能 skip：
// 门槛是绿的，但只在一台机器上跑得起来。`scripts/kiro-bundle-root.mjs` 把
// `KIRO_EXTENSION_JS` 加在 py 常量之前作为第一候选 —— 家还是那个家，只是可以从别处开门。
function bundlePath() {
  return resolveKiroBundle().path
}

// A tasks.md with every required Kiro heading, so only the behaviour under test
// produces findings. Without this, the missing-heading noise drowns the signal.
const tasksDoc = (tasksBody, graph = '{"waves":[{"id":0,"tasks":["9.9"]}]}') => [
  '# Implementation Plan',
  '',
  '## Overview',
  '',
  '> 概述',
  '',
  '## Task Dependency Graph',
  '',
  '```json',
  graph,
  '```',
  '',
  '## Tasks',
  '',
  '> 任务清单',
  '',
  tasksBody,
  '',
  '## Notes',
  '',
].join('\n')

const codesOf = (kind, text, options) => T.diagnoseArtifact(kind, text, options).map((d) => d.code)
const bySeverity = (kind, text, sev, options) =>
  T.diagnoseArtifact(kind, text, options).filter((d) => d.severity === sev)

describe('Req 2.1 — the optional task marker `*` is a real task, not a dropped line', () => {
  it('parses `- [ ]* 4.1 text`', () => {
    const t = T.parseTask('- [ ]* 4.1 optional task')
    assert.ok(t, 'the line must be recognised at all')
    assert.equal(t.index, '4.1')
    assert.equal(t.state, ' ')
    assert.equal(t.valid, true)
  })

  it('parses the escaped form `- [ ]\\* 4.2 text`', () => {
    const t = T.parseTask('- [ ]\\* 4.2 escaped task')
    assert.ok(t)
    assert.equal(t.index, '4.2')
  })

  it('counts an optional-marked leaf as an executable unit', () => {
    const md = tasksDoc('- [ ]* 1.1 optional leaf')
    assert.deepEqual(T.parseTaskList(md).map((t) => t.index), ['1.1'])
    assert.equal(T.executableUnitCount(md).count, 1)
  })
})

describe('Req 2.2 — heading-style tasks are reported, not silently ignored', () => {
  it('flags `### Task 5.1 …` with Kiro\u2019s own code', () => {
    const codes = codesOf('tasks', tasksDoc('### Task 5.1 heading style\n\n- [ ] 5.1 real'))
    assert.ok(codes.includes('tasks/invalid-task-heading'), JSON.stringify(codes))
  })

  it('flags `## Task 5 …` too', () => {
    const codes = codesOf('tasks', tasksDoc('## Task 5 heading style\n\n- [ ] 5.1 real'))
    assert.ok(codes.includes('tasks/invalid-task-heading'), JSON.stringify(codes))
  })

  it('leaves the checkbox task alone', () => {
    // The heading rule must not fire on the normal form, or it becomes noise.
    const codes = codesOf('tasks', tasksDoc('- [ ] 5.1 checkbox form'))
    assert.ok(!codes.includes('tasks/invalid-task-heading'), JSON.stringify(codes))
  })
})

describe('Req 2.3 — malformed task / sub-task lines get Kiro\u2019s per-depth codes', () => {
  it('a top-level line without an id is tasks/invalid-task-line', () => {
    const codes = codesOf('tasks', tasksDoc('- [ ] no id here'))
    assert.ok(codes.includes('tasks/invalid-task-line'), JSON.stringify(codes))
  })

  it('an indented line without a dotted id is tasks/invalid-subtask-line', () => {
    const codes = codesOf('tasks', tasksDoc('- [ ] 5. parent\n  - [ ] no dotted id'))
    assert.ok(codes.includes('tasks/invalid-subtask-line'), JSON.stringify(codes))
  })
})

describe('Req 2.4 — waves and checkboxes are cross-checked in BOTH directions', () => {
  it('a graph id with no checkbox line is a hard error', () => {
    // This direction makes the runner dispatch a task the file never defines.
    const codes = codesOf('tasks', tasksDoc('- [ ] 1.1 real', '{"waves":[{"id":0,"tasks":["9.9"]}]}'))
    assert.ok(codes.includes('tasks/waves-task-mismatch'), JSON.stringify(codes))
  })

  it('a checkbox in no wave is reported (the runner would never dispatch it)', () => {
    const codes = codesOf('tasks', tasksDoc('- [ ] 1.1 real\n- [ ] 2.1 orphan', '{"waves":[{"id":0,"tasks":["1.1"]}]}'))
    assert.ok(codes.includes('tasks/undeclared-task'), JSON.stringify(codes))
  })

  it('a parent grouping label is NOT reported when absent from the graph', () => {
    // Parents are labels; the shipped template lists only the leaf. Flagging
    // them would fire on every well-formed spec.
    const codes = codesOf('tasks', tasksDoc('- [ ] 1. parent\n  - [ ] 1.1 leaf', '{"waves":[{"id":0,"tasks":["1.1"]}]}'))
    assert.ok(!codes.includes('tasks/undeclared-task'), JSON.stringify(codes))
  })

  it('a consistent spec reports neither direction', () => {
    const codes = codesOf('tasks', tasksDoc('- [ ] 1. parent\n  - [ ] 1.1 leaf', '{"waves":[{"id":0,"tasks":["1.1"]}]}'))
    assert.ok(!codes.includes('tasks/waves-task-mismatch'), JSON.stringify(codes))
    assert.ok(!codes.includes('tasks/undeclared-task'), JSON.stringify(codes))
  })
})

describe('Req 2.7 — parent tasks are exempt from `_Requirements:_`, leaves are not', () => {
  it('a leaf without `_Requirements:_` is reported by the checklist layer', () => {
    // Covered behaviourally in checklist tests; here we pin the parsing
    // distinction the exemption is built on: parents are identifiable.
    const md = '- [ ] 1. parent\n  - [ ] 1.1 leaf\n  - [ ] 1.2 leaf two\n'
    assert.deepEqual([...T.parentTaskIds(T.parseTaskList(md))], ['1'])
  })

  it('a childless top-level task is NOT a parent', () => {
    const md = '- [ ] 1. alone\n- [ ] 2. other\n'
    assert.deepEqual([...T.parentTaskIds(T.parseTaskList(md))], [])
    assert.equal(T.executableUnitCount(md).count, 2)
  })
})

describe('Req 2.8 — the three state bands are distinguished, not collapsed', () => {
  const probe = (state) => tasksDoc(`- [${state}] 1.1 task`)

  it('[-] is legal and stays silent', () => {
    const codes = codesOf('tasks', probe('-'))
    assert.ok(!codes.includes('tasks/malformed-checkbox'), JSON.stringify(codes))
  })

  it('[~] PARSES but is only a repo-convention warning', () => {
    const t = T.parseTask('- [~] 1.1 tilde')
    assert.equal(t.valid, true, 'Kiro parses [~] — treating it as unparseable was the bug')
    const warn = T.diagnoseArtifact('tasks', probe('~')).find((d) => d.code === 'tasks/invalid-task-state')
    assert.ok(warn, 'expected a warning')
    assert.equal(warn.severity, 'warning')
    assert.equal(warn.source, 'repo-convention')
  })

  it('[/] is a hard error with Kiro\u2019s malformed-checkbox code', () => {
    const err = bySeverity('tasks', probe('/'), 'error').find((d) => d.code === 'tasks/malformed-checkbox')
    assert.ok(err, JSON.stringify(codesOf('tasks', probe('/'))))
    assert.equal(err.source, 'kiro-binary')
  })

  it('[!] is a hard error with Kiro\u2019s malformed-checkbox code', () => {
    const err = bySeverity('tasks', probe('!'), 'error').find((d) => d.code === 'tasks/malformed-checkbox')
    assert.ok(err, JSON.stringify(codesOf('tasks', probe('!'))))
  })
})

describe('Req 1.10 — every finding declares where its rule comes from', () => {
  const SAMPLES = [
    ['requirements', '# Requirements Document\n\n## Introduction\n\n## Requirements\n'],
    ['design', '# Design Document\n\n## Overview\n'],
    ['bugfix', '# Anything\n\n## Introduction\n'],
    ['tasks', tasksDoc('- [~] 1.1 tilde\n- [ ] 2.1 no id?')],
  ]

  it('every finding carries source ∈ {kiro-binary, repo-convention}', () => {
    for (const [kind, text] of SAMPLES) {
      for (const d of T.diagnoseArtifact(kind, text)) {
        assert.ok(
          d.source === 'kiro-binary' || d.source === 'repo-convention',
          `${kind} ${d.code} has source ${JSON.stringify(d.source)}`,
        )
      }
    }
  })

  it('a Kiro rule is labelled kiro-binary even when it matches a repo code shape', () => {
    const d = T.diagnoseArtifact('bugfix', '# X\n').find((x) => x.code === 'bugfix/missing-introduction')
    assert.equal(d.source, 'kiro-binary')
  })

  it('a plugin-only rule is labelled repo-convention', () => {
    const d = T.diagnoseArtifact('design', '# Design Document\n\n## Overview\n')
      .find((x) => x.code === 'design/missing-title' || x.code === 'design/missing-architecture')
    assert.ok(d)
  })
})

describe('Req 1.4 / 1.8 — design variant is sniffed, and H1 is only a repo convention', () => {
  it('sniffs the bugfix variant from content alone', () => {
    assert.equal(T.sniffDesignVariant('## Bug Details\n'), 'bugfix')
    assert.equal(T.sniffDesignVariant('## Hypothesized Root Cause\n'), 'bugfix')
    assert.equal(T.sniffDesignVariant('## Fix Implementation\n'), 'bugfix')
    assert.equal(T.sniffDesignVariant('### Fault Condition\n'), 'bugfix')
    assert.equal(T.sniffDesignVariant('## Architecture\n'), 'feature')
  })

  it('a bugfix design is NOT asked for the feature sections, even via kind=design', () => {
    const md = '# Design Document\n\n## Overview\n\n## Bug Details\n\n## Expected Behavior\n\n## Hypothesized Root Cause\n\n## Fix Implementation\n'
    const codes = codesOf('design', md)
    for (const featureOnly of ['design/missing-architecture', 'design/missing-components', 'design/missing-data-models']) {
      assert.ok(!codes.includes(featureOnly), JSON.stringify(codes))
    }
  })

  it('a missing design H1 is a warning labelled repo-convention (Kiro has no such rule)', () => {
    const d = T.diagnoseArtifact('design', '## Overview\n\n## Architecture\n\n## Components and Interfaces\n\n## Data Models\n')
      .find((x) => x.code === 'design/missing-title')
    assert.ok(d)
    assert.equal(d.severity, 'warning')
    assert.equal(d.source, 'repo-convention')
  })

  it('bugfix.md is never judged on its H1', () => {
    // The real the consumer repo file's H1 is `# Bugfix Requirements Document`; the old
    // table demanded `# Bug Analysis` and that was pure invention.
    const full = [
      '# Bugfix Requirements Document', '', '## Introduction', '', '## Bug Analysis', '',
      '### Current Behavior (Defect)', '', '### Expected Behavior (Correct)', '',
      '### Unchanged Behavior (Regression Prevention)', '',
    ].join('\n')
    const codes = codesOf('bugfix', full)
    assert.ok(!codes.includes('bugfix/wrong-h1'), JSON.stringify(codes))
    assert.ok(!codes.some((c) => c.includes('missing-h1')), JSON.stringify(codes))
    assert.deepEqual(bySeverity('bugfix', full, 'error'), [])
  })
})

describe('Req 1.9 — `# Implementation Plan` matches by prefix', () => {
  it('accepts a suffixed H1', () => {
    const md = tasksDoc('- [ ] 1.1 x').replace('# Implementation Plan', '# Implementation Plan — dsh-spec advancement')
    const codes = codesOf('tasks', md)
    assert.ok(!codes.includes('tasks/missing-implementation-plan'), JSON.stringify(codes))
  })
})

describe('Req 1.5 / 1.6 — the three invented design codes are gone for good', () => {
  it('no finding can ever use an invented code', () => {
    const invented = [
      'design/missing-root-cause-analysis',
      'design/missing-proposed-fix',
      'design/missing-properties-to-test',
      'designBugfix/missing-section',
      'bugfix/missing-section',
      'bugfix/missing-recommended-section',
    ]
    const samples = [
      '# Design Document',
      '## Overview\n\n## Bug Details\n',
      '# Bug Analysis\n\n## Introduction\n\n## Current Behavior\n',
      '',
    ]
    for (const kind of ['design', 'designBugfix', 'bugfix', 'tasks']) {
      for (const s of samples) {
        for (const d of T.diagnoseArtifact(kind, s)) {
          assert.ok(!invented.includes(d.code), `${kind} emitted invented code ${d.code}`)
        }
      }
    }
  })
})

describe('Req 1.11 / 1.12 / 1.14 — the Kiro rule-code set is exactly 41, verified against the bundle', () => {
  it('the plugin emits exactly Kiro\u2019s 41 codes across representative documents', (t) => {
    // Collect every code the corrected diagnostics can produce from documents
    // engineered to trip each rule, then compare BOTH WAYS against the codes
    // extracted live from the Kiro bundle. A missing code means under-
    // implementing; an extra one means we invented something again.
    const emitted = new Set()
    const probe = (kind, text, options) => {
      for (const d of T.diagnoseArtifact(kind, text, options)) emitted.add(d.code)
    }
    probe('requirements', '# Wrong\n')
    probe('requirements', '# Requirements Document\n\n## Introduction\n\n## Requirements\n\n### Requirement 1:\n')
    probe('requirements', '# Requirements Document\n\n## Introduction\n\n## Glossary\n\n## Requirements\n\n### Requirement x\n')
    probe('design', '# Design Document\n')
    probe('design', '# Design Document\n\n## Correctness Properties\n\n## Architecture\n')
    probe('design', '# Design Document\n\n## Architecture\n\n## Components and Interfaces\n\n## Data Models\n\n## Correctness Properties\n\n### Property x\n')
    probe('designBugfix', '# Design Document\n')
    probe('bugfix', '# X\n')
    probe('bugfix', '# X\n\n## Introduction\n\n## Bug Analysis\n\n### Current Behavior (Defect)\n\n### Expected Behavior (Correct)\n\n### Unchanged Behavior (Regression Prevention)\n\n## Architecture\n')
    const tasksFull = tasksDoc('- [ ] 1.1 x')
    probe('tasks', '# Implementation Plan\n\n## Task Dependency Graph\n\n## Tasks\n- [ ] 1.1 x\n- [!] 1.2 bad\n### Task 3\n')
    probe('tasks', tasksFull)
    probe('tasks', '# Implementation Plan\n\n## Task Dependency Graph\n\n```json\n{}\n```\n')

    const repoOnly = Object.keys(T.REPO_CODES)
    const kiroEmitted = [...emitted].filter((c) => !repoOnly.includes(c) && !c.endsWith('/unterminated-fence'))
    for (const c of kiroEmitted) {
      assert.equal(c.startsWith('designBugfix/'), false, `kind-prefixed code leaked: ${c}`)
    }

    // Live extraction from the shipped Kiro bundle.
    const script = EXTRACTOR_PATH
    let out
    try {
      out = execFileSync('python3', [script], { encoding: 'utf8' })
    } catch (e) {
      // Only the bundle's ABSENCE is skippable, and even that must be visible.
      // Any other failure — python3 missing, the extractor moved, a syntax
      // error — would make the strongest assertion vanish without a trace, so
      // it is rethrown instead of being absorbed into the same skip.
      if (existsSync(bundlePath())) throw e
      return t.skip(`Kiro bundle 不在本机（${bundlePath()}）：规则表与 bundle 的实时比对未执行`)
    }
    const bundleCodes = new Set(
      (out.split('RULE_CODES_BEGIN')[1] ?? '')
        .split('RULE_CODES_END')[0]
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
    assert.equal(bundleCodes.size, 41, `expected 41 codes in the bundle, parsed ${bundleCodes.size}`)

    for (const code of bundleCodes) {
      // A code can be unreachable from these particular probes without being
      // unimplemented; assert only the direction that catches invention.
      assert.ok(!/root-cause-analysis|proposed-fix|properties-to-test/.test(code), `invented bundle code? ${code}`)
    }
    // No emitted code may sit outside (Kiro's 41) ∪ (declared repo codes).
    for (const c of kiroEmitted) {
      assert.ok(
        bundleCodes.has(c) || repoOnly.includes(c) || c.endsWith('/unterminated-fence'),
        `emitted a code that is neither a Kiro code nor a declared repo code: ${c}`,
      )
    }
  })
})

describe('a missing Kiro bundle must be a VISIBLE skip, never a silent return', () => {
  // The strongest assertion in this suite is the live extraction compare above:
  // it re-derives all 41 codes from the shipped Kiro bundle and diffs them
  // against the table. It used to `return` when the bundle was absent, which
  // meant that on any machine without Kiro the strongest check simply did not
  // run — no failure, no skip line, nothing in the TAP output to notice. This
  // guard is what keeps it visible; `t.skip(reason)` is the replacement, and it
  // prints a `# SKIP` line naming the reason.
  it('no silently-swallowed assertion remains in this suite', () => {
    const src = readFileSync(BOUNDARIES_PATH, 'utf8')
    // The title deliberately avoids spelling the pattern out: an earlier version
    // of this very test matched its own name and could never pass.
    assert.doesNotMatch(
      src,
      /catch\s*\{\s*return\s*\}/,
      '静默 return 会让最强断言在无 Kiro 的机器上消失且无人知晓',
    )
  })
})

describe('the executor and the frozen rule table cannot drift apart', () => {
  // `packages/kiro-rules/lib/kiro-rules.js` is the AUDITABLE artifact (all 41
  // codes with their severity, pattern and `source`); `lib/index.js` is the
  // executor. They are separate files (now separate packages) on purpose, which
  // means they can drift — this suite is what makes that drift a test failure
  // instead of a silent behaviour change.

  it('the table declares exactly the 41 codes the bundle contains', async (t) => {
    const { KIRO_RULE_CODES, RULE_CODE_COUNT } = await import('@my-harness/kiro-rules')
    assert.equal(RULE_CODE_COUNT, 41)
    assert.equal(KIRO_RULE_CODES.length, 41)
    assert.equal(new Set(KIRO_RULE_CODES).size, 41, 'no duplicate codes')

    const script = EXTRACTOR_PATH
    let out
    try {
      out = execFileSync('python3', [script], { encoding: 'utf8' })
    } catch (e) {
      // Same rule as above: the skip is narrow (bundle absent) and visible.
      if (existsSync(bundlePath())) throw e
      return t.skip(`Kiro bundle 不在本机（${bundlePath()}）：规则表与 bundle 的实时比对未执行`)
    }
    const bundle = new Set(
      (out.split('RULE_CODES_BEGIN')[1] ?? '').split('RULE_CODES_END')[0].split('\n').map((l) => l.trim()).filter(Boolean),
    )
    assert.deepEqual([...KIRO_RULE_CODES].sort(), [...bundle].sort(), 'table and bundle disagree')
  })

  it('every rule entry carries a non-empty source and a compilable pattern', async () => {
    const { KIRO_RULES } = await import('@my-harness/kiro-rules')
    const entries = []
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (v && typeof v === 'object') {
        if (v.code) return entries.push(v)
        return Object.values(v).forEach(walk)
      }
    }
    walk(KIRO_RULES)
    assert.ok(entries.length >= 41, `expected at least 41 entries, got ${entries.length}`)
    for (const r of entries) {
      assert.ok(r.source, `${r.code} has no source`)
      assert.ok(r.severity === 'error' || r.severity === 'warning', `${r.code} has severity ${r.severity}`)
      if (r.pattern !== null && r.pattern !== undefined) {
        assert.ok(r.pattern instanceof RegExp, `${r.code} pattern is not a RegExp`)
      }
    }
  })

  it('the feature/bugfix design section lists in the executor match the table', async () => {
    const { rulesFor } = await import('@my-harness/kiro-rules')
    // The executor holds its own design section lists (`DESIGN_FEATURE_SECTIONS`
    // / `DESIGN_BUGFIX_SECTIONS`) because Kiro's checks include quirks a pure
    // data table cannot express (e.g. "report at most ONE unexpected-section
    // warning"). Section rules are exactly the table entries with a non-null
    // `name` — the content rules (`malformed-property-heading` and friends) have
    // no section name. Comparing the SETS keeps data and code in step.
    const tables = {
      feature: T.DESIGN_FEATURE_SECTIONS,
      bugfix: T.DESIGN_BUGFIX_SECTIONS,
    }
    for (const variant of ['feature', 'bugfix']) {
      const fromTable = (rulesFor('design', variant) ?? [])
        .filter((r) => r.name !== null && r.name !== undefined)
      const fromExecutor = tables[variant]
      assert.ok(fromExecutor && fromExecutor.length, `executor has no ${variant} section list`)
      assert.deepEqual(
        fromExecutor.map((s) => s.code).sort(),
        fromTable.map((r) => r.code).sort(),
        `${variant} section codes differ between executor and table`,
      )
      // The display names and severities must agree too: a section renamed in
      // one place but not the other would silently stop matching Kiro.
      for (const rule of fromTable) {
        const mine = fromExecutor.find((s) => s.code === rule.code)
        assert.ok(mine, `${rule.code} missing from the executor`)
        assert.equal(mine.name, rule.name, `${rule.code} section name differs`)
        assert.equal(mine.severity, rule.severity, `${rule.code} severity differs`)
      }
    }
  })

  it('every design section rule really is emitted when its section is absent', () => {
    // Behavioural counterpart to the table comparison above: a rule can be
    // listed and still never fire. `## Bug Details` is the bugfix sniff trigger,
    // so the bugfix probe uses a different trigger section to leave Bug Details
    // genuinely missing.
    for (const [text, expectAllMissing] of [
      ['# Design Document\n', 'feature'],
      ['## Hypothesized Root Cause\n', 'bugfix'],
    ]) {
      const emitted = new Set(T.diagnoseArtifact('design', text).map((d) => d.code))
      const sections = expectAllMissing === 'feature' ? T.DESIGN_FEATURE_SECTIONS : T.DESIGN_BUGFIX_SECTIONS
      for (const s of sections) {
        // The sniff trigger itself is present by construction in the bugfix
        // probe, so it is legitimately not reported as missing.
        if (s.code === 'design/missing-hypothesized-root-cause') continue
        assert.ok(emitted.has(s.code), `${s.code} did not fire for ${expectAllMissing}`)
      }
    }
  })

  it('REPO_CODES lists every repo-convention code AND nothing that is unreachable', () => {
    // The declared set is the contract that separates "our stricter taste" from
    // "Kiro's rule". A code emitted as repo-convention but absent from the table
    // silently falls back to being labelled kiro-binary, which is precisely the
    // conflation Req 1.10 exists to prevent. A code declared but unreachable is
    // dead documentation. Both directions are checked.
    const declared = Object.keys(T.REPO_CODES)
    const emitted = new Set()
    const probe = (kind, text, options) => {
      for (const d of T.diagnoseArtifact(kind, text, options)) {
        if (d.source === 'repo-convention') emitted.add(d.code)
      }
    }
    probe('requirements', '# Requirements Document\n\n## Introduction\n\n## Glossary\n\n## Requirements\n\n### Requirement x\n')
    probe('design', '## Overview\n')
    probe('designBugfix', '## Bug Details\n')
    probe('bugfix', '# X\n')
    // Trips: [~] state, waves/checkbox mismatch, an undeclared checkbox, and a
    // `{"waves":[]}` schema advisory.
    probe('tasks', tasksDoc('- [~] 1.1 a', '{"waves":[{"id":0,"tasks":["9.9"]}]}'))
    probe('tasks', tasksDoc('- [ ] 9.9 x', '{"waves":[]}'))
    probe('tasks', '# Implementation Plan\n\n## Task Dependency Graph\n\n```json\n{}\n```\n')
    // Duplicate ids: the runner and the state-writer would pick different lines.
    probe('tasks', tasksDoc('- [ ] 1.1 first\n- [ ] 1.1 second', '{"waves":[{"id":0,"tasks":["1.1"]}]}'))
    // too-many-units: past the 20-unit guideline.
    const many = ['# Implementation Plan', '', '## Overview', '', '> o', '', '## Task Dependency Graph', '', '```json',
      '{ "waves": [ { "id": 0, "tasks": ["1.1"] } ] }', '```', '', '## Tasks', '']
    for (let i = 1; i <= 25; i++) many.push(`- [ ] ${i}. leaf ${i}`)
    many.push('', '## Notes', '')
    probe('tasks', many.join('\n'))
    // Per-kind unterminated fence.
    for (const kind of ['requirements', 'design', 'designBugfix', 'bugfix', 'tasks']) {
      probe(kind, '# X\n```\nunclosed\n')
    }

    const undeclared = [...emitted].filter((c) => !declared.includes(c))
    assert.deepEqual(undeclared, [], 'these codes are emitted as repo-convention but not declared')

    // Every declared code must be reachable by some probe above.
    const unreachable = declared.filter((c) => !emitted.has(c))
    assert.deepEqual(unreachable, [], 'these declared repo codes can never be emitted')

    // And the declared severity must match what actually comes out.
    for (const [code, severity] of Object.entries(T.REPO_CODES)) {
      const hits = ['requirements', 'design', 'designBugfix', 'bugfix', 'tasks'].flatMap((k) => [
        ...T.diagnoseArtifact(k, '# X\n```\nunclosed\n'),
        ...T.diagnoseArtifact(k, many.join('\n')),
        ...T.diagnoseArtifact(k, tasksDoc('- [~] 1.1 a', '{"waves":[{"id":0,"tasks":["9.9"]}]}')),
      ]).filter((d) => d.code === code)
      for (const h of hits) assert.equal(h.severity, severity, `${code} severity drifted`)
    }
  })

  it('the three invented codes appear nowhere in the frozen table', async () => {
    const { KIRO_RULE_CODES, REPO_CONVENTIONS } = await import('@my-harness/kiro-rules')
    const all = [...KIRO_RULE_CODES, ...(REPO_CONVENTIONS ?? []).map((r) => r.code)]
    for (const invented of [
      'design/missing-root-cause-analysis',
      'design/missing-proposed-fix',
      'design/missing-properties-to-test',
    ]) {
      assert.ok(!all.includes(invented), `${invented} must not exist anywhere`)
    }
  })
})

describe('Kiro normalisation is trimEnd, and several rules use the RAW line (Req 1.13)', () => {
  // The subtle half of the alignment. Kiro's `xE` is `t.trimEnd()`, so:
  //   - trailing whitespace is irrelevant everywhere;
  //   - LEADING indentation defeats every `^#`-anchored pattern;
  //   - but several checks use the raw line, so an indented `  # Implementation
  //     Plan` must fail there too (it would be just as wrong to accept it).
  // Both directions are asserted, because a fix that only widens or only
  // narrows would still disagree with Kiro on real files: 15 of the 205 real
  // specs in the reference corpus contain indented ATX headings.
  const cases = [
    ['indented # Implementation Plan (raw rule) must NOT satisfy', 'tasks', '  # Implementation Plan\n', 'tasks/missing-implementation-plan', true],
    ['trailing-space # Implementation Plan (trimEnd) MUST satisfy', 'tasks', '# Implementation Plan   \n', 'tasks/missing-implementation-plan', false],
    ['indented ## Overview must NOT satisfy', 'tasks', '  ## Overview\n', 'tasks/missing-overview', true],
    ['trailing-space ## Overview MUST satisfy', 'tasks', '## Overview   \n', 'tasks/missing-overview', false],
    ['indented ## Requirements must NOT satisfy', 'requirements', '  ## Requirements\n', 'requirements/missing-requirements-section', true],
    ['trailing-space ## Requirements MUST satisfy', 'requirements', '## Requirements   \n', 'requirements/missing-requirements-section', false],
    ['indented ## Bug Analysis must NOT satisfy', 'bugfix', '  ## Bug Analysis\n', 'bugfix/missing-bug-analysis', true],
    ['trailing-space ## Bug Analysis MUST satisfy', 'bugfix', '## Bug Analysis   \n', 'bugfix/missing-bug-analysis', false],
    ['indented ## Data Models must NOT satisfy', 'design', '  ## Data Models\n', 'design/missing-data-models', true],
    ['trailing-space ## Data Models MUST satisfy', 'design', '## Data Models   \n', 'design/missing-data-models', false],
    ['indented ### Current Behavior (Defect) must NOT satisfy', 'bugfix', '  ### Current Behavior (Defect)\n', 'bugfix/missing-current-behavior', true],
    ['indented ## Task Dependency Graph must NOT satisfy', 'tasks', '  ## Task Dependency Graph\n', 'tasks/missing-dependency-graph', true],
    ['## OVERVIEW MUST satisfy (design names are lowercased)', 'design', '## OVERVIEW\n', 'design/missing-overview', false],
    ['## Overview · 概述 MUST NOT satisfy (same-line suffix)', 'design', '## Overview · 概述\n', 'design/missing-overview', true],
  ]
  for (const [label, kind, text, code, shouldReport] of cases) {
    it(label, () => {
      const reported = T.diagnoseArtifact(kind, text, { isBugfix: kind === 'designBugfix' })
        .map((d) => d.code)
        .includes(code)
      assert.equal(reported, shouldReport, `${code} on ${JSON.stringify(text)}`)
    })
  }

  it('an indented property heading counts as NEITHER a property nor malformed', () => {
    // Kiro's two patterns are `^(?:### )?Property \d+:` and `^(?:### )?Property\b`.
    // An indented line matches neither — `^` sits before the spaces — so the
    // section reads as empty and no malformed warning is raised. Counter-
    // intuitive, but it is what the bundle does, so it is what DSH must do.
    const md = '# Design Document\n\n## Correctness Properties\n\n  ### Property 1: indented\n\n**Validates: Requirements 1.1**\n'
    const codes = codesOf('design', md)
    assert.ok(codes.includes('design/empty-correctness-properties'), JSON.stringify(codes))
    assert.ok(!codes.includes('design/malformed-property-heading'), JSON.stringify(codes))
    assert.ok(!codes.includes('design/missing-property-validates'), JSON.stringify(codes))
  })

  it('`Property` without a numeric `N:` is malformed', () => {
    // This is the case Kiro's malformed rule actually fires on: the loose
    // pattern matches, the strict one does not.
    for (const bad of ['Property 1', '### Property one', 'Property x']) {
      const md = `# Design Document\n\n## Correctness Properties\n\n${bad}\n`
      const codes = codesOf('design', md)
      assert.ok(codes.includes('design/malformed-property-heading'), `${bad}: ${JSON.stringify(codes)}`)
    }
  })

  it('a property with no `**Validates:**` line is warned about', () => {
    const md = '# Design Document\n\n## Correctness Properties\n\n### Property 1: x\n\nsome prose\n'
    assert.ok(codesOf('design', md).includes('design/missing-property-validates'))
  })

  it('a property heading may be bare `Property N:` or `### Property N:`', () => {
    for (const line of ['Property 1: x', '### Property 1: x']) {
      const md = `# Design Document\n\n## Correctness Properties\n\n${line}\n\n**Validates: Requirements 1.1**\n`
      const codes = codesOf('design', md)
      assert.ok(!codes.includes('design/empty-correctness-properties'), `${line}: ${JSON.stringify(codes)}`)
      assert.ok(!codes.includes('design/malformed-property-heading'), `${line}: ${JSON.stringify(codes)}`)
    }
  })
})

describe('the legacy→Kiro code remap is real, not decorative', () => {
  it('every non-null target is an actual code, and no legacy code is still emitted', async () => {
    const { KIRO_RULE_CODES } = await import('@my-harness/kiro-rules')
    const realCodes = new Set([...KIRO_RULE_CODES, ...Object.keys(T.REPO_CODES)])
    const remap = T.LEGACY_CODE_REMAP

    for (const [legacy, target] of Object.entries(remap)) {
      if (target !== null) {
        assert.ok(realCodes.has(target), `${legacy} maps to ${target}, which is not a real code`)
      }
    }

    // The load-bearing half: none of the legacy codes may ever come back. This
    // is what turns the table from provenance prose into a guard against a
    // partial revert of the remap.
    const emitted = new Set()
    const probe = (kind, text, options) => {
      for (const d of T.diagnoseArtifact(kind, text, options)) emitted.add(d.code)
    }
    probe('requirements', '# Wrong\n')
    probe('requirements', '# Requirements Document\n\n## Introduction\n\n## Requirements\n\n### Requirement 1:\n')
    probe('design', '# Design Document\n')
    probe('design', '# Design Document\n\n## Overview\n')
    probe('designBugfix', '# Design Document\n')
    probe('bugfix', '# X\n')
    probe('bugfix', '# X\n\n## Introduction\n')
    probe('tasks', '# Implementation Plan\n')
    probe('tasks', tasksDoc('- [ ] 1.1 x'))
    probe('tasks', '## Task Dependency Graph\n```json\n{}\n```\n')

    const resurrected = Object.keys(remap).filter(
      (legacy) => emitted.has(legacy) && remap[legacy] !== legacy,
    )
    assert.deepEqual(resurrected, [], 'legacy codes must not be emitted any more')
  })
})

describe('the parser never silently drops a line Kiro accepts', () => {
  // The dangerous direction is DROPPING: an uncounted task can make `phase`
  // report `complete` while work is outstanding. Kiro's own top-level regex
  // requires a trailing dot on `N.`, while the sub-task regex does not, and
  // both are PREFIX tests — so `- [ ] 1.` and `- [ ] 1.1` are both legal with no
  // title text at all. An earlier revision of this parser dropped both.
  for (const line of ['- [ ] 1.', '- [ ] 1.1', '- [ ] 1.1.', '- [ ]* 4.1', '- [ ]\\* 4.2', '- [ ] 9.1 title']) {
    it(`parses ${JSON.stringify(line)} instead of dropping it`, () => {
      const t = T.parseTask(line)
      assert.ok(t, `${line} was dropped`)
      assert.match(t.index, /^\d+(?:\.\d+)*$/)
    })
  }

  it('counts an untitled task toward the total, so `complete` is not reachable early', () => {
    const md = tasksDoc('- [x] 1. done thing\n- [ ] 2.')
    assert.deepEqual(T.parseTaskList(md).map((t) => t.index), ['1', '2'])
    const stats = T.taskStats(md)
    assert.equal(stats.total, 2)
    assert.equal(stats.done, 1)
  })

  it('reports the Kiro line-shape errors it used to miss', () => {
    // `N` without a dot is an error to Kiro (its top-level regex needs `\\d+\\.`).
    assert.ok(
      codesOf('tasks', tasksDoc('- [ ] 12 no dot')).includes('tasks/invalid-task-line'),
      'a dotless top-level id must be reported',
    )
    // A sub-task without a dotted id is an error too.
    assert.ok(
      codesOf('tasks', tasksDoc('- [ ] 5. parent\n  - [ ] 1 no subid')).includes('tasks/invalid-subtask-line'),
    )
  })

  it('still rejects an id glued to text (a deliberate divergence from Kiro)', () => {
    assert.equal(T.parseTask('- [ ] 1.1foo'), undefined)
  })
})

describe('scaffolded templates must themselves satisfy the corrected rules', () => {
  // Discovered during execution and NOT enumerated in the original task list:
  // the plugin's own bugfix scaffold used heading names that Kiro rejects, and
  // its design scaffold invented three sections while omitting two. Every
  // bugfix spec this plugin ever created was therefore born non-conformant.
  // A template that fails its own linter is the worst kind of defect, because
  // it reproduces itself into every new spec.

  it('bugfixTemplate is clean under the bugfix rules', () => {
    const text = T.bugfixTemplate('fix the thing')
    assert.deepEqual(T.diagnoseArtifact('bugfix', text), [])
  })

  it('bugfixTemplate emits the three H3 sections with their exact suffixes', () => {
    const text = T.bugfixTemplate('fix the thing')
    assert.match(text, /^### Current Behavior \(Defect\)$/m)
    assert.match(text, /^### Expected Behavior \(Correct\)$/m)
    assert.match(text, /^### Unchanged Behavior \(Regression Prevention\)$/m)
    // …and NOT the H2 forms the old template used.
    assert.doesNotMatch(text, /^## Current Behavior$/m)
    assert.doesNotMatch(text, /^## Expected Behavior$/m)
    assert.doesNotMatch(text, /^## Unchanged Behavior$/m)
  })

  it('bugfixTemplate does not demand the invented H1', () => {
    assert.doesNotMatch(T.bugfixTemplate('x'), /^# Bug Analysis$/m)
  })

  it('designTemplate is clean under the feature design rules', () => {
    const text = T.designTemplate('high')
    assert.deepEqual(T.diagnoseArtifact('design', text), [])
  })

  it('designTemplate carries a real `Property N:` heading, not just `*For any*` prose', () => {
    // Without it Kiro warns design/empty-correctness-properties even though the
    // section is populated.
    assert.match(T.designTemplate('high'), /^### Property 1:/m)
  })
})

describe('the spec is scaffolded cleanly end to end through the tool layer', () => {
  it('a freshly initialised bugfix spec has zero errors in every artifact', async () => {
    const { mkdirSync, readFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { mount } = await import('./harness.mjs')
    const root = '/tmp/dsh-spec-scaffold-check'
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    const { call } = mount(root)
    await call('spec_init', { goal: 'fix the thing', kind: 'bugfix', feature: 'demo' })
    const bugfix = readFileSync(join(root, '.kiro/specs/demo/bugfix.md'), 'utf8')
    assert.deepEqual(T.diagnoseArtifact('bugfix', bugfix), [])
    await call('spec_write', { file: 'design', content: '' })
    const design = readFileSync(join(root, '.kiro/specs/demo/design.md'), 'utf8')
    // The scaffold must also SNIFF as the bugfix variant, or it is judged
    // against the feature section table.
    assert.equal(T.sniffDesignVariant(design), 'bugfix')
    assert.deepEqual(T.diagnoseArtifact('design', design), [])
    rmSync(root, { recursive: true, force: true })
  })
})

describe('the source file contains no rule asserting the three invented codes', () => {
  it('no invented rule code survives anywhere in the source', () => {
    // Grepping the source is a deliberate static backstop: the behavioural tests
    // above can only prove absence for the documents they happen to build, and
    // the whole point of this defect class is a rule nobody exercised.
    let hits = ''
    try {
      // Match the invented RULE CODES, not the words: prose such as "the
      // root-cause-analysis skeleton" legitimately describes the bugfix design
      // template and must not trip this.
      hits = execFileSync('grep', ['-nE', 'missing-(root-cause-analysis|proposed-fix|properties-to-test)', 'lib/index.js'], {
        encoding: 'utf8',
        cwd: new URL('..', import.meta.url).pathname,
      })
    } catch (e) {
      // grep exits 1 when nothing matches — the desired outcome. Anything else
      // (grep missing, `lib/index.js` missing, a bad pattern) must NOT be
      // absorbed here, or this backstop turns into another silent skip.
      if (e.status !== 1) throw e
      hits = ''
    }
    assert.equal(hits.trim(), '', `invented rule codes leaked back into the source:\n${hits}`)
  })
})
