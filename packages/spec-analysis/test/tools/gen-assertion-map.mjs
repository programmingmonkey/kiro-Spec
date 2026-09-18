// Task 0.1 —— 断言分布清单的**生成器**（不是手写清单）。
//
// 母计划把本期写成「Move: 对应的 5 个测试文件」。实测仓库里**没有**按模块命名的测试
// 文件：五个模块（checklist / drift / amendments / archive / signature）的覆盖散在
// `plugins/dsh-spec/test/` 的 5 个既有文件里。所以本期不是搬文件，是从混合文件里**择**
// 断言——择漏了不会红，只会少测（R2-1）。这份清单要先把「有哪些条、各自测什么、能不能
// 整体搬」变成可复核的数据，再据此选搬移策略。
//
// 分类口径（先写死，再看数；见任务级计划 Task 0.1 Step 3）：
//
//   movable      这条断言只依赖某个模块自身（含它的源码文本），搬进 packages/spec-analysis
//                仍成立。判据：主体不经过 dsh-spec 的工具装配层（mount/call/harness）。
//   not-movable  这条断言依赖 dsh-spec 的插件装配 / 工具层（mount + call('spec_*')），
//                搬走就没了被测对象。留在原地。
//   needs-split  同一条断言里既有「模块级」又有「装配级」的观测（或同时压两个模块），
//                搬一半会丢一半。
//
// ⚠️ 归属（module）是**推断**不是事实：仓库里没有任何测试 import 这五个模块（实测
// `grep -n "from '.*(checklist|drift|amendments|archive|signature)\.js'"` 零命中），
// 所以归属只能从「它调的是哪个 spec_* 工具」和「它读的是哪个模块的源码」反推。
// 推断规则全部写进产物的 `rules` 字段，便于复核；不确定的一律记 null，不硬猜。
//
// 生成器无副作用：顶层零写入，`--check` 只比较，写入只在 isMain 守卫内。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const OUT = join(PKG_ROOT, 'test', 'fixtures', 'assertion-map.json')

// 🔴 改造前的源码从 **git 里**取，不从工作区取 —— 与 `probe-conflicts.mjs` 同一口径。
//
// 为什么：这份清单的用途是**Task 0 的判定依据**（「可整体搬 / 不可搬 / 需拆 各多少条，
// 以及据此选哪条策略」）。搬移之后工作区里那 5 个文件已经**不再是**判定时看的那一版
// （`capabilities.test.mjs` 里被搬走的那条静态守卫就是实例），继续读工作区会让这份
// fixture 与 `design.md` 的判定表对不上：实测 movabal 会从 1 变成 0、总 it 从 130 变成 129。
// 不可重跑、且与文档不一致的 fixture，不是证据。
const PRE_CHANGE_REV = 'd1d7678'

// 五个被搬的模块 → 消费它的工具名 / 源码文件名。三张表的键必须一致。
const MODULES = ['checklist', 'drift', 'amendments', 'archive', 'signature']
const TOOL_OF = {
  checklist: 'spec_checklist',
  drift: 'spec_drift',
  amendments: 'spec_amend',
  archive: 'spec_archive',
  signature: 'spec_sign',
}

const FILES = [
  'boundaries.test.mjs',
  'capabilities.test.mjs',
  'pure.test.mjs',
  'regression-live-fire.test.mjs',
  'tool-surface.test.mjs',
]

// ---------------------------------------------------------------------------
// 极小源码扫描器：抽出 describe / it 的树 + 每个 it 的函数体文本。
// 不引第三方 parser：只用花括号配平，够用且可审计。
// ---------------------------------------------------------------------------

