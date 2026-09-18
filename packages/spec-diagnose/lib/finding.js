// Finding 契约（第 3.5 期 Task 2）。
//
// 一条 finding 的形状与**溯源**在本文件里定死。`source` 不是调试便利，是权威溯源：
// Kiro 二进制判的（`kiro-binary`）、项目约定判的（`repo-convention`）、补充 lint 判的
// （`supplementary`）必须可区分——沿用 dsh-spec Requirement 1.10「every finding declares
// where its rule comes from」。
//
// 零 I/O、恒不抛。

import { KIRO_BUNDLE } from '@my-harness/kiro-rules'

/**
 * DSH 自己的补充规则码（迁移自 `plugins/dsh-spec/lib/index.js:1254`，逐条保留原注释与依据）。
 *
 * 每一条都**有意**是 `repo-convention`：Kiro 没有实现它们，所以它们绝不能以
 * `source: 'kiro-binary'` 的 `error` 出现——那会让 DSH 拒绝一份 Kiro 欣然接受的 spec。
 * 末五条存在的原因是 Kiro 的调度器会**静默**丢掉畸形 wave 图并退回串行。
 */
export const REPO_CODES = Object.freeze({
  // Refused by the runner/state-writer: the two would pick different
  // definitions for the same id.
  'tasks/duplicate-task-id': 'error',
  // Kiro silently discards a graph missing a numeric wave `id` or using numeric
  // task ids, and falls back to one-task-per-wave — a silent loss of all
  // parallelism, which is why DSH reports it.
  'tasks/waves-schema': 'warning',
  // The graph and the checkboxes must agree in BOTH directions; Kiro's own
  // linter only asserts that `waves` is a non-empty array.
  'tasks/waves-task-mismatch': 'error',
  'tasks/undeclared-task': 'warning',
  // `[~]` parses in Kiro (`[ x~-]`) but is a fourth state this repo bans.
  'tasks/invalid-task-state': 'warning',
  // Scope advisory; never blocks.
  'tasks/too-many-units': 'warning',
  // Per-kind: `${kind}/unterminated-fence`. A stray ``` hides every heading and
  // task after it, which can undercount tasks and mask a missing section.
  'tasks/unterminated-fence': 'warning',
  'requirements/unterminated-fence': 'warning',
  'design/unterminated-fence': 'warning',
  'designBugfix/unterminated-fence': 'warning',
  'bugfix/unterminated-fence': 'warning',
  // Repo convention, not a Kiro rule: Kiro has no design H1 requirement.
  'design/missing-title': 'warning',
})

/**
 * 十个旧通用/模板码如何映射到 Kiro 忠实的方案。`null` 表示这个概念在 Kiro 里根本不存在，
 * 于是码是**消失**而不是改名（迁移自 `plugins/dsh-spec/lib/index.js:1290`）。
 *
 * 这张表是**出处**，不是机制——运行时没有任何东西消费它。测试双向读它：每个非空目标必须是
 * 真码（Kiro 的 41 条或已登记的 repo 约定），且**任何**源键都不得再被产出。没有那条测试它就是
 * 装饰，而装饰性的映射表比没有更糟：它暗示某处真的在做改名。
 */
export const LEGACY_CODE_REMAP = Object.freeze({
  'requirements/missing-h1': 'requirements/missing-title',
  'requirements/wrong-h1': 'requirements/missing-title',
  'requirements/missing-section': 'requirements/missing-introduction',
  'requirements/missing-recommended-section': 'requirements/missing-glossary',
  'design/missing-h1': null, // Kiro has NO design H1 rule → design/missing-title, warning
  'design/wrong-h1': null,
  'design/missing-section': 'design/missing-architecture',
  'design/missing-recommended-section': 'design/missing-correctness-properties',
  'designBugfix/missing-h1': null,
  'designBugfix/wrong-h1': null,
  'designBugfix/missing-section': null, // became the five design/missing-<bugfix-section> codes
  'designBugfix/missing-recommended-section': null,
  'bugfix/missing-h1': null, // Kiro's validateBugfixFormat has no H1 rule at all
  'bugfix/wrong-h1': null,
  'bugfix/missing-section': null, // became the three bugfix/missing-<h3> codes
  'bugfix/missing-recommended-section': null,
  'tasks/missing-h1': 'tasks/missing-implementation-plan',
  'tasks/missing-section': 'tasks/missing-dependency-graph',
  'tasks/missing-recommended-section': 'tasks/missing-overview',
  'tasks/invalid-dependency-graph': null, // split into the four Kiro DAG codes
  'tasks/waves-schema': 'tasks/waves-schema', // kept: DSH-only, Kiro never checks it
})

