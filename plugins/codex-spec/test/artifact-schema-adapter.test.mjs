// Task 7.1 —— 适配层的导出面与调用点契约。
//
// 接线的判据不只是「行为对」：适配层必须**保留** `artifactsForWorkflow` /
// `validateArtifactSchemas` 两个导出名与两处调用点，且 `artifactsForWorkflow` 对不支持的工作流
// 仍然**抛** `INVALID_FORMAT`（`lib/core/templates.mjs:11` 依赖这个行为来决定写不写）。
//
// 第 3 期 `packages/spec-parser/test/host-adapters.test.mjs` 是现成模板：一个「反正测试都过了」
// 就不补的判据，最后总会在某次重构里悄悄缩水。这里把它补上。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as schema from '../lib/core/artifact-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib');
const CORE = join(LIB, 'core');

test('适配层保留两个导出名', () => {
  assert.deepEqual(Object.keys(schema).sort(), ['artifactsForWorkflow', 'validateArtifactSchemas']);
  assert.equal(typeof schema.artifactsForWorkflow, 'function');
  assert.equal(typeof schema.validateArtifactSchemas, 'function');
});

test('两处调用点仍然从本文件导入（没有被绕过）', () => {
  // 第 7 期 Task 3：`artifact-schema.mjs` 与它的两处调用点都搬进了 `@my-harness/spec-state`
  // （13 个 core 文件在两个 host 之间逐字节相同）。这条绊线的**判据没变**——「调用点必须从
  // 这个模块 import，不许自己另写一份」——只是被测对象换了位置，所以它跟着换：
  //   ① 宿主的 `lib/core/templates.mjs` 必须是指向共享包的 shim（宿主里不许再有实现）；
  //   ② 共享包里的 templates 与 service 仍然从 `artifact-schema` import。
  const shim = readFileSync(join(CORE, 'templates.mjs'), 'utf8');
  assert.match(shim, /export \* from '@my-harness\/spec-state\/core\/templates'/);
  const PKG = join(HERE, '..', '..', '..', 'packages', 'spec-state', 'lib');
  const templates = readFileSync(join(PKG, 'core', 'templates.mjs'), 'utf8');
  const service = readFileSync(join(PKG, 'index.mjs'), 'utf8');
  assert.match(templates, /import \{ artifactsForWorkflow \} from '\.\/artifact-schema\.mjs'/);
  assert.match(service, /import \{ validateArtifactSchemas \} from '\.\/core\/artifact-schema\.mjs'/);
});

test('artifactsForWorkflow 对不支持的工作流仍然抛 INVALID_FORMAT', () => {
  for (const workflow of ['requirements-first', 'design-first', 'bugfix', 'quick']) {
    const allowed = schema.artifactsForWorkflow(workflow);
    assert.ok(allowed instanceof Set, `${workflow} 应返回 Set`);
  }
  for (const bad of ['nope', '', undefined, null, 42]) {
    assert.throws(
      () => schema.artifactsForWorkflow(bad),
      (error) => error.code === 'INVALID_FORMAT',
      `${String(bad)} 应当抛 INVALID_FORMAT —— templates.mjs 依赖它`,
    );
  }
});

test('validateArtifactSchemas 仍然对畸形入参抛 INVALID_FORMAT', () => {
  assert.throws(() => schema.validateArtifactSchemas({ workflow: 'quick', artifacts: null }), (e) => e.code === 'INVALID_FORMAT');
  assert.throws(() => schema.validateArtifactSchemas({ workflow: 'quick', artifacts: [] }), (e) => e.code === 'INVALID_FORMAT');
  assert.throws(
    () => schema.validateArtifactSchemas({ workflow: 'quick', artifacts: { tasks: 42 } }),
    (e) => e.code === 'INVALID_FORMAT',
  );
});

test('非白名单 artifact 的判定留在本层，且用历史字段名', () => {
  const findings = schema.validateArtifactSchemas({ workflow: 'quick', artifacts: { bugfix: '# X\n' } });
  assert.equal(findings.length, 1);
  assert.deepEqual(Object.keys(findings[0]).sort(), ['artifact', 'evidence', 'location', 'ruleId', 'severity', 'suggestedAction']);
  assert.equal(findings[0].ruleId, 'ARTIFACT_NOT_ALLOWED');
});

