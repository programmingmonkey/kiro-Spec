// Tool-surface regression test (spec task 6.1 / Req 8.1).
//
// The work adds five tools. Req 8.1 forbids changing the EXISTING ones in the
// process: a caller that already passes `{ dryRun: true }` to spec_run, or
// relies on spec_write requiring both `file` and `content`, must keep working.
// A silent signature change is the kind of break that only shows up in someone
// else's session, so the pre-change surface is frozen in a fixture and asserted
// here rather than eyeballed once.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { mount } from './harness.mjs'
import { __test as __testExport } from '../lib/index.js'

const baseline = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tool-surface-baseline.json'), 'utf8'),
)
// 第 2 期 Task 4.1 新增：**当前** 13 个工具的完整签名，与 baseline 并存。
// 两份文件各自有 `note` 说明用途 —— baseline 是历史不变量（8 + 1，改造前），
// current 是当前快照（13 + 1）。断言因此分两组，见文件末尾。
const current = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tool-surface-current.json'), 'utf8'),
)
const CURRENT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tool-surface-current.json')

const RETAINED_TEST_EXPORTS = [
  'BUGFIX_SECTIONS',
  'DESIGN_BUGFIX_SECTIONS',
  'DESIGN_FEATURE_SECTIONS',
  'KIRO_CHECKBOX_CHARS',
  'KIRO_RULE_CODES',
  'LEGACY_CODE_REMAP',
  'MIGRATABLE_FILES',
  'REPO_CODES',
  'RULE_CODE_COUNT',
  'SPEC_FILES',
  'VIEWABLE_FILES',
  'bugfixTemplate',
  'buildTaskPrompt',
  'buildWavePlan',
  'clipContext',
  'collectDesignSections',
  'collectHeadings',
  // 2026-09-13 · 第 4 期 Task 6（R3 父任务收敛）新增。登记它的理由不是「顺手导出」：
  // 真实嵌套语料有 86 份（消费项目），走工具调用逐份验证要落盘几十次；导出这个纯函数
  // 才能对语料做「叶子全完成后父任务必须收敛」的直接判定。
  'convergeParents',
  'designTemplate',
  'diagnoseArtifact',
  'diagnoseDependencyGraph',
  'diagnoseDesignProperties',
  'diagnoseTaskBody',
  'diagnoseWavesConsistency',
  'duplicateTaskIds',
  'executableUnitCount',
  'extractRequirementBlocks',
  'featureName',
  'formatTaskId',
  'hasUnterminatedFence',
  'nextTask',
  'parentTaskIds',
  'parseDependencyGraph',
  'parseTask',
  'parseTaskList',
  'phaseOf',
  'referencedRequirementIds',
  'requirementsTemplate',
  'runBatched',
  'scanLines',
  'sniffDesignVariant',
  'taskDetailText',
  'taskStats',
  'tasksTemplate',
]


// The plugin's own parameter spec, flattened to { params, required }.
function surface(root) {
  const { tools, commands } = mount(root)
  const out = { tools: {}, commands: [...commands.keys()] }
  for (const [name, def] of [...tools.entries()].sort()) {
    const props = def.parameters?.properties ?? {}
    out.tools[name] = {
      params: Object.keys(props).sort(),
      required: [...(def.parameters?.required ?? [])].sort(),
    }
  }
  return out
}

describe('Req 8.1 — the pre-existing tools keep their exact call signatures', () => {
  // 🔴 2026-09-13 · 第 4 期 Task 7（F28）**有意**放宽了这条不变量，理由必须写在这里：
  //
  // 原文断言 `params` **逐字段相等**，即禁止任何新增参数 —— 哪怕它是可选的、完全向后兼容的。
  // Task 7 要给写侧五个工具加可选 `spec`（F28：`_active` 是单一可变指针，并发会话一改，
  // `spec_task_set` 就写到别人的 `tasks.md` 上），这必然改变参数名列表。
  //
  // 真正要保的不变量是**「既有调用仍然有效」**，那等价于三件事，比「名字列表相等」更准：
  //   ① 既有参数一个不丢；② 必填项逐字段不变；③ 新增的参数必须是**可选**的。
  // 原断言在①③之外多禁了一条「不许新增」—— 那条不是契约，是当时的实现巧合。
  it('all eight original tools still accept every baseline parameter, and none became required', () => {
    const now = surface('/tmp')
    for (const [name, sig] of Object.entries(baseline.tools)) {
      const live = now.tools[name]
      assert.ok(live, `tool ${name} disappeared`)

      const lost = sig.params.filter((p) => !live.params.includes(p))
      assert.deepEqual(lost, [], `${name} 丢了既有参数：${lost.join(', ')}`)

      assert.deepEqual(live.required, sig.required, `${name} 的必填项变了`)

      const added = live.params.filter((p) => !sig.params.includes(p))
      for (const param of added) {
        assert.ok(
          !live.required.includes(param),
          `${name} 新增的参数 ${param} 是必填的 —— 那不是向后兼容的变更`,
        )
      }
    }
  })

  it('the /spec command is still registered', () => {
    const now = surface('/tmp')
    for (const c of baseline.commands) assert.ok(now.commands.includes(c), `command ${c} disappeared`)
  })

  it('the five new tools are present in addition to the baseline', () => {
    const now = surface('/tmp')
    for (const name of baseline.addedBy) {
      assert.ok(now.tools[name], `new tool ${name} is not registered`)
    }
    // ADDED, not substituted: the baseline set is a strict subset.
    for (const name of Object.keys(baseline.tools)) {
      assert.ok(now.tools[name], `${name} was replaced rather than kept`)
    }
  })

  it('each new tool accepts an optional `spec` so a multi-spec repo stays addressable', () => {
    const now = surface('/tmp')
    for (const name of ['spec_checklist', 'spec_drift', 'spec_sign', 'spec_amend', 'spec_archive']) {
      assert.ok(now.tools[name].params.includes('spec'), `${name} has no spec parameter`)
      assert.ok(!now.tools[name].required.includes('spec'), `${name} must not REQUIRE spec`)
    }
  })
})

