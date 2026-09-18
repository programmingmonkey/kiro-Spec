import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginTaskExecution,
  completeTaskExecution,
  createTaskPlan,
  failTaskExecution,
  recordTaskCheck,
  updateTaskState
} from '../lib/core/task-execution.mjs';

const markdown = `# Implementation Plan

## Tasks

- [x] 1. Prepare
  _Requirements:_ 1
- [ ] 2. Build
  _Requirements:_ 2
  _Dependencies:_ 1
- [ ] 3. Verify
  _Requirements:_ 3
  _Dependencies:_ 2
`;

const waves = [{ id: 0, tasks: ['1'] }, { id: 1, tasks: ['2', '3'] }];

test('计划按 scope 选择未完成叶子任务并验证依赖', () => {
  assert.deepEqual(createTaskPlan({ markdown, waves, scope: 'task', taskId: '2' }).taskIds, ['2']);
  assert.deepEqual(createTaskPlan({ markdown, waves, scope: 'all' }).taskIds, ['2', '3']);
  assert.equal(createTaskPlan({ markdown, waves, scope: 'task', taskId: '3' }).code, 'DEPENDENCY_NOT_MET');
  assert.equal(createTaskPlan({ markdown, waves, scope: 'wave', waveId: 99 }).code, 'WAVE_NOT_FOUND');
  assert.match(createTaskPlan({ markdown, waves, scope: 'all' }).planRevision, /^sha256:/);
});

test('不能计划尚未完成前置 wave 的任务', () => {
  const independent = `- [ ] 1. Collect\n  _Requirements:_ 1\n- [ ] 2. Render\n  _Requirements:_ 2\n`;
  assert.equal(createTaskPlan({ markdown: independent, waves: [{ id: 0, tasks: ['1'] }, { id: 1, tasks: ['2'] }], scope: 'wave', waveId: 1 }).code, 'DEPENDENCY_NOT_MET');
});

test('单任务规划同样遵守前序 wave，且不要求同 wave 无依赖任务先完成', () => {
  const independent = '- [ ] 1. Collect\n- [ ] 2. Render\n- [ ] 3. Export\n';
  const graph = [{ id: 0, tasks: ['1'] }, { id: 1, tasks: ['2', '3'] }];
  const blocked = createTaskPlan({ markdown: independent, waves: graph, scope: 'task', taskId: '3' });
  assert.equal(blocked.code, 'DEPENDENCY_NOT_MET');
  assert.deepEqual(createTaskPlan({ markdown: independent.replace('[ ] 1.', '[x] 1.'), waves: graph, scope: 'task', taskId: '3' }).taskIds, ['3']);
  assert.deepEqual(createTaskPlan({ markdown: independent, scope: 'task', taskId: '3' }).taskIds, ['3']);
});

test('不明活动 checkbox 阻止生成新计划', () => {
  const active = markdown.replace('- [ ] 2.', '- [-] 2.');
  assert.equal(createTaskPlan({ markdown: active, waves, scope: 'all' }).code, 'RECOVERY_REQUIRED');
});

test('checkbox 更新只允许精确的单任务合法迁移', () => {
  const begun = updateTaskState(markdown, '2', ' ', '-');
  assert.match(begun, /- \[-\] 2\. Build/);
  assert.match(updateTaskState(begun, '2', '-', 'x'), /- \[x\] 2\. Build/);
  assert.throws(() => updateTaskState(markdown, '2', '-', 'x'), /TASK_STATE_CONFLICT/);
  assert.throws(() => updateTaskState(markdown, '99', ' ', '-'), /TASK_NOT_FOUND/);
});

test('checkbox 更新支持 Kiro 无尾点子任务且保留其行格式', () => {
  const canonical = `- [ ] 1. Parent
  - [ ]* 1.1 Child
    - _Requirements: 1.1_
`;
  const begun = updateTaskState(canonical, '1.1', ' ', '-');
  assert.match(begun, /- \[-\]\* 1\.1 Child/);
  assert.match(updateTaskState(begun, '1.1', '-', 'x'), /- \[x\]\* 1\.1 Child/);
});

test('checkbox 更新跳过代码围栏中的同 ID Kiro 示例', () => {
  const markdown = `\`\`\`md
  - [ ] 1.1 Example only
\`\`\`
- [ ] 1. Parent
  - [ ] 1.1 Real task
`;
  const updated = updateTaskState(markdown, '1.1', ' ', '-');
  assert.match(updated, /- \[ \] 1\.1 Example only/);
  assert.match(updated, /- \[-\] 1\.1 Real task/);
});

test('checkbox 更新跳过缩进代码围栏中的同 ID Kiro 示例', () => {
  const markdown = `   \`\`\`md
- [ ] 1.1 Example only
   \`\`\`
- [ ] 1. Parent
  - [ ] 1.1 Real task
`;
  const updated = updateTaskState(markdown, '1.1', ' ', '-');
  assert.match(updated, /- \[ \] 1\.1 Example only/);
  assert.match(updated, /- \[-\] 1\.1 Real task/);
});

test('checkbox 更新不会被四空格缩进代码块阻断', () => {
  const markdown = `    \`\`\`md
- [ ] 1. Real task
`;
  assert.match(updateTaskState(markdown, '1', ' ', '-'), /- \[-\] 1\. Real task/);
});

