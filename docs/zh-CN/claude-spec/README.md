> 🌐 [English](../../../plugins/claude-spec/README.md) · **中文**

> ⚠️ **本文件是开发期的原版，不是英文版的翻译。**
> 英文版是**面向公开读者的改写**：它去掉了带日期的事故记录，并移除了指向内部资料的引用。
> 两者实质有差异处，**以英文版为准**。


# claude-spec

`claude-spec` is a Kiro-compatible Spec plugin for Claude. It provides the authoring loop for four
collaborative workflows, existing-Spec discovery, cross-artifact analysis and sync, serial task execution,
and a `PreToolUse` stage gate. It does not provide parallel execution, automatic cleanup, or security receipts.

## 运行拓扑：本地 / Cowork

2026-09-14 才第一次确认「本地 Claude Code CLI 是一条正常路径，不是 Cowork 的退化版」——在那之前
本文档从上到下都默认你在 Cowork 里跑。两条拓扑的差别只在**存活信号怎么解读**，不在功能或安全边界：

| | 本地 Claude Code CLI（**默认**） | Claude Cowork（显式切换） |
|---|---|---|
| `CLAUDE_SPEC_TOPOLOGY` | 省略，或显式设成 `local` | 设成 `cowork` |
| hook 与 MCP 的关系 | 同一台机器、同一个文件系统 | hook 跑在会话容器，MCP 跑在用户本机——两条路径未必共享文件系统 |
| `spec_health` 的 `gate.status === "unobserved"` 怎么读 | 更值得怀疑：直接检查 `hooks.json` 有没有被这次安装认领、有没有真的触发过 `PreToolUse` | **中性**，不构成「门没被调用」的判据——死活判据请走下面「阶段门控存活探针」，读容器内的审计日志 |

只在 MCP 服务器启动时读一次 `CLAUDE_SPEC_TOPOLOGY`，不做自动探测：判错拓扑会让 `unobserved` 的排查建议
指错方向，比不判定更危险。非法值（既不是 `local` 也不是 `cowork`）会让进程启动时直接失败退出并把原因写进
stderr，不会悄悄按 `local` 顶上。`spec_health` 的返回值里现在带一个 `gate.topology` 字段，回报这次判定
用的是哪一种。

⚠️ **这条拓扑切换不影响 §4.3.2 签名**：判据的事实源是消费项目自己 `.githooks/pre-commit`，
认的是签名里的 `env` 字段，与插件实际跑在哪种拓扑无关。要改判据得去改那个仓库的 pre-commit
（不在本插件范围内），而不是在这边悄悄放宽。
🔴 **2026-09-17 订正**：本段原先还写着「`env=Claude` 时 summary 必须含字面量 `Cowork`」。
消费项目已于 2026-09-17 **退役 Cowork 通道**（改走本地 Claude Code）并从 hook 里删掉那句判据，
理由值得记住：**那条要求被插件强制注入，于是它不再追踪现实，只追踪「作者有没有写那个词」，
沦为与实际宿主无关的咒语**。所以现在**没有按环境分的附加字面量要求**。

## Tier: `collaborative`

**本插件是 collaborative 档。** 勾选、确认、阶段门控都是**协作约定**，不是可强制执行的安全边界 ——
它们拦住的是「没意识到自己在越界」的正常流程，不是「决意绕过」的人。

