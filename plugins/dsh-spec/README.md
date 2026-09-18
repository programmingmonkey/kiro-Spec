> 🌐 **中文** · [English](../../docs/en/dsh-spec/README.md)

> ⚠️ **本文件是开发期的原版，不是英文版的翻译。**
> 英文版是**面向公开读者的改写**：它去掉了带日期的事故记录，并移除了指向内部资料的引用。
> 两者实质有差异处，**以英文版为准**。


# dsh-spec

复刻 Kiro Spec 机制的 DeepSeek Harness cordis 插件。把一个功能/修复规范化为正式 spec 文档，并强制分阶段顺序推进。

## 四种 spec 形态

| 形态 | 顺序 | 首个工件 | 审批门 |
|---|---|---|---|
| **feature（requirements-first）** | requirements → design → tasks | `requirements.md` | 有 |
| **feature（design-first）** | design → requirements（推导）→ tasks | `design.md`（High/Low Level 两档） | 有 |
| **bugfix** | analysis → design → tasks | `bugfix.md`（current/expected/unchanged 三段） | 有 |
| **quick** | 一次性三件套 | 三件全生成 | 无 |

### 真机有、本仓**未建模**的两档 workflow

`spec_init` 只接受上面那几档。真机的 `WorkflowType` 枚举里还有两个，本仓**已知但不实现**：

| 真机 `workflowType` | 本仓现状 |
|---|---|
| `fast-task` | **未建模**。文档集与 requirements-first 相同（`.config.kiro` + requirements/design/tasks），但**流程与呈现顺序**不同（真机是 tasks 优先的清单）。盘上实测 5 例在跑 |
| `verify-first` | **未建模**，且盘上 77 个真实 `.config.kiro` 里 **0 例** —— 不能说它不存在，只能说语料未覆盖 |

### 一处**仍待真机样本**才能裁定的差异

`quick` 这一档的**文档集**三方不一致：KiroCrew 的 quick **不产 `design.md`**，本仓的 quick
**产三件套**。⚠️ **目前无法裁定**：真机 `specType: "quick-spec"` 在 77 个真实 `.config.kiro`
里 **0 例**，拿不到真机样本。**别当成已解决** ——
等语料里出现 `quick-spec` 实例再以真机为准。
（真机的枚举与「`specType` → 本仓 kind」的映射已落地并断言，见 `packages/spec-parser/lib/config-kiro.js`
的 `specTypeToKind`；**分子歧的只是文档集**。）

读到 `.config.kiro` 里是这两档时，`spec_status` 会在 `workflowNotes` 里**明说「本仓未建模，
本次按既有流程走」**（见 §T3 的 `deriveWorkflow`）—— 静默套用另一套流程是本仓在别处反复拒绝的
那种降级。要做的话是独立一期，不是顺手加个枚举值。

## 目录对齐（Kiro 布局）

spec 默认写入 `.kiro/specs/<feature>/`（Kiro 的多 spec 子目录布局），每个功能一个目录：

```
<projectRoot>/.kiro/specs/<feature>/
├── requirements.md    # feature / quick
├── bugfix.md          # bugfix（Analysis 阶段产物，代替 requirements.md）
├── design.md
├── tasks.md
└── tasks.meta.json    # 执行历史 + _workflow 标记
```

- **活跃 spec 指针**：`.kiro/specs/_active` 记录当前 feature 名，后续 `spec_write/read/status/task_set` 免传 feature 名自动定位。
- **单 spec 兼容**：旧版直接写在配置 `specDir`（如 `.spec/`）下的 spec 仍可被读取。
- **非破坏迁移**：首次 `spec_init` 时若旧位置已有 spec，文件会被**复制**进
  `<feature>/` 子目录，旧位置保留（沿用 Kiro 的零迁移铁律）。
- 也可用 `specsRoot` 配置把根指向任意父目录。

## 三阶段（feature requirements-first）

