import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const requirements = '# Requirements\n\n## Requirement 1\n\nThe system SHALL retain a record.\n';
const design = '# Design\n\n## Overview\n\nA minimal design.\n';
const tasks = '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Implement the record\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n';
const snapshot = { head: 'fixture', index: 'fixture', trackedDirty: [], untracked: [], untrackedPolicy: 'exclude', submodules: [], lfs: { policy: 'none', pointers: [] }, modes: [], eol: 'lf', platform: 'darwin' };

async function setup({ mode = 'evaluation-only' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-regression-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  const authority = '# Rules\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), authority);
  const writePolicy = mode === 'evaluation-only'
    ? { mode, allowedPrefixes: ['_eval-codex-20260908/'], authorityFile: '.kiro/steering/spec.md', authorityHash: computeRawRevision(authority) }
    : { mode, allowedPrefixes: ['specs/'] };
  await writeAdapter(root, writePolicy);
  return { root, writePolicy, service: await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') }) };
}

async function writeAdapter(root, writePolicy) {
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy,
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }]
  }));
}

async function context(service, spec, artifact) {
  return (await service.call('spec_context', { spec, artifact })).contextProof;
}

async function writeArtifact(service, spec, artifact, content) {
  const prior = await service.call('spec_read', { spec, artifact });
  return service.call('spec_write', {
    spec, artifact, content,
    expectedRawRevision: prior.code === 'SPEC_NOT_FOUND' ? undefined : prior.rawRevision,
    contextProof: await context(service, spec, artifact)
  });
}

async function approve(service, spec, artifact) {
  const request = await service.call('spec_request_approval', { spec, artifact });
  return service.call('spec_record_approval', {
    spec, artifact, expectedStateEpoch: request.stateEpoch, confirmationText: request.recommendedPhrase
  });
}

test('缺失已记录 artifact 会撤销批准、状态可见且阻止任务计划', async () => {
  const { root, service } = await setup();
  const spec = '_eval-codex-20260908';
  await service.call('spec_init', { spec, workflow: 'requirements-first' });
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) {
    await writeArtifact(service, spec, artifact, content);
    await approve(service, spec, artifact);
  }
  await rm(path.join(root, '.kiro', 'specs', spec, 'requirements.md'));

  const status = await service.call('spec_status', { spec });
  assert.equal(status.phase, 'requirements_draft');
  assert.deepEqual(status.missingArtifacts, ['requirements']);
  assert.deepEqual(status.approvals, {});
  const repeated = await service.call('spec_status', { spec });
  assert.equal(repeated.stateEpoch, status.stateEpoch);
  assert.deepEqual(repeated.missingArtifacts, ['requirements']);
  assert.equal((await service.call('spec_task_plan', { spec, scope: 'all', workspaceSnapshot: snapshot })).code, 'ARTIFACT_MISSING');
});

test('恢复已缺失 artifact 时首次状态即准确且允许通过工具重建', async () => {
  const { root, service } = await setup();
  const spec = '_eval-codex-20260908';
  await service.call('spec_init', { spec, workflow: 'requirements-first' });
  await writeArtifact(service, spec, 'requirements', requirements);
  const file = path.join(root, '.kiro', 'specs', spec, 'requirements.md');
  await rm(file);
  assert.deepEqual((await service.call('spec_status', { spec })).missingArtifacts, ['requirements']);

  const recreated = await service.call('spec_write', {
    spec, artifact: 'requirements', content: requirements, expectedRawRevision: undefined,
    contextProof: await context(service, spec, 'requirements')
  });
  assert.equal(recreated.code, undefined);
  assert.deepEqual((await service.call('spec_status', { spec })).missingArtifacts, []);

  await rm(file);
  await service.call('spec_status', { spec });
  await writeFile(file, requirements);
  assert.deepEqual((await service.call('spec_status', { spec })).missingArtifacts, []);
});

test('运行中的 service 在 adapter 权限变更后撤销旧 proof 并拒绝写入', async () => {
  const { root, service } = await setup({ mode: 'authorized' });
  const spec = 'specs/demo';
  await service.call('spec_init', { spec, workflow: 'requirements-first' });
  const proof = await context(service, spec, 'requirements');
  await writeAdapter(root, { mode: 'authorized', allowedPrefixes: ['denied/'] });

  assert.deepEqual((await service.call('spec_health', {})).allowedPrefixes, ['denied/']);
  const result = await service.call('spec_write', { spec, artifact: 'requirements', content: requirements, expectedRawRevision: undefined, contextProof: proof });
  assert.equal(result.code, 'WRITE_POLICY_DENIED');
});