> ✅ **2026-09-14 02:54 已恢复。** 原因是 `scripts/spec-stage-gate.sh` **没有可执行位**
> （git 自第一笔提交起记的就是 `100644`，打包器也从不设模式位）—— 宿主直接 `exec` 它就拉不起来。
> 已修：git 改 `100755`、`pack-plugin.mjs` 把它写成 `0755`，并加一条**从产物自己的
> `hooks.json` 反查 `type:command` 路径**再验模式位的用例。
> 真机三段全通：`entry` 行（进程被拉起）→ `decision: allow`（判定在跑、走对分支）→
> `decision: deny` 且 Write 真的被拒（宿主执行了拒绝）。
>
> ⚠️ **「为什么 2026-09-13 那次会响」没有被这条结论解释掉**：那次装的 `78b16cf` 归档里，
> 同一个文件**也是 `0644`**（实测）。剩两种假设 —— 宿主改了拉起方式 / 那条记录本身有误 ——
> 本会话无法判定，**不选**。见 `docs/2026-09-14-spec-tri-host-incidents.md` §9.12。
>
> 以下是停摆期间的记录，保留备查：
> 🔴 ~~**2026-09-14 起：阶段门控在 Cowork 上当前不生效（现象已确认）。**~~
> 不是「拦不住决意绕过的人」，是**一次都不响**。
>
> ⚠️ **但「为什么」还没结案。** 曾经的结论是「宿主根本没调用 `PreToolUse` hook」——**它比证据强**：
> 那次 A/B 的因变量是「越阶段写有没有被拒」，而它分不开「宿主没调用」与「调用了但走了静默
> 放行分支」（门自身有**六条**静默放行分支，命中任一条都 `exit 0` 且不写 stderr）；
> 两个被测 build 的审计日志**都还是 opt-in**，所以整场 A/B 里「调没调」**零直接证据**。
> 已经钉死的是：判定逻辑没问题（喂 payload 实测 `deny` + `exit 2`）、配置字节从未变过
> （`git log` 一笔提交）、宿主侧**能查到的**版本指纹（`claude-code-vm` SDK `2.1.266`、
> VM bundle `2a762adf`）在整个窗口里**是平的**。
>
> **所以现在的准确措辞是：本插件的阶段门控层处于停摆状态，MCP 工具面不受影响。**
> 走 MCP 工具（`spec_write` 等）的流程仍有 CAS、lease、审批、署名全套保护；
> 绕过 MCP 直接用原生 `Write`/`Edit` 的路径**当前没有任何东西拦**。
> 完整证据链：`docs/2026-09-14-spec-tri-host-incidents.md` §9、
> `docs/2026-09-14-dsh-cross-account-hook-audit.md` §2.5 / §4。
>
> ✅ **存活信号现在有了**（2026-09-14 修，`.kiro/specs/claude-spec-gate-liveness`）：
> 每次 hook 调用都会覆盖写一个心跳，`spec_health` 把它读出来 —— **判据是 `gate.status`：
> 只有 `"observed"` 是活证据**（`unobserved` 是中性、`unavailable` 表示连路径都没有）。
> 于是「这道门还活着吗」**搭在活着的那层**（MCP 工具面）上。
> ⚠️ **但在 Cowork 拓扑下它恒为 `"unobserved"`，不是死活判据**【读码 2026-09-14】：
> 心跳由 hook 写在**会话容器**的 `<cwd>/.claude/`，而 `spec_health` 在**用户本机**按调用方给的
> `projectRoot` 去读 —— 两个不同的文件系统。**心跳想跨的那道缝，正是它被造出来要解释的那道缝。**
> 所以代码**不假装解决了它**：`unobserved` 说的是「**我没看见**」，不是「它没发生」，
> 并且会带一个 `caveat` 把这句话钉进返回值里。门活着它也是 `unobserved`，
> 把它读成「门死了」会得到一个**假的死亡信号**。
> 它只在 hook 与 MCP 同机同文件系统时有效（例如本地 Claude Code CLI）。
> Cowork 里的死活判据是 INSTALL.md 的探针 —— 读**容器内**那份审计日志。
> 审计日志仍默认开，而且是 `entry` 行（证明进程被拉起过）+ 判定行两行，
> **可以在会话里直接用 Bash 工具读**（Bash 工具与 hook 同在容器）——
> 步骤与判据表见 INSTALL.md 的「阶段门控存活探针」。
> ⚠️ 旧文写「`spec_health` 在架构上不可能报告 hook 的死活」：那是**当时的**事实，
> 心跳绕开了它 —— 代价是引入一条**待测前提**：容器与读取方共享同一文件系统。

依据是 `spikes/cowork-hook-probe/evidence/admission.json`：`privateStateIntegrity` 实测 **FAIL**，
`evaluateAdmission()` 返回 FAIL，计划据此落 `decision: "STOP"`。**在那份 admission 变化之前，
本文档里的档位措辞不得软化** —— 具体哪几项被明确划掉，见下方【不做】。

## 支持矩阵

