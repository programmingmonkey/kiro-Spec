// 真机把 spec 校验器模块**装了两遍**，而两份的消费者不同 —— 这条用例是那份一致性的**唯一钉子**。
//
// 事实（1.1.28 实测，开发仓实测 §8.4 ②）：副本 1 `GPd/HPd/VPd/WPd` 经 `KPd`
// （= `validateSpecDocument`）供 **IDE 侧**格式诊断；副本 2 `lQu/uQu/dQu/pQu` 经 `fQu`
// 供 **agent 工具 `validate_spec_format`**（其描述原文：*"Use this after a subagent writes
// or fixes a spec document to check for format compliance"*，且它先调 `resolveSpecType`
// —— 也就是读 `.config.kiro` 的那个函数）。
//
// 🔴 为什么值得一条网：本仓的 41 条规则表**只复刻了副本 1**（抽取面按
// `c(FN,"validateXxxFormat")` 的注册锚点取函数）。若某版 Kiro 让两份分岔，抽取面会继续读
// 副本 1，而 **agent 工具跑的是副本 2** —— 判定悄悄分成两套，而**仓库不会响**。
// 那正是本仓最忌讳的那种失败形态：一个检查「检测到了什么都没发生」。
//
// 设计：比较器是**纯函数**（只在文本上工作），于是「它真的会响吗」可以用一段**内存里改坏的
// 文本**当场证明（见最后一条用例），不需要动真机 bundle、也不需要往磁盘写任何东西。
// bundle 缺席时按仓库规矩 **skip-with-loud-message**，不算通过。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { kiroBundleAbsenceMessage, resolveKiroBundle } from '../../../scripts/kiro-bundle-root.mjs'

// ── 比较器（纯函数，零 I/O）───────────────────────────────────────────────────

/**
 * 每个校验器一条**只属于它**的规则码，用来在 bundle 里定位它的两份副本。
 * 与 开发仓实测 §8.4 的实测同源。
 */
export const PROBE_CODE = {
  validateRequirementsFormat: 'requirements/missing-introduction',
  validateDesignFormat: 'design/missing-overview',
  validateTasksFormat: 'tasks/missing-implementation-plan',
  validateBugfixFormat: 'bugfix/missing-introduction',
}

/** 从 `function NAME(` 的定义起点做花括号配对，切出完整函数体。 */
function sliceFunction(text, defIndex) {
  const braceAt = text.indexOf('{', defIndex)
  if (braceAt === -1) return undefined
  let depth = 0
  for (let i = braceAt; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(defIndex, i + 1)
    }
  }
  return undefined
}

