// spec-analysis — spec attribution signatures（第 2 期自 plugins/dsh-spec 原样搬出）。
//
// Several bases (Kiro, DSH, Codex, Claude) share one repo and one set of specs,
// so a spec needs an attribution trail: whenever a base edits a spec's PROSE it
// appends one signature line to the `## Notes` section of that spec's
// `tasks.md`:
//
//   - 2026-09-11 · DSH · <what changed>
//
// The convention also shows up in the wild as a `###`-prefixed heading
// (`### 2026-09-10 · DSH · ...`), so the PARSER accepts both markups while the
// GENERATOR emits only the `- ` list form.
//
// 第 6 期改动（2026-09-13，对齐消费项目 §4.3.2 现行原文）：
//   · `Gemini` 从**可渲染**集合里去掉（用户已删除该环境，消费项目的白名单从未包含它），
//     `Claude` 加入**可渲染**集合（消费项目 §0 已解锁 Claude Cowork 写 spec）。
//   · 但消费项目语料里有真实的 `· Gemini ·` 历史署名（`example-spec-alpha/tasks.md`
//     等 7 处），删掉解析支持会让 `parseSignatures()` 突然看不见既成事实、把台账弄丢。
//     所以这里拆成两个集合：`RENDERABLE_ENVS`（新签名允许用哪些环境）与
//     `PARSEABLE_ENVS`（解析历史文本时认哪些环境），后者仍含 Gemini，前者不含。
//   · `Claude` 目前只解锁了 **Cowork** 这一个通道：消费项目的 `.githooks/pre-commit`
//     要求 `env === 'Claude'` 时 summary 必须含字面量 `Cowork`，`renderSignature` 与
//     `checkAttribution` 都跟着收紧（见下方对应函数），但**只影响 Claude**，
//     不改变 Kiro/DSH/Codex 三个环境原有的判定 —— 那是本期的硬约束，不是可选项。
//
// 🔴 第 9 期改动（2026-09-17，对齐消费项目 **撤销**那条字面量要求）：
//   · 消费项目于 2026-09-17 **退役 Cowork 通道**（改走本地 Claude Code），并从
//     `.githooks/pre-commit` 里**删掉**了 `environment != "Claude" or "Cowork" in description`
//     这一支。撤销的**理由**（记在那边 `spec-conventions.md` §4.3.2「字面量为什么撤销」）值得
//     原样记住：**那条要求被插件强制注入，于是它不再追踪现实，只追踪「作者有没有写那个词」，
//     沦为与实际宿主无关的咒语、只制造假台账。** 换句话说本文件下面那两处「就近拒绝」
//     正是把它变成咒语的原因之一。
//   · 所以现在**没有按环境分的附加字面量要求**：判据只有两条 —— 环境名在白名单里、
//     第二个中点后有非空说明。`isValidSignatureLine` / `renderSignature` /
//     `checkAttribution` 已同步放开（`Claude` 仍是**可渲染**环境，只是不再要求那个词）。
//   · ⚠️ 权威来源是消费项目的**工作区改动**（当时那份 hook 与 steering 都还没提交）。
//     若那边再变，这一支要跟着重核 —— 钉住它的网是
//     `packages/spec-analysis/test/signature-pin.test.mjs`（逐字符比对面那份正则）。
//   · 另外它顺带修掉了管道符那支：消费项目「历史没有真实 `|` 署名消费者，不再兼容管道符
//     或混合分隔符」—— 本文件的 `CONSUMER_SIG_RE` 本来就只认 `·`，无需改动。
//
// Two judgement calls are inherited verbatim from the reference corpus
// (the consumer repo `.githooks/pre-commit` → `check_spec_signature`), because they are
// the whole point of the rule:
//   1. severity is `warning` and NEVER blocks. What counts as a substantive
//      edit cannot be decided reliably (is a typo fix worth a signature?), and
//      a hard block pushes people to SKIP_PRECOMMIT / --no-verify, which costs
//      more than a missed signature.
//   2. attribution is judged per SPEC DIRECTORY, not per file. The recommended
//      workflow is "edit design.md, sign in tasks.md", so a per-file check
//      would flag the project's own advice as a violation.
//
// ZERO direct filesystem access. Every read/write goes through the injected
// `port` (read text / write text / list dir / exists), so this module can be
// exercised against an in-memory fake and can never touch a real repo by
// accident. `node:fs` and `node:path` are deliberately not imported.

