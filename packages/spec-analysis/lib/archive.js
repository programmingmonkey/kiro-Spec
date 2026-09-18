// spec-analysis — archive a finished spec out of the active area（第 2 期自 plugins/dsh-spec 原样搬出）。
//
// `_archive/` is the terminal state of a spec: the artifact is kept for history
// while leaving the active set, so resolution ("which spec am I working on") never
// has to guess between a live spec and a retired one. Moving the directory is the
// only destructive act in dsh-spec, which is why Req 6.5 is absolute:
//
//   an archive is REFUSED when <archiveRoot>/<feature> already exists.
//
// A silent overwrite would destroy the earlier snapshot, and nothing in the repo
// would notice: the archive area has no signature and no lint backstop (§7.1.1),
// so both sides of a clobber look equally "valid" afterwards. The conflict is
// detected before any write, so a refused archive changes nothing byte-for-byte.
//
// ZERO filesystem access by design: every read, write and move goes through an
// injected `port` ({ readText, writeText, listDir, exists, move? }). No `node:fs`,
// no `node:path`. `port.move` is OPTIONAL — when the host does not provide it the
// spec is copied file-by-file instead, and the source is deliberately left in
// place (this module never deletes anything outside a real move; truncating or
// rewriting the source to "simulate" removal would corrupt a spec).

function joinPath(...parts) {
  const out = []
  for (const part of parts) {
    if (part === undefined || part === null || part === '') continue
    const s = String(part)
    if (out.length === 0) out.push(s.replace(/[\\/]+$/, '') || '/')
    else out.push(s.replace(/^[\\/]+/, '').replace(/[\\/]+$/, ''))
  }
  return out.join('/')
}

function basename(p) {
  const parts = String(p ?? '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter((segment) => segment !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

// Any path segment exactly equal to `_archive` (segment-wise: a spec named
// `my_archive_notes` is not the archive area).
function hasArchiveSegment(p) {
  return String(p ?? '')
    .split(/[\\/]+/)
    .some((segment) => segment === '_archive')
}

function requirePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`archive: \`${label}\` must be a non-empty absolute path; got ${JSON.stringify(value)}`)
  }
  return value.replace(/[\\/]+$/, '') || '/'
}

function requirePort(port, method) {
  if (!port || typeof port[method] !== 'function') {
    throw new Error(
      `archive: port.${method} is required — I/O is injected, this module never touches the filesystem directly`,
    )
  }
  return port
}

// `exists` is the authoritative probe; `listDir` is only a fallback for a port
// that omits it, and it is read as "definitely present" only when non-empty (an
// empty result cannot be told apart from a missing directory, so it is not
// treated as a conflict on its own).
async function pathExists(port, abs) {
  if (typeof port.exists === 'function') {
    try {
      return Boolean(await port.exists(abs))
    } catch {
      /* fall through to listDir */
    }
  }
  if (typeof port.listDir === 'function') {
    try {
      const entries = await port.listDir(abs)
      return Array.isArray(entries) && entries.length > 0
    } catch {
      return false
    }
  }
  return false
}

// `specDir`'s basename is the archive entry name. Refusing `.`/`..` matters: on
// `/a/..` a naive basename would yield `..` and `joinPath(root, '..')` would move
// the spec OUTSIDE the archive root.
function featureOf(specDir) {
  const base = basename(specDir)
  if (base === '' || base === '.' || base === '..') {
    throw new Error(
      `archive: cannot derive a feature name from ${JSON.stringify(specDir)} — specDir must end in the spec's own directory name`,
    )
  }
  return base
}

// Best-effort creation of the archive root. `mkdir` IS in the documented port
// contract (`lib/port.d.ts`), but a host may still omit it — and when it does,
// every writer we use (writeText/move) is expected to create missing parents, an
// assumption this module cannot verify from here. That is why the outcome is
// reported (`archiveRootVia: 'assumed-parent-creation'`) instead of assumed.
//
// 第 2 期订正：这段注释原先写的是「`mkdir` 不在 port 契约里」—— 契约落地之后就变成
// 假话了。契约把它列为必需，但**模块仍然容忍它缺席**（缺了就走上面那条假设路径）。
async function ensureArchiveRoot(port, root) {
  if (await pathExists(port, root)) return { created: false, via: 'exists' }
  if (typeof port.mkdir === 'function') {
    await port.mkdir(root)
    return { created: true, via: 'mkdir' }
  }
  return { created: false, via: 'assumed-parent-creation' }
}

