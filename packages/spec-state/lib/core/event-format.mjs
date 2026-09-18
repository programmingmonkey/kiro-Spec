// 适配层。执行事件块的解析与格式化实现已移入共享包 `@my-harness/spec-parser`（第 4 期）。
//
// 本文件只保留历史导出面（3 个名字，一个不删）——`revision.mjs` / `task-events.mjs` /
// `mcp/service.mjs` 都在用它们。
//
// 为什么是转发而不是改消费者：计划 Task 3 Step 1 的红字要求
// 「**其余 `lib/core/*` 与 `mcp/service.mjs` 的 import 路径一律不动**」。
// 抽包是搬家不是重构；消费者零改动时，中间态不可能因为漏改一处而悄悄变坏。
//
// 实现与抽取前逐字节相同：抽取前 codex-spec 与 claude-spec 两份副本同 sha
// `2bd49728c479…`，共享包那份即由该字节原样搬入。

export {
  appendExecutionEvent,
  parseExecutionEvents,
  stripValidExecutionEvents,
} from '@my-harness/spec-parser/event-format';
