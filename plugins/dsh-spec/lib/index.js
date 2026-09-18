// dsh-spec — a cordis plugin replicating Kiro's Spec mechanism.
//
// Kiro specs are three markdown files that formalize a feature/bugfix:
//   1. requirements.md — user stories + acceptance criteria (EARS notation)
//   2. design.md      — architecture, data flow, error handling, testing
//   3. tasks.md       — a checkbox implementation plan (+ tasks.meta.json history)
//
// Specs live under `.kiro/specs/<feature>/` (Kiro's layout). A legacy single
// spec written directly at the configured `specDir` (e.g. `.spec/`) keeps working
// transparently; the first spec_init migrates to the `<feature>/` subdirectory
// layout by default.
//
// Task state is three-valued (Kiro): `- [ ]` pending, `- [-]` in-progress,
// `- [x]` done. A fourth state is rejected.
//
// This plugin enforces the three-stage order (requirements -> design -> tasks)
// through first-class tools, surfaces a human `/spec` command, and injects an
// always-on system-prompt section so the workflow is a standing constraint.
import { join, resolve, dirname, basename, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as kiroRules from '@my-harness/kiro-rules'
import { parseTaskLine } from '@my-harness/spec-parser'
import { hasUnterminatedFence, scanLines } from '@my-harness/spec-parser/scan-lines'
import { CONFIG_KIRO_FILE, parseConfigKiro, specTypeToKind } from '@my-harness/spec-parser/config-kiro'
// 二阶分析（第 2 期抽成共享包）。这五个模块不再住在本插件里：
// `packages/spec-analysis` 是它们的唯一实现，I/O 由 `lib/port.js` 注入。
import { runChecklist } from '@my-harness/spec-analysis/checklist'
import { runDrift as runDriftModule } from '@my-harness/spec-analysis/drift'
import { appendSignature, checkAttribution } from '@my-harness/spec-analysis/signature'
import { applyParamEdit, appendRequirement, appendDesignAmendment } from '@my-harness/spec-analysis/amendments'
import { archiveSpec } from '@my-harness/spec-analysis/archive'
// dual-hash（第 4 期抽成共享包）。dsh-spec 到本期为止**完全没有**它 ——
// 于是「这次写入有没有改变语义」无从判断，F11 的「已修」靠的是流程约定（拿掉并发写者），
// 不是机制。🔴 三个写入口一律显式传 `strictTaskState: false`（真机四字符类 `[ x~-]`）：
// 依赖默认值会让 dsh 侧静默走 kiro 的收紧策略，对 `[~]` 行判错审批指纹。
import { computeApprovalFingerprint, computeRawRevision } from '@my-harness/spec-revision'
import { createDshPort } from './port.js'
// 裁决层（第 3.5 期）。findings 组装逻辑的唯一实现；本文件只做壳 + 渲染。
// 这里的名字全部是 `__test` 从第 1 期起就暴露的（Req 7.2：一个不删），从共享包单一来源进来。
import {
  BUGFIX_SECTIONS,
  DESIGN_BUGFIX_SECTIONS,
  DESIGN_FEATURE_SECTIONS,
  LEGACY_CODE_REMAP,
  REPO_CODES,
  collectDesignSections,
  collectHeadings,
  diagnoseArtifact,
  diagnoseDependencyGraph,
  diagnoseDesignProperties,
  diagnoseTaskBody,
  diagnoseWavesConsistency,
  executableUnitCount,
  kiroTrim,
} from '@my-harness/spec-diagnose'

// Kiro's checkbox character class. `__test` has exposed this name since before the
// extraction, so it stays; the live definition (and the three-valued policy that
// uses it) lives in `@my-harness/spec-parser`.
const KIRO_CHECKBOX_CHARS = [' ', 'x', '~', '-']

// True when a design document is the BUGFIX variant. Kiro decides this by SNIFFING
// THE CONTENT, not by the caller's declared type, so a bugfix design must be
// recognised even when `diagnoseArtifact` is called with the generic 'design' kind.
//
// Delegates to the frozen rule table rather than re-deriving the sniff pattern:
// the table is the auditable artifact, and two copies of this predicate could drift
// into disagreeing about which table applies.
const sniffDesignVariant = kiroRules.sniffDesignVariant

const name = 'dsh-spec'
const inject = ['tools', 'systemPrompt', 'fs', 'subagents']

const SPEC_FILES = ['requirements', 'design', 'tasks']
const DEFAULT_SPEC_DIR = '.spec'
const DEFAULT_MARKERS = ['.git']
const META_FILE = 'tasks.meta.json'
//: `tasks.meta.json` 是**真机 1.1.28 之前**的执行历史形状（`{pbtResults, executionHistory}`），
//: 放在 spec 目录里。真机现在把它挪到了 `~/.kiro/tasks/<workspace-hash>/<feature>.meta.json`
//: （形状也不同），**本插件不写那个 store** —— 理由见 README 的「执行历史」段：
//: 那个 store 是 Kiro 自己的、它今天还在写、且它用自己的文件锁与 `slice(-10)`。
//: 保留旧位置是有意的：仓库语料里 **96/211** 个 spec 就带着这份文件，而仓库的原则是
//: `tasks.meta.json`「is NOT ours to reconstruct」。
//
//: 每条任务的记录上限，与真机**逐字一致**（旧代与新代 store 都在写入时
//: `length > 10 && slice(-10)`，两处独立实测）。跟它一致不是为了好看：我们写的是同一个
//: 文件、同一个字段，规则不同会让「这份文件里到底能有多少条」取决于最后写它的是谁。
const EXECUTION_HISTORY_CAP = 10
const ANALYSIS_FILE = 'bugfix.md'
const ACTIVE_FILE = '_active'
// Kiro's checkbox character class lives in KIRO_CHECKBOX_CHARS (see the rule
// table below); `[~]` parses but is banned by repo convention, `[/]`/`[!]` are
// malformed there. There is deliberately no separate three-value TASK_STATES
// list any more — one source of truth, so the parser and the diagnostics can
// never disagree (Req 1.13).
const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_MAX_CONTEXT_BYTES = 32000
// Real file names a legacy single spec may hold. NOTE the explicit `.md`: the
// original migration loop iterated the extension-less SPEC_FILES names and so
// silently copied nothing but bugfix.md. (Declared after ANALYSIS_FILE — these
// read it at module-initialisation time.)
const MIGRATABLE_FILES = ['requirements.md', 'design.md', 'tasks.md', ANALYSIS_FILE]
// File names `/spec view` may read. User-supplied, so an explicit allow-list
// rather than trusting the argument (it is joined onto the spec directory as
// `<file>.md`). `meta` is deliberately excluded: it lives at `tasks.meta.json`,
// not `meta.md`, and `spec_read file=meta` already serves it.
const VIEWABLE_FILES = [...SPEC_FILES, 'bugfix']

// ---------------------------------------------------------------------------
// Always-on system-prompt section (the behavioral constraint).
// ---------------------------------------------------------------------------
const SPEC_SECTION = [
  '## Spec-Driven Development',
  '',
  'For any non-trivial feature or bug fix, work through a formal spec under `<project>/.kiro/specs/<feature>/` BEFORE implementing. Four kinds:',
  '',
  '- **feature (requirements-first)** — `requirements.md` → `design.md` → `tasks.md`.',
  '- **feature (design-first)** — `design.md` → `requirements.md` (derived) → `tasks.md`, with High / Low Level Design detail.',
  '- **bugfix** — `bugfix.md` (Current / Expected / Unchanged Behavior) → `design.md` (root cause + properties to test) → `tasks.md`.',
  '- **quick** — no approval gates; all three files drafted in one pass.',
  '',
  'Requirements use EARS: feature `WHEN <condition> THE SYSTEM SHALL <behavior>`; bugfix uses `the system ...` with `SHALL CONTINUE TO <existing>` for regression protection.',
  '',
  'Task state is exactly three-valued: `- [ ]` pending, `- [-]` in-progress, `- [x]` done (a fourth state is rejected). No task may be left `[-]` at the end of a session.',
  '',
  'An `## Task Dependency Graph` in `tasks.md` encodes wave order (wave-serial, intra-wave concurrent) as `{"waves":[{"id":0,"tasks":["1","2"]},{"id":1,"tasks":["3"]}]}` — an object array (never a bare array), each wave carrying a numeric `id` starting at 0, and task ids written as STRINGS ("1", "1.1").',
  '',
  'Manage the spec with the spec tools: `spec_init` starts it (kind/workflow/detailLevel), `spec_write` writes one file (workflow-aware stage gating), `spec_read` reads a file, `spec_status` reports phase + progress, `spec_task_set` toggles a task checkbox, `spec_meta` reads/writes `tasks.meta.json` execution history. Update `tasks.md` as each task completes so progress stays tracked. Do not skip the phases for complex work. Run `spec_diagnostics` (or `/spec diagnose`) to lint the `##` headings, dependency-graph shape, and task states before finishing.',
].join('\n')

// ---------------------------------------------------------------------------
// Templates (Kiro-style skeletons).
// ---------------------------------------------------------------------------
// requirements.md — feature (Requirements-First). Kiro diagnostic requires
// `## Introduction` / `## Requirements` exact English headings; EARS uses
// uppercase `THE SYSTEM SHALL`.
function requirementsTemplate(goal) {
  return [
    '# Requirements Document',
    '',
    '## Introduction',
    '',
    '> 背景与目标',
    '',
    (goal || '').trim() || '<goal>',
    '',
    '## Glossary',
    '',
    '> 术语',
    '',
    '## Requirements',
    '',
    '> 需求条目',
    '',
    '### 1. <requirement title>',
    '**User Story:** As <persona>, I want <capability>, so that <benefit>.',
    '',
    '#### Acceptance Criteria',
    '1. WHEN <condition> THE SYSTEM SHALL <behavior>',
    '2. WHEN <condition> THE SYSTEM SHALL <behavior>',
    '',
  ].join('\n')
}

// bugfix.md — bugfix Analysis artifact. Kiro uses `bugfix.md` (NOT
// requirements.md) and its validator requires these EXACT headings:
//   H2 `## Introduction`, H2 `## Bug Analysis`, then three **H3** sections whose
//   parenthetical suffixes are part of the pattern:
//   `### Current Behavior (Defect)`, `### Expected Behavior (Correct)`,
//   `### Unchanged Behavior (Regression Prevention)`.
// There is NO H1 rule. The previous template emitted `# Bug Analysis` plus H2
// `## Current Behavior` / `## Expected Behavior` / `## Unchanged Behavior`,
// which Kiro rejects four ways at once — so every bugfix spec this plugin
// scaffolded was born non-conformant (Req 1.1-1.3). EARS uses lowercase `the
// system` with `SHALL CONTINUE TO` for regression protection.
function bugfixTemplate(goal) {
  return [
    '# Bugfix Requirements Document',
    '',
    '## Introduction',
    '',
    '> 缺陷概述',
    '',
    (goal || '').trim() || '<bug description: reproduction steps + current + expected>',
    '',
    '## Bug Analysis',
    '',
    '> 缺陷分析',
    '',
    '### Current Behavior (Defect)',
    '',
    '> 缺陷（当前错误行为）',
    '',
    '1. WHEN <condition> THEN the system <incorrect behavior>',
    '',
    '### Expected Behavior (Correct)',
    '',
    '> 正确行为',
    '',
    '1. WHEN <condition> THEN the system SHALL <correct behavior>',
    '',
    '### Unchanged Behavior (Regression Prevention)',
    '',
    '> 回归防护（什么必须保持不变）',
    '',
    '1. WHEN <condition> THEN the system SHALL CONTINUE TO <existing behavior>',
    '',
  ].join('\n')
}

// design.md — feature design. `## Overview` / `## Architecture` /
// `## Data Models` / `## Components and Interfaces` / `## Error Handling` /
// `## Testing Strategy` / `## Correctness Properties` (Kiro diagnostic headings).
// detailLevel: 'high' (architecture) or 'low' (implementation detail).
function designTemplate(detailLevel = 'high') {
  const segments = [
    '# Design Document',
    '',
    '> 概述：架构与实现方案',
    '',
    '## Overview',
    '',
    '> 概述',
    '',
  ]
  if (detailLevel === 'low') {
    segments.push(
      '<detailed algorithm pseudocode and key data structures>',
      '',
    )
  } else {
    segments.push(
      '<system architecture and component design>',
      '',
    )
  }
  segments.push(
    '## Architecture',
    '',
    '> 架构',
    '',
    '<system architecture>',
    '',
    '## Components and Interfaces',
    '',
    '> 组件与接口',
    '',
    '<components and their interactions>',
    '',
    '## Data Models',
    '',
    '> 数据模型',
    '',
    '<data models and interfaces>',
    '',
    '## Sequence',
    '',
    '```mermaid',
    'sequenceDiagram',
    '    participant A',
    '    participant B',
    '    A->>B: <replace with the real interaction>',
    '```',
    '',
    '## Error Handling',
    '',
    '> 错误处理',
    '',
    '<error handling strategy>',
    '',
    '## Testing Strategy',
    '',
    '> 测试策略',
    '',
    '<testing strategy>',
    '',
    '## Correctness Properties',
    '',
    '> 正确性属性',
    '',
    // Kiro's design validator looks for `Property N:` headings (bare or `###`)
    // and warns `design/empty-correctness-properties` when it finds none. The
    // repo's `*For any*` prose convention is still the body style, but the
    // heading must be a real `Property N:` line or the section reads as empty.
    '### Property 1: <property name>',
    '',
    '*For any* <premise>, <property holds>.',
    '',
    '**Validates: Requirements 1.1**',
    '',
  )
  return segments.join('\n')
}

// design.md — the BUGFIX variant. Kiro's design validator picks this table by
// sniffing the content for `## Bug Details` / `## Hypothesized Root Cause` /
// `## Fix Implementation` / `### (Bug|Fault) Condition`, and the scaffold must
// therefore carry at least one of them or the file is judged against the
// FEATURE table (Req 1.4).
//
// Required here: `## Overview`, `## Bug Details`, `## Expected Behavior`,
// `## Hypothesized Root Cause`, `## Fix Implementation` (all error).
// Recommended: `## Glossary`, `## Correctness Properties`, `## Testing Strategy`.
//
// The previous scaffold emitted `## Root Cause Analysis` / `## Proposed Fix` /
// `## Properties to Test`, none of which appear anywhere in the Kiro bundle,
// while omitting `## Bug Details` and `## Fix Implementation` — so it was
// simultaneously inventing three sections and missing two (Req 1.5, 1.6).
function bugfixDesignTemplate() {
  return [
    '# Design Document',
    '',
    '> 缺陷修复设计：根因分析与修复方案',
    '',
    '## Overview',
    '',
    '> 概述',
    '',
    '<what is broken, and the shape of the fix>',
    '',
    '## Glossary',
    '',
    '> 术语',
    '',
    '<terms this fix introduces or redefines>',
    '',
    '## Bug Details',
    '',
    '> 缺陷细节',
    '',
    '### Formal Specification',
    '',
    '<the defect stated precisely enough to be falsifiable>',
    '',
    '### Examples',
    '',
    '<concrete inputs that expose it>',
    '',
    '## Expected Behavior',
    '',
    '> 正确行为',
    '',
    '<behavior after the fix>',
    '',
    '## Hypothesized Root Cause',
    '',
    '> 根因（假设）',
    '',
    '<the mechanism believed to cause the defect, with the evidence for it>',
    '',
    '## Fix Implementation',
    '',
    '> 修复实现',
    '',
    '<the change, per component>',
    '',
    '## Correctness Properties',
    '',
    '> 正确性属性',
    '',
    '### Property 1: 缺陷存在（修复前必红）',
    '',
    '<property proving the bug>',
    '',
    '**Validates: Requirements 1.1**',
    '',
    '### Property 2: 修复生效',
    '',
    '<property proving the fix>',
    '',
    '**Validates: Requirements 1.2**',
    '',
    '### Property 3: 无回归',
    '',
    '<property proving unchanged behavior still holds>',
    '',
    '**Validates: Requirements 1.3**',
    '',
    '## Testing Strategy',
    '',
    '> 测试策略',
    '',
    '<testing strategy (incl. property-based tests)>',
    '',
  ].join('\n')
}

function tasksTemplate() {
  return [
    '# Implementation Plan',
    '',
    '> 实施计划',
    '',
    '## Overview',
    '',
    '> 概述',
    '',
    '<implementation overview>',
    '',
    '## Task Dependency Graph',
    '',
    '```json',
    '{',
    '  "waves": [',
    '    { "id": 0, "tasks": ["1.1"] }',
    '  ]',
    '}',
    '```',
    '',
    '## Tasks',
    '',
    '> 任务清单',
    '',
    '- [ ] 1. <feature area>',
    '- [ ] 1.1 <task description>',
    '  - <implementation step>',
    '  - _Requirements: 1.1_',
    '',
    // `## Notes` is not decoration: the signature channel (spec-conventions
    // §4.3.2, enforced by signature.js) REQUIRES it, and amendments.js points
    // callers at it when refusing a task-body edit. Omitting it from the scaffold
    // made every freshly created spec unsignable until a human added the section.
    '## Notes',
    '',
    '> 备注',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Pure / filesystem helpers.
// ---------------------------------------------------------------------------
function projectRootOf(cwd, markers) {
  let dir = resolve(cwd || process.cwd())
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(cwd || process.cwd())
}

function cwdOf(holder) {
  return holder?.agent?.session?.header?.cwd
}

async function readSpecFile(ctx, abs) {
  const target = await ctx.fs.resolve(abs)
  const info = await ctx.fs.stat(target)
  if (!info) return undefined
  return ctx.fs.readText(target)
}

async function writeSpecFile(ctx, abs, content, exec, expectedRawRevision) {
  const target = await ctx.fs.resolve(abs)
  // Thread the calling session's sandbox policy through to the fs mutation,
  // mirroring dsh-tool-fs. Without it, a sandboxed ctx.fs falls back to the
  // deployment default policy and its workspace ROOT (not the session cwd),
  // which would deny every write to the project even in workspace-write mode.
  const policy = sessionSandboxPolicy(ctx, exec)
  const expected = await writeIntentFor(ctx, target, expectedRawRevision)
  await ctx.fs.writeText(target, content, expected, undefined, policy)
  return content.length
}

// ── CAS：写盘的**唯一**守卫（第 7 期 Task 5）─────────────────────────────────
//
// F11 报告的原话是「`writeText` 的 `expected` 参数传的是 `undefined`」。这里把它接上。
//
// 🔴 「不传」的语义**照抄共享层**，不发明第三种（Task 5 Step 3）。共享层
// （`packages/spec-state/lib/storage.mjs`）的判据是
// `(current ? computeRawRevision(current) : undefined) !== expectedRawRevision`，
// 也就是：
//
//   expectedRawRevision === null        → 「我预期这个文件还不存在」→ createIfAbsent
//   expectedRawRevision === 'sha256:…'  → 「我预期它的字节是这个」  → 先比对，匹配再 replaceIfVersion
//   **省略**                            → 调用点没有表态。此时基线是**此刻**观测到的版本，
//                                         挡住「此刻 → 写」之间插进来的写，但不断言更早的读取。
//
// 第三态是 dsh 特有的必要补充：这个插件有 12 个写调用点，其中多数（历史迁移、脚手架、
// 归档）本来就是「不存在才写」，让它们逐个改签名会把一次契约变更摊成十二次。
// 但必须强调：**「省略」不等于「无条件覆盖」** —— 它仍然会过 DSH 原生的版本守卫
//（`ctx.fs.writeText` 的 `FsWriteIntent`），所以 `undefined` 不再等于「不校验」。
//
// 读-改-写的调用点**必须**把自己读到的结果当基线显式传进来（`baselineOf(读到的内容)`），
// 否则「读完 → 写之前」那段窗口里的并发写仍会被静默覆盖。对照实测见
// `test/write-cas.test.mjs` 的第二个用例：不传基线的 `setTaskState` 在窗口里被人插一刀时
// 必须失败；修复前它是红的。
async function writeIntentFor(ctx, target, expectedRawRevision) {
  if (expectedRawRevision === null) {
    // 「我预期它还不存在」。自己先判一次，是为了让**错误码与共享层一致**
    //（`REVISION_CONFLICT`），而不是把这件事留给后端报成它自己的 `FS_NOT_OBSERVED`：
    // 同一个语义在两个宿主上给出两个错误码，调用方就没法写一份代码。
    if ((await ctx.fs.stat(target)) !== undefined) {
      throw revisionConflict('the file already exists, but expectedRawRevision said it should not')
    }
    return { kind: 'createIfAbsent' }
  }
  const info = await ctx.fs.stat(target)
  if (info === undefined) {
    if (expectedRawRevision === undefined) return { kind: 'createIfAbsent' }
    throw revisionConflict(`the file does not exist, but expectedRawRevision ${JSON.stringify(expectedRawRevision)} was asserted`)
  }
  const currentRawRevision = computeRawRevision(await ctx.fs.readText(target))
  if (expectedRawRevision !== undefined && expectedRawRevision !== currentRawRevision) {
    throw revisionConflict(`expectedRawRevision ${expectedRawRevision} does not match the current ${currentRawRevision}`)
  }
  return { kind: 'replaceIfVersion', version: info.version }
}

/** 与共享层同形的错误：`code` 供程序判定，message 供人读。 */
function revisionConflict(detail) {
  return Object.assign(
    new Error(`REVISION_CONFLICT: ${detail}. 文件在读取之后被别人改过 —— 重新读取，不要基于旧内容回写。`),
    { code: 'REVISION_CONFLICT' },
  )
}

/** 一次「读-改-写」的调用点应当传的基线：拿它刚读到的那份内容算。 */
function baselineOf(content) {
  return content === undefined ? null : computeRawRevision(content)
}

// Resolve the per-session sandbox policy for a mutation, or undefined when no
// confining filesystem is mounted (an unsandboxed ctx.fs ignores the extra
// policy arg). Mirrors dsh-tool-fs's FsSandboxController.resolvePolicy: the
// session's header.cwd becomes the workspace-write ROOT, so writes under the
// project (e.g. .kiro/specs/) pass containment.
function sessionSandboxPolicy(ctx, exec) {
  if (typeof ctx.fs?.sandboxMode === 'undefined') return undefined
  let policy
  try { policy = ctx.get('sandboxPolicy') } catch { return undefined }
  if (!policy || typeof policy.resolve !== 'function') return undefined
  const session = exec?.agent?.session
  return session ? policy.resolve({ session }) : undefined
}

// Phase depends on spec kind/workflow. `present` carries file presence flags
// plus an optional `workflow` string.
function phaseOf(present) {
  if (present.bugfix) {
    // bugfix: analysis(bugfix.md) -> design -> tasks
    if (!present.design) return 'analysis'
    if (!present.tasks) return 'design'
    if (present.tasksTotal > 0 && present.tasksDone >= present.tasksTotal) return 'complete'
    return 'tasks'
  }
  if (present.workflow === 'design-first') {
    // design -> requirements -> tasks
    if (!present.design) return 'none'
    if (!present.requirements) return 'design'
    if (!present.tasks) return 'requirements'
    if (present.tasksTotal > 0 && present.tasksDone >= present.tasksTotal) return 'complete'
    return 'tasks'
  }
  // default feature: requirements -> design -> tasks
  if (!present.requirements) return 'none'
  if (!present.design) return 'requirements'
  if (!present.tasks) return 'design'
  if (present.tasksTotal > 0 && present.tasksDone >= present.tasksTotal) return 'complete'
  return 'tasks'
}

// ---------------------------------------------------------------------------
// Line scanning now lives in the shared package (`@my-harness/spec-parser`), so
// that dsh-spec and codex-spec judge fences one way instead of two. `scanLines`
// and `hasUnterminatedFence` are imported above.
//
// ⚠️ The fence semantics are kiro's indentation-aware ones, which changes this
// host on two shapes (neither is covered by an assertion here):
//   · a fence indented by >= 4 whose close cannot be recognised (no smaller-indent
//     task in between) is not treated as a fence at all — the lines after it ARE
//     counted, where this plugin used to skip them;
//   · a closing run must be the same character AND at least as long as the
//     opening one, so ``` no longer closes ```` — those lines ARE skipped.
// The direction was chosen because `plugins/codex-spec/lib/core/revision.mjs`
// consumes the same primitives to compute approval fingerprints.
// ---------------------------------------------------------------------------

// Kiro's four task-line regexes, transcribed VERBATIM from the bundle. They are
// kept as separate constants (rather than folded into one clever pattern)
// because the diagnostics must reproduce Kiro's verdict exactly, and Kiro's own
// verdict is a three-way branch over these four tests:
//
//   if (A.test(line) && !g.test(line)) -> malformed-checkbox
//   if (!g.test(line))                 -> not a task at all, ignore
//   depth === 0 ? (h.test || m.test) : m.test
//
// `h` requires a trailing DOT on a top-level id (`1.`), while `m` does not on a
// sub-task id (`1.1`). Getting that asymmetry wrong in either direction is
// observable: too strict silently DROPS legal tasks, too lenient never reports
// `N.`-less lines that Kiro rejects.
const KIRO_TASK_TOP_RE = /^- \[([ x~-])\]\\?\*? \d+\./
const KIRO_TASK_SUB_RE = /^\s*- \[([ x~-])\]\\?\*? \d+\.\d+/
const KIRO_CHECKBOX_RE = /^\s*- \[([ x~-])\]/
const KIRO_MALFORMED_CHECKBOX_RE = /^\s*- \[([^\] ])\]/

// Match a task checkbox line: `- [<state>] N. text` (integer parent id) or
// `- [<state>] N.M text` (dotted leaf id, Kiro's `N.`/`N.M` numbering).
//
// Match a task checkbox line, and turn the shared identification layer's unified
// result back into this plugin's historical field names.
//
// This is a **projection**: it renames fields (`id`→`index`, `title`→`text`) and
// carries `state`/`valid` through verbatim. It contains NO decision logic — that
// is what keeps the 209 existing assertions in this plugin untouched. The
// equivalence is pinned by a test in the shared package (`Property 5`).
//
// The old inlined parser here accepted any single-character state and reported
// legality through `valid`, so a fourth-state line (`[/]`, `[!]`) is still a
// repairable entry rather than a dropped line.
function parseTask(text) {
  const parsed = parseTaskLine(text, { strictTaskState: false })
  if (parsed === undefined) return undefined
  return { index: parsed.id, text: parsed.title, state: parsed.state, valid: parsed.valid }
}

// Render a task id for display: `1.` for integer ids, `1.1` for dotted ids.
function formatTaskId(id) {
  return /^\d+$/.test(String(id)) ? `${id}.` : id
}

// Ids of tasks that group subtasks (a task is a parent when some other task id
// is `<id>.`-prefixed). A parent is a grouping label, not work: the wave runner
// only walks the dependency graph, so a parent that is not itself listed there
// is never dispatched and never marked. Counting it in the denominator would
// make `complete` unreachable for the plugin's own generated template
// (`- [ ] 1. <area>` + `- [ ] 1.1 <task>` with only `1.1` in the graph).
function parentTaskIds(entries) {
  const parents = new Set()
  for (const e of entries) {
    const dot = e.index.lastIndexOf('.')
    if (dot !== -1) parents.add(e.index.slice(0, dot))
  }
  return parents
}

// Task ids defined more than once. Duplicates are ambiguous: `buildWavePlan`
// would take the last definition (Map overwrite) while `setTaskState` edits the
// FIRST matching line, so the runner could execute one task while marking
// another. Callers refuse rather than guess.
function duplicateTaskIds(entries) {
  const seen = new Set()
  const dupes = new Set()
  for (const e of entries) {
    if (seen.has(e.index)) dupes.add(e.index)
    seen.add(e.index)
  }
  return [...dupes]
}

function taskStats(tasks) {
  const entries = parseTaskList(tasks)
  const parents = parentTaskIds(entries)
  let total = 0
  let done = 0
  let active = 0
  for (const e of entries) {
    if (parents.has(e.index)) continue // grouping label, not countable work
    total += 1
    if (!e.valid) continue // fourth state: outstanding, but neither done nor active
    if (e.state === 'x') done += 1
    else if (e.state === '-') active += 1
  }
  return { total, done, active }
}

// Find the next task to work on: prefer the first in-progress `[-]` task,
// otherwise the first pending `[ ]` task. Grouping parents and tasks in an
// unknown (fourth) state are skipped — neither is actionable work.
function nextTask(tasks) {
  const entries = parseTaskList(tasks)
  const parents = parentTaskIds(entries)
  let firstPending = null
  for (const e of entries) {
    if (parents.has(e.index) || !e.valid) continue
    if (e.state === '-') return { index: e.index, text: e.text }
    if (e.state === ' ' && firstPending === null) firstPending = { index: e.index, text: e.text }
  }
  return firstPending
}

// ---------------------------------------------------------------------------
// Task Dependency Graph (waves). Kiro encodes wave order in tasks.md under
// `## Task Dependency Graph` as a JSON fenced block of the shape
// `{ "waves": [{ "id": 0, "tasks": ["1.1", "3.1"] }] }` — waves are an OBJECT
// ARRAY (never a bare `[[1,2],[3]]`), each wave has a numeric `id`, and the
// task ids are STRINGS ("1.1").
//
// Verified against the real machine (kiro-agent 1.0.794,
// `kiro.kiro-agent/dist/extension.js`), not inferred: the parse-time validator
// rejects, with one distinct message each, a bare array, a wave that is not an
// object, a wave whose `id` is absent or not a `number` (the string "0" is
// rejected too), and any task id that is not a `string`. Any one of these makes
// the scheduler log `DAG pipeline: parse error, using sequential ordering` and
// substitute a one-task-per-wave graph, i.e. the whole graph is discarded and
// all parallelism is lost — silently, with no user-visible error. Kiro's own
// spec linter does NOT check either rule (its `tasks/invalid-dag-structure`
// only asserts that `waves` is a non-empty array), which is why DSH checks them
// here. Kiro also renumbers wave ids by array index, so a wave's `id` must be
// present and numeric but its actual value carries no meaning.
//
// Evidence: an executed extraction against the real machine (2026-09-16).
// ---------------------------------------------------------------------------

// Extract and parse the dependency graph from tasks.md. Returns `undefined`
// when no `## Task Dependency Graph` section is present — a degenerate state
// whose reading the repo CHOSE on 2026-09-16: **strictly serial, one task at a
// time** (`buildWavePlan`). The comment used to say "all tasks in one wave, or
// no parallelism", i.e. the two readings sat there undecided; 真机 takes the
// serial one. Throws on a malformed graph.
const GRAPH_HEADING = '## Task Dependency Graph'

function parseDependencyGraph(tasksContent) {
  // EXACT heading match, identical to the diagnostics' rule: a substring hit
  // such as `## Task Dependency Graph Notes` must not count as the graph
  // section while the diagnostics report that same section as missing.
  const lines = scanLines(tasksContent)
  const start = lines.findIndex((l) => !l.inFence && kiroTrim(l.raw) === GRAPH_HEADING)
  if (start === -1) return undefined

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^## /.test(kiroTrim(lines[i].raw))) {
      end = i
      break
    }
  }
  // Find the first ```json fenced block within the section.
  //
  // 🔴 **必须与 `@my-harness/spec-diagnose` 的 `diagnoseDependencyGraph` 用同一条正则**
  // （`packages/spec-diagnose/lib/diagnose.js:289/361/510`，都要求显式 `json`）。
  // 这里曾经是 `/```(?:json)?\s*\n([\s\S]*?)```/`，`json` 可省略 —— 于是段里若先出现一个
  // **裸围栏**的示例块，runner 绑到示例块、诊断层绑到 json 块，两者对「图在哪」的判断不一致。
  // 实测过两种后果（2026-09-12）：
  //   · 示例块里的 id 不存在 → 文档校验全绿，而 `buildWavePlan` 抛 "task 9.9 … not defined"；
  //   · 示例块里的 id 真实存在但波次不同 → **文档校验全绿、runner 静默只跑示例块那几个任务、
  //     零 warning** —— 正是 REVIEW-20260910 F2 说的「少算比多算危险」那一族。
  // 第 3.5 期已经把 spec-diagnose 一侧收紧并写明理由，这一侧当时被落下了。
  // 收紧的语料影响：222 份带图段的 tasks.md 上，两条正则**绑到同一块**，0 份行为改变。
  const section = lines.slice(start, end).map((l) => l.raw).join('\n')
  const fence = /```json\s*\n?([\s\S]*?)```/.exec(section)
  if (!fence) {
    throw new Error('## Task Dependency Graph present but no ```json fenced block found (the block must be tagged `json`; it must contain {"waves":[{"id":0,"tasks":["1"]},...]})')
  }
  let parsed
  try {
    parsed = JSON.parse(fence[1])
  } catch {
    throw new Error('## Task Dependency Graph contains invalid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.waves)) {
    throw new Error('## Task Dependency Graph must be an object with a "waves" array: {"waves":[{"id":0,"tasks":["1"]},...]} (not a bare array)')
  }
  const warnings = []
  const waves = parsed.waves.map((w, i) => {
    if (w === null || typeof w !== 'object' || !Array.isArray(w.tasks)) {
      throw new Error(`wave ${i} must be {"id":<number>,"tasks":["1.1",...]}; got a non-object or missing tasks array`)
    }
    // Kiro discards the whole graph and falls back to sequential when a wave
    // lacks a numeric `id`, or when task ids are numbers instead of strings.
    // Neither breaks DSH's own runner (`String(n)` below normalises ids, and
    // `wave.id` is not read by buildWavePlan), so these surface as warnings
    // rather than errors: the spec still runs here, it just loses its
    // parallelism once Kiro reads the same file.
    if (typeof w.id !== 'number') {
      warnings.push(`wave ${i} is missing a numeric "id" (Kiro rejects the graph and falls back to sequential)`)
    }
    const tasks = w.tasks.map((n) => {
      if (typeof n === 'number') {
        warnings.push(`wave ${i} uses numeric task id ${n} (Kiro requires string ids and falls back to sequential)`)
      }
      const id = String(n)
      if (!/^\d+(\.\d+)*$/.test(id)) {
        throw new Error(`wave ${i} contains invalid task id "${id}"; expected string ids like "1.1" (or integers)`)
      }
      return id
    })
    // De-dupe within a wave while preserving order.
    return [...new Set(tasks)]
  })
  if (waves.length === 0) {
    // NOT the same as omitting the graph. Returning `undefined` here would make
    // buildWavePlan schedule **every task, one at a time**, silently running the
    // whole spec — that is exactly the silent degradation this file guards
    // against elsewhere.
    //
    // 🔴 措辞订正（2026-09-16 晚，整体 review 时发现）：这句原先写作「省略图会把全部任务
    // 塞进**一个 wave**」—— 那是 T7 **之前**的语义。T7 把「无图」裁决成
    // 「一任务一波（严格串行）」之后，这句话就成了**对用户说的错话**：
    // 它让人以为省略图会跑并发，而事实相反。两态现在的区别是
    // 「什么都不调度」vs「全部调度、但一次一个」，**不是**「串行 vs 并发」。
    warnings.push('"waves" is an empty array — no tasks are declared, so nothing will be scheduled (this is NOT the same as omitting the graph, which schedules every task but runs them one at a time)')
  }
  return { waves, warnings }
}

// Parse the full task list from tasks.md into structured entries, capturing
// each task's number, title, state, and its indented detail lines (the
// implementation steps and `_Requirements:` references that follow it).
function parseTaskList(tasksContent) {
  const entries = []
  let current = undefined
  for (const { raw, inFence } of scanLines(tasksContent)) {
    // A checkbox inside a fenced example is not a task. Beyond that the whole
    // document is scanned on purpose: a real spec in this repo appends follow-up
    // tasks under its own `## Review Follow-up` heading, and scoping the parse to
    // `## Tasks` would silently drop them. Un-numbered prose checklists (the
    // common case in `## Overview`) are excluded by the shared line pattern
    // requiring an id.
    if (inFence) continue
    const t = parseTask(raw)
    if (t) {
      if (current) entries.push(current)
      current = { index: t.index, text: t.text, state: t.state, valid: t.valid, detail: [] }
    } else if (current && /^\s{2,}\S/.test(raw)) {
      // an indented detail line belonging to the current task
      current.detail.push(raw.trim())
    } else if (current && raw.trim() === '') {
      // blank line: keep collecting; detail lines may be separated
    } else if (current && /^\s*---\s*$/.test(raw)) {
      // horizontal rule ends a task block
      entries.push(current)
      current = undefined
    }
  }
  if (current) entries.push(current)
  return entries
}

// A task is "pending work" if it is in the graph and not already done ([x]).
// In-progress [-] counts as pending (it hasn't finished). Tasks not listed in
// the graph are ignored by the wave runner (they have no declared wave).
//
// Returns `{ waves, warnings }`.
//
// 🔴 「没有图」这一态 2026-09-16 **真机裁决为严格串行**。三条理由：
//
//   ① **真机就是串行**：无图时 `getReadyTasksSequential()` 只返回**第一个** ready 叶子，
//      一次一个；有 wave 信息才允许多路。本仓此前把它当成「一个 wave 装下全部任务」→
//      在 `maxConcurrency` 内并发，是对着干的。
//   ② **诊断器与 runner 自相矛盾**：`tasks/missing-dependency-graph` 在真机与本仓表里
//      **都是 `severity: "error"`** —— 缺图是「错」，而 runner 却把同一状态当成一次性
//      并发跑。
//   ③ **从沉默里推断可并行是不安全的那一侧**：没声明依赖 ≠ 声明了可以并行。并发子代理会
//      同时改同一批文件；`tasks.md` 的写入本仓已经用「执行器独占写入」收口了，但**代码
//      文件仍然裸露**。
//
// 影响面 3.1%（消费项目实测：224 份 `tasks.md` 里 7 份无图），而想要并发只需写一张图
// —— 代价落在可修的一侧。故无图 ⇒ **一任务一 wave**，并明说原因，别让用户以为那是性能问题。
//
// 另一个态：显式**空**图（`{"waves":[]}`）表示「什么都没声明」，**不得**静默退化成
// 「全都跑一遍」，也**不得**与「没有图」混为一谈（后者现在也是串行，但原因不同）。
function buildWavePlan(graph, taskEntries) {
  const warnings = []
  if (graph === undefined) {
    warnings.push(
      'tasks.md 里没有 `## Task Dependency Graph` —— 本次**严格串行**（一次一个任务）。' +
        '真机同样如此：没有声明依赖，就不该推断出可并行。想要波内并发，请写一张依赖图' +
        '（`{"waves":[{"id":0,"tasks":["1","2"]}]}`）。',
    )
  }
  const dupes = duplicateTaskIds(taskEntries)
  if (dupes.length) {
    throw new Error(
      `tasks.md defines duplicate task id(s): ${dupes.join(', ')} — ids must be unique ` +
      `(the runner would execute one definition while marking another)`,
    )
  }
  const byIndex = new Map(taskEntries.map((e) => [e.index, e]))
  // 无图 ⇒ 一任务一 wave（串行）。理由见本函数头注释的裁决 ①②③。
  const declared = graph?.waves ?? taskEntries.map((e) => [e.index])
  // The plan is computed once, before any state changes, so a task declared in
  // two waves would be dispatched twice (its first run cannot mark it done in
  // time). Track it globally instead.
  const seen = new Set()
  const waves = declared.map((waveTasks, wi) => {
    const tasks = []
    for (const index of waveTasks) {
      const entry = byIndex.get(index)
      if (!entry) throw new Error(`task ${index} appears in the dependency graph but is not defined in the task list`)
      if (seen.has(index)) {
        warnings.push(`task ${index} is declared in more than one wave (kept the first, wave index ${wi}); the later declaration is skipped`)
        continue
      }
      if (entry.state === 'x') continue // already done — skip
      seen.add(index)
      tasks.push({ index, text: entry.text, state: entry.state, valid: entry.valid, detail: entry.detail })
    }
    return tasks
  }).filter((w) => w.length > 0)
  return { waves, warnings }
}

// Render a task's detail lines into a runnable prompt fragment (implementation
// steps + requirement references), or empty string.
function taskDetailText(detail) {
  return (detail || []).length ? '\n' + detail.join('\n') : ''
}

function byteLength(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

// Collect the requirement ids a task's detail lines cite via Kiro's
// `_Requirements: 1.1, 2.3_` convention. Only the leading integer is kept,
// because the injected unit is the `### N.` requirement block.
function referencedRequirementIds(detail) {
  const ids = new Set()
  for (const line of detail || []) {
    const m = /_Requirements:\s*([^_]*)_/i.exec(line)
    if (!m) continue
    for (const part of m[1].split(/[,\s]+/)) {
      const num = /^(\d+)(?:\.\d+)*$/.exec(part.trim())
      if (num) ids.add(num[1])
    }
  }
  return [...ids]
}

// Extract the `### N. ...` requirement blocks named by `ids`. Returns undefined
// when extraction is not applicable (nothing cited, or nothing matched) so the
// caller can fall back to the full document rather than injecting nothing.
function extractRequirementBlocks(content, ids) {
  if (!ids.length) return undefined
  const out = []
  let capturing = false
  for (const { raw, inFence } of scanLines(content)) {
    if (inFence) {
      if (capturing) out.push(raw)
      continue
    }
    const t = raw.trim()
    const m = /^###\s+(\d+)[.\s]/.exec(t)
    if (m) {
      capturing = ids.includes(m[1])
      if (capturing) out.push(raw)
      continue
    }
    if (/^#{1,2}\s/.test(t)) {
      capturing = false
      continue
    }
    if (capturing) out.push(raw)
  }
  const text = out.join('\n').trim()
  return text || undefined
}

// Truncate a context blob to `maxBytes` on a code-point-safe boundary.
function clipContext(content, maxBytes) {
  const s = String(content ?? '')
  const size = byteLength(s)
  if (size <= maxBytes) return s
  let cut = Buffer.from(s, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8')
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1)
  return `${cut}\n\n… [truncated: ${size} bytes total, showing the first ${maxBytes}]`
}

// Build the prompt a subagent receives for one task. The spec context is
// bounded by a shared byte budget (`maxBytes`, spent across all three
// documents) and narrows to just the requirement blocks the task cites when its
// `_Requirements:` reference resolves — attaching the whole spec to every task
// scales the run with the spec's size for no benefit.
function buildTaskPrompt({
  index,
  text,
  detail,
  requirements,
  design,
  bugfix,
  maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
}) {
  const parts = [`Implement spec task ${index}: ${text}.${taskDetailText(detail)}`]
  const ids = referencedRequirementIds(detail)
  let budget = maxBytes
  const attach = (label, content, narrowable) => {
    if (content === undefined || budget <= 0) return
    const selected = narrowable ? extractRequirementBlocks(content, ids) : undefined
    const body = clipContext(selected ?? content, budget)
    budget -= byteLength(body)
    parts.push(`\n## ${label}\n${body}`)
  }
  attach('Bug Analysis (bugfix.md)', bugfix, true)
  attach('Requirements', requirements, true)
  attach('Design', design, false)
  parts.push(
    '\nComplete the task, then report what you changed and how you verified it. ' +
    'Do NOT edit tasks.md or call spec_task_set — the runner owns task state and marks it when your run settles.',
  )
  return parts.join('\n')
}

// Run `fn` over `items` with at most `limit` concurrent invocations, preserving
// result order. Mirrors Promise.allSettled's outcome shape and never rejects, so
// a single failing task cannot abort its wave. `undefined` from a settled
// rejection surfaces as a rejected outcome, exactly like allSettled.
async function runBatched(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await Promise.allSettled([fn(items[i], i)]).then((r) => r[0])
    }
  }
  const slots = Math.max(1, Math.min(Number(limit) || 1, items.length))
  await Promise.all(Array.from({ length: slots }, () => worker()))
  return results
}

