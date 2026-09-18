// 06-claude-spec Task 3 —— 写策略从 `evaluation-only` 改为「已授权」。
//
// 依据是消费项目 §0 的**现行**原文：*「已解锁的（当前 Kiro / DSH / Codex / Claude Code）
// 直接写正式 `.kiro/specs/<feature>/`，不走 `_eval-` 目录、不受第 2、3 条约束，
// 只需 §4.3.2 署名。Claude Code 安装 `claude-spec` 插件或接 MCP 后无需重新评估。」*
// ⚠️ 2026-09-17 订正：这段引文里原本写的是 `Claude Cowork`。消费项目同日把那条通道**退役**、
// 改登记为本地 `Claude Code` —— 引文照对面改；本测试的**判据**（mode 必须留在 `authorized`）
// 一字未变：它判的是授权，不是宿主名。
//
// 这一条**不是**「把闸门删掉」：
//   · `authorized` 只撤掉「正式目录要不要先登记」这一层；
//   · 写入仍被限制在 `specsRoot` 之内，路径/符号链接两条防线一条没少（下面有断言钉着）；
//   · `evaluation-only` 那条给未解锁宿主的 hash 闸门原样保留（也有断言钉着）。
// 换句话说：改的是**已解锁宿主**的通道，不是所有人的通道。

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '..');
const AUTHORITY_REL = '.kiro/steering/spec-conventions.md';
const AUTHORITY_TEXT = '# Spec conventions\n';
const REQUIREMENTS = '# Requirements\n\n## Requirement 1\n\nThe system SHALL keep a record.\n';

const SKILL_MESSAGE =
  'Claude 已解锁（消费项目 §0 已登记）：adapter.example.json 的 writePolicy.mode 必须留在 ' +
  '`authorized`。改回 `evaluation-only` 会把新装的 claude-spec 关回 `_eval-codex-YYYYMMDD/` 通道，' +
  '而 §0 明确写了「无需重新评估」—— 那不是可以商量的风格问题，是授权原文。';

async function fixture({ writePolicy }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-writepolicy-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await writeFile(path.join(root, AUTHORITY_REL), AUTHORITY_TEXT);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy,
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: [AUTHORITY_REL] }]
  }));
  return root;
}

const start = (root) => createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });

async function writeRequirements(service, spec) {
  const prior = await service.call('spec_read', { spec, artifact: 'requirements' });
  const proof = (await service.call('spec_context', { spec, artifact: 'requirements' })).contextProof;
  return service.call('spec_write', {
    spec, artifact: 'requirements', content: REQUIREMENTS,
    expectedRawRevision: prior.code ? undefined : prior.rawRevision, contextProof: proof
  });
}

// ── 示例文件的形状 ────────────────────────────────────────────────────────────

test('Task 3 Step 1 — adapter.example.json 是「直写正式目录」的形态', async () => {
  const example = JSON.parse(await readFile(path.join(pluginRoot, 'adapter.example.json'), 'utf8'));
  assert.equal(example.writePolicy.mode, 'authorized');
  // 省略 `allowedPrefixes` 就是「specsRoot 本身」，即任何正式的 `.kiro/specs/<feature>/`。
  // 写成逐目录登记会让「新建一个 spec 目录」必须先改配置，而 §0 要的正是去掉这一层。
  assert.equal(example.writePolicy.allowedPrefixes, undefined);
  assert.equal(example.writePolicy.authorityFile, AUTHORITY_REL);
  assert.equal(example.writePolicy.authorityHash, 'sha256:REPLACE_WITH_COMPUTED_HASH');
  assert.doesNotMatch(JSON.stringify(example), /_eval-/, '示例里不该再出现评估目录');
});

test('🔴 Task 3 Step 3 反向绊线 —— 写策略被改回 evaluation-only 时这条必须红', async () => {
  // 这条断言的全部意义就是「有人改回去时会红，且红得说明白为什么」。
  // 它故意不复用上面的 test：上面那条查的是一组形状，这一条只查档位，消息里带依据。
  const example = JSON.parse(await readFile(path.join(pluginRoot, 'adapter.example.json'), 'utf8'));
  assert.equal(example.writePolicy.mode, 'authorized', SKILL_MESSAGE);
});

// ── 已授权：直写正式目录 ──────────────────────────────────────────────────────

