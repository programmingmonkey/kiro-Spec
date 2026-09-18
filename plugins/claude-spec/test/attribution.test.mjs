// 06-claude-spec 收口 —— §4.3.2 署名：插件必须真的写得出来。
//
// 这条测试的存在理由比它本身更重要：
// 2026-09-13 第 6 期首版交付时，`@my-harness/spec-analysis` 是一个 **declared-but-unused**
// 依赖 —— package.json 里有，代码里零调用点。后果不是「署名格式不好看」，而是
// **claude-spec 一条署名都写不出来**，而署名是消费项目对已解锁底座的**唯一硬要求**
// （steering §0：「DSH 已解锁、不在其适用范围内。唯一的硬要求是 §4.3.2 的署名」）。
// 那次缺口只被写在一条 commit message 里，README 没有、计划没有、**没有任何一条测试会红**。
// 本文件就是那条会红的测试。
//
// 🔴 为什么署名必须走 `spec_write` 而不是单独的「补签」工具：
// 署名与它所描述的改动**一起**落进同一次原子写 —— 少一类事后操作，而且环境标识（写死
// `Claude`）由插件校验，不靠调用方手写不出错。
// ⚠️ 2026-09-17：这里原先还写着「通道字面量（`Cowork`）由插件校验」。那条要求已被消费项目
// 撤销（理由：**被插件强制注入 ⇒ 不再追踪现实，只制造假台账**），故本文件的判据只剩
// 「环境标识 + 非空说明」。跨语言的行为等价由 `signature-pin.test.mjs` 守着。
//
// ⚠️ 这里原先给的理由（steering §4.3.2：「批准之后再单独补一行署名会改掉
// `approvalFingerprint`，`observe()` 判为 `external_change_detected` 并作废该 artifact
// 的审批」）**已不成立**：第 8 期 `spec-sign-approval-clobber` 把
// `computeApprovalFingerprint` 升到 `semantic-v2`，`tasks.md` 上的**合法**署名行与合法
// 执行事件块一样被剥掉，不再是语义。仍然成立的只剩更窄的两条 —— 手工追加的行若写歪了
// （过不了 `parseSignatureLine`）仍是一次实质改动；豁免只覆盖 `tasks.md`。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isValidSignatureLine } from '@my-harness/spec-analysis/signature';
import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '..');
const AUTHORITY_REL = '.kiro/steering/spec-conventions.md';
const AUTHORITY_TEXT = '# Spec conventions\n';
const REQUIREMENTS = '# Requirements Document\n\n## Requirement 1\n\nThe system SHALL keep a record.\n';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-attribution-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await writeFile(path.join(root, AUTHORITY_REL), AUTHORITY_TEXT);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: { mode: 'authorized', authorityFile: AUTHORITY_REL, authorityHash: computeRawRevision(AUTHORITY_TEXT) },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: [AUTHORITY_REL] }]
  }));
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  await service.call('spec_init', { spec: 'attrib-demo', workflow: 'requirements-first' });
  return { root, service };
}

async function writeRequirements(service, spec, extra = {}) {
  const prior = await service.call('spec_read', { spec, artifact: 'requirements' });
  const proof = (await service.call('spec_context', { spec, artifact: 'requirements' })).contextProof;
  return service.call('spec_write', {
    spec, artifact: 'requirements', content: REQUIREMENTS,
    expectedRawRevision: prior.code ? undefined : prior.rawRevision, contextProof: proof, ...extra
  });
}

// ── 绊线：依赖必须**真的被用**，不能只写在 package.json 里 ────────────────────

test('🔴 绊线：spec-analysis 必须真的被 lib/ 引用（declared-but-unused 即红）', () => {
  const declared = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).dependencies ?? {};
  assert.ok(declared['@my-harness/spec-analysis'], 'package.json 必须声明 spec-analysis');
  const service = readFileSync(path.join(pluginRoot, 'lib', 'mcp', 'service.mjs'), 'utf8');
  assert.match(
    service,
    /from '@my-harness\/spec-analysis\/signature'/,
    '声明了却没人 import —— 这正是 2026-09-13 首版的缺口：插件一条署名都写不出来，' +
      '而署名是消费项目对已解锁底座的唯一硬要求。',
  );
  assert.match(service, /renderSignature\(/, 'import 了但不调用，等于没接');
});

// ── 正向：带 signature 的写入 ─────────────────────────────────────────────────

