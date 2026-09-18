import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';

function snapshot(label) {
  return { head: label, index: label, trackedDirty: [], untracked: [], untrackedPolicy: 'exclude', submodules: [], lfs: { policy: 'none', pointers: [] }, modes: [], eol: 'lf', platform: 'darwin' };
}

async function workspace({ withAdapter = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-stdio-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  const authority = '# rules\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), authority);
  if (withAdapter) await writeAdapter(root, authority);
  return root;
}

async function writeAdapter(root, authority = '# rules\n') {
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({ schemaVersion: 1, specsRoot: '.kiro/specs', writePolicy: { mode: 'evaluation-only', allowedPrefixes: ['_eval-codex-20260827/'], authorityFile: '.kiro/steering/spec.md', authorityHash: computeRawRevision(authority) }, rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }] }));
}

async function waitForReplies(replies, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (replies.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} MCP replies`);
}

test('stdio MCP 宣告 requirements-first 写作与串行执行工具，并返回结构化协作级结果', async () => {
  const cwd = await workspace();
  const server = spawn(process.execPath, [path.resolve(import.meta.dirname, '..', 'mcp-server.mjs')], { cwd });
  const replies = [];
  let resolveFirstReply;
  const firstReply = new Promise((resolve) => { resolveFirstReply = resolve; });
  let pending = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      replies.push(JSON.parse(line));
      if (replies.length === 1) resolveFirstReply();
    }
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  const timeout = setTimeout(() => resolveFirstReply(), 2_000);
  await firstReply;
  clearTimeout(timeout);
  server.kill();
  assert.equal(replies.length, 1, 'MCP server did not respond within 2 seconds');
  assert.equal(replies[0].id, 1);
  assert.deepEqual(replies[0].result.tools.map((tool) => tool.name), [
    'spec_health', 'spec_list', 'spec_template', 'spec_validate_artifacts', 'spec_init', 'spec_adopt', 'spec_read', 'spec_context',
    'spec_write', 'spec_status', 'spec_diagnostics', 'spec_analyze', 'spec_quality_preview', 'spec_sync_preview', 'spec_sync_apply',
    'spec_record_analysis', 'spec_request_approval', 'spec_record_approval', 'spec_task_set',
    'spec_task_plan', 'spec_task_begin', 'spec_task_record_check', 'spec_task_complete', 'spec_task_fail',
    'spec_task_reset_failures'
  ]);
  assert.doesNotMatch(JSON.stringify(replies[0]), /verified|actual-tool-event/i);
});

test('stdio MCP 可用 KIRO_SPEC_PROJECT_ROOT 脱离进程 cwd 定位项目', async () => {
  const projectRoot = await workspace();
  const pluginRoot = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], {
    cwd: pluginRoot,
    env: { ...process.env, KIRO_SPEC_PROJECT_ROOT: projectRoot }
  });
  const replies = [];
  let pending = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line) replies.push(JSON.parse(line));
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spec_health', arguments: {} } })}\n`);
  await waitForReplies(replies, 1);
  server.kill();

  assert.equal(replies[0].id, 1);
  assert.equal(replies[0].result.structuredContent.projectRoot, await realpath(projectRoot));
});

test('stdio MCP 在分发前拒绝类型错误和缺失字段', async () => {
  const projectRoot = await workspace();
  const pluginRoot = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { cwd: pluginRoot });
  const replies = [];
  let pending = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) if (line) replies.push(JSON.parse(line)); });
  try {
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'spec_task_begin', arguments: { projectRoot, spec: 'x', taskId: '1', planRevision: 'sha256:x', expectedStateEpoch: 1, workspaceSnapshot: snapshot('before'), recoverExpired: 'false' } } })}\n`);
    await waitForReplies(replies, 1);
    assert.equal(replies[0].error.code, -32602);
    assert.match(replies[0].error.message, /recoverExpired must be boolean/);
  } finally { server.kill(); }
});

test('stdio MCP 接受首次写入所需的 null rawRevision', async () => {
  const projectRoot = await workspace();
  const pluginRoot = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { cwd: pluginRoot });
  const replies = [];
  let pending = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) if (line) replies.push(JSON.parse(line)); });
  let requestId = 0;
  const call = async (name, args) => {
    const id = ++requestId;
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectRoot, ...args } } })}\n`);
    await waitForReplies(replies, id);
    return replies.find((reply) => reply.id === id).result.structuredContent;
  };
  try {
    const spec = '_eval-codex-20260827';
    await call('spec_init', { spec, workflow: 'requirements-first' });
    const context = await call('spec_context', { spec, artifact: 'requirements' });
    const written = await call('spec_write', { spec, artifact: 'requirements', content: '# Requirements\n', expectedRawRevision: null, contextProof: context.contextProof });
    assert.match(written.rawRevision, /^sha256:/);
  } finally { server.kill(); }
});

