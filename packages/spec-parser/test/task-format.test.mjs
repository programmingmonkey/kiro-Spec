// 2.1 —— 共享识别层的契约(先红:../lib/task-format.js 尚不存在,本文件此刻应当失败)。
//
// 钉住四件事:
//   ① 字段集恒完整,`kind` 取值集合恰为 {task, invalid-state};
//   ② 两个模式各自的状态策略(差异表 A1 / A2 是唯一的宿主分歧);
//   ③ B / C / D 三行归并到 dsh 侧判定后的取值;
//   ④ 恒不抛、零 I/O。
//
// 这些断言**故意**在实现之前写:实现若为了让测试过而放宽字段集或让 kind 多出一种,红。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { metadataValue, parseTaskLine } from '../lib/task-format.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = join(HERE, '..', 'lib')
const FIELDS = ['kind', 'id', 'state', 'indent', 'optional', 'title', 'stateOffset', 'valid']
const KIND_VALUES = ['task', 'invalid-state']

const dsh = (line) => parseTaskLine(line, { strictTaskState: false })
const kiro = (line) => parseTaskLine(line, { strictTaskState: true })

const SPECIMENS = [
  '- [ ] 1. x',
  '- [x] 1. x',
  '- [X] 1. x',
  '- [-] 1. x',
  '- [~] 1. x',
  '- [/] 1. x',
  '- [!] 1. x',
  '- [ ] 1.1',
  '- [ ] 1.',
  '- [ ] 1 foo',
  '- [ ] * 1.1 x',
  '- [ ]* 1.1 x',
  '  - [ ] 1.1 indented',
  '- [~] 1 foo',
  '- [ ] 1.1foo',
  '- [ ] task',
  '* [ ] 1.1 x',
  '-[ ] 1.1 x',
  '- [] 1.1 x',
  '- [ab] 1.1 x',
  '',
  '## Tasks',
]

describe('统一结果对象的形状', () => {
  it('凡返回对象即携带全部八个字段键,且 kind 只有两种取值', () => {
    for (const line of SPECIMENS) {
      for (const parsed of [dsh(line), kiro(line)]) {
        if (parsed === undefined) continue
        assert.deepEqual(Object.keys(parsed).sort(), [...FIELDS].sort(), `${JSON.stringify(line)} 的字段集`)
        assert.ok(KIND_VALUES.includes(parsed.kind), `${JSON.stringify(line)} 的 kind=${parsed.kind}`)
      }
    }
  })

  it('invalid-state 同样携带全部字段键(取不到的为 undefined)', () => {
    const parsed = kiro('- [~] 1. x')
    assert.equal(parsed.kind, 'invalid-state')
    assert.deepEqual(Object.keys(parsed).sort(), [...FIELDS].sort())
  })

  it('恒不抛:奇怪输入也返回而不是崩', () => {
    const odd = ['', '\n', '- [ ]', '- [ ] ', '```', '- [ ] 1.', '   ', '- [\u0000] 1. x', '- [ ] 99999999999999999999.1 x']
    for (const line of odd) {
      assert.doesNotThrow(() => dsh(line), JSON.stringify(line))
      assert.doesNotThrow(() => kiro(line), JSON.stringify(line))
    }
  })

  it('id 恒为字符串,indent 恒为原始缩进串', () => {
    assert.equal(dsh('- [ ] 1. x').id, '1')
    assert.equal(dsh('  - [ ] 1.1 x').indent, '  ')
    assert.equal(dsh('  - [ ] 1.1 x').indent.length, 2)
  })
})

