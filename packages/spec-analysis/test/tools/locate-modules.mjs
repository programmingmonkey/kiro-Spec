// 五个模块「现在住在哪」的**唯一**解析点。
//
// 本期是一个跨包的搬移：Task 3 之前它们住在 `plugins/dsh-spec/lib/`，之后住在
// `packages/spec-analysis/lib/`。两处的断言都要能在**两种状态**下跑出真话，所以
// 位置解析必须集中在这里，而不是各测试各写一份「找不到就回落」——
// 回落是本仓反复消灭的形态：它会让「模块丢了」看起来像「模块在别处」。
//
// 规矩：
//   1. 每个模块必须**恰好**存在于两地之一（两边都在 = 搬到一半；都不在 = 模块丢了）；
//   2. 返回值是当前状态，不是「猜一个」；
//   3. 状态是过渡态时**如实描述**，调用方负责把它打印出来或据此调整断言。

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 本包根（该文件在 <pkg>/test/tools/ 下）。 */
export const PKG_ROOT = resolve(HERE, '..', '..')
/** 仓库根。 */
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

/** 被搬的五个模块，按字典序——所有遍历都按它排序，保证输出可复核。 */
export const MODULES = ['amendments', 'archive', 'checklist', 'drift', 'signature']

export const PACKAGE_LIB = join(PKG_ROOT, 'lib')
export const PLUGIN_LIB = join(REPO_ROOT, 'plugins', 'dsh-spec', 'lib')

/**
 * 每个模块现在住在哪。
 * 返回 `{ module: { pkg: boolean, plugin: boolean } }`，以及两个便利集合。
 */
export function moduleLocations() {
  const where = {}
  for (const mod of MODULES) {
    where[mod] = {
      pkg: existsSync(join(PACKAGE_LIB, `${mod}.js`)),
      plugin: existsSync(join(PLUGIN_LIB, `${mod}.js`)),
    }
  }
  const inPkg = MODULES.filter((m) => where[m].pkg)
  const inPlugin = MODULES.filter((m) => where[m].plugin)
  const duplicated = MODULES.filter((m) => where[m].pkg && where[m].plugin)
  const missing = MODULES.filter((m) => !where[m].pkg && !where[m].plugin)
  return { where, inPkg, inPlugin, duplicated, missing }
}

/**
 * 五个模块**当前所在的那个目录**。
 * 任何一个模块两边都在或都不在就抛——过渡态可以存在，但状态必须是**明确的**。
 */
export function locateModules() {
  const { inPkg, inPlugin, duplicated, missing } = moduleLocations()
  if (duplicated.length > 0) {
    throw new Error(`这五个模块同时存在于两个位置（搬到一半）：${duplicated.join(', ')}`)
  }
  if (missing.length > 0) {
    throw new Error(`这五个模块在任何一个位置都找不到：${missing.join(', ')}`)
  }
  if (inPkg.length === MODULES.length) return PACKAGE_LIB
  if (inPlugin.length === MODULES.length) return PLUGIN_LIB
  throw new Error(
    `五个模块的分布既不完整地在本包、也不完整地在插件里：本包 ${JSON.stringify(inPkg)} / 插件 ${JSON.stringify(inPlugin)}`,
  )
}

/** 人类可读的当前状态，用于在测试里如实打印。 */
export function describeLocations() {
  const { inPkg, inPlugin } = moduleLocations()
  if (inPkg.length === MODULES.length) return '五个模块都在 packages/spec-analysis/lib（搬移已完成）'
  if (inPlugin.length === MODULES.length) return '五个模块都还在 plugins/dsh-spec/lib（搬移未开始）'
  return `过渡态：本包 ${inPkg.length} 个 / 插件 ${inPlugin.length} 个`
}

/** 每个模块当前实际存在的绝对路径；不存在则抛（调用方应先确认状态完整）。 */
export function modulePath(mod) {
  const { where } = moduleLocations()
  if (!MODULES.includes(mod)) throw new Error(`未知模块 ${mod}`)
  if (where[mod].pkg && where[mod].plugin) throw new Error(`${mod} 同时存在于两个位置`)
  if (where[mod].pkg) return join(PACKAGE_LIB, `${mod}.js`)
  if (where[mod].plugin) return join(PLUGIN_LIB, `${mod}.js`)
  throw new Error(`${mod} 在任何一个位置都不存在`)
}

/**
 * 抽出源码里真正的 import / export-from 目标。
 *
 * ⚠️ 不能用 `/(?:from|import)\s*['"]/` 那种松正则：注释与散文里出现的 import 一词
 * 会被一起吃掉（实测：`amendments.js` 的一个报错文案与 `signature.js` 的一句注释都被
 * 误判成 import 目标）。所以这里只认四种植根形态：静态 import、bare import、
 * export-from、动态 import()。
 */
export function importSpecifiers(source) {
  const out = []
  const patterns = [
    /^\s*import\s+[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /^\s*export\s+[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1])
  return out
}
