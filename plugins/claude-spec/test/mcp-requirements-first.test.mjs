import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const requirements = '# Requirements\n\n## Requirement 1\n\nThe system SHALL retain a record.\n';
const design = '# Design\n\n## Overview\n\nA minimal design.\n';
const tasks = '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Implement the record\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-mcp-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  const authority = '# Rules\n\nUse the approved format.\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), authority);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: { mode: 'evaluation-only', allowedPrefixes: ['_eval-codex-20260827/'], authorityFile: '.kiro/steering/spec.md', authorityHash: computeRawRevision(authority) },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }]
  }));
  return { root, service: await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') }) };
}

async function proof(service, artifact = 'requirements', spec = '_eval-codex-20260827') {
  const page = await service.call('spec_context', { spec, artifact });
  assert.equal(page.page, 1);
  assert.equal(page.totalPages, 1);
  assert.match(page.contextProof, /^context:/);
  return page.contextProof;
}

test('requirements-first MCP 闭环要求 context proof、CAS 与明确 collaborative confirmation', async () => {
  const { service } = await setup();
  assert.equal((await service.call('spec_health', {})).baseReady, true);
  const initialized = await service.call('spec_init', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  assert.equal(initialized.phase, 'requirements_draft');
  const contextProof = await proof(service);
  const missingProof = await service.call('spec_write', { spec: initialized.spec, artifact: 'requirements', content: requirements, expectedRawRevision: undefined });
  assert.equal(missingProof.code, 'CONTEXT_PROOF_INVALID');
  const written = await service.call('spec_write', { spec: initialized.spec, artifact: 'requirements', content: requirements, expectedRawRevision: undefined, contextProof });
  assert.match(written.rawRevision, /^sha256:/);
  const stale = await service.call('spec_write', { spec: initialized.spec, artifact: 'requirements', content: requirements, expectedRawRevision: 'sha256:stale', contextProof });
  assert.equal(stale.code, 'REVISION_CONFLICT');
  const requested = await service.call('spec_request_approval', { spec: initialized.spec, artifact: 'requirements' });
  assert.equal(requested.recommendedPhrase, '批准 requirements');
  const vague = await service.call('spec_record_approval', { spec: initialized.spec, artifact: 'requirements', expectedStateEpoch: requested.stateEpoch, confirmationText: '继续' });
  assert.equal(vague.code, 'APPROVAL_TEXT_INVALID');
  const approved = await service.call('spec_record_approval', { spec: initialized.spec, artifact: 'requirements', expectedStateEpoch: requested.stateEpoch, confirmationText: '批准 requirements' });
  assert.equal(approved.phase, 'design_draft');
  assert.equal(approved.assurance, 'collaborative');
  assert.doesNotMatch(JSON.stringify(approved), /verified|actual-tool-event/i);
});

test('读取外部语义修改会失效 approvals，且拒绝重复 adopt 覆盖状态', async () => {
  const { root, service } = await setup();
  const initialized = await service.call('spec_init', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  const contextProof = await proof(service);
  await service.call('spec_write', { spec: initialized.spec, artifact: 'requirements', content: requirements, expectedRawRevision: undefined, contextProof });
  const approval = await service.call('spec_request_approval', { spec: initialized.spec, artifact: 'requirements' });
  await service.call('spec_record_approval', { spec: initialized.spec, artifact: 'requirements', expectedStateEpoch: approval.stateEpoch, confirmationText: '批准 requirements' });
  await writeFile(path.join(root, '.kiro', 'specs', '_eval-codex-20260827', 'requirements.md'), requirements.replace('retain a record', 'retain a different record'));
  const refused = await service.call('spec_write', { spec: initialized.spec, artifact: 'design', content: design, expectedRawRevision: undefined, contextProof: await proof(service, 'design') });
  assert.equal(refused.code, 'PHASE_NOT_APPROVED');
  const observed = await service.call('spec_read', { spec: initialized.spec, artifact: 'requirements' });
  assert.equal(observed.externalChange, null);
  assert.equal((await service.call('spec_status', { spec: initialized.spec })).phase, 'requirements_draft');
  const adopted = await service.call('spec_adopt', { spec: initialized.spec, workflow: 'requirements-first' });
  assert.equal(adopted.code, 'SPEC_ALREADY_EXISTS');
});

test('requirements → design → tasks 在临时目录完成协作确认并保留现代 task/waves', async () => {
  const { service } = await setup();
  const started = await service.call('spec_init', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  let state = started;
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) {
    const contextProof = await proof(service, artifact, started.spec);
    const prior = await service.call('spec_read', { spec: started.spec, artifact });
    const write = await service.call('spec_write', { spec: started.spec, artifact, content, expectedRawRevision: prior.code === 'SPEC_NOT_FOUND' ? undefined : prior.rawRevision, contextProof });
    assert.match(write.rawRevision, /^sha256:/);
    const approval = await service.call('spec_request_approval', { spec: started.spec, artifact });
    state = await service.call('spec_record_approval', { spec: started.spec, artifact, expectedStateEpoch: approval.stateEpoch, confirmationText: `批准 ${artifact}` });
  }
  assert.equal(state.phase, 'implementing');
  const status = await service.call('spec_status', { spec: started.spec });
  assert.deepEqual(status.executableTaskIds, ['1']);
  assert.deepEqual(status.waves, [{ id: 0, tasks: ['1'] }]);
  const analysis = await service.call('spec_analyze', { spec: started.spec });
  assert.deepEqual(analysis.findings.map((finding) => finding.ruleId), ['REQUIREMENT_WITHOUT_DESIGN_TRACE']);
  const recorded = await service.call('spec_record_analysis', { spec: started.spec, findings: analysis.findings, expectedStateEpoch: status.stateEpoch });
  assert.equal(recorded.analysisCount, 1);
});

test('质量与同步预览只读取 artifact，并携带其当前 revision', async () => {
  const { service } = await setup();
  const started = await service.call('spec_init', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) {
    const contextProof = await proof(service, artifact, started.spec);
    await service.call('spec_write', { spec: started.spec, artifact, content, expectedRawRevision: undefined, contextProof });
    if (artifact !== 'tasks') {
      const approval = await service.call('spec_request_approval', { spec: started.spec, artifact });
      await service.call('spec_record_approval', { spec: started.spec, artifact, expectedStateEpoch: approval.stateEpoch, confirmationText: `批准 ${artifact}` });
    }
  }

  const quality = await service.call('spec_quality_preview', { spec: started.spec });
  assert.deepEqual(quality.findings.map((item) => item.ruleId).sort(), ['MISSING_ACCEPTANCE_CRITERIA', 'MISSING_DESIGN_SECTION', 'MISSING_DESIGN_SECTION']);
  assert.equal(quality.assurance, 'collaborative');

  const sync = await service.call('spec_sync_preview', { spec: started.spec });
  assert.deepEqual(Object.keys(sync.sourceRevisions).sort(), ['design', 'requirements', 'tasks']);
  assert.deepEqual(sync.proposals, [{
    artifact: 'design',
    operation: 'append',
    markdown: '\n## Requirements Trace\n\nRequirements 1\n',
    ruleId: 'ADD_DESIGN_REQUIREMENT_TRACE'
  }]);
  assert.equal(sync.assurance, 'collaborative');

  const applied = await service.call('spec_sync_apply', {
    spec: started.spec,
    sourceRevisions: sync.sourceRevisions,
    contextProof: await proof(service, 'design', started.spec),
    confirmationText: '应用同步建议'
  });
  assert.equal(applied.phase, 'design_draft');
  assert.match((await service.call('spec_read', { spec: started.spec, artifact: 'design' })).content, /^## Requirements Trace\n\nRequirements 1$/m);
  // 🔴 2026-09-18 订正（缺陷报告第 4 条）：原先断言 `approvals` 为空，那是拿「明细表被
  // 整张清空」当「审批已作废」的代理指标 —— 而整张清空正是第 4 条缺陷本身。明细表现在
  // 如实映射闸门（只作废 changedArtifact 及其下游），所以改为直接断言意图。
  assert.deepEqual(Object.keys((await service.call('spec_status', { spec: started.spec })).approvals).sort(), ['requirements']);
});

test('spec_list 发现没有私有状态的存量 Spec，但读取计划前要求显式 adopt', async () => {
  const { root, service } = await setup();
  const external = path.join(root, '.kiro', 'specs', '_eval-codex-20260827', 'external');
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, 'tasks.md'), tasks);

  const listed = await service.call('spec_list', {});
  assert.deepEqual(listed.specs.find(({ spec }) => spec === '_eval-codex-20260827/external'), {
    spec: '_eval-codex-20260827/external', lifecycle: 'external', artifacts: ['tasks']
  });
  const plan = await service.call('spec_task_plan', { spec: '_eval-codex-20260827/external', scope: 'all' });
  assert.equal(plan.code, 'ADOPTION_REQUIRED');
});

test('health 与 list 不创建私有状态目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-readonly-'));
  const privateDir = path.join(root, '.private');
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  const authority = '# Rules\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), authority);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: { mode: 'evaluation-only', allowedPrefixes: ['_eval-codex-20260906/'], authorityFile: '.kiro/steering/spec.md', authorityHash: computeRawRevision(authority) },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }]
  }));
  const service = await createMcpService({ projectRoot: root, privateDir });
  await service.call('spec_health', {});
  await service.call('spec_list', {});
  await assert.rejects(() => stat(privateDir), { code: 'ENOENT' });
});