import { scanLines } from '@my-harness/spec-parser/scan-lines'
// 行级识别器现在住在 `spec-parser`（第 8 期 `spec-sign-approval-clobber`）：审批指纹
// （`spec-revision`）必须认得一行合法署名，而又不许新增 `spec-revision → spec-analysis`
// 的依赖边。本文件保留同名 re-export，既有的调用点与测试一行不改。
import { PARSEABLE_ENVS, parseSignatureLine } from '@my-harness/spec-parser/signature-line'

export { PARSEABLE_ENVS, parseSignatureLine }

// 新签名允许使用的环境（渲染面）。历史上还有 Gemini，2026-09 用户已删除该环境，
// 消费项目的白名单也从未收过它 —— 见下方 PARSEABLE_ENVS 的注释。
export const RENDERABLE_ENVS = ['Kiro', 'DSH', 'Codex', 'Claude']

// 向后兼容别名：历史上 SIGNATURE_ENVS 同时充当「渲染允许」与「解析允许」两个角色
// （因为两者本来就相等）。第 6 期把它们拆开之后，这个名字保留下来，语义收窄为
// RENDERABLE_ENVS ——因为它唯一的下游用途（isSignatureEnv → renderSignature 的
// env 校验）本来就是「渲染」语义，不是「解析」语义。
export const SIGNATURE_ENVS = RENDERABLE_ENVS

// U+00B7 MIDDLE DOT. Exported so callers can print the convention, and written
// as an escape in the regexes below so a lookalike character (· U+0387 or
// • U+2022) sneaking into an edit cannot silently stop matching real files.
export const SIGNATURE_SEPARATOR = '·'

export const NOTES_HEADING = '## Notes'

// The canonical artifacts of a spec directory. Used both as the always-probed
// set and as the ordering of `missingFiles`.
export const SPEC_MD_FILES = ['tasks.md', 'design.md', 'requirements.md', 'bugfix.md']

// `DATE_RE` 只服务于**渲染**路径的日期校验；用于**识别**一行署名的两个正则随
// `parseSignatureLine` 一起搬到了 `@my-harness/spec-parser/signature-line`。
const DATE_SRC = '\\d{4}-\\d{2}-\\d{2}'
const DATE_RE = new RegExp(`^${DATE_SRC}$`)

// 与消费项目 `.githooks/pre-commit` 的 `is_valid_signature` 完全同源
// （2026-09-13 逐字符实测抄录其 Python 正则：
//   sig = re.compile(r"^-\s+\d{4}-\d{2}-\d{2}\s*·\s*(Kiro|DSH|Codex|Claude)\s*·\s*(\S.*)$")
// ）。判据的唯一事实源在消费项目那份脚本里，这里只做一次移植，不再造第二份会漂的
// 副本（母计划 R6-2）——如果消费项目改了那份脚本，这里要跟着重新抄录，而不是
// 各自演化。
//
// 与上面 LIST_FORM_RE 的差异是**有意的、更严格**：只认列 0 顶层列表项（不接受任何
// 前导空白，因此排除了缩进进列表容器或代码块里的示例行）、分隔符必须是 `·`（不接受
// `|` 或其他混合分隔符）、且不接受 `###` 标题形式。这是消费项目一家的收紧口径，
// 不是本模块通用解析规则的一部分，所以单独导出，不去改 LIST_FORM_RE / HEAD_FORM_RE
// 本身（那样会牵动 Kiro/DSH/Codex 已有的、更宽松的历史行为）。
const CONSUMER_SIG_RE = /^-\s+\d{4}-\d{2}-\d{2}\s*·\s*(Kiro|DSH|Codex|Claude)\s*·\s*(\S.*)$/

