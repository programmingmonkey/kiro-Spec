> 🌐 [English](../../../plugins/claude-spec/INSTALL.md) · **中文**

# 安装与运维

> ⚠️ **本文件里有若干 `⟨待测⟩` 槽位，它们是刻意留白的。** 计划 Task 7（安装与冒烟）标了
> 🔴 **必须在真实宿主里测**：安装面的真实行为只能在那个宿主里测，不许按 Codex 侧或本机的情况推断。
> ⚠️ **2026-09-17 订正**：本节原文写的是「**必须 Claude Cowork**」。消费项目同日**退役了 Cowork 通道**
> （改走本地 Claude Code CLI，它才是现在的日常路径），本插件也已把默认拓扑定成 `local`。下面那些
> 按 Cowork 拓扑写的段落**保留**（显式切过去时仍然适用，且它们记的是当时实测到的事实），
> **但别再把它读成「唯一合规宿主」**。
> 凡是没测过的，这里写 `⟨待测⟩` 并说清怎么测，不编一个看起来像真的命令。

## 单一路径安装

插件源目录在仓库的 `plugins/claude-spec/`。Cowork 侧走 **Customize → 添加插件**，指向该目录
（或上传打包后的压缩文件）：

**没有 CLI —— 走界面上传归档**【实测 2026-09-13/14】：Customize → 添加插件 → 上传
`node scripts/pack-plugin.mjs claude-spec` 产出的 `.plugin`。marketplace 在**服务端**
（本机装出来的名字是 `My Uploads`），本机磁盘上**没有** marketplace.json，只有一份安装台账：

```
~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<session>/rpm/
  manifest.json          # {id: plugin_<id>, name: claude-spec, marketplaceId, marketplaceName, updatedAt}
  plugin_<id>/           # 归档解包后的普通目录树（每次安装生成**新** id，旧目录不改写）
```

⚠️ **同一台机器上每个账号各有一份安装**。排查「重装了为什么没生效」时**先问是哪个账号** ——
2026-09-14 实测本机两个账号各装着一份，版本不同。

- 本仓库不提交 marketplace 注册表，避免安装步骤去改用户级配置。部署方应让 marketplace entry
  的 `source.path` 指向 `./plugins/claude-spec`。
- ⚠️ **可执行脚本目录必须叫 `scripts/`，不能有顶层 `bin/`**（2026-09-13 实测）：claude.ai 托管的
  插件不允许顶层 `bin/` —— 它会被加进 PATH 但审批界面不显示，表现是「本地看着好好的、上传就装不上」。
  `test/skeleton.test.mjs` 有一条断言钉住这一点。
- 清单文件是 `.claude-plugin/plugin.json`。它显式写了 `skills` / `hooks` / `mcpServers` 三个字段，
  **同时** hooks 也放在约定路径 `hooks/hooks.json`。
  【实测 2026-09-13/14】`skills` 与 `mcpServers` **被认可**：装上后会话里出现
  `claude-spec:claude-spec` skill 与 25 个 `spec_*` MCP 工具，且调用成功。
  `hooks` 字段的认可状态**现在是开着的问题** —— 见下方「阶段门控」小节的 🔴。

## 启用、禁用与卸载

- **查看安装状态**：上面那份 `rpm/manifest.json` 就是本机唯一的台账（含 `updatedAt`）。
  界面侧走 Customize 的插件列表。
- **卸载 / 移除 marketplace 注册**：`⟨待测⟩` —— 本次只观察到「重装会生成**新的** `plugin_<id>`
  目录、旧目录原样留着」，**不足以证明卸载是重装的前置步骤**，所以不写成命令。
- 🔴 **重装后必须完全退出并重启桌面应用**【实测 2026-09-14】：MCP server 是桌面应用的子进程，
  在应用启动时拉起，Node 启动时装载模块 —— **运行中的 server 只认它启动那一刻磁盘上的那份**。
  只新开一个会话不够。实测时间线：23:59:22 装新版 → 00:08:48 重启应用 → 00:08:56 新 server 起来。

