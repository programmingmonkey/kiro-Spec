// 适配层。dual-hash 的实现已移入共享包 `@my-harness/spec-revision`（第 4 期）。
//
// 本文件只保留历史导出面（2 个名字，一个不删）——`storage` / `task-events` /
// `task-execution` / `mcp/adapter` / `mcp/service` 都在用它们。
//
// 计划 Task 3 Step 1 要求「codex-spec 与 claude-spec 的 `lib/core/revision.mjs` 各改成一行
// re-export，其余 `lib/core/*` 与 `mcp/service.mjs` 的 **import 路径一律不动**」。
//
// 🔴 但只保住 import 路径**不足以**保住行为：`computeApprovalFingerprint` 多了一个策略入参
// `strictTaskState`。本宿主的每个调用点都显式传 `true`（codex-spec / claude-spec 的历史契约：
// 四字符类 `[ x-]`，`[~]` 不算任务），而不是去依赖共享包里的默认值 —— 默认值只是给
// 「还没表态」的调用方兜底，不应成为本宿主的依据。

export { computeApprovalFingerprint, computeRawRevision } from '@my-harness/spec-revision';
