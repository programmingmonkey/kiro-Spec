# `dsh-spec` 工具参考

DeepSeek Harness（corgis 插件）宿主。**13 个工具 + 1 个 `/spec` 命令**。

- 形态：cordis 插件，挂进一个 DSH profile（见 [../../plugins/dsh-spec/INSTALL.md](../../plugins/dsh-spec/INSTALL.md)）
- 与另外两个宿主的差别：工具面最小、且有一个命令面（`/spec`）；没有 MCP schema 校验层

---

## 一、立项与接管

### `spec_init`

启动一个 Kiro 风格 spec。

> Start a Kiro-style spec. kind: `'feature'`（默认 requirements-first）、`'bugfix'`（bugfix.md）、
> 或 `'quick'`（无审批门）。feature 支持 workflow `'design-first'` 与 detailLevel。

| 参数 | 必填 | 说明 |
|---|---|---|
| `goal` | ✅ | 高层目标，会写进 requirements 的 Introduction |
| `kind` | | `feature`（默认）\| `bugfix` \| `quick` |
| `workflow` | | feature 专用：`requirements-first`（默认）\| `design-first` |
| `detailLevel` | | design-first 专用：`high`（默认）\| `low` |
| `feature` | | 显式指定 spec 目录名 |

**四种形态与它们的顺序**：

| 形态 | 顺序 | 首个工件 | 审批门 |
|---|---|---|---|
| `feature`（requirements-first） | requirements → design → tasks | `requirements.md` | 有 |
| `feature`（design-first） | design → requirements（推导）→ tasks | `design.md` | 有 |
| `bugfix` | analysis → design → tasks | `bugfix.md`（current/expected/unchanged 三段） | 有 |
| `quick` | 一次性三件套 | 三件全生成 | 无 |

---

## 二、写作

### `spec_write`

写（创建或覆盖）一个 spec 文件。**强制工作流感知的阶段顺序**：
bugfix 走 `bugfix.md→design→tasks`，feature 走 `requirements→design→tasks`。

### `spec_read`

读一个 spec 文件；`file` 为 `'status'`（默认）时读整体状态。

### `spec_amend`

已冻结 spec 的**增量修正通道**，改一处不必重发整份正文。

| `kind` | 语义 |
|---|---|
| `param` | 用 `from`/`to` **就地**改一个参数值（`from` 必须恰好命中一次） |
| `requirement` | 追加需求，编号接在现有最大值之后 |
| `design` | 追加 `## Amendments` 条目并在 anchor 行后插 pointer |
| `archive` | 归档相关操作 |

### `spec_task_set`

按 id 标记 `tasks.md` 里的任务。状态映射：`pending`→`[ ]`、`active`/`in-progress`→`[-]`、`done`→`[x]`。

### `spec_sign`

往 `tasks.md` 的 `## Notes` 追加一行署名（格式 `- YYYY-MM-DD · DSH · <改了什么>`）。

### `spec_meta`

读写 `tasks.meta.json`（`{pbtResults, executionHistory}` 形状）。

### `spec_archive`

把一个 spec 目录移进 `.kiro/specs/_archive/<feature>/`。**拒绝覆盖已存在的归档**。

---

## 三、诊断与质量（全部只读）

### `spec_diagnostics`

Lint 当前 spec 对照 Kiro 的标题/格式约定：`##` 标题**严格前缀匹配**，
任务三态、依赖图 JSON 形状等。

### `spec_checklist`

对单个 spec 做**只读**的需求质量检查：缺验收条目 / 缺 user story / 条目不可测……

### `spec_drift`

**只读**漂移报告：哪些需求没有落地点 —— 依据任务状态与 design 的追踪关系。

### `spec_status`

报告工作流阶段、任务完成度、以及**下一步该做什么**。

---

## 四、执行

### `spec_run`

按 `## Task Dependency Graph` 的 wave 顺序执行 `tasks.md`：
**wave 之间串行，wave 内部可并行**。

> ⚠️ 依赖图必须写成 `{"waves":[{"id":0,"tasks":["1"]}]}` —— wave 带**数字 `id`**、
> 任务 id 写**字符串**。三处硬要求任意一处违反，宿主会**丢弃整张图并静默回退成完全串行**
> （无报错、无提示）。详见 [../spec-conventions.md](../spec-conventions.md)。

---

## 五、`/spec` 命令

命令面是本宿主独有的（另外两个宿主纯 MCP）。子命令与工具面一一对应，
用于在交互式会话里直接推进而不用让代理逐次调用工具。