/** 偏移量所属的函数名（最近的 `function NAME(` 起点）。 */
function enclosingFunctionName(text, index) {
  const before = text.slice(0, index)
  const matches = [...before.matchAll(/function\s+([\w$]+)\s*\(/g)]
  return matches.length === 0 ? undefined : matches[matches.length - 1][1]
}

/**
 * 用一条专属规则码定位某个校验器的**两份副本**。
 *
 * 按规则码而不是按 `c(FN,"validateXxxFormat")` 找：那个注册锚点**只有副本 1 有**
 * （副本 2 是由 `fQu` 直接调用的裸函数），所以注册锚点是找不到第二份的 —— 而这条用例的
 * 全部意义就在于第二份。
 *
 * 一个码可能在同一份里出现多次（例如 design 的那张表在 feature / bugfix 两张表里都有），
 * 所以先映射到所属函数、再按**首次出现顺序去重**。
 */
export function copiesOf(text, probeCode) {
  const names = []
  for (const match of text.matchAll(new RegExp(`"${probeCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'))) {
    const name = enclosingFunctionName(text, match.index)
    if (name && !names.includes(name)) names.push(name)
  }
  return names.map((name) => {
    const defIndex = text.indexOf(`function ${name}(`)
    return { name, source: defIndex === -1 ? undefined : sliceFunction(text, defIndex) }
  })
}

/** 当前有效的 JS 正则字面量前缀（决定一个 `/` 是正则还是除号）。 */
const REGEX_PREFIX = new Set(['(', ',', '=', ':', 'return', '||', '&&', '[', '!', '?', '', '{', ';'])

/**
 * 有序抽出**字符串字面量**与**正则字面量**。
 *
 * 载体就是这两样：`rule` / `severity` / `message` 是字符串，`pattern` 是正则 ——
 * 也就是说这份序列覆盖了「两份副本在判什么」的全部内容，而 minified 标识符不在其中，
 * 所以序列相同 ⇒ **判定语义相同**（名字不同不影响）。
 *
 * 模板字面量的 `${…}` 插值归一成占位符：两份的模板是同一句，只是嵌进去的 minified 变量名
 * 不同（实测 `Missing ${u} section` vs `Missing ${p} section`）。不归一化会把它误判成不一致；
 * 静态文本仍然逐字比对。
 */
export function literalSequence(source) {
  const out = []
  let i = 0
  let prev = ''
  const n = source.length
  while (i < n) {
    const ch = source[i]

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      let buf = ''
      while (i < n) {
        if (source[i] === '\\') { buf += source.slice(i, i + 2); i += 2; continue }
        if (source[i] === quote) break
        buf += source[i]
        i += 1
      }
      out.push({ kind: 'str', text: quote === '`' ? buf.replace(/\$\{[^}]*\}/g, '${_}') : buf })
      i += 1
      prev = 'str'
      continue
    }

    if (ch === '/' && source[i + 1] !== '/' && source[i + 1] !== '*' && REGEX_PREFIX.has(prev)) {
      i += 1
      let buf = ''
      let closed = false
      while (i < n) {
        if (source[i] === '\\') { buf += source.slice(i, i + 2); i += 2; continue }
        if (source[i] === '\n') break
        if (source[i] === '/') { closed = true; break }
        buf += source[i]
        i += 1
      }
      if (closed) {
        i += 1
        let flags = ''
        while (i < n && /[a-z]/.test(source[i])) { flags += source[i]; i += 1 }
        out.push({ kind: 're', text: `${buf}/${flags}` })
        prev = 're'
        continue
      }
      prev = '/'
      continue
    }

    if (/\s/.test(ch)) { i += 1; continue }
    const ident = /^[\w$]+/.exec(source.slice(i))
    if (ident) { prev = ident[0]; i += ident[0].length; continue }
    prev = ch
    i += 1
  }
  return out
}

/**
 * 副本引用的 **spec-type 属性名**序列（`Bugfix` / `Feature` / `QuickSpec`）。
 *
 * 🔴 为什么字面量比对**覆盖不到**这一层：`pis.SpecType.Bugfix` 与 `Mo.Bugfix` 都是**属性访问**，
 * 属性名是标识符、会被 `literalSequence` 归一化掉。于是「副本 1 判 Bugfix、副本 2 判 Feature」
 * 这种分岔在字面量序列上**完全看不出来** —— 这正是 开发仓实测 §8.4 里我当时得靠**手工**
 * 补一眼的地方。这里把它变成断言。
 *
 * 只比属性名、不比对象别名：`pis.SpecType.X` 与 `Mo.X` 指向同一个枚举对象（`Mo` 就是它本体，
 * `pis` 是把它再导出为 `SpecType` 的模块命名空间），两者的别名本来就该不同。
 */
export function specTypeProperties(source) {
  return [...source.matchAll(/\b\w+(?:\.SpecType)?\.(Bugfix|Feature|QuickSpec)\b/g)].map((m) => m[1])
}

/** 纯比较：返回 findings 数组（空 = 一致）。`text` 可以是真 bundle，也可以是别处来的文本。 */
export function compareCopies(text) {
  const findings = []
  for (const [validator, code] of Object.entries(PROBE_CODE)) {
    const copies = copiesOf(text, code)
    if (copies.length !== 2) {
      findings.push(`${validator}：按规则码 "${code}" 找到 ${copies.length} 份副本，期望 2 份`)
      continue
    }
    if (copies.some((c) => !c.source)) {
      findings.push(`${validator}：副本 ${copies.map((c) => c.name).join('/')} 里有一份切不出函数体`)
      continue
    }
    const [a, b] = copies
    const la = JSON.stringify(literalSequence(a.source))
    const lb = JSON.stringify(literalSequence(b.source))
    if (la !== lb) {
      findings.push(`${validator}：${a.name} 与 ${b.name} 的「字符串 + 正则字面量」有序序列不同`)
    }
    const pa = JSON.stringify(specTypeProperties(a.source))
    const pb = JSON.stringify(specTypeProperties(b.source))
    if (pa !== pb) {
      findings.push(`${validator}：${a.name} 引用 spec-type 属性 ${pa}，而 ${b.name} 引用 ${pb}`)
    }
  }
  return findings
}

// ── 用例 ────────────────────────────────────────────────────────────────────

const bundle = resolveKiroBundle()
let text
let readFailure
try {
  text = readFileSync(bundle.path, 'utf8')
} catch (error) {
  readFailure = error
}

const skip = (t) => {
  if (!readFailure) return false
  t.skip(`真机 bundle 不可用，本次不核两份副本：${readFailure.message}\n${kiroBundleAbsenceMessage()}`)
  return true
}

describe('真机 spec 校验器的**两份副本**必须一致（开发仓实测 §8.4 ③）', () => {
  it('每个校验器恰好定位到两份副本（锚点有效）', (t) => {
    if (skip(t)) return
    for (const [validator, code] of Object.entries(PROBE_CODE)) {
      const copies = copiesOf(text, code)
      assert.equal(
        copies.length,
        2,
        `${validator}：按 "${code}" 找到 ${copies.length} 份（${copies.map((c) => c.name).join(', ') || '无'}）` +
          ' —— 要么副本数变了，要么锚点失效，人工复核后再更新',
      )
      for (const copy of copies) assert.ok(copy.source, `${copy.name} 切不出函数体 —— bundle 结构已变`)
    }
  })

  it('两份的判定内容逐项相同（字面量序列 + spec-type 属性名）', (t) => {
    if (skip(t)) return
    assert.deepEqual(
      compareCopies(text),
      [],
      '两份副本分岔了 —— 本仓的 41 条规则表只复刻**副本 1**（IDE 诊断那条），' +
        '而 agent 工具 `validate_spec_format` 跑的是副本 2。分岔后判定会悄悄分成两套。' +
        '**这需要人判**：要么把规则表跟上真机的新语义，要么显式登记这条差异。',
    )
  })

  it('钉住两份副本的实际名字，好让分岔时的报错可读', (t) => {
    if (skip(t)) return
    // 顺带把「哪两份」记进断言 —— 升版换名后，上一条的报错会直接点名新名字，
    // 不用再去 grep 一遍（1.0.794 是 `f2u/h2u/m2u/g2u` 那一套，1.1.28 换成了下面这组）。
    const found = Object.fromEntries(
      Object.entries(PROBE_CODE).map(([v, code]) => [v, copiesOf(text, code).map((c) => c.name)]),
    )
    assert.deepEqual(found, {
      validateRequirementsFormat: ['lQu', 'GPd'],
      validateDesignFormat: ['uQu', 'HPd'],
      validateTasksFormat: ['dQu', 'VPd'],
      validateBugfixFormat: ['pQu', 'WPd'],
    }, '副本的 minified 名变了 —— Kiro 升版了；复核差异后更新这份名单（它是给人看的，不是判据）')
  })

  it('判别力：改坏副本 2 的一个字面量 / 一个 spec-type 属性，比较器都必须报出来', () => {
    // 🔴 这条是**判据的判据**：没有它，上面那条「逐项相同」可能只是比较器恒返回空数组 ——
    // 也就是本仓最恨的那种「检测到了什么都没发生」。用**内存里**的合成文本证明它真的会响。
    //
    // 合成文本必须让**四条真实规则码**各自都有两份副本：比较器遍历的是真码表，
    // 少一条就会报「找到 0 份副本」（我第一版就踩了这个：基准文本用了假码，于是基准自己就红了）。
    const build = ({ messageDrift = null, propDrift = null } = {}) => {
      const parts = []
      for (const [validator, code] of Object.entries(PROBE_CODE)) {
        const m1 = `m-${validator}`
        const m2 = validator === messageDrift ? `${m1}-副本2改了` : m1
        const p1 = 'Bugfix'
        const p2 = validator === propDrift ? 'Feature' : p1
        parts.push(
          `function A_${validator}(t,e){ if(e===ns.SpecType.${p1}) return []` +
            `; if(!x) return {severity:"error",message:"${m1}",rule:"${code}"}; return [] }`,
        )
        parts.push(
          `function B_${validator}(t,e){ if(e===Mo.${p2}) return []` +
            `; if(!x) return {severity:"error",message:"${m2}",rule:"${code}"}; return [] }`,
        )
      }
      return parts.join('\n')
    }

    assert.deepEqual(compareCopies(build()), [], '基准合成文本（两份一致）不该报任何差异')

    const msgFindings = compareCopies(build({ messageDrift: 'validateTasksFormat' }))
    assert.equal(msgFindings.length, 1, `字面量分岔应当恰好报一条，实得 ${JSON.stringify(msgFindings)}`)
    assert.match(msgFindings[0], /字面量.*有序序列不同/)

    // 属性名那一层单独证明会响 —— 字面量比对**覆盖不到**它（`.Bugfix` 是标识符、会被归一化掉），
    // 这正是 `specTypeProperties()` 单独存在的原因。
    const propFindings = compareCopies(build({ propDrift: 'validateTasksFormat' }))
    assert.equal(propFindings.length, 1, `属性名分岔应当恰好报一条，实得 ${JSON.stringify(propFindings)}`)
    assert.match(propFindings[0], /spec-type 属性/)
    assert.match(propFindings[0], /Bugfix/)
    assert.match(propFindings[0], /Feature/)
  })
})
