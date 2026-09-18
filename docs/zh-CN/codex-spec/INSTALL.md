> 🌐 [English](../../../plugins/codex-spec/INSTALL.md) · **中文**

> ⚠️ **本文件是开发期的原版，不是英文版的翻译。**
> 英文版是**面向公开读者的改写**：它去掉了带日期的事故记录，并移除了指向内部资料的引用。
> 两者实质有差异处，**以英文版为准**。


# 安装与运维

## 单一路径安装

Codex marketplace 必须指向仓库内已经 vendor 的 `plugins/codex-spec-dist/`，而不是开发源码目录
`plugins/codex-spec/`。源码目录依赖 workspace 包，直接安装会在启动时缺少 `@my-harness/spec-state`。
发布前执行 `node scripts/pack-plugin.mjs codex-spec --out /private/tmp/codex-spec.plugin`，再将归档解包到
`plugins/codex-spec-dist/`；本仓库的 marketplace 已指向该目录。随后执行：

```bash
codex plugin marketplace add /absolute/path/to/marketplace-root
codex plugin add codex-spec@your-marketplace
```

本仓库提交了项目级 marketplace 注册表；它不改写用户级 Codex 配置。部署方应使 marketplace entry 的 `source.path` 指向 `./plugins/codex-spec-dist`。

## 启用、禁用与卸载

```bash
# 查看安装和启用状态
codex plugin list

# 卸载（同时从 Codex 本地配置和缓存中移除）
codex plugin remove codex-spec@your-marketplace

# 移除本地 marketplace 注册
codex plugin marketplace remove your-marketplace
```

Codex 当前通过安装状态管理启用/禁用；没有单独的 disable 命令时，卸载是确定的禁用与回滚路径。重新添加相同 marketplace 并执行安装即可恢复。

## 配置合并与回滚

安装过程不会改写项目 `.codex/config.toml`。运行时会按工具调用创建或更新 `.kiro/specs/` 下 write policy 允许的 Markdown，并在项目根创建 `.codex-spec-private/` 保存可重建状态；项目应把 `.codex-spec-private/` 加入 `.gitignore`。

Codex 将插件内 `.mcp.json` 注册为一个名为 `codex-spec` 的本地 stdio server；如有同名用户 MCP 配置，先移除或改名冲突项，再安装本插件。

回滚步骤：卸载插件、移除仅为它新增的 marketplace，再重启 Codex 会话。卸载不会删除项目里的 `.kiro/specs/` 或 `.codex-spec-private/`；确认不再需要恢复 workflow state 后，可以手工删除后者。共享 Spec Markdown 不属于插件安装残留，不应随卸载自动删除。

## 项目 adapter

服务要求目标项目存在 `.codex/codex-spec.json`。从插件目录复制 `adapter.example.json`，把日期、权威文件和规则改成项目真实值，再保存到目标项目：

```bash
mkdir -p .codex
cp /absolute/path/to/codex-spec/adapter.example.json .codex/codex-spec.json
```

示例中的 `authorityHash` 不能照抄。它必须是 `authorityFile` 原始字节的 SHA-256，可在目标项目根计算：

```bash
node --input-type=module -e "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs'; const raw = readFileSync('.kiro/steering/spec-conventions.md'); console.log('sha256:' + createHash('sha256').update(raw).digest('hex'));"
```

把输出完整写入 `authorityHash`。缺少 adapter 时服务返回 `ADAPTER_MISSING`；JSON、路径或 policy 无效时返回 `ADAPTER_INVALID`；权威文件 hash 不匹配时返回 `ADAPTER_UNTRUSTED`。

## 项目根与宿主 smoke

插件 MCP 以 `.mcp.json` 中的 `cwd: "."` 从已安装插件根启动。每次调用必须把目标项目的规范化绝对路径作为 `projectRoot` 参数传入；仅对不传该参数的旧调用，服务才依次回退到 `KIRO_SPEC_PROJECT_ROOT` 和进程 cwd。首次安装或 Codex 升级后必须做宿主 smoke：

1. 在目标项目启动新的 Codex 会话。
2. 以目标项目绝对路径调用 `spec_health({ projectRoot })`，确认返回值一致。
3. 检查 stderr 启动诊断中的 `cwd` 与 `configuredProjectRoot`。
4. 未确认项目根之前，不调用 `spec_init`、`spec_adopt` 或 `spec_write`。

执行存量 `tasks.md` 前，再用 `spec_list` 确认目标是 `managed` 还是 `external`。`external` Spec 必须先显式 `spec_adopt`；随后按 Skill 的 `spec_task_plan` → `spec_task_begin` → `spec_task_record_check` → `spec_task_complete`/`spec_task_fail` 顺序执行，并在 plan/begin/complete 传入同一采集策略的结构化 `workspaceSnapshot`。不要绕过插件直接修改执行中的 checkbox。

旧客户端无法传 `projectRoot` 时，才以绝对路径设置 `KIRO_SPEC_PROJECT_ROOT` 后重启会话。`codex mcp get codex-spec` 可辅助检查已注册配置，但不能替代实际的 `spec_health` 宿主 smoke。

## 离线验证

无需网络或 npm registry：

```bash
cd plugins/codex-spec
npm run doctor
npm_config_cache=/private/tmp/codex-spec-npm-cache npm pack --dry-run --json
```

⚠️ 这段是**源码仓库**里的验证。**装好的插件（`plugins/codex-spec-dist/`）里没有
`doctor` / `check` / `test`** —— 它们都点名了 `test/`，而 `test/` 不进产物，打包时已剔。
产物里剩下的是 `npm run build`（对运行时文件过一遍 `node --check`）。
（剔之前：产物里 `npm run check` 直接 `MODULE_NOT_FOUND`，`npm test` 跑 0 个测试然后 exit 0。）

预期：语法检查和测试通过，dry-run 文件列表包含 `mcp-server.mjs`、运行时 `lib/`、Skill、文档与 `adapter.example.json`。

## 无 Hook 降级

任务 01 不安装 `/hooks`，也不要求 Hook trust 或 security bootstrap。启动诊断中的 `fileGuardrail=false` 是预期结果，而不是启动失败。直接文件写的 guardrail 只会在后续可选任务 07 引入。

## evaluation-only probe

`plugins/codex-spec/fixtures/adapter.example.json` 是当前消费项目权威 steering 文件的原始字节哈希样本。它只能安装到消费项目的 `.codex/kiro-spec.json` 后使用，且该写入需要用户明确授权；不要复制到其他仓库，也不要将 hash 当作可长期复用的默认值。

在获得授权且确认消费项目工作树干净后执行：

```bash
node plugins/codex-spec/fixtures/admission-probe.mjs \
  --project-root /absolute/path/to/the consumer repo \
  --adapter .codex/kiro-spec.json \
  --spec _eval-codex-20260827 \
  --output /tmp/probe-result.json
```

probe 仅会请求 evaluation-only 目录写入；它会记录两次被拒绝的越界写入、tasks 读写字节稳定性及固定 validator 的退出状态。它不会修改 steering、模板或 validator。真实运行完成后仍要独立检查 authority hash 与 `git diff -- .kiro/steering scripts/spec-tasks-lint.py`。
