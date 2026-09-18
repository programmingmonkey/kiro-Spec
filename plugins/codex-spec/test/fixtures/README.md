# 02A golden fixtures

- `codex-modern-*`：插件默认的现代 canonical 格式，任务 ID 为字符串。
- `kiro-modern-tasks.md`：Kiro 风格任务树；`kiro-legacy-waves.json`：现有 Kiro/DSH 样式的整数 waves 读取兼容输入。
- `dsh-modern-string-id-tasks.md`：DSH 应迁移到的现代输入。当前 `plugins/dsh-spec/lib/index.js` 只接受 `\d+` 并转换为 `Number`，因此该 fixture 对 DSH 是已知预期失败；它不被计为 Codex 02A 阻断项。

这些 fixture 是只读测试资产；不对应任何运行时状态或执行日志。
