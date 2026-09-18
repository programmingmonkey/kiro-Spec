// spec-analysis — lib/drift.js（第 2 期自 plugins/dsh-spec 原样搬出）
//
// Requirements → implementation drift diagnostic (`spec_drift`): which
// requirements have no landing spot at all.
//
// READ-ONLY (Req 5.2). The module reads through the injected `port` and never
// mutates — `port.writeText` is deliberately never called, and nothing here ever
// appends a task to a frozen spec (that is the explicit non-goal of the spec:
// "只要还有活要干，就不该往冻结的 spec 里塞"). All I/O lives in `runDrift`;
// every other function is pure over text.
//
// No `node:fs` / `node:path`: file access is the caller's business. 第 2 期起，本文件
// 只 import `@my-harness/spec-parser`（Task 3.3 的收敛）—— 包的依赖面有断言守着。
import { parseTaskLine } from '@my-harness/spec-parser'

const REQUIREMENTS_FILE = 'requirements.md'
// A bugfix spec replaces requirements.md with bugfix.md, so the requirements
// artifact is whichever candidate exists first (missing = both absent).
const REQUIREMENTS_CANDIDATES = [REQUIREMENTS_FILE, 'bugfix.md']
const TASKS_FILE = 'tasks.md'

// ---------------------------------------------------------------------------
// Evidence contract (Req 5.4).
// ---------------------------------------------------------------------------
// `evidence` is a MANDATORY field on every entry, and its value is `weak` by
// construction — deliberately, not as a placeholder. The judgment "this
// requirement has no implementation landing spot" is made from task state
// alone, because file-level evidence is genuinely unobtainable: a whole-corpus
// scan for `_Files:` / `_Targets:` / `_Paths:` annotations over the consumer repo (the
// reference corpus) returns ZERO hits across every spec, so there is no file to
// point at and inventing one would be fabrication. Task state is the strongest
// signal that exists today.
//
// `strong` / `medium` stay in the type contract for the day a spec starts
// emitting file-level annotations; nothing emits them yet.
const DRIFT_EVIDENCE = ['strong', 'medium', 'weak']
const TASK_STATE_EVIDENCE = 'weak'

// The three-valued task state this repo uses. Kiro's checkbox character class
// is `[ x~-]`, so a line may legally carry `~` too; only `x` means done, and
// `valid` distinguishes THIS repo's legal three states from the wider class.
const TASK_STATES = [' ', '-', 'x']

// Kiro's task line: `- [ ] N. title` / `- [-] N.M title`. 「哪一行是任务」是**共享层**的
// 职责（第 3 期把它移进了 `@my-harness/spec-parser`），本文件只消费它的判定。
//
// 第 2 期收敛掉的是本文件原来的 `TASK_LINE_RE`（全仓第三份任务行正则）。实测差异见
// `test/fixtures/conflict-consequences.json`：
//
//   形状空间 2160 例：更宽 900 / 更窄 135
//     更宽 —— `- [ ]1`（`]` 与 id 之间没有空格）、`- [ ]*1`（`*` 后没有空格）、
//             `- [ ] * 1`（`*` 前有空格）              → 360 / 360 / 180 例
//     更窄 —— `- [ ] 1.foo`（尾点后直接跟正文，共享层判为任务）  → 135 例
//   真实语料 228 份 tasks.md / 51,671 行：差异 **0 行**。
//
// 两个方向都该收敛：更宽那一侧与共享层的 **D 行已断言决定**
// （`spec-parser/test/task-format.test.mjs:116/135`：`]` 与 `*` 之间有空格不是任务）
// 直接矛盾 —— 同一个仓库里两处判定不许相反；更窄那一侧会让 drift **漏算**落地位置，
// 把本该 `info` 的需求报成 `unreferenced/warning`（漏算比多算危险，REVIEW 的 F2 结论）。
//
// ⚠️ 「0 行」是**今天的语料**，不是「没有行为变更」：形状空间里那 1035 例的判定确实变了，
// 将来谁写出那种行，drift 的结论就会跟着变。别把这条读成「零影响」。
//
// ⚠️ 本文件自带的 `scanLines`（全仓第三份围栏实现）**本期不动**：Task 0.3 的判定只覆盖
// 任务行正则，围栏统一留到第 3 期的收尾。所以现在「这一行是不是任务」用共享层、
// 「这一行在不在围栏里」仍用本文件的旧语义 —— 记为开放项，不要以为已经统一了。
const TASK_DETAIL_RE = /^\s{2,}\S/
const REQUIREMENT_HEADING_RE = /^###\s+(?:Requirement\s+)?(\d+)\s*[.:]/

