import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createSpecState } from '@my-harness/spec-state';
import { createNodeFsPort } from '@my-harness/spec-state/ports';

import { loadAdapter } from './adapter.mjs';

// 第 7 期 Task 4 —— codex-spec 的 MCP 服务入口，现在是**薄适配层**。
//
// 状态编排（stateEpoch / journal / lease / recovery / CAS / 全部 spec_* 分支）住在
// `@my-harness/spec-state`。这里只提供宿主侧的四样东西：adapter 加载、`node:fs` port、
// 时钟、随机数与进程身份。抽包之前这个文件 804 行，抽包之后是这些。
//
// 刻意**不**在这里做任何状态判断：哪怕一行「顺手补一下」的判断，都会让 codex-spec 与
// claude-spec 重新开始分叉 —— 而消灭这个分叉面正是本期存在的理由。
//
// ⚠️ 唯一的例外是 L3（`codex-spec-rename` 期 Task 7）的**私有状态目录改名 + 旧名只读兼容读**，
// 见下面 `PRIVATE_DIR_NAME` / `LEGACY_PRIVATE_DIR_NAME` / `withLegacyPrivateDirReads()`。
// 它不住在共享包里，是刻意的：Req 4.4 明令本期**不动** `packages/spec-state/**` 的默认值
// （那个字面量还是 claude-spec 的活路径），所以「读旧、写新」只能落在这一层。

const fs = createNodeFsPort(fsp);

/** 私有状态目录的**新名**（Req 4.1）：本期的写入一律落在这里。 */
const PRIVATE_DIR_NAME = '.codex-spec-private';
/**
 * 私有状态目录的**旧名**（Req 4.2 / 4.3）：只被**只读回退**读，从不被写。
 *
 * ⚠️ 这个字面量**不会**因为本期改名而从本仓消失：它同时是 `claude-spec` 的活路径
 * （`plugins/claude-spec/lib/mcp/service.mjs` 显式传的 `privateDirName`）与
 * `packages/spec-state/lib/storage.mjs` 的同名默认值，Req 4.4 明令那两处不动。
 * 所以旧名棘轮（Req 8）要把它登记成「按需求必须保留的落点」，而不是漏改。
 */
const LEGACY_PRIVATE_DIR_NAME = '.kiro-spec-private';

/** 锁的存活探测：`ESRCH` 之外的错误（例如 `EPERM`）都当「还活着」，与原实现一致。 */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (probe) { return probe.code !== 'ESRCH'; }
}

/**
 * 本次服务的两个私有状态目录（绝对路径）：`newDir` 是**写**落点，`legacyDir` 是**只读回退**落点。
 *
 * 调用方显式传 `privateDir` 时（测试与 `fixtures/admission-probe.mjs` 都这么用），
 * 回退落点取**同一父目录**下的旧名 —— 「旧目录是新目录的兄弟」这个形状不因为调用方给了路径而变。
 *
 * 🔴 **`path.resolve()` 不是装饰**（2026-09-17 review 实测）：调用方给的 path 末尾带一个分隔符
 * （`'<root>/.codex-spec-private/'`）时，下面 `legacyPathFor` 的归属判据
 * （未归一化的 `target.startsWith(`${newDir}${sep}`)`）会拼出 `'<root>/.codex-spec-private//'`，
 * **任何一个目标都命中不了** → 回退**静默全灭**（旧目录明明在，却一个字节都不回退），
 * `spec_status` 返回 `phase: undefined`。归一化后「带不带尾分隔符」是同一个目录。
 *
 * 为什么用 `path.resolve` 而不是 `path.normalize`：`privateDir` 的契约是**绝对路径**
 * （`packages/spec-state/lib/storage.mjs` 的 JSDoc 明写），而共享层对相对路径的既有行为就是
 * 「对着当前工作目录干活」（它只对 `projectRoot` 取 `realpath`）。`resolve` 让这里与共享层的
 * **实际锚点**一致，同时把字符串钉成可比较的形式。
 */
function privateDirs({ projectRoot, privateDir }) {
  const newDir = path.resolve(privateDir ?? path.join(projectRoot, PRIVATE_DIR_NAME));
  return { newDir, legacyDir: path.join(path.dirname(newDir), LEGACY_PRIVATE_DIR_NAME) };
}