// Read-then-write fallback used only when `port.move` is absent. Text-only (the
// port contract has no binary read) and empty directories are not preserved —
// both are acceptable for a spec directory of markdown/JSON artifacts, and both
// are reported to the caller.
async function copyTree(port, src, dest, counter) {
  let entries
  try {
    entries = await port.listDir(src)
  } catch (err) {
    throw new Error(`archive: cannot list ${src}: ${err?.message ?? err}`)
  }
  if (!Array.isArray(entries)) throw new Error(`archive: cannot list ${src} (listDir returned ${typeof entries})`)
  for (const entry of entries) {
    const from = typeof entry?.path === 'string' && entry.path !== '' ? entry.path : joinPath(src, entry?.name)
    const to = joinPath(dest, entry?.name)
    if (entry?.type === 'directory') {
      await copyTree(port, from, to, counter)
      continue
    }
    const text = await port.readText(from)
    if (typeof text !== 'string') throw new Error(`archive: cannot read ${from} while copying`)
    await port.writeText(to, text)
    counter.files += 1
  }
  return counter
}

// Would archiving `specDir` be refused for the 6.5 conflict? True iff the
// destination directory already exists. Pure query: it never throws for a missing
// source and never writes.
export async function archiveConflict({ port, specDir, archiveRoot }) {
  const source = requirePath(specDir, 'specDir')
  const root = requirePath(archiveRoot, 'archiveRoot')
  requirePort(port, 'listDir')
  const dest = joinPath(root, featureOf(source))
  return pathExists(port, dest)
}

export async function archiveSpec({ port, specDir, archiveRoot }) {
  const source = requirePath(specDir, 'specDir')
  const root = requirePath(archiveRoot, 'archiveRoot')
  requirePort(port, 'readText')
  requirePort(port, 'writeText')
  requirePort(port, 'listDir')
  requirePort(port, 'exists')

  if (hasArchiveSegment(source)) {
    throw new Error(
      `archive: refusing to archive ${source} — it is already under _archive/. A spec leaves the archive area\n` +
        'only by being restored explicitly; re-archiving it would either nest archives or race the existing copy.',
    )
  }

  const feature = featureOf(source)
  const dest = joinPath(root, feature)
  if (dest === source) {
    throw new Error(`archive: refusing to archive ${source} — the destination is the source itself`)
  }
  // Nesting in EITHER direction is not an archive. Checked here, before
  // `ensureArchiveRoot` creates anything: a rename into one's own subtree fails
  // with EINVAL only AFTER mkdir has already left the intermediate directories
  // behind — the "reported failure with a real side effect" shape this module
  // exists to avoid. `archiveRoot` is caller-supplied, so this is reachable.
  if (dest.startsWith(source + '/') || source.startsWith(dest + '/')) {
    throw new Error(
      `archive: refusing to archive ${source} — ${dest} lies inside the source (or the source lies inside\n` +
        'the destination). A spec cannot be archived into itself: the rename would fail after directories had\n' +
        'already been created. Nothing was changed. Pass an archive root that is not inside the spec.',
    )
  }
  if (!(await pathExists(port, source))) {
    throw new Error(`archive: source spec directory does not exist: ${source} (nothing was moved)`)
  }

  // Req 6.5. Checked BEFORE creating anything, so a refused archive leaves both
  // the archive root and the existing destination byte-identical.
  if (await pathExists(port, dest)) {
    throw new Error(
      `archive: refusing to archive ${source} — ${dest} already exists.\n` +
        'Overwriting it would destroy the earlier archived snapshot, and the archive area has no signature or\n' +
        'lint backstop to detect that afterwards. Nothing was changed; rename or move the existing archive first.',
    )
  }

  const rootState = await ensureArchiveRoot(port, root)
  const report = {
    feature,
    source,
    destination: dest,
    sourceRemoved: true,
    archiveRoot: root,
    createdArchiveRoot: rootState.created,
    // 'exists' | 'mkdir' | 'assumed-parent-creation'. The last one means the port
    // exposed no mkdir and the root will only come into being when the first file
    // write (or the move) creates it — an assumption this module cannot verify, so
    // it is reported rather than hidden.
    archiveRootVia: rootState.via,
    filesCopied: 0,
    // `null`, not `undefined`: this report is returned as a tool result, and the
    // runtime rejects a value whose JSON round-trip is lossy — an `undefined`-valued
    // property silently disappears in JSON.stringify, which is precisely the
    // "not lossless JSON" rejection. signature.js's `finding: null` is the same rule.
    note: null,
  }

  if (typeof port.move === 'function') {
    await port.move(source, dest)
    return report
  }

  const counter = await copyTree(port, source, dest, { files: 0 })
  report.filesCopied = counter.files
  report.sourceRemoved = false
  report.note =
    `port.move is unavailable: ${counter.files} file(s) were copied into ${dest}, but ${source} was NOT removed. ` +
    'This module never deletes anything outside a successful move, and it will not truncate the source to fake ' +
    'removal — the caller (or host) must delete the source directory itself.'
  return report
}