test('spec_write 带 signature —— 署名进文件，且被消费项目现行 pre-commit 判为合规', async () => {
  const { root, service } = await fixture();
  const written = await writeRequirements(service, 'attrib-demo', { signature: 'Cowork；requirements.md：补配额边界' });
  assert.equal(written.code, undefined, `写入被拒：${JSON.stringify(written)}`);
  assert.ok(written.signatureLine, '返回值要带回落盘的那一行，调用方才能自查');
  assert.equal(written.attributionWarning, null, '带了 signature 就不该再警告');

  const text = await readFile(path.join(root, '.kiro', 'specs', 'attrib-demo', 'requirements.md'), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('- ') && l.includes('Claude'));
  assert.ok(line, `落盘内容里找不到署名行：\n${text}`);

  // 判据的事实源是消费项目的 `.githooks/pre-commit`，不是本文件自己的正则 —— 见 R6-2。
  assert.equal(isValidSignatureLine(line), true, `这一行过不了消费项目的 pre-commit：${line}`);
  assert.equal(line, line.trimStart(), '署名必须在行首第 1 列：缩进进列表容器或代码块的一律不被 hook 认');
});

test('署名与内容在**同一次**原子写里落盘（不是写完再补一次）', async () => {
  const { root, service } = await fixture();
  const written = await writeRequirements(service, 'attrib-demo', { signature: 'Cowork；requirements.md：初稿' });
  const text = await readFile(path.join(root, '.kiro', 'specs', 'attrib-demo', 'requirements.md'), 'utf8');
  // rawRevision 是对**含署名**的最终内容算的：若署名是事后补的，这两个值必然对不上，
  // 而对不上正是 steering 说的 external_change_detected → 作废审批。
  assert.equal(written.rawRevision, computeRawRevision(Buffer.from(text)));
});

test('原文没有 ## Notes 时新起一个（§4.3.2：tasks.md 还不存在就签在当前文件末尾）', async () => {
  const { root, service } = await fixture();
  await writeRequirements(service, 'attrib-demo', { signature: 'Cowork；requirements.md：初稿' });
  const text = await readFile(path.join(root, '.kiro', 'specs', 'attrib-demo', 'requirements.md'), 'utf8');
  assert.match(text, /^## Notes$/m);
  assert.ok(text.indexOf('## Notes') > text.indexOf('## Requirement 1'), '新起的 Notes 应在正文之后');
});

// ── 反向：必须红的几条（其中「Claude 缺字面量」一条已于 2026-09-17 翻向，见下） ──────

test('🔴 反向（2026-09-17 翻向）— Claude 的 summary 不含那个词也照写，且仍过消费项目现行判定', async () => {
  // 这条原先断言「缺 `Cowork` ⇒ SIGNATURE_INVALID」。消费项目于 2026-09-17 撤掉了那条
  // 字面量要求（理由：**它被插件强制注入，于是不再追踪现实、只制造假台账**），所以现在断言
  // **相反的结论**：不含那个词照样写。
  // ⚠️ 但「放开」不能变成「签出不合规的行」—— 所以顺手证明产出的那一行仍过消费项目的判定。
  const { root, service } = await fixture();
  const written = await writeRequirements(service, 'attrib-demo', { signature: 'requirements.md：补配额边界' });
  assert.equal(written.code, undefined, `不该再拒：${JSON.stringify(written)}`);
  const text = await readFile(path.join(root, '.kiro', 'specs', 'attrib-demo', 'requirements.md'), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('- ') && l.includes('Claude'));
  assert.ok(line, `落盘内容里找不到署名行：\n${text}`);
  assert.equal(isValidSignatureLine(line), true, `这一行过不了消费项目的 pre-commit：${line}`);
});

test('🔴 不传 signature —— 不阻断，但必须带回 attributionWarning（与消费项目同为 warn 档）', async () => {
  const { service } = await fixture();
  const written = await writeRequirements(service, 'attrib-demo');
  assert.equal(written.code, undefined, '不带署名不该阻断写入 —— 消费项目自己的 check_spec_signature 也是 warn 级');
  assert.ok(written.attributionWarning, '但必须报出来，否则就是「检测到了但什么都没发生」');
  assert.match(written.attributionWarning, /§4\.3\.2/);
  assert.match(written.attributionWarning, /作废/, '要说清补签的正确方式，否则调用方会去事后追加一行');
});

test('🔴 环境标识写死为 Claude，不接受调用方指定', async () => {
  const service = readFileSync(path.join(pluginRoot, 'lib', 'mcp', 'service.mjs'), 'utf8');
  assert.match(service, /const SIGNATURE_ENV = 'Claude';/);
  assert.doesNotMatch(
    service,
    /renderSignature\(\{\s*env:\s*params\./,
    '让调用方自选 env 就是 §4.3.2 红字说的「借用别人的标识」—— 署错比不署更糟',
  );
});