Cowork 当前通过安装状态管理启用/禁用；没有单独 disable 命令时，**卸载是确定的禁用与回滚路径**。
重新添加相同 marketplace 并安装即可恢复。

回滚步骤：卸载插件 → 移除仅为它新增的 marketplace → 重启 Cowork 会话。卸载**不会**删除项目里的
`.kiro/specs/` 或 `.kiro-spec-private/`；确认不再需要恢复 workflow state 后可以手工删除后者。
共享的 Spec Markdown 不属于安装残留，不应随卸载自动删除。

## 配置合并与回滚

安装过程**不改写**项目的任何既有配置。运行时会：

- 在 `.kiro/specs/` 下按 `writePolicy` 允许的范围创建/更新 Markdown；
- 在项目根创建 `.kiro-spec-private/` 保存可重建状态与协作确认摘要 —— 项目应把它加入 `.gitignore`。

Cowork 把插件内 `.mcp.json` 注册为一个名为 `claude-spec` 的本地 stdio server。若已有同名用户级 MCP
配置，先移除或改名再安装。

## 项目 adapter

服务要求目标项目存在 **`.codex/codex-spec.json`**。从插件目录复制 `adapter.example.json`，
把项目真实值填进去：

```bash
mkdir -p .codex
cp /absolute/path/to/claude-spec/adapter.example.json .codex/codex-spec.json
```

🔴 **路径就叫 `.codex/codex-spec.json`，不要改成 `.claude/...`。** 它是**跨宿主共享的项目档案**：
`plugins/dsh-spec/lib/index.js` 与 `plugins/codex-spec/lib/mcp/adapter.mjs` 里同样读这个路径
（注释原文「the same adapter config the Codex CLI side uses」），消费项目里也已部署了一份真的。
改名会让同一个项目出现两份内容相同的档案。名字里的 `codex` 是 2026-09-17 跟随既有 `<宿主>-spec`
约定的结果 —— `claude-spec` 因此会去读一个以 codex 命名的文件，这是已知代价。

🔴 **改名前的旧路径由兼容读继续接住**（Req 3.2）：新路径不存在而旧路径存在时读旧路径，并在健康
回报里报 `adapterSource: legacy`；两者都在则以新路径为准并报冲突。所以已经部署过的项目不会因为
这次改名变成 `ADAPTER_MISSING`。旧路径的字面量只住在三份 adapter 的 `LEGACY_CODEX_SPEC_CONFIG`
里，本文档刻意不重写它（替换面里出现旧名会被 Req 8 的棘轮判红）。
详见 [README.md](README.md) 的同名小节。

`adapter.example.json` 的形状是**已授权直写**：

```json
{
  "schemaVersion": 1,
  "specsRoot": ".kiro/specs",
  "writePolicy": { "mode": "authorized", "authorityFile": ".kiro/steering/spec-conventions.md", "authorityHash": "sha256:..." },
  "rules": [ { "match": [".kiro/specs/**/*.md"], "contextFiles": [".kiro/steering/spec-conventions.md"] } ],
  "validators": [ { "id": "spec-tasks-lint", "profile": "kiro-spec/spec-tasks-lint-v1" } ]
}
```

- **省略 `allowedPrefixes`** 的含义是「`specsRoot` 本身」，即任何正式的 `.kiro/specs/<feature>/`。
  要逐目录登记时写 `"allowedPrefixes": ["<feature>/"]`，那就仍然是一张 allowlist。
- `authorityHash` 的语义是**「上次核对过的版本」**，不参与放行判定。它可以在目标项目根这样算：

  ```bash
  node --input-type=module -e "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs'; const raw = readFileSync('.kiro/steering/spec-conventions.md'); console.log('sha256:' + createHash('sha256').update(raw).digest('hex'));"
  ```

  对不上**不会**拒绝写入（`authorized` 下它是台账）—— 漂移与否在 `spec_health` 的 `authority.status`
  里看（`matches` / `drifted` / `unreadable` / `unrecorded`）。
  ⚠️ 想恢复到「hash 对不上就拒绝」的旧语义，那是 `evaluation-only` 模式的行为，而它只适用于
  **未解锁**宿主；已解锁宿主走 `authorized` 是消费项目 §0 现行原文定的。
