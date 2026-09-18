// spec-analysis — the incremental-correction channel for a FROZEN spec
// （第 2 期自 plugins/dsh-spec 原样搬出）。
//
// A spec under `.kiro/specs/<feature>/` is a snapshot of a change, not a living
// document. "Frozen" nevertheless does not mean read-only: the consumer repo's
// spec-conventions §7.1.1 ("冻结不等于只读：追加修正通道") sanctions exactly one way
// to correct an established spec — leave a trace, append rather than rewrite —
// and exactly one absolute rule: THE TASK BODY IS FROZEN.
//
//   applyParamEdit          parameter-class values are edited IN PLACE (Req 6.1)
//   appendRequirement       new requirements continue past the existing max (6.2)
//   appendDesignAmendment   new design points go to `## Amendments` (Req 6.3)
//   assertNotTaskBody       the guard that makes Req 6.4 unbreakable (exported so
//                           the rejection itself can be unit-tested)
//
// The task body is not merely "not written" here — it cannot be *addressed*. Two
// independent gates: `assertNotTaskBody` refuses a tasks.md target by name, and
// every writer screens its proposed text for a checkbox line / a `{"waves":[...]}`
// json block AND then re-checks the document's task-body signature before writing.
// The second gate is not redundant: it catches an edit that lands *inside* an
// existing waves block without the proposed text looking like one.
//
// ZERO filesystem access by design: every read and write goes through an injected
// `port` ({ readText, writeText, listDir, exists }), so this module stays pure and
// the host keeps ownership of the sandbox policy. No `node:fs`, no `node:path` —
// the path work this module needs (join, basename, the `_archive` segment test) is
// done on strings below.

// ---------------------------------------------------------------------------
import { parseTaskLine } from '@my-harness/spec-parser'

// Refusals. The messages are the deliverable: a caller who cannot see why a write
// was refused will route around the guard.
// ---------------------------------------------------------------------------

// The three machine consequences of editing a task body (§7.1.1), spelled out
// because they are the entire argument for the refusal.
const TASK_BODY_CONSEQUENCES = [
  '  1. Appending a checkbox requires editing `waves` in the same breath, and appending an *unchecked*',
  '     task flips an already-complete spec back to incomplete — progress is derived from the checkbox',
  '     set, so `complete` silently stops being reachable.',
  "  2. Renaming a task title silently orphans that task's entry in tasks.meta.json's `executionHistory`:",
  '     Kiro keys history by task title, so the recorded run no longer resolves to any task.',
  '  3. The wave runner marks the FIRST line matching a task id, so duplicating or editing an id makes the',
  '     runner execute one task while marking another.',
].join('\n')

// 三个门各有各的「怎么改」。**不许三处共用同一句尾**：那句话只对第一个门成立。
//
// 由来（整体 review 的 F11）：原先三个门共用一句「Correct requirements.md / design.md instead
// (applyParamEdit …)」。对门 1（目标是 tasks.md）它是对的；对门 2a/2b 它是**死路** ——
// 那两处正是在 `applyParamEdit` 里抛的，等于把人指回刚拒绝他的那个调用。
// 拒绝消息是本模块的交付物之一（见上面那段注释）：看不见「为什么被拒、下一步做什么」的
// 调用方会绕过守卫。所以每个门配一句能落地的话。
const REMEDY = {
  // 门 1：文件名。你要动的是 tasks.md —— 换目标文件。
  target:
    'Correct requirements.md / design.md instead (applyParamEdit / appendRequirement /\n' +
    "appendDesignAmendment), and record the change in tasks.md's `## Notes` via the signature channel.",
  // 门 2a：**提议写入的文本**里带着任务行。目标文件本来就是 requirements/design，
  // 所以话要落在「改你这段文本」，而不是「换个文件」。
  text:
    'This refusal is about the TEXT you asked to write, not about the target file: the target is already\n' +
    'requirements.md / design.md, which must not carry task-shaped lines. Drop or rewrite the checkbox\n' +
    'line (and any `waves` JSON block) in that text, then repeat the same call.',
  // 门 2b：写后校验。提议文本本身干净，但这次编辑会改动**已存在的** task-body 行。
  unchanged:
    'This refusal is about an EXISTING task-body line: your edit would rewrite one (the document\'s\n' +
    'checkbox set or its `waves` block differs before and after). Narrow `from` so it matches only the\n' +
    'text you actually meant to change and does not reach a checkbox line or the `waves` block.',
}