// R3（第 4 期 Task 6）—— 父任务收敛，对齐 Kiro 真机。
//
// Kiro 真机会在**子任务全部完成**后自动标记父任务；本插件原先只做叶子计数（让
// `phase: complete` 可达，F1），父任务那一行永远停在 `[ ]`，于是出现
// 「phase 说完成、父任务框还空着」的观感不一致。
//
// 三条边界，都有测试盯着（Task 6 Step 4 的反向测试是其中第二条的反面）：
//   ① **只收敛，不反收敛**：父任务已是 `[x]` 而子任务被退回 `[ ]` 时**不动父任务** ——
//      Kiro 真机也不回退，回退会把「曾经全部完成」这件事抹掉。
//   ② **逐级向上**：1.1 完成后若 1 的兄弟也全完成，1 收敛；1 收敛后祖父同理。
//      用不动点循环而不是只查一层 —— 只查一层时深层嵌套会停在中间层，
//      而那种中间态恰好最难被发现（父任务半收敛）。
//   ③ **围栏内不碰**：示例块里的任务行不算数，与 `setTaskState` 的既有纪律一致。
//
// ⚠️ 收敛改的是**合法 checkbox 状态**，所以 `approvalFingerprint` **不变**、`rawRevision` 变
// —— 这正是 dual-hash 两条语义的分界（第 4 期 Task 5 已把这个区分做成可观测的返回值）。
function convergeParents(markdown) {
  const lines = markdown.split('\n')
  const flags = scanLines(markdown)
  const tasks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (flags[i]?.inFence) continue
    const parsed = parseTaskLine(lines[i], { strictTaskState: false })
    if (parsed?.kind !== 'task') continue
    tasks.push({ lineIndex: i, id: parsed.id, state: parsed.state, stateOffset: parsed.stateOffset })
  }
  if (tasks.length === 0) return markdown

  // 🔴 重复 id 一律拒绝（2026-09-13 对抗性审查后补）。`setTaskState` 早就有这条守卫
  // （F18：重复 id 无法唯一定位，那等于「执行 A、标记 B」），但 `convergeParents` 原本没有。
  // 实测：一份含两行 `- [ ] 1. dup parent` 的 tasks.md，在标记**唯一**的 `2.` 之后，
  // **两行 `1.`** 都会被改写成 `[x]`。新增行为不该比既有行为更宽松。
  // 抛错发生在 `writeSpecFile` 之前，所以文件不会被写坏。
  const seenIds = new Set()
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      throw new Error(`task id ${task.id} is defined more than once in tasks.md — ids must be unique for parent convergence to be unambiguous`)
    }
    seenIds.add(task.id)
  }

  // 直接子任务：`1.1` 是 `1` 的子，`1.1.1` 不是（它是 `1.1` 的子）。
  const directChildren = (id) => tasks.filter(
    (task) => task.id.startsWith(`${id}.`) && !task.id.slice(id.length + 1).includes('.'),
  )

  const converged = []
  for (let pass = 0; ; pass += 1) {
    let changed = false
    for (const task of tasks) {
      if (task.state === 'x') continue
      const children = directChildren(task.id)
      if (children.length === 0) continue
      if (children.every((child) => child.state === 'x')) {
        task.state = 'x'
        converged.push(task.id)
        changed = true
      }
    }
    if (!changed) break
    // 每轮至少收敛一个（收敛后的任务被上面的 `continue` 永久跳过），所以轮数上界是
    // `tasks.length`。这道守卫在**正确实现下不可达** —— 那是护栏的本分，不是缺陷：
    // 它只为防「将来有人把循环改坏、changed 恒真」的静默死循环。
    // 对抗性审查指出原写法 `pass > tasks.length` **错位了 2**（带变更的 pass 至多落在 0..n-1，
    // 而它要求 ≥ n+1），收不到它想收的东西，故收紧为 `>=`。
    if (pass >= tasks.length) throw new Error('parent convergence did not settle')
  }
  if (converged.length === 0) return markdown

  for (const task of tasks) {
    if (!converged.includes(task.id)) continue
    const line = lines[task.lineIndex]
    lines[task.lineIndex] = `${line.slice(0, task.stateOffset)}x${line.slice(task.stateOffset + 1)}`
  }
  return lines.join('\n')
}

