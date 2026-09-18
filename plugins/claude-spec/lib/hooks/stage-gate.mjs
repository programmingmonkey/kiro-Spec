// claude-spec —— `PreToolUse` 阶段门控的**判定逻辑**（纯函数，可注入依赖，便于单测）。
//
// 为什么门控必须落在 `PreToolUse` 拦工具调用，而不是靠 SKILL.md 提醒：
// 模型手边永远有原生 `Write`，工具描述与 system prompt 拦不住它。第 5 期探针实测
// `PreToolUse` 在 Cowork 上会响、带 `tool_name` / `tool_input`，且**覆盖子代理**
// （子代理内部的每次 Write/Edit 各自独立触发，payload 带 `agent_id` / `agent_type`）。
//
// 三条实测约束直接写进实现，不是注释里的免责声明：
//   ① 子代理的 Write/Edit 各自独立触发 → 本判定**不看** `agent_id` / `agent_type`，
//      对父会话与子代理一视同仁。任何「只在父会话生效」的写法都会留下一个洞。
//   ② hook 跑在**会话容器**（Linux）里，读到的是容器的文件系统 → 判定只用 `node:path.posix`
//      与注入的 `exists`，不做任何「本机在哪」的假设。
//   ③ 探针的记录器永远 `exit 0`，本门控**要真拒绝** —— 二者不是一回事。但带
//      continuation 语义的事件（`Stop` / `SubagentStop`）**绝不**返回非零，见 `exitCodeFor`。
//
// 档位：**collaborative，不是 hard-security。** 模型能改自己正在被它判定的 hook 脚本
// （第 5 期 `privateStateIntegrity: FAIL`）。门控拦得住「越阶段写」，拦不住「改门控的人」。
// 任何把它描述成硬护栏的说法都超出了这份实现的实际能力。

import posix from 'node:path/posix';

/** 受阶段门控的 artifact —— 每个都映射到「它之前必须已存在的 artifact」。空数组 = 工作流的第一阶段。 */
export const STAGE_PREDECESSORS = Object.freeze({
  'requirements.md': [],
  'bugfix.md': [],
  // design 之前可能是 requirements（feature 工作流）或 bugfix（bugfix 工作流）——
  // `lib/core/workflow.mjs` 的两条审批链就是这么排的：requirements→design→tasks 与
  // bugfix→design→tasks。只认 requirements 会把 bugfix 工作流正常的第一阶段写完就卡住。
  'design.md': ['requirements.md', 'bugfix.md'],
  'tasks.md': ['design.md'],
});

/**
 * 门控认得的写工具。
 *
 * `Write|Edit` 是计划点名要求覆盖的核心两个。`MultiEdit` 是同一项能力在宿主里的另一个名字 ——
 * 一个只认 `Write|Edit` 的阶段门控，在宿主暴露 `MultiEdit` 时就是一个洞，而且正是这个门控
 * 存在的理由要堵的那种洞。其余工具（含只作用于 notebook 的那些，它们永远碰不到 `.md`）一律放行。
 */
export const GATED_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit']);

/** payload 里可能承载目标路径的键，按可能性排序。 */
const TARGET_KEYS = Object.freeze(['file_path', 'path', 'notebook_path']);

/** 带 continuation 语义的事件：向它们返回非零可能被理解成「继续」，一律不许发。 */
export const CONTINUATION_SENSITIVE_EVENTS = Object.freeze(['Stop', 'SubagentStop', 'StopFailure']);

/** 拒绝时该用的退出码。`PreToolUse` 走 `exit 2`（阻塞语义）；continuation 敏感事件恒为 0。 */
export function exitCodeFor(eventName, decision) {
  if (decision !== 'deny') return 0;
  return CONTINUATION_SENSITIVE_EVENTS.includes(eventName) ? 0 : 2;
}