export const SOURCES = Object.freeze(['kiro-binary', 'repo-convention', 'supplementary'])

/**
 * `source` 的**唯一**解析点。
 *
 * 默认值由查表决定、不由调用方自述——照搬 dsh-spec 的 `diag()` 注释原话：「猜就失去了这个字段
 * 的意义」。默认是 `'kiro-binary'` 只因为「不在 `REPO_CODES` 里的码」在当前规则表下确实都是
 * Kiro 的；显式传入的 `'repo-convention'` 用于**由本仓约定才成立**的那种 finding
 * （典型：某个标题只因落在围栏里而被判缺失）。
 */
export function resolveSource(code, explicit) {
  if (explicit !== undefined && explicit !== null) {
    if (!SOURCES.includes(explicit)) throw new Error(`unknown source: ${explicit}`)
    return explicit
  }
  return Object.prototype.hasOwnProperty.call(REPO_CODES, code) ? 'repo-convention' : 'kiro-binary'
}

/**
 * 唯一的 finding 构造点。
 *
 * `location.line` 是 **0 基**行号，与真机 Kiro 一致（它的规则循环传数组下标；实测第 10 行的
 * 畸形复选框真机报 `line: 9`）。`0` 同时被 Kiro 用来表示「文档级、无具体行」（实测
 * `tasks/missing-dependency-graph` 报 `line: 0`）——两者同形是 Kiro 的既有约定，本层照抄。
 * `area` 是四个 artifact 之一；`designBugfix` 归入 `design`（Kiro 也只有四个 area）。
 */
export function makeFinding({ code, severity, message, source, area, line, anchored, evidence, suggestedAction, kiroBundle }) {
  const hasLine = Number.isInteger(line) && line >= 0
  const numericLine = hasLine ? line : 0
  // `anchored` 必须**显式**传递：`line` 的数值 `0` 既可能是「第 1 行」也可能是「文档级」，
  // 从数值本身推不出来——这正是第 3.6 期 Task 0.2 要消灭的二义。
  // 缺省分支只服务于「直接调用 makeFinding 且给了合法行号」的场景；规则发射点 `diag()`
  // 一律显式给出，那才是唯一权威。判别式**不许**写成 `line >= 0`：默认值满足它，
  // 会把每一条文档级 finding 都误标成 anchored。
  const isAnchored = anchored === undefined ? hasLine : anchored === true
  const finding = {
    code: String(code),
    severity: severity === 'error' ? 'error' : 'warning',
    message: String(message ?? ''),
    source: resolveSource(code, source),
    location: { line: numericLine, column: null, anchored: isAnchored },
  }
  if (area) finding.area = area
  if (evidence) finding.evidence = evidence
  if (suggestedAction) finding.suggestedAction = suggestedAction
  if (kiroBundle) finding.kiroBundle = kiroBundle
  return finding
}

// `KIRO_BUNDLE` 直接导出（不在这里往 finding 上贴）：母计划的原话是「**validator 在输出里带上
// 它**」，也就是由壳（第 3.6 期的 CLI / MCP）在响应信封上带一次，而不是给每条 finding 复制一份
// 相同的四字段对象。原来的 `withKiroBundle` / `attachKiroBundle` 只有测试在用，已删。
export { KIRO_BUNDLE }
