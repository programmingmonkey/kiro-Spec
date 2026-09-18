// `.config.kiro` 识别器的**纯函数**测试。
//
// 语料**逐条取自盘上实测**（2026-09-16，消费项目 `.kiro/specs/**/.config.kiro` 共 77 个
// 文件），不是编出来的形状：8 种 keys 形态就是那 77 个文件去重后的全部。这条约束有意义
// —— 自己编语料只能测自己想得到的形态，而「想得到」正是这次差点漏掉 `validateLinkHeaderFormat`
// 的同一个毛病（见 开发仓实测 §8 与 T1 的提交信息）。
//
// 判定语义对齐真机**每条字段各自白名单**的那条路径（`resolveSpecType` / `FVu`）：
// 类型对且值在枚举里才收，否则静默丢这一个字段。见 `lib/config-kiro.js` 的头注释。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CONFIG_KIRO_FILE, SPEC_TYPES, WORKFLOW_TYPES, parseConfigKiro, specTypeToKind } from '../lib/config-kiro.js'

describe('8 种 keys 形态（逐条取自盘上实测）', () => {
  // [标签, 原文, 期望 specType, 期望 workflowType, 期望 extraKeys]
  const cases = [
    [
      '官方模板 3 字段（50/77）',
      '{"specId": "19cfc576-473e-4ff5-9b0d-0121de66eb0e", "workflowType": "requirements-first", "specType": "feature"}',
      'feature', 'requirements-first', [],
    ],
    [
      '缺 specId（18/77）',
      '{"workflowType": "requirements-first", "specType": "bugfix"}',
      'bugfix', 'requirements-first', [],
    ],
    [
      '含 createdBy / note（2/77）',
      '{"createdBy": "human", "note": "手工加过", "workflowType": "fast-task", "specType": "feature"}',
      'feature', 'fast-task', ['createdBy', 'note'],
    ],
    [
      '含 createdAt / extends（2/77）',
      '{"createdAt": "2026-06-09", "extends": "severe-abnormal-alert-panel", "workflowType": "fast-task", "specType": "feature"}',
      'feature', 'fast-task', ['createdAt', 'extends'],
    ],
    [
      '含 featureName（2/77）',
      '{"featureName": "x", "workflowType": "design-first", "specType": "feature"}',
      'feature', 'design-first', ['featureName'],
    ],
    [
      '含 createdAt / featureName（1/77）',
      '{"createdAt": "2026-06-09", "featureName": "x", "workflowType": "requirements-first", "specType": "bugfix"}',
      'bugfix', 'requirements-first', ['createdAt', 'featureName'],
    ],
    [
      '非标准形态：specName / specVersion（1/77）',
      '{"specName": "x", "specVersion": 2}',
      undefined, undefined, ['specName', 'specVersion'],
    ],
    [
      '非标准形态：spec（1/77）',
      '{"spec": "something"}',
      undefined, undefined, ['spec'],
    ],
  ]

  for (const [label, text, specType, workflowType, extraKeys] of cases) {
    it(label, () => {
      const out = parseConfigKiro(text)
      assert.equal(out.present, true)
      assert.equal(out.usable, true, '是个 JSON 对象就该是 usable —— 取不到类型字段不等于文件坏了')
      assert.equal(out.specType, specType)
      assert.equal(out.workflowType, workflowType)
      assert.deepEqual(out.extraKeys, extraKeys)
      assert.equal(out.hasType, specType !== undefined || workflowType !== undefined)
    })
  }

  it('非标准形态**不报错**，只是取不到类型 —— 与真机一致', () => {
    // 真机的 `isValidSpecConfig` 对这两个形态判 **true**（两个键都不存在，两项检查都不触发），
    // 随后读出来三个字段全 undefined。所以「拒读」在这里的正确形态是**没有可用的值**，
    // 不是抛错、也不是一个专门的状态码 —— 本模块照这个来。
    for (const text of ['{"specName": "x", "specVersion": 2}', '{"spec": "something"}']) {
      const out = parseConfigKiro(text)
      assert.equal(out.usable, true)
      assert.equal(out.hasType, false, '没有类型才算「这个文件帮不上判定的忙」')
    }
  })
})

