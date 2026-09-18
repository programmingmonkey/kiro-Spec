// 裁决层：四个 artifact 的**唯一**组装点（第 3.5 期 Task 4）。
//
// 迁移源是 `plugins/dsh-spec/lib/index.js` 的 `diagnoseArtifact`（第 3.5 期开工前在 :1675）。
// 选它做迁移源的理由是**结构性**的，不是判断谁更忠实：它已经引用 41 条规则表、已经有 `source`
// 字段、已经有 12 条 repo 码的分层。codex-spec 的 `artifact-schema.mjs` 只有 47 行、只手写 3 条
// 规则、零引用 `kiro-rules`，只保留导出面。
//
// 本期在此之上加的唯一行为（Task 0.2 判定）：
//   **围栏造成的更严必须标 `repo-convention`。**
//   dsh 的章节检测会跳过 ``` 内的标题，而真机 Kiro **没有围栏概念**（四个 validate*Format 全部
//   按行 `xE`(trimEnd) 匹配）。于是「某章节只出现在围栏里」时 dsh 判「缺」、真机判「有」——这是
//   本仓约定带来的额外严格度。主计划 3.5 的判据原话是「任何额外严格度只能出现在
//   `source: 'repo-convention'` 下」，故这类 finding 的 source 应为 repo-convention。
//
// 零 I/O、恒不抛。

import { KIRO_RULE_BY_CODE, sniffDesignVariant } from '@my-harness/kiro-rules'
import { parseTaskLine } from '@my-harness/spec-parser'
import { computeFenceState, hasUnterminatedFence } from '@my-harness/spec-parser/scan-lines'

import { makeFinding } from './finding.js'
import { applyProfile } from './profile.js'

const GRAPH_HEADING = '## Task Dependency Graph'

// 两个宿主**故意不同**的任务状态策略（第 3 期保留的分歧，本期不得抹平）：
//   dsh-spec  = false（宽松解析 + `[~]` 报 repo-convention 警告）
//   codex-spec = true （`[~]` 在解析层就被拒）
// 它同时决定**围栏判定**：`scanFence` 的 `taskIndents` 由任务行累积，而「哪些行是任务」依本策略
// 而不同——这是 `lib/scan-lines.js` 自陈的已知耦合（第 3.5 期 Task 0.1 实测为第三类差异形态）。
const LOOSE = { strictTaskState: false }

// 真机的 specType 是**三态**，不是布尔（1.1.28 bundle 逐字，`validateDesignFormat`）：
//
//     s = e===SpecType.Bugfix || e===void 0 && <嗅探四个 bugfix 标题>
//
//   · `'bugfix'`   → bugfix 章节表；`tasks.md` 豁免依赖图
//   · `'feature'`  → feature 章节表，**不嗅探**；依赖图照常要求
//   · `undefined`  → 按内容嗅探；依赖图照常要求
//
// 真机的 specType **只来自 `.config.kiro`**。所以调用方只该传**文件里写明的**值 —— 从
// `bugfix.md` 是否存在、或宿主自己的 workflow 记录**推断**出来的类型，真机看不见，传进来就会
// 让本地比真机松（豁免依赖图）或严（强制换表）。第 9 期 review（2026-09-17）前这里只有布尔
// `isBugfix`，表达不了「写明是 feature」，两个方向都因此与真机分叉。
//
// 🔴 `'quick-spec'` 按「未写」处理（2026-09-17 订正）。真机内部**两条路径不一致**：
//   · `get_diagnostics` 工具与「问题」面板的 `Kiro Spec Format`（用户实际看到的那两处）：
//     `specType==="feature" ? Feature : specType==="bugfix" ? Bugfix : 不设` —— quick-spec **嗅探**；
//   · `validate_spec_format`（子代理用）的 `resolveSpecType`：原样传 QuickSpec —— **不嗅探**。
// 本层跟前者：本仓对标的是 `getDiagnostics`，而用户在 Kiro 里看到的也是它的结论。
// 上一版（`40b8949`）跟的是后者，且没有写明这处分歧。盘上 `quick-spec` 样本 0 例。
//
// `isBugfix: true` 仍被接受，等价于 `specType: 'bugfix'`（旧签名，测试工具与外部调用在用）。
// 其余取值（含 `'quick-spec'` 与未知串）一律按「未写」处理；恒不抛。
function resolveSpecType({ specType, isBugfix } = {}) {
  if (specType === 'feature' || specType === 'bugfix') return specType
  if (isBugfix === true) return 'bugfix'
  return undefined
}

const strictOf = (options) => (options?.strictTaskState === true ? { strictTaskState: true } : LOOSE)

/**
 * 策略感知的行级围栏视图。**不要用共享层的 `scanLines`**：它的历史形态把策略写死成 loose
 * （`scanFence(raw, DEFAULT_OPTIONS)`），而本层必须让调用方绑定自己的策略，否则两宿主在围栏
 * 判定上的已知耦合会被悄悄抹平。
 */