| 组件 | 当前锁定范围 |
|---|---|
| Claude Cowork | 宿主版本 `1.52386.3`（Electron `44.2.0`）——2026-09-13 Task 7 真机安装实测，桌面端设备信息上报值 |
| Node（hook 侧） | `engines` 声明 `>=20 <26`；**会话容器（Linux，Cowork 云端沙箱）实测 `v22.22.2`** —— `PreToolUse` 的 `spec-stage-gate.sh`/`.mjs` 就跑在这里，已实测真实拦截 |
| Node（MCP 侧） | 🔴 **实测发现，与此前假设不同：MCP server 不跟 hook 同机。** `.mcp.json` 声明的 `claude-spec` server 是**本地 stdio 进程**，由桌面端在**用户本机**（此次实测环境：macOS arm64）拉起，通过 remote-devices 桥接暴露成 `mcp__remote-devices__plugin_claude-spec_claude-spec__*` 工具；本机 Node 实测 `v24.20.0`。证据：`spec_health({projectRoot:"/Users/.../消费项目"})` 直接读到了只存在于用户本机的真实消费项目。 |
| macOS | Apple Silicon（本次实测机型）与 Intel 的本地 stdio 运行时 |
| Linux | 会话容器侧 —— **只是 hook 实际执行的地方，不是 MCP。** 见上两行；旧版此处把两者混为一谈，是错的。 |

## 阶段门控（`PreToolUse`）

`hooks/hooks.json` 只挂一个事件：`PreToolUse`，`matcher: "Write|Edit|MultiEdit"`，命令是
`${CLAUDE_PLUGIN_ROOT}/scripts/spec-stage-gate.sh`。

只检查落在 `.kiro/specs/**` 内的写入，并按「阶段在前、产物在后」放行或拒绝：

| 想写 | 需要先存在 |
|---|---|
| `.kiro/specs/<f>/requirements.md` | （无条件放行：feature 工作流的第一阶段） |
| `.kiro/specs/<f>/bugfix.md` | （无条件放行：bugfix 工作流的第一阶段） |
| `.kiro/specs/<f>/design.md` | `requirements.md` **或** `bugfix.md` |
| `.kiro/specs/<f>/tasks.md` | `design.md` |

- **写 `.kiro/specs/**` 之外的任何文件不受影响** —— 静默放行，不打扰。
- **子代理内部的写同样被拦。** 实测：子代理每次工具调用各自独立触发 `PreToolUse`，payload 带
  `agent_id` / `agent_type`；判定**不看**这两个字段，父会话与子代理一视同仁。派个子代理不是绕过门控的路。
- **门控自己出错时放行并大声报错**（fail-open + loud）。理由：它拦不住存心绕过的人，
  所以为一个坏掉的环境（缺 node、畸形 payload）把正常写入全部堵死，只会制造更难查的故障。
  静默放行才是这里唯一不可接受的形态。

### 🔴 它覆盖不到哪些写入（必须先读这一段，再决定要不要依赖它）

`matcher` 是 `Write|Edit|MultiEdit`。**除此之外的写入路径一律不经过门控**，其中两条是日常会走的：

| 路径 | 是否经过门控 | 说明 |
|---|---|---|
| `Write` / `Edit` / `MultiEdit` | ✅ 拦 | 2026-09-13 真机实测：越阶段写被拒、补齐前一阶段后放行 |
| `Bash`（`cat > f`、`sed -i`、`tee`…） | ❌ **不拦** | 实测：同一个越阶段写改用 Bash heredoc，**静默落盘成功** |
| 桥接到用户本机的写（`device_bash` / `device_commit_files`） | ❌ **不拦，而且拦不了** | 见下 |

**为什么桥接那条不是「没做」而是「做不到」**：hook 跑在**会话容器**里，它的 `exists()` 只看得见
容器的文件系统。而在 Cowork + 桥接这个拓扑里，**真实的消费项目在用户本机**——
容器里根本没有那份 `.kiro/specs/`。门控即使收到了 `device_commit_files` 的 payload，
里面的 `devicePath` 也是**另一台机器**上的路径，它无法判断前一阶段的 artifact 存不存在。
把这类事件加进 matcher 只会产出「取不到就放行」的空判定，还顺带制造「已覆盖」的错觉。

