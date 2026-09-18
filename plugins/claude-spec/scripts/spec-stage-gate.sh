#!/bin/sh
# claude-spec —— 阶段门控的 node 存在性闸门（hooks.json 直接调这个文件）。
#
# 为什么包一层 sh 而不是让 hooks.json 直接调 `node`：
# 会话容器里有没有 node、是哪一版，第 6 期 Task 2 Step 6 把它列为**未测**的 ⟨待测⟩ 槽位
# （不许按本机或 Codex 侧的情况推断）。如果宿主找不到 `node`，直接调 node 的 hook 会
# 以一个含义不明的失败告终 —— 宿主怎么处理「hook 执行失败」没有文档，那是一个我们控制不了的
# 未知数。这一层把那个未知数换成一个明确的、可见的 **fail-open**：
# 门控放行，并在 stderr 上说明为什么。
#
# 口径与 spec-stage-gate.mjs 头部一致：这是 collaborative 约定，不是硬护栏；
# 静默失效不可接受，堵死正常工作同样不可接受。
if ! command -v node >/dev/null 2>&1; then
  echo "claude-spec stage gate: 容器里找不到 node —— 门控放行（fail-open）。" >&2
  echo "claude-spec stage gate: 阶段门控这次没有生效；MCP 侧同样起不来，先解决 node 再谈门控。" >&2
  exit 0
fi

# `dirname "$0"` 而不是 `${CLAUDE_PLUGIN_ROOT}`：后者在 hook 环境里实测存在
# （第 5 期探针记录了 pluginRoot 字段），但用脚本自身位置更少一层假设 ——
# 这一层存在的意义就是减少假设。
exec node "$(dirname "$0")/spec-stage-gate.mjs"
