// 静态只读守卫 —— **本期唯一一条「可整体搬」的断言**。
//
// 原名与断言体逐字保留自 `plugins/dsh-spec/test/capabilities.test.mjs:73`：
//
//     it(`${mod}.js has no executable write call`, ...)
//
// 保留名字不是洁癖：改造前 dsh-spec 的测试名集合是 A，改造后 dsh-spec ∪ spec-analysis
// 是 B，A ⊆ B 的记录（本期 spec 的 `## Notes`）只有在名字不动时才说得通。
//
// 为什么这条能搬而其余 44 条不能：它读的是**模块源码文本**（路径相对模块所在目录），
// 不经过 `mount()` + `call('spec_*')` 的装配层。其余 44 条的被测对象是装配层本身，
// 搬走就没有被测对象了 —— 所以它们留在原地，隔着装配层继续测被搬走的代码。
//
// 旧套件到不了的路径：这条守卫在旧套件里读的是**插件的相对路径**（`cwd: new URL('..')`），
// 所以它只能在模块住在那一个目录时成立；模块换位置之后，靠它守住「没被偷偷加回写入」
// 这件事就不再可能（`cat lib/checklist.js` 会直接 ENOENT）。
//
// 唯一改动：位置解析走 `tools/locate-modules.mjs`，于是搬移前后都能定位到那两个模块，
// 而不是靠 `cwd: new URL('..')` 这个只对插件成立的相对路径。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { modulePath } from './tools/locate-modules.mjs'

describe('read-only modules are statically incapable of writing (Req 4.7, 5.2)', () => {
  // The behavioural tests above hash the spec directory before/after, but they
  // can only exercise the code paths they happen to build. This is the static
  // backstop: the two read-only modules must contain no executable write call at
  // all, so a write added in some unexercised branch fails here rather than
  // silently mutating someone's spec.
  for (const mod of ['checklist', 'drift']) {
    it(`${mod}.js has no executable write call`, async () => {
      const src = readFileSync(modulePath(mod), 'utf8')
      const offenders = src
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => {
          const code = line.replace(/\/\/.*$/, '') // ignore trailing comments
          if (/^\s*(\/\/|\*|\/\*)/.test(line.trim())) return false // whole-line comment
          return /\b(port\.writeText|writeText\s*\(|writeFile|unlink|mkdir|rmdir|rename)\b/.test(code)
        })
      assert.deepEqual(offenders, [], `${mod}.js must not write: ${JSON.stringify(offenders)}`)
    })
  }

  it('这条守卫不是恒真的：把一次 writeText 塞进副本，它必须报出来', async () => {
    // 一条静态守卫最容易的失效形态是「正则写错了，于是永远没有 offenders」。
    // 所以拿真实源码做一次**反向**验证：在内存里的副本上注入一次写入。
    for (const mod of ['checklist', 'drift']) {
      const src = readFileSync(modulePath(mod), 'utf8')
      const injected = src.replace(/\n/, '\n// 注入\nawait port.writeText("/x", "y")\n')
      const offenders = injected
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => {
          const code = line.replace(/\/\/.*$/, '')
          if (/^\s*(\/\/|\*|\/\*)/.test(line.trim())) return false
          return /\b(port\.writeText|writeText\s*\(|writeFile|unlink|mkdir|rmdir|rename)\b/.test(code)
        })
      assert.ok(offenders.length > 0, `${mod}.js：注入的写入没有被守卫抓到，说明这条断言是恒真的`)
    }
  })
})
