// 两条"只回需要的那部分"的通道：`spec_context` 的 knownRevisions 与 `spec_read` 的 outline/section。
//
// 两者的动机相同：本仓库真实 design.md ≈ 12,000 字符，而多数读取只为看其中一节；
// `contextProof` 5 分钟过期又让同一批规则文件在一段起草里被反复整份灌进上下文。
//
// 🔴 两者的判据都必须是**字节哈希**，不是"大概没变"。本文件钉的就是这一点，外加
// 部分读那条不许藏起来的风险提示（partial:true + 去 spec_amend 的指引）。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = 'specs/demo';
const RULES = '# Spec conventions\n\n规则正文，足够长以至于重复灌入是有代价的。\n';

const requirements = [
  '# Requirements Document', '', '## Introduction', '', 'demo', '',
  '## Requirements', '', '### Requirement 1: Widget', '',
  '**User Story:** As a user, I want a widget, so that I have widgets.', '',
  '#### Acceptance Criteria', '1. WHEN asked THE SYSTEM SHALL return a widget', '',
].join('\n');

// `## Data Models` 在**代码围栏里**也出现一次 —— 切分必须围栏感知，不能把它当标题。
const design = [
  '# Design Document', '', '## Overview', '', 'widget design', '',
  '## Architecture', '', 'single module', '',
  '```md', '## Data Models', '围栏里的这一行不是标题', '```', '',
  '## Error Handling', '', 'none', '',
  '## Testing Strategy', '', 'unit tests', '',
  '## Data Models', '', 'widget {}', '',
].join('\n');

const tasks = [
  '# Implementation Plan', '',
  '## Task Dependency Graph', '',
  '```json', '{"waves":[{"id":0,"tasks":["1.1"]}]}', '```', '',
  '## Tasks', '', '- [ ] 1. Widget', '  - [ ] 1.1 Build it', '',
  '## Notes', '', '> notes', '',
].join('\n');

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-partial-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), RULES);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro',
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
  }));
  return root;
}

async function draftedSpec(root) {
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' });
  for (const [artifact, content] of [['requirements', requirements], ['design', design], ['tasks', tasks]]) {
    const proof = await service.call('spec_context', { spec: SPEC, artifact });
    const written = await service.call('spec_write', { spec: SPEC, artifact, content, contextProof: proof.contextProof });
    assert.ok(written.rawRevision !== undefined, `${artifact} 写入失败：${JSON.stringify(written)}`);
    const requested = await service.call('spec_request_approval', { spec: SPEC, artifact });
    await service.call('spec_record_approval', {
      spec: SPEC, artifact, expectedStateEpoch: requested.stateEpoch, confirmationText: requested.recommendedPhrase,
    });
  }
  return service;
}

async function withProject(run) {
  const root = await makeProject();
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// ── spec_context · knownRevisions ──────────────────────────────────────────

test('knownRevisions 命中：未变的规则文件只回执不回正文，proof 照常签发', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);

    const first = await service.call('spec_context', { spec: SPEC, artifact: 'design' });
    assert.equal(first.files.length, 1);
    assert.equal(first.files[0].content, RULES, '第一次必须回全文');
    assert.equal(first.unchangedCount, 0);

    const second = await service.call('spec_context', {
      spec: SPEC, artifact: 'design',
      knownRevisions: first.files.map(({ path: p, rawRevision }) => ({ path: p, rawRevision })),
    });
    assert.equal(second.unchangedCount, 1, `未变文件没有被识别：${JSON.stringify(second.files)}`);
    assert.equal(second.files[0].unchanged, true);
    assert.equal(second.files[0].content, undefined, '未变文件仍然回了正文 —— 省不掉任何 token');
    assert.equal(second.files[0].rawRevision, first.files[0].rawRevision);

    // proof 的效力不因为少回正文而变窄：它照样能签一次写入。
    // 这里用 `spec_amend` 而不是 `spec_write` —— 此刻 spec 已批准、phase 是 implementing，
    // `spec_write` 本就该被阶段门拒绝（PHASE_NOT_APPROVED），那正是 amend 存在的场景。
    assert.ok(second.contextProof, '没有签发 proof');
    const amended = await service.call('spec_amend', {
      spec: SPEC, kind: 'param', file: 'design', from: 'single module', to: 'two modules',
      contextProof: second.contextProof,
    });
    assert.ok(amended.rawRevision, `精简回包的 proof 不被 spec_amend 接受：${JSON.stringify(amended)}`);
  });
});

