// Task 2 —— Finding 契约。
//
// 守四件事：
//   ① 形状：字段集固定，`severity` / `area` 的取值域封闭；
//   ② `source` 由**查表**解析，不由调用方自述；
//   ③ 集合侧的不变式：`source === 'kiro-binary'` ⟹ `code ∈ KIRO_RULE_CODES`；
//   ④ `kiroBundle` 是冻结的复刻件身份，能被消费者拿去与自己装的 Kiro 比对。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KIRO_BUNDLE, KIRO_RULE_CODES } from '@my-harness/kiro-rules'

import * as pkg from '../lib/index.js'
import { REPO_CODES, SOURCES, makeFinding, resolveSource, diagnose } from '../lib/index.js'

const KEYS = ['area', 'code', 'location', 'message', 'severity', 'source']

describe('Task 2 — finding 的形状', () => {
  it('必填字段集恰好是契约里的六个', () => {
    const finding = makeFinding({ code: 'tasks/missing-notes', severity: 'warning', message: 'x', area: 'tasks' })
    assert.deepEqual(Object.keys(finding).sort(), KEYS)
    assert.deepEqual(Object.keys(finding.location).sort(), ['anchored', 'column', 'line'])
  })

  it('severity 只有 error / warning 两档；非法值退回 warning 而不是抛', () => {
    assert.equal(makeFinding({ code: 'x', severity: 'error', message: '', area: 'tasks' }).severity, 'error')
    assert.equal(makeFinding({ code: 'x', severity: 'fatal', message: '', area: 'tasks' }).severity, 'warning')
  })

  it('diagnose 产出的每一条都带 area，且 area ∈ 四个之一', () => {
    const docs = {
      requirements: '# Requirements Document\n',
      design: '# Design Document\n',
      tasks: '# Implementation Plan\n',
      bugfix: '# Bugfix\n',
    }
    for (const [artifact, markdown] of Object.entries(docs)) {
      const findings = diagnose({ artifact, markdown })
      assert.ok(findings.length > 0, `${artifact} 应当至少产出一条 finding`)
      for (const f of findings) {
        assert.ok(['requirements', 'design', 'tasks', 'bugfix'].includes(f.area), `${f.code} 的 area=${f.area}`)
      }
    }
  })
})

describe('Task 2 — source 是查表，不是自述', () => {
  it('不在 REPO_CODES 里的码默认 kiro-binary；在里面的默认 repo-convention', () => {
    assert.equal(resolveSource('tasks/missing-notes'), 'kiro-binary')
    assert.equal(resolveSource('tasks/invalid-task-state'), 'repo-convention')
    assert.equal(Object.keys(REPO_CODES).length, 12, 'repo 码从 12 条变成了别的数——重核 REPO_CODES')
  })

  it('显式传入的 source 覆盖查表（围栏造成的更严靠它）', () => {
    assert.equal(resolveSource('tasks/missing-notes', 'repo-convention'), 'repo-convention')
    assert.equal(makeFinding({ code: 'tasks/missing-notes', severity: 'warning', message: '', area: 'tasks', source: 'repo-convention' }).source, 'repo-convention')
  })

  it('SOURCES 的取值域封闭', () => {
    assert.deepEqual([...SOURCES].sort(), ['kiro-binary', 'repo-convention', 'supplementary'])
    for (const f of diagnose({ artifact: 'tasks', markdown: '# Implementation Plan\n' })) {
      assert.ok(SOURCES.includes(f.source), `${f.code} 的 source=${f.source}`)
    }
  })

  it('**集合侧**不变式：source 为 kiro-binary ⟹ code ∈ KIRO_RULE_CODES', () => {
    // 这条是「不得比 Kiro 更严」门槛的集合侧；文档侧由 kiro-superset.test.mjs 承担。
    const docs = [
      ['requirements', '# Requirements Document\n\n## Introduction\n\n## Requirements\n'],
      ['design', '# Design Document\n\n## Overview\n'],
      ['tasks', '# Implementation Plan\n\n## Tasks\n\n- [~] 1.1 a\n\n## Notes\n'],
      ['bugfix', '# X\n'],
    ]
    let checked = 0
    for (const [artifact, markdown] of docs) {
      for (const f of diagnose({ artifact, markdown })) {
        checked += 1
        if (f.source === 'kiro-binary') {
          assert.ok(KIRO_RULE_CODES.includes(f.code), `${f.code} 标成 kiro-binary，但它不在 41 条规则表里`)
        }
      }
    }
    assert.ok(checked > 0, '一条 finding 都没检查到——这条断言会恒真')
  })
})

describe('Task 2 — KIRO_BUNDLE 是复刻件身份，由壳带在输出上', () => {
  it('包把 KIRO_BUNDLE 原样转出（与 kiro-rules 是同一个对象）', () => {
    assert.equal(pkg.KIRO_BUNDLE, KIRO_BUNDLE)
  })

  it('KIRO_BUNDLE 字段齐全', () => {
    for (const field of ['version', 'bytes', 'sha256', 'extractedAt']) {
      assert.ok(KIRO_BUNDLE[field] !== undefined, `KIRO_BUNDLE 缺 ${field}`)
    }
  })

  it('每条 finding 不重复携带它（母计划：validator 在输出里带上它，不是每条 finding 一份）', () => {
    // 这条断言在评审里被改正过：原先 `diagnose()` 从不贴 bundle，而契约测试只测了一个
    // 只有测试在用的工具函数 `attachKiroBundle` —— 典型的「测了助手，没测行为」。
    // 现在把口径写死：bundle 只导出，不在 finding 上复制。
    const findings = diagnose({ artifact: 'tasks', markdown: '# Implementation Plan\n' })
    assert.ok(findings.length > 0)
    for (const f of findings) {
      assert.ok(!('kiroBundle' in f), `${f.code} 上贴了 kiroBundle —— 与「validator 在输出里带上它」不一致`)
    }
  })
})

