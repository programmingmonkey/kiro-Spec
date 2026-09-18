# @my-harness/spec-state

三个宿主共用的 **Spec 状态层**：`stateEpoch` / owner lease / journal / recovery / CAS，
以及全部 `spec_*` 的编排。第 7 期从两个 MCP host 的 `lib/mcp/service.mjs`（804 / 849 行）
与 `lib/core/` 抽出来，于是那两份的实现体从 ~750 行降到 **0**。

## 为什么它和别的共享包不一样

| 包 | 状态 | I/O | 依赖 |
|---|---|---|---|
| `kiro-rules` | 无 | 无 | 零 import |
| `spec-revision` | 无 | 无 | → `spec-parser` |
| `spec-analysis` | 无 | **注入 port** | → `spec-parser` |
| **`spec-state`** | **有状态** | **注入 port** | → `spec-revision` / `spec-parser` / `spec-diagnose` |

「有状态」不等于「可以自己碰 I/O」。本包 **零 `node:fs`、零 `node:path`**，有断言守着
（`test/shape.test.mjs`，判据跳过注释行）。路径运算用包内 `lib/paths.mjs` 的 posix 实现，
与 `spec-analysis/lib/archive.js` 的 `joinPath` / `basename` 同一手法。

## 注入面（缺一个就当场抛，不给能跑的默认值）

```js
createSpecState({
  projectRoot, adapterPath, privateDir, privateDirName = '.kiro-spec-private',
  loadAdapter,          // async ({ projectRoot, adapterPath }) => adapter
  fs,                   // 10 个原语，见 lib/ports.mjs 的 REQUIRED_FS_METHODS
  now,                  // 时钟：lease 到期 / TTL / 时间戳
  randomUUID,           // ownerToken / eventId / journalId / contextProof / 临时文件名
  pid, isAlive,         // 锁的存活探测
  fault,                // 故障注入（两个 host 的既有测试用它）
  hooks,                // { health, beforeWrite } —— 宿主独有插槽
})
```

`randomUUID` / `pid` / `isAlive` **没有默认实现**：给一个能跑的默认值，会让「忘了注入」
变成「跑起来了但快照不可复现」，而那是本期最忌讳的失败形态（计划 R7-1）。
`test/port-contract.test.mjs` 钉住这件事。

## 两个宿主 hook（共享层里没有一行 `if (宿主 === …)`）

- `health(adapter) → object` —— claude-spec 用它带回 adapter 的 `authority` 台账。
  codex-spec 没有这个概念，不塞给它。
- `beforeWrite({ artifact, content, params, state }) → { content, extra? } | { code, … }` ——
  claude-spec 用它把消费项目 §4.3.2 的署名**合进同一次原子写**。
  契约保证：写盘仍然只有 `storage.write` 一处，署名不可能绕过 CAS。
  署名行本身属**被剥离的协议标记**：`computeApprovalFingerprint` 在 `tasks.md` 上算语义时
  把它剥掉，与合法执行事件块同类（第 8 期 `spec-sign-approval-clobber`，`semantic-v2`）。
  所以「事后单独追加一行署名」不再改变审批指纹 —— 但本插槽仍然只管**写在哪一次**，
  不担保调用方手写的行一定合法。

## CAS 的「无基线」语义（R7-8，照抄共享层，不许发明第三种）

```js
// packages/spec-state/lib/storage.mjs
if ((current ? computeRawRevision(current) : undefined) !== expectedRawRevision) throw REVISION_CONFLICT
```

- `expectedRawRevision === undefined` → **「我预期这个文件还不存在」**（不是「跳过校验」）；
- `'sha256:…'` → 「我预期它的字节是这个」；
- dsh-spec 在同一语义上多一态：**省略** = 调用点没表态，用此刻观测到的版本作基线
  （仍然过 DSH 的 `FsWriteIntent` 版本守卫）。

## 宿主侧

| 宿主 | 适配层 | 说明 |
|---|---|---|
| codex-spec | `plugins/codex-spec/lib/mcp/service.mjs`（40 行） | 注入 adapter / node:fs port / 时钟 / 随机数 / 进程身份 |
| claude-spec | `plugins/claude-spec/lib/mcp/service.mjs`（93 行） | 同上 + 两个 hook |
| dsh-spec | 走 cordis，**不直接依赖本包** | 它的状态语义由 `ctx.fs` 的 `FsWriteIntent` 在本插件内实现（第 7 期 Task 5） |

`lib/core/` 的 12 个纯模块是从两个 host 的 `lib/core/` **整文件 `git mv`** 进来的；host 侧留一行
re-export shim，因此既有的 `../lib/core/xxx.mjs` import 与它们的回归网原样不动。

## 行为快照

`node scripts/snapshot-07.mjs --check` —— **8 个场景**，每步记「返回体 / stateEpoch /
私有状态文件的整份字节」。两个 host 除已知有意的差异（署名接线、adapter authority 台账）外
逐条相同，且抽取前后逐条相同。golden 是一次性采集的留档（在开发仓，不在本仓）。

- 完整生命周期、五条异常路径、**假时钟下的租约过期**；
- `task-set`（`spec_task_set` 的三态通道 —— F11 点名的那个函数）；
- `read-only-surface`（只读工具面 + `spec_record_analysis` + `spec_sync_apply`）。

**覆盖 25 / 25 个 `spec_*` 分支**，由 `scripts/snapshot-coverage.test.mjs` 守着：
新增一个分支而快照没跟进，根套件立刻红。`paths.mjs` 与 `node:path.posix` 的等价性由
`test/paths-parity.test.mjs` 守着。
