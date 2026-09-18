// 第 7 期 §9 欠账 ⑤ —— **红测先行**：`spec_sign` / `spec_amend` 的写路径残余窗口。
//
// 第 7 期把 F11 的机制那一半修到了 `spec_write` / `spec_task_set`（`test/write-cas.test.mjs`），
// 但 `spec_sign` 与 `spec_amend` 走的是另一条路：
//
//   appendSignature/applyAmendment → port.writeText(abs, content)
//     → createDshPort 的 `writeText: (abs, content) => writeSpecFile(ctx, abs, content, exec)`
//       ← **第 5 参缺省**，落进「没表态 → 用此刻观测到的版本做基线」那一态
//
// 所以它们**不是**无条件覆盖（仍过 DSH 原生的版本守卫），但
// 「模块读到 `T0` → 写之前观测 `T1`」这个窗口没被兜住：`T0 ≠ T1` 时，
// 基于 `T0` 算出来的新内容会**静默落在 `T1` 上**。这是 F11 的同族，
// 只是窗口从「整段任务时长」缩到「一次调用内」。
//
// 🔴 修法是扩 `@my-harness/spec-analysis` 的 port 契约（跨包），
// 这正是第 7 期把它显式记成欠账、留到后续期的原因。
//
// 注入技法照抄 `write-cas.test.mjs`：monkey-patch `ctx.fs.readText`，在第 N 次读之后
// 让另一个写者插一刀。下标与被测实现的内部读次数耦合，所以每条都配一个计数断言 ——
// 读次数一变，计数先红，用例不会退化成恒真。
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

const DESIGN = '# Design Document\n\n## Overview\n\n> 欠账 ⑤ 用例\n\n## Architecture\n\n串行。\n';
const TASKS = `# Implementation Plan

## Overview

> 欠账 ⑤ 用例

## Tasks

- [ ] 1. 甲
  _Requirements:_ 1

## Notes

> 备注

## Task Dependency Graph

\`\`\`json
{"waves":[{"id":0,"tasks":["1"]}]}
\`\`\`
`;

async function seeded() {
  const root = project();
  const a = mount(root);
  await a.call('spec_init', { goal: 'amend-cas', feature: 'amend-cas' });
  await a.call('spec_write', { file: 'design', content: DESIGN });
  await a.call('spec_write', { file: 'tasks', content: TASKS });
  return { root, a, tasksPath: join(root, '.kiro', 'specs', 'amend-cas', 'tasks.md') };
}

const isRevisionConflict = (error) =>
  error?.code === 'REVISION_CONFLICT' || /REVISION_CONFLICT/.test(String(error?.message ?? ''));

/** 在对 `match` 结尾的文件的第 `nth` 次读之后，让另一个写者插一刀。 */
function interleaveAfterRead(session, { match, nth, inject }) {
  const realReadText = session.ctx.fs.readText;
  const state = { reads: 0, injected: false };
  session.ctx.fs.readText = async (target) => {
    const text = await realReadText(target);
    if (String(target.targetKey).endsWith(match)) {
      state.reads += 1;
      if (state.reads === nth) { inject(text); state.injected = true; }
    }
    return text;
  };
  return state;
}

describe('欠账 ⑤ —— spec_sign / spec_amend 的读-改-写窗口', () => {
  it('spec_sign：读到之后、写之前被改，必须失败而不是把别人的改动静默盖掉', async () => {
    const { a, tasksPath } = await seeded();
    const state = interleaveAfterRead(a, {
      match: 'tasks.md',
      nth: 1,
      inject: (text) => writeFileSync(tasksPath, `${text}\n<!-- 另一个会话插进来的改动 -->\n`),
    });

    await assert.rejects(
      () => a.call('spec_sign', { spec: 'amend-cas', summary: 'design.md：SIGNATURE-MUST-NOT-LAND' }),
      isRevisionConflict,
      'appendSignature 基于它刚读到的那份算出新内容 —— 读完就被改了，必须失败',
    );

    assert.equal(state.injected, true, '注入没发生：读次数变了，本用例已退化成恒真，必须跟着改');
    const final = readFileSync(tasksPath, 'utf8');
    assert.match(final, /另一个会话插进来的改动/, '别人的改动必须还在');
    assert.doesNotMatch(final, /SIGNATURE-MUST-NOT-LAND/, '被拒绝的署名不得落地');
  });

  it('spec_sign：没有并发时照常签（CAS 不许把正常路径也挡掉）', async () => {
    const { a, tasksPath } = await seeded();
    await a.call('spec_sign', { spec: 'amend-cas', summary: 'design.md：正常签名' });
    assert.match(readFileSync(tasksPath, 'utf8'), /正常签名/, '正常路径必须仍然能签');
  });
});

