import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSpecStorage } from '../lib/core/storage.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';

// `codex-spec-rename` 期 Task 7（L3）—— 私有状态目录改名 + 旧名**只读**兼容读。
//
// 三种输入各一条用例（Req 4.1 / 4.2 / 4.3）：只有旧目录 / 只有新目录 / 两者都有。
//
// ⚠️ 两条刻意的写法，都是为了这份用例不被**别的**任务改动带红：
//   ① adapter 路径**显式**给出（不靠 `lib/mcp/adapter.mjs` 的默认值）—— 那默认值是 L4/Task 6 的面；
//   ② 旧目录名与新目录名**写字面量**，不从被测模块里 import 常量 —— 只写一个字面量，
//      这条断言就不算「拿被测代码自己的定义去证明被测代码」。

const ADAPTER_PATH = '.codex/codex-spec.json';
const SPEC = '_eval-codex-20260827';
/** Req 4.1 的新名。 */
const NEW_DIR_NAME = '.codex-spec-private';
/** Req 4.2 只读回退的旧名 —— 磁盘上既有项目用的就是它。 */
const LEGACY_DIR_NAME = '.kiro-spec-private';
/** 一份最小的合法 `tasks.md`：`spec_status` 会解析它，所以不能是随便一段文本。 */
const TASKS = '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Implement the record\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n';

/** 一个最小项目：`.kiro/specs` + 一份 adapter（`authorized`，只允许 `_eval-codex-20260827/`）。 */
async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-l3-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await writeFile(path.join(root, ADAPTER_PATH), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: { mode: 'authorized', allowedPrefixes: [`${SPEC}/`] },
    rules: []
  }));
  return root;
}

/** 开一个服务。不给 `privateDir` 时就是**生产形状**（`mcp-server.mjs` 只传 `projectRoot`）。 */
function open(root, privateDir) {
  return createMcpService({ projectRoot: root, adapterPath: ADAPTER_PATH, ...(privateDir === undefined ? {} : { privateDir }) });
}

/** 目录的字节快照：`{ 相对路径: sha256 }`；目录不存在返回 `null`。 */
async function snapshot(dir) {
  let entries;
  try { entries = await readdir(dir, { recursive: true }); } catch (caught) { if (caught.code === 'ENOENT') return null; throw caught; }
  const out = {};
  for (const entry of entries.sort()) {
    const abs = path.join(dir, entry);
    if (!(await stat(abs)).isFile()) continue;
    out[entry] = createHash('sha256').update(await readFile(abs)).digest('hex');
  }
  return out;
}

/** 「升级前」的形状：旧插件在自己的私有目录里写状态（`privateDir` 就是旧名那个目录）。 */
async function seed(root, dir, workflow, expectedPhase) {
  const service = await open(root, dir);
  assert.equal((await service.call('spec_init', { spec: SPEC, workflow })).phase, expectedPhase, `spec_init 在 ${dir} 上没有落进 ${expectedPhase}`);
  return service;
}

