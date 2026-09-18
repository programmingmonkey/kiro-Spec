// T3b（第 9 期）—— `spec_adopt` 从哪里知道「这是哪一种 spec」。
//
// 真机把类型写在 `<specDir>/.config.kiro` 里并**用它**选规则表（开发仓实测 §3.4）。
// 所以接管一个存量 spec 时那个文件是第一手证据：让调用方凭记忆手写 `workflow`，等于把
// 盘上已经写好的答案换成一次猜测。本文件钉三件事：
//
//   ① **能派生的就派生**，且**后果**正确 —— 不只看返回的字段，要看它真的选对了那条
//      workflow（`bugfix` 的第一阶段是 `bug_analysis_draft`，feature 形是 `*_draft` 另一种）；
//   ② **不能派生的不猜**（`quick-spec` / `fast-task` / `verify-first` / config 缺席或坏掉）——
//      要求调用方显式给，并且错误里说清是哪一种情形；
//   ③ **显式值与文件声明冲突时不替它选**，也不写到盘上（接管失败必须不留残留）。
//
// ⚠️ 为什么这些断言必须走真路径（`createMcpService`）而不是单测一个纯函数：
// `workflowFromConfig` 是本包**私有**的（`shape.test.mjs` 钉死了 `lib` 的导出集合，
// 不许长出新导出）。派生逻辑因此只能经 `spec_adopt` 观测 —— 这也正是它该被验的层次：
// 真正要保证的不是「映射表算得对」，而是「接管之后选中的是那一条 workflow」。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = '_eval-codex-20260827';

const ARTIFACTS = {
  requirements: '# Requirements\n\n## Requirement 1\n\nThe system SHALL retain a record.\n',
  design: '# Design\n\n## Overview\n\nA minimal design.\n',
  bugfix: '# Bugfix Analysis\n\n## Current Behavior\n\nThe system loses a record.\n',
  tasks: '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Implement the record\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n'
};

/**
 * 造一个工作区。`config` 是 `.config.kiro` 的**原文**（`undefined` = 不写这个文件），
 * `files` 是 spec 目录里要有的 artifact。
 */
