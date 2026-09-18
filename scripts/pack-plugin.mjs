#!/usr/bin/env node
// 把一个 plugin 打成可安装的 `.plugin`（zip），并把 workspace 依赖 vendor 进去。
//
// 🔴 **为什么必须有这个脚本**：2026-09-13 实测到一次真实事故 —— 装在 Cowork 里的
// claude-spec 是**抽包前**的旧 build（包里 `lib/core/revision.mjs` 仍是 4376 字节的完整实现，
// 而源码已经是 1000 字节的 re-export），于是「真机复验」验的是旧代码，却被记成了通过。
// 手工打包没有任何东西会在产物与源码漂开时报出来 —— 这正是本仓库反复要消灭的形态。
//
// 所以本脚本除了打包，还做两件**会红**的事：
//   ① `--check`：产物里每个文件与当前源码逐字节比对，不一致即非零退出；
//   ② 打包后自检：产物里不得残留任何裸 `@my-harness/` specifier，且每个改写后的相对路径
//      必须真的存在。漏 vendor 一个包，装上去就是 ERR_MODULE_NOT_FOUND。
//
// 用法：
//   node scripts/pack-plugin.mjs claude-spec [--out <path>]
//   node scripts/pack-plugin.mjs claude-spec --check    # 只比对，不写盘
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@my-harness/'
// 不进产物：测试、依赖树、运行时状态。test/ 是开发资产；node_modules 由 vendor/ 取代。
//
// `.claude/` 是**运行时状态**：gate 的心跳与审计日志（`observability.mjs` 写完就覆盖/追加），
// 仓库根与 plugin 根两层都被 `.gitignore` 忽略。不排除它就会被**装进产物** —— 2026-09-17 清库时
// 实测到 `dist/claude-spec-23417df.plugin` 里躺着
// `plugins/claude-spec/.claude/claude-spec-gate.heartbeat`：本机在这棵树里跑一次 gate 就会重建
// 那个文件，于是「源码被本机运行时污染 ⇒ 产物逐字节比对随时变红」，而它 ship 给宿主的是
// 一个只对打包那台机器有意义的日志。
//
// 按**目录名**在任意深度匹配（`collectFiles` 用 `EXCLUDE.has(entry)`）。`--check` 也走这里，
// 所以「旧产物里带着 .claude/」仍然会被判成「产物里多出 X」并红——这条网没有被这一行削弱。
const EXCLUDE = new Set(['node_modules', 'test', '.claude'])

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** 收集 plugin 的 @my-harness 依赖闭包（含传递依赖）。 */
function closure(pluginDir) {
  const seen = new Map()
  const visit = (name) => {
    if (seen.has(name)) return
    const dir = path.join(REPO, 'packages', name.slice(SCOPE.length))
    if (!existsSync(dir)) throw new Error(`pack-plugin: 找不到 workspace 包 ${name}（期望 ${dir}）`)
    const pkg = readJson(path.join(dir, 'package.json'))
    seen.set(name, { dir, pkg })
    for (const dep of Object.keys(pkg.dependencies ?? {})) if (dep.startsWith(SCOPE)) visit(dep)
  }
  for (const dep of Object.keys(readJson(path.join(pluginDir, 'package.json')).dependencies ?? {})) {
    if (dep.startsWith(SCOPE)) visit(dep)
  }
  return seen
}