/**
 * `target` 是否落在一个**锁**路径上 —— 任一路径段以 `.lock` 结尾即算（`state-<slug>.json.lock`、
 * `.lock/owner.json` 都命中）。
 *
 * 🔴 锁**不参与**旧目录回退（2026-09-17 review 实测）：共享层取锁的形状是
 * `mkdir('<statePath>.lock')` + 写 `<statePath>.lock/owner.json`，而「另一个写者还活着吗」
 * 是**靠读那个 owner.json 判出来的**。若 `readFile` 的回退按前缀命中把它也引到旧目录，
 * 那么**新目录里那把锁的活跃性会由另一个目录里的陈旧数据决定** —— 新目录的锁本来没人持有
 * （或持有者早退出了），旧目录里一条陈旧的 `owner.json` 却可以让它一直被当成「有人持有」，
 * 于是共享层那次取锁会一直空转到 `STATE_LOCK_TIMEOUT`。锁是**当下这一刻**的语义，不是历史数据。
 *
 * ⚠️ **这里刻意不写共享层那个取锁函数的内部名字**：`scripts/dependency-declaration.test.mjs`
 * 有一条**按文本**执行的守卫（宿主的生产代码里不得再出现状态编排的特征标识符），
 * 而那条守卫分辨不出注释与代码 —— 一句准确的散文会把它判红（实测踩到过）。
 * 守卫是对的（不许为了让散文好读就放宽它），所以改的是散文：用「共享层那次取锁」指代它。
 *
 * 判据只看 `target` 相对 `newDir` 的那一段（不看绝对路径前缀）：临时目录本身的路径里
 * 万一有 `.lock` 段，不该让整份回退失效。
 */
function isLockPath(target, { newDir }) {
  const relative = path.relative(newDir, path.resolve(target));
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).some((segment) => segment.endsWith('.lock'));
}

/**
 * `target` 在旧目录里的同名兄弟路径；**不在新目录下**（或两个目录本就是同一个）时返回 `undefined`。
 *
 * 归属判据用 `path.relative`（**以 `..` 开头或自身就是绝对路径**即「在外面」），不用
 * `target.startsWith(`${newDir}${sep}`)`：后者对「带尾分隔符的 `newDir`」会静默失配
 * （见 `privateDirs` 的注释），而 `path.relative` 的判据与写法无关。
 *
 * ⚠️ **`relative === ''` 那一格必须保住**：那是 `readdir(newDir)` 自己在问「旧目录里有什么」，
 * journal 的枚举正是走它（`journal.list` 读 `privateRoot` 本身）。把这一格当「在外面」拒掉，
 * Req 4.2 的「读既有 journal」就**只剩文件级回退**，旧目录里的 journal 条目永远枚举不到 ——
 * `plugins/codex-spec/test/legacy-private-dir.test.mjs` 的最后一条用例正是钉这件事的。
 *
 * `legacyDir === newDir` 那一支是必要的：显式 `privateDir` 恰好就是旧名时（
 * `fixtures/admission-probe.mjs` 正是这么传的），回退会指向自己 ——
 * 那时读回退等于把同一次失败重试一遍，`readdir` 回退还会**把自己列两遍**。
 */
function legacyPathFor(target, { newDir, legacyDir }) {
  if (legacyDir === newDir) return undefined;
  const relative = path.relative(newDir, path.resolve(target));
  if (relative !== '' && (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))) return undefined;
  return path.join(legacyDir, relative);
}

