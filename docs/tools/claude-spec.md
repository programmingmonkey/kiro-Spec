> 🌐 **中文** · [English](claude-spec.en.md)

# `claude-spec` 工具参考

Claude 宿主。**26 个 MCP 工具**，外加一条 `PreToolUse` 阶段门控。

- 形态：stdio MCP server + hooks（见 [../../plugins/claude-spec/INSTALL.md](../../plugins/claude-spec/INSTALL.md)）
- 比 `codex-spec` 多一个 `spec_amend`，且部分读 / 署名合并是**本宿主独有**

---

## 一、与 `codex-spec` 的差异（只有三处）

| 项 | claude-spec | codex-spec |
|---|---|---|
| `spec_amend` | ✅ 有（增量修正，见下） | ❌ 无 |
| `spec_read` 的 `outline` / `section` | ✅ 支持部分读 | ❌ 只回全文 |
| `spec_context` 的 `knownRevisions` | ✅ 逐字节未变则只回执 | ❌ 总是回全文 |
| `spec_write` 的 `signature` | ✅ 署名并入同一次原子写 | ❌ 无 |

其余 22 个工具的语义与必填参数与 `codex-spec` **完全一致** —— 见
[codex-spec.md](codex-spec.md) 的同名条目。

### `spec_amend`（本宿主独有）

已批准 Spec 的增量修正通道，改一处不必重发整份正文。

| `kind` | 语义 |
|---|---|
| `param` | 用 `from`/`to` 就地改参数值（`from` 须恰好命中一次） |
| `requirement` | 追加需求，编号续在现有最大值之后 |
| `design` | 追加 `## Amendments` 条目，并在 `anchor` 行后插入 pointer |

⚠️ **`heading`（或等价的 `title`，二选一）是「这一条修正自己的」标题**（`### …` 或裸文本），
**不要**传 section 名 `## Amendments` —— 该段由工具自建，传它会让文档出现两个同名二级标题。

拒改任务体，拒绝 `_archive/` 下的 Spec。写入**必定作废**该 artifact 及其下游审批。

### 部分读与回执

- `spec_read(outline=true)` 只回小节目录（标题/行号/字符数）；`spec_read(section="<标题>")`
  只回该小节正文。两者返回 `partial: true` ——
  **不要拿部分读的 `rawRevision` 去整份覆写**。
- `spec_context(knownRevisions=...)` 回传上次拿到的 `rawRevision`：逐字节未变的文件只回执
  （`unchanged: true`），变了的照常回全文。这是为长会话的 token 预算做的。

### 署名合并

`spec_write(..., signature=...)` 把署名**并进同一次原子写**：署名与内容一起落盘，
少一类事后操作，环境标识由插件校验。**事后手工追加一行不受这份担保** ——
它是否算「合法署名」由解析器判，写歪了仍是一次实质改动，仍会作废审批。

---

## 二、阶段门控（`PreToolUse`）

本宿主独有一条 `PreToolUse` hook：在写入发生**之前**检查阶段顺序，越阶段写会被拒。

🔴 **它是「协作约定」，不是「可强制执行的安全边界」。** 它拦住的是「没意识到自己在越界」的
正常流程，不是「决意绕过」的人。插件自述的档位是 `collaborative`。

🔴 **门控层可能处于未观测状态。** `spec_health` 返回的 `gate.status` 有三种取值，
**只有 `"observed"` 是「门活着」的证据**：

| `gate.status` | 读法 |
|---|---|
| `observed` | ✅ 活证据：hook 真的被调用了（心跳被写入） |
| `unobserved` | ⚠️ **中性**，不构成「门没被调用」的判据 |
| `unavailable` | 连心跳路径都没有 |

**走 MCP 工具的路径不受门控影响**：`spec_write` 等工具本身带 CAS、lease、审批、署名全套保护。
不受保护的只有「绕过 MCP、直接用原生 `Write`/`Edit`」那条路径。

### 两种运行拓扑

`CLAUDE_SPEC_TOPOLOGY` 环境变量（只在 MCP 服务器启动时读一次，**不做自动探测**）：

| | `local`（默认） | `cowork`（显式切换） |
|---|---|---|
| hook 与 MCP 的关系 | 同一台机器、同一个文件系统 | hook 在会话容器、MCP 在用户本机 |
| `gate.status === "unobserved"` 怎么读 | **更值得怀疑**：去查 `hooks.json` 有没有被认领、有没有真的触发过 | **中性** |

非法值（既不是 `local` 也不是 `cowork`）会让进程**启动时直接失败退出**并把原因写进 stderr ——
**不会**悄悄按 `local` 顶上。理由：判错拓扑会让排查方向指错，比不判定更危险。
