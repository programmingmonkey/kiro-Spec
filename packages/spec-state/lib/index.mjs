import { createHash } from 'node:crypto';

// ── 状态层身份（build 判别式）─────────────────────────────────────────────────
//
// 存在的理由是一次**具体的**失败：第 7 期 Task 4 Step 5 要求真机复验先用「判别式」
// 确认跑的是哪一版，计划把它写成「返回形状带本期新增的字段」。但第 7 期的设计目标
// 恰恰是**抽包对工具面不可观测**（完成门槛第 2 条：行为快照抽取前后逐条相同）——
// 两个要求直接矛盾，于是当时挑了一个 `rawRevision` 当判别式，而它从第 6 期起就在，
// 旧 build 同样返回它。那次真机复验因此没能回答「跑的是哪一版」。
//
// 🔴 所以这个字段是**专门为判别而存在**的，不承担任何业务语义：
//   - 它由**共享包自己**导出，不是宿主里的一个字面量 —— 宿主只是转发。
//     区别是关键的：宿主里的字面量只证明「宿主这个文件是新的」，而这个常量出现在
//     `spec_health` 里，证明的是「**这一份 spec-state 真的被装载了**」。
//   - 与 package.json 的 name@version 由测试钉死（`shape.test.mjs`），不许两处漂移。
//   - 两个 MCP 宿主**都**返回它，所以它不是宿主差异，不进 KNOWN_HOST_DIFFS。
export const STATE_LAYER = '@my-harness/spec-state@0.1.0';

import { adapterContextFiles } from './adapter-context.mjs';
import * as paths from './paths.mjs';
import { createSpecStorage } from './storage.mjs';

// 增量修正通道的三个 writer。**不在本包另写一份** —— dsh-spec 从第 2 期起就用这一份，
// 两边共用同一套守卫（拒改任务体的三道门、`_archive` 拒绝、`from` 命中 0/多次的歧义拒绝），
// 否则「同一个修正在两个宿主上结果不同」会变成一个没人盯的分叉面。
//
// 🔴 它的 I/O 是注入的（`port.readText` / `port.writeTextIfUnchanged`），本包**只给它内存 port**：
// 真正落盘仍然只有 `storage.write` 这一处，CAS 与 writePolicy 一条都不少（见 `amendInMemoryPort`）。
import { appendDesignAmendment, appendRequirement, applyParamEdit } from '@my-harness/spec-analysis/amendments';
// 围栏判定的**唯一**实现（登记表里的 canonical 那一条）。`spec_read` 的小节切分用它，
// 而不是另起一条正则 —— 见 `splitSections` 的注释。
import { computeFenceState } from '@my-harness/spec-parser/scan-lines';
// `.config.kiro`（真机写在 spec 目录里的类型元数据）的**唯一**解析器 —— 第 9 期 T3 建的，
// T3b 用它给 `spec_adopt` 派生 workflow。**不在这里另写一份解析**：8 种 keys 形态的容错与
// 「逐字段白名单」的判定语义都对齐真机实测，重复一份就等于让两个宿主各自漂。
import { CONFIG_KIRO_FILE, parseConfigKiro, specTypeToKind } from '@my-harness/spec-parser/config-kiro';

import { analyzeArtifacts, previewSynchronization } from './core/analysis.mjs';
import { validateArtifactSchemas } from './core/artifact-schema.mjs';
import { parseTasks, wavesFromMarkdown } from './core/index.mjs';
import { replaceTaskState } from './core/task-format.mjs';
import { appendExecutionEvent, parseExecutionEvents } from './core/event-format.mjs';
import { previewQuality } from './core/quality.mjs';
import { computeApprovalFingerprint, computeRawRevision } from './core/revision.mjs';
import { artifactTemplate } from './core/templates.mjs';
import { canonicalWorkspaceSnapshot } from './core/workspace-snapshot.mjs';
import {
  beginTaskExecution,
  completeTaskExecution,
  createTaskPlan,
  failTaskExecution,
  hashOwnerToken,
  recordTaskCheck,
  updateTaskState
} from './core/task-execution.mjs';
import { createWorkflowState, invalidateApprovals, isValidWorkflowState, recordApproval, transitionWorkflow } from './core/workflow.mjs';

const ARTIFACTS = new Set(['requirements', 'design', 'tasks', 'bugfix']);
const ARTIFACT_FILES = { requirements: 'requirements.md', design: 'design.md', tasks: 'tasks.md', bugfix: 'bugfix.md' };
const APPROVAL_PHRASES = { requirements: '批准 requirements', design: '批准 design', tasks: '批准 tasks', bugfix: '批准 bugfix', all: '批准全部 artifacts' };
const INITIAL_DRAFT_PHASE = { 'requirements-first': 'requirements_draft', 'design-first': 'design_draft', bugfix: 'bug_analysis_draft', quick: 'artifacts_generated' };
const WORKFLOW_ARTIFACTS = {
  'requirements-first': new Set(['requirements', 'design', 'tasks']),
  'design-first': new Set(['requirements', 'design', 'tasks']),
  bugfix: new Set(['bugfix', 'design', 'tasks']),
  quick: new Set(['requirements', 'design', 'tasks'])
};
const TASK_LEASE_MS = 30 * 60 * 1000;

// ── `spec_adopt` 的 workflow 从哪来（第 9 期 T3b）──────────────────────────────
//
// 真机把 spec 的类型写在 `<specDir>/.config.kiro` 里，并**用它**选规则表
// （`research/15` §3.1/§3.4）。所以接管一个存量 spec 时，那个文件就是「这是哪一种 spec」
// 的**第一手证据** —— 让调用方凭记忆手写 `workflow`，等于把一个已经写在盘上的答案
// 换成一次猜测。T3 把读取建在 dsh-spec 里，T3b 把同一件事接到这里。
//
// 这张表只收**有证据支撑**的映射（括号里是盘上样本数，`research/15` §4.3）：
//
//   `specType: bugfix`                        → `bugfix`（3 例；且它决定 artifact 是 `bugfix.md`）
//   `specType: feature` + `workflowType` 有序 → 那个顺序（70 例）
//   `specType: feature` + 无 `workflowType`   → `requirements-first`
//        —— 真机**读取端**的默认回落就是这个（`r.workflowType || WorkflowType.RequirementsFirst`，§3.2）
//   `specType: quick-spec`                    → **不派生**（理由见下）
//   `workflowType: fast-task / verify-first`  → **不派生**（本仓没有对应流程，§3.2 / T4）
//   config 缺席 / 不可用 / 取不到类型          → **不派生**
//
// 🔴 为什么 `quick-spec` 与 `fast-task` 是「不派生」而不是「挑一个像的」：
//   本仓 `quick` 是**一条 workflow**（phase 链与 feature 形不同、审批走 `all`），而
//   dsh-spec 里 `quick` 只是 **kind**（它的 workflow 仍记 `requirements-first`）。也就是说
//   「`quick-spec` 派生成哪个 workflow」这个问题的答案**在两个宿主的词汇表里本来就不同**，
//   而盘上 `quick-spec` 的真实样本是 **0 例**（§4.3 / §11 留白 1）—— 两个答案都说得通，
//   那就不是证据，是偏好。
//   `fast-task` / `verify-first` 同理：真机有枚举与 prompt 模板，本仓没有对应阶段表。
//   这时**要求调用方显式给**，并在错误里说清是哪一种情形 —— 而不是替它选一个。
//   这正对应 `research/15` T4 的裁决：本仓未建模的东西不许静默套用另一套流程。
//
// 返回判别式结果，让调用点能给出**具体**的错误（而不是一句「workflow 缺失」）：
//   `{ workflow, source: 'config' }` | `{ code: 'CONFIG_ABSENT' | 'CONFIG_UNUSABLE' |
//   'CONFIG_NO_TYPE' | 'CONFIG_QUICK_SPEC' | 'CONFIG_UNMODELED_WORKFLOW', detail? }`
function workflowFromConfig(config) {
  if (!config.present) return { code: 'CONFIG_ABSENT' };
  if (!config.usable) return { code: 'CONFIG_UNUSABLE', detail: config.code };
  const kind = specTypeToKind(config.specType);
  // bugfix 先判：真机也按 specType 选诊断表，而 bugfix 与 feature 是两套章节表（§3.4 路径 3）。
  if (kind === 'bugfix') return { workflow: 'bugfix', source: 'config' };
  if (kind === 'quick') return { code: 'CONFIG_QUICK_SPEC', detail: config.workflowType ?? null };
  if (config.workflowType === 'fast-task' || config.workflowType === 'verify-first') {
    return { code: 'CONFIG_UNMODELED_WORKFLOW', detail: config.workflowType };
  }
  if (config.workflowType === 'design-first') return { workflow: 'design-first', source: 'config' };
  if (config.workflowType === 'requirements-first') return { workflow: 'requirements-first', source: 'config' };
  // 只剩 `specType: feature` + 无 `workflowType`：走真机读取端的默认回落。
  if (kind === 'feature') return { workflow: 'requirements-first', source: 'config' };
  // 那两种非标准形态（`{specName,specVersion}` / `{spec}`）：文件在、但**什么都没声明**。
  return { code: 'CONFIG_NO_TYPE' };
}

/**
 * 「为什么派生出 workflow」的**具体**说法。
 *
 * 一句笼统的「workflow 缺失」会让人重新去猜我们刚拒绝猜的东西 —— 错误本身必须是
 * 可执行的信息：是文件不在？在但坏了？声明了但没有对应流程？还是它声明的那个取值
 * 本仓与真机**未必等价**？
 */
function workflowUnknownReason(derived) {
  switch (derived.code) {
    case 'CONFIG_ABSENT':
      return `${CONFIG_KIRO_FILE} is absent, so the spec's type cannot be derived`;
    case 'CONFIG_UNUSABLE':
      return `${CONFIG_KIRO_FILE} is present but unusable (${derived.detail})`;
    case 'CONFIG_NO_TYPE':
      return `${CONFIG_KIRO_FILE} is present but declares neither specType nor workflowType`;
    case 'CONFIG_QUICK_SPEC':
      return `${CONFIG_KIRO_FILE} says specType=quick-spec; this repo's \`quick\` workflow and the `
        + 'real machine\'s quick-spec are not known to be equivalent (0 such specs on disk), so nothing is derived';
    case 'CONFIG_UNMODELED_WORKFLOW':
      return `${CONFIG_KIRO_FILE} says workflowType=${derived.detail}, which this repo does not model`;
    default:
      return 'the spec declares no type';
  }
}

// `spec_amend` 的三种 kind 各自作用在哪个 artifact 上。
// `param` 由调用方的 `file` 决定，其余两种是固定的（这正是它们能少传一个参数的原因）。
const AMEND_KINDS = new Set(['param', 'requirement', 'design']);
function amendArtifact(params) {
  if (params.kind === 'requirement') return 'requirements';
  if (params.kind === 'design') return 'design';
  return params.file;
}

/**
 * 给 `@my-harness/spec-analysis/amendments` 的**内存 port**。
 *
 * 🔴 为什么不把 `storage` 直接包成 port：那会开出**第二条写盘路径**。amendments 的 port
 * 收绝对路径、自己决定什么时候写；而本包的全部落盘担保（CAS、writePolicy 前缀、
 * `SPEC_FROZEN`、durableReplace 的原子替换）都长在 `storage.write` 上。两条路径各写各的，
 * 迟早会出现「amend 绕过了 writePolicy」这类只在特定 kind 下才复现的洞。
 *
 * 所以这里让 amendments 在内存里完成它的**变换与全部守卫**（拒改任务体、`_archive` 拒绝、
 * `from` 歧义拒绝），把结果交回来，由调用方走那唯一一条 `storage.write`。
 * `writeTextIfUnchanged` 的 `previousText` 校验照样执行 —— 它是 amendments 自己的读-改-写
 * 一致性判据，不因为是内存实现就放宽。
 */
