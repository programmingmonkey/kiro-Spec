> 🌐 [English](../../../plugins/dsh-spec/INSTALL.md) · **中文**

# dsh-spec 接入指南

> 把一个功能/修复规范化为 Kiro 风格的三文档 Spec,并强制分阶段推进。
> 本包是一个 **DeepSeek Harness (DSH) cordis 插件**,只在 DSH 环境内有效。

## 前置条件

- 一个可运行的 DSH 环境(能 resolve 到 `@deepseek-ai/dsh-*` 包)。
- 本包只声明一个 peer dependency:`@deepseek-ai/dsh-tools`(DSH 环境自带,无需单独安装)。

## 安装

> 🔴 **2026-09-18 更正：本节此前写的是「本包不发布，唯一受支持的方式是作为本仓 workspace
> 的一部分」。那个结论过期了 —— 但不是因为它写错了，而是因为修法出现了。**
>
> 那条结论成立的前提是「依赖只能靠 `workspace:` 协议解析」。`scripts/pack-plugin.mjs`
> 的 vendor 逻辑正是为了消灭那个前提：它把 `@my-harness/*` 依赖闭包**复制进归档**
> 并把 import 改写成相对路径，所以打出来的包**不依赖 workspace 协议**，
> 可以装到没有本仓的机器上。这就是现在推荐的**方式 A**（见下）。
>
> ⚠️ 但**下面那条报错仍然成立**：`npm pack` / `file:` / `git+` 这三条路依然失效。
> 走**打包器**，不要走 `npm pack`。
>
> 以下保留原记录 —— 它是「为什么需要 vendor」的第一手证据。
>
> ---
>
> 🔴 **（过期）本包不发布,也不能作为独立的 `file:` / `git+` / `.tgz` 依赖安装。**
> 2026-09-12 起 `dsh-spec` 声明了 workspace 依赖
> `"@my-harness/kiro-rules": "workspace:*"`(41 条 Kiro 规则表的唯一副本),
> 而 `@my-harness/kiro-rules` 是 `private: true` 的 workspace 包。
>
> `workspace:` 协议只在 workspace 内部由 pnpm/yarn 解析,**npm 不改写它** ——
> `npm pack` 产出的 `package.json` 会原样带上 `workspace:*`。实测
> (2026-09-12,Node v25.8.0):
>
> ```console
> $ npm pack                              # 在 plugins/dsh-spec 内
> $ npm install dsh-spec-0.2.0.tgz        # 在 workspace 之外
> npm error code EUNSUPPORTEDPROTOCOL
> npm error Unsupported URL Type "workspace:": workspace:*
> ```
>
> 因此本指南此前记录的三条路径(`file:` 本地依赖 / 私有 `git+` / `npm pack`
> 后离线安装)**全部失效**,上面那条报错是它们的共同症状。对应的代码侧变化:
> `package.json` 现在带 `"private": true`,且不再声明 `files` / `keywords`。
> ⚠️ 删 `files` 的理由不是"只对发布有意义"—— `npm pack` 也读它。理由是**打包
> 分发这条路已经死了**(上面那条报错),留着它只会让人以为还能 pack 出去。
> `keywords` 才是只服务于 registry 检索的那个。

### 方式 A：用打包器出包（使用者用这个）

在**本仓根目录**跑打包器：

```bash
node scripts/pack-plugin.mjs dsh-spec --out dist/dsh-spec.plugin
```

它会做三件事，而且**第三件会红**：

1. 把 plugin 树收进一个 zip；
2. 把 `@my-harness/*` 依赖闭包 **vendor 进 `vendor/`**，并把源码里的裸 specifier
   改写成相对路径 —— 所以产物**不依赖 workspace 协议**；
3. 自检：产物里不得残留任何裸 `@my-harness/` specifier，且每条改写后的相对路径
   必须真的存在。漏 vendor 一个包，这里就报出来，而不是等你装上去报
   `ERR_MODULE_NOT_FOUND`。

产物解包到你的 DSH profile 目录：

```bash
unzip dist/dsh-spec.plugin -d <DSH_DIR>/.dsh/profiles/dsh-spec
```

再把 profile 的 `cordis.patch.yml` 指向那个目录（见下面「挂载到你的 DSH profile」）。

> ⚠️ **打包产物的 `package.json` 会被剪枝**：点名了产物里不存在的文件的 `script` 会被删掉。
> 这是有意的 —— 「声称的东西必须在包里」。所以你会在打包日志里看到
> `package.json 剪掉 N 条不成立的 script`，那不是报错。
>
> 想验产物有没有和源码漂开：`node scripts/pack-plugin.mjs dsh-spec --check`。

### 方式 B：作为本仓库 workspace 的一部分（改插件的人用这个）

`kiro-spec/pnpm-workspace.yaml` 已把 `plugins/*` 与 `packages/*` 纳入 workspace。
在 `kiro-spec` 根目录跑 `pnpm install` 后:

- `plugins/dsh-spec/node_modules/@my-harness/kiro-rules` 是指向
  `packages/kiro-rules` 的软链 —— 这是 `--preserve-symlinks` 开与关两种模式下
  **都可达**的解析位置(风险 R1 的推论),不要靠 hoist 到根。
- 该软链必须由 `pnpm install` 建出。手工建链属于本仓库已淘汰的做法。

DSH profile 侧只需要一条指向本目录的软链(`<DSH_DIR>` 就是这么做的):

```bash
ln -s /path/to/kiro-spec/plugins/dsh-spec <DSH_DIR>/.dsh/profiles/dsh-spec
```

profile 的 `cordis.patch.yml` 里 `name` 要指向本插件的**入口文件**(见下节)。