function taskBodyRefusal(context, remedy = REMEDY.target) {
  // `code` 让宿主不必靠匹配文案来分类这条拒绝（spec-state 的 catch 是
  // `caught.code ?? 'AMEND_REFUSED'`，于是它会原样透出 TASK_BODY_FROZEN）。
  // 靠文案分类的话，改一个字就会把分类悄悄改掉。
  return Object.assign(
    new Error(
      `Refusing to write a task body (${context}).\n` +
        "tasks.md's checkbox lines and its `waves` JSON are frozen (spec-conventions §7.1.1): a spec is a\n" +
        'checkpointed plan, and even the smallest edit corrupts the machinery that reads it —\n' +
        `${TASK_BODY_CONSEQUENCES}\n` +
        remedy,
    ),
    { code: 'TASK_BODY_FROZEN' },
  )
}

// A task checkbox line, verbatim from the brief. 第 2 期起它只是**析取式的一半**：见
// `isTaskBodyLine`。
const TASK_CHECKBOX_RE = /^\s*-\s*\[[^\]]\]\s*\d+(\.\d+)*\.?/

// ---------------------------------------------------------------------------
// 「这一行是不是 task body」= 共享层判为任务 **或** 旧宽正则命中（Task 0.3 的取并集）。
// ---------------------------------------------------------------------------
//
// 为什么是并集，而不是收敛到共享层：这个谓词是**拒绝写入的守卫**。拒绝面只增不减时，
// 最坏情况是多拒一条（人看得见、能申诉）；而放开是静默放行（没人看得见）。方向不对称，
// 所以取严的那一侧。
//
// 两半各自守着一条真实的失效（都有断言）：
//   ① 共享层那一半补上一个**实测存在的洞**：旧正则不认 `- [ ]* N.N …`，而那是**本仓
//      自己的**可选取子任务记法。真实语料里命中 44 行，分布在 8 份消费项目 `tasks.md`
//      （`test/fixtures/conflict-consequences.json`）。旧守卫因此对这类行完全放行。
//   ② 旧正则那一半守着粘连 id（`- [ ] 1.1foo`）：它不是共享层意义上的任务，但一条畸形
//      的复选框行正是「一次坏编辑」留下的东西，所以要继续拒。
//
// 🔴 **这一条没有消灭第四份实现。** 第 2 期的目标之一是「不把三份互相矛盾的实现固化成
// 跨包既成事实」；在 `TASK_LINE_RE`（drift）与 `signature.scanLines` 上那是真的，**在这一条
// 上只达成一半**：矛盾被降级成一个被解释的析取分支，但仍留在这个文件里。
//
// 要真正消灭它，得先回答一个不属于本期范围的问题：**粘连 id（`- [ ] 1.1foo`）到底该不该
// 算任务？** 共享层说不是，而共享层的 D 行邻居（`]` 与 `*` 之间的空格）已经因为是「不像
// 本仓记法」而被判为不是任务。这个问题的去向记在第 3 期的围栏/任务行收尾里。
//
// 实测（`test/fixtures/conflict-consequences.json`）：形状空间 2160 例中旧正则 更宽 315 /
// 更窄 450；真实语料 228 份 `tasks.md` 上 更窄 44 行、更宽 0 行。
function isTaskBodyLine(line) {
  const parsed = parseTaskLine(line)
  if (parsed !== undefined && parsed.kind === 'task') return true
  return TASK_CHECKBOX_RE.test(line)
}

// Kiro's heading form and the legacy `### 1.` form. Numbering must continue past
// the maximum found across BOTH.
const REQUIREMENT_HEADING_RE = /^###\s+Requirement\s+(\d+)\s*:/i
const LEGACY_REQUIREMENT_HEADING_RE = /^###\s+(\d+)\./

const AMENDMENTS_HEADING = '## Amendments'
const AMENDMENTS_SUBTITLE = '> 补充修正'

// ---------------------------------------------------------------------------
// Path / arg helpers (no node:path — see the header).
// ---------------------------------------------------------------------------