/**
 * L3 兼容读（Req 4.2 / 4.3）：**新目录优先，旧目录只读回退**。
 *
 * 手法照 `@my-harness/spec-state` 既有的 `legacyStatePath()`（`packages/spec-state/lib/index.mjs`：
 * `statePath(spec)` 先读、捕 `ENOENT`、再读 `legacyStatePath(spec)`，两次都 `ENOENT` 才算「没有」）
 * —— 同一形状，只是把「文件级的 slug 回退」在**目录级**再走一遍：新目录里没有的那个**文件**，
 * 去旧目录里按同名读。
 *
 * 为什么落在这一层：`getState` / `putState` / journal 编排都住在共享包里，而 Req 4.4 不许本期动
 * 那个包的默认值。共享包已经把 fs 做成**注入的 port**，所以「读旧、写新」可以整个在这一层表达，
 * 不必往共享包里加「新旧目录」这个它不该有的概念。
 *
 * 🔴 只包**读**原语（`readFile` / `readdir`）：写路径（`writeFile` / `open` / `rename` / `mkdir` /
 * `unlink` / `rmdir`）与 `stat` / `realpath` 原样透传 —— 于是「旧目录只读」是**结构上的**保证，
 * 不靠纪律：这个 port 根本没有把写映射到旧目录的通路。
 * （`stat` 不包也不是遗漏：状态层对私有目录只 `stat` 锁目录，而那发生在 `mkdir` 已成功之后。）
 *
 * 🔴 回退面**限定在状态 / journal 语义面**：**锁路径不回退**（判据见 `isLockPath`）。
 * 「新目录里的那个文件不在 → 去旧目录里按同名读」这条规则对*状态与 journal*成立，对*锁*不成立 ——
 * 锁说的是「此刻有没有别的写者」，把它的活跃判据接到另一个目录的陈旧 `owner.json` 上，
 * 会让共享层那次取锁空转到 `STATE_LOCK_TIMEOUT`（2026-09-17 review 实测）。
 * 所以那是**刻意的缩小**，不是「顺手少做一点」。
 *
 * `readdir` 的回退粒度是**条目**而不是目录：新目录里已有的名字以新目录为准，旧目录里多出来的名字
 * 补进来。这不是「顺手多做一点」，而是 Req 4.2 要求读「既有 journal」的唯一可行做法 —— journal 的
 * 枚举走 `readdir(privateRoot)`，而任何一次取锁（共享包用 `mkdir` 取锁）都会先建出新目录，
 * 若按「新目录存在就整份不回退」判，旧目录里的 journal 条目**永远不会**被枚举到，Req 4.2 的
 * 「读既有 journal」就成了死代码。文件级的 `legacyStatePath()` 正是同一条语义：回退只**补空**，
 * 不覆盖（同名以新目录为准）。
 *
 * 旧目录读不到时的口径：`ENOENT`（旧目录不存在）当「没有旧目录」；**其余错误一律抛出** ——
 * 一个读不到的旧目录报成「旧目录里没有东西」，正是 Req 4.3 明令不许的「静默降级成无历史」。
 */
function withLegacyPrivateDirReads(base, dirs) {
  /** 旧目录里的同名条目；无回退面时是 `undefined`。 */
  const legacyOf = (target) => legacyPathFor(target, dirs);
  return {
    ...base,
    async readFile(target, ...rest) {
      try {
        return await base.readFile(target, ...rest);
      } catch (caught) {
        // 锁路径不回退（见文件头那段「回退面限定在状态 / journal 语义面」与 `isLockPath`）：
        // 锁的活跃判据不许由另一个目录里的陈旧数据决定。
        const legacy = isLockPath(target, dirs) ? undefined : legacyOf(target);
        if (caught?.code !== 'ENOENT' || legacy === undefined) throw caught;
        return base.readFile(legacy, ...rest);
      }
    },
    async readdir(target, options) {
      const legacy = legacyOf(target);
      if (legacy === undefined) return base.readdir(target, options);
      let current;
      try {
        current = await base.readdir(target, options);
      } catch (caught) {
        // 新目录还不存在：整份回退到旧目录（此时旧目录也 `ENOENT` 就照原样抛）。
        if (caught?.code !== 'ENOENT') throw caught;
        return base.readdir(legacy, options);
      }
      let previous;
      try {
        previous = await base.readdir(legacy, options);
      } catch (caught) {
        if (caught?.code === 'ENOENT') return current;
        throw caught;
      }
      const nameOf = (entry) => (typeof entry === 'string' ? entry : entry.name);
      const seen = new Set((current ?? []).map(nameOf));
      return [...(current ?? []), ...(previous ?? []).filter((entry) => !seen.has(nameOf(entry)))];
    }
  };
}

/** 列一个目录的条目名；**目录不存在返回 `null`** —— 「不存在」与「空目录」必须分得开。
 *  只读（`readdir`），不创建任何东西 —— `spec_health` 必须保持只读。 */
