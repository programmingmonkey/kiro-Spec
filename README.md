> 🌐 **中文** · [English](README.en.md)

# kiro-spec

**基于 Kiro 的 Spec 体系构建。一套内核，三个宿主同时运行，与 Kiro 协作同一份 spec。**

在 **Codex**、**DeepSeek Harness**、**Claude** 三个宿主上跑同一套 Spec 能力；
写出的 spec 与 Kiro 原生格式一致 —— 所以 **Kiro 与这三个宿主可以协作同一份 spec**：
任何一方写的，其余各方都能接着改、接着执行。

## 四个参与方

| 参与方 | 形态 | 工具面 |
|---|---|---|
| **DeepSeek Harness** | [`dsh-spec`](plugins/dsh-spec/) —— cordis 插件 | 13 个工具 + `/spec` 命令 |
| **Codex** | [`codex-spec`](plugins/codex-spec/) —— MCP server | 25 个工具，全部经 schema 校验 |
| **Claude** | [`claude-spec`](plugins/claude-spec/) —— MCP server + `PreToolUse` 门控 | 26 个工具 |
| **Kiro** | 原生 —— spec 布局与判定规则与它一致，可直接读写同一份 spec | —— |

三个插件**共用同一个判定内核**（`packages/`），差异只在薄适配层。所以同一份 spec
在三个宿主上得到一致的结论 —— 一份文档不会「在一个底座通过、在另一个底座不通过」。

---

## Spec 是什么

**需求驱动，所有功能落配套文档。**

一个功能不是「先写代码」，而是先落成三份**互相约束**的文档：

| 文档 | 回答什么 |
|---|---|
| `requirements.md` | **要什么** —— 每条需求带 `**User Story:**` 与 EARS 验收判据（`WHEN … THE SYSTEM SHALL …`） |
| `design.md` | **怎么做** —— 架构、数据模型、组件接口、错误处理、测试策略 |
| `tasks.md` | **怎么落地** —— 带依赖图的实现清单，每项回指 `_Requirements: x.y_` |

另有三种形态：**bugfix** 走独立文档（`bugfix.md` 的 Current / Expected / Unchanged 三段，
用 `SHALL CONTINUE TO` 写回归防护），**design-first** 先确认设计再推导需求，
**quick** 一次性写齐三件套后整体确认。

**「落配套文档」不是一句倡导 —— 它是可判定的。** 41 条规则会逐条报出章节缺失、
验收判据写成散文、依赖图格式不符、任务状态用了第四种标记……**不合格的 spec 会被诊断器指出来**，
而不是靠人自觉。这是这套体系与「写个设计文档」的区别。

## 为什么需要它

编码代理写 spec 的常见失败模式不是「写不出」，而是：

- **写了但不合格** —— 章节标题差一个字、验收条目写成散文、任务没有依赖图；
- **不合格却没人报** —— 格式问题不报错，只是行为**悄悄降级**（最坏的一种：依赖图格式写歪，
  宿主丢弃整张图并静默回退成完全串行，无报错、无提示）；
- **报了但只在一个宿主上报** —— 换一个底座，同一份文档一个通过一个不通过。

本项目的三条主张正对着这三点：**格式是判据不是风格建议**、**降级必须出声**、
**判定内核宿主无关**。展开在 [docs/philosophy.md](docs/philosophy.md)。

## 这个仓库的特点

**① 覆盖 Spec 的完整生命周期，不只是写作。**

立项 → 写作 → 诊断 → 跨文档分析 → 审批 → 按依赖图执行。三个宿主各开放 13 / 25 / 26 个工具，
`dsh-spec` 另有 `/spec` 命令。不是「帮你写个模板」，而是把整条流程收进工具面。

**② 规则表逐条复刻，且有冻结测试守着。**

41 条判定规则复刻自 Kiro 的出厂校验器，版本与 sha256 记在 `packages/kiro-rules`；
Kiro 升版会让冻结测试变红，逼人重跑提取。
**判定与 Kiro 不一致时以 Kiro 为准，改我们这边** —— 这条决定了每个 bug 该往哪边修。

**③ 为「规范要求高」的工程模式做的。**

写入走 CAS（`expectedRawRevision` + `stateEpoch`）、执行走 lease（`ownerToken` + 30 分钟有效期）、
规则变更走短期凭证（`contextProof`）；任务三态、审批握手、连续失败三次门禁，都在**工具层**强制，
不依赖「记得这样做」。并发与协作靠状态机，不靠自觉。

**④ 判定内核与文件系统解耦。**

公开的 6 个包里，`lib/` **没有任何文件 import `node:fs` / `node:path`** ——
判定内核因此能在内存 port 上整体驱动（`packages/spec-analysis/test/port-contract.test.mjs`
正是这么测的），也可以脱离文件系统被穷举。

**⑤ 三个宿主是同一套语义，不是三份各自实现。**

适配层很薄：`plugins/*/lib/core/*` 的 13 个文件逐字节相同。其中 12 个只是
`export * from '@my-harness/spec-state/core/…'`；第 13 个 `storage.mjs` 是
**唯一把真实 `node:fs` 接进纯实现的边界** —— 八行，把文件系统 port 接进去。
判定、状态机、审批都来自同一份代码，而「I/O 从哪儿进来」是一个可以指出来的文件。

> 就 Spec 工作流的**工具面完整度与规则覆盖**而言，这基本是**全网最完整的 Spec 插件之一**。

## 快速开始

```bash
git clone <this-repo> && cd kiro-spec
pnpm install
npm test
```

