// spec-analysis — lib/checklist.js（第 2 期自 plugins/dsh-spec 原样搬出）
//
// Requirements quality checklist (`spec_checklist`): judge requirements.md on
// dimensions Kiro's own format validator does not cover — untestable criteria,
// vague quantifiers, and requirements no task ever picks up.
//
// READ-ONLY (Req 4.7). Everything is read through the injected `port`; the
// module never mutates, and `port.writeText` is deliberately never called (the
// test suite hashes the spec directory before and after a run). All I/O lives in
// `runChecklist` — every other function is pure over text, so each rule can be
// tested directly with no port and no filesystem.
//
// No `node:fs` / `node:path`: file access is the caller's business, and the
// single thin I/O function is what keeps that boundary honest.
const REQUIREMENTS_FILE = 'requirements.md'
// A bugfix spec replaces requirements.md with bugfix.md, so the requirements
// artifact is whichever candidate exists first. "Missing" therefore means BOTH
// are absent — reporting `requirements.md` when `bugfix.md` answered the
// question would be a false alarm.
const REQUIREMENTS_CANDIDATES = [REQUIREMENTS_FILE, 'bugfix.md']
const TASKS_FILE = 'tasks.md'

// EARS keywords match UPPERCASE only: the notation IS the contract (`SHALL`,
// not `shall`), so a lowercase English word inside prose must not make a
// criterion look testable.
const EARS_KEYWORDS = ['WHEN', 'WHILE', 'WHERE', 'IF', 'THEN', 'SHALL', 'THE SYSTEM']
const EARS_RE = new RegExp(`\\b(?:${EARS_KEYWORDS.join('|')})\\b`)

// Untestable quantifiers. A criterion phrased with one of these cannot be
// verified objectively — which is the whole reason the rule exists.
const VAGUE_QUANTIFIERS = ['适当', '合理', '尽快', '若干', '良好']

// Requirement heading. Kiro writes `### Requirement N:`, but legacy specs in
// this repo wrote `### N.`; both are judged, and the captured number — not the
// heading text — is what a finding anchors on (Req 4.4).
const REQUIREMENT_HEADING_RE = /^###\s+(?:Requirement\s+)?(\d+)\s*[.:]/
const ACCEPTANCE_HEADING_RE = /^####\s+Acceptance Criteria\b/i
// A criterion is a numbered or bulleted line. The `(\S.*)` guard rejects an
// empty marker (`1.` with nothing after it) rather than inventing a criterion.
const CRITERION_RE = /^\s*(?:\d+[.)]|[-*+])\s+(\S.*)$/
const USER_STORY_RE = /\*\*User Story:\*\*/

// The rule table (design.md §4.4). `source` matters as much as the rule: a
// Kiro-binary verdict is a hard incompatibility with the authoritative
// validator, while a repo-convention verdict is this repo's own stricter taste
// (Req 4.6) and must never masquerade as a Kiro error.
const RULES = [
  {
    id: 'checklist/no-criteria',
    severity: 'error',
    source: 'kiro-binary',
    verdict: 'a requirement block has no `#### Acceptance Criteria`',
  },
  {
    id: 'checklist/no-user-story',
    severity: 'warning',
    source: 'kiro-binary',
    verdict: 'a requirement block has no `**User Story:**`',
  },
  {
    id: 'checklist/no-ears-keyword',
    severity: 'warning',
    source: 'repo-convention',
    verdict: 'an acceptance criteria line has no uppercased EARS keyword',
  },
  {
    id: 'checklist/vague-quantifier',
    severity: 'warning',
    source: 'repo-convention',
    verdict: 'text contains an untestable quantifier',
  },
  {
    id: 'checklist/unreferenced-requirement',
    severity: 'warning',
    source: 'repo-convention',
    verdict: 'a requirement is not cited by any task-side `_Requirements:_` line',
  },
]

// ---------------------------------------------------------------------------
// Pure parsing.
// ---------------------------------------------------------------------------

// Split a document into `{ raw, no, inFence }` lines, tracking ``` / ~~~ fences
// (a fence closes only on a line starting with the same character). Same
// convention as the rest of the plugin: a fact is never judged two different
// ways, so every "which lines matter" question funnels through here — a `####`
// inside a fenced example must not impersonate a section.
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

// A requirement block runs from its `### ...` heading until the next `### `
// heading (any H3 — a malformed one still ends the previous block, otherwise a
// broken heading would silently absorb every later requirement).
function parseRequirementBlocks(content) {
  const blocks = []
  let current
  for (const line of scanLines(content)) {
    if (!line.inFence) {
      const t = line.raw.trim()
      const m = REQUIREMENT_HEADING_RE.exec(t)
      if (m) {
        current = { anchor: m[1], title: t.slice(m[0].length).trim(), lines: [] }
        blocks.push(current)
        continue
      }
      if (current !== undefined && /^###\s/.test(t)) {
        current = undefined
        continue
      }
    }
    if (current !== undefined) current.lines.push(line)
  }
  return blocks
}