test('文档判定改由共享裁决层产出：码是 Kiro 原码，不是自造码', () => {
  const findings = schema.validateArtifactSchemas({
    workflow: 'requirements-first',
    artifacts: { design: '# Design Document\n' },
  });
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(!/^MISSING_/.test(f.ruleId), `${f.ruleId} 是第 3.5 期之前的自造码，应已消失`);
    assert.match(f.ruleId, /^(requirements|design|tasks|bugfix)\//, `${f.ruleId} 不像 Kiro 的原码`);
  }
  for (const key of ['artifact', 'evidence', 'location', 'ruleId', 'severity']) {
    assert.ok(key in findings[0], `适配层输出缺 ${key}`);
  }
});

test('第 3.5 期之前那三个自造码在整个插件里不再出现', () => {
  for (const file of ['artifact-schema.mjs', 'templates.mjs']) {
    const source = readFileSync(join(CORE, file), 'utf8');
    for (const invented of ['MISSING_REQUIRED_SECTION', 'MISSING_TASK_DEPENDENCY_GRAPH']) {
      // 只查**被引号包住的字面量**：文件顶部的注释会提到这两个名字（说明它们已消失），
      // 那是文档不是生产者。
      assert.equal(source.includes(`'${invented}'`), false, `${file} 里仍有 ${invented} 这个码在产出`);
    }
  }
});

// Task 0.3：接线前 codex-spec 侧对 `unterminated-fence` 是**零消费者**（`grep -rn
// hasUnterminatedFence plugins/codex-spec/` 零命中，且它那 3 条手写规则完全看不到围栏）。
// 于是同一份 F 形态文档，两个宿主的 findings 必然不同——这是 0.1 的一个实例。
// 判定是「接入时一并补上」，下面两条就是它的落地断言。
const F_FORM = [
  '# Implementation Plan', '', '## Overview', '', '> 概述', '', '## Tasks', '',
  '- [ ] 1. 分组', '  - [ ] 1.1 叶子', '    - _Requirements: 1.1_', '',
  '示例:', '', '````md', '任意内容', '```', '',
  '## Task Dependency Graph', '', '```json', '{ "waves": [{ "id": 0, "tasks": ["1.1"] }] }', '```', '',
  '## Notes', '', '> 备注', '', '- 无', '',
].join('\n');

test('codex-spec 现在会产出 tasks/unterminated-fence（Task 0.3 的「一并补上」）', () => {
  const findings = schema.validateArtifactSchemas({ workflow: 'quick', artifacts: { tasks: F_FORM } });
  const codes = findings.map((f) => f.ruleId);
  assert.ok(codes.includes('tasks/unterminated-fence'), `实得 ${JSON.stringify(codes)}`);
  // 少算必须可见：围栏吞掉的两节仍要报
  assert.ok(codes.includes('tasks/missing-notes'));
  assert.ok(codes.includes('tasks/missing-dependency-graph'));
});

test('F 形态文档上，两个宿主的 findings 集合一致（0.1 的那个实例已关闭）', async () => {
  const { diagnose } = await import('@my-harness/spec-diagnose');
  const kiro = schema
    .validateArtifactSchemas({ workflow: 'quick', artifacts: { tasks: F_FORM } })
    .map((f) => `${f.ruleId}/${f.severity}/${f.location.line}`)
    .sort();
  // codex-spec 走严格策略、dsh-spec 走宽松策略——本形态里没有 `[~]`，故两边应完全一致。
  const shared = diagnose({ artifact: 'tasks', markdown: F_FORM, strictTaskState: true })
    .map((f) => `${f.code}/${f.severity}/${f.location.line}`)
    .sort();
  assert.deepEqual(kiro, shared);
});

// 第 9 期 review（2026-09-17）：workflow 只管白名单，不再冒充真机的 specType。
// 本宿主建的 spec 没有 `.config.kiro`，真机打开它时照常要求依赖图 —— 本层须一致。
test('workflow=bugfix 不再豁免依赖图；只有显式 specType=bugfix 才豁免', () => {
  const tasks = '# Implementation Plan: x\n\n## Overview\n\nx\n\n## Tasks\n\n- [ ] 1. 做一件事\n\n## Notes\n\nx\n';
  const codes = (args) => schema.validateArtifactSchemas(args).map((f) => f.ruleId);
  assert.ok(codes({ workflow: 'bugfix', artifacts: { tasks } }).includes('tasks/missing-dependency-graph'));
  assert.ok(!codes({ workflow: 'bugfix', specType: 'bugfix', artifacts: { tasks } }).includes('tasks/missing-dependency-graph'));
});
