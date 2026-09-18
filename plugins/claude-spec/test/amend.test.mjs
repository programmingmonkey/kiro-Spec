// `spec_amend` —— 冻结 Spec 的增量修正通道（claude-spec 侧）。
//
// 这条通道存在的**唯一**理由是 token：在它之前，改一份已批准 design.md 里的一个参数值，
// 也必须走 `spec_write` 重发整份正文 —— 本仓库真实 design.md ≈ 12,000 字符，
// 即一次 output 侧、永不命中缓存的全量重新生成。dsh-spec 从第 2 期起就有这个工具，
// claude-spec 一直没有，于是同一个修正在两个宿主上的代价差着两个数量级。
//
// 🔴 但"省 token"不许买走任何一条既有担保。本文件钉的就是那些担保：
//   ① 审批必须作废（与 `scripts/amend-invalidates-approval.test.mjs` 是同一条语义的两端：
//      那条走 DSH 打进来的外部改动，这条走本宿主的进程内改动）；
//   ② 任务体拒绝（Req 6.4）；
//   ③ `from` 命中 0 次 / 多次一律拒绝，不"挑第一个"；
//   ④ CAS —— `expectedRawRevision` 对不上就拒绝；
//   ⑤ contextProof 仍然必需，与 `spec_write` 同档。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = 'specs/demo';

const requirements = [
  '# Requirements Document', '', '## Introduction', '', 'demo', '',
  '## Requirements', '', '### Requirement 1: Widget', '',
  '**User Story:** As a user, I want a widget, so that I have widgets.', '',
  '#### Acceptance Criteria', '1. WHEN asked THE SYSTEM SHALL return a widget', '',
].join('\n');

// 必须在 design 里**恰好出现一次** —— `applyParamEdit` 在 0 次或多次时都拒绝。
const FROM = 'single module';
const TO = 'two modules';
const design = [
  '# Design Document', '', '## Overview', '', 'widget design', '',
  '## Architecture', '', FROM, '',
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

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-amend-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), '# Spec conventions\n');
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro',
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
  }));
  return root;
}

/** 起草 → 批准三份 artifact，停在 implementing（也就是「冻结」之后）。 */
async function approvedSpec(root) {
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' });
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) {
    const proof = await service.call('spec_context', { spec: SPEC, artifact });
    const written = await service.call('spec_write', { spec: SPEC, artifact, content, contextProof: proof.contextProof });
    assert.ok(written.rawRevision !== undefined, `${artifact} 写入失败：${JSON.stringify(written)}`);
    const requested = await service.call('spec_request_approval', { spec: SPEC, artifact });
    const recorded = await service.call('spec_record_approval', {
      spec: SPEC, artifact, expectedStateEpoch: requested.stateEpoch, confirmationText: requested.recommendedPhrase,
    });
    assert.ok(recorded.phase !== undefined, `${artifact} 批准失败：${JSON.stringify(recorded)}`);
  }
  return service;
}

async function proofFor(service, artifact) {
  const proof = await service.call('spec_context', { spec: SPEC, artifact });
  assert.ok(proof.contextProof, `取 ${artifact} 的 contextProof 失败：${JSON.stringify(proof)}`);
  return proof.contextProof;
}

async function withProject(run) {
  const root = await makeProject();
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('kind=param 就地改一个值，整份正文不必重发', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const designPath = path.join(root, '.kiro', 'specs', 'demo', 'design.md');

    const amended = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'design', from: FROM, to: TO,
      contextProof: await proofFor(service, 'design'),
    });
    assert.equal(amended.artifact, 'design', `amend 失败：${JSON.stringify(amended)}`);
    assert.ok(amended.rawRevision, 'amend 没有返回新的 rawRevision');

    const onDisk = await readFile(designPath, 'utf8');
    assert.match(onDisk, new RegExp(TO), '改动没有落盘');
    assert.doesNotMatch(onDisk, new RegExp(FROM), '旧值仍在');
    // 只改了那一处：其余章节逐字还在。
    for (const kept of ['## Overview', 'widget design', '## Error Handling', 'unit tests', 'widget {}']) {
      assert.ok(onDisk.includes(kept), `amend 波及了无关内容，丢了：${kept}`);
    }
  });
});

