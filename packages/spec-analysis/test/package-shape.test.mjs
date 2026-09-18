// Task 2.3 —— 包的形状契约：零文件系统访问、依赖面、导出面、畸形输入不抛。
//
// 这四条都是「实现遵守了但没人守」的典型：一个 `node:fs` import 会立刻把「I/O 全部注入」
// 变成一句空话，一个多余的 `dependencies` 会让分层破产，一个丢掉的导出会让宿主的 import
// 在运行时才炸 —— 而这三者都不会让任何**行为**测试变红。
//
// 旧套件到不了的路径：整个 dsh-spec 套件里**没有一条**断言「包的形状」——零依赖、
// exports 齐全、lib/ 下零 node:fs/node:path。这三条都是「实现遵守了但没人守」的形态：
// 破坏它们不会让任何行为测试变红，只会在别的宿主导入时才炸。
//
// 过渡态处理：五个模块在 Task 4.1 之前还住在插件里。本文件对**当前位置**做断言
// （`test/tools/locate-modules.mjs` 是唯一的位置解析点），所以它在搬移前后都是非空断言，
// 而不是「找不到就跳过」。

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { memoryPort } from './tools/memory-port.mjs'
import {
  MODULES,
  PACKAGE_LIB,
  PKG_ROOT,
  describeLocations,
  importSpecifiers,
  locateModules,
  moduleLocations,
  modulePath,
} from './tools/locate-modules.mjs'

const MANIFEST = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
const PKG_ROOT_TEST = join(PKG_ROOT, 'test')

// 位置解析自己做一次自检：五个模块必须完整地在一处，否则后面每条断言都在测空气。
const MODULE_DIR = locateModules()

describe('零文件系统访问（Requirement 1.2）', () => {
  it('lib/ 下的每个模块只 import 共享包，不 import node:fs / node:path', () => {
    for (const mod of MODULES) {
      const source = readFileSync(modulePath(mod), 'utf8')
      const specifiers = importSpecifiers(source)
      const offenders = specifiers.filter((s) => s === 'node:fs' || s === 'node:path' || s.startsWith('node:fs/'))
      assert.deepEqual(offenders, [], `${mod}.js 导入了 ${offenders.join(', ')}；I/O 必须全部走注入的 port`)
    }
  })

  it('唯一的 import 目标只可能是共享包或包内相对路径（依赖方向单向）', () => {
    for (const mod of MODULES) {
      const source = readFileSync(modulePath(mod), 'utf8')
      const specifiers = importSpecifiers(source)
      for (const s of specifiers) {
        assert.ok(
          s === '@my-harness/spec-parser' || s.startsWith('@my-harness/spec-parser/') || s.startsWith('./'),
          `${mod}.js 出现了计划外的依赖 ${s}`,
        )
      }
    }
  })

  it('lib/ 下的 JS 文件恰好是那五个（没有偷偷加进来的第六个）', () => {
    const js = readdirSync(PACKAGE_LIB)
      .filter((n) => n.endsWith('.js'))
      .sort()
    assert.deepEqual(js, MODULES.map((m) => `${m}.js`).sort())
  })

  it('五个模块只存在于**一处**：插件里不再留副本（搬到一半会两边都有）', () => {
    const { where } = moduleLocations()
    assert.deepEqual(
      MODULES.filter((m) => where[m].plugin),
      [],
      '插件里还留着副本 —— 那就又有了两份实现',
    )
    assert.deepEqual(
      MODULES.filter((m) => !where[m].pkg),
      [],
      '本包里缺模块',
    )
  })
})

describe('依赖面与导出面（Requirement 1.1）', () => {
  it('dependencies 恰好是 @my-harness/spec-parser（多一个都算分层破产）', () => {
    assert.deepEqual(Object.keys(MANIFEST.dependencies ?? {}), ['@my-harness/spec-parser'])
  })

  it('不存在反向依赖：spec-parser / kiro-rules 不依赖本包', () => {
    const parser = JSON.parse(readFileSync(join(PKG_ROOT, '..', 'spec-parser', 'package.json'), 'utf8'))
    const rules = JSON.parse(readFileSync(join(PKG_ROOT, '..', 'kiro-rules', 'package.json'), 'utf8'))
    assert.equal(parser.dependencies?.['@my-harness/spec-analysis'], undefined)
    assert.equal(rules.dependencies?.['@my-harness/spec-analysis'], undefined)
  })

  it('exports 的键恰好是五个模块，没有聚合入口（不造第二个权威）', () => {
    assert.deepEqual(Object.keys(MANIFEST.exports).sort(), MODULES.map((m) => `./${m}`))
    assert.equal(MANIFEST.main, undefined, 'main 会暗示存在一个聚合入口')
  })

  it('exports 的每个目标都指向真实文件', () => {
    // 这条断言原先写成「过渡期允许缺失、搬完后必须存在」的两支形态。搬移完成后
    // 第一支已经不可达 —— 留着它会让读者以为两种状态都还活着，而其中一支是死代码。
    // 现在只剩一条真不变量：五个目标全部可读。
    for (const mod of MODULES) {
      const target = MANIFEST.exports[`./${mod}`]
      assert.doesNotThrow(() => readFileSync(join(PKG_ROOT, target), 'utf8'), `${target} 不存在`)
    }
  })
})

