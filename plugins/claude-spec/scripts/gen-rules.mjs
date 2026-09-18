#!/usr/bin/env node
// claude-spec —— `.claude/rules/` 生成器（第 6 期 Task 5）。
//
// 它做一件事：把**规则表的单一事实源**（`packages/kiro-rules/lib/kiro-rules.js`）
// 派生成 5 份 `.claude/rules/*.md`，写进消费项目 —— 规则的消费地在那边。
//
// 🔴 规则表是真源，rule 文件是**派生产物**。改规则请改真源再重跑本脚本，
// 不要手改产物：产物的头里写着 `doNotEdit`，而且 Step 7 ① 会逐字节比对，手改必红。
//
// 为什么用 `resolveConsumerRoot()` 而不是写死路径：第 3.5 期栽过一次 —— 各处各写一遍
// `os.homedir()/Documents/消费项目`，到交付时仓库里有 8 份拷贝，其中一处是
// `if (!existsSync(root)) return []`，于是外部语料整层归零而判据照常「通过」。
// 所以这里：**解析不到就大声失败，绝不静默产出零个文件**。
//
// 产物落在 `.claude/rules/`，那不是 spec 目录，因此**不触发 §4.3.2 的署名检查**；
// 但它仍是一次消费项目提交，commit message 必须写明这是派生产物及其真源。
//
// 用法：
//   node scripts/gen-rules.mjs --out <dir>  # 落点必传（本脚本不猜路径）
//   node scripts/gen-rules.mjs --check        # 逐字节比对，不一致即 exit 1（保鲜检查）
//   node scripts/gen-rules.mjs --out <dir>     # 写到别处（测试用，不碰消费项目）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIRO_BUNDLE, REPO_CONVENTIONS, RULE_CODE_COUNT, rulesFor } from '@my-harness/kiro-rules';


/** 四个 artifact 区。`design` 不带 variant —— path rule 判不了变体，所以 design.md 要带上全部 15 条。 */
const AREAS = Object.freeze(['requirements', 'design', 'tasks', 'bugfix']);

const GENERATOR_REL = 'plugins/claude-spec/scripts/gen-rules.mjs';
const SOURCE_OF_TRUTH = 'packages/kiro-rules/lib/kiro-rules.js';

/** 派生产物的机器可读头。**不含时间戳** —— 时间戳会让 `--check` 永远不等，那道闸门就废了。 */
function generatedHeader() {
  return `<!-- claude-spec:generated ${JSON.stringify({
    generator: GENERATOR_REL,
    sourceOfTruth: SOURCE_OF_TRUTH,
    kiroBundle: KIRO_BUNDLE,
    doNotEdit: true,
  })} -->`;
}

/**
 * Step 3 的不变量：四个 artifact 文件的 code 并集恰为 41，且两两交集为空。
 *
 * ⚠️ 为什么两条都要：**只断「总数 41」会绿灯放行错误实现**。按变体遍历时
 * 「7 + 15 + 13 + 6 = 41」求和也等于 41，但并集只有 35 —— 6 条 `bugfix/missing-*`
 * 一条都不在里面。后半条（两两交集为空）才是真正咬人的那条。
 */
function assertRulePartition(sets) {
  const union = new Set(AREAS.flatMap((area) => sets[area]));
  if (union.size !== RULE_CODE_COUNT) {
    throw new Error(`规则分区不成立：四个 artifact 的 code 并集是 ${union.size}，期望 ${RULE_CODE_COUNT}`);
  }
  for (let i = 0; i < AREAS.length; i += 1) {
    for (let j = i + 1; j < AREAS.length; j += 1) {
      const shared = sets[AREAS[i]].filter((code) => sets[AREAS[j]].includes(code));
      if (shared.length > 0) {
        throw new Error(`规则分区不成立：${AREAS[i]} 与 ${AREAS[j]} 的 code 有交集 ${shared.join(', ')}`);
      }
    }
  }
}

function severityHeading(severity) {
  if (severity === 'error') return '必须满足（Kiro 报 error）';
  if (severity === 'warning') return '应当满足（Kiro 报 warning）';
  return `severity=${severity}`;
}

