// 阶段门控的**存活信号**（`.kiro/specs/claude-spec-gate-liveness`）。
//
// 分两层测：
//   ① 观测模块本身 —— 注入内存 IO，所以能测「写失败」「超上限」这些真磁盘上不好造的分支；
//   ② `spec_health` 的门面 —— 证明信号确实**搭在活着的那层**上，而不是只写在某个文件里。
//
// 🔴 这一组不测判定。判定归 `stage-gate.test.mjs`，本次变更一行没碰它。

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUDIT_MAX_BYTES,
  GATE_STATUS,
  TOPOLOGY,
  UNOBSERVED_CAVEAT_COWORK,
  UNOBSERVED_CAVEAT_LOCAL,
  appendAuditLine,
  projectDirFrom,
  readHeartbeat,
  resolveHeartbeatPath,
  resolveLogPath,
  summariseGate,
  writeHeartbeat,
} from '../lib/hooks/observability.mjs';
import { createMcpService } from '../lib/mcp/service.mjs';
import { computeRawRevision } from '../lib/core/revision.mjs';

const TMP = '/tmp/for-test';

/** 内存 IO：让「写不进去」变成一个可构造的输入，而不是一句祈祷。 */
function memoryIo({ failOn = null } = {}) {
  const files = new Map();
  const guard = (op) => { if (failOn === op) throw new Error(`stub failure: ${op}`); };
  return {
    files,
    existsSync: (target) => files.has(target),
    statSync: (target) => ({ size: files.get(target).length }),
    readFileSync: (target) => files.get(target),
    mkdirSync: () => guard('mkdirSync'),
    appendFileSync: (target, text) => { guard('appendFileSync'); files.set(target, (files.get(target) ?? '') + text); },
    writeFileSync: (target, text) => { guard('writeFileSync'); files.set(target, text); },
  };
}

// ── ① 观测模块 ────────────────────────────────────────────────────────────────

test('落点：五种配置逐条对齐既有行为，默认优先项目目录', () => {
  assert.deepEqual(resolveLogPath(undefined, { projectDir: '/proj', tmpdir: TMP }), {
    path: '/proj/.claude/claude-spec-gate.log', source: 'project',
  });
  assert.deepEqual(resolveLogPath(undefined, { projectDir: undefined, tmpdir: TMP }), {
    path: path.join(TMP, 'claude-spec-gate.log'), source: 'tmpdir',
  });
  assert.deepEqual(resolveLogPath('/abs/gate.log', { projectDir: '/proj', tmpdir: TMP }), {
    path: '/abs/gate.log', source: 'explicit',
  });
  // 相对路径仍然落 tmpdir：2026-09-14 那次在插件源码目录就地生出一个叫 `off` 的文件，
  // 就是相对路径 + 不可预测的 cwd 的组合。
  assert.deepEqual(resolveLogPath('rel.log', { projectDir: '/proj', tmpdir: TMP }), {
    path: path.join(TMP, 'rel.log'), source: 'relative',
  });
  assert.deepEqual(resolveLogPath('off', { projectDir: '/proj', tmpdir: TMP }), { path: undefined, source: 'disabled' });
  assert.deepEqual(resolveLogPath('', { projectDir: '/proj', tmpdir: TMP }), { path: undefined, source: 'disabled' });
});

test('项目根：payload 的 cwd 优先于环境变量，都没有就是不猜', () => {
  assert.equal(projectDirFrom({ cwd: '/from-payload', env: { CLAUDE_PROJECT_DIR: '/from-env' } }), '/from-payload');
  assert.equal(projectDirFrom({ cwd: undefined, env: { CLAUDE_PROJECT_DIR: '/from-env' } }), '/from-env');
  assert.equal(projectDirFrom({ cwd: '', env: { CLAUDE_SPEC_PROJECT_ROOT: '/from-root' } }), '/from-root');
  assert.equal(projectDirFrom({ cwd: undefined, env: {} }), undefined);
});

