// 护栏：**工具自己的骨架，必须过得了工具自己的校验器**。
//
// 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 1 条）。
// 缺陷本身是「`spec_template` 的产物被 `spec_validate_artifacts` 判 error」；而它能一直
// 存在的**直接原因**是这条护栏缺席 —— 两个工具从没被放在一起量过。所以修 TEMPLATES 只是
// 治标，这个文件才是治本的那一半。
//
// 实测（修复前）6 个组合里 4 个产出 error：
//     bugfix/bugfix 5 · bugfix/design 3 · requirements-first/requirements 2 · requirements-first/design 3
//
// ⚠️ 两条路径都要量，因为真机选章节表的依据有两个入口：
//   ① `spec_validate_artifacts` **不传** specType → design 靠 `sniffDesignVariant` 内容嗅探；
//   ② `spec_diagnostics` 传 `.config.kiro` 里写明的 specType → 直接选表。
// 只量①的话，一份「嗅探成 bugfix、但声明为 feature 时不合格」的骨架能溜过去。
//
// ⚠️ 判据是**零 error 且零 warning**，不是只看 error。warning 全是「缺推荐章节」，
// 照模板起草的人没理由从一开始就背着它们；放过 warning 等于让骨架天生带一批待办噪声。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { artifactsForWorkflow, validateArtifactSchemas } from '../lib/core/artifact-schema.mjs'
import { artifactTemplate } from '../lib/core/templates.mjs'

// 工作流 → 真机声明 specType 时该用的值。quick 不在此列：真机的 `quick-spec` 不选表而是
// 嗅探（见 spec-diagnose `resolveSpecType` 的注释），所以它只走路径①。
const DECLARED_SPEC_TYPE = {
  'requirements-first': 'feature',
  'design-first': 'feature',
  bugfix: 'bugfix',
}
const WORKFLOWS = ['requirements-first', 'design-first', 'quick', 'bugfix']

const combinations = WORKFLOWS.flatMap((workflow) => [...artifactsForWorkflow(workflow)].map((artifact) => ({ workflow, artifact })))

describe('每个 (workflow, artifact) 组合都有骨架', () => {
  it('覆盖面不是空的 —— 防止下面的循环被写空后恒真', () => {
    assert.equal(combinations.length, 12, '4 个工作流 × 3 个 artifact；改了工作流表就来改这里')
  })

  for (const { workflow, artifact } of combinations) {
    it(`${workflow}/${artifact} 取得到骨架`, () => {
      assert.equal(typeof artifactTemplate({ workflow, artifact }), 'string')
    })
  }
})

describe('① 骨架喂回 spec_validate_artifacts（不传 specType，design 靠嗅探）零 error 零 warning', () => {
  for (const { workflow, artifact } of combinations) {
    it(`${workflow}/${artifact}`, () => {
      const findings = validateArtifactSchemas({ workflow, artifacts: { [artifact]: artifactTemplate({ workflow, artifact }) } })
      assert.deepEqual(findings.map((f) => `${f.severity}:${f.ruleId}`), [], `${workflow}/${artifact} 的骨架不干净`)
    })
  }
})

describe('② 骨架在显式声明 specType 时同样零 error 零 warning', () => {
  for (const { workflow, artifact } of combinations.filter((c) => DECLARED_SPEC_TYPE[c.workflow])) {
    const specType = DECLARED_SPEC_TYPE[workflow]
    it(`specType=${specType} · ${workflow}/${artifact}`, () => {
      const findings = validateArtifactSchemas({ workflow, specType, artifacts: { [artifact]: artifactTemplate({ workflow, artifact }) } })
      assert.deepEqual(findings.map((f) => `${f.severity}:${f.ruleId}`), [], `${workflow}/${artifact} 在 specType=${specType} 下不干净`)
    })
  }
})

describe('放错格子的那一条不许回来', () => {
  it('bugfix.md 的骨架是 bugfix 表的章节，**不是** design(bugfix 变体) 的三节', () => {
    const bugfix = artifactTemplate({ workflow: 'bugfix', artifact: 'bugfix' })
    for (const required of ['## Introduction', '## Bug Analysis', '### Current Behavior (Defect)', '### Expected Behavior (Correct)', '### Unchanged Behavior (Regression Prevention)']) {
      assert.ok(bugfix.includes(required), `bugfix.md 骨架缺 ${required}`)
    }
    // 缺陷原貌：bugfix.md 拿到的是这三节 —— 它们属于 bugfix 工作流的 **design.md**。
    for (const misplaced of ['## Bug Details', '## Hypothesized Root Cause', '## Fix Implementation']) {
      assert.ok(!bugfix.includes(misplaced), `${misplaced} 属于 design.md，不该出现在 bugfix.md 骨架里`)
    }
  })

  it('design 的两个变体确实不同 —— 一维表回来的话这条会红', () => {
    assert.notEqual(
      artifactTemplate({ workflow: 'bugfix', artifact: 'design' }),
      artifactTemplate({ workflow: 'requirements-first', artifact: 'design' }),
      'bugfix 与 feature 的 design 章节表几乎不相交，共用一份骨架按构造就不可能都对',
    )
  })

  it('工作流不认的 artifact 仍然抛 ARTIFACT_NOT_ALLOWED（原有行为不许丢）', () => {
    assert.throws(() => artifactTemplate({ workflow: 'bugfix', artifact: 'requirements' }), (caught) => caught.code === 'ARTIFACT_NOT_ALLOWED')
    assert.throws(() => artifactTemplate({ workflow: 'requirements-first', artifact: 'bugfix' }), (caught) => caught.code === 'ARTIFACT_NOT_ALLOWED')
  })

  it('不支持的工作流仍然抛 INVALID_FORMAT（templates.mjs 依赖 artifactsForWorkflow 的这个行为）', () => {
    assert.throws(() => artifactTemplate({ workflow: 'nope', artifact: 'design' }), (caught) => caught.code === 'INVALID_FORMAT')
  })
})
