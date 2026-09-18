import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRawRevision } from '../lib/core/revision.mjs';

const probe = new URL('../fixtures/admission-probe.mjs', import.meta.url);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-consumer-probe-'));
  const authority = '# Spec conventions\n';
  await Promise.all([
    mkdir(path.join(root, '.codex'), { recursive: true }),
    mkdir(path.join(root, '.kiro', 'specs'), { recursive: true }),
    mkdir(path.join(root, '.kiro', 'steering'), { recursive: true }),
    mkdir(path.join(root, '.kiro', 'settings', 'templates', 'specs'), { recursive: true }),
    mkdir(path.join(root, 'scripts'), { recursive: true })
  ]);
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), authority);
  await Promise.all(['requirements.md', 'design.md', 'tasks.md'].map((name) => writeFile(path.join(root, '.kiro', 'settings', 'templates', 'specs', name), `# ${name}\n`)));
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: {
      mode: 'evaluation-only',
      allowedPrefixes: ['_eval-codex-20260827/'],
      authorityFile: '.kiro/steering/spec-conventions.md',
      authorityHash: computeRawRevision(authority)
    },
    rules: [{
      match: ['.kiro/specs/**/*.md'],
      contextFiles: [
        '.kiro/steering/spec-conventions.md',
        '.kiro/settings/templates/specs/requirements.md',
        '.kiro/settings/templates/specs/design.md',
        '.kiro/settings/templates/specs/tasks.md'
      ]
    }],
    validators: [{ id: 'spec-tasks-lint', profile: 'kiro-spec/spec-tasks-lint-v1' }]
  }));
  await writeFile(path.join(root, 'scripts', 'spec-tasks-lint.py'), 'import sys\nraise SystemExit(0)\n');
  return root;
}

test('the consumer repo admission probe performs an isolated evaluation-only round trip', async () => {
  const root = await setup();
  const output = path.join(root, 'probe-result.json');
  const result = await run(process.execPath, [probe.pathname, '--project-root', root, '--adapter', '.codex/codex-spec.json', '--spec', '_eval-codex-20260827', '--output', output]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(Object.keys(report).sort(), [
    'adapterRevision', 'negativeWrites', 'roundTrip', 'schemaVersion',
    'spec', 'validator', 'writeMode'
  ]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.writeMode, 'evaluation-only');
  assert.equal(report.spec, '_eval-codex-20260827');
  assert.equal(report.negativeWrites.formalSpecDenied, true);
  assert.equal(report.negativeWrites.outsideSpecsDenied, true);
  assert.equal(report.validator.exitCode, 0);
  assert.equal(report.roundTrip.tasksByteStable, true);
  assert.deepEqual((await readdir(path.join(root, '.kiro', 'specs', '_eval-codex-20260827'))).sort(), ['design.md', 'requirements.md', 'tasks.md']);
});
