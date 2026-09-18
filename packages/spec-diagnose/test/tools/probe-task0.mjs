// Task 0 探针 —— 第 3.5 期计划的三条阻塞项 (0.1 / 0.2 / 0.3) 的取数脚本。
//
// 「凡『现状』列都不得由人写」(第 3 期教训)。本文件只取数、只打印,不做判定;
// 判定口径先写死在计划 Task 0 的表里,再据此填 spec 的 `Task 0 判定结果`。
//
// 三条证据路径互相独立:
//   ① 两宿主**当前的纯函数实现**(dsh-spec 的 diagnoseArtifact / codex-spec 的
//      validateArtifactSchemas / 共享 scan-lines 的两个策略);
//   ② 真机 Kiro 出厂 bundle 里**现读并执行**的四个校验器(见 kiro-validators.mjs);
//   ③ 共享包两个策略的**属性化笛卡尔积**语料(见 gen-policy-coupling.mjs)。
//
// 无副作用:顶层不写任何文件,只在 isMain 守卫内打印。

import { __test as dsh } from '../../../../plugins/dsh-spec/lib/index.js'
// 相对路径而非 `@my-harness/spec-parser`:本探针是 Task 0 的取数工具,先于 Task 4 的建包。
// Task 4 建包并 `pnpm install` 之后可以切回包名,但那不是本步的判据。
import { computeFenceState, hasUnterminatedFence, scanTaskLines } from '../../../spec-parser/lib/scan-lines.js'
import { validateArtifactSchemas } from '../../../../plugins/codex-spec/lib/core/artifact-schema.mjs'
import { kiroDiagnose, loadKiroValidators } from './kiro-validators.mjs'

const STRICT = { strictTaskState: true }
const LOOSE = { strictTaskState: false }

/** 把一个策略对一份文档的「任务判定」投影成 `行号:id|kind` 列表(计划里那种形状)。 */
function taskLines(markdown, options) {
  const lines = String(markdown).split('\n')
  const { syntaxes } = scanTaskLines(markdown, options)
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const syntax = syntaxes[index]
    if (!syntax) continue
    out.push(`${index + 1}:${syntax.kind === 'task' ? syntax.id : syntax.kind}`)
  }
  return out
}

// ── 0.1 白名单封闭性:策略耦合导致的围栏判定差异 ───────────────────────────────
// 计划原文的 5 行文档(不含作为小节标题的 `## Tasks`):
//   1: `  - [~] 1.1 tilde-task`
//   2: `    \`\`\``
//   3: `    - [ ] 2.1 hidden-or-not`
//   4: `    \`\`\``
//   5: `  - [ ] 1.2 after`
const A1_DOC = [
  '  - [~] 1.1 tilde-task',
  '    ```',
  '    - [ ] 2.1 hidden-or-not',
  '    ```',
  '  - [ ] 1.2 after',
].join('\n')

export function probe01() {
  const dshTasks = taskLines(A1_DOC, LOOSE)
  const kiroTasks = taskLines(A1_DOC, STRICT)
  return {
    doc: A1_DOC,
    dshTasks,
    kiroTasks,
    // 计划说「分歧是多出一个 id 2.1」——把声明外的残留单独列出来。
    residualBeyondDeclaredState:
      [...new Set([...dshTasks, ...kiroTasks])].filter(
        (entry) => dshTasks.includes(entry) !== kiroTasks.includes(entry) && !entry.endsWith(':1.1'),
      ),
    dshInFenceLoose: computeFenceState(A1_DOC.split('\n'), LOOSE).map((x) => (x ? 1 : 0)).join(''),
    kiroInFenceStrict: computeFenceState(A1_DOC.split('\n'), STRICT).map((x) => (x ? 1 : 0)).join(''),
    dshUnterminatedFence: hasUnterminatedFence(A1_DOC),
  }
}

// ── 0.2 「不得比 Kiro 更严」:字面门槛抓不住的反例 ────────────────────────────
// 一份 Overview / Tasks / Task Dependency Graph / Notes 齐全的 tasks.md。
// 唯一区别:中间的示例围栏写成「开 N 个反引号 / 闭 M 个反引号」。
// 关键:围栏**位于 `## Task Dependency Graph` 与 `## Notes` 之前**,于是 F 形态下
// dsh 把这两节连同它们的 heading 一起吞进围栏。
const TASKS_DOC = (openRun, closeRun) =>
  [
    '# Implementation Plan',
    '',
    '## Overview',
    '',
    '> 概述',
    '',
    '## Tasks',
    '',
    '- [ ] 1. 分组',
    '  - [ ] 1.1 叶子',
    '    - _Requirements: 1.1_',
    '',
    '示例:',
    '',
    `${'`'.repeat(openRun)}md`,
    '任意内容',
    `${'`'.repeat(closeRun)}`,
    '',
    '## Task Dependency Graph',
    '',
    '```json',
    '{ "waves": [{ "id": 0, "tasks": ["1.1"] }] }',
    '```',
    '',
    '## Notes',
    '',
    '> 备注',
    '',
    '- 无',
    '',
  ].join('\n')

const findingsOf = (text) =>
  dsh.diagnoseArtifact('tasks', text).map((d) => ({ code: d.code, severity: d.severity, source: d.source }))

export function probe02() {
  const loaded = loadKiroValidators()
  const control = TASKS_DOC(3, 3)
  const fForm = TASKS_DOC(4, 3)
  const controlFindings = findingsOf(control)
  const fFindings = findingsOf(fForm)
  return {
    controlFindings,
    fFormFindings: fFindings,
    // 逐条:该码是否在 41 条内、source 是不是 kiro-binary(字面门槛只看这一侧)。
    fFormCodeProvenance: fFindings.map((d) => ({
      code: d.code,
      source: d.source,
      inKiro41: dsh.KIRO_RULE_CODES.includes(d.code),
    })),
    // 真机对这同一份 F 形态文档的实际输出(执行 bundle 里的 validateTasksFormat)。
    realKiroOnFForm: kiroDiagnose('tasks', fForm, loaded).map((d) => d.rule),
    realKiroOnControl: kiroDiagnose('tasks', control, loaded).map((d) => d.rule),
    kiroBundleSha256: loaded.bundle.sha256,
  }
}

// ── 0.3 codex-spec 侧 unterminated-fence 消费者 ──────────────────────────────
export function probe03() {
  const fForm = TASKS_DOC(4, 3)
  const kiro = validateArtifactSchemas({ workflow: 'quick', artifacts: { tasks: fForm } }).map((x) => x.ruleId)
  const dsh = findingsOf(fForm).map((x) => x.code)
  return {
    kiroFindingsOnFForm: kiro,
    dshFindingsOnFForm: dsh,
    // 两侧集合是否相同。**必须算出来**：这里原先写的是字面量 `false`（计划 0.3 的说法是
    // 「必然不同」），而接线之后两个宿主产出的是同一组码 —— 于是这个探针会一边打印两份
    // **相同**的清单、一边声称它们不同。证据工具里最不能出现的就是人写的结论。
    identicalSets: [...kiro].sort().join('\u0000') === [...dsh].sort().join('\u0000'),
  }
}

function main() {
  const which = process.argv[2]
  const all = { '0.1': probe01, '0.2': probe02, '0.3': probe03 }
  const entries = which ? [[which, all[which]]] : Object.entries(all)
  for (const [name, fn] of entries) {
    if (!fn) throw new Error(`unknown probe: ${name}`)
    console.log(`\n=== Task ${name} ===`)
    console.log(JSON.stringify(fn(), null, 2))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