/** exports 子路径 → vendor 里的落点。整个 lib/ 都拷，避免漏掉内部相对 import。 */
//
// 2026-09-13 · 第 7 期：`@my-harness/spec-state` 的 `./core/*` 是**通配导出**，
// 而代码里 import 的是具体的 `core/analysis`、`core/revision`…… 只登记一条
// `@my-harness/spec-state/core/*` 匹配不上任何真实 specifier，11 个 import 会全部报
// 「没被 vendor 覆盖」。所以通配项要按**目录里的实际文件**展开成一条条具体导出。
//
// 落点必须与下面拷 `lib/` 时用的相对路径**一致**（`vendor/<short>/<lib 下的相对路径>`）：
// 早先这里用的是 `path.basename(target)`，对 spec-state 会撞名 —— `lib/index.mjs` 与
// `lib/core/index.mjs` 的 basename 都是 `index.mjs`。
function vendorTarget(short, target) {
  const rel = path.posix.normalize(target).replace(/^\.\//, '')
  const underLib = rel.startsWith('lib/') ? rel.slice('lib/'.length) : path.basename(rel)
  return `vendor/${short}/${underLib}`
}

function vendorMap(name, { dir, pkg }) {
  const short = name.slice(SCOPE.length)
  const map = new Map()
  for (const [sub, target] of Object.entries(pkg.exports ?? { '.': pkg.main })) {
    if (typeof target !== 'string') continue
    if (sub.includes('*')) {
      const star = target.indexOf('*')
      if (star === -1) continue
      const prefix = target.slice(0, star)
      const suffix = target.slice(star + 1)
      // `prefix` 以 `/` 结尾（`./lib/core/`），它本身就是一个目录名。不能对它用
      // `path.dirname()` —— 那个函数会丢掉最后一段（`./lib/core/` → `./lib`）。
      const scanDir = path.join(dir, prefix)
      if (!existsSync(scanDir)) continue
      for (const entry of readdirSync(scanDir)) {
        if (!entry.endsWith(suffix)) continue
        const stem = entry.slice(0, entry.length - suffix.length)
        const spec = `${name}/${sub.replace(/^\.\//, '').replace('*', stem)}`
        map.set(spec, vendorTarget(short, path.posix.join(prefix, entry)))
      }
      continue
    }
    map.set(sub === '.' ? name : `${name}/${sub.replace(/^\.\//, '')}`, vendorTarget(short, target))
  }
  return { short, dir, map }
}

function collectFiles(root, base = '') {
  const out = []
  for (const entry of readdirSync(path.join(root, base))) {
    if (EXCLUDE.has(entry)) continue
    const rel = base ? `${base}/${entry}` : entry
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...collectFiles(root, rel))
    else out.push(rel)
  }
  return out
}

// 一个**带版本号**的 `@my-harness/x@1.2.3` 不是 module specifier，是身份字符串
// （目前唯一的用例：`packages/spec-state` 的 `STATE_LAYER` —— 真机 build 判别式）。
// 本仓库的 import 一律走 workspace 协议，specifier 里**永远不带 `@version`**，
// 所以「包名后面紧跟 @」是可靠的判别。
//
// 🔴 为什么必须显式排除，而不是让它撞进 `missing`：两种错法都很坏，且都不响。
//   ① 若它落进 vendorMap（比如哪天真有同名 key），会被**改写成相对路径** ——
//      装上去之后 `spec_health` 报的「状态层身份」就变成 `./vendor/spec-state/index.mjs`，
//      一个看起来正常、实际在撒谎的判别式，比没有判别式更糟；
//   ② 若它落进 `missing`，打包直接失败（本次实测就是这样），把一个纯粹的
//      字符串问题报成「装上去会 ERR_MODULE_NOT_FOUND」。
const IDENTITY_STRING = /^@my-harness\/[^/]+@/

