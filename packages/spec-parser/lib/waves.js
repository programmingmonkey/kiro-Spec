// 共享解析层：`## Task Dependency Graph` 的 waves 读入。
//
// 第 4 期从 `plugins/{kiro,claude}-spec/lib/core/index.mjs` 摘出（不是整文件搬移）。
// 摘出的理由写在 packages/spec-revision/README.md 的「切法决策」四条里，要点是：
// 它**不是 revision 私有**（`analysis.mjs` 与 `mcp/service.mjs` 各有一个消费者），
// 把它塞进一个叫 "revision" 的包会让「解析 waves」从 revision 包里 import —— 层次是反的。
//
// 实现逐字节照搬原 `index.mjs` 里的同名函数，判据由 scripts/fixtures/revision-golden.json
// 的三组语义对照 + 5 份真实 spec 的两个 hash 兜住（`scripts/revision-golden.test.mjs`）。

import { hasUnterminatedFence, scanLines } from './scan-lines.js'

/** Read modern string-ID waves and the historical integer forms without numeric ID loss. */
export function parseWaves(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.waves)) throw new Error('waves must be an object with a waves array');
  const sourceFormat = parsed.waves.every((wave) => wave && typeof wave === 'object' && Number.isInteger(wave.id) && Array.isArray(wave.tasks) && wave.tasks.every((id) => typeof id === 'string'))
    ? 'modern'
    : 'legacy';
  const waves = parsed.waves.map((wave, index) => {
    const tasks = Array.isArray(wave) ? wave : wave?.tasks;
    if (!Array.isArray(tasks) || !tasks.every((id) => typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id)))) {
      throw new Error(`wave ${index} must contain string or historical integer task IDs`);
    }
    const id = Array.isArray(wave) ? index : (Number.isInteger(wave.id) ? wave.id : index);
    return { id, tasks: tasks.map(String) };
  });
  return { sourceFormat, waves };
}

// ---------------------------------------------------------------------------
// `## Task Dependency Graph` 的**定位**（与上面的 `parseWaves` 分工：那个只管解析
// 一段已经拿到手的 JSON，这个管「JSON 在哪」）。
//
// 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 6.1 条）。
// 原先有两处各自手写的正则，且都用「空白」连接标题与围栏：
//     spec-state/lib/index.mjs         /^## Task Dependency Graph\s*$\s*^```json\s*\n.../m
//     spec-state/lib/core/analysis.mjs /## Task Dependency Graph\s*\n\s*```json\s*\n.../m
// 于是**标题与围栏之间的任何正文行都会让匹配失败**。而消费项目的 spec-conventions.md
// §3.1 **强制**每个 `##` 的下一行写 `> 中文副标题`（理由是 Kiro 诊断器按 `## English`
// 做 exact match，中文只能挪进引用块）。实测该仓 208 份 tasks.md 里 165 份（79%）踩中
// —— 它们的 DAG 对执行器**全部不可见**，退化成逐任务串行且**连一条 warning 都没有**。
// 错误的并行语义比报错难发现得多，所以这里两件事一起修：放宽定位 + 读不到必须出声。
//
// 判据改为与**诊断裁决层**的 `dependencyGraph()` 同构（那一处本来就是对的；这里不写它的包名，
// 因为本包不许反向依赖那一层，连字面提及都被 package-shape 的单向依赖网挡着）：
// 从标题起到**下一个 `##`** 为止划出 section，在 section 内找第一个 ```json 围栏。
// 两个方向都必须守住：
//   · 标题与围栏之间允许任意正文（副标题、说明段）—— 这是本次要修的那个洞；
//   · 不许越过下一个 `##` 去绑别的 section 的 json 围栏 —— 把「图没了」变成「图错了」更糟。
//
// ⚠️ `scanLines` 的 inFence 语义（实测，别按直觉猜）：**开栏行与闭栏行本身也是
// inFence=true**，围栏外才是 false。所以「开栏」的判据是 `inFence[i] && !inFence[i-1]`，
// 而不是「这行长得像 ```json」—— 后者分不出它是开栏还是另一个围栏肚子里的一行文本。
// 未闭合的围栏会一路 inFence 到 EOF，这恰好让 section 边界自动延伸（围栏里的 `## X`
// 不会被误当成下一节的开头），因此不必另行处理。

