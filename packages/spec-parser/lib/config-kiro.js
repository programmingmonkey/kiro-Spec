// `.config.kiro` 的**识别器** —— 真机 Kiro 写在 spec 目录里的类型元数据。
//
// 为什么需要它：Kiro 建一个 spec 时，除了三份 md，还会在
// `.kiro/specs/<feature>/` 下写一份 `.config.kiro`，内容是
//
//     {"specId": "<uuid>", "workflowType": "...", "specType": "..."}
//
// 官方 prompt 模板的原话是 `the model MUST also create the config file`，refinement 期
// 还专门规定 `Preserve .config.kiro — do NOT recreate it`。它是**权威**：真机用它决定
// 规则表（`validateSpecDocument(text, docType, specType)` 的第三个入参）、文档清单顺序
// （`workflowType === FastTask`）、以及 IDE 侧的 context key。
//
// 🔴 而本仓此前**全仓零处理**它。后果不是「少读一个文件」，是**判定源分叉**：
// 真机从 `.config.kiro` 读 `specType`，本仓只能靠 `bugfix.md` 是否存在来猜。两者会在
// 三种情形下不一致（见 T3 的三条断言）。所以这个模块存在的理由是**把判定源对齐**。
//
// 枚举逐字取自真机 bundle（2026-09-16，kiro.kiro-agent 1.1.28，sha256 ce29c664…）：
//
//     el = { RequirementsFirst:"requirements-first", DesignFirst:"design-first",
//            FastTask:"fast-task", VerifyFirst:"verify-first" }        // WorkflowType
//     Mo = { Feature:"feature", Bugfix:"bugfix", QuickSpec:"quick-spec" }  // SpecType
//
// ⚠️ 判据口径 = 真机**每条字段各自白名单**（`resolveSpecType` 与 `FVu` 那条路径），
// 不是 `isValidSpecConfig` 那条更严的门。理由：真正决定诊断结果的正是前者
// （`d.specType===Mo.Bugfix ? ... : Mo.Feature ? ... : Mo.QuickSpec ? ... : void 0`），
// 而后者只服务 IDE 的 context key。两者严格度不同是**实测事实**，不是我的取舍：
//
//   · `FVu`：`typeof l.workflowType=="string" && $Vu(l.workflowType) && (u.workflowType=…)`
//            —— 逐字段：类型对 **且** 在白名单里才收，否则**静默丢掉这一个字段**；
//   · `Jmp`（isValidSpecConfig）：只要 `specId` 存在而类型不对、或 `workflowType` 存在而
//            不在枚举里，就判**整份配置无效**，读出来是空对象。
//
// 本模块走前者：逐字段收，`Jmp` 会判「整份无效」的那些形态在这里**仍是 `usable:true`**，
// 只是不合格的字段取不到值（例如 `specId` 是数字 → `specId: undefined`，其余照收）。
// `usable:false` 只留给真正读不出对象的两种情形（`INVALID_JSON` / `NOT_AN_OBJECT`）。
// （2026-09-17 订正：此处原写作「把整份无效也照实报成 `usable:false`」，与实现不符。）
//
// 本模块**零 I/O、零 import、恒不抛**（与同目录 `task-format.js` / `event-format.js`
// 的既有约束一致）。文件读取由宿主自己做：`spec-parser` 是纯函数层，加一行 `node:fs`
// 会让它失去「可被任何宿主嵌入」的性质。

/** 文件名。真机的读取点全部写死这个字面量，没有配置项。 */
export const CONFIG_KIRO_FILE = '.config.kiro'

/** 真机 `WorkflowType` 的四个取值（逐字，顺序照 bundle 的声明序）。 */
export const WORKFLOW_TYPES = ['requirements-first', 'design-first', 'fast-task', 'verify-first']

/** 真机 `SpecType` 的三个取值（逐字）。 */
export const SPEC_TYPES = ['feature', 'bugfix', 'quick-spec']

const WORKFLOW_SET = new Set(WORKFLOW_TYPES)
const SPEC_TYPE_SET = new Set(SPEC_TYPES)

