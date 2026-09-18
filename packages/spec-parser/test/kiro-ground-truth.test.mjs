// 1.2 —— 真机 ground truth。
//
// 三件事,每一件都是**独立**于「生成器」那条路径的核对：
//   ① 从 bundle 现读的四条 prefix 正则,与 plugins/dsh-spec 的逐字转写逐字符比对。
//      两条路径互相独立（一边是 Kiro 出厂 bundle，一边是本仓的转写），比只看一边强。
//   ② fixture 记录的 bundle 身份（bytes / sha256）与当前 bundle 一致——Kiro 升版必红。
//   ③ 用真机判定分支复算 fixture 的 kiroBin 列,逐条比对。
//
// 真机不在时以带原因的 t.skip 记录，不得静默 return（第 1 期已实测过静默跳过会让最强的
// 那道断言在无 Kiro 的机器上无声消失）。**不得把真机结论硬编码成布尔**：正则必须现读。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { kiroBinFor } from './tools/difference-matrix.mjs'
import { loadKiroBranch } from './tools/kiro-branch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'difference-matrix.json'), 'utf8'))
const DSH_SOURCE = join(HERE, '..', '..', '..', 'plugins', 'dsh-spec', 'lib', 'index.js')

// bundle 只在模块加载时读一次；读不到不该让整个文件崩，而是让每条断言显式 skip。
let branch = null
let branchFailure = null
try {
  branch = loadKiroBranch()
} catch (error) {
  branchFailure = error
}

const skipWithoutBundle = (t) => {
  if (!branchFailure) return false
  t.skip(`真机 bundle 不可用，本次不核真机列：${branchFailure.message}`)
  return true
}

const CONSTANTS = {
  d: 'KIRO_TASK_TOP_RE',
  p: 'KIRO_TASK_SUB_RE',
  f: 'KIRO_CHECKBOX_RE',
  h: 'KIRO_MALFORMED_CHECKBOX_RE',
}

// 真机结论的**手写锚点**：与生成器无关、与 bundle 解析无关。
//
// 下面那条「复算 kiroBin 列」的断言是拿同一个 judgeTasksSection 生成又校验的 —— 它抓得住
// fixture 被手改或 bundle 换版，抓不住 judgeTasksSection 自己写错（两者会一起错、一起绿）。
// 故把最关键的那几条结论另外写死在这里。
const HAND_ANCHORED = {
  A1: [{ verdict: 'ok' }],
  A2: [{ verdict: 'malformed-checkbox' }, { verdict: 'malformed-checkbox' }],
  B: [{ verdict: 'ok' }, { verdict: 'ok' }],
  C: [{ verdict: 'invalid-task-line' }],
  D: [{ verdict: 'invalid-task-line' }],
  E: [{ taskLines: [3] }, { taskLines: [3, 5] }],
  F: [{ taskLines: [3, 5] }],
}

