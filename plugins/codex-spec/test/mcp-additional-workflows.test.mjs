import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const artifactContent = {
  requirements: '# Requirements\n\n## Requirement 1\n\nThe system SHALL retain a record.\n',
  design: '# Design\n\n## Overview\n\nA minimal design.\n',
  bugfix: '# Bugfix Analysis\n\n## Current Behavior\n\nThe system loses a record.\n',
  tasks: '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Implement the record\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n'
};

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-workflows-'));
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
  return createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
}

async function writeArtifact(service, spec, artifact) {
  const context = await service.call('spec_context', { spec, artifact });
  const previous = await service.call('spec_read', { spec, artifact });
  return service.call('spec_write', {
    spec,
    artifact,
    content: artifactContent[artifact],
    expectedRawRevision: previous.code === 'SPEC_NOT_FOUND' ? undefined : previous.rawRevision,
    contextProof: context.contextProof
  });
}

async function approve(service, spec, artifact, phrase = `批准 ${artifact}`) {
  const request = await service.call('spec_request_approval', { spec, artifact });
  return service.call('spec_record_approval', { spec, artifact, expectedStateEpoch: request.stateEpoch, confirmationText: phrase });
}

test('design-first 先确认 design，再进入 requirements 阶段', async () => {
  const service = await setup();
  const spec = '_eval-codex-20260827';
  const started = await service.call('spec_init', { spec, workflow: 'design-first' });
  assert.equal(started.phase, 'design_draft');
  await writeArtifact(service, spec, 'design');
  assert.equal((await approve(service, spec, 'design')).phase, 'requirements_draft');
  await writeArtifact(service, spec, 'requirements');
  assert.equal((await approve(service, spec, 'requirements')).phase, 'tasks_draft');
});

test('bugfix 以独立 bugfix.md 开始，并在分析确认后进入根因设计', async () => {
  const service = await setup();
  const spec = '_eval-codex-20260827';
  const started = await service.call('spec_init', { spec, workflow: 'bugfix' });
  assert.equal(started.phase, 'bug_analysis_draft');
  await writeArtifact(service, spec, 'bugfix');
  assert.equal((await approve(service, spec, 'bugfix')).phase, 'root_cause_design_draft');
  const read = await service.call('spec_read', { spec, artifact: 'bugfix' });
  assert.equal(read.content, artifactContent.bugfix);
  await writeArtifact(service, spec, 'design');
  assert.equal((await approve(service, spec, 'design')).phase, 'tasks_draft');
  await writeArtifact(service, spec, 'tasks');
  assert.equal((await approve(service, spec, 'tasks')).phase, 'implementing');
});

test('quick 写入三份 artifact 后只接受一次整体确认', async () => {
  const service = await setup();
  const spec = '_eval-codex-20260827';
  const started = await service.call('spec_init', { spec, workflow: 'quick' });
  assert.equal(started.phase, 'artifacts_generated');
  for (const artifact of ['requirements', 'design', 'tasks']) await writeArtifact(service, spec, artifact);
  const individual = await service.call('spec_request_approval', { spec, artifact: 'requirements' });
  assert.equal(individual.code, 'APPROVAL_STALE');
  const approved = await approve(service, spec, 'all', '批准全部 artifacts');
  assert.equal(approved.phase, 'implementing');
  assert.deepEqual(Object.keys((await service.call('spec_status', { spec })).approvals).sort(), ['design', 'requirements', 'tasks']);
});

test('quick 在三份 artifact 未齐全时拒绝整体确认', async () => {
  const service = await setup();
  const spec = '_eval-codex-20260827';
  await service.call('spec_init', { spec, workflow: 'quick' });
  await writeArtifact(service, spec, 'requirements');
  const request = await service.call('spec_request_approval', { spec, artifact: 'all' });
  assert.equal(request.code, 'QUICK_ARTIFACTS_INCOMPLETE');
  assert.equal((await service.call('spec_status', { spec })).phase, 'artifacts_generated');
  await writeArtifact(service, spec, 'design');
  await writeArtifact(service, spec, 'tasks');
  assert.match((await service.call('spec_request_approval', { spec, artifact: 'all' })).approvalFingerprint, /^sha256:/);
});

test('quick 拒绝写入不属于整体审批的 bugfix artifact', async () => {
  const service = await setup();
  const spec = '_eval-codex-20260827';
  await service.call('spec_init', { spec, workflow: 'quick' });
  const rejected = await writeArtifact(service, spec, 'bugfix');
  assert.equal(rejected.code, 'ARTIFACT_NOT_ALLOWED');
});