- 错误码：缺 adapter → `ADAPTER_MISSING`；JSON / 路径 / policy 无效 → `ADAPTER_INVALID`；
  **`evaluation-only` 模式下** authority hash 不匹配 → `ADAPTER_UNTRUSTED`。

## 项目根与宿主 smoke

插件 MCP 以 `.mcp.json` 中的 `cwd: "${CLAUDE_PLUGIN_ROOT}"` 启动
（⚠️ 本文件旧版写的是 `cwd: "."`，与实际文件不符，2026-09-14 订正）。每次调用都必须把目标项目的规范化绝对路径作为
`projectRoot` 传入；没有传时，服务按 `CLAUDE_SPEC_PROJECT_ROOT` → `CLAUDE_PROJECT_DIR` →
`process.cwd()` 依次回退。首次安装或 Cowork 升级后必须做宿主 smoke：

1. 在目标项目启动新的 Cowork 会话。
2. 以目标项目绝对路径调用 `spec_health({ projectRoot })`，确认回显一致。
3. 检查 stderr 启动诊断里的 `cwd`、`configuredProjectRoot` 与 `configuredProjectRootSource`。
4. 未确认项目根之前，不调用 `spec_init`、`spec_adopt` 或 `spec_write`。
5. 旧客户端无法传 `projectRoot` 时，才以绝对路径设置 `CLAUDE_SPEC_PROJECT_ROOT` 后重启会话。

✅ **已实测（2026-09-14），这个槽位可以关掉。** `.mcp.json` 用的就是 `${CLAUDE_PLUGIN_ROOT}`，
它解析到 `…/rpm/plugin_<id>/`，即**插件根**，不是项目根。
所以「`.` 落在哪」这个问题在当前配置下**不成立** —— 当初担心的坑（`.` 落插件根 →
`process.cwd()` 当项目根 → 每次调用都静默对着错误目录干活）已经被这份配置绕开了。
🔴 **但结论仍然是「必须显式传 `projectRoot`」**：`process.cwd()` 现在铁定是插件目录，
回退到它一定是错的。上面第 3 步的可观测点保留。

🔴 **MCP 与 hook 是两条执行路径，不要合成一条结论**【实测 2026-09-14】：

| 层 | 跑在哪 | 证据 |
|---|---|---|
| **MCP server** | **用户本机** | `ps` 实测 pid 12306 = `/usr/local/bin/node …/rpm/plugin_<id>/mcp-server.mjs`；工具名带 `mcp__remote-devices__` 前缀（经桥接）。本机 Node `v24.20.0`，在 `engines` 区间内 |
| **PreToolUse hook** | **会话容器** | 插件在容器里有同步副本 `/root/.claude/plugins/synced/<orgUuid>_<accountUuid>/claude-spec~g2/`；门控要 `existsSync` 同目录的前一阶段文件，被写的 `.kiro/specs/**` 也在容器里 |

⚠️ **旧版本文把两者合成「MCP 跑在会话容器」再整体推翻成「跑在本机」，两次都不准。**
另：「`spec_health` 读到本机项目」**不是**判别执行位置的判别式 —— 容器把本机仓库挂在
`mnt/` 下，容器里读到本机文件说明不了执行位置。真正的判别式是 `ps`。

所以「会话容器的 node 版本」这个槽位**问的是 hook 侧**，而 hook 确实在容器里 ——
容器有 node：**`v22.22.2`（`/opt/node22/bin/node`）【实测 2026-09-14】**，在 `engines: ">=20 <26"` 区间内。

## 阶段门控的安装与验证

`hooks/hooks.json` 挂一个 `PreToolUse`（`matcher: "Write|Edit|MultiEdit"`），命令是
`${CLAUDE_PLUGIN_ROOT}/scripts/spec-stage-gate.sh` —— 这一层 sh 只做一件事：容器里找不到 `node`
时**放行并出声**，而不是以一个含义不明的 hook 失败告终。

