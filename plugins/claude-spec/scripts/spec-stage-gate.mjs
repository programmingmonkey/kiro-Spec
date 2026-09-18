#!/usr/bin/env node
// claude-spec —— `PreToolUse` 阶段门控的 CLI 入口。hooks.json 调它，payload 从 stdin 进。
//
// 职责分得很清：判定在 `lib/hooks/stage-gate.mjs`（纯函数、有单测），这里只负责
// 「读 payload → 注入真实文件系统 → 把判定翻译成宿主的响应与退出码」。
// **观测在 `lib/hooks/observability.mjs`**（同样纯逻辑 + 注入 IO）。
//
// 🔴 失败一律 **fail-open + loud**，不 fail-closed。
// 理由不是「图省事」，而是门控的实际能力摆在那里：它是一条**协作约定**，
// 模型能改它自己的 hook 脚本（第 5 期 `privateStateIntegrity: FAIL`）。所以它挡不住
// 存心绕过的人；它唯一能做的，是拦住「没意识到自己越阶段了」的正常流程。
// 把这样的东西做成 fail-closed，只会让一个缺 node、一个畸形 payload、一次容器 IO 抖动
// 变成「用户什么都写不了，且原因只有 stderr 一行」，那比漏放一次坏得多。
// **但报错必须响**：静默放行是这套逻辑里唯一真正不可接受的形态。
//
// ── 观测（`.kiro/specs/claude-spec-gate-liveness`）────────────────────────
//
// **① entry 行**：进程一启动就写，**先于任何解析**。它证明的只有一件事 ——
// 这个进程被宿主拉起过。有了它，「宿主没调用」才从不可证伪变成可证伪。
//
// **② 判定行**：走完判定后写，带 `decision` / `reason` / `target`。
// 只记 deny 的话，「宿主没调用」与「调用了但走了放行分支」在日志上长得一模一样。
//
// **③ 心跳**：一次调用覆盖写一次，由 `spec_health` 读出去。于是「门还活着吗」
// 可以在**活着的层**（MCP 工具面）上看到，而不是只能靠人记得跑探针。
//
// 默认落点优先**项目目录**（容器挂着本机仓库，落那儿 Mac 侧也读得到），
// 退回 `tmpdir`；每行自带 `logPath` / `logSource`，读的人不必猜它在哪。
// 关掉审计日志：`CLAUDE_SPEC_GATE_LOG=off`（心跳不受这个开关影响 ——
// 它是存活信号，不该能被顺手关掉）。换地方：设成目标路径。

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import {
  appendAuditLine,
  projectDirFrom,
  resolveHeartbeatPath,
  resolveLogPath,
  writeHeartbeat,
} from '../lib/hooks/observability.mjs';
import { decideStageGate, denialResponse, exitCodeFor } from '../lib/hooks/stage-gate.mjs';

const io = { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync };

// 环境级项目根：payload 还没解析，这是此刻唯一能拿到的项目线索。
const ENV_PROJECT_DIR = projectDirFrom({ env: process.env });
const ENV_HEARTBEAT_PATH = resolveHeartbeatPath({ projectDir: ENV_PROJECT_DIR });

const { path: LOG_PATH, source: LOG_SOURCE } = resolveLogPath(process.env.CLAUDE_SPEC_GATE_LOG, {
  projectDir: ENV_PROJECT_DIR,
});

function audit(fields) {
  appendAuditLine({ path: LOG_PATH, source: LOG_SOURCE, ...fields }, io);
}

function beat(fields, heartbeatPath) {
  writeHeartbeat({ path: heartbeatPath, ...fields }, io);
}

// 🔴 ① entry 行：**先于 stdin**。宿主拉起了这个进程 —— 这是它唯一的主张，
// 也是全流程里唯一不依赖任何解析成功的证据。
audit({ phase: 'entry', pid: process.pid, cwd: process.cwd() });
if (ENV_HEARTBEAT_PATH) beat({ phase: 'entry', pid: process.pid }, ENV_HEARTBEAT_PATH);

