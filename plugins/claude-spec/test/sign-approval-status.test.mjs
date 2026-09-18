// 署名不得清空审批 —— 这是 `spec-sign-approval-clobber` 的**状态层**判据。
//
// 纯函数层的判据在 `packages/spec-revision/test/approval-signature.test.mjs`（指纹必须不变）。
// 本文件补的是**后果**：即便指纹行为对了，也要证明状态层的反应真的变了 ——
// `observe()` 会因为语义变化执行 `state.approvals = {}`，并把 phase 退回起草阶段。
//
// 🔴 修复前本文件必红。判据取「审批集合 + phase 逐字段相同」，而不是只数个数：
// 少一条审批与全清空是两种不同的失败，混成一个计数会掩盖其中一个。
//
// 说明：这里**直接向磁盘追加一行署名**（不经过任何宿主的写路径），模拟「署名已完成落盘」
// 这一既成事实。真正的跨宿主回归（Kiro/Claude 批准 + DSH 真 `spec_sign`）在
// `sign-approval-cross-host.test.mjs`。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = 'specs/demo';

const requirements = [
  '# Requirements Document', '', '## Introduction', '', 'demo', '',
  '## Requirements', '', '### 1. Widget', '',
  '**User Story:** As a user, I want a widget, so that I have widgets.', '',
  '#### Acceptance Criteria', '1. WHEN asked THE SYSTEM SHALL return a widget', '',
].join('\n');

const design = [
  '# Design Document', '', '## Overview', '', 'widget design', '',
  '## Architecture', '', 'single module', '',
  '## Error Handling', '', 'none', '',
  '## Testing Strategy', '', 'unit tests', '',
  '## Data Models', '', 'widget {}', '',
].join('\n');

const tasks = [
  '# Implementation Plan', '',
  '## Task Dependency Graph', '',
  '```json', '{"waves":[{"id":0,"tasks":["1.1"]}]}', '```', '',
  '## Tasks', '',
  '- [ ] 1. Widget', '  - [ ] 1.1 Build it', '',
  '## Notes', '', '> notes', '',
].join('\n');

const SIGNATURE = '- 2026-09-14 · DSH · 补 Req 1 的属性值域';

async function approvedSpec() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-sign-approval-'));
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  const authority = '# Spec conventions\n\nUse the approved format.\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), authority);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro',
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
  }));
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });

  await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' });
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) {
    const proof = await service.call('spec_context', { spec: SPEC, artifact });
    const written = await service.call('spec_write', { spec: SPEC, artifact, content, contextProof: proof.contextProof });
    assert.equal(written.rawRevision !== undefined, true, `${artifact} 写入失败：${JSON.stringify(written)}`);
    const requested = await service.call('spec_request_approval', { spec: SPEC, artifact });
    const recorded = await service.call('spec_record_approval', {
      spec: SPEC, artifact, expectedStateEpoch: requested.stateEpoch, confirmationText: requested.recommendedPhrase,
    });
    assert.equal(recorded.phase !== undefined, true, `${artifact} 批准失败：${JSON.stringify(recorded)}`);
  }
  return { root, service, tasksPath: path.join(root, '.kiro', 'specs', 'demo', 'tasks.md') };
}

test('🔴 一次合法署名不得清空审批、不得让 phase 退档（修复前必红）', async () => {
  const { root, service, tasksPath } = await approvedSpec();

  const before = await service.call('spec_status', { spec: SPEC });
  assert.deepEqual(Object.keys(before.approvals).sort(), ['design', 'requirements', 'tasks']);
  assert.equal(before.phase, 'implementing');

  // 既成事实：一行合法署名已经落在 tasks.md 的 ## Notes 上。
  const body = (await readFile(tasksPath, 'utf8')).replace(/\s+$/, '');
  await writeFile(tasksPath, `${body}\n${SIGNATURE}\n`);

  const after = await service.call('spec_status', { spec: SPEC });
  assert.deepEqual(
    Object.keys(after.approvals).sort(),
    ['design', 'requirements', 'tasks'],
    '合法署名清空了审批：§4.3.2 要求的署名动作不该作废任何审批',
  );
  assert.equal(
    after.phase,
    'implementing',
    '合法署名把 workflow phase 退回了起草阶段：这会强迫使用者重走三份审批',
  );
  assert.equal(after.recovery, null);

  // 反向守卫：一次**实质**改动仍必须作废审批，否则上面那条豁免就成了 fail-open。
  const edited = (await readFile(tasksPath, 'utf8')).replace('1.1 Build it', '1.1 Build it properly');
  await writeFile(tasksPath, edited);
  const drifted = await service.call('spec_status', { spec: SPEC });
  // 🔴 2026-09-18 订正（缺陷报告第 4 条）：原先断言 `approvals` 为空，那是拿「明细表被
  // 整张清空」当「审批已作废」的代理指标 —— 而整张清空正是第 4 条缺陷本身。明细表现在
  // 如实映射闸门（只作废 changedArtifact 及其下游），所以改为直接断言意图。
  // 改的是 tasks（链尾），作废面就是它自己；requirements / design 未被触碰。
  assert.ok(
    !Object.keys(drifted.approvals).includes('tasks'),
    '实质改动必须继续作废审批 —— 豁免不能宽到把真改动也放过',
  );
  assert.deepEqual(
    Object.keys(drifted.approvals).sort(), ['design', 'requirements'],
    '作废面越过了被改的 tasks —— 上游没被碰过，不该跟着丢审批记录',
  );

  void root;
});
