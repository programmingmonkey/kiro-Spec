import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { computeApprovalFingerprint, computeRawRevision } from '../lib/core/revision.mjs';
import { classifyExternalChange, parseExecutionEvents } from '../lib/core/task-events.mjs';
import { createWorkflowState, invalidateApprovals, recordApproval, transitionWorkflow } from '../lib/core/workflow.mjs';

const fixtureRoot = path.resolve(import.meta.dirname, 'fixtures');
const fixture = () => readFile(path.join(fixtureRoot, 'tasks-with-event-v1.md'), 'utf8');

test('rawRevision 对 BOM、CRLF 和尾随空白保持字节敏感', () => {
  const plain = computeRawRevision(Buffer.from('text\n', 'utf8'));
  assert.notEqual(plain, computeRawRevision(Buffer.from('\uFEFFtext\n', 'utf8')));
  assert.notEqual(plain, computeRawRevision(Buffer.from('text\r\n', 'utf8')));
  assert.notEqual(plain, computeRawRevision(Buffer.from('text \n', 'utf8')));
  assert.match(plain, /^sha256:[0-9a-f]{64}$/);
});

test('tasks approvalFingerprint 忽略合法 checkbox 与 execution-event，但保留业务语义', async () => {
  const baseline = await fixture();
  const checkboxChanged = baseline.replace('- [ ] 1.', '- [-] 1.');
  const eventChanged = baseline.replace('"to":"-"', '"to":"x"').replace('"from":" "', '"from":"-"');
  const titleChanged = baseline.replace('Implement the protocol', 'Implement a different protocol');
  const dependencyChanged = baseline.replace('_Dependencies:_ 0.1', '_Dependencies:_ 0.2');
  const waveChanged = baseline.replace('["1"]', '["1", "2"]');
  const noteChanged = baseline.replace('This note is semantic content.', 'This note changed.');
  const fingerprint = computeApprovalFingerprint({ artifact: 'tasks', markdown: baseline });

  assert.equal(fingerprint, computeApprovalFingerprint({ artifact: 'tasks', markdown: checkboxChanged }));
  assert.equal(fingerprint, computeApprovalFingerprint({ artifact: 'tasks', markdown: eventChanged }));
  assert.notEqual(fingerprint, computeApprovalFingerprint({ artifact: 'tasks', markdown: titleChanged }));
  assert.notEqual(fingerprint, computeApprovalFingerprint({ artifact: 'tasks', markdown: dependencyChanged }));
  assert.notEqual(fingerprint, computeApprovalFingerprint({ artifact: 'tasks', markdown: waveChanged }));
  assert.notEqual(fingerprint, computeApprovalFingerprint({ artifact: 'tasks', markdown: noteChanged }));
});

test('Kiro canonical 子任务的 checkbox 变化不改变 tasks 审批指纹', () => {
  const pending = `# Implementation Plan

## Tasks

- [ ] 1. Parent
  - [ ] 1.1 Child
    - _Requirements: 1.1_
`;
  const active = pending.replace('[ ] 1.1', '[-] 1.1');
  assert.equal(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: active })
  );
});

test('根级 Kiro dotted task 的 checkbox 变化不改变 tasks 审批指纹', () => {
  const pending = `# Implementation Plan

## Tasks

- [ ] 1.1 Root-level child syntax
  - _Requirements: 1.1_
`;
  const completed = pending.replace('[ ] 1.1', '[x] 1.1');
  assert.equal(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: completed })
  );
});

test('parser 接受的非规范缩进子任务其 checkbox 变化同样不改变 tasks 审批指纹', () => {
  const pending = `# Implementation Plan

## Tasks

- [ ] 1. Parent
    - [ ] 1.1 Child
      - _Requirements: 1.1_
`;
  const active = pending.replace('[ ] 1.1', '[-] 1.1');
  assert.equal(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: active })
  );
});

test('非法 execution-event 不会被忽略', async () => {
  const invalid = (await fixture()).replace('"kind":"task-transition"', '"kind":"unexpected"');
  const parsed = parseExecutionEvents(invalid);
  assert.equal(parsed.valid, false);
  assert.notEqual(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: await fixture() }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: invalid })
  );
});