test('🔴 amend 之后审批必须作废（与 DSH 外部改动同一条语义）', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);

    const before = await service.call('spec_status', { spec: SPEC });
    assert.deepEqual(Object.keys(before.approvals).sort(), ['design', 'requirements', 'tasks']);
    assert.equal(before.phase, 'implementing');

    const amended = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'design', from: FROM, to: TO,
      contextProof: await proofFor(service, 'design'),
    });
    assert.equal(amended.approvalsInvalidated, true, `amend 没有自报作废：${JSON.stringify(amended)}`);

    const after = await service.call('spec_status', { spec: SPEC });
    // 🔴 2026-09-18 订正（docs/2026-09-18-claude-spec-plugin-defects.md 第 4 条）。
    // 这里原先断言 `approvals` 为**空**。那是拿「明细表被整张清空」当「审批已作废」的
    // 代理指标 —— 而整张清空本身就是第 4 条缺陷：闸门按 `invalidateApprovals` 只作废
    // changedArtifact 及其**下游链**，明细却被 `state.approvals = {}` 连上游一起带走，
    // 于是上游那份永久停在「闸门 granted、审计查无此人」。
    // 明细表现在如实映射闸门，所以本条改为直接断言**意图**：被改的那条及其下游不再有效，
    // 上游不受牵连。这比原断言更强 —— 原断言对「作废范围对不对」是瞎的。
    assert.deepEqual(
      Object.keys(after.approvals).sort(), ['requirements'],
      '修订 design 之后 design/tasks 的审批仍然有效 —— 省 token 买走了审批语义，这正是本条要拦的回归',
    );
    assert.equal(after.phase, 'design_draft', '阶段必须回滚到 design 起草 —— 否则改完还能继续执行');
  });
});

// 🔴 2026-09-18 改写（docs/2026-09-18-claude-spec-plugin-defects.md 第 2 / 6.5 条）。
// 原标题是「file=tasks **一律**拒绝」，而那正是缺陷：冻结的本意是 Req 6.4 的**任务体**，
// 不是整份 tasks.md。一律拒绝让 `## Notes` 里的一行署名也改不了，而 spec-conventions
// §7.1.1 rule ① 明写那里可以碰 —— 工具比它服务的规则更严；再与 `spec_write` 的整份替换
// 组合起来，tasks 的唯一可用编辑路径恰好会破坏署名台账（第 2 条）。
//
// ⚠️ 原用例还有一处隐藏问题：它拿 **design** 的 contextProof 去改 tasks。旧代码的一刀切
// 拒绝发生在 proof 校验**之前**，所以这个不匹配一直看不见；判定挪到 proof 之后，它就露出来了。
// 下面改用 tasks 自己的 proof —— 否则这条用例根本走不到它要测的那道门。
test('拒改任务体（Req 6.4）：动了任务定义就拒，没动就放行', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const tasksPath = path.join(root, '.kiro', 'specs', 'demo', 'tasks.md');

    // ① 改任务标题 = 改任务体 → 拒。
    const refused = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'tasks', from: 'Build it', to: 'Build it twice',
      contextProof: await proofFor(service, 'tasks'),
    });
    assert.equal(refused.code, 'TASK_BODY_FROZEN', `任务体没有被拒：${JSON.stringify(refused)}`);
    assert.match(refused.message, /task body/, '文案要说清被拒的是任务体');
    // 旧文案「amend requirements/design instead」实测会指错路：一条本属于 tasks 的订正
    // 被照着写进了 design 的 `## Amendments`，来回三次写操作才收回来。
    assert.doesNotMatch(refused.message, /amend requirements\/design instead/, '不许再用那句会指错路的文案');
    assert.ok((await readFile(tasksPath, 'utf8')).includes('- [ ] 1.1 Build it'), '任务体被改动了');

    // ② 改 `## Notes` 里的正文 = 没动任务定义 → 放行。这是第 2 / 6.5 条要打开的那条路。
    const allowed = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'tasks', from: '> notes', to: '> 备注（订正）',
      contextProof: await proofFor(service, 'tasks'),
    });
    assert.equal(allowed.code, undefined, `非任务行被拒了：${JSON.stringify(allowed)}`);
    const afterNotes = await readFile(tasksPath, 'utf8');
    assert.ok(afterNotes.includes('> 备注（订正）'), '订正没有落盘');
    assert.ok(afterNotes.includes('- [ ] 1.1 Build it'), 'amend 波及了任务体');
  });
});

