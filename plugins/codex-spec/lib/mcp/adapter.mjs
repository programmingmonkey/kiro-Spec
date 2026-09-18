import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { computeRawRevision } from '../core/revision.mjs';

function domainError(code, message, details = {}) { return Object.assign(new Error(message), { code, details }); }

// 已知 validator 表（第 3.6 期 Task 0.1）。
//
// 🔴 这是**白名单**，不是校验开关。放宽它是为了允许第二条 validator（`spec-validator`），
// 不是为了允许任意 profile 注入——前者加一行，后者删掉整段检查，两者只差一行。
// 所以形状写成「id 与 profile 必须命中同一张已知表」，而不是「不校验」。
//
// `typeof` 守卫不是多余的：只写 `KNOWN_VALIDATORS[v.id] === v.profile` 时，
// 两个 `undefined` 会相等，于是 `{}` 这样的空条目也会被放进来。
const KNOWN_VALIDATORS = Object.freeze({
  'spec-tasks-lint': 'kiro-spec/spec-tasks-lint-v1',
  'spec-validator': 'kiro-spec/kiro-rules-v1',
});

function isKnownValidator(validator) {
  if (typeof validator?.id !== 'string' || typeof validator.profile !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(KNOWN_VALIDATORS, validator.id)) return false;
  return KNOWN_VALIDATORS[validator.id] === validator.profile;
}

function isRelativeInside(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes('..');
}

function isPrefix(prefix) {
  if (prefix === '') return true;
  return typeof prefix === 'string' && prefix.endsWith('/') && isRelativeInside(prefix.replace(/\/$/, ''));
}

function normaliseWritePolicy(policy) {
  if (!policy || !['evaluation-only', 'authorized'].includes(policy.mode)) {
    throw domainError('ADAPTER_INVALID', 'adapter writePolicy mode is invalid');
  }
  const declared = policy.allowedPrefixes;
  if (policy.mode === 'evaluation-only') {
    if (!Array.isArray(declared) || declared.length === 0 || !declared.every(isPrefix) || !declared.every((prefix) => /^_eval-codex-\d{8}\/$/.test(prefix))) {
      throw domainError('ADAPTER_INVALID', 'evaluation-only writePolicy requires canonical evaluation prefixes');
    }
    return { mode: policy.mode, allowedPrefixes: declared };
  }
  if (declared === undefined || (Array.isArray(declared) && declared.length === 0)) return { mode: policy.mode, allowedPrefixes: [''] };
  if (!Array.isArray(declared) || !declared.every(isPrefix)) {
    throw domainError('ADAPTER_INVALID', 'authorized writePolicy allowedPrefixes must be project-relative directories ending in "/"');
  }
  return { mode: policy.mode, allowedPrefixes: declared };
}

// 🔴 L4 · 共享配置路径（Req 3.1）。三个宿主插件 —— 本文件、`plugins/claude-spec/lib/mcp/adapter.mjs`、
// `plugins/dsh-spec/lib/index.js` —— 声明的必须是**同一个默认路径**，且三处字符串逐字相同。
// `plugins/claude-spec/test/skeleton.test.mjs` 有一条断言把这三处钉在一起：改这里就得同时改那两处，
// 否则当场判红。
//
// 为什么名字里带 codex 而 claude-spec / dsh-spec 也读它：它是**跨宿主共享的项目档案**，
// 不是某个插件的身份。2026-09-17 的改名把它从 `.codex/kiro-spec.json` 改成
// `.codex/codex-spec.json` —— **跟随既有的 `<宿主>-spec` 命名约定、改动面最小**。
// 中立名（例 `.codex/spec-adapter.json`）被否，理由是它要连带改动一个已落盘、已进版本管理的路径；
// 直接后果是 `claude-spec` 会去读一个以 codex 命名的文件。取舍与后果记在
// `.kiro/specs/codex-spec-rename/design.md` 决策点 3。
//
// 两个常量都 `export`：跨宿主契约测试要拿它们建夹具与断言来源，而测试文件自己写旧名字面量会
// 把旧名引进替换面（Req 8 的棘轮判红）。旧名字面量的唯一落点就是这三份 adapter。
export const CODEX_SPEC_CONFIG = '.codex/codex-spec.json';
export const LEGACY_CODEX_SPEC_CONFIG = '.codex/kiro-spec.json';

