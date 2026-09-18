// 真机执行器的自检。
//
// 这是整个「不得比真机更严」判据的地基：它的结论只有在**读出来并执行的是 bundle 自己的代码**时
// 才算数。所以要独立地钉住三件事：
//   ① 注入的两个外部名字（`oE` / `pis.SpecType.Bugfix`，1.1.28 的拼写）与 bundle 原文一致——防止
//      「注入值白名单化」之后校验器的行为悄悄偏离真机；
//   ② 定位锚点失效时**抛**，而不是退化成一个空对象（静默退化会让门槛恒真）；
//   ③ 执行结果非空——校验器真的在判，而不是被 `new Function` 包成了一个空壳。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { SPEC_TYPE, TRIM_END, kiroDiagnose, loadKiroValidators } from './tools/kiro-validators.mjs'

let loaded = null
let loadFailure = null
try {
  loaded = loadKiroValidators()
} catch (error) {
  loadFailure = error
}

const skip = (t) => {
  if (!loadFailure) return false
  t.skip(`真机 bundle 不可用：${loadFailure.message}`)
  return true
}

describe('真机执行器的自检', () => {
  it('四个校验器都取到了', (t) => {
    if (skip(t)) return
    for (const name of ['validateRequirementsFormat', 'validateDesignFormat', 'validateTasksFormat', 'validateBugfixFormat']) {
      assert.equal(typeof loaded.validators[name], 'function', `${name} 没取到`)
    }
    assert.equal(typeof loaded.bundle.sha256, 'string')
    assert.ok(loaded.bundle.bytes > 1_000_000, 'bundle 字节数小得不像真的')
  })

  it('注入的 TRIM_END 与 bundle 原文的 trim 实现行为一致', (t) => {
    if (skip(t)) return
    const text = readFileSync(loaded.bundle.path, 'utf8')
    // 按 bundle **自己的具名标签**找这个函数，不写死 minified 名：1.0.794 叫 `xE`、1.1.28 叫 `oE`。
    // 写死的话每次升版都要动这里，而「写死的名字会过期」本仓已经吃过教训
    // （见 extract-kiro-rules.py 的 resolve_targets）。
    const anchor = /c\((\w+),"trimEnd"\)/.exec(text)
    assert.ok(anchor, 'bundle 里找不到 trimEnd 的具名标签 —— 锚点失效，人工复核后再更新')
    const body = new RegExp(`function ${anchor[1]}\\(t\\)\\{return ([^}]+)\\}`).exec(text)
    assert.ok(
      body,
      `bundle 里 ${anchor[1]} 的形状不是 \`function ${anchor[1]}(t){return …}\` —— 人工复核`,
    )
    // 用 bundle 自己的表达式现场造一个实现，再与注入值对拍。
    const bundleTrim = new Function('t', `return ${body[1]}`)
    const samples = ['', 'x', 'x ', '  x', 'x\t', 'x\n', '  ## Overview  ', '\u00a0x\u00a0', 'x\r\n']
    for (const sample of samples) {
      assert.equal(
        TRIM_END(sample),
        bundleTrim(sample),
        `${anchor[1]}(${JSON.stringify(sample)}) 不一致`,
      )
    }
  })

  it('注入的 SpecType.Bugfix 与 bundle 原文一致', (t) => {
    if (skip(t)) return
    const text = readFileSync(loaded.bundle.path, 'utf8')
    const found = /t\.Bugfix="([^"]+)"/.exec(text)
    assert.ok(found, 'bundle 里找不到 SpecType.Bugfix——锚点失效')
    assert.equal(SPEC_TYPE.Bugfix, found[1], '注入的 Bugfix 字面量与 bundle 不一致')
  })

  it('执行结果是真判定，不是空壳（非空性）', (t) => {
    if (skip(t)) return
    const tasks = kiroDiagnose('tasks', '# Implementation Plan\n', loaded).map((f) => f.rule)
    assert.ok(tasks.includes('tasks/missing-tasks-section'), `真机对这份文档应当报缺 Tasks 段，实得 [${tasks.join(', ')}]`)
    const requirements = kiroDiagnose('requirements', '# Requirements Document\n', loaded).map((f) => f.rule)
    assert.ok(requirements.includes('requirements/missing-introduction'), `实得 [${requirements.join(', ')}]`)
  })

  // 「我们执行的那四个」必须**恰好**是「真机分派的那四个」。
  //
  // 这条钉的是加载面的边界。没有它，1.1.28 那次升版里 `validateLinkHeaderFormat`
  // （同后缀、但校验 HTTP Link 头、不发任何 rule 码）被一起装进来，会以
  // 「ReferenceError: vRs is not defined」的形态把整个加载搞崩——红得像判定出问题，
  // 实际只是名单没设界。反过来，真机若**新增**一个 spec 校验器，这条会点名。
  it('加载面与 validateSpecDocument 的分派面一致', (t) => {
    if (skip(t)) return
    const text = readFileSync(loaded.bundle.path, 'utf8')
    const dispatch = /\.validateSpecDocument\s*=\s*(\w+)/.exec(text)
    assert.ok(dispatch, 'bundle 里找不到 validateSpecDocument —— 锚点失效')
    // 导出赋值与函数定义**离得很远**（中间隔着四个校验器，实测 1.1.28 差 >4000 字符），
    // 故按 minified 名另找定义点，而不是从赋值处取窗口。
    const defs = [...text.matchAll(new RegExp(`function ${dispatch[1]}\\(`, 'g'))]
    assert.equal(defs.length, 1, `bundle 里 function ${dispatch[1]}( 出现 ${defs.length} 次 —— 锚点有歧义`)
    // 定义体实测只有 165 字符；窗口给足余量，不必做花括号配对。
    const window = text.slice(defs[0].index, defs[0].index + 4000)

    // `case"requirements":return GPd(t);` → {requirements: 'GPd'}
    const dispatched = new Map()
    for (const m of window.matchAll(/case\s*"(\w+)"\s*:\s*return\s+(\w+)\(/g)) {
      dispatched.set(m[1], m[2])
    }
    assert.ok(dispatched.size >= 4, `分派表只解析出 ${dispatched.size} 条 —— 形状变了，人工复核`)

    // 分派用的 minified 名，必须与我们从锚点取到的、实际装进 validators 的那批逐名相同。
    const loadedMinified = new Map()
    for (const m of text.matchAll(/c\((\w+),"(validate\w+Format)"\)/g)) {
      loadedMinified.set(m[2], m[1])
    }
    const want = ['validateRequirementsFormat', 'validateDesignFormat', 'validateTasksFormat', 'validateBugfixFormat']
    const seen = new Set()
    for (const [artifact, minified] of dispatched) {
      const friendly = `validate${artifact[0].toUpperCase()}${artifact.slice(1)}Format`
      // bugfix 那档的友好名是 validateBugfixFormat，分派键是 "bugfix" —— 上面的拼接正好命中。
      if (!want.includes(friendly)) continue
      seen.add(friendly)
      assert.equal(
        loadedMinified.get(friendly),
        minified,
        `真机把 ${artifact} 分派给 ${minified}，但锚点说 ${friendly} 是 ${loadedMinified.get(friendly)}`,
      )
    }
    assert.deepEqual([...seen].sort(), [...want].sort(), '分派的 artifact 集合与加载面不一致')
  })

  it('锚点失效时抛，而不是静默退化', () => {
    assert.throws(() => loadKiroValidators('/definitely/not/a/bundle.js'), /读不到 Kiro bundle/)
    // 一个能读到、但里面没有校验器的文件：必须抛，不能返回一个空对象。
    const fake = new URL('./tools/kiro-validators.mjs', import.meta.url)
    assert.throws(
      () => loadKiroValidators(fake.pathname),
      /bundle 里没取到/,
      '缺校验器时没有抛——那会让门槛在升版后静默恒真',
    )
  })
})
