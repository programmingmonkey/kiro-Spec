// Task 3 —— 红测：**自造码即失败**。
//
// 判据：四个 area 上 `diagnose()` 产出的每一个 code 都必须落在**三个来源**的并集里：
//   `KIRO_RULE_CODES`（41 条，来自 kiro-rules） ∪ `REPO_CODES`（本仓内置的 12 条约定）
//   ∪ `profile.conventions`（项目自带）。
//
// ⚠️ **对计划措辞的订正（实测）**：计划 Task 3 Step 1 写的是
// 「code ∈ `KIRO_RULE_CODES ∪ profile.conventions`」——**这个并集不够**。本仓内置的 12 条约定
// （`tasks/invalid-task-state` / `tasks/too-many-units` / `tasks/undeclared-task` /
// `${kind}/unterminated-fence` / `design/missing-title`）既不在 41 条里，也不由 profile 声明，
// 而是无条件产出的。照计划原文写，正向断言在本仓的第一份 `[~]` 语料上就会红——红得**对**，
// 是措辞漏了一个来源。故按三源并集断言；「零自造码」的实质（码必须来自封闭表，不得凭空造）
// 不受影响。
//
// 为什么需要**反向**那一条（计划 Task 3 Step 2）：只说「code ⊆ 三个来源」时，如果语料是空的，
// 断言恒真。第 3 期的独立审计抓到过一条恒真断言，不复制它。故这里：
//   · 正向：先断言四个 area 真的产出了 finding（非空），再断言包含关系；
//   · 反向：把包复制到临时目录、在副本里让 `diagnose` 多吐一个自造码，跑同一条断言并断言它**失败**。
//     副本里跑，**不改动工作树**。

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { KIRO_RULE_CODES } from '@my-harness/kiro-rules'

import { REPO_CODES, diagnose } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const PACKAGES_ROOT = join(PACKAGE_ROOT, '..')

// 四个 area 各至少一份能产出 finding 的语料 —— 空语料会让这条断言恒真。
const CORPUS = [
  ['requirements', '# Requirements Document\n\n## Introduction\n'],
  ['design', '# Design Document\n\n## Overview\n'],
  ['tasks', '# Implementation Plan\n\n## Tasks\n\n- [~] 1.1 a\n\n## Notes\n'],
  ['bugfix', '# Bugfix Requirements Document\n\n## Introduction\n'],
]

const PROFILE = { name: 'test', conventions: ['design/missing-title'] }
const ALLOWED = new Set([...KIRO_RULE_CODES, ...Object.keys(REPO_CODES), ...PROFILE.conventions])

describe('Task 3 — 四个 area 的判定都来自 kiro-rules ∪ repo 内置约定 ∪ profile.conventions', () => {
  it('正向：四个 area 都真的产出了 finding（非空，否则断言恒真）', () => {
    for (const [artifact, markdown] of CORPUS) {
      const findings = diagnose({ artifact, markdown, profile: PROFILE })
      assert.ok(findings.length > 0, `${artifact} 的语料没产出任何 finding —— 包含关系会恒真`)
    }
  })

  it('正向：没有任何自造码', () => {
    for (const [artifact, markdown] of CORPUS) {
      for (const f of diagnose({ artifact, markdown, profile: PROFILE })) {
        assert.ok(ALLOWED.has(f.code), `${artifact} 产出自造码 ${f.code} —— 三个来源里都没有它`)
      }
    }
  })

  it('反向：副本里注入一个自造码后，同一条判据必须失败', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-diagnose-inject-'))
    try {
      cpSync(PACKAGE_ROOT, dir, { recursive: true, filter: (src) => !src.includes('node_modules') })
      // 把两个 workspace 依赖以**绝对**符号链接接回工作区，否则副本里的 `@my-harness/*` 解析不到。
      mkdirSync(join(dir, 'node_modules', '@my-harness'), { recursive: true })
      for (const dep of ['kiro-rules', 'spec-parser']) {
        symlinkSync(join(PACKAGES_ROOT, dep), join(dir, 'node_modules', '@my-harness', dep), 'dir')
      }
      const lib = join(dir, 'lib', 'diagnose.js')
      const original = readFileSync(lib, 'utf8')
      const patched = original.replace(
        '  return applyProfile(withContract, profile)',
        "  withContract.push(makeFinding({ code: 'tasks/invented-by-the-injection', severity: 'warning', message: 'x', area }))\n  return applyProfile(withContract, profile)",
      )
      assert.notEqual(patched, original, '注入点没匹配上 —— 反向这条会变成恒真')
      writeFileSync(lib, patched)

      const script = join(dir, 'inject-check.mjs')
      writeFileSync(
        script,
        [
          `import { diagnose } from ${JSON.stringify(join(dir, 'lib', 'index.js'))}`,
          `import { KIRO_RULE_CODES } from '@my-harness/kiro-rules'`,
          `import { REPO_CODES } from ${JSON.stringify(join(dir, 'lib', 'finding.js'))}`,
          `const allowed = new Set([...KIRO_RULE_CODES, ...Object.keys(REPO_CODES), 'design/missing-title'])`,
          `const findings = diagnose({ artifact: 'tasks', markdown: '# Implementation Plan\\n\\n## Tasks\\n\\n- [~] 1.1 a\\n\\n## Notes\\n', profile: { conventions: ['design/missing-title'] } })`,
          `const bad = findings.filter((f) => !allowed.has(f.code))`,
          `if (bad.length === 0) { console.log('VACUOUS'); process.exit(0) }`,
          `console.log('CAUGHT ' + bad.map((f) => f.code).join(',')); process.exit(3)`,
        ].join('\n'),
      )

      let status = 0
      let stdout = ''
      try {
        stdout = execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: dir })
      } catch (error) {
        status = error.status
        stdout = String(error.stdout ?? '')
      }
      assert.equal(status, 3, `反向注入没有被抓住（退出码 ${status}，输出 ${stdout.trim()}）—— 说明正向断言是恒真的`)
      assert.match(stdout, /CAUGHT tasks\/invented-by-the-injection/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
