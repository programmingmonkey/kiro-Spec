// Task 0.1 —— 属性化「策略耦合」语料生成器（第 3.5 期）。
//
// 为什么要有这个:第 3 期的白名单封闭性判据只遍历 `difference-matrix.json` 的 7 行**定值**样本。
// 而 `lib/scan-lines.js` 的 `taskIndents` 由任务行累积,「哪些行是任务」依 `strictTaskState` 而
// 不同,于是**围栏判定本身**随策略而变 —— 这种形态按构造不在那 7 行里。实测已复现出两宿主
// 任务集合相差一个 id(见第 3.5 期 spec 的 Task 0.1)。
//
// 本生成器把语料从「7 行定值」换成**笛卡尔积**,让耦合被穷举而不是被举几个例子。
// 轴:
//   状态字符      ∈ { ' ', 'x', 'X', '-', '~', '/' }   —— `~` / `/` 正是两个策略判定不同的两态
//   主语任务缩进  ∈ { 0, 2, 4 }
//   围栏缩进      ∈ { 2, 4 }                          —— >3 时才需要「认闭合」,耦合只在这里出现
//   围栏开 run     ∈ { 3, 4 }
//   围栏闭 run     ∈ { 3, 4 }
//   防护行        ∈ { false, true }                    —— 开闭之间是否有缩进更小的任务行
//   → 6 × 3 × 2 × 2 × 2 × 2 = 288 份
//
// 产物只含**语料本身**(文档 + 轴取值 + id),不含任何测量结果。测量留给测试:
// 生成器与校验器同源会让它们「一起错、一起绿」(第 3 期独立审计的 F2 教训)。
//
// 无副作用:顶层不写任何文件,写入只在 isMain 守卫内(`corpus-golden.test.mjs` 曾被
// 「顶层就 writeFileSync 的生成器」咬过一次,同一个坑不踩第二次)。

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const OUTPUT = join(HERE, '..', 'fixtures', 'policy-coupling.json')

export const STATES = [' ', 'x', 'X', '-', '~', '/']
export const SUBJECT_INDENTS = [0, 2, 4]
export const FENCE_INDENTS = [2, 4]
export const RUNS = [3, 4]
export const GUARDS = [false, true]

export const AXES = [
  { name: 'state', values: STATES, note: '`~` / `/` 是两策略判定不同的两态，耦合的触发条件' },
  { name: 'subjectIndent', values: SUBJECT_INDENTS, note: '主语任务行的缩进' },
  { name: 'fenceIndent', values: FENCE_INDENTS, note: '围栏行的缩进；>3 时才需要「认闭合」' },
  { name: 'openRun', values: RUNS, note: '开围栏的反引号 run 长度' },
  { name: 'closeRun', values: RUNS, note: '闭围栏的反引号 run 长度；< 开 run 则不闭合' },
  { name: 'guard', values: GUARDS, note: '开闭之间是否插入缩进更小的任务行（影响 hasFenceClose）' },
]

/** 一份语料的文档。行序固定，便于 fixture 逐字节比对。 */
export function documentFor({ state, subjectIndent, fenceIndent, openRun, closeRun, guard }) {
  const s = ' '.repeat(subjectIndent)
  const f = ' '.repeat(fenceIndent)
  const lines = [`${s}- [${state}] 1.1 subject`, `${f}${'`'.repeat(openRun)}`, `${f}- [ ] 2.1 hidden`]
  if (guard) lines.push('- [ ] 1.3 shallower')
  lines.push(`${f}${'`'.repeat(closeRun)}`, '- [ ] 1.4 after')
  return lines.join('\n')
}

const specimenId = (axes) =>
  `s${STATES.indexOf(axes.state)}-${axes.subjectIndent}-${axes.fenceIndent}-${axes.openRun}${axes.closeRun}${axes.guard ? 'g' : 'n'}`

export function buildSpecimens() {
  const specimens = []
  for (const state of STATES)
    for (const subjectIndent of SUBJECT_INDENTS)
      for (const fenceIndent of FENCE_INDENTS)
        for (const openRun of RUNS)
          for (const closeRun of RUNS)
            for (const guard of GUARDS) {
              const axes = { state, subjectIndent, fenceIndent, openRun, closeRun, guard }
              specimens.push({ id: specimenId(axes), axes, text: documentFor(axes) })
            }
  return specimens
}

export function buildFixture() {
  const specimens = buildSpecimens()
  return {
    schemaVersion: 1,
    generatedBy: 'packages/spec-parser/test/tools/gen-policy-coupling.mjs',
    about: [
      '属性化「策略耦合」语料（第 3.5 期 Task 0.1）。用途：把白名单封闭性的语料从 7 行定值换成笛卡尔积。',
      '只含语料本身，不含测量结果——测量留给 declared-diffs.test.mjs，避免生成器与校验器同源。',
      '轴：state × subjectIndent × fenceIndent × openRun × closeRun × guard。',
      `规格数：${specimens.length}。重跑：node packages/spec-parser/test/tools/gen-policy-coupling.mjs`,
    ],
    axes: AXES,
    count: specimens.length,
    corpusSha256: createHash('sha256')
      .update(specimens.map((s) => `${s.id}\n${s.text}`).join('\n\u0000\n'))
      .digest('hex'),
    specimens,
  }
}

function main() {
  const fixture = buildFixture()
  if (process.argv.includes('--check')) {
    const current = JSON.parse(readFileSync(OUTPUT, 'utf8'))
    const same = JSON.stringify(current) === JSON.stringify(fixture)
    console.log(same ? `OK：${fixture.count} 份语料与入库 fixture 逐字节相同` : 'DRIFT：重跑生成器结果与入库 fixture 不同')
    process.exitCode = same ? 0 : 1
    return
  }
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`wrote ${OUTPUT}（${fixture.count} 份语料）`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