describe('Task 2 — location.line 的单位与真机一致（0 基）', () => {
  it('文档级规则用 0，行级规则用真实下标', () => {
    // 真机 Kiro 实测：第 10 行的畸形复选框报 line: 9；tasks/missing-dependency-graph 报 line: 0。
    const doc = [
      '# Implementation Plan', '', '## Overview', '', '> x', '', '## Tasks', '',
      '- [x] 1.1 ok', '- [/] 1.2 bad', '  - [ ] nope', '', '## Notes', '', '> x', '',
    ].join('\n')
    const byCode = Object.fromEntries(diagnose({ artifact: 'tasks', markdown: doc }).map((f) => [f.code, f.location.line]))
    assert.equal(byCode['tasks/malformed-checkbox'], 9, '行级规则应报真实 0 基下标')
    assert.equal(byCode['tasks/invalid-subtask-line'], 10)
    assert.equal(byCode['tasks/missing-dependency-graph'], 0, '文档级规则用 0')
  })

  it('anchored 判别位：文档级为 false、行级为 true（第 3.6 期 Task 0.2）', () => {
    // `line` 的数值一个字节没动（与真机对齐是 3.5 期的判据）；二义由判别位消解。
    const doc = [
      '# Implementation Plan', '', '## Overview', '', '> x', '', '## Tasks', '',
      '- [x] 1.1 ok', '- [/] 1.2 bad', '  - [ ] nope', '',
    ].join('\n')
    const byCode = Object.fromEntries(diagnose({ artifact: 'tasks', markdown: doc }).map((f) => [f.code, f.location]))
    assert.equal(byCode['tasks/missing-dependency-graph'].anchored, false, '文档级不锚定')
    assert.equal(byCode['tasks/missing-dependency-graph'].line, 0, 'anchored:false 时 line 必须是 0')
    assert.equal(byCode['tasks/missing-notes'].anchored, false, '文档级不锚定')
    assert.equal(byCode['tasks/malformed-checkbox'].anchored, true, '行级必须锚定')
    assert.equal(byCode['tasks/malformed-checkbox'].line, 9, '行级仍报真实 0 基下标')
  })

  it('判别位不靠 line 的数值推断：line:0 既可以是第 1 行、也可以是文档级', () => {
    // 这条钉死的是第 3.6 期对计划写法的那处订正：计划给的判别式
    // `Number.isInteger(line) && line >= 0` 会被默认值 0 满足，从而把每一条文档级
    // finding 都误标成 anchored。只有显式传递才可区分。
    const base = { code: 'tasks/missing-notes', severity: 'warning', message: 'x', area: 'tasks', line: 0 }
    assert.equal(makeFinding({ ...base, anchored: true }).location.anchored, true)
    assert.equal(makeFinding({ ...base, anchored: false }).location.anchored, false)
    assert.equal(makeFinding({ ...base, anchored: true }).location.line, 0, '锚定在第 1 行时 line 仍是 0')
  })
})

describe('Task 2 — suggestedAction 在缺具名目标时给出可操作建议', () => {
  it('缺章节类的 finding 带 suggestedAction；非章节类不带', () => {
    // 需求块存在但没有 `#### Acceptance Criteria` → 这条是**非**具名章节类，不该有建议。
    const req = [
      '# Requirements Document', '', '## Introduction', '', '> x', '', '## Glossary', '', '> x',
      '', '## Requirements', '', '### Requirement 1: x', '', '**User Story:** as a', '',
    ].join('\n')
    const missing = diagnose({ artifact: 'requirements', markdown: req })
      .find((f) => f.code === 'requirements/missing-acceptance-criteria')
    assert.ok(missing, '这份文档应当报缺 Acceptance Criteria')
    assert.equal(missing.location.line, 12, '真机对这条报的是需求块的标题下标')
    assert.equal(missing.suggestedAction, 'Add a #### Acceptance Criteria section.', '它有具名目标，应当给建议')

    // 规则表里没有 `display` 的码不给建议（`tasks/invalid-dag-structure` 就是一条）。
    const noTarget = diagnose({
      artifact: 'tasks',
      markdown: '# Implementation Plan\n\n## Overview\n\n> x\n\n## Tasks\n\n## Task Dependency Graph\n\n```json\n{}\n```\n\n## Notes\n\n> x\n',
    }).find((f) => f.code === 'tasks/invalid-dag-structure')
    assert.ok(noTarget, '这份文档应当报 DAG 结构错')
    assert.equal(noTarget.suggestedAction, undefined, '没有具名目标就不该编一个建议出来')

    const section = diagnose({ artifact: 'tasks', markdown: '# Implementation Plan\n' })
      .find((f) => f.code === 'tasks/missing-notes')
    assert.equal(section.suggestedAction, 'Add a ## Notes section.')
  })
})