const GRAPH_HEADING = '## Task Dependency Graph'
// ⚠️ 提成具名常量不是风格偏好：`scripts/scan-recognizers.mjs` 的字面量抽取只认
// `=` `(` `,` `:` `return` 等前缀，写成 `!/…/.test(x)` 会**结构性地扫不到**，
// 于是这条围栏识别器就成了一笔不在册的债。写在这里，登记表看得见它。
const JSON_FENCE_OPEN_RE = /^\s*```json\s*$/

function isGraphHeading(line) {
  return !line.inFence && line.raw.trimEnd() === GRAPH_HEADING
}

/**
 * 定位 `## Task Dependency Graph` 段里第一个**闭合的** ```json 围栏。
 * @returns {{ json: string, headingLine: number } | undefined}
 *   没有该标题、或标题在但段内没有闭合的 json 围栏，都返回 undefined；
 *   两者由 `wavesFromMarkdown` 的 warning 区分。
 */
export function locateWavesJson(markdown) {
  const lines = scanLines(markdown)
  const start = lines.findIndex(isGraphHeading)
  if (start === -1) return undefined

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].inFence && /^## /.test(lines[i].raw)) { end = i; break }
  }

  for (let i = start + 1; i < end; i++) {
    const isOpener = lines[i].inFence && !lines[i - 1]?.inFence
    if (!isOpener || !JSON_FENCE_OPEN_RE.test(lines[i].raw)) continue
    // 开栏之后一路都是 inFence，直到围栏外的第一行；那一行的**前一行**是闭栏。
    let j = i + 1
    while (j < lines.length && lines[j].inFence) j += 1
    // ⚠️ 闭合性**不能**用「j 有没有走到 lines.length」判：围栏恰好闭合在文档最后一行时，
    // j 也会合法地等于 lines.length。
    // 也**不要**在这里自己写一条 `^```` 的定界符正则去认闭栏 —— 本仓 `scripts/recognizer-registry`
    // 把每一处手写的围栏识别器都记成技术债，而且理由成立：围栏只该有一个事实源。
    // 判据改用扫描层已经导出的 `hasUnterminatedFence`：j 没走到头 ⇒ 我们确实出了栏（已闭合）；
    // j 走到头时，只有「整份文档存在未闭合围栏」才说明这一处没闭上。
    if (j >= lines.length && hasUnterminatedFence(markdown)) return undefined // 未闭合
    return { json: lines.slice(i + 1, j - 1).map((l) => l.raw).join('\n'), headingLine: start + 1 }
  }
  return undefined
}

/**
 * 从 tasks.md 正文读出 waves，**并且说明读不出来的时候是为什么**。
 *
 * 🔴 `warnings` 非空而 `waves` 为空 = 执行器将退化为逐任务串行。调用方必须把它透出去，
 * 不许吞掉 —— 静默退化正是第 6.1 条缺陷真正的杀伤点。
 *
 * 注：**没有** `## Task Dependency Graph` 标题不产生 warning。那是「这份 spec 没有图」，
 * 由 `kiro-rules` 的 `tasks/missing-dependency-graph` 在校验期报，不归本函数；在这里也报
 * 会让每一份无图 spec 的 status 都挂一条噪声，噪声多了 warning 就没人看了。
 *
 * @returns {{ waves: {id:number,tasks:string[]}[], warnings: string[] }}
 */
export function wavesFromMarkdown(markdown) {
  if (!scanLines(markdown).some(isGraphHeading)) return { waves: [], warnings: [] }

  const located = locateWavesJson(markdown)
  if (!located) {
    return { waves: [], warnings: [`${GRAPH_HEADING} is present but that section has no closed \`\`\`json block; execution falls back to sequential ordering`] }
  }
  let parsed
  try {
    parsed = parseWaves(located.json)
  } catch (caught) {
    return { waves: [], warnings: [`${GRAPH_HEADING} could not be parsed (${caught.message}); execution falls back to sequential ordering`] }
  }
  if (parsed.waves.length === 0) {
    return { waves: [], warnings: [`${GRAPH_HEADING} parsed to an empty wave list; execution falls back to sequential ordering`] }
  }
  return { waves: parsed.waves, warnings: [] }
}
