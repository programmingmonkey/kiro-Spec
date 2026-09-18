// 真机 Kiro 的四个 artifact 校验器：从出厂 bundle 里**现读并执行**,不转写。
//
// 为什么是「执行」而不是「复刻语义」:第 3 期的 `kiro-branch.mjs` 只复刻了 tasks 段的四条
// prefix 正则,那是**读码 + 转写**;本模块直接 `new Function` 包住 bundle 里的原函数,判定者是
// Kiro 自己的代码。这使「`kiro-binary` findings ⊆ 真机 getDiagnostics 的实际输出」这条门槛
// 可以被真正执行,而不是被重新实现一遍。
//
// 代价与边界:
//   · bundle 缺席(CWD 不是 macOS / 未装 Kiro)→ 抛,由 caller 决定 skip(**不得**用硬编码顶替);
//   · bundle 升版导致锚点失效 → 抛,人工复核后更新锚点,不得改用硬编码;
//   · 校验器只依赖两个外部名字:trimEnd 与 SpecType 模块。二者在下面按 bundle 原文注入,
//     并各有一条断言(见 test/kiro-validators.test.mjs)防止「注入值与 bundle 脱节」。
//     这两个名字的**minified 拼写会随升版变化** —— 见 INJECTED 的注释。
//
// 本模块是**测试工具**,不进 `lib/`,不属于发布面。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { kiroBundleAbsenceMessage, resolveKiroBundle } from '../../../../scripts/kiro-bundle-root.mjs'

// 定位用锚点:`c(FN,"validateXxxFormat")` 的具名导出行。它只用来找函数首尾。
const NAME_MAP_RE = /c\((\w+),"(validate\w+Format)"\)/g

//: 我们**真正要执行**的四个 —— 恰好是 `validateSpecDocument` 分派的那四个。
//:
//: 🔴 为什么需要这张名单而不是照单全收 `\w+Format`：1.1.28 的 bundle 里多了一个
//: `c(gRs,"validateLinkHeaderFormat")`，而它校验的是 **HTTP Link 头**
//: （`'must be an array or string of format "</styles.css>; rel=preload; as=style"'`），
//: 与 spec 文档无关、也不发任何 `rule:"…"` 码。原先的正则照单全收，于是它被一起装进来 ——
//: 1.1.28 下它读第三个外部名字，把**整个加载**搞崩，红得像 spec 判定出问题，实际是名单没设界。
//: 给名单设界后，「真机是否新增了第 5 个**spec** 校验器」这件事改由
//: `test/kiro-validators.test.mjs` 的「分派一致性」用例来管 —— 它比对
//: `validateSpecDocument` 的 switch，而不是靠后缀猜。
export const REQUIRED_VALIDATORS = [
  'validateRequirementsFormat',
  'validateDesignFormat',
  'validateTasksFormat',
  'validateBugfixFormat',
]

// 注入的**形参名** = bundle 里这两个外部名字当前的 minified 拼写。
//
// 🔴 拼写会随升版重新混淆，这是**实测过两次**的：1.0.794 是 `xE` / `Cts`，
// 1.1.28 变成 `oE` / `pis`（`oE` 在 bundle 里被标为 `c(oE,"trimEnd")`，与 `xE` 是同一个函数；
// `pis` 是导出 `SpecType` 的那个模块命名空间，与 `Cts` 同一个）。**语义没变，只是名字变了。**
// 名字错了不是「红得看不懂」，而是 `new Function` 深处的 `ReferenceError` —— 故 `loadKiroValidators`
// 会当场空跑一次把它逼出来，换成一句指明了名字的话。
const INJECTED = { trimEnd: 'oE', specType: 'pis' }

// 校验器读的外部名字。`oE` 取自 bundle:`function oE(t){return t.trimEnd()}`（1.1.28）。
// 二者都**导出**，好让 `test/kiro-validators.test.mjs` 拿 bundle 原文对拍，防止「注入值与 bundle 脱节」。
export const TRIM_END = (t) => String(t).trimEnd()
// `var HM;(function(t){t.Feature="feature",t.Bugfix="bugfix"...})` —— 只有 Bugfix 被 task 校验读到。
export const SPEC_TYPE = { Feature: 'feature', Bugfix: 'bugfix', QuickSpec: 'quick-spec' }

/** 从一个函数起点做花括号配对,切出完整函数源码。名字不匹配时返回 null（见下）。 */
function sliceFunction(text, anchor, expectedName) {
  const start = text.lastIndexOf('function', anchor)
  if (start === -1 || start > anchor) return null
  // 锚点正则在**注释里**也会命中（本文件自己的注释就写了 `c(FN,"validateXxxFormat")`）。
  // 故这里要求切出来的确实是 `function <捕获到的名字>(`,否则当作假命中跳过 ——
  // 真锚点坏掉时会在下面的「没取到」检查里**响亮地抛**,不会退化成空壳。
  if (!text.startsWith(`function ${expectedName}(`, start)) return null
  const braceAt = text.indexOf('{', start)
  if (braceAt === -1) return null
  let depth = 0
  for (let i = braceAt; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { source: text.slice(start, i + 1), start, end: i + 1 }
    }
  }
  throw new Error('函数体没有闭合——bundle 结构已变')
}