function amendInMemoryPort(expectedPath, current) {
  let written;
  const port = {
    async readText(abs) {
      if (abs !== expectedPath) return undefined;
      return current;
    },
    async writeTextIfUnchanged(abs, content, previousText) {
      if (abs !== expectedPath) throw new Error(`amend: unexpected write target ${abs}`);
      if (previousText !== current) throw new Error('amend: target changed under the amendment');
      written = content;
    }
  };
  return { port, result: () => written };
}

/**
 * 把 Markdown 切成 `## ` 顶层小节。**围栏感知**：代码块里的 `## x` 不是标题。
 *
 * 🔴 围栏判定必须走 `computeFenceState`，**不许在这里自己写一条 `/^\s*(`{3,}|~{3,})/`**。
 * 第一版就是自己写的，被 `scripts/recognizer-registry.test.mjs` 当场抓住 —— 那张登记表
 * 存在的理由正是「自建识别器会各自漂移」：canonical 那一份取的是 kiro 的**缩进式**语义
 * （缩进 > 3 且认不出闭合的 ``` 不算围栏开启），而随手写的这条把它们全当围栏，
 * 于是同一份 design.md 在这里和在 approval fingerprint 那里会切出不同的结构。
 */
function splitSections(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const inFenceAt = computeFenceState(lines);
  const sections = [];
  let current = { heading: null, start: 0, lines: [] };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inFence = inFenceAt[index] === true;
    if (!inFence && /^##\s+\S/.test(line)) {
      sections.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), start: index, lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  // 首段（第一个 `## ` 之前的前言）只有在非空时才算一节，避免多出一个空壳。
  return sections
    .filter((section, index) => index > 0 || section.lines.join('').trim() !== '')
    .map((section) => ({
      heading: section.heading,
      startLine: section.start + 1,
      lineCount: section.lines.length,
      characters: section.lines.join('\n').length,
      content: section.lines.join('\n')
    }));
}

function writePhase(workflow, artifact) {
  if (workflow === 'quick') return WORKFLOW_ARTIFACTS.quick.has(artifact) ? 'artifacts_generated' : undefined;
  return {
    'requirements-first': { requirements: 'requirements_draft', design: 'design_draft', tasks: 'tasks_draft' },
    'design-first': { design: 'design_draft', requirements: 'requirements_draft', tasks: 'tasks_draft' },
    bugfix: { bugfix: 'bug_analysis_draft', design: 'root_cause_design_draft', tasks: 'tasks_draft' }
  }[workflow]?.[artifact];
}

function approvalPhase(workflow, artifact) {
  if (workflow === 'quick') return artifact === 'all' ? 'overall_review' : undefined;
  return writePhase(workflow, artifact);
}

function phaseAfterApproval(workflow, artifact) {
  if (workflow === 'quick') return artifact === 'all' ? 'approved' : undefined;
  if (workflow === 'bugfix' && artifact === 'bugfix') return 'bug_analysis_approved';
  return `${artifact}_approved`;
}

function nextDraftPhase(workflow, artifact) {
  return {
    'requirements-first': { requirements: 'design_draft', design: 'tasks_draft', tasks: 'implementing' },
    'design-first': { design: 'requirements_draft', requirements: 'tasks_draft', tasks: 'implementing' },
    bugfix: { bugfix: 'root_cause_design_draft', design: 'tasks_draft', tasks: 'implementing' },
    quick: { all: 'implementing' }
  }[workflow]?.[artifact];
}

/**
 * Walk a freshly created workflow state up to its initial drafting phase.
 * `quick` needs two hops (initialized -> clarifying -> artifacts_generated); the others need one.
 * transitionWorkflow reports failure by returning an error object, so it is checked on every hop
 * to avoid spinning forever on an unchanged phase.
 */
function advanceToInitialDraft(workflowState, workflow) {
  let current = workflowState;
  while (current.phase !== INITIAL_DRAFT_PHASE[workflow]) {
    const phases = { quick: { initialized: 'clarifying', clarifying: 'artifacts_generated' } }[workflow];
    const to = phases?.[current.phase] ?? INITIAL_DRAFT_PHASE[workflow];
    const next = transitionWorkflow({ state: current, to, expectedStateEpoch: current.stateEpoch });
    if (next.code) return next;
    current = next;
  }
  return current;
}

function error(code, message, details = {}, nextAction = '重新读取状态后重试') { return { code, message, details, nextAction }; }

// 审批有**两张表**，语义不同、极易走岔：
//   · `state.workflowState.approvals` —— 闸门，值是字符串 `pending` / `granted` / `invalidated`；
//   · `state.approvals`               —— 审计明细，值是 `{fingerprint, confirmationText, recordedAt, assurance}`。
//
// 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 4 条）。
// 四个作废点（`observeKnownArtifacts` / `observe` / `spec_amend` / `spec_sync_apply`）
// 都用 `invalidateApprovals` **定向**作废闸门（只作废 changedArtifact 及其下游链），
// 却把明细表写成 `state.approvals = {}` —— **整张清空**。于是改一份 design，bugfix 的
// 闸门仍是 granted（它在链上游，本就不该被作废），明细却没了；随后重批 design / tasks
// 只补回这两条明细，bugfix 就永久停在「闸门已批准、审计查无此人」。
// 实测正是这个形状：spec_status 报 design + tasks 两条，磁盘上闸门却是三条 granted。
// 对一个以「可审计」为卖点的工具，「已批准但查不到记录」会被读成没批。
//
// 修法不是在四处各抄一遍作废集合（那等于把同一个判断复制四份，下一处又会走岔），
// 而是让不变式**由构造成立**：明细表的键集合 ≡ 闸门表上仍为 granted 的键集合。
// 由此 quickReview 那处（闸门全部作废）也自然退化成清空，不必特殊对待。
function syncApprovalDetails(state) {
  for (const artifact of Object.keys(state.approvals ?? {})) {
    if (state.workflowState?.approvals?.[artifact] !== 'granted') delete state.approvals[artifact];
  }
  return state.approvals;
}
function slug(spec) { return createHash('sha256').update(spec).digest('hex'); }
function legacySlug(spec) { return encodeURIComponent(spec).replace(/%/g, '_'); }
function validSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0 || paths.isAbsolute(spec) || spec.split(/[\\/]+/).includes('..')) return false;
  return paths.normalize(spec) === spec;
}
function validExecution(execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || !execution.attemptsByTask || typeof execution.attemptsByTask !== 'object'
    || !Array.isArray(execution.failures) || !Array.isArray(execution.completedTaskIds)
    || Object.values(execution.attemptsByTask).some((value) => !Number.isInteger(value) || value < 0)
    || execution.completedTaskIds.some((value) => typeof value !== 'string')) return false;
  const active = execution.activeTask;
  return active === null || (active && typeof active === 'object' && typeof active.taskId === 'string'
    && typeof active.ownerTokenHash === 'string' && Number.isFinite(active.leaseExpiresAt)
    && typeof active.startedWorkspaceRevision === 'string' && Array.isArray(active.checks));
}

function validTaskPlan(plan) {
  return plan && typeof plan === 'object' && !Array.isArray(plan)
    && typeof plan.planRevision === 'string' && Array.isArray(plan.taskIds) && plan.taskIds.every((id) => typeof id === 'string')
    && plan.taskTypes && typeof plan.taskTypes === 'object' && !Array.isArray(plan.taskTypes)
    && typeof plan.tasksRevision === 'string' && typeof plan.workspaceRevision === 'string'
    && Number.isInteger(plan.stateEpoch) && Number.isFinite(plan.expiresAt);
}

function validTaskPlans(taskPlans) {
  return taskPlans && typeof taskPlans === 'object' && !Array.isArray(taskPlans)
    && Object.entries(taskPlans).every(([revision, plan]) => revision === plan.planRevision && validTaskPlan(plan));
}

/**
 * 三个 MCP/cordis 宿主共用的**状态层**（第 7 期 Task 3）。
 *
 * 它拿到的每一样宿主相关的东西都是注入的：**没有** `node:fs`、**没有** `node:path`、
 * `now()` / `randomUUID()` / `pid()` / `isAlive()` 全部是 port。为的是 DSH 那条路 ——
 * 它的写盘必须带会话沙箱策略（`plugins/dsh-spec/lib/port.js`），不可能直接用 `node:fs`。
 *
 * @param {object} options
 * @param {string} options.projectRoot        项目根（绝对路径）
 * @param {string} [options.adapterPath]      adapter 配置的项目相对路径
 * @param {string} [options.privateDir]       私有状态目录；缺省时用 `privateDirName`
 * @param {string} [options.privateDirName]   私有状态目录名（**参数化**，不写死在包里）
 * @param {Function} options.loadAdapter      async ({ projectRoot, adapterPath }) => adapter
 * @param {object} options.fs                 文件系统 port（见 lib/ports.mjs）
 * @param {Function} [options.now]            时钟 port
 * @param {Function} options.randomUUID       随机数 port（必给，见下）
 * @param {Function} options.pid              当前进程号 port
 * @param {Function} options.isAlive          async (pid) => boolean，锁的存活探测
 * @param {Function} [options.fault]          故障注入（两个 host 的既有测试用它）
 * @param {object} [options.hooks]            宿主特有插槽：`health` / `beforeWrite`
 */