🔴 **所以要把话说死：在当前部署拓扑下，被这道门控实际覆盖的写入接近于零。**
它保护的是容器内那份文件系统上的 `.kiro/specs/**`，而 spec 不在那儿。

真正对本机 spec 生效的约束是另外两条，它们不在 hook 层：

1. **MCP 侧的 `spec_write`** —— 它跑在用户本机，有 `writePolicy` / `contextProof` /
   `rawRevision` CAS / phase 检查，越阶段写会被 `PHASE_NOT_APPROVED` 拒绝。**这才是本机 spec 的主闸门。**
2. **消费项目自己的 `.githooks/pre-commit`** —— 提交时跑格式 lint 与署名检查，对所有环境生效。

门控是**第三道、也是最弱的一道**，作用范围仅限容器内的原生写。别把它当成 `.kiro/specs/**` 受保护的依据。
- 要看它到底响没响（Task 7 的 STOP 门 ② 就需要这个）：设 `CLAUDE_SPEC_GATE_LOG=<path>`，
  每次判定追加一行 JSON（事件、工具、是否带 `agent_id`、目标路径、判定、理由）。默认关闭。
- ✅ `.mcp.json` 的 `cwd` 与 `args` 均已改成 `${CLAUDE_PLUGIN_ROOT}`（不再是 `"."`），
  消掉了「解析成插件根还是项目根」这个未知数——2026-09-13 打包/Task 7 一并修的，不再是 `⟨待测⟩`。
  何况每一个 `spec_*` MCP 工具都把 `projectRoot` 列为必填参数（见上表 MCP 侧那行），
  调用方永远显式传目标项目的绝对路径，服务端的 `cwd` 落在哪已经不影响正确性——
  它只决定「调用方不传时兜底猜哪个目录」，MCP 侧的项目根解析顺序保留为
  `工具参数 projectRoot` → `CLAUDE_SPEC_PROJECT_ROOT` → `CLAUDE_PROJECT_DIR` → `process.cwd()`，
  并且启动诊断会把实际用的是哪一个报出来。

## §4.3.2 署名：只能随 `spec_write` 一起落盘

`spec_write` 有一个可选参数 `signature`（本次改了什么）。给了它，插件就用
`@my-harness/spec-analysis` 的 `renderSignature({ env: 'Claude', … })` 渲染出署名行，
并在**同一次原子写**里并进 content：

```
- 2026-09-13 · Claude · design.md：补充配额边界
```

🔴 **为什么没有单独的「补签」工具。** 因为署名本该与它所描述的改动**一起**落进同一次原子写：
这样少一类事后操作，而且环境标识（写死 `Claude`）由插件按 §4.3.2 校验，不靠调用方手写不出错。
补签的做法因此是**重新 `spec_write`（带 `signature`）**。
（2026-09-17：这里原写作「与环境标识、通道字面量」—— 那条字面量要求已随 Cowork 通道退役撤销。）

⚠️ **旧版给的理由已作废**（2026-09-14 第 8 期 `spec-sign-approval-clobber`）。旧版写的是
「批准之后再单独补一行署名，会改掉 `rawRevision` 与 `approvalFingerprint`，下一次 `observe()`
判为 `external_change_detected` 并**作废该 artifact 的审批**」—— `computeApprovalFingerprint`
升到 `semantic-v2` 后在 `tasks.md` 上把**合法**署名行与合法执行事件块一样剥掉，这句话不再是
事实（见 `packages/spec-revision/README.md` 的两个哈希语义）。仍然成立的只剩更窄的两条：

- 手工追加的一行是否算「合法署名」由 `parseSignatureLine` 判 —— **写歪了仍是一次实质改动、
  仍会作废该 artifact 的审批**；
- 豁免只覆盖 `tasks.md`；`requirements` / `design` 内的人工署名仍会改变指纹。

三条行为，都有测试钉着（`test/attribution.test.mjs`）：

- **环境标识写死 `Claude`**，不接受调用方指定 —— §4.3.2 红字：「没有属于自己的标识时，
  不要借用别人的」，让调用方自选 env 正是那条路。
