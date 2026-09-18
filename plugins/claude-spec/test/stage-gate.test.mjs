// 06-claude-spec Task 4（**写**那半边）—— 阶段门控的失败模式。
//
// 🔴 这一份**不能**替代 Task 4 的「验」：真机验证只有在 Cowork 里触发一次真实的
// `PreToolUse` 才算数，容器复现 ≠ 真机实测（母计划设计原则⑤）。下面这些跑在 node 里，
// 证明的是「判定与接线是对的」，不是「Cowork 会调用它」。
//
// 三条实测约束各自的对应断言：
//   ① 子代理越阶段写同样被拒 —— payload 带 `agent_id` / `agent_type` 时判定不变。
//   ② 判定只依赖注入的 `exists`（容器文件系统），不做本机假设 —— 见纯函数那几条。
//   ③ 真拒绝（exit 2）与探针的「永远 exit 0」是两回事；同时 continuation 敏感事件恒 0。

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONTINUATION_SENSITIVE_EVENTS,
  GATED_TOOLS,
  STAGE_PREDECESSORS,
  decideStageGate,
  denialResponse,
  exitCodeFor,
  normaliseTarget,
  parseSpecTarget,
  targetPathOf,
} from '../lib/hooks/stage-gate.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '..');
const GATE = path.join(pluginRoot, 'scripts', 'spec-stage-gate.mjs');
const WRAPPER = path.join(pluginRoot, 'scripts', 'spec-stage-gate.sh');
const PROJECT = '/repo';
const FEATURE_DIR = `${PROJECT}/.kiro/specs/demo`;

/** 注入一个「这些文件存在」的容器文件系统。 */
const existsIn = (...present) => (absolutePath) => present.includes(absolutePath);

function decide(overrides = {}) {
  return decideStageGate({
    toolName: 'Write',
    toolInput: { file_path: `${FEATURE_DIR}/requirements.md`, content: 'x' },
    projectDir: PROJECT,
    exists: existsIn(),
    ...overrides,
  });
}

// ── 纯函数：判定 ──────────────────────────────────────────────────────────────

test('阶段表本身就是那份约定，逐条钉住', () => {
  assert.deepEqual(Object.keys(STAGE_PREDECESSORS).sort(), ['bugfix.md', 'design.md', 'requirements.md', 'tasks.md']);
  assert.deepEqual(STAGE_PREDECESSORS['requirements.md'], []);
  assert.deepEqual(STAGE_PREDECESSORS['bugfix.md'], []);
  assert.deepEqual(STAGE_PREDECESSORS['design.md'], ['requirements.md', 'bugfix.md']);
  assert.deepEqual(STAGE_PREDECESSORS['tasks.md'], ['design.md']);
});

test('第一阶段（requirements.md / bugfix.md）无条件放行', () => {
  for (const artifact of ['requirements.md', 'bugfix.md']) {
    const result = decide({ toolInput: { file_path: `${FEATURE_DIR}/${artifact}` } });
    assert.equal(result.decision, 'allow', `${artifact} 是第一阶段，不该被拦`);
  }
});

test('越阶段写 ①：只有 requirements 时写 tasks.md → 拒绝，且理由点名缺的是 design.md', () => {
  const result = decide({
    toolInput: { file_path: `${FEATURE_DIR}/tasks.md` },
    exists: existsIn(`${FEATURE_DIR}/requirements.md`),
  });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /design\.md/, '拒绝理由必须说清缺的是哪一个，否则没法照着修');
  assert.equal(result.artifact, 'tasks.md');
  assert.equal(result.feature, 'demo');
});

test('越阶段写 ②：空目录写 design.md → 拒绝，理由是 requirements / bugfix 都不在', () => {
  const result = decide({ toolInput: { file_path: `${FEATURE_DIR}/design.md` } });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /requirements\.md 或 bugfix\.md/);
});

test('deny 的判定带得走：target / feature / artifact 都在结果里', () => {
  const result = decide({ toolInput: { file_path: `${FEATURE_DIR}/tasks.md` } });
  assert.equal(result.target, `${FEATURE_DIR}/tasks.md`);
  assert.equal(result.feature, 'demo');
  assert.equal(result.artifact, 'tasks.md');
});

