import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSpecStorage } from '../lib/core/storage.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-storage-'));
  const privateDir = path.join(root, '.plugin-data');
  const specsRoot = path.join(root, '.kiro', 'specs');
  const specDir = path.join(specsRoot, '_eval-codex-20260827', 'demo');
  await mkdir(specDir, { recursive: true });
  await writeFile(path.join(specDir, 'requirements.md'), '# Requirements\n');
  return { root, privateDir, specDir, storage: await createSpecStorage({ projectRoot: root, specsRoot: '.kiro/specs', privateDir, allowedPrefixes: ['_eval-codex-20260827/'] }) };
}

test('storage 以 realpath/writePolicy 限制 artifact，并拒绝 tasks.meta.json 写入', async () => {
  const { root, storage } = await setup();
  await assert.rejects(() => storage.read('../outside.md'), { code: 'PATH_OUTSIDE_PROJECT' });
  await assert.rejects(() => storage.write({ relativePath: 'demo/requirements.md', content: 'x', expectedRawRevision: 'sha256:0' }), { code: 'WRITE_POLICY_DENIED' });
  await mkdir(path.join(root, 'elsewhere'));
  await symlink(path.join(root, 'elsewhere'), path.join(root, '.kiro', 'specs', '_eval-codex-20260827', 'escape'));
  await assert.rejects(() => storage.read('_eval-codex-20260827/escape/file.md'), { code: 'SYMLINK_ESCAPE' });
  await writeFile(path.join(root, 'outside.md'), 'outside\n');
  await symlink(path.join(root, 'outside.md'), path.join(root, '.kiro', 'specs', '_eval-codex-20260827', 'demo', 'design.md'));
  await assert.rejects(() => storage.read('_eval-codex-20260827/demo/design.md'), { code: 'SYMLINK_ESCAPE' });
  await assert.rejects(() => storage.write({ relativePath: '_eval-codex-20260827/demo/tasks.meta.json', content: '{}', expectedRawRevision: undefined }), { code: 'READ_ONLY_ARTIFACT' });
});

test('storage 使用 rawRevision CAS 和同目录原子替换', async () => {
  const { specDir, storage } = await setup();
  const before = await storage.read('_eval-codex-20260827/demo/requirements.md');
  await assert.rejects(() => storage.write({ relativePath: '_eval-codex-20260827/demo/requirements.md', content: '# Changed\n', expectedRawRevision: 'sha256:stale' }), { code: 'REVISION_CONFLICT' });
  const written = await storage.write({ relativePath: '_eval-codex-20260827/demo/requirements.md', content: '# Changed\n', expectedRawRevision: before.rawRevision });
  assert.notEqual(written.rawRevision, before.rawRevision);
  assert.equal(await readFile(path.join(specDir, 'requirements.md'), 'utf8'), '# Changed\n');
});

test('adopt/freeze/archive 和 intent journal 保持 lifecycle 边界', async () => {
  const { privateDir, storage } = await setup();
  const adopted = await storage.adopt({ spec: '_eval-codex-20260827/demo', workflow: 'requirements-first' });
  assert.equal(adopted.status, 'imported');
  await storage.freeze({ spec: '_eval-codex-20260827/demo' });
  await assert.rejects(() => storage.write({ relativePath: '_eval-codex-20260827/demo/requirements.md', content: '# Later\n', expectedRawRevision: adopted.artifacts.requirements.rawRevision }), { code: 'SPEC_FROZEN' });
  const preview = await storage.archivePreview({ spec: '_eval-codex-20260827/demo' });
  assert.match(preview.destination, /_archive/);
  const journal = await storage.journal.begin({ spec: '_eval-codex-20260827/demo', intent: 'archive' });
  assert.equal((await storage.journal.commit({ id: journal.id })).status, 'committed');
  const reloaded = await createSpecStorage({ projectRoot: path.dirname(privateDir), specsRoot: '.kiro/specs', privateDir, allowedPrefixes: ['_eval-codex-20260827/'] });
  assert.equal((await reloaded.journal.get({ id: journal.id })).status, 'committed');
});

test('archive apply 只接受匹配 preview 并受控移动到 archive', async () => {
  const { root, storage } = await setup();
  const preview = await storage.archivePreview({ spec: '_eval-codex-20260827/demo' });
  await assert.rejects(() => storage.archiveApply({ preview: { ...preview, snapshotRevision: 'sha256:stale' } }), { code: 'REVISION_CONFLICT' });
  const result = await storage.archiveApply({ preview });
  assert.equal(result.archived, true);
  assert.equal((await storage.read('_archive/demo/requirements.md')).content, '# Requirements\n');
  await assert.rejects(() => storage.read('_eval-codex-20260827/demo/requirements.md'), /ENOENT/);
});
