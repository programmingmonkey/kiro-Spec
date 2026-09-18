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

/** 一个合法的 `allowedPrefixes` 条目：项目相对、以 `/` 结尾的目录。空串是「specsRoot 本身」的哨兵。 */
function isPrefix(prefix) {
  if (prefix === '') return true;
  return typeof prefix === 'string' && prefix.endsWith('/') && isRelativeInside(prefix.replace(/\/$/, ''));
}

/**
 * 写入策略的两种模式（第 6 期 Task 3 定稿）。
 *
 * `evaluation-only` —— 未解锁宿主。只能写 `_eval-codex-YYYYMMDD/` 这类评估目录，
 * 且 `authorityHash` 必须逐字节等于当前 `authorityFile`，对不上就拒绝。
 *
 * `authorized` —— 已解锁宿主（消费项目 §0 现行原文：Kiro / DSH / Codex / Claude Code）。
 * ⚠️ 2026-09-17：这里原写作 `Claude Cowork`。对面同日把 Cowork 通道退役、改登记本地
 * `Claude Code`；本插件那行引文跟着改，以免下一个人拿旧通道名去对账。
 * 注意：这条只影响**引文里的通道名**，不影响 `authorized` 的语义（它判的是 mode，不是宿主名）。
 * 直接写正式的 `.kiro/specs/<feature>/`，不走 `_eval-` 目录。
 *
 * `allowedPrefixes` 在 `authorized` 下**可以省略或为空**，含义是「specsRoot 本身」，
 * 也就是任何正式的 spec 目录。这**不是**「放行一切」：写入仍然被限制在 `specsRoot` 之内
 * （`PATH_OUTSIDE_PROJECT` / `SYMLINK_ESCAPE` 一条都没少），少的只是「正式目录还要不要
 * 先在配置里登记」这一层。之所以必须能表达这个：Task 7 的真实闭环是**新建**一个 spec
 * 目录，逐目录登记的写法会让「新建」变成必须先改配置，而那正是 §0 说的「不受第 2、3 条约束」
 * 要去掉的东西。
 *
 * `authorityFile` / `authorityHash` 在两个模式下都保留，但语义不同：
 *   · evaluation-only —— **闸门**：对不上即 `ADAPTER_UNTRUSTED`。
 *   · authorized      —— **台账**：记录「上次核对过的版本」，**不参与放行判定**。
 * 后者的由来写死在计划的 Task 3 Step 2：authorityFile 指向 Kiro 的 steering 文件，
 * 那份文件每次被 Kiro 改一个错别字 hash 就会变；把它当闸门，插件会在一个与写规格
 * 毫无关系的时间点上突然罢工。漂移事实由 `spec_health` 回报（`authority.status`），
 * 交给人和 hook 去看，而不是让写入路径替他们做决定。
 */
function normaliseWritePolicy(policy) {
  if (!policy || !['evaluation-only', 'authorized'].includes(policy.mode)) {
    throw domainError('ADAPTER_INVALID', 'adapter writePolicy mode is invalid');
  }
  const declared = policy.allowedPrefixes;

  if (policy.mode === 'evaluation-only') {
    if (!Array.isArray(declared) || declared.length === 0 || !declared.every(isPrefix)) {
      throw domainError('ADAPTER_INVALID', 'evaluation-only writePolicy requires a non-empty allowedPrefixes list');
    }
    if (!declared.every((prefix) => /^_eval-codex-\d{8}\/$/.test(prefix))) {
      throw domainError('ADAPTER_INVALID', 'evaluation-only prefixes must be canonical evaluation directories');
    }
    return { mode: policy.mode, allowedPrefixes: declared };
  }

  if (declared === undefined) return { mode: policy.mode, allowedPrefixes: [''] };
  if (!Array.isArray(declared)) throw domainError('ADAPTER_INVALID', 'authorized writePolicy allowedPrefixes must be an array when present');
  if (declared.length === 0) return { mode: policy.mode, allowedPrefixes: [''] };
  if (!declared.every(isPrefix)) {
    throw domainError('ADAPTER_INVALID', 'authorized writePolicy allowedPrefixes entries must be project-relative directories ending in "/"');
  }
  return { mode: policy.mode, allowedPrefixes: declared };
}

/**
 * `authorityFile` 与记录下来的 hash 是否还对得上。**只回报，不抛**：
 * 见 `normaliseWritePolicy` 的注释，这条在 authorized 模式下是台账不是闸门。
 */