test('🔴 实测约束 ①：子代理的 payload（带 agent_id / agent_type）判定与父会话完全一致', () => {
  // 门控**不看** agent_id —— 任何「只在父会话生效」的写法都会留下一个洞，
  // 而探针实测子代理内部的 Write/Edit 各自独立触发同一个 PreToolUse。
  const parent = { toolName: 'Write', toolInput: { file_path: `${FEATURE_DIR}/tasks.md` }, projectDir: PROJECT, exists: existsIn() };
  const child = { ...parent, agentId: 'agent_abc', agentType: 'general-purpose' };
  assert.deepEqual(decideStageGate(child).decision, decideStageGate(parent).decision);
  assert.equal(decideStageGate(child).decision, 'deny', '子代理越阶段写必须同样被拒');
});

test('design.md 在 bugfix 工作流里是合法的下一步（只认 requirements 会误拦）', () => {
  const result = decide({
    toolInput: { file_path: `${FEATURE_DIR}/design.md` },
    exists: existsIn(`${FEATURE_DIR}/bugfix.md`),
  });
  assert.equal(result.decision, 'allow');
});

test('写 .kiro/specs/** 之外 → 放行不打扰（实测约束里的第三条失败模式）', () => {
  for (const target of [`${PROJECT}/src/index.mjs`, `${PROJECT}/README.md`, `${PROJECT}/.kiro/steering/spec.md`, '/etc/hosts']) {
    const result = decide({ toolInput: { file_path: target } });
    assert.equal(result.decision, 'allow', `${target} 不该被门控打扰`);
  }
});

test('specs 目录下的非 artifact 文件放行：tasks.meta.json / _archive / 未知名字', () => {
  for (const target of [
    `${PROJECT}/.kiro/specs/demo/tasks.meta.json`,
    `${PROJECT}/.kiro/specs/_archive/demo/tasks.md`,
    `${PROJECT}/.kiro/specs/demo/notes.md`,
    `${PROJECT}/.kiro/specs/tasks.md`,
  ]) {
    const result = decide({ toolInput: { file_path: target } });
    if (target.endsWith('_archive/demo/tasks.md')) {
      // `_archive/demo` 是 feature，缺 design.md → 仍然拒。这不是「放行」那一类，
      // 列在这里是为了记录：归档目录里的 feature 同样受阶段约束，别以为 `_archive` 是免检区。
      assert.equal(result.decision, 'deny');
      continue;
    }
    assert.equal(result.decision, 'allow', `${target} 不该被门控`);
  }
});

test('不认得的工具一律放行（Read / Bash / Glob …），MultiEdit 则在门控内', () => {
  for (const toolName of ['Read', 'Bash', 'Glob', 'Grep', undefined]) {
    assert.equal(decide({ toolName, toolInput: { file_path: `${FEATURE_DIR}/tasks.md` } }).decision, 'allow');
  }
  assert.deepEqual([...GATED_TOOLS].sort(), ['Edit', 'MultiEdit', 'Write']);
  assert.equal(decide({ toolName: 'Edit', toolInput: { file_path: `${FEATURE_DIR}/tasks.md` } }).decision, 'deny');
  assert.equal(decide({ toolName: 'MultiEdit', toolInput: { file_path: `${FEATURE_DIR}/tasks.md` } }).decision, 'deny');
});

test('取不到目标路径时放行 —— 没见过的 payload 形状不该把正常写入堵死', () => {
  for (const toolInput of [undefined, null, {}, { file_path: '' }, { file_path: 42 }, { command: 'ls' }]) {
    const result = decide({ toolInput });
    assert.equal(result.decision, 'allow');
    assert.match(result.reason, /没有可判定的目标路径/);
  }
  assert.equal(targetPathOf({ path: '/a/b' }), '/a/b');
  assert.equal(targetPathOf({ file_path: '/a/b', path: '/c/d' }), '/a/b');
});

test('相对路径按 projectDir 归一；projectDir 缺席时不猜绝对路径', () => {
  assert.equal(normaliseTarget('.kiro/specs/demo/tasks.md', PROJECT), `${FEATURE_DIR}/tasks.md`);
  assert.equal(normaliseTarget(`${FEATURE_DIR}/tasks.md`, undefined), `${FEATURE_DIR}/tasks.md`);
  assert.equal(normaliseTarget('a/../b.md', undefined), 'b.md');
  // projectDir 缺席 + 相对路径：靠后缀照样判得出，不编一个假的绝对路径。
  const result = decideStageGate({ toolName: 'Write', toolInput: { file_path: '.kiro/specs/demo/tasks.md' }, exists: existsIn() });
  assert.equal(result.decision, 'deny');
  assert.equal(result.target, '.kiro/specs/demo/tasks.md');
});