export function isValidSignatureLine(line) {
  const text = String(line ?? '')
  // 判据**只有**正则那两条（环境名在白名单里、第二个中点后有非空说明）。
  // 2026-09-17 之前这里还有一支 `environment !== 'Claude' || description.includes('Cowork')`，
  // 已随消费项目撤销那条要求一起去掉 —— 见文件头「第 9 期改动」。
  return CONSUMER_SIG_RE.test(text)
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

// Today as YYYY-MM-DD in `timeZone`, falling back to the machine's local zone.
//
// 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 3 条）。
// 这里原先只有下面那条本地实现，注释写着「at UTC+8 an evening edit would be labelled
// with tomorrow's UTC date」—— 推理没错，但结论**只在「本机就是 UTC+8」时成立**。
// 改用本地 getter 只是把 UTC 的坑换成了本机时区的坑：实测在 America/Los_Angeles 上，
// 一次会话的 9 条署名全部盖成了前一天（与北京差 15 小时，比 UTC 的 8 小时偏得更多）。
// 台账日期系统性错一天，而它服务的仓库明文规定「日期一律取北京时间」。
//
// 所以时区是**入参**，不是推断出来的：仓库的基准时区是项目约定，不是环境事实，
// 探测不出来。缺省仍回落到本机时区 —— 没配置的宿主行为逐字不变。
export function todayDate(now = new Date(), timeZone) {
  if (timeZone === undefined || timeZone === null || timeZone === '') {
    const y = String(now.getFullYear()).padStart(4, '0')
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  // `en-CA` 的短日期格式就是 YYYY-MM-DD —— 不必自己拼，也就不会拼错。
  // 时区名非法时 Intl 会抛 RangeError：让它抛。一个配错的时区静默退回本机，
  // 就是把「日期错一天」这个缺陷原样换个入口再来一遍。
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

// 语义是「渲染面」：这个 env 是否允许出现在**新写**的签名里。历史解析用
// PARSEABLE_ENVS，见 ENV_ALT 的注释——两者故意不共用这一个函数。
export function isSignatureEnv(env) {
  return SIGNATURE_ENVS.includes(env)
}

// Join path segments without `node:path`. Separators are normalised; `.`/`..`
// are intentionally NOT resolved, because callers only ever join a spec
// directory with a plain file name.
export function joinPath(base, ...parts) {
  const all = [base, ...parts].filter((p) => p !== undefined && p !== null && String(p) !== '')
  if (all.length === 0) return ''
  let out = String(all[0])
  for (const part of all.slice(1)) {
    out = out.replace(/[\\/]+$/, '') + '/' + String(part).replace(/^[\\/]+/, '')
  }
  return out
}

// 第 2 期收敛：围栏扫描改调**共享层**（`@my-harness/spec-parser/scan-lines`）。
//
// 本文件原来自带第五份围栏实现，用的是第 3 期**之前**的语义：只比首字符闭合、无缩进感知、
// 无 run 长度比较，另外会剥掉行尾 `\r`。第 3 期把 `index.js` 那一份换成了 kiro 的缩进式
// 语义（`nextFenceMarker` / `hasFenceClose`），**这一份没跟着换** —— 于是同一个仓库里
// 「哪一行在围栏里」有两个答案。本期把它收敛掉，导出名 `scanLines` 保留（调用方不变）。
//
// 三处识别差异，都在 Task 0.3 的判定里逐条登记过：
//   ① 行尾 `\r`：旧实现剥 `\r`，共享层不剥（它刻意只按 `\n` 切，`revision.mjs` 的
//      approval fingerprint 依赖这套原语）。补齐它的是**署名行解析**那一侧
//      （`parseSignatureLine` 容忍行尾 `\r`），不是在共享层之上再造一层归一化 ——
//      多一层归一化就多一处「两边看到的行不一样」的入口。
//   ② 缩进 4 的围栏：旧语义把它当围栏（把里面的署名藏起来），共享层按 CommonMark 判它是
//      **缩进代码块**、其后的顶格署名行是真实内容。方向是「多识别」，安全。
//   ③ **开围栏的 run 比闭围栏长**（```` 开 / ``` 「闭」）：旧语义只比首字符，于是它认为
//      围栏已闭合、后面的署名被识别；共享层要求「同字符且 run 长度 >= 开 run」，于是不闭合、
//      后面的署名**被算进围栏** —— 方向是「**少识别**」，也就是本文件最不愿走的那一侧。
//      它仍然是收敛而不是取舍：CommonMark 就要求闭合 run 不短于开 run，而 `spec-parser`
//      的差异表 **F 行**早已把「4 个反引号被 3 个反引号闭合」定成两宿主都不接受的行为 ——
//      换句话说，**旧的这一份实现与仓库自己已经定下的判定相反**。所以按「修正确」登记。
//      实测语料影响 0（685 份 `.md` 无一份命中），且三条族谱与整族规模都钉在
//      `test/signature-fences.test.mjs` 里（那一族是整体 review 补上的：初版枚举漏了它）。
//
// 语料实测（685 份 `.md`，Task 0.3 的探针）：差异 0 份。
export { scanLines }

// `parseSignatureLine` 已搬到 `@my-harness/spec-parser/signature-line`（本文件顶部 re-export）。
// 搬家理由与判据不变性写在那个模块的头部注释里。

// All signatures in a document, in file order.
export function parseSignatures(text) {
  // `raw` 现在来自共享层，可能带行尾 `\r` —— 由 `parseSignatureLine` 自己容忍。
  const out = []
  for (const { raw, inFence } of scanLines(text)) {
    if (inFence) continue
    const sig = parseSignatureLine(raw)
    if (sig) out.push(sig)
  }
  return out
}

// Render the signature line. `date` defaults to today (local) so a caller that
// does not care about the clock cannot produce an undated attribution.
export function renderSignature({ date, env = 'DSH', summary, timeZone } = {}) {
  const day = normaliseDate(date, timeZone)
  if (!isSignatureEnv(env)) {
    throw new Error(
      `renderSignature: unknown env ${JSON.stringify(env)} — expected one of ${RENDERABLE_ENVS.join(', ')}`,
    )
  }
  // Collapse newlines and whitespace runs: the signature must stay exactly one
  // line, otherwise the next append would land inside the previous signature
  // and the parser would silently read only half of it.
  const body = String(summary ?? '').replace(/\s+/g, ' ').trim()
  if (!body) {
    throw new Error('renderSignature: summary must be a non-empty description of what changed')
  }
  // 2026-09-17：这里原有一条「env === 'Claude' 时 summary 必须含字面量 Cowork」的就近拒绝。
  // 已删除 —— 消费项目撤销了那条要求，理由正是**本插件把它强制注入**，于是它不再追踪现实
  // （详见文件头「第 9 期改动」）。保留这条注释是为了下一个看见 diff 的人知道它为什么没了，
  // 而不是把它当成「漏删的旧校验」再加回来。
  return `- ${day} ${SIGNATURE_SEPARATOR} ${env} ${SIGNATURE_SEPARATOR} ${body}`
}

function normaliseDate(date, timeZone) {
  if (date === undefined || date === null || date === '') return todayDate(new Date(), timeZone)
  const value = String(date).trim()
  // A date the parser cannot read back would produce a signature that is
  // invisible to checkAttribution — refuse it here instead of writing it.
  if (!DATE_RE.test(value)) {
    throw new Error(`renderSignature: date must be YYYY-MM-DD, got ${JSON.stringify(String(date))}`)
  }
  return value
}

// Locate the `## Notes` section: `{ start, end }` where `end` is the line index
// of the next `## ` heading, or the line count when Notes is the last section.
// EXACT heading match (same rule as the spec diagnostics): a substring hit such
// as `## Notes and caveats` is a different section.
function findNotesSection(text) {
  const lines = scanLines(text)
  const start = lines.findIndex((l) => !l.inFence && l.raw.trim() === NOTES_HEADING)
  if (start === -1) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^##\s/.test(lines[i].raw.trim())) {
      end = i
      break
    }
  }
  return { start, end }
}

async function readTextOrUndefined(port, abs) {
  if (!port || typeof port.readText !== 'function') return undefined
  try {
    const text = await port.readText(abs)
    return text === undefined || text === null ? undefined : String(text)
  } catch {
    return undefined
  }
}

async function listEntries(port, dir) {
  if (!port || typeof port.listDir !== 'function') return []
  try {
    const entries = await port.listDir(dir)
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Directory operations (all I/O through `port`).
// ---------------------------------------------------------------------------

// Append the signature to the END of tasks.md's `## Notes` section and return
// the rendered line. Idempotent: an attribution that is already in the file is
// not repeated.
export async function appendSignature({ port, dir, summary, env = 'DSH', date, timeZone } = {}) {
  const line = renderSignature({ date, env, summary, timeZone })
  const abs = joinPath(dir, 'tasks.md')

  let content
  try {
    content = await port.readText(abs)
  } catch (e) {
    throw new Error(`appendSignature: cannot read ${abs} (${e?.message || e})`)
  }
  if (content === undefined || content === null) {
    throw new Error(`appendSignature: ${abs} does not exist — an attribution signature belongs in the ## Notes section of an existing spec tasks.md`)
  }
  const text = String(content)

  const merged = insertSignatureInto(text, line)
  if (!merged.ok) {
    // 消息逐字保持不变：behaviour-snapshot 钉着它。
    throw new Error(`appendSignature: ${abs} has no "## Notes" section — add that section, do not sign anywhere else (the convention signs in tasks.md's ## Notes)`)
  }
  if (merged.duplicate) return line

  // The module's single filesystem mutation. Nothing else here writes.
  // 🔴 走 `writeTextIfUnchanged`，把**刚读到的那份**当基线（第 7 期 §9 欠账 ⑤）：
  // `text` 是 `T0` 读到的内容，`merged.text` 是基于它算出来的。若盘上已经不是 `T0`，
  // 这次写入就会把别人的改动静默抹掉 —— 所以宁可失败。
  await port.writeTextIfUnchanged(abs, merged.text, text)
  return line
}

// ---------------------------------------------------------------------------
// 纯文本插入（无 I/O）。`appendSignature` 与 claude-spec 的 `spec_write` 共用这一份。
//
// 🔴 **为什么要抽出来**：claude-spec 的 `spec_write` 是 CAS 原子写 —— 写盘只允许发生一处，
// 所以它不能调用会自己写盘的 `appendSignature`，只能在内存里把签名并进 content。
// 顺带也省掉一类事后操作：署名与它所描述的改动在同一次写入里落盘。
//
// ⚠️ 这里原先给的理由（消费项目 steering §4.3.2：「批准之后再单独补一行署名会改掉
// `approvalFingerprint`，`observe()` 判 `external_change_detected` 并作废该 artifact 的审批」）
// **已不成立**：第 8 期 `spec-sign-approval-clobber` 把 `computeApprovalFingerprint` 升到
// `semantic-v2`，`tasks.md` 上的**合法**署名行与合法执行事件块一样被剥掉，不再是语义。
//
// 各写一份插入逻辑就是本项目反复要消灭的「同源副本」（第 6 期风险 R6-2），
// 所以这里只留一份，两边都调它。
//
// @returns {{ok: true, text: string, duplicate: boolean}} | {{ok: false, code: 'NO_NOTES_SECTION'}}
export function insertSignatureInto(text, line, { createNotes = false } = {}) {
  const source = String(text ?? '')
  const wantedLine = parseSignatureLine(line)
  if (!wantedLine) return { ok: false, code: 'NOT_A_SIGNATURE' }
  const section = findNotesSection(source)
  if (!section) {
    // `appendSignature` 保持原行为（抛错）：它只签 tasks.md，而 tasks.md 没有 `## Notes`
    // 是文件本身有问题，静默新建会把签名塞进一个作者没打算要的章节。
    // `createNotes` 只给 §4.3.2 的另一条路用：**tasks.md 还不存在时**（spec 尚在
    // requirements / design 阶段）签在当前那份文件末尾，「没有 `## Notes` 就新起一个」。
    if (!createNotes) return { ok: false, code: 'NO_NOTES_SECTION' }
    const duplicateHere = parseSignatures(source).some(
      (s) => s.date === wantedLine.date && s.env === wantedLine.env && s.summary === wantedLine.summary,
    )
    if (duplicateHere) return { ok: true, text: source, duplicate: true, createdNotes: false }
    const eolNew = source.includes('\r\n') ? '\r\n' : '\n'
    const body = source.replace(/\s+$/, '')
    return {
      ok: true,
      duplicate: false,
      createdNotes: true,
      text: [body, '', NOTES_HEADING, '', '> 备注', '', line, ''].join(eolNew),
    }
  }

  // Idempotence compares the parsed triple, not the raw line, so an existing
  // `### date · env · summary` heading suppresses the `- ` form too: they are
  // the same attribution, and both spellings at once would just be noise.
  const wanted = wantedLine
  const duplicate = parseSignatures(source).some(
    (s) => s.date === wanted.date && s.env === wanted.env && s.summary === wanted.summary,
  )
  if (duplicate) return { ok: true, text: source, duplicate: true, createdNotes: false }

  // Rewrite using the file's dominant EOL so a CRLF file stays CRLF.
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  let out
  if (section.end >= lines.length) {
    // `## Notes` is the LAST section: append at EOF, collapsing trailing blank
    // lines first so repeated appends cannot grow an ever-widening gap.
    let last = lines.length
    while (last > 0 && lines[last - 1].trim() === '') last -= 1
    // House style puts a blank line between a heading and its content; a
    // signature glued to `## Notes` reads as part of the heading. Only add it
    // when the section is otherwise empty, so repeated appends do not grow gaps.
    const needsBlank = last === section.start + 1
    out = needsBlank
      ? [...lines.slice(0, last), '', line, '']
      : [...lines.slice(0, last), line, '']
  } else {
    // Another `## ` section follows: insert BEFORE it, not at EOF — appending
    // at EOF would file the signature under that following section instead.
    let at = section.end
    while (at > section.start + 1 && lines[at - 1].trim() === '') at -= 1
    out = [...lines.slice(0, at), line, '', ...lines.slice(at)]
  }
  return { ok: true, text: out.join(eol), duplicate: false, createdNotes: false }
}

// 2026-09-17：这里原有 `isCompliantForAttribution(sig)`——「Claude 的 summary 必须含 `Cowork`
// 才算达标」。随消费项目撤销那条要求，它**恒为真**，于是连同 `checkAttribution` 里那次
// `.filter(isCompliantForAttribution)` 一并删掉：一个恒真的过滤器只会让下一个人以为
// 「这里还有一条按环境分的判据」。
// ⚠️ 若将来真机再引入按环境分的附加要求，**加回时要一起加断言**（否则又会变成咒语）。

// Report shape:
//   { dir, ok, applicable, signatures, missingFiles, finding }
// `applicable` is false when no changed files were named, i.e. there is nothing to
// attribute and `ok` is true by default rather than by evidence. Without it a caller
// cannot tell "nothing to check" from "checked and signed".
// Attribution granularity is the SPEC DIRECTORY (Req 3.2): a signature found in
// ANY `.md` file of the directory satisfies the whole directory, so the
// "change design.md, sign in tasks.md" workflow passes. Never throws — a
// missing signature is a warning, not an error.
export async function checkAttribution({ port, dir, changedFiles } = {}) {
  const changed = normaliseChangedFiles(changedFiles)
  const report = { dir, ok: true, applicable: changed.length > 0, signatures: [], missingFiles: [], finding: null }

  // Candidate set: the four canonical artifacts are always probed (so a file
  // that simply is not there shows up in missingFiles), plus every other `.md`
  // in the directory — an extra notes file is still part of this spec's trail.
  const candidates = new Map(SPEC_MD_FILES.map((name) => [name, joinPath(dir, name)]))
  for (const entry of await listEntries(port, dir)) {
    if (!entry || entry.type === 'directory') continue
    const name = String(entry.name ?? '')
    if (!name.toLowerCase().endsWith('.md') || candidates.has(name)) continue
    candidates.set(name, typeof entry.path === 'string' && entry.path ? entry.path : joinPath(dir, name))
  }

  const extras = [...candidates.keys()].filter((n) => !SPEC_MD_FILES.includes(n)).sort()
  for (const name of [...SPEC_MD_FILES, ...extras]) {
    const text = await readTextOrUndefined(port, candidates.get(name))
    if (text === undefined) {
      report.missingFiles.push(name)
      continue
    }
    report.signatures.push(...parseSignatures(text))
  }

  // `ok` is false ONLY when something changed and no COMPLIANT attribution
  // exists anywhere in the directory. An empty changedFiles means "no prose
  // edit", so there is nothing to attribute. `report.signatures` still lists
  // every parsed signature (including a non-compliant Claude one) for
  // visibility — only the ok gate uses the compliant subset.
  // 2026-09-17：原先这里是 `report.signatures.filter(isCompliantForAttribution)` ——
  // 那个过滤器随消费项目撤销字面量要求而恒真，已删。现在「任何一条被解析出来的签名」
  // 就算数（判据与真机 hook 一致：环境名 + 非空说明）。
  const compliant = report.signatures
  if (changed.length > 0 && compliant.length === 0) {
    report.ok = false
    report.finding = {
      ruleId: 'repo/spec-unsigned',
      severity: 'warning',
      source: 'repo-convention',
      message: unsignedMessage(dir, changed),
    }
  }
  return report
}

function normaliseChangedFiles(changedFiles) {
  if (changedFiles === undefined || changedFiles === null) return []
  const list = Array.isArray(changedFiles) ? changedFiles : [changedFiles]
  return list.map((f) => String(f)).filter((f) => f.trim() !== '')
}

function unsignedMessage(dir, changed) {
  const shown = changed.slice(0, 5).join(', ')
  const more = changed.length > 5 ? `, ... (+${changed.length - 5} more)` : ''
  const example = renderSignature({ env: 'DSH', summary: '<what changed>' })
  return (
    `${changed.length} spec file(s) changed in ${dir} (${shown}${more}) but no compliant attribution signature ` +
    `was found in any .md file of that spec directory. Attribution is judged per spec directory, so a ` +
    `single signature anywhere in the directory is enough — append one to the ## Notes section of ` +
    `tasks.md, e.g. "${example}" (${RENDERABLE_ENVS.join('|')}). Warning only: this does not block the change.`
  )
}