// ---------------------------------------------------------------------------
// Severity ladder and the frozen suppression (Req 5.5).
// ---------------------------------------------------------------------------
// Ordered from loudest to quietest. `hint` sits below `info` for one concrete
// reason: the suppression must be STRICTLY monotonic for EVERY entry, including
// the boundary case "every task is [x]" where an entry's unfrozen severity is
// already `info`. With a 3-rung ladder those entries would map info → info,
// i.e. "not higher" but not strictly lower, and the correctness property for
// the frozen boundary would not hold. Today `hint` is only ever produced by
// suppression of an `info` entry — an unfrozen report never emits it.
const SEVERITY_LADDER = ['error', 'warning', 'info', 'hint']

// Unfrozen severity per status: a requirement nobody ever picked up is the
// real drift signal (warning); a requirement whose tasks are still open is
// simply in progress (info); a requirement nothing could be checked against
// (no tasks.md) cannot be exonerated, so it stays a warning.
const BASE_SEVERITY = {
  'no-tasks': 'warning',
  unreferenced: 'warning',
  'referenced-not-done': 'info',
  'referenced-done': 'info',
}
const DRIFT_STATUSES = ['unreferenced', 'referenced-not-done', 'referenced-done', 'no-tasks']

function severityRank(severity) {
  return SEVERITY_LADDER.indexOf(severity)
}

/**
 * Pure: drop one rung on the severity ladder when the spec is frozen.
 * `(severity, frozen) -> severity`, floored at the quietest rung.
 */
export function suppressSeverity(severity, frozen) {
  if (!frozen) return severity
  const i = severityRank(severity)
  if (i === -1) return severity
  return SEVERITY_LADDER[Math.min(i + 1, SEVERITY_LADDER.length - 1)]
}

// ---------------------------------------------------------------------------
// Pure parsing.
// ---------------------------------------------------------------------------

// Split a document into `{ raw, no, inFence }` lines, tracking ``` / ~~~ fences.
// Same convention as the rest of the plugin: a checkbox or a `###` inside a
// fenced example is not real content.
function scanLines(content) {
  let inFence = false
  let fenceChar = ''
  return String(content ?? '').split('\n').map((raw, i) => {
    const t = raw.trim()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(t)
    const fenced = inFence || fenceMatch !== null
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
        fenceChar = ''
      }
    }
    return { raw, no: i + 1, inFence: fenced }
  })
}

// `{ anchor, title }` per requirement block, in document order.
function parseRequirementOutline(content) {
  const out = []
  for (const line of scanLines(content)) {
    if (line.inFence) continue
    const t = line.raw.trim()
    const m = REQUIREMENT_HEADING_RE.exec(t)
    if (m) out.push({ anchor: m[1], title: t.slice(m[0].length).trim() })
  }
  return out
}

// Requirement ids a single `_Requirements:` detail line cites. Only the leading
// integer matters (`1.1` refers to block `1`). `全部` / `all` is a wildcard:
// real corpus specs write `_Requirements: 全部_`, and ignoring it would report
// every requirement of such a spec as unreferenced — a false positive.
function refsFromDetailLine(raw) {
  const m = /_Requirements:\s*([^_]*)_/i.exec(raw)
  if (!m) return { ids: [], all: false }
  const ids = []
  let all = false
  for (const part of m[1].split(/[,\s]+/)) {
    const p = part.trim()
    if (!p) continue
    if (/^(?:全部|所有|all)$/i.test(p)) all = true
    const num = /^(\d+)(?:\.\d+)*$/.exec(p)
    if (num) ids.push(num[1])
  }
  return { ids, all }
}

