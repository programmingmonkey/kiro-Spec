// 「合法署名行」必须与「合法执行事件块」同类：都是协议标记，都不算语义。
//
// 由来（`spec-sign-approval-clobber`，bugfix Requirement 2.x）：消费项目 §4.3.2 要求
// 「改 spec 正文后在 tasks.md 的 ## Notes 留一行署名」，而 DSH 侧把它做成了**独立工具**
// `spec_sign`。于是署名是一次**事后追加**，而 `computeApprovalFingerprint` 只剥执行事件块、
// 不剥署名 —— 一次合法署名被当成实质语义变更，触发 `observe()` 的 `state.approvals = {}`：
// 兄弟宿主上整份 spec 的审批被清空、phase 从 implementing 退回 tasks_draft。
//
// 本文件钉住三件事，缺一不可：
//   ① 合法署名不改变指纹（修复前**必红**，这是本次变更唯一的判别力来源）；
//   ② 形似署名但**不合法**的行必须继续改变指纹（否则「伪造一行像署名的东西」就成了
//      不提请重新审批的改写通道 —— 那是 fail-open，比原缺陷更危险）；
//   ③ **围栏内**的署名行不受豁免（否则往示例代码块里加一行也变成不可见改动，同为 fail-open）。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeApprovalFingerprint, computeRawRevision } from '../lib/revision.mjs'

/** 顶层 `- <date> · <env> · <summary>`，与 §4.3.2 的渲染结果逐字符同形。 */
const VALID_LINE = '- 2026-09-14 · DSH · 补 Req 1 的属性值域'

/** 与 `insertSignatureInto` 在「## Notes 是最后一节」时的落法一致：先裁尾空行，再 `line + ''`。 */
function appendToNotes(markdown, line) {
  const body = markdown.replace(/\s+$/, '')
  return `${body}\n${line}\n`
}

const TASKS = [
  '# Implementation Plan',
  '',
  '## Tasks',
  '',
  '- [ ] 1. Widget',
  '  - [ ] 1.1 Build it',
  '    - _Requirements: 1.1_',
  '',
  '## Notes',
  '',
  '> 备注',
  '',
].join('\n')

const fp = (markdown, strictTaskState = false) =>
  computeApprovalFingerprint({ artifact: 'tasks', markdown, strictTaskState })

describe('合法署名行是协议标记，不是语义（Req 2.1 / 2.3 / 2.4）', () => {
  it('🔴 追加一行合法署名不得改变 approvalFingerprint —— 修复前这条必红', () => {
    const before = fp(TASKS)
    const after = fp(appendToNotes(TASKS, VALID_LINE))
    assert.equal(
      after,
      before,
      '合法署名改变了审批指纹：它会被 observe() 判成 external_change_detected，清空整份 spec 的审批',
    )
  })

  it('对照：追加一行**非**署名散文仍然改变指纹（豁免不能过宽）', () => {
    assert.notEqual(fp(TASKS), fp(appendToNotes(TASKS, '> 顺手补一句解释')))
  })

  it('署名一定改变 rawRevision（dual-hash 的另一半不受影响）', () => {
    assert.notEqual(
      computeRawRevision(TASKS),
      computeRawRevision(appendToNotes(TASKS, VALID_LINE)),
    )
  })
})