async function setup({ config, files = ['tasks'] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-adopt-config-'));
  const specDir = path.join(root, '.kiro', 'specs', SPEC);
  await mkdir(specDir, { recursive: true });
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
  for (const name of files) await writeFile(path.join(specDir, `${name}.md`), ARTIFACTS[name]);
  if (config !== undefined) await writeFile(path.join(specDir, '.config.kiro'), config);
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  return { root, specDir, service, call: (params) => service.call('spec_adopt', { spec: SPEC, ...params }) };
}

const json = (value) => JSON.parse(JSON.stringify(value));

test('🔴 必填与否：`workflow` 不再是必填参数（省略时走 .config.kiro）', async () => {
  // 这条钉的是**契约**本身。省略 workflow 而在改动前会拿到 INVALID_FORMAT ——
  // 现在它要么成功（能从 config 派生），要么报 WORKFLOW_UNKNOWN（说不出类型）。
  // 换句话说：`INVALID_FORMAT: workflow is not supported` 这个答复**永远**不该再出现。
  const { call } = await setup({ config: '{"specType":"feature","workflowType":"requirements-first"}' });
  const adopted = await call({});
  assert.equal(adopted.workflow, 'requirements-first');
  assert.equal(adopted.workflowSource, 'config');
});

test('specType=bugfix ⇒ 真的选中 bugfix 那条流程（不只看字段）', async () => {
  const { call } = await setup({ config: '{"specType":"bugfix","workflowType":"requirements-first"}', files: ['bugfix', 'tasks'] });
  const adopted = await call({});
  assert.equal(adopted.workflow, 'bugfix');
  assert.equal(adopted.workflowSource, 'config');
  assert.equal(adopted.specType, 'bugfix', '真机的原值要如实回报');
  // **后果**：bugfix 链的第一阶段是 bug_analysis_draft。若选成 feature 形，这里会是
  // requirements_draft —— 而两种 artifact 完全不同（bugfix.md vs requirements.md）。
  assert.equal(adopted.phase, 'bug_analysis_draft');
});

test('specType=feature + 无 workflowType ⇒ 走真机读取端的默认回落 requirements-first', async () => {
  // 依据：真机读侧 `r.workflowType || WorkflowType.RequirementsFirst`（开发仓实测 §3.2）。
  const { call } = await setup({ config: '{"specType":"feature"}' });
  const adopted = await call({});
  assert.equal(adopted.workflow, 'requirements-first');
  assert.equal(adopted.phase, 'requirements_draft');
  assert.equal(adopted.workflowType, null, '文件没声明 workflowType，回报 null 而不是编一个');
});

test('specType=feature + workflowType=design-first ⇒ design-first', async () => {
  const { call } = await setup({ config: '{"specType":"feature","workflowType":"design-first"}' });
  const adopted = await call({});
  assert.equal(adopted.workflow, 'design-first');
  assert.equal(adopted.phase, 'design_draft');
});

test('8 种 keys 形态的边界：`{specName,specVersion}` 声明不了任何类型 ⇒ 不猜', async () => {
  // 这两种非标准形态在盘上真实存在（§4.2 各 1 例）。文件在、但什么都没声明 ——
  // 「文件在场」不等于「有类型」，这一条就是把这两件事分开。
  const { call } = await setup({ config: '{"specName":"admin-dashboard","specVersion":"1.0"}' });
  const result = await call({});
  assert.equal(result.code, 'WORKFLOW_UNKNOWN');
  assert.equal(result.details.reason, 'CONFIG_NO_TYPE');
  assert.equal(result.details.configPresent, true, '文件确实在场，别把它报成「没有配置」');
});

test('quick-spec ⇒ 不派生（两个词汇表答案不同 + 盘上 0 例），显式传就放行', async () => {
  const { call } = await setup({ config: '{"specType":"quick-spec","workflowType":"requirements-first"}' });
  const refused = await call({});
  assert.equal(refused.code, 'WORKFLOW_UNKNOWN');
  assert.equal(refused.details.reason, 'CONFIG_QUICK_SPEC');
  assert.match(refused.message, /quick-spec/);
  // 反面同样是判据：拒绝之后**没有留下任何残留** —— 显式接管仍然成功，且用 quick 链。
  const adopted = await call({ workflow: 'quick' });
  assert.equal(adopted.workflow, 'quick');
  assert.equal(adopted.workflowSource, 'explicit');
  assert.equal(adopted.phase, 'artifacts_generated');
});

test('本仓未建模的 workflowType（fast-task / verify-first）⇒ 不猜，并点名取值', async () => {
  for (const workflowType of ['fast-task', 'verify-first']) {
    const { call } = await setup({ config: `{"specType":"feature","workflowType":"${workflowType}"}` });
    const result = await call({});
    assert.equal(result.code, 'WORKFLOW_UNKNOWN', workflowType);
    assert.equal(result.details.reason, 'CONFIG_UNMODELED_WORKFLOW', workflowType);
    assert.equal(result.details.detail, workflowType);
    assert.match(result.message, new RegExp(workflowType));
  }
});

test('.config.kiro 缺席 / 坏掉 ⇒ 不猜（但两种情形在 details 里可区分）', async () => {
  const absent = await (await setup({})).call({});
  assert.equal(absent.code, 'WORKFLOW_UNKNOWN');
  assert.equal(absent.details.reason, 'CONFIG_ABSENT');
  assert.equal(absent.details.configPresent, false);

  const broken = await (await setup({ config: '{"specType":' })).call({});
  assert.equal(broken.code, 'WORKFLOW_UNKNOWN');
  assert.equal(broken.details.reason, 'CONFIG_UNUSABLE');
  assert.equal(broken.details.detail, 'INVALID_JSON');
  assert.notEqual(absent.message, broken.message, '「没有这个文件」与「文件坏了」不能给同一句话');
});

test('🔴 显式值与文件声明冲突 ⇒ 拒绝接管，且不写到盘上', async () => {
  const { call, service } = await setup({ config: '{"specType":"bugfix","workflowType":"requirements-first"}', files: ['bugfix'] });
  const conflict = await call({ workflow: 'requirements-first' });
  assert.equal(conflict.code, 'WORKFLOW_CONFLICT');
  assert.deepEqual(conflict.details, json({ requested: 'requirements-first', fromConfig: 'bugfix', specType: 'bugfix', workflowType: 'requirements-first' }));
  // 冲突时**不能**已经落了私有状态 —— 否则「拒绝」只拒绝了返回值。
  const listed = await service.call('spec_list', {});
  assert.equal(listed.specs.find((entry) => entry.spec === SPEC).lifecycle, 'external', '被拒绝的接管不得留下 managed 状态');
  // 而按文件声明接管就成功 —— 冲突的出路是「说一致的」，不是「随便挑一个」。
  const adopted = await call({ workflow: 'bugfix' });
  assert.equal(adopted.workflow, 'bugfix');
  assert.equal(adopted.workflowSource, 'explicit');
});

test('显式值与文件一致时不报冲突（冲突的是分歧，不是「同时给了」）', async () => {
  const { call } = await setup({ config: '{"specType":"feature","workflowType":"design-first"}' });
  const adopted = await call({ workflow: 'design-first' });
  assert.equal(adopted.workflowSource, 'explicit');
  assert.equal(adopted.specType, 'feature');
});

test('回归：没有 .config.kiro 时显式 workflow 的行为与改动前相同', async () => {
  const { call } = await setup({ files: ['requirements', 'design', 'tasks'] });
  const adopted = await call({ workflow: 'requirements-first' });
  assert.equal(adopted.workflow, 'requirements-first');
  assert.equal(adopted.workflowSource, 'explicit');
  assert.equal(adopted.status, 'imported');
  assert.deepEqual(Object.keys(adopted.artifacts).sort(), ['design', 'requirements', 'tasks'], '基线与改动前一致');
  // 不认识的 workflow 仍然当场拒（这条原先就成立，别在重排参数时弄丢）。
  const bogus = await (await setup({})).call({ workflow: 'waterfall' });
  assert.equal(bogus.code, 'INVALID_FORMAT');
});

test('🔴 工具结果必须能过 JSON 往返（不许漏出 undefined）', async () => {
  // 第 9 期 T3 的实测教训：第一版把 `specType` 写成 `undefined`，夹具的
  // `assertLosslessJson` 当场抓住（`$.specType is undefined`）。这条把要求钉在这里，
  // 免得「返回里有 undefined」再次靠某个下游宿主才发现。
  const { call } = await setup({ config: '{"specType":"feature","workflowType":"requirements-first"}' });
  const adopted = await call({});
  assert.deepEqual(json(adopted), adopted, '成功结果里有 undefined（JSON 往返后丢字段）');
  const refused = await (await setup({})).call({});
  assert.deepEqual(json(refused), refused, '错误结果里有 undefined（JSON 往返后丢字段）');
});

test('🔴 `workflowSource` 落进私有状态，`spec_status` / `spec_list` 都报得出来', async () => {
  // T3 的判据之一写着「补 `/spec status` 里一行告知：当前的 specType/workflowType 的来源是
  // config 还是推断」。**只把来源放在 adopt 的返回值里不算** —— 下一次调用就丢了，
  // 而「这份 spec 为什么是 bugfix 形」恰恰是**事后**才会被问到的问题。
  // dsh-spec 那边早就有这个字段（config/meta/artifact/default）；这里补上的是另两个宿主。
  const { call, service } = await setup({ config: '{"specType":"bugfix"}', files: ['bugfix'] });
  assert.equal((await call({})).workflowSource, 'config', '接管那一刻就该报出来');

  const status = await service.call('spec_status', { spec: SPEC });
  assert.equal(status.workflowSource, 'config', '状态里也要说得出「怎么知道的」');
  const entry = (await service.call('spec_list', {})).specs.find((candidate) => candidate.spec === SPEC);
  assert.equal(entry.workflowSource, 'config');
});

test('显式接管与 `spec_init` 都记成 `explicit`（同一套词汇，新旧状态可区分）', async () => {
  const explicit = await setup({ files: ['tasks'] });
  assert.equal((await explicit.call({ workflow: 'quick' })).workflowSource, 'explicit');
  assert.equal((await explicit.service.call('spec_status', { spec: SPEC })).workflowSource, 'explicit');

  // `spec_init` 不读 `.config.kiro`（它建的是新 spec，现场还没有那个文件）——
  // 来源是调用方给的，所以同样是 `explicit`，不是「未知」。
  const initialised = await setup({ files: ['tasks'] });
  await initialised.service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' });
  assert.equal((await initialised.service.call('spec_status', { spec: SPEC })).workflowSource, 'explicit');
});

test('🔴 `workflow` 类型不对时**不当成「没传」**（否则调用方以为自己指定过）', async () => {
  // 服务端**不强制** inputSchema（`validateToolArguments` 没有调用点，schema 是给宿主看的说明），
  // 所以这一层是唯一一道门。`null` / 数字 / 对象被静默当成省略的话，调用方指定的东西被丢了
  // 而它以为生效了 —— 那是「成功了但成功错了」的形状。
  const { call } = await setup({ config: '{"specType":"bugfix"}' });
  for (const bad of [null, 42, {}, []]) {
    const result = await call({ workflow: bad });
    assert.equal(result.code, 'INVALID_FORMAT', `${JSON.stringify(bad)} 被当成了「省略」`);
  }
  // 反面：真的省略仍然走派生（这条与上面成对，防止我把 undefined 也一起拒掉）。
  assert.equal((await call({})).workflow, 'bugfix');
});
