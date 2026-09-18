// dsh-spec — 宿主适配层：把 `ctx.fs` 包成 `@my-harness/spec-analysis` 的 port。
//
// 这一段是从 `lib/index.js` 的 `portOf(exec)` 原样搬出来的（第 2 期 Task 3.2），语义逐行不变。
// 它**留在插件里**、不进共享包：`ctx.fs` 是 DSH 的概念，共享包不该知道它。
//
// 为什么 `exec` 是**绑定**的而不是让模块传：五个模块调的是 `port.writeText(abs, content)`，
// 所以「第三个参数是 exec」这种设计永远拿到 undefined，于是每一次写入都会悄悄丢掉会话的
// 沙箱策略 —— workspace-write 的围栏会退回部署默认策略，把本该允许的写入拒掉。
//
// 为什么 `mkdir` / `move` 走宿主 fs 而不用 `ctx.fs`：`ctx.fs`（@deepseek-ai/dsh-fs）
// 只暴露 readText / writeText / stat / listDir，**没有** move / rename / remove 原语
// （读码核对过服务，也没有 `fs_delete`/`fs_remove` 工具）。真正的目录移动因此无法用它表达，
// 而替代方案是让 archive 静默退化成「复制但留下原 spec」—— 报告成功却留下两份 spec，
// 比失败更糟，因为调用方以为归档完成了。
//
// 与其假装，这两个操作直接用宿主 fs，并把沙箱问题正面回答掉：每一条路径都必须落在
// 解析出来的项目根内，于是 archive 永远不可能被指向工作区之外、也不可能把 spec 移出去。

import { mkdir, rename } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * @param {object} ctx  cordis 上下文（只要 `fs`）
 * @param {object} exec 调用会话（`agent.session.header.cwd` 决定项目根）
 * @param {object} deps 插件自己的三件东西，避免把它们复制一份到本文件
 * @param {(ctx: object, abs: string) => Promise<string|undefined>} deps.readSpecFile
 * @param {(ctx: object, abs: string, content: string, exec: object) => Promise<number>} deps.writeSpecFile
 * @param {(holder: object) => string} deps.rootOf  项目根解析（依赖插件的 config markers）
 * @param {(content: string|undefined) => string|null} deps.baselineOf  内容 → 基线（第 7 期欠账 ⑤）
 */
export function createDshPort(ctx, exec, { readSpecFile, writeSpecFile, rootOf, baselineOf }) {
  // 闭包在**这次调用**的 `exec` 上：项目根由调用会话决定，模块级的 helper 没有会话可依据。
  const assertInsideProject = (p, verb) => {
    const root = rootOf(exec)
    const abs = resolve(p)
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(
        `refusing to ${verb} ${abs}: it is outside the project root ${root}. ` +
          'spec_archive only ever operates within the workspace.',
      )
    }
    return abs
  }

  return {
    readText: async (abs) => readSpecFile(ctx, abs),
    writeText: async (abs, content) => writeSpecFile(ctx, abs, content, exec),
    // 读-改-写专用（第 7 期 §9 欠账 ⑤，2026-09-14 补）：把调用方**刚读到的那份**
    // 折成 `expectedRawRevision`，交给 `writeSpecFile` 的第 5 参 —— 也就是走
    // `writeIntentFor` 的「断言字节」那一态（`'sha256:…'` → 先比对再 replaceIfVersion）。
    //
    // 🔴 与直接调 `writeText` 的区别正是欠账 ⑤ 那个窗口：`writeText` 省略第 5 参，
    // 落进「没表态 → 用**此刻**观测到的版本做基线」，于是「模块读到 T0 → 写之前观测 T1」
    // 这一段没人兜；这里把基线钉死在 T0，窗口就没了。
    writeTextIfUnchanged: async (abs, content, previousText) =>
      writeSpecFile(ctx, abs, content, exec, baselineOf(previousText)),
    exists: async (abs) => {
      try {
        const target = await ctx.fs.resolve(abs)
        return (await ctx.fs.stat(target)) !== undefined
      } catch {
        return false
      }
    },
    listDir: async (abs) => {
      try {
        const target = await ctx.fs.resolve(abs)
        if (typeof ctx.fs.listDir !== 'function') return []
        const entries = await ctx.fs.listDir(target)
        return (Array.isArray(entries) ? entries : []).map((e) => ({
          name: e.name,
          type: e.type,
          path: e.target?.displayPath ?? e.target?.targetKey ?? join(abs, e.name),
        }))
      } catch {
        return []
      }
    },
    // 有它，archive.js 才能**如实**报告 archive 根是不是它建的。没有它，模块只能说
    // 「假定了父目录会被创建」—— 而那在这里是假话，因为 `move` 已经把目录建好了。
    // 一份对自己其实知道的事情含糊其辞的报告，本身也是一种不准确。
    mkdir: async (abs) => {
      await mkdir(assertInsideProject(abs, 'create a directory in'), { recursive: true })
    },
    move: async (src, dest) => {
      assertInsideProject(src, 'move')
      assertInsideProject(dest, 'move to')
      await mkdir(dirname(dest), { recursive: true })
      await rename(src, dest)
    },
  }
}