test('checkbox 更新跳过任务列表容器内的四空格围栏示例', () => {
  const markdown = `- [ ] 1. Parent
    \`\`\`md
    - [ ] 1.1 Example only
    \`\`\`
  - [ ] 1.1 Real task
`;
  const updated = updateTaskState(markdown, '1.1', ' ', '-');
  assert.match(updated, /- \[ \] 1\.1 Example only/);
  assert.match(updated, /- \[-\] 1\.1 Real task/);
});

test('checkbox 更新跳过深层任务回退到父级容器后的围栏示例', () => {
  const markdown = `- [ ] 1. Root
  - [ ] 1.1 Mid
    - [ ] 1.1.1 Parent
      - [ ] 1.1.1.1 Inner
    \`\`\`md
    - [ ] 1.1.1.2 Example only
    \`\`\`
    - [ ] 1.1.1.2 Real task
`;
  const updated = updateTaskState(markdown, '1.1.1.2', ' ', '-');
  assert.match(updated, /- \[ \] 1\.1\.1\.2 Example only/);
  assert.match(updated, /- \[-\] 1\.1\.1\.2 Real task/);
});

test('checkbox 更新不会被未闭合的缩进围栏候选阻断', () => {
  const markdown = `- [ ] 1. First task
    \`\`\`md
- [ ] 2. Real task
`;
  assert.match(updateTaskState(markdown, '2', ' ', '-'), /- \[-\] 2\. Real task/);
});

test('checkbox 更新不会把无关围栏当作缩进候选的闭合标记', () => {
  const markdown = `- [ ] 1. First task
    \`\`\`md
- [ ] 2. Real task
\`\`\`json
{}
\`\`\`
`;
  assert.match(updateTaskState(markdown, '2', ' ', '-'), /- \[-\] 2\. Real task/);
});

test('执行状态要求 owner 和成功检查，完成后关闭 active task', () => {
  const begun = beginTaskExecution({ execution: {}, taskId: '2', ownerTokenHash: 'sha256:owner', leaseExpiresAt: 2000, workspaceRevision: 'sha256:before' });
  assert.equal(begun.activeTask.taskId, '2');

  const wrong = recordTaskCheck({ execution: begun, ownerTokenHash: 'sha256:wrong', command: 'npm test', exitCode: 0, summary: 'pass' });
  assert.equal(wrong.code, 'OWNER_TOKEN_INVALID');

  const checked = recordTaskCheck({ execution: begun, ownerTokenHash: 'sha256:owner', command: 'npm test', exitCode: 0, summary: 'pass' });
  const completed = completeTaskExecution({ execution: checked, ownerTokenHash: 'sha256:owner', workspaceRevision: 'sha256:after', summary: 'done' });
  assert.equal(completed.activeTask, null);
  assert.equal(completed.lastCompleted.taskId, '2');
});

test('无成功检查、无工作区变化与三次失败均 fail closed', () => {
  const begun = beginTaskExecution({ execution: {}, taskId: '2', ownerTokenHash: 'sha256:owner', leaseExpiresAt: 2000, workspaceRevision: 'sha256:same' });
  assert.equal(completeTaskExecution({ execution: begun, ownerTokenHash: 'sha256:owner', workspaceRevision: 'sha256:after', summary: 'done' }).code, 'CHECK_REQUIRED');
  const checked = recordTaskCheck({ execution: begun, ownerTokenHash: 'sha256:owner', command: 'npm test', exitCode: 0, summary: 'pass' });
  assert.equal(completeTaskExecution({ execution: checked, ownerTokenHash: 'sha256:owner', workspaceRevision: 'sha256:same', summary: 'done' }).code, 'NO_WORKSPACE_CHANGE');

  let execution = begun;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failed = failTaskExecution({ execution, ownerTokenHash: 'sha256:owner', summary: `failed ${attempt}` });
    if (attempt < 3) {
      assert.equal(failed.activeTask, null);
      execution = beginTaskExecution({ execution: failed, taskId: '2', ownerTokenHash: 'sha256:owner', leaseExpiresAt: 2000, workspaceRevision: 'sha256:same' });
    } else {
      assert.equal(failed.code, 'HUMAN_REVIEW_REQUIRED');
      assert.equal(failed.execution.attemptsByTask['2'], 3);
    }
  }
});

test('all 拒绝遗漏或重复任务的 waves', () => {
  assert.equal(createTaskPlan({ markdown, waves: [{ id: 0, tasks: ['1', '2'] }], scope: 'all' }).code, 'INVALID_FORMAT');
  assert.equal(createTaskPlan({ markdown, waves: [{ id: 0, tasks: ['1', '2', '2', '3'] }], scope: 'all' }).code, 'INVALID_FORMAT');
});

test('verification 任务在成功检查后允许 workspace revision 不变', () => {
  const begun = beginTaskExecution({ execution: {}, taskId: '3', taskType: 'verification', ownerTokenHash: 'sha256:owner', leaseExpiresAt: 2000, workspaceRevision: 'sha256:same' });
  const checked = recordTaskCheck({ execution: begun, ownerTokenHash: 'sha256:owner', command: 'npm test', exitCode: 0, summary: 'pass' });
  assert.equal(completeTaskExecution({ execution: checked, ownerTokenHash: 'sha256:owner', workspaceRevision: 'sha256:same', summary: 'verified' }).code, undefined);
});
