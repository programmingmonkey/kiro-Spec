import assert from 'node:assert/strict';
import test from 'node:test';

import { toolNames, tools, validateToolArguments } from '../lib/mcp/tools.mjs';

test('工具目录为每个操作暴露独立描述、完整必填参数与封闭 schema', () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.equal(toolNames.length, 26);
  assert.equal(new Set(tools.map((tool) => tool.description)).size, tools.length);
  // `spec_amend` 只有 kind 与 contextProof 是无条件必填：param / requirement / design
  // 三支各自需要的字段不同，写成一张必填清单会让另外两支永远填不出合法参数。
  // 分支内的缺参在服务端逐条拒绝（AMEND_ANCHOR_REQUIRED / AMEND_POINTER_REQUIRED 等）。
  assert.deepEqual(byName.get('spec_amend').inputSchema.required, ['projectRoot', 'spec', 'kind', 'contextProof']);
  assert.deepEqual(byName.get('spec_amend').inputSchema.properties.kind.enum, ['param', 'requirement', 'design']);
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
  // 这条钉的是契约本身：把它加回必填会让「省略即派生」那条路径永远走不到，而**所有**既有
  // 调用点都显式传了 workflow，所以没有别的断言会因此变红（那正是要在这里钉住的原因）。
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

// 🔴 `annotations` 合计 1,684 字节（占 spec 工具面 8.5%），2026-09-16 的 token 对账里
// 一度被当成可删的冗余。**不能删**：`destructiveHint` 是宿主决定要不要弹确认的依据，
// 删掉它等于让 spec_write / spec_amend / spec_task_begin 这些破坏性操作不再提示确认 ——
// 那是拿一道安全闸换 8.5% 的 schema。何况 Claude Code 经 ToolSearch 载入时本就把
// annotations 丢掉了（实测），在那条路径上它一个 token 都不占。本条断言是那次判断的落点。
test('工具注解区分纯读与共享 Markdown 写入', () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('spec_amend').annotations.destructiveHint, true, 'amend 写正文，必须标破坏性');
  assert.equal(byName.get('spec_amend').annotations.readOnlyHint, false);
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
