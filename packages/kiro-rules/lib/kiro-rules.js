// kiro-rules — Kiro's AUTHORITATIVE spec-validation rule table.
//
// This file is pure data + pure functions: no imports, no I/O, no side effects
// beyond freezing its own literals, so it is safe to import anywhere (including
// tests that only want the rule inventory).
//
// WHY THIS FILE EXISTS
// kiro.dev never documented the spec Markdown format. The only authority is the
// four `validate*Format` functions compiled into Kiro's shipped bundle:
//
//   /Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/
//     dist/extension.js
//
// (minified names bxd/Cxd/Ixd/Txd, dispatched by
// `validateSpecDocument(text, area, specType)`). `scripts/extract-kiro-rules.py`
// re-extracts those four bodies plus the bundle-wide `rule:"…"` literals.
// Re-verified 2026-02: the bundle contains exactly 41 such literals, ALL of them
// inside those four functions (requirements 7, design 15, tasks 13, bugfix 6).
//
// `KIRO_BUNDLE` below pins WHICH build of that bundle this table came from. No
// byte literal is kept here on purpose — this line used to say "12,978,019
// bytes", and that read like a version marker when it is not one: the bundle was
// rebuilt on 2026-09-11 (12,978,019 -> 12,978,260 bytes) with the extension
// version unchanged and all 41 codes identical.
//
// One audit note, because it looks alarming at first glance: the bundle ships
// that module TWICE, and BOTH copies are live — they just have different
// consumers. Re-verified on 1.1.28 (2026-09-16), names updated from the
// 1.0.794-era ones (f2u/h2u/m2u/g2u dispatched by A2u):
//
//   · copy 1 — GPd/HPd/VPd/WPd, dispatched by KPd, registered as
//     `validateSpecDocument`. Consumer: the IDE-side format diagnostics.
//   · copy 2 — lQu/uQu/dQu/pQu, dispatched by fQu. Consumer: the
//     agent-callable tool `validate_spec_format` ("Use this after a subagent
//     writes or fixes a spec document to check for format compliance"), which
//     resolves specType via the same `.config.kiro` reader.
//
// The two copies agree on every rule code, severity, message and pattern. The
// only differences are minified identifiers and the module alias for the
// spec-type enum — `pis.SpecType.Bugfix` (copy 1) vs `Mo.Bugfix` (copy 2),
// where `pis` is the module namespace re-exporting the same enum `Mo` that copy 2
// dereferences directly. Both evaluate to the string `"bugfix"`.
//
// The equality was MEASURED during the 1.1.28 upgrade, not assumed: for each of
// the four validators the ordered sequence of string literals + regex literals
// was extracted from both bodies and compared (template-literal `${…}`
// interpolations normalised to a placeholder, since those hold identifiers, not
// text) — all four matched exactly. That method does NOT cover property names,
// so the spec-type access was spot-checked by hand on top of it:
//   tasks  copy1 `e !== pis.SpecType.Bugfix`   copy2 `e !== Mo.Bugfix`
//   design copy1 `e === pis.SpecType.Bugfix`   copy2 `e === Mo.Bugfix`
//
// ✅ Both checks were pinned on 2026-09-16 by `test/kiro-copies-parity.test.mjs`
// (in THIS package — the pin lives with the claim it protects, and keeping it here
// is also what lets `package-shape.test.mjs` assert that nothing under
// `lib/` names a downstream package, comments included).
//
// That test locates each validator's two copies via a rule code unique to that
// validator, compares their ordered string+regex literal sequences, and
// **separately** compares the spec-type property names — the literal comparison
// cannot see `.Bugfix` vs `.Feature`, because property names are identifiers and get
// normalised away. It carries its own discriminating-power test on synthetic text,
// so "they agree" cannot pass vacuously.
//
// What a failure means: the extraction面 reads copy 1 while the agent tool runs
// copy 2, so the two would judge differently — a human must decide which one the
// rule table should follow, or record the divergence explicitly.
// (Before 2026-09-16 this was an open item: the verification was a throwaway
// script, so nothing in the repo would have said so.)
//
// So there are eight validator functions but still exactly four rule tables, and
// still exactly 41 codes. A previous version of this plugin invented generic
// `${kind}/missing-section` codes and three design sections Kiro never asks for;
// those are deliberately absent from every list below.
//
// MATCHING SEMANTICS (faithful, and they differ per area — do not generalise)
//   - Kiro normalises a line with an inline helper that is `String.prototype
//     .trimEnd()` — NOT `trim()`, despite what an earlier brief claimed. So a
//     LEADING space makes `## Overview` invisible to the requirements/tasks/
//     bugfix/design section tests, while trailing whitespace never matters.
//     Each rule below records which normalisation Kiro actually used via
//     `trimmed` (true = trimEnd(line), false = the RAW line, null = n/a).
//   - `design` section presence is NOT a per-name regex. Kiro captures
//     `/^##\s+(.+)$/` off the trimEnd'd line, lowercases the group, and compares
//     it to the lowercased section name. Hence `## Overview` and `## OVERVIEW`
//     both satisfy it, but a same-line suffix (`## Overview · 概述`) does not.
//     `name` + `pattern` below reproduce that comparison; `pattern` is the
//     equivalent self-contained regex for consumers that want one.
//   - `requirements` H1, `tasks` H1, `bugfix` section, and the design
//     "Correctness Properties" scan each have their own quirks; see the
//     per-area comments.
//   - `pattern` is the shape a document must SATISFY (the expected form) — null
//     when the rule is structural/positional with no single expected shape.
//     `detect` is the regex Kiro uses to FIND the offending construct, which for
//     `malformed-*` / `invalid-*` / `unexpected-section` rules is deliberately
//     NOT the expected form.
//
// `source` CONTRACT
//   'kiro-binary'    — Kiro itself enforces this code. All 41 are this.
//   'repo-convention'— this plugin's own addition. Never mixed into the 41;
//                      see REPO_CONVENTIONS at the bottom. A repo convention
//                      that fired as an `error` would make DSH reject a spec
//                      Kiro happily accepts.
//
// CONTENT SNIFFING (design only)
//   Kiro picks the design section table from the document content:
//   `specType === Bugfix || (specType === undefined && sniff(text))`. Note the
//   exact shape: an EXPLICIT non-bugfix specType (Feature / quick-spec) SKIPS
//   sniffing and forces the feature table. `sniffDesignVariant()` below is the
//   `specType === undefined` half — pure content sniffing, no type argument,
//   which is all this plugin needs.