test('execution-event delimiter 必须独占一行', () => {
  assert.equal(parseExecutionEvents('prefix<!-- kiro-spec:execution-events:v1:start -->').valid, false);
  assert.equal(parseExecutionEvents('<!-- kiro-spec:execution-events:v1:end -->suffix').valid, false);
});

test('semantic-v2 忽略合法 event block 的位置与空白表示，但不忽略正文', async () => {
  const withEvent = await fixture();
  const block = /\n<!-- kiro-spec:execution-events:v1:start -->[\s\S]*?<!-- kiro-spec:execution-events:v1:end -->\n/;
  const withoutEvent = withEvent.replace(block, '\n');
  const movedEvent = withoutEvent.replace('## Notes\n', `<!-- kiro-spec:execution-events:v1:start -->\n{"schemaVersion":1,"events":[{"id":"8c2f8f72-9f8e-4e6c-a059-2e31fe1d0d1e","taskId":"1","from":" ","to":"-","kind":"task-transition"}]}\n<!-- kiro-spec:execution-events:v1:end -->\n\n## Notes\n`);
  const formattingOnly = withoutEvent.replace('# Implementation Plan', '# Implementation Plan   ').replace('\n\n## Tasks', '\n\n\n## Tasks');
  assert.equal(computeApprovalFingerprint({ artifact: 'tasks', markdown: withoutEvent }), computeApprovalFingerprint({ artifact: 'tasks', markdown: movedEvent }));
  assert.equal(computeApprovalFingerprint({ artifact: 'tasks', markdown: withoutEvent }), computeApprovalFingerprint({ artifact: 'tasks', markdown: formattingOnly }));
});

test('semantic-v2 不会把代码围栏内的伪任务 checkbox 当作可忽略状态', async () => {
  const pending = '# Requirements\n\n```md\n- [ ] 1. This is documentation, not a task\n```\n';
  const done = pending.replace('- [ ]', '- [x]');
  assert.notEqual(computeApprovalFingerprint({ artifact: 'requirements', markdown: pending }), computeApprovalFingerprint({ artifact: 'requirements', markdown: done }));
});

test('semantic-v2 保留缩进代码围栏内的伪任务 checkbox', () => {
  const pending = '   ```md\n- [ ] 1.1 Documentation\n   ```\n';
  const done = pending.replace('[ ]', '[x]');
  assert.notEqual(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: done })
  );
});

test('semantic-v2 不会让四空格缩进代码块吞掉后续任务语义', () => {
  const baseline = '    ```md\n- [ ] 1. Real task\n';
  const retitled = baseline.replace('Real task', 'Different task');
  assert.notEqual(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: baseline }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: retitled })
  );
});

test('semantic-v2 保留任务列表容器内四空格围栏示例的 checkbox', () => {
  const pending = '- [ ] 1. Parent\n    ```md\n    - [ ] 1.1 Documentation\n    ```\n';
  const done = pending.replace('[ ] 1.1', '[x] 1.1');
  assert.notEqual(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: done })
  );
});

test('semantic-v2 保留深层任务回退到父级容器后的围栏示例 checkbox', () => {
  const pending = `- [ ] 1. Root
  - [ ] 1.1 Mid
    - [ ] 1.1.1 Parent
      - [ ] 1.1.1.1 Inner
    \`\`\`md
    - [ ] 1.1.1.2 Documentation
    \`\`\`
    - [ ] 1.1.1.2 Real task
`;
  const changedExample = pending.replace('[ ] 1.1.1.2 Documentation', '[x] 1.1.1.2 Documentation');
  assert.notEqual(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: changedExample })
  );
});

test('semantic-v2 不让未闭合的缩进围栏候选吞掉后续任务语义', () => {
  const pending = '- [ ] 1. First task\n    ```md\n- [ ] 2. Real task\n';
  const retitled = pending.replace('Real task', 'Different task');
  assert.notEqual(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: retitled })
  );
});