function joinPath(...parts) {
  const out = []
  for (const part of parts) {
    if (part === undefined || part === null || part === '') continue
    const s = String(part)
    if (out.length === 0) out.push(s.replace(/[\\/]+$/, '') || '/')
    else out.push(s.replace(/^[\\/]+/, '').replace(/[\\/]+$/, ''))
  }
  return out.join('/')
}

// Any path segment exactly equal to `_archive`. Segment-wise because a spec named
// `my_archive_notes` must not be mistaken for the archive area.
function hasArchiveSegment(p) {
  return String(p ?? '')
    .split(/[\\/]+/)
    .some((segment) => segment === '_archive')
}

function requirePort(port, method) {
  if (!port || typeof port[method] !== 'function') {
    throw new Error(
      `amendments: port.${method} is required — I/O is injected, this module never touches the filesystem directly`,
    )
  }
  return port
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new Error(`amendments: \`${label}\` must be a string; got ${value === null ? 'null' : typeof value}`)
  }
  if (!allowEmpty && value.trim() === '') throw new Error(`amendments: \`${label}\` must not be empty`)
  return value
}

// A heading is ONE line. Without this a `title` of "x\n### Requirement 99: y"
// would let a caller inject structure the heading form is meant to constrain.
function requireSingleLine(value, label) {
  const text = requireString(value, label)
  if (/[\r\n]/.test(text)) {
    throw new Error(`amendments: \`${label}\` must be a single line, got ${JSON.stringify(text)}`)
  }
  return text
}

// The spec directory, normalized. Also the point where Req 6.6 is enforced for
// every writer — there is no second code path into a spec.
function resolveSpecDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('amendments: `dir` must be a non-empty absolute path to the spec directory')
  }
  if (hasArchiveSegment(dir)) {
    throw new Error(
      `Refusing to amend a spec under _archive/ (${dir}).\n` +
        'The archive area has no signature and no lint backstop (spec-conventions §7.1.1): an amendment\n' +
        'there would be untraceable, so the incremental-correction channel is closed for archived specs.\n' +
        'Move the spec back out of _archive/ first, or open a new spec for the change.',
    )
  }
  return dir === '/' ? '/' : dir.replace(/[\\/]+$/, '')
}

// `<dir>/<file>.md`. The file name is an allow-list by construction: no path
// separators, so a caller cannot steer a write out of the spec directory.
function specFilePath(dir, file) {
  const name = requireString(file, 'file')
  if (/[\\/]/.test(name)) {
    throw new Error(`amendments: \`file\` must be a bare name ("requirements" | "design"), got ${JSON.stringify(name)}`)
  }
  const stem = name.replace(/\.md$/i, '').toLowerCase()
  if (stem === '' || stem === '.' || stem === '..') {
    throw new Error(`amendments: \`file\` must be a bare name ("requirements" | "design"), got ${JSON.stringify(name)}`)
  }
  return joinPath(dir, `${stem}.md`)
}

function quote(text) {
  const oneLine = String(text).replace(/\n/g, '\\n')
  return `"${oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine}"`
}

async function readRequired(port, abs, what) {
  let content
  try {
    content = await port.readText(abs)
  } catch (err) {
    throw new Error(`amendments: cannot read ${abs} (${what}): ${err?.message ?? err}`)
  }
  if (typeof content !== 'string') {
    throw new Error(`amendments: ${abs} does not exist — ${what} must exist before it can be amended`)
  }
  return content
}

/**
 * 读-改-写的写半边：`previousText` 必须是**本次调用刚读到的那份**（第 7 期 §9 欠账 ⑤）。
 * 盘上不再是它，就拒绝 —— 基于旧内容算出来的结果落在新内容上，等于静默抹掉别人的改动。
 */
async function writeRequired(port, abs, content, previousText) {
  try {
    await port.writeTextIfUnchanged(abs, content, previousText)
  } catch (err) {
    throw new Error(`amendments: cannot write ${abs}: ${err?.message ?? err}`)
  }
  return content
}

// ---------------------------------------------------------------------------
// The task-body gates.
// ---------------------------------------------------------------------------

// Req 6.4, gate 1: the file name. Exported so the rejection can be unit-tested.
export function assertNotTaskBody(file) {
  if (typeof file !== 'string') return
  const stem = file
    .trim()
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.md$/, '')
  if (stem === 'tasks') throw taskBodyRefusal(`target file ${JSON.stringify(file)}`, REMEDY.target)
}

