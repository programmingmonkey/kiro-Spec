// `paths.mjs` 与 `node:path.posix` 的**等价性**测试。
//
// 🔴 为什么这条测试必须存在：包里的零 `node:path`（门槛 1）**不是**靠「不 import」达成的，
// 而是靠「手写一份等价的」。于是「等价」就成了这个门槛的全部依据 —— 而 2026-09-13 的自审
// 用 30 万组 fuzz 实测出**两处不等价**：
//
//   ① `resolve` 保留了尾斜杠（node 去掉）—— 86926 组不同，语义差异 0 组；
//   ② `dirname('//x')` 返回 `/`（node 返回 `//`，POSIX 双斜杠）—— 3148 组不同。
//
// 两处都已修。**修完不加测试，就等于把「改对了」变成一句无人复验的话** —— 这个仓库
// 已经吃过一次同样的亏（第 6 期「实测不会红」）。所以本文件把当年的 fuzz 缩成
// 确定性 + 可复现的形态入库：短路径穷举（判别力都在短路径的边界上）+ 固定种子采样。
//
// 🔴 判据是 `node:path.posix`，不是 `node:path`：宿主平台是 posix，而 `paths.mjs` 只实现
// posix 语义。`resolve` 有一处**刻意**的不同（不回落 cwd），单独断言。

import assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import test from 'node:test';

import * as paths from '../lib/paths.mjs';

const SEGMENTS = ['a', '..', '.', '', 'b'];
const POSIX = nodePath.posix;

/** 短路径穷举：1~4 段 × 有无前导斜杠 × 有无尾斜杠。 */
function enumerate() {
  const out = []
  const build = (parts) => {
    const joined = parts.join('/')
    for (const lead of ['', '/']) {
      for (const tail of ['', '/']) out.push(`${lead}${joined}${tail}`)
    }
  }
  const walk = (parts) => {
    if (parts.length > 0) build(parts)
    if (parts.length === 4) return
    for (const segment of SEGMENTS) walk([...parts, segment])
  }
  walk([])
  // 纯斜杠的几种形态（`/`、`//`、`///`）不在上面的组合里
  out.push('/', '//', '///', '////')
  return [...new Set(out)]
}

/** 固定种子的 LCG —— 不用 Math.random，失败要能原样复现。 */
function* sampled(count, seed = 20260913) {
  let state = seed >>> 0
  const next = (n) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n }
  for (let i = 0; i < count; i += 1) {
    const length = 1 + next(6)
    const parts = Array.from({ length }, () => SEGMENTS[next(SEGMENTS.length)])
    let value = parts.join('/')
    if (next(3) === 0) value = `/${value}`
    if (next(4) === 0) value += '/'
    yield value
  }
}

const CORPUS = [...enumerate(), ...sampled(3000)];

test('语料本身够大、且含边界形态（否则下面几条会退化成恒真）', () => {
  assert.ok(CORPUS.length > 3000, `语料只有 ${CORPUS.length} 条`);
  for (const boundary of ['', '.', '..', '/', '//', 'a/', '/a', 'a//b', '/a/../..']) {
    assert.ok(CORPUS.includes(boundary), `语料缺了边界形态 ${JSON.stringify(boundary)}`);
  }
});

test('normalize / basename / isAbsolute 与 node:path.posix 逐例相同', () => {
  const bad = { normalize: [], basename: [], isAbsolute: [] };
  for (const value of CORPUS) {
    if (POSIX.normalize(value) !== paths.normalize(value)) bad.normalize.push(value);
    if (POSIX.basename(value) !== paths.basename(value)) bad.basename.push(value);
    if (POSIX.isAbsolute(value) !== paths.isAbsolute(value)) bad.isAbsolute.push(value);
  }
  for (const [kind, list] of Object.entries(bad)) {
    assert.deepEqual(list.slice(0, 5), [], `${kind} 有 ${list.length} 例与 node:path.posix 不同`);
  }
});

test('dirname 与 node:path.posix 逐例相同（含 POSIX 双斜杠 `//x` → `//`）', () => {
  const bad = CORPUS.filter((value) => POSIX.dirname(value) !== paths.dirname(value))
    .map((value) => `${JSON.stringify(value)} → node=${JSON.stringify(POSIX.dirname(value))} mine=${JSON.stringify(paths.dirname(value))}`);
  assert.deepEqual(bad.slice(0, 5), [], `dirname 有 ${bad.length} 例不同`);
  // 那两个具体的反例单独再钉一次：它们就是当年 fuzz 抓到的东西
  assert.equal(paths.dirname('//a'), '//');
  assert.equal(paths.dirname('//a/'), '//');
  assert.equal(paths.dirname('///a'), POSIX.dirname('///a'));
});

test('join 与 node:path.posix 逐例相同', () => {
  const bad = [];
  for (const value of CORPUS) {
    for (const other of ['b', 'c/', '/d', '']) {
      // eslint 风格不作要求：这里只要「同一组输入、两个实现给出同一个答案」
      const want = POSIX.join(value, other);
      const got = paths.join(value, other);
      if (want !== got) bad.push(`${JSON.stringify([value, other])} → node=${JSON.stringify(want)} mine=${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `join 有 ${bad.length} 例不同`);
});

test('resolve：首段绝对时与 node:path.posix 相同，且**不留尾斜杠**', () => {
  const bad = [];
  for (const value of CORPUS) {
    for (const relative of ['a', 'b/', '../c', './d', '']) {
      const base = `/${value.replace(/^\/+/, '')}`;
      const want = POSIX.resolve(base, relative);
      const got = paths.resolve(base, relative);
      if (want !== got) bad.push(`${JSON.stringify([base, relative])} → node=${JSON.stringify(want)} mine=${JSON.stringify(got)}`);
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `resolve 有 ${bad.length} 例不同`);
  // 当年那条具体反例
  assert.equal(paths.resolve('/a', 'b/'), '/a/b');
  assert.equal(paths.resolve('/'), '/');
});

test('resolve 刻意**不**回落 cwd —— 没有绝对段时抛，而不是对着当前目录干活', () => {
  assert.throws(() => paths.resolve('a', 'b'), /no absolute segment/);
  assert.throws(() => paths.resolve('', '.'), /no absolute segment/);
});

test('inside 用字符串前缀比较，且不把「同前缀的兄弟目录」当成内部', () => {
  assert.equal(paths.inside('/a/b', '/a/b'), true);
  assert.equal(paths.inside('/a/b', '/a/b/c.md'), true);
  assert.equal(paths.inside('/a/b', '/a/bc'), false, '/a/bc 不在 /a/b 之内');
  assert.equal(paths.inside('/a/b', '/a'), false);
});
