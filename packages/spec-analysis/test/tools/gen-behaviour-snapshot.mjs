// Task 1.2 / 1.3 —— 五个模块的**行为快照**：抽取前的既定事实。
//
// 这不是 golden，是**证据**。抽取后必须逐字段相同；不同就是抽错了，唯一允许的例外是
// Task 0.3 判定为收敛的那三处，且必须逐条对着后果清单解释（spec Req 3.3）。
//
// 为什么用内存 port 而不是真实临时目录：五个模块的设计前提就是「I/O 由调用方注入」。
// 在内存 port 上跑，物理上不可能写盘，于是快照只含**模块的输出**，不含文件系统的噪声；
// `port.writes` 顺带给出只读性的直接证据（readText 调了几次、writeText 有没有被调）。
//
// 语料刻意写死并**包含即将发生变化的那些行**——`- [ ]* 1.1`、`- [ ] 1.foo`、
// `- [ ] * 1.2`、`- [ ] 1.2foo`、`- [x]* 2.1`，以及缩进 4 的围栏与 CRLF 署名。
// 语料里没有的形状，收敛后快照就不会动，那条「逐字段相同」也就证明不了什么。
//
// 用法：
//   node test/tools/gen-behaviour-snapshot.mjs --rev d1d7678          # ★ 重新生成入库那版快照
//   node test/tools/gen-behaviour-snapshot.mjs                       # 默认读 <pkg>/lib
//   node test/tools/gen-behaviour-snapshot.mjs --lib <dir>
//   node test/tools/gen-behaviour-snapshot.mjs --check [--rev d1d7678]
//
// ⚠️ 入库的那份快照记录的是**改造前**那一版实现，而那一版已经不在工作区里了（第 2 期把
// 五个模块搬走并收敛过）。所以重新生成它必须用 `--rev <git-rev>` —— 那会把 git 里那一版
// 的五个模块落到临时目录再跑。不带 `--rev` 只会拿**当前**实现去比，那当然不等（三处收敛
// 是有意的）。
//
// `--lib` 是**显式**的，不做「找不到就回落」——抽取前用插件目录，抽取后用本包目录，
// 哪一份被冻结由调用方点名。产物里**不记** libDir：否则前后两份快照会因为这个字段不等，
// 而为了让它们相等去「比较时忽略某字段」正是本仓要消灭的形态。
//
// 生成器无副作用：顶层零写入，写入只在 isMain 守卫内。

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { memoryPort, omitMove, snapshotTree } from './memory-port.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const OUT = join(PKG_ROOT, 'test', 'fixtures', 'behaviour-snapshot.json')
const DEFAULT_LIB = join(PKG_ROOT, 'lib')

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

const REQS = [
  '# Requirements Document',
  '',
  '## Introduction',
  '',
  '> 背景',
  '',
  '## Glossary',
  '',
  '> 术语',
  '',
  '## Requirements',
  '',
  '> 需求',
  '',
  '### Requirement 1: Alpha',
  '**User Story:** As a dev I want A.',
  '',
  '#### Acceptance Criteria',
  '1. WHEN x THE SYSTEM SHALL do A',
  '',
  '### Requirement 2: Beta',
  '**User Story:** As a dev I want B.',
  '',
  '#### Acceptance Criteria',
  '1. 系统应当合理地尽快完成适当的工作',
  '',
  '### Requirement 3: Gamma',
  '**User Story:** As a dev I want C.',
  '',
  '#### Acceptance Criteria',
  '1. WHEN y THE SYSTEM SHALL do C',
  '',
  '### Requirement 4: Delta',
  '**User Story:** As a dev I want D.',
  '',
  '没有判据小节，也没有被任何任务引用。',
  '',
  '### Requirement 5: Epsilon',
  '**User Story:** As a dev I want E.',
  '',
  '#### Acceptance Criteria',
  '1. WHEN z THE SYSTEM SHALL do E',
  '',
].join('\n')