### 阶段门控存活探针（装完 / 升级后**必跑**）

⚠️ **本节走的是 Cowork 拓扑的路**（`CLAUDE_SPEC_TOPOLOGY=cowork`）：hook 在会话容器、MCP 在用户
本机，两条路径未必共享文件系统，所以要专门读**容器内**的审计日志才能判定死活。**默认的本地 Claude
Code CLI 拓扑（`CLAUDE_SPEC_TOPOLOGY` 省略或 `local`）不需要走这一节**——hook 与 MCP 同机同文件系统，
直接调 `spec_health` 看 `gate.status` 就够了：`"observed"` 是活证据，`"unobserved"` 更值得怀疑（先查
`hooks.json` 有没有被这次安装认领），不必读容器审计日志。`spec_health` 的返回值里带一个 `gate.topology`
字段，可以确认这次判定用的是哪一种拓扑。见 README「运行拓扑：本地 / Cowork」一节。

🔴 **审计日志 2026-09-14 起默认开**，不用设任何东西。默认落点**优先能被人读到的地方**：

| 条件 | 落点 | `logSource` |
|---|---|---|
| 环境里有项目根（`CLAUDE_PROJECT_DIR` / `CLAUDE_SPEC_PROJECT_ROOT`） | `<项目根>/.claude/claude-spec-gate.log` | `project` |
| 没有 | `os.tmpdir()/claude-spec-gate.log` | `tmpdir` |

```bash
CLAUDE_SPEC_GATE_LOG=/path/to/log   # 换地方（绝对路径；相对路径一律落 tmpdir，不落 cwd）
CLAUDE_SPEC_GATE_LOG=off            # 关掉审计日志（**心跳不受这个开关影响**）
```

**为什么改成默认开**：这次事故里，判断「宿主到底调没调这个脚本」**只有这份日志能回答**，
而它当时是 opt-in —— 要打开就得改**宿主启动 hook 时的环境变量**，
那个位置在 Cowork 里没有任何一方够得到，排查因此彻底卡死。
**一个只有在你已经能观测时才打得开的观测器，等于没有。**

每次调用往该文件追加**两行**，每行自带 `logPath` / `logSource`（读的人不必猜它在容器还是项目目录）：

| 行 | 何时写 | 回答什么 |
|---|---|---|
| `phase: "entry"` | 进程启动，**先于任何解析** | 这个进程被宿主**拉起过**吗 |
| `phase: "decision"` | 走完判定 | 判成了什么、为什么、`tool_name` / `target` / `agent_id` |

**allow 与 deny 两支都记** —— 只记 deny 的话，「宿主没调用」和「调用了但走了放行分支」长得一模一样。
有 1 MiB 上限，超了**停写**（回答「调没调」靠的是最早那几行，不是最新的）。

#### 怎么读（**在 Cowork 会话里用 Bash 工具跑，不要去 Mac 上找文件**）

hook 跑在会话容器里，而** Bash 工具和 hook 在同一个容器** —— 所以日志的读法就是一条会话内命令：

```bash
# 1) 先看现状
cat "${CLAUDE_PROJECT_DIR:-.}/.claude/claude-spec-gate.log" 2>/dev/null || cat /tmp/claude-spec-gate.log
# 2) 在 .kiro/specs/<feature>/ 里越阶段写一次 design.md（同目录无 requirements.md）
# 3) 再 cat 一次，看多出来的行
```

**先做过一次普通写（会走 allow）再解释「没有 deny 行」** —— 否则你分不清「日志读不到」和「门没被调用」。

#### 判据表（四种互斥结果）

| 日志 | 含义 |
|---|---|
| 有 `entry` · 末行 `decision: "deny"` | 宿主调了、门判对了 → 问题在**宿主没执行这个拒绝** |
| 有 `entry` · 末行 `decision: "allow"` | 宿主调了、走了放行分支 → `reason` 直接写明是**哪一支** |
| 有 `entry` · **没有判定行** | 宿主调了、进程没走到判定（畸形 payload / stdin 不 EOF）→ 看 `problem` 字段 |
| **一行都没有** | 宿主**根本没拉起这个进程** |

