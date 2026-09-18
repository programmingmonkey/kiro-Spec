// Spec 的持久化层（第 7 期从 `plugins/{kiro,claude}-spec/lib/core/storage.mjs` 搬出并 port 化）。
//
// 搬之前它直接 `import … from 'node:fs/promises'` 与 `node:path`。所以「进包」这件事对它
// 等价于「改成 port 注入」——这是本期最具体的一块工作量，也是 dsh 能复用同一套 CAS 的前提
// （dsh 写盘走 cordis 的 `ctx.fs` + 沙箱策略，不可能直接用 `node:fs`）。
//
// 三件事**一字未改**：
//   ① CAS 判据 `(current ? computeRawRevision(current) : undefined) !== expectedRawRevision`
//      —— `undefined` 的含义是「我预期这个文件还不存在」，不是「跳过校验」（R7-8）；
//   ② `tasks.meta.json` 只读（母计划非目标：不动它的字节）；
//   ③ `target()` 的路径逃逸检查（`PATH_OUTSIDE_PROJECT` / `SYMLINK_ESCAPE`）。

import { computeRawRevision } from './core/revision.mjs';
import * as paths from './paths.mjs';

function error(code, message) { return Object.assign(new Error(message), { code }); }

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.specsRoot
 * @param {string} [options.privateDir]      私有目录绝对路径；缺省时用 `privateDirName`
 * @param {string} [options.privateDirName]  私有目录名（参数化，不写死）
 * @param {string[]} [options.allowedPrefixes]
 * @param {object} options.fs                文件系统 port（见 lib/ports.mjs）
 */
