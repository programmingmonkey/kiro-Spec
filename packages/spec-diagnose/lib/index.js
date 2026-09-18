// `@my-harness/spec-diagnose` —— 第 3.5 期的裁决层。
//
// 「同一份 spec 判定成什么」只有一个实现，四个表面（dsh-spec / codex-spec / 第 6 期
// claude-spec / 第 3.6 期 spec-validator）都只做壳。
//
// 零 I/O、恒不抛、依赖只允许 `@my-harness/kiro-rules` 与 `@my-harness/spec-parser`。
//
// ⚠️ 下面除 `diagnose` 之外的诊断层名字（子装配、章节表、`kiroTrim`）是**为适配层保留的**：
// dsh-spec 的 `__test` 从第 1 期起就暴露它们（`design/feature` 章节表与规则表的「不许漂移」
// 断言正押在 `DESIGN_*_SECTIONS` 上），接线时**一个都不能删**（Req 7.2）。所以它们必须从这里
// 单一来源出去，而不是在插件里留第二份。

export {
  diagnose,
  diagnoseArtifact,
  taskEntries,
  parentTaskIds,
  duplicateTaskIds,
  executableUnitCount,
  // 子装配与表格：适配层与「表-执行器不许漂移」的断言需要
  collectHeadings,
  collectDesignSections,
  diagnoseDesignProperties,
  diagnoseDependencyGraph,
  diagnoseTaskBody,
  diagnoseWavesConsistency,
  kiroTrim,
  DESIGN_FEATURE_SECTIONS,
  DESIGN_BUGFIX_SECTIONS,
  BUGFIX_SECTIONS,
} from './diagnose.js'
export { REPO_CODES, LEGACY_CODE_REMAP, SOURCES, KIRO_BUNDLE, makeFinding, resolveSource } from './finding.js'
export { applyProfile } from './profile.js'
