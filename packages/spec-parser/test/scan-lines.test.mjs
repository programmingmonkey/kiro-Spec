// 2.1 —— 扫描层的契约(先红:../lib/scan-lines.js 尚不存在)。
//
// 钉住的中心是一条:围栏只有**一个**事实源。差异表 E / F 两行的归并全部押在这上面——
// 若 scanLines 与 scanTaskLines 各判一套,归并就只到得了宿主的一半,而 dsh 的任务计数
// 走的正是 scanLines。
//
// 文档样本取差异矩阵的 E / F 两行(真机在这两行上没有围栏概念,故权威是本仓约定)。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { computeFenceState, hasFenceClose, hasUnterminatedFence, nextFenceMarker, scanLines, scanTaskLines } from '../lib/scan-lines.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'difference-matrix.json'), 'utf8'))

const row = (id) => FIXTURE.rows.find((entry) => entry.id === id)
const E_DOCS = row('E').specimens
const F_DOCS = row('F').specimens

const taskLineNumbers = (markdown) => {
  const { syntaxes } = scanTaskLines(markdown, { strictTaskState: false })
  return syntaxes.flatMap((syntax, index) => (syntax?.kind === 'task' ? [index + 1] : []))
}

describe('形状与历史契约', () => {
  it('scanLines 返回 {raw, inFence}[],长度等于行数', () => {
    const markdown = '## Tasks\n- [ ] 1. a\n'
    const lines = scanLines(markdown)
    assert.equal(lines.length, markdown.split('\n').length)
    assert.deepEqual(Object.keys(lines[0]).sort(), ['inFence', 'raw'])
    assert.equal(lines[1].raw, '- [ ] 1. a')
  })

  it('scanTaskLines 返回 {lines, syntaxes}', () => {
    const result = scanTaskLines('## Tasks\n- [ ] 1. a\n', { strictTaskState: false })
    assert.ok(Array.isArray(result.lines))
    assert.ok(Array.isArray(result.syntaxes))
    assert.equal(result.syntaxes[1]?.kind, 'task')
  })
})