/**
 * 门 1 的**就地编辑**变体：允许寻址 tasks.md，把「改的是不是任务体」交给门 2b 判。
 * 只给 `applyParamEdit` 用 —— 它是唯一在写盘前做 before/after 比对的 writer。
 * 其余 writer（append 类）没有那道事后校验，继续用 `assertNotTaskBody` 按名硬拒。
 */
function assertNotTaskBodyExceptInPlace(file) {
  if (typeof file !== 'string') return
  const stem = file.trim().toLowerCase().replace(/^.*[\\/]/, '').replace(/\.md$/, '')
  if (stem === 'tasks') return // 交给门 2a / 2b
  assertNotTaskBody(file)
}

// Fenced blocks, with their info string. Unterminated trailing blocks are kept
// (dropping them would leave the one malformed case unguarded).
function fencedBlocks(content) {
  const blocks = []
  let open = null
  let body = []
  for (const raw of String(content ?? '').split('\n')) {
    const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(raw)
    if (open === null) {
      if (!fence) continue
      open = { char: fence[1][0], info: fence[2].trim() }
      body = []
      continue
    }
    if (fence && fence[1][0] === open.char && fence[2].trim() === '') {
      blocks.push({ info: open.info, body: body.join('\n') })
      open = null
      body = []
      continue
    }
    body.push(raw)
  }
  if (open !== null) blocks.push({ info: open.info, body: body.join('\n') })
  return blocks
}

// A fenced block whose payload is an object carrying a `waves` array — the
// dependency graph, i.e. the second half of the task body.
//
// Tagged OR untagged, because index.js's parseDependencyGraph matches
// /```(?:json)?\s*\n/ — a bare ``` fence is read as the graph. Screening only
// ```json would leave a `waves` edit free to hide in a fence the parser still
// treats as authoritative. (A ```js-tagged fence is outside both scopes: that
// parser does not match it either.)
function wavesBlocks(content) {
  const found = []
  for (const block of fencedBlocks(content)) {
    if (block.info !== '' && !/^json\b/i.test(block.info)) continue
    let parsed
    try {
      parsed = JSON.parse(block.body)
    } catch {
      continue
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.waves)) {
      found.push(`${block.info}\n${block.body}`)
    }
  }
  return found
}

// The bytes Req 6.4 protects: every checkbox line and every waves block.
function taskBodySignature(content) {
  const checkboxes = String(content ?? '')
    .split('\n')
    .filter((line) => isTaskBodyLine(line))
  return JSON.stringify({ checkboxes, waves: wavesBlocks(content) })
}

// Req 6.4, gate 2a: refuse proposed text that carries a task-body token.
function assertNoTaskBodyText(text, context) {
  for (const line of String(text ?? '').split('\n')) {
    if (isTaskBodyLine(line)) throw taskBodyRefusal(`${context} introduces a checkbox line: ${quote(line)}`, REMEDY.text)
  }
  const waves = wavesBlocks(text)
  if (waves.length > 0) throw taskBodyRefusal(`${context} introduces a \`waves\` JSON block`, REMEDY.text)
}

// Req 6.4, gate 2b: the post-condition. Cheap, and it catches an edit that lands
// inside an existing waves block without carrying a recognisable token itself.
function assertTaskBodyUnchanged(before, after, context) {
  if (taskBodySignature(before) !== taskBodySignature(after)) {
    throw taskBodyRefusal(`${context} would have changed existing task-body lines`, REMEDY.unchanged)
  }
}