test('心跳落点：项目根缺席时返回 undefined —— 心跳的意义就是被 spec_health 读到', () => {
  assert.equal(resolveHeartbeatPath({ projectDir: '/proj' }), '/proj/.claude/claude-spec-gate.heartbeat');
  assert.equal(resolveHeartbeatPath({ projectDir: undefined }), undefined);
});

test('审计行：追加、带落点来源，且「调没调」靠最早那几行', () => {
  const io = memoryIo();
  const target = '/proj/.claude/claude-spec-gate.log';
  assert.equal(appendAuditLine({ path: target, source: 'project', phase: 'entry' }, io), true);
  assert.equal(appendAuditLine({ path: target, source: 'project', phase: 'decision', decision: 'deny' }, io), true);
  const lines = io.files.get(target).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].phase, 'entry');
  assert.equal(lines[1].decision, 'deny');
  assert.equal(lines[0].logSource, 'project');
  assert.equal(lines[0].logPath, target, '每行自带落点 —— 读的人不必猜它在容器还是项目目录');
});

test('审计行：超上限**停写**而不轮转（轮转会把最能回答问题的头几行丢掉）', () => {
  const io = memoryIo();
  const target = '/proj/claude-spec-gate.log';
  io.files.set(target, 'x'.repeat(AUDIT_MAX_BYTES + 1));
  assert.equal(appendAuditLine({ path: target, source: 'project', phase: 'entry' }, io), false);
  assert.equal(io.files.get(target).length, AUDIT_MAX_BYTES + 1, '停写，不是截断');
});

test('审计行：写不进去返回 false 且**不抛**（观测器的失败不许影响被观测者）', () => {
  const io = memoryIo({ failOn: 'appendFileSync' });
  assert.equal(appendAuditLine({ path: '/proj/gate.log', source: 'project', phase: 'entry' }, io), false);
  assert.equal(appendAuditLine({ path: undefined, source: 'disabled', phase: 'entry' }, memoryIo()), false);
});

test('心跳：覆盖写而不是追加 —— 它回答的是「最近一次」', () => {
  const io = memoryIo();
  const target = '/proj/.claude/claude-spec-gate.heartbeat';
  writeHeartbeat({ path: target, decision: 'allow' }, io);
  writeHeartbeat({ path: target, decision: 'deny' }, io);
  const lines = io.files.get(target).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).decision, 'deny');
  assert.equal(writeHeartbeat({ path: target, decision: 'deny' }, memoryIo({ failOn: 'writeFileSync' })), false);
});

test('读心跳：不存在、空、半截 JSON、非对象 —— 一律 null，永不抛', () => {
  const io = memoryIo();
  assert.equal(readHeartbeat('/nope', io), null);
  assert.equal(readHeartbeat(undefined, io), null);
  io.files.set('/a', '');
  assert.equal(readHeartbeat('/a', io), null);
  io.files.set('/b', '{"ts":');
  assert.equal(readHeartbeat('/b', io), null);
  io.files.set('/c', '[1,2]');
  assert.equal(readHeartbeat('/c', io), null);
  io.files.set('/d', '{"ts":"2026-09-14T01:00:00.000Z","decision":"deny"}');
  assert.equal(readHeartbeat('/d', io).decision, 'deny');
});

