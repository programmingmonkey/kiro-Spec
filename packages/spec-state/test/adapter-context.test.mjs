// `adapterContextFiles` 的契约。由一次**真机**踩中补上（2026-09-13，第 7 期真机复验）。
//
// 踩中的形态：adapter 不写 `rules` → `loadAdapter` 照常通过（它把 `rules` 当选填）
// → `spec_health` / `spec_init` 都正常 → `spec_context` 炸成
// `INVALID_FORMAT: Cannot read properties of undefined (reading 'filter')`。
// 一个内部 TypeError 穿着领域错误码出来，而正确的错误（`RULES_UNAVAILABLE`）
// 就写在调用方的下一行，只是永远到不了。
import assert from 'node:assert/strict';
import test from 'node:test';

import { adapterContextFiles } from '../lib/adapter-context.mjs';

const adapter = (value) => ({ value: { specsRoot: '.kiro/specs', ...value } });

test('rules 缺席 → 返回 []，不抛（调用方据此给出 RULES_UNAVAILABLE）', () => {
  assert.deepEqual(adapterContextFiles(adapter({}), 'requirements'), []);
  assert.deepEqual(adapterContextFiles(adapter({ rules: null }), 'tasks'), []);
  // 不是数组也当没有——`loadAdapter` 的归一化用的是同一条判据（Array.isArray）。
  assert.deepEqual(adapterContextFiles(adapter({ rules: {} }), 'design'), []);
});

test('通配规则命中，且 contextFiles 去重', () => {
  const a = adapter({ rules: [
    { match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md'] },
    { match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec.md', '.kiro/steering/b.md'] },
  ] });
  assert.deepEqual(adapterContextFiles(a, 'requirements'), ['.kiro/steering/spec.md', '.kiro/steering/b.md']);
});

test('前缀规则只命中匹配的 artifact 路径', () => {
  const a = adapter({ rules: [{ match: ['.kiro/specs/requirements'], contextFiles: ['r.md'] }] });
  assert.deepEqual(adapterContextFiles(a, 'requirements'), ['r.md']);
  assert.deepEqual(adapterContextFiles(a, 'design'), []);
});
