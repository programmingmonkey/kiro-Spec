import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const pluginRoot = path.resolve(import.meta.dirname, '..');

async function startServer() {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line) messages.push(JSON.parse(line));
  });
  await once(child, 'spawn');
  return {
    async request(id, method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.id === id);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${method}`);
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

test('plugin manifest wires the Skill and local stdio MCP without Hooks', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const skill = await readFile(path.join(pluginRoot, 'skills', 'codex-spec', 'SKILL.md'), 'utf8');

  assert.equal(manifest.name, 'codex-spec');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(manifest.hooks, undefined);
  assert.deepEqual(manifest.interface.capabilities, ['Read', 'Write']);
  assert.doesNotMatch(manifest.description, /skeleton/i);
  assert.doesNotMatch(manifest.interface.longDescription, /introduced only in later tasks/i);
  assert.deepEqual(mcp.mcpServers['codex-spec'], {
    command: 'node',
    args: ['./mcp-server.mjs'],
    cwd: '.'
  });
  assert.match(skill, /fileGuardrail=false/);
  assert.doesNotMatch(skill, /later workflow tools/i);
  assert.doesNotMatch(skill, /quick, task execution/);
  assert.match(skill, /`requirements-first`, `design-first`, `bugfix`, and `quick` collaborative workflows/);
  assert.match(skill, /serial task execution/);
  assert.match(skill, /spec_health[\s\S]*spec_list[\s\S]*spec_adopt[\s\S]*spec_context[\s\S]*spec_read[\s\S]*spec_diagnostics[\s\S]*spec_task_plan/);
  assert.match(skill, /spec_task_begin[\s\S]*spec_task_record_check[\s\S]*spec_task_complete/);
  assert.match(skill, /spec_task_fail/);
});

test('adapter 示例随包发布并要求调用方计算 authority hash', async () => {
  const [exampleRaw, packageRaw] = await Promise.all([
    readFile(path.join(pluginRoot, 'adapter.example.json'), 'utf8'),
    readFile(path.join(pluginRoot, 'package.json'), 'utf8')
  ]);
  const example = JSON.parse(exampleRaw);
  const packageJson = JSON.parse(packageRaw);

  assert.equal(example.schemaVersion, 1);
  assert.equal(example.specsRoot, '.kiro/specs');
  assert.equal(example.writePolicy.mode, 'evaluation-only');
  assert.deepEqual(example.writePolicy.allowedPrefixes, ['_eval-codex-YYYYMMDD/']);
  assert.equal(example.writePolicy.authorityFile, '.kiro/steering/spec-conventions.md');
  assert.equal(example.writePolicy.authorityHash, 'sha256:REPLACE_WITH_COMPUTED_HASH');
  assert.deepEqual(example.rules, [{
    match: ['.kiro/specs/**/*.md'],
    contextFiles: ['.kiro/steering/spec-conventions.md']
  }]);
  assert.deepEqual(example.validators, [{
    id: 'spec-tasks-lint',
    profile: 'kiro-spec/spec-tasks-lint-v1'
  }]);
  assert.ok(packageJson.files.includes('adapter.example.json'));
  assert.doesNotMatch(packageJson.description, /skeleton/i);
});

test('MCP starts over stdio and exposes requirements-first authoring and serial execution tools', async () => {
  const server = await startServer();
  try {
    const initialized = await server.request(1, 'initialize', { protocolVersion: '2025-06-18' });
    const listed = await server.request(2, 'tools/list');

    assert.equal(initialized.result.serverInfo.name, 'codex-spec');
    assert.equal(initialized.result.serverInfo.version, '1.0.0');
    assert.deepEqual(initialized.result.capabilities.tools, {});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      'spec_health', 'spec_list', 'spec_template', 'spec_validate_artifacts', 'spec_init', 'spec_adopt', 'spec_read', 'spec_context',
      'spec_write', 'spec_status', 'spec_diagnostics', 'spec_analyze', 'spec_quality_preview', 'spec_sync_preview', 'spec_sync_apply',
      'spec_record_analysis', 'spec_request_approval', 'spec_record_approval', 'spec_task_set',
      'spec_task_plan', 'spec_task_begin', 'spec_task_record_check', 'spec_task_complete', 'spec_task_fail',
      'spec_task_reset_failures'
    ]);
    for (const tool of listed.result.tools) {
      assert.equal(tool.annotations.openWorldHint, false);
    }
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_health').annotations.readOnlyHint, true);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_task_plan').annotations.readOnlyHint, false);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_write').annotations.destructiveHint, true);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_task_begin').annotations.destructiveHint, true);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_health').annotations.destructiveHint, false);
  } finally {
    await server.stop();
  }
});

test('installation documentation defines offline validation and no-Hook rollback', async () => {
  const [readme, install] = await Promise.all([
    readFile(path.join(pluginRoot, 'README.md'), 'utf8'),
    readFile(path.join(pluginRoot, 'INSTALL.md'), 'utf8')
  ]);

  assert.match(readme, /Node 20/);
  assert.match(readme, /fileGuardrail=false/);
  assert.match(readme, /context proof[^\n]*内存/);
  assert.match(readme, /全局串行/);
  assert.doesNotMatch(readme, /私有目录保存[^\n]*context proof/);
  assert.match(install, /离线验证/);
  assert.match(install, /卸载/);
  assert.match(install, /adapter\.example\.json/);
  assert.match(install, /ADAPTER_MISSING/);
  assert.match(install, /宿主 smoke/);
  assert.match(install, /\.codex-spec-private\//);
  assert.doesNotMatch(install, /也不写 `\.kiro\/specs\/`/);
  assert.doesNotMatch(install, /不创建私有状态/);
  assert.doesNotMatch(install, /\/Users\/macbkkopro/);
});