// ---------------------------------------------------------------------------
// Writer 1 — parameter-class edit, IN PLACE (Req 6.1).
// ---------------------------------------------------------------------------
export async function applyParamEdit({ port, dir, file, from, to }) {
  // 🔴 2026-09-18（docs/2026-09-18-claude-spec-plugin-defects.md 第 2 / 6.5 条）：
  // 这里原先是 `assertNotTaskBody(file)` —— 按**文件名**一刀切拒绝 tasks.md。
  //
  // 冻结的对象是 Req 6.4 的**任务体**（checkbox 行与 `waves` 块），而不是整份 tasks.md：
  // 上面 REMEDY.target 那句话自己就写着「record the change in tasks.md's `## Notes`」，
  // spec-conventions §7.1.1 rule ① 也明写 `## Notes` 可以碰。一刀切让 `## Notes` 里的
  // 一行署名也改不了 —— 工具比它服务的规则更严，实测把人推去改了错的文件（一次错误的
  // 指路产生三次写操作），也让写歪的署名**无法订正**。
  //
  // ⚠️ 这确实拿掉了 tasks.md 上「两道独立门」中的第一道，所以只对**本 writer** 拿掉：
  // `applyParamEdit` 是就地编辑，它下面跟着门 2b（`assertTaskBodyUnchanged`）—— 那是
  // 精确判据：比较编辑前后的 checkbox 集合与 `waves` 块，改了任何一个都拒。两个 append
  // 类 writer 没有这样的事后校验，它们继续按文件名硬拒（见各自的 assertNotTaskBody）。
  // 也就是说：放开的是「能不能寻址」，没有放开「能不能改任务体」。
  assertNotTaskBodyExceptInPlace(file)
  const base = resolveSpecDir(dir)
  const target = specFilePath(base, file)
  const fromText = requireString(from, 'from')
  const toText = requireString(to, 'to', { allowEmpty: true })
  requirePort(port, 'readText')
  requirePort(port, 'writeTextIfUnchanged')
  assertNoTaskBodyText(toText, 'applyParamEdit replacement')

  const content = await readRequired(port, target, 'the target file')
  const occurrences = content.split(fromText).length - 1
  if (occurrences === 0) {
    // Naming the file and the exact text, because the caller's mental model of the
    // file is what is wrong here — a silent no-op would leave the old value live.
    throw new Error(`applyParamEdit: text not found in ${target} — nothing was replaced.\n  from: ${quote(fromText)}`)
  }
  if (occurrences > 1) {
    // "Replace the first occurrence" cannot be honoured safely: picking one of N
    // identical targets is a guess, and a wrong guess silently changes a value the
    // caller never looked at. Make the caller disambiguate.
    throw new Error(
      `applyParamEdit: ambiguous target in ${target} — the text occurs ${occurrences} times, so which one to\n` +
        `edit is undefined. Widen \`from\` until it matches exactly once.\n  from: ${quote(fromText)}`,
    )
  }

  const at = content.indexOf(fromText)
  const next = content.slice(0, at) + toText + content.slice(at + fromText.length)
  assertTaskBodyUnchanged(content, next, 'applyParamEdit')
  await writeRequired(port, target, next, content)
  return { path: target, occurrences: 1, replaced: fromText, with: toText }
}

// ---------------------------------------------------------------------------
// Writer 2 — append a requirement, numbering past the existing maximum (Req 6.2).
// ---------------------------------------------------------------------------

// max+1 over BOTH heading forms. Fence-blind on purpose: a `### Requirement 99:`
// inside a code fence only pushes the next number higher (safe), whereas missing a
// real heading would re-use a number — the one thing 6.2 forbids.
function nextRequirementNumber(content) {
  let max = 0
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim()
    const kiro = REQUIREMENT_HEADING_RE.exec(line)
    if (kiro) {
      max = Math.max(max, Number(kiro[1]))
      continue
    }
    const legacy = LEGACY_REQUIREMENT_HEADING_RE.exec(line)
    if (legacy) max = Math.max(max, Number(legacy[1]))
  }
  return max + 1
}

