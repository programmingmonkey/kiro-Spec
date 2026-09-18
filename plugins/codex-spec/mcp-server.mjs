#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { createMcpService } from './lib/mcp/service.mjs';
import { toolNames, tools, validateToolArguments } from './lib/mcp/tools.mjs';

const serverInfo = { name: 'codex-spec', version: '1.0.0' };
const services = new Map();

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function protocolError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function resolveProjectRoot(argumentsValue) {
  const explicit = argumentsValue?.projectRoot;
  if (explicit !== undefined && (typeof explicit !== 'string' || !path.isAbsolute(explicit))) {
    throw new Error('projectRoot must be an absolute path');
  }
  return explicit ?? process.env.KIRO_SPEC_PROJECT_ROOT ?? process.cwd();
}
async function getService(argumentsValue) {
  const projectRoot = await realpath(resolveProjectRoot(argumentsValue));
  if (services.has(projectRoot)) return services.get(projectRoot);
  const service = await createMcpService({ projectRoot });
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

process.stderr.write(`${JSON.stringify({ event: 'codex-spec.mcp.started', version: serverInfo.version, cwd: process.cwd(), configuredProjectRoot: process.env.KIRO_SPEC_PROJECT_ROOT ?? null, fileGuardrail: false, tools: tools.length })}\n`);

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