/** 从 `tool_input` 里取目标路径。取不到就返回 `undefined`（调用方据此放行，而不是猜一个）。 */
export function targetPathOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  for (const key of TARGET_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 把目标路径归一化成容器里的绝对路径。
 * `projectDir` 缺席且路径本身是相对的时候**不猜**：原样保留相对形态，靠后缀匹配照样能判定 ——
 * 猜错的绝对路径比一个诚实的相对路径更危险。
 */
export function normaliseTarget(target, projectDir) {
  const value = String(target).replace(/\\/g, '/');
  if (value.startsWith('/')) return posix.normalize(value);
  if (typeof projectDir === 'string' && projectDir.length > 0) return posix.normalize(posix.join(projectDir.replace(/\\/g, '/'), value));
  return posix.normalize(value);
}

/**
 * 从绝对路径里拆出 `.kiro/specs/<feature>/<artifact>`。
 * 不在 `.kiro/specs/**` 之内、或压根没有 feature 目录（`.kiro/specs/tasks.md`）时返回 `null`。
 */
export function parseSpecTarget(target) {
  const match = /(?:^|\/)\.kiro\/specs\/(.+)$/.exec(target);
  if (!match) return null;
  const segments = match[1].split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const artifact = segments.at(-1);
  return { feature: segments.slice(0, -1).join('/'), artifact, dir: target.slice(0, target.length - (artifact.length + 1)) };
}

/**
 * 判定一次写操作。
 *
 * @param {object} input
 * @param {string} input.eventName         hook 事件名（默认 `PreToolUse`）
 * @param {string} input.toolName          `payload.tool_name`
 * @param {object} input.toolInput         `payload.tool_input`
 * @param {string} [input.projectDir]      容器里的项目根（`payload.cwd` / `CLAUDE_PROJECT_DIR`）
 * @param {(absolutePath: string) => boolean} input.exists  注入的存在性判定（容器文件系统）
 * @returns {{decision: 'allow'|'deny', reason: string, target?: string, feature?: string, artifact?: string}}
 */
export function decideStageGate({ eventName = 'PreToolUse', toolName, toolInput, projectDir, exists }) {
  if (typeof exists !== 'function') throw new TypeError('decideStageGate requires an exists() predicate');
  if (!GATED_TOOLS.includes(toolName)) {
    return { decision: 'allow', reason: `工具 ${toolName ?? '(缺失)'} 不在阶段门控范围内` };
  }

  const raw = targetPathOf(toolInput);
  if (raw === undefined) {
    // 取不到路径就放行：门控宁可漏一次，也不要因为一个没见过的 payload 形状把正常写入全堵死。
    return { decision: 'allow', reason: `${toolName} 的 payload 里没有可判定的目标路径` };
  }

  const target = normaliseTarget(raw, projectDir);
  const parsed = parseSpecTarget(target);
  if (!parsed) {
    // 实测约束里的「写 `.kiro/specs/**` 之外 → 放行不打扰」就是这一支。
    return { decision: 'allow', reason: '目标不在 .kiro/specs/** 之内', target };
  }

  const required = STAGE_PREDECESSORS[parsed.artifact];
  if (required === undefined) {
    return { decision: 'allow', reason: `${parsed.artifact} 不是受阶段门控的 artifact`, target, ...parsed };
  }
  if (required.length === 0) {
    return { decision: 'allow', reason: `${parsed.artifact} 是所在工作流的第一阶段`, target, ...parsed };
  }

  const present = required.filter((name) => exists(posix.join(parsed.dir, name)));
  if (present.length > 0) {
    return { decision: 'allow', reason: `前一阶段已存在：${present.join(' / ')}`, target, ...parsed };
  }

  const missing = required.join(' 或 ');
  return {
    decision: 'deny',
    target,
    ...parsed,
    reason:
      `越阶段写：${parsed.artifact} 依赖 ${missing}，但 ${parsed.dir} 下都不存在。` +
      `阶段顺序是「前一阶段的 artifact 先落地，下一阶段才开始写」。` +
      `如果你认为这个判断错了，改 hooks/hooks.json —— 这是一条 collaborative 约定，不是硬护栏。`,
  };
}

/** 拒绝时交给宿主的响应体。字段名照第 5 期探针实测过的官方形状（`hookSpecificOutput`）。 */
export function denialResponse({ eventName = 'PreToolUse', reason }) {
  return { hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'deny', permissionDecisionReason: reason } };
}