async function listDirNames(dir) {
  try {
    const entries = await fs.readdir(dir);
    return (entries ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.name));
  } catch (caught) {
    if (caught?.code === 'ENOENT') return null;
    throw caught;
  }
}

/**
 * 私有状态目录的**有效来源**（Req 4.3）：判据是「旧目录是否仍是**有效**来源」，不是
 * 「新目录存在吗」。
 *
 * 🔴 为什么不能用「新目录存在吗」（2026-09-17 review 实测）：任何一次**写**都会先
 * `mkdir` 出新目录（`packages/spec-state/lib/index.mjs` 里「落状态」与「取锁」两条路径都在动手之前 mkdir，
 * 都在建锁之前 mkdir），所以一次写之后这个信号就**永久消失** —— 而数据**仍然读自旧目录**。
 * 那是一个**一次性信号**，不是「有效来源」的回报。
 *
 * 现在的判据（三层）：旧目录不在 → 不报；旧目录在而新目录不在 → 报；两个都在时，
 * 旧目录**持有至少一个新目录没有的条目**才报。于是「一次写之后」仍报 —— 新目录里刚多出
 * 的那几个名字是**新的**，旧目录里那些老条目依然是新目录里没有的。
 *
 * 三点理由（与旧实现相同，判据变了但形状没变）：
 *
 * ① Req 4.3 要求的是「不静默降级成无历史」，`stateDirSource` 是有事要说的信号，不是常驻字段；
 * ② 它只在 codex-spec 这一侧存在（claude-spec 的目录名按 Req 4.4 本期不动、也就没有「旧名」可言），
 *    常驻字段会让 `spec_health` 多出一个 claude-spec 没有的键 —— 而两宿主的 `spec_health` 是被
 *    `scripts/snapshot-07.mjs` **逐步对拍**的（`spec_health` 正是「已知有意差异」的所在地）。
 *    多出来的键会被那条网判成**漂移**，而它背后的 golden 属排除面（冻结），修不回来；
 * ③ 两个都有且**同名条目一一对应**时「以新目录为准」（`readFile` 只在 `ENOENT` 时回退、
 *    `readdir` 同名以新为准），这个事实由上面那条 port 的形状表达，不靠一个只说来源的字段去暗示。
 *
 * ⚠️ 三条不能破的断言（`plugins/codex-spec/test/legacy-private-dir.test.mjs` 逐条钉住）：
 * 只有旧目录 → `legacy`；只有新目录 → **不报**；两个都有且同名 → **不报**。
 */
async function stateDirSourceReport({ newDir, legacyDir }) {
  if (legacyDir === newDir) return {};
  const legacyNames = await listDirNames(legacyDir);
  if (legacyNames === null) return {};
  const newNames = await listDirNames(newDir);
  if (newNames === null) return { stateDirSource: 'legacy' };
  const alreadyInNewDir = new Set(newNames);
  return legacyNames.some((name) => !alreadyInNewDir.has(name)) ? { stateDirSource: 'legacy' } : {};
}

export async function createMcpService({ projectRoot, privateDir, adapterPath, now = () => Date.now(), fault = async () => {} }) {
  const dirs = privateDirs({ projectRoot, privateDir });
  return createSpecState({
    projectRoot,
    // `privateDir` **显式**给出（即使调用方没传）：下面那个 port 与来源回报都按这**同一个字符串**
    // 判定「哪些路径属于新目录」，而共享层内部还会对 `projectRoot` 自己取一次 realpath。
    // 把字符串钉在一处，回退映射才不会因为两条路径写法不同而**静默失效**（失效的样子是
    // 「旧目录明明在，却一个字节都没回退」—— 最难看出来的那一种）。
    privateDir: dirs.newDir,
    adapterPath,
    privateDirName: PRIVATE_DIR_NAME,
    loadAdapter,
    fs: withLegacyPrivateDirReads(fs, dirs),
    now,
    randomUUID,
    pid: () => process.pid,
    isAlive,
    fault,
    // 宿主插槽（共享层那段注释就写着 codex-spec 该往 `health` 里加自己的字段）：
    // 共享层没有「新旧目录」这个概念，所以来源回报放这里，不放共享层。
    hooks: { health: () => stateDirSourceReport(dirs) }
  });
}