test('semantic-v2 不让缩进围栏候选跨越更浅任务吞掉语义', () => {
  const pending = '- [ ] 1. First task\n    ```md\n- [ ] 2. Real task\n```json\n{}\n```\n';
  const retitled = pending.replace('Real task', 'Different task');
  assert.notEqual(
    computeApprovalFingerprint({ artifact: 'tasks', markdown: pending }),
    computeApprovalFingerprint({ artifact: 'tasks', markdown: retitled })
  );
});

test('只有 tasks artifact 可忽略任务 checkbox，且两种 Markdown fence 都保留代码状态', () => {
  const requirementPending = '# Requirements\n\n- [ ] 1. A decision\n';
  const tildePending = '# Implementation Plan\n\n~~~md\n- [ ] 1. Documentation\n~~~\n';
  assert.notEqual(computeApprovalFingerprint({ artifact: 'requirements', markdown: requirementPending }), computeApprovalFingerprint({ artifact: 'requirements', markdown: requirementPending.replace('[ ]', '[x]') }));
  assert.notEqual(computeApprovalFingerprint({ artifact: 'tasks', markdown: tildePending }), computeApprovalFingerprint({ artifact: 'tasks', markdown: tildePending.replace('[ ]', '[x]') }));
});

test('semantic-v2 保留正文段落边界和嵌套围栏中的 JSON 表示', () => {
  const paragraphs = '# Requirements\n\nFirst paragraph.\n\nSecond paragraph.\n';
  const merged = paragraphs.replace('First paragraph.\n\nSecond', 'First paragraph.\nSecond');
  const codeA = '````md\n# Task Dependency Graph\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n````\n';
  const codeB = codeA.replace('{"waves":[{"id":0,"tasks":["1"]}]}', '{\n  "waves": [ { "id": 0, "tasks": [ "1" ] } ]\n}');
  assert.notEqual(computeApprovalFingerprint({ artifact: 'requirements', markdown: paragraphs }), computeApprovalFingerprint({ artifact: 'requirements', markdown: merged }));
  assert.notEqual(computeApprovalFingerprint({ artifact: 'tasks', markdown: codeA }), computeApprovalFingerprint({ artifact: 'tasks', markdown: codeB }));
});

test('semantic-v2 不把顶级缩进代码块中的伪任务当作合法 checkbox', () => {
  const code = '# Implementation Plan\n\n    - [ ] 1. Documentation example\n';
  assert.notEqual(computeApprovalFingerprint({ artifact: 'tasks', markdown: code }), computeApprovalFingerprint({ artifact: 'tasks', markdown: code.replace('[ ]', '[x]') }));
  const nestedCode = '# Implementation Plan\n\n    - [ ] 1.1.1. Documentation example\n';
  assert.notEqual(computeApprovalFingerprint({ artifact: 'tasks', markdown: nestedCode }), computeApprovalFingerprint({ artifact: 'tasks', markdown: nestedCode.replace('[ ]', '[x]') }));
});

test('semantic-v2 对等价 waves JSON 格式稳定', async () => {
  const formatted = await fixture();
  const compact = formatted.replace('{\n  "waves": [\n    { "id": 0, "tasks": ["1"] }\n  ]\n}', '{"waves":[{"id":0,"tasks":["1"]}]}');
  assert.equal(computeApprovalFingerprint({ artifact: 'tasks', markdown: formatted }), computeApprovalFingerprint({ artifact: 'tasks', markdown: compact }));
});

