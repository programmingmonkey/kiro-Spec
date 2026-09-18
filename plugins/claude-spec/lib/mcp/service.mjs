import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { insertSignatureInto, parseSignatures, renderSignature } from '@my-harness/spec-analysis/signature';
import { createSpecState } from '@my-harness/spec-state';
import { createNodeFsPort } from '@my-harness/spec-state/ports';

import {
  normaliseTopology as normaliseTopologyValue,
  readHeartbeat,
  resolveHeartbeatPath,
  summariseGate,
} from '../hooks/observability.mjs';
import { loadAdapter } from './adapter.mjs';

/** 心跳读取只需要这两个同步操作；用它而不是异步的 `fsp` 端口 —— 心跳是几十字节的覆盖写。 */
const heartbeatIo = { existsSync, readFileSync };

// 第 7 期 Task 4 —— claude-spec 的 MCP 服务入口，现在是**薄适配层 + 两处宿主插槽**。
//
// 状态编排全部住在 `@my-harness/spec-state`；本文件只保留**这个宿主独有的两件事**：
//   ① `spec_health` 的 `authority` 台账（claude 的 adapter 才有 authority 概念）；
//   ② `spec_write` 的 §4.3.2 署名合并（消费项目对该仓库的硬要求，codex-spec 没有）。
// 两者都通过注入的 hook 实现，所以共享层里没有一行「if (宿主 === claude)」。
//
// 🔴 署名**只能**走 `beforeWrite` hook：它是本宿主唯一「在原子写之前改写内容」的入口，
// 也是唯一能让插件按 §4.3.2 校验环境标识（写死 `Claude`）的位置。
// ⚠️ 2026-09-17：这里原写作「与环境标识、通道字面量（`Cowork`）」。那条字面量要求已被
// 消费项目撤销（理由：被插件强制注入 ⇒ 不再追踪现实，只制造假台账），见
// `packages/spec-analysis/lib/signature.js` 文件头「第 9 期改动」。
//
// ⚠️ 旧版给的理由是「批准之后再单独补一行署名会改掉 `approvalFingerprint`，下一次
// `observe()` 判为 `external_change_detected` 并作废该 artifact 的审批」——**这句话现在
// 不成立**。第 8 期 `spec-sign-approval-clobber` 把 `computeApprovalFingerprint` 升到
// `semantic-v2` 后，`tasks.md` 上的**合法**署名行与合法执行事件块一样被剥掉，不再是语义。
// 仍然成立的是更窄的两条：① 手工追加的一行是否算「合法署名」由解析器判，写歪了仍是一次
// 实质改动、仍会作废该 artifact 的审批；② 豁免只覆盖 `tasks.md`，`requirements` / `design`
// 内的人工署名仍会改变指纹。所以把署名并进同一次写入依然更好 —— 少一类事后操作，
// 且合法性由插件担保，不靠调用方手写不出错。

const fs = createNodeFsPort(fsp);

/** 与共享层同一个形状的 error（hook 的拒绝必须和包内错误长得一模一样）。 */
function error(code, message, details = {}, nextAction = '重新读取状态后重试') { return { code, message, details, nextAction }; }

// 本插件的环境标识。写死成 'Claude' 而不是做成参数：消费项目 §4.3.2 的红字是
// 「**没有属于自己的标识时，不要借用别人的** —— 停下问用户要一个」，让调用方自选 env
// 正是「借用别人的标识」那条路。四个标识里只有 Claude 属于本宿主。
//
// 🔴 `topology`（下面）不动署名这条判据 —— 判据的事实源是消费项目 `.githooks/pre-commit`
// 认 `env` 字段的外部规则，与本插件实际跑在哪种拓扑无关：本地模式下产出的合法签名，
// 照样要在真正过消费项目 pre-commit 时被认出来。
// 见 `docs/`（2026-09-14 会话）对这两件事的澄清：拓扑分的是「hook 与 MCP 是否同机」，
// 不是「Claude 这个标识解锁了几条通道」。
// ⚠️ 2026-09-17：那段澄清当时是拿「Claude 必须含 `Cowork`」当例子的；那条要求已撤销
// （消费项目退役 Cowork 通道 + 删掉那句字面量判据）。**洞见本身仍然成立**：
// 拓扑与「这条环境标识合不合规」是两件事，所以下面这段注释保留、只换掉那个例子。
const SIGNATURE_ENV = 'Claude';

