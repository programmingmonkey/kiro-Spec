// `## Task Dependency Graph` 的定位判据 —— 钉住 2026-09-18 第 6.1 条缺陷。
//
// 🔴 缺陷原貌：两个消费者（spec-state 的 `index.mjs` 与 `core/analysis.mjs`）各自手写了
// 一条正则，都用「空白」连接标题与 json 围栏：
//     /## Task Dependency Graph\s*\n\s*```json\s*\n([\s\S]*?)\n```/m
// 于是标题与围栏之间只要有一行正文，匹配就失败、waves 退化为 []，**且没有任何 warning**。
// 而消费项目的 spec-conventions.md §3.1 **强制**每个 `##` 下一行写 `> 中文副标题`
// （Kiro 诊断器按 `## English` 做 exact match，中文只能挪进引用块）。实测该仓 208 份
// tasks.md 里 165 份踩中 —— 79% 的 DAG 对执行器不可见，执行器无声退化为逐任务串行。
//
// 本文件的中心是两条，缺一不可：
//   ① **合规写法必须能读出图**（缺陷的正面）；
//   ② **读不出图时必须出声**（缺陷真正的杀伤点 —— 错误的并行语义比报错难发现得多）。
// 所以每个否定用例都同时断言 `waves` 为空**和** `warnings` 非空；只断言前者的话，
// 回退到「静默退化」的实现照样能通过，这条网就等于没有。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { locateWavesJson, wavesFromMarkdown } from '../lib/waves.js'

const HEADING = '## Task Dependency Graph'
const GRAPH = '{"waves":[{"id":0,"tasks":["1.1"]},{"id":1,"tasks":["2.1"]}]}'
const fence = (body) => ['```json', body, '```'].join('\n')
const doc = (...lines) => lines.join('\n')

describe('① 合规写法能读出图', () => {
  it('§3.1 的 `> 中文副标题` 写法 —— 这正是缺陷报告里 165/208 份 spec 的形状', () => {
    const markdown = doc(HEADING, '', '> 任务依赖图', '', fence(GRAPH))
    const { waves, warnings } = wavesFromMarkdown(markdown)
    assert.deepEqual(waves, [{ id: 0, tasks: ['1.1'] }, { id: 1, tasks: ['2.1'] }])
    assert.deepEqual(warnings, [], '合规写法不该产生 warning')
  })

  it('不带副标题的写法（修复前唯一能命中的那种）没有退化', () => {
    const { waves, warnings } = wavesFromMarkdown(doc(HEADING, '', fence(GRAPH)))
    assert.equal(waves.length, 2)
    assert.deepEqual(warnings, [])
  })

  it('标题与围栏之间隔着多段正文也照样读得到', () => {
    const markdown = doc(HEADING, '', '> 任务依赖图', '', '说明：按写同一文件的任务必须分到不同 wave 排布。', '', fence(GRAPH))
    assert.equal(wavesFromMarkdown(markdown).waves.length, 2)
  })

  it('图之后还有别的 section 不影响读取', () => {
    const markdown = doc(HEADING, '', '> 任务依赖图', '', fence(GRAPH), '', '## Notes', '', '- 2026-09-18 · 某人')
    assert.equal(wavesFromMarkdown(markdown).waves.length, 2)
  })

  it('wave 的 id 被原样保留 —— `spec_task_plan(scope="wave")` 按 id 而非下标查找', () => {
    const markdown = doc(HEADING, '', '> 任务依赖图', '', fence('{"waves":[{"id":7,"tasks":["1.1"]}]}'))
    assert.deepEqual(wavesFromMarkdown(markdown).waves, [{ id: 7, tasks: ['1.1'] }])
  })
})

describe('② 读不出图时必须出声（静默退化是本缺陷的杀伤点）', () => {
  const silentlyDegrades = {
    '标题在、但段内没有 json 围栏': doc(HEADING, '', '> 任务依赖图', '', '（图待补）'),
    '围栏未闭合': doc(HEADING, '', '```json', '{"waves":[]}'),
    'JSON 坏了': doc(HEADING, '', '> 任务依赖图', '', fence('{waves:}')),
    'waves 是空数组': doc(HEADING, '', fence('{"waves":[]}')),
    'json 围栏落在下一个 ## 之后（不许跨节去绑）': doc(HEADING, '', '> 任务依赖图', '', '## Notes', '', fence(GRAPH)),
  }

  for (const [name, markdown] of Object.entries(silentlyDegrades)) {
    it(`${name} → waves 为空**且**有 warning`, () => {
      const { waves, warnings } = wavesFromMarkdown(markdown)
      assert.deepEqual(waves, [], `${name}：不该读出图`)
      assert.equal(warnings.length, 1, `${name}：退化必须出声，否则错误的并行语义无人可见`)
      assert.match(warnings[0], /sequential/, 'warning 要说清后果是退化为串行')
    })
  }

  it('压根没有这一节 → 不出 warning（那是「没有图」，由 kiro-rules 在校验期报，不是这里的噪声）', () => {
    const { waves, warnings } = wavesFromMarkdown(doc('## Tasks', '', '- [ ] 1. 做一件事'))
    assert.deepEqual(waves, [])
    assert.deepEqual(warnings, [])
  })
})

describe('边界：不许把别处的 json 当成产线图', () => {
  it('围栏里写着的 `## Task Dependency Graph` 不算标题', () => {
    const markdown = doc('## Notes', '', '````md', HEADING, fence('{"waves":[{"id":0,"tasks":["9.9"]}]}'), '````')
    const { waves, warnings } = wavesFromMarkdown(markdown)
    assert.deepEqual(waves, [], '示例代码块里的图不是产线图')
    assert.deepEqual(warnings, [], '它连标题都不算，所以也不该报退化')
  })

  it('locateWavesJson 交回的是围栏体本身，不含定界行', () => {
    const located = locateWavesJson(doc(HEADING, '', '> 任务依赖图', '', fence(GRAPH)))
    assert.equal(located.json, GRAPH)
    assert.equal(located.headingLine, 1)
  })
})