// ---------------------------------------------------------------------------
// 欠账 ⑦ —— `spec_run` 的「plan 时读的 → 完成时写」窗口（与 ⑤ 同族）
//
// `setTaskState` 自己是读-改-写、默认基线是它**刚读到的**那份，所以「读 → 写」这一小段
// 已经被兜住了。没兜住的是更长的那一段：`spec_run` 在 **plan 时**读一次 tasks.md 算出波次，
// 然后派子代理（可能跑很久），**回来才写**。这中间别人改了 tasks.md，
// `setTaskState` 会用**它自己刚读到的新版本**当基线 —— 写入成功，而这次写入所依据的计划
// 是基于一份已经作废的内容算出来的。
//
// 🔴 修法不能是「把 plan 时的基线固定传下去」：`spec_run` 会**连续标多个任务**，
// 第一次写入之后 revision 就变了，固定基线会让第二个 mark 起全部冲突 —— 那是自己撞自己。
// 正确形状是**链式推进**：起点是 plan 时读到的那份，每次自己写成功之后把基线推到自己刚写的
// 那一版。于是「别人改的」被拒、「自己改的」通过。
import { readFileSync as rfs, writeFileSync as wfs } from 'node:fs';
import { fakeSubagents } from './harness.mjs';

const OK = () => ({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] });

describe('欠账 ⑦ —— spec_run 的 plan→mark 窗口', () => {
  const seedRunnable = async (root, subagents) => {
    const m = mount(root, { subagentProvider: 'spawn' }, { subagents });
    await m.call('spec_init', { goal: 'g', feature: 'rn' });
    await m.call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' });
    await m.call('spec_write', {
      file: 'tasks',
      content: `## Task Dependency Graph\n\n\`\`\`json\n{"waves":[{"id":0,"tasks":["1.1"]}]}\n\`\`\`\n\n## Tasks\n\n- [ ] 1.1 a\n`,
    });
    return m;
  };

  it('plan 之后、mark 之前 tasks.md 被别人改了 → 必须报出来，不许静默标状态', async () => {
    const root = project();
    const m = await seedRunnable(root, fakeSubagents(OK));
    const tasksPath = join(root, '.kiro', 'specs', 'rn', 'tasks.md');

    // 子代理跑的时候，另一个写者改了 tasks.md —— 用 fakeSubagents 的回调当「这段时间」。
    const subagents = fakeSubagents(() => {
      wfs(tasksPath, `${rfs(tasksPath, 'utf8')}\n<!-- 另一个会话在子代理跑的时候改的 -->\n`);
      return OK();
    });
    const m2 = mount(root, { subagentProvider: 'spawn' }, { subagents });

    const out = (await m2.call('spec_run', {})).rendered;

    assert.match(out, /REVISION_CONFLICT/,
      'plan 依据的内容已作废，这次标状态必须被拒并报出来（writeFailures 是调用方 MUST see 的那一类）');
    const final = rfs(tasksPath, 'utf8');
    assert.match(final, /另一个会话在子代理跑的时候改的/, '别人的改动必须还在');
    // ⚠️ 注意这里断的是 `[x]` 不是 `[ ]`：`spec_run` 对每个任务 mark **两次** ——
    // 派发前标 `[-]`、完成后标 `[x]`。外部改动发生在子代理运行期间，也就是这两次之间，
    // 所以第一次 `[-]` 是**合法成功**的（那时基线还对得上），被拒的是第二次。
    // 早先这条写成 `- [ ] 1.1`，那是错的 —— 它要求连合法的那次也别落地。
    assert.doesNotMatch(final, /- \[x\] 1\.1 a/, '基于作废计划的完成标记不得落地');
    assert.match(final, /- \[-\] 1\.1 a/, '派发前那次标记发生在改动之前，应当仍在');
    void m;
  });

  it('没有并发时连续标多个任务照常成功（链式基线不许自己撞自己）', async () => {
    const root = project();
    const m = mount(root, { subagentProvider: 'spawn' }, { subagents: fakeSubagents(OK) });
    await m.call('spec_init', { goal: 'g', feature: 'rn2' });
    await m.call('spec_write', { file: 'design', content: '# Design Document\n\n## Overview\n' });
    await m.call('spec_write', {
      file: 'tasks',
      content: `## Task Dependency Graph\n\n\`\`\`json\n{"waves":[{"id":0,"tasks":["1.1","1.2"]}]}\n\`\`\`\n\n## Tasks\n\n- [ ] 1.1 a\n- [ ] 1.2 b\n`,
    });
    const out = (await m.call('spec_run', {})).rendered;
    assert.doesNotMatch(out, /REVISION_CONFLICT/, '自己连续写两次不该撞自己');
    const final = rfs(join(root, '.kiro', 'specs', 'rn2', 'tasks.md'), 'utf8');
    assert.match(final, /- \[x\] 1\.1 a/, '第一个任务应当被标完成');
    assert.match(final, /- \[x\] 1\.2 b/, '第二个任务也应当被标完成 —— 这条就是「自己撞自己」的判别式');
  });
});