// Set a task's checkbox state in tasks.md, preserving the rest of the file.
// `index` is the task id as a string ("1" or "1.1"). Returns the updated file.
async function setTaskState(ctx, dir, index, targetChar, exec, expectedRawRevision) {
  const abs = join(dir, 'tasks.md')
  const tasks = await readSpecFile(ctx, abs)
  if (tasks === undefined) throw new Error('tasks.md does not exist yet')
  // Only the checkbox token is rewritten, addressed by line index so the rest of
  // the file round-trips byte-for-byte. Fenced lines are skipped so an example
  // can never be edited.
  const flags = scanLines(tasks)
  let found = 0
  const next = tasks.split('\n').map((line, i) => {
    if (flags[i]?.inFence) return line
    const parsed = parseTaskLine(line, { strictTaskState: false })
    if (parsed === undefined || parsed.id !== String(index)) return line
    found += 1
    // Replace ONLY the checkbox character, addressed by `stateOffset` from the
    // shared layer, so the rest of the line round-trips byte-for-byte (indent,
    // dotted id like "1.1", separator, text). Any single-character state
    // matches — not just the three legal ones — so a fourth-state line can be
    // repaired.
    return `${line.slice(0, parsed.stateOffset)}${targetChar}${line.slice(parsed.stateOffset + 1)}`
  }).join('\n')
  if (found === 0) throw new Error(`task ${index} not found in tasks.md`)
  if (found > 1) {
    throw new Error(`task ${index} is defined ${found} times in tasks.md — ids must be unique to mark a state unambiguously`)
  }
  // R3：这一改动之后，把「同级已全完成」的父任务逐级收敛上去（见 convergeParents）。
  const converged = convergeParents(next)
  // 读-改-写：默认基线是**刚读到的这一份** —— 不传它，`[-] -> [x]` 的勾选就会覆盖掉
  // 「读完之后、写之前」别人对同一份 tasks.md 的任何修改（F11 的原始形态）。
  // 调用方可以给出**更早**的基线（`expectedRawRevision`，它审阅时看到的那一版），
  // 那会让「读之前就被改过」也一并被拒。
  await writeSpecFile(ctx, abs, converged, exec, expectedRawRevision !== undefined ? expectedRawRevision : baselineOf(tasks))
  return converged
}