describe('真机 bundle 的四条正则与 bundle 身份', () => {
  it('与 plugins/dsh-spec/lib/index.js 的逐字转写逐字符相同', (t) => {
    if (skipWithoutBundle(t)) return
    const source = readFileSync(DSH_SOURCE, 'utf8')
    for (const [key, constant] of Object.entries(CONSTANTS)) {
      const found = new RegExp(`^const ${constant} = /(.*)/$`, 'm').exec(source)
      assert.ok(found, `dsh-spec 里找不到 ${constant}`)
      assert.equal(
        branch.sources[key],
        found[1],
        `${constant} 与真机 bundle 的正则不再逐字相同——两边已有一边被改过`,
      )
    }
  })

  it('fixture 记录的 bundle 身份等于当前 bundle', (t) => {
    if (skipWithoutBundle(t)) return
    // 这条红了 = Kiro 升版了。**下一步不是「重跑生成器」** —— 那会连 rows 一起改写。
    //
    // 2026-09-16 从 1.0.794 升到 1.1.28 时实测踩到过：生成器对「探针三列与已入库 fixture
    // 不一致」fail loud，而当时**真的不一致** —— 变的却是 dsh / kiro 两列（宿主解析器的历史
    // 快照），不是 kiroBin（唯一由 bundle 派生的列）。原因是两个宿主此后被接线到了共享包，
    // 于是快照列落到了归并后的值（`scan-lines.js` 的围栏语义、`task-format.js` 的
    // 「B/C 归并到状态合法即成任务」）。生成器自己的守卫注释就写着这种情况
    // 「重生成等于改写『抽取前』这份历史证据。此时不该重跑本脚本」。
    //
    // 所以正确的收口是：**先用探针复算一遍 kiroBin 列，逐行比对**。
    //   · kiroBin 有变 → 规则判定真变了，复核差异表并在 commit message 里写明；
    //   · kiroBin 没变、只有 dsh/kiro 漂 → 升版与差异表无关，**只更新 kiroBundle 这一处身份戳**，
    //     rows 一个字节都不许动（它是历史证据）。
    // 无论哪种，都不要给生成器加 --force。
    assert.equal(
      FIXTURE.kiroBundle.sha256,
      branch.bundle.sha256,
      'Kiro 升版了：先复算并逐行比对 kiroBin 列（见本用例注释），再决定改什么；**不要**直接重跑生成器',
    )
    assert.equal(FIXTURE.kiroBundle.bytes, branch.bundle.bytes)
  })

  it('bundle 的 tasks 校验路径里没有任何围栏状态', (t) => {
    if (skipWithoutBundle(t)) return
    // E / F 两行判为 repo-convention 的全部依据就是这一条：真机没有围栏概念。
    // 窗口按**函数边界**切（最近一个 function 起点 → 下一个 function 起点），不再用固定
    // 字符数 —— 固定窗口的末尾会落在无关规则表中间，既可能被无关文本打破，也可能漏掉窗口外的
    // 真实围栏逻辑。
    const text = readFileSync(branch.bundle.path, 'utf8')
    const anchor = text.indexOf(branch.sources.d)
    assert.ok(anchor > 0, '找不到判定分支的锚点')
    const start = text.lastIndexOf('function', anchor)
    const end = text.indexOf('function', anchor + 1)
    assert.ok(start > 0 && start < anchor, '没能定位到承载判定分支的函数起点')
    assert.ok(end > anchor, '没能定位到该函数的结束边界')
    const body = text.slice(start, end)
    assert.equal(body.includes('fence'), false, '真机 tasks 校验路径里出现了 fence —— E/F 的依据需重核')
    assert.equal(body.includes('Fence'), false, '真机 tasks 校验路径里出现了 Fence —— E/F 的依据需重核')
  })
})

describe('fixture 的 kiroBin 列由真机判定复算得出', () => {
  for (const row of FIXTURE.rows) {
    it(`${row.id}`, (t) => {
      if (skipWithoutBundle(t)) return
      for (const specimen of row.specimens) {
        const tag = row.kind === 'line' ? specimen.text : specimen.name
        assert.deepEqual(kiroBinFor(row.kind, specimen, branch), specimen.kiroBin, `${row.id} · ${tag}`)
      }
    })
  }
})

describe('真机结论的手写锚点（独立于生成器与 bundle 解析）', () => {
  for (const [id, expected] of Object.entries(HAND_ANCHORED)) {
    it(`${id}`, () => {
      const entry = FIXTURE.rows.find((row) => row.id === id)
      assert.ok(entry, `fixture 里没有 ${id}`)
      assert.equal(entry.specimens.length, expected.length, `${id} 的样本数与手写锚点数不一致`)
      entry.specimens.forEach((specimen, index) => {
        const want = expected[index]
        if ('verdict' in want) {
          assert.equal(specimen.kiroBin.verdict, want.verdict, `${id}[${index}] 的真机结论`)
        } else {
          assert.deepEqual(specimen.kiroBin.taskLines, want.taskLines, `${id}[${index}] 真机认下的任务行`)
        }
      })
    })
  }

  it('七行都被锚住（避免将来新增行时漏锚）', () => {
    assert.deepEqual(Object.keys(HAND_ANCHORED).sort(), FIXTURE.rows.map((row) => row.id).sort())
  })
})
