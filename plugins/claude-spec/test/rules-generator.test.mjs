// 06-claude-spec Task 5 —— `.claude/rules/` 生成器。
//
// 这份测试的重心不是「文件生成了」，而是 Step 3 那条判据**有没有牙**：
// 「四个 artifact 文件的 code 并集恰为 41，且两两交集为空」。
// 只断「求和 41」会被一个错误实现绿灯放行 —— 下面有一条**负向对照**把那个错误实现
// 原地搭出来（求和 41 / 并集 35），用来证明这条断言不是恒真的。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KIRO_BUNDLE, RULE_CODE_COUNT, rulesFor } from '@my-harness/kiro-rules';
import { resolveConsumerRoot, consumerAbsenceMessage } from '../../../scripts/consumer-root.mjs';

import { renderRules } from '../scripts/gen-rules.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '..');
const GENERATOR = path.join(pluginRoot, 'scripts', 'gen-rules.mjs');
const AREAS = ['requirements', 'design', 'tasks', 'bugfix'];
/** Task 0 探针实测的分区：7 / 15 / 13 / 6。写死在这里，改规则表就得有人来解释。 */
const EXPECTED_COUNTS = { requirements: 7, design: 15, tasks: 13, bugfix: 6 };

/** 从生成的 artifact 文件正文里把规则码抽出来 —— 检查的是**产物**，不是输入。 */
function codesIn(markdown) {
  return [...markdown.matchAll(/^\s*- 规则码：`([^`]+)`$/gm)].map((match) => match[1]);
}

// ── 产物形状 ─────────────────────────────────────────────────────────────────

test('恰好 5 份文件，名字与落点符合约定', () => {
  const files = renderRules();
  assert.deepEqual([...files.keys()].sort(), ['bugfix.md', 'design.md', 'requirements.md', 'spec-core.md', 'tasks.md']);
});

test('spec-core.md 无 paths:（常驻）；四个 artifact 各带自己的 paths:（路由）', () => {
  const files = renderRules();
  assert.doesNotMatch(files.get('spec-core.md'), /^paths:/m, 'spec-core 必须常驻，不能带 paths:');
  for (const area of AREAS) {
    const content = files.get(`${area}.md`);
    assert.match(content, new RegExp(`^paths:\\n  - "\\.kiro/specs/\\*\\*/${area}\\.md"$`, 'm'), `${area}.md 的 paths: 不对`);
  }
});

test('每份文件都有机器可读的头：生成器路径 + KIRO_BUNDLE + doNotEdit', () => {
  for (const [name, content] of renderRules()) {
    const match = /^<!-- claude-spec:generated (\{.*\}) -->$/m.exec(content);
    assert.ok(match, `${name} 缺机器可读的头`);
    const header = JSON.parse(match[1]);
    assert.equal(header.generator, 'plugins/claude-spec/scripts/gen-rules.mjs');
    assert.equal(header.sourceOfTruth, 'packages/kiro-rules/lib/kiro-rules.js');
    assert.equal(header.doNotEdit, true);
    // 第 1 期加的 bundle 标识必须原样带上：没有它，读者无法判断这批规则复刻自哪个 Kiro 版本。
    assert.deepEqual(header.kiroBundle, KIRO_BUNDLE);
  }
});

test('头里没有时间戳 —— 有的话 --check 会永远不等，那道闸门就废了', () => {
  for (const [, content] of renderRules()) {
    assert.doesNotMatch(content, /generatedAt|generated-at|20\d\d-\d\d-\d\dT/, '产物里不许出现生成时间');
  }
  // 两次生成必须逐字节相同。
  const first = renderRules();
  const second = renderRules();
  for (const [name, content] of first) assert.equal(second.get(name), content, `${name} 两次生成不一致`);
});

// ── 🔴 Step 3：并集恰为 41，且两两交集为空（在产物上判） ────────────────────────

test('🔴 四个 artifact 文件的 code 并集恰为 41，两两交集为空，各区计数 7/15/13/6', () => {
  const files = renderRules();
  const fromOutput = {};
  for (const area of AREAS) fromOutput[area] = codesIn(files.get(`${area}.md`));

  for (const area of AREAS) {
    assert.equal(fromOutput[area].length, EXPECTED_COUNTS[area], `${area}.md 的规则码数不对`);
    assert.equal(new Set(fromOutput[area]).size, fromOutput[area].length, `${area}.md 内部有重复 code`);
  }

  const union = new Set(AREAS.flatMap((area) => fromOutput[area]));
  // 两条都要：并集才是 Step 3 要求的那一条；求和相等只是巧合。
  assert.equal(union.size, RULE_CODE_COUNT, `并集是 ${union.size}，期望 ${RULE_CODE_COUNT}`);

  for (let i = 0; i < AREAS.length; i += 1) {
    for (let j = i + 1; j < AREAS.length; j += 1) {
      const shared = fromOutput[AREAS[i]].filter((code) => fromOutput[AREAS[j]].includes(code));
      assert.deepEqual(shared, [], `${AREAS[i]} 与 ${AREAS[j]} 的规则码有交集`);
    }
  }
});

test('🔴 负向对照：按变体遍历那个错误实现，求和 41 但并集只有 35 —— 这条断言因此不是恒真的', () => {
  // 这个错误实现长这样：把 design 拆成 feature / bugfix 两组去遍历，于是**再也走不到
  // `bugfix` 这个 area**（bugfix.md 的那 6 条 `bugfix/missing-*`）。
  // 巧的是 7 + 10 + 11 + 13 = 41 —— 只断总数的话它全绿。
  const byVariant = [
    rulesFor('requirements').map((rule) => rule.code),
    rulesFor('design', 'feature').map((rule) => rule.code),
    rulesFor('design', 'bugfix').map((rule) => rule.code),
    rulesFor('tasks').map((rule) => rule.code),
  ];
  const sum = byVariant.reduce((total, codes) => total + codes.length, 0);
  const union = new Set(byVariant.flat());

  assert.equal(sum, RULE_CODE_COUNT, '这个错误实现的求和**恰好**等于 41 —— 正是它骗过总数断言的原因');
  assert.notEqual(union.size, RULE_CODE_COUNT, '并集断言必须能把它挡下来');
  assert.equal(union.size, 35);

  const missing = rulesFor('bugfix').map((rule) => rule.code).filter((code) => !union.has(code));
  assert.deepEqual(missing, [
    'bugfix/missing-introduction',
    'bugfix/missing-bug-analysis',
    'bugfix/missing-current-behavior',
    'bugfix/missing-expected-behavior',
    'bugfix/missing-unchanged-behavior',
    'bugfix/unexpected-section'
  ], '漏掉的正该是计划点名的那 6 条 bugfix/missing-*');
});

// ── 生成器自身的失败面 ───────────────────────────────────────────────────────

test('--check 在目录不存在时大声失败，不静默"产出零个文件也算通过"（第 3.5 期那次事故的形状）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-nocheck-'));
  await rm(dir, { recursive: true, force: true });
  assert.throws(
    () => execFileSync(process.execPath, [GENERATOR, '--out', dir, '--check'], { encoding: 'utf8', stdio: 'pipe' }),
    (caught) => {
      assert.equal(caught.status, 1);
      assert.match(`${caught.stderr}`, /不存在/);
      return true;
    },
  );
});

test('--check 在产物被手改时变红', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-tamper-'));
  try {
    execFileSync(process.execPath, [GENERATOR, '--out', dir], { encoding: 'utf8', stdio: 'pipe' });
    await writeFile(path.join(dir, 'tasks.md'), `${await readFile(path.join(dir, 'tasks.md'), 'utf8')}\n手改一行\n`);
    assert.throws(
      () => execFileSync(process.execPath, [GENERATOR, '--out', dir, '--check'], { encoding: 'utf8', stdio: 'pipe' }),
      (caught) => {
        assert.equal(caught.status, 1);
        assert.match(`${caught.stderr}`, /不一致|派生产物|手改/s);
        return true;
      },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("生成器不依赖插件树之外的任何东西（静态）", () => {
  // 🔴 本用例替换掉了原先那条「缺席时必须走 consumerAbsenceMessage」的静态检查。
  // 原检查的前提已不存在：生成器的落点现在**必须显式传入**，它不再解析任何下游项目路径。
  // 而旧行为正是它 import 仓根脚本、进而让打包器把仓根脚本一起 vendor 进发布产物的原因
  // （产物里那份 vendor/_repo/ 只对导出那台机器有意义）。
  // 现在守的是新的不变量：插件树里的文件不许有指向仓外的相对 import，否则产物会带死链。
  const source = readFileSync(GENERATOR, "utf8");
  assert.match(source, /--out 是必须的/, "落点必须显式给出：生成器不猜任何下游项目的路径");
  assert.ok(!source.includes("../../../"), "不许有指向插件树之外的相对 import");
  assert.ok(!source.includes("/Users/"), "生成器里不许出现本机绝对路径");
});

// ── Step 7 ①：kiro-spec 侧的保鲜检查 ────────────────────────────────────────

test('Step 7 ① 保鲜检查：重跑生成器写到临时目录，与消费项目现存的 .claude/rules/ 逐字节比对', async (t) => {
  const { root, resolved } = resolveConsumerRoot();
  if (!resolved) {
    t.skip(`消费项目语料不在场，这一项记「未跑」：${consumerAbsenceMessage('.claude/rules/ 的比对目标')}`);
    return;
  }
  const existing = path.join(root, '.claude', 'rules');
  assert.ok(
    existsSync(existing),
    `消费项目里还没有 \`.claude/rules/\`（${existing}）—— 这一项**没有跑过**，不是通过。\n` +
      '生成一次：`node plugins/claude-spec/scripts/gen-rules.mjs`，并把产物提交进消费项目。',
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-rules-'));
  try {
    execFileSync(process.execPath, [GENERATOR, '--out', dir], { encoding: 'utf8', stdio: 'pipe' });
    const generated = (await readdir(dir)).sort();
    const shipped = readdirSync(existing).filter((name) => name.endsWith('.md')).sort();
    assert.deepEqual(shipped, generated, '两边的文件名集合不一致');

    for (const name of generated) {
      const [fresh, onDisk] = await Promise.all([readFile(path.join(dir, name), 'utf8'), readFile(path.join(existing, name), 'utf8')]);
      assert.equal(onDisk, fresh, `${name} 与生成器输出不一致 —— 规则表改过而产物没重跑，或者产物被手改了`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