test('L3 只有旧目录：读旧状态、回报 stateDirSource=legacy、新写入落新目录、旧目录逐字节只读', async () => {
  const root = await makeProject();
  const newDir = path.join(root, NEW_DIR_NAME);
  const legacyDir = path.join(root, LEGACY_DIR_NAME);

  await seed(root, legacyDir, 'requirements-first', 'requirements_draft');
  const legacyBefore = await snapshot(legacyDir);
  assert.ok(Object.keys(legacyBefore).some((name) => name.startsWith('state-')), `旧目录里应当已有 state：${JSON.stringify(legacyBefore)}`);
  await assert.rejects(() => stat(newDir), { code: 'ENOENT' }, '起点：新目录不该存在');

  const service = await open(root);
  // Req 4.3：只存在旧目录 → 报 legacy（不静默降级成「无历史」）
  assert.equal((await service.call('spec_health', {})).stateDirSource, 'legacy');
  // Req 4.2：旧目录里的 state 被读到
  assert.equal((await service.call('spec_status', { spec: SPEC })).phase, 'requirements_draft');
  // 读到的确实被当成「已有状态」，而不是「全新项目」
  assert.equal((await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' })).code, 'SPEC_ALREADY_EXISTS');

  // Req 4.2：新的写入落在**新**目录
  assert.equal((await service.call('spec_init', { spec: `${SPEC}/second`, workflow: 'requirements-first' })).phase, 'requirements_draft');
  const newEntries = await readdir(newDir);
  assert.ok(newEntries.some((name) => name.startsWith('state-')), `新目录里应当有新的 state：${JSON.stringify(newEntries)}`);

  // Req 4.2：旧目录**只读** —— 一个字节都没变（含「没有新增文件」）
  assert.deepEqual(await snapshot(legacyDir), legacyBefore);
});

test('L3 只有新目录：读新状态、不报 stateDirSource、旧目录始终不被创建', async () => {
  const root = await makeProject();
  const legacyDir = path.join(root, LEGACY_DIR_NAME);

  await seed(root, path.join(root, NEW_DIR_NAME), 'requirements-first', 'requirements_draft');
  await assert.rejects(() => stat(legacyDir), { code: 'ENOENT' }, '旧目录不该被创建');

  const service = await open(root);
  assert.equal((await service.call('spec_health', {})).stateDirSource, undefined, '只有新目录时没有「来源」要说');
  assert.equal((await service.call('spec_status', { spec: SPEC })).phase, 'requirements_draft');
  assert.equal((await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' })).code, 'SPEC_ALREADY_EXISTS');
  await assert.rejects(() => stat(legacyDir), { code: 'ENOENT' }, '跑过一轮之后旧目录仍不该存在');
});

test('L3 两者都有：同名 state 以新目录为准，旧目录仍未被写', async () => {
  const root = await makeProject();
  const newDir = path.join(root, NEW_DIR_NAME);
  const legacyDir = path.join(root, LEGACY_DIR_NAME);

  // 两个目录里放**同名** state（同一 spec），但 workflow 不同 —— 这样才能分辨读到了哪一份。
  await seed(root, newDir, 'requirements-first', 'requirements_draft');
  await seed(root, legacyDir, 'design-first', 'design_draft');
  const legacyBefore = await snapshot(legacyDir);
  assert.equal(Object.keys(await snapshot(newDir)).length, Object.keys(legacyBefore).length, '两个目录应当各有一份同名 state');

  const service = await open(root);
  assert.equal((await service.call('spec_health', {})).stateDirSource, undefined, '两者都在时以新目录为准，没有 legacy 要说');
  assert.equal((await service.call('spec_status', { spec: SPEC })).phase, 'requirements_draft', '读到的必须是**新**目录那一份（design-first 那份是 design_draft）');
  assert.equal((await service.call('spec_init', { spec: SPEC, workflow: 'requirements-first' })).code, 'SPEC_ALREADY_EXISTS');
  assert.deepEqual(await snapshot(legacyDir), legacyBefore, '旧目录仍然只读');
});

test('L3 只存在旧目录：旧目录里的 pending journal 也被枚举到（journal 走 readdir 回退）', async () => {
  const root = await makeProject();
  const legacyDir = path.join(root, LEGACY_DIR_NAME);
  await seed(root, legacyDir, 'requirements-first', 'requirements_draft');
  await writeFile(path.join(root, '.kiro', 'specs', SPEC, 'tasks.md'), TASKS);

  // 用**真的**存储层在旧目录里落一条 pending journal —— 手写 JSON 等于自己造一份格式。
  const storage = await createSpecStorage({ projectRoot: root, specsRoot: '.kiro/specs', privateDir: legacyDir, allowedPrefixes: [`${SPEC}/`] });
  const entry = await storage.journal.begin({
    spec: SPEC,
    intent: { action: 'task_begin', taskId: '1', beforeRawRevision: 'sha256:before', afterRawRevision: 'sha256:after' }
  });
  const legacyBefore = await snapshot(legacyDir);

  // `spec_status` 的 `reconcilePending` 是唯一会枚举 journal 的公开路径；它列得到这条旧条目，
  // 才会报出 `journal_state_mismatch`（tasks.md 的 revision 与两个 intent revision 都不等）。
  const service = await open(root);
  const status = await service.call('spec_status', { spec: SPEC });
  assert.deepEqual(status.recovery, { code: 'RECOVERY_REQUIRED', taskId: '1', journalId: entry.id, reason: 'journal_state_mismatch' });

  // 回退只**读**：旧目录里的那条 journal 一个字节都没动（也没有被搬走）
  assert.deepEqual(await snapshot(legacyDir), legacyBefore);
});

// ── 2026-09-17 review 修复轮：三条「回退静默失效」的用例 ───────────────────────
//
// 三条都来自同一次 review 的实测，形状也同源：**回退看起来接上了，实际没接上**。
// 它们的判据都不是「结果里有没有新字段」，而是「旧目录里的数据到底有没有被读到」——
// 前者在静默失效时照样能给一个自洽的答案。

test('L3 回退：`privateDir` 末尾多一个分隔符时旧目录**仍然**被读到（归属判据不许靠字符串前缀）', async () => {
  const root = await makeProject();
  const legacyDir = path.join(root, LEGACY_DIR_NAME);
  await seed(root, legacyDir, 'requirements-first', 'requirements_draft');

  // 调用方给的路径末尾多一个分隔符。归一化之前，归属判据拼出的是
  // `'<root>/.codex-spec-private//'` —— **任何一个目标都命中不了**，于是回退静默全灭。
  const service = await open(root, `${path.join(root, NEW_DIR_NAME)}${path.sep}`);

  assert.equal((await service.call('spec_health', {})).stateDirSource, 'legacy', '旧目录在场，来源就该报 legacy');
  assert.equal(
    (await service.call('spec_status', { spec: SPEC })).phase,
    'requirements_draft',
    '旧目录里的 state 必须仍被读到 —— 返回 `phase: undefined` 就是「回退全灭」的样子'
  );
});

test('L3 回退：锁路径不回退 —— 旧目录里的陈旧 owner.json 不许决定新目录那把锁的活跃性', async () => {
  const root = await makeProject();
  const newDir = path.join(root, NEW_DIR_NAME);
  const legacyDir = path.join(root, LEGACY_DIR_NAME);
  await seed(root, legacyDir, 'requirements-first', 'requirements_draft');
  await writeFile(path.join(root, '.kiro', 'specs', SPEC, 'tasks.md'), TASKS);

  // 新目录那把锁**已经存在**（`mkdir` 会给 EEXIST），但里面没有 `owner.json`。
  const [stateName] = (await readdir(legacyDir)).filter((name) => name.startsWith('state-'));
  assert.ok(stateName, '前置：旧目录里应当已经有一份 state');
  const lockName = `${stateName}.lock`;
  await mkdir(path.join(newDir, lockName), { recursive: true });
  // 锁目录的 mtime 弄旧：共享层在「读不到 owner.json」时会据此判「上一个写者已经走了」。
  const past = new Date(Date.now() - 60_000);
  await utimes(path.join(newDir, lockName), past, past);

  // 旧目录里放一份**看起来还活着**的 owner（pid 就是本进程）——复现「新目录的锁被旧数据接管」。
  await mkdir(path.join(legacyDir, lockName), { recursive: true });
  await writeFile(
    path.join(legacyDir, lockName, 'owner.json'),
    JSON.stringify({ pid: process.pid, createdAt: Date.now() })
  );

  const service = await open(root);
  const status = await service.call('spec_status', { spec: SPEC });

  assert.notEqual(
    status.code,
    'STATE_LOCK_TIMEOUT',
    '锁落在了旧目录的陈旧 owner.json 上：新目录那把锁被判成「有人持有」，一直空转到超时'
  );
  assert.equal(status.phase, 'requirements_draft', '拿到锁之后照旧从旧目录读状态');
});

test('L3 有效来源：新目录被一次写建出来之后，spec_health **仍须**报 legacy', async () => {
  const root = await makeProject();
  const legacyDir = path.join(root, LEGACY_DIR_NAME);
  await seed(root, legacyDir, 'requirements-first', 'requirements_draft');
  await assert.rejects(() => stat(path.join(root, NEW_DIR_NAME)), { code: 'ENOENT' }, '起点：新目录还不存在');

  const service = await open(root);
  assert.equal((await service.call('spec_health', {})).stateDirSource, 'legacy');

  // 一次**写**：共享层在建锁之前就 `mkdir` 出新目录（`acquireSpecLock` / `putState` 都是这样）。
  assert.equal(
    (await service.call('spec_init', { spec: `${SPEC}/second`, workflow: 'requirements-first' })).phase,
    'requirements_draft'
  );
  assert.ok((await readdir(path.join(root, NEW_DIR_NAME))).length > 0, '前置：这一次写必须已经建出新目录');

  // 新目录存在了，但**有效来源仍是旧目录**：旧目录里的老条目在新目录里没有对应物，
  // 而 `spec_status` 读的就是它们。若判据是「新目录存在吗」，这个信号在这一次写之后就永久消失。
  assert.equal(
    (await service.call('spec_health', {})).stateDirSource,
    'legacy',
    '新目录存在之后就报不出 legacy —— 那是一次性信号，而数据**仍读自旧目录**'
  );
  assert.equal((await service.call('spec_status', { spec: SPEC })).phase, 'requirements_draft');
});
