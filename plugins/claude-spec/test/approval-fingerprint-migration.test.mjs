// 迁移行为：指纹算法升到 `semantic-v2` 之后，**存量 v1 记录**会怎样。
//
// 这不是"测一个功能"，而是把一次**已知的一次性代价**钉成可解释、可复现的事实。
// 本仓库对"静默失配"的容忍度是零（`REVIEW-20260914` §1 记过一次"判别式无效、
// 据此写下通过"的事故），所以算法升级带来的失配必须**在数据里可见、在测试里可查**，
// 而不是表现为一次莫名其妙的外部变更。
//
// 现实是什么（已实测，见下断言）：
//   · 存量记录里存的是 v1 算法算出的指纹，与 v2 现值必然不等；
//   · `observe()` 只在"字节确实变了"时才比较指纹，所以纯静置的 spec 不受影响；
//   · 一旦发生一次外部编辑，那条陈旧记录会让它走**清空审批**那条路（而不是它本该走的
//     恢复路径）——**方向是 fail-safe（丢审批、要求重新批准），不是放过改动**；
//   · 那次之后记录被刷新为 v2，条件不再重复。
//
// ⚠️ 模拟手法说明：这里把存量指纹**改成一个哨兵值**，而不是真的去跑一份旧版实现。
// 对被测代码而言两者等价——它只做"存的值 != 现值"这一个比较。用哨兵值的好处是
// 用例不依赖旧版代码是否还在。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = 'specs/demo';
const V1_SENTINEL = 'sha256:semantic-v1-era-record';

const requirements = '# Requirements Document\n\n## Introduction\n\nd\n\n## Requirements\n\n### 1. W\n\n**User Story:** As a, I want b, so that c.\n\n#### Acceptance Criteria\n1. WHEN x THE SYSTEM SHALL y\n';
const design = '# Design Document\n\n## Overview\n\no\n\n## Architecture\n\na\n\n## Error Handling\n\ne\n\n## Testing Strategy\n\nt\n\n## Data Models\n\nm\n';
const tasks = '# Implementation Plan\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1.1"]}]}\n```\n\n## Tasks\n\n- [ ] 1. Widget\n  - [ ] 1.1 Build it\n\n## Notes\n\n> n\n';

async function approvedSpec() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-migration-'));
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), '# Spec conventions\n');
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro',
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
  }));
  const privateDir = path.join(root, '.private');
  const service = await createMcpService({ projectRoot: root, privateDir });
  await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' });
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) {
    const proof = await service.call('spec_context', { spec: SPEC, artifact });
    await service.call('spec_write', { spec: SPEC, artifact, content, contextProof: proof.contextProof });
    const requested = await service.call('spec_request_approval', { spec: SPEC, artifact });
    await service.call('spec_record_approval', {
      spec: SPEC, artifact, expectedStateEpoch: requested.stateEpoch, confirmationText: requested.recommendedPhrase,
    });
  }
  const stateFile = path.join(privateDir, (await readdir(privateDir)).find((f) => f.endsWith('.json')));
  return { root, service, stateFile, tasksPath: path.join(root, '.kiro', 'specs', 'demo', 'tasks.md') };
}

const readState = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('存量 v1 指纹：一次外部改动会走清空路径（fail-safe），且**只此一次**', async () => {
  const { service, stateFile, tasksPath } = await approvedSpec();

  const before = await service.call('spec_status', { spec: SPEC });
  assert.deepEqual(Object.keys(before.approvals).sort(), ['design', 'requirements', 'tasks']);

  // 存量记录：指纹是 v1 算法的产物。
  const state = await readState(stateFile);
  assert.ok(state.artifacts.tasks.approvalFingerprint, '前置：记录里应当已存有 tasks 的指纹');
  state.artifacts.tasks.approvalFingerprint = V1_SENTINEL;
  await writeFile(stateFile, JSON.stringify(state, null, 2));

  // ① 外部（无 journal 背书）的 checkbox 改动。
  await writeFile(tasksPath, (await readFile(tasksPath, 'utf8')).replace('- [ ] 1.1', '- [x] 1.1'));
  const first = await service.call('spec_status', { spec: SPEC });
  // 🔴 2026-09-18 订正（docs/2026-09-18-claude-spec-plugin-defects.md 第 4 条）。
  // 这里原先断言 `approvals` 为**空**。那是拿「明细表被整张清空」当「审批已作废」的
  // 代理指标 —— 而整张清空本身就是第 4 条缺陷：闸门按 `invalidateApprovals` 只作废
  // changedArtifact 及其**下游链**，明细却被 `state.approvals = {}` 连上游一起带走，
  // 于是上游那份永久停在「闸门 granted、审计查无此人」。
  // 明细表现在如实映射闸门，所以本条改为直接断言**意图**：被改的那条及其下游不再有效，
  // 上游不受牵连。这比原断言更强 —— 原断言对「作废范围对不对」是瞎的。
  // 这里改的是 **tasks**（链尾），所以作废面就是它自己；requirements / design 未被触碰，
  // 它们的审批本就该留着。fail-safe 的方向体现在「tasks 的审批没了」，不在「全清」。
  assert.ok(
    !Object.keys(first.approvals).includes('tasks'),
    '陈旧指纹被当成了「没变化」—— 失配被静默吞掉了，这是本条要拦的方向',
  );
  assert.deepEqual(
    Object.keys(first.approvals).sort(), ['design', 'requirements'],
    '作废面越过了被改的 artifact —— 上游没被碰过，不该跟着丢审批记录',
  );

  // ② 那次之后记录被刷新为 v2 现值 —— 所以代价是**一次性**的。
  const after = await readState(stateFile);
  assert.notEqual(
    after.artifacts.tasks.approvalFingerprint,
    V1_SENTINEL,
    '记录没有被刷新：那意味着这次失配会无限重复，而不是一次性代价',
  );

  // ③ 再改一次，走回它本该走的恢复路径（而不是第二次清空）。
  await writeFile(tasksPath, (await readFile(tasksPath, 'utf8')).replace('- [ ] 1. Widget', '- [x] 1. Widget'));
  const second = await service.call('spec_status', { spec: SPEC });
  assert.equal(
    second.recovery?.code,
    'RECOVERY_REQUIRED',
    '刷新之后应当回到既有恢复路径；这里若还不是 RECOVERY_REQUIRED，说明 v2 记录仍被当成不匹配',
  );
});