test('损坏的私有 state fail closed，不被当作未管理 Spec', async () => {
  const { root } = await setup();
  const privateDir = path.join(root, '.private');
  await mkdir(privateDir, { recursive: true });
  const stateFile = path.join(privateDir, `state-${createHash('sha256').update('_eval-codex-20260827/demo').digest('hex')}.json`);
  await writeFile(stateFile, '{broken');
  const service = await createMcpService({ projectRoot: root, privateDir });
  assert.equal((await service.call('spec_status', { spec: '_eval-codex-20260827/demo' })).code, 'STATE_CORRUPT');
  assert.equal((await service.call('spec_adopt', { spec: '_eval-codex-20260827/demo', workflow: 'requirements-first' })).code, 'STATE_CORRUPT');
  await writeFile(stateFile, 'null');
  assert.equal((await service.call('spec_status', { spec: '_eval-codex-20260827/demo' })).code, 'STATE_CORRUPT');
  assert.equal((await service.call('spec_adopt', { spec: '_eval-codex-20260827/demo', workflow: 'requirements-first' })).code, 'STATE_CORRUPT');
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 1, workflowState: { schemaVersion: 1, workflow: 'anything', phase: 'implementing', stateEpoch: 0, approvals: {} }, artifacts: {}, approvals: {}
  }));
  assert.equal((await service.call('spec_status', { spec: '_eval-codex-20260827/demo' })).code, 'STATE_CORRUPT');
  assert.equal((await service.call('spec_task_plan', { spec: '_eval-codex-20260827/demo', scope: 'all', workspaceRevision: 'sha256:x' })).code, 'STATE_CORRUPT');
});

test('spec_init 可在尚无 specsRoot 的新项目中创建首个 Spec', async () => {
  const { root } = await setup();
  const specsRoot = path.join(root, '.kiro', 'specs');
  const moved = `${specsRoot}-moved`;
  await import('node:fs/promises').then(({ rename }) => rename(specsRoot, moved));
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private-new') });
  assert.equal((await service.call('spec_health', {})).baseReady, true);
  const initialized = await service.call('spec_init', { spec: '_eval-codex-20260827', workflow: 'requirements-first' });
  assert.equal(initialized.phase, 'requirements_draft');
});