/**
 * 这个路径**作为一个目录项在场**吗（判据是 `lstat`，不是「能不能解析到目标」）。
 *
 * 🔴 为什么不能用 `realpath` 当存在判据（2026-09-17 review 实测的静默失效）：
 * `.codex/codex-spec.json` 是一个**坏掉的符号链接**（dangling symlink）时 `realpath` 给
 * `ENOENT`，于是「新路径不存在」→ 静默回退去读**旧**档案，`specsRoot` 与 `writePolicy`
 * （`allowedPrefixes` 决定哪些目录可写）**一起换源**，而 `adapterPathConflict` 仍是 `null`
 * —— 调用方眼里「一切正常」。这不是「新路径优先、旧路径兜底」，是**新路径被跳过**。
 *
 * 改成「在场」之后，坏掉的新路径**以它为准** → 后面那次 `realpath` 抛 `ENOENT` → 报既有的
 * `ADAPTER_MISSING`，且**点名新路径**。方向与 `resolveAdapterTarget` 的「新路径优先」一致：
 * 在场即优先，坏掉就报错，**不降级**。
 *
 * 非 `ENOENT` 的错误照原样抛，不吞。
 */
async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (caught) {
    if (caught.code === 'ENOENT') return false;
    throw caught;
  }
}

/**
 * 选要读的那份档案 —— **新路径优先、旧路径只读回退、两者都在要报冲突**（Req 3.2 / 3.3）。
 * 形状与本仓既有先例一致：`packages/spec-state/lib/index.mjs` 的 `legacyStatePath()`。
 *
 * 调用方**显式**给了 `adapterPath` 就照它读（`source: 'explicit'`，不回退）：显式路径是调用方的
 * 决定，不是默认值 —— 回退只属于「用默认值」那条路。两者都不存在时返回新路径，
 * 于是错误照旧是既有的 `ADAPTER_MISSING`，且指向用户真正该放文件的地方（Req/design「行为不变」）。
 *
 * 「存在」的判据是**目录项在场**（见上面 `exists`）：新路径是一个坏掉的符号链接时它照样**在场**，
 * 于是走 `primary` 那一支 → 后面 `realpath` 报 `ADAPTER_MISSING`。若此时旧档案也在场，
 * `conflict` 仍会被报出来（两份都在场是事实）—— 但**绝不去读旧那份**。
 */
async function resolveAdapterTarget(project, adapterPath) {
  if (adapterPath !== undefined) return { relativePath: adapterPath, source: 'explicit', conflict: null };
  const primaryExists = await exists(path.resolve(project, CODEX_SPEC_CONFIG));
  const legacyExists = await exists(path.resolve(project, LEGACY_CODEX_SPEC_CONFIG));
  if (primaryExists) {
    return {
      relativePath: CODEX_SPEC_CONFIG,
      source: 'primary',
      // 两者都在 → 以新为准，但**把冲突说出来**（Req 3.3）：静默取其一，读者会以为另一份不存在。
      conflict: legacyExists ? { primary: CODEX_SPEC_CONFIG, legacy: LEGACY_CODEX_SPEC_CONFIG, took: 'primary' } : null,
    };
  }
  if (legacyExists) return { relativePath: LEGACY_CODEX_SPEC_CONFIG, source: 'legacy', conflict: null };
  return { relativePath: CODEX_SPEC_CONFIG, source: 'primary', conflict: null };
}

