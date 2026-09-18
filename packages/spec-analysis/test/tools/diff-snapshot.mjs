// Task 3.4 的验收工具：把**改造前**的行为快照与**当前实现**的输出逐字段比对。
//
// 用法：
//   node test/tools/diff-snapshot.mjs            # 对着 <pkg>/lib 跑，列出差异
//   node test/tools/diff-snapshot.mjs --lib <dir> # 指定另一份实现
//   node test/tools/diff-snapshot.mjs --json      # 机器可读
//
// 退出口径：**没有差异也返回 0**，有差异也返回 0 —— 这不是「测试」，是取数工具。
// 差异必须由人对着 Task 0.3 的后果清单逐条解释（spec Req 3.3）；把差异做成非零退出码
// 会把「有差异」直接等同于「错」，而本期**有意的**行为变更正好三处。
//
// 它也不做「忽略某个字段再比」：快照本身就不含 libDir 与时间戳，所以整棵 JSON tree
// 是逐字段可比的。任何一处不等都必须被列出来。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSnapshot } from './gen-behaviour-snapshot.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..', '..')
const BEFORE = join(PKG_ROOT, 'test', 'fixtures', 'behaviour-snapshot.json')
const DEFAULT_LIB = join(PKG_ROOT, 'lib')

const isObj = (v) => v !== null && typeof v === 'object'

/** 逐字段比较，返回 `[{path, before, after}]`；数组按索引对齐（顺序本身就是行为）。 */
export function diffJson(before, after, path = '$', out = []) {
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      out.push({ path, before, after })
      return out
    }
    const n = Math.max(before.length, after.length)
    for (let i = 0; i < n; i += 1) {
      if (i >= before.length) out.push({ path: `${path}[${i}]`, before: undefined, after: after[i] })
      else if (i >= after.length) out.push({ path: `${path}[${i}]`, before: before[i], after: undefined })
      else diffJson(before[i], after[i], `${path}[${i}]`, out)
    }
    return out
  }
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    for (const k of keys) {
      if (!(k in before)) out.push({ path: `${path}.${k}`, before: undefined, after: after[k] })
      else if (!(k in after)) out.push({ path: `${path}.${k}`, before: before[k], after: undefined })
      else diffJson(before[k], after[k], `${path}.${k}`, out)
    }
    return out
  }
  if (before !== after) out.push({ path, before, after })
  return out
}

/** 差异落在哪个模块：路径第二段（`modules.<mod>...` / `pure.<mod>...`）。 */
export function moduleOf(path) {
  const m = /^\$\.(?:modules|pure)\.([a-z]+)/.exec(path)
  return m ? m[1] : '(非模块字段)'
}

const short = (v) => {
  const s = JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > 120 ? `${s.slice(0, 117)}...` : s
}

function libDirArg(argv) {
  const i = argv.indexOf('--lib')
  return i === -1 ? DEFAULT_LIB : resolve(PKG_ROOT, '..', '..', argv[i + 1])
}

/**
 * ⚠️ 比较前必须把「当前输出」过一遍 JSON 往返。
 *
 * fixture 是从磁盘读回来的 JSON，而 `buildSnapshot()` 返回的是**活对象**：里面可以有
 * `undefined`。`JSON.stringify(undefined)` 落在数组里会变成 `null`，于是同一份行为会
 * 报出一堆 `null -> undefined` 的假差异（实测：6 处差异里 5 处是它）。
 * 两边都过同一遍序列化，差异才只剩真的行为差异。
 */
const jsonRoundTrip = (v) => JSON.parse(JSON.stringify(v))

async function main() {
  const before = JSON.parse(readFileSync(BEFORE, 'utf8'))
  const after = jsonRoundTrip(await buildSnapshot(libDirArg(process.argv)))
  const diffs = diffJson(before, after)
  // 逐字段的差异是**最小报告**，它会把「一进一出」的两处变化压成同一个下标上的一处。
  // 所以另外印几组高信号投影，让「集合变了」这种东西不会被字段对齐藏起来。
  const projections = [
    ['drift 任务 id 序列', before.pure.drift.parseEntries.map((e) => e.index), after.pure.drift.parseEntries.map((e) => e.index)],
    [
      'amendments 守卫判定',
      before.modules.amendments.guardText.map((r) => `${r[0]}=${r[1]}`),
      after.modules.amendments.guardText.map((r) => `${r[0]}=${r[1]}`),
    ],
    [
      'signature 识别到的署名',
      before.modules.signature.checkSigned.signatures.map((x) => x.summary),
      after.modules.signature.checkSigned.signatures.map((x) => x.summary),
    ],
  ]
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(diffs, null, 2))
    return
  }
  for (const [label, b, a] of projections) {
    const same = JSON.stringify(b) === JSON.stringify(a)
    console.log(`${same ? '=' : '≠'} ${label}`)
    if (!same) {
      console.log(`      前: ${JSON.stringify(b)}`)
      console.log(`      后: ${JSON.stringify(a)}`)
    }
  }
  if (diffs.length === 0) {
    console.log('逐字段相同（0 处差异）')
    return
  }
  const byModule = new Map()
  for (const d of diffs) byModule.set(moduleOf(d.path), (byModule.get(moduleOf(d.path)) ?? 0) + 1)
  console.log(`${diffs.length} 处差异，按模块：${JSON.stringify(Object.fromEntries([...byModule.entries()].sort()))}`)
  for (const d of diffs) console.log(`  ${d.path}\n      前: ${short(d.before)}\n      后: ${short(d.after)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