export async function createSpecState({
  projectRoot,
  adapterPath,
  privateDir,
  privateDirName = '.kiro-spec-private',
  loadAdapter,
  fs,
  now = () => Date.now(),
  // 随机数必须注入（Task 2 Step 3）：ownerToken / eventId / journalId / contextProof / 临时文件名
  // 全由它派生。给一个能跑的默认实现，会让「忘了注入」变成「跑起来了但快照不可复现」——
  // 那正是 R7-1 的形状。所以缺它时**当场抛**，而不是悄悄退回 `node:crypto`。
  randomUUID = () => { throw new Error('spec-state: the randomUUID port is required (see lib/ports.mjs)'); },
  pid = () => { throw new Error('spec-state: the pid port is required (see lib/ports.mjs)'); },
  isAlive = async () => { throw new Error('spec-state: the isAlive port is required (see lib/ports.mjs)'); },
  fault = async () => {},
  hooks = {}
}) {
  let adapter = await loadAdapter({ projectRoot, adapterPath });
  let specsRoot = paths.resolve(adapter.projectRoot, adapter.value.specsRoot);
  const dataDir = privateDir ?? paths.join(adapter.projectRoot, privateDirName);
  let storage = await createSpecStorage({ projectRoot: adapter.projectRoot, specsRoot: adapter.value.specsRoot, privateDir: dataDir, allowedPrefixes: adapter.value.writePolicy.allowedPrefixes, fs, randomUUID });
  const queues = new Map();
  const proofs = new Map();

  async function refreshAdapter() {
    const next = await loadAdapter({ projectRoot: adapter.projectRoot, adapterPath });
    if (next.rawRevision === adapter.rawRevision) return;
    const nextSpecsRoot = paths.resolve(next.projectRoot, next.value.specsRoot);
    const nextStorage = await createSpecStorage({ projectRoot: next.projectRoot, specsRoot: next.value.specsRoot, privateDir: dataDir, allowedPrefixes: next.value.writePolicy.allowedPrefixes, fs, randomUUID });
    adapter = next;
    specsRoot = nextSpecsRoot;
    storage = nextStorage;
    proofs.clear();
  }
  async function statePath(spec) { return paths.join(dataDir, `state-${slug(spec)}.json`); }
  async function legacyStatePath(spec) { return paths.join(dataDir, `state-${legacySlug(spec)}.json`); }
  /**
   * 读 `<specDir>/.config.kiro` 的**文本**；文件不在就是 `undefined`（即「没读到」，
   * 不是「空文件」—— `parseConfigKiro` 区分这两者）。
   *
   * 走 `storage.read` 而不是直接摸 fs：路径逃逸检查（`PATH_OUTSIDE_PROJECT` /
   * `SYMLINK_ESCAPE`）因此与四份 artifact 走的是同一条路，不另开一个绕过它的口子。
   * 读权限不受 `allowedPrefixes` 限制 —— 那只管写（`storage.write` 才检查）。
   */
  async function readConfigKiro(spec) {
    try { return (await storage.read(`${spec}/${CONFIG_KIRO_FILE}`)).content; }
    catch (caught) { if (caught.code === 'ENOENT') return undefined; throw caught; }
  }
  async function getState(spec) {
    let raw;
    try { raw = await fs.readFile(await statePath(spec), 'utf8'); }
    catch (caught) {
      if (caught.code !== 'ENOENT') throw caught;
      try { raw = await fs.readFile(await legacyStatePath(spec), 'utf8'); }
      catch (legacyCaught) { if (legacyCaught.code === 'ENOENT') return undefined; throw legacyCaught; }
    }
    try {
      const state = JSON.parse(raw);
      if (!state || typeof state !== 'object' || Array.isArray(state)
        || state.schemaVersion !== 1 || !isValidWorkflowState(state.workflowState)
        || !state.artifacts || typeof state.artifacts !== 'object' || Array.isArray(state.artifacts)
        || !state.approvals || typeof state.approvals !== 'object' || Array.isArray(state.approvals)
        || (state.spec !== undefined && state.spec !== spec)
        || (state.missingArtifacts !== undefined && (!Array.isArray(state.missingArtifacts) || state.missingArtifacts.some((artifact) => !ARTIFACTS.has(artifact))))
        || (state.execution !== undefined && !validExecution(state.execution))
        || (state.taskPlans !== undefined && !validTaskPlans(state.taskPlans))) throw new Error('invalid state shape');
      return state;
    }
    catch { throw Object.assign(new Error(`private state for ${spec} is corrupt`), { code: 'STATE_CORRUPT' }); }
  }
  async function putState(spec, state) {
    state.spec = spec;
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const file = await statePath(spec);
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.rename(temp, file);
      const directory = await fs.open(dataDir, 'r');
      try { await directory.sync(); } catch { /* directory fsync is not supported on every platform */ } finally { await directory.close(); }
    } catch (caught) { await fs.unlink(temp).catch(() => {}); throw caught; }
    return state;
  }
  async function acquireSpecLock(spec) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const lock = `${await statePath(spec)}.lock`;
    const ownerFile = paths.join(lock, 'owner.json');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await fs.mkdir(lock);
        try { await fs.writeFile(ownerFile, JSON.stringify({ pid: pid(), createdAt: now() }), { encoding: 'utf8', mode: 0o600 }); }
        catch (caught) { await fs.rmdir(lock).catch(() => {}); throw caught; }
        return async () => { await fs.unlink(ownerFile).catch(() => {}); await fs.rmdir(lock).catch(() => {}); };
      }
      catch (caught) {
        if (caught.code !== 'EEXIST') throw caught;
        try {
          const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
          // `process.kill(pid, 0)` 是宿主概念（也是 DSH 里拿不到的东西），所以走 port。
          const alive = await isAlive(owner.pid);
          if (!alive) { await fs.unlink(ownerFile).catch(() => {}); await fs.rmdir(lock).catch(() => {}); }
        } catch {
          try { if (now() - (await fs.stat(lock)).mtimeMs > 5_000) await fs.rmdir(lock); } catch { /* another writer released it */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw Object.assign(new Error('timed out waiting for Spec state lock'), { code: 'STATE_LOCK_TIMEOUT' });
  }
  async function queued(spec, action) {
    const prior = queues.get(spec) ?? Promise.resolve();
    const run = async () => { const release = await acquireSpecLock(spec); try { return await action(); } finally { await release(); } };
    const next = prior.then(run, run);
    queues.set(spec, next.catch(() => {}));
    return next;
  }
  /**
   * evaluation-only 模式下故意只接受与前缀完全相等的 Spec 名,不接受其下的嵌套名。
   *
   * 注意字段名与语义有意的不一致:`allowedPrefixes` 的字面含义是目录子树,但在
   * evaluation-only 下这里按精确名比较。原因见
   * docs/superpowers/plans/2026-08-27-kiro-spec-consumer-unified-naming-change-request.md
   * ——前缀会授权到并未获批的嵌套 Spec,这被列为要修正的缺陷。
   *
   * 该变更请求的终态是把 `allowedPrefixes` 换成精确的 `allowedSpecs`,但那需要先改
   * 消费项目的 steering 权威文件并取得独立批准,因此尚未实施。在那之前这里是过渡态:
   * 语义已收紧,字段名未改。行为由 adapter-profile.test.mjs 的 nested 用例钉住。
   *
   * 存储层(lib/core/storage.mjs)仍是 startsWith 前缀检查,作为纵深防御的外层;
   * 本函数是更严的内层。
   */
  function allowed(spec) {
    if (adapter.value.writePolicy.mode === 'evaluation-only') {
      return adapter.value.writePolicy.allowedPrefixes.some((prefix) => spec === prefix.slice(0, -1));
    }
    return adapter.value.writePolicy.allowedPrefixes.some((prefix) => spec === prefix.slice(0, -1) || spec.startsWith(prefix));
  }
  /**
   * 🔴 2026-09-18（docs/2026-09-18-claude-spec-plugin-defects.md 第 5.1 条）：
   * 这条拒绝原先只说「spec path is not allowed by writePolicy」，既不说当前策略是什么，
   * 也不说该写成什么。而 `spec` 参数的说明是「相对 specsRoot 的安全 Spec 路径」——
   * 当 specsRoot 是 `.kiro`、allowedPrefixes 是 `["specs/"]` 时，那句话字面上很容易被读成
   * 「specs 根之下」，于是第一次调用必然踩空（实测 3 次 spec_init 里踩了 1 次）。
   * 把判据本身放进 details：一行信息省掉一次去翻 adapter 配置。
   */
  function writePolicyDenied(spec) {
    const policy = adapter.value.writePolicy;
    return error(
      'WRITE_POLICY_DENIED',
      `spec path ${JSON.stringify(spec)} is not allowed by writePolicy (mode=${policy.mode}); `
      + `it must start with one of: ${policy.allowedPrefixes.map((prefix) => JSON.stringify(prefix)).join(', ')} `
      + `— these are relative to specsRoot ${JSON.stringify(adapter.value.specsRoot)}, not to it plus "specs".`,
      { specsRoot: adapter.value.specsRoot, mode: policy.mode, allowedPrefixes: policy.allowedPrefixes, spec },
    );
  }
  function fileFor(artifact) { if (!ARTIFACTS.has(artifact)) throw Object.assign(new Error('unsupported artifact'), { code: 'INVALID_ARTIFACT' }); return ARTIFACT_FILES[artifact]; }
  function executionState(state) { return state.execution ?? { activeTask: null, attemptsByTask: {}, failures: [], completedTaskIds: [] }; }
  function taskStates(markdown) {
    const all = (items) => items.flatMap((task) => [task, ...all(task.children)]);
    return Object.fromEntries(all(parseTasks(markdown).tasks).map((task) => [task.id, task.state]));
  }
  function artifactRecord(artifact, markdown, rawRevision) {
    return {
      rawRevision,
      approvalFingerprint: computeApprovalFingerprint({ artifact, markdown, strictTaskState: true }),
      ...(artifact === 'tasks' ? { taskStates: taskStates(markdown), executionEventIds: parseExecutionEvents(markdown).events.map((event) => event.id) } : {})
    };
  }
  // 🔴 原先这里是一条自己手写的正则（`\s*$\s*^` 同样吃不掉标题与围栏之间的正文行），
  // 于是 §3.1 合规写法的 DAG 对 `spec_status` / `spec_task_plan` 全不可见，且**无声**。
  // 现改为共用 `wavesFromMarkdown`；读不到的理由随 `warnings` 一起报出去，不再静默退化。
  function wavesFrom(markdown) {
    return wavesFromMarkdown(markdown).waves;
  }
  /** 把解析层的字符串 warning 映射成与 `parseTasks` 同形状的结构，好合进同一个 warnings 数组。 */
  function waveWarningsFrom(markdown) {
    return wavesFromMarkdown(markdown).warnings.map((message) => ({ code: 'WAVES_UNAVAILABLE', severity: 'warning', message }));
  }
  function planKey(spec, revision) { return `${spec}:${revision}`; }
  function workspaceRevision(params) { return params.workspaceSnapshot ? canonicalWorkspaceSnapshot(params.workspaceSnapshot).revision : params.workspaceRevision; }
  function pruneTaskPlans(state) {
    if (!state.taskPlans) return false;
    let changed = false;
    for (const [revision, plan] of Object.entries(state.taskPlans)) {
      if (plan.expiresAt <= now()) { delete state.taskPlans[revision]; changed = true; }
    }
    return changed;
  }
  function rememberPlan(state, value) {
    const plans = state.taskPlans ??= {};
    const entries = Object.entries(plans).sort(([, left], [, right]) => left.expiresAt - right.expiresAt);
    while (entries.length >= 100) {
      const [revision] = entries.shift();
      delete plans[revision];
    }
    plans[value.planRevision] = {
      planRevision: value.planRevision,
      taskIds: value.taskIds,
      taskTypes: value.taskTypes,
      tasksRevision: value.tasksRevision,
      workspaceRevision: value.workspaceRevision,
      stateEpoch: value.stateEpoch,
      expiresAt: now() + 10 * 60 * 1000
    };
  }
  async function proofValid(token, spec, artifact) {
    const proof = proofs.get(token);
    if (!proof || proof.expiresAt <= now() || proof.adapterRevision !== adapter.rawRevision || proof.spec !== spec || proof.artifact !== artifact) return undefined;
    try {
      for (const file of proof.contextFiles) {
        const current = computeRawRevision(await fs.readFile(file.path));
        if (current !== file.rawRevision) return undefined;
      }
    } catch {
      return undefined;
    }
    return proof;
  }
  async function observeKnownArtifacts(spec, state) {
    const missing = new Set(state.missingArtifacts ?? []);
    for (const artifact of Object.keys(state.artifacts ?? {})) {
      try { await observe(spec, artifact, state); missing.delete(artifact); }
      catch (caught) {
        if (caught.code !== 'ENOENT') throw caught;
        missing.add(artifact);
        if (!(state.missingArtifacts ?? []).includes(artifact)) {
          const updated = invalidateApprovals({ state: state.workflowState, changedArtifact: artifact, expectedStateEpoch: state.workflowState.stateEpoch });
          if (!updated.code) {
            state.workflowState = updated;
            syncApprovalDetails(state);
          }
          state.missingArtifacts = [...missing].sort();
          await putState(spec, state);
        }
      }
    }
    return [...missing].sort();
  }
  async function observe(spec, artifact, state) {
    const current = await storage.read(`${spec}/${fileFor(artifact)}`);
    const wasMissing = state.missingArtifacts?.includes(artifact);
    if (wasMissing) {
      state.missingArtifacts = state.missingArtifacts.filter((item) => item !== artifact);
      await putState(spec, state);
    }
    const fingerprint = computeApprovalFingerprint({ artifact, markdown: current.content, strictTaskState: true });
    const known = state.artifacts?.[artifact];
    if (known && known.rawRevision !== current.rawRevision) {
      const semanticChanged = known.approvalFingerprint !== fingerprint;
      if (semanticChanged) {
        const updated = invalidateApprovals({ state: state.workflowState, changedArtifact: artifact, expectedStateEpoch: state.workflowState.stateEpoch });
        if (!updated.code) {
          state.workflowState = updated;
          syncApprovalDetails(state);
          state.artifacts[artifact] = artifactRecord(artifact, current.content, current.rawRevision);
          await putState(spec, state);
        }
        return { current, fingerprint, externalChange: { disposition: 'external_change_detected', artifact } };
      }
      if (artifact === 'tasks' && (JSON.stringify(known.taskStates) !== JSON.stringify(taskStates(current.content))
        || JSON.stringify(known.executionEventIds ?? []) !== JSON.stringify(parseExecutionEvents(current.content).events.map((event) => event.id)))) {
        throw Object.assign(new Error('tasks checkbox changes are not backed by the current execution journal'), { code: 'RECOVERY_REQUIRED', details: { artifact: 'tasks' } });
      }
      return { current, fingerprint, externalChange: { disposition: 'reread_required', artifact } };
    }
    return { current, fingerprint };
  }
  async function reconcilePending(spec, state) {
    const pending = await storage.journal.list({ spec, status: 'pending' });
    for (const entry of pending) {
      const observed = await storage.read(`${spec}/tasks.md`);
      if (entry.intent.action === 'task_begin') {
        if (observed.rawRevision === entry.intent.afterRawRevision) {
          if (state.execution?.activeTask?.journalId === entry.id) { await storage.journal.commit({ id: entry.id }); continue; }
          return { code: 'RECOVERY_REQUIRED', taskId: entry.intent.taskId, journalId: entry.id, reason: 'orphaned_begin' };
        }
        if (observed.rawRevision === entry.intent.beforeRawRevision && !state.execution?.activeTask) { await storage.journal.resolve({ id: entry.id, status: 'rolled_back' }); continue; }
        return { code: 'RECOVERY_REQUIRED', taskId: entry.intent.taskId, journalId: entry.id, reason: 'journal_state_mismatch' };
      }
      if (['task_complete', 'task_fail'].includes(entry.intent.action)) {
        if (observed.rawRevision === entry.intent.afterRawRevision) {
          state.execution = entry.intent.nextExecution;
          state.artifacts.tasks = artifactRecord('tasks', observed.content, observed.rawRevision);
          state.workflowState = { ...state.workflowState, stateEpoch: entry.intent.nextStateEpoch };
          await putState(spec, state);
          await storage.journal.commit({ id: entry.id });
          continue;
        }
        if (observed.rawRevision === entry.intent.beforeRawRevision) { await storage.journal.resolve({ id: entry.id, status: 'rolled_back' }); continue; }
        return { code: 'RECOVERY_REQUIRED', taskId: entry.intent.taskId, journalId: entry.id, reason: 'journal_state_mismatch' };
      }
    }
    return null;
  }
  async function observeApproval(spec, artifact, state) {
    if (artifact !== 'all') return observe(spec, artifact, state);
    if (state.workflowState.workflow !== 'quick') throw Object.assign(new Error('all approval is only available for quick'), { code: 'INVALID_ARTIFACT' });
    const missing = ['requirements', 'design', 'tasks'].filter((name) => !state.artifacts?.[name]);
    if (missing.length > 0) throw Object.assign(new Error('quick requires requirements, design, and tasks before overall approval'), { code: 'QUICK_ARTIFACTS_INCOMPLETE', details: { missing } });
    const observations = await Promise.all(['requirements', 'design', 'tasks'].map((name) => observe(spec, name, state)));
    return { fingerprint: computeApprovalFingerprint({ artifact: 'quick-artifacts', markdown: observations.map((item) => item.fingerprint).join('\n'), strictTaskState: true }) };
  }
  async function listSpecs(directory = specsRoot, prefix = '') {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (caught) { if (caught.code === 'ENOENT') return []; throw caught; }
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (next === '_archive' || next.startsWith('_archive/')) continue;
      const state = await getState(next);
      const artifacts = [];
      for (const [artifact, filename] of Object.entries(ARTIFACT_FILES)) {
        try { await fs.readFile(paths.join(directory, entry.name, filename)); artifacts.push(artifact); } catch { /* absent artifact */ }
      }
      if (state) result.push({ spec: next, workflow: state.workflowState.workflow, workflowSource: state.workflowSource ?? null, phase: state.workflowState.phase, imported: Boolean(state.imported), lifecycle: 'managed', artifacts });
      else if (artifacts.length > 0) result.push({ spec: next, lifecycle: 'external', artifacts });
      result.push(...await listSpecs(paths.join(directory, entry.name), next));
    }
    return result;
  }
  async function readCrossArtifactInputs(spec) {
    try {
      const entries = await Promise.all(['requirements', 'design', 'tasks'].map(async (artifact) => [artifact, await storage.read(`${spec}/${fileFor(artifact)}`)]));
      return {
        artifacts: Object.fromEntries(entries.map(([artifact, read]) => [artifact, read.content])),
        sourceRevisions: Object.fromEntries(entries.map(([artifact, read]) => [artifact, read.rawRevision]))
      };
    } catch (caught) {
      throw Object.assign(new Error('requirements, design, and tasks are required for cross-artifact analysis'), { code: 'ANALYSIS_INPUT_INCOMPLETE', details: { cause: caught.code } });
    }
  }

  async function call(name, params = {}) {
    try {
      await refreshAdapter();
      // 宿主可往健康回报里加字段（claude-spec 的 adapter 有 authority 台账，codex-spec 没有）。
      // 放在 hook 里而不是共享层里：把不需要它的宿主塞进去就是让 codex-spec 背一个它没有的概念。
      //
      // 例外是 `adapterSource`（L4 / Req 3.2、3.3）：它**不是**某个宿主的概念，而是「这份档案是
      // 从哪个路径读到的」——两个宿主共用一个默认路径与同一套回退规则，所以回报形状也该是同一个。
      //
      // ⚠️ 只在**偏离默认**时报（Req 3.2 点名的 `legacy`，与 Req 3.3 点名的冲突）：
      // 读的就是新路径、也没有冲突时，这个字段不携带任何信息，却会改变一份**冻结**的验收快照
      // （`scripts/snapshot-07.mjs` 场景 8 录了 `spec_health` 的返回体，golden 在排除面、
      // 本期不许重捕）。「加了字段」这件事本身不算信号，不该让那条网变红。
      if (name === 'spec_health') return { baseReady: true, stateLayer: STATE_LAYER, projectRoot: adapter.projectRoot, writeMode: adapter.value.writePolicy.mode, allowedPrefixes: adapter.value.writePolicy.allowedPrefixes, fileGuardrail: false, adapterRevision: adapter.rawRevision, ...(adapter.adapterSource === 'legacy' ? { adapterSource: 'legacy' } : {}), ...(adapter.adapterPathConflict ? { adapterPathConflict: adapter.adapterPathConflict } : {}), assurance: 'collaborative', ...(await hooks.health?.(adapter) ?? {}) };
      if (name === 'spec_list') return { specs: await listSpecs() };
      if (name === 'spec_template') return { workflow: params.workflow, artifact: params.artifact, content: artifactTemplate({ workflow: params.workflow, artifact: params.artifact }), assurance: 'collaborative' };
      if (name === 'spec_validate_artifacts') return { findings: validateArtifactSchemas({ workflow: params.workflow, artifacts: params.artifacts }), assurance: 'collaborative' };
      if (!validSpec(params.spec)) return error('INVALID_FEATURE_NAME', 'spec must be a safe relative path');
      if (name === 'spec_init') return await queued(params.spec, async () => {
        if (!allowed(params.spec)) return writePolicyDenied(params.spec);
        const existing = await getState(params.spec);
        if (existing) return error('SPEC_ALREADY_EXISTS', 'spec already exists');
        if (!Object.hasOwn(INITIAL_DRAFT_PHASE, params.workflow)) return error('INVALID_FORMAT', 'workflow is not supported');
        const prefix = adapter.value.writePolicy.allowedPrefixes.find((candidate) => params.spec === candidate.slice(0, -1) || params.spec.startsWith(candidate));
        const evaluationRoot = paths.join(specsRoot, prefix.slice(0, -1));
        await fs.mkdir(evaluationRoot, { recursive: true });
        const verifiedRoot = await fs.realpath(evaluationRoot);
        if (!(verifiedRoot === specsRoot || verifiedRoot.startsWith(`${specsRoot}${paths.sep}`))) return error('SYMLINK_ESCAPE', 'evaluation directory escapes specsRoot');
        await fs.mkdir(paths.join(specsRoot, params.spec), { recursive: true, mode: 0o700 });
        let workflowState = createWorkflowState({ workflow: params.workflow });
        workflowState = advanceToInitialDraft(workflowState, params.workflow);
        if (workflowState.code) return workflowState;
        const state = { schemaVersion: 1, workflowState, artifacts: {}, approvals: {}, imported: false, workflowSource: 'explicit', execution: executionState({}) };
        await putState(params.spec, state);
        return { spec: params.spec, phase: workflowState.phase, stateEpoch: workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_adopt') return await queued(params.spec, async () => {
        if (await getState(params.spec)) return error('SPEC_ALREADY_EXISTS', 'spec is already managed');
        // `workflow` 自 T3b 起是**可选**的：省略时从 spec 自己的 `.config.kiro` 派生。
        // 但「显式给的」与「文件里声明的」若都成立且不一致，本层**不替它们在两者之间选**。
        //
        // `null` / 数字 / 对象都**不是**「没传」：把类型不对的参数静默当成省略，会让调用方
        // 以为自己指定过（而它其实被丢了）。只有 `undefined` 算省略，其余非字符串当场拒。
        if (params.workflow !== undefined && typeof params.workflow !== 'string') {
          return error('INVALID_FORMAT', 'workflow must be a string when provided');
        }
        const explicit = params.workflow;
        if (explicit !== undefined && !Object.hasOwn(INITIAL_DRAFT_PHASE, explicit)) return error('INVALID_FORMAT', 'workflow is not supported');

        // 顺序是有意的：先让 storage 证明这个 spec 目录存在（「目录不存在 / 符号链接逃逸 /
        // 路径不合法」这些形态仍由它给出，与改动前一致），**之后**再读 `.config.kiro`。
        // 反过来会让「目录根本不存在」被报成「没有可派生的类型声明」—— 一个错误的诊断。
        const adopted = await storage.adopt({ spec: params.spec, workflow: explicit });
        // ⚠️ 两步：读**文本**，再解析。`readConfigKiro` 返回的是原文（`undefined` = 没读到），
        // 判别式结果由 `parseConfigKiro` 给 —— 少走第二步会让每份配置都被当成「解读不了」，
        // 而这恰好是最难从现象上看出来的错法（每条路径都报同一个 code）。
        const config = parseConfigKiro(await readConfigKiro(params.spec));
        const derived = workflowFromConfig(config);
        // 真机的原值如实回报（`null` 而不是 `undefined`：工具结果必须能过 JSON 往返）。
        const declared = {
          specType: config.usable ? config.specType ?? null : null,
          workflowType: config.usable ? config.workflowType ?? null : null
        };

        let workflow = explicit;
        let workflowSource = 'explicit';
        if (explicit === undefined) {
          if (derived.workflow === undefined) {
            return error('WORKFLOW_UNKNOWN',
              `workflow is required: ${workflowUnknownReason(derived)}`,
              { reason: derived.code, detail: derived.detail ?? null, configPresent: config.present, ...declared },
              '显式传 workflow（requirements-first / design-first / bugfix / quick），'
              + `或者先给这个 spec 写一份可用的 ${CONFIG_KIRO_FILE} 再接管`);
          }
          workflow = derived.workflow;
          workflowSource = 'config';
        } else if (derived.workflow !== undefined && derived.workflow !== explicit) {
          return error('WORKFLOW_CONFLICT',
            `${CONFIG_KIRO_FILE} declares ${derived.workflow} but this call requested ${explicit} — adoption will not choose between them`,
            { requested: explicit, fromConfig: derived.workflow, ...declared },
            `两者必须一致：要么改传 "${derived.workflow}"，要么先修正 ${CONFIG_KIRO_FILE}`
            + '。⚠️ 改那个文件会同时改变**真机**的判定（它按 specType 选规则表）—— 见 research/15 §3');
        }

        let workflowState = createWorkflowState({ workflow });
        workflowState = advanceToInitialDraft(workflowState, workflow);
        if (workflowState.code) return workflowState;
        const artifacts = {};
        for (const artifact of Object.keys(adopted.artifacts)) {
          if (!ARTIFACTS.has(artifact)) continue;
          const current = await storage.read(`${params.spec}/${fileFor(artifact)}`);
          artifacts[artifact] = artifactRecord(artifact, current.content, current.rawRevision);
        }
        // `workflowSource` 落到私有状态里：T3 的判据之一是「`spec_status` 要能说出
        // 当前的 workflow 是**怎么知道的**」（dsh-spec 那边是 `workflowSource` = config/meta/
        // artifact/default）。来源在 `spec_adopt` 那一刻才知道，事后无法从 state 反推 ——
        // 所以必须记下来，否则「依据 `.config.kiro` 接管」这件事只活在返回值里、下一次调用就没了。
        // 老状态没有这个键时读出来是 `null`（= 不知道），**不猜**。
        await putState(params.spec, { schemaVersion: 1, workflowState, artifacts, approvals: {}, imported: true, workflowSource, execution: executionState({}) });
        // `phase` / `stateEpoch` 与 `spec_init` 对齐：接管之后调用方要知道自己落在**哪条链的
        // 哪一阶段**（否则只能再调一次 `spec_status`）。而「落在哪条链」正是 T3b 的判据本身 ——
        // 它必须在接管那一刻可观测，不能靠事后推断。改动前这里只回 `{status, workflow, artifacts}`。
        return { ...adopted, workflow, workflowSource, phase: workflowState.phase, stateEpoch: workflowState.stateEpoch, ...declared };
      });
      const state = await getState(params.spec);
      if (!state && name.startsWith('spec_task_')) return error('ADOPTION_REQUIRED', 'existing Spec must be adopted before task execution', { spec: params.spec }, '调用 spec_adopt 后重新规划');
      if (!state) return error('SPEC_NOT_FOUND', 'spec is not initialized; use spec_adopt for existing artifacts');
      if (name === 'spec_task_set') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        const pendingRecovery = await reconcilePending(params.spec, state);
        if (pendingRecovery) return pendingRecovery;
        if (executionState(state).activeTask) return error('TASK_ALREADY_ACTIVE', `task ${executionState(state).activeTask.taskId} is already active`);
        const missing = await observeKnownArtifacts(params.spec, state);
        if (missing.length > 0) return error('ARTIFACT_MISSING', `required artifacts are missing: ${missing.join(', ')}`, { artifacts: missing });
        const observed = await observe(params.spec, 'tasks', state);
        let states;
        try { states = taskStates(observed.current.content); } catch (caught) { return error('INVALID_FORMAT', caught.message); }
        const currentState = states[params.taskId];
        if (currentState === undefined) return error('TASK_NOT_FOUND', `task ${params.taskId} does not exist`, { taskId: params.taskId });
        const target = { pending: ' ', 'in-progress': '-', done: 'x' }[params.state];
        if (currentState === target) return { taskId: params.taskId, state: `[${target}]`, rawRevision: observed.current.rawRevision, stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
        const content = replaceTaskState(observed.current.content, params.taskId, currentState, target);
        const write = await storage.write({ relativePath: `${params.spec}/tasks.md`, content, expectedRawRevision: observed.current.rawRevision });
        state.artifacts.tasks = artifactRecord('tasks', content, write.rawRevision);
        state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
        await putState(params.spec, state);
        return { taskId: params.taskId, state: `[${target}]`, rawRevision: write.rawRevision, stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_task_plan') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        const missing = await observeKnownArtifacts(params.spec, state);
        if (missing.length > 0) return error('ARTIFACT_MISSING', `required artifacts are missing: ${missing.join(', ')}`, { artifacts: missing });
        if (state.workflowState.phase !== 'implementing') return error('PHASE_NOT_APPROVED', `cannot execute tasks in ${state.workflowState.phase}`);
        if (executionState(state).activeTask) return error('TASK_ALREADY_ACTIVE', `task ${executionState(state).activeTask.taskId} is already active`);
        const observed = await observe(params.spec, 'tasks', state);
        const plan = createTaskPlan({ markdown: observed.current.content, waves: wavesFrom(observed.current.content), scope: params.scope, taskId: params.taskId, waveId: params.waveId });
        // 图读不出来时，`scope="wave"` 会以 WAVE_NOT_FOUND 收场。把**为什么**读不出来一并
        // 带上：否则调用方只知道「没有这个 wave」，不知道整张图其实压根没被看见。
        const waveWarnings = waveWarningsFrom(observed.current.content);
        if (plan.code) return waveWarnings.length > 0 ? { ...plan, details: { ...plan.details, warnings: waveWarnings } } : plan;
        const blockedTaskId = plan.taskIds.find((taskId) => (executionState(state).attemptsByTask?.[taskId] ?? 0) >= 3);
        if (blockedTaskId) return error('HUMAN_REVIEW_REQUIRED', `task ${blockedTaskId} requires human review after three failures`, { taskId: blockedTaskId });
        const value = { ...plan, spec: params.spec, workspaceRevision: workspaceRevision(params), stateEpoch: state.workflowState.stateEpoch, ...(waveWarnings.length > 0 ? { warnings: waveWarnings } : {}) };
        pruneTaskPlans(state);
        rememberPlan(state, value);
        await putState(params.spec, state);
        return value;
      });
      if (name === 'spec_task_begin') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        const pendingRecovery = await reconcilePending(params.spec, state);
        if (pendingRecovery?.reason === 'orphaned_begin') {
          const entry = (await storage.journal.list({ spec: params.spec, status: 'pending' })).find((candidate) => candidate.id === pendingRecovery.journalId);
          if (!params.recoverExpired) return pendingRecovery;
          if (params.taskId !== entry.intent.taskId || params.planRevision !== entry.intent.planRevision) return error('PLAN_STALE', 'recovery must resume the journal-owned task and plan');
          const ownerToken = randomUUID();
          const execution = beginTaskExecution({ execution: executionState(state), taskId: params.taskId, taskType: entry.intent.taskType, ownerTokenHash: hashOwnerToken(ownerToken), leaseExpiresAt: now() + TASK_LEASE_MS, workspaceRevision: workspaceRevision(params) });
          execution.activeTask = { ...execution.activeTask, journalId: entry.id, planRevision: entry.intent.planRevision, planTaskIds: entry.intent.planTaskIds };
          state.execution = execution;
          const recoveredTasks = await storage.read(`${params.spec}/tasks.md`);
          state.artifacts.tasks = artifactRecord('tasks', recoveredTasks.content, recoveredTasks.rawRevision);
          state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
          await putState(params.spec, state);
          await storage.journal.commit({ id: entry.id });
          return { taskId: params.taskId, ownerToken, leaseExpiresAt: execution.activeTask.leaseExpiresAt, stateEpoch: state.workflowState.stateEpoch, recovered: true, assurance: 'collaborative' };
        }
        if (pendingRecovery) return pendingRecovery;
        const missing = await observeKnownArtifacts(params.spec, state);
        if (missing.length > 0) return error('ARTIFACT_MISSING', `required artifacts are missing: ${missing.join(', ')}`, { artifacts: missing });
        if (state.workflowState.phase !== 'implementing') return error('PLAN_STALE', `task execution approval changed; current phase is ${state.workflowState.phase}`);
        if (params.expectedStateEpoch !== state.workflowState.stateEpoch) return error('STATE_EPOCH_CONFLICT', 'stateEpoch is stale');
        const currentExecution = executionState(state);
        if (currentExecution.activeTask) {
          const expired = currentExecution.activeTask.leaseExpiresAt <= now();
          if (!expired) return error('TASK_ALREADY_ACTIVE', `task ${currentExecution.activeTask.taskId} is already active`);
          if (!params.recoverExpired) return error('RECOVERY_REQUIRED', 'active task lease expired; retry with recoverExpired after reviewing workspace state', { taskId: currentExecution.activeTask.taskId });
          if (params.taskId !== currentExecution.activeTask.taskId || params.planRevision !== currentExecution.activeTask.planRevision) return error('PLAN_STALE', 'recovery must resume the expired task and plan');
          let journal;
          try { journal = await storage.journal.get({ id: currentExecution.activeTask.journalId }); } catch { return error('RECOVERY_REQUIRED', 'active task journal is unavailable'); }
          if (journal.status !== 'committed' || journal.spec !== params.spec || journal.intent.action !== 'task_begin' || journal.intent.taskId !== params.taskId) return error('RECOVERY_REQUIRED', 'active task is not backed by its begin journal');
          const currentTasks = await storage.read(`${params.spec}/tasks.md`);
          if (currentTasks.rawRevision !== journal.intent.afterRawRevision) return error('RECOVERY_REQUIRED', 'active task Markdown no longer matches its begin journal');
          const ownerToken = randomUUID();
          const ownerTokenHash = hashOwnerToken(ownerToken);
          const execution = beginTaskExecution({ execution: { ...currentExecution, activeTask: null }, taskId: params.taskId, taskType: currentExecution.activeTask.taskType, ownerTokenHash, leaseExpiresAt: now() + TASK_LEASE_MS, workspaceRevision: workspaceRevision(params) });
          execution.activeTask = {
            ...execution.activeTask,
            journalId: currentExecution.activeTask.journalId,
            planRevision: currentExecution.activeTask.planRevision,
            planTaskIds: currentExecution.activeTask.planTaskIds
          };
          state.execution = execution;
          state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
          await putState(params.spec, state);
          return { taskId: params.taskId, ownerToken, leaseExpiresAt: execution.activeTask.leaseExpiresAt, stateEpoch: state.workflowState.stateEpoch, recovered: true, assurance: 'collaborative' };
        }
        if (pruneTaskPlans(state)) await putState(params.spec, state);
        const plan = state.taskPlans?.[params.planRevision];
        if (!plan || !plan.taskIds.includes(params.taskId) || plan.stateEpoch !== params.expectedStateEpoch || plan.workspaceRevision !== workspaceRevision(params)) return error('PLAN_STALE', 'task plan is missing or stale');
        if (plan.taskIds[0] !== params.taskId) return error('DEPENDENCY_NOT_MET', `task ${params.taskId} is not the next executable task`, { nextTaskId: plan.taskIds[0] });
        if ((currentExecution.attemptsByTask?.[params.taskId] ?? 0) >= 3) return error('HUMAN_REVIEW_REQUIRED', `task ${params.taskId} requires human review after three failures`);
        const observed = await observe(params.spec, 'tasks', state);
        if (observed.current.rawRevision !== plan.tasksRevision) return error('PLAN_STALE', 'tasks.md changed after planning');
        const ownerToken = randomUUID();
        const ownerTokenHash = hashOwnerToken(ownerToken);
        const execution = beginTaskExecution({ execution: currentExecution, taskId: params.taskId, taskType: plan.taskTypes[params.taskId], ownerTokenHash, leaseExpiresAt: now() + TASK_LEASE_MS, workspaceRevision: workspaceRevision(params) });
        const eventId = randomUUID();
        const content = appendExecutionEvent(updateTaskState(observed.current.content, params.taskId, ' ', '-'), { id: eventId, kind: 'task-transition', taskId: params.taskId, from: ' ', to: '-' });
        const journal = await storage.journal.begin({ spec: params.spec, intent: { action: 'task_begin', taskId: params.taskId, taskType: plan.taskTypes[params.taskId], planRevision: plan.planRevision, planTaskIds: plan.taskIds, workspaceRevision: workspaceRevision(params), eventId, from: ' ', to: '-', beforeRawRevision: observed.current.rawRevision, afterRawRevision: computeRawRevision(Buffer.from(content)) } });
        execution.activeTask = { ...execution.activeTask, journalId: journal.id, planRevision: plan.planRevision, planTaskIds: plan.taskIds };
        await fault('afterTaskJournalWrite', { action: 'task_begin', spec: params.spec, taskId: params.taskId });
        const write = await storage.write({ relativePath: `${params.spec}/tasks.md`, content, expectedRawRevision: observed.current.rawRevision });
        await fault('afterTaskMarkdownWrite', { action: 'task_begin', spec: params.spec, taskId: params.taskId });
        state.execution = execution;
        state.artifacts.tasks = artifactRecord('tasks', content, write.rawRevision);
        state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
        delete state.taskPlans[params.planRevision];
        await putState(params.spec, state);
        await storage.journal.commit({ id: journal.id });
        return { taskId: params.taskId, ownerToken, leaseExpiresAt: execution.activeTask.leaseExpiresAt, stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_task_record_check') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (params.expectedStateEpoch !== state.workflowState.stateEpoch) return error('STATE_EPOCH_CONFLICT', 'stateEpoch is stale');
        const currentExecution = executionState(state);
        if (currentExecution.activeTask && currentExecution.activeTask.leaseExpiresAt <= now()) return error('LEASE_EXPIRED', 'task lease expired');
        const execution = recordTaskCheck({ execution: currentExecution, ownerTokenHash: hashOwnerToken(params.ownerToken), command: params.command, exitCode: params.exitCode, summary: params.summary });
        if (execution.code) return execution;
        state.execution = execution;
        state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
        await putState(params.spec, state);
        return { taskId: execution.activeTask.taskId, checks: execution.activeTask.checks, stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_task_complete') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (params.expectedStateEpoch !== state.workflowState.stateEpoch) return error('STATE_EPOCH_CONFLICT', 'stateEpoch is stale');
        const currentExecution = executionState(state);
        const ownerTokenHash = hashOwnerToken(params.ownerToken);
        if (!currentExecution.activeTask) return error('TASK_NOT_ACTIVE', 'no task is active');
        if (currentExecution.activeTask.ownerTokenHash !== ownerTokenHash) return error('OWNER_TOKEN_INVALID', 'owner token does not match the active task');
        await observeKnownArtifacts(params.spec, state);
        if (state.workflowState.phase !== 'implementing') return error('RECOVERY_REQUIRED', 'Spec semantics changed during task execution; review and re-approve before completing', { taskId: currentExecution.activeTask.taskId });
        if (currentExecution.activeTask && currentExecution.activeTask.leaseExpiresAt <= now()) return error('LEASE_EXPIRED', 'task lease expired');
        const active = currentExecution.activeTask;
        const execution = completeTaskExecution({ execution: currentExecution, ownerTokenHash, workspaceRevision: workspaceRevision(params), summary: params.summary });
        if (execution.code) return execution;
        const observed = await observe(params.spec, 'tasks', state);
        const eventId = randomUUID();
        const content = appendExecutionEvent(updateTaskState(observed.current.content, active.taskId, '-', 'x'), { id: eventId, kind: 'task-transition', taskId: active.taskId, from: '-', to: 'x' });
        const journal = await storage.journal.begin({ spec: params.spec, intent: { action: 'task_complete', taskId: active.taskId, eventId, from: '-', to: 'x', beforeRawRevision: observed.current.rawRevision, afterRawRevision: computeRawRevision(Buffer.from(content)), nextExecution: execution, nextStateEpoch: state.workflowState.stateEpoch + 1 } });
        await fault('afterTaskJournalWrite', { action: 'task_complete', spec: params.spec, taskId: active.taskId });
        const write = await storage.write({ relativePath: `${params.spec}/tasks.md`, content, expectedRawRevision: observed.current.rawRevision });
        await fault('afterTaskMarkdownWrite', { action: 'task_complete', spec: params.spec, taskId: active.taskId });
        state.execution = execution;
        state.artifacts.tasks = artifactRecord('tasks', content, write.rawRevision);
        state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
        await putState(params.spec, state);
        await storage.journal.commit({ id: journal.id });
        const nextTaskId = active.planTaskIds.find((taskId) => !execution.completedTaskIds.includes(taskId)) ?? null;
        return { completedTaskId: active.taskId, nextTaskId, stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_task_fail') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (params.expectedStateEpoch !== state.workflowState.stateEpoch) return error('STATE_EPOCH_CONFLICT', 'stateEpoch is stale');
        const currentExecution = executionState(state);
        const active = currentExecution.activeTask;
        if (active?.leaseExpiresAt <= now()) return error('LEASE_EXPIRED', 'task lease expired');
        const failed = failTaskExecution({ execution: currentExecution, ownerTokenHash: hashOwnerToken(params.ownerToken), summary: params.summary });
        if (failed.code && failed.code !== 'HUMAN_REVIEW_REQUIRED') return failed;
        const execution = failed.execution ?? failed;
        const observed = await observe(params.spec, 'tasks', state);
        const eventId = randomUUID();
        const content = appendExecutionEvent(updateTaskState(observed.current.content, active.taskId, '-', ' '), { id: eventId, kind: 'task-transition', taskId: active.taskId, from: '-', to: ' ' });
        const journal = await storage.journal.begin({ spec: params.spec, intent: { action: 'task_fail', taskId: active.taskId, eventId, from: '-', to: ' ', beforeRawRevision: observed.current.rawRevision, afterRawRevision: computeRawRevision(Buffer.from(content)), nextExecution: execution, nextStateEpoch: state.workflowState.stateEpoch + 1 } });
        await fault('afterTaskJournalWrite', { action: 'task_fail', spec: params.spec, taskId: active.taskId });
        const write = await storage.write({ relativePath: `${params.spec}/tasks.md`, content, expectedRawRevision: observed.current.rawRevision });
        await fault('afterTaskMarkdownWrite', { action: 'task_fail', spec: params.spec, taskId: active.taskId });
        state.execution = execution;
        state.artifacts.tasks = artifactRecord('tasks', content, write.rawRevision);
        state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
        await putState(params.spec, state);
        await storage.journal.commit({ id: journal.id });
        if (failed.code) return { ...failed, execution: undefined, failedTaskId: active.taskId, stateEpoch: state.workflowState.stateEpoch };
        return { failedTaskId: active.taskId, attempts: execution.attemptsByTask[active.taskId], stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_task_reset_failures') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (params.expectedStateEpoch !== state.workflowState.stateEpoch) return error('STATE_EPOCH_CONFLICT', 'stateEpoch is stale');
        if (state.workflowState.phase !== 'implementing') return error('PHASE_NOT_APPROVED', `cannot reset failures in ${state.workflowState.phase}`);
        const execution = executionState(state);
        if (execution.activeTask) return error('TASK_ALREADY_ACTIVE', `task ${execution.activeTask.taskId} is already active`);
        if ((execution.attemptsByTask?.[params.taskId] ?? 0) < 3) return error('RESET_NOT_REQUIRED', `task ${params.taskId} is not blocked`);
        const expected = `确认重置任务 ${params.taskId}`;
        if (params.confirmationText !== expected) return error('CONFIRMATION_TEXT_INVALID', `confirmation text must exactly match: ${expected}`);
        state.execution = {
          ...execution,
          attemptsByTask: { ...execution.attemptsByTask, [params.taskId]: 0 },
          humanResets: [...(execution.humanResets ?? []), { taskId: params.taskId, recordedAt: new Date(now()).toISOString(), confirmationText: params.confirmationText }]
        };
        state.workflowState = { ...state.workflowState, stateEpoch: state.workflowState.stateEpoch + 1 };
        await putState(params.spec, state);
        return { taskId: params.taskId, reset: true, stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_context') {
        const files = adapterContextFiles(adapter, params.artifact ?? 'requirements');
        if (files.length === 0) return error('RULES_UNAVAILABLE', 'no context files match this artifact');
        // `knownRevisions` —— 调用方已经持有的 `path → rawRevision`。命中的文件**只回执**，
        // 不回正文。
        //
        // 由来是一次实测：`contextProof` 5 分钟过期，而 `spec_write` / `spec_amend` 都强制
        // 要求一份有效 proof，所以一段稍长的起草里同一批规则文件会被反复整份灌进上下文 ——
        // 而它们在这期间**逐字节没变**。
        //
        // 🔴 判据是 `computeRawRevision` 的字节哈希，不是「调用方觉得自己还记得」：
        // 盘上变了一个字节就照常回全文。所以这里省掉的是**确定重复**的那部分，
        // 准确性一分不让。proof 里记的仍然是**全部** contextFiles 与它们的真实 revision，
        // 与是否回正文无关 —— `proofValid` 的判定面没有变窄。
        const known = new Map(
          Array.isArray(params.knownRevisions)
            ? params.knownRevisions.filter((entry) => entry && typeof entry.path === 'string').map((entry) => [entry.path, entry.rawRevision])
            : Object.entries(params.knownRevisions ?? {})
        );
        const pages = [];
        const contextFiles = [];
        let unchangedCount = 0;
        for (const relative of files) {
          const file = await fs.realpath(paths.join(adapter.projectRoot, relative));
          // 先读**字节**再解码：`proofValid` 用的就是字节哈希（`computeRawRevision(await fs.readFile(path))`），
          // 两处必须是同一个口径，否则回执给出的 revision 与校验用的 revision 可能不是同一个数。
          const raw = await fs.readFile(file);
          const rawRevision = computeRawRevision(raw);
          contextFiles.push({ path: file, rawRevision });
          if (known.get(relative) === rawRevision) {
            unchangedCount += 1;
            pages.push({ path: relative, rawRevision, unchanged: true });
            continue;
          }
          pages.push({ path: relative, rawRevision, content: raw.toString('utf8') });
        }
        const token = `context:${randomUUID()}`;
        proofs.set(token, { expiresAt: now() + 5 * 60 * 1000, adapterRevision: adapter.rawRevision, spec: params.spec, artifact: params.artifact ?? 'requirements', contextFiles });
        return { page: 1, totalPages: 1, files: pages, unchangedCount, contextProof: token, expiresAt: now() + 5 * 60 * 1000 };
      }
      if (name === 'spec_read') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        const observed = await observe(params.spec, params.artifact, state);
        const taskAst = params.artifact === 'tasks' ? parseTasks(observed.current.content) : undefined;
        state.artifacts[params.artifact] = artifactRecord(params.artifact, observed.current.content, observed.current.rawRevision);
        await putState(params.spec, state);

        // 部分读 —— `outline` 只回目录，`section` 只回一节。
        //
        // 起因与 `spec_context` 的 knownRevisions 同源：本仓库真实 design.md ≈ 12,000 字符，
        // 而多数读取只是为了看其中一节。**基线刷新与回多少正文无关**：上面的 `observe`
        // 已经按盘上的全量内容比对过指纹（外部改动照样被发现、审批照样作废），
        // 这里改的只是回给调用方的正文量。
        //
        // 🔴 但部分读会带来一个新风险：调用方只看过一节，却拿到了一个「当前」的
        // rawRevision —— 如果它接着用 `spec_write` 整份覆盖，CAS **会通过**，
        // 没看过的那几节就被静默抹掉了。所以部分读一律标 `partial: true` 并附一句
        // 明确的去向（改用 `spec_amend`，它在服务端就地变换，不需要整份正文）。
        // 不把这个风险藏起来，是这条优化能成立的前提。
        const wantsOutline = params.outline === true;
        const wantsSection = typeof params.section === 'string' && params.section !== '';
        const base = {
          artifact: params.artifact,
          rawRevision: observed.current.rawRevision,
          approvalFingerprint: observed.fingerprint,
          externalChange: observed.externalChange ?? null,
          ...(taskAst ? { warnings: taskAst.warnings } : {})
        };
        if (!wantsOutline && !wantsSection) return { ...base, content: observed.current.content };

        const sections = splitSections(observed.current.content);
        const partialNote = '这是一次部分读：不要用它的 rawRevision 去做整份 spec_write（CAS 会通过，没读到的小节会被静默覆盖）。改用 spec_amend 做就地修正，或不带 section/outline 再读一次拿全文。';
        if (wantsOutline) {
          return {
            ...base,
            partial: true,
            totalCharacters: observed.current.content.length,
            sections: sections.map(({ content, ...meta }) => meta),
            partialNote
          };
        }
        const matches = sections.filter((section) => section.heading === params.section);
        if (matches.length === 0) {
          return error('SECTION_NOT_FOUND', `no top-level "## " section titled ${JSON.stringify(params.section)}`, {
            available: sections.map((section) => section.heading).filter((heading) => heading !== null)
          });
        }
        // 同名小节出现多次时**不挑第一个**：与 amendments 的 `from` 歧义拒绝同一条原则 ——
        // 静默取第一个会让调用方以为自己读到了唯一那一节。报出每一处的起始行，让它改读全文或 outline。
        if (matches.length > 1) {
          return error('SECTION_AMBIGUOUS', `${matches.length} top-level "## " sections are titled ${JSON.stringify(params.section)}`, {
            startLines: matches.map((section) => section.startLine)
          }, '不带 section 再读一次拿全文，或先用 outline 看清结构');
        }
        const [found] = matches;
        return {
          ...base,
          partial: true,
          section: found.heading,
          startLine: found.startLine,
          totalCharacters: observed.current.content.length,
          content: found.content,
          partialNote
        };
      });
      if (name === 'spec_write') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (!allowed(params.spec)) return writePolicyDenied(params.spec);
        if (!WORKFLOW_ARTIFACTS[state.workflowState.workflow]?.has(params.artifact)) return error('ARTIFACT_NOT_ALLOWED', `${params.artifact} is not an artifact of ${state.workflowState.workflow}`);
        if (!await proofValid(params.contextProof, params.spec, params.artifact)) return error('CONTEXT_PROOF_INVALID', 'a current spec_context proof is required');
        const missing = await observeKnownArtifacts(params.spec, state);
        const blockingMissing = missing.filter((artifact) => artifact !== params.artifact);
        if (blockingMissing.length > 0) return error('ARTIFACT_MISSING', `required artifacts are missing: ${blockingMissing.join(', ')}`, { artifacts: blockingMissing });
        const quickReview = state.workflowState.workflow === 'quick' && state.workflowState.phase === 'overall_review';
        if (!quickReview && state.workflowState.phase !== writePhase(state.workflowState.workflow, params.artifact)) return error('PHASE_NOT_APPROVED', `cannot write ${params.artifact} in ${state.workflowState.phase}`);
        const artifact = params.artifact;
        // 宿主插槽 `beforeWrite`：claude-spec 用它把 §4.3.2 署名**合进同一次原子写**
        // （署名与它所描述的改动一起落盘，少一类事后操作；本包不判断署名是否改变审批指纹 ——
        // 第 8 期 `semantic-v2` 起 `tasks.md` 上的合法署名行已被剥离，见 @my-harness/spec-revision）。
        // codex-spec 没有署名概念，hook 缺省是恒等。
        //
        // 契约：返回 `{ content, extra? }`，或返回带 `code` 的对象当场拒绝（SIGNATURE_INVALID）。
        // content 的最终值由 hook 决定，但**写盘仍然只有这一处** —— 署名不可能绕过 CAS。
        // 🔴 `previousContent`：盘上那一份，给 hook 用来**保留**整份替换会带走的东西
        // （claude-spec 用它保住 §4.3.2 署名台账 —— 见 2026-09-18 缺陷报告第 2 条）。
        // 只在有 hook 时才读：没有 hook 的宿主（codex-spec）不该为此多一次 I/O。
        // ENOENT 是首次写入的正常形态，不是错误。
        let previousContent = null;
        if (hooks.beforeWrite) {
          try { previousContent = (await storage.read(`${params.spec}/${fileFor(artifact)}`)).content; }
          catch (caught) { if (caught.code !== 'ENOENT') throw caught; }
        }
        const prepared = hooks.beforeWrite
          ? await hooks.beforeWrite({ artifact, content: params.content, params, state, previousContent, adapter })
          : { content: params.content };
        if (prepared?.code) return prepared;
        const content = prepared.content;
        const extra = prepared.extra ?? {};
        const record = artifactRecord(artifact, content, computeRawRevision(Buffer.from(content)));
        const write = await storage.write({ relativePath: `${params.spec}/${fileFor(artifact)}`, content, expectedRawRevision: params.expectedRawRevision });
        state.artifacts[artifact] = { ...record, rawRevision: write.rawRevision };
        state.missingArtifacts = (state.missingArtifacts ?? []).filter((item) => item !== artifact);
        if (quickReview) {
          state.workflowState = { ...state.workflowState, phase: 'artifacts_generated', approvals: Object.fromEntries(Object.keys(state.workflowState.approvals).map((name) => [name, 'invalidated'])), stateEpoch: state.workflowState.stateEpoch + 1 };
          syncApprovalDetails(state);
          delete state.approvalRequest;
        }
        await putState(params.spec, state);
        return { ...write, approvalFingerprint: state.artifacts[artifact].approvalFingerprint, assurance: 'collaborative', ...extra };
      });
      // ── spec_amend —— 冻结 spec 的增量修正通道 ──────────────────────────────
      //
      // 与 `spec_write` 的**三处**刻意不同，每一处都有由来：
      //
      //  ① **不做 phase 门控。** `spec_write` 只允许在该 artifact 的起草阶段写，而 amend
      //     的全部意义就是改一份**已经批准、已进入 implementing** 的 spec（§7.1.1
      //     「冻结不等于只读」）。套用 writePhase 会让这个工具在它唯一有用的场景下必然失败。
      //  ② **整份内容不过模型的手。** 调用方给的是 `from`/`to`（或 title/body），正文由
      //     amendments 在服务端就地变换。这是本工具存在的理由：一处改动不该要求重新生成
      //     整份 12,000 字符的 design.md —— 那既是 output token 的浪费，也是一次抄写风险。
      //  ③ **写完必定作废审批。** 见下面 invalidateApprovals 处的注释。
      if (name === 'spec_amend') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (!allowed(params.spec)) return writePolicyDenied(params.spec);
        if (!AMEND_KINDS.has(params.kind)) return error('INVALID_AMEND_KIND', `kind must be one of ${[...AMEND_KINDS].join(', ')}`);
        const artifact = amendArtifact(params);
        if (!ARTIFACTS.has(artifact)) return error('INVALID_ARTIFACT', 'kind=param requires file to be requirements, design or bugfix');
        // 任务体是冻结的（Req 6.4）—— 但冻结的是**任务体**（checkbox 行与 `waves` 块），
        // 不是整份 tasks.md。所以这里不再按 artifact 名一刀切拒绝：判据只有一处，在
        // `@my-harness/spec-analysis/amendments` 的门 2b（`assertTaskBodyUnchanged`），
        // 它比较编辑前后的 checkbox 集合与 `waves` 块 —— 比在这里再写一个「像不像任务行」
        // 的形状判据准确，也避免两层各判一套、判得还不一样。
        // 那条拒绝自带 `code: 'TASK_BODY_FROZEN'`，由下面的 catch 原样透出。
        // 这里仍然守住 kind：`requirement` / `design` 两种 amend 的落点本来就不是 tasks。
        if (artifact === 'tasks' && params.kind !== 'param') return error('TASK_BODY_FROZEN', `kind=${params.kind} does not amend tasks; the task body is frozen (Req 6.4)`);
        if (!WORKFLOW_ARTIFACTS[state.workflowState.workflow]?.has(artifact)) return error('ARTIFACT_NOT_ALLOWED', `${artifact} is not an artifact of ${state.workflowState.workflow}`);
        if (!await proofValid(params.contextProof, params.spec, artifact)) return error('CONTEXT_PROOF_INVALID', 'a current spec_context proof is required');

        const relativePath = `${params.spec}/${fileFor(artifact)}`;
        let current;
        try { current = await storage.read(relativePath); }
        catch (caught) { return error(caught.code ?? 'ARTIFACT_MISSING', `cannot read ${artifact}: ${caught.message ?? caught}`); }
        if (params.expectedRawRevision !== undefined && params.expectedRawRevision !== null && params.expectedRawRevision !== current.rawRevision) {
          return error('REVISION_CONFLICT', 'rawRevision does not match', { currentRawRevision: current.rawRevision });
        }

        // amendments 收的 `dir` 只用于两件事：`_archive` 段拒绝，和拼 `<dir>/<file>.md`。
        // 传 spec 的**相对**路径即可，两者都成立（`specs/_archive/x` 照样被拒），
        // 而且拼出来的 key 与上面的 relativePath 逐字相同，内存 port 认得出。
        const bridge = amendInMemoryPort(relativePath, current.content);
        let outcome;
        try {
          if (params.kind === 'param') {
            outcome = await applyParamEdit({ port: bridge.port, dir: params.spec, file: artifact, from: params.from, to: params.to });
          } else if (params.kind === 'requirement') {
            outcome = await appendRequirement({ port: bridge.port, dir: params.spec, title: params.title, body: params.body });
          } else {
            if (typeof params.anchor !== 'string' || params.anchor === '') return error('AMEND_ANCHOR_REQUIRED', 'kind=design requires `anchor`: the exact existing line the in-place pointer follows (Req 6.3)');
            if (typeof params.pointer !== 'string' || params.pointer === '') return error('AMEND_POINTER_REQUIRED', 'kind=design requires `pointer`: the one-line pointer inserted after the anchor line');
            // 🔴 `title` 曾被**静默丢弃**（2026-09-18 缺陷报告第 6.2 条）：工具声明收下它，
            // 而 kind=design 这条路径只把 `heading` 往下传，`title` 连一句提示都没有就没了。
            // 两个参数说的是同一件事（这条修正的标题），所以：缺 heading 时 title 顶上；
            // 两个都给且不一致时**当场拒绝** —— 悄悄挑一个用，就是把缺陷换个形状留下。
            if (typeof params.title === 'string' && params.title !== '' && typeof params.heading === 'string' && params.heading !== '' && params.title.trim() !== params.heading.trim()) {
              return error('AMEND_REFUSED', 'kind=design takes ONE entry heading: `heading` and `title` were both given and differ. They name the same thing — pass only one.');
            }
            const entryHeading = (typeof params.heading === 'string' && params.heading !== '') ? params.heading : params.title;
            outcome = await appendDesignAmendment({ port: bridge.port, dir: params.spec, heading: entryHeading, body: params.body, pointer: { anchor: params.anchor, text: params.pointer } });
          }
        } catch (caught) {
          // amendments 的拒绝消息本身就是交付物（它那份文件头写明了这一点）：原样透出去，
          // 不要压成一句 "amend failed" —— 看不见为什么被拒的调用方会绕过守卫。
          return error(caught.code ?? 'AMEND_REFUSED', caught.message ?? String(caught));
        }
        const amended = bridge.result();
        if (typeof amended !== 'string') return error('AMEND_REFUSED', 'the amendment produced no content');

        // 署名走与 `spec_write` 完全相同的插槽：修正正文同样是 §4.3.2 意义上的实质改动，
        // 没有理由因为它「只改了一行」就免签。
        // amend 是就地变换，正文（含历史署名）本来就还在，所以保留逻辑在这条路径上是空操作。
        // 仍然把 `previousContent` 传齐，是为了让 hook 的契约只有一种形状 —— 将来若新增一种
        // 会删内容的 amend kind，保留逻辑自动就位，而不是那时才发现这里少传了一个参数。
        const prepared = hooks.beforeWrite
          ? await hooks.beforeWrite({ artifact, content: amended, params, state, previousContent: current.content, adapter })
          : { content: amended };
        if (prepared?.code) return prepared;
        const content = prepared.content;
        const extra = prepared.extra ?? {};

        const write = await storage.write({ relativePath, content, expectedRawRevision: current.rawRevision });

        // 🔴 修正正文 ⇒ 审批作废。这不是保守起见，是一条已经有跨宿主测试钉住的语义
        // （`scripts/amend-invalidates-approval.test.mjs`：DSH 改一行 design，Claude 侧的
        // 三个审批必须全部消失）。那条测试走的是「外部改动被 observe 发现」这条路；
        // 本工具在**进程内**改，observe 不会再把它当外部改动，所以必须在这里显式作废 ——
        // 少了这一步，同一个修正从 DSH 打进来审批会作废、从本工具打进来却不会，
        // 而后者看起来一切正常，正是最难发现的那种不一致。
        const invalidated = invalidateApprovals({ state: state.workflowState, changedArtifact: artifact, expectedStateEpoch: state.workflowState.stateEpoch });
        if (invalidated.code) return invalidated;
        state.workflowState = invalidated;
        state.artifacts[artifact] = artifactRecord(artifact, content, write.rawRevision);
        syncApprovalDetails(state);
        delete state.approvalRequest;
        await putState(params.spec, state);
        return {
          artifact,
          kind: params.kind,
          rawRevision: write.rawRevision,
          approvalFingerprint: state.artifacts[artifact].approvalFingerprint,
          amendment: outcome,
          phase: state.workflowState.phase,
          stateEpoch: state.workflowState.stateEpoch,
          approvalsInvalidated: true,
          assurance: 'collaborative',
          ...extra
        };
      });
      if (name === 'spec_request_approval') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        const observed = await observeApproval(params.spec, params.artifact, state);
        if (state.workflowState.workflow === 'quick' && params.artifact === 'all' && state.workflowState.phase === 'artifacts_generated') {
          const prepared = transitionWorkflow({ state: state.workflowState, to: 'overall_review', expectedStateEpoch: state.workflowState.stateEpoch });
          if (prepared.code) return prepared;
          state.workflowState = prepared;
        }
        if (state.workflowState.phase !== approvalPhase(state.workflowState.workflow, params.artifact)) return error('APPROVAL_STALE', `approval is not available in ${state.workflowState.phase}`);
        const request = { artifact: params.artifact, approvalFingerprint: observed.fingerprint, stateEpoch: state.workflowState.stateEpoch };
        state.approvalRequest = request;
        await putState(params.spec, state);
        return { ...request, recommendedPhrase: APPROVAL_PHRASES[params.artifact], assurance: 'collaborative' };
      });
      if (name === 'spec_record_approval') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        const request = state.approvalRequest;
        if (!request || request.artifact !== params.artifact || request.stateEpoch !== params.expectedStateEpoch) return error('APPROVAL_STALE', 'request a fresh approval first');
        if (params.confirmationText !== APPROVAL_PHRASES[params.artifact]) return error('APPROVAL_TEXT_INVALID', 'confirmation text must exactly match the recommended phrase');
        const observed = await observeApproval(params.spec, params.artifact, state);
        if (observed.fingerprint !== request.approvalFingerprint) return error('APPROVAL_STALE', 'artifact changed since approval was requested');
        let next = recordApproval({ state: state.workflowState, artifact: params.artifact, expectedStateEpoch: params.expectedStateEpoch });
        if (next.code) return next;
        const approvalResultPhase = phaseAfterApproval(state.workflowState.workflow, params.artifact);
        next = transitionWorkflow({ state: next, to: approvalResultPhase, expectedStateEpoch: next.stateEpoch });
        if (next.code) return next;
        const follow = nextDraftPhase(state.workflowState.workflow, params.artifact);
        next = transitionWorkflow({ state: next, to: follow, expectedStateEpoch: next.stateEpoch });
        state.workflowState = next;
        const recordedAt = new Date(now()).toISOString();
        for (const artifact of params.artifact === 'all' ? Object.keys(next.approvals) : [params.artifact]) {
          state.approvals[artifact] = { fingerprint: request.approvalFingerprint, confirmationText: params.confirmationText, recordedAt, assurance: 'collaborative' };
        }
        delete state.approvalRequest;
        await putState(params.spec, state);
        return { phase: next.phase, stateEpoch: next.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_status') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        const pendingRecovery = await reconcilePending(params.spec, state);
        let missingArtifacts = [];
        let observedRecovery = null;
        try { missingArtifacts = await observeKnownArtifacts(params.spec, state); }
        catch (caught) { if (caught.code === 'RECOVERY_REQUIRED') observedRecovery = { code: caught.code, ...caught.details }; else throw caught; }
        let taskInfo = {};
        try { const read = await observe(params.spec, 'tasks', state); const ast = parseTasks(read.current.content); taskInfo = { executableTaskIds: ast.executableTaskIds, warnings: [...ast.warnings, ...waveWarningsFrom(read.current.content)], waves: wavesFrom(read.current.content) }; }
        catch (caught) { if (caught.code === 'RECOVERY_REQUIRED') observedRecovery = { code: caught.code, ...caught.details }; else if (caught.code !== 'ENOENT') throw caught; }
        const execution = executionState(state);
        const recovery = pendingRecovery ?? observedRecovery ?? (execution.activeTask?.leaseExpiresAt <= now() ? { code: 'RECOVERY_REQUIRED', taskId: execution.activeTask.taskId } : null);
        // `workflowSource`：这份 workflow 是**怎么知道的**（`config` = 按 spec 自己的
        // `.config.kiro` 派生；`explicit` = 调用方在 init/adopt 时明确给的；`null` = 老状态，
        // 无法反推）。它证明的是「判定来源」，不是「判定对不对」——别把它读成质量信号。
        return { phase: state.workflowState.phase, stateEpoch: state.workflowState.stateEpoch, workflowSource: state.workflowSource ?? null, approvals: state.approvals, assurance: 'collaborative', imported: state.imported, execution, recovery, missingArtifacts, ...taskInfo };
      });
      if (name === 'spec_analyze') {
        try {
          const { artifacts } = await readCrossArtifactInputs(params.spec);
          return { findings: analyzeArtifacts(artifacts), assurance: 'collaborative' };
        } catch (caught) {
          return error('ANALYSIS_INPUT_INCOMPLETE', 'requirements, design, and tasks are required for cross-artifact analysis', { cause: caught.code });
        }
      }
      if (name === 'spec_quality_preview') {
        try {
          const { artifacts, sourceRevisions } = await readCrossArtifactInputs(params.spec);
          return { ...previewQuality(artifacts), sourceRevisions, assurance: 'collaborative' };
        } catch (caught) { return error(caught.code ?? 'ANALYSIS_INPUT_INCOMPLETE', caught.message, caught.details ?? {}); }
      }
      if (name === 'spec_sync_preview') {
        try {
          const { artifacts, sourceRevisions } = await readCrossArtifactInputs(params.spec);
          return { proposals: previewSynchronization(artifacts), sourceRevisions, assurance: 'collaborative' };
        } catch (caught) { return error(caught.code ?? 'ANALYSIS_INPUT_INCOMPLETE', caught.message, caught.details ?? {}); }
      }
      if (name === 'spec_sync_apply') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (!allowed(params.spec)) return writePolicyDenied(params.spec);
        if (params.confirmationText !== '应用同步建议') return error('APPROVAL_TEXT_INVALID', 'confirmation text must exactly match 应用同步建议');
        if (!await proofValid(params.contextProof, params.spec, 'design')) return error('CONTEXT_PROOF_INVALID', 'a current design spec_context proof is required');
        let inputs;
        try { inputs = await readCrossArtifactInputs(params.spec); }
        catch (caught) { return error(caught.code ?? 'ANALYSIS_INPUT_INCOMPLETE', caught.message, caught.details ?? {}); }
        if (!params.sourceRevisions || Object.keys(inputs.sourceRevisions).some((artifact) => params.sourceRevisions[artifact] !== inputs.sourceRevisions[artifact])) {
          return error('REVISION_CONFLICT', 'source artifacts changed since sync preview', { currentSourceRevisions: inputs.sourceRevisions });
        }
        const proposals = previewSynchronization(inputs.artifacts);
        if (proposals.length !== 1 || proposals[0].artifact !== 'design' || proposals[0].operation !== 'append') return error('SYNC_NOT_APPLICABLE', 'there is no unambiguous append-only design sync proposal');
        const proposal = proposals[0];
        const write = await storage.write({ relativePath: `${params.spec}/${fileFor('design')}`, content: `${inputs.artifacts.design}${proposal.markdown}`, expectedRawRevision: inputs.sourceRevisions.design });
        const invalidated = invalidateApprovals({ state: state.workflowState, changedArtifact: 'design', expectedStateEpoch: state.workflowState.stateEpoch });
        if (invalidated.code) return invalidated;
        state.workflowState = invalidated;
        state.artifacts.design = { rawRevision: write.rawRevision, approvalFingerprint: computeApprovalFingerprint({ artifact: 'design', markdown: `${inputs.artifacts.design}${proposal.markdown}`, strictTaskState: true }) };
        syncApprovalDetails(state);
        delete state.approvalRequest;
        await putState(params.spec, state);
        return { proposal, rawRevision: write.rawRevision, phase: state.workflowState.phase, stateEpoch: state.workflowState.stateEpoch, assurance: 'collaborative' };
      });
      if (name === 'spec_record_analysis') return await queued(params.spec, async () => {
        const state = await getState(params.spec);
        if (params.expectedStateEpoch !== state.workflowState.stateEpoch) return error('STATE_EPOCH_CONFLICT', 'stateEpoch is stale');
        if (!Array.isArray(params.findings)) return error('INVALID_ANALYSIS_RECORD', 'findings must be an array');
        state.analysisRecords ??= [];
        state.analysisRecords.push({ id: randomUUID(), findings: params.findings, recordedAt: new Date(now()).toISOString(), assurance: 'collaborative' });
        await putState(params.spec, state);
        return { analysisCount: state.analysisRecords.length, assurance: 'collaborative' };
      });
      if (name === 'spec_diagnostics') {
        const validatorPlan = (adapter.value.validators ?? []).map((validator) => ({
          id: validator.id,
          argv: ['python3', 'scripts/spec-tasks-lint.py', '--strict', `${adapter.value.specsRoot}/${params.spec}/tasks.md`],
          readOnly: true
        }));
        let diagnostics = [];
        let read;
        try {
          read = await storage.read(`${params.spec}/tasks.md`);
        } catch (caught) {
          if (caught.code !== 'ENOENT') throw caught;
        }
        if (read) {
          try {
            diagnostics = parseTasks(read.content).warnings;
          } catch (caught) {
            diagnostics = [{ code: caught.code ?? 'INVALID_FORMAT', severity: 'error', message: caught.message }];
          }
        }
        // `findings` —— 对标 Kiro `get_diagnostics` 的 spec 分支（2026-09-17）：直接读**盘上**
        // 这份 spec 的全部 artifact，按同一套规则（Kiro 41 条 + 本仓约定）诊断。
        //
        // 此前本工具只回 `tasks.md` 的解析警告 + 一条让宿主自己跑的 lint 命令，真正的规则只能经
        // `spec_validate_artifacts` 拿到 —— 而那要求调用方把**整份正文**当参数传进来（每份数千 token），
        // 也看不到 `.config.kiro`。这里两件事都补上：
        //   · 读盘，调用方只传 spec 名；
        //   · specType 取 `.config.kiro` 写明的值，与真机 `get_diagnostics` 同一输入。
        // 只读：不走 `observe`（不刷新基线、不作废审批、不写私有状态），与 `readOnlyHint` 一致。
        // 缺席的 artifact 列进 `missingArtifacts`，不当错误。
        const workflow = state.workflowState.workflow;
        const contents = {};
        const missingArtifacts = [];
        for (const artifact of WORKFLOW_ARTIFACTS[workflow] ?? []) {
          try { contents[artifact] = (await storage.read(`${params.spec}/${fileFor(artifact)}`)).content; }
          catch (caught) { if (caught.code === 'ENOENT') missingArtifacts.push(artifact); else throw caught; }
        }
        const config = parseConfigKiro(await readConfigKiro(params.spec));
        const specType = config.usable ? config.specType ?? null : null;
        const findings = validateArtifactSchemas({ workflow, artifacts: contents, specType: specType ?? undefined });
        return { diagnostics, findings, specType, missingArtifacts, validatorPlan, assurance: 'collaborative' };
      }
      return error('METHOD_NOT_FOUND', `unknown tool: ${name}`);
    } catch (caught) { return error(caught.code ?? 'INVALID_FORMAT', caught.message, caught.details ?? {}); }
  }
  return { adapter, call };
}
