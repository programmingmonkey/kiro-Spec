// 真实文件系统上的 port —— 只给测试用。
//
// `memory-port.mjs` 证明的是「模块没有调 writeText」，而 0.2 要提升成包级契约的那条断言
// 是「**跑前跑后目录逐文件 sha256 相同**」（旧套件 `capabilities.test.mjs` 的 `snapshot()`
// 就是这种形态）。两者的失效面不同：前者漏掉「绕过 port 直接写」，后者漏掉「写到了
// 自己以为无关的位置」。所以两种都留。
//
// 本文件是**测试**的 I/O，可以 import `node:fs`；被搬的五个模块不行（有断言守着）。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 建一个真实目录 port。`move` 可选，用来复现降级路径。 */
export function fsPort({ withMove = true } = {}) {
  const port = {
    async readText(abs) {
      try {
        return readFileSync(abs, 'utf8')
      } catch {
        return undefined
      }
    },
    async writeText(abs, text) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    },
    // 读-改-写专用（第 7 期 §9 欠账 ⑤）：盘上还是调用方读到的那份吗？不是就抛。
    async writeTextIfUnchanged(abs, text, previousText) {
      let current
      try { current = readFileSync(abs, 'utf8') } catch { current = undefined }
      if (current !== previousText) {
        throw Object.assign(
          new Error(`REVISION_CONFLICT: ${abs} changed since it was read`),
          { code: 'REVISION_CONFLICT' },
        )
      }
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    },
    async listDir(abs) {
      let entries
      try {
        entries = readdirSync(abs, { withFileTypes: true })
      } catch {
        return []
      }
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: join(abs, e.name),
      }))
    },
    async exists(abs) {
      return existsSync(abs)
    },
    async mkdir(abs) {
      mkdirSync(abs, { recursive: true })
    },
  }
  if (withMove) {
    port.move = async (from, to) => {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    }
  }
  return port
}

/**
 * 逐文件 sha256（相对路径 → 摘要）。这就是旧套件 `snapshot()` 的口径，
 * 也是 0.2 要提升为包级契约的那条断言。
 */
export function hashTree(dir) {
  const out = {}
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) walk(full, rel)
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

/**
 * 把一个 port 包成「每次 writeText 都**真的**落一份到 `<dir>/.probe-extra/`」的变体。
 * 这是反向验证用的：hash 断言必须因此变红，否则那条断言是恒真的。
 */
export function portThatSecretlyWrites(port, dir) {
  const leak = () => {
    const sneak = join(dir, '.probe-extra')
    mkdirSync(sneak, { recursive: true })
    writeFileSync(join(sneak, 'leak.txt'), 'leak')
  }
  return {
    ...port,
    async writeText(abs, text) {
      await port.writeText(abs, text)
      leak()
    },
    // 2026-09-14：`appendSignature` 改走 `writeTextIfUnchanged`（第 7 期 §9 欠账 ⑤），
    // 这个变体必须跟着包住它 —— 否则那条「注入一次写入就必须红」的反向验证会
    // **静默退化成恒真**（它包的那个方法已经没人调了）。
    async writeTextIfUnchanged(abs, text, previousText) {
      await port.writeTextIfUnchanged(abs, text, previousText)
      leak()
    },
  }
}
