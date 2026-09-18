// 审批握手（2026-09-17 与用户约定）：agent 写完一份文档后**不发起**审批，只在回复末尾说明
// 「请 review、直接改文件、改完发送批准短语」；用户改完后先发短语，agent 再核对变化并
// 依次调用 request → record。
//
// 这条约定写在 SKILL.md 里，本文件钉的是它依赖的**插件事实**，任何一条变了约定就不成立：
//   ① 起草期内用户在插件之外改文件，不会让之后的请求/批准失败；
//   ② `spec_read` 的 `externalChange` 能区分「用户改过」与「没改过」—— agent 靠它判断要不要报改动；
//   ③ 短语先于请求说出，插件照样接受（它只核对原话、状态版本号与内容指纹）；
//   ④ 请求与记录之间内容再变，批准被拒 —— 这是「批准落到没看过的版本上」的最后一道门。
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

async function withDraft(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-handshake-'));
  try {
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
    await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), '# rules\n');
    await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
      schemaVersion: 1,
      specsRoot: '.kiro',
      writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
      rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
    }));
    const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
    await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' });
    const proof = await service.call('spec_context', { spec: SPEC, artifact: 'requirements' });
    const written = await service.call('spec_write', { spec: SPEC, artifact: 'requirements', content: requirements, contextProof: proof.contextProof });
    assert.ok(written.rawRevision, JSON.stringify(written));
    await run({ service, file: path.join(root, '.kiro', 'specs', 'demo', 'requirements.md') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** agent 收到短语后的动作序列：读 → 请求 → 记录。返回三步的结果。 */
async function handshake(service, phrase, { between } = {}) {
  const read = await service.call('spec_read', { spec: SPEC, artifact: 'requirements' });
  const requested = await service.call('spec_request_approval', { spec: SPEC, artifact: 'requirements' });
  if (between) await between();
  const recorded = await service.call('spec_record_approval', {
    spec: SPEC, artifact: 'requirements', expectedStateEpoch: requested.stateEpoch, confirmationText: phrase,
  });
  return { read, requested, recorded };
}

test('用户没改：externalChange 为空，先说短语再请求照样批准', async () => {
  await withDraft(async ({ service }) => {
    const { read, requested, recorded } = await handshake(service, '批准 requirements');
    assert.equal(read.externalChange, null, '没改过却报了改动 —— agent 会向用户报一个不存在的变化');
    assert.equal(requested.recommendedPhrase, '批准 requirements');
    assert.equal(recorded.code, undefined, JSON.stringify(recorded));
    const status = await service.call('spec_status', { spec: SPEC });
    assert.equal(status.phase, 'design_draft');
  });
});

test('用户在起草期直接改了文件：读到 externalChange，批准照常完成且落在改后的版本上', async () => {
  await withDraft(async ({ service, file }) => {
    const edited = requirements.replace('return a widget', 'return exactly one widget');
    await writeFile(file, edited);

    const { read, recorded } = await handshake(service, '批准 requirements');
    assert.ok(read.externalChange, '用户的改动没被识别 —— agent 无从向用户报告它批准的是哪一版');
    assert.match(read.content, /exactly one widget/);
    assert.equal(recorded.code, undefined, `起草期的外部改动让批准失败了：${JSON.stringify(recorded)}`);

    const status = await service.call('spec_status', { spec: SPEC });
    assert.equal(status.phase, 'design_draft');
    assert.equal(await readFile(file, 'utf8'), edited, '批准过程改动了用户的文件');
  });
});

test('请求与记录之间内容又变了：拒绝批准（不落到没看过的版本上）', async () => {
  await withDraft(async ({ service, file }) => {
    const { recorded } = await handshake(service, '批准 requirements', {
      between: () => writeFile(file, requirements.replace('return a widget', 'return two widgets')),
    });
    assert.equal(recorded.code, 'APPROVAL_STALE', `内容变了仍被批准：${JSON.stringify(recorded)}`);
    const status = await service.call('spec_status', { spec: SPEC });
    assert.equal(status.phase, 'requirements_draft');
  });
});

test('短语不逐字一致：拒绝', async () => {
  await withDraft(async ({ service }) => {
    const { recorded } = await handshake(service, '批准需求');
    assert.equal(recorded.code, 'APPROVAL_TEXT_INVALID');
  });
});