describe('形似而不合法的行**不得**获得豁免（Req 2.3 —— 防止 fail-open）', () => {
  // 🔴 **豁免判据 = `parseSignatureLine`**，也就是全仓「什么算署名」的唯一定义
  //（`checkAttribution` 用它、`parseSignatures` 用它）。刻意**不**用更严的
  // `isValidSignatureLine`：那个还额外要求列 0、`- ` 形式、且 Claude 必须含
  // `Cowork`。若按它豁免，`###` 形式与嵌套缩进的历史署名就豁免不到，缺陷会在那些形态上
  // 静默残留 —— 而"同一个词两处两个定义"正是本仓库反复记过的那类缺陷。
  //
  // 因此下面这些**不是**合法署名（形状不达解析器标准），必须继续改变指纹：
  const ILLEGAL = [
    ['未知 env', '- 2026-09-14 · Cursor · 补 Req 1'],
    ['env 不在白名单（小写）', '- 2026-09-14 · dsh · 补 Req 1'],
    ['日期不是 ISO', '- 26-09-14 · DSH · 补 Req 1'],
    ['缺尾部分隔符与 summary', '- 2026-09-14 · DSH ·'],
    ['summary 只有空白', '- 2026-09-14 · DSH ·    '],
    ['用竖线当分隔符', '- 2026-09-14 | DSH | 补 Req 1'],
    ['用冒号当分隔符', '- 2026-09-14: DSH: 补 Req 1'],
    ['不是列表项也不是标题', '2026-09-14 · DSH · 补 Req 1'],
  ]

  for (const [label, line] of ILLEGAL) {
    it(`${label} 仍然改变指纹`, () => {
      assert.notEqual(
        fp(appendToNotes(TASKS, line)),
        fp(TASKS),
        `${label} 被当成署名豁免了 —— 这会让一行伪装文本绕过审批失效`,
      )
    })
  }

  // ⚠️ 两条**实测出来的**边界，写在这里是为了让下一个人不必重新发现：
  //   · 日期只校验形状（`YYYY-MM-DD`），**不校验是不是真实历日** —— `2026-13-45` 会被识别；
  //   · Claude 通道的 `Cowork` 要求住在渲染面与消费项目严格识别器里，解析器不管。
  // 两者都**沿用解析器既有语义**（改它会让 `checkAttribution` 也变，属另一件事），
  // 所以它们确实会被豁免 —— 下面是"把这件事钉住"而不是"把它当正确"。
  it('日期只校验形状：2026-13-45 与合法日期一样被豁免（解析器既有语义）', () => {
    assert.equal(fp(appendToNotes(TASKS, '- 2026-13-45 · DSH · 补 Req 1')), fp(TASKS))
  })

  it('历史 Gemini 署名被豁免（语料里有真实的历史署名，解析面刻意留着它）', () => {
    assert.equal(fp(appendToNotes(TASKS, '- 2026-09-14 · Gemini · 旧底座')), fp(TASKS))
  })

  it('Claude 缺 Cowork 仍被豁免 —— 那一条要求不在解析器的判据里', () => {
    assert.equal(
      fp(appendToNotes(TASKS, '- 2026-09-14 · Claude · 补 Req 1')),
      fp(TASKS),
      '若这条改成 notEqual，就说明豁免判据被换成了更严的消费项目识别器（会让 ### 形式漏掉）',
    )
  })
})

describe('围栏内的署名行不受豁免（Req 2.4 —— 否则示例代码块里的改动会隐身）', () => {
  const WITH_FENCED = TASKS.replace('> 备注', ['> 备注', '', '示例：', '', '```markdown', VALID_LINE, '```'].join('\n'))
  const WITH_EMPTY_FENCE = TASKS.replace('> 备注', ['> 备注', '', '示例：', '', '```markdown', '', '```'].join('\n'))

  it('🔴 围栏**内**加一行形如署名的示例，必须改变指纹', () => {
    assert.notEqual(
      fp(WITH_FENCED),
      fp(WITH_EMPTY_FENCE),
      '围栏内的示例行被当成真署名剥掉了 —— 往代码块里加一行就成了不可见改动',
    )
  })

  it('围栏**外**的合法署名仍然被豁免（不能因为怕围栏就把豁免整个关掉）', () => {
    assert.equal(fp(appendToNotes(WITH_EMPTY_FENCE, VALID_LINE)), fp(WITH_EMPTY_FENCE))
  })
})

describe('实质变更照旧敏感（Req 3.1 / 3.2）', () => {
  it('改任务标题必须改变指纹', () => {
    assert.notEqual(fp(TASKS), fp(TASKS.replace('Build it', 'Build it properly')))
  })

  it('合法 checkbox 切换不得改变指纹', () => {
    assert.equal(fp(TASKS), fp(TASKS.replace('- [ ] 1.1', '- [x] 1.1')))
  })
})
