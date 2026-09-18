// 内存 port —— 五个模块的注入式 I/O 面，一份实现给探针与测试共用。
//
// 为什么需要它：五个模块的设计前提就是「I/O 由调用方注入」，所以它们可以在**完全不碰
// 文件系统**的情况下被驱动。冻结快照与包级测试都用它，于是「跑一遍会不会写盘」这个问题
// 在物理上就不成立。
//
// 除 `move` 之外的方法都齐全；`omitMove()` 产出的变体用来证明 `archive` 的降级语义
// （逐文件复制且不删源）——那条语义在母计划里只是散文，本期把它变成断言。
//
// 额外记一份 `writes` 操作日志：只读性除了「前后 hash 相同」之外，还有更直接的证据形态
// ——「readText 被调了 7 次、writeText 一次都没被调」。两者都留。

/** 把绝对路径按 `/` 切段；空段与 `.` 丢掉。不做 `..` 解析（本仓的 port 契约也不做）。 */
function segments(p) {
  return String(p ?? '')
    .split(/[/\\]+/)
    .filter((s) => s !== '' && s !== '.')
}

function normalise(p) {
  const segs = segments(p)
  return `/${segs.join('/')}`
}

function parentOf(p) {
  const segs = segments(p)
  segs.pop()
  return `/${segs.join('/')}`
}

/**
 * 建一个内存 port。`tree` 形如 `{ '/abs/path/file.md': '内容' }`；目录由其路径前缀推导，
 * 也可以用 `{ dirs: [...] }` 显式创建空目录。
 */
export function memoryPort(tree = {}, { dirs = [] } = {}) {
  const files = new Map(Object.entries(tree).map(([k, v]) => [normalise(k), String(v)]))
  const dirsSet = new Set(['/'])
  const log = []
  let writes = 0

  const ensureDir = (p) => {
    const segs = segments(p)
    for (let i = 1; i <= segs.length; i += 1) dirsSet.add(`/${segs.slice(0, i).join('/')}`)
  }
  for (const p of dirs) ensureDir(normalise(p))
  for (const p of files.keys()) ensureDir(parentOf(p))

  const isDir = (p) => dirsSet.has(normalise(p))
  const childrenOf = (p) => {
    const base = normalise(p) === '/' ? '' : normalise(p)
    const prefix = `${base}/`
    const out = new Map()
    for (const f of files.keys()) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length)
      const [head, ...tail] = rest.split('/')
      out.set(head, tail.length === 0 ? 'file' : 'directory')
    }
    for (const d of dirsSet) {
      if (d === normalise(p) || !d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (rest.includes('/')) continue
      if (!out.has(rest)) out.set(rest, 'directory')
    }
    return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }

  return {
    files,
    log,
    get writes() {
      return writes
    },
    async readText(p) {
      const abs = normalise(p)
      log.push(['readText', abs])
      return files.get(abs)
    },
    async writeText(p, text) {
      const abs = normalise(p)
      writes += 1
      log.push(['writeText', abs])
      ensureDir(parentOf(abs))
      files.set(abs, String(text))
    },
    // 读-改-写专用（第 7 期 §9 欠账 ⑤）。内存替身直接比字符串 —— 真实宿主怎么比由它自己定，
    // 契约只要求「不是我读到的那份就抛，且错误里含 REVISION_CONFLICT」。
    async writeTextIfUnchanged(p, text, previousText) {
      const abs = normalise(p)
      log.push(['writeTextIfUnchanged', abs])
      if (files.get(abs) !== previousText) {
        throw Object.assign(
          new Error(`REVISION_CONFLICT: ${abs} changed since it was read`),
          { code: 'REVISION_CONFLICT' },
        )
      }
      writes += 1
      ensureDir(parentOf(abs))
      files.set(abs, String(text))
    },
    async listDir(p) {
      const abs = normalise(p)
      log.push(['listDir', abs])
      return childrenOf(abs).map(([name, type]) => ({ name, type, path: `${abs === '/' ? '' : abs}/${name}` }))
    },
    async exists(p) {
      const abs = normalise(p)
      log.push(['exists', abs])
      return isDir(abs) || files.has(abs)
    },
    async mkdir(p) {
      log.push(['mkdir', normalise(p)])
      ensureDir(normalise(p))
    },
    async move(from, to) {
      const src = normalise(from)
      const dst = normalise(to)
      log.push(['move', src, dst])
      const moved = [...files.keys()].filter((f) => f === src || f.startsWith(`${src}/`))
      for (const f of moved) {
        files.set(`${dst}${f.slice(src.length)}`, files.get(f))
        files.delete(f)
      }
      for (const d of [...dirsSet]) {
        if (d === src || d.startsWith(`${src}/`)) {
          dirsSet.delete(d)
          dirsSet.add(`${dst}${d.slice(src.length)}`)
        }
      }
      ensureDir(dst)
    },
  }
}

/** 把 `move` 删掉的变体：用来断言 `archive` 的复制降级。 */
export function omitMove(port) {
  const { move, ...rest } = port
  return rest
}

/** 逐文件快照（相对路径 → 内容），用于「跑前跑后逐字节相同」这类断言。 */
export function snapshotTree(port) {
  const out = {}
  for (const [k, v] of [...port.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) out[k] = v
  return out
}
