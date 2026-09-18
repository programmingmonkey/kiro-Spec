// Test harness: mounts the real plugin against a fake cordis ctx backed by a
// real temporary directory. Nothing about the plugin is stubbed — the tools it
// registers are the tools these tests call — so what is exercised is the same
// code path the harness runs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { apply } from '../lib/index.js'

// A temporary project root. `.git` is what the plugin's default project-root
// markers look for, so its presence makes the temp dir the resolved root.
export function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-spec-test-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

export function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * `FsVersion` 的假实现：**由内容派生**（真实后端是不透明的 token，但只要它随内容变，
 * `replaceIfVersion` 的判别力就是真的）。目录用固定串，因为目录没有内容可比。
 */
function versionOf(abs, st) {
  if (st.isDirectory()) return 'dir'
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

// Minimal FileSystemService surface: resolve/stat/readText/writeText/listDir.
// Deliberately omits `sandboxMode` so the plugin's sandbox-policy lookup no-ops,
// exactly as it does for an unsandboxed ctx.fs.
function makeFs() {
  const target = (p) => ({ targetKey: p, displayPath: p })
  return {
    async resolve(p) {
      return target(p)
    },
    async stat(t) {
      try {
        const st = statSync(t.targetKey)
        return { version: versionOf(t.targetKey, st), type: st.isDirectory() ? 'directory' : 'file', size: st.size }
      } catch {
        return undefined
      }
    },
    async readText(t) {
      return readFileSync(t.targetKey, 'utf8')
    },
    // 🔴 第 7 期 Task 5：`expected` 是 DSH 原生的 `FsWriteIntent`，**必须**在这里照契约实现。
    // 假 fs 直接忽略它，会让「CAS 有没有真的接上」这件事在测试里恒真 —— 而那个假绿灯
    // 正是第 4 期「验的是旧 build」的同一族错误（被测面被 stub 掉了）。
    //   { kind: 'createIfAbsent' }              → 目标已存在即 FS_NOT_OBSERVED
    //   { kind: 'replaceIfVersion', version }   → 目标不存在或版本不符即 FS_STALE_VERSION
    //   undefined                                → 无条件（DSH 契约：省略 = 不校验）
    async writeText(t, content, expected) {
      const exists = existsSync(t.targetKey)
      if (expected?.kind === 'createIfAbsent' && exists) {
        throw Object.assign(new Error(`FS_NOT_OBSERVED: ${t.displayPath} already exists`), { code: 'FS_NOT_OBSERVED' })
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!exists) {
          throw Object.assign(new Error(`FS_STALE_VERSION: ${t.displayPath} is absent`), { code: 'FS_STALE_VERSION' })
        }
        const version = versionOf(t.targetKey, statSync(t.targetKey))
        if (version !== expected.version) {
          throw Object.assign(new Error(`FS_STALE_VERSION: ${t.displayPath} changed since it was observed`), { code: 'FS_STALE_VERSION' })
        }
      }
      mkdirSync(dirname(t.targetKey), { recursive: true })
      writeFileSync(t.targetKey, content)
      return { version: versionOf(t.targetKey, statSync(t.targetKey)) }
    },
    async listDir(t) {
      let entries
      try {
        entries = readdirSync(t.targetKey, { withFileTypes: true })
      } catch {
        return []
      }
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        target: target(join(t.targetKey, e.name)),
      }))
    },
  }
}

// Mount the plugin over `cwd` and return the registered tools/commands plus a
// fake `exec` carrying the session cwd the plugin reads.
export function mount(cwd, config = {}, { subagents } = {}) {
  const tools = new Map()
  const commands = new Map()
  const sections = []

  const ctx = {
    fs: makeFs(),
    subagents,
    get(id) {
      // `sandboxPolicy` intentionally absent → plugin falls back to undefined.
      if (id === 'commands') return { register: (c) => commands.set(c.name, c) }
      return undefined
    },
    systemPrompt: { section: (s) => sections.push(s) },
    tools: { register: (t) => tools.set(t.name, t) },
  }

  apply(ctx, config)

  const exec = { agent: { session: { header: { cwd } } } }

  // Lossless-JSON guard (bugfix 1.1 / Property 1). A tool's return value BECOMES the
  // harness's tool result, and the runtime rejects any value whose JSON round-trip is
  // lossy — `undefined`-valued properties silently disappear. Asserting it HERE means
  // every test in this suite covers that contract, instead of each tool's test having
  // to remember: `note: undefined` shipped because nothing ever looked at a return value.
  const assertLosslessJson = (tool, value, path = '$') => {
    if (value === undefined) {
      throw new Error(`${tool}: ${path} is undefined — a tool result must be lossless JSON`)
    }
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new Error(`${tool}: ${path} is a ${typeof value} — not JSON-encodable`)
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${tool}: ${path} is ${value} — not JSON-encodable`)
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => assertLosslessJson(tool, item, `${path}[${i}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) assertLosslessJson(tool, item, `${path}.${key}`)
    }
  }

  const call = async (name, args = {}) => {
    const value = await tools.get(name).execute(args, exec)
    assertLosslessJson(name, value)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${name}: tool result is not lossless JSON`)
    return value
  }

  return { ctx, tools, commands, sections, exec, call }
}

// A SubagentRuntime stand-in. `handler(request)` decides the child's outcome;
// returning a value means "completed", throwing means the child failed.
export function fakeSubagents(handler = () => ({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })) {
  const calls = []
  return {
    calls,
    async start(provider, request) {
      calls.push({ provider, request })
      let settled
      try {
        settled = Promise.resolve(await handler(request))
      } catch (e) {
        settled = Promise.reject(e)
      }
      return {
        id: `run-${calls.length}`,
        localAgent: undefined,
        result: settled,
        async dispose() {},
      }
    },
  }
}

export function readFile(root, ...parts) {
  return readFileSync(join(root, ...parts), 'utf8')
}