function renderRule(rule) {
  const lines = [];
  const label = rule.display ?? rule.name ?? rule.code;
  lines.push(`- **\`${label}\`** — ${rule.message}`);
  lines.push(`  - 规则码：\`${rule.code}\``);
  // 变体信息只在它真的有区分度时写出来：design 是唯一带变体的区。
  if (Array.isArray(rule.variants) && rule.variants.length > 0 && rule.variants.length < 2) {
    lines.push(`  - 只适用于 \`${rule.variants.join('` / `')}\` 变体`);
  }
  if (rule.skippedForBugfix) lines.push('  - bugfix 变体下跳过');
  return lines.join('\n');
}

function renderArtifactFile(area, rules) {
  const artifact = `${area}.md`;
  const sorted = [...rules].sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  const bySeverity = new Map();
  for (const rule of sorted) {
    if (!bySeverity.has(rule.severity)) bySeverity.set(rule.severity, []);
    bySeverity.get(rule.severity).push(rule);
  }

  const body = [
    '---',
    'paths:',
    `  - \".kiro/specs/**/${artifact}\"`,
    '---',
    '',
    generatedHeader(),
    '',
    `# \`.kiro/specs/**/${artifact}\` 的写作规则`,
    '',
    `本文件是**派生产物**，请勿手改 —— 改 \`${SOURCE_OF_TRUTH}\` 再重跑 \`${GENERATOR_REL}\`。`,
    `规则复刻自 Kiro bundle \`${KIRO_BUNDLE.version}\`（sha256 \`${KIRO_BUNDLE.sha256}\`）。`,
    `本文件含 ${sorted.length} 条规则码；四个 artifact 文件合计 ${RULE_CODE_COUNT} 条，两两不重叠。`,
    '',
  ];

  for (const [severity, group] of bySeverity) {
    body.push(`## ${severityHeading(severity)}`, '');
    for (const rule of group) body.push(renderRule(rule), '');
  }

  return `${body.join('\n').replace(/\n+$/, '')}\n`;
}

function renderCoreFile(sets) {
  const body = [
    generatedHeader(),
    '',
    '# Spec 规则索引（常驻）',
    '',
    '本文件是**派生产物**，请勿手改。真源是 `' + SOURCE_OF_TRUTH + '`，生成器是 `' + GENERATOR_REL + '`。',
    `规则复刻自 Kiro bundle \`${KIRO_BUNDLE.version}\`（${KIRO_BUNDLE.bytes} bytes，sha256 \`${KIRO_BUNDLE.sha256}\`，提取于 ${KIRO_BUNDLE.extractedAt}）。`,
    '',
    '它没有 `paths:`，所以在任何文件上都加载；带 `paths:` 的那四份只在对应的 artifact 上加载。',
    '',
    '## 按 artifact 路由',
    '',
    '| 文件 | `paths:` | 规则码数 |',
    '|---|---|---|',
    ...AREAS.map((area) => `| \`.claude/rules/${area}.md\` | \`.kiro/specs/**/${area}.md\` | ${sets[area].length} |`),
    `| （合计） | — | ${RULE_CODE_COUNT} |`,
    '',
    '## 书写顺序',
    '',
    '1. `requirements.md`：先写，它是 feature 工作流的第一阶段（bugfix 工作流是 `bugfix.md`）。',
    '2. `design.md`：前一阶段落地之后再写。**变体（feature / bugfix）由内容判定，不由路径判定** ——',
    '   所以本目录里 `design.md` 那一份带的是两个变体的并集；按内容判变体这一步留在 MCP 侧',
    '   （`sniffDesignVariant`），path rule 判不了它。',
    '3. `tasks.md`：最后写，含 `## Task Dependency Graph`。',
    '',
    '阶段顺序由 `claude-spec` 的 `PreToolUse` 门控执行（`hooks/hooks.json`）。',
    '🔴 那是**协作约定，不是硬护栏** —— 依据 `spikes/cowork-hook-probe/evidence/admission.json`',
    '（`privateStateIntegrity: FAIL` → `decision: STOP`）。',
    '',
    '## 仓库约定（不属于那 41 条 Kiro 规则）',
    '',
    '这些是**本仓库**的约定，不是 Kiro 的规则。它们不参与上面的计数，也不该让 Kiro 拒绝的 spec',
    '在这里被报成 error —— 任何一条被算进 41 里都会让两个宿主对同一份 spec 给出不同结论。',
    '',
    ...REPO_CONVENTIONS.map((convention) => {
      const label = convention.display ?? convention.code;
      // 有些约定没有 `display`（例如 tasks/unterminated-fence），此时标签就是 code ——
      // 再在括号里重复一遍同一个 code 只会让读者以为它们是两样东西。
      const code = label === convention.code ? '' : `\`${convention.code}\`，`;
      return `- **\`${label}\`** — ${convention.message}（${code}severity=${convention.severity}）`;
    }),
    '',
  ];
  return `${body.join('\n').replace(/\n+$/, '')}\n`;
}

