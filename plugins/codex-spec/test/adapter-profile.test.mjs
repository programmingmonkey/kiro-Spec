import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const fixtureRoot = new URL('./fixtures/', import.meta.url);

test('the consumer repo adapter fixture locks the evaluation-only authority contract', async () => {
  const adapter = JSON.parse(await readFile(new URL('adapter-profile.json', fixtureRoot), 'utf8'));
  assert.equal(adapter.specsRoot, '.kiro/specs');
  assert.equal(adapter.writePolicy.mode, 'evaluation-only');
  assert.deepEqual(adapter.writePolicy.allowedPrefixes, ['_eval-codex-20260827/']);
  assert.equal(adapter.writePolicy.authorityFile, '.kiro/steering/spec-conventions.md');
  assert.deepEqual(adapter.validators, [{ id: 'spec-tasks-lint', profile: 'kiro-spec/spec-tasks-lint-v1' }]);
  assert.deepEqual(adapter.rules[0].contextFiles, [
    '.kiro/steering/spec-conventions.md',
    '.kiro/settings/templates/specs/requirements.md',
    '.kiro/settings/templates/specs/design.md',
    '.kiro/settings/templates/specs/tasks.md'
  ]);
});

const tasks = '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Parent\n  - [ ] 1.1. Leaf\n    _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1.1"]}]}\n```\n';

async function setup({ authorityHash = 'valid', validators = [{ id: 'spec-tasks-lint', profile: 'kiro-spec/spec-tasks-lint-v1' }] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-consumer-'));
  await mkdir(path.join(root, '.kiro', 'specs', '_eval-codex-20260827'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  const authority = '# Spec conventions\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), authority);
  await writeFile(path.join(root, '.kiro', 'specs', '_eval-codex-20260827', 'tasks.md'), tasks);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: { mode: 'evaluation-only', allowedPrefixes: ['_eval-codex-20260827/'], authorityFile: '.kiro/steering/spec-conventions.md', authorityHash: authorityHash === 'valid' ? computeRawRevision(authority) : 'sha256:wrong' },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
    validators
  }));
  return { root };
}

// ── 第 3.6 期 Task 0.1：白名单是**放宽**，不是取消 ─────────────────────────────
//
// R36-1 的处置：放宽与取消只差一行。下面四条把两者钉开——两条已知放行、两个未知
// （id / profile）与空条目仍然要抛。少了下半组，上面那条「放行」就不可证伪。

test('Task 0.1 — 两条已知 validator 可同时挂载（Task 7 的形状）', async () => {
  const { root } = await setup({
    validators: [
      { id: 'spec-tasks-lint', profile: 'kiro-spec/spec-tasks-lint-v1' },
      { id: 'spec-validator', profile: 'kiro-spec/kiro-rules-v1' }
    ]
  });
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  await service.call('spec_adopt', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  const diagnostics = await service.call('spec_diagnostics', { spec: '_eval-codex-20260827' });
  assert.deepEqual(
    diagnostics.validatorPlan.map((entry) => entry.id),
    ['spec-tasks-lint', 'spec-validator'],
    '两条 validator 都应当出现在 plan 里'
  );
});

test('Task 0.1 — 未知 id 仍然抛 ADAPTER_INVALID', async () => {
  const { root } = await setup({ validators: [{ id: 'not-a-real-validator', profile: 'kiro-spec/spec-tasks-lint-v1' }] });
  await assert.rejects(
    () => createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') }),
    { code: 'ADAPTER_INVALID' }
  );
});

test('Task 0.1 — 已知 id 但未知 profile 仍然抛 ADAPTER_INVALID', async () => {
  const { root } = await setup({ validators: [{ id: 'spec-tasks-lint', profile: 'consumer/not-a-real-profile' }] });
  await assert.rejects(
    () => createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') }),
    { code: 'ADAPTER_INVALID' }
  );
});

test('Task 0.1 — 空条目不得因为两个 undefined 相等而被放行', async () => {
  // 只写 `KNOWN_VALIDATORS[v.id] === v.profile` 时 `{}` 会通过（undefined === undefined）。
  const { root } = await setup({ validators: [{}] });
  await assert.rejects(
    () => createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') }),
    { code: 'ADAPTER_INVALID' }
  );
});

test('缺少项目 adapter 时返回可操作的 ADAPTER_MISSING 错误', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-missing-adapter-'));
  await assert.rejects(
    () => createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') }),
    (caught) => {
      assert.equal(caught.code, 'ADAPTER_MISSING');
      // L4（Req 3.1）：默认路径改名为 `.codex/codex-spec.json`，所以「两份都不在」时
      // 报错文案与 `details.adapterPath` 都指向**新**路径 —— 那是用户真正该放文件的地方。
      assert.match(caught.message, /\.codex\/codex-spec\.json/);
      assert.deepEqual(caught.details, {
        adapterPath: '.codex/codex-spec.json',
        examplePath: 'adapter.example.json'
      });
      return true;
    }
  );
});