async function readAuthorityStatus(project, policy) {
  if (policy.authorityFile === undefined && policy.authorityHash === undefined) return { declared: false };
  if (!isRelativeInside(policy.authorityFile)) {
    return { declared: true, status: 'invalid', detail: 'authorityFile must be a project-relative path' };
  }
  const recordedHash = typeof policy.authorityHash === 'string' ? policy.authorityHash : null;
  let currentHash;
  try {
    currentHash = computeRawRevision(await readFile(path.join(project, policy.authorityFile)));
  } catch (caught) {
    return { declared: true, file: policy.authorityFile, recordedHash, currentHash: null, status: 'unreadable', detail: caught.code ?? caught.message };
  }
  const status = recordedHash === null ? 'unrecorded' : recordedHash === currentHash ? 'matches' : 'drifted';
  return { declared: true, file: policy.authorityFile, recordedHash, currentHash, status };
}

// 🔴 L4 · 共享配置路径（Req 3.1）。**不要**把它「顺手清理」成 `.claude/...`。
//
// 它看起来像 Codex 残留，其实是**跨宿主共享的项目档案**，不是本插件的身份：
//   · `plugins/dsh-spec/lib/index.js` 的 `CODEX_SPEC_CONFIG` 声明的是**同一个**路径
//     —— 一个 **DSH** 宿主插件同样读它，注释原文写着「the same adapter config the Codex CLI
//     side uses」；
//   · 消费项目里已经部署了一份真的（2026-09-12 提交 `c979f3ed`，内容 `mode: "authorized"`、
//     `allowedPrefixes: ["specs/"]`、`specsRoot: ".kiro"`），且它**没有** `.claude/` 目录。
// 改成 `.claude/claude-spec.json` 的后果是实打实的：同一个项目要为两个插件维护两份内容相同的
// 档案，而两个宿主本来就该看同一份 —— 两个仓库里的工具会在读到不同配置时给出不同结论。
//
// 2026-09-17 的改名只换了**文件名**（旧名见下面的兼容读常量），位置与「跨宿主共享」这条判断
// 都没变。旧名由兼容读继续接住，所以已部署的项目（含消费项目那份）不会因为改名而
// ADAPTER_MISSING。取舍与直接后果记在 `.kiro/specs/codex-spec-rename/design.md` 决策点 3。
//
// 这一条属于 Task 2 Step 7「逐处判断」里**判为跨宿主事实**的那一类。三处
// （本文件 / `plugins/codex-spec/lib/mcp/adapter.mjs` / `plugins/dsh-spec/lib/index.js`）
// **必须逐字相同**：test/skeleton.test.mjs 有一条断言把三处钉在一起，就是为了防下一次
// 「看起来很像残留」的清理，或只改两处。
//
// 两个常量都 `export`：跨宿主契约测试要拿它们建夹具与断言来源，而测试文件自己写旧名字面量
// 会把旧名引进替换面（Req 8 的棘轮判红）—— 旧名字面量的唯一落点就是这三份 adapter。
export const CODEX_SPEC_CONFIG = '.codex/codex-spec.json';

// L4 兼容读的**旧**路径（Req 3.2）：只用来读既有项目里已经在的那份档案 —— 不写、不新装、
// 也不出现在安装文档里。它必须是活字面量而不是一段一次性迁移脚本：消费项目那份文件
// 就叫这个名字，改名不许把它变成 ADAPTER_MISSING。
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
 * 两份 adapter（本文件与 `plugins/codex-spec/lib/mcp/adapter.mjs`）的这一条必须**同语义**，
 * 否则同一个坏链接在两个宿主上会给出不同结论。
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
 * 形状照 `packages/spec-state/lib/index.mjs` 的 `legacyStatePath()`（本仓既有先例）。
 *
 * 调用方**显式**给了 `adapterPath` 就照它读（`source: 'explicit'`，不回退）：显式路径是调用方的
 * 决定，不是默认值。两者都不存在时返回新路径，于是错误照旧是既有的 `ADAPTER_MISSING`，
 * 且指向用户真正该放文件的地方（design `## Error Handling`：这一格「行为不变」）。
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

/**
 * `signatureTimeZone` —— §4.3.2 署名日期的基准时区（IANA 名，如 `Asia/Shanghai`）。
 *
 * 🔴 由来（2026-09-18，docs/2026-09-18-claude-spec-plugin-defects.md 第 3 条）。
 * 署名日期原先固定按**本机**时区盖。实测在 America/Los_Angeles 上，一次会话的 9 条署名
 * 全部早了一天 —— 而它服务的仓库明文规定「日期一律取北京时间」。
 *
 * 为什么是显式配置而**不是**自动探测：要的是「这个仓库的基准时区」，那是项目约定，
 * 不是环境事实 —— 机器所在地、CI 的 UTC、贡献者的本地时区，没有一个能推出它。
 *
 * 为什么非法值**抛**而不是回落本机：静默回落等于把「日期错一天」这个缺陷原样换个入口
 * 再来一遍，而且这次还带着一个「我已经配过了」的错觉。
 */
