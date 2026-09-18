// §4.3.2 署名的**行级识别器** —— 从 `@my-harness/spec-analysis` 搬到这里。
//
// 为什么搬（第 8 期 `spec-sign-approval-clobber`）：审批指纹住在 `spec-revision`，
// 它现在必须认得「一行合法署名」（协议标记豁免，与执行事件块同类），但依赖方向是
//
//     spec-revision → spec-parser      （零反向）
//     spec-analysis → spec-parser
//
// 而识别器原先住在 `spec-analysis`。新增 `spec-revision → spec-analysis` 会被仓库的
// 依赖纪律判为反向边，于是唯一不新增边、也不造第二份副本的落法，是把它放进两者
// **共同的**依赖里。这正是第 7 期抽 `spec-state` 时用过的同一手法：搬家，宿主保留
// 同名 re-export，既有调用点与测试一行不改。
//
// 🔴 **判据逐字未改。** 它仍是消费项目 `.githooks/pre-commit` 的收紧口径，逐字符
// 移植的证据在 `packages/spec-analysis/test/signature-pin.test.mjs`——那份 pin
// 在搬家后必须**继续指向那份真源**，而不是指向这里的副本（否则"漂了就红"的保护会
// 变成保护一份没人用的死副本）。
//
// 本模块零 I/O、零 import（与同目录 `event-format.js` 的既有约束一致）。

// 解析历史文本时认得的环境（解析面）。比渲染面多一个 Gemini：
// 消费项目语料里有 7 处真实的 `· Gemini ·` 历史签名（2026-09-13 实测），
// 解析器必须继续认得它们，哪怕生成器已经不再用这个环境写新签名。
export const PARSEABLE_ENVS = ['Kiro', 'DSH', 'Codex', 'Claude', 'Gemini']

const DATE_SRC = '\\d{4}-\\d{2}-\\d{2}'
// 解析用 PARSEABLE_ENVS（含 Gemini），这样解析器与「新签名允许写哪些环境」的
// 渲染校验可以各自独立变化，不会因为拆分而互相打架。
const ENV_ALT = PARSEABLE_ENVS.join('|')
const MIDDOT = '\\u00b7'
// `- <date> · <env> · <summary>` (also matches an indented nested bullet).
const LIST_FORM_RE = new RegExp(`^\\s*-\\s+(${DATE_SRC})\\s*${MIDDOT}\\s*(${ENV_ALT})\\s*${MIDDOT}\\s*(.*)$`)
// `### <date> · <env> · <summary>` — three-or-more hashes. A `##` line is a spec
// SECTION (`## Notes`), never an attribution, so it must not match.
const HEAD_FORM_RE = new RegExp(`^\\s*#{3,6}\\s+(${DATE_SRC})\\s*${MIDDOT}\\s*(${ENV_ALT})\\s*${MIDDOT}\\s*(.*)$`)

// Parse ONE line as a signature, or undefined. Both markups are accepted, the
// separator may have no surrounding spaces (real files vary), but the summary
// is mandatory in both: `date · env` alone is a label, not an attribution of
// what changed — the same rule the pre-commit regex enforces by requiring the
// trailing separator.
export function parseSignatureLine(line) {
  // 容忍行尾 `\r`（Task 0.3 的第 1 处差异）。为什么修在这里而不是让扫描层归一化：
  // 缺陷本来就在这一侧 —— 共享层的 `parseTaskLine` 用 `\s*$` 结尾，本来就吃得下 `\r`，
  // 只有本文件这两个 `(.*)$` 吃不下；而共享层**刻意**只按 `\n` 切（`revision.mjs` 用同一套
  // 原语算 approval fingerprint，第 3 期反复强调不能动）。修这一侧影响面最小，也不会在
  // 共享层之上多出一层「两边看到的行不一样」的入口。
  //
  // 少识别是危险方向：署名是消费项目对已解锁底座的唯一硬要求，CRLF checkout 上静默
  // 看不见签名会让整目录被判未署名。
  const text = String(line ?? '').replace(/\r$/, '')
  const m = LIST_FORM_RE.exec(text) || HEAD_FORM_RE.exec(text)
  if (!m) return undefined
  const summary = m[3].trim()
  if (!summary) return undefined
  return { date: m[1], env: m[2], summary, raw: text.trim() }
}