// ---------------------------------------------------------------------------
// Shared helpers (pure).
// ---------------------------------------------------------------------------

// Deep-freeze the literal tables so a consumer cannot mutate the rule inventory
// by accident. RegExp objects tolerate being frozen.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

// De-duplicate rule entries by code, keeping the first occurrence (which fixes
// the reporting order — Kiro emits diagnostics in table order, so callers that
// iterate these arrays reproduce Kiro's output order exactly).
function uniqueByCode(rules) {
  const seen = new Set()
  const out = []
  for (const rule of rules) {
    if (seen.has(rule.code)) continue
    seen.add(rule.code)
    out.push(rule)
  }
  return out
}

// Build one Kiro-enforced rule. `area` is derived from the code prefix because
// that prefix is literally how Kiro namespaces the rule ("design/…" is design).
function kiroRule({
  code,
  severity,
  pattern = null,
  detect = [],
  display = null,
  message,
  variant = null,
  variants = null,
  name = null,
  trimmed = null,
  skippedForBugfix = false,
}) {
  return {
    code,
    area: code.split('/')[0],
    variant,
    variants,
    severity,
    source: 'kiro-binary',
    pattern,
    detect,
    display,
    message,
    trimmed,
    name,
    skippedForBugfix,
  }
}

// Kiro's `validateRequirementsFormat`. Two quirks worth keeping:
//   - the H1/section/acceptance-criteria tests run on the trimEnd'd line;
//   - the requirement-heading and `**User Story:**` tests run on the RAW line,
//     so an indented `### Requirement 1: …` is "malformed" to Kiro.
const REQUIREMENTS_RULES = [
  kiroRule({
    code: 'requirements/missing-title',
    severity: 'error',
    pattern: /^# Requirements Document$/,
    display: '# Requirements Document',
    message: 'Missing required heading: # Requirements Document',
    trimmed: true,
  }),
  kiroRule({
    code: 'requirements/missing-introduction',
    severity: 'error',
    pattern: /^## Introduction$/,
    display: '## Introduction',
    message: 'Missing required section: ## Introduction',
    trimmed: true,
  }),
  kiroRule({
    code: 'requirements/missing-glossary',
    severity: 'warning',
    pattern: /^## Glossary$/,
    display: '## Glossary',
    message: 'Missing recommended section: ## Glossary',
    trimmed: true,
  }),
  kiroRule({
    code: 'requirements/missing-requirements-section',
    severity: 'error',
    pattern: /^## Requirements$/,
    display: '## Requirements',
    message: 'Missing required section: ## Requirements',
    trimmed: true,
  }),
  // Fires when the loose form matches and the strict form does not, i.e. only
  // when a requirement heading is present but lacks `N:`.
  kiroRule({
    code: 'requirements/malformed-requirement-heading',
    severity: 'error',
    pattern: /^### Requirement \d+:/,
    detect: [/^### Requirement\b/],
    display: '### Requirement N: Title',
    message: 'Malformed requirement heading. Expected format: ### Requirement N: Title',
    trimmed: false,
  }),
  // Per requirement BLOCK (from the heading to the next `### ` heading). Warning
  // severity: a missing User Story is flagged, not fatal.
  kiroRule({
    code: 'requirements/missing-user-story',
    severity: 'warning',
    pattern: /\*\*User Story:\*\*/,
    display: '**User Story:**',
    message: 'Requirement block is missing **User Story:**',
    trimmed: false,
  }),
  kiroRule({
    code: 'requirements/missing-acceptance-criteria',
    severity: 'error',
    pattern: /^#### Acceptance Criteria$/,
    display: '#### Acceptance Criteria',
    message: 'Requirement block is missing #### Acceptance Criteria',
    trimmed: true,
  }),
]

// ---------------------------------------------------------------------------
// design — TWO section tables, selected by content sniffing.
//
// Three section rules are shared verbatim by both tables (overview,
// correctness properties, testing strategy); Kiro defines them twice, so they
// are defined once here and referenced from both arrays. Their `variant` is
// therefore null (only variant-EXCLUSIVE rules carry 'feature'/'bugfix') and
// `variants` lists both. Every design code stays unique: 7 + 8 - 3 = 12
// section codes, + 3 structural codes = the 15 design codes in the bundle.
//
// `display` note: Kiro's own table stores these WITHOUT the `## ` prefix (e.g.
// "Overview") and composes the message as `Missing ${required|recommended}
// section: ## ${display}`. `display` below carries the prefix — it is the
// literal line a document must contain — and `message` is that composed
// template, copied from the bundle verbatim. `name` is Kiro's lowercased
// comparison key, which is what decides whether a section counts as present.
// ---------------------------------------------------------------------------

const DESIGN_SECTION_OVERVIEW = kiroRule({
  code: 'design/missing-overview',
  severity: 'error',
  pattern: /^##\s+Overview$/i,
  display: '## Overview',
  name: 'overview',
  variants: ['feature', 'bugfix'],
  message: 'Missing required section: ## Overview',
  trimmed: true,
})

const DESIGN_SECTION_CORRECTNESS_PROPERTIES = kiroRule({
  code: 'design/missing-correctness-properties',
  severity: 'warning',
  pattern: /^##\s+Correctness Properties$/i,
  display: '## Correctness Properties',
  name: 'correctness properties',
  variants: ['feature', 'bugfix'],
  message: 'Missing recommended section: ## Correctness Properties',
  trimmed: true,
})

const DESIGN_SECTION_TESTING_STRATEGY = kiroRule({
  code: 'design/missing-testing-strategy',
  severity: 'warning',
  pattern: /^##\s+Testing Strategy$/i,
  display: '## Testing Strategy',
  name: 'testing strategy',
  variants: ['feature', 'bugfix'],
  message: 'Missing recommended section: ## Testing Strategy',
  trimmed: true,
})

// Kiro's feature table, in Kiro's own order.
const DESIGN_FEATURE_SECTIONS = [
  DESIGN_SECTION_OVERVIEW,
  kiroRule({
    code: 'design/missing-architecture',
    severity: 'error',
    pattern: /^##\s+Architecture$/i,
    display: '## Architecture',
    name: 'architecture',
    variant: 'feature',
    variants: ['feature'],
    message: 'Missing required section: ## Architecture',
    trimmed: true,
  }),
  kiroRule({
    code: 'design/missing-components',
    severity: 'error',
    pattern: /^##\s+Components and Interfaces$/i,
    display: '## Components and Interfaces',
    name: 'components and interfaces',
    variant: 'feature',
    variants: ['feature'],
    message: 'Missing required section: ## Components and Interfaces',
    trimmed: true,
  }),
  kiroRule({
    code: 'design/missing-data-models',
    severity: 'error',
    pattern: /^##\s+Data Models$/i,
    display: '## Data Models',
    name: 'data models',
    variant: 'feature',
    variants: ['feature'],
    message: 'Missing required section: ## Data Models',
    trimmed: true,
  }),
  DESIGN_SECTION_CORRECTNESS_PROPERTIES,
  kiroRule({
    code: 'design/missing-error-handling',
    severity: 'warning',
    pattern: /^##\s+Error Handling$/i,
    display: '## Error Handling',
    name: 'error handling',
    variant: 'feature',
    variants: ['feature'],
    message: 'Missing recommended section: ## Error Handling',
    trimmed: true,
  }),
  DESIGN_SECTION_TESTING_STRATEGY,
]

// Kiro's bugfix table, in Kiro's own order. Note `glossary` and
// `expected behavior` exist ONLY here — a feature design is not asked for them.
const DESIGN_BUGFIX_SECTIONS = [
  DESIGN_SECTION_OVERVIEW,
  kiroRule({
    code: 'design/missing-glossary',
    severity: 'warning',
    pattern: /^##\s+Glossary$/i,
    display: '## Glossary',
    name: 'glossary',
    variant: 'bugfix',
    variants: ['bugfix'],
    message: 'Missing recommended section: ## Glossary',
    trimmed: true,
  }),
  kiroRule({
    code: 'design/missing-bug-details',
    severity: 'error',
    pattern: /^##\s+Bug Details$/i,
    display: '## Bug Details',
    name: 'bug details',
    variant: 'bugfix',
    variants: ['bugfix'],
    message: 'Missing required section: ## Bug Details',
    trimmed: true,
  }),
  kiroRule({
    code: 'design/missing-expected-behavior',
    severity: 'error',
    pattern: /^##\s+Expected Behavior$/i,
    display: '## Expected Behavior',
    name: 'expected behavior',
    variant: 'bugfix',
    variants: ['bugfix'],
    message: 'Missing required section: ## Expected Behavior',
    trimmed: true,
  }),
  kiroRule({
    code: 'design/missing-hypothesized-root-cause',
    severity: 'error',
    pattern: /^##\s+Hypothesized Root Cause$/i,
    display: '## Hypothesized Root Cause',
    name: 'hypothesized root cause',
    variant: 'bugfix',
    variants: ['bugfix'],
    message: 'Missing required section: ## Hypothesized Root Cause',
    trimmed: true,
  }),
  DESIGN_SECTION_CORRECTNESS_PROPERTIES,
  kiroRule({
    code: 'design/missing-fix-implementation',
    severity: 'error',
    pattern: /^##\s+Fix Implementation$/i,
    display: '## Fix Implementation',
    name: 'fix implementation',
    variant: 'bugfix',
    variants: ['bugfix'],
    message: 'Missing required section: ## Fix Implementation',
    trimmed: true,
  }),
  DESIGN_SECTION_TESTING_STRATEGY,
]

// The design checks that do NOT depend on the variant: they all run inside the
// `## Correctness Properties` section. Kiro finds that section with a
// case-SENSITIVE, exact, trimEnd'd test (`/^## Correctness Properties$/`) —
// unlike the case-insensitive presence check above — and then scans the RAW
// lines below it.
const DESIGN_STRUCTURAL_RULES = [
  kiroRule({
    code: 'design/malformed-property-heading',
    severity: 'error',
    pattern: /^(?:### )?Property \d+:/,
    detect: [/^(?:### )?Property\b/],
    display: 'Property N: Title or ### Property N: Title',
    message: 'Malformed property heading. Expected format: Property N: Title or ### Property N: Title',
    variants: ['feature', 'bugfix'],
    trimmed: false,
  }),
  // Reported when the section exists but holds no `Property N:` heading.
  kiroRule({
    code: 'design/empty-correctness-properties',
    severity: 'warning',
    message: 'Correctness Properties section has no properties. Expected at least one Property N: heading',
    variants: ['feature', 'bugfix'],
  }),
  // Per-property block (heading to the next property heading / section end).
  kiroRule({
    code: 'design/missing-property-validates',
    severity: 'warning',
    pattern: /\*\*Validates:\s*Requirements\s+[\d.,\s]+\*\*/,
    display: '**Validates: Requirements X.Y**',
    message: 'Property is missing **Validates: Requirements X.Y** reference',
    variants: ['feature', 'bugfix'],
    trimmed: false,
  }),
]

// ---------------------------------------------------------------------------
// tasks — `validateTasksFormat`. Quirks that a "clean" reimplementation loses:
//   - the H1 test is a bare PREFIX match on the RAW line with no `$`, so
//     `# Implementation Plan for X` passes, and a leading space fails;
//   - `## `-heading detection inside the task scan is also a RAW `/^## /`;
//   - the checkbox class `[ x~-]` is Kiro's: `-` last in the class is a literal
//     hyphen, and `~` is a first-class status rather than a character the class
//     happens to accept — it is `queued`, one of the four values in Kiro's own
//     enum (`VIu`: Completed→"x", InProgress→"-", Queued→"~", NotStarted→" "),
//     and Kiro's write-back path produces `[~]` itself. This repo bans it as a
//     fourth state anyway, but that ban is a REPO CONVENTION, not a fact about
//     Kiro (2026-09-16, from a real-machine measurement). Both
//     `- [ ]* N.` and `- [ ]\* N.` parse because of `\\?\*?` (optional literal
//     backslash, then optional asterisk);
//   - `tasks/missing-dependency-graph` is SKIPPED when the spec type is bugfix
//     (and, since Kiro compares `specType === Bugfix`, it RUNS when the type is
//     undefined/unknown).
// ---------------------------------------------------------------------------

const TASKS_RULES = [
  kiroRule({
    code: 'tasks/missing-implementation-plan',
    severity: 'error',
    pattern: /^# Implementation Plan/,
    display: '# Implementation Plan',
    // The trailing colon in the message is Kiro's own (the pattern has none).
    message: 'Missing required heading: # Implementation Plan:',
    trimmed: false,
  }),
  kiroRule({
    code: 'tasks/missing-overview',
    severity: 'warning',
    pattern: /^## Overview$/,
    display: '## Overview',
    message: 'Missing recommended section: ## Overview',
    trimmed: true,
  }),
  kiroRule({
    code: 'tasks/missing-tasks-section',
    severity: 'warning',
    pattern: /^## Tasks$/,
    display: '## Tasks',
    message: 'Missing recommended section: ## Tasks',
    trimmed: true,
  }),
  // A task written as a heading instead of a checkbox. There is no valid shape
  // to satisfy, so the heading regex is the detector, not `pattern`.
  kiroRule({
    code: 'tasks/invalid-task-heading',
    severity: 'error',
    detect: [/^#{2,3} Task \d+/],
    message: 'Tasks must use checkbox format (- [ ] N. Description), not ## or ### headings',
    trimmed: false,
  }),
  // Scanned only inside `## Tasks`. `detect` is Kiro's malformed-checkbox probe
  // (`[^\] ]` = one char that is neither `]` nor a space, e.g. `[/]` or `[!]`);
  // `pattern` is the checkbox Kiro accepts. NOTE `- []` matches NEITHER, so Kiro
  // silently ignores it rather than reporting it.
  kiroRule({
    code: 'tasks/malformed-checkbox',
    severity: 'error',
    pattern: /^\s*- \[([ x~-])\]/,
    detect: [/^\s*- \[([^\] ])\]/],
    message: 'Malformed checkbox. Use - [ ] (unchecked) or - [x] (checked, lowercase)',
    trimmed: false,
  }),
  // Top-level (zero-indent) task lines: `h` in the bundle.
  kiroRule({
    code: 'tasks/invalid-task-line',
    severity: 'error',
    pattern: /^- \[([ x~-])\]\\?\*? \d+\./,
    message: 'Task line does not match expected format: - [ ] N. or - [x] N.',
    trimmed: false,
  }),
  // Indented lines: `m` in the bundle, which requires the dotted `N.M` id.
  kiroRule({
    code: 'tasks/invalid-subtask-line',
    severity: 'error',
    pattern: /^\s*- \[([ x~-])\]\\?\*? \d+\.\d+/,
    message: 'Sub-task line does not match expected format: - [ ] N.M or - [x] N.M',
    trimmed: false,
  }),
  kiroRule({
    code: 'tasks/missing-notes',
    severity: 'warning',
    pattern: /^## Notes$/,
    display: '## Notes',
    message: 'Missing recommended section: ## Notes',
    trimmed: true,
  }),
  kiroRule({
    code: 'tasks/missing-dependency-graph',
    severity: 'error',
    pattern: /^## Task Dependency Graph$/,
    display: '## Task Dependency Graph',
    message: 'Missing required section: ## Task Dependency Graph.',
    trimmed: true,
    // Kiro guards this one with `specType !== Bugfix`; a bugfix spec has no
    // dependency graph. The message's trailing period is Kiro's.
    skippedForBugfix: true,
  }),
  // The graph checks below run on the joined text of the graph section, in this
  // order: fence present -> fence non-empty -> JSON parses -> shape is valid.
  kiroRule({
    code: 'tasks/missing-dag-json',
    severity: 'error',
    pattern: /```json[\s\S]*?```/,
    message: 'Task Dependency Graph section is missing a JSON code block with wave definitions.',
    trimmed: false,
  }),
  kiroRule({
    code: 'tasks/empty-dag-json',
    severity: 'error',
    message: 'Task Dependency Graph JSON block is empty.',
  }),
  // Kiro only requires a non-empty `waves` ARRAY. It does not validate wave
  // ids/tasks — a malformed wave list is silently dropped at scheduling time,
  // which is why the repo conventions below re-check the same structure.
  kiroRule({
    code: 'tasks/invalid-dag-structure',
    severity: 'error',
    message: 'Task Dependency Graph must contain a non-empty "waves" array.',
  }),
  kiroRule({
    code: 'tasks/invalid-dag-json',
    severity: 'error',
    message: 'Task Dependency Graph contains invalid JSON.',
  }),
]

// ---------------------------------------------------------------------------
// bugfix — `validateBugfixFormat`. There is NO H1 rule here at all: Kiro never
// looks at the bugfix title, so every heading this validator requires is `##`
// or `###` and matched exactly (H3 suffix included) on the trimEnd'd line.
// ---------------------------------------------------------------------------

const BUGFIX_RULES = [
  kiroRule({
    code: 'bugfix/missing-introduction',
    severity: 'error',
    pattern: /^## Introduction$/,
    display: '## Introduction',
    message: 'Missing required section: ## Introduction',
    trimmed: true,
  }),
  kiroRule({
    code: 'bugfix/missing-bug-analysis',
    severity: 'error',
    pattern: /^## Bug Analysis$/,
    display: '## Bug Analysis',
    message: 'Missing required section: ## Bug Analysis',
    trimmed: true,
  }),
  kiroRule({
    code: 'bugfix/missing-current-behavior',
    severity: 'error',
    pattern: /^### Current Behavior \(Defect\)$/,
    display: '### Current Behavior (Defect)',
    message: 'Missing required section: ### Current Behavior (Defect)',
    trimmed: true,
  }),
  kiroRule({
    code: 'bugfix/missing-expected-behavior',
    severity: 'error',
    pattern: /^### Expected Behavior \(Correct\)$/,
    display: '### Expected Behavior (Correct)',
    message: 'Missing required section: ### Expected Behavior (Correct)',
    trimmed: true,
  }),
  kiroRule({
    code: 'bugfix/missing-unchanged-behavior',
    severity: 'error',
    pattern: /^### Unchanged Behavior \(Regression Prevention\)$/,
    display: '### Unchanged Behavior (Regression Prevention)',
    message: 'Missing required section: ### Unchanged Behavior (Regression Prevention)',
    trimmed: true,
  }),
  // Design-only sections leaking into a bugfix document. Kiro scans `##`/`###`
  // headings (RAW line, `/^#{2,3}\s+(.+)$/`), tests the captured text against
  // the five case-insensitive patterns in `detect`, and reports the FIRST hit
  // only (it breaks out of the loop).
  //
  // `message` is Kiro's template VERBATIM, including its minified placeholder:
  // `${d}` is the local holding the captured heading text (`u[1]` in the
  // bundle), so a consumer substitutes the heading it matched. It is left as
  // `${d}` rather than renamed so this string is byte-comparable with the
  // bundle; the placeholder also appears in sibling messages for other
  // document kinds that carry no rule code.
  kiroRule({
    code: 'bugfix/unexpected-section',
    severity: 'warning',
    detect: [
      /technical context/i,
      /implementation details/i,
      /architecture/i,
      /components and interfaces/i,
      /data models/i,
    ],
    message: 'Section "${d}" is a design-only section and does not belong in a bugfix document',
    trimmed: false,
  }),
]

// ---------------------------------------------------------------------------
// Content sniffing (design only).
// ---------------------------------------------------------------------------

// The four markers that make a design document the BUGFIX variant. Kiro tests
// them on the trimEnd'd line and stops at the first hit; the `(Bug|Fault)` and
// `/i` parts are Kiro's, and `Fault Condition` is the alternative some specs
// use. No caller-supplied type enters into this: a document containing any of
// these is a bugfix design regardless of how it was named.
const DESIGN_BUGFIX_MARKERS = [
  /^##\s+Bug Details$/i,
  /^##\s+Hypothesized Root Cause$/i,
  /^##\s+Fix Implementation$/i,
  /^###\s+(Bug|Fault) Condition$/i,
]

// -> 'bugfix' | 'feature'. Pure: no type argument, no state.
export function sniffDesignVariant(text) {
  const lines = String(text ?? '').split('\n')
  // trimEnd, not trim: Kiro's normaliser is `t.trimEnd()`.
  return lines.some((line) => DESIGN_BUGFIX_MARKERS.some((re) => re.test(line.trimEnd())))
    ? 'bugfix'
    : 'feature'
}

// ---------------------------------------------------------------------------
// The exported rule inventory.
// ---------------------------------------------------------------------------

// Every distinct Kiro rule, first occurrence wins (order = Kiro's table order).
const ALL_KIRO_RULES = uniqueByCode([
  ...REQUIREMENTS_RULES,
  ...DESIGN_FEATURE_SECTIONS,
  ...DESIGN_BUGFIX_SECTIONS,
  ...DESIGN_STRUCTURAL_RULES,
  ...TASKS_RULES,
  ...BUGFIX_RULES,
])

// All 41 codes, sorted, no duplicates. Derived from the tables above so it can
// never drift out of sync with them.
export const KIRO_RULE_CODES = Object.freeze(ALL_KIRO_RULES.map((rule) => rule.code).sort())

// The four validators' rule tables, grouped the way Kiro groups them. `design`
// is the only area with two variants: `feature` (7 section rules), `bugfix`
// (8 section rules) and the 3 variant-independent `structural` checks.
// `rulesFor()` composes those; the raw arrays keep Kiro's per-variant order.
export const KIRO_RULES = deepFreeze({
  requirements: REQUIREMENTS_RULES,
  design: {
    feature: DESIGN_FEATURE_SECTIONS,
    bugfix: DESIGN_BUGFIX_SECTIONS,
    structural: DESIGN_STRUCTURAL_RULES,
    // The sniffing markers, exported for callers that want to explain themselves.
    bugfixMarkers: DESIGN_BUGFIX_MARKERS,
  },
  tasks: TASKS_RULES,
  bugfix: BUGFIX_RULES,
})

// code -> entry, for lookups (every one of the 41 is a key).
const BY_CODE = {}
for (const rule of ALL_KIRO_RULES) BY_CODE[rule.code] = rule
export const KIRO_RULE_BY_CODE = deepFreeze(BY_CODE)

// The bundle contains exactly 41 distinct `rule:"…"` literals, and all 41 live
// inside the four `validate*Format` functions (verified with the extractor).
export const RULE_CODE_COUNT = 41

// Which Kiro build this table replicates. This package is a REPLICA, not the
// standard: a consumer has to be able to answer "does this match the Kiro I have
// installed", and without these fields the only way was a manual diff of prose.
//
// The three identity fields are deliberately redundant, and none alone suffices:
//   - `version` is kiro.kiro-agent's semantic version (NOT Kiro.app's — this
//     machine has Kiro.app 1.0.437 alongside extension 1.0.794);
//   - `bytes` is a cheap change detector that can fire with no rule change (see
//     the header: a 2026-09-11 rebuild moved it by 241 bytes while the extension
//     version stood still);
//   - `sha256` is the precise identity, but it is not comparable across builds.
// `extractedAt` is the ISO date these values were last taken from a machine —
// updated only when `version` or `sha256` changes, which is what keeps
// "re-run the extractor, paste, `git diff` is empty" true. Generate, never
// hand-write:
//   python3 scripts/extract-kiro-rules.py --emit-bundle-meta
export const KIRO_BUNDLE = Object.freeze({
  version: '1.1.28',
  bytes: 13161950,
  sha256: 'ce29c664ae8d69ef303a7b9b1e817871a93221f8ad2f5a42c7391775b8069d05',
  extractedAt: '2026-09-16',
})

// Rules for one area. `variant` only means anything for 'design':
//   - 'feature' / 'bugfix' -> that variant's section rules + the structural ones
//   - anything falsy       -> every design rule (the union), because a caller
//                             with no variant should not silently lose rules
// An unknown area returns [] — the same thing Kiro's own dispatcher does in its
// `default:` branch, and a diagnostics path should not throw on a bad argument.
export function rulesFor(area, variant) {
  if (area === 'requirements') return KIRO_RULES.requirements
  if (area === 'tasks') return KIRO_RULES.tasks
  if (area === 'bugfix') return KIRO_RULES.bugfix
  if (area === 'design') {
    const sections =
      variant === 'feature'
        ? KIRO_RULES.design.feature
        : variant === 'bugfix'
          ? KIRO_RULES.design.bugfix
          : uniqueByCode([...KIRO_RULES.design.feature, ...KIRO_RULES.design.bugfix])
    return uniqueByCode([...sections, ...KIRO_RULES.design.structural])
  }
  return []
}

// ---------------------------------------------------------------------------
// REPO CONVENTIONS — NOT Kiro rules. Separate on purpose: these must never be
// counted among the 41 and must never be emitted as Kiro errors, or DSH would
// reject specs Kiro accepts. `source` is always 'repo-convention'.
// ---------------------------------------------------------------------------

// `variant` is null for every entry (none of these is variant-scoped) and
// `pattern`/`detect` are RegExp-or-null like the Kiro entries so consumers can
// treat both lists uniformly.
function repoConvention({ code, severity, message, pattern = null, display = null }) {
  return {
    code,
    area: code.split('/')[0],
    variant: null,
    variants: null,
    severity,
    source: 'repo-convention',
    pattern,
    detect: [],
    display,
    message,
    trimmed: null,
    name: null,
    skippedForBugfix: false,
  }
}

export const REPO_CONVENTIONS = deepFreeze([
  // The repo asks design.md to open with `# Design Document`. Kiro has NO design
  // H1 rule whatsoever, so this is a convention and stays a WARNING: a design
  // document Kiro accepts must not be reported as an error here.
  repoConvention({
    code: 'design/missing-title',
    severity: 'warning',
    display: '# Design Document',
    pattern: /^# Design Document$/,
    message: 'No H1 title. Kiro does not require one for design.md; this repo convention asks for "# Design Document"',
  }),
  // A code fence that opens and never closes makes every following line look
  // like code, which silently hides headings and tasks from all the checks
  // above — worth surfacing even though Kiro says nothing about it.
  repoConvention({
    code: 'tasks/unterminated-fence',
    severity: 'warning',
    message:
      'A code fence is opened but never closed — every line after it is treated as code, ' +
      'so headings and tasks below it are ignored (which can undercount tasks and mask missing sections)',
  }),
  // Kiro's wave graph only has to be a non-empty array; these three re-check the
  // structure DSH's runner actually needs. Kiro drops a malformed wave list and
  // falls back to sequential execution, a silent loss of parallelism.
  repoConvention({
    code: 'tasks/waves-schema',
    severity: 'warning',
    message: 'Task Dependency Graph wave entries are missing the numeric "id" / string "tasks" fields this runner needs',
  }),
  repoConvention({
    code: 'tasks/waves-task-mismatch',
    severity: 'error',
    message: 'Task Dependency Graph does not cover every task exactly once',
  }),
  repoConvention({
    code: 'tasks/undeclared-task',
    severity: 'warning',
    message: 'Task Dependency Graph references a task id that has no checkbox line',
  }),
  // Two definitions of the same id resolve differently in the runner and in the
  // state writer, so this one is a hard error.
  repoConvention({
    code: 'tasks/duplicate-task-id',
    severity: 'error',
    message: 'Duplicate task id(s) — ids must be unique',
  }),
  // Kiro's task-line regexes only anchor the prefix, so a line can satisfy them
  // and still carry no description at all.
  repoConvention({
    code: 'tasks/invalid-task-body',
    severity: 'error',
    message: 'Task line has no description after its id',
  }),
  // Kiro does NOT merely "tolerate" `~` — it is `queued`, one of the four values
  // in Kiro's own status enum, and Kiro's write-back path produces `[~]` itself.
  // DSH's three-valued task state (pending / in-progress / done) has no slot for
  // it, so this ban is a **repo convention, not a fact about Kiro**.
  //
  // 措辞在这里是有后果的：写成「Kiro 不认它」会让人在**真机产出的语料**上判错 ——
  // 消费项目的 224 份 `tasks.md` 里有 3 处真实的 `[~]`（`example-spec-beta`），
  // 语义正是 `queued`。所以那句理由 2026-09-16 被订正，本轮只改措辞、不改归类（归类本来就对）。
  // 依据是 2026-09-16 的真机实测。
  repoConvention({
    code: 'tasks/too-many-units',
    severity: 'warning',
    message: 'Unrecognised task state — this repo allows only [ ], [-] and [x]',
  }),
])