// The acceptance-criteria subsection of one block: `{ present, criteria }`.
// `present` is the heading's presence (the literal `no-criteria` verdict), and
// `criteria` holds each numbered/bulleted line together with its wrapped
// continuation lines so a criterion split across lines is still one criterion.
function parseAcceptanceCriteria(block) {
  let present = false
  const criteria = []
  for (const line of block?.lines ?? []) {
    if (line.inFence) continue
    const t = line.raw.trim()
    if (!present) {
      if (ACCEPTANCE_HEADING_RE.test(t)) present = true
      continue
    }
    if (/^#{1,4}\s/.test(t)) break // the next subsection ends the criteria list
    const m = CRITERION_RE.exec(line.raw)
    if (m) {
      criteria.push({ text: m[1].trim(), no: line.no })
      continue
    }
    if (t === '') continue
    if (criteria.length) {
      // a wrapped or annotated continuation of the previous criterion
      criteria[criteria.length - 1].text = `${criteria[criteria.length - 1].text} ${t}`
    }
  }
  return { present, criteria }
}

function hasUserStory(block) {
  return (block?.lines ?? []).some((l) => !l.inFence && USER_STORY_RE.test(l.raw))
}

function hasEarsKeyword(text) {
  return EARS_RE.test(String(text ?? ''))
}

// Distinct untestable quantifiers in a text, in table order so the findings are
// deterministic.
function findVagueQuantifiers(text) {
  const s = String(text ?? '')
  return VAGUE_QUANTIFIERS.filter((w) => s.includes(w))
}

// Requirement ids cited by `_Requirements: 1.1, 2.3_` detail lines. Only the
// leading integer matters, because the judged unit is the `### N` block.
// `全部` / `all` is treated as a wildcard: real specs in this corpus do write
// `_Requirements: 全部_`, and ignoring it would report every requirement in
// such a spec as unreferenced — a false positive, i.e. the expensive direction.
function parseRequirementRefs(tasksContent) {
  const ids = new Set()
  let all = false
  for (const line of scanLines(tasksContent)) {
    if (line.inFence) continue
    const m = /_Requirements:\s*([^_]*)_/i.exec(line.raw)
    if (!m) continue
    for (const part of m[1].split(/[,\s]+/)) {
      const p = part.trim()
      if (!p) continue
      if (/^(?:全部|所有|all)$/i.test(p)) all = true
      const num = /^(\d+)(?:\.\d+)*$/.exec(p)
      if (num) ids.add(num[1])
    }
  }
  return { ids: [...ids], all }
}

// ---------------------------------------------------------------------------
// Pure judgement.
// ---------------------------------------------------------------------------

function finding(rule, anchor, message) {
  // Exactly the five documented keys — the shape is a contract, so no extra
  // diagnostic fields leak in and break a strict deep-equal downstream.
  return { ruleId: rule.id, severity: rule.severity, source: rule.source, anchor, message }
}

/**
 * Run every rule over already-read text (`undefined` = file absent).
 * Pure: no port, no filesystem. Returns `{ counts, missingFiles, findings }`.
 */
export function evaluateChecklist({ requirementsText, tasksText } = {}) {
  const byRule = new Map(RULES.map((r) => [r.id, r]))
  const missingFiles = []
  const findings = []

  if (requirementsText === undefined) missingFiles.push(REQUIREMENTS_FILE)
  if (tasksText === undefined) missingFiles.push(TASKS_FILE)
  const references = tasksText === undefined ? undefined : parseRequirementRefs(tasksText)

  const blocks = requirementsText === undefined ? [] : parseRequirementBlocks(requirementsText)
  // Per-block error+warning tallies, keyed by block INDEX (not by anchor: two
  // blocks could carry the same number, and `passed` counts blocks).
  const problems = blocks.map(() => 0)

  blocks.forEach((block, bi) => {
    const anchor = block.anchor
    const add = (f) => {
      findings.push(f)
      if (f.severity !== 'info') problems[bi] += 1
    }

    if (!hasUserStory(block)) {
      add(finding(byRule.get('checklist/no-user-story'), anchor, `Requirement ${anchor} has no \`**User Story:**\` line.`))
    }

    const { present, criteria } = parseAcceptanceCriteria(block)
    if (!present) {
      add(
        finding(
          byRule.get('checklist/no-criteria'),
          anchor,
          `Requirement ${anchor} has no \`#### Acceptance Criteria\` section.`,
        ),
      )
    } else if (criteria.length === 0) {
      // The heading exists but carries no criteria — the same defect from a
      // quality standpoint, so it must not slip through as "passed".
      add(
        finding(
          byRule.get('checklist/no-criteria'),
          anchor,
          `Requirement ${anchor} has an empty \`#### Acceptance Criteria\` section (no criteria lines).`,
        ),
      )
    } else {
      criteria.forEach((c, ci) => {
        if (hasEarsKeyword(c.text)) return
        const clip = c.text.length > 80 ? `${c.text.slice(0, 80)}…` : c.text
        add(
          finding(
            byRule.get('checklist/no-ears-keyword'),
            anchor,
            `Requirement ${anchor} criterion ${ci + 1} has no uppercased EARS keyword (${EARS_KEYWORDS.join(' / ')}): "${clip}"`,
          ),
        )
      })
    }

    // The heading title is part of the requirement's text too, so it is scanned
    // alongside the body.
    const body = [block.title, ...block.lines.filter((l) => !l.inFence).map((l) => l.raw)].join('\n')
    for (const word of findVagueQuantifiers(body)) {
      add(
        finding(
          byRule.get('checklist/vague-quantifier'),
          anchor,
          `Requirement ${anchor} contains the untestable quantifier \`${word}\`; replace it with a measurable criterion.`,
        ),
      )
    }

    if (references !== undefined && !references.all && !references.ids.includes(anchor)) {
      add(
        finding(
          byRule.get('checklist/unreferenced-requirement'),
          anchor,
          `Requirement ${anchor} is not cited by any \`_Requirements:_\` line in ${TASKS_FILE}.`,
        ),
      )
    }
  })

  const counts = { error: 0, warning: 0, info: 0, total: 0, passed: 0 }
  for (const f of findings) counts[f.severity] += 1
  counts.total = findings.length
  counts.passed = problems.filter((n) => n === 0).length
  return { counts, missingFiles, findings }
}

/**
 * The first-version rule table (design.md §4.4). Fresh copies, so a caller
 * cannot mutate the shared table.
 */
export function checklistRules() {
  return RULES.map((r) => ({ ...r }))
}

// ---------------------------------------------------------------------------
// The one I/O function.
// ---------------------------------------------------------------------------

// `specDir` is already absolute and the port takes absolute paths, so joining is
// a string operation — no `node:path` import just to add a slash.
function joinSpecPath(specDir, name) {
  return `${String(specDir ?? '').replace(/[/\\]+$/, '')}/${name}`
}

async function readFirst(port, specDir, names) {
  for (const name of names) {
    const text = await port.readText(joinSpecPath(specDir, name))
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * Produce the READ-ONLY requirements-quality report for one spec directory.
 * A missing file is recorded in `missingFiles` and the run continues — never an
 * exception (Req 4.7).
 */
export async function runChecklist({ port, specDir }) {
  const requirementsText = await readFirst(port, specDir, REQUIREMENTS_CANDIDATES)
  const tasksText = await port.readText(joinSpecPath(specDir, TASKS_FILE))
  const report = evaluateChecklist({ requirementsText, tasksText })
  // 🔴 「没输入」不等于「零问题」（第 8 期 `acceptance-net-firing`）。
  //
  // 原先三种完全不同的输入返回**逐字同形**的报告（counts 全零 / findings 空）：
  //   ① 目录里既没有 requirements.md 也没有 bugfix.md；
  //   ② 是 bugfix.md（需求在那三段里，没有 `### N.` 块）；
  //   ③ requirements.md 存在但为空。
  // 而渲染出来是一行 `0 error(s), 0 warning(s)` —— 读起来像"查过且干净"。
  //
  // 判据只做「显式不适用」，**不**去解析 bugfix.md 的三段：那是新写一个分析器，
  // 不是修一个沉默（见 `.kiro/specs/acceptance-net-firing/design.md` 的"一处刻意不做"）。
  const reason = requirementsText === undefined
    ? 'NO_REQUIREMENTS_FILE'
    : (parseRequirementBlocks(requirementsText).length === 0 ? 'NO_REQUIREMENT_BLOCKS' : undefined)
  // ⚠️ `missingFiles` **照样带上**：它是"这个目录里缺哪些文件"的事实，与"本次分析不适用"
  // 是两件事。丢掉它会让既有那条"空 spec 目录仍可检视"的行为断言变红 —— 实测撞到过。
  if (reason) return { specDir, applicable: false, reason, missingFiles: report.missingFiles }
  return { specDir, applicable: true, ...report }
}

export { EARS_KEYWORDS, VAGUE_QUANTIFIERS, REQUIREMENTS_FILE, TASKS_FILE }
export { scanLines, parseRequirementBlocks, parseAcceptanceCriteria, hasUserStory, hasEarsKeyword, findVagueQuantifiers, parseRequirementRefs }