test('🔴 knownRevisions 只跳过逐字节未变的：规则文件一改，立刻回全文', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);
    const first = await service.call('spec_context', { spec: SPEC, artifact: 'design' });
    const stale = first.files.map(({ path: p, rawRevision }) => ({ path: p, rawRevision }));

    await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), `${RULES}\n新增了一条规则。\n`);

    const second = await service.call('spec_context', { spec: SPEC, artifact: 'design', knownRevisions: stale });
    assert.equal(second.unchangedCount, 0, '文件已经变了却被当成未变 —— 这会让调用方基于过期规则写入');
    assert.match(second.files[0].content, /新增了一条规则/, '变更后没有回全文');
    assert.notEqual(second.files[0].rawRevision, stale[0].rawRevision);
  });
});

test('伪造的 knownRevisions 不会骗过校验（哈希不等就回全文）', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);
    const second = await service.call('spec_context', {
      spec: SPEC, artifact: 'design',
      knownRevisions: [{ path: '.kiro/steering/spec-conventions.md', rawRevision: 'sha256:' + '0'.repeat(64) }],
    });
    assert.equal(second.unchangedCount, 0);
    assert.equal(second.files[0].content, RULES, '假 revision 让正文被跳过了');
  });
});

// ── spec_read · outline / section ──────────────────────────────────────────

test('outline 只回目录，不回正文，且围栏里的 ## 不算小节', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);
    const outline = await service.call('spec_read', { spec: SPEC, artifact: 'design', outline: true });

    assert.equal(outline.partial, true, '部分读没有自报 partial');
    assert.ok(outline.partialNote.includes('spec_amend'), 'partialNote 没有把人指向 spec_amend');
    assert.equal(outline.totalCharacters, design.length);
    for (const section of outline.sections) {
      assert.equal(section.content, undefined, 'outline 回了正文 —— 那就不是目录了');
      assert.ok(typeof section.startLine === 'number' && typeof section.characters === 'number');
    }
    const headings = outline.sections.map((section) => section.heading).filter(Boolean);
    assert.deepEqual(headings, ['Overview', 'Architecture', 'Error Handling', 'Testing Strategy', 'Data Models']);
    assert.equal(headings.filter((h) => h === 'Data Models').length, 1, '围栏里的 ## Data Models 被当成了标题');
  });
});

test('section 只回那一节，且逐字等于全文里的对应片段', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);
    const one = await service.call('spec_read', { spec: SPEC, artifact: 'design', section: 'Architecture' });

    assert.equal(one.partial, true);
    assert.match(one.content, /^## Architecture/, '回的不是这一节的开头');
    assert.ok(one.content.includes('single module'));
    assert.ok(!one.content.includes('## Error Handling'), '越界回了下一节');
    assert.ok(one.content.length < design.length / 2, '"部分读"并没有变短');

    const full = await service.call('spec_read', { spec: SPEC, artifact: 'design' });
    assert.ok(full.content.includes(one.content), '小节正文与全文对不上 —— 切分不是无损的');
    assert.equal(full.partial, undefined, '全量读不该被标成部分读');
    assert.equal(one.rawRevision, full.rawRevision);
  });
});

test('section 不存在时报错并给出可选项，不静默回空', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);
    const missing = await service.call('spec_read', { spec: SPEC, artifact: 'design', section: '不存在的小节' });
    assert.equal(missing.code, 'SECTION_NOT_FOUND', `没报错：${JSON.stringify(missing)}`);
    assert.ok(missing.details.available.includes('Architecture'), '没有给出可选小节');
  });
});

test('section 同名出现多次时拒绝并报出每处起始行，不"挑第一个"', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);
    const designPath = path.join(root, '.kiro', 'specs', 'demo', 'design.md');
    await writeFile(designPath, `${design}\n## Architecture\n\nsecond copy\n`);

    const ambiguous = await service.call('spec_read', { spec: SPEC, artifact: 'design', section: 'Architecture' });
    assert.equal(ambiguous.code, 'SECTION_AMBIGUOUS', `静默挑了一节：${JSON.stringify(ambiguous).slice(0, 200)}`);
    assert.equal(ambiguous.details.startLines.length, 2);
    // 对照组：唯一的小节照常能读 —— 否则上面的「拒绝」可能只是整个 section 读坏了。
    const unique = await service.call('spec_read', { spec: SPEC, artifact: 'design', section: 'Overview' });
    assert.equal(unique.partial, true);
  });
});

test('部分读不改变外部改动检测：改盘上的文件，section 读照样发现', async () => {
  await withProject(async (root) => {
    const service = await draftedSpec(root);
    const designPath = path.join(root, '.kiro', 'specs', 'demo', 'design.md');
    await writeFile(designPath, design.replace('single module', 'three modules'));

    const one = await service.call('spec_read', { spec: SPEC, artifact: 'design', section: 'Architecture' });
    assert.ok(one.externalChange, '部分读把外部改动吃掉了 —— 省 token 买走了检测能力');
    assert.match(one.content, /three modules/);

    const after = await service.call('spec_status', { spec: SPEC });
    assert.equal(after.approvals.design, undefined, '外部改动之后 design 的审批仍然有效');
  });
});
