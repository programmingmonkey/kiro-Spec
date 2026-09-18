#!/usr/bin/env node
// claude-spec — 语法与 JSON 形状自检（`npm run check`）。
//
// 为什么不是 codex-spec 那种手写文件清单：
// codex-spec 的 `check` 把 33 个文件名逐个抄进 package.json。那份清单**只会漏，不会报**——
// 新增一个文件而忘了加进去，检查照样全绿，而这正是本仓库反复要消灭的「静默缺口」形态。
// fork 出来的这一份改成**遍历**：插件里每个 `.mjs` 都过一遍 `node --check`，
// 每个受约束的 JSON 都过一遍 `JSON.parse`。新增文件自动进入覆盖面，不需要谁记得改清单。
//
// 刻意排除：`node_modules/`（依赖的语法不是本包的交付物）。
// 不排除测试与 fixtures：它们也是交付物的一部分，语法必须成立。

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** 受约束的 JSON：写错一个字符就该在这里红，而不是等到装进宿主才发现。 */
const JSON_FILES = ['package.json', '.mcp.json', 'hooks/hooks.json', 'adapter.example.json']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (entry.isFile() && /\.(mjs|sh)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

const failures = []

const scripts = walk(PLUGIN_ROOT).sort()
for (const file of scripts) {
  // `.sh` 也要过一遍：`scripts/spec-stage-gate.sh` 是门控的入口，
  // 它语法坏了等于门控静默失效 —— 而那是最难发现的一种坏法。
  const isShell = file.endsWith('.sh')
  const runtime = isShell ? 'sh' : process.execPath
  const args = isShell ? ['-n', file] : ['--check', file]
  try {
    // stdio 全部吞掉：失败原因由我们自己的消息给出，不把 node 的原始堆栈混进来。
    execFileSync(runtime, args, { stdio: 'pipe' })
  } catch (caught) {
    const detail = `${caught.stdout ?? ''}${caught.stderr ?? ''}`.trim()
    failures.push(`语法错误 ${path.relative(PLUGIN_ROOT, file)}\n${detail}`)
  }
}

for (const rel of JSON_FILES) {
  const file = path.join(PLUGIN_ROOT, rel)
  try {
    JSON.parse(readFileSync(file, 'utf8'))
  } catch (caught) {
    failures.push(`JSON 不可解析 ${rel}: ${caught.message}`)
  }
}

if (failures.length > 0) {
  console.error(`claude-spec check 失败（${failures.length} 项）：`)
  for (const failure of failures) console.error(`\n${failure}`)
  process.exit(1)
}

console.log(`claude-spec check 通过：${scripts.length} 个脚本语法成立，${JSON_FILES.length} 份 JSON 可解析`)
