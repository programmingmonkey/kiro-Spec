// 第 4 期的**搬移字节证据**：抽取没有改动被搬文件的任何一个字节。
//
// 为什么不是「看 `git diff -M` 显示为 rename」：抽取前 codex-spec 与 claude-spec 的两份
// `event-format.mjs` 逐字节相同，git 的 rename 检测只能按路径序挑一个当源（实测挑中的是
// claude-spec），它**无法**表达「从 codex-spec 搬」。内容哈希是确定的，rename 是启发式的 ——
// 所以这里断言 sha256：它比 rename 显示更强，且能自动复验。
//
// 更新方式：如果确实要有意修改共享实现（不是搬移），改 `EXPECTED_SHARED_SHA256` 并在
// commit message 里说明「这不是搬家，是修改」—— 本文件的作用正是逼你说出这句话。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const SHARED = join(HERE, '..', 'lib', 'event-format.js')
const HOSTS = ['codex-spec', 'claude-spec']

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** 抽取前 `plugins/{kiro,claude}-spec/lib/core/event-format.mjs` 的共同 sha256。 */
const EXPECTED_SHARED_SHA256 = '2bd49728c479d9ccc27a87b331d469eb27c904efd977a8992773a1c6ac11c74e'

describe('搬移字节证据（Requirement: 抽包是搬家，不是重构）', () => {
  it('共享包里的实现与抽取前两份副本逐字节相同', () => {
    assert.equal(
      sha256(readFileSync(SHARED)),
      EXPECTED_SHARED_SHA256,
      '共享实现被改动过。若是有意的修改，请连同 commit message 一起更新 EXPECTED_SHARED_SHA256。',
    )
  })

  for (const host of HOSTS) {
    it(`${host} 的 lib/core/event-format.mjs 只剩转发，不再持有实现副本`, () => {
      // 第 7 期 Task 3：`lib/core/` 的 13 个文件整体搬进 `@my-harness/spec-state`，
      // 于是宿主这一层的转发目标从 spec-parser 变成了 spec-state。**链的终点没变**，
      // 判据跟着实现走 —— 并且要多断言一跳：中间那一层自己也必须是转发，
      // 否则「只剩转发」这句话就只对宿主成立、对整条链不成立。
      const shim = readFileSync(join(REPO, 'plugins', host, 'lib', 'core', 'event-format.mjs'), 'utf8')
      assert.match(shim, /from '@my-harness\/spec-state\/core\/event-format'/,
        '宿主的转发必须指向共享包 —— 本期存在的全部理由就是消灭同源副本')
      const middle = readFileSync(join(REPO, 'packages', 'spec-state', 'lib', 'core', 'event-format.mjs'), 'utf8')
      assert.match(middle, /from '@my-harness\/spec-parser\/event-format'/,
        '中间层也必须转发到 spec-parser，不能把实现留在半路')
      // 实现的两个特征串（解析用的 START 常量、格式化用的 append 逻辑）在**整条链**上都不该出现
      for (const [label, source] of [[`plugins/${host}`, shim], ['packages/spec-state', middle]]) {
        assert.equal(/kiro-spec:execution-events:v1:start/.test(source), false,
          `${label} 里实现又回来了：这正是第 4 期要消灭的分叉形态`)
        assert.equal(/export function appendExecutionEvent/.test(source), false,
          `${label} 里实现又回来了`)
      }
    })
  }

  it('两个 host 的转发壳内容一致（fork 树上没有多开一个不对称的口子）', () => {
    const [a, b] = HOSTS.map((host) => readFileSync(join(REPO, 'plugins', host, 'lib', 'core', 'event-format.mjs'), 'utf8'))
    assert.equal(a, b)
  })
})
