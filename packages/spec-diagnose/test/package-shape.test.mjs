// Task 4（建包）—— 包的形状契约：**依赖恰好两个**、零 `node:fs` / `node:path`、恒不抛、单向依赖。
//
// 这几条都是「实现遵守了但没人守」的典型：一个多余的依赖、一次 `node:fs` 导入、一条反向
// import，都不会让任何功能测试变红，却会让「纯函数裁决层」这个定位破产。
//
// 与第 3 期 `packages/spec-parser/test/package-shape.test.mjs` 的区别：spec-parser 的契约是
// 「零 runtime 依赖」，本包**有两个**允许的依赖（kiro-rules 的规则表 + spec-parser 的扫描层），
// 故断言反过来写：必须**恰好**是那两条，多一条少一条都红。

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { diagnose } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const WORKSPACE_ROOT = join(PACKAGE_ROOT, '..', '..')
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const LIB_FILES = readdirSync(join(PACKAGE_ROOT, 'lib')).filter((name) => name.endsWith('.js'))

const ALLOWED_DEPS = ['@my-harness/kiro-rules', '@my-harness/spec-parser']

describe('Task 4 — 包的形状', () => {
  it('private + type: module + test 脚本', () => {
    assert.equal(MANIFEST.private, true)
    assert.equal(MANIFEST.type, 'module')
    assert.equal(MANIFEST.scripts.test, 'node --test test/*.test.mjs')
  })

  it('依赖**恰好**是 kiro-rules 与 spec-parser', () => {
    assert.deepEqual(Object.keys(MANIFEST.dependencies ?? {}).sort(), [...ALLOWED_DEPS].sort())
    assert.equal('devDependencies' in MANIFEST, false, '本包不该有 devDependencies')
  })

  it('exports 的 "." 指向 lib/index.js 且文件存在', () => {
    assert.equal(MANIFEST.exports['.'], './lib/index.js')
    assert.doesNotThrow(() => readFileSync(join(PACKAGE_ROOT, MANIFEST.exports['.']), 'utf8'))
  })
})

// 静态扫描的**全部**取 import 形态。评审改正：原先只匹配 `from '...'`，于是
// `import('node:fs')`（动态）与 `import 'node:fs'`（裸）都绕过门禁——实测把
// `export const probeIo = () => import("node:fs")` 追加到 lib/finding.js 之后，
// 这条门禁仍然报 pass 10 / fail 0，而 node:fs 确实可达。
const IMPORT_SOURCES = [
  /from\s+['"]([^'"]+)['"]/g, // import x from '...'  /  export ... from '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // import('...')
  /(?:^|[;\s])import\s+['"]([^'"]+)['"]/g, // 裸 import '...'
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // require('...')
]

function importedSources(source) {
  const found = []
  for (const re of IMPORT_SOURCES) {
    for (const match of source.matchAll(re)) found.push(match[1])
  }
  return found
}

describe('Task 4 — 零 I/O', () => {
  it('lib/ 下每个文件都不导入 node:fs / node:path / node:os / node:child_process', () => {
    assert.ok(LIB_FILES.length > 0)
    const banned = ['node:fs', 'node:fs/promises', 'node:path', 'node:os', 'node:child_process']
    for (const name of LIB_FILES) {
      const source = readFileSync(join(PACKAGE_ROOT, 'lib', name), 'utf8')
      for (const spec of importedSources(source)) {
        assert.ok(
          !banned.includes(spec),
          `lib/${name} 导入了 ${spec} —— 裁决层必须是零 I/O 的纯函数层`,
        )
      }
    }
  })

  it('取 import 的四种形态都被覆盖（否则上面那条可以被绕过）', () => {
    // 自检：把四种形态各喂一条，必须全部被抽出。这条防的是「扫描器本身写窄了」。
    const sample = [
      "import a from 'x1'",
      "const b = await import('x2')",
      "import 'x3'",
      "const c = require('x4')",
      "export { d } from 'x5'",
    ].join('\n')
    const got = importedSources(sample)
    for (const want of ['x1', 'x2', 'x3', 'x4', 'x5']) {
      assert.ok(got.includes(want), `扫描器漏了 ${want}（实得 ${JSON.stringify(got)}）`)
    }
  })

  it('lib/ 下只 import 两个允许的包（含子路径），外加包内相对路径', () => {
    const isAllowed = (spec) => ALLOWED_DEPS.some((dep) => spec === dep || spec.startsWith(`${dep}/`))
    for (const name of LIB_FILES) {
      const source = readFileSync(join(PACKAGE_ROOT, 'lib', name), 'utf8')
      for (const spec of importedSources(source)) {
        if (spec.startsWith('./') || spec.startsWith('../')) continue
        assert.ok(isAllowed(spec), `lib/${name} 导入了 ${spec} —— 不在允许的两个依赖里`)
      }
    }
  })
})

