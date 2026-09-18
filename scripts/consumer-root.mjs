// 下游消费项目仓库根的**唯一**解析点（测试与探针共用）。
//
// 为什么要有它：有些回归测试必须对着**一份真实的下游语料**跑 —— 合成语料验不出
// 真实世界里的文件形态（缩进、CRLF、历史遗留的三态标记、写歪的围栏……）。
// 而那份语料**不在本仓**：它属于使用本插件的项目，是私有的。
//
// 所以这里解析一个**可配置**的根，候选按优先级排列，第一个真实存在的胜出：
//   1. 环境变量 `CONSUMER_REPO_ROOT`（显式覆盖，CI / 别的机器用这个）
//   2. 与本仓**同级**的 `../consumer`（把两份 checkout 并列摆放时成立）
//
// 🔴 解析不到时**不许静默降级**。调用方必须 skip-with-loud-message 或显式报错，
// 把 `consumerAbsenceMessage()` 原样嵌进消息里 —— 它会列出试过的每一条路径。
//
// 这条规矩的由来值得记下来：早先有一处写成 `if (!existsSync(root)) return []`，
// 于是外层语料整层归零，而判据照常「通过」。**语料没了，测试反而全绿** ——
// 这是本仓库反复要消灭的形态，也是这个文件存在的理由。
//
// ⚠️ 公开环境下「没有那份语料」是**正常状态**：相关用例会 skip，并在消息里说明原因。
// 但 skip 不算通过 —— 想要跑全量回归，把 `CONSUMER_REPO_ROOT` 指向你的项目即可。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本仓根（本文件在 <repo>/scripts/ 下）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 候选按优先级排列。 */
export function consumerRootCandidates() {
  return [
    process.env.CONSUMER_REPO_ROOT,
    path.resolve(REPO_ROOT, '..', 'consumer'),
  ].filter(Boolean)
}

/**
 * 解析消费项目仓库根。
 *
 * 返回 `{ root, resolved, tried }`：解析不到时 `root` 是**最后一条候选**，
 * **仅供消息使用** —— 不要拿它去读文件（`resolved === false` 时那条路径按定义不存在）。
 */
export function resolveConsumerRoot() {
  const tried = consumerRootCandidates()
  const found = tried.find((candidate) => existsSync(candidate))
  return { root: found ?? tried[tried.length - 1], resolved: found !== undefined, tried }
}

/** 消费项目 `.kiro/specs` 的绝对路径（同样带解析状态）。 */
export function resolveConsumerSpecs() {
  const base = resolveConsumerRoot()
  const specs = path.join(base.root, '.kiro', 'specs')
  return { ...base, specs, resolved: base.resolved && existsSync(specs) }
}

/** 供 skip / diagnostic 原样嵌入，口径统一。 */
export function consumerAbsenceMessage(what = '消费项目语料') {
  const { tried } = resolveConsumerRoot()
  return (
    `${what}不在场 —— 本次不核这一项，不用硬编码顶替。已尝试：\n  ` +
    tried.join('\n  ') +
    '\n可用环境变量 CONSUMER_REPO_ROOT 指定。skip 不算通过：交付说明里要写明它没跑过。'
  )
}
