// 06-claude-spec Task 1 —— Claude 的签名要真的能被消费项目的 pre-commit 放行。
//
// 旧套件到不了的路径：改造前 `renderSignature({env:'Claude', ...})` 直接抛异常
// （`SIGNATURE_ENVS` 里没有 Claude），所以从来没有任何测试断言过「Claude 产出的签名
// 会被消费项目接受」——因为根本产不出来。第 6 期加了 Claude 之后，判据的唯一事实源
// 仍然在消费项目的 `.githooks/pre-commit`（`is_valid_signature`），不是本文件，
// 所以这里测的是 `isValidSignatureLine`（对该函数的逐字符移植）而不是
// 自建一套会漂的判定（母计划 R6-2）。
//
// 三条反向测试先看它红：在加上 Claude 校验之前，①②③ 都应该是「本来就会被
// 消费项目拒绝，但我们这边毫无察觉」的空白——那时补上了断言。
//
// 🔴 2026-09-17 订正（对齐消费项目 **撤销** Claude 的字面量要求）：原来 ① 断言的是
// 「`env=Claude` 而 summary 不含字面量 `Cowork` ⇒ 我们拒绝」。那条要求已连同 Cowork 通道一起
// 退役（理由：**它被插件强制注入，于是不再追踪现实，只制造假台账**），所以 ① 现在断言的是
// **相反的结论**：不含那个词的 Claude 署名**合法**，两边都放行。
// ⚠️ 也就是说本文件里 ① 的方向被翻过一次 —— 下一个看见 diff 的人请把它读成
// 「契约变了」，不是「谁写反了」。跨语言的行为等价由
// `signature-pin.test.mjs` 直接跑 hook 的 Python 逐例比对来守。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isValidSignatureLine, renderSignature, RENDERABLE_ENVS, PARSEABLE_ENVS } from '../lib/signature.js'

describe('06-claude-spec Task 1 — renderSignature 与消费项目 pre-commit 的判定必须同源', () => {
  it('RENDERABLE_ENVS 恰好是 Kiro/DSH/Codex/Claude（Gemini 已从渲染面退场）', () => {
    assert.deepEqual(RENDERABLE_ENVS, ['Kiro', 'DSH', 'Codex', 'Claude'])
  })

  it('PARSEABLE_ENVS 比 RENDERABLE_ENVS 多一个 Gemini（解析仍认历史签名）', () => {
    assert.deepEqual(PARSEABLE_ENVS, ['Kiro', 'DSH', 'Codex', 'Claude', 'Gemini'])
  })

  it('renderSignature({env:"Claude"}) 现在产得出来，且被消费项目的判定放行', () => {
    const line = renderSignature({ date: '2026-09-13', env: 'Claude', summary: 'Cowork；示例改动' })
    assert.equal(line, '- 2026-09-13 · Claude · Cowork；示例改动')
    assert.equal(isValidSignatureLine(line), true, '消费项目的 is_valid_signature 应当放行这一行')
  })

  it('🔴 反向测试 ①（2026-09-17 翻向）— env=Claude 而 summary 不含那个词：合法，两边都放行', () => {
    // 翻向的理由见文件头。这条现在是**撤销那条字面量要求**的落点：它是唯一一条
    // 直接断言「不含 `Cowork` 的 Claude 署名合法」的测试。
    const line = renderSignature({ date: '2026-09-13', env: 'Claude', summary: '这句话没有那个词' })
    assert.equal(line, '- 2026-09-13 · Claude · 这句话没有那个词')
    assert.equal(isValidSignatureLine(line), true, '消费项目的 is_valid_signature 现在应当放行它')
  })

  it('🔴 反向测试 ① 的另一半（同向翻）— 绕过 renderSignature 手写出的同一行，判定也放行', () => {
    const smuggled = '- 2026-09-13 · Claude · 这句话没有那个词'
    assert.equal(isValidSignatureLine(smuggled), true)
  })

  it('反向测试 ② — 分隔符用 | 而不是 ·：消费项目判定必须拒绝（不再兼容管道符）', () => {
    const piped = '- 2026-09-13 | Claude | 管道符分隔的署名行'
    assert.equal(isValidSignatureLine(piped), false)
  })

  it('反向测试 ③ — 署名行有前导空格（缩进进列表容器/代码块）：消费项目判定必须拒绝', () => {
    const indented = '  - 2026-09-13 · Claude · 缩进的署名行'
    assert.equal(isValidSignatureLine(indented), false)
    // 对照：我们自己更宽松的 parseSignatureLine 允许缩进（多宿主的既有行为，不因
    // 消费项目一家的收紧口径而改变）——这条断言记录两者的差异是有意的，不是遗漏。
  })

  it('四个环境都不受任何「按环境分的字面量」影响（撤销之后 Claude 也纳入）', () => {
    // 2026-09-17 之前这条循环只有 Kiro/DSH/Codex —— 那时 Claude 被那条字面量要求挡在外面。
    // 撤销之后它没有例外的理由了，于是**把 Claude 也纳入**：这条因此比原来更强
    // （任何一个环境将来被加上「必须含某个词」的要求，这里都会红）。
    for (const env of ['Kiro', 'DSH', 'Codex', 'Claude']) {
      const line = renderSignature({ date: '2026-09-13', env, summary: '不提任何特殊词也完全没问题' })
      assert.equal(isValidSignatureLine(line), true, `${env} 的签名不该被任何字面量规则误伤`)
    }
  })

  it('渲染面拒绝 Gemini（已从白名单退场），错误信息只列出当前四个可渲染环境', () => {
    assert.throws(() => renderSignature({ env: 'Gemini', summary: 'x' }), /expected one of Kiro, DSH, Codex, Claude/)
  })
})