/**
 * 把 `.config.kiro` 的**文本**解析成可用的类型元数据。
 *
 * 返回一个**判别式结果**，四种形态互相可区分（这是本模块的主要价值 —— 真机把这几种
 * 情形压成同一个「读不到」，而本仓需要说清「是文件不在」还是「文件在但不可用」）：
 *
 * ```js
 * { present: false }                                  // 宿主没读到文件
 * { present: true, usable: false, code: 'INVALID_JSON' }
 * { present: true, usable: false, code: 'NOT_AN_OBJECT' }
 * { present: true, usable: true, specType, workflowType, specId, extraKeys }
 * ```
 *
 * `usable: true` 而三个字段**全是 `undefined`** 是**合法结果**，对应盘上实测到的那两种
 * 非标准形态（`{"specName":…,"specVersion":…}` 与 `{"spec":…}`）：它们既没有
 * `specType` 也没有 `workflowType`，真机读出来同样什么也没有（`isValidSpecConfig` 对
 * 它们**判 true**，因为两个键都不存在）——所以这里也**不报错**，只是取不到值。
 *
 * @param {unknown} text 文件内容；非字符串一律按「没读到」处理
 */
export function parseConfigKiro(text) {
  if (typeof text !== 'string' || text.trim() === '') return { present: false }

  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    // 坏 JSON 是**这一份配置不可用**，不是「没有配置」——宿主据此可以不回落推断，
    // 但本模块不替它决定，只如实报出。
    return { present: true, usable: false, code: 'INVALID_JSON' }
  }
  if (raw === null || typeof raw !== 'object') {
    // 数组**不**落进这里：`typeof [] === 'object'`，它会被当成一个没有相关键的对象，
    // 与真机一致（`FVu` 同样只挡 null 与非对象）。
    return { present: true, usable: false, code: 'NOT_AN_OBJECT' }
  }

  // 逐字段白名单：类型对了、值也在枚举里，才收；否则丢这一个字段。
  const specType = typeof raw.specType === 'string' && SPEC_TYPE_SET.has(raw.specType)
    ? raw.specType
    : undefined
  const workflowType = typeof raw.workflowType === 'string' && WORKFLOW_SET.has(raw.workflowType)
    ? raw.workflowType
    : undefined
  // `specId` 只查类型，不查形状。盘上实测 77 份里只有 46 份是合法 UUID，另 31 份缺失
  // 或不是 UUID —— 它**不可当必填、也不可当主键**，故这里不校验 UUID 形状。
  const specId = typeof raw.specId === 'string' ? raw.specId : undefined

  // 盘上实测 8 种 keys 形态，其中 6 种带额外字段（`createdBy` / `note` / `extends` /
  // `createdAt` / `featureName`）。它们是被 agent 或人手工加上的，**读取端一律忽略**
  // （真机也只取那三个键），但记下来能让「这文件被手工改过」变成可观测的事实。
  const extraKeys = Object.keys(raw).filter(
    (key) => key !== 'specType' && key !== 'workflowType' && key !== 'specId',
  )

  return {
    present: true,
    usable: true,
    specType,
    workflowType,
    specId,
    extraKeys,
    // 这个文件到底认不认得出类型 —— 供宿主决定「是否还值得回落推断」。
    hasType: specType !== undefined || workflowType !== undefined,
  }
}

/**
 * `SpecType` → 本仓的 **kind** 词汇（`feature` / `bugfix` / `quick`）。
 *
 * ⚠️ 注意 `quick-spec` → `'quick'` 是**跨词汇表**的映射，不是改名：dsh-spec 把 quick 当
 * **kind**（`spec_init kind=quick`），而且它 `init` 时把 `workflow` 记成
 * `requirements-first`，所以 `quick` 在本仓的 workflow 轴上**没有对应值**。
 * 故调用方应当把 kind 与 workflow 分开用，不要拿这个返回值去填 workflow 字段。
 *
 * 未知取值返回 `undefined`（而不是 'feature'）——「不认识的类型」与「确定的 feature」
 * 是两件事，静默合并会让第三种类型出现时读起来像第一种。
 */
export function specTypeToKind(specType) {
  if (specType === 'feature') return 'feature'
  if (specType === 'bugfix') return 'bugfix'
  if (specType === 'quick-spec') return 'quick'
  return undefined
}
