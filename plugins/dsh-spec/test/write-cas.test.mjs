// 第 7 期 Task 5 Step 1 —— **红测先行**：F11「并发写丢更新」的原始形态。
//
// F11 的读码记录（`REVIEW-20260910-spec-tools.md`）说得很具体：
// `setTaskState` = 读整个 tasks.md → 改一个字符 → 整文件回写，无锁、无版本守卫，
// 因为 `writeText` 的 `expected` 参数传的是 `undefined`。
// 于是：A 读 → B 读同一版本 → A 写回 → **B 写回（基于旧内容，抹掉 A 的修改）**。
//
// 第 4 期的「已修」是**拿掉并发写者**（删掉子代理自标状态的指令，状态由 runner 独占）——
// 那是流程约定，不是机制。本文件钉的是机制那一半：
//   · 调用方明确断言了基线（`expectedRawRevision`）→ 不匹配即拒绝，不许静默覆盖；
//   · 调用方没断言（`spec_task_set` 自己在内部读-改-写）→ **调用点自己读到的那份**就是基线，
//     所以「读完之后、写之前被别人改了」也必须失败。
//
// 🔴 这两条在修复前都必须是红的。第一条红在「没有这个参数」，第二条红在「读了不算数」。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { cleanup, makeProject, mount } from './harness.mjs';

const roots = [];
const project = () => {
  const root = makeProject();
  roots.push(root);
  return root;
};
after(() => roots.forEach(cleanup));

const DESIGN = '# Design Document\n\n## Overview\n\n> 并发用例\n\n## Architecture\n\n串行。\n';
const TASKS = `# Implementation Plan

## Overview

> 并发用例

## Tasks

- [ ] 1. 甲
  _Requirements:_ 1
- [ ] 2. 乙
  _Requirements:_ 1

## Task Dependency Graph

\`\`\`json
{"waves":[{"id":0,"tasks":["1"]},{"id":1,"tasks":["2"]}]}
\`\`\`
`;

async function seeded() {
  const root = project();
  const a = mount(root);
  await a.call('spec_init', { goal: 'cas', feature: 'cas' });
  await a.call('spec_write', { file: 'design', content: DESIGN });
  await a.call('spec_write', { file: 'tasks', content: TASKS });
  // 第二个会话：与第一个对着同一个项目目录，模型上就是「同一台机器上的另一个会话」。
  const b = mount(root);
  return { root, a, b, tasksPath: join(root, '.kiro', 'specs', 'cas', 'tasks.md') };
}

const isRevisionConflict = (error) =>
  error?.code === 'REVISION_CONFLICT' || /REVISION_CONFLICT/.test(String(error?.message ?? ''));