export async function appendRequirement({ port, dir, title, body }) {
  assertNotTaskBody('requirements')
  const base = resolveSpecDir(dir)
  const target = specFilePath(base, 'requirements')
  const titleText = requireSingleLine(title, 'title')
  const bodyText = requireString(body, 'body', { allowEmpty: true })
  requirePort(port, 'readText')
  requirePort(port, 'writeTextIfUnchanged')
  assertNoTaskBodyText(`${titleText}\n${bodyText}`, 'appendRequirement body')

  const content = await readRequired(port, target, 'requirements.md')
  const number = nextRequirementNumber(content)

  // "原位指针" (Req 6.2). A requirement list is append-only, so the only position
  // that is BOTH "where the addition begins" and "where the pre-existing document
  // ended" is the insertion boundary itself — the line immediately above the new
  // block. The pointer carries 见文末 so a reader who meets it while reading the
  // tail still knows the entry is a late addition, not original text. (The
  // the consumer repo fixture parks its pointer at exactly that kind of boundary:
  // requirements.md:68 announces Req 1.11–1.16 and sits directly above the
  // `### Requirement 2` heading that follows the amended block.)
  const pointer = `> 追加修正：Requirement ${number} 为本轮新增，见文末。`
  assertNoTaskBodyText(pointer, 'appendRequirement pointer')

  const parts = [pointer, '', `### Requirement ${number}: ${titleText}`]
  const trimmedBody = bodyText.replace(/\s+$/, '')
  if (trimmedBody !== '') parts.push('', trimmedBody)
  const block = parts.join('\n')
  // Exactly one blank line of separation from whatever came before; only the
  // trailing newlines are normalised, so all pre-existing text round-trips.
  const trimmedContent = content.replace(/\n+$/, '')
  const next = trimmedContent === '' ? `${block}\n` : `${trimmedContent}\n\n${block}\n`
  assertTaskBodyUnchanged(content, next, 'appendRequirement')
  await writeRequired(port, target, next, content)
  return { path: target, number, pointer }
}

// ---------------------------------------------------------------------------
// Writer 3 — design amendment at the end, pointer at the original position (6.3).
// ---------------------------------------------------------------------------

// Split into `{ raw, inFence }`, tracking ``` / ~~~ (a fence closes only on a line
// starting with the same character). Same single-source scanner as index.js: a
// `## Amendments` mentioned inside a fenced example must not become the section
// heading, and a `## Foo` inside an amendment body must not end the section.
function scanLines(content) {
  let inFence = false
  let fenceChar = ''
  return String(content ?? '')
    .split('\n')
    .map((raw) => {
      const trimmed = raw.trim()
      const fence = /^(`{3,}|~{3,})/.exec(trimmed)
      const fenced = inFence || fence !== null
      if (fence) {
        const ch = fence[1][0]
        if (!inFence) {
          inFence = true
          fenceChar = ch
        } else if (ch === fenceChar) {
          inFence = false
          fenceChar = ''
        }
      }
      return { raw, inFence: fenced }
    })
}

// Insert `text` as its own line directly after the line that exactly equals
// `anchor`. The anchored line itself is never touched.
function insertAfterAnchorLine(content, anchor, text, target) {
  if (anchor.includes('\n')) {
    throw new Error(
      `appendDesignAmendment: \`pointer.anchor\` must be a single line (it is matched against whole lines); got ${quote(anchor)}`,
    )
  }
  const lines = content.split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i++) if (lines[i] === anchor) hits.push(i)
  if (hits.length === 0) {
    throw new Error(
      `appendDesignAmendment: anchor not found in ${target} — expected a line exactly equal to:\n  anchor: ${quote(anchor)}`,
    )
  }
  if (hits.length > 1) {
    // A duplicated anchor would scatter the pointer across N positions; which one
    // is "the amended original location" is undefined.
    throw new Error(
      `appendDesignAmendment: anchor is ambiguous in ${target} — the line occurs ${hits.length} times, so\n` +
        `where to put the pointer is undefined. Pass a longer, unique anchor line.\n  anchor: ${quote(anchor)}`,
    )
  }
  lines.splice(hits[0] + 1, 0, text)
  return lines.join('\n')
}

// Append one entry inside `## Amendments`, creating the section (+ its Chinese
// sub-title) when the design has never been amended.
function appendAmendmentEntry(content, heading, body) {
  const lines = content.split('\n')
  const scanned = scanLines(content)
  const start = scanned.findIndex((l) => !l.inFence && l.raw.trim() === AMENDMENTS_HEADING)

  // `heading` arrives either as bare text or already prefixed — the brief's own
  // example is `### 2026-09-11 · …`. Normalising keeps both callers correct
  // instead of guessing which one the caller meant.
  const headingLine = /^#{1,6}\s/.test(heading.trim()) ? heading.trim() : `### ${heading.trim()}`
  const entryLines = [headingLine]
  const trimmedBody = body.replace(/\s+$/, '')
  if (trimmedBody !== '') entryLines.push('', trimmedBody)

  if (start === -1) {
    const base = content.replace(/\n+$/, '')
    const block = [AMENDMENTS_HEADING, '', AMENDMENTS_SUBTITLE, '', ...entryLines].join('\n')
    return { text: base === '' ? `${block}\n` : `${base}\n\n${block}\n`, created: true }
  }

  // The section ends at the next top-level `## ` heading (outside a fence), or at
  // EOF. The new entry goes INSIDE that boundary: if some unrelated section already
  // follows `## Amendments`, appending blindly at EOF would file the amendment
  // under that section instead.
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!scanned[i].inFence && /^##\s/.test(lines[i].trim())) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end)
  while (section.length > 1 && section[section.length - 1].trim() === '') section.pop()
  const merged = [...section, '', ...entryLines, '']
  return { text: [...lines.slice(0, start), ...merged, ...lines.slice(end)].join('\n'), created: false }
}