export async function createSpecStorage({
  projectRoot,
  specsRoot,
  privateDir,
  privateDirName = '.kiro-spec-private',
  allowedPrefixes = [],
  fs,
  randomUUID
}) {
  if (!fs || typeof fs.readFile !== 'function' || typeof fs.open !== 'function') {
    throw error('PORT_MISSING', 'spec-state storage requires an injected fs port (readFile/open at minimum)');
  }
  // 与 fs port 同样**当场**校验：缺随机数时就建实例，会让「忘了注入」拖到第一次写盘才暴露，
  // 而那时已经写了一半。
  if (typeof randomUUID !== 'function') {
    throw error('PORT_MISSING', 'spec-state storage requires the randomUUID port');
  }
  const makeId = randomUUID;
  const project = await fs.realpath(projectRoot);
  const requestedSpecs = paths.resolve(project, specsRoot);
  let specs;
  try { specs = await fs.realpath(requestedSpecs); }
  catch (caught) { if (caught.code !== 'ENOENT') throw caught; specs = requestedSpecs; }
  if (!paths.inside(project, specs)) throw error('PATH_OUTSIDE_PROJECT', 'specsRoot is outside project');
  const privateRoot = privateDir ?? paths.join(project, privateDirName);
  const frozen = new Set();
  const adopted = new Map();
  const journalEntries = new Map();

  // 🔴 跨宿主提醒（2026-09-14）：本层的 CAS 判据是
  //   `(current ? computeRawRevision(current) : undefined) !== expectedRawRevision`
  // 也就是 **`undefined` = 「我预期这个文件还不存在」** —— 文件已存在时传 `undefined`
  // 会直接 `REVISION_CONFLICT`，它**不是**「跳过校验」。
  //
  // `plugins/dsh-spec` 的 `writeIntentFor` 有**第三态**，且与这里方向相反：它把
  // `null` 当「预期不存在」，而**省略**当「调用点没表态」→ 用此刻观测到的版本做基线、
  // 于是**成功**。理由写在那个函数上方（12 个既有写调用点不改签名）。
  //
  // 后果：**同一段代码、省略同一个参数，在两个宿主上一个冲突、一个成功。**
  // 改这里的语义之前先看那边；反之亦然。第 7 期 Task 5 Step 3 记着这件事。
  async function durableReplace(file, content) {
    const temp = `${file}.${makeId()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.rename(temp, file);
      const directory = await fs.open(paths.dirname(file), 'r');
      try { await directory.sync(); } catch { /* directory fsync is not supported on every platform */ } finally { await directory.close(); }
    } catch (cause) { await fs.unlink(temp).catch(() => {}); throw cause; }
  }

  async function persistJournal(entry) {
    await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
    const file = paths.join(privateRoot, `journal-${entry.id}.json`);
    await durableReplace(file, JSON.stringify(entry));
  }

  async function target(relativePath, writing = false) {
    if (paths.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) throw error('PATH_OUTSIDE_PROJECT', 'relative path escapes specsRoot');
    const lexical = paths.resolve(specs, relativePath);
    if (!paths.inside(specs, lexical)) throw error('PATH_OUTSIDE_PROJECT', 'relative path escapes specsRoot');
    if (writing && !allowedPrefixes.some((prefix) => relativePath.startsWith(prefix))) throw error('WRITE_POLICY_DENIED', 'path is not allowed by writePolicy');
    const parent = await fs.realpath(paths.dirname(lexical));
    if (!paths.inside(specs, parent)) throw error('SYMLINK_ESCAPE', 'symlink escapes specsRoot');
    try {
      const resolved = await fs.realpath(lexical);
      if (!paths.inside(specs, resolved)) throw error('SYMLINK_ESCAPE', 'symlink escapes specsRoot');
      return resolved;
    } catch (caught) {
      if (caught.code === 'ENOENT') return lexical;
      throw caught;
    }
  }

  async function read(relativePath) {
    const file = await target(relativePath);
    const raw = await fs.readFile(file);
    return { content: raw.toString('utf8'), rawRevision: computeRawRevision(raw) };
  }

  async function write({ relativePath, content, expectedRawRevision }) {
    if (paths.basename(relativePath) === 'tasks.meta.json') throw error('READ_ONLY_ARTIFACT', 'tasks.meta.json is read-only');
    const spec = relativePath.split('/').slice(0, -1).join('/');
    if (frozen.has(spec)) throw error('SPEC_FROZEN', 'spec is frozen');
    const file = await target(relativePath, true);
    let current;
    try { current = await fs.readFile(file); } catch { current = undefined; }
    if ((current ? computeRawRevision(current) : undefined) !== expectedRawRevision) throw error('REVISION_CONFLICT', 'rawRevision does not match');
    await durableReplace(file, content);
    return { rawRevision: computeRawRevision(Buffer.from(content, 'utf8')) };
  }

  async function adopt({ spec, workflow }) {
    const dir = await target(spec);
    if (!paths.inside(specs, await fs.realpath(dir))) throw error('SYMLINK_ESCAPE', 'spec symlink escapes specsRoot');
    const artifacts = {};
    for (const name of ['requirements', 'bugfix', 'design', 'tasks']) {
      try { artifacts[name] = await read(`${spec}/${name}.md`); } catch { /* optional */ }
    }
    const state = { status: 'imported', workflow, artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, { rawRevision: value.rawRevision }])) };
    adopted.set(spec, state);
    return state;
  }

  async function freeze({ spec }) { await target(spec); frozen.add(spec); return { spec, frozen: true }; }
  async function archivePreview({ spec }) {
    const dir = await target(spec);
    const files = (await Promise.all(['requirements.md', 'bugfix.md', 'design.md', 'tasks.md'].map(async (name) => {
      try { const raw = await fs.readFile(paths.join(dir, name)); return [name, computeRawRevision(raw)]; } catch { return undefined; }
    }))).filter(Boolean);
    return { spec, destination: `_archive/${paths.basename(spec)}`, snapshotRevision: computeRawRevision(Buffer.from(JSON.stringify(files))) };
  }
  async function archiveApply({ preview }) {
    const current = await archivePreview({ spec: preview.spec });
    if (current.snapshotRevision !== preview.snapshotRevision || current.destination !== preview.destination) throw error('REVISION_CONFLICT', 'archive preview is stale');
    const source = await target(preview.spec);
    const destination = paths.resolve(specs, preview.destination);
    if (!paths.inside(specs, destination)) throw error('PATH_OUTSIDE_PROJECT', 'archive destination escapes specsRoot');
    await fs.mkdir(paths.dirname(destination), { recursive: true, mode: 0o700 });
    try { await fs.stat(destination); throw error('SPEC_ALREADY_EXISTS', 'archive destination exists'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    await fs.rename(source, destination);
    frozen.delete(preview.spec);
    return { archived: true, destination: preview.destination };
  }

  return {
    projectRoot: project, specsRoot: specs, read, write, adopt, freeze, archivePreview, archiveApply,
    journal: {
      async begin({ spec, intent }) { const entry = { id: makeId(), spec, intent, status: 'pending', createdAt: new Date().toISOString() }; journalEntries.set(entry.id, entry); await persistJournal(entry); return entry; },
      async commit({ id }) { const entry = journalEntries.get(id) ?? JSON.parse(await fs.readFile(paths.join(privateRoot, `journal-${id}.json`), 'utf8')); if (!entry) throw error('JOURNAL_NOT_FOUND', 'journal entry not found'); entry.status = 'committed'; journalEntries.set(id, entry); await persistJournal(entry); return { ...entry }; },
      async resolve({ id, status }) { if (!['committed', 'rolled_back'].includes(status)) throw error('INVALID_JOURNAL_STATUS', 'invalid journal status'); const entry = journalEntries.get(id) ?? JSON.parse(await fs.readFile(paths.join(privateRoot, `journal-${id}.json`), 'utf8')); entry.status = status; journalEntries.set(id, entry); await persistJournal(entry); return { ...entry }; },
      async get({ id }) { try { return JSON.parse(await fs.readFile(paths.join(privateRoot, `journal-${id}.json`), 'utf8')); } catch { throw error('JOURNAL_NOT_FOUND', 'journal entry not found'); } },
      async list({ spec, status }) {
        let names;
        try { names = await fs.readdir(privateRoot); } catch (caught) { if (caught.code === 'ENOENT') return []; throw caught; }
        const entries = [];
        for (const name of names.filter((candidate) => /^journal-[0-9a-f-]+\.json$/.test(candidate))) {
          const entry = JSON.parse(await fs.readFile(paths.join(privateRoot, name), 'utf8'));
          if ((!spec || entry.spec === spec) && (!status || entry.status === status)) entries.push(entry);
        }
        return entries;
      }
    }
  };
}
