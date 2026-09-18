// `spec_write` 的整份替换不许带走 §4.3.2 的署名台账 —— 钉住 2026-09-18 第 2 条缺陷。
//
// 🔴 缺陷原貌：`spec_write` 只**追加本次**署名，不保留此前的。单看这条语义没问题（它就叫
// 「整份替换」）。致命的是它与另一条规则的**组合**：`spec_amend` 对 `tasks` 一律
// `TASK_BODY_FROZEN`（连 `## Notes` 里的署名行都拒），于是 tasks.md 的**唯一**可编辑路径
// 恰好会破坏台账。实测一次会话因此丢了 4 条署名，而发现纯属偶然 —— 是去修一个编号错字时
// 顺手数了一下才看见的。
//
// 为什么台账值得单独设一道网：它是 git 结构上补不回来的那一维。文件内容 git 有历史，
// 「哪个底座在哪天改了什么」只此一处记录；丢了就是丢了，而且丢得无声。

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = '_eval-codex-20260827';

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
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] }],
  }));
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  return { root, service };
}

function ok(result, what) {
  assert.equal(result.code, undefined, `${what} 本该成功，却返回 ${result.code}：${result.message ?? ''}`);
  return result;
}

const DESIGN = (body) => `# Design Document\n\n## Overview\n\n${body}\n`;

async function write(service, artifact, content, signature) {
  const context = ok(await service.call('spec_context', { spec: SPEC, artifact }), `spec_context ${artifact}`);
  const previous = await service.call('spec_read', { spec: SPEC, artifact });
  return ok(await service.call('spec_write', {
    spec: SPEC,
    artifact,
    content,
    expectedRawRevision: previous.code === 'SPEC_NOT_FOUND' ? undefined : previous.rawRevision,
    contextProof: context.contextProof,
    signature,
  }), `spec_write ${artifact}`);
}

async function approve(service, artifact) {
  const request = ok(await service.call('spec_request_approval', { spec: SPEC, artifact }), `spec_request_approval ${artifact}`);
  return ok(await service.call('spec_record_approval', { spec: SPEC, artifact, expectedStateEpoch: request.stateEpoch, confirmationText: `批准 ${artifact}` }), `spec_record_approval ${artifact}`);
}

const signatureLines = (text) => text.split('\n').filter((line) => /^- \d{4}-\d{2}-\d{2} · /.test(line.trim()));

test('连续三次 spec_write：三条署名都还在，而不是只剩最后一条', async () => {
  const { root, service } = await setup();
  ok(await service.call('spec_init', { spec: SPEC, workflow: 'design-first' }), 'spec_init');

  await write(service, 'design', DESIGN('第一版。'), '新建 design');
  await write(service, 'design', DESIGN('第二版。'), '订正 Overview 措辞');
  const third = await write(service, 'design', DESIGN('第三版。'), '补充边界说明');

  const onDisk = await readFile(path.join(root, '.kiro', 'specs', SPEC, 'design.md'), 'utf8');
  const lines = signatureLines(onDisk);
  assert.equal(lines.length, 3, `台账应有 3 条署名，实际 ${lines.length} 条：\n${onDisk}`);
  assert.ok(lines[0].includes('新建 design'), '最早那条被整份替换带走了 —— 这正是第 2 条缺陷的形态');
  assert.ok(lines[1].includes('订正 Overview 措辞'));
  assert.ok(lines[2].includes('补充边界说明'));

  // 台账要保持时间序：搬回来的历史署名在前，本次的在后。
  assert.deepEqual(lines.map((l) => l.trim()), [...lines].map((l) => l.trim()), '顺序被打乱');
  // 回执要自报搬了哪几条，而不是悄悄做掉。
  assert.deepEqual(third.preservedSignatures?.length, 2, '回执没有说明保留了哪些历史署名');
});

test('幂等：同一条署名不会因为被搬回来而重复', async () => {
  const { root, service } = await setup();
  ok(await service.call('spec_init', { spec: SPEC, workflow: 'design-first' }), 'spec_init');

  await write(service, 'design', DESIGN('第一版。'), '新建 design');
  // 调用方把上一条署名**照抄**进了新正文（人工补签的常见做法）——不该因此出现两条。
  const carried = await readFile(path.join(root, '.kiro', 'specs', SPEC, 'design.md'), 'utf8');
  const previousBlock = carried.slice(carried.indexOf('## Notes'));
  await write(service, 'design', `${DESIGN('第二版。')}\n${previousBlock}`, '订正措辞');

  const onDisk = await readFile(path.join(root, '.kiro', 'specs', SPEC, 'design.md'), 'utf8');
  const lines = signatureLines(onDisk);
  assert.equal(lines.length, 2, `照抄历史署名不该产生重复，实际 ${lines.length} 条：\n${onDisk}`);
});

test('首次写入（盘上还没有这份 artifact）不受影响', async () => {
  const { root, service } = await setup();
  ok(await service.call('spec_init', { spec: SPEC, workflow: 'design-first' }), 'spec_init');
  await write(service, 'design', DESIGN('第一版。'), '新建 design');
  const onDisk = await readFile(path.join(root, '.kiro', 'specs', SPEC, 'design.md'), 'utf8');
  assert.equal(signatureLines(onDisk).length, 1);
});

test('tasks.md 同样受保护 —— 它是缺陷里丢得最多的那一份', async () => {
  const { root, service } = await setup();
  await service.call('spec_init', { spec: SPEC, workflow: 'bugfix' });

  const tasks = (n) => `# Implementation Plan\n\n## Tasks\n\n- [ ] 1. 第 ${n} 版任务\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n> 任务依赖图\n\n\`\`\`json\n{"waves":[{"id":0,"tasks":["1"]}]}\n\`\`\`\n`;
  await write(service, 'bugfix', '# Bugfix Analysis\n\n## Introduction\n\nx\n\n## Bug Analysis\n\n### Current Behavior (Defect)\n\na\n\n### Expected Behavior (Correct)\n\nb\n\n### Unchanged Behavior (Regression Prevention)\n\nc\n', '新建 bugfix');
  await approve(service, 'bugfix');
  await write(service, 'design', DESIGN('设计。'), '新建 design');
  await approve(service, 'design');
  await write(service, 'tasks', tasks(1), '新建 tasks');
  await write(service, 'tasks', tasks(2), 'wave 排布订正');

  const onDisk = await readFile(path.join(root, '.kiro', 'specs', SPEC, 'tasks.md'), 'utf8');
  const lines = signatureLines(onDisk);
  assert.equal(lines.length, 2, `tasks.md 台账应有 2 条，实际 ${lines.length}：\n${onDisk}`);
  assert.ok(lines[0].includes('新建 tasks'), '「新建」那条被带走了 —— 实测会话里丢的正是这一条');
});
