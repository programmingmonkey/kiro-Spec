// claude-spec —— 阶段门控的**观测器**。
//
// 2026-09-14 立项（`.kiro/specs/claude-spec-gate-liveness`）。
//
// 由来：门控停摆时，「宿主到底调没调这个 hook」**没有任何可读证据**。
// 手工喂 payload 证明的是「脚本被调用时会 deny」，答不了「有没有被调用」——
// 而当时能回答这件事的那份审计日志是 opt-in，要打开就得改宿主启动 hook 时的环境变量，
// 那个位置在 Cowork 里没有任何一方够得到。排查因此彻底卡死。
//
// 这里只做两件事，都是**纯逻辑 + 注入 IO**。`lib/hooks/stage-gate.mjs` 的判定一行不碰：
//   ① 审计行：entry 行（解析 stdin 之前）+ 判定行（解析之后）。追加写，回答「调没调」。
//   ② 心跳：一次调用覆盖写一次。回答「**最近一次**是什么时候」，由 `spec_health` 读出去 ——
//      于是存活信号搭在**活着的那层**（MCP 工具面）上：hook 停摆时它照常工作，
//      它是唯一还有机会报告 hook 死活的地方。
//
// 🔴 贯穿全文的一条：**观测器的任何失败都不得改变判定结果与退出码。**
// 下面每个 IO 函数都吞异常并返回布尔，调用方不许据此改变被观测者。

import os from 'node:os';
import path from 'node:path';

/** 有人看得见才有意义：超上限**停写**而不是轮转 —— 回答「调没调」靠的是最早那几行。 */
export const AUDIT_MAX_BYTES = 1024 * 1024;
export const OBSERVABILITY_DIR = '.claude';
/** ⚠️ 文件名**沿用旧默认**（`os.tmpdir()/claude-spec-gate.log`）：它已经写进 INSTALL.md，
 *  换个名字等于让所有按文档去找的人扑空 —— 而这次变更的理由正是「别再让人扑空」。 */
export const LOG_FILE_NAME = 'claude-spec-gate.log';
export const HEARTBEAT_FILE_NAME = 'claude-spec-gate.heartbeat';

/**
 * `spec_health` 的 `gate.status`。它描述**这条读通不通**，不描述门活不活。
 *
 * 拆出三态的直接原因（2026-09-14，`0bc9c0d` 复核）：hook 的项目根是**会话容器**路径、
 * `spec_health` 拿到的是调用方给的**本机**路径，两者未必是同一个文件系统。
 * 于是「没读到」在中性上只是「我没看见」，不是「它没发生」——
 * 而把它写成 `lastSeen: null`，读者会读成「门死了」，那是**假的死亡信号**。
 */
export const GATE_STATUS = Object.freeze({
  /** 读到了合法心跳 —— **唯一的活证据**。 */
  OBSERVED: 'observed',
  /** 路径解析得出，但那里没有合法心跳。**中性**：可能没被调用，也可能两条路径不是同一个文件系统。 */
  UNOBSERVED: 'unobserved',
  /** 连心跳路径都解析不出来（没有 `projectRoot`）。 */
  UNAVAILABLE: 'unavailable',
});

/**
 * 运行拓扑：hook 与 MCP 是不是同一台机器、同一个文件系统。
 *
 * 2026-09-14 才第一次确认「本地 Claude Code CLI 也是一条正常路径，不是 Cowork 的退化版」——
 * 在这之前，`summariseGate` 只按 Cowork 拓扑（hook 在会话容器、MCP 在用户本机，两者未必
 * 共享文件系统）的心智给 `unobserved` 配了一句 caveat，本地模式下这条心智**不成立**：
 * hook 与 MCP 同机同文件系统，读不到心跳更可能真的是没被调用，而不是「看不见对方」。
 * 两种拓扑对同一个 `unobserved` 状态的排查建议因此不同，需要显式区分——不做自动探测：
 * 拓扑判定错了比不判定更危险，这里遵的是 §4.3.2「没有自己的标识就停下问用户」的同一条原则。
 * 默认 `local`：现在本地 Claude Code CLI 才是日常路径，Cowork 是要显式切换过去的那一个。
 */
export const TOPOLOGY = Object.freeze({
  LOCAL: 'local',
  COWORK: 'cowork',
});

export const TOPOLOGY_VALUES = Object.freeze(Object.values(TOPOLOGY));