/** 读空 stdin、坏 JSON、任何异常都走这一支。 */
function allowLoudly(problem, stderr, heartbeatPath) {
  stderr.write(
    `claude-spec stage gate: ${problem}\n` +
      '门控放行（fail-open）：它是一条协作约定，不是硬护栏；为一个坏掉的环境把正常写入全部堵死\n' +
      '只会制造更难查的故障。这次没有拦，但请把上面这行当成真问题去修。\n',
  );
  audit({ phase: 'decision', event: 'error', decision: 'allow', problem });
  if (heartbeatPath) beat({ phase: 'decision', decision: 'allow', event: 'error', reason: problem }, heartbeatPath);
  process.exit(0);
}

let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { payload += chunk; });
process.stdin.on('end', () => {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (caught) {
    allowLoudly(`payload 不是合法 JSON（${caught.message}），长度 ${payload.length}`, process.stderr, ENV_HEARTBEAT_PATH);
    return;
  }

  const eventName = typeof parsed.hook_event_name === 'string' && parsed.hook_event_name ? parsed.hook_event_name : 'PreToolUse';
  const projectDir = projectDirFrom({ cwd: parsed.cwd, env: process.env });

  // payload 的项目根优先于环境根 —— 与判定逻辑同源（它也要用这个目录去 existsSync）。
  // 环境根那一路的 entry 心跳在模块顶部已经写过；这里只管 payload 这一路。
  const heartbeatPath = resolveHeartbeatPath({ projectDir });

  let decision;
  try {
    decision = decideStageGate({
      eventName,
      toolName: parsed.tool_name,
      toolInput: parsed.tool_input,
      projectDir,
      // 实测约束 ②：hook 跑在会话容器里，这里读到的就是**容器**的文件系统。
      exists: (absolutePath) => existsSync(absolutePath),
    });
  } catch (caught) {
    allowLoudly(`判定过程抛错：${caught.stack ?? caught.message}`, process.stderr, heartbeatPath);
    return;
  }

  const common = {
    phase: 'decision',
    event: eventName,
    tool: parsed.tool_name ?? null,
    agentType: parsed.agent_type ?? null,
    hasAgentId: typeof parsed.agent_id === 'string' && parsed.agent_id.length > 0,
    target: decision.target ?? null,
    decision: decision.decision,
    reason: decision.reason,
  };

  if (decision.decision !== 'deny') {
    audit(common);
    beat(common, heartbeatPath);
    process.exit(0);
  }

  // 拒绝：两个通道都发。
  //   · stdout 的 `hookSpecificOutput.permissionDecision` —— 第 5 期探针实测这个 JSON 通道
  //     在 Cowork 上确实被解析（`updatedInput` 生效）。但它实测的是 `allow` 那一支，
  //     `deny` 这一支**没有被真机验证过**（那是 Task 4「验」那半边的事）。
  //   · `exit 2` + stderr —— 阻塞语义不依赖宿主是否解析 JSON。
  // 只发 JSON 的话，万一 `permissionDecision` 没被实现，门控就静默失效 —— 而那正是
  // STOP 门 ② 要抓的失效形态。两害相权，多发一条、由 Task 7 的真机记录去判定哪个通道生效。
  audit({ ...common, channels: ['hookSpecificOutput.permissionDecision', 'exit 2'] });
  beat(common, heartbeatPath);
  process.stdout.write(`${JSON.stringify(denialResponse({ eventName, reason: decision.reason }))}\n`);
  process.stderr.write(`claude-spec stage gate: ${decision.reason}\n`);

  const code = exitCodeFor(eventName, decision.decision);
  if (code === 0) {
    // 探针记录的坑：`Stop` / `SubagentStop` 的非零退出带 continuation 语义。
    // 本门控只挂 `PreToolUse`，这一支理论上到不了 —— 但它到得了的那天，
    // 就是有人把事件名加进 hooks.json 却没人想起这条约束的那天，所以留在代码里。
    process.stderr.write(`claude-spec stage gate: 事件 ${eventName} 带 continuation 语义，按约束不返回非零退出码。\n`);
  }
  process.exit(code);
});

// stdin 已经因为管道关闭而 end；这里是兜底，避免宿主没关 stdin 时门控永远不返回。
setTimeout(() => allowLoudly('等待 stdin 超时（10s）', process.stderr, ENV_HEARTBEAT_PATH), 10_000).unref();
