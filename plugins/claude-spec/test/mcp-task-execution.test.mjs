import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const spec = '_eval-codex-20260906/execution';
const requirements = '# Requirements\n\n## Requirement 1\n\nThe system SHALL execute tasks.\n';
const design = '# Design\n\n## Overview\n\nUse a serial executor.\n';
const tasks = `# Implementation Plan

## Tasks

- [ ] 1. Implement execution
  _Requirements:_ 1
- [ ] 2. Verify execution
  _Requirements:_ 1
  _Dependencies:_ 1

## Task Dependency Graph

\`\`\`json
{"waves":[{"id":0,"tasks":["1"]},{"id":1,"tasks":["2"]}]}
\`\`\`
`;

const canonicalTasks = `# Implementation Plan

## Tasks

- [ ] 1. Parent
  - [ ]* 1.1 Kiro child
    - _Requirements: REQ_AUTH_1_

## Task Dependency Graph

\`\`\`json
{"waves":[{"id":0,"tasks":["1.1"]}]}
\`\`\`
`;

async function setup({ now, fault, tasksContent = tasks } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-execution-'));
  const specDir = path.join(root, '.kiro', 'specs', spec);
  await mkdir(specDir, { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  const authority = '# Rules\n\nExecute serially.\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), authority);
  await writeFile(path.join(specDir, 'requirements.md'), requirements);
  await writeFile(path.join(specDir, 'design.md'), design);
  await writeFile(path.join(specDir, 'tasks.md'), tasksContent);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: {
      mode: 'evaluation-only', allowedPrefixes: ['_eval-codex-20260906/'],
      authorityFile: '.kiro/steering/spec.md', authorityHash: computeRawRevision(authority)
    },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }]
  }));
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private'), ...(now ? { now } : {}), ...(fault ? { fault } : {}) });
  await service.call('spec_adopt', { spec, workflow: 'requirements-first' });
  for (const artifact of ['requirements', 'design', 'tasks']) {
    const request = await service.call('spec_request_approval', { spec, artifact });
    const approved = await service.call('spec_record_approval', {
      spec, artifact, expectedStateEpoch: request.stateEpoch, confirmationText: `批准 ${artifact}`
    });
    assert.equal(approved.code, undefined);
  }
  return { root, specDir, service };
}

test('adopt 后完成 plan → begin → check → complete 串行闭环', async () => {
  const { specDir, service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'all', workspaceRevision: 'sha256:before' });
  assert.deepEqual(plan.taskIds, ['1', '2']);
  assert.match(plan.planRevision, /^sha256:/);

  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  assert.match(begun.ownerToken, /^[0-9a-f-]{36}$/);
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[-\] 1\. Implement/);

  const checked = await service.call('spec_task_record_check', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch,
    command: 'npm test', exitCode: 0, summary: 'all tests passed'
  });
  assert.equal(checked.checks.at(-1).source, 'agent-reported');

  const completed = await service.call('spec_task_complete', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch,
    workspaceRevision: 'sha256:after', summary: 'execution implemented'
  });
  assert.equal(completed.completedTaskId, '1');
  assert.equal(completed.nextTaskId, '2');
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[x\] 1\. Implement/);
  assert.equal((await service.call('spec_status', { spec })).execution.activeTask, null);
});

test('重建 service 后仍可 begin 已持久化的计划', async () => {
  const { root, service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const restarted = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });

  const begun = await restarted.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });

  assert.match(begun.ownerToken, /^[0-9a-f-]{36}$/);
});

test('Kiro canonical 子任务通过 MCP 完成 plan → begin → check → complete 闭环', async () => {
  const { specDir, service } = await setup({ tasksContent: canonicalTasks });
  const plan = await service.call('spec_task_plan', { spec, scope: 'all', workspaceRevision: 'sha256:before' });
  assert.deepEqual(plan.taskIds, ['1.1']);

  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1.1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[-\]\* 1\.1 Kiro child/);

  const checked = await service.call('spec_task_record_check', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch,
    command: 'npm test', exitCode: 0, summary: 'canonical task passed'
  });
  const completed = await service.call('spec_task_complete', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch,
    workspaceRevision: 'sha256:after', summary: 'canonical task completed'
  });
  assert.equal(completed.completedTaskId, '1.1');
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[x\]\* 1\.1 Kiro child/);
});

