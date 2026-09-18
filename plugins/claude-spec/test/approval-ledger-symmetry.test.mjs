// 审批的**两张表**不许走岔 —— 钉住 2026-09-18 第 4 条缺陷。
//
// 🔴 缺陷原貌：`state.workflowState.approvals`（闸门，字符串态）与 `state.approvals`
// （审计明细，对象态）在四个作废点上用了不对称的策略 —— 闸门按 `invalidateApprovals`
// **定向**作废（只动 changedArtifact 及其下游链），明细却被 `state.approvals = {}`
// **整张清空**。于是改一份下游 artifact，上游那份的闸门仍是 granted、明细却没了；
// 随后重批只补回被重批的那几条，上游那份永久停在「已批准但查不到记录」。
//
// 实测形状：spec_status 报 design + tasks 两条明细，而磁盘上闸门是三条 granted。
// 闸门是对的、门也拦得住，坏的是**审计面**——对一个以可审计为卖点的工具，
// 「已批准但查不到记录」会被读成没批。
//
// 判据是一条不变式，不是某个具体场景：
//     明细表的键集合 ≡ 闸门表上仍为 `granted` 的键集合
// 在整条「批准 → 改 → 重批」的路径上**每一步**都成立。只断言终局的话，
// 中间某一步把明细清空再补回来的实现照样能过。

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = '_eval-codex-20260827';

const artifactContent = {
  bugfix: '# Bugfix Analysis\n\n## Introduction\n\nA record is lost.\n\n## Bug Analysis\n\n### Current Behavior (Defect)\n\nThe system loses a record.\n\n### Expected Behavior (Correct)\n\nThe system retains it.\n\n### Unchanged Behavior (Regression Prevention)\n\nEverything else keeps working.\n',
  design: '# Design Document\n\n## Overview\n\nA minimal corrective design.\n',
  tasks: '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Implement the record\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n'
};

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-ledger-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  const authority = '# Rules\n\nUse the approved format.\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), authority);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: { mode: 'evaluation-only', allowedPrefixes: [`${SPEC}/`], authorityFile: '.kiro/steering/spec.md', authorityHash: computeRawRevision(authority) },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }]
  }));
  const privateDir = path.join(root, '.private');
  return { service: await createMcpService({ projectRoot: root, privateDir }), privateDir };
}

/**
 * ⚠️ 每一次调用都断言成功。本文件的上一版没有这道断言，于是 `spec_write` 在
 * `implementing` 阶段被 `PHASE_NOT_APPROVED` 拒掉时**被静默吞掉**，用例一路空转到底、
 * 在缺陷还原后照样全绿 —— 一条没有判别力的网比没有网更糟，因为它会让人以为这里有人看着。
 */
function ok(result, what) {
  assert.equal(result.code, undefined, `${what} 本该成功，却返回 ${result.code}：${result.message ?? ''}`);
  return result;
}

async function writeArtifact(service, artifact, content = artifactContent[artifact]) {
  const context = ok(await service.call('spec_context', { spec: SPEC, artifact }), `spec_context ${artifact}`);
  const previous = await service.call('spec_read', { spec: SPEC, artifact });
  return ok(await service.call('spec_write', {
    spec: SPEC,
    artifact,
    content,
    expectedRawRevision: previous.code === 'SPEC_NOT_FOUND' ? undefined : previous.rawRevision,
    contextProof: context.contextProof,
    signature: `2026-09-18 · 测试 · ${artifact}`,
  }), `spec_write ${artifact}`);
}

/**
 * 改一份**已批准**的 artifact 只有 `spec_amend` 这一条路 —— `spec_write` 在 implementing
 * 阶段会被 PHASE_NOT_APPROVED 拒（这正是缺陷报告第 6.5 条描述的那道墙）。
 * 而 amend 正是第 4 条缺陷的真实触发路径：它定向作废闸门、却整张清空明细。
 */
async function amendDesign(service, from, to) {
  const context = ok(await service.call('spec_context', { spec: SPEC, artifact: 'design' }), 'spec_context design');
  return ok(await service.call('spec_amend', {
    spec: SPEC,
    kind: 'param',
    file: 'design',
    from,
    to,
    contextProof: context.contextProof,
    signature: '2026-09-18 · 测试 · amend',
  }), 'spec_amend design');
}

