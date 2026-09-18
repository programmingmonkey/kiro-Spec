// Task 1 —— 冻结快照的**证据性**断言（不是 golden 钉死）。
//
// 覆盖旧套件到不了的路径：这五个模块在旧套件里**只**经 `mount()` + `call('spec_*')` 被驱动
// （见 `fixtures/assertion-map.json`：45 条全部 not-movable）。这个文件第一次直接驱动它们，
// 用内存 port（`test/tools/memory-port.mjs`），并覆盖旧断言完全不碰的输入：
// `- [ ] 1.foo` 形态、`- [ ]* 1.2` 形态、空 `#### Acceptance Criteria`、`suppressSeverity`
// 的全阶梯、`renderSignature` 的三个拒绝分支、`port.move` 缺失时的复制降级。
//
// ⚠️ **这个文件刻意不把 fixture 与「当前实现」绑死。** Task 0.3 判定为收敛的那三处是
// **有意的行为变更**，用 `--check` 把快照钉在当前实现上，只会让那三处变更变成红灯——
// 那是把验收动作写成了恒真/恒假的断言。快照的前后比对是 Task 3.4 的**验收动作**，
// 证据落在提交正文里；这里只断言「快照本身不是空壳」与「生成器可重跑且无副作用」。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { buildSnapshot, corpusTree } from './tools/gen-behaviour-snapshot.mjs'
import { memoryPort, omitMove, snapshotTree } from './tools/memory-port.mjs'
import { locateModules } from './tools/locate-modules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const FIXTURE = join(PKG_ROOT, 'test', 'fixtures', 'behaviour-snapshot.json')

const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'))

describe('Task 1.3 — 生成器无副作用，且可重跑', () => {
  it('import 生成器不写任何文件（在**子进程**里按 mtime 实测，不靠读码推断）', () => {
    // ⚠️ 必须在子进程里测。本文件顶部已经静态 import 了生成器，于是 `await import(...)`
    // 只会命中 ESM 缓存、什么都不执行 —— 那样这条断言**恒真**（而且 `before` 也是在静态
    // import 之后才取的，即使生成器顶层真写盘也已经发生在它之前）。子进程是一张新的模块图。
    const before = statSync(FIXTURE).mtimeMs
    execFileSync('node', ['-e', "await import('./test/tools/gen-behaviour-snapshot.mjs')"], {
      cwd: PKG_ROOT,
      stdio: 'pipe',
    })
    assert.equal(statSync(FIXTURE).mtimeMs, before, 'import 生成器改动了 fixture 的 mtime')
    // 反向自检:子进程这条路本身必须真的在跑 —— 让它 import 一个不存在的模块，必须非零退出。
    assert.throws(() =>
      execFileSync('node', ['-e', "await import('./test/tools/__no-such__.mjs')"], { cwd: PKG_ROOT, stdio: 'pipe' }),
    )
  })

  it('同一份实现上连跑两次，逐字节相同', async () => {
    // 位置解析集中在 test/tools/locate-modules.mjs：五个模块在搬移前后**恰好**在一处，
    // 两个都在（搬到一半）或都不在（模块丢了）都会抛。
    const dir = locateModules()
    const a = JSON.stringify(await buildSnapshot(dir))
    const b = JSON.stringify(await buildSnapshot(dir))
    assert.equal(a, b, '同一实现两次生成的快照不同，说明产物里混进了与行为无关的字段')
  })

  it('产物里不含 libDir 与时间戳（否则前后两份会因为无关字段不等）', () => {
    const text = readFileSync(FIXTURE, 'utf8')
    assert.ok(!/libDir/.test(text), '产物里出现了 libDir')
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), '产物里出现了 ISO 时间戳')
  })
})

describe('Task 1.1 — 改造前的工具面事实', () => {
  it('记录了 13 个工具与 1 个 command', () => {
    const s = fixture()
    assert.equal(Object.keys(s.toolSurface.tools).length, 13)
    assert.deepEqual(s.toolSurface.commands, ['spec'])
  })
})