/**
 * 拓扑输入归一化：省略 / `null` / `''` 都算「没给信号」，退回 `TOPOLOGY.LOCAL`；
 * 除此之外的值必须命中 `TOPOLOGY`，否则抛错——「没给信号」和「给了错的信号」不是
 * 一回事，前者退默认，后者要停下来问，不能替调用方猜一个（同一条原则见上面
 * `TOPOLOGY` 的注释）。
 *
 * 这条判断曾经在 `summariseGate`（本文件）、`service.mjs` 的 `createMcpService`、
 * `mcp-server.mjs` 的环境变量解析里各自实现一遍，`''`/`null` 算不算「没给信号」在
 * 三份副本里逐渐长出了分歧——收在这一处，三边都改成调用它。
 */
export function normaliseTopology(value, { label } = {}) {
  if (value === undefined || value === null || value === '') return TOPOLOGY.LOCAL;
  if (!TOPOLOGY_VALUES.includes(value)) {
    throw new Error(`${label ? `${label}: ` : ''}topology must be one of ${TOPOLOGY_VALUES.join('/')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** 只在 `unobserved` 出现 —— 让那条中性读法不能被绕过（只写在文档里就等于没写）。 */
export const UNOBSERVED_CAVEAT_LOCAL =
  '本地模式下 hook 与 MCP 同一台机器、同一个文件系统，不存在「路径不通」的疑点，' +
  '所以这里读不到心跳更可能只是这次会话还没有一次 PreToolUse 命中过，而不是两边看不见彼此。' +
  '仍按中性处理，不升级成「门死了」——但排查方向和 Cowork 不同：直接检查 hooks.json 是否被这次安装' +
  '认领、有没有对 .kiro/specs/ 下的文件做过一次写操作，不必像 Cowork 拓扑那样去读 INSTALL.md 的容器审计日志探针。';

/** 只在 `unobserved` 出现，`topology: 'cowork'` 时使用。 */
export const UNOBSERVED_CAVEAT_COWORK =
  '本机读不到这台 hook 的心跳，不构成「门没被调用」的判据：hook 跑在会话容器、MCP 跑在用户本机，' +
  '两者的项目根是同一目录的两条路径，未必共享文件系统。Cowork 下的死活判据请用 INSTALL.md 的阶段门控存活探针。';

function isNonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 项目根：payload 的 `cwd` 优先，退回环境变量。
 * 这是 hook 里唯一可靠的「项目在哪」来源 —— `process.cwd()` 是宿主决定的，不可预测。
 * 取不到就返回 `undefined`，**不猜**（猜错的绝对路径比一个诚实的缺席更危险）。
 */
export function projectDirFrom({ cwd, env = {} } = {}) {
  for (const candidate of [cwd, env.CLAUDE_PROJECT_DIR, env.CLAUDE_SPEC_PROJECT_ROOT]) {
    if (isNonEmpty(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 审计日志落点。
 *
 * @param {string|undefined} configured `CLAUDE_SPEC_GATE_LOG`
 * @returns {{ path: string|undefined, source: 'disabled'|'explicit'|'relative'|'project'|'tmpdir' }}
 *
 * ⚠️ 相对路径**继续**解析到 `tmpdir`，而不是项目目录：2026-09-14 有一次
 * `CLAUDE_SPEC_GATE_LOG=off` 喂给了还不认这个哨兵值的旧脚本，相对路径就地生根，
 * 在插件源码目录留了一个名叫 `off` 的日志文件，还一度被当成排查用的现场痕迹。
 * 这条教训不能因为「落点改成项目目录」被顺手改掉。
 */
export function resolveLogPath(configured, { projectDir, tmpdir = os.tmpdir() } = {}) {
  if (configured === '' || configured === 'off') return { path: undefined, source: 'disabled' };
  if (isNonEmpty(configured)) {
    return path.isAbsolute(configured)
      ? { path: configured, source: 'explicit' }
      : { path: path.join(tmpdir, configured), source: 'relative' };
  }
  if (isNonEmpty(projectDir)) {
    return { path: path.join(projectDir, OBSERVABILITY_DIR, LOG_FILE_NAME), source: 'project' };
  }
  return { path: path.join(tmpdir, LOG_FILE_NAME), source: 'tmpdir' };
}

/** 心跳落点。项目根缺席时返回 `undefined` —— 心跳的意义就是「被 `spec_health` 读到」。 */
export function resolveHeartbeatPath({ projectDir } = {}) {
  if (!isNonEmpty(projectDir)) return undefined;
  return path.join(projectDir, OBSERVABILITY_DIR, HEARTBEAT_FILE_NAME);
}

/**
 * 追加一行审计。
 *
 * 每行都带 `logSource` / `logPath`：排查时最先要回答的不是「有没有行」，
 * 而是「我看的这个文件是不是它写的那个」—— hook 跑在会话容器里，
 * 容器的 `/tmp` 和项目目录是两个地方。
 *
 * @returns {boolean} 是否写成功（调用方不应据此改变判定）
 */
export function appendAuditLine({ path: target, source, ...fields }, io) {
  if (!isNonEmpty(target)) return false;
  try {
    const size = io.existsSync(target) ? io.statSync(target).size : 0;
    if (size > AUDIT_MAX_BYTES) return false;
    io.mkdirSync(path.dirname(target), { recursive: true });
    io.appendFileSync(target, `${JSON.stringify({ ts: new Date().toISOString(), ...fields, logSource: source, logPath: target })}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 覆盖写心跳。覆盖而非追加：它回答「最近一次」，不是「一共响过几次」——
 * 历史上限交给审计日志。
 *
 * @returns {boolean} 是否写成功
 */
export function writeHeartbeat({ path: target, ...fields }, io) {
  if (!isNonEmpty(target)) return false;
  try {
    io.mkdirSync(path.dirname(target), { recursive: true });
    io.writeFileSync(target, `${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
    return true;
  } catch {
    return false;
  }
}

/** @returns {object|null} 不存在、读不动、不是合法 JSON、不是对象 —— 一律 `null`，不抛。 */
export function readHeartbeat(target, io) {
  if (!isNonEmpty(target)) return null;
  try {
    if (!io.existsSync(target)) return null;
    const parsed = JSON.parse(io.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 心跳 → `spec_health` 的 `gate` 字段。
 *
 * 🔴 **本函数不回答「门活不活」，只回答「这条读通不通」**（`status`）。由来见 `GATE_STATUS`。
 * 判据强度是：只有 `observed` 是活证据；`unobserved` 是**中性**的（带着 `caveat`），
 * `unavailable` 表示连路径都没有。**任何非 `observed` 都不许被读成「门没被调用」。**
 *
 * 仍然**不**引入 `alive: true/false` 与任何阈值：门控的调用频率由用户的写作节奏决定，
 * 「N 分钟没心跳就算死」在正常使用中必然误报。交给读的人看 `ageMs`。
 *
 * `topology` 不做自动探测，交给 `normaliseTopology` 统一归一：省略/`null`/`''` 都退回
 * `TOPOLOGY.LOCAL`（见该函数与 `TOPOLOGY` 常量的注释），其余非法值直接抛错——拓扑判错了
 * 比不判更危险，不能替调用方猜一个。它只影响 `unobserved` 态挑哪句 caveat，三态里都会把
 * 归一后的值原样带回去，方便读结果的人确认「这次判定是按哪种拓扑做的」。
 */
export function summariseGate({ heartbeat, path: heartbeatPath, now = Date.now(), topology } = {}) {
  const resolvedTopology = normaliseTopology(topology, { label: 'summariseGate' });
  const base = {
    status: isNonEmpty(heartbeatPath) ? GATE_STATUS.UNOBSERVED : GATE_STATUS.UNAVAILABLE,
    heartbeatPath: heartbeatPath ?? null,
    topology: resolvedTopology,
    lastSeen: null,
    ageMs: null,
    decision: null,
    event: null,
    reason: null,
  };
  if (!heartbeat || typeof heartbeat !== 'object') return withCaveat(base);
  const seen = Date.parse(heartbeat.ts);
  // `ts` 都解析不出来的文件，同样答不了「最近一次是什么时候」—— 与「不存在」同构。
  // 给它一个更细的状态只会让人以为那点差别有意义。
  if (Number.isNaN(seen)) return withCaveat(base);
  return {
    ...base,
    status: GATE_STATUS.OBSERVED,
    lastSeen: new Date(seen).toISOString(),
    ageMs: Math.max(0, now - seen),
    decision: heartbeat.decision ?? null,
    event: heartbeat.event ?? null,
    reason: heartbeat.reason ?? null,
  };
}

/** `caveat` 与 `unobserved` 同生共死。`unavailable` 不需要它：没有路径本就说明不了任何事。 */
function withCaveat(summary) {
  if (summary.status !== GATE_STATUS.UNOBSERVED) return summary;
  const caveat = summary.topology === TOPOLOGY.COWORK ? UNOBSERVED_CAVEAT_COWORK : UNOBSERVED_CAVEAT_LOCAL;
  return { ...summary, caveat };
}