- **summary 为空 / 放不进文件时就近拒绝**（`SIGNATURE_INVALID`），不等到消费项目的 pre-commit
  才发现。（2026-09-17 之前这里列的是「缺字面量 `Cowork` 就近拒绝」—— 那条要求已撤销。）
- **不传 `signature` 不阻断**，但返回 `attributionWarning`。这一档是照抄消费项目自己的选择：
  它的 `check_spec_signature` 也是 warn 级，理由是「什么算实质修改无法可靠自动判定，
  硬拦会误伤，而误伤会把人推向 `SKIP_PRECOMMIT`」。

判定的事实源始终是消费项目的 `.githooks/pre-commit`。我们这边的
`isValidSignatureLine` 是它的逐字符移植（跨语言没法共享），
由 `packages/spec-analysis/test/signature-pin.test.mjs` 直接读那份 hook 比对——**漂了就红**。

## 写策略：已授权直写正式目录

`adapter.example.json` 的 `writePolicy.mode` 是 **`authorized`**，**省略 `allowedPrefixes`** ——
含义是「`specsRoot` 本身」，即任何正式的 `.kiro/specs/<feature>/`。

依据是消费项目 §0 **现行**原文：*「已解锁的（当前 Kiro / DSH / Codex / Claude Code）直接写正式
`.kiro/specs/<feature>/`，不走 `_eval-` 目录、不受第 2、3 条约束，只需 §4.3.2 署名。」*
（2026-09-17 订正：这段引文里原本写的是 `Claude Cowork`。消费项目同日把那条通道**退役**、
改登记为本地 `Claude Code` —— 引文照着对面改，**不要**在我们要保持同步的地方沿用旧通道名。）

- 这**不是**「放行一切」：写入仍被限制在 `specsRoot` 之内，`PATH_OUTSIDE_PROJECT` 与
  `SYMLINK_ESCAPE` 一条都没少。少的只是「正式目录还要不要先在配置里登记」。
- `authorityFile` / `authorityHash` 仍然保留，但在 `authorized` 下是**台账不是闸门**：
  语义是「上次核对过的版本」，不参与放行判定；漂移与否由 `spec_health` 的 `authority.status`
  回报（`matches` / `drifted` / `unreadable` / `unrecorded`）。把 hash 当闸门会让插件在某次
  Kiro 改个错别字之后、在与写规格毫无关系的时间点上突然罢工。
- `evaluation-only` 仍然是给未解锁宿主用的**闸门**（前缀必须是 `_eval-codex-YYYYMMDD/`，
  且 hash 必须对上）。本期改的是已解锁宿主的通道，不是所有人的通道。

### 项目档案路径：`.codex/codex-spec.json`

服务要求目标项目存在 `.codex/codex-spec.json`。这个路径是**跨宿主共享的项目档案**，不是本插件的身份：

- `plugins/dsh-spec/lib/index.js` 与 `plugins/codex-spec/lib/mcp/adapter.mjs` 声明的 `CODEX_SPEC_CONFIG`
  是**同一个**路径字符串 —— 一个 **DSH** 宿主插件同样读它，注释原文是
  「the same adapter config the Codex CLI side uses」；
- 消费项目里已经部署了一份真的（`mode: "authorized"`、`allowedPrefixes: ["specs/"]`、
  `specsRoot: ".kiro"`），而且消费项目 **没有** `.claude/` 目录。

2026-09-17 的改名把文件名里的 `kiro` 换成 `codex`（跟随既有的 `<宿主>-spec` 命名约定）：路径**位置**
与「跨宿主共享」这条判断都没变，但后果要写出来 —— `claude-spec` 会去读一个**以 codex 命名**的文件。
这是本期选「跟随既有约定、改动面最小」换来的代价，不是缺陷；取舍与被拒的备选名
（中立名 `.codex/spec-adapter.json`）记在 `.kiro/specs/codex-spec-rename/design.md` 决策点 3。

🔴 **旧名由兼容读继续接住**（Req 3.2）：新路径不存在而旧路径存在时读旧路径，并在健康回报里报
`adapterSource: legacy`；两者都在则以新路径为准、把冲突报出来而不是静默取其一。所以已部署的项目
不会因为这次改名变成 `ADAPTER_MISSING`（报错文案与 `details.adapterPath` 指向的都是**新**路径 ——
那是用户真正该放文件的地方）。

