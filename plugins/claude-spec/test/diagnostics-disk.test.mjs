// `spec_diagnostics` 的 `findings` —— 对标 Kiro `get_diagnostics` 的 spec 分支（2026-09-17）。
//
// 钉四件事：① 读的是**盘上**的文件（调用方不传正文）；② specType 取 `.config.kiro` 写明的值；
// ③ 缺席的 artifact 列进 `missingArtifacts` 而不是报错；④ 只读 —— 私有状态文件逐字节不变。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMcpService } from '../lib/mcp/service.mjs';

const SPEC = 'specs/demo';

const DESIGN_WITH_MARKER = [
  '# Design Document', '', '## Overview', '', 'x', '', '## Architecture', '', 'x', '',
  '## Components and Interfaces', '', 'x', '', '## Data Models', '', 'x', '',
  '## Correctness Properties', '', 'x', '', '## Error Handling', '', 'x', '',
  '## Testing Strategy', '', 'x', '', '## Fix Implementation', '', '顺带一段修复实现。', '',
].join('\n');
const TASKS_NO_GRAPH = '# Implementation Plan: x\n\n## Overview\n\nx\n\n## Tasks\n\n- [ ] 1. 做一件事\n\n## Notes\n\nx\n';
const BUGFIX = '# Bugfix Requirements Document\n\n## Introduction\n\nx\n\n## Bug Analysis\n\n### Current Behavior (Defect)\n\n1.1 WHEN y THEN the system does wrong\n\n### Expected Behavior\n\n2.1 WHEN y THEN the system does right\n\n### Unchanged Behavior (Regression Prevention)\n\n3.1 WHEN z THEN the system SHALL CONTINUE TO be fine\n';

/** 在盘上放好 spec 文件后 `spec_adopt`，返回 service 与私有状态文件路径。 */
async function adopted(files, workflow) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-diag-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro',
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [],
  }));
  const dir = path.join(root, '.kiro', 'specs', 'demo');
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  const privateDir = path.join(root, '.private');
  const service = await createMcpService({ projectRoot: root, privateDir });
  const result = await service.call('spec_adopt', { spec: SPEC, ...(workflow ? { workflow } : {}) });
  assert.equal(result.code, undefined, JSON.stringify(result));
  const stateFile = path.join(privateDir, `state-${createHash('sha256').update(SPEC).digest('hex')}.json`);
  return { root, service, stateFile };
}

const codes = (result) => result.findings.map((f) => `${f.artifact}:${f.ruleId}`);

test('读盘诊断：调用方只传 spec 名，缺席的 artifact 单独列出', async () => {
  const { root, service } = await adopted({ 'design.md': '# Design Document\n\n## Overview\n\nx\n' }, 'requirements-first');
  try {
    const result = await service.call('spec_diagnostics', { spec: SPEC });
    assert.ok(codes(result).includes('design:design/missing-architecture'), JSON.stringify(result.findings));
    assert.deepEqual(result.missingArtifacts, ['requirements', 'tasks']);
    assert.equal(result.specType, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('.config.kiro 写明 feature：带 bugfix 标题的 design 不嗅探；对照组（无 config）嗅探', async () => {
  const declared = await adopted({ '.config.kiro': '{"specType":"feature","workflowType":"requirements-first"}', 'design.md': DESIGN_WITH_MARKER });
  const plain = await adopted({ 'design.md': DESIGN_WITH_MARKER }, 'requirements-first');
  try {
    const withConfig = await declared.service.call('spec_diagnostics', { spec: SPEC });
    assert.equal(withConfig.specType, 'feature');
    assert.ok(!codes(withConfig).includes('design:design/missing-bug-details'), JSON.stringify(withConfig.findings));
    const without = await plain.service.call('spec_diagnostics', { spec: SPEC });
    assert.ok(codes(without).includes('design:design/missing-bug-details'), JSON.stringify(without.findings));
  } finally {
    await rm(declared.root, { recursive: true, force: true });
    await rm(plain.root, { recursive: true, force: true });
  }
});

test('写明 bugfix 才豁免依赖图；只凭 workflow=bugfix 不豁免（与 get_diagnostics 一致）', async () => {
  const declared = await adopted({ '.config.kiro': '{"specType":"bugfix"}', 'bugfix.md': BUGFIX, 'tasks.md': TASKS_NO_GRAPH });
  const explicit = await adopted({ 'bugfix.md': BUGFIX, 'tasks.md': TASKS_NO_GRAPH }, 'bugfix');
  try {
    const a = await declared.service.call('spec_diagnostics', { spec: SPEC });
    assert.ok(!codes(a).includes('tasks:tasks/missing-dependency-graph'), JSON.stringify(a.findings));
    const b = await explicit.service.call('spec_diagnostics', { spec: SPEC });
    assert.ok(codes(b).includes('tasks:tasks/missing-dependency-graph'), JSON.stringify(b.findings));
  } finally {
    await rm(declared.root, { recursive: true, force: true });
    await rm(explicit.root, { recursive: true, force: true });
  }
});

test('只读：盘上文件被外部改过，诊断照样读新内容，但私有状态逐字节不变', async () => {
  const { root, service, stateFile } = await adopted({ 'design.md': DESIGN_WITH_MARKER }, 'requirements-first');
  try {
    const before = await readFile(stateFile, 'utf8');
    await writeFile(path.join(root, '.kiro', 'specs', 'demo', 'design.md'), '# Design Document\n');
    const result = await service.call('spec_diagnostics', { spec: SPEC });
    assert.ok(codes(result).includes('design:design/missing-overview'), '没读到盘上的新内容');
    assert.equal(await readFile(stateFile, 'utf8'), before, 'spec_diagnostics 改了私有状态 —— 它声明的是 readOnlyHint');
  } finally { await rm(root, { recursive: true, force: true }); }
});