test('parseSpecTarget 只认「feature 目录下」的路径', () => {
  assert.deepEqual(parseSpecTarget(`${FEATURE_DIR}/tasks.md`), { feature: 'demo', artifact: 'tasks.md', dir: FEATURE_DIR });
  assert.equal(parseSpecTarget(`${PROJECT}/.kiro/specs/tasks.md`), null);
  assert.equal(parseSpecTarget(`${PROJECT}/src/tasks.md`), null);
  assert.equal(parseSpecTarget('/etc/hosts'), null);
});

test('嵌套 feature 目录照样成立', () => {
  const nested = `${PROJECT}/.kiro/specs/group/demo`;
  const result = decide({ toolInput: { file_path: `${nested}/tasks.md` }, exists: existsIn(`${nested}/requirements.md`) });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /design\.md/);
  assert.equal(decide({ toolInput: { file_path: `${nested}/design.md` }, exists: existsIn(`${nested}/requirements.md`) }).decision, 'allow');
});

test('缺 exists 注入即抛 —— 静默取一个默认文件系统是本仓库反复要消灭的形态', () => {
  assert.throws(() => decideStageGate({ toolName: 'Write', toolInput: { file_path: `${FEATURE_DIR}/tasks.md` } }), /exists/);
});

// ── 退出码与响应体 ────────────────────────────────────────────────────────────

test('🔴 实测约束 ③：真拒绝走 exit 2；continuation 敏感事件恒为 0', () => {
  assert.equal(exitCodeFor('PreToolUse', 'deny'), 2);
  assert.equal(exitCodeFor('PreToolUse', 'allow'), 0);
  for (const eventName of CONTINUATION_SENSITIVE_EVENTS) {
    assert.equal(exitCodeFor(eventName, 'deny'), 0, `${eventName} 带 continuation 语义，不许返回非零`);
  }
  assert.deepEqual(denialResponse({ reason: 'r' }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' },
  });
});

// ── 进程级：hooks.json 真正调的那条链路 ───────────────────────────────────────