旧路径的**字面量只住在三份 adapter 里**（各导出一个 `LEGACY_CODEX_SPEC_CONFIG`），本节刻意不重写它：
替换面里出现旧名会被 Req 8 的棘轮判红，而「旧名字面量只住在三个 adapter 里」正是那五族具名豁免中
族 5 的形状。`test/skeleton.test.mjs` 有一条断言把三处的默认值逐字钉在一起。

## `.claude/rules/` 与 contextProof 缺口

`scripts/gen-rules.mjs` 从 `packages/kiro-rules/lib/kiro-rules.js`（**单一事实源**）派生出 5 份
`.claude/rules/*.md`：`spec-core.md`（无 `paths:`，常驻）与 requirements / design / tasks / bugfix
各一份（带 `paths: [".kiro/specs/**/<artifact>.md"]`）。四个 artifact 文件的规则码**并集恰为 41、
两两交集为空** —— 这条判据由 `test/rules-generator.test.mjs` 在**产物**上验证，
而不是只断「总数 41」（按变体遍历时求和恰好也是 41，而并集只有 35）。

🔴 **`paths:` 只替掉 Kiro fileMatch router 的一半。** 具体说：

| Kiro 侧 | `.claude/rules/` 侧 | 结论 |
|---|---|---|
| 按路径**路由**规则（加载哪些） | `paths:` frontmatter —— 精确对应物 | ✅ 有对等物 |
| `ruleLoadedToken`（**证明**规则真的进了上下文） | **无对等物**：`InstructionsLoaded` 的 `path_glob_match` 只能写日志，不能给 MCP 递 token | ❌ 没有 |

所以「规则按路径加载了」这件事在本插件里是一条 **collaborative 约束，不是可验证约束**。
不要引用任何 `paths:` 配置去论证「这条规则一定在模型的上下文里」。

### 派生产物的保鲜：两层都已落地（2026-09-13 收口）

产物落在另一个仓库，真源一改产物就旧 —— 计划 R6-6 记的就是这个结构性风险。两层检查现在都在：

| | 落点 | 谁会看到 | 状态 |
|---|---|---|---|
| ① | kiro-spec 的 `test/rules-generator.test.mjs` | 跑 kiro-spec 测试的人 | ✅ |
| ② | 消费项目的 `.githooks/pre-commit` → `check_claude_rules_freshness` | **所有在消费项目提交的人** | ✅ Kiro 于 2026-09-13 落地 |

②比原请求更强的两点：

- **它读 index 而不是工作区**（`git show :<file>`）。所以「工作区已重生成但忘了 `git add`」
  这种假绿也拦得住 —— 这正好顺带覆盖了原本打算另加的 `git ls-files` 断言：
  index 里没有产物时生成器报 ENOENT、退出码 1，照样拦。
- **它是 error 级、会中止提交**，不是 warn。

三个方向都实测过（生成器 `--check` 的退出码）：index 无产物 → 1（拦）；与真源一致 → 0（放行）；
手改派生产物 → 1（拦）。并且真的拦过一次提交：`HEAD` 未动，输出里给了重跑命令。

⚠️ **一处环境差异，别把 skip 读成 pass。** ②的默认路径是 `~/Documents/kiro-spec`,
在用户本机成立；但在 Cowork 的桌面 VM 里连接文件夹挂在 `$HOME/mnt/...`,默认路径不存在，
于是它会**大声跳过并明说「不算通过」**。在那种环境下要真的跑，得给
`MY_HARNESS_ROOT=$HOME/mnt/kiro-spec`。

⚠️ **改了真源就要把产物一起暂存。** ②是 error 级，只改 `packages/kiro-rules` 而不重跑生成器，
下一次消费项目提交会被直接拦下。

## 三条实测边界（不许美化）

1. **模型能改自己的 hook 脚本。** 第 5 期实测 `privateStateIntegrity = FAIL`：用一次普通 Bash 调用
   改写了已安装插件的 `scripts/record.sh`，改动在**下一个 hook 事件即生效、无需重装**。
   所以「让 hook 背书」与「让 hook 背假书」是同一个能力。