function guidance(phase) {
  switch (phase) {
    case 'none': return 'No spec yet. Call spec_init with a goal to start.'
    case 'analysis': return 'Complete the current/expected/unchanged sections in bugfix.md, then spec_write design.md (with root cause + properties to test).'
    case 'requirements': return 'Draft user stories + EARS acceptance criteria into requirements.md, then spec_write design.md.'
    case 'design': return 'Document architecture / data flow / testing in design.md (or derive requirements.md from it in design-first), then proceed to tasks.'
    case 'tasks': return 'Implement tasks in wave order; toggle each with spec_task_set as it completes ([ ] pending, [-] in-progress, [x] done).'
    case 'complete': return 'All tasks complete.'
    default: return ''
  }
}

// A `[-]` task is a promise that someone is working on it right now. Across
// sessions that promise is unverifiable, so a leftover `[-]` makes the next
// reader believe work is in flight when nothing is (Req 3.4). This is a
// reminder, never a blocker: the phase and the task counts are unaffected.
const RESIDUE_HINT = (n) =>
  `${n} task(s) are stuck in [-]. Kiro reserves [-] for work happening right now; across sessions it reads as "someone is on this" when nobody is. Converge each one to [x] (done) or back to [ ] (not started).`

function renderStatusText(st) {
  const fileBits = [
    `requirements=${st.files.requirements ? 'present' : 'missing'}`,
    `design=${st.files.design ? 'present' : 'missing'}`,
    `tasks=${st.files.tasks ? 'present' : 'missing'}`,
  ]
  if (st.files.bugfix) fileBits.push(`bugfix=present`)
  const lines = [
    `Spec: ${st.phase} phase${st.workflow ? ` (${st.workflow})` : ''}`,
    `Dir: ${st.dir}`,
    `Files: ${fileBits.join(', ')}`,
    `Tasks: ${st.tasks.done}/${st.tasks.total} done${st.tasks.active ? `, ${st.tasks.active} in progress` : ''}`,
  ]
  // 「这个 workflow 是怎么定下来的」——四层来源里到底采信了哪一层。没有这一行时，
  // 一个由推断得到的 workflow 与一个真机写明的 workflow 在输出里长得一模一样。
  if (st.workflowSource) {
    const seen = [
      st.specType ? `specType=${st.specType}` : null,
      st.kind && st.kind !== st.workflow ? `kind=${st.kind}` : null,
    ].filter(Boolean)
    lines.push(`Workflow source: ${st.workflowSource}${seen.length ? ` (${seen.join(', ')})` : ''}`)
  }
  if (st.units) {
    // "Executable units" is a scope measure (spec-conventions §4.6): parents do
    // not count, because dispatching one is not work.
    lines.push(
      `Executable units: ${st.units.count}${st.units.exempt ? ' (size warning waived by "不拆分为多个 spec")' : ''}`,
    )
  }
  if (st.nextTask) lines.push(`Next task: ${formatTaskId(st.nextTask.index)} ${st.nextTask.text}`)
  lines.push('', st.guidance)
  // `workflowNotes` 与 `warnings` 在数据上分开（一个是「判定怎么来的」，一个是「这份
  // spec 有什么问题」），但渲染成同一种提示 —— 两者都是读者该看见、且不该被埋在正文里的。
  for (const w of [...(st.warnings ?? []), ...(st.workflowNotes ?? [])]) lines.push('', `⚠️ ${w}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Spec directory model: .kiro/specs/<feature>/ (Kiro layout) with legacy
// single-spec fallback and an explicit feature-selection `specsRoot`.
//
// The Kiro specs parent is `<root>/<specsRoot>/specs` where `specsRoot` is
// read from the repo's `.codex/codex-spec.json` ({"specsRoot": ".kiro"}) —
// the same adapter config the Codex CLI side uses — else defaults to `.kiro`.
// ---------------------------------------------------------------------------
// 🔴 L4 · 共享配置路径（Req 3.1）。这个字符串必须与 `plugins/codex-spec/lib/mcp/adapter.mjs`、
// `plugins/claude-spec/lib/mcp/adapter.mjs` 的 `CODEX_SPEC_CONFIG` **逐字相同** ——
// `plugins/claude-spec/test/skeleton.test.mjs` 有一条断言把这三处钉在一起。
// 它是**跨宿主共享的项目档案**，不是本插件的身份（这是第 4 期 Task 2 Step 7 判过的）。
const CODEX_SPEC_CONFIG = '.codex/codex-spec.json'
// L4 兼容读的**旧**路径（Req 3.2）：新路径不在时读它，让已部署的项目（消费项目那份就叫旧名）
// 不因改名而失配。只读，不写、不新装、也不进安装文档。
const LEGACY_CODEX_SPEC_CONFIG = '.codex/kiro-spec.json'

// Read the shared adapter config and return its `specsRoot` value (e.g. ".kiro"),
// or undefined when the file is absent or unparseable.
//
// L4 兼容读（Req 3.2）：**新路径优先、旧路径回退**。DSH 这一侧没有「健康回报」的出口
// （本插件不注册 `spec_health`），所以回退**不回报来源** —— 这是如实登记的限制，不是遗漏。
// 新路径在场时一律以它为准，哪怕它是坏 JSON（那时不该悄悄退回一份更旧的档案）。
async function codexSpecsRoot(ctx, root) {
  const raw = (await readSpecFile(ctx, join(root, CODEX_SPEC_CONFIG)))
    ?? (await readSpecFile(ctx, join(root, LEGACY_CODEX_SPEC_CONFIG)))
  if (raw === undefined) return undefined
  try {
    const cfg = JSON.parse(raw)
    const value = cfg && typeof cfg.specsRoot === 'string' ? cfg.specsRoot.trim().replace(/\/+$/, '') : ''
    return value || undefined
  } catch {
    return undefined
  }
}

// The Kiro specs parent directory (holds `<feature>/` dirs + `_active`):
// `.codex/codex-spec.json`'s `specsRoot` (a parent that contains `specs/`),
// else the default `.kiro`.
async function specsParentDir(ctx, root) {
  const codexRoot = await codexSpecsRoot(ctx, root)
  return join(root, codexRoot || '.kiro', 'specs')
}

// Resolve the *current spec directory* to operate on, plus supporting context.
// Resolution order (first hit wins):
//   1. If `specsRoot` is configured, it is the spec parent directory; return it
//      unchanged (the caller works inside it directly).
//   2. If the project has `<specsParent>/_active` pointing at a feature name,
//      return `<specsParent>/<feature>`.
//   3. If the specs parent holds exactly ONE feature dir, use it.
//   4. If it holds MANY and none is selected, throw listing the candidates —
//      never silently fall back to `.spec/` (that is the bug this fixes).
//   5. If the repo declares a Kiro specs root (.codex/codex-spec.json, or the
//      legacy name it falls back to) but the specs dir is empty, return the
//      empty dir (first spec_init creates there).
//   6. Otherwise legacy single spec at <projectRoot>/<specDir> (pre-Kiro repos
//      keep their exact old behavior).
async function resolveSpecDir(ctx, root, specDir, specsRoot) {
  if (specsRoot) {
    return { kind: 'specsRoot', dir: resolve(root, specsRoot) }
  }
  const parent = await specsParentDir(ctx, root)
  const active = await readSpecFile(ctx, join(parent, ACTIVE_FILE))
  const feature = active !== undefined ? String(active).trim() : ''
  if (feature) return { kind: 'feature', dir: join(parent, feature) }

  const names = await listSpecs(ctx, parent)
  if (names.length === 1) return { kind: 'feature', dir: join(parent, names[0]) }
  if (names.length > 1) {
    const shown = names.slice(0, 12).join(', ')
    const more = names.length > 12 ? `, ... (+${names.length - 12} more)` : ''
    throw new Error(
      `No active spec selected: ${parent} holds ${names.length} specs (${shown}${more}). ` +
      `Pick one via spec_init feature=<name>, or write "${ACTIVE_FILE}" (in ${parent}) with the feature name.`
    )
  }

  const hasCodex = (await codexSpecsRoot(ctx, root)) !== undefined
  if (hasCodex) return { kind: 'codex-empty', dir: parent }
  return { kind: 'legacy', dir: join(root, specDir) }
}

// Resolve a spec directory from an EXPLICIT argument, or fall back to the same
// resolution every other tool uses. This is the order Req 7.5 requires:
//   1. an explicit `spec` argument (name, or a path under the specs parent);
//   2. the `_active` pointer (via resolveSpecDir);
//   3. the sole spec directory;
//   4. a clear error listing the candidates — never a guess.
// The `_active` file is deliberately NOT the only basis: Kiro enumerates the
// directory instead, and the reference corpus has no `_active` at all, so a
// spec must stay reachable without one.
async function resolveSpecArg(ctx, holder, explicit, specLocOf, specsParentOf, rootOf) {
  const raw = explicit === undefined || explicit === null ? '' : String(explicit).trim()
  // An explicit argument is resolved FIRST and must not touch the fallback:
  // `specLocOf` throws when the repo holds several specs and none is active, so
  // computing it eagerly would make `spec=<name>` unusable in exactly the
  // multi-spec repos the argument exists for.
  if (!raw) return specLocOf(holder)
  const parent = await specsParentOf(holder)
  // A bare name is looked up under the specs parent so `spec=my-feature` works.
  // A PATH is resolved against the PROJECT ROOT, never `process.cwd()`: the harness
  // process is started from one directory while the session workspace is another, so
  // cwd resolution silently reads — and for the write tools, modifies — a DIFFERENT
  // checkout. The two agree in tests (temp dir == test cwd), which is why this only
  // ever showed up on a real deployment.
  const isPath = raw.startsWith('/') || raw.includes('/') || raw.includes('\\')
  const candidate = isPath ? resolve(rootOf(holder), raw) : join(parent, raw)
  // Containment: an explicit `spec` may only name a spec INSIDE the specs parent.
  // Strictly inside — the specs parent itself is a container, not a spec, and
  // letting it through made `spec_archive spec=.kiro/specs` create `_archive/`
  // and only THEN fail on the self-nesting rename. Without containment at all,
  // `../../other-repo/.kiro/specs/x` would escape the project entirely.
  const parentAbs = resolve(parent)
  if (!candidate.startsWith(parentAbs + sep)) {
    throw new Error(
      `spec "${raw}" resolves to ${candidate}, which is not a spec directory inside this project's ` +
      `specs directory (${parentAbs}). Pass a feature name, or a path to one spec under it.`,
    )
  }
  // The directory itself counts as "found". Requiring an artifact would make an
  // empty or half-written spec directory unreachable, which defeats the
  // "record missingFiles and carry on" contract the checklist and drift
  // reports have (Req 4.7 / Req 5) — you could not inspect a spec that has not
  // written requirements.md yet, which is precisely when a checklist is useful.
  let isDir = false
  try {
    const target = await ctx.fs.resolve(candidate)
    isDir = (await ctx.fs.stat(target))?.type === 'directory'
  } catch { isDir = false }
  const has = isDir
    || await checkFile(ctx, candidate, 'requirements.md')
    || await checkFile(ctx, candidate, 'tasks.md')
    || await checkFile(ctx, candidate, ANALYSIS_FILE)
  if (!has) {
    const names = await listSpecs(ctx, parent)
    throw new Error(
      `spec "${raw}" not found under ${parent}` +
      (names.length ? ` — available: ${names.join(', ')}` : ' (no spec directories found)'),
    )
  }
  return { kind: 'explicit', dir: candidate }
}

// Read `tasks.meta.json` and report its shape WITHOUT writing anything. Used by
// the non-destructive meta guard so a caller can say what it preserved.
async function readMetaForPreserve(ctx, dir) {
  const raw = await readSpecFile(ctx, join(dir, META_FILE))
  if (raw === undefined) return { exists: false, parsed: undefined, raw }
  try {
    const parsed = JSON.parse(raw)
    return { exists: true, parsed: parsed && typeof parsed === 'object' ? parsed : undefined, raw }
  } catch {
    return { exists: true, parsed: undefined, raw }
  }
}

// Derive this spec's workflow from every source that carries it, in ONE place.
//
// Precedence, and why:
//
//   ① `.config.kiro` — **真机权威**。Kiro 建 spec 时 MUST 写它（官方 prompt 模板原话），
//      真机用它选规则表、排文档清单顺序。判定源与真机对齐是本函数存在的理由。
//   ② `tasks.meta.json._workflow` — 本仓自己 init 时写下的，只有本仓建的 spec 才有。
//   ③ `bugfix.md` 是否存在 — 前两者都缺席时的**推断**兜底（原先唯一的判据）。
//   ④ 默认 `requirements-first`。
//
// 🔴 收敛成一处是本期的主要目的之一。原先「bugfix.md 存在性」这个回落**表达了三遍**：
// `readWorkflow` 内部一次、`specStatus` 一次（`bugfix !== undefined ? 'bugfix' : …`）、
// `diagnoseSpec` 一次（`hasBugfix ? 'bugfix' : …`）。三份都在说同一件事，任一处单独改动
// 都会让**状态报告与诊断判定对不上** —— 而它们本来就是同一个问题的两个面。
//
// 返回 `source`（判定来自哪一层）与 `notes`（回落/冲突/未建模的取值），好让调用方把
// 「我们是怎么知道的」讲出来，而不是把结论伪装成事实。
async function deriveWorkflow(ctx, dir) {
  const notes = []

  // ① `.config.kiro`
  const config = parseConfigKiro(await readSpecFile(ctx, join(dir, CONFIG_KIRO_FILE)))
  if (config.present && !config.usable) {
    notes.push(`${CONFIG_KIRO_FILE} 在场但不可用（${config.code}）—— 判定已回落到下一层来源`)
  }

  // ② `tasks.meta.json._workflow`
  let metaWorkflow
  const metaRaw = await readSpecFile(ctx, join(dir, META_FILE))
  if (metaRaw !== undefined) {
    try {
      const meta = JSON.parse(metaRaw)
      if (meta && typeof meta === 'object' && typeof meta._workflow === 'string') metaWorkflow = meta._workflow
    } catch { /* 坏 meta 不该让取数整体失败 —— 回落到下一层 */ }
  }

  // ③ `bugfix.md` 是否存在
  const hasBugfix = (await readSpecFile(ctx, join(dir, ANALYSIS_FILE))) !== undefined

  const configWorkflow = config.usable ? workflowFromConfig(config) : undefined
  const artifactWorkflow = hasBugfix ? 'bugfix' : undefined

  let workflow
  let source
  if (configWorkflow !== undefined) { workflow = configWorkflow; source = 'config' }
  else if (metaWorkflow !== undefined) { workflow = metaWorkflow; source = 'meta' }
  else if (artifactWorkflow !== undefined) { workflow = artifactWorkflow; source = 'artifact' }
  else { workflow = 'requirements-first'; source = 'default' }

  // 两者都在且不一致：采信 `.config.kiro`（真机权威），但**说出来**。
  // 这不是理论情形 —— 手工改过任一个文件就会出现，而静默选一个会让读者以为另一个不存在。
  if (configWorkflow !== undefined && metaWorkflow !== undefined && configWorkflow !== metaWorkflow) {
    notes.push(
      `${CONFIG_KIRO_FILE} 说 ${configWorkflow}，${META_FILE} 的 _workflow 说 ${metaWorkflow}` +
      ' —— 采信前者（真机权威）；若两者都在就不一致，说明有一个被手工改过',
    )
  }

  // 真机有、本仓**没有建模**的 workflowType。映射到 requirements-first 的流程，但必须
  // 报出来：静默套用另一套流程，正是本仓在别处反复拒绝的那种降级。
  if (config.usable && (config.workflowType === 'fast-task' || config.workflowType === 'verify-first')) {
    notes.push(
      `${CONFIG_KIRO_FILE} 的 workflowType=${config.workflowType} 本仓未建模` +
      '（真机的文档清单顺序与阶段都不同）—— 本次按既有流程走',
    )
  }

  return {
    workflow,
    source,
    // 真机的原值，供状态输出如实呈现；本仓的 workflow 词汇表没有它。
    specType: config.usable ? config.specType : undefined,
    kind: config.usable ? specTypeToKind(config.specType) : undefined,
    notes,
  }
}