test('规则文件在 contextProof 签发后变化时拒绝旧 proof', async () => {
  const { root, service } = await setup({ mode: 'authorized' });
  const spec = 'specs/context-proof';
  await service.call('spec_init', { spec, workflow: 'requirements-first' });
  const proof = await context(service, spec, 'requirements');
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), '# Rules\n\nChanged after proof.\n');

  const result = await service.call('spec_write', {
    spec, artifact: 'requirements', content: requirements,
    expectedRawRevision: undefined, contextProof: proof,
  });
  assert.equal(result.code, 'CONTEXT_PROOF_INVALID');
});

test('adapter 刷新构建失败时不会提交半成品配置或继续用旧 storage 写入', async () => {
  const { root, service } = await setup({ mode: 'authorized' });
  const spec = 'specs/demo';
  await service.call('spec_init', { spec, workflow: 'requirements-first' });
  await writeArtifact(service, spec, 'requirements', requirements);
  const prior = await service.call('spec_read', { spec, artifact: 'requirements' });
  const proof = await context(service, spec, 'requirements');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-outside-'));
  await symlink(outside, path.join(root, 'outside'));
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: 'outside',
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }]
  }));

  assert.equal((await service.call('spec_health')).code, 'PATH_OUTSIDE_PROJECT');
  assert.equal((await service.call('spec_health')).code, 'PATH_OUTSIDE_PROJECT');
  const attempted = await service.call('spec_write', {
    spec, artifact: 'requirements', content: `${requirements}\nChanged.\n`,
    expectedRawRevision: prior.rawRevision, contextProof: proof
  });
  assert.equal(attempted.code, 'PATH_OUTSIDE_PROJECT');
  assert.equal(await readFile(path.join(root, '.kiro', 'specs', spec, 'requirements.md'), 'utf8'), requirements);
});

test('非法 tasks 写入失败时不会替换磁盘中的 artifact', async () => {
  const { root, service } = await setup();
  const spec = '_eval-codex-20260908';
  await service.call('spec_init', { spec, workflow: 'requirements-first' });
  await writeArtifact(service, spec, 'requirements', requirements);
  await approve(service, spec, 'requirements');
  await writeArtifact(service, spec, 'design', design);
  await approve(service, spec, 'design');
  const proof = await context(service, spec, 'tasks');
  const invalid = '- [~] 1. Invalid state\n';

  assert.equal((await service.call('spec_write', { spec, artifact: 'tasks', content: invalid, expectedRawRevision: undefined, contextProof: proof })).code, 'INVALID_FORMAT');
  await assert.rejects(readFile(path.join(root, '.kiro', 'specs', spec, 'tasks.md')), { code: 'ENOENT' });
});

test('quick 审阅阶段允许修订 artifact 并回到整体起草阶段', async () => {
  const { service } = await setup();
  const spec = '_eval-codex-20260908';
  await service.call('spec_init', { spec, workflow: 'quick' });
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) await writeArtifact(service, spec, artifact, content);
  await service.call('spec_request_approval', { spec, artifact: 'all' });
  const prior = await service.call('spec_read', { spec, artifact: 'requirements' });
  const revised = await service.call('spec_write', {
    spec, artifact: 'requirements', content: `${requirements}\nRevised after review.\n`, expectedRawRevision: prior.rawRevision,
    contextProof: await context(service, spec, 'requirements')
  });

  assert.equal(revised.code, undefined);
  assert.equal((await service.call('spec_status', { spec })).phase, 'artifacts_generated');
});

test('不同安全 Spec 路径使用不同私有状态', async () => {
  const { service } = await setup({ mode: 'authorized' });
  const first = await service.call('spec_init', { spec: 'specs/a/b', workflow: 'requirements-first' });
  const second = await service.call('spec_init', { spec: 'specs/a_2Fb', workflow: 'requirements-first' });
  assert.equal(first.code, undefined);
  assert.equal(second.code, undefined);
});