test('任务体冻结按**语义**判，不按形状猜', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const tasksPath = path.join(root, '.kiro', 'specs', 'demo', 'tasks.md');

    // 改 checkbox 状态：`from` 长得完全不像「任务行」的片段，但它改的是任务 state。
    // 形状判据（「from 是否匹配 `- [ ] N.`」）会放过它 —— 语义判据不会。
    const sneaky = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'tasks', from: '[ ] 1.1', to: '[x] 1.1',
      contextProof: await proofFor(service, 'tasks'),
    });
    assert.equal(sneaky.code, 'TASK_BODY_FROZEN', `改任务状态没有被拒：${JSON.stringify(sneaky)}`);
    assert.ok((await readFile(tasksPath, 'utf8')).includes('- [ ] 1.1 Build it'), '任务状态被绕过改掉了');
  });
});

test('from 命中 0 次 / 多次都拒绝，不"挑第一个"', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);

    const missing = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'design', from: '这段文字不存在', to: 'x',
      contextProof: await proofFor(service, 'design'),
    });
    assert.ok(missing.code, `命中 0 次却没拒绝：${JSON.stringify(missing)}`);
    assert.match(missing.message, /not found/, `拒绝理由没说清是"没找到"：${missing.message}`);

    // `## ` 在这份 design 里出现多次 —— 歧义必须拒绝。
    const ambiguous = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'design', from: '## ', to: '### ',
      contextProof: await proofFor(service, 'design'),
    });
    assert.ok(ambiguous.code, `命中多次却没拒绝：${JSON.stringify(ambiguous)}`);
    assert.match(ambiguous.message, /ambiguous/, `拒绝理由没说清是"有歧义"：${ambiguous.message}`);
  });
});

test('CAS：expectedRawRevision 对不上就拒绝，且不落盘', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const designPath = path.join(root, '.kiro', 'specs', 'demo', 'design.md');
    const before = await readFile(designPath, 'utf8');

    const stale = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'design', from: FROM, to: TO,
      expectedRawRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      contextProof: await proofFor(service, 'design'),
    });
    assert.equal(stale.code, 'REVISION_CONFLICT', `陈旧 revision 没有被拒：${JSON.stringify(stale)}`);
    assert.equal(await readFile(designPath, 'utf8'), before, 'CAS 拒绝之后文件仍被改动了');
  });
});

test('contextProof 仍然必需，与 spec_write 同档', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const refused = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'design', from: FROM, to: TO,
      contextProof: 'context:not-a-real-proof',
    });
    assert.equal(refused.code, 'CONTEXT_PROOF_INVALID', `无效 proof 没有被拒：${JSON.stringify(refused)}`);
  });
});

test('kind=requirement 追加需求，编号续在现有最大值之后', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const amended = await service.call('spec_amend', {
      spec: SPEC, kind: 'requirement', title: 'Gadget', body: '**User Story:** As a user, I want a gadget.',
      contextProof: await proofFor(service, 'requirements'),
    });
    assert.equal(amended.artifact, 'requirements', `amend 失败：${JSON.stringify(amended)}`);
    const onDisk = await readFile(path.join(root, '.kiro', 'specs', 'demo', 'requirements.md'), 'utf8');
    assert.match(onDisk, /### Requirement 2: Gadget/, '新需求没有按 max+1 编号');
    assert.ok(onDisk.includes('### Requirement 1: Widget'), '原有需求被破坏');
  });
});