/** 从 `text[from]` 处的 `(` 开始，返回配对 `)` 的下标。 */
function matchParen(text, openIndex) {
  let depth = 0
  let i = openIndex
  let quote = null
  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 2
      else {
        if (ch === quote) quote = null
        i += 1
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** 取 `(...)` 的第一个字符串字面量（describe/it 的名字）。 */
function firstStringLiteral(text) {
  const m = /^\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(text)
  return m ? m[2] : null
}

/** 收集 `describe(` / `it(` 调用，带嵌套深度与行号。 */
function collectCalls(text) {
  const out = []
  const re = /\b(describe|it)\s*\(/g
  let m
  while ((m = re.exec(text)) !== null) {
    // 行首非空白处只允许 describe/it（避免命中 `assert.ok(it(` 之类的假阳性）
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    const prefix = text.slice(lineStart, m.index)
    if (prefix.trim() !== '') continue
    const openIndex = m.index + m[0].length - 1
    const closeIndex = matchParen(text, openIndex)
    if (closeIndex === -1) continue
    const args = text.slice(openIndex + 1, closeIndex)
    const name = firstStringLiteral(args)
    out.push({
      kind: m[1],
      name,
      start: m.index,
      end: closeIndex + 1,
      argsStart: openIndex + 1,
      line: text.slice(0, m.index).split('\n').length,
    })
  }
  // 嵌套：为每个 it 找最近的、包住它的 describe 链
  for (const call of out) {
    call.ancestors = out
      .filter((d) => d.kind === 'describe' && d.start < call.start && d.end > call.end)
      .map((d) => d.name)
  }
  return out
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

const ASSEMBLY_RE = /\bcall\s*\(/
// 读模块源码文本（capabilities 的静态只读守卫）：execFileSync('cat', [`lib/${mod}.js`])
const SOURCE_READ_RE = /execFileSync\(\s*['"]cat['"]/

/**
 * 归属信号，按强度排列。**只看函数体**，不看文件顶部 import：
 * 一条断言「测什么」由它运行时干了什么决定，不由它所在文件 import 了什么决定。
 *   `call('<tool>'` / 体里出现带引号的工具名  → 该工具对应的模块
 *   `for (const mod of ['checklist','drift'])` + 体里读 `lib/${mod}.js` → 那几个模块
 * 都不命中 → 归属为 null（不硬猜）。
 */
function attribute(body, fileText) {
  const evidence = []
  const mods = new Set()

  const mentioned = MODULES.filter((mod) => new RegExp(`['"]${TOOL_OF[mod]}['"]`).test(body))
  for (const mod of mentioned) {
    mods.add(mod)
    evidence.push(`mentions-tool:${TOOL_OF[mod]}`)
  }

  if (SOURCE_READ_RE.test(body) && body.includes('lib/${mod}.js')) {
    // 模块名单在 it 之外的 `for (const mod of [...])` 里，必须从整个文件取。
    const loop = /for\s*\(\s*const\s+mod\s+of\s*\[([^\]]*)\]/.exec(fileText)
    const listed = loop ? [...loop[1].matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]) : []
    for (const mod of listed.filter((m) => MODULES.includes(m))) {
      mods.add(mod)
      evidence.push(`source-scan:${mod}`)
    }
  }

  return { modules: [...mods], evidence, sourceScan: evidence.some((e) => e.startsWith('source-scan:')) }
}

function classify({ body, fileText }) {
  const { modules: mentioned, evidence, sourceScan } = attribute(body, fileText)
  // 「运行时有没有真的动过它」是硬门槛：只是把工具名写进一份清单（注册面断言、
  // 遍历清单的参数断言）不算覆盖到该模块。这类断言归 dsh-spec 的工具面，不属本期。
  const exercises = ASSEMBLY_RE.test(body) || sourceScan

  let category
  let modules = []
  let mentions = mentioned
  if (sourceScan) {
    // 静态读模块源码：模块级断言，可以搬（路径相对于包根，搬后仍成立）。
    category = ASSEMBLY_RE.test(body) ? 'needs-split' : 'movable'
    modules = mentioned
    mentions = []
  } else if (exercises && mentioned.length > 0) {
    // 驱动了某个 spec_* 工具：装配级断言语境，搬走就没有被测对象。
    category = 'not-movable'
    modules = mentioned
    mentions = []
  } else {
    // 其余一律不算本期模块的覆盖——包括「调的是别的工具」和「只把名字写进清单」。
    category = 'not-attributable'
  }

  return { modules, mentions, category, evidence }
}

/** 改造前那一版测试文件文本（从 git blob 取，取不到即抛）。 */
export function preChangeSource(name) {
  return execFileSync('git', ['-C', REPO_ROOT, 'show', `${PRE_CHANGE_REV}:plugins/dsh-spec/test/${name}`], {
    encoding: 'utf8',
  })
}

export function buildAssertionMap() {
  const files = FILES.map((name) => {
    const text = preChangeSource(name)
    const calls = collectCalls(text)
    const its = calls
      .filter((c) => c.kind === 'it')
      .map((c) => {
        const body = c.argsStart >= 0 ? text.slice(c.argsStart, c.end - 1) : ''
        const { modules, mentions, category, evidence } = classify({ body, fileText: text })
        return {
          file: name,
          line: c.line,
          name: c.name,
          describes: c.ancestors ?? [],
          modules,
          // 弱信号：只是被列进清单（工具面断言），运行时没真的驱动它。
          mentions,
          category,
          evidence,
        }
      })
    return { file: name, itCount: its.length, tests: its }
  })

  const totals = { movable: 0, 'not-movable': 0, 'needs-split': 0, 'not-attributable': 0 }
  const perModule = Object.fromEntries(MODULES.map((m) => [m, { movable: 0, 'not-movable': 0, 'needs-split': 0 }]))
  for (const f of files) {
    for (const t of f.tests) {
      totals[t.category] = (totals[t.category] ?? 0) + 1
      for (const m of t.modules) {
        if (t.category in perModule[m]) perModule[m][t.category] += 1
      }
    }
  }

  return {
    schemaVersion: 1,
    rev: PRE_CHANGE_REV,
    state: 'pre-change（Task 0.1 的判定基准；搬移与收敛之前那一版 dsh-spec 测试文件）',
    about:
      `Task 0.1 的断言分布清单：plugins/dsh-spec/test 的 5 个混合文件里，每一条 it 测的是哪个模块、以及它能不能整体搬进 packages/spec-analysis。由 test/tools/gen-assertion-map.mjs 从 git blob ${PRE_CHANGE_REV} 现读生成（不是工作区那一版），勿手改。`,
    rules: {
      movable: '主体不经过 dsh-spec 的插件装配层，只依赖某个模块自身（含其源码文本）。',
      'not-movable': '依赖插件装配 / 工具层（mount + call(spec_*)），搬走就没有被测对象。',
      'needs-split': '同一条断言里既有模块级又有装配级观测。',
      'not-attributable': '五个模块都不涉及——五个文件里大部分断言属于解析器 / 规则表 / 工具面，与本期的搬移无关。',
      moduleAttribution:
        '归属只看函数体（不看文件顶部 import）：① 体里出现带引号的 spec_* 工具名 → 该模块；② 体里读 lib/${mod}.js → 该文件里 for (const mod of [...]) 列出的模块。都不命中则 modules 为空。每条命中的信号记在 evidence 里，可逐条复核。',
    },
    totals,
    perModule,
    files,
  }
}

function main() {
  const mode = process.argv[2] ?? '--write'
  const map = buildAssertionMap()
  const text = `${JSON.stringify(map, null, 2)}\n`
  if (mode === '--check') {
    const current = readFileSync(OUT, 'utf8')
    if (current !== text) {
      console.error('assertion-map.json 与生成器不一致——重新生成并复核差异')
      process.exit(1)
    }
    console.log('assertion-map.json 与生成器一致')
    return
  }
  writeFileSync(OUT, text)
  console.log(`wrote ${OUT}`)
  console.log(JSON.stringify(map.totals, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
