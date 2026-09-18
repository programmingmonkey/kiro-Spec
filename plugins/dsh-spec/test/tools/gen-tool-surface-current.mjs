// 当前工具面快照的生成器（Task 4.1）。
//
// 为什么要**另起**一个文件而不是往 `tool-surface-baseline.json` 里补签名：
// 那份文件的 `note` 原文说的是「8 个工具 + 1 个 command 在 dsh-spec-advancement **之前**
// 的样子……`addedBy` 的工具是新的，必须在基线集合**之外**同时存在」。它是一份**历史不变量**，
// `addedBy` 只有名字**正是因为**那五个工具不属于改造前的基线。给它们在那份文件里补上签名，
// 会让它的 `note` 变成假话，并把两件不同的东西（历史不变量 vs 当前工具面快照）混成一个文件。
//
// 两份并存，各自有 `note` 说明用途，断言分两组：
//   ① 对 baseline 的 8 + 1 做历史不变量校验（tool-surface.test.mjs）
//   ② 对 current 的 13 个做逐字段回归（同一个文件）
//
// 生成器无副作用：顶层零写入，写入只在 isMain 守卫内。`--check` 只比较。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mount } from '../harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'fixtures', 'tool-surface-current.json')

/**
 * 把插件挂起来，读它**实际注册**了什么。
 *
 * 用的是与 `tool-surface.test.mjs` 同一个 `mount()`，所以 fixture 与断言看的是同一个世界；
 * 手抄一份签名表就等于造第二权威。
 */
export function currentSurface() {
  const { tools, commands } = mount('/tmp')
  const out = { tools: {}, commands: [...commands.keys()].sort() }
  for (const [name, def] of [...tools.entries()].sort()) {
    const props = def.parameters?.properties ?? {}
    out.tools[name] = {
      params: Object.keys(props).sort(),
      required: [...(def.parameters?.required ?? [])].sort(),
    }
  }
  return out
}

const NOTE = [
  'CURRENT tool surface: all 13 tools + 1 command, measured after the phase-2 extraction.',
  'This is NOT the historical invariant — that one lives in `tool-surface-baseline.json` and',
  'must keep recording only the 8 + 1 that existed BEFORE dsh-spec-advancement.',
  'Assertions read both files in two groups: (1) baseline 8 + 1 must be unchanged field by',
  'field; (2) these 13 must match field by field. `addedBy` in the baseline carries names only',
  'on purpose; its signatures belong here, not there.',
].join(' ')

export function buildFixture() {
  return { note: NOTE, ...currentSurface() }
}

function main() {
  const text = `${JSON.stringify(buildFixture(), null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error('tool-surface-current.json 与当前注册面不一致——重新生成并复核差异')
      process.exit(1)
    }
    console.log('tool-surface-current.json 与当前注册面一致')
    return
  }
  writeFileSync(OUT, text)
  console.log(`wrote ${OUT}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