test('kind=design 的 heading 是**条目**标题，不是 section 名（2026-09-18 第 6.2 条）', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const designPath = path.join(root, '.kiro', 'specs', 'demo', 'design.md');
    const common = { spec: SPEC, kind: 'design', body: '补充说明。', anchor: 'widget design', pointer: '（另见文末补充修正）' };
    // 计数按**标题行**，不是子串 —— 正文里提到 `## Amendments` 四个字不算一个标题。
    const amendmentsHeadings = (text) => text.split('\n').filter((line) => line.trimEnd() === '## Amendments').length;

    // ① 传 section 名 —— 原先被原样接受，落盘出**两个** `## Amendments`。
    const refused = await service.call('spec_amend', { ...common, heading: '## Amendments', contextProof: await proofFor(service, 'design') });
    assert.ok(refused.code, `传 section 名没有被拒：${JSON.stringify(refused)}`);
    assert.match(refused.message, /level-2 heading|creates and owns the section/, `拒绝理由没说清：${refused.message}`);
    assert.equal(amendmentsHeadings(await readFile(designPath, 'utf8')), 0, '被拒的调用不该落盘');

    // ② 不传 heading —— 错误要说清该传什么，而不是只说「got undefined」。
    const missing = await service.call('spec_amend', { ...common, contextProof: await proofFor(service, 'design') });
    assert.ok(missing.code, '缺 heading 没有被拒');
    assert.match(missing.message, /ENTRY/, `没说清该传什么：${missing.message}`);

    // ③ 正常路径：条目标题 + 自建 section，`## Amendments` 恰好一个。
    const okAmend = await service.call('spec_amend', { ...common, heading: '### 2026-09-18 · 订正取数口径', contextProof: await proofFor(service, 'design') });
    assert.equal(okAmend.code, undefined, `正常条目被拒：${JSON.stringify(okAmend)}`);
    const onDisk = await readFile(designPath, 'utf8');
    assert.equal(amendmentsHeadings(onDisk), 1, `出现了重复的二级标题：\n${onDisk}`);
    assert.match(onDisk, /^### 2026-09-18 · 订正取数口径$/m, '条目标题没落盘');
    assert.match(onDisk, /补充说明。/, 'body 没落盘');
  });
});

test('kind=design 的 title 不再被静默丢弃', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const designPath = path.join(root, '.kiro', 'specs', 'demo', 'design.md');
    const common = { spec: SPEC, kind: 'design', body: '正文。', anchor: 'widget design', pointer: '（另见文末补充修正）' };

    // 只给 title：它就是条目标题，必须落盘 —— 原先它连一句提示都没有就没了。
    const viaTitle = await service.call('spec_amend', { ...common, title: '### 只给了 title', contextProof: await proofFor(service, 'design') });
    assert.equal(viaTitle.code, undefined, `只给 title 被拒了：${JSON.stringify(viaTitle)}`);
    assert.match(await readFile(designPath, 'utf8'), /^### 只给了 title$/m, 'title 被丢了');

    // 两个都给且不一致 —— 悄悄挑一个用就是把缺陷换个形状留下，所以当场拒。
    const conflict = await service.call('spec_amend', { ...common, heading: '### A', title: '### B', contextProof: await proofFor(service, 'design') });
    assert.ok(conflict.code, 'heading 与 title 冲突没有被拒');
    assert.match(conflict.message, /both given and differ/);
  });
});

test('kind=design 要求 anchor 与 pointer，缺一个就指名道姓地拒绝', async () => {
  await withProject(async (root) => {
    const service = await approvedSpec(root);
    const noAnchor = await service.call('spec_amend', {
      spec: SPEC, kind: 'design', heading: '### 2026-09-16 · 修正', body: 'x', pointer: '> 见文末',
      contextProof: await proofFor(service, 'design'),
    });
    assert.equal(noAnchor.code, 'AMEND_ANCHOR_REQUIRED', `缺 anchor 没被拒：${JSON.stringify(noAnchor)}`);

    const noPointer = await service.call('spec_amend', {
      spec: SPEC, kind: 'design', heading: '### 2026-09-16 · 修正', body: 'x', anchor: FROM,
      contextProof: await proofFor(service, 'design'),
    });
    assert.equal(noPointer.code, 'AMEND_POINTER_REQUIRED', `缺 pointer 没被拒：${JSON.stringify(noPointer)}`);
  });
});