const TASKS = [
  '# Implementation Plan',
  '',
  '## Overview',
  '',
  '> 概述',
  '',
  '## Task Dependency Graph',
  '',
  '```json',
  '{"waves":[{"id":0,"tasks":["1.1","1.2"]},{"id":1,"tasks":["2.2"]}]}',
  '```',
  '',
  '## Tasks',
  '',
  '> 任务清单',
  '',
  '- [ ] 1. 分组标签',
  '  - [ ]* 1.1 取子任务记法（星号紧贴 `]`，本仓自己的写法）',
  '    - _Requirements: 1_',
  '  - [ ] 2.foo 尾点后直接跟正文',
  '  - [ ] * 1.2 星号前有空格',
  '  - [ ] 1.2foo 粘连 id',
  '  - [x]* 2.1 已完成的取子任务',
  '    - _Requirements: 2_',
  '  - [ ] 2.2 普通任务',
  '    - _Requirements: 3_',
  '',
  '## Notes',
  '',
  '- 2026-09-12 · DSH · 冻结快照的语料',
  '',
].join('\n')

const DESIGN = [
  '# Design Document',
  '',
  '## Overview',
  '',
  '> 概述',
  '',
  '第一段。',
  '',
  '## Architecture',
  '',
  '> 架构',
  '',
  '第二段。',
  '',
].join('\n')

// 署名扫描的语料：三类围栏形态各一份。缩进 4 那一例是 Task 0.3 判定的第 2 处行为变更，
// CRLF 那一例是第 1 处（修在 parseSignatureLine 里，识别集合必须**不变**）。
const NOTES_EXTRA = [
  '# Extra notes',
  '',
  '```',
  '- 2026-09-12 · DSH · 平衡围栏内的署名（两侧都不该看见）',
  '```',
  '',
  '说明：',
  '',
  '    ```',
  '- 2026-09-12 · DSH · 缩进 4 的围栏内的署名',
  '    ```',
  '',
  '- 2026-09-12 · DSH · CRLF 结尾的署名\r',
  '',
].join('\n')

// 未被署名的目录：`checkAttribution` 的 UNSIGNED 分支要用它。
const UNSIGNED_TASKS = ['# Implementation Plan', '', '## Tasks', '', '- [ ] 1.1 x', '', '## Notes', ''].join('\n')

const SPEC_DIR = '/specs/demo'
const UNSIGNED_DIR = '/specs/unsigned'

// 快照里唯一一处依赖**时钟**的字段：`checkAttribution` 的未署名提示里带一句示例署名，
// 而那句示例由 `renderSignature` 用「今天」渲染（`todayDate()`）。快照是证据，不能每天
// 都不一样 —— 所以这里把那个日期换成**显式占位符**。
//
// ⚠️ 关键在「显式」：fixture 里能看见 `<today>` 这个占位符，而不是日期被悄悄抹平成空串。
// 它是哪一天由 `test/evidence.test.mjs` **单独断言**（重新算一遍今天，断言提示里确实是它）——
// 把时钟依赖藏起来才是危险的，断言它才是。
const CLOCK_PLACEHOLDER = '<today>'

function defuseClock(message) {
  return typeof message === 'string' ? message.replace(/\d{4}-\d{2}-\d{2}/g, CLOCK_PLACEHOLDER) : message
}

export function corpusTree() {
  return {
    [`${SPEC_DIR}/requirements.md`]: REQS,
    [`${SPEC_DIR}/tasks.md`]: TASKS,
    [`${SPEC_DIR}/design.md`]: DESIGN,
    [`${SPEC_DIR}/notes-extra.md`]: NOTES_EXTRA,
    [`${UNSIGNED_DIR}/requirements.md`]: REQS,
    [`${UNSIGNED_DIR}/tasks.md`]: UNSIGNED_TASKS,
    '/specs/legacy/tasks.md': UNSIGNED_TASKS,
  }
}

// ---------------------------------------------------------------------------
// 载入五个模块
// ---------------------------------------------------------------------------

async function loadModules(libDir) {
  const load = (name) => import(pathToFileURL(join(libDir, `${name}.js`)).href)
  const [checklist, drift, amendments, archive, signature] = await Promise.all([
    load('checklist'),
    load('drift'),
    load('amendments'),
    load('archive'),
    load('signature'),
  ])
  return { checklist, drift, amendments, archive, signature }
}

