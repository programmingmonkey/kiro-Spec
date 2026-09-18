// port 契约 —— `spec-state` 唯一的 I/O 面。
//
// 这份文件的价值与 `@my-harness/spec-analysis/lib/port.d.ts` 相同：让「状态层想要一个新
// 原语」这件事必须先改这里，而不是在某个分支里顺手多调一个 `fs.xxx()`。
//
// 🔴 本包（`lib/` 下）零 `node:fs` / `node:path`，有断言守着。所以连「给 MCP 宿主用的
// node 实现」也必须**由宿主把 node 模块传进来** —— `createNodeFsPort(fsPromises)`。
// 这样两个 MCP 宿主共用同一份 40 行实现（而不是各抄一份），而包里依然没有 node:fs。

/**
 * @typedef {object} SpecStateFsPort
 * @property {(path: string, encoding?: string) => Promise<any>} readFile
 *   `readFile(path)` 返回 Buffer（revision 要对字节敏感，不能只读文本）；
 *   `readFile(path, 'utf8')` 返回 string。文件缺失时抛 `code === 'ENOENT'` 的错误。
 * @property {(path: string, data: string, options?: object) => Promise<void>} writeFile
 * @property {(path: string, flags: string, mode?: number) => Promise<{writeFile: Function, sync: Function, close: Function}>} open
 *   `'wx'`（独占创建）与 `'r'`（读，用于目录 fsync）两种用法。
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(path: string) => Promise<void>} unlink
 * @property {(path: string, options?: object) => Promise<void>} mkdir
 * @property {(path: string) => Promise<void>} rmdir
 * @property {(path: string, options?: object) => Promise<any[]>} readdir
 *   带 `{ withFileTypes: true }` 调用，返回项需有 `.name` 与 `.isDirectory()`。
 * @property {(path: string) => Promise<{mtimeMs: number}>} stat
 * @property {(path: string) => Promise<string>} realpath
 */

/** 状态层实际用到的 fs 原语（读码实测，不是提议的一份清单）。 */
export const REQUIRED_FS_METHODS = Object.freeze([
  'readFile', 'writeFile', 'open', 'rename', 'unlink', 'mkdir', 'rmdir', 'readdir', 'stat', 'realpath'
]);

/**
 * 把 `node:fs/promises`（或任何同形状的命名空间）包成 `SpecStateFsPort`。
 *
 * 用法（宿主侧）：
 * ```js
 * import * as fsp from 'node:fs/promises'
 * import { createNodeFsPort } from '@my-harness/spec-state/ports'
 * const fs = createNodeFsPort(fsp)
 * ```
 *
 * `open` 返回的是宿主自己的 FileHandle —— 状态层只调 `writeFile` / `sync` / `close`，
 * 所以不需要再包一层。
 */
export function createNodeFsPort(fsPromises) {
  const missing = REQUIRED_FS_METHODS.filter((name) => typeof fsPromises?.[name] !== 'function');
  if (missing.length > 0) throw new Error(`createNodeFsPort: fs namespace is missing ${missing.join(', ')}`);
  return {
    readFile: (target, ...rest) => fsPromises.readFile(target, ...rest),
    writeFile: (target, data, options) => fsPromises.writeFile(target, data, options),
    open: (target, flags, mode) => fsPromises.open(target, flags, mode),
    rename: (from, to) => fsPromises.rename(from, to),
    unlink: (target) => fsPromises.unlink(target),
    mkdir: (target, options) => fsPromises.mkdir(target, options),
    rmdir: (target) => fsPromises.rmdir(target),
    readdir: (target, options) => fsPromises.readdir(target, options),
    stat: (target) => fsPromises.stat(target),
    realpath: (target) => fsPromises.realpath(target)
  };
}
