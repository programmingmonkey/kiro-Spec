#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import path from 'node:path';

import { normaliseTopology as normaliseTopologyValue } from './lib/hooks/observability.mjs';
import { createMcpService } from './lib/mcp/service.mjs';
import { toolNames, tools, validateToolArguments } from './lib/mcp/tools.mjs';

const serverInfo = { name: 'claude-spec', version: '1.0.0' };
const services = new Map();

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function protocolError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
// 项目根的解析顺序。为什么 `CLAUDE_PROJECT_DIR` 排在 `process.cwd()` 前面：
// Cowork 侧 `.mcp.json` 的 `cwd: "."` 到底解析成**插件根**还是**项目根**，是第 6 期
// Task 2 Step 6 明确留白的 ⟨待测⟩ 槽位（不许按 Codex 侧的行为推断）。若它解析成插件根，
// `process.cwd()` 指的就是插件的安装目录 —— 拿它当项目根会让每一次工具调用都静默地
// 对着错误的目录干活，而错误只在结果里以「找不到 spec」的形式间接浮现。
// `CLAUDE_PROJECT_DIR` 是探针实测存在的变量（`spikes/cowork-hook-probe`，hook 侧确认），
// 排在 cwd 前面可以把这个坑挡掉；两者都不存在时退回 cwd，行为与 fork 前一致。
const PROJECT_ROOT_ENV = ['CLAUDE_SPEC_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR'];

// 运行拓扑：hook 与 MCP 是否同机同文件系统。不做自动探测（README/observability.mjs 的
// TOPOLOGY 注释说过为什么），显式声明，默认 `local` —— 本地 Claude Code CLI 现在才是
// 日常路径，Cowork 要显式切换过去。非法值直接让进程快速失败退出，不悄悄拿 local 顶上：
// 拓扑判错了会让 spec_health 的 unobserved caveat 指错排查方向，比不判定更危险。
// 「省略/空串算未指定、其余非法值一律拒绝」这条判断不在这里重复实现，统一调
// observability.mjs 的 `normaliseTopology`（同一份判断曾经在这里、service.mjs、
// summariseGate 里各写一遍，三份副本对「什么算未指定」逐渐长出分歧）。
const TOPOLOGY_ENV = 'CLAUDE_SPEC_TOPOLOGY';

function resolveTopology() {
  return normaliseTopologyValue(process.env[TOPOLOGY_ENV], { label: TOPOLOGY_ENV });
}

/** 命中的环境变量与值；都没命中时为 null（此时回落到 `process.cwd()`）。 */
function configuredProjectRoot() {
  for (const name of PROJECT_ROOT_ENV) {
    const value = process.env[name];
    if (value) return { source: name, value };
  }
  return null;
}

function resolveProjectRoot(argumentsValue) {
  const explicit = argumentsValue?.projectRoot;
  if (explicit !== undefined && (typeof explicit !== 'string' || !path.isAbsolute(explicit))) {
    throw new Error('projectRoot must be an absolute path');
  }
  if (explicit !== undefined) return explicit;
  for (const name of PROJECT_ROOT_ENV) {
    const value = process.env[name];
    if (value) return value;
  }
  return process.cwd();
}
async function getService(argumentsValue) {
  const projectRoot = await realpath(resolveProjectRoot(argumentsValue));
  if (services.has(projectRoot)) return services.get(projectRoot);
  const service = await createMcpService({ projectRoot, topology });
  services.set(projectRoot, service);
  return service;
}
function toolResult(value) {
  const isError = Boolean(value?.code);
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

async function dispatch(request) {
  const { id = null, method, params = {} } = request;
  if (method === 'initialize') return response(id, { protocolVersion: params.protocolVersion, serverInfo, capabilities: { tools: {} } });
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return response(id, { tools });
  if (method === 'tools/call') {
    if (!toolNames.includes(params.name)) return protocolError(id, -32602, `Unknown tool: ${params.name}`);
    let validationArguments;
    try { validationArguments = { projectRoot: resolveProjectRoot(params.arguments), ...(params.arguments ?? {}) }; }
    catch (caught) { return protocolError(id, -32602, caught.message); }
    const invalid = validateToolArguments(params.name, validationArguments);
    if (invalid) return protocolError(id, -32602, invalid);
    const { projectRoot: _projectRoot, ...toolArguments } = params.arguments ?? {};
    if (toolArguments.expectedRawRevision === null) toolArguments.expectedRawRevision = undefined;
    try {
      return response(id, toolResult(await (await getService(params.arguments)).call(params.name, toolArguments)));
    } catch (caught) {
      return response(id, toolResult({ code: caught.code ?? 'INVALID_FORMAT', message: caught.message, details: caught.details ?? {}, nextAction: '修正项目配置后重试' }));
    }
  }
  return protocolError(id, -32601, `Method not available: ${method}`);
}

let topology;
try {
  topology = resolveTopology();
} catch (caught) {
  // `process.stderr.write` 后面紧跟 `process.exit` 在 POSIX 上不安全：管道上的写入是
  // 异步的（Node 自己的文档写明这一点），`exit` 可能在写完成前就把进程收了，诊断信息
  // 因此可能被截断或丢掉——恰好违背这里「大声失败、绝不悄悄兜底」的目的。改用
  // `fs.writeSync` 直接对 fd 2 发起同步系统调用，不经过 stream 的异步缓冲，保证这行
  // 一定在进程退出前落到调用方能看见的地方。
  writeSync(2, `${JSON.stringify({ event: 'claude-spec.mcp.fatal', message: caught.message })}\n`);
  process.exit(1);
}

const configured = configuredProjectRoot();
process.stderr.write(`${JSON.stringify({ event: 'claude-spec.mcp.started', version: serverInfo.version, cwd: process.cwd(), configuredProjectRoot: configured?.value ?? null, configuredProjectRootSource: configured?.source ?? 'process.cwd()', fileGuardrail: false, trustTier: 'collaborative', hooks: './hooks/hooks.json', tools: tools.length, topology })}\n`);

let pending = '';
let sequence = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    sequence = sequence.then(async () => {
      let request;
      try { request = JSON.parse(line); const reply = await dispatch(request); if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`); }
      catch (caught) { process.stdout.write(`${JSON.stringify(protocolError(request?.id ?? null, -32603, caught.message))}\n`); }
    });
  }
});
