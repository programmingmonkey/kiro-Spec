// 第 7 期 Task 3 —— 本文件是 `@my-harness/spec-state` 的同名 shim。
//
// core/ 的 13 个文件在两个 host 之间逐字节相同（probe-07 `pureAlready`），搬进共享包后
// 这里只留一行 re-export：既消灭了分叉面，又让 host 既有的 `../lib/core/xxx.mjs` import
// 与它们的回归网原样不动。手法与第 4 期 `core/revision.mjs` 变成 spec-revision 的 shim 一致。

export * from '@my-harness/spec-state/core/templates';
