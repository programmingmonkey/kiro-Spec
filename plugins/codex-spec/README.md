> 🌐 **中文** · [English](../../docs/en/codex-spec/README.md)

> ⚠️ **本文件是开发期的原记录。**
> 英文版是**面向公开读者的改写**：它去掉了带日期的事故记录，并移除了指向内部资料的引用。
> 两者描述的行为一致，但**不是互相翻译** —— 想知道「当初是怎么得出这个结论的」，看这一份。


# codex-spec

`codex-spec` 是面向 Codex 的 Kiro-compatible Spec 插件。它提供四种协作级工作流的写作闭环、存量 Spec 发现、跨 artifact 分析与同步、串行任务执行，以及 evaluation-only 准入；不提供并行执行、Hook 或 Hard-security。

## 支持矩阵

| 组件 | 当前锁定范围 |
|---|---|
| Codex | `0.150.0-alpha.8` 或后续兼容版本；版本变化需重跑宿主 smoke |
| Node | `>=20 <26`；Node 20、22、24 LTS 为支持基线，00A-base 在 Node `v25.8.0` 验证 |
| macOS | Apple Silicon 与 Intel 的本地 stdio 运行时 |
| Linux | x86_64 与 arm64 的本地 stdio 运行时 |

## 当前能力与边界

MCP 提供 `spec_health/list/template/validate_artifacts/init/adopt/read/context/write/status/diagnostics/analyze/quality_preview/sync_preview/sync_apply/record_analysis/request_approval/record_approval`，以及 `spec_task_set` 手动三态更新、`spec_task_plan/begin/record_check/complete/fail/reset_failures` 串行执行工具。

⚠️ **与 claude-spec 的一处未评估差异**（2026-09-17 记）：共享层 `packages/spec-state` 已实现
`spec_amend`、`spec_read` 的 `outline`/`section` 部分读、`spec_context` 的 `knownRevisions`，
但**本宿主的工具清单没有开放它们**（`lib/mcp/tools.mjs`）。这不是一个经过评估的决定 —— 那三条是在 claude-spec 的 token 实测里做的，没有对本宿主重做。要开放，须同步本目录的
`tool-schema.test.mjs` 与 `SKILL.md`，并补跑 `pack-plugin` 与 `codex-spec-dist` 的漂移网。

它支持 requirements-first、design-first、bugfix 与 quick：design-first 先确认设计，bugfix 使用独立 `bugfix.md`，quick 必须写齐三份 artifact 后以 `批准全部 artifacts` 作一次整体确认。`spec_template` 提供 workflow 专属模板；`spec_diagnostics` 直接读盘上的 spec 与 `.config.kiro` 做格式诊断（对标 Kiro `getDiagnostics` 的 spec 分支），`spec_validate_artifacts` 只用于尚未落盘的草稿。`spec_analyze`、`spec_quality_preview` 和 `spec_sync_preview` 都只读比较 requirements/design/tasks；`spec_sync_apply` 只应用无歧义的设计追踪追加，并要求三份源 revision、design context proof 和明确确认，随后使受影响确认失效。

插件调用时，每个工具都必须传入当前项目的规范化绝对 `projectRoot`；写入还要求与该项目 `.codex/codex-spec.json` 的 `writePolicy` 相符、拥有未过期的 `spec_context` proof，并提交匹配的 `rawRevision`。确认、工作区快照和执行检查记录始终显示 `assurance=collaborative`。

消费项目适配器必须保持 `evaluation-only`：只允许 `.kiro/specs/_eval-codex-YYYYMMDD/` 这一份规范命名的评估 Spec，不允许在其下再嵌套子 Spec，并以权威 steering 文件的 SHA-256 绑定策略。适配器 hash 不匹配、Spec 名称不匹配或 context proof 失效时，服务端拒绝写入。MCP 仅返回内建 allowlist 的 validator argv，绝不自行执行项目命令。

当前不包含 converge、并行执行、Hook、自动清理或 Hard-security。同步只覆盖无歧义的 design requirements trace 追加，不会自动改写已批准内容。`tasks.meta.json` 始终只读。项目命令由宿主 agent 运行；`spec_task_record_check` 只保存明确标记为 `agent-reported` 的命令、退出码和摘要。

`spec_list` 会发现没有私有状态的存量 Spec，并以 `lifecycle=external` 返回。执行前必须显式 `spec_adopt`。执行顺序是 plan → begin → record_check → complete/fail；跨进程锁、owner token、30 分钟 lease、state epoch、task raw revision 和可重启对账的 intent journal 共同拒绝重复执行、过期提交与半提交状态。第三次失败会持续返回 `HUMAN_REVIEW_REQUIRED`，直到人工使用精确确认短语调用 `spec_task_reset_failures`。

`spec_task_plan/begin/complete` 接收由宿主采集的结构化 `workspaceSnapshot`，服务端负责 canonicalize 并重算 revision，但不自行运行 Git，因此仍是 collaborative 边界。纯检查叶子任务必须显式标记 `_Type:_ verification`，才可在 workspace revision 不变时完成。

启动诊断以单行 JSON 写入 stderr，字段包括版本、cwd、显式配置的项目根、`tools` 和 `fileGuardrail=false`。该日志不包含 Spec 内容、token、receipt 或私有状态。工具参数中的绝对 `projectRoot` 优先级最高；旧调用才依次回退到 `KIRO_SPEC_PROJECT_ROOT` 和进程 cwd。`spec_health` 会回显规范化后的 `projectRoot`，安装后必须核对它是否指向目标项目。

`.codex-spec-private/` 保存可重建的 workflow cache 与协作确认摘要；context proof 仅保存在当前进程的内存中，进程退出或五分钟有效期结束后必须重新调用 `spec_context`。Markdown 仍是共享真源。私有状态丢失后可通过 `spec_adopt` 和重新确认恢复，且不会提升 assurance。

当前 stdio transport 在 `mcp-server.mjs` 中全局串行处理请求，因此 MCP 调用不会并发进入 service。直接导入 `createMcpService` 后并发调用不属于本版本保证的契约；若未来开放该用法，需要先统一串行化所有会读写 spec state 的操作。

`spec_health`、`spec_list`、`spec_context` 与 `spec_diagnostics` 不创建私有状态并声明 `readOnlyHint=true`。`spec_read`、`spec_status` 与 `spec_task_plan` 可能因发现外部变化而刷新 workflow state，因此保守声明为非只读；会替换共享 Markdown 的工具另声明 `destructiveHint=true`。

## 本地验证

```bash
cd plugins/codex-spec
npm run doctor
```

无 Hook 时是支持的基础模式：`fileGuardrail=false` 表示直接文件工具没有 guardrail；它不阻断已安装插件的 Skill 与 MCP 启动。

安装、启用、禁用、卸载、配置合并/回滚和离线验证见 [INSTALL.md](INSTALL.md)。

## evaluation-only 准入

插件内的 `fixtures/` 提供固定的适配器样本和可重复运行的 probe。它只用于评估目录 `_eval-codex-YYYYMMDD/`，并拒绝正式 Spec 及所有非评估前缀的写入。probe 通过 `createMcpService()` 写入 requirements、design、tasks，读取 tasks 验证字节稳定性，然后只以固定 argv 运行一次 validator。

样本中的 authority hash 是对当前消费项目 steering 文件的原始字节绑定，不是通用默认值；运行前必须重新验证。真实消费项目写入必须获得用户明确的跨仓授权，并先确认其工作树干净。未满足这两个前提时，只能运行插件内的隔离测试，不能把结果表述为真实宿主准入通过。
