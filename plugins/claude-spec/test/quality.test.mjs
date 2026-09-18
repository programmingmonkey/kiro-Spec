import assert from 'node:assert/strict';
import test from 'node:test';
import { previewQuality } from '../lib/core/quality.mjs';

test('质量 preview 输出可定位的澄清、检查表和设计缺口', () => {
  const result = previewQuality({ requirements: '# Requirements\nThe system SHALL be fast.\n', design: '# Design\n', tasks: '- [ ] 1. Implement and test\n' });
  assert.deepEqual(result.findings.map((item) => item.ruleId).sort(), ['AMBIGUOUS_TERM', 'MISSING_ACCEPTANCE_CRITERIA', 'MISSING_DESIGN_SECTION', 'MISSING_DESIGN_SECTION', 'NON_ATOMIC_TASK']);
  assert.equal(result.checklist.length, result.findings.length);
});