test('四工作流只允许各自的相邻 phase，并使用 stateEpoch CAS', () => {
  const expectedPhases = {
    'requirements-first': ['requirements_draft', 'requirements_approved', 'design_draft', 'design_approved', 'tasks_draft', 'tasks_approved', 'implementing', 'validating', 'complete'],
    'design-first': ['design_draft', 'design_approved', 'requirements_draft', 'requirements_approved', 'tasks_draft', 'tasks_approved', 'implementing', 'validating', 'complete'],
    bugfix: ['bug_analysis_draft', 'bug_analysis_approved', 'root_cause_design_draft', 'design_approved', 'tasks_draft', 'tasks_approved', 'implementing', 'validating', 'complete'],
    quick: ['clarifying', 'artifacts_generated', 'overall_review', 'approved', 'implementing', 'validating', 'complete']
  };
  for (const [workflow, phases] of Object.entries(expectedPhases)) {
    let state = createWorkflowState({ workflow });
    assert.equal(state.phase, 'initialized');
    for (const phase of phases) {
      const approval = { requirements_approved: 'requirements', design_approved: 'design', bug_analysis_approved: 'bugfix', tasks_approved: 'tasks', approved: 'all' }[phase];
      if (approval) state = recordApproval({ state, artifact: approval, expectedStateEpoch: state.stateEpoch });
      state = transitionWorkflow({ state, to: phase, expectedStateEpoch: state.stateEpoch });
      assert.equal(state.phase, phase);
    }
    assert.equal(transitionWorkflow({ state, to: 'complete', expectedStateEpoch: state.stateEpoch - 1 }).code, 'STATE_EPOCH_CONFLICT');
  }
  const initial = createWorkflowState({ workflow: 'requirements-first' });
  assert.equal(transitionWorkflow({ state: initial, to: 'design_draft', expectedStateEpoch: 0 }).code, 'INVALID_STATE_TRANSITION');
  let awaitingApproval = transitionWorkflow({ state: initial, to: 'requirements_draft', expectedStateEpoch: 0 });
  assert.equal(transitionWorkflow({ state: awaitingApproval, to: 'requirements_approved', expectedStateEpoch: awaitingApproval.stateEpoch }).code, 'APPROVAL_REQUIRED');
  assert.equal(recordApproval({ state: initial, artifact: 'requirements', expectedStateEpoch: 0 }).code, 'APPROVAL_NOT_AVAILABLE');
  assert.equal(transitionWorkflow({ state: { ...initial, phase: 'unknown' }, to: 'initialized', expectedStateEpoch: 0 }).code, 'INVALID_WORKFLOW_STATE');
});

test('审批失效沿既定矩阵传播，quick 作为一个整体 group', () => {
  const makeState = (workflow, approvals) => ({ ...createWorkflowState({ workflow }), approvals, stateEpoch: 8 });
  assert.deepEqual(invalidateApprovals({ state: makeState('requirements-first', { requirements: 'granted', design: 'granted', tasks: 'granted' }), changedArtifact: 'requirements', expectedStateEpoch: 8 }).approvals, { requirements: 'invalidated', design: 'invalidated', tasks: 'invalidated' });
  assert.deepEqual(invalidateApprovals({ state: makeState('design-first', { requirements: 'granted', design: 'granted', tasks: 'granted' }), changedArtifact: 'requirements', expectedStateEpoch: 8 }).approvals, { requirements: 'invalidated', design: 'granted', tasks: 'invalidated' });
  assert.deepEqual(invalidateApprovals({ state: makeState('bugfix', { bugfix: 'granted', design: 'granted', tasks: 'granted' }), changedArtifact: 'design', expectedStateEpoch: 8 }).approvals, { bugfix: 'granted', design: 'invalidated', tasks: 'invalidated' });
  const quick = invalidateApprovals({ state: makeState('quick', { requirements: 'granted', design: 'granted', tasks: 'granted' }), changedArtifact: 'tasks', expectedStateEpoch: 8 });
  assert.deepEqual(quick.approvals, { requirements: 'invalidated', design: 'invalidated', tasks: 'invalidated' });
  assert.equal(quick.stateEpoch, 9);
  assert.equal(invalidateApprovals({ state: makeState('quick', { requirements: 'granted', design: 'granted', tasks: 'granted' }), changedArtifact: 'tasks', expectedStateEpoch: 7 }).code, 'STATE_EPOCH_CONFLICT');
  const approvedTasks = { ...makeState('requirements-first', { requirements: 'granted', design: 'granted', tasks: 'granted' }), phase: 'tasks_approved' };
  const invalidatedTasks = invalidateApprovals({ state: approvedTasks, changedArtifact: 'tasks', expectedStateEpoch: 8 });
  assert.equal(invalidatedTasks.phase, 'tasks_draft');
  assert.equal(recordApproval({ state: invalidatedTasks, artifact: 'tasks', expectedStateEpoch: invalidatedTasks.stateEpoch }).approvals.tasks, 'granted');
  assert.equal(transitionWorkflow({ state: { schemaVersion: 1, workflow: 'bad', phase: 'initialized', stateEpoch: 0, approvals: {} }, to: 'anything', expectedStateEpoch: 0 }).code, 'INVALID_WORKFLOW_STATE');
  assert.equal(recordApproval({ state: { ...makeState('requirements-first', { requirements: 'invalidated', design: 'granted', tasks: 'pending' }), phase: 'tasks_draft' }, artifact: 'tasks', expectedStateEpoch: 8 }).code, 'INVALID_WORKFLOW_STATE');
});