function fenceView(content, options) {
  const raw = String(content ?? '').split('\n')
  const inFence = computeFenceState(raw, strictOf(options))
  return raw.map((line, index) => ({ raw: line, inFence: inFence[index] === true }))
}

// Kiro's four task-line regexes, transcribed verbatim from the bundle. They are
// PREFIX tests, which is why `- [ ] 1.1` passes at depth 0 via the sub-task one.
const KIRO_TASK_TOP_RE = /^- \[([ x~-])\]\\?\*? \d+\./
const KIRO_TASK_SUB_RE = /^\s*- \[([ x~-])\]\\?\*? \d+\.\d+/
const KIRO_CHECKBOX_RE = /^\s*- \[([ x~-])\]/
const KIRO_MALFORMED_CHECKBOX_RE = /^\s*- \[([^\] ])\]/

export const REQUIREMENT_BLOCK_SECTIONS = [
  { code: 'requirements/missing-acceptance-criteria', pattern: /^#### Acceptance Criteria$/, display: '#### Acceptance Criteria', severity: 'error', trimEnd: true },
  { code: 'requirements/missing-user-story', pattern: /\*\*User Story:\*\*/, display: '**User Story:**', severity: 'warning', trimEnd: false },
]

export const DESIGN_FEATURE_SECTIONS = [
  { code: 'design/missing-overview', name: 'overview', display: 'Overview', severity: 'error' },
  { code: 'design/missing-architecture', name: 'architecture', display: 'Architecture', severity: 'error' },
  { code: 'design/missing-components', name: 'components and interfaces', display: 'Components and Interfaces', severity: 'error' },
  { code: 'design/missing-data-models', name: 'data models', display: 'Data Models', severity: 'error' },
  { code: 'design/missing-correctness-properties', name: 'correctness properties', display: 'Correctness Properties', severity: 'warning' },
  { code: 'design/missing-error-handling', name: 'error handling', display: 'Error Handling', severity: 'warning' },
  { code: 'design/missing-testing-strategy', name: 'testing strategy', display: 'Testing Strategy', severity: 'warning' },
]

export const DESIGN_BUGFIX_SECTIONS = [
  { code: 'design/missing-overview', name: 'overview', display: 'Overview', severity: 'error' },
  { code: 'design/missing-glossary', name: 'glossary', display: 'Glossary', severity: 'warning' },
  { code: 'design/missing-bug-details', name: 'bug details', display: 'Bug Details', severity: 'error' },
  { code: 'design/missing-expected-behavior', name: 'expected behavior', display: 'Expected Behavior', severity: 'error' },
  { code: 'design/missing-hypothesized-root-cause', name: 'hypothesized root cause', display: 'Hypothesized Root Cause', severity: 'error' },
  { code: 'design/missing-correctness-properties', name: 'correctness properties', display: 'Correctness Properties', severity: 'warning' },
  { code: 'design/missing-fix-implementation', name: 'fix implementation', display: 'Fix Implementation', severity: 'error' },
  { code: 'design/missing-testing-strategy', name: 'testing strategy', display: 'Testing Strategy', severity: 'warning' },
]

export const BUGFIX_SECTIONS = [
  { code: 'bugfix/missing-introduction', pattern: /^## Introduction$/, display: '## Introduction' },
  { code: 'bugfix/missing-bug-analysis', pattern: /^## Bug Analysis$/, display: '## Bug Analysis' },
  { code: 'bugfix/missing-current-behavior', pattern: /^### Current Behavior \(Defect\)$/, display: '### Current Behavior (Defect)' },
  { code: 'bugfix/missing-expected-behavior', pattern: /^### Expected Behavior \(Correct\)$/, display: '### Expected Behavior (Correct)' },
  { code: 'bugfix/missing-unchanged-behavior', pattern: /^### Unchanged Behavior \(Regression Prevention\)$/, display: '### Unchanged Behavior (Regression Prevention)' },
]

// Sections that belong to a design document and therefore must not appear in
// bugfix.md — Kiro reports these as a warning (`bugfix/unexpected-section`).
const BUGFIX_DESIGN_ONLY = [
  /technical context/i,
  /implementation details/i,
  /architecture/i,
  /components and interfaces/i,
  /data models/i,
]

// Kiro's line normaliser, reproduced exactly: `function xE(t){return t.trimEnd()}`.
// It is trimEnd, NOT trim — a LEADING-indented heading therefore does not match.
export function kiroTrim(line) {
  return String(line ?? '').replace(/\s+$/, '')
}

/**
 * Raw visibility: does any line of the document satisfy `predicate` **ignoring fences**?
 *
 * 这正是真机 Kiro 看到的世界——它按行匹配，没有围栏状态。dsh 的围栏感知是一层本仓约定；
 * 当一条 `missing-*` 只因这层约定才成立时，它的权威溯源就是本仓约定，不是 Kiro。
 */
function visibleInRawText(content, predicate) {
  return String(content ?? '')
    .split('\n')
    .some((line) => predicate(kiroTrim(line)))
}

export function collectHeadings(content, options) {
  const h1 = []
  const h2 = new Set()
  for (const { raw, inFence } of fenceView(content, options)) {
    if (inFence) continue
    const line = kiroTrim(raw)
    if (line.startsWith('# ')) h1.push(line)
    else if (line.startsWith('## ')) h2.add(line)
  }
  return { h1, h2 }
}

export function collectDesignSections(content, options) {
  const names = new Set()
  for (const { raw, inFence } of fenceView(content, options)) {
    if (inFence) continue
    const m = /^##\s+(.+)$/.exec(kiroTrim(raw))
    if (m) names.add(m[1].toLowerCase())
  }
  return names
}

/**
 * 一条 finding 的构造。`source` 走 `makeFinding` 里的查表；只有「围栏造成的更严」会显式传
 * `'repo-convention'`。
 *
 * `anchored` 的**唯一**判定点（第 3.6 期 Task 0.2）。判据是「第 5 个实参有没有传」——
 * 实测 31 个调用点里 10 处传了 `line`、**没有一处显式传 `0`**，所以 `line !== undefined`
 * 是无歧义的判别信号。这里**不能**用 `line >= 0` 当判据：一旦 `line` 有默认值 `0`，
 * 每一条文档级 finding 都会被它误标成 anchored。
 */
function diag(code, severity, message, source, line) {
  const anchored = line !== undefined
  const rule = KIRO_RULE_BY_CODE[code]
  const out = { code, severity, message, source, line: anchored ? line : 0, anchored }
  // 契约里的 suggestedAction：规则表里有具名目标（`display`）就给出可操作的建议。
  // 旧 codex-spec 适配层对每一条 finding 都带这个字段（它只有 3 条手写规则、都是缺章节类），
  // 迁到共享层后一度消失；这里把它补回来，并顺手覆盖全部「缺某个具名章节」的规则。
  if (rule?.display) {
    out.suggestedAction = rule.display.startsWith('# ')
      ? `Add the ${rule.display} heading.`
      : `Add a ${rule.display} section.`
  }
  return out
}

/**
 * 行号单位：**0 基**，与 Kiro 自己一致——它的规则循环传的是数组下标（实测：
 * `## Tasks` 段里第 10 行的畸形复选框，真机报 `line: 9`）。`0` 同时是 Kiro 表达
 * 「文档级、无具体行」的取值（实测：`tasks/missing-dependency-graph` 报 `line: 0`）。
 * 两者同形是 Kiro 的既有约定，本层照抄，不另造哨兵。
 */

// ── Design: `## Correctness Properties` ─────────────────────────────────────
export function diagnoseDesignProperties(content, options) {
  const out = []
  const lines = fenceView(content, options)
  const start = lines.findIndex((l) => !l.inFence && /^## Correctness Properties$/.test(kiroTrim(l.raw)))
  if (start === -1) return out

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^## /.test(kiroTrim(lines[i].raw))) {
      end = i
      break
    }
  }
  const body = lines.slice(start + 1, end)
  const okHeading = /^(?:### )?Property \d+:/
  const looseHeading = /^(?:### )?Property\b/
  const properties = []
  for (let i = 0; i < body.length; i++) {
    // RAW line, and fences are NOT skipped: Kiro tests the line directly with no
    // normaliser and no fence awareness. An indented `  ### Property 1:` is
    // therefore malformed to Kiro rather than valid, and a fenced example inside
    // the section still counts as a property.
    const line = body[i].raw
    if (looseHeading.test(line) && !okHeading.test(line)) {
      out.push(diag(
        'design/malformed-property-heading',
        'error',
        'Malformed property heading. Expected format: Property N: Title or ### Property N: Title',
        'kiro-binary',
        start + 1 + i,
      ))
    }
    if (okHeading.test(line)) properties.push({ line: start + 1 + i, index: i })
  }
  if (properties.length === 0) {
    out.push(diag(
      'design/empty-correctness-properties',
      'warning',
      'Correctness Properties section has no properties. Expected at least one Property N: heading',
      'kiro-binary',
      start,
    ))
  }
  for (let i = 0; i < properties.length; i++) {
    const from = properties[i].index + 1
    const to = i + 1 < properties.length ? properties[i + 1].index : body.length
    const hasValidates = body.slice(from, to).some((l) => /\*\*Validates:\s*Requirements\s+[\d.,\s]+\*\*/.test(l.raw))
    if (!hasValidates) {
      out.push(diag(
        'design/missing-property-validates',
        'warning',
        'Property is missing **Validates: Requirements X.Y** reference',
        'kiro-binary',
        properties[i].line,
      ))
    }
  }
  return out
}

// ── Tasks: task list / waves ────────────────────────────────────────────────

/** 任务行（非围栏内）的紧凑投影：诊断只需要 index / state / valid。 */
export function taskEntries(content, options) {
  const entries = []
  for (const { raw, inFence } of fenceView(content, options)) {
    if (inFence) continue
    const parsed = parseTaskLine(raw, strictOf(options))
    if (parsed === undefined) continue
    entries.push({ index: parsed.id, state: parsed.state, valid: parsed.valid })
  }
  return entries
}

/**
 * Ids of tasks that group subtasks. A parent is a grouping label, not work — the
 * wave runner only walks the dependency graph, so a parent that is not itself
 * listed there is never dispatched and never marked.
 */
export function parentTaskIds(entries) {
  const parents = new Set()
  for (const e of entries) {
    const dot = e.index.lastIndexOf('.')
    if (dot !== -1) parents.add(e.index.slice(0, dot))
  }
  return parents
}

/**
 * Task ids defined more than once. Duplicates are ambiguous: `buildWavePlan`
 * would take the last definition while the state writer edits the FIRST matching
 * line, so the runner could execute one task while marking another.
 */
export function duplicateTaskIds(entries) {
  const seen = new Set()
  const dupes = new Set()
  for (const e of entries) {
    if (seen.has(e.index)) dupes.add(e.index)
    seen.add(e.index)
  }
  return [...dupes]
}

/** 解析 `## Task Dependency Graph` 段里的 wave 图；畸形即抛（由调用方决定处置）。 */
function dependencyGraph(content, options) {
  const lines = fenceView(content, options)
  const start = lines.findIndex((l) => !l.inFence && kiroTrim(l.raw) === GRAPH_HEADING)
  if (start === -1) return undefined

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^## /.test(kiroTrim(lines[i].raw))) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end).map((l) => l.raw).join('\n')
  // 与下面 `diagnoseDependencyGraph` 用**同一个**正则：要求 ```` ```json ````。
  // 旧版这里是 /```(?:json)?\s*\n([\s\S]*?)```/，`json` 可省略，于是段里若先出现一个
  // 裸围栏（示例块），它会绑到那一个——而 sibling 绑到 json 块，两条路径对「图在哪」的判断
  // 可以不一致，实测能产出**假的** tasks/waves-schema（示例块里的数字 id 被当成产线图的）。
  const fence = /```json\s*\n?([\s\S]*?)```/.exec(section)
  if (!fence) throw new Error('## Task Dependency Graph present but no JSON fenced block found')
  let parsed
  try {
    parsed = JSON.parse(fence[1])
  } catch {
    throw new Error('## Task Dependency Graph contains invalid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.waves)) {
    throw new Error('## Task Dependency Graph must be an object with a "waves" array (not a bare array)')
  }
  const warnings = []
  const waves = parsed.waves.map((w, i) => {
    if (w === null || typeof w !== 'object' || !Array.isArray(w.tasks)) {
      throw new Error(`wave ${i} must be {"id":<number>,"tasks":[...]}`)
    }
    if (typeof w.id !== 'number') {
      warnings.push(`wave ${i} is missing a numeric "id" (Kiro rejects the graph and falls back to sequential)`)
    }
    const tasks = w.tasks.map((n) => {
      if (typeof n === 'number') {
        warnings.push(`wave ${i} uses numeric task id ${n} (Kiro requires string ids and falls back to sequential)`)
      }
      const id = String(n)
      if (!/^\d+(\.\d+)*$/.test(id)) throw new Error(`wave ${i} contains invalid task id "${id}"`)
      return id
    })
    return [...new Set(tasks)]
  })
  if (waves.length === 0) {
    warnings.push('"waves" is an empty array — no tasks are declared, so nothing will be scheduled (this is NOT the same as omitting the graph)')
  }
  return { waves, warnings }
}

// The `## Task Dependency Graph` checks Kiro performs, in its own order and with
// its own code names. `undefined` graph means no graph section at all, which is
// not an error for a bugfix spec (Kiro skips the requirement there).
export function diagnoseDependencyGraph(content, { isBugfix = false, options = LOOSE } = {}) {
  const out = []
  const lines = fenceView(content, options)
  const start = lines.findIndex((l) => !l.inFence && kiroTrim(l.raw) === GRAPH_HEADING)
  if (start === -1) {
    if (!isBugfix) {
      // 围栏造成的情形：真机会看见这个标题（它不跳围栏），dsh 看不见 —— 额外严格度归本仓约定。
      const fenceCaused = visibleInRawText(content, (line) => line === GRAPH_HEADING)
      out.push(diag(
        'tasks/missing-dependency-graph',
        'error',
        'Missing required section: ## Task Dependency Graph.',
        fenceCaused ? 'repo-convention' : 'kiro-binary',
      ))
    }
    return out
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^## /.test(kiroTrim(lines[i].raw))) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end).map((l) => l.raw).join('\n')
  if (!/```json[\s\S]*?```/.test(section)) {
    out.push(diag(
      'tasks/missing-dag-json',
      'error',
      'Task Dependency Graph section is missing a JSON code block with wave definitions.',
      'kiro-binary',
    ))
    return out
  }
  const fence = section.match(/```json\s*\n?([\s\S]*?)```/)
  if (!fence) return out
  const body = fence[1].trim()
  if (body === '') {
    out.push(diag('tasks/empty-dag-json', 'error', 'Task Dependency Graph JSON block is empty.', 'kiro-binary'))
    return out
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    out.push(diag('tasks/invalid-dag-json', 'error', 'Task Dependency Graph contains invalid JSON.', 'kiro-binary'))
    return out
  }
  if (!parsed || !Array.isArray(parsed.waves) || parsed.waves.length === 0) {
    out.push(diag(
      'tasks/invalid-dag-structure',
      'error',
      'Task Dependency Graph must contain a non-empty "waves" array.',
      'kiro-binary',
    ))
    if (parsed && Array.isArray(parsed.waves)) {
      out.push(diag(
        'tasks/waves-schema',
        'warning',
        // ⚠️ 措辞订正（2026-09-16 晚）：原句说省略图「runs every task in a single wave」——
        // 那是 T7 之前的语义。T7 把「无图」裁决为**一任务一波（严格串行）**，于是原句变成
        // 一句会误导人的话（读起来像「省略图会跑并发」）。两态的区别是「什么都不调度」
        // vs 「全部调度、但一次一个」。
        '"waves" is an empty array — no tasks are declared, so nothing will be scheduled (this is NOT the same as omitting the graph, which schedules every task but runs them one at a time)',
        'repo-convention',
      ))
    }
    return out
  }
  try {
    const graph = dependencyGraph(content, options)
    for (const w of graph?.warnings ?? []) {
      out.push(diag('tasks/waves-schema', 'warning', w, 'repo-convention'))
    }
  } catch {
    /* already reported above by the shape check */
  }
  return out
}

// Kiro's task-body rules, restricted to the `## Tasks` section exactly as Kiro
// restricts them (a checkbox elsewhere in the file is not a task-body line to
// Kiro, although this parser deliberately scans the whole document).
export function diagnoseTaskBody(content, options) {
  const out = []
  const lines = fenceView(content, options)
  const start = lines.findIndex((l) => !l.inFence && kiroTrim(l.raw) === '## Tasks')
  if (start === -1) return out
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^## /.test(kiroTrim(lines[i].raw))) {
      end = i
      break
    }
  }
  for (let i = start + 1; i < end; i++) {
    const raw = lines[i].raw
    // Kiro's four-way branch, reproduced exactly. Note the asymmetry it relies
    // on: a top-level id needs a trailing DOT, a sub-task id does not. Both are
    // `.test()` calls, i.e. PREFIX matches.
    if (KIRO_MALFORMED_CHECKBOX_RE.test(raw) && !KIRO_CHECKBOX_RE.test(raw)) {
      out.push(diag(
        'tasks/malformed-checkbox',
        'error',
        'Malformed checkbox. Use - [ ] (unchecked) or - [x] (checked, lowercase)',
        'kiro-binary',
        i,
      ))
      continue
    }
    if (!KIRO_CHECKBOX_RE.test(raw)) continue
    const depth = /^(\s*)/.exec(raw)[1].length
    if (depth === 0) {
      if (!KIRO_TASK_TOP_RE.test(raw) && !KIRO_TASK_SUB_RE.test(raw)) {
        out.push(diag(
          'tasks/invalid-task-line',
          'error',
          'Task line does not match expected format: - [ ] N. or - [x] N.',
          'kiro-binary',
          i,
        ))
      }
    } else if (!KIRO_TASK_SUB_RE.test(raw)) {
      out.push(diag(
        'tasks/invalid-subtask-line',
        'error',
        'Sub-task line does not match expected format: - [ ] N.M or - [x] N.M',
        'kiro-binary',
        i,
      ))
    }
    // Repo convention on top of Kiro's shape check: `[~]` is INSIDE Kiro's
    // `[ x~-]` class, so Kiro parses it happily; this repo bans it as a fourth
    // state. `[/]` and `[!]` never reach here — the malformed branch above
    // consumed them, exactly as Kiro's does.
    //
    // ⚠️ 这条只在**宽松策略**下产出，这就是 declared-diff `task-state-tilde` 在 findings 层的
    // 形态：宽松侧把它当任务并报警告；严格侧在解析层就拒了它（`parseTasks` 抛
    // `Invalid task state`），根本走不到 finding 层。抹平这个差异等于删掉第 3 期有意保留的策略分歧。
    if (!strictOf(options).strictTaskState) {
      const state = KIRO_CHECKBOX_RE.exec(raw)[1].toLowerCase()
      if (state === '~') {
        const index = parseTaskLine(raw, strictOf(options))?.id ?? '<unknown>'
        out.push(diag(
          'tasks/invalid-task-state',
          'warning',
          `Task ${index} uses "[~]". Kiro parses it, but this repo allows only [ ], [-], [x]`,
          'repo-convention',
          i,
        ))
      }
    }
  }
  // Kiro scans the WHOLE document for heading-style tasks, not just `## Tasks`.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].inFence) continue
    if (/^#{2,3} Task \d+/.test(lines[i].raw)) {
      out.push(diag(
        'tasks/invalid-task-heading',
        'error',
        'Tasks must use checkbox format (- [ ] N. Description), not ## or ### headings',
        'kiro-binary',
        i,
      ))
    }
  }
  return out
}

// Cross-check the wave plan against the checkbox list in BOTH directions.
//   - a graph task with no checkbox would be dispatched against a task the file
//     never defines;
//   - a checkbox with no graph entry is never dispatched and never marked, so it
//     is silently invisible to `spec_run`.
export function diagnoseWavesConsistency(content, options) {
  const out = []
  const lines = fenceView(content, options)
  const start = lines.findIndex((l) => !l.inFence && kiroTrim(l.raw) === GRAPH_HEADING)
  if (start === -1) return out
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^## /.test(kiroTrim(lines[i].raw))) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end).map((l) => l.raw).join('\n')
  const fence = section.match(/```json\s*\n?([\s\S]*?)```/)
  if (!fence) return out
  let graph
  try {
    graph = JSON.parse(fence[1].trim())
  } catch {
    return out
  }
  if (!graph || !Array.isArray(graph.waves)) return out
  const declared = new Set()
  for (const w of graph.waves) {
    if (!w || !Array.isArray(w.tasks)) continue
    for (const id of w.tasks) declared.add(String(id))
  }
  const entries = taskEntries(content, options)
  const defined = new Set(entries.map((e) => e.index))
  // A PARENT task is a grouping label, not work: flagging parents would make
  // this check fire on every well-formed spec.
  const parents = parentTaskIds(entries)
  const undefinedInGraph = [...declared].filter((id) => !defined.has(id) && !parents.has(id))
  const absentFromGraph = [...defined].filter((id) => !declared.has(id) && !parents.has(id))
  if (undefinedInGraph.length) {
    out.push(diag(
      'tasks/waves-task-mismatch',
      'error',
      `Wave graph declares task id(s) ${undefinedInGraph.join(', ')} with no checkbox line in tasks.md`,
      'repo-convention',
    ))
  }
  if (absentFromGraph.length) {
    out.push(diag(
      'tasks/undeclared-task',
      'warning',
      `Checkbox task id(s) ${absentFromGraph.join(', ')} appear in no wave, so the runner will never dispatch or mark them`,
      'repo-convention',
    ))
  }
  return out
}

// Executable units, not raw checkbox lines. A unit is a leaf task or a top-level
// task with no children; a parent is a grouping label and counts for nothing.
// Both bands are ADVISORY — never a non-zero exit, never a block.
export function executableUnitCount(content, options) {
  const entries = taskEntries(content, options)
  const parents = parentTaskIds(entries)
  const units = entries.filter((e) => !parents.has(e.index))
  const count = units.length
  const exempt = /不拆分为多个 spec/.test(String(content ?? ''))
  if (exempt) return { count, exempt: true, warning: false, severity: null, message: '' }
  if (count > 40) {
    return {
      count,
      exempt: false,
      warning: true,
      severity: 'warning',
      message: `${count} executable units — well past the 40-unit ceiling. Splitting into multiple specs is strongly advised (and still just advice: use the phrase "不拆分为多个 spec" in ## Overview to accept the size deliberately).`,
    }
  }
  if (count > 20) {
    return {
      count,
      exempt: false,
      warning: true,
      severity: 'warning',
      message: `${count} executable units exceeds the 20-unit guideline — consider splitting the spec (the check never blocks).`,
    }
  }
  return { count, exempt: false, warning: false, severity: null, message: '' }
}

/**
 * 把任意输入安全地变成文本。`String(x)` 在一个 `toString` 会抛的对象上会抛——那只说明输入是
 * 恶意的，不是「文档格式不对」，但「恒不抛」这条契约不看动机：返回空串，让判定退化成「空文档」。
 */
function asText(content) {
  if (content === undefined || content === null) return ''
  try {
    return String(content)
  } catch {
    return ''
  }
}

/** 组装一个 artifact 的全部 finding（未套 profile）。 */
function assemble(kind, content, options = {}) {
  if (content === undefined || content === null) return []
  const text = asText(content)
  const { h1, h2 } = collectHeadings(text, options)
  const out = []
  // Two views of the document, because Kiro uses two: `norm` is trimEnd (its
  // `xE`), `rawLines` is untouched. Rules marked `trimmed: false` match the RAW
  // line, so an indented `  # Implementation Plan` must NOT satisfy them.
  const norm = text.split('\n').map(kiroTrim)
  const rawLines = text.split('\n')

  if (hasUnterminatedFence(text, strictOf(options))) {
    out.push(diag(
      `${kind}/unterminated-fence`,
      'warning',
      'A code fence is opened but never closed — every line after it is treated as code, ' +
        'so headings and tasks below it are ignored (which can undercount tasks and mask missing sections)',
    ))
  }

  if (kind === 'requirements') {
    if (!norm.some((l) => /^# Requirements Document$/.test(l))) {
      out.push(diag('requirements/missing-title', 'error', 'Missing required heading: # Requirements Document'))
    }
    // 围栏约定造成的更严：标题在原始文本里存在、只因落在围栏内而不可见。
    const fenceSources = (heading) =>
      visibleInRawText(text, (line) => line === heading) ? 'repo-convention' : undefined
    for (const [heading, code, severity, message] of [
      ['## Introduction', 'requirements/missing-introduction', 'error', 'Missing required section: ## Introduction'],
      ['## Glossary', 'requirements/missing-glossary', 'warning', 'Missing recommended section: ## Glossary'],
      ['## Requirements', 'requirements/missing-requirements-section', 'error', 'Missing required section: ## Requirements'],
    ]) {
      if (h2.has(heading)) continue
      out.push(diag(code, severity, message, fenceSources(heading)))
    }
    const okHeading = /^### Requirement \d+:/
    const looseHeading = /^### Requirement\b/
    for (let i = 0; i < rawLines.length; i++) {
      if (looseHeading.test(rawLines[i]) && !okHeading.test(rawLines[i])) {
        out.push(diag(
          'requirements/malformed-requirement-heading',
          'error',
          'Malformed requirement heading. Expected format: ### Requirement N: Title',
          undefined,
          i,
        ))
      }
      if (!okHeading.test(rawLines[i])) continue
      let end = rawLines.length
      for (let y = i + 1; y < rawLines.length; y++) {
        if (/^### /.test(rawLines[y])) {
          end = y
          break
        }
      }
      for (const section of REQUIREMENT_BLOCK_SECTIONS) {
        const slice = section.trimEnd ? norm.slice(i + 1, end) : rawLines.slice(i + 1, end)
        if (!slice.some((l) => section.pattern.test(l))) {
          out.push(diag(
            section.code,
            section.severity,
            section.code === 'requirements/missing-acceptance-criteria'
              ? 'Requirement block is missing #### Acceptance Criteria'
              : 'Requirement block is missing **User Story:**',
            undefined,
            i,
          ))
        }
      }
    }
    return out
  }

  if (kind === 'bugfix') {
    // Kiro's validateBugfixFormat. There is NO H1 rule — the real the consumer repo
    // file's H1 is `# Bugfix Requirements Document`. Note this branch matches
    // `norm` (ALL lines) and is therefore NOT fence-aware: it already agrees
    // with Kiro, so nothing here needs relabelling.
    for (const section of BUGFIX_SECTIONS) {
      if (!norm.some((l) => section.pattern.test(l))) {
        out.push(diag(section.code, 'error', `Missing required section: ${section.display}`, 'kiro-binary'))
      }
    }
    for (const line of rawLines) {
      const m = /^#{2,3}\s+(.+)$/.exec(line)
      if (!m) continue
      if (BUGFIX_DESIGN_ONLY.some((re) => re.test(m[1]))) {
        out.push(diag(
          'bugfix/unexpected-section',
          'warning',
          `Section "${m[1]}" is a design-only section and does not belong in a bugfix document`,
          'kiro-binary',
        ))
        break
      }
    }
    return out
  }

  if (kind === 'design' || kind === 'designBugfix') {
    // Which table applies, exactly as Kiro decides it:
    //   specType === Bugfix || (specType === undefined && sniff(text))
    // A declared `feature` means NO sniffing: the feature table applies even when
    // the text carries bugfix headings (`quick-spec` counts as undeclared, see
    // `resolveSpecType`).
    // `designBugfix` is the legacy kind that forces the bugfix table.
    const variant = kind === 'designBugfix' || options.specType === 'bugfix'
      ? 'bugfix'
      : options.specType === undefined ? sniffDesignVariant(text) : 'feature'
    const table = variant === 'bugfix' ? DESIGN_BUGFIX_SECTIONS : DESIGN_FEATURE_SECTIONS
    const present = collectDesignSections(text, options)
    for (const section of table) {
      if (present.has(section.name)) continue
      const requiredness = section.severity === 'error' ? 'required' : 'recommended'
      // 围栏约定造成的更严：真机（无围栏概念）看得见 `## <Section>` 的原文。
      const fenceCaused = visibleInRawText(text, (line) => {
        const m = /^##\s+(.+)$/.exec(line)
        return m ? m[1].toLowerCase() === section.name : false
      })
      out.push(diag(
        section.code,
        section.severity,
        `Missing ${requiredness} section: ## ${section.display}`,
        fenceCaused ? 'repo-convention' : 'kiro-binary',
      ))
    }
    // `# Design Document` is a REPO CONVENTION, not a Kiro rule.
    if (h1.length === 0) {
      out.push(diag(
        'design/missing-title',
        'warning',
        'No H1 title. Kiro does not require one for design.md; this repo convention asks for "# Design Document"',
        'repo-convention',
      ))
    }
    out.push(...diagnoseDesignProperties(text, options))
    return out
  }

  if (kind === 'tasks') {
    // Kiro's validateTasksFormat, in Kiro's own order.
    // RAW line: Kiro tests `/^# Implementation Plan/.test(f)` with no
    // normalisation at all.
    if (!rawLines.some((l) => /^# Implementation Plan/.test(l))) {
      out.push(diag(
        'tasks/missing-implementation-plan',
        'error',
        'Missing required heading: # Implementation Plan:',
        'kiro-binary',
      ))
    }
    for (const [heading, code, severity, message] of [
      ['## Overview', 'tasks/missing-overview', 'warning', 'Missing recommended section: ## Overview'],
      ['## Tasks', 'tasks/missing-tasks-section', 'warning', 'Missing recommended section: ## Tasks'],
      ['## Notes', 'tasks/missing-notes', 'warning', 'Missing recommended section: ## Notes'],
    ]) {
      if (h2.has(heading)) continue
      const fenceCaused = visibleInRawText(text, (line) => line === heading)
      out.push(diag(code, severity, message, fenceCaused ? 'repo-convention' : 'kiro-binary'))
    }
    // Kiro skips the graph requirement only for a DECLARED bugfix (`e !== SpecType.Bugfix`).
    out.push(...diagnoseDependencyGraph(text, { isBugfix: options.specType === 'bugfix', options }))
    out.push(...diagnoseTaskBody(text, options))
    out.push(...diagnoseWavesConsistency(text, options))
    const dupes = duplicateTaskIds(taskEntries(text, options))
    if (dupes.length) {
      out.push(diag(
        'tasks/duplicate-task-id',
        'error',
        `Duplicate task id(s): ${dupes.join(', ')} — ids must be unique`,
      ))
    }
    const units = executableUnitCount(text, options)
    if (units.warning) out.push(diag('tasks/too-many-units', units.severity, units.message, 'repo-convention'))
    return out
  }

  return out
}

const AREA_OF = { requirements: 'requirements', design: 'design', designBugfix: 'design', tasks: 'tasks', bugfix: 'bugfix' }
const KNOWN_ARTIFACTS = Object.keys(AREA_OF)

/**
 * 裁决层的唯一入口。
 *
 * 恒不抛：非字符串 markdown、未知 artifact、畸形 profile 都只导致「少几条 finding」，
 * 不会让调用方的整次工具调用失败。
 *
 * `specType` 只传 `.config.kiro` 里**写明**的值（见 `resolveSpecType` 的注释）。
 *
 * @param {{ artifact: string, markdown: unknown, profile?: object,
 *           specType?: string, isBugfix?: boolean }} input
 *   `specType` 可以原样传 `.config.kiro` 的值；只有 `feature` / `bugfix` 生效（见 `resolveSpecType`）。
 */
export function diagnose({ artifact, markdown, profile, strictTaskState, specType, isBugfix } = {}) {
  const kind = typeof artifact === 'string' ? artifact : ''
  if (!KNOWN_ARTIFACTS.includes(kind)) return []
  const findings = assemble(kind, markdown, { specType: resolveSpecType({ specType, isBugfix }), ...strictOf({ strictTaskState }) })
  const area = AREA_OF[kind]
  const withContract = findings.map((f) =>
    makeFinding({
      code: f.code,
      severity: f.severity,
      message: f.message,
      source: f.source,
      line: f.line,
      anchored: f.anchored,
      area,
      suggestedAction: f.suggestedAction,
    }),
  )
  return applyProfile(withContract, profile)
}

/**
 * 旧签名适配：`(kind, content, options)` → `diagnose({ ... })`。
 *
 * dsh-spec 的 `__test.diagnoseArtifact` 从第 1 期起就是这个名字与签名，第 3.5 期的接线
 * **不得**改它（Req 7.2：`__test` 的导出面不变）。策略保持宽松——那是 dsh-spec 的绑定。
 */
export function diagnoseArtifact(kind, content, options = {}) {
  return diagnose({ artifact: kind, markdown: content, specType: options?.specType, isBugfix: options?.isBugfix === true })
}

export { KNOWN_ARTIFACTS, AREA_OF }