/**
 * 工具面（**活字段**，不是历史事实 —— 这一点在 2026-09-13 被实测戳破过）。
 *
 * 它从**当前工作区**的 `plugins/dsh-spec/test/harness.mjs` 挂载当前 `lib/index.js`，
 * 因此 `--rev <rev>` 复原的只是那五个分析模块，**不包括**工具面本身。
 * 原文写的是「改造前事实：8 个基线工具 + 1 个 command + 5 个 addedBy 工具」，
 * 那句话对**入库那一刻**成立，但把它当成不变量会误导下一个人。
 *
 * 实测（第 4 期 Task 7 给写侧五个工具加可选 `spec` 后）：`--check --rev d1d7678`
 * 变红，逐字段比对确认差异**只有**这一段、且正是那 5 个新增参数 ——
 * 其余（五个模块的行为、pure 段）逐字节一致。也就是说这条红是**工具面有意变更**
 * 的正常反应，不是快照坏了。刷新时要照这个范围核对：只该动 toolSurface。
 */
async function toolSurface() {
  const harness = await import(
    pathToFileURL(join(REPO_ROOT, 'plugins', 'dsh-spec', 'test', 'harness.mjs')).href
  )
  const { tools, commands } = harness.mount('/tmp')
  const out = { commands: [...commands.keys()].sort(), tools: {} }
  for (const [name, def] of [...tools.entries()].sort()) {
    out.tools[name] = {
      params: Object.keys(def.parameters?.properties ?? {}).sort(),
      required: [...(def.parameters?.required ?? [])].sort(),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

export async function buildSnapshot(libDir = DEFAULT_LIB) {
  const M = await loadModules(libDir)

  // ---- 纯函数：不需要 port，边界值逐个点名 ---------------------------------
  const pure = {
    checklist: {
      rules: M.checklist.checklistRules(),
      emptyDir: M.checklist.evaluateChecklist({}),
      noCriteria: M.checklist.evaluateChecklist({
        requirementsText: '## Requirements\n\n### Requirement 1: X\n**User Story:** As a.\n',
        tasksText: '## Tasks\n- [ ] 1.1 y\n  - _Requirements: 1_\n',
      }),
      emptyCriteriaSection: M.checklist.evaluateChecklist({
        requirementsText:
          '## Requirements\n\n### Requirement 1: X\n**User Story:** As a.\n\n#### Acceptance Criteria\n\n继续。\n',
        tasksText: '## Tasks\n- [ ] 1.1 y\n  - _Requirements: 1_\n',
      }),
      refsWildcard: M.checklist.parseRequirementRefs('- _Requirements: 全部_\n'),
      refsNumbers: M.checklist.parseRequirementRefs('- _Requirements: 1.1, 2, 3.4.5_\n'),
    },
    drift: {
      // 全阶梯：suppressSeverity 的每一档与越界档
      severityLadder: M.drift.SEVERITY_LADDER.map((s) => [
        s,
        M.drift.suppressSeverity(s, false),
        M.drift.suppressSeverity(s, true),
      ]),
      suppressUnknown: M.drift.suppressSeverity('nope', true),
      parseEntries: M.drift.parseTaskEntries(TASKS),
      parseEntriesEmpty: M.drift.parseTaskEntries(''),
      frozenAllDone: M.drift.isFrozen('## Tasks\n- [x] 1.1 a\n- [x] 2.1 b\n'),
      frozenNoTasks: M.drift.isFrozen('## Tasks\n\n没有任务。\n'),
      frozenUndefined: M.drift.isFrozen(undefined),
      frozenMixed: M.drift.isFrozen('## Tasks\n- [x] 1.1 a\n- [ ] 2.1 b\n'),
      recommendations: ['unreferenced', 'referenced-not-done', 'referenced-done', 'no-tasks'].map((status) =>
        M.drift.driftRecommendations({ requirement: '1', status, frozen: status === 'referenced-done', feature: 'demo', tasks: ['1.1'] }),
      ),
      buildReport: M.drift.buildDriftReport({ requirementsText: REQS, tasksText: TASKS, feature: 'demo' }),
      buildReportNoTasks: M.drift.buildDriftReport({ requirementsText: REQS, feature: 'demo' }),
      refs: M.drift.refsFromDetailLine('- _Requirements: 全部_'),
    },
    signature: {
      envs: M.signature.SIGNATURE_ENVS,
      todayDate: M.signature.todayDate(new Date('2026-09-12T23:30:00')),
      joinPath: [
        M.signature.joinPath('/a/', 'b', 'c'),
        M.signature.joinPath('/a', '/b/'),
        M.signature.joinPath(''),
        M.signature.joinPath('/a'),
      ],
      isSignatureEnv: ['DSH', 'Kiro', '', 'dsh'].map((e) => [e, M.signature.isSignatureEnv(e)]),
      parseLine: [
        '- 2026-09-12 · DSH · x',
        '- 2026-09-12 · DSH · x\r',
        '  - 2026-09-12 · DSH · x',
        '### 2026-09-12 · DSH · x',
        '## 2026-09-12 · DSH · x',
        '- 2026-09-12 · DSH ·',
        '- 2026-09-12 ·DSH· x',
        '- 2026-09-12 · Nobody · x',
      ].map((line) => [JSON.stringify(line), M.signature.parseSignatureLine(line)]),
      renderOk: M.signature.renderSignature({ date: '2026-09-12', env: 'DSH', summary: '改了什么' }),
      renderRejects: [
        ['unknown env', () => M.signature.renderSignature({ env: 'Nobody' })],
        ['bad date', () => M.signature.renderSignature({ date: '2026/09/12', summary: 'x' })],
        ['empty summary', () => M.signature.renderSignature({ date: '2026-09-12', summary: '   ' })],
      ].map(([label, fn]) => {
        try {
          return [label, null, fn()]
        } catch (e) {
          return [label, e.message, null]
        }
      }),
    },
    amendments: {
      assertNotTaskBody: [
        'tasks',
        'tasks.md',
        'dir/tasks.md',
        'requirements',
        'design.md',
        'TASKS.MD',
        undefined,
      ].map((file) => {
        try {
          M.amendments.assertNotTaskBody(file)
          return [JSON.stringify(file), null]
        } catch (e) {
          return [JSON.stringify(file), e.message.includes('Refusing to write a task body')]
        }
      }),
    },
  }

  // ---- 内存 port 上的模块行为 ----------------------------------------------
  const checklistPort = memoryPort(corpusTree())
  const runChecklistOut = await M.checklist.runChecklist({ port: checklistPort, specDir: SPEC_DIR })

  const driftPort = memoryPort(corpusTree())
  const runDriftOut = await M.drift.runDrift({ port: driftPort, specDir: SPEC_DIR })

  const sigSignedPort = memoryPort(corpusTree())
  const checkSigned = await M.signature.checkAttribution({
    port: sigSignedPort,
    dir: SPEC_DIR,
    changedFiles: ['requirements.md'],
  })
  const sigUnsignedPort = memoryPort(corpusTree())
  const checkUnsigned = await M.signature.checkAttribution({
    port: sigUnsignedPort,
    dir: UNSIGNED_DIR,
    changedFiles: ['requirements.md'],
  })

  const amendPort = memoryPort(corpusTree())
  const paramEdit = await M.amendments.applyParamEdit({
    port: amendPort,
    dir: SPEC_DIR,
    file: 'requirements',
    from: 'As a dev I want A.',
    to: 'As a dev I want A, changed.',
  })
  const appendReq = await M.amendments.appendRequirement({
    port: amendPort,
    dir: SPEC_DIR,
    title: 'Zeta',
    body: 'WHEN q THE SYSTEM SHALL do Z.',
  })
  const appendDesign = await M.amendments.appendDesignAmendment({
    port: amendPort,
    dir: SPEC_DIR,
    heading: '2026-09-12 · DSH · 补设计点',
    body: '补一个设计点。',
    pointer: { anchor: '第二段。', text: '> 见 `## Amendments`。' },
  })

  // 守卫的两个方向都要留证：旧谓词命中的要被拒，共享层认定的也要被拒。
  const guardProbes = [
    ['- [ ] 1.1foo 粘连 id（旧谓词命中）', () => M.amendments.assertNotTaskBody('requirements')],
    ['- [ ]* 1.2 x（共享层认定的任务）', () => M.amendments.assertNotTaskBody('design')],
  ].map(([label]) => [label, 'file-name gate only (text gate 见 guardText)'])

  const guardText = []
  for (const [label, text] of [
    ['glued-id', '- [ ] 1.1foo x'],
    ['star-subtask', '- [ ]* 1.2 x'],
    ['space-star', '- [ ] * 1.3 x'],
    ['plain', '- [ ] 1.4 x'],
    ['no-checkbox', '普通一句正文'],
  ]) {
    const p = memoryPort(corpusTree())
    try {
      await M.amendments.applyParamEdit({ port: p, dir: SPEC_DIR, file: 'requirements', from: '背景', to: text })
      guardText.push([label, 'ACCEPTED', null])
    } catch (e) {
      guardText.push([label, 'REFUSED', e.message.includes('Refusing to write a task body')])
    }
  }

  const archiveWithMovePort = memoryPort(corpusTree())
  const archiveWithMove = await M.archive.archiveSpec({
    port: archiveWithMovePort,
    specDir: '/specs/legacy',
    archiveRoot: '/specs/_archive',
  })
  const archiveNoMovePort = omitMove(memoryPort(corpusTree()))
  const archiveNoMove = await M.archive.archiveSpec({
    port: archiveNoMovePort,
    specDir: '/specs/legacy',
    archiveRoot: '/specs/_archive',
  })
  const conflictPort = memoryPort(corpusTree(), { dirs: ['/specs/_archive/legacy'] })
  const conflict = await M.archive.archiveConflict({
    port: conflictPort,
    specDir: '/specs/legacy',
    archiveRoot: '/specs/_archive',
  })
  const conflictNone = await M.archive.archiveConflict({
    port: memoryPort(corpusTree()),
    specDir: '/specs/legacy',
    archiveRoot: '/specs/_archive',
  })

  const appendSigPort = memoryPort(corpusTree())
  const appendSignatureLine = await M.signature.appendSignature({
    port: appendSigPort,
    dir: SPEC_DIR,
    summary: '冻结快照',
    env: 'DSH',
    date: '2026-09-12',
  })
  const appendSignatureAgain = await M.signature.appendSignature({
    port: appendSigPort,
    dir: SPEC_DIR,
    summary: '冻结快照',
    env: 'DSH',
    date: '2026-09-12',
  })

  return {
    schemaVersion: 1,
    about: [
      'Task 1 的五个模块行为快照。这是**证据不是 golden**：抽取后必须逐字段相同，',
      '唯一允许的例外是 Task 0.3 判定为收敛的那三处，且必须逐条对着后果清单解释。',
      '由 test/tools/gen-behaviour-snapshot.mjs 生成，勿手改。',
      '不记来源目录、也不记时间戳：否则前后两份会因为与行为无关的字段不等，而「比较时忽略某字段」正是本仓要消灭的形态。',
      `唯一的时钟依赖（未署名提示里那句示例署名的日期）被换成显式占位符 ${CLOCK_PLACEHOLDER} —— 它是今天由 test/evidence.test.mjs 单独断言，不是被抹平。`,
    ],
    toolSurface: await toolSurface(),
    modules: {
      checklist: {
        run: runChecklistOut,
        port: { reads: checklistPort.log.filter(([op]) => op === 'readText').length, writes: checklistPort.writes, treeUnchanged: snapshotTree(checklistPort) },
      },
      drift: {
        run: runDriftOut,
        port: { reads: driftPort.log.filter(([op]) => op === 'readText').length, writes: driftPort.writes, treeUnchanged: snapshotTree(driftPort) },
      },
      signature: {
        checkSigned,
        // 只对**未署名提示**做时钟去敏（它内嵌一句用今天渲染的示例署名）；
        // 语料里那些真实署名行的日期（2026-09-12）不动，它们是内容不是时钟。
        checkUnsigned: {
          ...checkUnsigned,
          finding: checkUnsigned.finding ? { ...checkUnsigned.finding, message: defuseClock(checkUnsigned.finding.message) } : null,
        },
        appendSignatureLine,
        appendSignatureAgain,
        port: {
          signedWrites: sigSignedPort.writes,
          unsignedWrites: sigUnsignedPort.writes,
          appendWrites: appendSigPort.writes,
          tasksAfterAppend: appendSigPort.files.get(`${SPEC_DIR}/tasks.md`),
        },
      },
      amendments: {
        paramEdit,
        appendReq,
        appendDesign,
        guardProbes,
        guardText,
        requirementsAfter: amendPort.files.get(`${SPEC_DIR}/requirements.md`),
        designAfter: amendPort.files.get(`${SPEC_DIR}/design.md`),
        writes: amendPort.writes,
      },
      archive: {
        withMove: archiveWithMove,
        withoutMove: archiveNoMove,
        withMoveTree: snapshotTree(archiveWithMovePort),
        withoutMoveTree: snapshotTree(archiveNoMovePort),
        conflict,
        conflictNone,
      },
    },
    pure,
  }
}

/** 读产物并 parse，供测试断言用。 */
export function readSnapshot() {
  return JSON.parse(readFileSync(OUT, 'utf8'))
}

function libDirArg(argv) {
  const i = argv.indexOf('--lib')
  if (i === -1) return DEFAULT_LIB
  const value = argv[i + 1]
  if (!value) throw new Error('--lib 后面要跟一个目录')
  return resolve(REPO_ROOT, value)
}

// 把某个 git rev 里的五个模块落到临时目录，返回该目录。
//
// 为什么需要它：入库的快照记的是改造前那一版，而那一版已不在工作区里。若要人工记得
// 「先 git show 五次再指 --lib」，这条路径迟早会被走错（而走错的表现是「快照不等」，
// 会被误读成实现坏了）。让**工具**去做这件事，命令就只有一个。
const MATERIALISED = []

function materialiseRev(rev) {
  const dir = mkdtempSync(join(tmpdir(), `spec-analysis-rev-${rev.replace(/[^\w.-]/g, '_')}-`))
  for (const mod of ['checklist', 'drift', 'amendments', 'archive', 'signature']) {
    let src
    try {
      src = execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:plugins/dsh-spec/lib/${mod}.js`], {
        encoding: 'utf8',
      })
    } catch (e) {
      throw new Error(`从 git 取 ${rev}:plugins/dsh-spec/lib/${mod}.js 失败：${e.message}`)
    }
    writeFileSync(join(dir, `${mod}.js`), src)
  }
  MATERIALISED.push(dir)
  return dir
}

function revArg(argv) {
  const i = argv.indexOf('--rev')
  if (i === -1) return undefined
  const value = argv[i + 1]
  if (!value) throw new Error('--rev 后面要跟一个 git rev')
  return value
}

async function main() {
  const mode = process.argv.includes('--check') ? '--check' : '--write'
  const rev = revArg(process.argv)
  if (rev !== undefined && process.argv.includes('--lib')) throw new Error('--rev 与 --lib 只能给一个')
  const libDir = rev === undefined ? libDirArg(process.argv) : materialiseRev(rev)
  const snapshot = await buildSnapshot(libDir)
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  if (mode === '--check') {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error(`behaviour-snapshot.json 与当前实现不一致（libDir=${libDir}）`)
      process.exit(1)
    }
    console.log('behaviour-snapshot.json 与当前实现一致')
    return
  }
  writeFileSync(OUT, text)
  const size = statSync(OUT).size
  console.log(`wrote ${OUT} (${size} bytes) from ${libDir}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } finally {
    // 临时目录只由 `--rev` 创建；清了它，`--file` 与 `--check` 的行为都不受影响。
    for (const dir of MATERIALISED) rmSync(dir, { recursive: true, force: true })
  }
}