test('stdio MCP 可由每次工具调用显式指定绝对项目根', async () => {
  const projectRoot = await workspace();
  const pluginRoot = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { cwd: pluginRoot });
  const replies = [];
  let pending = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line) replies.push(JSON.parse(line));
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spec_health', arguments: { projectRoot } } })}\n`);
  await waitForReplies(replies, 1);
  server.kill();

  assert.equal(replies[0].id, 1);
  assert.equal(replies[0].result.structuredContent.projectRoot, await realpath(projectRoot));
});

test('stdio MCP 初始化失败保留请求身份，补齐 adapter 后同一进程可恢复', async () => {
  const projectRoot = await workspace({ withAdapter: false });
  const pluginRoot = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { cwd: pluginRoot });
  const replies = [];
  let pending = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line) replies.push(JSON.parse(line));
  });
  try {
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'spec_health', arguments: { projectRoot } } })}\n`);
    await waitForReplies(replies, 1);
    assert.equal(replies[0].id, 41);
    assert.equal(replies[0].result.structuredContent.code, 'ADAPTER_MISSING');
    assert.equal(replies[0].result.isError, true);

    await writeAdapter(projectRoot);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'spec_health', arguments: { projectRoot } } })}\n`);
    await waitForReplies(replies, 2);

    assert.equal(replies[1].id, 42);
    assert.equal(replies[1].result.structuredContent.projectRoot, await realpath(projectRoot));
  } finally {
    server.kill();
  }
});

test('stdio MCP 在真实进程内完成 adopt、审批与单任务执行闭环', async () => {
  const projectRoot = await workspace();
  const spec = '_eval-codex-20260827/stdio-execution';
  const specDir = path.join(projectRoot, '.kiro', 'specs', spec);
  await mkdir(specDir, { recursive: true });
  await writeFile(path.join(specDir, 'requirements.md'), '# Requirements\n\n## Requirement 1\n\nThe system SHALL execute.\n');
  await writeFile(path.join(specDir, 'design.md'), '# Design\n\n## Overview\n\nSerial execution.\n');
  await writeFile(path.join(specDir, 'tasks.md'), '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Execute through stdio\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n');

  const pluginRoot = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { cwd: pluginRoot });
  const replies = [];
  let pending = '';
  let requestId = 0;
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line) replies.push(JSON.parse(line));
  });
  const call = async (name, args) => {
    const id = ++requestId;
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectRoot, ...args } } })}\n`);
    await waitForReplies(replies, id);
    return replies.find((reply) => reply.id === id).result.structuredContent;
  };
  try {
    assert.equal((await call('spec_adopt', { spec, workflow: 'requirements-first' })).status, 'imported');
    for (const artifact of ['requirements', 'design', 'tasks']) {
      const approval = await call('spec_request_approval', { spec, artifact });
      const recorded = await call('spec_record_approval', {
        spec, artifact, expectedStateEpoch: approval.stateEpoch, confirmationText: `批准 ${artifact}`
      });
      assert.equal(recorded.code, undefined);
    }
    const plan = await call('spec_task_plan', { spec, scope: 'all', workspaceSnapshot: snapshot('before') });
    const begun = await call('spec_task_begin', {
      spec, taskId: '1', planRevision: plan.planRevision,
      expectedStateEpoch: plan.stateEpoch, workspaceSnapshot: snapshot('before')
    });
    const checked = await call('spec_task_record_check', {
      spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch,
      command: 'node --test', exitCode: 0, summary: 'pass'
    });
    const completed = await call('spec_task_complete', {
      spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch,
      workspaceSnapshot: snapshot('after'), summary: 'stdio execution complete'
    });
    assert.equal(completed.completedTaskId, '1');
    assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[x\] 1\. Execute/);
    assert.equal((await call('spec_status', { spec })).execution.activeTask, null);
  } finally {
    server.kill();
  }
});