🔴 **这张表的前提**：「一行都没有」只有在**这个探针读的路径与门控写的是同一个文件系统**时才成立。
这条是待测前提，不是既成事实 —— 所以先做上面第 1 步、确认探针**读得到**已经有内容的那份日志，
再拿「没有 deny 行」去下结论。**观测器的故障不许被读成现象。**

#### 更省事的一条：`spec_health` 的 `gate` 字段

每次调用还会覆盖写一个心跳（`<项目根>/.claude/claude-spec-gate.heartbeat`），
`spec_health` 把它读出来。**先看 `status`，只有 `"observed"` 是活证据：**

| `status` | 含义 | 能不能下结论 |
|---|---|---|
| `"observed"` | 读到了合法心跳 | ✅ **能** —— 门至少被调用过一次，`lastSeen` / `ageMs` / `decision` 就是它的证据 |
| `"unobserved"` | 路径在，但那里没有合法心跳（不存在 / 空 / 半截 JSON / `ts` 非法） | ❌ **不能** —— 它是**中性**的，必须连着读 `caveat` |
| `"unavailable"` | 连心跳路径都解析不出来（没有 `projectRoot`） | ❌ 不能 |

```json
{"gate":{"status":"observed","heartbeatPath":"…","lastSeen":"2026-09-14T01:01:19.000Z",
         "ageMs":4200,"decision":"deny","event":"PreToolUse","reason":"越阶段写：…"}}
{"gate":{"status":"unobserved","heartbeatPath":"…","lastSeen":null,"ageMs":null,
         "decision":null,"event":null,"reason":null,
         "caveat":"本机读不到这台 hook 的心跳，不构成「门没被调用」的判据：…"}}
```

`status: "unobserved"` 与「没被调用」**不是一回事**：它说的是「**我没看见**」，不是「它没发生」。
`caveat` 就是为这句话而存在的 —— 只写在文档里等人去读，等于没写。

它刻意**不**给 `alive: true/false`，也不给任何时间阈值：门控的调用频率由写作节奏决定，
任何「N 分钟没心跳就算死」都会在正常使用中误报。**`status` 描述的是「这条读通不通」，不是门活不活。**

🔴🔴 **但在 Cowork 拓扑下这条读恒为 `unobserved`。别拿它当死活判据。**【读码 2026-09-14】

心跳落点是 `<projectDir>/.claude/…`，而两侧的 `projectDir` **不可能是同一个目录**：

| | 谁给的 `projectDir` | 落在哪 |
|---|---|---|
| **写心跳**（hook） | payload 的 `cwd` —— 会话容器里的路径（如 `/home/claude`） | **容器**文件系统 |
| **读心跳**（`spec_health`） | 调用方传的 `projectRoot` —— 用户本机路径（如 `/Users/…/kiro-spec`） | **Mac** 文件系统 |

这正是本插件那条「hook 在容器、MCP 在本机」的两路径结论本身 ——
**心跳想跨的那道缝，恰恰就是它被造出来要解释的那道缝。**

⚠️ 所以 `status` 非 `"observed"` **不等于**「从没被调用过」：门活着它也是 `unobserved`。
把它读成「门死了」会得到一个**假的死亡信号** —— 比没有信号更糟。
从 MCP 这一侧**没有办法**判定「读不到」是「没被调用」还是「两条路径不共享」——
所以代码不去假装解决了它，只把这件事写成 `status` + `caveat`。

**它在什么场景下有效**：hook 与 MCP **同机同文件系统**时（例如本地 Claude Code CLI，
而不是 Cowork 的容器 + 桥接拓扑）。在 Cowork 里，死活只能靠下面那个探针读**容器内**的审计日志。

✅ **2026-09-14 02:54：门控已恢复，STOP 门 ② 关闭。**