describe('dsh 模式(strictTaskState: false)', () => {
  it('A1:第四态 `[~]` 解析为任务且 valid=true', () => {
    const parsed = dsh('- [~] 1. x')
    assert.deepEqual(
      { kind: parsed.kind, id: parsed.id, state: parsed.state, valid: parsed.valid, title: parsed.title },
      { kind: 'task', id: '1', state: '~', valid: true, title: 'x' },
    )
  })

  it('A2:四字符类之外的态解析为任务且 valid=false', () => {
    for (const bad of ['/', '!', '?']) {
      const parsed = dsh(`- [${bad}] 1. x`)
      assert.equal(parsed.kind, 'task', `[${bad}]`)
      assert.equal(parsed.valid, false, `[${bad}]`)
    }
  })

  it('B:空标题是任务且 title 为空串', () => {
    assert.equal(dsh('- [ ] 1.1').title, '')
    assert.equal(dsh('- [ ] 1.').title, '')
    assert.equal(dsh('- [ ] 1.1').id, '1.1')
    assert.equal(dsh('- [ ] 1.').id, '1')
  })

  it('C:顶层整数 id 无尾点仍是任务(有意比真机宽,漏算会让 phase 谎报 complete)', () => {
    const parsed = dsh('- [ ] 1 foo')
    assert.equal(parsed.kind, 'task')
    assert.equal(parsed.id, '1')
    assert.equal(parsed.title, 'foo')
  })

  it('D:`]` 与 `*` 之间有空格不是任务', () => {
    assert.equal(dsh('- [ ] * 1.1 x'), undefined)
  })
})

describe('kiro 模式(strictTaskState: true)', () => {
  it('A1 / A2:四字符类之外的态一律 invalid-state,且恒不抛', () => {
    for (const bad of ['~', '/', '!', '?']) {
      const parsed = kiro(`- [${bad}] 1. x`)
      assert.equal(parsed.kind, 'invalid-state', `[${bad}]`)
    }
  })

  it('B / C:归并到 dsh 侧 —— 成为任务,不再有 invalid-format', () => {
    assert.equal(kiro('- [ ] 1.1').kind, 'task')
    assert.equal(kiro('- [ ] 1.').kind, 'task')
    assert.equal(kiro('- [ ] 1 foo').kind, 'task')
  })

  it('D:同样不是任务(与 dsh 侧一致)', () => {
    assert.equal(kiro('- [ ] * 1.1 x'), undefined)
  })

  it('判定顺序:状态先于格式 —— `- [~] 1 foo` 判 invalid-state 而非任务', () => {
    assert.equal(kiro('- [~] 1 foo').kind, 'invalid-state')
  })
})

describe('两模式的共同约定', () => {
  it('大写 X 归一为小写 x', () => {
    for (const run of [dsh, kiro]) {
      const parsed = run('- [X] 1. x')
      assert.equal(parsed.state, 'x')
      assert.equal(parsed.valid, true)
    }
  })

  it('这两种模式在 A1 / A2 上输出不同(判别力的最小样本)', () => {
    for (const line of ['- [~] 1. x', '- [/] 1. x']) {
      const a = dsh(line)
      const b = kiro(line)
      assert.notDeepEqual(a, b, `${line} 在两模式下取值相同——开关没有被真正使用`)
    }
  })

  it('stateOffset 指向复选框内那个状态字符', () => {
    for (const [line, offset] of [
      ['- [ ] 1. x', 3],
      ['- [x] 1. x', 3],
      ['  - [x] 1.1 y', 5],
    ]) {
      const parsed = parseTaskLine(line, { strictTaskState: false })
      assert.equal(parsed.stateOffset, offset, JSON.stringify(line))
      assert.equal(line[parsed.stateOffset], parsed.state, JSON.stringify(line))
    }
  })

  it('一律不是任务的形态', () => {
    for (const line of ['- [ ] 1.1foo', '- [] 1.1 x', '- [ab] 1.1 x', '* [ ] 1.1 x', '-[ ] 1.1 x', '- [ ] task']) {
      assert.equal(dsh(line), undefined, `dsh ${JSON.stringify(line)}`)
      assert.equal(kiro(line), undefined, `kiro ${JSON.stringify(line)}`)
    }
  })
})

describe('metadataValue 随迁', () => {
  it('从任务体里抽出 _Requirements: 的值', () => {
    assert.equal(metadataValue('- _Requirements: 1.1, 2.3_', 'Requirements'), '1.1, 2.3')
    assert.equal(metadataValue('nothing here', 'Requirements'), undefined)
  })
})

describe('零 I/O', () => {
  it('lib/ 下不导入 node:fs 与 node:path', () => {
    for (const file of ['task-format.js', 'scan-lines.js']) {
      const source = readFileSync(join(LIB_DIR, file), 'utf8')
      assert.equal(/from ['"]node:fs['"]/.test(source), false, `${file} 导入了 node:fs`)
      assert.equal(/from ['"]node:path['"]/.test(source), false, `${file} 导入了 node:path`)
    }
  })
})