function rewrite(source, fromRel, specToVendor) {
  let missing = []
  const out = source.replace(/(['"])(@my-harness\/[^'"]+)\1/g, (whole, q, spec) => {
    if (IDENTITY_STRING.test(spec)) return whole
    const target = specToVendor.get(spec)
    if (!target) { missing.push(spec); return whole }
    let rel = path.posix.relative(path.posix.dirname(fromRel), target)
    if (!rel.startsWith('.')) rel = `./${rel}`
    return `${q}${rel}${q}`
  })
  return { out, missing }
}

function build(pluginName) {
  const pluginDir = path.join(REPO, 'plugins', pluginName)
  if (!existsSync(pluginDir)) throw new Error(`pack-plugin: 没有这个 plugin：${pluginDir}`)
  const deps = closure(pluginDir)
  const specToVendor = new Map()
  const vendors = []
  for (const [name, info] of deps) {
    const v = vendorMap(name, info)
    vendors.push(v)
    for (const [spec, target] of v.map) specToVendor.set(spec, target)
  }

  /** @type {Map<string,Buffer|string>} 产物相对路径 → 内容 */
  const files = new Map()
  const missingAll = []

  for (const rel of collectFiles(pluginDir)) {
    const abs = path.join(pluginDir, rel)
    // 🔴 只改写 .mjs / .js。**不要**碰 package.json（它的 dependencies 键本来就是包名，
    // 改写会把依赖声明毁掉）、也不要碰 .md（文档里提到包名是正当的）。
    // 第一版把 json/md/sh 一起改写，自检当场抓到 `package.json → @my-harness/spec-analysis`——
    // 那不是漏 vendor，是改写面开太宽。
    if (/\.(mjs|js)$/.test(rel)) {
      const { out, missing } = rewrite(readFileSync(abs, 'utf8'), rel, specToVendor)
      missingAll.push(...missing.map((m) => `${rel} → ${m}`))
      files.set(rel, out)
    } else files.set(rel, readFileSync(abs))
  }

  for (const { short, dir } of vendors) {
    for (const rel of collectFiles(path.join(dir, 'lib'))) {
      const target = `vendor/${short}/${rel}`
      const { out, missing } = rewrite(readFileSync(path.join(dir, 'lib', rel), 'utf8'), target, specToVendor)
      missingAll.push(...missing.map((m) => `${target} → ${m}`))
      files.set(target, out)
    }
    // exports 里可能有 lib 之外的资源（如 declared-diffs.json）
    const pkg = readJson(path.join(dir, 'package.json'))
    for (const t of Object.values(pkg.exports ?? {})) {
      if (typeof t !== 'string' || t.startsWith('./lib/')) continue
      const src = path.join(dir, t)
      if (existsSync(src)) files.set(`vendor/${short}/${path.basename(t)}`, readFileSync(src))
    }
  }

  // ── 逃出 plugin 根的相对 import：一并 vendor 进来 ──
  // 实测（2026-09-13）：`scripts/gen-rules.mjs` import 了 `../../../scripts/consumer-root.mjs`,
  // 那是**仓库级**脚本、不在 plugin 树里。旧产物原样收了这个文件，于是包里躺着一条**指向包外的
  // 死 import** —— 一直没炸只是因为装好的插件从不调它。既然打包，就不该产出装不起来的文件。
  for (const [rel, content] of [...files]) {
    if (!/\.(mjs|js)$/.test(rel) || typeof content !== 'string') continue
    let next = content
    for (const m of content.matchAll(/from\s+(['"])(\.[^'"]+)\1/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2]))
      if (!resolved.startsWith('../')) continue // 没逃出去
      const src = path.resolve(pluginDir, path.dirname(rel), m[2])
      if (!existsSync(src)) throw new Error(`pack-plugin: ${rel} 引用了不存在的 ${m[2]}`)
      const target = `vendor/_repo/${path.basename(src)}`
      files.set(target, readFileSync(src, 'utf8'))
      let relTo = path.posix.relative(path.posix.dirname(rel), target)
      if (!relTo.startsWith('.')) relTo = `./${relTo}`
      next = next.split(m[2]).join(relTo)
    }
    if (next !== content) files.set(rel, next)
  }

  // ── 自检 ①：不得残留裸 specifier ──
  if (missingAll.length) {
    throw new Error(`pack-plugin: 有 ${missingAll.length} 个 @my-harness specifier 没被 vendor 覆盖，装上去就是 ERR_MODULE_NOT_FOUND：\n  ` + missingAll.join('\n  '))
  }
  // ── 自检 ②：改写后的相对路径必须真的存在 ──
  const broken = []
  for (const [rel, content] of files) {
    if (!/\.(mjs|js)$/.test(rel) || typeof content !== 'string') continue
    for (const m of content.matchAll(/from\s+(['"])(\.[^'"]+)\1/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2]))
      if (!files.has(target)) broken.push(`${rel} → ${m[2]}`)
    }
  }
  if (broken.length) throw new Error(`pack-plugin: ${broken.length} 处相对 import 指向产物里不存在的文件：\n  ` + broken.join('\n  '))

  // ── package.json 剪枝：只留产物里真实成立的声称（见 pruneManifest 上方那段） ──
  if (files.has('package.json')) {
    const { text, dropped } = pruneManifest(files.get('package.json').toString('utf8'), files)
    files.set('package.json', text)
    if (dropped.length) console.error(`   package.json 剪掉 ${dropped.length} 条不成立的 script：${dropped.join('；')}`)
  }

  return files
}

// ── 产物的 package.json 只许描述**产物里真实存在的东西** ──
//
// 🔴 由来是一次实测（2026-09-14）。`EXCLUDE` 第 26 行就写着「test/ 是开发资产，不进产物」——
// 但 `package.json` 是**原样拷**进去的，于是产物里躺着一句
// `"test": "node --test test/**/*.test.mjs"`：**明知没 ship 测试，却把「我有测试」这句话打了进去。**
// 后果实测到三处：
//   ① `pnpm -r test` 里 `plugins/codex-spec-dist` 报 `# tests 0 / # pass 0 / # fail 0`，
//      整条命令 `exit=0` —— 一个跑了 0 个测试然后说通过的包，正是本仓库最恨的形状；
//   ② 在产物目录里跑 `npm run check`（它的 INSTALL.md 文案里就有这个词）直接
//      `MODULE_NOT_FOUND: test/artifact-schema-adapter.test.mjs`；
//   ③ `@my-harness/*` 依赖已经被 vendor 进 `vendor/`，`dependencies` 里却还留着
//      `workspace:*` —— 在 workspace 之外 `npm install` 必炸。
//
// 一条规则，三处一起适用：**声称的东西必须在包里**。
//   · scripts —— 命令里点名的文件不在产物里，这条 script 就删掉（`npm run x` 递归跟进）；
//   · devDependencies —— 它们只为 `test/` 存在，而 `test/` 不进产物；
//   · dependencies 里的 `@my-harness/*` —— 已经被 vendor 取代（自检①保证产物里
//     不残留任何裸 specifier），留着就是一句不成立的声称。
//
// ⚠️ 注意这里**不是**改写 specifier。第 145 行那条「不要碰 package.json」说的是
// 不许把 `@my-harness/spec-state` 改写成 `./vendor/...`（那会毁掉依赖声明的语义）。
// 删掉一个已经不成立的键，与把它改写成一个撒谎的值，是两件相反的事。
const PATHISH = /\.(mjs|js|cjs|json|sh|ts)$/

/** 一条 script 命令里点名的「文件路径」token（跳过 flag 与裸命令名）。 */
function pathClaims(cmd) {
  return cmd
    .split(/[\s;&|]+/)
    .filter((t) => t && !t.startsWith('-') && PATHISH.test(t))
    .map((t) => t.replace(/^\.\//, ''))
}

/** 这条 script 通过 `npm run x` / `npm test` 依赖的其它 script 名。 */
function scriptRefs(cmd) {
  const out = []
  for (const m of cmd.matchAll(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/g)) out.push(m[1])
  return out
}

/** 产物里是否存在这个路径（支持 `test/*.test.mjs` 这种 glob：看目录下有没有文件）。 */
function claimSatisfied(claim, files) {
  if (!claim.includes('*')) return files.has(claim)
  const dir = claim.slice(0, claim.lastIndexOf('/') + 1)
  for (const rel of files.keys()) if (rel.startsWith(dir)) return true
  return false
}

function pruneManifest(text, files) {
  const pkg = JSON.parse(text)

  delete pkg.devDependencies
  if (pkg.dependencies) {
    for (const dep of Object.keys(pkg.dependencies)) if (dep.startsWith(SCOPE)) delete pkg.dependencies[dep]
    if (!Object.keys(pkg.dependencies).length) delete pkg.dependencies
  }

  const dropped = []
  if (pkg.scripts) {
    // 不动点迭代：`doctor = npm run check && npm test`，`test` 被删之后 `doctor` 也必须删 ——
    // 一条指向已删 script 的 script，跑起来同样是「说有、其实没有」。
    for (;;) {
      let changed = false
      for (const [name, cmd] of Object.entries(pkg.scripts)) {
        const missing = pathClaims(cmd).filter((c) => !claimSatisfied(c, files))
        const deadRef = scriptRefs(cmd).filter((r) => r !== name && !(r in pkg.scripts))
        if (missing.length || deadRef.length) {
          dropped.push(`${name}（${[...missing, ...deadRef.map((r) => `npm run ${r}`)].join('、')} 不在产物里）`)
          delete pkg.scripts[name]
          changed = true
        }
      }
      if (!changed) break
    }
    if (!Object.keys(pkg.scripts).length) delete pkg.scripts
  }

  // ── 自检③：剪完之后不许再有任何一条 script 点名产物里没有的文件 ──
  // 没有这条，上面的不动点写错一个条件就会静默放过 —— 而那正是本次要修的病本身。
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const claim of pathClaims(cmd)) {
      if (!claimSatisfied(claim, files)) {
        throw new Error(`pack-plugin: 剪枝后 script "${name}" 仍然点名了产物里没有的 ${claim} —— 剪枝逻辑漏了`)
      }
    }
  }

  return { text: `${JSON.stringify(pkg, null, 2)}\n`, dropped }
}

// 🔴 需要可执行位的产物文件。由来是一次真实事故（2026-09-14）：
// `hooks.json` 里 `type: "command"` 指向 `scripts/spec-stage-gate.sh`，而这份脚本
// 从**第一笔提交起**（`d011932`，git 记的就是 `100644`）就没有可执行位，打包器也从不设模式 ——
// 于是装到宿主里也是 `0644`。同一个容器里**所有能正常工作的 hook 脚本都是 `0755`**。
//
// ⚠️ 此前我把它排除过，理由是「所有归档都一样，包括第 6 期那个能响的 `78b16cf`，
// 所以它是常量不是变量」。**那个推理是错的**：常量只能排除它作为「变化的那个量」，
// 排除不了它作为「一直就错、而现在才致命的前提」。宿主换一种拉起方式
// （`sh <path>` → 直接 `exec`），一个一直缺的可执行位就会从无害变成致命。
const EXECUTABLE = new Set(['scripts/spec-stage-gate.sh'])

function writeZip(files, outPath) {
  const stage = mkdtempSync(path.join(tmpdir(), 'pack-plugin-'))
  for (const [rel, content] of files) {
    const abs = path.join(stage, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, EXECUTABLE.has(rel) ? { mode: 0o755 } : undefined)
    // `writeFileSync` 的 mode 只在**新建**时生效；stage 是新建的临时目录，所以够用。
    // 但显式 chmod 一次，免得将来有人改成复用目录时这里静默失效。
    if (EXECUTABLE.has(rel)) chmodSync(abs, 0o755)
  }
  // 🔴 **在 stage 的临时目录里打包，再整份拷到目标路径。**
  // 直接 `zip <目标>` 在只读/受限挂载上会失败得很难看：zip 先写临时文件再 rename，
  // rename 与 unlink 都可能被拒，结果是留下一个 0 字节的目标文件 + 一个游离的临时文件
  // （2026-09-13 实测踩到）。临时目录里没有这个限制。
  //
  // 🔴 暂存 zip 的路径必须**既唯一、又在被压目录之外**：
  //   · **唯一** —— 同一时刻可能有另一个打包器在跑。`node --test` 默认并行跑测试文件，
  //     而 `pack-plugin.test.mjs` 与 `dist-drift.test.mjs` 都会打同一个 plugin。
  //   · **在 stage 之外** —— `zip -rq . ` 会把 stage 里的 zip 自己一起压进去。
  // 原先它写在 `path.dirname(stage)`（即**共享的** tmpdir）里、文件名只取 outPath 的
  // basename。2026-09-16 实测：5 个并发打同一个 plugin，1 个崩在
  // `cpSync(built, outPath)`，`ENOENT ... /T/codex-spec.plugin.build` —— 另一个实例的
  // `rmSync` 把它的产物删了。后果是**假红**：而 `dist-drift` 的失败消息会指挥人去
  // `rm -rf` 重解包一个本来完好的 dist。给每个调用一个自己的输出暂存目录即可。
  const outStage = mkdtempSync(path.join(tmpdir(), 'pack-plugin-out-'))
  const built = path.join(outStage, path.basename(outPath))
  execFileSync('zip', ['-rq', built, '.'], { cwd: stage })

  mkdirSync(path.dirname(outPath), { recursive: true })
  if (existsSync(outPath)) {
    // 已存在就换名，不覆盖：覆盖失败会留下 0 字节文件，而那比报错更难查。
    throw new Error(`pack-plugin: ${outPath} 已存在。换一个 --out，或先删掉它 —— ` +
      `不覆盖是有意的：覆盖失败会留下一个 0 字节的包，装上去只会报一堆无关的错。`)
  }
  cpSync(built, outPath)
  rmSync(outStage, { recursive: true, force: true })
  rmSync(stage, { recursive: true, force: true })
}

const [, , pluginName, ...rest] = process.argv
if (!pluginName) { console.error('用法：node scripts/pack-plugin.mjs <plugin 名> [--out <path>] [--check]'); process.exit(2) }
const checkOnly = rest.includes('--check')
const outIdx = rest.indexOf('--out')
// 默认文件名带 commit 短 sha：固定名字会让「装的是哪一版」无从对证 —— 2026-09-13 那次
// 「真机复验验的是旧 build」正是这么发生的。
let sha = 'nogit'
try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() } catch { /* 非 git 树 */ }
const outPath = outIdx >= 0 ? path.resolve(rest[outIdx + 1]) : path.join(REPO, 'dist', `${pluginName}-${sha}.plugin`)

let files
try { files = build(pluginName) } catch (e) { console.error('❌ ' + e.message); process.exit(1) }

if (checkOnly) {
  if (!existsSync(outPath)) { console.error(`❌ 产物不存在：${outPath} —— 没打过包，不是「通过」`); process.exit(1) }
  const { execFileSync: run } = await import('node:child_process')
  const listing = run('unzip', ['-Z1', outPath], { encoding: 'utf8' }).split('\n').filter((n) => n && !n.endsWith('/'))
  const diffs = []
  for (const [rel, content] of files) {
    if (!listing.includes(rel)) { diffs.push(`产物里缺 ${rel}`); continue }
    const actual = run('unzip', ['-p', outPath, rel])
    const expect = Buffer.isBuffer(content) ? content : Buffer.from(content)
    if (!actual.equals(expect)) diffs.push(`${rel} 与源码不一致（产物 ${actual.length}B / 源码 ${expect.length}B）`)
  }
  for (const rel of listing) if (!files.has(rel)) diffs.push(`产物里多出 ${rel}`)
  if (diffs.length) {
    console.error(`❌ 产物与源码已经漂开（${diffs.length} 处）——装上去跑的不是当前代码：\n  ` + diffs.join('\n  '))
    process.exit(1)
  }
  console.log(`✅ ${path.basename(outPath)} 与当前源码逐字节一致（${files.size} 个文件）`)
} else {
  writeZip(files, outPath)
  console.log(`✅ 打包完成：${outPath}`)
  console.log(`   ${files.size} 个文件，vendor 了 ${[...new Set([...files.keys()].filter((k) => k.startsWith('vendor/')).map((k) => k.split('/')[1]))].join(' / ')}`)
}