原因是下面这张排查表里被我**一度排除掉**的那一行 —— `spec-stage-gate.sh` 没有可执行位。
排除它的理由是「所有归档都一样，是常量不是变量」，**那个推理是错的**：
常量只能排除它作为**变化的那个量**，排除不了它作为**一直就错、而现在才致命的前提**。

修法：git `100755` + `pack-plugin.mjs` 写成 `0755` + 一条从产物 `hooks.json` 反查
`type:command` 路径模式位的用例。真机三段全通（`entry` → `allow` → `deny` 且真被拒）。

⚠️ **「为什么 09-13 那次会响」仍开着**：那次那个归档里同一个文件也是 `0644`。
两种假设（宿主改了拉起方式 / 那条记录有误）无法判定，不选。见事故记录 §9.12。

以下是停摆期间的排查记录，保留备查：

🔴 ~~**2026-09-14 现状：门控当前不响，STOP 门 ② 重新打开。**~~
在换账号 + 重装 `086066f` 之后，用与第 6 期实测**完全相同的形状**复现两次
（会话容器里 `.kiro/specs/<feature>/design.md`、同目录无 `requirements.md`）——
**写入成功，没有任何拒绝**。已排除的：

| 查过的 | 结果 |
|---|---|
| matcher 写法 | `"Write|Edit|MultiEdit"`，对 |
| `hooks/hooks.json` 位置 | 在约定路径，对 |
| manifest 的 `hooks` 字段 | `"./hooks/hooks.json"`，在 |
| **门控脚本本身** | **没坏** —— 直接喂 payload：越阶段写 → `permissionDecision: "deny"` + `exit=2`；域外写 → 静默 `exit=0` |
| `.sh` 的可执行位 | 🔴 **本行结论已订正 —— 它就是根因（见上）**：产物里是 `0644`，且**自 `d011932`（插件第一笔提交）起一直是**，所有归档都一样。旧理由「所有归档都一样 ⇒ 是常量不是变量」**不成立**：常量只能排除它作为**变化的那个量**，排除不了它作为**一直就错、而现在才致命的前提**。留档不删 —— 下一个人最容易重走的就是这条推理 |

**这三处都查过，都没问题；脚本本身喂 payload 也会 deny。但「所以是宿主没有调用它」这一步
在 2026-09-14 那天证据不足**，口径已按 2026-09-14 的复盘收窄（细节见下面「A/B 的因变量」）：

- 当天的因变量是「**Write 没被拒**」，它是四个因子的乘积：宿主有没有调 × 门是否适用 ×
  门判没判 deny × 宿主执不执行 deny。实验只钉死了「配置字节没变」这一个因子。
- 两个被测 build（`086066f` / `78b16cf`）的审计日志**都还是 opt-in**（默认开是 `cae84cd`，
  只进了 HEAD），所以整个 A/B 里「宿主调没调」**零直接证据**。
- 门自己还有**六条静默放行分支**（tool 不在 `GATED_TOOLS`、取不到目标路径、目标不在
  `.kiro/specs/**`……），命中任一条都 `exit 0` 且不写 stderr —— 与「没被调用」逐字同症状。

✅ **A/B 对照已做**（2026-09-14）：在**旧账号**（`31deeb1f`）的会话里跑同一探针 —— 装的
就是 2026-09-13 实测**会拒**的那一版 `78b16cf` **本体，未重装**（`spec_health` 无 `stateLayer`，
已确认确实是旧 build）—— 结果 **Write 同样没有被拒**。**它证伪的是「换了账号」这个变量，
不是「我们的配置错了」这个可能性。**

**宿主版本这一侧我查过，在窗口里是平的**：`claude-code-vm` SDK 全程 `2.1.266`
（最后一次切换 09-13 12:45，比那次成功早 8 小时）、VM bundle 全程 `2a762adf`（09-12 起）。
所以「宿主侧发生了变更」目前**没有任何指纹**——可能是没留痕的服务端改动，但也可能不是宿主。

**准确措辞**：宿主**停止调用**插件贡献的 `PreToolUse`，目前是一个**尚未被证据支持的假设**，
不是结论。能给它定论的只有上面那条探针（同会话 `cat`）。

