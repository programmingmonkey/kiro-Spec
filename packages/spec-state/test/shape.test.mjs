// 第 7 期 Task 3 Step 4 —— 包的形状：导出面 / 零 I/O / 依赖单向。
//
// 三条都是「抽包时顺手就能破坏、之后没人会注意」的东西，所以各有一条断言守着。
// 导出面是**手写清单**：想让包多导出一个名字，必须先改这里 —— 这条约定照
// `@my-harness/spec-analysis` 与 `@my-harness/spec-revision` 的成例。

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as state from '../lib/index.mjs';
import * as ports from '../lib/ports.mjs';
import * as storage from '../lib/storage.mjs';
import * as pathsModule from '../lib/paths.mjs';
import * as adapterContext from '../lib/adapter-context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

const SOURCES = walk(join(PKG, 'lib'));

// 只认**代码行**里的说明符：注释里写着 `from 'node:fs/promises'` 或
// `from '@my-harness/…'`（例如 `ports.mjs` / `storage.mjs` 的用法示例与变更说明）
// 不算依赖、也不算 I/O。这条口径抄自 `scripts/dependency-declaration.test.mjs` ——
// 那边吃过一次「注释里提了一句就算已 import」的假阴性。
const codeLines = (abs) => readFileSync(abs, 'utf8')
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  })
  .join('\n');

test('零 node:fs / node:path：I/O 全部由宿主注入（门槛 1）', () => {
  const offenders = SOURCES
    .filter((abs) => /from\s+['"]node:(fs|fs\/promises|path|path\/posix)['"]/.test(codeLines(abs)))
    .map((abs) => relative(PKG, abs));
  assert.deepEqual(offenders, [], `这些文件又自己碰了文件系统/路径：${offenders.join(', ')}`);
});

test('依赖方向单向：spec-state → spec-revision → spec-parser，且不反向 import 任何 plugin', () => {
  // 自引用不算依赖（包名只会出现在文档里）。
  // `spec-analysis` 于「增量修正通道」一期登记：spec-state → spec-analysis → spec-parser，
  // 方向仍然单向（spec-analysis 的 dependencies 只有 spec-parser，不反向依赖本包）。
  // 登记它是为了让 `spec_amend` 复用那三个 writer，而不是在本包再抄一份守卫。
  const allowed = new Set(['@my-harness/spec-revision', '@my-harness/spec-parser', '@my-harness/spec-diagnose', '@my-harness/spec-analysis', '@my-harness/spec-state']);
  const wrongDirection = [];
  const plugins = [];
  for (const abs of SOURCES) {
    const source = codeLines(abs);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('@my-harness/')) continue;
      // 子路径（`@my-harness/spec-parser/waves`）归到包名再判。
      const pkg = specifier.split('/').slice(0, 2).join('/');
      if (!allowed.has(pkg)) wrongDirection.push(`${relative(PKG, abs)} → ${specifier}`);
    }
    if (/plugins\/(kiro|claude|dsh)-spec/.test(source) && /from\s+['"][^'"]*plugins\//.test(source)) {
      plugins.push(relative(PKG, abs));
    }
  }
  assert.deepEqual(wrongDirection, [], `共享包不得反向依赖 L2 或未登记的包：${wrongDirection.join(', ')}`);
  assert.deepEqual(plugins, [], `共享包不得直接 import 插件里的文件：${plugins.join(', ')}`);
});

test('导出面是手写清单（新增导出必须先改这里）', () => {
  assert.deepEqual(Object.keys(state).sort(), ['STATE_LAYER', 'createSpecState']);
  assert.deepEqual(Object.keys(storage).sort(), ['createSpecStorage']);
  assert.deepEqual(Object.keys(ports).sort(), ['REQUIRED_FS_METHODS', 'createNodeFsPort']);
  assert.deepEqual(Object.keys(pathsModule).sort(), [
    'basename', 'dirname', 'inside', 'isAbsolute', 'join', 'normalize', 'resolve', 'sep'
  ]);
  assert.deepEqual(Object.keys(adapterContext).sort(), ['adapterContextFiles']);
});

test('core/ 的 12 个纯模块都还在（整文件搬移，不是重写；storage 按边界表另住 lib/）', () => {
  const names = readdirSync(join(PKG, 'lib', 'core')).sort();
  assert.deepEqual(names, [
    'analysis.mjs', 'artifact-schema.mjs', 'event-format.mjs', 'index.mjs', 'quality.mjs',
    'revision.mjs', 'task-events.mjs', 'task-execution.mjs', 'task-format.mjs', 'templates.mjs',
    'workflow.mjs', 'workspace-snapshot.mjs'
  ]);
});

test('`resolve` 不回落 cwd —— 没有绝对段时抛，而不是静默对着当前目录干活', () => {
  assert.throws(() => pathsModule.resolve('a', 'b'), /no absolute segment/);
  assert.equal(pathsModule.resolve('/root', 'a', 'b'), '/root/a/b');
  // 右侧绝对段覆盖左侧，与 node:path 一致
  assert.equal(pathsModule.resolve('/root', '/other', 'b'), '/other/b');
});

// `STATE_LAYER` 是 build 判别式（见 lib/index.mjs 的理由）。它的全部价值在于「不撒谎」：
// 一旦它与 package.json 漂开，真机上读到的就是一个**看起来像版本号的假话** —— 那比没有
// 判别式更糟。所以这里把两处钉死，改版本号时必须同时改常量，否则本条红。
test('STATE_LAYER 与 package.json 的 name@version 逐字相等（判别式不许撒谎）', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  assert.equal(state.STATE_LAYER, `${pkg.name}@${pkg.version}`);
});
