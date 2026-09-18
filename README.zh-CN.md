> 🌐 [English](README.md) · **中文**

# kiro-spec

**A Kiro-compatible Spec workflow — requirements → design → tasks — for three hosts.**

把「先想清楚再写代码」变成**有强制结构的工程流程**：需求写成可验收的条目、设计写成可追踪的组件、
任务写成带依赖图的清单、执行按依赖顺序推进、每一步都有诊断器盯着格式。

同一套内核，三个宿主：

| 宿主 | 插件 | 形态 | 工具面 |
|---|---|---|---|
| **DeepSeek Harness** | [`dsh-spec`](plugins/dsh-spec/) | cordis 插件 | 13 个工具 + `/spec` 命令 |
| **Codex** | [`codex-spec`](plugins/codex-spec/) | MCP server | 25 个工具，25 个全部经 schema 校验 |
| **Claude** | [`claude-spec`](plugins/claude-spec/) | MCP server + `PreToolUse` 门控 | 26 个工具 |

三个宿主**共用同一套** L0 判定内核（`packages/`），差异只在适配层。所以同一份 spec 在三个宿主上
会得到一致的诊断结论 —— 这是这个项目最初要解决的问题。

---

## 为什么需要它

编码代理写 spec 的常见失败模式不是「写不出」，而是：

- **写了但不合格** —— 章节标题差一个字、验收条目写成散文、任务没有依赖图；
- **不合格却没人报** —— 格式问题不报错，只是行为悄悄降级（最坏的一种）；
- **报了但只在一个宿主上报** —— 换一个底座，同一份文档一个通过一个不通过。

本项目的三条主张，正是对着这三点：

1. **格式是判据，不是风格建议。** 41 条规则复刻自 Kiro 的出厂校验器，逐条带规则码与严重级。
2. **降级必须出声。** 依赖图解析不了**不许**静默回退成串行 —— 见 [docs/philosophy.zh-CN.md](docs/philosophy.zh-CN.md)。
3. **判定内核宿主无关。** 三个适配层都调同一个 `spec-diagnose`，结论必须一致。

理念与设计取舍写在 **[docs/philosophy.zh-CN.md](docs/philosophy.zh-CN.md)**。

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
| [docs/tools/dsh-spec.zh-CN.md](docs/tools/dsh-spec.zh-CN.md) | 13 个工具 + `/spec` 命令 |
| [docs/tools/codex-spec.zh-CN.md](docs/tools/codex-spec.zh-CN.md) | 25 个 MCP 工具 |
| [docs/tools/claude-spec.zh-CN.md](docs/tools/claude-spec.zh-CN.md) | 26 个 MCP 工具 + 阶段门控 |
| [docs/spec-conventions.zh-CN.md](docs/spec-conventions.zh-CN.md) | 怎么写：标题格式、EARS 句式、任务三态、依赖图 |
| [docs/compat.zh-CN.md](docs/compat.zh-CN.md) | 与 Kiro 的差异（含**已知未建模**的部分） |

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

分层是**硬约束**，不是组织习惯：`packages/` 里一个 `node:fs` 都不许出现（I/O 全走注入的 port），
所以判定内核可以在任何宿主里跑，也可以被单测穷举。

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
以及 `skip` 与「通过」的区别，都写在 [TEST-SCOPE.zh-CN.md](TEST-SCOPE.zh-CN.md) —— 那一篇是记账，不是免责。

## 与 Kiro 的关系

规则表复刻自 Kiro 的出厂校验器（版本与 sha256 记在 `packages/kiro-rules`）。**判定不一致时，
以 Kiro 为准，改我们这边** —— 这条写在这里是因为它决定了每一个 bug 该往哪边修。

已知的未建模部分、以及刻意保留的差异，列在 [docs/compat.zh-CN.md](docs/compat.zh-CN.md)。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