test('bugfix 提供独立模板，并报告缺失的必填根因章节', async () => {
  const service = await setup();
  const template = await service.call('spec_template', { workflow: 'bugfix', artifact: 'bugfix' });
  assert.match(template.content, /^# Bugfix Analysis/m);
  // 🔴 2026-09-18 订正（docs/2026-09-18-claude-spec-plugin-defects.md 第 1 条）。
  // 这三行原先断言的是 `## Bug Details` / `## Hypothesized Root Cause` / `## Fix Implementation`
  // —— 那是 bugfix 工作流 **design.md** 的章节，被放错到了 bugfix.md 的骨架里。于是这条
  // 用例不但没拦住缺陷，反而**把它钉死**了：谁来修模板，先撞红的是这里。
  // 现改为断言 `validateBugfixFormat` 真正要求的那五节（与下半段那五条 findings 同源）。
  assert.match(template.content, /^## Introduction$/m);
  assert.match(template.content, /^## Bug Analysis$/m);
  assert.match(template.content, /^### Current Behavior \(Defect\)$/m);
  assert.match(template.content, /^### Expected Behavior \(Correct\)$/m);
  assert.match(template.content, /^### Unchanged Behavior \(Regression Prevention\)$/m);
  // 骨架自己必须过得了同一个校验器 —— 这正是缺陷能存在的那条缺席护栏。
  // （全组合的版本在 packages/spec-state/test/templates-validate-clean.test.mjs。）
  const templateFindings = await service.call('spec_validate_artifacts', { workflow: 'bugfix', artifacts: { bugfix: template.content } });
  assert.deepEqual(templateFindings.findings, [], 'spec_template 的产物不该被 spec_validate_artifacts 判出任何 finding');

  const result = await service.call('spec_validate_artifacts', {
    workflow: 'bugfix',
    artifacts: { bugfix: '# Bugfix Analysis\n\n## Bug Details\n\nObserved failure.\n' }
  });
  // 第 3.5 期接线后重写（唯一被改动的断言之一，原因如下）：
  // 旧实现只手写 3 条规则、用自造码 `MISSING_REQUIRED_SECTION`，对这份文档只报 2 条；
  // 接上共享裁决层后用的是 Kiro 自己的 `validateBugfixFormat` 的 5 条章节规则与**原码**。
  // 这份文档给了 `## Bug Details`（bugfix 变体的嗅探触发节），Kiro 另外还要求
  // `## Introduction` / `## Bug Analysis` 与三个 `### ...` 子节 —— 也就是说旧实现**漏报**了 3 条。
  assert.deepEqual(result.findings.map((item) => item.ruleId).sort(), [
    'bugfix/missing-bug-analysis',
    'bugfix/missing-current-behavior',
    'bugfix/missing-expected-behavior',
    'bugfix/missing-introduction',
    'bugfix/missing-unchanged-behavior'
  ]);
  // location.line 由旧适配层恒为 1，改为 Finding 契约里的 0（文档级、无具体行）。
  assert.deepEqual(result.findings.map((item) => item.location.line), [0, 0, 0, 0, 0]);
});

test('feature workflow 的 tasks schema 要求现代 Task Dependency Graph', async () => {
  const service = await setup();
  const result = await service.call('spec_validate_artifacts', {
    workflow: 'requirements-first',
    artifacts: { tasks: '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Implement record\n  _Requirements:_ 1\n' }
  });
  // 第 3.5 期接线后重写（唯一被改动的断言之二）：
  // 旧实现只手写 1 条 tasks 规则、用自造码 `MISSING_TASK_DEPENDENCY_GRAPH`。接上共享裁决层后，
  // 判定是 Kiro 的 `validateTasksFormat` 全套：这份文档缺 `## Overview`（建议节，warning）、
  // 缺 `## Notes`（建议节，warning）、缺 `## Task Dependency Graph`（必填节，error）。
  // 顺序是 Kiro 自己的检查顺序，故这里不再排序。
  assert.deepEqual(result.findings.map((item) => item.ruleId), [
    'tasks/missing-overview',
    'tasks/missing-notes',
    'tasks/missing-dependency-graph'
  ]);
  assert.equal(result.findings[0].artifact, 'tasks');
  assert.equal(result.assurance, 'collaborative');
});