describe('Task 4.1 — 当前工具面快照与基线**并存**，两组断言各管一件事', () => {
  it('当前快照恰好是 13 个工具 + 1 个 command', () => {
    assert.equal(Object.keys(current.tools).length, 13)
    assert.deepEqual(current.commands, ['spec'])
  })

  it('两组的关系是「基线 ⊆ 当前」，而且 `addedBy` 的五个确实只在这里带签名', () => {
    for (const name of Object.keys(baseline.tools)) {
      assert.ok(current.tools[name], `基线工具 ${name} 不在当前快照里`)
    }
    for (const name of baseline.addedBy) {
      assert.ok(current.tools[name], `addedBy 工具 ${name} 不在当前快照里`)
      // baseline 里它们**必须**只有名字 —— 那是那份文件的契约。
      assert.equal(baseline.tools[name], undefined, `${name} 不该出现在 baseline 的 tools 里`)
    }
  })

  it('13 个工具的 params/required 逐字段等于实际注册面（快照不是手抄的）', () => {
    const now = surface('/tmp')
    assert.deepEqual(Object.keys(now.tools).sort(), Object.keys(current.tools).sort())
    for (const [name, sig] of Object.entries(current.tools)) {
      assert.deepEqual(now.tools[name].params, sig.params, `${name} 的参数名变了`)
      assert.deepEqual(now.tools[name].required, sig.required, `${name} 的必填项变了`)
    }
  })

  it('两份文件各自有 note，且 baseline 的 note 仍然说的是「改造前」', () => {
    assert.match(current.note, /CURRENT tool surface/)
    assert.match(current.note, /NOT the historical invariant/)
    assert.match(baseline.note, /BEFORE/)
    // baseline 的 note 不能变成假话：它只能记 8 个签名。
    assert.equal(Object.keys(baseline.tools).length, 8)
    assert.equal(baseline.addedBy.length, 5)
  })

  it('fixture 由生成器产出，重跑逐字节相同（不是手改过的）', async () => {
    const { execFileSync } = await import('node:child_process')
    const stdout = execFileSync('node', ['test/tools/gen-tool-surface-current.mjs', '--check'], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    // ⚠️ 只断言「退出码为 0」是**恒真风险**：生成器的 isMain 判断若失败（例如用 `join`
    // 而不是 `resolve` 比 argv[1]），脚本什么都不做也 exit 0，这条断言就永远绿。
    // 所以必须断言它打印了「比过」那句话。
    assert.match(stdout, /一致/, `--check 没有真的比对：${JSON.stringify(stdout)}`)
    assert.ok(existsSync(CURRENT_PATH))
  })
})

describe('Task 4.3 — `__test` 的历史导出面：键一个不删', () => {
  // `lib/index.js` 的注释早就写着「`__test` 的历史导出面（键一个不删，Req 7.2）」，
  // 但**没有任何断言守着它** —— 本期把五个模块搬走时，这句承诺是我自己在提交正文里
  // 复述的，而它当时只由「我的 diff 没碰那些键」保证。本仓库的规矩是：承诺必须有断言。
  //
  // 名单手写（不从 `__test` 现读）：现读再比现读是恒真的。改动这份名单必须是有意的。
  it(`清单里那 ${RETAINED_TEST_EXPORTS.length} 个键一个不少（少了任何一个都会让某个宿主的既有用法在运行时才炸）`, () => {
    const keys = Object.keys(__testExport)
    const missing = RETAINED_TEST_EXPORTS.filter((k) => !keys.includes(k))
    assert.deepEqual(missing, [], `__test 少了:${missing.join(', ')}`)
  })

  it('清单本身是完整的（没有「新增了键但没人登记」这种静默漂移）', () => {
    const extra = Object.keys(__testExport).filter((k) => !RETAINED_TEST_EXPORTS.includes(k))
    assert.deepEqual(extra, [], `__test 新增了未登记的键:${extra.join(', ')} —— 登记它,或说明它为何不该在这里`)
  })
})
