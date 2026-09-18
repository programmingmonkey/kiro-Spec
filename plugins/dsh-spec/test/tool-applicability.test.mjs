// 两个分析器工具的**渲染面**：「没查」必须与「查过且干净」长得不同。
//
// 软件侧的适用性判据在 `packages/spec-analysis/test/applicability.test.mjs`；本文件补的是
// **使用者真正看到的那一行**。判据再对，渲染成 `0 error(s), 0 warning(s)` 也等于没修 ——
// 本缺陷的形态就是"沉默被读成通过"，而沉默是在**输出**里被读的。
//
// 旧套件到不了的路径：`capabilities.test.mjs` 确实调了这两个工具，但它只喂**有需求块**的
// feature 语料（还断言 finding 条数以防空跑）。它从不喂"没有 requirements.md / 零需求块"的
// 输入，因此"渲染成零报告"这件事在旧套件里没有任何一条断言会红。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cleanup, makeProject, mount } from './harness.mjs';

const TASKS = '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. A\n';

const BUGFIX = [
  '# Bugfix Requirements Document', '', '## Introduction', '', 'x', '', '## Bug Analysis', '',
  '### Current Behavior (Defect)', '', '1.1 WHEN a THEN the system b', '',
  '### Expected Behavior (Correct)', '', '2.1 WHEN a THEN the system SHALL c', '',
  '### Unchanged Behavior (Regression Prevention)', '', '3.1 WHEN a THEN the system SHALL CONTINUE TO d', '',
].join('\n');

const REQUIREMENTS = [
  '# Requirements Document', '', '## Introduction', '', 'x', '', '## Requirements', '',
  '### 1. Widget', '', '**User Story:** As a, I want b, so that c.', '',
  '#### Acceptance Criteria', '1. WHEN x THE SYSTEM SHALL y', '',
].join('\n');

function seed(feature, files) {
  const root = makeProject();
  mkdirSync(join(root, '.kiro', 'specs', feature), { recursive: true });
  writeFileSync(join(root, '.kiro', 'specs', '_active'), `${feature}\n`);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, '.kiro', 'specs', feature, name), content);
  }
  return root;
}

describe('Req 2.5 — 不适用时首行必须显式，且不得打印计数行', () => {
  it('spec_checklist · kind=bugfix 语料', async () => {
    const root = seed('a-bugfix', { 'bugfix.md': BUGFIX, 'tasks.md': TASKS });
    try {
      const { call } = mount(root, {});
      const out = await call('spec_checklist', {});
      assert.equal(out.report.applicable, false);
      assert.match(out.rendered.split('\n')[0], /未分析/, '首行没有显式说明"没查"');
      assert.doesNotMatch(out.rendered, /0 error\(s\)/, '仍然打印了计数行 —— 那就是本缺陷的形态');
      assert.match(out.rendered, /不是「查过且干净」/);
    } finally {
      cleanup(root);
    }
  });

  it('spec_drift · kind=bugfix 语料', async () => {
    const root = seed('a-bugfix', { 'bugfix.md': BUGFIX, 'tasks.md': TASKS });
    try {
      const { call } = mount(root, {});
      const out = await call('spec_drift', {});
      assert.equal(out.report.applicable, false);
      assert.match(out.rendered.split('\n')[0], /未分析/, '首行没有显式说明"没查"');
      assert.doesNotMatch(out.rendered, /requirement\(s\) examined/, '仍然打印了"examined"计数行');
    } finally {
      cleanup(root);
    }
  });

  it('两份需求文件都不在时，原因与 bugfix 形态**不同**', async () => {
    const root = seed('a-bare', { 'tasks.md': TASKS });
    try {
      const { call } = mount(root, {});
      const out = await call('spec_checklist', {});
      assert.match(out.rendered.split('\n')[0], /NO_REQUIREMENTS_FILE/);
    } finally {
      cleanup(root);
    }
  });
});

describe('Req 3.5 — feature 形态的渲染逐字不变', () => {
  it('有需求块时照常给计数行', async () => {
    const root = seed('a-feature', { 'requirements.md': REQUIREMENTS, 'tasks.md': TASKS });
    try {
      const { call } = mount(root, {});
      const out = await call('spec_checklist', {});
      assert.equal(out.report.applicable, true);
      assert.match(out.rendered.split('\n')[1], /^\d+ error\(s\), \d+ warning\(s\), \d+ info — \d+ requirement block\(s\) clean/);
    } finally {
      cleanup(root);
    }
  });
});