## 挂载到你的 DSH profile

在你的 profile 的 `cordis.patch.yml`(或 `cordis.yml`)里加一行 insert:

```yaml
- insert:
    - id: dsh-spec
      # 入口文件路径,相对 profile 目录解析。<DSH_DIR> 的实测值就是这个 ——
      # 那里 .dsh/profiles/dsh-spec 是指向 kiro-spec/plugins/dsh-spec 的软链。
      name: '../dsh-spec/lib/index.js'
      config:
        specDir: .spec                 # 单 spec 兼容位置(默认 .spec)
        projectRootMarkers: ['.git']   # 项目根识别标记
        specsRoot: null                # 显式 spec 父目录(可选)
        useFeatureDirs: true           # 使用 .kiro/specs/<feature>/ 布局
        subagentProvider: null         # /spec run 派发任务用;配了才能 run
```

> ⚠️ `name` 是**入口文件的路径**,不是包名。写 `name: 'dsh-spec'` 是**解析不到**的:
> 实测 `profiles/web/node_modules/` 与 `.dsh-module-fallback/node_modules/` 都是空的,
> `profiles/node_modules/` 与 `<DSH_DIR>/node_modules/` 里也都没有名为 `dsh-spec` 的包
> —— 解析链上没有任何东西可以命中(这一条是**推断**,依据是这条实测出来的解析链,
> 我没有真的用包名写法启动过)。包名写法只在「把本包作为依赖装进 profile」时才有意义,
> 而那条路已经失效(见上面的安装一节)。

## 最小可用配置

只想用核心三文档工作流(不跑 waves),config 可全部省略,用默认值:

```yaml
- insert:
    - id: dsh-spec
      name: '../dsh-spec/lib/index.js'
```

## 能力与用法

见 `README.md`(四种形态 / 目录对齐 / 工具 `spec_*` / 命令 `/spec`)。

## 验证是否挂载成功

按顺序做三步,任何一步失败都能定位是哪一层的问题:软链 → 组合 → 工具可见。

### 第 1 步:确认两个软链都在

本包**不在 profile 的依赖树里** —— 它是被软链进来的 profile 目录。所以在 profile
目录里跑 `pnpm list dsh-spec` 查不到东西,那是布局使然,不是没装。要查的是这两条:

```bash
# ① profile 侧:profile 目录就是本目录
ls -l <DSH_DIR>/.dsh/profiles/dsh-spec

# ② 本包侧:workspace 依赖解析到了共享包
ls -l plugins/dsh-spec/node_modules/@my-harness/kiro-rules
```

两条都必须是软链。①断了 → profile 里没有这个插件;②断了 → 先在本仓库根跑
`pnpm install`(见「安装」)。

### 第 2 步:确认组合里出现了这一行

```bash
dsh --dump-config
```

预期在输出的 plugin 列表(或对应 profile 的组合树)里能看到:

```
- id: dsh-spec
  name: '../dsh-spec/lib/index.js'
```

- 若报找不到模块 → 那条 `name` 路径相对 profile 目录拼出来的文件不存在(第 1 步的两条软链)。
- 若根本没这一行 → `cordis.patch.yml` 的 insert 没生效,检查 id 与缩进。

### 第 3 步:确认工具真的可见

启动一个会话(或用 `dsh --dump-config` 里的工具清单),确认出现 `spec_*` 工具:

```
spec_init / spec_write / spec_read / spec_status / spec_task_set / spec_meta / spec_run
```

以及命令 `/spec`。

- 工具全都不在 → 插件的 `inject`(tools/systemPrompt/fs/subagents)中某项在目标 profile 里缺失。
  ⚠️ `inject` 是**硬依赖**:缺任意一项,整个插件都不加载,`spec_*` 工具会**全部消失**(不是只少 `spec_run`)。
  其中 `subagents` 由 `@deepseek-ai/dsh-subagent` 提供,`dsh-base` 已挂载它,故基于 `dsh-base` 的 profile 正常;
  若你的 profile 不含 `dsh-base`,需自行保证 `tools`/`systemPrompt`/`fs`/`subagents` 四个 service 均存在。
- 工具都在,但 `spec_run` / `/spec run` 报 "requires config.subagentProvider" → 属**未配**而非缺依赖:
  在 profile 的 `dsh-spec` 行补 `config: { subagentProvider: spawn }`
  (`dsh-base` 已挂载 `@deepseek-ai/dsh-subagent-spawn-in-process`,其注册名默认即 `spawn`)。
  未配时核心三文档工作流不受影响,`/spec plan` 仍可预览执行计划。

  > **在 kiro-spec 这套布局下无需手工补。** 该配置位于 `<DSH_DIR>/.dsh/profiles/web/cordis.patch.yml`,
  > 而 `<DSH_DIR>` 不是 git 仓库(重装/升级即丢失)。故由**受版本控制**的 `restart-dsh.sh`
  > 调用 `scripts/ensure-profile-config.mjs` 幂等补齐:文件缺失则创建、已正确则逐字节不动、
  > 显式设成别的 provider 则保留不覆盖。手工补仅在上述脚本不适用时(自定义布局)才需要。
  > 该脚本可单独使用:`node scripts/ensure-profile-config.mjs --file <profile-patch.yml>`。

### 冒烟测试(可选,端到端确认)

进入任意一个含 `.git` 的项目目录,启动会话后让 agent 跑:

```
/spec init 测试一把
/spec status
```

`/spec status` 应返回 `requirements` 阶段,且项目根下已出现 `.kiro/specs/<feature>/requirements.md`。
这证明:装包 ✅、组合 ✅、工具 ✅、落盘目录 ✅——整套 spec 机制已在此项目可用。