// `.config.kiro` 的两个字段 → 本仓的 workflow 值。取不到时 `undefined`（**不是**默认值，
// 默认那一刻属于优先级链的最后一层，不属于这里）。
//
// `specType` 先于 `workflowType`：真机也是按 specType 选诊断表，且 bugfix 与 feature 是
// 两套完全不同的章节表 —— 让 workflowType 覆盖它会选错表。
function workflowFromConfig(config) {
  if (config.specType === 'bugfix') return 'bugfix'

  // 🔴 显式的**非** bugfix specType 是一个**肯定判断**（「这不是 bugfix」），必须压过下层
  // 的一切推断 —— 包括 `tasks.meta.json._workflow` 与目录里残留的 `bugfix.md`。
  //
  // 这一条是被测试抓出来的：原先 `specType:"feature"`（不含 workflowType）会一路落到
  // `return undefined`，于是下层的 `_workflow:"bugfix"` 就赢了 —— 一个明确声明为 feature
  // 的 spec 被当成 bugfix 诊断。T3 情形② 的要害正是这件事，它在 config+meta 这个组合上
  // 比在 config+bugfix.md 上更容易漏掉。
  if (config.specType === 'feature' || config.specType === 'quick-spec') {
    // quick-spec 在本仓的 workflow 轴上就是 feature 形的那条流程 —— dsh-spec 的 `spec_init`
    // 本来也把 quick 的 workflow 记成 requirements-first，区分靠 kind 不靠 workflow。
    return config.workflowType === 'design-first' ? 'design-first' : 'requirements-first'
  }

  // 没有 specType —— 只能听 workflowType 的。
  if (config.workflowType === 'design-first') return 'design-first'
  if (config.workflowType === 'requirements-first') return 'requirements-first'
  // fast-task / verify-first 单独出现（无 specType）：本仓没建模，**不猜**成 feature 形。
  // 报 undefined 让下层去说它知道的事，同时 fast-task 的那条 note 仍会发出来。
  return undefined
}

// Set the active feature pointer (records which feature dir is "current").
async function setActiveFeature(ctx, parentDir, feature, exec) {
  await writeSpecFile(ctx, join(parentDir, ACTIVE_FILE), feature + '\n', exec)
}

// Blank the active feature pointer when it names `specDir` — used after a spec has
// been archived out of the active area. `resolveSpecDir` treats an empty pointer
// exactly like a missing one, so blanking cannot be mistaken for a selection; leaving
// it instead makes every later no-argument call resolve to a directory that is no
// longer there and report "no spec yet" rather than naming the real problem.
async function clearActiveIfPointingAt(ctx, parentDir, specDir, exec) {
  const activePath = join(parentDir, ACTIVE_FILE)
  const current = await readSpecFile(ctx, activePath)
  if (current === undefined) return false
  if (String(current).trim() !== basename(specDir)) return false
  await writeSpecFile(ctx, activePath, '', exec, baselineOf(current))
  return true
}

// Enumerate feature directories under a specs parent that contain at least one
// spec file (requirements.md / bugfix.md / design.md / tasks.md). Returns a
// list of feature names. Falls back to [] when the specs dir is missing or the
// fs backend exposes no listDir.
async function listSpecs(ctx, specsDir) {
  try {
    const dir = await ctx.fs.resolve(specsDir)
    if (typeof ctx.fs.listDir !== 'function') return []
    const entries = await ctx.fs.listDir(dir)
    if (!Array.isArray(entries)) return []
    const names = []
    for (const entry of entries) {
      if (entry?.type !== 'directory' || !entry?.name) continue
      if (entry.name.startsWith('_')) continue
      // Confirm it actually holds a spec file (a stray dir is not a spec).
      const base = entry.target?.displayPath ?? entry.target?.targetKey ?? join(specsDir, entry.name)
      const hasSpec = await Promise.all(SPEC_FILES.map((f) => checkFile(ctx, base, `${f}.md`)))
        .then((r) => r.some(Boolean))
      if (hasSpec) names.push(entry.name)
    }
    return names.sort()
  } catch {
    return []
  }
}

