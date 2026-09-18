// 「没查」必须与「查过且干净」可区分 —— 两个分析器的适用性判据。
//
// 旧套件到不了的路径：`read-only-hash.test.mjs` 确实调了这两个入口，但它只喂**有需求块**的
// 语料（还断言 `findings.length > 0` / `entries.length === 2` 以防空跑），**从不喂**"没有
// `requirements.md`"或"零需求块"的输入 —— 而本缺陷恰好只在那三种输入上出现。
// 所以旧套件的那两条绿灯与这件事完全无关。
//
// 🔴 由来（2026-09-14 复验实测）：`runChecklist` / `runDrift` 对**三种完全不同的输入**
// 返回**逐字同形**的报告：
//
//   ① 目录里既没有 requirements.md 也没有 bugfix.md   → counts 全零 / entries 0
//   ② 目录里是 bugfix.md（需求在那三段里，没有 ### N. 块）→ counts 全零 / entries 0
//   ③ requirements.md 存在但为空（刚脚手架出来）      → counts 全零 / entries 0
//
// 三者在输出上与「有一份 requirements.md、逐条都干净」**只差数字**，而调用方拿到的
// 是一行 `0 error(s), 0 warning(s)` —— 读起来像"查过且干净"。
// 本项目的母题「守卫存在但守错了对象」在这里的变体是：**检查存在，但它的沉默长得像通过**。
//
// 判据的形状：`applicable: false` + 一个**说得出原因**的 `reason`。
// 为什么只做"显式不适用"而不真去解析 bugfix.md 的三段：见 `acceptance-net-firing` 的
// design.md「一处刻意不做」——那是新写一个分析器，不是修一个沉默。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runChecklist } from '../lib/checklist.js';
import { runDrift } from '../lib/drift.js';
import { fsPort } from './tools/fs-port.mjs';

const port = fsPort();

function specDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-analysis-applicability-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

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

const BOTH = [
  { label: 'kind=bugfix（bugfix.md + tasks.md）', files: { 'bugfix.md': BUGFIX, 'tasks.md': TASKS }, reason: 'NO_REQUIREMENT_BLOCKS' },
  { label: '两份都没有（只有 tasks.md）', files: { 'tasks.md': TASKS }, reason: 'NO_REQUIREMENTS_FILE' },
  { label: 'requirements.md 存在但为空', files: { 'requirements.md': '', 'tasks.md': TASKS }, reason: 'NO_REQUIREMENT_BLOCKS' },
];

describe('Req 2.5 — 三种「看起来空」的形态必须各自说出原因，而不是给一份零报告', () => {
  for (const { label, files, reason } of BOTH) {
    it(`checklist · ${label} → applicable:false / ${reason}`, async () => {
      const report = await runChecklist({ port, specDir: specDir(files) });
      assert.equal(report.applicable, false, `被当成"查过且干净"了：${JSON.stringify(report.counts)}`);
      assert.equal(report.reason, reason);
      // 关键：既然不适用，就不该再给出一个会被读成结论的计数。
      assert.equal(report.counts, undefined, '不适用时仍然返回了 counts —— 那正是本缺陷的形态');
    });

    it(`drift · ${label} → applicable:false / ${reason}`, async () => {
      const report = await runDrift({ port, specDir: specDir(files) });
      assert.equal(report.applicable, false, `被当成"没有漂移"了：entries=${report.entries?.length}`);
      assert.equal(report.reason, reason);
      assert.equal(report.entries, undefined, '不适用时仍然返回了 entries —— 空数组会被读成"零漂移"');
    });
  }
});

describe('Req 3.5 — feature 形态的输出必须逐字不变', () => {
  it('checklist：有需求块时照常给 counts 与 findings', async () => {
    const report = await runChecklist({ port, specDir: specDir({ 'requirements.md': REQUIREMENTS, 'tasks.md': TASKS }) });
    assert.equal(report.applicable, true);
    assert.equal(report.counts.total, report.findings.length);
    assert.ok(report.counts.total > 0, '这条语料应当报出 finding，否则该断言在空跑');
  });

  it('drift：有需求块时照常给 entries', async () => {
    const report = await runDrift({ port, specDir: specDir({ 'requirements.md': REQUIREMENTS, 'tasks.md': TASKS }) });
    assert.equal(report.applicable, true);
    assert.equal(report.entries.length, 1, '该语料应当有 1 条需求，否则该断言在空跑');
  });
});
