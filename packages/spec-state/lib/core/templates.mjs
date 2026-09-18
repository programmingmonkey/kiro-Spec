// artifact 骨架。
//
// 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 1 条）。
// 原先 `TEMPLATES` 是**一维**的（只有 requirements / design / tasks / bugfix 四个键），
// 而 `packages/kiro-rules` 的章节表**是分变体的**：design 有 feature / bugfix 两套，
// 两套的必需章节几乎不相交。`artifactTemplate({workflow, artifact})` 拿 workflow 做完
// 成员检查就把它丢掉，于是同一份 design 骨架要同时服侍两套表 —— 按构造就不可能对。
//
// 实测（修复前，`spec_validate_artifacts` 那条调用路径）：6 个合法组合里 **4 个**产出 error：
//     bugfix/bugfix                    5 error   ← 骨架给的是 design(bugfix 变体) 的三节，放错了格子
//     bugfix/design                    3 error
//     requirements-first/requirements  2 error   ← 缺陷报告没提到这一条
//     requirements-first/design        3 error
// 也就是说：**照模板起草的人必然踩满 error**，而校验器正是这套工具自己的。
//
// ⚠️ design 的变体不是由 workflow 直接决定的，而是真机的两段逻辑（见 spec-diagnose 的
// `assemble`）：`specType==='bugfix'` → bugfix 表；`specType===undefined` → **内容嗅探**
// （`sniffDesignVariant`，认 `## Bug Details` / `## Hypothesized Root Cause` /
// `## Fix Implementation` / `### (Bug|Fault) Condition` 四个标记）。而 `spec_validate_artifacts`
// **不传** specType。所以 bugfix 工作流的 design 骨架必须自带那几个标记 —— 它既让嗅探
// 落到 bugfix 表，又恰好满足那张表。两条路径（声明 specType / 靠嗅探）因此收敛到同一份骨架。
//
// 护栏在 `test/templates-validate-clean.test.mjs`：每个 (workflow, artifact) 组合的骨架
// 喂回 `spec_validate_artifacts` 必须**零 error 且零 warning**。这条护栏缺席，正是本缺陷
// 能一直存在的直接原因 —— 工具没有拿自己的校验器量过自己的产物。
import { artifactsForWorkflow } from './artifact-schema.mjs';

const REQUIREMENTS = [
  '# Requirements Document',
  '',
  '## Introduction',
  '',
  '<State the problem and the outcome this spec commits to.>',
  '',
  '## Glossary',
  '',
  '- **<Term>** — <definition used consistently below>',
  '',
  '## Requirements',
  '',
  '### Requirement 1: <Short title>',
  '',
  '**User Story:** As a <role>, I want <capability>, so that <benefit>.',
  '',
  '#### Acceptance Criteria',
  '',
  '1. WHEN <condition> THEN the system SHALL <observable outcome>.',
  ''
].join('\n');

// feature 变体：必需 Overview / Architecture / Components and Interfaces / Data Models，
// 推荐 Correctness Properties / Error Handling / Testing Strategy。
// ⚠️ **不许**出现 bugfix 的四个嗅探标记，否则会被判到 bugfix 表上去。
const DESIGN_FEATURE = [
  '# Design Document',
  '',
  '## Overview',
  '',
  '<Describe the proposed design.>',
  '',
  '## Architecture',
  '',
  '<Describe the structure and the boundaries it holds.>',
  '',
  '## Components and Interfaces',
  '',
  '<Describe each component and the contract between them.>',
  '',
  '## Data Models',
  '',
  '<Describe the data shapes and their invariants.>',
  '',
  '## Correctness Properties',
  '',
  '### Property 1: <Short name>',
  '',
  '<State the property in falsifiable terms.>',
  '',
  '**Validates: Requirements 1**',
  '',
  '## Error Handling',
  '',
  '<Describe failures and recovery.>',
  '',
  '## Testing Strategy',
  '',
  '<Describe deterministic tests.>',
  ''
].join('\n');