test('消费项目 adapter 的 evaluation-only authority hash 不匹配即 fail-closed', async () => {
  const { root } = await setup({ authorityHash: 'wrong' });
  await assert.rejects(() => createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') }), { code: 'ADAPTER_UNTRUSTED' });
});

test('消费项目 adapter 仅允许评估目录，且 diagnostics 返回受限 validator 描述', async () => {
  const { root } = await setup();
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const rejected = await service.call('spec_init', { spec: 'production', workflow: 'requirements-first' });
  assert.equal(rejected.code, 'WRITE_POLICY_DENIED');
  const nested = await service.call('spec_init', { spec: '_eval-codex-20260827/nested', workflow: 'requirements-first' });
  assert.equal(nested.code, 'WRITE_POLICY_DENIED');
  const adopted = await service.call('spec_adopt', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  assert.equal(adopted.status, 'imported');
  const status = await service.call('spec_status', { spec: '_eval-codex-20260827' });
  assert.deepEqual(status.executableTaskIds, ['1.1']);
  assert.deepEqual(status.waves, [{ id: 0, tasks: ['1.1'] }]);
  const diagnostics = await service.call('spec_diagnostics', { spec: '_eval-codex-20260827' });
  assert.deepEqual(diagnostics.validatorPlan, [{ id: 'spec-tasks-lint', argv: ['python3', 'scripts/spec-tasks-lint.py', '--strict', '.kiro/specs/_eval-codex-20260827/tasks.md'], readOnly: true }]);
});

test('diagnostics 以只读方式返回缺 Requirements warning，并由 read/status 透传', async () => {
  const { root } = await setup();
  const privateDir = path.join(root, '.private');
  const service = await createMcpService({ projectRoot: root, privateDir });
  await service.call('spec_adopt', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  const taskFile = path.join(root, '.kiro', 'specs', '_eval-codex-20260827', 'tasks.md');
  await writeFile(taskFile, '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Missing requirement\n');
  const stateFile = path.join(privateDir, `state-${createHash('sha256').update('_eval-codex-20260827').digest('hex')}.json`);
  const before = await readFile(stateFile, 'utf8');

  const diagnostics = await service.call('spec_diagnostics', { spec: '_eval-codex-20260827' });
  assert.deepEqual(diagnostics.diagnostics, [{
    code: 'TASK_MISSING_REQUIREMENTS', severity: 'warning', taskId: '1', message: 'Executable task 1 is missing _Requirements:_'
  }]);
  assert.equal(await readFile(stateFile, 'utf8'), before);

  const read = await service.call('spec_read', { spec: '_eval-codex-20260827', artifact: 'tasks' });
  assert.equal(read.warnings[0].code, 'TASK_MISSING_REQUIREMENTS');
  const status = await service.call('spec_status', { spec: '_eval-codex-20260827' });
  assert.equal(status.warnings[0].code, 'TASK_MISSING_REQUIREMENTS');
});

test('diagnostics 将非法任务状态返回为结构化 error', async () => {
  const { root } = await setup();
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  await service.call('spec_adopt', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  await writeFile(path.join(root, '.kiro', 'specs', '_eval-codex-20260827', 'tasks.md'), '- [?] 1. Invalid\n');

  const diagnostics = await service.call('spec_diagnostics', { spec: '_eval-codex-20260827' });
  assert.deepEqual(diagnostics.diagnostics, [{
    code: 'INVALID_FORMAT', severity: 'error', message: 'Invalid task state at line 1; use [ ], [-], or [x]'
  }]);
});

test('diagnostics 保留存储安全错误的顶层 MCP 错误契约', async () => {
  const { root } = await setup();
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const spec = '_eval-codex-20260827';
  await service.call('spec_adopt', { spec, workflow: 'requirements-first' });
  const managed = path.join(root, '.kiro', 'specs', '_eval-codex-20260827');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-diagnostics-outside-'));
  await writeFile(path.join(outside, 'tasks.md'), '- [ ] 1. Outside\n');
  await rename(managed, `${managed}-managed`);
  await symlink(outside, managed);

  const diagnostics = await service.call('spec_diagnostics', { spec });
  assert.equal(diagnostics.code, 'SYMLINK_ESCAPE');
  assert.equal(diagnostics.diagnostics, undefined);
});
