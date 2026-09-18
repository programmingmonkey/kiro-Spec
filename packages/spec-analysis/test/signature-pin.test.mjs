// 把「移植版」和消费项目的真文件钉在一起。
//
// **旧套件到不了的那条路径**：`signature-gate.test.mjs` 测的是我们这一份判定
// 自身自洽（正反例都对），但它从头到尾**没有打开过消费项目的 `.githooks/pre-commit`**。
// 于是「我们的实现是对的」与「我们的实现和消费项目一致」这两件事，旧套件只覆盖了前一件。
// 本文件读那份真文件做逐字符比对，补的就是后一件。
//
// 🔴 为什么必须有这条：`CONSUMER_SIG_RE` 与 `isValidSignatureLine` 是
// 消费项目 `.githooks/pre-commit` 里 `is_valid_signature` 的**逐字符移植**——也就是
// 第 6 期风险 R6-2 点名的「同源副本」。移植本身没问题（hook 是 Python，跨语言没法共享），
// 有问题的是**没有任何东西会在它漂掉时报出来**。
//
// 这件事在消费项目侧刚刚真实发生过一次：2026-09-13 之前 hook 的白名单是
// `(Kiro|DSH|Codex)`，而 steering §4.3.2 已经写着四个标识含 Claude —— 两处对不上，
// 合规署名被报「没署名」，而它是 warn 级，于是被当噪音忽略了。按仓库自己的记录，
// 那是「改三漏一」的第三次复发。这条测试防的就是第四次。
//
// 语料缺席时 **skip 并大声说明**，不静默通过（第 3.5 期的教训：静默降级最难查）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConsumerRoot, consumerAbsenceMessage } from '../../../scripts/consumer-root.mjs'
import { isValidSignatureLine } from '../lib/signature.js'

// 我们这一侧的源，写成字面量而不是 `RegExp.source`：要比的是「人写下的那份承诺」，
// 现读再比现读是恒真的（与 export-face 那条测试同一个道理）。
const OURS = String.raw`^-\s+\d{4}-\d{2}-\d{2}\s*·\s*(Kiro|DSH|Codex|Claude)\s*·\s*(\S.*)$`

// Python 源码里中点写成 `·` 转义；归一化后再比，避免把「写法不同」误判成「判定不同」。
const normalise = (src) => src.replace(/\\u00b7/g, '·').replace(/\s+$/, '')

test('🔴 署名正则与消费项目的 .githooks/pre-commit 逐字符一致（漂了就红）', (t) => {
  const { root, resolved } = resolveConsumerRoot()
  if (!resolved) {
    t.skip(`未跑，不是通过：${consumerAbsenceMessage('.githooks/pre-commit 的 is_valid_signature')}`)
    return
  }
  const hook = readFileSync(join(root, '.githooks', 'pre-commit'), 'utf8')
  const m = /^sig = re\.compile\(r"(.+)"\)$/m.exec(hook)
  assert.ok(m, 'pre-commit 里找不到 `sig = re.compile(r"...")` —— 它可能被改写了，这条移植要重新核对')
  assert.equal(
    normalise(m[1]),
    normalise(OURS),
    '移植版与消费项目的正则已经漂开。事实源永远是消费项目那一份：以它为准改这边，' +
      '不要反过来改消费项目迁就我们。',
  )
})