// Check whether a specific file exists under a directory path.
async function checkFile(ctx, dirPath, name) {
  try {
    const child = await ctx.fs.resolve(join(dirPath, name))
    const st = await ctx.fs.stat(child)
    return st !== undefined
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Spec diagnostics (getDiagnostics-equivalent).
//
// 第 3.5 期起，**组装逻辑不再在本文件**：裁决层是 `@my-harness/spec-diagnose`，
// 四个表面（本插件 / codex-spec / 第 6 期 claude-spec / 第 3.6 期 validator）都只做壳。
//
// 本文件保留两样东西：
//   ① `__test` 的历史导出面（键一个不删，Req 7.2）——那些名字现在从共享包 re-export，
//      于是「章节表与执行器不许漂移」那条断言比抽取前更强：两边真的是同一份数据。
//   ② `renderDiagnostics`（下文），把 findings 渲染成工具输出。
//
// `kiroTrim` / 章节表 / 子装配全部经上面的 import 从共享包进来，本文件不再有第二份。
// 🔴 「没查」必须与「查过且干净」长得不同（第 8 期 `acceptance-net-firing`）。
//
// `runChecklist` / `runDrift` 对三种"看起来空"的输入（没有 requirements.md / 是 bugfix.md /
// requirements.md 为空）原先返回计数全零的报告，渲染出来就是一行 `0 error(s), 0 warning(s)`
// —— 与"有一份 requirements.md、逐条都干净"**逐字同形**，读的人无从分辨。
// 这一支**只**说清"这次没查"，并且**不得**打印任何计数行。
function renderNotApplicable(label, specDir, reason, missingFiles = []) {
  const why = reason === 'NO_REQUIREMENTS_FILE'
    ? '目录里既没有 requirements.md 也没有 bugfix.md'
    : '读到的那份需求文件里没有 `### N.` 需求块（常见于 kind=bugfix —— 需求在 bugfix.md 的三段里）'
  const lines = [
    `⚠️ 未分析（${reason}）：${label} — ${specDir}`,
    `   ${why}。`,
    '   本检查只覆盖 requirements.md 的 `### N.` / `#### Acceptance Criteria` 结构。',
    '   🔴 这是「没查」，不是「查过且干净」—— 不要把它读成零问题。',
  ]
  // `Missing:` 是**既有**输出的一部分（"这个目录缺哪些文件"），与"本次分析不适用"是两件事。
  // 不适用时照样打印 —— 丢掉它会让"空 spec 目录仍可检视"那条既有行为断言变红（实测撞到过）。
  if (missingFiles.length) lines.push(`Missing: ${missingFiles.join(', ')}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Render diagnostic results for tool / command output.
function renderDiagnostics(results) {
  if (!results || results.length === 0) return 'No spec files present yet (run spec_init first).'
  const lines = []
  let errors = 0
  let warnings = 0
  for (const r of results) {
    lines.push(`## ${r.file}`)
    if (r.diagnostics.length === 0) {
      lines.push('  ok — no findings')
      continue
    }
    for (const d of r.diagnostics) {
      if (d.severity === 'error') errors += 1
      else warnings += 1
      lines.push(`  [${d.severity === 'error' ? 'ERROR' : 'WARN'}] (${d.code}) ${d.message}`)
    }
  }
  const total = results.reduce((n, r) => n + r.diagnostics.length, 0)
  lines.unshift(`${total} finding(s): ${errors} error(s), ${warnings} warning(s).`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Plugin body.
// ---------------------------------------------------------------------------
function apply(ctx, config = {}) {
  const specDir = typeof config.specDir === 'string' && config.specDir.trim()
    ? config.specDir.trim()
    : DEFAULT_SPEC_DIR
  const markers = Array.isArray(config.projectRootMarkers) && config.projectRootMarkers.length
    ? config.projectRootMarkers
    : DEFAULT_MARKERS
  const specsRoot = typeof config.specsRoot === 'string' && config.specsRoot.trim()
    ? config.specsRoot.trim()
    : undefined
  const useFeatureDirs = config.useFeatureDirs !== false
  const subagentProvider = typeof config.subagentProvider === 'string' && config.subagentProvider.trim()
    ? config.subagentProvider.trim()
    : undefined
  // Upper bound on subagents started per wave. Without it a wave declaring N
  // tasks starts N children at once.
  const maxConcurrency = Number.isInteger(config.maxConcurrency) && config.maxConcurrency > 0
    ? config.maxConcurrency
    : DEFAULT_MAX_CONCURRENCY
  // Upper bound on the spec context injected into one task prompt (see
  // buildTaskPrompt). Guards against attaching a whole multi-hundred-KB spec to
  // every task in the run.
  const maxContextBytes = Number.isInteger(config.maxContextBytes) && config.maxContextBytes > 0
    ? config.maxContextBytes
    : DEFAULT_MAX_CONTEXT_BYTES

  const rootOf = (holder) => projectRootOf(cwdOf(holder), markers)
  const specLocOf = (holder) => resolveSpecDir(ctx, rootOf(holder), specDir, specsRoot)
  const specsParentOf = async (holder) => specsParentDir(ctx, rootOf(holder))

  async function computeStatus(holder, explicit) {
    const root = rootOf(holder)
    // 第 4 期 Task 7（F28）：显式目标优先。`specDirFor` 走的正是 Req 7.5 的顺序
    // （显式参数 → `_active` → 唯一目录 → 报错），所以读写两侧从此共用同一条解析路径。
    const dir = await specDirFor(holder, explicit)
    const [requirements, design, tasks, bugfix] = await Promise.all([
      readSpecFile(ctx, join(dir, 'requirements.md')),
      readSpecFile(ctx, join(dir, 'design.md')),
      readSpecFile(ctx, join(dir, 'tasks.md')),
      readSpecFile(ctx, join(dir, ANALYSIS_FILE)),
    ])
    const wf = await deriveWorkflow(ctx, dir)
    const stats = tasks === undefined ? { total: 0, done: 0, active: 0 } : taskStats(tasks)
    // Executable units (leaf tasks + childless top-level tasks) are a SCOPE
    // measure and are deliberately not the same number as `stats.total`:
    // `stats` counts countable work, `units` counts what a runner would
    // dispatch. The size guideline is advisory at both bands (Req 2.5).
    const units = tasks === undefined
      ? { count: 0, exempt: false, warning: false, severity: null, message: '' }
      : executableUnitCount(tasks)
    const warnings = []
    if (stats.active > 0) warnings.push(RESIDUE_HINT(stats.active))
    if (units.warning) warnings.push(units.message)
    const phase = phaseOf({
      requirements: requirements !== undefined,
      design: design !== undefined,
      tasks: tasks !== undefined,
      bugfix: bugfix !== undefined,
      workflow: wf.workflow,
      tasksTotal: stats.total,
      tasksDone: stats.done,
    })
    return {
      phase,
      dir,
      root,
      // `deriveWorkflow` 已经把四层来源走完并给了默认值，故这里**不再**二次回落 ——
      // 原先那行 `workflow || (bugfix !== undefined ? 'bugfix' : …)` 是同一件事的第三份表达。
      workflow: wf.workflow,
      // 「我们是怎么知道的」：判定来源 + 真机原值 + 回落/冲突/未建模的说明。
      // ⚠️ 可选字段用 `null` 而不是 `undefined`：工具结果必须是无损 JSON，而 `undefined`
      // 过不了 JSON 往返 —— 消费者分不清「字段不存在」与「值缺席」。测试夹具的
      // `assertLosslessJson` 会当场报 `$.specType is undefined`（本行是它抓出来的）。
      workflowSource: wf.source,
      specType: wf.specType ?? null,
      kind: wf.kind ?? null,
      workflowNotes: wf.notes,
      files: {
        requirements: requirements !== undefined,
        design: design !== undefined,
        tasks: tasks !== undefined,
        bugfix: bugfix !== undefined,
      },
      tasks: stats,
      units,
      warnings,
      nextTask: tasks === undefined ? null : nextTask(tasks),
      guidance: guidance(phase),
    }
  }

  // Collect and run diagnostics across the present spec artifacts, keyed by
  // the recorded workflow (bugfix vs feature) so design.md is checked against
  // the right heading set.
  async function diagnoseSpec(holder) {
    const dir = (await specLocOf(holder)).dir
    // Choosing the wrong workflow here checks a bugfix `design.md` against the FEATURE
    // heading set — reporting `## Architecture` missing while never checking
    // `## Root Cause Analysis`. So the derivation goes through the single shared
    // function rather than repeating the fallback (第 9 期 T3).
    const wf = await deriveWorkflow(ctx, dir)
    const workflow = wf.workflow
    const isBugfix = workflow === 'bugfix'
    // The workflow decides WHICH FILES are checked (bugfix.md vs requirements.md);
    // the rule tables inside them follow Kiro's own input, which is only the
    // `.config.kiro` specType (`resolveSpecType`). An INFERRED bugfix (meta /
    // bugfix.md on disk) is invisible to Kiro, so it must not reach the
    // diagnoser as a declared type: Kiro would still sniff design.md and still
    // demand the dependency graph (第 9 期 review, 2026-09-17).
    const artifacts = isBugfix
      ? [['bugfix', 'bugfix.md'], ['design', 'design.md'], ['tasks', 'tasks.md']]
      : [['requirements', 'requirements.md'], ['design', 'design.md'], ['tasks', 'tasks.md']]
    const results = []
    for (const [kind, name] of artifacts) {
      const content = await readSpecFile(ctx, join(dir, name))
      if (content === undefined) continue
      results.push({ file: name, diagnostics: diagnoseArtifact(kind, content, { specType: wf.specType }) })
    }
    return results
  }

  // Non-destructively migrate a legacy single spec at <root>/<specDir> into a
  // feature dir: copy each known artifact that exists there and is not already
  // present in the target. Triggered by ANY known artifact (not just
  // requirements.md), so a legacy spec that only ever had design.md migrates
  // too. Shared by `spec_init` and `/spec init` so the two cannot drift — and
  // it addresses real file names, so the three `.md` artifacts actually copy.
  async function migrateLegacySpec(root, dir, exec) {
    const legacy = join(root, specDir)
    for (const name of MIGRATABLE_FILES) {
      const src = await readSpecFile(ctx, join(legacy, name))
      if (src === undefined) continue
      if (await readSpecFile(ctx, join(dir, name)) !== undefined) continue
      // 「不存在才写」：断言 null（预期不存在），而不是「没表态」。这样即使两次迁移
      // 并行跑，后到的那次也会失败而不是覆盖前一次刚搬过去的字节。
      await writeSpecFile(ctx, join(dir, name), src, exec, null)
    }
  }

  // Always-on workflow constraint.
  ctx.systemPrompt.section({ name: 'spec:workflow', order: 120, text: SPEC_SECTION })

  // ---- spec_init ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_init',
    description: "Start a Kiro-style spec. kind: 'feature' (requirements-first by default), 'bugfix' (bugfix.md), or 'quick' (no approval gates). feature supports workflow 'design-first' and detailLevel.",
    parameters: {
      goal: { type: 'string', required: true, description: 'High-level goal or feature summary seeded into the requirements introduction.' },
      kind: { type: 'string', description: "'feature' (default) | 'bugfix' | 'quick'." },
      workflow: { type: 'string', description: "Feature workflow: 'requirements-first' (default) or 'design-first'." },
      detailLevel: { type: 'string', description: "Design-First detail level: 'high' (default) or 'low'." },
      feature: { type: 'string', description: 'Optional feature (directory) name; defaults to a slug derived from the goal and is cached as the active spec.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `Spec started (${v.phase} stage).\nDir: ${v.dir}\nNext: ${v.next}` }],
    },
    async execute(args, exec) {
      const root = rootOf(exec)

      const kind = (args.kind || 'feature').toLowerCase()
      // `let`, not `const`: `quick` normalises the workflow to
      // requirements-first (that is what it records in meta), and the returned
      // value must not disagree with what landed on disk.
      let workflow = kind === 'feature' && (args.workflow || '').toLowerCase() === 'design-first'
        ? 'design-first'
        : 'requirements-first'
      const detailLevel = (args.detailLevel || 'high').toLowerCase() === 'low' ? 'low' : 'high'
      const feature = featureName(args.feature, args.goal)

      // Determine the target directory. init always creates/selects a concrete
      // spec directory; it does NOT depend on the currently-active feature.
      let dir
      if (specsRoot) {
        dir = resolve(root, specsRoot)
      } else if (useFeatureDirs) {
        const parent = await specsParentOf(exec)
        dir = join(parent, feature)
        await migrateLegacySpec(root, dir, exec)
      } else {
        dir = join(root, specDir)
      }

      // Record this feature dir as the active spec so subsequent tools resolve
      // to it without re-passing the feature name.
      if (useFeatureDirs && !specsRoot) {
        await setActiveFeature(ctx, await specsParentOf(exec), feature, exec)
      }

      // Scaffolding is NON-DESTRUCTIVE. `init` creates what is missing; use
      // `spec_write` to overwrite deliberately. Writing unconditionally also
      // defeated the legacy migration above: it copied requirements.md into the
      // feature dir and the template then immediately overwrote it.
      const preserved = []
      const scaffold = async (fileName, content) => {
        const existing = await readSpecFile(ctx, join(dir, fileName))
        if (existing !== undefined) {
          preserved.push(fileName)
          return
        }
        await writeSpecFile(ctx, join(dir, fileName), content, exec, null)
      }

      // `tasks.meta.json` is NOT ours to reconstruct. Kiro writes it too, via
      // `saveMetadata` (path built by `replace(/\.md$/,'.meta.json')`), and its
      // `executionHistory` is the only record of every task run against this
      // spec. The old code wrote a fresh `{pbtResults:{},executionHistory:{}}`
      // on EVERY init — unconditionally, OUTSIDE the guard above — so simply
      // re-running spec_init on an existing spec silently wiped that history
      // (Req 9.1, 9.3). Now it goes through the same guard, and when the file
      // already exists we only ADD the workflow marker if it is missing,
      // preserving every other key and entry verbatim (Req 7.3).
      const scaffoldMeta = async (workflowName) => {
        const state = await readMetaForPreserve(ctx, dir)
        if (!state.exists) {
          await writeSpecFile(
            ctx,
            join(dir, META_FILE),
            JSON.stringify({ pbtResults: {}, executionHistory: {}, _workflow: workflowName }, null, 2) + '\n',
            exec,
            null,
          )
          return
        }
        // EXISTS → not one byte is touched (Req 9.1 / 9.3).
        //
        // Not even to add our own `_workflow` marker. An earlier revision
        // merged that key in, which preserved every Kiro field yet still broke
        // the requirement's actual promise — the file's BYTES change, and a
        // spec that was already correct would be reported as modified. Req 9.3
        // is explicit that this write gets the SAME "exists ⇒ skip" guard as the
        // three artifacts. The workflow is recoverable without the marker — and since
        // 第 9 期 T3 there are two sources for it, both better than a guess:
        // Kiro's own `.config.kiro`, then the bugfix artifact on disk.
        preserved.push(META_FILE)
      }

      // Scaffold the first artifact, then record the workflow in meta.
      let phase
      let next
      if (kind === 'bugfix') {
        await scaffold(ANALYSIS_FILE, bugfixTemplate(args.goal))
        await scaffoldMeta('bugfix')
        phase = 'analysis'
        next = 'Draft the current/expected/unchanged sections in bugfix.md, then spec_write design.md (root cause + properties to test).'
      } else if (kind === 'quick') {
        // No approval gates: scaffold all three artifacts up front. Quick has no
        // design-first variant, so pin the workflow to what meta records.
        workflow = 'requirements-first'
        await scaffold('requirements.md', requirementsTemplate(args.goal))
        await scaffold('design.md', designTemplate('high'))
        await scaffold('tasks.md', tasksTemplate())
        await scaffoldMeta('requirements-first')
        phase = 'tasks'
        next = 'All three files drafted with no approval gates. Edit them, then implement tasks.'
      } else if (workflow === 'design-first') {
        await scaffold('design.md', designTemplate(detailLevel))
        await scaffoldMeta('design-first')
        phase = 'design'
        next = `Draft ${detailLevel === 'low' ? 'Low' : 'High'} Level design.md, then spec_write requirements.md derived from the architecture.`
      } else {
        await scaffold('requirements.md', requirementsTemplate(args.goal))
        await scaffoldMeta('requirements-first')
        phase = 'requirements'
        next = 'Draft requirements.md, then spec_write design.md once requirements are complete.'
      }
      if (preserved.length) {
        next += ` Kept existing file(s) untouched: ${preserved.join(', ')} (use spec_write to overwrite).`
      }

      return {
        dir,
        feature,
        kind,
        workflow,
        phase,
        next,
      }
    },
  }))

  // ---- spec_write ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_write',
    description: "Write (create or overwrite) one spec file. Enforces workflow-aware stage order: bugfix uses bugfix.md→design→tasks; feature is requirements→design→tasks (or design→requirements→tasks in design-first). After writing, returns a non-blocking diagnostic summary (heading/runtime checks); it never prevents the write.",
    parameters: {
      file: { type: 'string', required: true, description: "One of 'requirements', 'design', 'tasks', or 'bugfix'." },
      content: { type: 'string', required: true, description: 'Full markdown content to write. For a bugfix design, an empty string scaffolds the root-cause-analysis skeleton.' },
      spec: { type: 'string', description: 'Optional spec name (or path). Omitted: resolve from _active, else the sole spec directory.' },
      expectedRawRevision: { oneOf: [{ type: 'string' }, { type: 'null' }], description: "Optional optimistic-concurrency guard (F11). Pass the rawRevision of the content you read (spec_read returns it). A mismatch refuses the write with REVISION_CONFLICT instead of silently overwriting a concurrent change. Pass null to assert the file does not exist yet (first write). Omitted: the baseline is the content this call just read." },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: `Wrote ${v.file}.md (${v.bytes} bytes). Phase: ${v.phase}. Next: ${v.next}` + (v.diagnostics ? `\n\n⚠️ Diagnostics (non-blocking):\n${v.diagnostics}` : ''),
      }],
    },
    async execute(args, exec) {
      const WRITABLE = [...SPEC_FILES, 'bugfix']
      if (!WRITABLE.includes(args.file)) {
        throw new Error(`invalid spec file "${args.file}"; expected one of ${WRITABLE.join(', ')}`)
      }
      const dir = await specDirFor(exec, args.spec)
      // The gate and the diagnostics must agree on which workflow this spec is ——
      // same derivation, so a `.config.kiro` that says `feature` cannot make the
      // diagnostics treat a spec as feature while the gate still demands bugfix.md.
      const { workflow, specType } = await deriveWorkflow(ctx, dir)

      // Stage-order gating, spec-kind aware.
      if (args.file === 'design') {
        if (workflow === 'design-first') {
          // design is the starting artifact; allowed first.
        } else {
          const prereq = workflow === 'bugfix' ? ANALYSIS_FILE : 'requirements.md'
          const has = await readSpecFile(ctx, join(dir, prereq))
          if (has === undefined) throw new Error(`${prereq} does not exist yet — write it first (spec_init / spec_write).`)
        }
      }
      // design-first runs design -> requirements -> tasks, so requirements is
      // NOT the starting artifact in that workflow. Without this gate the tool
      // would silently accept any order while its description claims to enforce
      // the stage order.
      if (args.file === 'requirements' && workflow === 'design-first') {
        const design = await readSpecFile(ctx, join(dir, 'design.md'))
        if (design === undefined) {
          throw new Error('design-first derives requirements FROM the design — write design.md first (spec_init workflow=design-first, then spec_write design).')
        }
      }
      if (args.file === 'tasks') {
        const design = await readSpecFile(ctx, join(dir, 'design.md'))
        if (design === undefined) throw new Error('design.md does not exist yet — write design first (spec_write design).')
        if (workflow === 'design-first') {
          const req = await readSpecFile(ctx, join(dir, 'requirements.md'))
          if (req === undefined) throw new Error('requirements.md does not exist yet — design-first derives requirements before tasks.')
        }
      }

      // Bugfix design gets the root-cause-analysis skeleton (not the feature
      // design skeleton) when an empty content is supplied. This wires up
      // bugfixDesignTemplate, which is otherwise dead code.
      let content = args.content
      if (args.file === 'design' && workflow === 'bugfix' && String(content).trim() === '') {
        content = bugfixDesignTemplate()
      }

      // 🔴 dual-hash（第 4 期 Task 5）：写入前后各算一次审批指纹，把「字节变了」与
      // 「语义变了」分开报出来。`setTaskState` 走的是另一条路（只动 checkbox），
      // 而这里覆盖整份文件，所以「改了标题」和「只改了 checkbox」必须能区分 ——
      // 前者该作废审批，后者不该。
      const abs = join(dir, `${args.file}.md`)
      const previous = await readSpecFile(ctx, abs)
      const previousApprovalFingerprint = previous === undefined
        ? null
        : computeApprovalFingerprint({ artifact: args.file, markdown: previous, strictTaskState: false })

      // 调用方明确断言了基线就用它的（那才是「我读到的是这一版」的完整表达）；
      // 没断言时用**刚读到的 `previous`** —— 这就是一次标准的读-改-写。
      const baseline = args.expectedRawRevision !== undefined ? args.expectedRawRevision : baselineOf(previous)
      const bytes = await writeSpecFile(ctx, abs, content, exec, baseline)
      const st = await computeStatus(exec, args.spec)

      const rawRevision = computeRawRevision(content)
      const approvalFingerprint = computeApprovalFingerprint({ artifact: args.file, markdown: content, strictTaskState: false })
      // 首次写入没有可比的旧内容 → `null`。把「不知道」报成 `false` 是谎，
      // 而 `false` 的语义是「确定语义没变」——两者不能混。
      const semanticChanged = previousApprovalFingerprint === null
        ? null
        : previousApprovalFingerprint !== approvalFingerprint

      // Non-blocking diagnostic summary for the file just written (advisory
      // only — a malformed spec still writes successfully).
      // Same rule as `diagnoseSpec`: only the DECLARED `.config.kiro` specType
      // reaches the diagnoser; without it Kiro sniffs design.md, and so do we.
      const kind = args.file
      const diags = diagnoseArtifact(kind, content, { specType })
      const diagnostics = diags.length
        ? renderDiagnostics([{ file: `${args.file}.md`, diagnostics: diags }])
        : null

      return {
        file: args.file,
        bytes,
        phase: st.phase,
        next: st.guidance,
        diagnostics,
        rawRevision,
        approvalFingerprint,
        previousApprovalFingerprint,
        semanticChanged,
      }
    },
  }))

  // ---- spec_read ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_read',
    description: "Read one spec file, or the overall status when file is 'status' (default).",
    parameters: {
      file: { type: 'string', description: "One of 'requirements', 'design', 'tasks', 'bugfix', 'meta', or 'status' (default)." },
      spec: { type: 'string', description: 'Optional spec name (or path). Omitted: resolve from _active, else the sole spec directory.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{
        type: 'text',
        text: v.status
          ? renderStatusText(v.status)
          : (v.content === null ? `(${v.file} not present yet)` : v.content),
      }],
    },
    async execute(args, exec) {
      const st = await computeStatus(exec, args.spec)
      const file = args.file || 'status'
      if (file === 'status') return { phase: st.phase, file: 'status', content: null, status: st }
      if (file === 'meta') {
        const dir = await specDirFor(exec, args.spec)
        const content = await readSpecFile(ctx, join(dir, META_FILE))
        return { phase: st.phase, file: 'meta', content: content ?? null, status: null }
      }
      const readable = [...SPEC_FILES, 'bugfix']
      if (!readable.includes(file)) throw new Error(`invalid spec file "${file}"; expected one of ${readable.join(', ')} or 'status'`)
      const dir = await specDirFor(exec, args.spec)
      const content = await readSpecFile(ctx, join(dir, `${file}.md`))
      // `rawRevision` 是 CAS 的基线：调用方读到它，写回时拿它断言（`expectedRawRevision`）。
      // 不返回它，「先读后写」就只能靠调用方自己重算 —— 而它拿不到同样的字节口径。
      return { phase: st.phase, file, content: content ?? null, status: null, rawRevision: content === undefined ? null : computeRawRevision(content) }
    },
  }))

  // ---- spec_status --------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_status',
    description: 'Report the spec workflow phase, task completion, and the next required step.',
    parameters: {
      spec: { type: 'string', description: 'Optional spec name (or path). Omitted: resolve from _active, else the sole spec directory.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: renderStatusText(v) }],
    },
    async execute(args, exec) {
      return computeStatus(exec, args.spec)
    },
  }))

  // ---- spec_task_set ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_task_set',
    description: "Mark a task in tasks.md by its id. State 'pending'→[ ], 'active'/'in-progress'→[-], 'done'→[x].",
    parameters: {
      index: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        required: true,
        description: "Task id to set: '1' (integer parent) or '1.1' (dotted leaf).",
      },
      done: { type: 'boolean', description: 'true marks [x]. Mutually exclusive with an explicit state.' },
      state: { type: 'string', description: "'pending' | 'active' | 'done'. Prefer this over the boolean done flag." },
      spec: { type: 'string', description: 'Optional spec name (or path). Omitted: resolve from _active, else the sole spec directory.' },
      expectedRawRevision: { oneOf: [{ type: 'string' }, { type: 'null' }], description: "Optional optimistic-concurrency guard (F11): the rawRevision of the tasks.md you reviewed (spec_read returns it). A mismatch refuses the checkbox write with REVISION_CONFLICT. Omitted: the baseline is the tasks.md this call just read — so a concurrent write landing inside the read-modify-write window still fails." },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `Task ${v.index} -> ${v.state} (${v.doneCount}/${v.total} done). Phase: ${v.phase}.` }],
    },
    async execute(args, exec) {
      const dir = await specDirFor(exec, args.spec)
      const abs = join(dir, 'tasks.md')
      const tasks = await readSpecFile(ctx, abs)
      if (tasks === undefined) throw new Error('tasks.md does not exist yet — write tasks first (spec_write tasks).')
      // A numeric index is only safe for integer (parent) ids: a JSON number
      // cannot distinguish "1.1" from "1.10" (both parse to 1.1), so a numeric
      // dotted id would silently target the WRONG task. Require a string for
      // any non-integer id.
      let index
      if (typeof args.index === 'number') {
        if (!Number.isInteger(args.index)) {
          throw new Error(`task id ${args.index} is not an integer; dotted ids like "1.1" must be passed as a string (a numeric 1.10 is indistinguishable from 1.1)`)
        }
        index = String(args.index)
      } else {
        index = String(args.index).trim()
      }

      // Resolve the target state: explicit `state` wins over the boolean `done`.
      let target
      if (args.state !== undefined && args.state !== null && args.state !== '') {
        const s = String(args.state).toLowerCase()
        const map = { pending: ' ', active: '-', 'in-progress': '-', done: 'x' }
        if (!(s in map)) throw new Error(`invalid state "${args.state}"; expected one of pending|active|done`)
        target = map[s]
      } else {
        target = args.done ? 'x' : ' '
      }

      // Locate the task line and rewrite only its state token, preserving the
      // list indent and the rest of the line verbatim (dotted id, separator).
      // Delegates to the shared setter so this path and `spec_run` share one
      // implementation (including the duplicate-id refusal).
      const next = await setTaskState(ctx, dir, index, target, exec, args.expectedRawRevision)
      const stats = taskStats(next)
      const st = await computeStatus(exec, args.spec)
      // 🔴 勾选一个 checkbox 只该动 rawRevision，**不该**动 approvalFingerprint
      // （第 4 期 Task 5：`setTaskState` 只更新前者）。这个区分就是「这次写入
      // 有没有改变语义」这件事在本插件上的落地 —— 指纹变了，说明有东西改错了。
      const rawRevision = computeRawRevision(next)
      const approvalFingerprint = computeApprovalFingerprint({ artifact: 'tasks', markdown: next, strictTaskState: false })
      const previousApprovalFingerprint = computeApprovalFingerprint({ artifact: 'tasks', markdown: tasks, strictTaskState: false })
      return {
        index,
        state: target === 'x' ? '[x]' : target === '-' ? '[-]' : '[ ]',
        total: stats.total,
        doneCount: stats.done,
        phase: st.phase,
        rawRevision,
        approvalFingerprint,
        previousApprovalFingerprint,
      }
    },
  }))

  // ---- spec_meta ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_meta',
    description: 'Read or write `tasks.meta.json` — the PRE-1.1.28 shape (`{pbtResults, executionHistory}`) kept beside the spec. Current Kiro keeps its own store at `~/.kiro/tasks/<workspace-hash>/`; this plugin never writes that one.',
    parameters: {
      action: { type: 'string', description: "'read' (default) or 'record'." },
      task: { type: 'string', description: "Task title/key to append an execution record to (required for 'record')." },
      executionId: { type: 'string', description: 'Optional execution id; defaults to a generated uuid.' },
      chatSessionId: { type: 'string', description: 'Optional chat session id.' },
      timestamp: { type: 'number', description: 'Optional epoch-ms timestamp; defaults to now.' },
      spec: { type: 'string', description: 'Optional spec name (or path). Omitted: resolve from _active, else the sole spec directory.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(args, exec) {
      const dir = await specDirFor(exec, args.spec)
      const path = join(dir, META_FILE)
      const raw = await readSpecFile(ctx, path)
      let meta
      if (raw === undefined) {
        meta = { pbtResults: {}, executionHistory: {} }
      } else {
        try { meta = JSON.parse(raw) } catch { meta = { pbtResults: {}, executionHistory: {} } }
      }
      if (typeof meta !== 'object' || meta === null) meta = { pbtResults: {}, executionHistory: {} }
      meta.pbtResults ??= {}
      meta.executionHistory ??= {}

      const action = (args.action || 'read').toLowerCase()
      if (action === 'read') {
        return { rendered: JSON.stringify(meta, null, 2) }
      }
      if (action !== 'record') throw new Error(`invalid action "${args.action}"; expected 'read' or 'record'`)

      if (!args.task) throw new Error("spec_meta record requires a 'task' title/key")
      // A non-numeric timestamp would poison executionHistory ordering (records
      // are sorted/compared by this field downstream), so reject it loudly
      // rather than storing whatever arrived.
      let timestamp = Date.now()
      if (args.timestamp !== undefined && args.timestamp !== null) {
        if (typeof args.timestamp !== 'number' || !Number.isFinite(args.timestamp)) {
          throw new Error(`timestamp must be a finite epoch-ms number; got ${JSON.stringify(args.timestamp)}`)
        }
        timestamp = args.timestamp
      }
      const record = {
        executionId: args.executionId || randomUUID(),
        chatSessionId: args.chatSessionId || '',
        timestamp,
      }
      const list = meta.executionHistory[args.task] ?? (meta.executionHistory[args.task] = [])
      list.push(record)
      // 与真机同一条上限（见 EXECUTION_HISTORY_CAP）。截断**要说出来**：真机是静默截的，
      // 但静默丢记录正是本仓在别处反复拒绝的那种降级 —— 调用方至少该知道少了几条。
      const before = list.length
      if (before > EXECUTION_HISTORY_CAP) list.splice(0, before - EXECUTION_HISTORY_CAP)
      const trimmed = before - list.length
      // 读-改-写：`raw` 是本工具开头读到的那一份，用它当基线。
      await writeSpecFile(ctx, path, JSON.stringify(meta, null, 2) + '\n', exec, baselineOf(raw))
      return {
        rendered:
          `Recorded execution for "${args.task}" @ ${record.timestamp} (${list.length} total` +
          `${trimmed ? `, trimmed ${trimmed} oldest to keep ${EXECUTION_HISTORY_CAP}` : ''}).`,
      }
    },
  }))

  // ---- spec_run (waves dependency-graph executor) -------------------------
  // Shared implementation for the spec_run tool and the /spec run command.
  async function runSpec(exec, { wave, dryRun }) {
    const dir = (await specLocOf(exec)).dir
    const tasksContent = await readSpecFile(ctx, join(dir, 'tasks.md'))
    if (tasksContent === undefined) throw new Error('tasks.md does not exist yet — write tasks first (spec_write tasks).')

    const graph = parseDependencyGraph(tasksContent)
    const entries = parseTaskList(tasksContent)
    const plan = buildWavePlan(graph, entries)
    // Both the graph's own schema warnings and the planner's (duplicate-wave)
    // warnings are user-visible: they announce silent degradations.
    const notes = [...(graph?.warnings ?? []), ...plan.warnings]

    let waves = plan.waves
    if (wave !== undefined) {
      const w = Number(wave)
      if (!Number.isInteger(w) || w < 1 || w > waves.length) {
        throw new Error(`wave ${w} out of range; plan has ${waves.length} wave(s) of pending work`)
      }
      waves = [waves[w - 1]]
    }

    const runnable = waves.filter((w) => w.length > 0)
    const warnBlock = notes.length ? '\n' + notes.map((n) => `⚠️ ${n}`).join('\n') : ''
    if (runnable.length === 0) {
      return `No pending tasks to run (all tasks done, or none listed in the dependency graph).${warnBlock}`
    }

    if (dryRun) {
      const text = runnable.map((wv, i) => {
        const ids = wv.map((t) => `${t.index}`).join(', ')
        const hint = wv.length > 1 ? ` (concurrent, max ${maxConcurrency})` : ''
        return `Wave ${i + 1}: tasks [${ids}]${hint}`
      }).join('\n')
      return `Wave plan (${runnable.length} wave(s)):\n${text}${warnBlock}`
    }

    if (!subagentProvider) {
      throw new Error('spec run requires config.subagentProvider to dispatch tasks; use /spec plan to preview, or set subagentProvider in the dsh-spec config.')
    }

    const [requirements, design, bugfix] = await Promise.all([
      readSpecFile(ctx, join(dir, 'requirements.md')).catch(() => undefined),
      readSpecFile(ctx, join(dir, 'design.md')).catch(() => undefined),
      readSpecFile(ctx, join(dir, ANALYSIS_FILE)).catch(() => undefined),
    ])

    const results = []
    // A task that ran but could not be marked is the one failure mode a caller
    // MUST see, so state-write errors are collected rather than swallowed.
    const writeFailures = []
    // 第 7 期 §9 欠账 ⑦（2026-09-14 补）——「plan 时读的 → 完成时写」这一段窗口。
    //
    // `setTaskState` 自己的默认基线是它**刚读到的**那份，所以「读 → 写」那一小段早就兜住了。
    // 没兜住的是更长的这一段：上面 plan 时读了一次 tasks.md 算出波次，然后派子代理
    // （可能跑很久），**回来才写**。这中间别人改了 tasks.md，`setTaskState` 会拿它自己
    // 刚读到的**新**版本当基线 —— 写入成功，而这次写入所依据的计划是基于一份已作废的内容算的。
    //
    // 🔴 修法不能是把 plan 时的基线固定传下去：本函数会**连续标多个任务**，
    // 第一次写入之后 revision 就变了，固定基线会让第二个 mark 起全部冲突 —— 自己撞自己。
    // 所以是**链式推进**：起点 = plan 时读到的那份，每次自己写成功后推到自己刚写的那一版。
    // 于是「别人改的」被拒、「自己改的」通过。
    let markBaseline = baselineOf(tasksContent)
    const mark = async (index, ch) => {
      try {
        const written = await setTaskState(ctx, dir, index, ch, exec, markBaseline)
        markBaseline = baselineOf(written)
      } catch (e) {
        // 失败时**不推进**基线：盘上那份不是我们写的，下一次 mark 应当继续用原基线去撞。
        writeFailures.push(`task ${index} -> [${ch === 'x' ? 'x' : ch === '-' ? '-' : ' '}]: ${String(e?.message || e)}`)
      }
    }

    const dispatch = (t) => {
      const prompt = buildTaskPrompt({
        index: t.index,
        text: t.text,
        detail: t.detail,
        requirements,
        design,
        bugfix,
        maxBytes: maxContextBytes,
      })
      return ctx.subagents.start(subagentProvider, {
        label: `spec task ${t.index}`,
        prompt: [{ type: 'text', text: prompt }],
        parent: exec.agent,
        signal: exec.signal,
      }).then(async (run) => {
        try {
          const result = await run.result
          const stop = result?.stopReason
          if (stop !== undefined && stop !== 'completed' && stop !== 'done') {
            throw new Error(`task ${t.index} ended abnormally (${String(stop)})`)
          }
          const text = (result?.output || []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
          return { index: t.index, ok: true, text }
        } finally {
          // Always release the run, including when result rejects.
          await run.dispose?.().catch(() => {})
        }
      })
    }

    for (let wi = 0; wi < runnable.length; wi++) {
      const wv = runnable[wi]
      for (const t of wv) await mark(t.index, '-')
      let outcomes
      try {
        outcomes = await runBatched(wv, maxConcurrency, dispatch)
      } catch (err) {
        // Abnormal exit: never strand this wave in [-], which spec-conventions
        // forbids across sessions.
        for (const t of wv) await mark(t.index, ' ')
        throw err
      }

      for (let i = 0; i < wv.length; i++) {
        const t = wv[i]
        const oc = outcomes[i]
        if (oc && oc.status === 'fulfilled') {
          await mark(t.index, 'x')
          results.push({ wave: wi + 1, index: t.index, done: true })
        } else {
          await mark(t.index, ' ')
          results.push({ wave: wi + 1, index: t.index, done: false, error: String(oc?.reason ?? 'no outcome') })
        }
      }
    }

    const done = results.filter((r) => r.done).length
    const failed = results.filter((r) => !r.done)
    const lines = [`Ran ${results.length} task(s): ${done} done, ${failed.length} failed.`]
    for (const f of failed) lines.push(`  - task ${f.index} (wave ${f.wave}): ${f.error}`)
    if (writeFailures.length) {
      lines.push(`⚠️ ${writeFailures.length} task-state write(s) failed — tasks.md may not reflect what actually ran:`)
      for (const w of writeFailures) lines.push(`  - ${w}`)
    }
    for (const n of notes) lines.push(`⚠️ ${n}`)
    return lines.join('\n')
  }

  ctx.tools.register(defineTool({
    name: 'spec_run',
    description: "Execute tasks.md in wave order from the ## Task Dependency Graph: waves run serially, tasks within a wave run concurrently via subagents. Only not-yet-done tasks are run. Requires a configured subagentProvider.",
    parameters: {
      wave: { type: 'number', description: 'Optional 1-based wave index to run only that wave; default runs all waves in order.' },
      dryRun: { type: 'boolean', description: 'When true, return the wave plan without dispatching any subagent.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(args, exec) {
      return { rendered: await runSpec(exec, args) }
    },
  }))

  // ---- spec_diagnostics ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_diagnostics',
    description: "Lint the active spec against the Kiro heading/format conventions: exact `##` heading match (strict prefix, no same-line suffix), H1 title, dependency-graph shape, task-state validity, and acceptance-criteria presence. Returns errors/warnings per file and never blocks writes.",
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(_args, exec) {
      const results = await diagnoseSpec(exec)
      return { rendered: renderDiagnostics(results) }
    },
  }))

  // ---------------------------------------------------------------------------
  // 第 4 期 Task 7（F28）之后，**全部读写工具**都用同一条解析路径解析 `spec`：
  // 显式参数 → `_active` → 唯一目录 → 报错（Req 7.5），multi-spec repo 永不被猜。
  //
  // 原文只说「the five capability tools」，因为那时只有分析/归档类五个带 `spec`。
  // 缺口正在**写侧**：`spec_write` / `spec_read` / `spec_status` / `spec_task_set` /
  // `spec_meta` 一个都没有 —— 而 F28 记的那次现场事故，撞的正是 `spec_task_set`：
  // 并发会话改了 `_active`，它就把状态写到了别人的 `tasks.md` 上（当时幸免只因 id 不重合）。
  // 现在这五个都接受可选 `spec`，`_active` 只对**没传** `spec` 的调用生效。
  //
  // `port` is the injected I/O boundary the lib/* modules expect: they
  // deliberately import no `node:fs`, so they cannot accidentally write outside
  // the paths the caller hands them.
  // ---------------------------------------------------------------------------
  // `exec` is BOUND HERE, not passed by the modules: they call
  // `port.writeText(abs, content)`, so an exec taken as a third argument would
  // always arrive undefined and every write would silently lose the session's
  // sandbox policy — workspace-write containment would then fall back to the
  // deployment default and deny the write.
  //
  // 实现与那两条理由（`ctx.fs` 没有 move 原语、以及为什么改用宿主 fs 时要正面回答
  // 沙箱问题）都跟着搬到了 `lib/port.js` —— 那里是宿主适配层，共享包不该知道 `ctx.fs`。
  // 这里只把插件自己的三件东西递进去：读、写、项目根解析（它们依赖本插件的 config
  // 与沙箱策略）。
  const portOf = (exec) => createDshPort(ctx, exec, { readSpecFile, writeSpecFile, rootOf, baselineOf })

  const specDirFor = async (exec, explicit) =>
    (await resolveSpecArg(ctx, exec, explicit, specLocOf, specsParentOf, rootOf)).dir

  // ---- spec_checklist ------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_checklist',
    description: 'READ-ONLY requirements-quality checklist for one spec: missing acceptance criteria / user story, criteria without a capitalised EARS keyword, untestable quantifiers (适当/合理/尽快/若干/良好), and requirements no task references. Reports counts + findings and never writes.',
    parameters: {
      spec: { type: 'string', description: 'Optional spec name (or path). Omitted: resolve from _active, else the sole spec directory.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(args, exec) {
      const specDir = await specDirFor(exec, args.spec)
      const report = await runChecklist({ port: portOf(exec), specDir })
      if (report.applicable === false) return { rendered: renderNotApplicable('Requirements checklist', specDir, report.reason, report.missingFiles), report }
      const lines = [
        `Requirements checklist — ${specDir}`,
        `${report.counts.error} error(s), ${report.counts.warning} warning(s), ${report.counts.info} info — ` +
        `${report.counts.passed} requirement block(s) clean of error+warning.`,
      ]
      if (report.missingFiles.length) lines.push(`Missing: ${report.missingFiles.join(', ')}`)
      for (const f of report.findings) {
        lines.push(`  [${f.severity.toUpperCase()}] (${f.ruleId} · ${f.source}) ${f.anchor}: ${f.message}`)
      }
      return { rendered: lines.join('\n'), report }
    },
  }))

  // ---- spec_drift ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_drift',
    description: 'READ-ONLY drift report: which requirements have no implementation landing point, based on task state and _Requirements: citations. Never writes tasks.md. Each entry carries an evidence-strength field (always "weak": this corpus has no file-level annotations, so task state is the only available evidence) and two suggested ways forward.',
    parameters: {
      spec: { type: 'string', description: 'Optional spec name (or path). Omitted: resolve from _active, else the sole spec directory.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(args, exec) {
      const specDir = await specDirFor(exec, args.spec)
      const report = await runDriftModule({ port: portOf(exec), specDir })
      if (report.applicable === false) return { rendered: renderNotApplicable('Drift report', specDir, report.reason, report.missingFiles), report }
      const lines = [
        `Drift report — ${specDir}${report.frozen ? ' (frozen: every task is [x], severities suppressed)' : ''}`,
        `${report.entries.length} requirement(s) examined. READ-ONLY: tasks.md was not modified.`,
      ]
      if (report.missingFiles.length) lines.push(`Missing: ${report.missingFiles.join(', ')}`)
      for (const e of report.entries) {
        lines.push(`  [${e.severity}] req ${e.requirement} — ${e.status} (evidence: ${e.evidence})`)
        if (e.recommendation) lines.push(`      ${e.recommendation}`)
      }
      return { rendered: lines.join('\n'), report }
    },
  }))

  // ---- spec_sign -----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_sign',
    description: 'Append an attribution signature line to tasks.md\'s `## Notes` (format `- YYYY-MM-DD · DSH · <what changed>`), or check whether a spec directory is signed. Checking is per SPEC DIRECTORY (signing in tasks.md satisfies a design.md change) and is warning-only.',
    parameters: {
      spec: { type: 'string', description: 'Optional spec name (or path).' },
      action: { type: 'string', description: "'sign' (default) appends a signature; 'check' only reports." },
      summary: { type: 'string', description: "What changed, e.g. 'design.md：补 Req 3 的属性值域'." },
      env: { type: 'string', description: "Kiro | DSH | Codex | Gemini (default DSH)." },
      changedFiles: { type: 'string', description: "For action=check: comma-separated changed file names." },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(args, exec) {
      const specDir = await specDirFor(exec, args.spec)
      const action = (args.action || 'sign').toLowerCase()
      if (action === 'check') {
        const changedFiles = String(args.changedFiles ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const report = await checkAttribution({ port: portOf(exec), dir: specDir, changedFiles })
        // Three states, not two: "no changed files to attribute" is a different answer
        // from "the attribution is present". Rendering both as SIGNED made the check
        // report success for a directory holding zero signature lines.
        const verdict = report.applicable === false
          ? 'NOT CHECKED (no changedFiles given — pass one to judge attribution)'
          : report.ok
            ? 'SIGNED (per spec directory)'
            : 'UNSIGNED (per spec directory)'
        const lines = [
          `Attribution — ${specDir}: ${verdict}`,
          `${report.signatures.length} signature line(s) found across .md files.`,
        ]
        if (report.missingFiles.length) lines.push(`Missing: ${report.missingFiles.join(', ')}`)
        if (report.finding) lines.push(`  [${report.finding.severity.toUpperCase()}] (${report.finding.ruleId}) ${report.finding.message}`)
        return { rendered: lines.join('\n'), report }
      }
      if (action !== 'sign') throw new Error(`invalid action "${args.action}"; expected 'sign' or 'check'`)
      const line = await appendSignature({ port: portOf(exec), dir: specDir, summary: args.summary, env: args.env || 'DSH', exec })
      return { rendered: `Signed ${join(specDir, 'tasks.md')}:\n${line}`, line }
    },
  }))

  // ---- spec_amend ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_amend',
    description: "Incremental correction channel for a frozen spec: 'param' edits a parameter value IN PLACE, 'requirement' appends a requirement with numbering continuing past the existing maximum, 'design' writes a `## Amendments` entry plus an in-place pointer. Refuses to touch a task body and refuses specs under _archive/.",
    parameters: {
      spec: { type: 'string', description: 'Optional spec name (or path).' },
      kind: { type: 'string', required: true, description: "'param' | 'requirement' | 'design'." },
      file: { type: 'string', description: "For kind=param: 'requirements' | 'design' | 'bugfix'." },
      from: { type: 'string', description: 'For kind=param: the exact existing text to replace.' },
      to: { type: 'string', description: 'For kind=param: its replacement.' },
      title: { type: 'string', description: 'For kind=requirement: the new requirement title.' },
      body: { type: 'string', description: 'For kind=requirement/design: the content to insert.' },
      heading: { type: 'string', description: 'For kind=design: the `### YYYY-MM-DD · …` amendment heading.' },
      anchor: { type: 'string', description: 'For kind=design: the exact existing line the pointer follows.' },
      pointer: { type: 'string', description: 'For kind=design: the pointer line inserted after the anchor.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(args, exec) {
      const specDir = await specDirFor(exec, args.spec)
      const kind = String(args.kind ?? '').toLowerCase()
      if (kind === 'param') {
        const out = await applyParamEdit({ port: portOf(exec), dir: specDir, file: args.file, from: args.from, to: args.to, exec })
        return { rendered: `Edited ${args.file}.md in place (${out?.occurrences ?? 1} occurrence, first only).`, result: out }
      }
      if (kind === 'requirement') {
        const out = await appendRequirement({ port: portOf(exec), dir: specDir, title: args.title, body: args.body, exec })
        return { rendered: `Appended ${out?.heading ?? 'the new requirement'} to requirements.md (numbering continues past the existing maximum).`, result: out }
      }
      if (kind === 'design') {
        // Req 6.3 wants a pointer at the amended ORIGINAL location, so both
        // halves are mandatory. Checked here (not left to the writer) because
        // the writer's own message names `pointer.text`, while the user's
        // actual omission is usually `anchor` — a confusing gap that made
        // "amend the design" look like a bug in the tool.
        if (!args.anchor) {
          throw new Error(
            'spec_amend kind=design requires `anchor`: the exact existing line of design.md that the ' +
            'amendment replaces, so a one-line pointer can be left at the original position (Req 6.3). ' +
            'Pass anchor="<the existing line>" and pointer="<the pointer line to insert after it>".',
          )
        }
        if (!args.pointer) {
          throw new Error('spec_amend kind=design requires `pointer`: the one-line pointer to insert after the anchor line.')
        }
        const out = await appendDesignAmendment({
          port: portOf(exec),
          dir: specDir,
          heading: args.heading,
          body: args.body,
          pointer: { anchor: args.anchor, text: args.pointer },
          exec,
        })
        return { rendered: `Added an amendment to design.md with an in-place pointer.`, result: out }
      }
      throw new Error(`invalid kind "${args.kind}"; expected 'param' | 'requirement' | 'design'`)
    },
  }))

  // ---- spec_archive --------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'spec_archive',
    description: 'Move one spec directory into `.kiro/specs/_archive/<feature>/`. Refuses to overwrite an existing archive of the same name (nothing is changed in that case).',
    parameters: {
      spec: { type: 'string', description: 'Optional spec name (or path).' },
      archiveRoot: { type: 'string', description: 'Optional archive root override (defaults to <specs-parent>/_archive).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: v.rendered }],
    },
    async execute(args, exec) {
      const specDir = await specDirFor(exec, args.spec)
      const specsParent = await specsParentOf(exec)
      const archiveRoot = args.archiveRoot || join(specsParent, '_archive')
      const out = await archiveSpec({ port: portOf(exec), specDir, archiveRoot })
      // `archiveSpec` reports `destination`; reading `dest` made the left side of this
      // `??` dead code and the rendered path a coincidence of its right side.
      const dest = out?.destination ?? join(archiveRoot, basename(specDir))
      const cleared = await clearActiveIfPointingAt(ctx, specsParent, specDir, exec)
      return {
        rendered: `Archived ${specDir} → ${dest}${cleared ? ' (cleared the _active pointer)' : ''}`,
        result: out,
      }
    },
  }))

  // ---- /spec command ------------------------------------------------------
  const commands = ctx.get('commands')
  if (commands) {
    commands.register({
      name: 'spec',
      description: 'create or inspect a Kiro-style spec (requirements/design/tasks/bugfix)',
      input: { hint: '[status|diagnose|new <name>|view [name] [file]|run|plan|analyze_requirements [name]]' },
      handler: async (invocation) => {
        const text = (invocation.rawInput || '').trim()
        const root = rootOf(invocation)

        // /spec  |  /spec status
        if (!text || text === 'status') {
          const st = await computeStatus(invocation)
          return { kind: 'success', text: renderStatusText(st) }
        }

        // /spec diagnose | /spec diag | /spec lint
        if (text === 'diagnose' || text === 'diag' || text === 'lint') {
          const rendered = renderDiagnostics(await diagnoseSpec(invocation))
          return { kind: 'success', text: rendered }
        }

        // /spec run | /spec plan
        if (text === 'run' || text === 'plan') {
          try {
            const out = await runSpec(invocation, { dryRun: text === 'plan' })
            return { kind: 'success', text: out }
          } catch (e) {
            return { kind: 'error', text: String(e?.message || e) }
          }
        }

        // /spec new <feature-name>
        if (/^new(?:\s+)(.+)$/s.test(text)) {
          const feature = text.replace(/^new\s+/i, '').trim()
          const dir = useFeatureDirs && !specsRoot
            ? join(await specsParentOf(invocation), featureName(feature, feature))
            : join(root, specDir)
          if (useFeatureDirs && !specsRoot) {
            await setActiveFeature(ctx, await specsParentOf(invocation), featureName(feature, feature), invocation)
          }
          // Non-destructive, like `spec_init` (see the note there). In
          // particular the meta write must not clobber a Kiro `executionHistory`
          // just because someone ran `/spec new` again.
          const reqPath = join(dir, 'requirements.md')
          const kept = (await readSpecFile(ctx, reqPath)) !== undefined
          if (!kept) await writeSpecFile(ctx, reqPath, requirementsTemplate(feature), invocation, null)
          const metaState = await readMetaForPreserve(ctx, dir)
          // Same "exists ⇒ skip" guard as spec_init (Req 9.3): an existing
          // tasks.meta.json is never rewritten, not even to add our marker.
          if (!metaState.exists) {
            await writeSpecFile(
              ctx,
              join(dir, META_FILE),
              JSON.stringify({ pbtResults: {}, executionHistory: {}, _workflow: 'requirements-first' }, null, 2) + '\n',
              invocation,
              null,
            )
          }
          const keptNote = kept ? ' Kept the existing requirements.md (use spec_write to overwrite).' : ''
          const metaNote = metaState.exists ? ` Kept the existing ${META_FILE}.` : ''
          return { kind: 'success', text: `Spec "${feature}" initialized in ${dir} (requirements stage). Draft requirements.md, then /spec status.${keptNote}${metaNote}` }
        }

        // /spec view [name] [file]
        if (/^view(?:\s+.*)?$/.test(text)) {
          const args = text.replace(/^view\s*/i, '').trim().split(/\s+/).filter(Boolean)
          let feature = args.shift()
          let file = args.shift() || 'requirements'
          // `file` comes straight from user input and is joined onto the spec
          // dir, so it must be whitelisted: `../../../etc/hosts` would otherwise
          // read any `<path>.md` on disk.
          file = String(file).replace(/\.md$/i, '')
          if (!VIEWABLE_FILES.includes(file)) {
            return { kind: 'error', text: `invalid spec file "${file}"; expected one of ${VIEWABLE_FILES.join(', ')}` }
          }
          let dir
          // If a feature is named, switch to its directory (sanitized to match
          // the slug featureName produces at init time) — resolve it directly
          // so multi-spec repos work without an _active pointer.
          if (feature) {
            if (!useFeatureDirs && !specsRoot) {
              return { kind: 'error', text: 'naming a feature requires useFeatureDirs (.kiro/specs/<feature>/)' }
            }
            dir = join(await specsParentOf(invocation), featureName(feature, feature))
          } else {
            const loc = await specLocOf(invocation)
            dir = loc.dir
          }
          const content = await readSpecFile(ctx, join(dir, `${file}.md`))
          if (content === undefined) {
            return { kind: 'error', text: `${file}.md not found in ${dir}` }
          }
          return { kind: 'success', text: `# ${file}.md (${dir})\n\n${content}` }
        }

        // /spec analyze_requirements [name]
        if (/^analyze_requirements(?:\s+.*)?$/.test(text) || /^analyze(?:\s+.*)?$/.test(text)) {
          const arg = text.replace(/^analyze_requirements\s*/i, '').replace(/^analyze\s*/i, '').trim()
          let dir
          if (arg) {
            dir = join(await specsParentOf(invocation), featureName(arg, arg))
          } else {
            const loc = await specLocOf(invocation)
            dir = loc.dir
          }
          const req = await readSpecFile(ctx, join(dir, 'requirements.md'))
          if (req === undefined) {
            // List candidate specs when none given or target missing.
            const specs = await listSpecs(ctx, await specsParentOf(invocation))
            if (specs.length === 0) {
              return { kind: 'error', text: `no requirements.md in ${dir} (and no spec directories found).` }
            }
            return { kind: 'success', text: `No requirements.md at ${dir || '<none>'}. Available specs: ${specs.join(', ')} — pass one, e.g. /spec analyze_requirements ${specs[0]}` }
          }
          const guidance = [
            `Analyze the requirements in ${dir}/requirements.md across the FULL requirement set (not one by one). Read the file, then identify:`,
            '',
            '1. **Logical contradictions** — requirements that are each reasonable but jointly impossible.',
            '2. **Ambiguity** — vague terms ("large files", "fast") that would split implementations.',
            '3. **Conflicting constraints** — functional/non-functional requirements that cannot both hold.',
            '4. **Undeclared assumptions** — references to concepts/behaviors never defined.',
            '5. **Missing edge cases** — failure modes, boundary conditions, concurrency scenarios with no coverage.',
            '',
            'Present each finding as a clarifying question with the affected requirement numbers, a plain-language explanation, and a suggested fix. Update requirements.md in place as each question is resolved. You may ignore a finding if the ambiguity is intentional.',
          ].join('\n')
          return { kind: 'success', text: guidance }
        }

        // /spec init <goal>
        if (/^init(?:\s+)(.+)$/s.test(text)) {
          const goal = text.replace(/^init\s+/i, '').trim()
          let dir
          if (useFeatureDirs && !specsRoot) {
            // Always create a feature dir under the specs parent — do not rely
            // on the resolver, which needs an _active pointer in multi-spec repos.
            const feature = featureName(undefined, goal)
            const parent = await specsParentOf(invocation)
            dir = join(parent, feature)
            await setActiveFeature(ctx, parent, feature, invocation)
            // Same migration `spec_init` performs; without it `/spec init` and
            // the tool took different paths for the identical situation.
            await migrateLegacySpec(root, dir, invocation)
          } else {
            const loc = await specLocOf(invocation)
            dir = loc.dir
          }
          const reqPath = join(dir, 'requirements.md')
          const kept = (await readSpecFile(ctx, reqPath)) !== undefined
          if (!kept) await writeSpecFile(ctx, reqPath, requirementsTemplate(goal), invocation, null)
          const metaState = await readMetaForPreserve(ctx, dir)
          // Same "exists ⇒ skip" guard as spec_init (Req 9.3): an existing
          // tasks.meta.json is never rewritten, not even to add our marker.
          if (!metaState.exists) {
            await writeSpecFile(
              ctx,
              join(dir, META_FILE),
              JSON.stringify({ pbtResults: {}, executionHistory: {}, _workflow: 'requirements-first' }, null, 2) + '\n',
              invocation,
              null,
            )
          }
          const keptNote = kept ? ' Kept the existing requirements.md (use spec_write to overwrite).' : ''
          const metaNote = metaState.exists ? ` Kept the existing ${META_FILE}.` : ''
          return { kind: 'success', text: `Spec initialized in ${dir} (requirements stage). Draft requirements.md, then /spec status.${keptNote}${metaNote}` }
        }

        return { kind: 'error', text: 'Usage: /spec [status|diagnose|new <name>|view [name] [file]|run|plan|analyze_requirements [name]|init <goal>]' }
      },
    })
  }
}