⚠️ 原先写的「最可能的剩余变量是换了账号」**已被此实验证伪**，保留这句备查。

⚠️ **在这条恢复之前，本插件的阶段门控这一层不能算可用** —— README 的 collaborative 档位措辞
本来就没承诺硬护栏，但「约定 + 一个会响的提醒」和「约定 + 一个不响的提醒」不是一回事。

---

🔴 **若装好后探针一行都不出现**，按 STOP 门 ② 的**修正口径**处理：

- 宿主支持 `PreToolUse` 仍是**已实测事实**（第 5 期探针 13/33，且覆盖子代理）。
  **不要把结论写成「Cowork 不支持 hook」**，也不要降级成「靠 SKILL.md 提醒」——
  后者正是母计划点名不接受的方案。
- 但也**不要**把「我查干净了 ⇒ 一定是自己配错了」当默认。正确形状是：**先穷尽自己这一侧**
  （matcher 写法、`hooks/hooks.json` 的位置、manifest 的 `hooks` 字段、上面那张判据表），
  **穷尽之后允许指向环境** —— 2026-09-13/14 那次就是「查干净了、仍然不响」。
- 无论指向哪边，**先确认探针读得到一份已经有内容的日志**（先做一次会走 allow 的写）。
  否则「没有 deny 行」分不清「门没被调用」与「日志读不到」—— 观测器的故障不许被读成现象。

## 离线验证

无需网络或 npm registry：

```bash
cd plugins/claude-spec
npm run doctor                                        # = npm run check && npm test
npm_config_cache=/private/tmp/claude-spec-npm-cache npm pack --dry-run --json
```

⚠️ 上面这段是**源码仓库**里的验证。**装好的插件里没有 `doctor` 也没有 `test`** ——
它们依赖 `test/`，而 `test/` 不进产物（`pack-plugin.mjs` 的 `EXCLUDE`），所以打包时连同
这两条 script 一起剔掉了。在装好的插件目录里能跑的是 `npm run check`。
（为什么要剔：剔之前，产物里的 `npm test` 跑 **0 个测试然后 exit 0** ——
一个假绿，比报「没有这条 script」更难查。）

`npm run check` 遍历插件里每个 `.mjs` / `.sh` 过语法、每份受约束的 JSON 过 `JSON.parse`。
预期：检查与测试通过；dry-run 文件列表包含 `.claude-plugin/`、`hooks/`、`scripts/`、
`mcp-server.mjs`、运行时 `lib/`、Skill、文档与 `adapter.example.json`。

## 规则派生（`.claude/rules/`）

```bash
node scripts/gen-rules.mjs              # 写进 <消费项目>/.claude/rules/
node scripts/gen-rules.mjs --check      # 逐字节比对，不一致即 exit 1
node scripts/gen-rules.mjs --out <dir>  # 写到别处
```

真源是 `packages/kiro-rules/lib/kiro-rules.js` 的**唯一事实源**；产物是派生物，**不要手改**。
消费项目解析不到时会**大声失败**，不会静默产出零个文件。

⚠️ 产物当前**入不了消费项目的库**：那边 `.gitignore` 忽略 `.claude/`，并明文写着不要再加
`!.claude/...` 例外。本轮**没有**改它的 `.gitignore`，也**没有**提交那 5 份文件 ——
它们以未跟踪状态存在，功能上仍会被加载，但换机器/新 clone 就归零。
细节与三条可选路线见 `docs/superpowers/plans/artifacts/06-consumer-precommit-request.md`。

## 本文件里哪些是**没测过**的

如实列出，免得读者以为都验过了：

> 2026-09-14 逐行复核。**填掉四行、订正两行、剩两行仍开着、新增一行。**