test('summariseGate：三态各就各位，且只有 observed 是活证据（不引入 alive 阈值）', () => {
  const beatPath = '/proj/.claude/claude-spec-gate.heartbeat';

  // unobserved —— **中性**：可能是没被调用，也可能是两条路径不是同一个文件系统。
  const absent = summariseGate({ heartbeat: null, path: beatPath });
  assert.equal(absent.status, GATE_STATUS.UNOBSERVED);
  assert.equal(absent.lastSeen, null);
  assert.equal(absent.ageMs, null);
  assert.equal(absent.decision, null);
  assert.equal(absent.heartbeatPath, beatPath);
  assert.ok(absent.caveat.length > 0, 'unobserved 必须自带 caveat —— 只写在文档里等于没写');

  // unavailable —— 连路径都没有，与「没读到」不是一回事。
  const noPath = summariseGate({ heartbeat: null, path: undefined });
  assert.equal(noPath.status, GATE_STATUS.UNAVAILABLE);
  assert.equal(noPath.heartbeatPath, null);
  assert.equal(noPath.caveat, undefined, 'caveat 与 unobserved 同生共死');

  const now = Date.parse('2026-09-14T01:00:10.000Z');
  const seen = summariseGate({
    heartbeat: { ts: '2026-09-14T01:00:00.000Z', decision: 'deny', event: 'PreToolUse', reason: '越阶段写' },
    path: beatPath,
    now,
  });
  assert.equal(seen.status, GATE_STATUS.OBSERVED);
  assert.equal(seen.lastSeen, '2026-09-14T01:00:00.000Z');
  assert.equal(seen.ageMs, 10_000);
  assert.equal(seen.decision, 'deny');
  assert.equal(seen.caveat, undefined);

  // `ts` 解析不出来的文件答不了「最近一次是什么时候」—— 与「不存在」同构，不许报 observed。
  assert.equal(summariseGate({ heartbeat: { ts: 'nonsense' }, path: beatPath }).status, GATE_STATUS.UNOBSERVED);
  assert.equal(summariseGate({ heartbeat: { ts: 'nonsense' }, path: beatPath }).lastSeen, null);
});

test('summariseGate：不传 topology 时默认 local，三态结果都带 topology 字段', () => {
  const beatPath = '/proj/.claude/claude-spec-gate.heartbeat';
  assert.equal(summariseGate({ heartbeat: null, path: beatPath }).topology, TOPOLOGY.LOCAL, '省略 topology 时默认本地——今天才发现之前一直默认按 Cowork 心智在读这个字段');
  assert.equal(summariseGate({ heartbeat: null, path: undefined, topology: TOPOLOGY.COWORK }).topology, TOPOLOGY.COWORK, 'unavailable 态也要带着 topology，不止 unobserved');
  const now = Date.parse('2026-09-14T01:00:10.000Z');
  const observed = summariseGate({
    heartbeat: { ts: '2026-09-14T01:00:00.000Z', decision: 'deny' }, path: beatPath, topology: TOPOLOGY.COWORK, now,
  });
  assert.equal(observed.topology, TOPOLOGY.COWORK, 'observed 态也要带着 topology');
});

test('summariseGate：unobserved 的 caveat 按拓扑区分——local 不再引导去读 Cowork 的容器探针', () => {
  const beatPath = '/proj/.claude/claude-spec-gate.heartbeat';
  const local = summariseGate({ heartbeat: null, path: beatPath, topology: TOPOLOGY.LOCAL });
  const cowork = summariseGate({ heartbeat: null, path: beatPath, topology: TOPOLOGY.COWORK });
  assert.equal(local.caveat, UNOBSERVED_CAVEAT_LOCAL);
  assert.equal(cowork.caveat, UNOBSERVED_CAVEAT_COWORK);
  assert.notEqual(local.caveat, cowork.caveat);
  assert.doesNotMatch(local.caveat, /请用 INSTALL\.md/, 'local 拓扑没有容器，不该让人去读容器审计日志探针');
  assert.match(cowork.caveat, /请用 INSTALL\.md/, 'cowork 拓扑下死活判据仍然是 INSTALL.md 的容器探针');
});

test('summariseGate：非法 topology 大声拒绝，不静默回退成 local', () => {
  const beatPath = '/proj/.claude/claude-spec-gate.heartbeat';
  assert.throws(
    () => summariseGate({ heartbeat: null, path: beatPath, topology: 'desktop' }),
    /topology/,
    '拿不准处于哪种拓扑时应该停下报错，不能替调用方猜一个',
  );
});

// ── ② spec_health 门面 ───────────────────────────────────────────────────────

