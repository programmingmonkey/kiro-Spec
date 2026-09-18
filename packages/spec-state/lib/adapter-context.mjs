// `adapterContextFiles` —— 从 host adapter 的 `rules` 里挑出某个 artifact 的上下文文件。
//
// 它原本住在两个 host 的 `lib/mcp/adapter.mjs` 里、逐字节相同。它是**纯的**（只读
// `adapter.value`），所以搬进共享包；host 的 `adapter.mjs` 保留同名导出（一行 re-export），
// 既有的调用点与测试不用改。
//
// `adapter.mjs` 本身**不搬**：两个 host 的 writePolicy 归一化与 authority 台账是真分叉
// （probe-07：claude 182 行 / kiro 80 行），属 Task 2 的「留 host 适配层」。

// 🔴 `rules` 缺席时返回 `[]`，不是解引用 `undefined`。
//
// 由来是一次**真机**踩中（2026-09-13，第 7 期真机复验）：adapter 不写 `rules` 时
// `loadAdapter` 照常通过（`adapter.mjs` 的校验原文就是
// `const rules = Array.isArray(adapter.rules) ? adapter.rules : []` —— 它把 `rules` 当选填），
// `spec_health` / `spec_init` 都正常，然后 `spec_context` 在这里炸成
// `INVALID_FORMAT: Cannot read properties of undefined (reading 'filter')` ——
// 一个内部 TypeError 穿着领域错误码出来，看的人无从知道是 adapter 少了一个字段。
//
// 而正确答案**本来就在调用方手里**：`lib/index.mjs` 的 `spec_context` 下一行就是
// `if (files.length === 0) return error('RULES_UNAVAILABLE', 'no context files match this artifact')`。
// 只要这里不炸，调用方自己会给出那条说人话的错误。
//
// 【实测】这个解引用**不是第 7 期引入的**：`git show 75d8694^:plugins/claude-spec/lib/mcp/adapter.mjs:181`
// 逐字相同 —— 搬包是忠实的，缺陷比抽包更早。
export function adapterContextFiles(adapter, artifact) {
  const rules = Array.isArray(adapter.value?.rules) ? adapter.value.rules : [];
  const artifactPath = `${adapter.value.specsRoot}/${artifact}.md`;
  return [...new Set(rules.filter((rule) => rule.match.some((pattern) => pattern === '.kiro/specs/**/*.md' || artifactPath.startsWith(pattern.replace('/**', '')))).flatMap((rule) => rule.contextFiles))];
}