test('错误 owner、缺少成功检查和 fail 回退均不误标完成', async () => {
  const { specDir, service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });

  assert.equal((await service.call('spec_task_complete', {
    spec, ownerToken: 'wrong', expectedStateEpoch: begun.stateEpoch,
    workspaceRevision: 'sha256:after', summary: 'wrong owner'
  })).code, 'OWNER_TOKEN_INVALID');
  assert.equal((await service.call('spec_task_complete', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch,
    workspaceRevision: 'sha256:after', summary: 'unchecked'
  })).code, 'CHECK_REQUIRED');

  const failed = await service.call('spec_task_fail', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, summary: 'implementation failed'
  });
  assert.equal(failed.failedTaskId, '1');
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[ \] 1\. Implement/);
});

test('spec_task_set 提供独立的手动三态通道，且不绕过严格执行 lease', async () => {
  const { specDir, service } = await setup();

  const active = await service.call('spec_task_set', { spec, taskId: '1', state: 'in-progress' });
  assert.equal(active.state, '[-]');
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[-\] 1\. Implement/);
  assert.equal((await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' })).code, 'RECOVERY_REQUIRED');

  const pending = await service.call('spec_task_set', { spec, taskId: '1', state: 'pending' });
  assert.equal(pending.state, '[ ]');
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[ \] 1\. Implement/);

  await service.call('spec_task_set', { spec, taskId: '1', state: 'in-progress' });
  const done = await service.call('spec_task_set', { spec, taskId: '1', state: 'done' });
  assert.equal(done.state, '[x]');
  assert.match(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[x\] 1\. Implement/);

  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '2', workspaceRevision: 'sha256:after' });
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '2', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:after'
  });
  assert.equal((await service.call('spec_task_set', { spec, taskId: '2', state: 'pending' })).code, 'TASK_ALREADY_ACTIVE');
  assert.equal((await service.call('spec_task_fail', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, summary: 'cleanup'
  })).code, undefined);
});

test('过期 lease 只在显式 recoverExpired 后允许同任务换 owner', async () => {
  let clock = 1000;
  const { service } = await setup({ now: () => clock });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  clock = begun.leaseExpiresAt + 1;
  assert.equal((await service.call('spec_status', { spec })).recovery.code, 'RECOVERY_REQUIRED');
  assert.equal((await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: begun.stateEpoch, workspaceRevision: 'sha256:before'
  })).code, 'RECOVERY_REQUIRED');

  const recovered = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: begun.stateEpoch, workspaceRevision: 'sha256:before', recoverExpired: true
  });
  assert.notEqual(recovered.ownerToken, begun.ownerToken);
  assert.equal(recovered.taskId, '1');
});

test('tasks.md 在 plan 后变化会拒绝 begin', async () => {
  const { specDir, service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  await writeFile(path.join(specDir, 'tasks.md'), `${tasks}\nExternal semantic change.\n`);
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  assert.equal(begun.code, 'PLAN_STALE');
});

test('同一任务第三次 fail 后要求人工复核', async () => {
  const { service } = await setup();
  let result;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: `sha256:before-${attempt}` });
    const begun = await service.call('spec_task_begin', {
      spec, taskId: '1', planRevision: plan.planRevision,
      expectedStateEpoch: plan.stateEpoch, workspaceRevision: `sha256:before-${attempt}`
    });
    result = await service.call('spec_task_fail', {
      spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, summary: `failed ${attempt}`
    });
  }
  assert.equal(result.code, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(result.failedTaskId, '1');
});

test('执行中 artifact 语义变化会阻止 complete，不能误标任务完成', async () => {
  const { specDir, service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  const checked = await service.call('spec_task_record_check', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch,
    command: 'npm test', exitCode: 0, summary: 'pass'
  });
  const activeMarkdown = await readFile(path.join(specDir, 'tasks.md'), 'utf8');
  await writeFile(path.join(specDir, 'tasks.md'), activeMarkdown.replace('Implement execution', 'Implement changed execution'));

  const completed = await service.call('spec_task_complete', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch,
    workspaceRevision: 'sha256:after', summary: 'must not complete stale task'
  });
  assert.equal(completed.code, 'RECOVERY_REQUIRED');
  assert.doesNotMatch(await readFile(path.join(specDir, 'tasks.md'), 'utf8'), /- \[x\] 1\./);
});