2. **署名是自述的，四个环境一视同仁。** 没有任何机制能证明那一行是哪个底座写的。
   判据的事实源是消费项目的 `.githooks/pre-commit`，不是本插件，也不构成「作者身份」的证明。
   （2026-09-17 之前它额外要求 summary 含字面量 `Cowork`；那条要求已随 Cowork 通道退役撤销 ——
   而它之所以被撤销，恰恰因为**插件的强制注入让它不再是一种自述**。）
3. **hook 背书的是会话容器当时的状态** —— 不是用户本机（本机是 darwin/arm64，容器是 Linux），
   更不是「实际应答的模型」。读门控或日志的结论时不要把这三者混起来。

## 【不做】

**「机器背书署名」不做。** 不是「暂缓」，是不做：它的全部依据是「模型改不了 hook」，
而第 5 期实测证否了（`privateStateIntegrity` = FAIL）。在模型能改自己 hook 脚本的宿主上做机器背书，
只是把一个可伪造的字段包装得更像真的 —— 比不做更坏，因为它会诱使下游把它当证据。

**不宣称 `Level 2` / `hard-security`；不宣称署名或门控「不可伪造」。** 本插件没有任何一项
可强制执行的安全边界，加了 `PreToolUse` 也不改变这一点（`fileGuardrail` 在启动诊断里**仍然是
`false`**）。

**重新评估的入口**（不是「再想想」）：

- 宿主出现一个**模型改不动的私有状态位置**（例如受管插件、只读的 org-plugins）→
  可重测 `privateStateIntegrity`，通过后才谈机器背书；
- Cowork 出现等价于 `sandbox.filesystem.denyWrite` 的**配置面** → 可重测写侧完整性。
  ⚠️ 现状是：Cowork **不读** `~/.claude/settings.json`，而 0.6 版的沙箱配置写在那个文件里，
  也就是说该配置面在此宿主上**不存在**，不是「没开」。

## 当前能力与边界

MCP 提供 `spec_health/list/template/validate_artifacts/init/adopt/read/context/write/amend/status/diagnostics/analyze/quality_preview/sync_preview/sync_apply/record_analysis/request_approval/record_approval`，以及 `spec_task_set` 手动三态更新与 `spec_task_plan/begin/record_check/complete/fail/reset_failures` 串行执行工具。

**审批握手**（2026-09-17 与用户约定，写在 `SKILL.md`）：agent 写完一份文档后**不发起**审批，只在回复末尾请用户
review、可直接改文件、改完发送批准短语；收到短语后 agent 先全量读取、核对相对自己版本的改动（有解释不了的改动就停下问），
再依次 `spec_request_approval` → `spec_record_approval`，并告诉用户批准的是哪一版。插件只核对原话、状态版本号与
「请求到记录之间内容未变」，**分辨不出**短语是在请求之前还是之后说的 —— 版本对应靠 agent 的核对与报告。
行为依据钉在 `test/approval-handshake.test.mjs`，短语清单与插件一致性钉在 `scripts/approval-handshake-skill.test.mjs`。

**省 token 的三条通道**（本分支新增；只省**确定重复**的正文，不放宽任何判据）：

- `spec_amend` —— 已批准 Spec 的增量修正（`param` / `requirement` / `design` 三种 kind），正文在服务端就地变换，
  不必重发整份文档。仍要求有效的 `spec_context` proof 与 CAS；拒改任务体、拒绝 `_archive/`；
  **写完必定作废**被改 artifact 及其下游的审批（phase 随之退回 review），与 DSH 侧同一语义。
- `spec_read` 的 `outline` / `section` —— 部分读，回包带 `partial: true`。**不要**拿它的 `rawRevision` 去整份
  `spec_write`：CAS 会通过，没读到的小节会被静默覆盖。同名 `## ` 小节出现多次时 `section` 拒绝并报歧义。
- `spec_context` 的 `knownRevisions` —— 字节未变的规则文件只回执不回正文；proof 仍覆盖全部文件。