describe('围栏只有一个事实源', () => {
  // 期望值对着**文档形状**写死，而不是让两个调用互相比 —— 后者是恒真的：computeFenceState
  // 与 scanLines 都从同一个 scanFence 派生，除非有人重写 scanLines，那条断言不可能失败。
  // 写死的这三行也是「围栏取 kiro 的缩进式语义」这一决定的可读样本。
  const EXPECTED_IN_FENCE = {
    'fence-indent4-unclosed': [false, false, false, false],
    'fence-indent4-closed': [false, false, false, false, false, false],
    'fence-4ticks-closed-by-3': [false, true, true, true, true, true],
  }

  it('每份围栏文档的 inFence 列等于写死的期望值（scanLines 与 computeFenceState 两个视图）', () => {
    for (const { name, text } of [...E_DOCS, ...F_DOCS]) {
      const want = EXPECTED_IN_FENCE[name]
      assert.ok(want, `fixture 里出现了清单外的文档 ${name} —— 请补期望值，别让它悄悄不被检查`)
      assert.deepEqual(scanLines(text).map((line) => line.inFence), want, name)
      assert.deepEqual(computeFenceState(text.split('\n')), want, `${name}（computeFenceState 投影）`)
    }
  })

  it('模块里只有一处围栏侦测（源码结构近似检查）', () => {
    // Property 8 的另一半是「不存在第二条围栏判定路径」——那是源码结构性质，行为断言强制不了。
    // 这里用一次近似检查：围栏正则与扫描函数各只应有一处定义。它抓不住「换个名字写第二套」，
    // 但能抓住最可能发生的形态（复制一份扫描器）。
    const source = readFileSync(join(HERE, '..', 'lib', 'scan-lines.js'), 'utf8')
    assert.equal((source.match(/const FENCE_RE = /g) ?? []).length, 1, '围栏正则出现了不止一处')
    assert.equal((source.match(/function scanFence\(/g) ?? []).length, 1, '扫描器出现了不止一处')
  })

  it('scanTaskLines 跳过的行,正是 scanLines 标为 inFence 的行', () => {
    for (const { text } of [...E_DOCS, ...F_DOCS]) {
      const fenced = scanLines(text)
        .map((line, index) => (line.inFence ? index + 1 : null))
        .filter(Boolean)
      const { syntaxes } = scanTaskLines(text, { strictTaskState: false })
      for (const lineNumber of fenced) {
        assert.equal(syntaxes[lineNumber - 1], undefined, `第 ${lineNumber} 行在围栏内却仍被判定`)
      }
    }
  })

  it('hasUnterminatedFence 与同一状态一致', () => {
    assert.equal(hasUnterminatedFence('## Tasks\n```\n- [ ] 1. a\n'), true)
    assert.equal(hasUnterminatedFence('## Tasks\n```\n- [ ] 1. a\n```\n'), false)
    assert.equal(hasUnterminatedFence('## Tasks\n- [ ] 1. a\n'), false)
  })
})

describe('E / F 两行归并到 kiro 的缩进式围栏语义', () => {
  // 方向是 2026-09-12 执行期订正的：原设计要统一到 dsh 的无条件语义，但那会改
  // plugins/codex-spec/lib/core/revision.mjs 的哈希（approval fingerprint），而
  // codex-spec/test/revision-state.test.mjs:127/162/171/189 正钉着 E / F 的这些形态。
  it('E：缩进 4 且无可认闭合时不认作围栏，故围栏内那行被计入 —— 与真机完全一致', () => {
    assert.deepEqual(taskLineNumbers(E_DOCS[0].text), [3])
    assert.deepEqual(taskLineNumbers(E_DOCS[1].text), [3, 5])
  })

  it('E：那两行都不触发未闭合围栏探针（它们压根没被认成围栏）', () => {
    for (const { name, text } of E_DOCS) {
      assert.equal(hasUnterminatedFence(text), false, name)
    }
  })

  it('F：闭合 run 长度须 >= 开 run，故 3 个反引号闭不掉 4 个 —— 后续行不计入（比真机少判两行）', () => {
    assert.deepEqual(taskLineNumbers(F_DOCS[0].text), [])
  })

  it('F：该少算必须由 warning 探针可见（这是需求 3.5 的成立条件）', () => {
    assert.equal(hasUnterminatedFence(F_DOCS[0].text), true, '围栏未闭合却没有触发探针 —— 少算会变静默')
  })
})

describe('revision 用的那两个原语，默认策略必须是 strict', () => {
  // `plugins/codex-spec/lib/core/revision.mjs` 直接调用 nextFenceMarker / hasFenceClose 来算
  // approval fingerprint，而它在移植前调用的是 kiro 的 strict 语义。第一次移植时我把
  // hasFenceClose 内部的 parseTaskLine 传成了 dsh 策略，于是这个形状下判定翻转 —— 这条断言
  // 就是那次回归的守卫：`[~]` 行在 strict 下不是任务，故不得短路掉「闭合判定」。
  const DOC = ['- [ ] 1. parent', '    ````', '- [~] 1.1 x', '    ````']

  it('hasFenceClose 默认按 strict 判定（与移植前一致）', () => {
    const marker = nextFenceMarker(DOC[1], undefined, [0])
    assert.equal(marker, '````', '锚点：缩进 4 且已有缩进 0 的任务，marker 应当返回')
    assert.equal(
      hasFenceClose(DOC, 1, marker),
      true,
      '`[~]` 行在 strict 下不是任务，不该让 hasFenceClose 提前返回 false —— 语义被改过就会红',
    )
  })

  it('显式传 dsh 策略时才走另一条判定（这是 scanFence 的既有耦合）', () => {
    const marker = nextFenceMarker(DOC[1], undefined, [0])
    assert.equal(hasFenceClose(DOC, 1, marker, { strictTaskState: false }), false)
  })
})