function normaliseSignatureTimeZone(declared) {
  if (declared === undefined || declared === null) return null;
  if (typeof declared !== 'string' || declared.trim() === '') {
    throw domainError('ADAPTER_INVALID', 'signatureTimeZone must be a non-empty IANA time zone name, e.g. "Asia/Shanghai"');
  }
  const zone = declared.trim();
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  } catch {
    throw domainError('ADAPTER_INVALID', `signatureTimeZone is not a time zone this runtime knows: ${JSON.stringify(zone)}`);
  }
  return zone;
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

  const writePolicy = normaliseWritePolicy(adapter.writePolicy);
  // 把规范化结果写回 `adapter.value`：service 与测试读的都是 `writePolicy.allowedPrefixes`，
  // 让「省略即 specsRoot」这件事在读取侧只有一个已归一化的答案，而不是每处各判一次。
  // `rawRevision` 由**原始字节**算出，与这里的改动无关。
  adapter.writePolicy = { ...adapter.writePolicy, mode: writePolicy.mode, allowedPrefixes: writePolicy.allowedPrefixes };

  // evaluation-only 的闸门语义原样保留：authorityFile/authorityHash 必需且必须对上。
  if (writePolicy.mode === 'evaluation-only') {
    if (!isRelativeInside(adapter.writePolicy.authorityFile) || typeof adapter.writePolicy.authorityHash !== 'string') {
      throw domainError('ADAPTER_INVALID', 'evaluation-only policy requires authorityFile and authorityHash');
    }
    const authority = await readFile(path.join(project, adapter.writePolicy.authorityFile));
    if (computeRawRevision(authority) !== adapter.writePolicy.authorityHash) {
      throw domainError('ADAPTER_UNTRUSTED', 'authority file hash does not match writePolicy');
    }
  }

  const rules = Array.isArray(adapter.rules) ? adapter.rules : [];
  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.match) || !Array.isArray(rule.contextFiles) || !rule.contextFiles.every(isRelativeInside)) throw domainError('ADAPTER_INVALID', 'adapter rules are invalid');
    for (const contextFile of rule.contextFiles) {
      const resolved = await realpath(path.join(project, contextFile));
      if (!(resolved === project || resolved.startsWith(`${project}${path.sep}`))) throw domainError('SYMLINK_ESCAPE', 'context file escapes project');
    }
  }
  const validators = Array.isArray(adapter.validators) ? adapter.validators : [];
  if (!validators.every(isKnownValidator)) throw domainError('ADAPTER_INVALID', 'validator profile is not allowed');

  const signatureTimeZone = normaliseSignatureTimeZone(adapter.signatureTimeZone);

  const authority = writePolicy.mode === 'evaluation-only'
    ? { declared: true, file: adapter.writePolicy.authorityFile, recordedHash: adapter.writePolicy.authorityHash, status: 'enforced' }
    : await readAuthorityStatus(project, adapter.writePolicy);

  return {
    projectRoot: project,
    path: canonicalTarget,
    // §4.3.2 署名日期按哪个时区盖。`null` = 未声明，回落本机时区（行为与声明前逐字不变）。
    signatureTimeZone,
    // 读到的是哪一份（Req 3.2 / 3.3）：`primary` = 新路径、`legacy` = 只读回退的旧路径、
    // `explicit` = 调用方显式指定的路径。`adapterPathConflict` 只在「新旧都在、取了新的」时非空。
    adapterPath: selection.relativePath,
    adapterSource: selection.source,
    adapterPathConflict: selection.conflict,
    rawRevision: computeRawRevision(raw),
    value: adapter,
    authority,
  };
}

// 第 7 期 Task 3 —— 这个函数是纯的、且两个 host 逐字节相同，已搬进 `@my-harness/spec-state`。
// 这里保留同名 re-export，既有的调用点与测试不用改。**adapter 加载本身不搬**：两个 host 的
// writePolicy 归一化与 authority 台账是真分叉（probe-07：claude 182 行 / kiro 80 行）。
export { adapterContextFiles } from '@my-harness/spec-state/adapter-context';
