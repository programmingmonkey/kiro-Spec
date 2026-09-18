import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parseArtifact, parseTasks, parseWaves, writeTasks, writeWaves } from '../lib/core/index.mjs';

const fixtureRoot = path.resolve(import.meta.dirname, 'fixtures');

async function fixture(name) {
  return readFile(path.join(fixtureRoot, name), 'utf8');
}

test('任务 AST 保留任意深度字符串 ID、状态、可选标记和 sourceRange', async () => {
  const ast = parseTasks(await fixture('codex-modern-tasks.md'));
  const task = ast.tasks[0];
  const leaf = task.children[1].children[0];

  assert.equal(task.id, '1');
  assert.equal(task.state, ' ');
  assert.equal(task.children[1].id, '1.2');
  assert.equal(leaf.id, '1.2.3');
  assert.equal(leaf.optional, true);
  assert.deepEqual(leaf.requirements, ['2.3', '2.4']);
  assert.deepEqual(leaf.dependencies, ['1.1']);
  assert.equal(leaf.children.length, 0);
  assert.ok(leaf.sourceRange.start.line < leaf.sourceRange.end.line);
  assert.deepEqual(ast.executableTaskIds, ['1.1', '1.2.3', '2']);
});

test('容器不是可执行任务，顶级叶子仍是可执行任务', async () => {
  const ast = parseTasks(await fixture('kiro-modern-tasks.md'));
  assert.deepEqual(ast.tasks.map((task) => task.id), ['1', '2']);
  assert.deepEqual(ast.executableTaskIds, ['1.1', '1.2', '2']);
  assert.equal(ast.tasks[0].children.length, 2);
  assert.equal(ast.tasks[1].children.length, 0);
});

test('Kiro canonical 任务格式保留叶子、紧贴 optional 标记与进行中状态', () => {
  const canonical = `- [ ] 1. Parent
  - [ ] 1.1 Child
    - _Requirements: 1.1_
- [ ]* 2. Optional
  - _Requirements: 2.1_
- [-] 3. In progress
  - _Requirements: 3.1_
`;
  const ast = parseTasks(canonical);

  assert.deepEqual(ast.executableTaskIds, ['1.1', '2', '3']);
  assert.deepEqual(ast.tasks[0].children[0].requirements, ['1.1']);
  assert.equal(ast.tasks[1].optional, true);
  assert.equal(ast.tasks[2].state, '-');
});

test('canonical metadata 保留含下划线的引用并可经 writer 往返', () => {
  const ast = parseTasks(`- [ ] 1. Task
  - _Requirements: REQ_AUTH_1_
  - _Dependencies: DEP_AUTH_2_
`);
  assert.deepEqual(ast.tasks[0].requirements, ['REQ_AUTH_1']);
  assert.deepEqual(ast.tasks[0].dependencies, ['DEP_AUTH_2']);
  const reparsed = parseTasks(writeTasks(ast));
  assert.deepEqual(reparsed.tasks[0].requirements, ['REQ_AUTH_1']);
  assert.deepEqual(reparsed.tasks[0].dependencies, ['DEP_AUTH_2']);
});

test('顶层任务缺少尾点不再报错，而是按真机语义成为任务', () => {
  // 差异表 C：真机 f 命中、d 不命中 → 报 tasks/invalid-task-line，且该行不计为任务；
  // dsh 有意计入（漏算会让 phase 谎报 complete，见 plugins/dsh-spec/lib/index.js:525-535）。
  // 第 3 期把 kiro 归并到 dsh 侧：解析层不再拒绝该行，格式问题交由 finding 层（第 3.5 期）。
  const ast = parseTasks('- [ ] 1 Missing top-level delimiter\n  - _Requirements: 1.1_\n');
  assert.equal(ast.tasks[0].id, '1');
});

test('无标题任务不再报错，而是成为任务（真机的两条任务正则都是前缀测试）', () => {
  // 差异表 B：真机 p 是前缀测试，'- [ ] 1.' 命中 → 无 error。kiro 原判 invalid-format 比真机更严。
  const ast = parseTasks('- [ ] 1.\n');
  assert.equal(ast.tasks[0].id, '1');
  assert.equal(ast.tasks[0].title, '');
});

test('代码围栏内的 Kiro 任务示例不会与真实任务冲突', () => {
  const markdown = `\`\`\`md
  - [ ] 1.1 Example only
\`\`\`

## Tasks

- [ ] 1. Parent
  - [ ] 1.1 Real task
    - _Requirements: 1.1_
`;
  const ast = parseTasks(markdown);
  assert.deepEqual(ast.executableTaskIds, ['1.1']);
  assert.equal(ast.tasks[0].children[0].title, 'Real task');
});