| 项 | 状态 |
|---|---|
| Cowork 的安装路径 | ✅ **已测**：无 CLI，Customize 上传归档；marketplace 在服务端；本机台账见上文 |
| Cowork 的卸载 / 移除 marketplace 注册 | `⟨待测⟩` —— 只观察到「重装生成新 `plugin_<id>`、旧目录留着」，**不足以**推出卸载是前置步骤 |
| `.mcp.json` 的 `cwd` 解析结果 | ✅ **已测**：用的是 `${CLAUDE_PLUGIN_ROOT}` → `…/rpm/plugin_<id>/`（插件根）。旧版本文写「`cwd: "."`」是**文档与自己的文件不符**，已订正 |
| 本机 node 版本（**MCP 侧**） | ✅ **已测**：`/usr/local/bin/node`，`v24.20.0`，在 `engines` 区间内 |
| 会话容器里的 node 版本（**hook 侧**） | ✅ **已测**：`v22.22.2`（`/opt/node22/bin/node`），在 `engines` 区间内。⚠️ 这两行是两条路径，旧版把它们混成一行 |
| manifest 的 `skills` / `mcpServers` 是否被认可 | ✅ **已测**：skill 与 25 个 MCP 工具都加载且可调用 |
| manifest 的 `hooks` 是否被认可 | 🔴 **开着** —— 门控不响，但「不响」的**成因仍未定论**（见上面的判据表）。已定位到 hook 在**容器**侧，容器副本的 `hooks.json` / `.sh` 都完整。⚠️ 曾把容器 `installationPreference: "available"` 当成头号嫌疑，**已被自己的实测推翻**（同一份副本里的 skill 确实加载了 ⇒ 这份副本是活的）|
| `PreToolUse` 门控在真机上真的响、真的拦得住 | ✅ **已测**（2026-09-14，桌面客户端本地模式，消费项目真实 `.kiro/specs/`）：`Write` 工具对 `.kiro/specs/_gate-liveness-probe-20260914/design.md`（同目录无 requirements.md）返回 `entry` 行 + `decision: "deny"`，写操作被真实拒绝（宿主报错，文件/目录均未落盘）。之前「2026-09-14 起不响」那条是**容器侧**的观察 —— 门控活着，但当时判定对象是容器临时目录（`/home/claude/...`），与消费项目仓库无关；本地模式下 hook 与文件同机，`Write` 直接命中，问题不复现。此前的普通写（`.kiro/specs/` 之外）也如预期拿到 `decision: "allow"`，排除了「日志读不到」与「门没被调用」混淆的可能 |
| 拒绝走哪个通道生效（`permissionDecision` JSON / `exit 2`） | `⟨待测⟩` —— 本地探针的日志同样显示两个通道都发（`channels: ["hookSpecificOutput.permissionDecision", "exit 2"]`），且宿主确实执行了拒绝，但日志本身不区分是哪个通道生效；仍需改 hook 脚本让两个通道分开触发（各自单独测一次）才能判定宿主实际认哪个 |
| 本地 marketplace 安装 | 🔁 **实际走的不是这条** —— 走的是服务端 `My Uploads` 上传。本地 marketplace 这条路径仍 `⟨待测⟩` |
| **多账号** | 🆕 **已测**：同机每账号各一份安装，版本可不同。任何「装了没生效」的排查都要先确定账号 |

## 消费项目 evaluation-only probe（历史通道，仍受支持但已不是本轮默认）

插件内的 `fixtures/admission-probe.mjs` 是那次准入的证据生成器，用于**评估目录**
`_eval-codex-YYYYMMDD/`，并拒绝正式 Spec 的写入。它是 `evaluation-only` 模式的回归夹具 ——
**已解锁宿主不走这条路**（见上面的 adapter 小节）。

在获得用户明确授权、且确认消费项目工作树干净之后：

```bash
node fixtures/admission-probe.mjs \
  --project-root /absolute/path/to/the consumer repo \
  --adapter .codex/kiro-spec.json \
  --spec _eval-codex-20260827 \
  --output /tmp/probe-result.json
```

它只请求 evaluation-only 目录的写入，并记录越界写入被拒、tasks 读写字节稳定性与固定 validator 的
退出状态。它不会修改 steering、模板或 validator。真实运行后仍要独立检查
`git diff -- .kiro/steering scripts/spec-tasks-lint.py`。