describe('Task 1.2 — 快照不是空壳：冲突形态确实被行使了', () => {
  it('drift 在改造前漏掉 `- [ ] 1.foo`（共享层判为任务，drift 的窄正则看不见）', () => {
    const s = fixture()
    const ids = s.pure.drift.parseEntries.map((e) => e.index)
    assert.ok(ids.includes('1.1'), '语料里的 `- [ ]* 1.1` 没被 drift 看见，语料没起到作用')
    // `- [ ] 1.foo` 收敛后会以 id `1` 出现；改造前 drift 看不见它，
    // 所以 id `1` 只出现一次（来自 `- [ ] 1. 分组标签`）。
    assert.equal(ids.filter((i) => i === '1').length, 1, '语料里 `- [ ] 1.foo` 的改造前状态变了')
  })

  it('amendments 的守卫在改造前**不认** `- [ ]* 1.2`（就是语料上那 44 行的洞）', () => {
    const s = fixture()
    const byLabel = Object.fromEntries(s.modules.amendments.guardText.map(([label, verdict, refused]) => [label, [verdict, refused]]))
    assert.deepEqual(byLabel['glued-id'], ['REFUSED', true], '粘连 id 在改造前必须被拒')
    assert.deepEqual(byLabel['star-subtask'], ['ACCEPTED', null], '取子任务记法在改造前应当被放行——这正是那个洞')
    assert.deepEqual(byLabel['plain'], ['REFUSED', true], '普通任务行在改造前就必须被拒')
  })

  it('署名扫描在改造前看不见缩进 4 的围栏内的署名，但看得见 CRLF 结尾的那条', () => {
    const s = fixture()
    const summaries = s.modules.signature.checkSigned.signatures.map((x) => x.summary)
    assert.ok(summaries.includes('冻结快照的语料'), 'tasks.md 的 ## Notes 署名没被识别')
    assert.ok(summaries.includes('CRLF 结尾的署名'), 'CRLF 署名在改造前就应当被识别（它的 scanLines 剥了 \\r）')
    assert.ok(
      !summaries.includes('缩进 4 的围栏内的署名'),
      '缩进 4 那一例在改造前应当被隐藏——收敛后由 Task 3.5 登记为显式行为变更',
    )
    assert.ok(
      !summaries.includes('平衡围栏内的署名（两侧都不该看见）'),
      '平衡围栏内的署名**永远**不该被识别',
    )
  })

  it('只读模块一次 writeText 都没调（比「前后 hash 相同」更直接）', () => {
    const s = fixture()
    assert.equal(s.modules.checklist.port.writes, 0)
    assert.equal(s.modules.drift.port.writes, 0)
    assert.equal(s.modules.signature.port.signedWrites, 0)
    assert.equal(s.modules.signature.port.unsignedWrites, 0)
    // 只读模块的 readText 确实被调过——否则上面那三个 0 可能只是因为根本没跑。
    assert.ok(s.modules.checklist.port.reads >= 2, 'checklist 一次都没读，快照是空的')
    assert.ok(s.modules.drift.port.reads >= 2, 'drift 一次都没读，快照是空的')
  })

  it('归档缺 `move` 时走复制且不删源（母计划写明的降级语义，本期第一次有断言）', () => {
    const s = fixture()
    assert.equal(s.modules.archive.withMove.sourceRemoved, true)
    assert.equal(s.modules.archive.withoutMove.sourceRemoved, false)
    assert.equal(s.modules.archive.withoutMove.filesCopied, 1)
    assert.match(s.modules.archive.withoutMove.note, /was NOT removed/)
    // 「不删源」不能只看字段：源文件必须还在。
    assert.ok(
      Object.keys(s.modules.archive.withoutMoveTree).some((p) => p.startsWith('/specs/legacy/')),
      '复制降级后源文件消失了',
    )
  })

  it('内存 port 的 move 真的搬了目录（对照组：否则上面的降级断言可能两边都一样）', () => {
    const s = fixture()
    assert.ok(
      !Object.keys(s.modules.archive.withMoveTree).some((p) => p.startsWith('/specs/legacy/')),
      'withMove 之后源还在，说明 move 没生效',
    )
    assert.ok(Object.keys(s.modules.archive.withMoveTree).some((p) => p.startsWith('/specs/_archive/legacy/')))
  })
})

describe('内存 port 自身的语义（它是所有包级测试的地基，值得单独钉）', () => {
  it('readText 对不存在的文件返回 undefined 而不是抛', async () => {
    const port = memoryPort({ '/a/b.md': 'x' })
    assert.equal(await port.readText('/a/missing.md'), undefined)
  })

  it('listDir 只返回直接子项并带 type', async () => {
    const port = memoryPort({ '/a/b.md': 'x', '/a/c/d.md': 'y' })
    const entries = await port.listDir('/a')
    assert.deepEqual(
      entries.map((e) => [e.name, e.type]),
      [
        ['b.md', 'file'],
        ['c', 'directory'],
      ],
    )
  })

  it('omitMove 之后 move 不再是函数，其余方法原样保留', async () => {
    const port = omitMove(memoryPort({ '/a/b.md': 'x' }))
    assert.equal(typeof port.move, 'undefined')
    assert.equal(await port.readText('/a/b.md'), 'x')
  })

  it('snapshotTree 逐文件记录，可替代「前后 hash 相同」', async () => {
    const port = memoryPort({ '/a/b.md': 'x' })
    const before = snapshotTree(port)
    await port.readText('/a/b.md')
    assert.deepEqual(snapshotTree(port), before)
  })
})

describe('语料本身：Task 0.3 要收敛的三种形态都在里面', () => {
  it('语料含 `- [ ]* `、`- [ ] * `、`- [ ] N.foo`、`- [ ] N.Nfoo`、`- [x]* `', () => {
    // ⚠️ 断言**语料数据**，不是生成器的源码文本。
    // 早先这一条 grep 的是 `gen-behaviour-snapshot.mjs` 的源码 —— 那样它会在形状只出现在
    // 注释里、或语料改由别的代码路径拼出来的时候照样通过。生成器导出了 `corpusTree()`，
    // 直接断言它拼出来的文本才是真的。
    const tasks = corpusTree()['/specs/demo/tasks.md']
    assert.ok(typeof tasks === 'string' && tasks.length > 0, '语料里没有 demo 的 tasks.md')
    for (const shape of ['- [ ]* 1.1', '- [ ] * 1.2', '- [ ] 2.foo', '- [ ] 1.2foo', '- [x]* 2.1']) {
      assert.ok(tasks.includes(shape), `语料里缺 ${shape}——收敛后快照不会动，比对就证明不了什么`)
    }
    // 反面:语料里**不该**有的形状也要说清楚,免得有人「顺手补全」把对照搞乱。
    assert.ok(!tasks.includes('- [x] 1.1foo'), '语料里混进了未声明的形状')
  })
})