| 阶段 | 文件 | 内容 |
|---|---|---|
| Requirements | `requirements.md` | 用户故事 + EARS 验收标准（`WHEN … THE SYSTEM SHALL …`） |
| Design | `design.md` | 架构、数据流、错误处理、测试策略 |
| Tasks | `tasks.md` | 复选框实现计划，每项引用 `_Requirements: x.y_` |

> bugfix 的 Analysis 阶段产物是 `bugfix.md`（Current / Expected / Unchanged Behavior
> 三段，EARS 用小写 `the system` + `SHALL CONTINUE TO` 做回归防护），design 阶段补
> 根因分析与「需测试属性」。

## 能力

- **系统提示段**（`spec:workflow`, order 120）：把 spec-first 工作流注入每次请求，作为常驻行为约束。
- **任务三态**（Kiro）：`- [ ]` 待办 / `- [-]` 进行中 / `- [x]` 完成，拒绝第四态。
- **任务依赖图**：`tasks.md` 的 `## Task Dependency Graph`，wave 间串行、wave 内并发。形态为
  `{"waves":[{"id":0,"tasks":["1","2"]},{"id":1,"tasks":["3"]}]}` —— 对象数组（非裸数组）、
  wave 带**数字 `id`**（0 起连续）、任务 id 为**字符串**。后两项 DSH 自己不强制（会归一化），
  但 Kiro 真机缺任一项就丢弃整图回退串行，故 `spec_diagnostics` 会发 warning。
  依据是 kiro-agent 1.0.794 的真机实测。
- **waves 执行器**（`spec_run` 工具 + `/spec run`）：解析依赖图，按 wave 顺序执行；wave 间串行、wave 内通过 subagent 并发（默认最多 4 个，见 `maxConcurrency`）。只跑未完成（非 `[x]`）且在图中声明的任务；失败任务回退 `[ ]`，成功标 `[x]`。`/spec plan` 预览执行计划（不派发）。
  - **任务状态由执行器独占写入。** 派发出去的子代理被明确告知**不要**改 `tasks.md`、不要调 `spec_task_set` —— 同 wave 内多个子代理并发整文件读-改-写会互相覆盖。状态一律由 runner 在子代理结算后标记。
  - 状态写入失败会**显式列在返回结果里**（不会静默丢失），异常中断时本 wave 的 `[-]` 会回落到 `[ ]`。
  - **没有依赖图 ⇒ 严格串行**（一次一个任务），并给出 warning 说明原因与改法。
    2026-09-16 真机裁决：真机无图时 `getReadyTasksSequential()` 只返回
    **第一个** ready 叶子，一次一个；而本仓此前把它当成"一个 wave 装下全部任务"在
    `maxConcurrency` 内并发 —— 与真机相反。改向串行还有一条更硬的理由：
    `tasks/missing-dependency-graph` 在真机与本仓表里**都是 `severity: "error"`**，
    也就是**诊断器判它是错，runner 却把它当并发跑**，两者自相矛盾。而且"没声明依赖"
    ≠"声明了可以并行"：并发子代理会同时改同一批文件（`tasks.md` 已用"执行器独占写入"
    收口，但代码文件仍裸露）。影响面 3.1%（消费项目 224 份 `tasks.md` 里 7 份无图），
    想要并发只需补一张图。
  - 空依赖图 `{"waves":[]}` 表示"什么都不调度"，与"没有依赖图"**语义仍不同**：
    前者**一条都不派发**（给出 warning），后者按上面那样**逐条串行跑完**。
  - 任务的 `_Requirements:` 引用会被解析，只向子代理注入被引用的需求块；`design.md` 等其余上下文受 `maxContextBytes` 总预算约束，超出即截断。