test('外部变更将 raw-only、已对账 transition、未对账 transition 与执行中语义变化分开', async () => {
  const baseline = await fixture();
  const block = /\n<!-- kiro-spec:execution-events:v1:start -->[\s\S]*?<!-- kiro-spec:execution-events:v1:end -->\n/;
  const withoutEvent = baseline.replace(block, '\n');
  const checkboxChanged = withoutEvent.replace('- [ ] 1.', '- [-] 1.') + '\n<!-- kiro-spec:execution-events:v1:start -->\n{"schemaVersion":1,"events":[{"id":"8c2f8f72-9f8e-4e6c-a059-2e31fe1d0d1e","taskId":"1","from":" ","to":"-","kind":"task-transition"}]}\n<!-- kiro-spec:execution-events:v1:end -->\n';
  const extraEvent = checkboxChanged.replace('}]}\n<!--', '},{"id":"7fcb2e7a-9522-4bcb-aefb-a7e8f03c3d61","taskId":"1","from":"-","to":"x","kind":"task-transition"}]}\n<!--');
  const eventChanged = baseline.replace('"from":" "', '"from":"-"').replace('"to":"-"', '"to":"x"');
  const titleChanged = baseline.replace('Implement the protocol', 'Implement another protocol');

  assert.equal(classifyExternalChange({ previousMarkdown: baseline, currentMarkdown: `${baseline}\n`, phase: 'tasks_approved' }).disposition, 'reread_required');
  assert.equal(classifyExternalChange({ previousMarkdown: withoutEvent, currentMarkdown: checkboxChanged, phase: 'implementing', journalEvidence: [{ taskId: '1', from: ' ', to: '-', eventId: '8c2f8f72-9f8e-4e6c-a059-2e31fe1d0d1e' }] }).disposition, 'legal_execution_transition');
  assert.equal(classifyExternalChange({ previousMarkdown: withoutEvent, currentMarkdown: extraEvent, phase: 'implementing', journalEvidence: [{ taskId: '1', from: ' ', to: '-', eventId: '8c2f8f72-9f8e-4e6c-a059-2e31fe1d0d1e' }] }).disposition, 'recovery_required');
  assert.equal(classifyExternalChange({ previousMarkdown: withoutEvent, currentMarkdown: checkboxChanged, phase: 'tasks_draft', journalEvidence: [{ taskId: '1', from: ' ', to: '-', eventId: '8c2f8f72-9f8e-4e6c-a059-2e31fe1d0d1e' }] }).disposition, 'recovery_required');
  assert.equal(classifyExternalChange({ previousMarkdown: baseline, currentMarkdown: eventChanged, phase: 'implementing' }).disposition, 'recovery_required');
  assert.equal(classifyExternalChange({ previousMarkdown: baseline, currentMarkdown: titleChanged, phase: 'implementing' }).disposition, 'external_change_detected');
});

test('execution-event parser 返回稳定的字节与行 sourceRange', async () => {
  const parsed = parseExecutionEvents(await fixture());
  assert.equal(parsed.valid, true);
  assert.ok(parsed.sourceRange.start.offset < parsed.sourceRange.end.offset);
  assert.ok(parsed.sourceRange.start.line < parsed.sourceRange.end.line);
});