test('上游 artifact 在 plan 前变化会撤销 executing 准入', async () => {
  const { specDir, service } = await setup();
  await writeFile(path.join(specDir, 'requirements.md'), `${requirements}\nNew requirement.\n`);
  const plan = await service.call('spec_task_plan', { spec, scope: 'all', workspaceRevision: 'sha256:before' });
  assert.equal(plan.code, 'PHASE_NOT_APPROVED');
});

test('adopt 后上游 artifact 仅 CRLF 变化不撤销语义批准', async () => {
  const { specDir, service } = await setup();
  await writeFile(path.join(specDir, 'requirements.md'), requirements.replaceAll('\n', '\r\n'));
  const plan = await service.call('spec_task_plan', { spec, scope: 'all', workspaceRevision: 'sha256:before' });
  assert.equal(plan.code, undefined);
});

test('执行中的外部 checkbox 变化未经 journal 对账时 fail closed', async () => {
  const { specDir, service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  const checked = await service.call('spec_task_record_check', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, command: 'npm test', exitCode: 0, summary: 'pass' });
  const current = await readFile(path.join(specDir, 'tasks.md'), 'utf8');
  await writeFile(path.join(specDir, 'tasks.md'), current.replace('- [ ] 2.', '- [x] 2.'));
  const completed = await service.call('spec_task_complete', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch, workspaceRevision: 'sha256:after', summary: 'must stop' });
  assert.equal(completed.code, 'RECOVERY_REQUIRED');
  assert.equal((await service.call('spec_status', { spec })).recovery.code, 'RECOVERY_REQUIRED');
});

test('begin 不能跳过计划中的前置任务', async () => {
  const { service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'all', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '2', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  assert.equal(begun.code, 'DEPENDENCY_NOT_MET');
});

test('MCP 单任务规划在没有 Dependencies 注记时仍检查前序 wave', async () => {
  const { service } = await setup({ tasksContent: tasks.replace('  _Dependencies:_ 1\n', '') });
  const blocked = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '2', workspaceRevision: 'sha256:before' });
  assert.equal(blocked.code, 'DEPENDENCY_NOT_MET');
  assert.deepEqual((await service.call('spec_task_plan', { spec, scope: 'all', workspaceRevision: 'sha256:before' })).taskIds, ['1', '2']);
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  const checked = await service.call('spec_task_record_check', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, command: 'test', exitCode: 0, summary: 'pass' });
  const completed = await service.call('spec_task_complete', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch, workspaceRevision: 'sha256:after', summary: 'first complete' });
  assert.equal(completed.completedTaskId, '1');
  const next = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '2', workspaceRevision: 'sha256:after' });
  assert.deepEqual(next.taskIds, ['2']);
});

test('等价路径不能创建第二套 state 绕过活动 lease', async () => {
  const { service } = await setup();
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  const bypass = await service.call('spec_adopt', { spec: `${spec.replace(/\/[^/]+$/, '')}/./${spec.split('/').at(-1)}`, workflow: 'requirements-first' });
  assert.equal(bypass.code, 'INVALID_FEATURE_NAME');
  assert.ok(begun.ownerToken);
});

test('status 只读取 Task Dependency Graph 中的 waves', async () => {
  const { specDir, service } = await setup();
  const current = await readFile(path.join(specDir, 'tasks.md'), 'utf8');
  await writeFile(path.join(specDir, 'tasks.md'), current.replace('## Tasks', '```json\n{"example": true}\n```\n\n## Tasks'));
  const status = await service.call('spec_status', { spec });
  assert.deepEqual(status.waves.map((wave) => wave.id), [0, 1]);
});