/**
 * Parse tasks.md into `{ index, state, valid, done, requirements, referencesAll }`
 * entries. Pure. Indented detail lines following a task line belong to it.
 */
export function parseTaskEntries(tasksContent) {
  const entries = []
  let current
  for (const line of scanLines(tasksContent)) {
    if (line.inFence) continue
    const parsed = parseTaskLine(line.raw)
    if (parsed !== undefined && parsed.kind === 'task') {
      // `parseTaskLine` 已经小写化过 state；`valid` 仍是**本仓的三态**
      // （`[' ', '-', 'x']`），不是共享层那条更宽的四字符类 `[ x~-]` ——
      // 两者的区别是 `[~]`：它是一条能解析的任务，但不是本仓承认的合法状态。
      const state = parsed.state
      current = {
        index: parsed.id,
        state,
        valid: TASK_STATES.includes(state),
        done: state === 'x',
        requirements: [],
        referencesAll: false,
      }
      entries.push(current)
      continue
    }
    if (current === undefined) continue
    if (TASK_DETAIL_RE.test(line.raw)) {
      const { ids, all } = refsFromDetailLine(line.raw)
      if (all) current.referencesAll = true
      for (const id of ids) {
        if (!current.requirements.includes(id)) current.requirements.push(id)
      }
    } else if (/^\s*---\s*$/.test(line.raw)) {
      current = undefined // a horizontal rule ends the task block
    }
  }
  return entries
}

/**
 * Pure: is the spec frozen, i.e. is every task line `[x]`?
 * A task-less `tasks.md` is NOT frozen: vacuous truth would declare a spec
 * finished and quiet every drift signal in a file that may not be written yet.
 */
export function isFrozen(tasksContent) {
  if (tasksContent === undefined) return false
  const tasks = parseTaskEntries(tasksContent)
  return tasks.length > 0 && tasks.every((t) => t.done)
}

// ---------------------------------------------------------------------------
// Pure judgement + recommendation.
// ---------------------------------------------------------------------------

/**
 * Recommendation text for one drift entry (Req 5.3). Signature: a single
 * descriptor object, so a caller can build it straight from an entry:
 *
 *   driftRecommendations({ requirement, status, frozen, feature, tasks })
 *
 * Every return value carries BOTH escape routes — open a fresh `<feature>-v2`
 * spec, or use the append-amendment channel (only for a change that has already
 * landed in code). The append-amendment route records "已经这样了", never
 * "打算这样", which is exactly why it is conditional.
 */
export function driftRecommendations({
  requirement = '',
  status = 'unreferenced',
  frozen = false,
  feature = 'feature',
  tasks = [],
} = {}) {
  const parts = []
  if (status === 'referenced-done') {
    parts.push(`No drift: requirement ${requirement} is covered by done task(s) ${tasks.join(', ') || '(none)'}.`)
  } else if (status === 'referenced-not-done') {
    parts.push(
      `Requirement ${requirement} is referenced by still-open task(s) ${tasks.join(', ') || '(none)'} — finish them, or, if the work moved, take a route below.`,
    )
  } else if (status === 'no-tasks') {
    parts.push(
      `Cannot judge requirement ${requirement}: ${TASKS_FILE} is absent, so no task state exists to cite as evidence.`,
    )
  } else {
    parts.push(`No implementation landing spot found for requirement ${requirement} (evidence: task state only).`)
  }
  parts.push(`Route 1 — open a fresh \`${feature}-v2\` spec.`)
  parts.push(
    'Route 2 — use the append-amendment channel, only for a change that has ALREADY landed in code (it records what happened, not what is planned).',
  )
  if (frozen) {
    parts.push(
      `This spec is frozen (every task is \`[x]\`): report only — the task body is never edited.`,
    )
  }
  return parts.join(' ')
}