**spec 格式诊断（对标 Kiro `getDiagnostics` 的 spec 分支）**：`spec_diagnostics` 直接读盘上该 spec 的全部 artifact
与 `.config.kiro`，返回 `findings`（规则与 Kiro 同源）、`specType`、`missingArtifacts`，只读、不刷新基线。
`spec_validate_artifacts` 只用于**尚未落盘**的草稿：它要调用方传整份正文，也看不到 `.config.kiro`
（`workflow` 只决定哪些 artifact 合法，类型按「未写」处理：design 按内容嗅探，tasks 要求依赖图）。
spec 类型只认 `.config.kiro` 写明的 `feature` / `bugfix`；`quick-spec` 按「未写」处理 —— 与 Kiro 的
`get_diagnostics` 和「问题」面板一致（Kiro 的 `validate_spec_format` 在这点上与它们不一致）。
**代码**的编译/lint/类型诊断（`getDiagnostics` 的另一半）不在本插件里：连着 IDE 时用 IDE 的诊断工具，否则跑项目自己的检查。

支持 requirements-first、design-first、bugfix 与 quick：design-first 先确认设计，bugfix 使用独立 `bugfix.md`，quick 必须写齐三份 artifact 后以 `批准全部 artifacts` 作一次整体确认。`spec_analyze`、`spec_quality_preview` 与 `spec_sync_preview` 都只读比较 requirements/design/tasks；`spec_sync_apply` 只应用无歧义的设计追踪追加，并要求三份源 revision、design context proof 和明确确认。

每个工具都必须传入当前项目的规范化绝对 `projectRoot`；写入还要求与该项目的 `writePolicy` 相符、拥有未过期的 `spec_context` proof，并提交匹配的 `rawRevision`。确认、工作区快照与执行检查记录始终显示 `assurance=collaborative`。

`spec_list` 会发现没有私有状态的存量 Spec 并以 `lifecycle=external` 返回；执行前必须显式 `spec_adopt`。执行顺序是 plan → begin → record_check → complete/fail；跨进程锁、owner token、30 分钟 lease、state epoch、task raw revision 与 intent journal 共同拒绝重复执行与半提交状态。第三次失败会持续返回 `HUMAN_REVIEW_REQUIRED`，直到人工用精确短语调用 `spec_task_reset_failures`。`tasks.meta.json` 始终只读。

`spec_task_plan/begin/complete` 接收由宿主采集的结构化 `workspaceSnapshot`（路径集须排除 `.kiro/specs/**` 与 `.kiro-spec-private/**`），服务端负责 canonicalize 并重算 revision，但不自行运行 Git。纯检查叶子任务必须显式标记 `_Type:_ verification`。

启动诊断以单行 JSON 写入 stderr，字段包括 `version`、`cwd`、`configuredProjectRoot` 与其
`configuredProjectRootSource`（命中的环境变量名，都没命中就是 `process.cwd()`）、`tools`、
`hooks`、`trustTier: "collaborative"` 与 `fileGuardrail: false`。该日志不包含 Spec 内容或 token。
`spec_health` 会回显规范化后的 `projectRoot`、`writeMode`、`allowedPrefixes` 与 `authority`。

`.kiro-spec-private/` 保存可重建的 workflow cache 与协作确认摘要；context proof 仅保存在当前进程的
**内存**中，进程退出或五分钟有效期结束后必须重新调用 `spec_context`。Markdown 仍是共享真源。
🔴 `.kiro-spec-private/` 与 `tasks.md` 里 `<!-- kiro-spec:execution-events:v1:start -->` 这对标记
**都是已落盘的既有状态**，名字里的 `kiro-spec` 是有意保留的：改名会孤立已在消费项目里的
workflow state，并让解析器**静默**看不见既成的事件块。不要「顺手清理」它们。

当前 stdio transport 在 `mcp-server.mjs` 中**全局串行**处理请求，因此 MCP 调用不会并发进入 service。
直接导入 `createMcpService` 后并发调用不属于本版本保证的契约。

## 本地验证

```bash
cd plugins/claude-spec
npm run doctor          # = npm run check && npm test
```

`npm run check` 遍历插件里每个 `.mjs` / `.sh` 过语法、每份受约束的 JSON 过 `JSON.parse` ——
它是遍历而不是手写清单，新增文件自动进入覆盖面。

安装、启用、禁用、卸载、配置合并/回滚与离线验证见 [INSTALL.md](INSTALL.md)。
