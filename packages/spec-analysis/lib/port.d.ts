// packages/spec-analysis/lib/port.d.ts
//
// port 契约：五个二阶分析模块**唯一**的 I/O 面。
//
// 这五个模块刻意不 import `node:fs` / `node:path`（有断言守着），所以宿主必须把一个
// port 注入进来。契约按**实测用法**写，不按母计划的提议——提议的
// `{readText, writeText, listDir, exists, move?}` **少一个 `mkdir`**，而 `archive.js`
// 不给 `mkdir` 就落不了地（`ensureArchiveRoot` 要用它报告 archive 根是否真的被创建）。
//
// 实测用法（读码 + 冻结快照，见 test/fixtures/behaviour-snapshot.json）：
//
//   readText / writeText   五个模块全用
//   listDir                archive、signature
//   exists / mkdir         **仅** archive
//   move                   **仅** archive，且**可选**（见下）
//
// 只有类型、没有运行时导出：本文件的价值是让「模块想要一个新方法」这件事必须先改契约，
// 而不是在某个分支里顺手多调一个 `port.xxx()`。

export interface SpecPortEntry {
  name: string
  /** `directory` 的项会被 `archive` 的复制降级递归进去。 */
  type?: 'file' | 'directory'
  /** 绝对路径。缺省时调用方按 `joinPath(dir, entry.name)` 兜底。 */
  path?: string
}

export interface SpecPort {
  /**
   * 读文本。**文件不存在返回 `undefined`，不抛**——这是 `checklist` / `drift` 的
   * `missingFiles` 契约的前提（缺文件要记下来并继续，不是让整次运行炸掉）。
   */
  readText(path: string): Promise<string | undefined>

  /** 写文本。父目录不存在时的行为由宿主决定（`archive` 会在报告里如实说明它没验证过）。 */
  writeText(path: string, text: string): Promise<void>

  /**
   * **读-改-写专用的写**：断言 `path` 当前内容仍等于 `previousText`，否则拒绝写入。
   *
   * 🔴 为什么它是**必填**而不是像 `move?` 那样可选（第 7 期 §9 欠账 ⑤，2026-09-14 补）：
   * `signature` 与 `amendments` 都是「读 `T0` → 算 → 写 `T1`」。用普通 `writeText` 时，
   * `T0 ≠ T1` 的那一刻，基于旧内容算出来的结果会**静默落在新内容上** —— 别人的改动被抹掉，
   * 没有任何人收到信号。这是 F11 的同族，只是窗口从「整段任务时长」缩到「一次调用内」。
   *
   * 做成可选就等于给「悄悄退化成无保护」留了一条路，而那正是本仓库反复要消灭的形态：
   * 一个可以不实现的安全检查，等于一个不存在的安全检查。所以入口用 `requirePort` 硬卡，
   * 缺它的宿主会在**调用时立刻报错**，而不是在某次并发里丢一份改动。
   *
   * 实现方只需回答一个问题：**盘上还是我读到的那份吗？** 不是就抛（错误里应含
   * `REVISION_CONFLICT`，与共享状态层口径一致）。怎么比（哈希 / 版本号 / mtime）由宿主定。
   */
  writeTextIfUnchanged(path: string, text: string, previousText: string): Promise<void>

  /** 列目录。只返回直接子项。目录不存在时返回空数组而不是抛。 */
  listDir(path: string): Promise<SpecPortEntry[]>

  /** 存在性探测。`archive` 的冲突检测以它为准。 */
  exists(path: string): Promise<boolean>

  /** 建目录（递归）。`archive` 用它报告 archive 根是否真的被创建。 */
  mkdir(path: string): Promise<void>

  /**
   * 目录移动。**可选**——缺它时 `archive.js` 逐文件复制，并且：
   *   1. **不删源**（`sourceRemoved: false`），同时在 `note` 里写明源目录要由宿主自己删；
   *   2. 空目录不保留、只搬文本（port 契约里没有二进制读）。
   * 它绝不截断源文件来伪装「已删除」——那会把一份 spec 变成半份。
   */
  move?(from: string, to: string): Promise<void>
}