describe('畸形输入不抛（Requirement 1.4 的边界）', () => {
  // 五个模块的读入口之一是「文本进来、结论出去」，它们对畸形文本必须是容忍的：
  // 抛出去会让一个坏字符炸掉整份 spec 的检查。**写入口**是另一回事——它们靠抛错来拒绝
  // （`archive:` / `amendments:` / `appendSignature:` 前缀），那是有意的 loud failure。
  const tolerant = [
    ['checklist.evaluateChecklist()', (m) => m.checklist.evaluateChecklist()],
    ['checklist.evaluateChecklist({})', (m) => m.checklist.evaluateChecklist({})],
    ['evaluateChecklist 文本是数字', (m) => m.checklist.evaluateChecklist({ requirementsText: 123, tasksText: [] })],
    ['checklistRules()', (m) => m.checklist.checklistRules()],
    ['drift.parseTaskEntries(undefined)', (m) => m.drift.parseTaskEntries(undefined)],
    ['drift.parseTaskEntries(数字)', (m) => m.drift.parseTaskEntries(42)],
    ['drift.isFrozen(undefined)', (m) => m.drift.isFrozen(undefined)],
    ['drift.isFrozen({})', (m) => m.drift.isFrozen({})],
    ['drift.buildDriftReport({})', (m) => m.drift.buildDriftReport({})],
    ['drift.driftRecommendations()', (m) => m.drift.driftRecommendations()],
    ['drift.suppressSeverity(未知档)', (m) => m.drift.suppressSeverity('nope', true)],
    ['signature.parseSignatures(undefined)', (m) => m.signature.parseSignatures(undefined)],
    ['signature.parseSignatureLine(数字)', (m) => m.signature.parseSignatureLine(7)],
    ['signature.isSignatureEnv(undefined)', (m) => m.signature.isSignatureEnv(undefined)],
    ['signature.joinPath(undefined)', (m) => m.signature.joinPath(undefined)],
  ]

  it(`${tolerant.length} 条纯入口对畸形输入一律返回而不抛`, async () => {
    const m = {}
    for (const mod of MODULES) m[mod] = await import(modulePath(mod))
    for (const [label, fn] of tolerant) {
      assert.doesNotThrow(() => fn(m), `${label} 抛了`)
    }
  })

  it('写入口抛的是**自己的**错误（带模块前缀），不是 TypeError', async () => {
    const m = {}
    for (const mod of MODULES) m[mod] = await import(modulePath(mod))
    const cases = [
      ['archive.archiveSpec 无 port', () => m.archive.archiveSpec({ port: {}, specDir: '/s/x', archiveRoot: '/s/_archive' }), /archive: port\.readText is required/],
      ['archive.archiveSpec 无参数', () => m.archive.archiveSpec({}), /archive: `specDir` must be a non-empty absolute path/],
      // 端口齐备（用内存 port），这样才走到 `_archive/` 那条守卫；空 port 会先在
      // requirePort 上失败 —— 那是另一条断言，不该靠它冒充这一条。
      ['archive 已归档目录', () => m.archive.archiveSpec({ port: memoryPort({}), specDir: '/s/_archive/x', archiveRoot: '/s/_archive' }), /already under _archive/],
      ['amendments.applyParamEdit 无 port', () => m.amendments.applyParamEdit({ port: {}, dir: '/s/demo', file: 'requirements', from: 'a', to: 'b' }), /amendments: port\.readText is required/],
      ['amendments 目标文件是 tasks', () => m.amendments.assertNotTaskBody('tasks'), /Refusing to write a task body/],
      ['amendments 目录在 _archive', () => m.amendments.applyParamEdit({ port: {}, dir: '/s/_archive/demo', file: 'requirements', from: 'a', to: 'b' }), /under _archive/],
      ['signature.appendSignature 无 port', () => m.signature.appendSignature({ port: {}, dir: '/s/demo', summary: 'x' }), /appendSignature: cannot read/],
      ['signature 未知环境', () => m.signature.renderSignature({ env: 'Nobody', summary: 'x' }), /unknown env/],
      ['signature 日期格式错', () => m.signature.renderSignature({ date: '2026/09/12', summary: 'x' }), /date must be YYYY-MM-DD/],
    ]
    for (const [label, fn, pattern] of cases) {
      await assert.rejects(async () => fn(), pattern, label)
    }
  })
})

describe('Requirement 5.4 — 每个新测试文件都要写明它覆盖了旧套件到不了的哪条路径', () => {
  // Req 5.4 的原话是「在新测试文件里写明」——那是一句**承诺**。本仓库的规矩是：
  // 任何可被跳过的分支/承诺都必须有断言，否则它会在第一次赶时间时消失。
  // 标记取「旧套件到不了」这五个字，因为它在这批文件的头部本来就反复出现。
  it('test/*.test.mjs 每个文件的头部都写了「旧套件到不了」', () => {
    const files = readdirSync(PKG_ROOT_TEST).filter((n) => n.endsWith('.test.mjs'))
    assert.ok(files.length >= 8, `只扫到 ${files.length} 个测试文件 —— 扫描逻辑本身可能坏了`)
    const missing = files.filter((n) => !readFileSync(join(PKG_ROOT_TEST, n), 'utf8').split('\n').slice(0, 22).join('\n').includes('旧套件到不了'))
    assert.deepEqual(missing, [], `这些新测试文件没有写明自己补的是哪条空白：${missing.join(', ')}`)
  })
})

describe('位置状态本身要被打印出来（否则过渡态是隐形的）', () => {
  it('locateModules 解析成功，且位置描述可读', () => {
    assert.equal(typeof describeLocations(), 'string')
    assert.ok(describeLocations().length > 0)
    assert.ok(MODULE_DIR === PACKAGE_LIB || MODULE_DIR.endsWith('plugins/dsh-spec/lib'))
  })
})