// Derive a slug-ish directory name from an explicit feature name or the goal.
// Both paths are sanitized so a user-supplied name can never escape the specs
// directory (path traversal) or create an invalid directory name.
function featureName(feature, goal) {
  const raw = (feature && String(feature).trim()) || (goal || '').toString().trim()
  const base = raw || 'feature'
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'feature'
}

// Exported for the test suite. Not part of the public surface: the tool layer
// and the `apply` entry point are the supported API. Keeping the pure helpers
// reachable lets the parser/stats/diagnostics invariants be tested directly
// instead of only through a mounted plugin.
const __test = {
  SPEC_FILES,
  MIGRATABLE_FILES,
  VIEWABLE_FILES,
  KIRO_CHECKBOX_CHARS,
  REPO_CODES,
  LEGACY_CODE_REMAP,
  scanLines,
  parseTask,
  parseTaskList,
  parentTaskIds,
  duplicateTaskIds,
  // 第 4 期 Task 6（R3 父任务收敛）。导出它是为了能对**真实嵌套语料**直接验证收敛
  // 语义，而不必为每一份语料走一遍工具调用 —— 消费项目有 86 份含嵌套的 spec。
  convergeParents,
  taskStats,
  nextTask,
  formatTaskId,
  buildWavePlan,
  parseDependencyGraph,
  hasUnterminatedFence,
  collectHeadings,
  collectDesignSections,
  sniffDesignVariant,
  DESIGN_FEATURE_SECTIONS,
  DESIGN_BUGFIX_SECTIONS,
  BUGFIX_SECTIONS,
  KIRO_RULE_CODES: kiroRules.KIRO_RULE_CODES,
  RULE_CODE_COUNT: kiroRules.RULE_CODE_COUNT,
  diagnoseArtifact,
  diagnoseDependencyGraph,
  diagnoseTaskBody,
  diagnoseWavesConsistency,
  diagnoseDesignProperties,
  executableUnitCount,
  phaseOf,
  featureName,
  taskDetailText,
  referencedRequirementIds,
  extractRequirementBlocks,
  clipContext,
  buildTaskPrompt,
  runBatched,
  requirementsTemplate,
  bugfixTemplate,
  designTemplate,
  tasksTemplate,
}

// L4 的两个常量一并导出：dsh 侧的兼容读回退要在测试里被**真的**跑到，而测试文件若自己写
// 旧名字面量，会把一个替换面不该有的旧名引进棘轮（Req 8）。这里导出的是**唯一**那份真值。
export { name, inject, apply, __test, CODEX_SPEC_CONFIG, LEGACY_CODEX_SPEC_CONFIG }