- **工具**（`spec_*`）：
  - `spec_init(goal, kind?, workflow?, detailLevel?, feature?)` — 启动 spec；`kind` = feature(默认)/bugfix/quick；`workflow` = requirements-first(默认)/design-first；`detailLevel` = high(默认)/low
  - `spec_write(file, content)` — 写 spec 文件（`requirements`/`design`/`tasks`/`bugfix`）；工作流感知的阶段门控；写后返回非阻塞诊断摘要（不阻止写入）
  - `spec_read(file?)` — 读某文件、`meta`（tasks.meta.json）、或整体状态
  - `spec_status()` — 阶段 + 任务完成度 + 下一步
  - `spec_task_set(index, {done?|state?})` — 设置任务状态（`pending`/`active`/`done`）
  - `spec_meta(action?, task?, ...)` — 读写 spec 目录下的 `tasks.meta.json`。

    ⚠️ **它是真机 1.1.28 之前**的执行历史形状（`{pbtResults, executionHistory}`，每条任务上限
    **10 条**，与真机逐字一致）。真机已把这份数据挪到
    `~/.kiro/tasks/<workspace-hash>/<feature>.meta.json`（形状也不同），**本插件不写那个 store**：
    它是 Kiro 自己的、它今天还在写、且它持自己的文件锁并会在**它的**写入路径上 `slice(-10)`
    —— 我们插进去的记录会被它截掉。而且写到工作区外要绕过 `ctx.fs`，正是 `port.move` 那条路，
    仓库在那条路上专门加了 `assertInsideProject` 把它拦住。

    保留旧位置是有意的：仓库语料里 **96/211** 个 spec 就带着这份文件，而仓库的既有原则是
    `tasks.meta.json`「is NOT ours to reconstruct」。**所以：说的口径要准，位置不动。**
    读它的人要知道自己读到的**不是**当前 Kiro 的执行历史。
  - `spec_run(wave?, dryRun?)` — waves 执行器；`wave` 只跑某波，`dryRun` 仅预览计划
  - `spec_diagnostics()` — 诊断器（getDiagnostics 等价物）：校验 `##` 标题严格前缀匹配、H1 标题、依赖图 JSON 形状、任务第四态，缺 `**User Story:**`/`#### Acceptance Criteria` 给软警告；只报告、不阻塞写入
- **命令** `/spec [status|diagnose|new <name>|view [name] [file]|run|plan|analyze_requirements [name]|init <goal>]`
  - `new <name>` — 新建 spec 并切到其 feature 目录
  - `view [name] [file]` — 打开指定 spec 文档（缺省 requirements.md 与当前活跃 spec）
  - `run` / `plan` — 按依赖图执行 / 预览计划
  - `diagnose` / `diag` / `lint` — 对活跃 spec 跑诊断器（`spec_diagnostics` 的命令面）
  - `analyze_requirements [name]` — 引导当前 agent 跨全量需求做一致性分析（逻辑矛盾/歧义/冲突约束/未声明假设/缺失边界）

## 配置

在 profile 的 `cordis.patch.yml` 行里可覆盖：

```yaml
- insert:
    - id: dsh-spec
      name: ../dsh-spec/lib/index.js
      config:
        specDir: .spec               # 默认；单 spec 兼容位置
        projectRootMarkers: ['.git'] # 项目根识别标记
        specsRoot: null              # 显式 spec 父目录（可选）
        useFeatureDirs: true         # 使用 .kiro/specs/<feature>/ 布局
        subagentProvider: null       # /spec run 派发任务用的 subagent provider 名（必填才能 run）
        maxConcurrency: 4            # 单 wave 内最大并发子代理数（默认 4）
        maxContextBytes: 32000       # 注入单个任务提示词的 spec 上下文总预算字节（默认 32000）
```

> `subagentProvider` 填 `spawn` 即可：`dsh-base` 已挂载 `@deepseek-ai/dsh-subagent-spawn-in-process`，
> 其注册名默认就是 `spawn`。未配置时 `spec_run` / `/spec run` 会明确报错（核心三文档工作流不受影响，
> `/spec plan` 仍可预览）。

spec 文件写入 `<projectRoot>/.kiro/specs/<feature>/`，项目根 = 从会话 cwd 向上找最近含 `.git` 的目录（无则回退 cwd）。
