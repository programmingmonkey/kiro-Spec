// `specType` 三态 —— 与真机 `validateDesignFormat` / `validateTasksFormat` **逐态对拍**。
//
// 由来（第 9 期 review，2026-09-17）：真机的判定是
//
//     design: e===SpecType.Bugfix || e===void 0 && <嗅探>   → bugfix 表，否则 feature 表
//     tasks : 缺依赖图 && e!==SpecType.Bugfix                → missing-dependency-graph
//
// 而本层此前只有布尔 `isBugfix`，表达不了「写明是 feature」：
//   · 写明 feature、正文却带 bugfix 标题 → 本地嗅探成 bugfix 表，真机不嗅探（本地更严）；
//   · 只是**推断**为 bugfix → 宿主传 `isBugfix:true`，本地豁免依赖图，真机不豁免（本地更松）。
//
// 对标的是 `get_diagnostics`（与「问题」面板同一映射）：`.config.kiro` 的 specType 只有
// `feature` / `bugfix` 被传给校验器，其余（含 `quick-spec`）一律不传。`validate_spec_format`
// 会原样传 `quick-spec`，与此不一致 —— 本层跟前者（见 `resolveSpecType` 的注释），
// 下面有一条断言从 bundle 原文钉住这个映射。
//
// 断言口径：同一份文档、同一个 specType，本地 `source: 'kiro-binary'` 的码集合 **等于**
// 真机输出的码集合（限于本文件关心的那几条章节/依赖图码）。等于而不是 ⊆：本条要抓的
// 恰好包括「本地比真机松」。真机不在时 skip 并写明原因，不用硬编码期望值顶替。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { diagnose, diagnoseArtifact } from '../lib/index.js'
import { kiroDiagnose, loadKiroValidators } from './tools/kiro-validators.mjs'

let loaded = null
let loadFailure = null
try {
  loaded = loadKiroValidators()
} catch (error) {
  loadFailure = error
}

// feature 章节齐全，另外带一个 bugfix 嗅探标记（`## Fix Implementation`）。
const DESIGN_FEATURE_WITH_MARKER = [
  '# Design Document',
  '## Overview', 'x',
  '## Architecture', 'x',
  '## Components and Interfaces', 'x',
  '## Data Models', 'x',
  '## Correctness Properties', 'x',
  '## Error Handling', 'x',
  '## Testing Strategy', 'x',
  '## Fix Implementation', '顺带写了一段修复实现',
  '',
].join('\n')

// 没有依赖图的 tasks.md（其余结构齐全）。
const TASKS_WITHOUT_GRAPH = [
  '# Implementation Plan: x',
  '## Overview', 'x',
  '## Tasks',
  '- [ ] 1. 做一件事',
  '## Notes', 'x',
  '',
].join('\n')

const SECTION_CODE = /^design\/missing-|^tasks\/missing-dependency-graph$/
const localCodes = (artifact, markdown, specType) =>
  new Set(
    diagnose({ artifact, markdown, specType })
      .filter((f) => f.source === 'kiro-binary' && SECTION_CODE.test(f.code))
      .map((f) => f.code),
  )
// `get_diagnostics` 的映射：`specType==="feature" ? Feature : specType==="bugfix" ? Bugfix : 不设`。
const getDiagnosticsSpecType = (declared) => (declared === 'feature' || declared === 'bugfix' ? declared : undefined)
const kiroCodes = (artifact, markdown, specType) =>
  new Set(
    kiroDiagnose(artifact, markdown, loaded, { specType: getDiagnosticsSpecType(specType) })
      .map((f) => f.rule)
      .filter((code) => SECTION_CODE.test(code)),
  )

const STATES = [undefined, 'feature', 'bugfix', 'quick-spec']

