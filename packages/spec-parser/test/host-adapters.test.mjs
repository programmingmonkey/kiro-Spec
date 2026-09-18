// 任务 5.2 / 5.3 的两条断言，对应 design 的 Property 4 / Property 5。
//
// 它们盯的是接线的**正确性**而不是功能：
//   · Property 4：codex-spec 适配层仍导出那 7 个历史名字（revision / task-execution /
//     mcp service / core index 都在用它们，少一个就是某个宿主静默降级）。
//   · Property 5：dsh-spec 侧新增的 `parseTask` 是**纯改名**——对任意行，它的输出必须
//     恒等于「共享层的统一对象按 id→index、title→text 手工映射」的结果。若投影里混进了
//     任何判定逻辑，这一条就会红。它换来的是 dsh-spec 209 项断言零修改。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseTaskLine } from '../lib/task-format.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'difference-matrix.json'), 'utf8'))

const KIRO_ADAPTER = join(ROOT, 'plugins', 'codex-spec', 'lib', 'core', 'task-format.mjs')
const DSH_PLUGIN = join(ROOT, 'plugins', 'dsh-spec', 'lib', 'index.js')

const KIRO_HISTORY_NAMES = [
  'parseTaskLine',
  'taskIndentStack',
  'nextFenceMarker',
  'hasFenceClose',
  'scanTaskLines',
  'metadataValue',
  'replaceTaskState',
]

const DSH_TEST_SURFACE = [
  'SPEC_FILES',
  'KIRO_CHECKBOX_CHARS',
  'scanLines',
  'parseTask',
  'parseTaskList',
  'taskStats',
  'hasUnterminatedFence',
  'nextTask',
  'buildWavePlan',
  'diagnoseArtifact',
]

describe('Property 4 · codex-spec 适配层的导出面不缩水', () => {
  it('七个历史导出名一个不删，且都可调用', async () => {
    const adapter = await import(KIRO_ADAPTER)
    const missing = KIRO_HISTORY_NAMES.filter((name) => typeof adapter[name] !== 'function')
    assert.deepEqual(missing, [], `适配层缺导出：${missing.join(', ')}`)
  })

  it('适配层把策略固定为 strict：`[~]` 是 invalid-state（不是 dsh 的「任务 + valid」）', async () => {
    const adapter = await import(KIRO_ADAPTER)
    assert.equal(adapter.parseTaskLine('- [~] 1. x').kind, 'invalid-state')
    assert.equal(adapter.parseTaskLine('- [ ] 1. x').kind, 'task')
  })
})

describe('Property 5 · dsh-spec 的投影是纯改名', () => {
  it('对 fixture 的每一行，投影输出恒等于按字段名映射手工构造的对象', async () => {
    const { __test: dsh } = await import(DSH_PLUGIN)
    const lines = FIXTURE.rows.filter((row) => row.kind === 'line').flatMap((row) => row.specimens)

    assert.ok(lines.length >= 7, '样本太少，这条断言会变得没有意义')

    for (const { text } of lines) {
      const unified = parseTaskLine(text, { strictTaskState: false })
      const renamed =
        unified === undefined
          ? undefined
          : { index: unified.id, text: unified.title, state: unified.state, valid: unified.valid }
      assert.deepEqual(dsh.parseTask(text), renamed, `${JSON.stringify(text)} 的投影不是纯改名`)
    }
  })

  it('`__test` 导出面保持（测试面与诊断都依赖它）', async () => {
    const { __test: dsh } = await import(DSH_PLUGIN)
    const missing = DSH_TEST_SURFACE.filter((name) => dsh[name] === undefined)
    assert.deepEqual(missing, [], `__test 少了：${missing.join(', ')}`)
  })
})