test('第三次失败后持续阻断 plan/begin，不再签发 owner', async () => {
  const { service } = await setup();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: `sha256:before-${attempt}` });
    const begun = await service.call('spec_task_begin', {
      spec, taskId: '1', planRevision: plan.planRevision,
      expectedStateEpoch: plan.stateEpoch, workspaceRevision: `sha256:before-${attempt}`
    });
    await service.call('spec_task_fail', {
      spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, summary: `failed ${attempt}`
    });
  }
  assert.equal((await service.call('spec_task_plan', {
    spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:blocked'
  })).code, 'HUMAN_REVIEW_REQUIRED');
  const status = await service.call('spec_status', { spec });
  assert.equal((await service.call('spec_task_reset_failures', { spec, taskId: '1', expectedStateEpoch: status.stateEpoch, confirmationText: '继续' })).code, 'CONFIRMATION_TEXT_INVALID');
  const reset = await service.call('spec_task_reset_failures', { spec, taskId: '1', expectedStateEpoch: status.stateEpoch, confirmationText: '确认重置任务 1' });
  assert.equal(reset.reset, true);
  assert.equal((await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:after-review' })).code, undefined);
});

test('多 service 实例不能用旧状态复活已完成任务', async () => {
  const { root, service } = await setup();
  const second = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', {
    spec, taskId: '1', planRevision: plan.planRevision,
    expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before'
  });
  await second.call('spec_status', { spec });
  await service.call('spec_task_record_check', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch,
    command: 'npm test', exitCode: 0, summary: 'pass'
  });
  const afterCheck = await service.call('spec_status', { spec });
  await service.call('spec_task_complete', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: afterCheck.stateEpoch,
    workspaceRevision: 'sha256:after', summary: 'done'
  });
  const stale = await second.call('spec_task_record_check', {
    spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch,
    command: 'npm test', exitCode: 0, summary: 'stale'
  });
  assert.ok(['STATE_EPOCH_CONFLICT', 'TASK_NOT_ACTIVE'].includes(stale.code));
  assert.equal((await second.call('spec_status', { spec })).execution.activeTask, null);
});

test('两个 service 并发 begin 只有一个能取得 owner', async () => {
  const { root, service } = await setup();
  const second = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const firstPlan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const secondPlan = await second.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const results = await Promise.all([
    service.call('spec_task_begin', { spec, taskId: '1', planRevision: firstPlan.planRevision, expectedStateEpoch: firstPlan.stateEpoch, workspaceRevision: 'sha256:before' }),
    second.call('spec_task_begin', { spec, taskId: '1', planRevision: secondPlan.planRevision, expectedStateEpoch: secondPlan.stateEpoch, workspaceRevision: 'sha256:before' })
  ]);
  assert.equal(results.filter((result) => result.ownerToken).length, 1);
  assert.equal(results.filter((result) => result.code).length, 1);
});

test('两个 service 并发 complete 只有一个能提交', async () => {
  const { root, service } = await setup();
  const second = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  const checked = await service.call('spec_task_record_check', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, command: 'npm test', exitCode: 0, summary: 'pass' });
  const args = { spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch, workspaceRevision: 'sha256:after', summary: 'done' };
  const results = await Promise.all([service.call('spec_task_complete', args), second.call('spec_task_complete', args)]);
  assert.equal(results.filter((result) => result.completedTaskId === '1').length, 1);
  assert.equal(results.filter((result) => result.code).length, 1);
});

test('过期 owner 不能调用 fail 绕过恢复流程', async () => {
  let clock = 1000;
  const { service } = await setup({ now: () => clock });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  clock = begun.leaseExpiresAt + 1;
  assert.equal((await service.call('spec_task_fail', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, summary: 'stale fail' })).code, 'LEASE_EXPIRED');
});

test('过期接管必须保持 begin journal 的 Markdown event 证据', async () => {
  let clock = 1000;
  const { specDir, service } = await setup({ now: () => clock });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  const current = await readFile(path.join(specDir, 'tasks.md'), 'utf8');
  await writeFile(path.join(specDir, 'tasks.md'), current.replace(/\n<!-- kiro-spec:execution-events:v1:start -->[\s\S]*?<!-- kiro-spec:execution-events:v1:end -->\n/, '\n'));
  clock = begun.leaseExpiresAt + 1;
  const recovered = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: begun.stateEpoch, workspaceRevision: 'sha256:before', recoverExpired: true });
  assert.equal(recovered.code, 'RECOVERY_REQUIRED');
});

