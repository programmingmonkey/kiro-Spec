// Task 1 的语料清单与取数：**无副作用**，供生成器与测试共同引用。
//
// 单独成一个模块，是为修第 3 期踩过的那个坑：测试原先直接 import 生成器去取清单，而生成器顶层
// 就会 measure 并 `writeFileSync` 覆盖已入库的 fixture —— 于是「跑一次回归测试」会悄悄重写
// 「改造前快照」这份**证据**。清单与取数本身不该附带任何写入。
//
// 本模块**在 import 期零文件系统访问**：一切都在函数里发生。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 内层：kiro-spec 自己的 spec ──────────────────────────────────────────────
// 计划 Task 1 Step 1 点名 6 份（第 1 期 Task 4 的 5 份 + 第 3 期新增的 1 份），**不重新枚举**。
// 钉死名单而不是「扫目录」的原因：这份存档是**证据**，证据的语料必须可复现——目录里后来多出来的
// 两个（`kiro-rules-extraction`、本期的 `spec-diagnose-extraction`）是各期自身的产物，不在名单内。
export const INNER_SPECS = [
  'dsh-spec-advancement',
  'hello-world',
  'subagent-model-toggle',
  'dsh-spec-hardening',
  'dsh-spec-live-fire-fixes',
  'spec-parser-extraction',
]

// ── 外层：消费项目抽样（**只读**，本期绝不写入该目录）──────────────────────
//
// `CONSUMER_SPECS_ROOT` 是**登记用的规范路径**（入库的 fixture 里记的就是它），
// 但取数**不得**只认这一条：它是一台机器上的绝对路径，在 CI、另一台开发机、Cowork 的
// Linux VM 上都解析不到。
//
// 🔴 **这里曾经是一个静默降级点，是本轮 review 抓到的真缺陷。**
// 原实现是 `if (!existsSync(root)) return []` —— 路径解析不到时外层语料**整层归零且无任何信号**，
// 后果有两种，第二种更糟：
//   · `rule-reachability` 会红，但归因是假的（报「表里有死规则」，实际是语料没加载）；
//   · `declared-diffs-closure` **悄悄通过**，在 18 个 artifact 而不是全量上宣布「除声明外逐字段相同」
//     —— 而那正是整个第 3.5 期存在的意义所在的门槛。
// 现在改为：多候选解析 + 显式状态。**不在场必须由调用方 skip-with-loud-message，
// 不允许当成「跑过了」**（与 `kiro-validators` 对缺失 bundle 的处置同形）。
export const CONSUMER_SPECS_ROOT = '@CONSUMER_REPO@/.kiro/specs'

// 仓库根（本文件在 packages/spec-diagnose/test/tools/ 下，上溯四级）。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** 候选按优先级排列；第一个真实存在的胜出。 */
export function outerRootCandidates() {
  return [
    process.env.SPEC_CORPUS_CONSUMER_REPO_ROOT,        // 显式覆盖，最高优先
    CONSUMER_SPECS_ROOT,                          // 规范路径（真机）
    resolve(REPO_ROOT, '..', '消费项目', '.kiro', 'specs'), // 与仓库同级（VM / 其他机器）
  ].filter(Boolean)
}

/**
 * 外层语料的解析状态。**任何消费外层的地方都应先读它**，据此决定断言还是响亮跳过。
 * 返回 `{ root, resolved, tried }`：`root` 在解析不到时回落到规范路径，仅供消息使用。
 */
export function resolveOuterRoot() {
  const tried = outerRootCandidates()
  const root = tried.find((candidate) => existsSync(candidate))
  return { root: root ?? CONSUMER_SPECS_ROOT, resolved: root !== undefined, tried }
}

/** 供测试直接嵌进 skip / diagnostic 消息，口径统一。 */
export function outerAbsenceMessage() {
  const { tried } = resolveOuterRoot()
  return (
    '消费项目语料不在场 —— 本次不核外层那一层，不用硬编码顶替。已尝试：\n  ' +
    tried.join('\n  ') +
    '\n可用 SPEC_CORPUS_CONSUMER_REPO_ROOT 指定；外层缺席时的结论只覆盖内层语料。'
  )
}

export const ARTIFACT_FILES = {
  'requirements.md': 'requirements',
  'design.md': 'design',
  'tasks.md': 'tasks',
  'bugfix.md': 'bugfix',
}

/** 抽样规则（**先写死再抽**，不许挑）。 */
export function sampleRule(total) {
  const every = Math.floor(total / 20)
  return {
    description: '按目录名排序后每第 N 个取一份，N = ⌊总数 / 20⌋（先写死规则再抽，不许挑）',
    candidates: total,
    every,
    note: every < 1 ? '语料不足 20 份，退化为全取' : `取下标 0, ${every}, ${2 * every}, …`,
  }
}

/** 外层抽样的候选目录：`.kiro/specs` 下的一级目录，排除 `_archive`（它是容器，不是一份 spec）。 */
export function outerCandidates(root = resolveOuterRoot().root) {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => name !== '_archive')
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

/** 选中目录名连同规则一起入库——否则「抽样 20 份」是不可复现的。 */
export function selectOuterSample(root = resolveOuterRoot().root) {
  const candidates = outerCandidates(root)
  const rule = sampleRule(candidates.length)
  const every = Math.max(1, rule.every)
  const selected = candidates.filter((_, index) => index % every === 0)
  return { root, rule, selected }
}

/** 一份 spec 目录里的 artifact → markdown。 */
export function artifactsOf(dir) {
  const out = {}
  for (const [file, artifact] of Object.entries(ARTIFACT_FILES)) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    out[artifact] = readFileSync(path, 'utf8')
  }
  return out
}

/**
 * 该 spec 的工作流。与 dsh-spec 的判定同源（`plugins/dsh-spec/lib/index.js:2017`）：
 * 先读 `tasks.meta.json` 的 `_workflow`，回落到「有 bugfix.md 即 bugfix，否则 requirements-first」。
 */
export function workflowOf(dir) {
  const meta = join(dir, 'tasks.meta.json')
  if (existsSync(meta)) {
    try {
      const parsed = JSON.parse(readFileSync(meta, 'utf8'))
      if (parsed && typeof parsed._workflow === 'string') return parsed._workflow
    } catch {
      /* 坏 meta 不该让取数整体失败——回落到文件存在性 */
    }
  }
  return existsSync(join(dir, 'bugfix.md')) ? 'bugfix' : 'requirements-first'
}

/** 两层语料的展开：每一项 = 一份 spec × 它的每个 artifact。 */
export function buildCorpus({ specsRoot, consumerRoot = resolveOuterRoot().root } = {}) {
  const entries = []
  const push = (layer, spec, dir) => {
    const artifacts = artifactsOf(dir)
    if (Object.keys(artifacts).length === 0) return
    entries.push({ layer, spec, dir, workflow: workflowOf(dir), artifacts })
  }
  for (const spec of INNER_SPECS) push('inner', spec, join(specsRoot, spec))
  const sample = selectOuterSample(consumerRoot)
  for (const spec of sample.selected) push('outer', spec, join(sample.root, spec))
  // `outer` 让调用方能区分「外层跑过且为空」与「外层根本没加载」——
  // 这两件事此前在返回值里长得一模一样，正是静默降级的成因。
  const outer = { ...resolveOuterRoot(), entries: entries.filter((e) => e.layer === 'outer').length }
  return { entries, sample, outer }
}
