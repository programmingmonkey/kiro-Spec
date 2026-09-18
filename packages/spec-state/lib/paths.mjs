// 纯 posix 路径运算 —— 替代 `node:path`。
//
// 为什么要有它：门槛 1 要求 `packages/spec-state/` 里零 `node:path`，而状态层确实需要
// 拼路径。手法与 `@my-harness/spec-analysis`（`lib/archive.js` 的 `joinPath` / `basename`）
// 一致：包内实现那**几个真正用到的**语义，而不是把整台 `node:path` 包一层。
//
// 🔴 `resolve` 与 `node:path.resolve` 有一处**刻意的不同**：它**不**回落 `process.cwd()`。
// 状态层里每一处 `resolve` 的第一个参数都是绝对路径（`realpath(projectRoot)` 的结果），
// 所以「没有绝对段」只可能是一个错误。回落 cwd 会让这个错误静默地变成「对着当前工作目录
// 干活」—— 而那恰好是 `mcp-server.mjs` 注释里那个「静默地对着错误的目录干活」的坑。
// 这里选择抛出来。

export const sep = '/'

export function isAbsolute(value) {
  return typeof value === 'string' && value.length > 0 && value.charCodeAt(0) === 47;
}

export function normalize(value) {
  if (typeof value !== 'string' || value === '') return '.';
  const absolute = value.charCodeAt(0) === 47;
  const trailing = value.length > 1 && value.endsWith('/');
  const out = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  let result = out.join('/');
  if (absolute) result = `/${result}`;
  if (result === '') result = absolute ? '/' : '.';
  if (trailing && result !== '/') result += '/';
  return result;
}

export function join(...parts) {
  const segments = parts.filter((part) => part !== undefined && part !== null && part !== '');
  if (segments.length === 0) return '.';
  return normalize(segments.map(String).join('/'));
}

/** 从右往左找第一个绝对段作为基准；找不到就抛（见文件头）。 */
export function resolve(...parts) {
  let found = false;
  const collected = [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part === undefined || part === null || part === '') continue;
    const text = String(part);
    collected.unshift(text);
    if (isAbsolute(text)) { found = true; break; }
  }
  if (!found) {
    throw new Error('spec-state paths.resolve: no absolute segment — the state layer never resolves against an implicit cwd');
  }
  // 🔴 与 `node:path.posix.resolve` 的一处**必须照抄**的细节：结果**不留尾斜杠**。
  // 2026-09-13 自审实测（30 万组 fuzz）：不 strip 时有 86926 组与 node 不同 ——
  // 语义差异 0 组（不构成逃逸），但字面值不同就是行为不同。等价性是「零 node:path」
  // 这个门槛的全部依据，任何一处「差不多」都会让它变成一句空话。
  const resolved = normalize(collected.join('/'));
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

export function dirname(value) {
  const text = String(value ?? '');
  if (text === '') return '.';
  const absolute = text.charCodeAt(0) === 47;
  const trimmed = text.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index === -1) return absolute ? '/' : '.';
  if (index === 0) return '/';
  // POSIX 的**双斜杠**：`//x` 的 dirname 是 `//`，不是 `/` —— node:path.posix 照此实现
  // （`hasRoot && end === 1` 那条分支）。2026-09-13 自审 fuzz 实测：缺这一条时有 3148 组不同，
  // 全部是 `//` 开头的路径。实际不可达（`validSpec` 会拒绝 `//` 开头的 spec 名，
  // 因为 `normalize('//a') !== '//a'`），但它同样是等价性缺口。
  if (index === 1 && absolute && text.charCodeAt(1) === 47) return '//';
  return trimmed.slice(0, index);
}

export function basename(value) {
  const trimmed = String(value ?? '').replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** `target` 是否落在 `root` 之内（含 `root` 自身）。用字符串比较，与 `node:path` 一致。 */
export function inside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
}
