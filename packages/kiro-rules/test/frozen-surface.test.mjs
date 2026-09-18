import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as rules from '@my-harness/kiro-rules'

// 2026-09-12 抽取前实测。Kiro 升版并重跑 extract-kiro-rules.py 后本值**应当**改变 ——
// 届时连同 RULE_CODE_COUNT 一起更新，并在 commit 里写明 Kiro 版本。
// 它红了不代表出错，代表上游规则集变了，需要人看一眼。
const CODES_SHA = '73440783b2948295bc5ca1d3c110559943467a94336c0195dca18b2830779923'

test('规则码集合与抽取前逐项相同', () => {
  assert.equal(rules.RULE_CODE_COUNT, 41)
  assert.equal(rules.KIRO_RULE_CODES.length, 41)
  assert.equal(new Set(rules.KIRO_RULE_CODES).size, 41, '存在重复 code')
  const sha = createHash('sha256')
    .update([...rules.KIRO_RULE_CODES].sort().join('\n'))
    .digest('hex')
  assert.equal(sha, CODES_SHA, '规则码集合已改变')
})

test('各 area 的 distinct code 数为 7/15/13/6', () => {
  // ⚠️ 不能写成 `new Set(Object.values(KIRO_RULES[area]).flat().map(r => r.code))`。
  // `KIRO_RULES.design.bugfixMarkers` 是 4 条 **RegExp**（不是规则条目，没有 `code`），
  // 直接取 `.code` 会得到 4 个 `undefined`，被 Set 并成 1 个元素，算出 16。
  // distinct code 的定义是「带 code 的条目的去重数」，design 因此是 15 而不是 16：
  //   feature 7 + bugfix 8 + structural 3 = 18 条目 − 3 个跨变体重复 = 15。
  const entries = (area) => Object.values(rules.KIRO_RULES[area]).flat()
  const distinct = (area) =>
    new Set(entries(area).map((r) => r?.code).filter((c) => typeof c === 'string')).size

  // 4 条 code-less marker 必须仍在位 —— 它们消失同样会改变上面的计数，
  // 而这只在计数恰好不变时才看得见，所以单独钉住。
  assert.equal(entries('design').filter((r) => !(r && r.code)).length, 4)
  assert.equal(entries('design').length, 22, 'design 的条目数（含变体重复）')

  assert.deepEqual(
    { requirements: distinct('requirements'), design: distinct('design'),
      tasks: distinct('tasks'), bugfix: distinct('bugfix') },
    { requirements: 7, design: 15, tasks: 13, bugfix: 6 },
  )
})

test('导出面完整 —— 少一个都会让某个宿主静默降级', () => {
  assert.deepEqual(Object.keys(rules).sort(), [
    'KIRO_BUNDLE', 'KIRO_RULES', 'KIRO_RULE_BY_CODE', 'KIRO_RULE_CODES',
    'REPO_CONVENTIONS', 'RULE_CODE_COUNT', 'rulesFor', 'sniffDesignVariant',
  ])
  assert.equal(rules.REPO_CONVENTIONS.length, 8)
})

// `kiro-rules` 是**复刻件**，不是标准：规则逆自某一版 Kiro 出厂 bundle 的
// `kiro.kiro-agent` 扩展。使用者必须能判断「这份表对不对得上我装的 Kiro」，
// 否则复刻件与标准的差异只能靠人肉比对。
//
// ⚠️ 两个廉价字段都**不足以**标识版本，这一点是实测出来的，不是猜的。两次实测：
//
//   · 2026-09-11 20:51 —— bundle 被**重建**（12,978,019 → 12,978,260 字节），
//     而扩展版本号仍是 1.0.794、41 条 rule code 一字未变。→ bytes 变了 ≠ 规则集变了。
//   · 2026-09-16 —— 真升版（1.0.794 → 1.1.28，12,978,260 → 13,161,950 字节）。
//     三个字段全变，而**41 条 rule code 仍逐项相同**（双向差集为空），
//     四个校验器的语义也没变 —— 变的只有 minified 名与 bundle 身份本身。
//     → 版本号/字节数变了也 ≠ 规则集变了，只是更值得去看一眼。
//
// 所以：
//   - bytes 只是最便宜的报警信号，不能当版本；
//   - version 是扩展的语义版本，重建不必然升它；
//   - sha256 才是精确身份，但它跨版本不可比。
// 三者一起给，才能让使用者选一种方式对上自己那台机器。
//
// 这三个值**不是手抄的**：由 `scripts/extract-kiro-rules.py --emit-bundle-meta`
// 从本机扩展实读并打印成可直接粘贴的代码块（见该脚本的注释）。
test('复刻件声明了它复刻的是哪一版 Kiro bundle', () => {
  const b = rules.KIRO_BUNDLE
  assert.ok(b, '缺 KIRO_BUNDLE —— 使用者无从判断这份规则表对应哪一版 Kiro')
  for (const k of ['version', 'bytes', 'sha256', 'extractedAt']) {
    assert.ok(b[k], `KIRO_BUNDLE.${k} 为空`)
  }
  assert.match(b.version, /^\d+\.\d+\.\d+$/)
  assert.match(b.sha256, /^[0-9a-f]{64}$/)
  assert.equal(
    b.bytes,
    13161950,
    'bundle 字节数变了 —— 先跑 extract-kiro-rules.py --emit-bundle-meta 看清是哪一版，' +
    '再重跑提取脚本核对 41 条 code 是否仍逐项相同（bytes 变不代表规则变，2026-09-11 与 2026-09-16 各实测过一例）',
  )
})
