// 适配层。识别与扫描的实现已移入共享包 `@my-harness/spec-parser`（第 3 期）。
//
// 本文件只做两件事：
//   ① 保留 codex-spec 的历史导出面（7 个名字，一个不删）—— revision / task-execution /
//      mcp service / core index 都在用它们；
//   ② 把 kiro 的策略固定为 strict：四字符类 `[ xX-]`（去掉 `~`）。这是 2026-09-08 的显式收紧，
//      也是差异表 A1 / A2 两条「有意保留的分歧」的 kiro 侧。
//
// 已删除的东西：`invalid-format`。它的两个生产者（空标题 `- [ ] 1.`、顶层无尾点 id `- [ ] 1 x`）
// 正是差异表的 B / C 两行，第 3 期把这两行归并到 dsh 侧（= 真机，两条真机正则都是前缀测试），
// 于是该枚举不再有任何生产者。留着它就是 F19 形态（死枚举），故连同 `lib/core/index.mjs` 的
// 抛错分支一起删除。
//
// `nextFenceMarker` / `hasFenceClose` 的语义**不得改变**：`lib/core/revision.mjs` 用同一套原语
// 跑 semanticTokens，而 revision 产出的是 approval fingerprint。

import { metadataValue, parseTaskLine as parseTaskLineShared } from '@my-harness/spec-parser'
import { scanTaskLines as scanTaskLinesShared } from '@my-harness/spec-parser/scan-lines'

export {
  hasFenceClose,
  nextFenceMarker,
  replaceTaskState,
  taskIndentStack,
} from '@my-harness/spec-parser/scan-lines'

export { metadataValue }

const STRICT = { strictTaskState: true }

export const parseTaskLine = (line) => parseTaskLineShared(line, STRICT)

export const scanTaskLines = (markdown) => scanTaskLinesShared(markdown, STRICT)
