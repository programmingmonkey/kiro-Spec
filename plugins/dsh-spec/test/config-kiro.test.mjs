// 第 9 期 T3 —— `.config.kiro` 让判定源与真机对齐。
//
// 背景（`research/15` §3 / §4）：真机 Kiro 建 spec 时 MUST 往 spec 目录写一份
// `.config.kiro`，内容是 `{"specId":…, "workflowType":…, "specType":…}`，并**用它**决定
// 规则表与文档清单顺序。本仓此前零处理它，只能靠 `bugfix.md` 是否存在去**猜**类型。
//
// 两者会在三种情形下不一致，而这三种都真实存在于消费项目的语料里。下面三条用例就是
// 那三种，每条都用**端到端可观测的后果**来钉（不是只断言返回值里多了个字段）：
// 判定错了，`spec_write design` 的前置条件就会去要错的另一个文件。
//
// 为什么断言放这里而不是 `packages/spec-parser`：那一侧钉的是**解析**（8 种 keys 形态），
// 这一侧钉的是**判定链的优先级**（config → meta → 制品 → 默认）。两者是两件事。
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { cleanup, makeProject, mount } from './harness.mjs'

const projects = []
function project() {
  const root = makeProject()
  projects.push(root)
  return root
}
after(() => {
  for (const root of projects) cleanup(root)
})

const CONFIG_KIRO = '.config.kiro'

