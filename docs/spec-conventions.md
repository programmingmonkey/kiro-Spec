> 🌐 **中文** · [English](spec-conventions.en.md)

# Spec 写作约定

诊断器**会**报出来的硬约束。写之前先看这一篇，比写完再改便宜。

---

## 1. 标题必须是纯英文

每个 `##` 顶层 section 的英文主标题**保持纯英文**，中文副标题写在下一行的引用块里：

```
## Overview

> 概述

正文从这里开始...
```

`### N.X` 子标题允许全中文。

### 必须英文的标题清单

**`requirements.md`**：`# Requirements Document` / `## Introduction` /
`## Glossary`（建议） / `## Requirements`

**`design.md`**：`# Design Document` / `## Overview` / `## Architecture` /
`## Data Models` / `## Components and Interfaces` /
`## Error Handling`（建议） / `## Testing Strategy`（建议） / `## Correctness Properties`（建议）

**`tasks.md`**：`# Implementation Plan` / `## Overview`（建议） /
`## Task Dependency Graph`（**必须**） / `## Tasks`（建议） / `## Notes`（建议）

⚠️ 匹配是**严格前缀**。`## Requirement` 不是 `## Requirements`。

---

## 2. 每条需求的结构

```
### 1. <需求名>

**User Story:** As a <角色>, I want <能力>, so that <价值>.

#### Acceptance Criteria

1. WHEN <触发> THEN THE SYSTEM SHALL <行为>.
2. IF <条件> THEN THE SYSTEM SHALL <行为>.
```

- 需求标题**以数字 ID 开头**（`### 1. xxx`）。不要写 `### R1 -`。
- 验收条目用 **EARS 句式**：`WHEN` / `WHILE` / `WHERE` / `IF...THEN` / `THE...SHALL`。
  EARS 是**大写**的。
- 每条 Requirement 必须同时有 `**User Story:**` 与 `#### Acceptance Criteria` 两个子结构。

---

## 3. Correctness Properties（建议）

```
*For any* <输入域>, <性质> 成立.

**Validates: Requirements 1.2, 2.1**
```

- 每条属性**行首**是 `*For any*`（是的，用斜体星号，**不是** `- **For any**`）。
- 带 `**Validates: Requirements X.Y**` 标注。

---

## 4. 任务三态 —— 只有三个

| 标记 | 含义 |
|---|---|
| `- [ ] N.` | 未开始 |
| `- [-] N.` | 进行中 |
| `- [x] N.` | 已完成 |

**不要发明第四种。**

> ⚠️ 理由**不是**「宿主不认」—— 事实上真机**认** `[~]`，它是 `queued` 的一等状态，
> Kiro 自己会写它。这是**本项目的约定**：只认三态。
> **别拿「宿主不认」当理由** —— 那是个不成立的说法。

**不许跨会话留 `[-]`。** 只在真正开工那一刻打，收工前必须收敛成 `[x]` 或退回 `- [ ]`。

---

## 5. 任务依赖图（必须）

必须是**合法 JSON 代码块**：

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["3"] }
  ]
}
```

**三处硬要求，违反任意一处宿主会丢弃整张图并静默回退成完全串行**
（无报错、无提示）：

1. `waves` 是**对象数组**，不是裸数组 `[[1,2],[3]]`；
2. 每个 wave 带**数字** `id`（0 起连续）——写字符串 `"0"` 会被校验拒绝（`typeof === "number"`）；
3. 任务 id 写成**字符串** —— `["1","2"]`，不是 `[1,2]`。

`id` 的数值不承载语义（真机按数组下标重编号），但必须存在且是数字。

⚠️ 真机 linter **查不出 ② ③**（它只断言 `waves` 是非空数组）。
所以写错的唯一症状是**并行度消失** —— 一个不会报错的性能问题。

---

## 6. 执行前核实 spec 的既有前提

spec 经常以「沿用现有 X / 复用已有 Y」作为前提并当成既成事实。

> **动手前必须核实那个 X 在调用端真实存在且在用。**

只确认被调用方（函数/类型/常量有定义）**不算** —— 定义在那儿而没有任何调用者，
是这类 bug 最典型的形态。

---

## 7. 生命周期：spec 是变更快照，不是活文档

已发版且无后续迭代的、被新版取代的、或残缺骨架超 30 天未动的 ——
移进 `.kiro/specs/_archive/`。

**默认归档，不删除。**