// 🔴 这里**故意不导出** `DEFAULT_BUNDLE_PATH`。它曾经存在，而它就是那个坑：
// 加载器认 `KIRO_EXTENSION_JS`，调用方却拿着这个常量去 `readFileSync` —— 于是设了环境变量
// 之后三条断言全红，红得像「真机 Kiro 与复刻件不一致」，实际只是路径管道。
// 想知道「这次读的到底是哪个文件」，用返回值里的 `bundle.path`：它是**实际用过**的那条。
export function loadKiroValidators(bundlePath = resolveKiroBundle().path) {
  let text
  try {
    text = readFileSync(bundlePath, 'utf8')
  } catch (error) {
    throw new Error(`读不到 Kiro bundle：${bundlePath}（${error.code ?? error.message}）。\n${kiroBundleAbsenceMessage()}`)
  }

  const validators = {}
  for (const match of text.matchAll(NAME_MAP_RE)) {
    const [, minified, name] = match
    // 照单全收会装进同后缀的无关函数（见 REQUIRED_VALIDATORS 的注释）。
    if (!REQUIRED_VALIDATORS.includes(name)) continue
    const sliced = sliceFunction(text, match.index, minified)
    if (!sliced) continue
    // 只注入校验器真正会读到的东西。若 bundle 新引了别的自由变量,这里会抛
    // ReferenceError —— 那是**想要的**:静默少注入一个名字会让判定悄悄失真。
    const factory = new Function(INJECTED.trimEnd, INJECTED.specType, `return (${sliced.source})`)
    const fn = factory(TRIM_END, { SpecType: SPEC_TYPE })

    // 自由变量在**调用**时才解析，构造不报错。空跑一次把它逼到加载期来，并把
    // 「bundle 换了混淆名」翻译成一句能照做的话（否则是 eval 深处的 ReferenceError，
    // 看起来像判定错了，实际只是名字管道）。
    //
    // 覆盖面的诚实边界：空串只能逼出**空串这条路径上**会读到的名字。实测（717 份真实
    // 文档上的并集）四个校验器恰好只读这两个名字，故当前够用；将来若某个名字只在罕见分支
    // 上读，仍会以 ReferenceError 的形式在语料用例里炸——那也比静默失真强。
    try {
      fn('')
    } catch (error) {
      if (error instanceof ReferenceError) {
        throw new Error(
          `bundle 的 ${name} 读到一个没注入的外部名字（${error.message}）。` +
            `实测它应当只读 ${INJECTED.trimEnd}（trimEnd）与 ${INJECTED.specType}（SpecType 模块）。` +
            '若 Kiro 升版重新混淆了这两个名字，把 INJECTED 改成 bundle 里当前的拼写，' +
            '并复核 TRIM_END / SPEC_TYPE 仍与 bundle 原文一致（两条断言在 test/kiro-validators.test.mjs）。',
        )
      }
      // 其它异常是校验器在自己的分支上遇到 undefined 时的正常反应，不在此处收口。
    }
    validators[name] = fn
  }

  for (const name of REQUIRED_VALIDATORS) {
    if (typeof validators[name] !== 'function') throw new Error(`bundle 里没取到 ${name}——锚点已失效`)
  }

  return {
    validators,
    bundle: {
      path: bundlePath,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  }
}

/** 按 `kind` 调真机校验器。`kind` 与 dsh-spec 的 kind 同名。 */
export function kiroDiagnose(kind, content, loaded, options = {}) {
  // `specType` 原样透传（真机收的就是这个三态值）；`isBugfix` 是旧写法。
  const specType = options.specType ?? (options.isBugfix ? SPEC_TYPE.Bugfix : undefined)
  switch (kind) {
    case 'requirements':
      return loaded.validators.validateRequirementsFormat(String(content))
    case 'design':
    case 'designBugfix':
      // design 的形态由内容嗅探决定,与 dsh 的 `sniffDesignVariant` 同源。真机校验器
      // 收的第二个参数是 specType;未显式传 bugfix 时它自己 sniff。
      return loaded.validators.validateDesignFormat(String(content), specType)
    case 'tasks':
      return loaded.validators.validateTasksFormat(String(content), specType)
    case 'bugfix':
      return loaded.validators.validateBugfixFormat(String(content))
    default:
      throw new Error(`未知 kind: ${kind}`)
  }
}
