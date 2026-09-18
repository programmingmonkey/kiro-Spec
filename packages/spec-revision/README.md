# `@my-harness/spec-revision`

Kiro Spec 的 **dual-hash** 计算层：`rawRevision` 与 `approvalFingerprint`。

抽取自 `plugins/{kiro,claude}-spec/lib/core/revision.mjs`（第 4 期）。纯函数、零 I/O、
不注入 port —— 已核：原文件只 import `node:crypto` 与三个同目录兄弟，无 `node:fs`。

## 两个哈希的语义（沿用第 3 期，本期不重新定义）

| | 何时变 |
|---|---|
| `rawRevision` | **任意字节变化即变**（BOM、换行、尾空格都算） |
| `approvalFingerprint` | 合法 checkbox / execution-event / `tasks.md` 上的**合法署名行**变化**不变**；标题、正文、`_Requirements:_`、依赖、waves、自由 Notes 变化**才变** |

> 署名行属**被剥离的协议标记**，与 execution-event 同类，不是语义。该豁免自
> `schemaVersion: semantic-v2`（第 8 期 `spec-sign-approval-clobber`）起生效，且**只对
> `tasks.md`**：`requirements` / `design` 内的人工署名仍会改变指纹。判据是
> `parseSignatureLine` —— 形似而不合法的行照旧改变指纹（否则就是一条 fail-open 的改写通道）。
>
> ⚠️ **范围是「文档级」，不限 `## Notes`**（2026-09-14 实测，第 8 期 `acceptance-net-firing` 补记）：
> 同形行落在 `## Tasks` 段的 detail 位置、其它 `##` 节、或 `## Notes` 内**一律被豁免**；
> **围栏内除外**（那条防线是刻意保留的）。这与 `checkAttribution` 的判据一致 ——
> 全仓「什么算署名」只有 `parseSignatureLine` 一个定义，豁免跟着它走。
> 代价是"写得像署名的一行落在哪儿都不算语义"；这是**接受的**（署名本就是自述的协议标记），
> 但必须写明 —— 否则下一个人会以为豁免只作用于 `## Notes`。

`approvalFingerprint` 是**审批指纹**。判错等于审批被静默作废或静默保留 —— 两个方向都难查。

## 切法决策（2026-09-13 定，附实测依据）

这一步是**布局决定**，不能只活在某次 commit message 里，故落地在此。

`revision.mjs` 的依赖闭包分三组，三组性质不同：

| 组 | 符号 | 现居（抽取前） | revision 之外还有谁在用 | 性质 |
|---|---|---|---|---|
| 1 | `parseTaskLine` / `metadataValue` / `hasFenceClose` / `nextFenceMarker` / `taskIndentStack` | `task-format.mjs`（已是 spec-parser 的薄转发，唯一自有物是 `STRICT` 策略绑定） | 全 host 都在用 | 已共享，只差**策略参数化** |
| 2 | `stripValidExecutionEvents`（另有 `parseExecutionEvents` / `appendExecutionEvent`） | `event-format.mjs`（零 import、自包含） | `task-events.mjs`、`mcp/service.mjs` | **解析/格式化**，不是 revision 私有 |
| 3 | `parseWaves` | `index.mjs`（16 行） | `analysis.mjs`、`mcp/service.mjs` | **解析**，不是 revision 私有 |

**四条理由：**

1. **第 2、3 组搬进 `@my-harness/spec-parser`，不搬进本包。**
   它们本来就是「解析 spec markdown」，那正是 spec-parser 的职责；而且它们各自都有
   revision 之外的消费者 —— 塞进 revision 包会变成「`service.mjs` 要从 revision 包里
   import 执行事件格式化」，层次是反的，下一个人还得再拆一次。
   规模也支持：`parseWaves` 16 行，`event-format.mjs` 3308 字节、3 个导出、零依赖。

2. **第 1 组不搬，本包直接依赖 `@my-harness/spec-parser`，并把 `strictTaskState` 作为入参。**
   策略参数化，函数不注入。

3. 🔴 **明确否掉「把 `parseWaves` / `stripValidExecutionEvents` 作为函数注入」。**
   那会让三个 host 各自接线，「三边用同一套原语」这个保证从**共享事实**退化成
   **三个各自的承诺** —— 而本期存在的全部理由就是消灭这种漂移。
   **策略是配置，可以是入参；实现是共享物，不能是入参。**

4. 🔴 **明确否掉「复制一份进新包」。**
   那会是本项目的又一次同源副本，而且藏在一个名字听起来很正当的"共享包"里。

## `strictTaskState` 为什么必须显式传

`parseTaskLine` 是**带策略的**：codex-spec 走 strict（四字符类 `[ x-]`，去掉 `~`），
dsh-spec 走非 strict（真机四字符类 `[ x~-]`）。这不是历史遗留，是注册在案的**有意分歧** ——
`packages/spec-parser/declared-diffs.json` 里的 `task-state-tilde`（A1）与
`task-state-illegal`（A2），第 3.5 期的判据「实测差异集合 ⊆ 声明集合」正盯着它们。

🔴 本包若把 strict 写死，dsh 侧的 `approvalFingerprint` 会对 `[~]` 行判错 ——
而那是审批指纹。所以策略是入参。

**默认值取 `true`**（kiro 侧的历史行为），理由是：两个 host 的既有测试与生产调用点
大量依赖 strict 语义，取 `false` 会让它们全部静默改变含义。取 `true` 只让**新接入方
必须显式表态**——dsh-spec 侧一律显式传 `false`。

**漏传由谁盯**（2026-09-13 对抗性审查后修正过一次，原文写「由绊线测试盯着漏传」但当时
**没有**这样的测试）：`plugins/dsh-spec/test/fingerprint.test.mjs` 最后一条是**集成**用例，
用含 `[~]` 的语料走 `spec_task_set` —— `[~]` 在两个策略下一次算 task token、一次算 text token，
结论相反。受控变异实测：把生产调用点的 `strictTaskState: false` 去掉，这条会红。
⚠️ 其余用例抓不到漏传：`strategy.test.mjs` 只测**直接传参**，`fingerprint.test.mjs` 的
其他集成用例语料不含 `[~]`（两种策略结果相同）。

## 判据

- `scripts/fixtures/revision-golden.json` + `scripts/revision-golden.test.mjs`：
  5 份真实 spec 的每个 artifact 两个 hash 逐字节相同；三组「语义等价但字节不同」的对照；
  外加 `strictAxis` 一段（**补的盲区**：该 golden 原本对 `strictTaskState` 轴零判别力 ——
  翻转默认值仍 12/12 绿、15 个 artifact 敏感者 0，而那正是 §0 ⑤ / R4-8 点名最危险的轴）。
  ⚠️ 对照组的价值**实测过两条**：① 覆盖语料没有的输入形状（去掉 event-format 的 `TRANSITIONS`
  项时只有对照 ③ 红）；② 输入自包含。原文给的理由「把 `approvalFingerprint` 换成
  `computeRawRevision` 别名时那 5 个值一个都不会变」**已被实测证伪**（那种变异会让 5 条语料全红）。
- `test/strategy.test.mjs`：`strictTaskState` 确实是入参，且两个策略在 `[~]` 行上分道扬镳。
