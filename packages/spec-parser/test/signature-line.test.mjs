// 署名行识别器的判定矩阵。
//
// 这个模块第 8 期刚从 `@my-harness/spec-analysis` 搬来（理由见模块头部：审批指纹需要它，
// 但 `spec-revision → spec-analysis` 是反向边）。**搬家不改判据** —— 所以这份矩阵的作用
// 是把「搬家前后的判定完全相同」写成可执行的事实，而不是靠"我只是复制粘贴"这句自述。
//
// 它与 `packages/spec-analysis/test/signature-fences.test.mjs`（围栏族）和
// `signature-pin.test.mjs`（消费项目真源 pin）是三条**互补**的防线：
//   · 本文件 —— 单行判定矩阵，不涉及语料、不涉及围栏；
//   · 围栏族 —— 多行文档里"哪些行算数"；
//   · pin —— 判据本身有没有偏离消费项目的事实源。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PARSEABLE_ENVS, parseSignatureLine } from '../lib/signature-line.js'

describe('合法署名：应当被识别', () => {
  const VALID = [
    ['DSH 列表形', '- 2026-09-14 · DSH · 补 Req 1 的属性值域', { date: '2026-09-14', env: 'DSH', summary: '补 Req 1 的属性值域' }],
    ['Kiro', '- 2026-01-01 · Kiro · 初稿', { date: '2026-01-01', env: 'Kiro', summary: '初稿' }],
    ['Codex', '- 2026-01-01 · Codex · 对齐', { date: '2026-01-01', env: 'Codex', summary: '对齐' }],
    ['Claude（含 Cowork）', '- 2026-01-01 · Claude · Cowork；补充配额边界', { date: '2026-01-01', env: 'Claude', summary: 'Cowork；补充配额边界' }],
    ['Gemini（历史语料仍要能解析）', '- 2026-01-01 · Gemini · 旧底座', { date: '2026-01-01', env: 'Gemini', summary: '旧底座' }],
    ['分隔符两侧无空格', '- 2026-01-01·DSH·紧挨着写', { date: '2026-01-01', env: 'DSH', summary: '紧挨着写' }],
    ['嵌套缩进列表项', '  - 2026-01-01 · DSH · 缩进', { date: '2026-01-01', env: 'DSH', summary: '缩进' }],
    ['三个井号的标题形', '### 2026-01-01 · DSH · 标题形', { date: '2026-01-01', env: 'DSH', summary: '标题形' }],
    ['四个井号同样算', '#### 2026-01-01 · DSH · 四级', { date: '2026-01-01', env: 'DSH', summary: '四级' }],
  ]

  for (const [label, line, expected] of VALID) {
    it(`${label} → 识别`, () => {
      const parsed = parseSignatureLine(line)
      assert.ok(parsed, `未能识别：${JSON.stringify(line)}`)
      assert.equal(parsed.date, expected.date)
      assert.equal(parsed.env, expected.env)
      assert.equal(parsed.summary, expected.summary)
    })
  }

  it('行尾 \\r 被容忍（CRLF checkout 上少识别是危险方向）', () => {
    assert.equal(parseSignatureLine('- 2026-01-01 · DSH · x\r')?.summary, 'x')
  })

  it('raw 是去空白后的整行', () => {
    assert.equal(parseSignatureLine('  - 2026-01-01 · DSH · x  ')?.raw, '- 2026-01-01 · DSH · x')
  })
})

describe('非法行：不得被识别（它们是 fail-open 的入口）', () => {
  const INVALID = [
    ['未知 env', '- 2026-01-01 · Foo · x'],
    ['env 大小写不符', '- 2026-01-01 · dsh · x'],
    ['日期不是 ISO', '- 26-01-01 · DSH · x'],
    ['缺 summary', '- 2026-01-01 · DSH ·'],
    ['summary 只有空白', '- 2026-01-01 · DSH ·    '],
    ['缺 env 段', '- 2026-01-01 · x'],
    ['不是列表项也不是标题', '2026-01-01 · DSH · x'],
    ['缺尾部中间点', '- 2026-01-01 · DSH x'],
    ['两个井号是 section 不是署名', '## 2026-01-01 · DSH · x'],
    ['一个井号不匹配', '# 2026-01-01 · DSH · x'],
    ['六个以上井号不匹配', '####### 2026-01-01 · DSH · x'],
    ['用其它字符当分隔符', '- 2026-01-01 | DSH | x'],
    ['空行', ''],
  ]

  for (const [label, line] of INVALID) {
    it(`${label} → 不识别`, () => {
      assert.equal(parseSignatureLine(line), undefined, `被误识别：${JSON.stringify(line)}`)
    })
  }

  it('undefined / null 不抛异常', () => {
    assert.equal(parseSignatureLine(undefined), undefined)
    assert.equal(parseSignatureLine(null), undefined)
  })
})

describe('解析面与渲染面故意不相等（历史语料不能丢）', () => {
  it('Gemini 可解析（语料里有真实历史署名）', () => {
    assert.ok(PARSEABLE_ENVS.includes('Gemini'))
    assert.ok(parseSignatureLine('- 2026-01-01 · Gemini · x'))
  })
})

describe('两条判据边界：写下来是为了不让下一个人重新发现', () => {
  // 🔴 这两条**不是**缺陷，是解析器的既有语义。第 8 期把它们作为**豁免判据**之后，
  // 它们的含义变大了（进入审批指纹的豁免集），所以必须显式钉住而不是留白。
  // 改任何一个都会牵动 `checkAttribution` / `parseSignatures` 的行为 —— 那是另一件事。

  it('日期只校验形状，不校验真实历日', () => {
    // `\\d{4}-\\d{2}-\\d{2}` 是形状。要求真实历日会让「少识别」这条危险方向复活：
    // 一份历史语料里写错的日期，会让整目录被判未署名。
    assert.ok(parseSignatureLine('- 2026-13-45 · DSH · x'), '形状合法即识别')
    assert.ok(parseSignatureLine('- 2026-02-30 · DSH · x'), '形状合法即识别')
  })

  it('Claude 的 Cowork 要求**不在**解析器判据里（它在渲染面与消费项目严格识别器）', () => {
    assert.ok(parseSignatureLine('- 2026-01-01 · Claude · 没有那个词'))
  })
})
