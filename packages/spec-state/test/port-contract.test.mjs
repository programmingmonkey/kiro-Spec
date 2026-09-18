// 第 7 期 Task 3 Step 4 —— port 契约与 CAS 的「无基线」语义。
//
// 这里钉的是**本期最容易走偏的两件事**：
//   ① 缺 port 时当场抛，而不是悄悄退回 `node:crypto` / `node:fs`（R7-1：注入变成直接调用
//      之后单测照样绿，而真机上租约行为变了）；
//   ② `expectedRawRevision: undefined` 的语义是「我预期这个文件还不存在」，**不是**
//      「跳过校验」（R7-8：dsh 照这套接，不许发明第三种）。
//
// 测试自己可以 import `node:fs`（它是宿主的 I/O，不是被测模块的）—— 这一点与
// `@my-harness/spec-analysis` 的 `test/tools/fs-port.mjs` 同例。

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { REQUIRED_FS_METHODS, createNodeFsPort } from '../lib/ports.mjs';
import { createSpecStorage } from '../lib/storage.mjs';

const fsp = await import('node:fs/promises');

test('port 契约：清单里的每个方法都必须在，缺一个就当场抛', () => {
  assert.deepEqual([...REQUIRED_FS_METHODS].sort(), [
    'mkdir', 'open', 'readFile', 'readdir', 'realpath', 'rename', 'rmdir', 'stat', 'unlink', 'writeFile'
  ]);
  const partial = Object.fromEntries(REQUIRED_FS_METHODS.filter((name) => name !== 'rename').map((name) => [name, () => {}]));
  assert.throws(() => createNodeFsPort(partial), /missing rename/);
  assert.throws(() => createNodeFsPort(undefined), /missing/);
});

test('缺 fs port / randomUUID port 时当场抛，不退回到宿主默认实现', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spec-state-port-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await assert.rejects(
    () => createSpecStorage({ projectRoot: root, specsRoot: '.kiro/specs' }),
    { code: 'PORT_MISSING' }
  );
  await assert.rejects(
    () => createSpecStorage({ projectRoot: root, specsRoot: '.kiro/specs', fs: createNodeFsPort(fsp) }),
    { code: 'PORT_MISSING' }
  );
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spec-state-cas-'));
  const specDir = path.join(root, '.kiro', 'specs', '_eval-codex-20260913', 'demo');
  await mkdir(specDir, { recursive: true });
  const storage = await createSpecStorage({
    projectRoot: root,
    specsRoot: '.kiro/specs',
    privateDir: path.join(root, '.private'),
    allowedPrefixes: ['_eval-codex-20260913/'],
    fs: createNodeFsPort(fsp),
    randomUUID: () => '00000000-0000-4000-8000-000000000000'
  });
  return { root, specDir, storage, relativePath: '_eval-codex-20260913/demo/requirements.md' };
}

test('🔴 `expectedRawRevision: undefined` 的含义是「我预期这个文件还不存在」', async () => {
  const { specDir, storage, relativePath } = await setup();
  // ① 文件不存在 → undefined 放行（这是「首次写入」那条路）
  const first = await storage.write({ relativePath, content: '# A\n', expectedRawRevision: undefined });
  assert.match(first.rawRevision, /^sha256:/);
  assert.equal(await readFile(path.join(specDir, 'requirements.md'), 'utf8'), '# A\n');
  // ② 文件已存在 → 同一个 undefined 必须撞 REVISION_CONFLICT，而不是静默覆盖
  await assert.rejects(
    () => storage.write({ relativePath, content: '# B\n', expectedRawRevision: undefined }),
    { code: 'REVISION_CONFLICT' }
  );
  assert.equal(await readFile(path.join(specDir, 'requirements.md'), 'utf8'), '# A\n', '被拒绝的写入不得改动字节');
  // ③ 拿对了基线 → 通过
  const read = await storage.read(relativePath);
  const second = await storage.write({ relativePath, content: '# B\n', expectedRawRevision: read.rawRevision });
  assert.notEqual(second.rawRevision, read.rawRevision);
});

test('CAS 对字节敏感：只改一个换行也视为变更', async () => {
  const { storage, relativePath } = await setup();
  const first = await storage.write({ relativePath, content: '# A\n', expectedRawRevision: undefined });
  const read = await storage.read(relativePath);
  const second = await storage.write({ relativePath, content: '# A\n\n', expectedRawRevision: read.rawRevision });
  assert.notEqual(second.rawRevision, first.rawRevision);
  assert.equal(second.rawRevision, `sha256:${createHash('sha256').update(Buffer.from('# A\n\n')).digest('hex')}`);
});

test('journal 落盘走注入的 fs port（同一个 storage 实例重开也能读到已提交条目）', async () => {
  const { root, storage } = await setup();
  const entry = await storage.journal.begin({ spec: '_eval-codex-20260913/demo', intent: { action: 'task_begin' } });
  assert.equal((await storage.journal.commit({ id: entry.id })).status, 'committed');
  const reopened = await createSpecStorage({
    projectRoot: root,
    specsRoot: '.kiro/specs',
    privateDir: path.join(root, '.private'),
    allowedPrefixes: ['_eval-codex-20260913/'],
    fs: createNodeFsPort(fsp),
    randomUUID: () => '11111111-1111-4111-8111-111111111111'
  });
  assert.equal((await reopened.journal.get({ id: entry.id })).status, 'committed');
  assert.deepEqual((await reopened.journal.list({ spec: '_eval-codex-20260913/demo', status: 'committed' })).map((item) => item.id), [entry.id]);
});

test('randomUUID port 决定临时文件名与 journal id —— 它是可注入的，不是写死的', async () => {
  const { root } = await setup();
  const marker = '22222222-2222-4222-8222-222222222222';
  const storage = await createSpecStorage({
    projectRoot: root,
    specsRoot: '.kiro/specs',
    privateDir: path.join(root, '.private'),
    allowedPrefixes: ['_eval-codex-20260913/'],
    fs: createNodeFsPort(fsp),
    randomUUID: () => marker
  });
  const entry = await storage.journal.begin({ spec: '_eval-codex-20260913/demo', intent: {} });
  assert.equal(entry.id, marker);
  assert.equal(
    await readFile(path.join(root, '.private', `journal-${marker}.json`), 'utf8').then((text) => JSON.parse(text).id),
    marker
  );
});

test('tasks.meta.json 仍然只读（母计划非目标：不动它的字节）', async () => {
  const { specDir, storage } = await setup();
  await writeFile(path.join(specDir, 'tasks.meta.json'), '{"schemaVersion":1}\n');
  await assert.rejects(
    () => storage.write({ relativePath: '_eval-codex-20260913/demo/tasks.meta.json', content: '{}', expectedRawRevision: undefined }),
    { code: 'READ_ONLY_ARTIFACT' }
  );
});
