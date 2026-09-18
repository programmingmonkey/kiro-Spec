import assert from 'node:assert/strict';
import test from 'node:test';

import { toolNames, tools, validateToolArguments } from '../lib/mcp/tools.mjs';

test('工具目录为每个操作暴露独立描述、完整必填参数与封闭 schema', () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.equal(toolNames.length, 25);
  assert.equal(new Set(tools.map((tool) => tool.description)).size, tools.length);
  assert.deepEqual(byName.get('spec_write').inputSchema.required, [
    'projectRoot', 'spec', 'artifact', 'content', 'expectedRawRevision', 'contextProof'
  ]);
  assert.deepEqual(byName.get('spec_template').inputSchema.required, ['projectRoot', 'workflow', 'artifact']);
  assert.deepEqual(byName.get('spec_validate_artifacts').inputSchema.required, ['projectRoot', 'workflow', 'artifacts']);
  assert.deepEqual(byName.get('spec_sync_apply').inputSchema.required, [
    'projectRoot', 'spec', 'sourceRevisions', 'contextProof', 'confirmationText'
  ]);
  assert.deepEqual(byName.get('spec_sync_apply').inputSchema.properties.sourceRevisions.required, ['requirements', 'design', 'tasks']);
  assert.deepEqual(byName.get('spec_record_analysis').inputSchema.required, ['projectRoot', 'spec', 'findings', 'expectedStateEpoch']);
  assert.deepEqual(byName.get('spec_record_analysis').inputSchema.properties.findings.items.required, [
    'severity', 'artifact', 'location', 'ruleId', 'evidence', 'suggestedAction'
  ]);
  assert.deepEqual(byName.get('spec_record_approval').inputSchema.required, [
    'projectRoot', 'spec', 'artifact', 'expectedStateEpoch', 'confirmationText'
  ]);
  assert.deepEqual(byName.get('spec_init').inputSchema.properties.workflow.enum, ['requirements-first', 'design-first', 'bugfix', 'quick']);
  assert.deepEqual(byName.get('spec_adopt').inputSchema.properties.workflow.enum, ['requirements-first', 'design-first', 'bugfix', 'quick']);
  // T3b（第 9 期）：`workflow` 由必填改为**可选** —— 省略时按 spec 自己的 `.config.kiro` 派生。
  // 两个宿主各有自己的一份 tools.mjs 与本文件，所以这条**必须两边都钉**：只在 claude-spec 钉，
  // codex-spec 单独被改回必填时不会有任何东西响。
  assert.deepEqual(byName.get('spec_adopt').inputSchema.required, ['projectRoot', 'spec']);
  assert.deepEqual(byName.get('spec_write').inputSchema.properties.artifact.enum, ['requirements', 'design', 'tasks', 'bugfix']);
  assert.deepEqual(byName.get('spec_record_approval').inputSchema.properties.artifact.enum, ['requirements', 'design', 'tasks', 'bugfix', 'all']);
  assert.deepEqual(byName.get('spec_request_approval').inputSchema.properties.artifact.enum, ['requirements', 'design', 'tasks', 'bugfix', 'all']);
  assert.deepEqual(byName.get('spec_task_plan').inputSchema.properties.scope.enum, ['task', 'wave', 'all']);
  assert.deepEqual(byName.get('spec_task_plan').inputSchema.required, ['projectRoot', 'spec', 'scope', 'workspaceSnapshot']);
  assert.deepEqual(byName.get('spec_task_begin').inputSchema.required, [
    'projectRoot', 'spec', 'taskId', 'planRevision', 'expectedStateEpoch', 'workspaceSnapshot'
  ]);
  assert.deepEqual(byName.get('spec_task_record_check').inputSchema.required, [
    'projectRoot', 'spec', 'ownerToken', 'expectedStateEpoch', 'command', 'exitCode', 'summary'
  ]);
  assert.deepEqual(byName.get('spec_task_complete').inputSchema.required, [
    'projectRoot', 'spec', 'ownerToken', 'expectedStateEpoch', 'workspaceSnapshot', 'summary'
  ]);
  assert.deepEqual(byName.get('spec_task_fail').inputSchema.required, [
    'projectRoot', 'spec', 'ownerToken', 'expectedStateEpoch', 'summary'
  ]);
  assert.deepEqual(byName.get('spec_task_set').inputSchema.required, ['projectRoot', 'spec', 'taskId', 'state']);
  assert.deepEqual(byName.get('spec_task_set').inputSchema.properties.state.enum, ['pending', 'in-progress', 'done']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.inputSchema.required.includes('projectRoot'), tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
  }
});

test('工具注解区分纯读与共享 Markdown 写入', () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('spec_health').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_list').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_context').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_diagnostics').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_template').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_validate_artifacts').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_analyze').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_quality_preview').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_sync_preview').annotations.readOnlyHint, true);
  assert.equal(byName.get('spec_read').annotations.readOnlyHint, false);
  assert.equal(byName.get('spec_status').annotations.readOnlyHint, false);
  assert.equal(byName.get('spec_task_plan').annotations.readOnlyHint, false);
  assert.equal(byName.get('spec_write').annotations.destructiveHint, true);
  assert.equal(byName.get('spec_sync_apply').annotations.destructiveHint, true);
  assert.equal(byName.get('spec_task_begin').annotations.destructiveHint, true);
  assert.equal(byName.get('spec_task_complete').annotations.destructiveHint, true);
  assert.equal(byName.get('spec_task_set').annotations.destructiveHint, true);
});

test('只写私有状态的工具既不标 readOnly 也不标 destructive', () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('spec_record_analysis').annotations.readOnlyHint, false);
  assert.equal(byName.get('spec_record_analysis').annotations.destructiveHint, false);
  assert.equal(byName.get('spec_record_approval').annotations.readOnlyHint, false);
  assert.equal(byName.get('spec_record_approval').annotations.destructiveHint, false);
});

test('workspaceSnapshot 接受已脏文件的内容摘要', () => {
  const snapshot = {
    head: 'sha256:head', index: 'sha256:index',
    trackedDirty: [{ path: 'src/a.js', contentRevision: 'sha256:before' }],
    untracked: [], untrackedPolicy: 'include', submodules: [],
    lfs: { policy: 'none', pointers: [] }, modes: [], eol: 'lf', platform: 'darwin'
  };
  assert.equal(validateToolArguments('spec_task_plan', {
    projectRoot: '/project', spec: 'demo', scope: 'task', workspaceSnapshot: snapshot
  }), null);
});