describe('specType 三态与真机逐态一致', () => {
  it('bundle 里 get_diagnostics 的映射仍是「只认 feature / bugfix」', (t) => {
    if (loadFailure) return t.skip(`真机 bundle 不可用：${loadFailure.message}`)
    const text = readFileSync(loaded.bundle.path, 'utf8')
    // 锚点用工具类的具名标签，不用 `id:"get_diagnostics"`：后者在 bundle 里出现两次（1.1.28 实测）。
    const tool = text.indexOf('"ToolGetDiagnostics"')
    assert.ok(tool !== -1 && text.indexOf('"ToolGetDiagnostics"', tool + 1) === -1, 'ToolGetDiagnostics 标签不唯一或缺失 —— 锚点失效，人工复核')
    const body = text.slice(tool, tool + 4000)
    assert.match(
      body,
      /\.specType==="feature"\?\w+=\w+\.SpecType\.Feature:\w+\.specType==="bugfix"&&\(\w+=\w+\.SpecType\.Bugfix\)/,
      'get_diagnostics 读 .config.kiro 的映射变了 —— 重核 resolveSpecType 的取舍',
    )
  })

  for (const [artifact, markdown] of [['design', DESIGN_FEATURE_WITH_MARKER], ['tasks', TASKS_WITHOUT_GRAPH]]) {
    for (const specType of STATES) {
      it(`${artifact} · specType=${specType ?? '(未写)'}`, (t) => {
        if (loadFailure) return t.skip(`真机 bundle 不可用：${loadFailure.message}`)
        assert.deepEqual(
          [...localCodes(artifact, markdown, specType)].sort(),
          [...kiroCodes(artifact, markdown, specType)].sort(),
        )
      })
    }
  }
})

// 下面几条不依赖真机：钉的是**本地的后果**，真机不在的机器上也必须守住。
describe('specType 三态的本地后果', () => {
  const sectionCodes = (findings) => findings.map((f) => f.code).filter((c) => SECTION_CODE.test(c)).sort()

  it('写明 feature ⇒ 不嗅探：带 bugfix 标题的 feature 设计不报 bugfix 章节缺失', () => {
    assert.deepEqual(sectionCodes(diagnose({ artifact: 'design', markdown: DESIGN_FEATURE_WITH_MARKER, specType: 'feature' })), [])
  })

  it('quick-spec 按「未写」处理：照样嗅探（跟 get_diagnostics，不跟 validate_spec_format）', () => {
    const codes = sectionCodes(diagnose({ artifact: 'design', markdown: DESIGN_FEATURE_WITH_MARKER, specType: 'quick-spec' }))
    assert.ok(codes.includes('design/missing-bug-details'), JSON.stringify(codes))
  })

  it('对照组：未写 ⇒ 嗅探成 bugfix 表（否则上一条的「不报」可能只是恒真）', () => {
    const codes = sectionCodes(diagnose({ artifact: 'design', markdown: DESIGN_FEATURE_WITH_MARKER }))
    assert.ok(codes.includes('design/missing-bug-details'), JSON.stringify(codes))
  })

  it('依赖图只对**写明**的 bugfix 豁免', () => {
    assert.deepEqual(sectionCodes(diagnose({ artifact: 'tasks', markdown: TASKS_WITHOUT_GRAPH, specType: 'bugfix' })), [])
    for (const specType of [undefined, 'feature', 'quick-spec']) {
      assert.deepEqual(
        sectionCodes(diagnose({ artifact: 'tasks', markdown: TASKS_WITHOUT_GRAPH, specType })),
        ['tasks/missing-dependency-graph'],
        `specType=${specType}`,
      )
    }
  })

  it('旧写法 isBugfix:true 仍等价于 specType:bugfix；未知取值按「未写」处理且不抛', () => {
    const legacy = diagnose({ artifact: 'tasks', markdown: TASKS_WITHOUT_GRAPH, isBugfix: true })
    assert.deepEqual(sectionCodes(legacy), [])
    const unknown = diagnose({ artifact: 'design', markdown: DESIGN_FEATURE_WITH_MARKER, specType: 'bug' })
    assert.ok(sectionCodes(unknown).includes('design/missing-bug-details'), '未知取值没有回到嗅探')
  })

  it('旧签名 diagnoseArtifact 透传 specType', () => {
    const codes = sectionCodes(diagnoseArtifact('design', DESIGN_FEATURE_WITH_MARKER, { specType: 'feature' }))
    assert.deepEqual(codes, [])
  })
})