test('authorized + 省略 allowedPrefixes —— 可以新建正式 spec 目录并直接写入', async () => {
  const root = await fixture({ writePolicy: { mode: 'authorized', authorityFile: AUTHORITY_REL, authorityHash: computeRawRevision(AUTHORITY_TEXT) } });
  const service = await start(root);
  // 这正是 Task 7 Step 3 真实闭环的前置：**新建**一个 spec 目录，不是往登记过的目录里写。
  const created = await service.call('spec_init', { spec: 'brand-new-feature', workflow: 'requirements-first' });
  assert.equal(created.code, undefined, `新建正式 spec 目录被拒：${JSON.stringify(created)}`);
  const written = await writeRequirements(service, 'brand-new-feature');
  assert.equal(written.code, undefined, `直写正式目录被拒：${JSON.stringify(written)}`);
  assert.equal(await readFile(path.join(root, '.kiro', 'specs', 'brand-new-feature', 'requirements.md'), 'utf8'), REQUIREMENTS);

  const health = await service.call('spec_health', {});
  assert.equal(health.writeMode, 'authorized');
  // 归一化后的内部表示：空串前缀 = specsRoot 本身。
  assert.deepEqual(health.allowedPrefixes, ['']);
});

test('authorized + 显式 allowedPrefixes —— 仍然是一张 allowlist，不是万能通行证', async () => {
  const root = await fixture({ writePolicy: { mode: 'authorized', allowedPrefixes: ['projects/'] } });
  const service = await start(root);
  assert.equal((await service.call('spec_init', { spec: 'projects/inside', workflow: 'requirements-first' })).code, undefined);
  const outside = await service.call('spec_init', { spec: 'not-listed', workflow: 'requirements-first' });
  assert.equal(outside.code, 'WRITE_POLICY_DENIED', '显式登记时，没登记的名字必须仍然被拒');
});

test('authorized 不等于放行一切 —— 路径仍被限制在 specsRoot 之内', async () => {
  const root = await fixture({ writePolicy: { mode: 'authorized' } });
  const service = await start(root);
  for (const spec of ['../escape', '/etc/passwd', 'a/../../b']) {
    const result = await service.call('spec_init', { spec, workflow: 'requirements-first' });
    assert.equal(result.code, 'INVALID_FEATURE_NAME', `${spec} 不该被放行`);
  }
});

// ── authority 是台账，不是闸门 ────────────────────────────────────────────────

test('Task 3 Step 2 — authorized 下 authorityHash 对不上**不阻断**写入，但漂移要看得见', async () => {
  const root = await fixture({ writePolicy: { mode: 'authorized', authorityFile: AUTHORITY_REL, authorityHash: 'sha256:recorded-on-another-day' } });
  const service = await start(root);

  const health = await service.call('spec_health', {});
  assert.equal(health.authority.status, 'drifted', '漂移必须回报，否则「台账」两个字就是空的');
  assert.equal(health.authority.file, AUTHORITY_REL);
  assert.equal(health.authority.recordedHash, 'sha256:recorded-on-another-day');
  assert.equal(health.authority.currentHash, computeRawRevision(AUTHORITY_TEXT));

  // 🔴 关键的一半：Kiro 改一个错别字之后，插件**不许**罢工。
  assert.equal((await service.call('spec_init', { spec: 'still-writable', workflow: 'requirements-first' })).code, undefined);
  assert.equal((await writeRequirements(service, 'still-writable')).code, undefined);
});

test('authorityFile 不存在时也只是回报 unreadable，不阻断', async () => {
  const root = await fixture({ writePolicy: { mode: 'authorized', authorityFile: '.kiro/steering/absent.md', authorityHash: 'sha256:x' } });
  const service = await start(root);
  assert.equal((await service.call('spec_health', {})).authority.status, 'unreadable');
  assert.equal((await service.call('spec_init', { spec: 'demo', workflow: 'requirements-first' })).code, undefined);
});

// ── 未解锁宿主的那道闸门没被拆掉 ──────────────────────────────────────────────

test('evaluation-only 仍然是闸门：hash 对不上即 ADAPTER_UNTRUSTED', async () => {
  const root = await fixture({ writePolicy: { mode: 'evaluation-only', allowedPrefixes: ['_eval-codex-20260908/'], authorityFile: AUTHORITY_REL, authorityHash: 'sha256:wrong' } });
  await assert.rejects(() => start(root), (caught) => caught.code === 'ADAPTER_UNTRUSTED');
});

test('evaluation-only 仍然只认规范的评估目录前缀', async () => {
  const root = await fixture({ writePolicy: { mode: 'evaluation-only', allowedPrefixes: ['_eval-codex-20260908/'], authorityFile: AUTHORITY_REL, authorityHash: computeRawRevision(AUTHORITY_TEXT) } });
  const service = await start(root);
  assert.equal((await service.call('spec_init', { spec: '_eval-codex-20260908', workflow: 'requirements-first' })).code, undefined);
  assert.equal((await service.call('spec_init', { spec: 'a-real-feature', workflow: 'requirements-first' })).code, 'WRITE_POLICY_DENIED');
});
