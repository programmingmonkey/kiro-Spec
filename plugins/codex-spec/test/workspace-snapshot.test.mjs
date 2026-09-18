import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalWorkspaceSnapshot } from '../lib/core/workspace-snapshot.mjs';

const base = {
  head: 'abc123',
  index: 'def456',
  trackedDirty: ['src/a.js'],
  untracked: ['tmp/out.txt'],
  submodules: [{ path: 'vendor/lib', head: '111', dirty: false }],
  lfs: { policy: 'tracked-only', pointers: ['assets/a.bin'] },
  modes: [{ path: 'script.sh', mode: '100755' }]
};

test('canonical workspace snapshot 明确记录 HEAD/index/dirty/untracked/submodule/LFS/权限/换行策略', () => {
  const snapshot = canonicalWorkspaceSnapshot({ ...base, platform: 'darwin', eol: 'lf', untrackedPolicy: 'include' });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.head, 'abc123');
  assert.deepEqual(snapshot.trackedDirty, ['src/a.js']);
  assert.deepEqual(snapshot.untracked, ['tmp/out.txt']);
  assert.equal(snapshot.eol, 'lf');
  assert.match(snapshot.revision, /^sha256:/);
});

test('macOS/Linux fixture 在相同 canonical 输入下产生相同 snapshot revision', () => {
  const mac = canonicalWorkspaceSnapshot({ ...base, platform: 'darwin', eol: 'lf', untrackedPolicy: 'include' });
  const linux = canonicalWorkspaceSnapshot({ ...base, platform: 'linux', eol: 'lf', untrackedPolicy: 'include' });
  assert.equal(mac.revision, linux.revision);
  assert.equal(mac.platformPolicy, 'portable');
  assert.equal(linux.platformPolicy, 'portable');
});

test('untracked policy 与权限或换行变化会改变 snapshot revision', () => {
  const first = canonicalWorkspaceSnapshot({ ...base, platform: 'linux', eol: 'lf', untrackedPolicy: 'include' });
  assert.notEqual(first.revision, canonicalWorkspaceSnapshot({ ...base, platform: 'linux', eol: 'lf', untrackedPolicy: 'exclude' }).revision);
  assert.notEqual(first.revision, canonicalWorkspaceSnapshot({ ...base, platform: 'linux', eol: 'crlf', untrackedPolicy: 'include' }).revision);
  assert.notEqual(first.revision, canonicalWorkspaceSnapshot({ ...base, modes: [{ path: 'script.sh', mode: '100644' }], platform: 'linux', eol: 'lf', untrackedPolicy: 'include' }).revision);
});

test('已脏文件的内容摘要变化必须改变 snapshot revision', () => {
  const first = canonicalWorkspaceSnapshot({ ...base, trackedDirty: [{ path: 'src/a.js', content: 'sha256:before' }], platform: 'linux', eol: 'lf', untrackedPolicy: 'include' });
  const second = canonicalWorkspaceSnapshot({ ...base, trackedDirty: [{ path: 'src/a.js', content: 'sha256:after' }], platform: 'linux', eol: 'lf', untrackedPolicy: 'include' });
  assert.notEqual(first.revision, second.revision);
});
