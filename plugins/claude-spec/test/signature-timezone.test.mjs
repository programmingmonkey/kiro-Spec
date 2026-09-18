// §4.3.2 署名日期按**声明的**时区盖 —— 钉住 2026-09-18 第 3 条缺陷。
//
// 🔴 缺陷原貌：`todayDate` 固定用 `getFullYear/getMonth/getDate`（本机时区），注释把假设
// 写得很明白：「at UTC+8 an evening edit would be labelled with tomorrow's UTC date」。
// 推理没错，但结论**只在「本机就是 UTC+8」时成立**。实测在 America/Los_Angeles 上，
// 一次会话的 9 条署名全部早了一天 —— 而它服务的仓库明文规定「日期一律取北京时间」。
// 闸门不受影响，坏的是台账：每一条署名的日期都系统性偏一天，且偏得可辨、没人会当场发现。
//
// ⚠️ 本文件**不依赖跑测机器的时区**。判据是「同一个时刻在两个时区下落在不同日期」这件事，
// 由固定的 UTC 时刻构造 —— 否则这条网在 UTC+8 的机器上会恒绿，那正是缺陷的成因本身。

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderSignature, todayDate } from '@my-harness/spec-analysis/signature';
import { createMcpService } from '../lib/mcp/service.mjs';

// 2026-09-18 03:00Z = 北京 11:00（当天）= 洛杉矶前一日 20:00。跨日，且两边都不是 UTC 边界。
const INSTANT = new Date('2026-09-18T03:00:00Z');

test('todayDate：同一时刻在两个时区下是不同的日期', () => {
  assert.equal(todayDate(INSTANT, 'Asia/Shanghai'), '2026-09-18');
  assert.equal(todayDate(INSTANT, 'America/Los_Angeles'), '2026-09-17', '这正是实测里那 9 条署名早一天的成因');
  assert.equal(todayDate(INSTANT, 'UTC'), '2026-09-18');
});

test('不传时区 = 回落本机（未声明的宿主行为逐字不变）', () => {
  const local = `${String(INSTANT.getFullYear()).padStart(4, '0')}-${String(INSTANT.getMonth() + 1).padStart(2, '0')}-${String(INSTANT.getDate()).padStart(2, '0')}`;
  assert.equal(todayDate(INSTANT), local);
  assert.equal(todayDate(INSTANT, undefined), local);
  assert.equal(todayDate(INSTANT, ''), local, '空字符串按「没声明」处理');
});

test('renderSignature 把时区透传下去', () => {
  const line = renderSignature({ env: 'Claude', summary: '改了一处', timeZone: 'Asia/Shanghai' });
  assert.match(line, /^- \d{4}-\d{2}-\d{2} · Claude · 改了一处$/);
});

test('非法时区当场抛，不静默回落本机', () => {
  assert.throws(() => todayDate(INSTANT, 'Nope/Nowhere'), RangeError,
    '静默回落等于把「日期错一天」换个入口再来一遍，而且这次还带着「我已经配过了」的错觉');
});

async function loadWith(signatureTimeZone) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-tz-'));
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), '# Spec conventions\n');
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1,
    specsRoot: '.kiro',
    ...(signatureTimeZone === undefined ? {} : { signatureTimeZone }),
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
  }));
  const { loadAdapter } = await import('../lib/mcp/adapter.mjs');
  return { root, load: () => loadAdapter({ projectRoot: root }) };
}

test('adapter 读得出 signatureTimeZone，未声明时是 null', async () => {
  assert.equal((await (await loadWith('Asia/Shanghai')).load()).signatureTimeZone, 'Asia/Shanghai');
  assert.equal((await (await loadWith(undefined)).load()).signatureTimeZone, null);
});

test('adapter 里写了非法时区 → ADAPTER_INVALID，而不是带着错误配置继续跑', async () => {
  for (const bad of ['Nope/Nowhere', '', 42]) {
    const { load } = await loadWith(bad);
    await assert.rejects(load, (caught) => caught.code === 'ADAPTER_INVALID', `${JSON.stringify(bad)} 没有被拒`);
  }
});

test('端到端：声明了时区，落盘的署名日期按该时区盖', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-spec-tz-e2e-'));
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await mkdir(path.join(root, '.kiro', 'steering'), { recursive: true });
  await writeFile(path.join(root, '.kiro', 'steering', 'spec-conventions.md'), '# Spec conventions\n');
  // 取一个**与本机必然不同**的时区，这样断言在任何机器上都有判别力：
  // 本机若在东半球就用 Pacific/Honolulu（UTC-10），否则用 Pacific/Kiritimati（UTC+14）。
  const zone = new Date().getTimezoneOffset() <= 0 ? 'Pacific/Honolulu' : 'Pacific/Kiritimati';
  await writeFile(path.join(root, '.codex', 'codex-spec.json'), JSON.stringify({
    schemaVersion: 1, specsRoot: '.kiro', signatureTimeZone: zone,
    writePolicy: { mode: 'authorized', allowedPrefixes: ['specs/'] },
    rules: [{ match: ['.kiro/specs/**/*.md'], contextFiles: ['.kiro/steering/spec-conventions.md'] }],
  }));
  const service = await createMcpService({ projectRoot: root, privateDir: path.join(root, '.private') });
  const SPEC = 'specs/demo';
  await service.call('spec_init', { spec: SPEC, workflow: 'design-first' });
  const context = await service.call('spec_context', { spec: SPEC, artifact: 'design' });
  const written = await service.call('spec_write', {
    spec: SPEC, artifact: 'design', content: '# Design Document\n\n## Overview\n\nx\n',
    contextProof: context.contextProof, signature: '新建 design',
  });
  assert.equal(written.code, undefined, `写入失败：${JSON.stringify(written)}`);

  const onDisk = await readFile(path.join(root, '.kiro', 'specs', 'demo', 'design.md'), 'utf8');
  const stamped = /^- (\d{4}-\d{2}-\d{2}) · /m.exec(onDisk);
  assert.ok(stamped, `没找到署名行：\n${onDisk}`);
  assert.equal(stamped[1], todayDate(new Date(), zone), `署名没有按声明的 ${zone} 盖日期`);
});