export async function loadAdapter({ projectRoot, adapterPath }) {
  if (adapterPath !== undefined && !isRelativeInside(adapterPath)) throw domainError('ADAPTER_INVALID', 'adapter path must be a project-relative path');
  const project = await realpath(projectRoot);
  // 变量名故意不叫 `resolved`：下面 rules 循环里有一个同名的 `const resolved`（context file 的
  // realpath 结果），同名会让人误以为这里被循环改过。
  const selection = await resolveAdapterTarget(project, adapterPath);
  const target = path.resolve(project, selection.relativePath);
  if (!target.startsWith(`${project}${path.sep}`)) throw domainError('ADAPTER_INVALID', 'adapter path escapes project');
  let canonicalTarget;
  try {
    canonicalTarget = await realpath(target);
  } catch (caught) {
    if (caught.code === 'ENOENT') {
      throw domainError(
        'ADAPTER_MISSING',
        `adapter is missing at ${selection.relativePath}; copy adapter.example.json and replace its project-specific values`,
        { adapterPath: selection.relativePath, examplePath: 'adapter.example.json' }
      );
    }
    throw caught;
  }
  if (!canonicalTarget.startsWith(`${project}${path.sep}`)) throw domainError('SYMLINK_ESCAPE', 'adapter path escapes project');
  const raw = await readFile(canonicalTarget);
  let adapter;
  try { adapter = JSON.parse(raw); } catch { throw domainError('ADAPTER_INVALID', 'adapter is not valid JSON'); }
  if (adapter?.schemaVersion !== 1 || !isRelativeInside(adapter.specsRoot)) throw domainError('ADAPTER_INVALID', 'adapter schemaVersion/specsRoot is invalid');
  const policy = normaliseWritePolicy(adapter.writePolicy);
  adapter.writePolicy = { ...adapter.writePolicy, ...policy };
  const rules = Array.isArray(adapter.rules) ? adapter.rules : [];
  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.match) || !Array.isArray(rule.contextFiles) || !rule.contextFiles.every(isRelativeInside)) throw domainError('ADAPTER_INVALID', 'adapter rules are invalid');
    for (const contextFile of rule.contextFiles) {
      const resolved = await realpath(path.join(project, contextFile));
      if (!(resolved === project || resolved.startsWith(`${project}${path.sep}`))) throw domainError('SYMLINK_ESCAPE', 'context file escapes project');
    }
  }
  if (policy.mode === 'evaluation-only') {
    if (!isRelativeInside(adapter.writePolicy.authorityFile) || typeof adapter.writePolicy.authorityHash !== 'string') throw domainError('ADAPTER_INVALID', 'evaluation-only policy requires authorityFile and authorityHash');
    const authority = await readFile(path.join(project, adapter.writePolicy.authorityFile));
    if (computeRawRevision(authority) !== adapter.writePolicy.authorityHash) throw domainError('ADAPTER_UNTRUSTED', 'authority file hash does not match writePolicy');
  }
  const validators = Array.isArray(adapter.validators) ? adapter.validators : [];
  if (!validators.every(isKnownValidator)) throw domainError('ADAPTER_INVALID', 'validator profile is not allowed');
  return {
    projectRoot: project,
    path: canonicalTarget,
    // 读到的是哪一份（Req 3.2 / 3.3）：`primary` = 新路径、`legacy` = 只读回退的旧路径、
    // `explicit` = 调用方显式指定的路径。`adapterPathConflict` 只在「新旧都在、取了新的」时非空。
    adapterPath: selection.relativePath,
    adapterSource: selection.source,
    adapterPathConflict: selection.conflict,
    rawRevision: computeRawRevision(raw),
    value: adapter,
  };
}

// 第 7 期 Task 3 —— 这个函数是纯的、且两个 host 逐字节相同，已搬进 `@my-harness/spec-state`。
// 这里保留同名 re-export，既有的调用点与测试不用改。**adapter 加载本身不搬**：两个 host 的
// writePolicy 归一化与 authority 台账是真分叉（probe-07：claude 182 行 / kiro 80 行）。
export { adapterContextFiles } from '@my-harness/spec-state/adapter-context';
