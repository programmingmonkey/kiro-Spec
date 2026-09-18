import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const pluginRoot = path.resolve(import.meta.dirname, '..');
const readJson = async (rel) => JSON.parse(await readFile(path.join(pluginRoot, rel), 'utf8'));

async function startServer() {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line) messages.push(JSON.parse(line));
  });
  await once(child, 'spawn');
  return {
    async request(id, method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = messages.find((message) => message.id === id);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${method}`);
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

test('plugin manifest wires the Skill, the local stdio MCP, and the PreToolUse stage gate', async () => {
  const manifest = await readJson('.claude-plugin/plugin.json');
  const mcp = await readJson('.mcp.json');
  const skill = await readFile(path.join(pluginRoot, 'skills', 'claude-spec', 'SKILL.md'), 'utf8');

  assert.equal(manifest.name, 'claude-spec');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  // 与 codex-spec 的关键分歧：这次 `hooks` 字段**必须存在**（第 6 期 Task 4 新增）。
  // codex-spec 的骨架测试显式断言 `manifest.hooks === undefined`，那条断言的否定式就是这一条。
  assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.doesNotMatch(manifest.description, /skeleton/i);
  // Task 7 安装验证实测：插件被打包成独立 .plugin 安装后，`cwd: '.'` 解析的是 Cowork
  // 启动 MCP 子进程时的进程 cwd，不保证等于插件目录——必须用 ${CLAUDE_PLUGIN_ROOT}，
  // 不能像 codex-spec 那样假设 `.` 就是插件根（母计划 Task 2 Step 6 的 ⟨待测⟩，2026-09-13 实测填坑）。
  assert.deepEqual(mcp.mcpServers['claude-spec'], {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server.mjs'],
    cwd: '${CLAUDE_PLUGIN_ROOT}'
  });

  // SKILL.md 的 frontmatter 名字就是装上后在 Cowork 里显示的名字 ——
  // 留着 `codex-spec` 会让这个 skill 顶着别的插件的名字出现。
  assert.match(skill, /^---\nname: claude-spec\n/, 'SKILL.md frontmatter 的 name 必须是 claude-spec');
  assert.doesNotMatch(skill, /name: codex-spec/);
  // 加了 hook 也不能把档位说成硬护栏：这几条是第 6 期的核心诚实性约束。
  assert.match(skill, /fileGuardrail=false/);
  assert.match(skill, /collaborative/);
  // 「不是 hard-security」这句**必须**在；而被禁的是**宣称**，不是词表。
  // 依据：计划 Task 6 Step 1 说「不得出现 Level 2 / hard-security / 不可伪造 / 机器背书这类措辞」，
  // Step 4 又要求把「机器背书署名」写进 README 的【不做】段 —— 字面禁词会让 Step 4 写不出来。
  // 唯一自洽的读法是：禁的是把它们当成**本插件的档位**来宣称。README 侧那条检查更严也更精确，
  // 见 test/readme-tier.test.mjs：这些词只允许出现在【不做】段落里。
  assert.match(skill, /不是 hard-security/);
  assert.match(skill, /admission\.json/);
  assert.doesNotMatch(skill, /本插件是\s*(?:Level 2|hard-security)/);
  assert.match(skill, /`requirements-first`, `design-first`, `bugfix`, and `quick` collaborative workflows/);
  assert.match(skill, /serial task execution/);
  assert.match(skill, /spec_health[\s\S]*spec_list[\s\S]*spec_adopt[\s\S]*spec_context[\s\S]*spec_read[\s\S]*spec_diagnostics[\s\S]*spec_task_plan/);
  assert.match(skill, /spec_task_begin[\s\S]*spec_task_record_check[\s\S]*spec_task_complete/);
  assert.match(skill, /spec_task_fail/);
});

test('fork 形状：没有 .codex-plugin、没有顶层 bin/、skills 只有 claude-spec 一个子目录', async () => {
  // ① Codex 的清单目录不该被带过来（Task 2 Step 1）。
  assert.equal(existsSync(path.join(pluginRoot, '.codex-plugin')), false, '.codex-plugin/ 不该出现在 claude-spec 里');
  // ② kiro-spec 的评审留档不是资产（Task 2 Step 1）。
  // ⚠️ 这里的文件名**必须**留着 `kiro-spec`：它断言的是一个旧名字的**缺席**。
  // 改名成 `claude-spec` 会让这条断言恒真（永远不存在的东西当然不存在），
  // 也就是把一条守卫悄悄变成噪音 —— Task 2 Step 7 的「不许全局替换」说的正是这种情形。
  assert.equal(existsSync(path.join(pluginRoot, 'REVIEW-20260827-kiro-spec-plugin.md')), false);

  // ③ 🔴 顶层 `bin/` 不存在（1.4 的实测约束）：claude.ai 托管的插件不允许顶层 `bin/` ——
  // 它会被加进 PATH 但审批界面不显示，表现是「本地看着好好的、上传就装不上」。
  // 可执行脚本一律放 `scripts/`。这条断言很便宜，防的正是那个只在装载时才暴露的失败模式。
  assert.equal(existsSync(path.join(pluginRoot, 'bin')), false, '顶层 bin/ 会让插件装不上；可执行脚本请放 scripts/');

  // ④ skills 的子目录名不受 manifest 约束，但它是装上后的显示名来源。
  assert.deepEqual(await readdir(path.join(pluginRoot, 'skills')), ['claude-spec']);

  // ⑤ 🔴 共享配置路径（L4，Req 3.1）：**三处**默认值必须逐字相同，不要「顺手清理」。
  //
  // 它看着像 Codex 残留，实际是**跨宿主共享的项目档案**：claude-spec / codex-spec / dsh-spec
  // 三个宿主读同一份（dsh 侧注释原文「the same adapter config the Codex CLI side uses」），
  // 而消费项目里已经部署了一份真的（commit `c979f3ed`）。改成 `.claude/claude-spec.json`
  // 会让同一个项目出现两份内容相同的档案。
  //
  // 2026-09-17 的改名（`.kiro` → `codex`）换的是**文件名**，位置与「共享」这条判断都没变；
  // 旧名由三个宿主的兼容读继续接住（Req 3.2），所以已部署的项目不会因此 ADAPTER_MISSING。
  //
  // 这条断言存在的唯一目的：防下一次「看起来很像残留」的清理，也防**只改两处**——
  // 半改名状态（两个宿主读新路径、第三个还读旧路径）正是它要挡的事故。
  const sharedConfigPath = (source, file) => {
    // `export ` 是可选的：两个 adapter 导出这两个常量（跨宿主契约测试要用），dsh 是末尾统一导出。
    const found = /^(?:export )?const CODEX_SPEC_CONFIG = '([^']+)'/m.exec(source);
    assert.ok(found, `${file} 里找不到 CODEX_SPEC_CONFIG 的声明 —— 「三处一致」这条断言失去了对象`);
    return found[1];
  };
  const claudeSpecSource = await readFile(path.join(pluginRoot, 'lib', 'mcp', 'adapter.mjs'), 'utf8');
  const codexSpecSource = await readFile(path.resolve(pluginRoot, '..', 'codex-spec', 'lib', 'mcp', 'adapter.mjs'), 'utf8');
  const dshSpecSource = await readFile(path.resolve(pluginRoot, '..', 'dsh-spec', 'lib', 'index.js'), 'utf8');
  // **一条**断言钉住三处**逐字**相等（不靠人眼比对，也不拆成三条各自相等）：
  // `deepEqual` 失败时会把三个值一起打出来，所以「哪一处漂了」一眼可读。
  assert.deepEqual(
    [
      sharedConfigPath(claudeSpecSource, 'plugins/claude-spec/lib/mcp/adapter.mjs'),
      sharedConfigPath(codexSpecSource, 'plugins/codex-spec/lib/mcp/adapter.mjs'),
      sharedConfigPath(dshSpecSource, 'plugins/dsh-spec/lib/index.js'),
    ],
    ['.codex/codex-spec.json', '.codex/codex-spec.json', '.codex/codex-spec.json'],
    '三处默认值指的是同一个跨宿主共享的项目档案，必须逐字相同（只改两处 = 一个宿主读新路径、另一个还读旧的）'
  );
  assert.doesNotMatch(claudeSpecSource, /adapterPath = '\.claude/, '不要把它写成 .claude/...');
});

test('MCP starts over stdio and exposes requirements-first authoring and serial execution tools', async () => {
  const server = await startServer();
  try {
    const initialized = await server.request(1, 'initialize', { protocolVersion: '2025-06-18' });
    const listed = await server.request(2, 'tools/list');
    const manifest = await readJson('.claude-plugin/plugin.json');

    assert.equal(initialized.result.serverInfo.name, 'claude-spec');
    // serverInfo.version 必须与 manifest 一致，否则「装的是哪一版」两处说法不同。
    assert.equal(initialized.result.serverInfo.version, manifest.version);
    assert.deepEqual(initialized.result.capabilities.tools, {});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      'spec_health', 'spec_list', 'spec_template', 'spec_validate_artifacts', 'spec_init', 'spec_adopt', 'spec_read', 'spec_context',
      'spec_write', 'spec_amend', 'spec_status', 'spec_diagnostics', 'spec_analyze', 'spec_quality_preview', 'spec_sync_preview', 'spec_sync_apply',
      'spec_record_analysis', 'spec_request_approval', 'spec_record_approval', 'spec_task_set',
      'spec_task_plan', 'spec_task_begin', 'spec_task_record_check', 'spec_task_complete', 'spec_task_fail',
      'spec_task_reset_failures'
    ]);
    for (const tool of listed.result.tools) {
      assert.equal(tool.annotations.openWorldHint, false);
    }
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_health').annotations.readOnlyHint, true);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_task_plan').annotations.readOnlyHint, false);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_write').annotations.destructiveHint, true);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_task_begin').annotations.destructiveHint, true);
    assert.equal(listed.result.tools.find((tool) => tool.name === 'spec_health').annotations.destructiveHint, false);
  } finally {
    await server.stop();
  }
});

test('启动诊断仍然是 fileGuardrail=false，并新增 trustTier=collaborative', async () => {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await once(child, 'spawn');
    for (let attempt = 0; attempt < 100 && !stderr.includes('claude-spec.mcp.started'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    child.kill();
  }
  const line = stderr.split('\n').find((candidate) => candidate.includes('claude-spec.mcp.started'));
  assert.ok(line, `stderr 上没有启动诊断行；实际 stderr: ${stderr}`);
  const diagnostic = JSON.parse(line);
  // 加了 hook 之后这一格**仍然是 false**：门控拦不住「改门控的人」，所以它不是 file guardrail。
  // 把它改成 true 才是第 6 期明确禁止的那种过度宣称。
  assert.equal(diagnostic.fileGuardrail, false);
  assert.equal(diagnostic.trustTier, 'collaborative');
});
