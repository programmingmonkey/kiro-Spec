import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeArtifacts } from '../lib/core/analysis.mjs';

const requirements = `# Requirements Document

### 1. Persist records

The system SHALL retain records.

### 2. Recover records

The system SHALL recover records.
`;

const design = `# Design Document

## Correctness Properties

*For any* retained record, recovery returns it. **Validates: Requirements 1**
`;

const tasks = `# Implementation Plan

## Tasks

- [ ] 1. Persist records
  _Requirements:_ 1
  _Dependencies:_ 2
- [ ] 2. Recover records
  _Requirements:_ 9

## Task Dependency Graph

\`\`\`json
{"waves":[{"id":0,"tasks":["1"]},{"id":1,"tasks":["2"]}]}
\`\`\`
`;

test('跨 artifact 分析以结构化 finding 报告需求追踪、依赖环和 wave 逆序', () => {
  const findings = analyzeArtifacts({ requirements, design, tasks });
  assert.deepEqual(findings.map((finding) => finding.ruleId).sort(), [
    'REQUIREMENT_WITHOUT_DESIGN_TRACE',
    'REQUIREMENT_WITHOUT_TASK',
    'UNKNOWN_TASK_REQUIREMENT',
    'WAVE_DEPENDENCY_ORDER'
  ]);
  assert.ok(findings.every((finding) => finding.severity && finding.artifact && finding.location && finding.evidence && finding.suggestedAction));
  assert.equal(findings.find((finding) => finding.ruleId === 'UNKNOWN_TASK_REQUIREMENT').location.line, 8);
});

test('识别消费项目的 Requirement 标题与验收项引用', () => {
  const findings = analyzeArtifacts({
    requirements: `# Requirements Document

### Requirement 1: 录入等级

#### Acceptance Criteria

1. THE 系统 SHALL 保存等级。
`,
    design: '# Design Document\n\nRequirements 1.1\n',
    tasks: `# Implementation Plan

## Tasks

- [ ] 1. 保存等级
  _Requirements:_ 1.1

## Task Dependency Graph

\`\`\`json
{"waves":[{"id":0,"tasks":["1"]}]}
\`\`\`
`
  });

  assert.deepEqual(findings, []);
});
