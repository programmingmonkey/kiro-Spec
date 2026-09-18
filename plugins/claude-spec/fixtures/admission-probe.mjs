#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createMcpService } from '../lib/mcp/service.mjs';

const REQUIREMENTS = '# Requirements\n\n## Requirements\n\n### Requirement 1\n\nThe evaluation SHALL preserve its artifact round trip.\n';
const DESIGN = '# Design\n\n## Requirements Trace\n\n- Requirement 1: round-trip storage\n';
const TASKS = '# Implementation Plan\n\n## Tasks\n\n- [ ] 1. Preserve round trip\n  _Requirements:_ 1\n\n## Task Dependency Graph\n\n```json\n{"waves":[{"id":0,"tasks":["1"]}]}\n```\n';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--project-root', '--adapter', '--spec', '--output'].includes(key) || !value || values[key]) throw new Error('usage: probe.mjs --project-root <path> --adapter <path> --spec <path> --output <path>');
    values[key] = value;
  }
  if (Object.keys(values).length !== 4) throw new Error('usage: probe.mjs --project-root <path> --adapter <path> --spec <path> --output <path>');
  return values;
}

function mustSucceed(result, action) {
  if (result?.code) throw Object.assign(new Error(`${action}: ${result.message}`), { code: result.code, details: result.details });
  return result;
}

function runValidator({ projectRoot, tasksPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['scripts/spec-tasks-lint.py', '--strict', tasksPath], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function writeArtifact(service, { spec, artifact, content }) {
  const context = mustSucceed(await service.call('spec_context', { spec, artifact }), `load ${artifact} context`);
  return mustSucceed(await service.call('spec_write', { spec, artifact, content, expectedRawRevision: undefined, contextProof: context.contextProof }), `write ${artifact}`);
}

export async function runProbe({ projectRoot, adapter, spec, output }) {
  const root = path.resolve(projectRoot);
  const service = await createMcpService({ projectRoot: root, adapterPath: adapter, privateDir: path.join(root, '.kiro-spec-private') });
  const formal = await service.call('spec_init', { spec: 'formal-admission', workflow: 'quick' });
  const outside = await service.call('spec_init', { spec: '_non-evaluation/admission', workflow: 'quick' });
  mustSucceed(await service.call('spec_init', { spec, workflow: 'quick' }), 'initialize evaluation spec');
  await writeArtifact(service, { spec, artifact: 'requirements', content: REQUIREMENTS });
  await writeArtifact(service, { spec, artifact: 'design', content: DESIGN });
  await writeArtifact(service, { spec, artifact: 'tasks', content: TASKS });
  const reread = mustSucceed(await service.call('spec_read', { spec, artifact: 'tasks' }), 'read tasks');
  const tasksPath = `${service.adapter.value.specsRoot}/${spec}/tasks.md`;
  const validator = await runValidator({ projectRoot: root, tasksPath });
  const report = {
    schemaVersion: 1,
    adapterRevision: service.adapter.rawRevision,
    writeMode: service.adapter.value.writePolicy.mode,
    spec,
    negativeWrites: {
      formalSpecDenied: formal.code === 'WRITE_POLICY_DENIED',
      outsideSpecsDenied: outside.code === 'WRITE_POLICY_DENIED'
    },
    roundTrip: { tasksByteStable: Buffer.from(reread.content, 'utf8').equals(Buffer.from(TASKS, 'utf8')) },
    validator
  };
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    await runProbe({ projectRoot: args['--project-root'], adapter: args['--adapter'], spec: args['--spec'], output: args['--output'] });
  } catch (caught) {
    process.stderr.write(`${caught.code ?? 'PROBE_FAILED'}: ${caught.message}\n`);
    process.exitCode = 1;
  }
}
