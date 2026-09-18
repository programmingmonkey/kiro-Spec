# `codex-spec` 工具参考

Codex 宿主。**25 个 MCP 工具**，全部经 schema 校验。

- 形态：stdio MCP server（见 [../../plugins/codex-spec/INSTALL.md](../../plugins/codex-spec/INSTALL.md)）
- 没有 Hook、没有阶段门控：**唯一的强制层是工具自己**（CAS、lease、审批、确认短语）

---

## 一、侦察（只读）

| 工具 | 必填 | 说明 |
|---|---|---|
| `spec_health` | `projectRoot` | 检查目标项目 adapter、写入边界和插件基础能力 |
| `spec_list` | `projectRoot` | 发现已管理与 external Spec，**不接管也不修改** |
| `spec_template` | `projectRoot`, `workflow`, `artifact` | 返回某工作流某 artifact 的规范起草模板，不写任何文件 |

`spec_health` 是最该先调的一个：它同时回答「adapter 在不在」「写入边界是什么」
「门控活着吗」（后者见 [claude-spec.md](claude-spec.md)）。

## 二、立项与接管

| 工具 | 必填 | 说明 |
|---|---|---|
| `spec_init` | `projectRoot`, `spec`, `workflow` | 创建私有状态与受控目录，推进到该工作流的起草阶段 |
| `spec_adopt` | `projectRoot`, `spec` | 接管已有 Spec 并记录 artifact 基线 |

⚠️ **`spec_adopt` 的接管不等于批准。** `workflow` 可省略：省略时按 spec 自己的
`.config.kiro` 派生；**显式值与它冲突则拒绝接管**（不猜）。

## 三、写作

| 工具 | 必填 | 说明 |
|---|---|---|
| `spec_read` | `projectRoot`, `spec`, `artifact` | 读一个已管理 artifact，并刷新其 rawRevision 与语义指纹基线 |
| `spec_context` | `projectRoot`, `spec`, `artifact` | 加载写作/执行所需的项目权威规则，签发**短期** `contextProof` |
| `spec_write` | `projectRoot`, `spec`, `artifact`, `content`, `expectedRawRevision`, `contextProof` | 用 `contextProof` + rawRevision **CAS** 原子替换当前阶段的 Markdown |

这三个是一条链：**读 → 取 proof → 写**。

- `expectedRawRevision` 是**乐观锁**：拿旧 revision 去写会被拒，而不是覆盖别人的改动。
- `contextProof` 是**短期凭证**：它证明「写之前确实读过当前的权威规则（steering）」。
  没有它写不进去 —— 这条设计是为了让「规则变了但代理还用着旧理解」无法静默发生。

## 四、状态与诊断

| 工具 | 必填 | 只读 | 说明 |
|---|---|---|---|
| `spec_status` | `projectRoot`, `spec` | | 读 phase、批准、任务、waves、执行恢复状态；发现外部变化时刷新 |
| `spec_diagnostics` | `projectRoot`, `spec` | ✅ | 对标 Kiro `getDiagnostics` 的 spec 分支 |
| `spec_validate_artifacts` | `projectRoot`, `workflow`, `artifacts` | ✅ | 校验**调用方传入的** Markdown（尚未落盘的草稿） |

`spec_diagnostics` 值得单说：它**直接读盘上该 spec 的全部 artifact**，按 Kiro 规则与本仓约定
返回 findings（spec 类型取 `.config.kiro` 写明的值），缺席的列入 `missingArtifacts`；
另附 tasks 解析警告与应由宿主执行的只读 validator 计划。**只读，不刷新基线。**

> ⚠️ `workflow` 只决定「哪些 artifact 合法」，**不代表 spec 类型**。已落盘的 spec 请用
> `spec_diagnostics`，不必传正文。

## 五、跨 artifact 分析（全部只读）

| 工具 | 说明 |
|---|---|
| `spec_analyze` | 只读比较 requirements/design/tasks，返回**带来源定位**的可追溯性结论 |
| `spec_quality_preview` | 只读汇总三份 artifact 的质量画面与源 rawRevision |
| `spec_sync_preview` | 只读给出**无歧义的追加型**同步建议，不改任何 artifact |

`spec_analyze` 的结论可以经 `spec_record_analysis` 记进私有状态（以 `stateEpoch` CAS），
**不改写 Markdown** —— 分析与文档是两件事。

## 六、同步

| 工具 | 必填 | 说明 |
|---|---|---|
| `spec_sync_apply` | `projectRoot`, `spec`, `sourceRevisions`, `contextProof`, `confirmationText` | 应用唯一的追加型设计同步建议 |

它要求**三样齐备**才动：三份源 revision、design `contextProof`、精确确认短语。
随后**使受影响的确认失效**。

## 七、审批

| 工具 | 必填 | 说明 |
|---|---|---|
| `spec_request_approval` | `projectRoot`, `spec`, `artifact` | 固定当前 artifact 指纹，返回**精确批准短语**与 `stateEpoch` |
| `spec_record_approval` | `projectRoot`, `spec`, `artifact`, `expectedStateEpoch`, `confirmationText` | 记录与最新请求匹配的批准，推进阶段 |

「精确批准短语」是防误触设计：批准必须**回填**系统给出的那串字，而不是一句 `yes`。

## 八、任务执行（串行，带 lease）

| 工具 | 必填 | 说明 |
|---|---|---|
| `spec_task_set` | `projectRoot`, `spec`, `taskId`, `state` | 手动标三态；**严格执行 lease 存在时拒绝绕过** |
| `spec_task_plan` | `projectRoot`, `spec`, `scope`, `workspaceSnapshot` | 为已 adopt 且进入 implementing 的 Spec 计算 `task`/`wave`/`all` 串行执行计划 |
| `spec_task_begin` | `projectRoot`, `spec`, `taskId`, `planRevision`, `expectedStateEpoch`, `workspaceSnapshot` | 验证计划与 epoch，取得**单个任务 lease**，把 `[ ]` 原子改为 `[-]` |
| `spec_task_record_check` | `projectRoot`, `spec`, `ownerToken`, `expectedStateEpoch`, `command`, `exitCode`, `summary` | 记录 agent-reported 命令与退出码，**不执行命令** |
| `spec_task_complete` | `projectRoot`, `spec`, `ownerToken`, `expectedStateEpoch`, `workspaceSnapshot`, `summary` | 要求成功检查 + 有效 owner，把 `[-]` 原子改为 `[x]` |
| `spec_task_fail` | `projectRoot`, `spec`, `ownerToken`, `expectedStateEpoch`, `summary` | 关闭 attempt，把插件拥有的 `[-]` 恢复为 `[ ]` 并累计失败次数 |
| `spec_task_reset_failures` | `projectRoot`, `spec`, `taskId`, `expectedStateEpoch`, `confirmationText` | 人工复核后解除**三次失败**门禁，保留审计记录 |

设计要点：

- **`planRevision` + `expectedStateEpoch` + `workspaceSnapshot` 三重校验**：计划变了、
  状态变了、或工作区变了都会拒绝 begin。这是为了防「按旧计划推进」这种最难查的错误。
- **`ownerToken` 是 lease 凭证**：过期的 owner 不能调 complete / fail。
  `spec_task_fail` 把 `[-]` 恢复成 `[ ]` 而不是留在中间态 —— 不留悬空的进行中标记。
- **连续失败三次会被门禁挡住**，解除需要人工确认短语，且审计记录保留。