// 运行拓扑：hook 与 MCP 是否同机同文件系统，决定 `unobserved` 该指去哪条排查路径。
// 不做自动探测（见 observability.mjs 的 TOPOLOGY 注释），默认 `local`——本地 Claude Code
// CLI 现在才是日常路径，Cowork 需要显式切换过去。「省略/`null`/`''` 都算未指定、其余
// 非法值一律拒绝」这条归一逻辑本身不在这里重复实现，统一调 observability.mjs 的
// `normaliseTopology`（同一份判断曾经在这里、`summariseGate`、mcp-server.mjs 里各写一遍，
// 三份副本对「什么算未指定」逐渐长出分歧）。
function normaliseTopology(topology) {
  // 抛真 Error（带 .code）而不是复用 `error()`：那个 helper 产出的是**返回值**形状，
  // 给 hook 正常回传用；这里是构造期校验。
  //
  // 这条抛错分支在**真正跑起来的 stdio 服务器**里摸不到：`mcp-server.mjs` 在进程启动时
  // 就已经用同一个 `normaliseTopology` 校验过环境变量，传进 `createMcpService` 的
  // `topology` 永远是已经验证过的合法值。会真正触发这里的，只有绕过 `mcp-server.mjs`、
  // 直接调 `createMcpService` 的调用方——目前只有测试（`test/gate-liveness.test.mjs`）。
  try {
    return normaliseTopologyValue(topology, { label: 'createMcpService' });
  } catch (caught) {
    throw Object.assign(caught, { code: 'ADAPTER_INVALID' });
  }
}

/** 锁的存活探测：`ESRCH` 之外的错误（例如 `EPERM`）都当「还活着」，与原实现一致。 */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (probe) { return probe.code !== 'ESRCH'; }
}

async function authorityHealth(adapter, topology) {
  // `authority` 是**台账**不是闸门（authorized 模式下）：它回报 authorityFile 的
  // 「上次核对过的版本」与当前值的差异，但不参与放行判定。放这里是为了让漂移可见 ——
  // 看得见而不断供，比看不见、或者看见了就罢工都强。见 lib/mcp/adapter.mjs 的注释。
  //
  // `gate` 是同一种东西再往下一层（`.kiro/specs/claude-spec-gate-liveness`）：
  // 门控 hook 跑在**会话容器**、MCP 跑在**用户本机**，两条路径互相看不见 ——
  // 所以 `spec_health` 曾经在架构上不可能报告 hook 的死活。心跳把这条信号
  // **搭在活着的那层**上：hook 停摆时工具面照常工作，它就成了唯一能报告死活的地方。
  //
  // 心跳缺席/损坏一律 `lastSeen: null`，绝不因为读不到就把 `spec_health` 弄挂 ——
  // 观测器的失败不许影响被观测者，这是同一份设计里贯穿到底的一条。
  const heartbeatPath = resolveHeartbeatPath({ projectDir: adapter.projectRoot });
  return {
    authority: adapter.authority,
    gate: summariseGate({
      heartbeat: readHeartbeat(heartbeatPath, heartbeatIo),
      path: heartbeatPath,
      topology,
    }),
  };
}

/** 署名的身份是三元组（日期 · 环境 · 摘要），不是原始行 —— 与 `insertSignatureInto` 的幂等判据同源。 */
function signatureKey(signature) {
  return `${signature.date}\u0000${signature.env}\u0000${signature.summary}`;
}

/**
 * 把 `previousContent` 里有、而新正文里没有的署名逐条搬回来。
 *
 * 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 2 条）。
 * `spec_write` 的语义是**整份替换**，它只追加本次署名、不保留此前的。单看没问题；
 * 但 `spec_amend` 对 `tasks` 一律 `TASK_BODY_FROZEN`，于是 tasks.md 的**唯一**可编辑
 * 路径恰好会破坏署名台账。实测一次会话因此丢了 4 条署名，而**发现纯属偶然**。
 *
 * 台账是 git 结构上补不回来的那一维（谁改了什么，只此一处记录），所以这里的默认是
 * **保留**，而不是「调用方没带就当它想删」。调用方确实想删某一条时，路径是 amend 那条
 * 就地修改，不是靠在 spec_write 里少抄一行 —— 后者与「忘了抄」无法区分。
 *
 * 顺序：按旧文件里的出现顺序逐条插回，本次的新署名最后落 —— 台账保持时间序。
 */