/**
 * `heading` 是**这一条修正自己的标题**（`### …`），不是它要落进去的那个 section 名。
 *
 * 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 6.2 条）。
 * 两个参数职责重叠、都没人守：本函数**自己会建** `## Amendments` 段，却又要调用方传
 * 一个 `heading`。于是传 `"## Amendments"`（最直觉的猜法）被原样接受，落盘成：
 *     ## Amendments      ← 本函数建的
 *     > 补充修正
 *     ## Amendments      ← 调用方传的，又写了一遍
 * 一个本职是「维护 spec 结构」的工具，把文档写出了重复的二级标题。实测是靠人工
 * `grep -c '^## Amendments'` 才发现的。
 *
 * 判据：条目标题不许是 `#` / `##` 级 —— 那两级会另起一个 section，与它要落进去的那个平级
 * （甚至同名）。`###` 及更深、或裸文本（由 `appendAmendmentEntry` 补成 `###`）才是条目。
 */
function requireAmendmentHeading(heading) {
  if (heading === undefined || heading === null || heading === '') {
    throw new Error(
      'amendments: `heading` is required — it is the amendment ENTRY\'s own heading, e.g.\n' +
        '  "### 2026-09-18 · 订正取数口径"  (or bare text, which is prefixed with `### `).\n' +
        `Do NOT pass the section name ${JSON.stringify(AMENDMENTS_HEADING)}: this writer creates that section itself.`,
    )
  }
  const text = requireSingleLine(heading, 'heading')
  const level = /^(#{1,6})\s/.exec(text.trim())
  if (level && level[1].length <= 2) {
    throw new Error(
      `amendments: \`heading\` ${JSON.stringify(text.trim())} is a level-${level[1].length} heading, which would start a\n` +
        `section beside ${JSON.stringify(AMENDMENTS_HEADING)} instead of filing an entry inside it (passing\n` +
        `${JSON.stringify(AMENDMENTS_HEADING)} itself writes that heading a second time). Pass the entry's own\n` +
        '`### …` heading, or bare text — this writer creates and owns the section.',
    )
  }
  return text
}

export async function appendDesignAmendment({ port, dir, heading, body, pointer }) {
  assertNotTaskBody('design')
  const base = resolveSpecDir(dir)
  const target = specFilePath(base, 'design')
  const headingText = requireAmendmentHeading(heading)
  const bodyText = requireString(body, 'body', { allowEmpty: true })
  requirePort(port, 'readText')
  requirePort(port, 'writeTextIfUnchanged')
  // The pointer is specified as ONE line: a multi-line "pointer" is a paragraph,
  // which belongs in the amendment body, not at the amended location.
  const pointerLine = requireSingleLine(pointer?.text, 'pointer.text')
  const anchor = requireString(pointer?.anchor, 'pointer.anchor')
  assertNoTaskBodyText(`${headingText}\n${bodyText}\n${pointerLine}`, 'appendDesignAmendment content')

  const content = await readRequired(port, target, 'design.md')
  // Build both edits in memory and write once, so a missing anchor cannot leave a
  // half-applied amendment (pointer refused, entry already appended).
  const withPointer = insertAfterAnchorLine(content, anchor, pointerLine, target)
  const amended = appendAmendmentEntry(withPointer, headingText, bodyText)
  assertTaskBodyUnchanged(content, amended.text, 'appendDesignAmendment')
  await writeRequired(port, target, amended.text, content)
  return {
    path: target,
    createdAmendmentsSection: amended.created,
    pointer: pointerLine,
    anchor,
    heading: /^#{1,6}\s/.test(headingText.trim()) ? headingText.trim() : `### ${headingText.trim()}`,
  }
}