/** 生成全部 5 份文件的内容。纯函数：不碰文件系统，方便 `--check` 与测试复用。 */
export function renderRules() {
  const sets = {};
  const bundles = {};
  for (const area of AREAS) {
    const rules = rulesFor(area);
    sets[area] = rules.map((rule) => rule.code);
    bundles[area] = rules;
  }
  assertRulePartition(sets);

  const files = new Map();
  files.set('spec-core.md', renderCoreFile(sets));
  for (const area of AREAS) files.set(`${area}.md`, renderArtifactFile(area, bundles[area]));
  return files;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function targetDirectory(argv) {
  const outIndex = argv.indexOf('--out');
  // 落点必须显式给出：本脚本**不猜**任何下游项目的路径。
  //
  // 曾经这里默认写入某个具体项目的 `.claude/rules/`。那个默认值有两重代价：
  // 把本插件与那个项目耦合在一起；以及为了解析那条路径而 import 仓根脚本，
  // 最终让 pack-plugin 把仓根脚本一起打进了发布产物（`vendor/_repo/`）。
  if (outIndex === -1) fail('--out 是必须的：本脚本不猜任何下游项目的路径。用法：node scripts/gen-rules.mjs --out <dir>');
  const value = argv[outIndex + 1];
  if (!value || value.startsWith('--')) fail('--out 需要一个目录参数');
  return path.resolve(value);
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const directory = targetDirectory(argv);
  const files = renderRules();

  if (!check) {
    mkdirSync(directory, { recursive: true });
    for (const [name, content] of files) writeFileSync(path.join(directory, name), content);
    console.log(`已生成 ${files.size} 份规则文件 → ${directory}`);
    // 报字节数而不是 `.length`：内容里有中文，`.length` 数的是字符，会报出偏小的数字。
    for (const [name, content] of files) console.log(`  ${name}  ${Buffer.byteLength(content, 'utf8')} bytes`);
    return;
  }

  if (!existsSync(directory)) {
    fail(`${directory} 不存在 —— 规则文件还没生成过，或者位置变了。先不带 --check 跑一次。`);
  }

  const drift = [];
  for (const [name, expected] of files) {
    const file = path.join(directory, name);
    let actual;
    try {
      actual = readFileSync(file, 'utf8');
    } catch (caught) {
      drift.push(`${name}: 读不到（${caught.code ?? caught.message}）`);
      continue;
    }
    if (actual !== expected) drift.push(`${name}: 与生成器输出不一致`);
  }

  if (drift.length > 0) {
    fail(
      `规则文件与生成器不一致（${drift.length}/${files.size}）：\n  ${drift.join('\n  ')}\n` +
        `真源改过之后要重跑 \`node ${GENERATOR_REL}\`，并把产物一起提交。\n` +
        '手改产物同样会在这里红 —— 这是有意的：产物是派生物，手改等于制造第二份会漂的副本。',
    );
  }
  console.log(`${directory} 下 ${files.size} 份规则文件与生成器逐字节一致`);
}

// 只有被直接执行时才动文件系统；被 import 时只导出纯函数。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