function preserveSignatures({ artifact, text, previousContent }) {
  if (typeof previousContent !== 'string' || previousContent === '') return { text, preserved: [] };
  const present = new Set(parseSignatures(text).map(signatureKey));
  let merged = text;
  const preserved = [];
  for (const signature of parseSignatures(previousContent)) {
    if (present.has(signatureKey(signature))) continue;
    const placed = insertSignatureInto(merged, signature.raw, { createNotes: true });
    // 这一条是从盘上解析出来的，`insertSignatureInto` 认不出它只可能是两层解析口径不一致。
    // 那种情况下宁可当场拒绝：静默丢一条历史署名，正是本函数要消灭的那个故障。
    if (!placed.ok) return { code: 'SIGNATURE_INVALID', message: `cannot preserve an existing signature in ${artifact}: ${placed.code} (${signature.raw})` };
    merged = placed.text;
    present.add(signatureKey(signature));
    preserved.push(signature.raw);
  }
  return { text: merged, preserved };
}

async function signBeforeWrite({ artifact, content, params, previousContent, adapter }) {
  // ── §4.3.2 署名：必须与内容改动在**同一次**原子写里落盘 ──────────────────
  //
  // 插入逻辑复用 `@my-harness/spec-analysis` 的 `insertSignatureInto`，不在本包
  // 另写一份 —— 那就是 R6-2 说的「同源副本」。
  //
  // 顺序要紧：**先**把历史署名搬回来，**再**签本次的 —— 反过来的话本次署名会被挤到台账中间。
  const carried = preserveSignatures({ artifact, text: content, previousContent });
  if (carried.code) return error(carried.code, carried.message);
  let merged = carried.text;
  const preservedSignatures = carried.preserved;
  let signatureLine = null;
  let attributionWarning = null;
  if (params.signature !== undefined && params.signature !== null && String(params.signature).trim() !== '') {
    let line;
    try {
      // 时区由 adapter 的 `signatureTimeZone` 决定；未声明则 `undefined`，回落本机时区。
      // 见 lib/mcp/adapter.mjs 的 `normaliseSignatureTimeZone`（2026-09-18 缺陷报告第 3 条）。
      line = renderSignature({ env: SIGNATURE_ENV, summary: params.signature, timeZone: adapter?.signatureTimeZone ?? undefined });
    } catch (caught) {
      // 就近拒绝：签不达标比不签更糟（§4.3.2「署错比不署更糟」）。
      return error('SIGNATURE_INVALID', caught?.message ?? String(caught));
    }
    // `createNotes` 走的是 §4.3.2 的第二条路：tasks.md 还不存在时签在当前这份
    // 文件末尾，没有 `## Notes` 就新起一个。
    const placed = insertSignatureInto(merged, line, { createNotes: true });
    if (!placed.ok) return error('SIGNATURE_INVALID', `cannot place signature into ${artifact}: ${placed.code}`);
    merged = placed.text;
    signatureLine = line;
  } else {
    // 不阻断 —— 与消费项目自己的 `check_spec_signature` 同档（warn 级）。
    // 那边刻意不判 error 的理由是「什么算实质修改无法可靠自动判定，硬拦会误伤，
    // 而误伤会把人推向 SKIP_PRECOMMIT」。这里照抄那个判断，不自作主张更严。
    attributionWarning =
      `没有署名：本次写入 ${artifact} 未带 signature 参数。消费项目 §4.3.2 要求改 spec 正文时留下底座署名，` +
      `而它是该仓库对已解锁底座的唯一硬要求。补签要重新 spec_write（带 signature）—— 署名与内容在` +
      `同一次原子写里落盘，少一类事后操作，环境标识与通道字面量也由插件按 §4.3.2 校验。` +
      `手工追加一行不是等效做法：它是否算「合法署名」由解析器判，写歪了就仍是一次实质改动，` +
      `仍会作废该 artifact 的审批（豁免只覆盖 tasks.md 上的合法署名行）。`;
  }
  return { content: merged, extra: { signatureLine, attributionWarning, ...(preservedSignatures.length > 0 ? { preservedSignatures } : {}) } };
}

export async function createMcpService({ projectRoot, privateDir, adapterPath, now = () => Date.now(), fault = async () => {}, topology }) {
  const resolvedTopology = normaliseTopology(topology);
  return createSpecState({
    projectRoot,
    privateDir,
    adapterPath,
    privateDirName: '.kiro-spec-private',
    loadAdapter,
    fs,
    now,
    randomUUID,
    pid: () => process.pid,
    isAlive,
    fault,
    hooks: { health: (adapter) => authorityHealth(adapter, resolvedTopology), beforeWrite: signBeforeWrite }
  });
}