function runGate({ payload, env = {}, executable = GATE }) {
  return new Promise((resolve, reject) => {
    // 🔴 显式给 cwd：2026-09-14 实测，不给 cwd 时进程继承 `node --test` 的 cwd
    // （= 插件源码目录），于是一个**相对**的 `CLAUDE_SPEC_GATE_LOG` 会就地生根 ——
    // 本仓库真的因此在 `plugins/claude-spec/` 下留了一个名叫 `off` 的日志文件，
    // 而且它一度被当成「现场痕迹」去排查。测试不许污染源码树。
    const child = spawn(process.execPath, [executable], { cwd: os.tmpdir(), env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'claude-spec-gate-'));
}

/**
 * 审计日志是**多行** JSON Lines（`.kiro/specs/claude-spec-gate-liveness`）：
 * 第一行是 entry —— 它唯一的职责是证明「这个进程被宿主拉起过」，
 * 也是全流程里唯一不依赖任何解析成功的证据；最后一行是判定。
 */
async function auditLines(file) {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test('进程级：越阶段写被真拒绝（exit 2 + stdout 决策 JSON + stderr 理由）', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    const result = await runGate({ payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md'), content: 'x' } } });
    assert.equal(result.code, 2, `期望 exit 2，实际 ${result.code}；stderr=${result.stderr}`);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(result.stderr, /越阶段写/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：specs 之外的写入静默放行（exit 0，两个流都不出声）', async () => {
  const dir = await tempDir();
  try {
    const result = await runGate({ payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'index.mjs') } } });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：前一阶段已存在时放行', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    await writeFile(path.join(dir, 'placeholder'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(feature, { recursive: true });
    await writeFile(path.join(feature, 'design.md'), '# Design Document\n');
    const result = await runGate({ payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md') } } });
    assert.equal(result.code, 0, result.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级 fail-open：畸形 payload 放行但**必须出声**', async () => {
  const result = await runGate({ payload: '{not json' });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /不是合法 JSON/);
  assert.match(result.stderr, /fail-open/);
});

test('进程级 fail-open：空 payload 同样放行且出声', async () => {
  const result = await runGate({ payload: '' });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /不是合法 JSON/);
});

test('进程级：CLAUDE_SPEC_GATE_LOG 打开时留得下审计行（STOP 门 ② 要的证据）', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    const log = path.join(dir, 'gate.log');
    await runGate({ env: { CLAUDE_SPEC_GATE_LOG: log }, payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md') } } });
    const lines = await auditLines(log);
    assert.equal(lines[0].phase, 'entry', '第一行必须是 entry —— 「宿主调没调」唯一不依赖解析的证据');
    const line = lines.at(-1);
    assert.equal(line.decision, 'deny');
    assert.equal(line.tool, 'Write');
    assert.equal(line.hasAgentId, false);
    assert.equal(line.target, path.join(feature, 'tasks.md'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// 🔴 2026-09-14：审计日志改为**默认开**。由来见 scripts/spec-stage-gate.mjs 的头部注释 ——
// 一次真实事故里，判断「宿主到底调没调这个脚本」只有这份日志能回答，而它当时是 opt-in，
// 要打开就得改宿主启动 hook 时的环境变量，那个位置没有任何一方够得到，排查彻底卡死。
// **一个只有在你已经能观测时才打得开的观测器，等于没有。** 这三条钉住新默认。
test('进程级：不设环境变量时审计日志**默认开**，落在 tmpdir', async () => {
  const dir = await tempDir();
  const fallback = path.join(os.tmpdir(), 'claude-spec-gate.log');
  // 先删掉。这份日志有 1 MiB 上限、超了**停写**（回答「调没调」靠最早那几行），
  // 反复跑测试会把上限顶到 —— 「比较前后长度」于是会长成一条会自己烂掉的断言。
  await rm(fallback, { force: true });
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    await runGate({ payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md') } } });
    const lines = await auditLines(fallback);
    assert.equal(lines[0].phase, 'entry', '默认路径下第一行应当是 entry');
    assert.equal(lines[0].logSource, 'tmpdir', '没有项目根线索时退回 tmpdir');
    const line = lines.at(-1);
    assert.equal(line.decision, 'deny');
    assert.equal(line.target, path.join(feature, 'tasks.md'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：放行也要记 —— 否则「没被调用」与「调用了但放行」分不开', async () => {
  const dir = await tempDir();
  try {
    const log = path.join(dir, 'gate.log');
    await runGate({ env: { CLAUDE_SPEC_GATE_LOG: log }, payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'outside.md') } } });
    const lines = await auditLines(log);
    assert.equal(lines[0].phase, 'entry');
    const line = lines.at(-1);
    assert.equal(line.decision, 'allow');
    assert.match(line.reason, /不在 \.kiro\/specs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// 🔴 相对路径不许落在 cwd。由来：hook 的 cwd 由宿主决定、不可预测，
// 一个相对的日志路径会落在谁也想不到的地方（本仓库就被留过一个叫 `off` 的文件）。
test('进程级：相对的 CLAUDE_SPEC_GATE_LOG 落在 tmpdir，不落在 cwd', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    await runGate({ env: { CLAUDE_SPEC_GATE_LOG: 'relative-probe.log' }, payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md') } } });
    assert.equal(existsSync(path.join(pluginRoot, 'relative-probe.log')), false, '不许落在插件源码目录');
    const resolved = path.join(os.tmpdir(), 'relative-probe.log');
    assert.ok(existsSync(resolved), '应当落在 tmpdir');
    await rm(resolved, { force: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：CLAUDE_SPEC_GATE_LOG=off 关得掉（留一个逃生口）', async () => {
  const dir = await tempDir();
  const fallback = path.join(os.tmpdir(), 'claude-spec-gate.log');
  const before = existsSync(fallback) ? (await readFile(fallback, 'utf8')).length : 0;
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    await runGate({ env: { CLAUDE_SPEC_GATE_LOG: 'off' }, payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md') } } });
    const after = existsSync(fallback) ? (await readFile(fallback, 'utf8')).length : 0;
    assert.equal(after, before, 'off 时不该往默认路径写');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：审计行记下子代理身份（hasAgentId=true），判定不变', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    const log = path.join(dir, 'gate.log');
    const result = await runGate({
      env: { CLAUDE_SPEC_GATE_LOG: log },
      payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Edit', agent_id: 'agent_1', agent_type: 'general-purpose', tool_input: { file_path: path.join(feature, 'tasks.md') } }
    });
    assert.equal(result.code, 2);
    const line = (await auditLines(log)).at(-1);
    assert.equal(line.hasAgentId, true);
    assert.equal(line.agentType, 'general-purpose');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：continuation 敏感事件即使判定为拒绝也不返回非零', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    const result = await runGate({ payload: { hook_event_name: 'SubagentStop', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md') } } });
    assert.equal(result.code, 0, 'SubagentStop 不许返回非零');
    assert.match(result.stderr, /continuation/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sh 包装层：node 在时行为与直调一致', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [WRAPPER], {});
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'tasks.md') } }));
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sh 包装层：找不到 node 时 fail-open 并出声（容器 node 版本是未测槽位）', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [WRAPPER], { env: { ...process.env, PATH: '' } });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end('{}');
  });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /找不到 node/);
  assert.match(result.stderr, /fail-open/);
});

// ── 存活信号：entry 行与心跳（`.kiro/specs/claude-spec-gate-liveness`）──────────
//
// 🔴 这一组钉住的是「门**有没有被调用**」这件事的可证伪性。
// 2026-09-13/14 那次停摆里，能回答它的唯一证据是 opt-in 的审计日志，从未被打开过 ——
// 于是「宿主没调用」与「调用了但走了静默放行分支」在证据上完全一样，排查彻底卡死。

test('进程级：非法 JSON 的 payload **也**留下 entry 行（宿主调没调，这里答）', async () => {
  const dir = await tempDir();
  try {
    const log = path.join(dir, 'gate.log');
    await runGate({ env: { CLAUDE_SPEC_GATE_LOG: log }, payload: '{not json' });
    const lines = await auditLines(log);
    assert.equal(lines[0].phase, 'entry', 'entry 行必须先于任何解析落下');
    assert.equal(lines[0].logSource, 'explicit');
    assert.equal(lines.at(-1).event, 'error', '畸形 payload 走 fail-open 分支，但**已经**留痕');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：空 payload 同样先落 entry 行', async () => {
  const dir = await tempDir();
  try {
    const log = path.join(dir, 'gate.log');
    await runGate({ env: { CLAUDE_SPEC_GATE_LOG: log }, payload: '' });
    assert.equal((await auditLines(log))[0].phase, 'entry');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：心跳落在项目根的 .claude/ 下，内容等于最后一次判定', async () => {
  const dir = await tempDir();
  try {
    const feature = path.join(dir, '.kiro', 'specs', 'demo');
    const result = await runGate({ payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(feature, 'design.md') } } });
    assert.equal(result.code, 2, result.stderr);
    const beat = JSON.parse(await readFile(path.join(dir, '.claude', 'claude-spec-gate.heartbeat'), 'utf8'));
    assert.equal(beat.decision, 'deny');
    assert.equal(beat.tool, 'Write');
    assert.equal(beat.target, path.join(feature, 'design.md'));
    assert.ok(Number.isFinite(Date.parse(beat.ts)), 'ts 必须是可解析的时刻 —— spec_health 要拿它算 ageMs');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('进程级：放行也写心跳（否则「没被调用」与「调用了但放行」在心跳上分不开）', async () => {
  const dir = await tempDir();
  try {
    await runGate({ payload: { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'index.mjs') } } });
    const beat = JSON.parse(await readFile(path.join(dir, '.claude', 'claude-spec-gate.heartbeat'), 'utf8'));
    assert.equal(beat.decision, 'allow');
    assert.match(beat.reason, /不在 \.kiro\/specs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── hooks.json 本身的形状 ─────────────────────────────────────────────────────

test('hooks.json 只挂 PreToolUse，matcher 覆盖 Write|Edit，且命令指向本仓库的脚本', async () => {
  const hooks = JSON.parse(await readFile(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['PreToolUse'], '只挂需要的事件，不要照抄探针那 33 个');
  const [entry] = hooks.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Write|Edit|MultiEdit');
  assert.match(entry.matcher, /Write\|Edit/, '计划要求覆盖的两个必须在 matcher 里');
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].type, 'command');
  // 探针实测过的形状：`${CLAUDE_PLUGIN_ROOT}` 确实被展开（record.sh 日志里有 pluginRoot 值）。
  assert.equal(entry.hooks[0].command, '${CLAUDE_PLUGIN_ROOT}/scripts/spec-stage-gate.sh');
  assert.ok(Number.isInteger(entry.hooks[0].timeout));
});
