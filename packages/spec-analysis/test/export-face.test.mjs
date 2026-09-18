// 五个模块的**逐名导出面**（Requirement 2.6；design 的 Components 表；task 3.3 的完成判据）。
//
// 旧套件到不了的路径：整个 dsh-spec 套件里没有一条断言「某个模块导出了哪些名字」。
// 唯一的守卫是 `capabilities.test.mjs:73` 那条静态只读扫描（它读源码文本，不看导出），
// 而它在搬移时跟着模块走了。于是「搬移/收敛时丢掉一个导出」这件事在本期之前**没有任何
// 断言能发现** —— 它只会在某个宿主导入时炸，而那个宿主可能不在本仓库里（第 6 期的
// claude-spec 就是这种宿主）。
//
// 期望名单**手写**自 `design.md` 的 Components 表（而不是从模块现读）：
// 现读再比现读是恒真的。写下这份名单的人就是那个「承诺」，改动它必须同时改 design.md
// —— 这正是这条断言存在的意义。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { MODULES, REPO_ROOT, modulePath } from './tools/locate-modules.mjs'

const EXPECTED = {
  checklist: [
    'EARS_KEYWORDS',
    'REQUIREMENTS_FILE',
    'TASKS_FILE',
    'VAGUE_QUANTIFIERS',
    'checklistRules',
    'evaluateChecklist',
    'findVagueQuantifiers',
    'hasEarsKeyword',
    'hasUserStory',
    'parseAcceptanceCriteria',
    'parseRequirementBlocks',
    'parseRequirementRefs',
    'runChecklist',
    'scanLines',
  ],
  drift: [
    'BASE_SEVERITY',
    'DRIFT_EVIDENCE',
    'DRIFT_STATUSES',
    'REQUIREMENTS_FILE',
    'SEVERITY_LADDER',
    'TASKS_FILE',
    'TASK_STATE_EVIDENCE',
    'buildDriftReport',
    'driftRecommendations',
    'isFrozen',
    'parseTaskEntries',
    'refsFromDetailLine',
    'runDrift',
    'scanLines',
    'severityRank',
    'suppressSeverity',
  ],
  amendments: ['appendDesignAmendment', 'appendRequirement', 'applyParamEdit', 'assertNotTaskBody'],
  archive: ['archiveConflict', 'archiveSpec'],
  signature: [
    'NOTES_HEADING',
    'PARSEABLE_ENVS',
    'RENDERABLE_ENVS',
    'SIGNATURE_ENVS',
    'SIGNATURE_SEPARATOR',
    'SPEC_MD_FILES',
    'appendSignature',
    'checkAttribution',
    'insertSignatureInto',
    'isValidSignatureLine',
    'isSignatureEnv',
    'joinPath',
    'parseSignatureLine',
    'parseSignatures',
    'renderSignature',
    'scanLines',
    'todayDate',
  ],
}

describe('Requirement 2.6 — 五个模块的导出名一个不少、也没有多余', () => {
  for (const mod of MODULES) {
    it(`${mod}.js 的导出面与 design 的表逐名相同（${EXPECTED[mod].length} 个）`, async () => {
      const actual = Object.keys(await import(modulePath(mod))).sort()
      // 分开断言「缺了谁」与「多了谁」：只报一个 diff 时,前者与后者看起来一样。
      const missing = EXPECTED[mod].filter((n) => !actual.includes(n))
      const extra = actual.filter((n) => !EXPECTED[mod].includes(n))
      assert.deepEqual(missing, [], `${mod}.js 少了导出:${missing.join(', ')}`)
      assert.deepEqual(extra, [], `${mod}.js 多了未登记的导出:${extra.join(', ')}`)
      assert.deepEqual(actual, [...EXPECTED[mod]].sort())
    })
  }

  it('signature 的 scanLines 就是共享层那一个（收敛后不该再有第二份）', async () => {
    const mod = await import(modulePath('signature'))
    const shared = await import('@my-harness/spec-parser/scan-lines')
    assert.equal(mod.scanLines, shared.scanLines)
  })

  it('design.md 的 Components 表点名了每个模块的导出——名单与本文档同源', (t) => {
    // ⚠️ 本项在公开仓里 **skip-with-loud-message**：它读的是开发仓库自己的那份 spec
    // 设计稿，属开发史材料，不在本仓。断言比的是那份文档的字节，合成不出来 ——
    // 所以公开仓的状态不是「绿」，是「本仓没跑这一项」。
    const designPath = `${REPO_ROOT}/.kiro/specs/spec-analysis-extraction/design.md`
    let design
    try {
      design = readFileSync(designPath, 'utf8')
    } catch {
      t.skip(`开发仓库的 spec 不在场，这一项不核：${designPath}`)
      return
    }
    for (const [mod, names] of Object.entries(EXPECTED)) {
      const row = design.split('\n').find((l) => l.startsWith(`| \`${mod}.js\` |`))
      assert.ok(row, `design.md 的 Components 表里没有 ${mod}.js 那一行`)
      const missing = names.filter((n) => !row.includes(n))
      assert.deepEqual(missing, [], `design.md 的 ${mod}.js 那行漏了:${missing.join(', ')}`)
    }
  })
})