describe('F11 —— 并发先读后写不得静默抹掉前一个（第 7 期 Task 5）', () => {
  it('两个会话各读一次，后写的那个以 REVISION_CONFLICT 失败', async () => {
    const { a, b, tasksPath } = await seeded();
    const seenA = await a.call('spec_read', { file: 'tasks' });
    const seenB = await b.call('spec_read', { file: 'tasks' });
    assert.equal(typeof seenA.rawRevision, 'string', 'spec_read 必须给出可断言的基线（rawRevision）');
    assert.equal(seenA.rawRevision, seenB.rawRevision, '两个会话读到的是同一版本，前提才成立');

    await a.call('spec_write', {
      file: 'tasks',
      content: `${TASKS}\n<!-- 会话 A 的改动 -->\n`,
      expectedRawRevision: seenA.rawRevision,
    });

    await assert.rejects(
      () => b.call('spec_write', {
        file: 'tasks',
        content: `${TASKS}\n<!-- 会话 B 的改动 -->\n`,
        expectedRawRevision: seenB.rawRevision,
      }),
      isRevisionConflict,
      'B 基于陈旧基线写入 —— 必须失败，而不是把 A 的改动静默抹掉',
    );

    const final = readFileSync(tasksPath, 'utf8');
    assert.match(final, /会话 A 的改动/, 'A 的写入必须还在');
    assert.doesNotMatch(final, /会话 B 的改动/, 'B 的写入必须没有落地');
  });

  it('没传基线时不等于「无条件覆盖」：调用点自己读到的那份就是基线', async () => {
    const { a, tasksPath } = await seeded();
    // 把「读 → 写」之间被别人插进来的一次写入做出来：读之后立刻改盘，模拟另一个会话。
    // 这里**不改** `ctx.fs` 的语义，只是让另一个写者（同一个进程里的直接写）插进去。
    const realReadText = a.ctx.fs.readText;
    // 被拒绝的这条路径上，`spec_task_set` 会读 tasks.md **3 次**（实测）：① 工具前言里的
    // taskStats、② `setTaskState` 自己的读-改-写读、③ CAS 判定时对当前字节的读。
    // 我要的是「② 读完、③ 之前」这一段 —— 那正是 F11 说的窗口。所以注入落在第 2 次读之后。
    // （成功路径上还有第 4 次读，是写入后的 `computeStatus`。）
    // 🔴 这个下标与被测实现的内部读次数耦合：改 `spec_task_set` 的读顺序时它必须一起改，
    // 否则这条用例会退化成恒真（注入落在窗口之外）。读次数一变，下面的计数断言会先红。
    let reads = 0;
    const READ_BEFORE_THE_INTERLEAVE = 2;
    a.ctx.fs.readText = async (target) => {
      const text = await realReadText(target);
      if (String(target.targetKey).endsWith('tasks.md')) {
        reads += 1;
        if (reads === READ_BEFORE_THE_INTERLEAVE) {
          // A 已经把旧内容读进手了；此刻另一个会话把同一份文件改掉。
          writeFileSync(tasksPath, `${text}\n<!-- 另一个会话插进来的改动 -->\n`);
        }
      }
      return text;
    };

    await assert.rejects(
      () => a.call('spec_task_set', { index: '1', state: 'done' }),
      isRevisionConflict,
      'setTaskState 是基于它刚读到的那份做读-改-写的 —— 读完就被改了，它必须失败',
    );

    assert.equal(reads, 3, `被拒绝路径上对 tasks.md 的读次数变了（实测 3 次）。` +
      `注入点（第 ${READ_BEFORE_THE_INTERLEAVE} 次读之后）必须跟着一起改，否则这条用例会静默失效。`);
    const final = readFileSync(tasksPath, 'utf8');
    assert.match(final, /另一个会话插进来的改动/, '别人的改动必须还在');
    assert.match(final, /- \[ \] 1\. 甲/, '被拒绝的勾选不得落地');
  });

  it('基线对得上时照常写入（CAS 不是把正常路径也挡掉）', async () => {
    const { a, tasksPath } = await seeded();
    const seen = await a.call('spec_read', { file: 'tasks' });
    await a.call('spec_write', {
      file: 'tasks',
      content: `${TASKS}\n<!-- 正常写入 -->\n`,
      expectedRawRevision: seen.rawRevision,
    });
    assert.match(readFileSync(tasksPath, 'utf8'), /正常写入/);
  });

  it('`expectedRawRevision: null` 表示「我预期这个文件还不存在」（与共享层同义）', async () => {
    const { a, tasksPath } = await seeded();
    // 文件已存在 → 断言「不存在」必须失败
    await assert.rejects(
      () => a.call('spec_write', { file: 'tasks', content: TASKS, expectedRawRevision: null }),
      isRevisionConflict,
    );
    assert.match(readFileSync(tasksPath, 'utf8'), /- \[ \] 1\. 甲/);
    // 真正不存在的那一份 → 放行。`spec_init` 只脚手架 requirements / design / tasks，
    // 所以 `bugfix.md` 是这一份 spec 里唯一保证不存在的 artifact。
    await a.call('spec_write', { file: 'bugfix', content: '# Bugfix\n', expectedRawRevision: null });
    assert.equal(readFileSync(join(tasksPath, '..', 'bugfix.md'), 'utf8'), '# Bugfix\n');
  });
});