/**
 * Pure: build the READ-ONLY correspondence table from already-read text
 * (`undefined` = file absent). Returns `{ frozen, missingFiles, entries }`.
 */
export function buildDriftReport({ requirementsText, tasksText, feature = 'feature' } = {}) {
  const missingFiles = []
  if (requirementsText === undefined) missingFiles.push(REQUIREMENTS_FILE)
  if (tasksText === undefined) missingFiles.push(TASKS_FILE)

  const frozen = isFrozen(tasksText)
  const tasks = tasksText === undefined ? [] : parseTaskEntries(tasksText)
  const byId = new Map(tasks.map((t) => [t.index, t]))
  const outline = requirementsText === undefined ? [] : parseRequirementOutline(requirementsText)

  const entries = outline.map(({ anchor, title }) => {
    let status
    let refs = []
    if (tasksText === undefined) {
      status = 'no-tasks'
    } else {
      // The wildcard is PER TASK (`this task covers every requirement`), never
      // global: treating one `_Requirements: 全部_` line as "every task covers
      // everything" would mark all requirements referenced by all tasks and
      // hide real drift.
      refs = tasks
        .filter((t) => t.referencesAll || t.requirements.includes(anchor))
        .map((t) => t.index)
        .filter((id, i, all) => all.indexOf(id) === i)
      if (refs.length === 0) status = 'unreferenced'
      else status = refs.every((id) => byId.get(id)?.done === true) ? 'referenced-done' : 'referenced-not-done'
    }
    const severity = suppressSeverity(BASE_SEVERITY[status], frozen)
    return {
      requirement: anchor,
      title,
      severity,
      status,
      evidence: TASK_STATE_EVIDENCE,
      tasks: refs,
      recommendation: driftRecommendations({ requirement: anchor, status, frozen, feature, tasks: refs }),
    }
  })

  return { frozen, missingFiles, entries }
}

// ---------------------------------------------------------------------------
// The one I/O function.
// ---------------------------------------------------------------------------

// `specDir` is already absolute and the port takes absolute paths, so joining is
// a string operation — no `node:path` import just to add a slash.
function joinSpecPath(specDir, name) {
  return `${String(specDir ?? '').replace(/[/\\]+$/, '')}/${name}`
}

function baseName(specDir) {
  const parts = String(specDir ?? '').replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || 'feature'
}

async function readFirst(port, specDir, names) {
  for (const name of names) {
    const text = await port.readText(joinSpecPath(specDir, name))
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * Produce the READ-ONLY drift report for one spec directory. A missing file is
 * recorded in `missingFiles` and the run continues — never an exception.
 */
export async function runDrift({ port, specDir }) {
  const requirementsText = await readFirst(port, specDir, REQUIREMENTS_CANDIDATES)
  const tasksText = await port.readText(joinSpecPath(specDir, TASKS_FILE))
  // The feature name feeds the `<feature>-v2` escape route (Req 5.3).
  const report = buildDriftReport({ requirementsText, tasksText, feature: baseName(specDir) })
  // 🔴 「没输入」不等于「零漂移」（第 8 期 `acceptance-net-firing`）。与 `runChecklist`
  // 同一形态、同一修法：三种"看起来空"的输入原先都返回 `entries: []`，
  // 而空数组会被读成"没有漂移"。判据的由来见 checklist.js 同名段的注释。
  const reason = requirementsText === undefined
    ? 'NO_REQUIREMENTS_FILE'
    : (report.entries.length === 0 ? 'NO_REQUIREMENT_BLOCKS' : undefined)
  // ⚠️ `missingFiles` 照样带上 —— 理由见 checklist.js 同名段。
  if (reason) return { specDir, applicable: false, reason, missingFiles: report.missingFiles }
  return { specDir, applicable: true, ...report }
}

export { BASE_SEVERITY, DRIFT_EVIDENCE, DRIFT_STATUSES, SEVERITY_LADDER, TASK_STATE_EVIDENCE }
export { REQUIREMENTS_FILE, TASKS_FILE, scanLines, severityRank, refsFromDetailLine }
