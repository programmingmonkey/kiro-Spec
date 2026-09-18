// Task 5.3(A ⊆ B 名集合检查)—— **记录性**工具，不是门槛。
//
// 计划把它写成 R2-1 的处置:改造前 dsh-spec 的全部测试名构成 A,改造后 dsh-spec ∪
// spec-analysis 构成 B,断言 A ⊆ B。但本期**一条断言都没搬**(45 条行为断言全部经
// `mount()` + `call('spec_*')`,被测对象是装配层,搬不动),所以这个检查在本期是**空转**的:
// 什么都不搬,集合当然包含。
//
// 因此:
//   · 它**不作门槛** —— 一条不可能因为要防的原因而失败的断言,是装饰;
//   · 但它的**结果要落档**,因为下一期若真的开始搬断言,这条检查就该立刻变成门槛;
//   · 唯一保留的硬要求是「那条唯一搬走的断言,名字逐字保留」—— 见下面的 `MOVED`。
//
// A 从 git 里取(`d1d7678` = 搬移前那一笔),B 从工作区取。两边都只用**源码里的名字**:
// 运行时的实例数会因循环与跳过而不同,名字才是「这条断言还在不在」的载体。
//
// 用法: node test/tools/name-set-check.mjs [--json]

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

const PRE_CHANGE_REV = 'd1d7678'
const DSH_TEST_DIR = 'plugins/dsh-spec/test'

/** 那条唯一搬走的断言:名字必须逐字保留在同一批文件里。 */
export const MOVED = ['${mod}.js has no executable write call']

/** 从源码里抽 `it(` / `test(` 的名字字面量(单引号、双引号、反引号)。 */
export function testNames(source) {
  const out = new Set()
  for (const m of source.matchAll(/^\s*(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/gm)) out.add(m[2])
  return out
}

function namesFromGit(rev, dir) {
  const files = execFileSync('git', ['-C', REPO_ROOT, 'ls-tree', '-r', '--name-only', rev, '--', dir], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.test.mjs'))
  const names = new Map()
  for (const file of files) {
    const src = execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:${file}`], { encoding: 'utf8' })
    for (const n of testNames(src)) names.set(n, file)
  }
  return { files: files.length, names }
}

function namesFromWorktree(dir, glob = /\.test\.mjs$/) {
  const names = new Map()
  let files = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'tools') continue
        walk(full)
      } else if (glob.test(e.name)) {
        files += 1
        for (const n of testNames(readFileSync(full, 'utf8'))) names.set(n, full.slice(REPO_ROOT.length + 1))
      }
    }
  }
  walk(dir)
  return { files, names }
}

export function buildReport() {
  const a = namesFromGit(PRE_CHANGE_REV, DSH_TEST_DIR)
  const dshNow = namesFromWorktree(join(REPO_ROOT, DSH_TEST_DIR))
  const analysisNow = namesFromWorktree(join(PKG_ROOT, 'test'))
  const b = new Map([...dshNow.names, ...analysisNow.names])
  const missing = [...a.names.keys()].filter((n) => !b.has(n))
  const added = [...b.keys()].filter((n) => !a.names.has(n))
  return {
    preChangeRev: PRE_CHANGE_REV,
    a: { files: a.files, names: a.names.size },
    b: { dshFiles: dshNow.files, analysisFiles: analysisNow.files, names: b.size },
    subset: missing.length === 0,
    missing,
    addedCount: added.length,
    movedNamesPresent: MOVED.map((n) => [n, b.has(n)]),
  }
}

function main() {
  const r = buildReport()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  console.log(`A(改造前 dsh-spec, ${r.preChangeRev}) = ${r.a.names} 个名字 / ${r.a.files} 个文件`)
  console.log(`B(dsh-spec ${r.b.dshFiles} 文件 ∪ spec-analysis ${r.b.analysisFiles} 文件) = ${r.b.names} 个名字`)
  console.log(`A ⊆ B: ${r.subset ? '成立' : `不成立 —— 缺 ${r.missing.length} 个: ${JSON.stringify(r.missing)}`}`)
  console.log(`B 里新增的名字:${r.addedCount} 个`)
  for (const [name, present] of r.movedNamesPresent) console.log(`搬走的那条名字仍在 B 里:${name} -> ${present}`)
  console.log('注:本期一条断言都没搬,所以 A ⊆ B 是**空转**成立的,不作门槛(Req 5.3)。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