### 装到宿主

每个插件目录下有自己的 `INSTALL.md`：

- [`plugins/dsh-spec/INSTALL.md`](plugins/dsh-spec/INSTALL.md)
- [`plugins/codex-spec/INSTALL.md`](plugins/codex-spec/INSTALL.md)
- [`plugins/claude-spec/INSTALL.md`](plugins/claude-spec/INSTALL.md)

或者自己打一个可分发的包：

```bash
npm run pack:all          # 三个宿主的 .plugin 归档 → dist/
```

打包器会把 `@my-harness/*` 依赖 **vendor 进归档**，所以打出来的包不依赖 workspace 协议，
可以直接装到没有本仓的机器上。

### 用起来

在目标项目里让代理调用 `spec_init`，或在 DSH 里用 `/spec`：

```
spec_init(projectRoot, spec="user-login", workflow="requirements-first")
→ 生成 .kiro/specs/user-login/requirements.md

spec_write(projectRoot, spec="user-login", artifact="requirements", content=..., ...)
→ 写入并做格式诊断

spec_diagnostics(projectRoot, spec="user-login")
→ 逐条报出格式问题（带规则码与严重级）

spec_task_plan / spec_task_begin / spec_task_complete
→ 按依赖图串行执行任务，带 lease 与恢复
```

## 工具参考

| 文档 | 内容 |
|---|---|
| [docs/tools/dsh-spec.md](docs/tools/dsh-spec.md) | 13 个工具 + `/spec` 命令 |
| [docs/tools/codex-spec.md](docs/tools/codex-spec.md) | 25 个 MCP 工具 |
| [docs/tools/claude-spec.md](docs/tools/claude-spec.md) | 26 个 MCP 工具 + 阶段门控 |
| [docs/spec-conventions.md](docs/spec-conventions.md) | 怎么写：标题格式、EARS 句式、任务三态、依赖图 |
| [docs/compat.md](docs/compat.md) | 与 Kiro 的差异（含**已知未建模**的部分） |

### 文档布局

核心文档**中英并排**：`X.md`（**中文**，默认文件名）与 `X.en.md`（英文），两篇顶部互相链接。

插件自带的文档（`plugins/<名字>/README.md` 与 `INSTALL.md`）的英文版放在
[`docs/en/<名字>/`](docs/en/) 下 —— 同样的信息，换个位置。

⚠️ 两者**不是互相翻译**。中文那批是**开发期的原记录**；英文那批是**面向公开读者的改写**，
去掉了带日期的事故记录、移除了指向内部资料的引用。两者描述的行为一致 ——
想知道「当初是怎么得出这个结论的」，看中文那批。

## 仓库结构

```
packages/                    宿主无关的判定内核（零外部依赖）
  kiro-rules/                41 条规则表 —— 唯一事实源
  spec-parser/               识别层 + 扫描层（哪一行是任务 / 哪一行在围栏里）
  spec-analysis/             checklist / drift / amendments / archive / signature
  spec-revision/             rawRevision（dual-hash）
  spec-state/                状态机、lease、审批、恢复
  spec-diagnose/             裁决层：把上面这些组装成统一 findings
plugins/                     三个宿主的薄适配层
  dsh-spec/  codex-spec/  claude-spec/
scripts/                     pack-plugin.mjs（打包器）、consumer-root.mjs、kiro-bundle-root.mjs
```

分层不是组织习惯：**公开的 6 个包里，`lib/` 下没有任何文件 import `node:fs` / `node:path`**
（I/O 全走注入的 port），所以判定内核可以在任何宿主里跑，也能在内存 port 上被穷举
（`packages/spec-analysis/test/port-contract.test.mjs` 正是这么测的）。

## 测试

```bash
npm test
```

### 两个 Node 版本声称，不是一回事

| | 要求 | 为什么 |
|---|---|---|
| **插件运行时**<br>（`plugins/*/package.json`） | `>=20 <26` | 代码只用到 `import.meta.dirname`（Node 20.11+）。宿主给什么版本就能跑什么版本 |
| **本仓的工具链**<br>（根 `package.json`） | `>=22 <26` | pnpm 11 依赖 `node:sqlite`（Node 22.5+），**它在 Node 20 上起不来** |

CI 只跑 **22 与 24** —— 与工具链声称一致。把 Node 20 放进矩阵会红，
而红的原因与插件无关（是包管理器起不来），那会让人误以为兼容性坏了。

> 这条区分是 2026-09-18 加的。此前根 `package.json` 写的是 `>=20`，
> 而那个数字**在 CI 里从来无法被验证** —— 一个永远不会被验证的兼容性声称，
> 比不声称更坏：它把「没测过」包装成了「支持」。

**若干用例在没有下游语料时会 skip**，这是有意的设计。想跑全量：

```bash
CONSUMER_REPO_ROOT=/path/to/your/project npm test
```

⚠️ 本仓是从一个更大的开发仓库导出的公开子集。**哪些东西没在这里、为什么**，
以及 `skip` 与「通过」的区别，都写在 [TEST-SCOPE.md](TEST-SCOPE.md) —— 那一篇是记账，不是免责。

## 与 Kiro 的关系

规则表复刻自 Kiro 的出厂校验器（版本与 sha256 记在 `packages/kiro-rules`）。**判定不一致时，
以 Kiro 为准，改我们这边** —— 这条写在这里是因为它决定了每一个 bug 该往哪边修。

已知的未建模部分、以及刻意保留的差异，列在 [docs/compat.md](docs/compat.md)。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