async function approve(service, artifact) {
  const request = ok(await service.call('spec_request_approval', { spec: SPEC, artifact }), `spec_request_approval ${artifact}`);
  return ok(await service.call('spec_record_approval', { spec: SPEC, artifact, expectedStateEpoch: request.stateEpoch, confirmationText: `批准 ${artifact}` }), `spec_record_approval ${artifact}`);
}

/** 磁盘上的私有 state —— 判据必须落在**持久化**的那一份上，不能只信 spec_status 的回执。 */
async function readPersistedState(privateDir) {
  const { readdir } = await import('node:fs/promises');
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(full));
      else if (entry.name.endsWith('.json')) out.push(full);
    }
    return out;
  };
  for (const file of await walk(privateDir)) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.workflowState?.approvals) return parsed;
  }
  throw new Error('私有 state 没找着 —— 这条用例的判据没有着落，不能当它通过');
}

/** 不变式：明细键集合 ≡ 闸门上仍为 granted 的键集合。 */
function assertLedgerSymmetry(state, at) {
  const granted = Object.entries(state.workflowState.approvals).filter(([, v]) => v === 'granted').map(([k]) => k).sort();
  const detailed = Object.keys(state.approvals ?? {}).sort();
  assert.deepEqual(detailed, granted, `${at}：闸门 granted=[${granted}] 但明细=[${detailed}] —— 两张表走岔了`);
}

test('bugfix 工作流：改 design 不该带走 bugfix 的审批明细', async () => {
  const { service, privateDir } = await setup();
  await service.call('spec_init', { spec: SPEC, workflow: 'bugfix' });

  for (const artifact of ['bugfix', 'design', 'tasks']) {
    await writeArtifact(service, artifact);
    await approve(service, artifact);
    assertLedgerSymmetry(await readPersistedState(privateDir), `刚批准 ${artifact} 之后`);
  }

  const beforeAmend = await readPersistedState(privateDir);
  assert.deepEqual(Object.keys(beforeAmend.approvals).sort(), ['bugfix', 'design', 'tasks'], '三份都批准后，三条明细都该在');

  // 改 design —— `invalidateApprovals` 只作废 design 及其下游（tasks），bugfix 在上游不动。
  await amendDesign(service, 'A minimal corrective design.', 'A minimal corrective design, revised.');

  const afterAmend = await readPersistedState(privateDir);
  assertLedgerSymmetry(afterAmend, '改完 design 之后');
  assert.equal(afterAmend.workflowState.approvals.bugfix, 'granted', 'bugfix 在链上游，闸门不该被这次改动作废');
  assert.ok(afterAmend.approvals.bugfix, '🔴 缺陷原形：bugfix 闸门仍是 granted，明细却被整张清空带走了');
  assert.ok(afterAmend.approvals.bugfix.fingerprint, '明细要留的是完整对象（fingerprint / recordedAt），不是一个占位值');

  // 重批下游，回到三条全绿。tasks 的正文没动过，只是审批被链式作废了，重批即可。
  await approve(service, 'design');
  await approve(service, 'tasks');

  const settled = await readPersistedState(privateDir);
  assertLedgerSymmetry(settled, '重批之后');
  assert.deepEqual(Object.keys(settled.approvals).sort(), ['bugfix', 'design', 'tasks']);
});

test('spec_status 报的 approvals 键集合与持久化 state 一致（报告第 4 条建议的那条断言）', async () => {
  const { service, privateDir } = await setup();
  await service.call('spec_init', { spec: SPEC, workflow: 'bugfix' });
  for (const artifact of ['bugfix', 'design', 'tasks']) {
    await writeArtifact(service, artifact);
    await approve(service, artifact);
  }
  await amendDesign(service, 'A minimal corrective design.', 'A minimal corrective design, revised.');
  await approve(service, 'design');
  await approve(service, 'tasks');

  const status = ok(await service.call('spec_status', { spec: SPEC }), 'spec_status');
  const persisted = await readPersistedState(privateDir);
  assert.deepEqual(
    Object.keys(status.approvals ?? {}).sort(),
    Object.keys(persisted.approvals ?? {}).sort(),
    'spec_status 与磁盘上的明细键集合不一致 —— 那是缺陷，不是展示差异',
  );
  assert.ok(status.approvals.bugfix, 'bugfix 已批准，status 必须查得到它的记录');
});
