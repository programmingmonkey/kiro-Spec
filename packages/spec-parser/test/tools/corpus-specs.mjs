// 语料 golden 的清单：**无副作用**，供生成器与测试共同引用。
//
// 单独成一个模块是为了修一个真实的坑：测试原先直接 import 生成器去取这份清单，而生成器顶层
// 就会 measure() 并 writeFileSync 覆盖已入库的 fixtures/corpus-golden.json —— 于是「跑一次回归
// 测试」会悄悄重写「接线前快照」这份证据；一旦宿主漂移，失败形态还会变成 import 期抛错而不是
// 断言失败。清单本身是常量，不该附带任何行为。

export const FEATURE_SPECS = ['dsh-spec-advancement', 'hello-world', 'subagent-model-toggle']

export const BUGFIX_SPECS = ['dsh-spec-hardening', 'dsh-spec-live-fire-fixes']

export const ALL_SPECS = [...FEATURE_SPECS, ...BUGFIX_SPECS]