// 🔴 2026-09-17：这一条从「钉住 hook 里那句 Python 表达式」改成**执行 hook 自己的
// `is_valid_signature`**，与我们这一份逐例对齐。
//
// 为什么换：原版 `assert.match(hook, /return environment != "Claude" or "Cowork" in description/)`
// 在消费项目 **删掉**那条 Claude 字面量要求时确实红了（逼同步生效 ✓），但它只能发现
// **那一种**改法 —— 那条规则住在函数体里、不在正则里，所以第一种测试（比正则）看不见它，
// 而这条又只能认出自己钉的字面量。也就是说：hook 换任何**别的**改法（再加一条按环境的
// 要求、改判定顺序、加第三条判据），两条测试都可能同时是绿的。
//
// 现在这条测的是**行为等价**：把 hook 的 `sig` 与 `is_valid_signature` 原样抽出来跑，
// 拿同一个用例表分别问两边的实现，逐例比对。hook 怎么改都行 —— 只要两边判定不再一致，它就红。
// 这正是「事实源永远是消费项目那一份」这条承诺**可执行**的形态。
const CASES = [
  '- 2026-09-13 · DSH · 补需求边界',
  '- 2026-09-13 · Kiro · 补需求边界',
  '- 2026-09-13 · Codex · 补需求边界',
  // 🔴 撤销后的关键用例：Claude 的说明**不含** `Cowork` 也必须合法。
  '- 2026-09-13 · Claude · 补需求边界',
  '- 2026-09-13 · Claude · Cowork；补需求边界',
  // 白名单外的环境、与旧格式（管道符）—— 两边都该拒。
  '- 2026-09-13 · Gemini · 补需求边界',
  '- 2026-09-13 | Claude | Cowork；补需求边界',
  // 第二个中点后必须**非空**：只写环境名不算署名。
  '- 2026-09-13 · DSH · ',
  '- 2026-09-13 · DSH',
  // 顶层列表项之外的形态（`###` 标题、缩进）在真机判据里不合法（解析器那边另收）。
  '### 2026-09-13 · DSH · 补需求边界',
  '  - 2026-09-13 · DSH · 补需求边界',
]

test('🔴 署名判定与 hook 的 `is_valid_signature` **逐例行为等价**（hook 怎么改都会红）', (t) => {
  const { root, resolved } = resolveConsumerRoot()
  if (!resolved) {
    t.skip(`未跑，不是通过：${consumerAbsenceMessage('is_valid_signature 的行为')}`)
    return
  }
  const hook = readFileSync(join(root, '.githooks', 'pre-commit'), 'utf8')
  const compileLine = /^sig = re\.compile\(r".+"\)$/m.exec(hook)
  assert.ok(compileLine, 'pre-commit 里找不到 `sig = re.compile(r"...")` —— 这份移植要重新核对')
  const fn = /^def is_valid_signature\(line\):\n(?:[ \t]+.*\n?)+/m.exec(hook)
  assert.ok(fn, 'pre-commit 里找不到 `def is_valid_signature(...)` 的函数体 —— 这份移植要重新核对')

  // 抽出来原样跑。`-c` 而不是写临时文件：这些代码片段本来就是真机文件的一部分，不需要落盘。
  // ⚠️ hook 里 `import os, re, subprocess, sys` 写在整段 Python 的开头（那段被 shell 变量
  // `SPEC_SIG_PY` 包着），而 `is_valid_signature` 只用得到 `re` —— 所以这里**补上 import**
  // 而不是假装它能独立运行。第一版漏了它，报的 `NameError: name 're' is not defined`
  // 正是这条测试该说的话（我把它读成了「hook 改了」，其实是抽取时少了一行）。
  const script = `import re\n${compileLine[0]}\n${fn[0]}\nimport json, sys\nprint(json.dumps([bool(is_valid_signature(c)) for c in json.loads(sys.argv[1])]))\n`
  let theirs
  try {
    theirs = JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(CASES)], { encoding: 'utf8' }))
  } catch (caught) {
    // undefined ≠ 不一致：hook 的判定若不再自足（引用了别的 helper），这条移植失去依据。
    // 大声失败而不是 skip —— 静默降级最难查（第 3.5 期的教训）。
    assert.fail(`跑不动 hook 的 is_valid_signature（它可能不再自足）：${caught.stderr || caught.message}`)
  }
  assert.equal(theirs.length, CASES.length)

  const ours = CASES.map((line) => isValidSignatureLine(line))
  for (const [index, line] of CASES.entries()) {
    assert.equal(
      ours[index],
      theirs[index],
      `第 ${index} 个用例两边判定不一致：${JSON.stringify(line)}\n` +
        `  我们：${ours[index]}　hook：${theirs[index]}\n` +
        '事实源永远是消费项目那一份：以它为准改这边，不要反过来改消费项目迁就我们。',
    )
  }
  // 判别力：用例表里必须**同时**有 true 与 false，否则「全绿」可能只是因为两边都全拒。
  assert.ok(new Set(theirs).size === 2, `用例表没有同时覆盖合法与非法（得到 ${JSON.stringify(theirs)}）`)
})