// bugfix 变体：必需 Overview / Bug Details / Expected Behavior / Hypothesized Root Cause /
// Fix Implementation，推荐 Glossary / Correctness Properties / Testing Strategy。
// 其中 `## Bug Details` / `## Hypothesized Root Cause` / `## Fix Implementation` 同时是
// `sniffDesignVariant` 的标记 —— 见文件头 ⚠️。
const DESIGN_BUGFIX = [
  '# Design Document',
  '',
  '## Overview',
  '',
  '<Describe the corrective design in one paragraph.>',
  '',
  '## Glossary',
  '',
  '- **<Term>** — <definition used consistently below>',
  '',
  '## Bug Details',
  '',
  '<Describe the observed behavior and the conditions that produce it.>',
  '',
  '## Expected Behavior',
  '',
  '<Describe what the system should do instead.>',
  '',
  '## Hypothesized Root Cause',
  '',
  '<State the falsifiable cause and the evidence for it.>',
  '',
  '## Correctness Properties',
  '',
  '### Property 1: <Short name>',
  '',
  '<State the property the fix must preserve, in falsifiable terms.>',
  '',
  '**Validates: Requirements 1**',
  '',
  '## Fix Implementation',
  '',
  '<Describe the smallest corrective change.>',
  '',
  '## Testing Strategy',
  '',
  '<Describe the test that fails before the fix and passes after it.>',
  ''
].join('\n');

// bugfix.md（**不是** design 的 bugfix 变体 —— 原先这两个被放反了，是第 1 条缺陷的直接形态）。
const BUGFIX = [
  '# Bugfix Analysis',
  '',
  '## Introduction',
  '',
  '<State the defect and the scope of the correction.>',
  '',
  '## Bug Analysis',
  '',
  '### Current Behavior (Defect)',
  '',
  '<Describe what the system does today, with the reproduction.>',
  '',
  '### Expected Behavior (Correct)',
  '',
  '<Describe what it should do instead.>',
  '',
  '### Unchanged Behavior (Regression Prevention)',
  '',
  '<Describe what must keep working, and how that is verified.>',
  ''
].join('\n');

const TASKS = [
  '# Implementation Plan',
  '',
  '## Overview',
  '',
  '<Describe the execution order and what each wave establishes.>',
  '',
  '## Tasks',
  '',
  '- [ ] 1. <Implement one verifiable change>',
  '  _Requirements:_ 1',
  '',
  '## Task Dependency Graph',
  '',
  '```json',
  '{"waves":[{"id":0,"tasks":["1"]}]}',
  '```',
  '',
  '## Notes',
  '',
  '<Record decisions and attributions here.>',
  ''
].join('\n');

// 二维索引：workflow → artifact → 骨架。feature 类的三个工作流共用同一组，
// bugfix 工作流有自己的 bugfix.md 与 design(bugfix 变体)。
const TEMPLATES = {
  'requirements-first': { requirements: REQUIREMENTS, design: DESIGN_FEATURE, tasks: TASKS },
  'design-first': { requirements: REQUIREMENTS, design: DESIGN_FEATURE, tasks: TASKS },
  quick: { requirements: REQUIREMENTS, design: DESIGN_FEATURE, tasks: TASKS },
  bugfix: { bugfix: BUGFIX, design: DESIGN_BUGFIX, tasks: TASKS },
};

export function artifactTemplate({ workflow, artifact }) {
  if (!artifactsForWorkflow(workflow).has(artifact)) throw Object.assign(new Error(`${artifact} is not an artifact of ${workflow}`), { code: 'ARTIFACT_NOT_ALLOWED' });
  const template = TEMPLATES[workflow]?.[artifact];
  // `artifactsForWorkflow` 已经放行了这个组合，这里还取不到就是本表漏了一格 —— 那是本文件
  // 的缺陷，不是调用方的。宁可炸也不要 `undefined` 顺着 spec_write 流下去变成一份空 artifact。
  if (typeof template !== 'string') {
    throw Object.assign(new Error(`no template for ${workflow}/${artifact}; TEMPLATES is missing that combination`), { code: 'INVALID_FORMAT' });
  }
  return template;
}