/** 建一个 spec 目录并写入选定的文件。`config` 为 undefined 时**不写** `.config.kiro`。 */
function seedSpec(root, name, { config, files = {} } = {}) {
  const dir = join(root, '.kiro', 'specs', name)
  mkdirSync(dir, { recursive: true })
  if (config !== undefined) writeFileSync(join(dir, CONFIG_KIRO), config)
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

const REQS = '# Requirements Document\n\n## Introduction\n\n开篇。\n\n## Requirements\n\n### Requirement 1: A\n\n**User Story:** As a dev I want A.\n\n#### Acceptance Criteria\n\n1. WHEN x THEN the system SHALL do A\n'
const BUGFIX = '# Bugfix Requirements Document\n\n## Introduction\n\n修一个缺陷。\n\n## Bug Analysis\n\n### Current Behavior (Defect)\n\n1.1 WHEN y THEN the system does wrong\n\n### Expected Behavior\n\n2.1 WHEN y THEN the system does right\n\n### Unchanged Behavior (Regression Prevention)\n\n3.1 WHEN z THEN the system SHALL CONTINUE TO be fine\n'

describe('T3 情形 ① — specType=bugfix 而 bugfix.md 尚未生成', () => {
  it('判 bugfix（source=config），于是 design 的前置条件要的是 bugfix.md', async () => {
    const root = project()
    // 只有 requirements.md —— 这正是「config 说 bugfix、制品说 feature」的分叉点。
    seedSpec(root, 'demo', {
      config: '{"workflowType": "requirements-first", "specType": "bugfix"}\n',
      files: { 'requirements.md': REQS },
    })
    const { call } = mount(root)

    const st = await call('spec_status', { spec: 'demo' })
    assert.equal(st.workflow, 'bugfix', 'config 说 bugfix，就该判 bugfix')
    assert.equal(st.workflowSource, 'config')
    assert.equal(st.specType, 'bugfix')

    // 端到端后果：feature 的前置条件是 requirements.md（在），bugfix 的要 bugfix.md（不在）。
    // 判错就会**放行**，所以这里必须抛，且必须点名 bugfix.md。
    await assert.rejects(
      call('spec_write', { spec: 'demo', file: 'design', content: '# Design Document\n' }),
      /bugfix\.md does not exist yet/,
      '判成 feature 就会放行这份 design —— 而 config 明确说了这是 bugfix',
    )
  })
})

describe('T3 情形 ② — specType=feature 而目录里有残留的 bugfix.md', () => {
  it('判 feature（source=config），残留的 bugfix.md **不算**前置条件', async () => {
    const root = project()
    // 中间状态：曾经是 bugfix，后来改成 feature。目录里两样都在。
    seedSpec(root, 'demo', {
      config: '{"workflowType": "requirements-first", "specType": "feature"}\n',
      files: { 'bugfix.md': BUGFIX },
    })
    const { call } = mount(root)

    const st = await call('spec_status', { spec: 'demo' })
    assert.equal(st.workflow, 'requirements-first', '显式的 specType=feature 必须压过「有 bugfix.md」这个推断')
    assert.equal(st.workflowSource, 'config')

    // 端到端后果：只靠 `bugfix.md` 判定时会认为前置条件已满足（文件在）→ 放行。
    // config 说 feature，前置条件就是 requirements.md —— 它不在，必须抛。
    await assert.rejects(
      call('spec_write', { spec: 'demo', file: 'design', content: '# Design Document\n' }),
      /requirements\.md does not exist yet/,
      '残留的 bugfix.md 不该满足 feature 的前置条件',
    )
  })
})

describe('T3 情形 ③ — specType=quick-spec', () => {
  it('有独立可观测标记：specType 与 kind 都如实报出，且不塞进 workflow 轴', async () => {
    const root = project()
    seedSpec(root, 'demo', {
      config: '{"specType": "quick-spec", "workflowType": "requirements-first"}\n',
      files: { 'requirements.md': REQS, 'design.md': '# Design Document\n', 'tasks.md': '# Implementation Plan\n' },
    })
    const { call, tools } = mount(root)

    const st = await call('spec_status', { spec: 'demo' })
    assert.equal(st.specType, 'quick-spec', '真机原值要如实呈现')
    assert.equal(st.kind, 'quick', '跨词汇表映射：真机的 quick-spec → 本仓的 kind=quick')
    assert.equal(st.workflowSource, 'config')
    assert.notEqual(st.workflow, 'quick', '`quick` 不是本仓 workflow 轴上的取值，不许硬塞进去')

    // 渲染面也要看得见 —— 只存在 JSON 里不算「可观测」。
    const blocks = tools.get('spec_status').output.render(null, st)
    const text = blocks.map((b) => b.text ?? '').join('\n')
    assert.match(text, /Workflow source: config \(specType=quick-spec, kind=quick\)/)
  })
})

describe('T3 —— 判定来源如实报出（四层优先级）', () => {
  it('四层来源各自可辨：config / meta / artifact / default', async () => {
    const root = project()

    // ① config
    seedSpec(root, 'fromConfig', { config: '{"specType": "bugfix"}\n' })
    // ② meta（config 缺席）
    seedSpec(root, 'fromMeta', { files: { 'tasks.meta.json': '{"_workflow": "design-first"}\n' } })
    // ③ 制品（config、meta 都缺席）
    seedSpec(root, 'fromArtifact', { files: { 'bugfix.md': BUGFIX } })
    // ④ 默认（三者都缺席）
    seedSpec(root, 'fromDefault', {})

    const { call } = mount(root)
    const src = async (spec) => (await call('spec_status', { spec })).workflowSource

    assert.equal(await src('fromConfig'), 'config')
    assert.equal(await src('fromMeta'), 'meta')
    assert.equal(await src('fromArtifact'), 'artifact')
    assert.equal(await src('fromDefault'), 'default')
  })

  it('config 与 meta 都在且不一致：采信 config，但把矛盾说出来', async () => {
    const root = project()
    seedSpec(root, 'conflict', {
      config: '{"specType": "feature"}\n',
      files: { 'tasks.meta.json': '{"_workflow": "bugfix"}\n' },
    })
    const { call, tools } = mount(root)

    const st = await call('spec_status', { spec: 'conflict' })
    assert.equal(st.workflow, 'requirements-first', '采信 config（真机权威）')
    assert.equal(st.workflowSource, 'config')
    // 静默选一个会让读者以为另一个不存在 —— 矛盾必须出现在输出里。
    assert.equal(st.workflowNotes.length, 1)
    assert.match(st.workflowNotes[0], /_workflow 说 bugfix/)
    const text = tools.get('spec_status').output.render(null, st).map((b) => b.text ?? '').join('\n')
    assert.match(text, /⚠️ .*_workflow 说 bugfix/)
  })

  it('真机有、本仓未建模的 workflowType（fast-task）会报出来，不静默套流程', async () => {
    const root = project()
    seedSpec(root, 'fast', {
      config: '{"specType": "feature", "workflowType": "fast-task"}\n',
      files: { 'requirements.md': REQS },
    })
    const { call } = mount(root)
    const st = await call('spec_status', { spec: 'fast' })
    assert.equal(st.workflowSource, 'config')
    assert.equal(st.workflowNotes.length, 1)
    assert.match(st.workflowNotes[0], /fast-task 本仓未建模/)
  })

  it('.config.kiro 在场但坏 JSON：回落下一层，并说明为什么回落了', async () => {
    const root = project()
    seedSpec(root, 'broken', {
      config: '{ this is not json',
      files: { 'tasks.meta.json': '{"_workflow": "design-first"}\n' },
    })
    const { call } = mount(root)
    const st = await call('spec_status', { spec: 'broken' })
    assert.equal(st.workflow, 'design-first', '坏 config 不该让整次判定失败')
    assert.equal(st.workflowSource, 'meta')
    assert.match(st.workflowNotes.join('\n'), /INVALID_JSON/)
  })
})

// 第 9 期 review（2026-09-17）—— 诊断器只该收到**写明**的 specType。
//
// 真机 `specFormat` 的 specType 只来自 `.config.kiro`；写明 feature 时它不嗅探 design，
// 只有写明 bugfix 时才豁免依赖图。此前本插件把 workflow（含推断出来的 bugfix）当成
// 「显式类型」传给诊断器，两个方向都与真机分叉。
describe('诊断器的 specType 来源 —— 只认 .config.kiro', () => {
  const DESIGN_WITH_MARKER = '# Design Document\n\n## Overview\n\nx\n\n## Architecture\n\nx\n\n## Components and Interfaces\n\nx\n\n## Data Models\n\nx\n\n## Correctness Properties\n\nx\n\n## Error Handling\n\nx\n\n## Testing Strategy\n\nx\n\n## Fix Implementation\n\n顺带一段修复实现。\n'
  const TASKS_NO_GRAPH = '# Implementation Plan: x\n\n## Overview\n\nx\n\n## Tasks\n\n- [ ] 1. 做一件事\n\n## Notes\n\nx\n'

  it('写明 feature：带 bugfix 标题的 design 按 feature 表查（不嗅探）', async () => {
    const root = project()
    seedSpec(root, 'demo', {
      config: '{"workflowType": "requirements-first", "specType": "feature"}\n',
      files: { 'requirements.md': REQS, 'design.md': DESIGN_WITH_MARKER },
    })
    const { call } = mount(root)
    const out = await call('spec_diagnostics', {})
    assert.doesNotMatch(out.rendered, /design\/missing-bug-details/, out.rendered)
  })

  it('对照组：没有 config 时同一份 design 被嗅探成 bugfix 表', async () => {
    const root = project()
    seedSpec(root, 'demo', { files: { 'requirements.md': REQS, 'design.md': DESIGN_WITH_MARKER } })
    const { call } = mount(root)
    const out = await call('spec_diagnostics', {})
    assert.match(out.rendered, /design\/missing-bug-details/, out.rendered)
  })

  it('只是**推断**为 bugfix（有 bugfix.md、无 config）：依赖图照样要求，与真机一致', async () => {
    const root = project()
    seedSpec(root, 'demo', { files: { 'bugfix.md': BUGFIX, 'tasks.md': TASKS_NO_GRAPH } })
    const { call } = mount(root)
    const st = await call('spec_status', { spec: 'demo' })
    assert.equal(st.workflow, 'bugfix')
    assert.equal(st.workflowSource, 'artifact')
    const out = await call('spec_diagnostics', {})
    assert.match(out.rendered, /tasks\/missing-dependency-graph/, out.rendered)
  })

  it('写明 bugfix：依赖图豁免', async () => {
    const root = project()
    seedSpec(root, 'demo', {
      config: '{"workflowType": "requirements-first", "specType": "bugfix"}\n',
      files: { 'bugfix.md': BUGFIX, 'tasks.md': TASKS_NO_GRAPH },
    })
    const { call } = mount(root)
    const out = await call('spec_diagnostics', {})
    assert.doesNotMatch(out.rendered, /tasks\/missing-dependency-graph/, out.rendered)
  })
})