test('缩进代码围栏内的 Kiro 任务示例不会与真实任务冲突', () => {
  const markdown = `   \`\`\`md
- [ ] 1.1 Example only
   \`\`\`

- [ ] 1. Parent
  - [ ] 1.1 Real task
    - _Requirements: 1.1_
`;
  assert.deepEqual(parseTasks(markdown).executableTaskIds, ['1.1']);
});

test('四空格缩进代码块不会开启围栏并吞掉后续任务', () => {
  const markdown = `    \`\`\`md
- [ ] 1. Real task
  - _Requirements: 1.1_
`;
  assert.deepEqual(parseTasks(markdown).executableTaskIds, ['1']);
});

test('任务列表容器内的四空格围栏不会把示例解析为任务', () => {
  const markdown = `- [ ] 1. Parent
    \`\`\`md
    - [ ] 1.1 Example only
    \`\`\`
  - [ ] 1.1 Real task
    - _Requirements: 1.1_
`;
  assert.deepEqual(parseTasks(markdown).executableTaskIds, ['1.1']);
});

test('深层任务后回到父级容器的围栏不会把示例解析为任务', () => {
  const markdown = `- [ ] 1. Root
  - [ ] 1.1 Mid
    - [ ] 1.1.1 Parent
      - [ ] 1.1.1.1 Inner
    \`\`\`md
    - [ ] 1.1.1.2 Example only
    \`\`\`
    - [ ] 1.1.1.2 Real task
`;
  assert.deepEqual(parseTasks(markdown).executableTaskIds, ['1.1.1.1', '1.1.1.2']);
});

test('未闭合的缩进围栏候选不会吞掉后续同级任务', () => {
  const markdown = `- [ ] 1. First task
    \`\`\`md
- [ ] 2. Real task
`;
  assert.deepEqual(parseTasks(markdown).executableTaskIds, ['1', '2']);
});

test('缩进围栏候选不会跨越更浅任务配对无关围栏', () => {
  const markdown = `- [ ] 1. First task
    \`\`\`md
- [ ] 2. Real task
\`\`\`json
{}
\`\`\`
`;
  assert.deepEqual(parseTasks(markdown).executableTaskIds, ['1', '2']);
});

test('任务状态严格限于 [ ]、[-]、[x]', () => {
  assert.throws(
    () => parseTasks('- [?] 1. Invalid state\n  _Requirements:_ 1.1\n'),
    /Invalid task state/
  );
});

test('任务状态拒绝禁用的 [~] 别名', () => {
  assert.throws(
    () => parseTasks('- [~] 1. Forbidden alias\n  _Requirements:_ 1.1\n'),
    /Invalid task state/
  );
});

test('waves 同时读取现代字符串格式与历史整数格式，写入一律为现代字符串格式', async () => {
  const modern = parseWaves(await fixture('codex-modern-waves.json'));
  const legacy = parseWaves(await fixture('kiro-legacy-waves.json'));

  assert.deepEqual(modern, { sourceFormat: 'modern', waves: [{ id: 0, tasks: ['1.1', '1.2.3'] }, { id: 1, tasks: ['2'] }] });
  assert.deepEqual(legacy, { sourceFormat: 'legacy', waves: [{ id: 0, tasks: ['1', '2'] }, { id: 1, tasks: ['3'] }] });
  assert.equal(writeWaves(legacy), await fixture('codex-canonical-waves.json'));
});

test('canonical writer 不将 string task ID 退化为数字，且可稳定往返', async () => {
  const parsed = parseTasks(await fixture('codex-modern-tasks.md'));
  const written = writeTasks(parsed);
  const reparsed = parseTasks(written);

  assert.match(written, /- \[ \] 1\. Container task/);
  assert.match(written, /- \[x\]\* 1\.2\.3 Optional deep leaf/);
  assert.match(written, /- _Requirements: 2\.3, 2\.4_/);
  assert.deepEqual(reparsed.executableTaskIds, ['1.1', '1.2.3', '2']);
  assert.equal(reparsed.tasks[0].children[1].children[0].id, '1.2.3');
});

test('artifact AST 仅提供中性标题结构，不猜测 feature/bugfix 工作流', () => {
  const artifact = parseArtifact('# Requirements\n\n## User Stories\n\nText\n');
  assert.deepEqual(artifact.sections.map((section) => section.title), ['Requirements', 'User Stories']);
  assert.equal(artifact.sourceRange.start.line, 1);
});

test('DSH 现代格式 fixture 被明确记录为已知兼容性失败，不冒充已验证通过', async () => {
  const manifest = JSON.parse(await fixture('dsh-modern-known-failure.json'));
  const dshModernFixture = await fixture('dsh-modern-string-id-tasks.md');
  assert.equal(manifest.expectations.codexParser, 'pass');
  assert.equal(manifest.expectations.dshCurrentParser, 'known-failure');
  assert.match(manifest.reason, /整数/);
  assert.deepEqual(parseTasks(dshModernFixture).executableTaskIds, ['1.1', '1.2.3']);
});
