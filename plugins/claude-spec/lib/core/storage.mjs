// 第 7 期 Task 3 —— storage 的宿主侧 shim：把 `node:fs` 与 `randomUUID` 绑成 port 注入。
//
// 持久化算法（CAS、同目录原子替换、路径逃逸检查、journal 落盘）住在
// `@my-harness/spec-state/storage`，那里零 `node:fs` / `node:path`。这个文件是
// 「宿主必须自己提供的 I/O 实现」这一层，属 Task 2 边界表的「留 host 适配层」。
//
// 保留同名 `createSpecStorage` 导出，因此 host 既有的 `../lib/core/storage.mjs`
// import 与 storage.test.mjs 的 63 行断言原样不动。

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';

import { createNodeFsPort } from '@my-harness/spec-state/ports';
import { createSpecStorage as createPortStorage } from '@my-harness/spec-state/storage';

const fs = createNodeFsPort(fsp);

export async function createSpecStorage(options) {
  return createPortStorage({ ...options, fs, randomUUID });
}