/** 最小可用项目：一份 adapter + 心跳目录。`spec_health` 要经 adapter 才能起来。 */
async function livenessRoot({ topology } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-liveness-'));
  await mkdir(path.join(root, '.kiro', 'specs'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await mkdir(path.join(root, '.codex'), { recursive: true });
  const authority = '# Rules\n\nUse the approved format.\n';
  await writeFile(path.join(root, '.kiro', 'steering', 'spec.md'), authority);
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro/specs',
    writePolicy: {
      mode: 'evaluation-only',
      allowedPrefixes: ['_eval-codex-20260914/'],
      authorityFile: '.kiro/steering/spec.md',
      authorityHash: computeRawRevision(authority),
    },
    rules: [],
  }));
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private'), ...(topology !== undefined ? { topology } : {}) });
  return { root, service, beatPath: path.join(root, '.claude', 'claude-spec-gate.heartbeat') };
}

test('spec_health：读不到心跳时 status 为 unobserved 且带 caveat —— 不许表达成「门死了」', async () => {
  const { root, service } = await livenessRoot();
  try {
    const health = await service.call('spec_health', {});
    assert.ok(health.gate, 'spec_health 必须回报门的存活状态 —— 那是活着的那层唯一能做的');
    assert.equal(health.gate.status, GATE_STATUS.UNOBSERVED, '没读到 ≠ 没被调用，状态必须中性');
    assert.ok(health.gate.caveat, 'unobserved 必须把「这不构成判据」写进返回值');
    assert.equal(health.gate.lastSeen, null);
    assert.equal(health.gate.ageMs, null);
    // macOS 的 mkdtemp 会给出 /var/... 而 realpath 是 /private/var/...，所以按后缀与目录名断言。
    assert.ok(health.gate.heartbeatPath.includes(path.basename(root)), '心跳路径必须在项目根之下');
    assert.match(health.gate.heartbeatPath, /\.claude\/claude-spec-gate\.heartbeat$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spec_health：心跳存在时读得出 lastSeen 与判定；坏心跳退回 null 而不报错', async () => {
  const { root, service, beatPath } = await livenessRoot();
  try {
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeFile(beatPath, `${JSON.stringify({ ts: new Date().toISOString(), decision: 'deny', event: 'PreToolUse', reason: '越阶段写' })}\n`);
    const alive = await service.call('spec_health', {});
    assert.equal(alive.gate.status, GATE_STATUS.OBSERVED, '只有读到了才算 observed');
    assert.ok(Number.isFinite(Date.parse(alive.gate.lastSeen)));
    assert.ok(alive.gate.ageMs >= 0);
    assert.equal(alive.gate.decision, 'deny');
    assert.equal(alive.gate.caveat, undefined, 'observed 不需要 caveat');

    await writeFile(beatPath, '{ 半截');
    const broken = await service.call('spec_health', {});
    assert.equal(broken.gate.status, GATE_STATUS.UNOBSERVED);
    assert.equal(broken.gate.lastSeen, null, '坏心跳与缺席同构：都答不了「最近一次」');
    assert.equal(broken.gate.decision, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spec_health：createMcpService 不传 topology 时默认本地模式', async () => {
  const { root, service } = await livenessRoot();
  try {
    const health = await service.call('spec_health', {});
    assert.equal(health.gate.topology, TOPOLOGY.LOCAL, '今天才发现之前一直默认按 Cowork 心智在读这个字段——default 必须是 local');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spec_health：createMcpService 显式传 topology=cowork 时如实反映在 gate.topology 上', async () => {
  const { root, service } = await livenessRoot({ topology: TOPOLOGY.COWORK });
  try {
    const health = await service.call('spec_health', {});
    assert.equal(health.gate.topology, TOPOLOGY.COWORK);
    assert.match(health.gate.caveat, /INSTALL\.md/, 'cowork 模式下 unobserved 的 caveat 要指回容器探针');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('createMcpService：非法 topology 直接拒绝创建，不吞掉也不静默兜底成 local', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-liveness-'));
  try {
    await assert.rejects(
      () => createMcpService({ projectRoot: root, privateDir: path.join(root, '.private'), topology: 'desktop' }),
      /topology/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