test('begin 在 Markdown 落盘后崩溃，重启会暴露并可显式恢复 journal', async () => {
  let injected = false;
  const { root, service } = await setup({ fault: async (point, context) => {
    if (!injected && point === 'afterTaskMarkdownWrite' && context.action === 'task_begin') { injected = true; throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' }); }
  } });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  assert.equal((await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' })).code, 'INJECTED_CRASH');
  const restarted = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  assert.equal((await restarted.call('spec_status', { spec })).recovery.reason, 'orphaned_begin');
  const recovered = await restarted.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before', recoverExpired: true });
  assert.equal(recovered.recovered, true);
  assert.ok(recovered.ownerToken);
  const checked = await restarted.call('spec_task_record_check', { spec, ownerToken: recovered.ownerToken, expectedStateEpoch: recovered.stateEpoch, command: 'npm test', exitCode: 0, summary: 'pass' });
  const completed = await restarted.call('spec_task_complete', { spec, ownerToken: recovered.ownerToken, expectedStateEpoch: checked.stateEpoch, workspaceRevision: 'sha256:after', summary: 'recovered completion' });
  assert.equal(completed.completedTaskId, '1');
});

test('complete 在 Markdown 落盘后崩溃，重启 status 根据 journal 前滚 state', async () => {
  let injected = false;
  const { root, service } = await setup({ fault: async (point, context) => {
    if (!injected && point === 'afterTaskMarkdownWrite' && context.action === 'task_complete') { injected = true; throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' }); }
  } });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  const checked = await service.call('spec_task_record_check', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, command: 'npm test', exitCode: 0, summary: 'pass' });
  assert.equal((await service.call('spec_task_complete', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch, workspaceRevision: 'sha256:after', summary: 'done' })).code, 'INJECTED_CRASH');
  const restarted = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const status = await restarted.call('spec_status', { spec });
  assert.equal(status.execution.activeTask, null);
  assert.deepEqual(status.execution.completedTaskIds, ['1']);
  assert.equal(status.recovery, null);
});

test('fail 在 Markdown 落盘后崩溃，重启 status 根据 journal 前滚失败计数', async () => {
  let injected = false;
  const { root, service } = await setup({ fault: async (point, context) => {
    if (!injected && point === 'afterTaskMarkdownWrite' && context.action === 'task_fail') { injected = true; throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' }); }
  } });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  assert.equal((await service.call('spec_task_fail', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, summary: 'failed' })).code, 'INJECTED_CRASH');
  const restarted = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const status = await restarted.call('spec_status', { spec });
  assert.equal(status.execution.activeTask, null);
  assert.equal(status.execution.attemptsByTask['1'], 1);
  assert.equal(status.recovery, null);
});

test('complete journal 落盘但 Markdown 未写时，不冒认外部 [x] 为插件提交', async () => {
  let injected = false;
  const { root, specDir, service } = await setup({ fault: async (point, context) => {
    if (!injected && point === 'afterTaskJournalWrite' && context.action === 'task_complete') { injected = true; throw Object.assign(new Error('injected crash'), { code: 'INJECTED_CRASH' }); }
  } });
  const plan = await service.call('spec_task_plan', { spec, scope: 'task', taskId: '1', workspaceRevision: 'sha256:before' });
  const begun = await service.call('spec_task_begin', { spec, taskId: '1', planRevision: plan.planRevision, expectedStateEpoch: plan.stateEpoch, workspaceRevision: 'sha256:before' });
  const checked = await service.call('spec_task_record_check', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: begun.stateEpoch, command: 'npm test', exitCode: 0, summary: 'pass' });
  assert.equal((await service.call('spec_task_complete', { spec, ownerToken: begun.ownerToken, expectedStateEpoch: checked.stateEpoch, workspaceRevision: 'sha256:after', summary: 'must not be borrowed' })).code, 'INJECTED_CRASH');
  const current = await readFile(path.join(specDir, 'tasks.md'), 'utf8');
  await writeFile(path.join(specDir, 'tasks.md'), current.replace('- [-] 1.', '- [x] 1.'));
  const restarted = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const status = await restarted.call('spec_status', { spec });
  assert.equal(status.recovery.reason, 'journal_state_mismatch');
  assert.deepEqual(status.execution.completedTaskIds, []);
});