describe('逐字段白名单：类型对且值在枚举里，才收', () => {
  it('未知 workflowType 被丢掉，但同一条记录里的 specType 照收', () => {
    // 真机 `FVu`：`typeof l.workflowType=="string" && $Vu(l.workflowType) && (u.workflowType=…)`
    // —— 丢的是**这一个字段**，不是整份配置。整份作废是 `isValidSpecConfig` 那条更严的门，
    // 而决定诊断结果的是本条。
    const out = parseConfigKiro('{"workflowType": "bogus", "specType": "feature"}')
    assert.equal(out.workflowType, undefined)
    assert.equal(out.specType, 'feature')
    assert.equal(out.hasType, true)
  })

  it('未知 specType 被丢掉', () => {
    const out = parseConfigKiro('{"specType": "epic", "workflowType": "design-first"}')
    assert.equal(out.specType, undefined)
    assert.equal(out.workflowType, 'design-first')
  })

  it('类型不对也被丢掉（数字/对象/数组/布尔）', () => {
    for (const bad of ['123', '{}', '[]', 'true', 'null']) {
      const out = parseConfigKiro(`{"specType": ${bad}, "workflowType": ${bad}}`)
      assert.equal(out.specType, undefined, `specType=${bad} 不该被收`)
      assert.equal(out.workflowType, undefined, `workflowType=${bad} 不该被收`)
    }
  })

  it('枚举与真机逐字一致（改这里必须是升版，不是顺手）', () => {
    // 真机 bundle 1.1.28：`el` 是 WorkflowType、`Mo` 是 SpecType。这两个数组是复刻件，
    // Kiro 升版时它们可能变 —— 变了要连带改 开发仓实测 与提取脚本的核对。
    assert.deepEqual(WORKFLOW_TYPES, ['requirements-first', 'design-first', 'fast-task', 'verify-first'])
    assert.deepEqual(SPEC_TYPES, ['feature', 'bugfix', 'quick-spec'])
  })

  it('specId 只查类型、不查 UUID 形状（盘上 77 份里只有 46 份是合法 UUID）', () => {
    assert.equal(parseConfigKiro('{"specId": "not-a-uuid"}').specId, 'not-a-uuid')
    assert.equal(parseConfigKiro('{"specId": 42}').specId, undefined)
    assert.equal(parseConfigKiro('{"specType": "feature"}').specId, undefined)
  })
})

describe('边界：四种不可用形态互相可区分', () => {
  it('没读到 / 空内容 → present:false（这是「没有这个文件」，不是「文件坏了」）', () => {
    for (const v of ['', '   \n\t\n', undefined, null, 42, {}]) {
      assert.deepEqual(parseConfigKiro(v), { present: false }, `${JSON.stringify(v)} 应判 present:false`)
    }
  })

  it('坏 JSON → usable:false, code:INVALID_JSON（文件在，但读不出东西）', () => {
    for (const text of ['{ this is not json', '{"a": ', '{']) {
      const out = parseConfigKiro(text)
      assert.equal(out.present, true)
      assert.equal(out.usable, false)
      assert.equal(out.code, 'INVALID_JSON')
    }
  })

  it('null / 字符串 / 数字 → usable:false, code:NOT_AN_OBJECT', () => {
    for (const text of ['null', '"x"', '3', 'true']) {
      const out = parseConfigKiro(text)
      assert.equal(out.present, true)
      assert.equal(out.usable, false)
      assert.equal(out.code, 'NOT_AN_OBJECT', `${text} 应判 NOT_AN_OBJECT`)
    }
  })

  it('数组 **不**算 NOT_AN_OBJECT —— 与真机一致（`typeof [] === "object"`）', () => {
    const out = parseConfigKiro('[]')
    assert.equal(out.usable, true)
    assert.equal(out.hasType, false)
    assert.deepEqual(out.extraKeys, [])
  })

  it('文件名常量就是真机写死的那个（没有配置项）', () => {
    assert.equal(CONFIG_KIRO_FILE, '.config.kiro')
  })
})

describe('specTypeToKind：跨词汇表映射', () => {
  it('三个真机取值各有归属，未知值返回 undefined 而不是兜底成 feature', () => {
    assert.equal(specTypeToKind('feature'), 'feature')
    assert.equal(specTypeToKind('bugfix'), 'bugfix')
    assert.equal(specTypeToKind('quick-spec'), 'quick')
    assert.equal(specTypeToKind('epic'), undefined)
    assert.equal(specTypeToKind(undefined), undefined)
  })

  it('quick-spec 只映射到 kind，**不**产生 workflow 轴上的值 —— 调用方别拿它填 workflow', () => {
    // 这个断言存在的理由：`quick` 在本仓是 kind（`spec_init kind=quick`），而 dsh-spec 的
    // init 把 quick 的 workflow 记成 requirements-first。把 kind 填进 workflow 会让
    // `phaseOf` 走到一个它不认识的取值上，然后**静默**按 requirements-first 处理。
    const kind = specTypeToKind('quick-spec')
    assert.equal(kind, 'quick')
    assert.notEqual(kind, 'requirements-first')
    assert.notEqual(kind, 'design-first')
    assert.notEqual(kind, 'bugfix')
  })
})
