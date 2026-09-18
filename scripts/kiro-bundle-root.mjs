// Kiro 出厂 bundle 路径的**唯一**解析点（测试与探针共用）。
//
// 为什么要有它 —— 与 `consumer-root.mjs` 是同一种病，只是晚诊断了半年：
// 那个文件的头部写着「`~/Documents/消费项目` 这个假设在第 3.5 / 3.6 两期里被各写了一遍，
// 到第 3.6 期交付时仓库里已有 8 份拷贝……在 Cowork 的 Linux VM 上 14 个 skip 里有 11 个是
// 这条路径解析不到造成的」。消费项目因此有了三级候选 + 环境变量 + 统一缺席消息。
// **Kiro bundle 从来没享受过同样的治疗**：`KIRO_EXTENSION_JS` 只在两个 tool 模块的默认参数里
// 各写了一遍，没有唯一解析点，于是调用方可以绕过它 —— 而且真的绕过了。
//
// 🔴 那次绕过的形态值得记下来，因为它只在「有人真的把覆盖机制用起来」时才会现形：
// `spec-diagnose` 的加载器认 `KIRO_EXTENSION_JS`，但三处断言用的是**导出的常量**
// `DEFAULT_BUNDLE_PATH`。不设变量时三条都走 skip，看不出问题；设了变量之后加载器读到了
// 挂载点的 bundle、skip 守卫放行，紧接着同一个用例又去 `readFileSync('/Applications/…')`
// —— ENOENT。**红得像「真机 Kiro 与复刻件不一致」，实际只是路径管道。**
// 也就是说：唯一想认真跑这几条真机判据的人，恰恰是唯一会被它误导的人。
//
// 两级候选，第一个真实存在的胜出：
//   1. 环境变量 `KIRO_EXTENSION_JS`（显式覆盖：CI / Cowork VM / 任何非作者主机用这个）
//   2. `packages/kiro-rules/scripts/extract-kiro-rules.py` 里的 `BUNDLE` 常量
//
// 🔴 第 2 级**从 py 文件里现读**，不在本文件里再抄一份绝对路径。理由沿用
// `plugins/dsh-spec/test/boundaries.test.mjs` 的原话：「bundle 位置只有一个家 —— 从那里读，
// 意味着 bundle 换了地方只会让 skip 理由跟着变，而不是在这里留下一条过期路径」。
// 本文件做的是给那个家**加一把前门钥匙**（环境变量），不是再盖一个家。
//
// 🔴 解析不到时**不许静默降级**。调用方必须 skip-with-loud-message 或显式报错，
// 把 `kiroBundleAbsenceMessage()` 原样嵌进消息里 —— 它会列出试过的每一条路径。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** kiro-spec 仓库根（本文件在 <repo>/scripts/ 下）。 */
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** `BUNDLE` 常量的唯一出处。 */
export const EXTRACTOR_PATH = path.join(HARNESS_ROOT, 'packages', 'kiro-rules', 'scripts', 'extract-kiro-rules.py')

/**
 * 从抽取脚本里现读 `BUNDLE`。
 * 🔴 读不到就**抛**，不返回猜测值 —— 一个猜出来的路径会把「配置坏了」伪装成「bundle 不在本机」。
 */
export function canonicalKiroBundle() {
  const matched = /^BUNDLE\s*=\s*"([^"]+)"/m.exec(readFileSync(EXTRACTOR_PATH, 'utf8'))
  if (!matched) throw new Error(`extract-kiro-rules.py 里找不到 BUNDLE 常量：${EXTRACTOR_PATH}`)
  return matched[1]
}

/** 候选按优先级排列。 */
export function kiroBundleCandidates() {
  return [process.env.KIRO_EXTENSION_JS, canonicalKiroBundle()].filter(Boolean)
}

/**
 * 解析 bundle 路径。
 * 返回 `{ path, resolved, tried }`：解析不到时 `path` 回落到规范路径，**仅供消息使用**，
 * 不要拿它去读文件（`resolved` 为 false 时那条路径按定义是不存在的）。
 */
export function resolveKiroBundle() {
  const tried = kiroBundleCandidates()
  const found = tried.find((candidate) => existsSync(candidate))
  return { path: found ?? tried[tried.length - 1], resolved: found !== undefined, tried }
}

/** 供 skip / diagnostic 原样嵌入，口径统一。 */
export function kiroBundleAbsenceMessage(what = 'Kiro 出厂 bundle') {
  const { tried } = resolveKiroBundle()
  return (
    `${what}不在本机 —— 本次不核这一项，不用硬编码顶替。已尝试：\n  ` +
    tried.join('\n  ') +
    '\n可用环境变量 KIRO_EXTENSION_JS 指定。skip 不算通过：交付说明里要写明它没跑过。'
  )
}
