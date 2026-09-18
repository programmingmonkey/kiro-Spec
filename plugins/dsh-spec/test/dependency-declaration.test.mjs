// dsh-spec — dsh-tools 依赖声明的守卫。
//
// 这四条守的都是**已经真实发生过**的失效，不是假想风险：
//
//  ① devDependency 必须是精确版本。
//     `@deepseek-ai/dsh-tools` 的 dist-tags 是
//       latest = 0.0.1-rc.1   alpha = 0.1.5-alpha.2   next = 0.1.5-rc.2
//     `latest` 指着一个很旧的版本。任何范围写法或一次不带版本的
//     `npm i @deepseek-ai/dsh-tools`，都会**成功地**装上 0.0.1-rc.1 且不报错。
//
//  ② 实际安装的版本必须等于声明的版本。
//     2026-09-12 之前，插件测试用的是 <DSH_DIR> 里 9 月 3 日遗留的
//     0.1.2-rc.1 副本，而宿主运行的是 0.1.5-alpha.2 —— 两者不是同一实例，
//     且没有任何东西会报告这件事。
//
//  ③ peer 范围必须真的匹配实际安装的版本。
//     原声明 `>=0.1.0-rc.6` 同时排除了 0.1.2-rc.1（当时链着的）和
//     0.1.5-alpha.2（宿主跑的）—— node-semver 的预发布比较符只接受**同一
//     [major,minor,patch] 元组**的预发布版。于是 pnpm 的 auto-install-peers
//     选中了 `maxSatisfying` = 0.1.0-rc.8，静默装进第三份实例。
//     后来一度改成 `"*"`，同样不匹配任何预发布版（`*` 不吃 prerelease）。
//     本条用 semver 真库判定，不手写比较 —— 手写预发布规则正是上面两次踩坑的成因。
//
// 本文件不校验 dsh-tools 的**内容**，只校验声明与安装事实是否自洽。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = '@deepseek-ai/dsh-tools'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const pkg = readJson(resolve(HERE, '..', 'package.json'))

// 安装事实。缺失即失败而非跳过：没有它，下面三条一条都证明不了，
// 而"静默跳过"恰是本仓库反复要消灭的形态。
function installedVersion() {
  const p = resolve(HERE, '..', 'node_modules', PKG_NAME, 'package.json')
  let json
  try {
    json = readJson(p)
  } catch (e) {
    assert.fail(
      `读不到已安装的 ${PKG_NAME}（${p}）：${e.code ?? e.message}\n` +
      '先跑 `pnpm install`；本测试断言的是声明与安装事实的一致性，缺了安装事实就无从断言。',
    )
  }
  return json.version
}

test('① devDependency 必须钉精确版本，不得使用范围', () => {
  const spec = pkg.devDependencies?.[PKG_NAME]
  assert.ok(spec, `devDependencies 里缺 ${PKG_NAME}`)
  assert.match(
    spec,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `期望精确版本，实际 ${JSON.stringify(spec)}。` +
    '范围写法会让 npm/pnpm 有机会落到 dist-tag `latest`（= 0.0.1-rc.1）。',
  )
})

test('② 实际安装的版本必须等于声明的版本', () => {
  const declared = pkg.devDependencies[PKG_NAME]
  const installed = installedVersion()
  // 本条以 ① 为前提。声明不是精确版本时做等值比较只会给出误导性消息
  // （"声明 ^1.2.3，实际安装 1.2.3" —— 而那个安装版本其实是对的），
  // 所以此处直接指回根因，不假装是版本不符。
  assert.match(
    declared,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `devDependency ${JSON.stringify(declared)} 不是精确版本，无从做等值比较 —— 根因见 ①。`,
  )
  assert.equal(
    installed,
    declared,
    `声明 ${declared}，实际安装 ${installed} —— 存在第二份实例或解析被替换。`,
  )
})

test('③ peer 范围必须真的匹配实际安装的版本', () => {
  const range = pkg.peerDependencies?.[PKG_NAME]
  assert.ok(range, `peerDependencies 里缺 ${PKG_NAME}`)
  const installed = installedVersion()
  assert.ok(
    semver.satisfies(installed, range),
    `peer 范围 ${JSON.stringify(range)} 不匹配实际安装的 ${installed}。\n` +
    'node-semver 的预发布规则：带 prerelease 的比较符只接受同一 [major,minor,patch] ' +
    '元组的 prerelease。宿主升到下一个 alpha（如 0.1.6-alpha.1）时本条会红 —— ' +
    '这是预期行为，届时同步 range，不要放宽成 `*`（`*` 不匹配任何 prerelease）。',
  )
})

//  ④ 发布形态必须是「明确不发布」。
//     本包依赖 `@my-harness/kiro-rules: workspace:*`，而那个包是 private 的。
//     `workspace:` 协议 **npm 不改写** —— 2026-09-12 实测：`npm pack` 出来的
//     package.json 原样带 `workspace:*`，在 workspace 外 `npm install` 报
//     `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`。
//     所以把 private 去掉、或把只服务于打包的字段加回来，等于让这个装不上的
//     形态重新看起来是可发布的。决定与理由见 INSTALL.md 的安装一节。
//
//     ⚠️ 2026-09-18 订正前提（**结论不变**）：INSTALL.md 此前写「本包不发布」，
//     那句已被更正 —— `scripts/pack-plugin.mjs` 会把 workspace 依赖 vendor 进归档，
//     所以**有**一条可分发路径（方式 A）。但这**不改变本条断言的理由**：
//     那条路走的是打包器，不是 `npm pack`；`workspace:` 协议的报错依然成立，
//     而打包器**不读 `files`** —— 于是 `files` 仍是一个**没有任何东西会校验的声称**，
//     正是本仓在别处反复拒绝的形态。分发的真实形状由打包器与它的测试定义。
test('④ 发布形态：不发布 —— private 为 true，且无发布态字段', () => {
  assert.equal(
    pkg.private,
    true,
    'dsh-spec 依赖 private 的 workspace 包；去掉 private 会让「可发布」这个假象回来。',
  )
  for (const field of ['files', 'keywords']) {
    assert.equal(
      pkg[field],
      undefined,
      `"${field}" 只服务于打包/发布；本包不发布（见 INSTALL.md），留着是误导。`,
    )
  }
})
