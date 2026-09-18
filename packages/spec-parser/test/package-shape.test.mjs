// 包的形状契约：零 runtime 依赖、exports 齐全、两个共享文件只有一个方向的依赖。
//
// 这三条都是「实现遵守了但没人守」的典型：一个反向 import 会重新造出互相依赖，一个
// `dependencies` 字段会让「零依赖」变成一句空话 —— 而两者都不会让任何功能测试变红。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const TASK_FORMAT = readFileSync(join(PACKAGE_ROOT, 'lib', 'task-format.js'), 'utf8')
const SCAN_LINES = readFileSync(join(PACKAGE_ROOT, 'lib', 'scan-lines.js'), 'utf8')

describe('零 runtime 依赖（Requirement 1.2）', () => {
  it('package.json 不含 dependencies 字段', () => {
    assert.equal(
      'dependencies' in MANIFEST,
      false,
      '本包是三宿主无条件复用的纯函数层，加任何依赖都会让它不再是「零依赖」',
    )
  })

  it('lib/ 下不导入 node:fs 与 node:path', () => {
    for (const [name, source] of [
      ['task-format.js', TASK_FORMAT],
      ['scan-lines.js', SCAN_LINES],
    ]) {
      assert.equal(/from\s+['"]node:fs['"]/.test(source), false, `${name} 导入了 node:fs`)
      assert.equal(/from\s+['"]node:path['"]/.test(source), false, `${name} 导入了 node:path`)
    }
  })
})

describe('exports 齐全（Requirement 4.3）', () => {
  it('"." 与 "./scan-lines" 与 "./declared-diffs.json" 都在，且指向真实文件', () => {
    const expected = {
      '.': './lib/task-format.js',
      './scan-lines': './lib/scan-lines.js',
      './declared-diffs.json': './declared-diffs.json',
    }
    for (const [key, target] of Object.entries(expected)) {
      assert.equal(MANIFEST.exports[key], target, `exports["${key}"]`)
      assert.doesNotThrow(() => readFileSync(join(PACKAGE_ROOT, target), 'utf8'), `${target} 不存在`)
    }
  })
})

describe('两个共享文件只有一个方向的依赖（Requirement 1.3）', () => {
  it('scan-lines.js 导入 task-format.js（正向）', () => {
    assert.match(SCAN_LINES, /from\s+['"]\.\/task-format\.js['"]/)
  })

  it('task-format.js **不**导入 scan-lines.js（反向不存在）', () => {
    assert.equal(
      /from\s+['"]\.\/scan-lines\.js['"]/.test(TASK_FORMAT),
      false,
      '反向 import 会让两个文件互相依赖，「识别层 / 扫描层」的分层与串行前提同时破产',
    )
  })
})
