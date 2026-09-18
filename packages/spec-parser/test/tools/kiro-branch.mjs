// 真机 Kiro 的 tasks 校验分支：从 bundle 运行时读出四条 prefix 正则，并复现其判定语义。
//
// 本模块是**测试工具**，不进 `lib/`，也不属于发布面。
//
// 为什么不把结论写成布尔常量：本期设计的全部依据是「真机怎么判」。把四条正则或判定结论
// 硬编码进本文件，就等于把「真机依据」换成「我抄的字符串」——一旦 Kiro 升版，测试照样全绿。
// 故：正则必须从 bundle 现读，读不到就抛（不用硬编码顶替）。这一条沿用第 1 期
// `packages/kiro-rules/scripts/extract-kiro-rules.py` 的处置：bundle 缺席时 caller 抛，
// 不猜。
//
// 复现的是 bundle 里这段循环的语义（原文为 if/else，不是三元式）：
//
//   if (h.test(g) && !f.test(g)) { push('tasks/malformed-checkbox'); continue }
//   if (!f.test(g)) continue
//   indent === 0 ? (p 命中则跳过；否则 d 不命中则 push('tasks/invalid-task-line'))
//                : (p 不命中则 push('tasks/invalid-subtask-line'))
//
// 该循环**没有**任何围栏状态——这是差异表 E / F 判为 repo-convention 的原始依据。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { kiroBundleAbsenceMessage, resolveKiroBundle } from '../../../../scripts/kiro-bundle-root.mjs'


// 定位用锚点：四条正则里第一条的字面前缀。它只是**定位器**，不承担任何判定结论。
const ANCHOR = '/^- \\[([ x~-])\\]'

// 不导出常量路径：调用方要知道「实际读了哪个文件」，用返回值。理由见
// `scripts/kiro-bundle-root.mjs` 的头部（spec-diagnose 那边真的被这个常量坑过）。
export function loadKiroBranch(bundlePath = resolveKiroBundle().path) {
  let text
  try {
    text = readFileSync(bundlePath, 'utf8')
  } catch (error) {
    throw new Error(
      `读不到 Kiro bundle：${bundlePath}（${error.code ?? error.message}）。` +
        '本工具不用硬编码顶替缺失的真机证据——请在装有 Kiro 的机器上重跑。',
    )
  }

  const at = text.indexOf(ANCHOR)
  if (at === -1) {
    throw new Error(
      `bundle 中找不到四条 prefix 正则的锚点 ${ANCHOR}。Kiro 可能已升版；` +
        '人工复核新 bundle 的判定分支后再更新锚点，不要改用硬编码。',
    )
  }

  // 锚点起 400 字符内即四条正则字面量。转义感知：`\\.` 吃「反斜杠 + 任意字符」，
  // 故 `\\?\*?` 里的 `\\` 与 `\*` 都能被正确跨过。
  const window = text.slice(at, at + 400)
  const found = [...window.matchAll(/\/((?:\\.|[^/\\])+)\//g)].map((match) => match[1])
  const [d, p, f, h] = found
  if (!d || !p || !f || !h) {
    throw new Error(`从 bundle 里只取到 ${found.length} 条正则，期望 4 条（d / p / f / h）`)
  }

  return {
    d: new RegExp(d),
    p: new RegExp(p),
    f: new RegExp(f),
    h: new RegExp(h),
    sources: { d, p, f, h },
    bundle: {
      path: bundlePath,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  }
}

/**
 * 复现 `## Tasks` 段内的逐行判定。返回 `{ line, verdict }[]`（行号为 1 基）。
 * 只列出「命中判决」的行：`ok` 表示该行被真机判为合规复选框行，其余三种是它报出的 rule。
 */
export function judgeTasksSection(lines, branch) {
  const { d, p, f, h } = branch
  const start = lines.findIndex((line) => /^## Tasks$/.test(line))
  if (start === -1) return []

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }

  const verdicts = []
  for (let i = start + 1; i < end; i += 1) {
    const g = lines[i]
    if (h.test(g) && !f.test(g)) {
      verdicts.push({ line: i + 1, verdict: 'malformed-checkbox' })
      continue
    }
    if (!f.test(g)) continue

    const indent = /^(\s*)/.exec(g)?.[1].length ?? 0
    if (indent === 0) {
      if (p.test(g)) {
        verdicts.push({ line: i + 1, verdict: 'ok' })
        continue
      }
      verdicts.push({ line: i + 1, verdict: d.test(g) ? 'ok' : 'invalid-task-line' })
      continue
    }
    verdicts.push({ line: i + 1, verdict: p.test(g) ? 'ok' : 'invalid-subtask-line' })
  }
  return verdicts
}

export function judgeDocument(markdown, branch) {
  return judgeTasksSection(markdown.split('\n'), branch)
}