describe('Task 4 — 单向依赖', () => {
  const readManifest = (rel) => JSON.parse(readFileSync(join(WORKSPACE_ROOT, rel), 'utf8'))
  const libSources = (rel) =>
    readdirSync(join(WORKSPACE_ROOT, rel)).filter((n) => n.endsWith('.js') || n.endsWith('.mjs'))

  it('kiro-rules 不反向依赖本包', () => {
    const manifest = readManifest('packages/kiro-rules/package.json')
    assert.equal('@my-harness/spec-diagnose' in (manifest.dependencies ?? {}), false)
    for (const name of libSources('packages/kiro-rules/lib')) {
      const source = readFileSync(join(WORKSPACE_ROOT, 'packages/kiro-rules/lib', name), 'utf8')
      assert.equal(source.includes('spec-diagnose'), false, `kiro-rules/lib/${name} 提到了 spec-diagnose`)
    }
  })

  it('spec-parser 不反向依赖本包', () => {
    const manifest = readManifest('packages/spec-parser/package.json')
    assert.equal('@my-harness/spec-diagnose' in (manifest.dependencies ?? {}), false)
    for (const name of libSources('packages/spec-parser/lib')) {
      const source = readFileSync(join(WORKSPACE_ROOT, 'packages/spec-parser/lib', name), 'utf8')
      assert.equal(source.includes('spec-diagnose'), false, `spec-parser/lib/${name} 提到了 spec-diagnose`)
    }
  })
})

describe('Task 4 — 恒不抛', () => {
  it('任意畸形输入都不抛，只返回 finding 列表', () => {
    const inputs = [
      undefined, null, 42, 0, NaN, true, false, '', {}, [], () => {}, Symbol('x'),
      Buffer.from('x'), new Map(), '# X\n', { toString() { throw new Error('boom') } },
    ]
    inputs.forEach((markdown, index) => {
      for (const artifact of ['requirements', 'design', 'tasks', 'bugfix', 'designBugfix', 'nope', undefined, 1]) {
        assert.doesNotThrow(
          () => diagnose({ artifact, markdown, profile: {}, strictTaskState: true }),
          `第 ${index} 号畸形输入配 artifact=${String(artifact)} 时抛了`,
        )
      }
      assert.doesNotThrow(() => diagnose({ artifact: 'tasks', markdown, profile: null }), `第 ${index} 号畸形输入抛了`)
    })
  })

  it('畸形 profile 不抛，且把 overrides 只当 severity 用', () => {
    for (const profile of [null, 42, 'x', [], { conventions: 'not-an-array' }, { overrides: [] }, { optOuts: 5 }]) {
      assert.doesNotThrow(() => diagnose({ artifact: 'tasks', markdown: '# Implementation Plan\n', profile }))
    }
    const overridden = diagnose({
      artifact: 'tasks',
      markdown: '# Implementation Plan\n',
      profile: { overrides: { 'tasks/missing-tasks-section': 'error' } },
    }).find((f) => f.code === 'tasks/missing-tasks-section')
    assert.equal(overridden.severity, 'error')
    assert.equal(overridden.source, 'kiro-binary', 'overrides 不得改变 source')
  })

  it('optOuts 按码关闭，且只关被点名的码', () => {
    const base = diagnose({ artifact: 'tasks', markdown: '# Implementation Plan\n' })
    const opted = diagnose({ artifact: 'tasks', markdown: '# Implementation Plan\n', profile: { optOuts: ['tasks/missing-overview'] } })
    assert.equal(opted.some((f) => f.code === 'tasks/missing-overview'), false)
    assert.equal(opted.length, base.length - 1)
  })
})
