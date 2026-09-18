> 🌐 **English** · [中文](spec-conventions.zh-CN.md)

# Spec writing conventions

The hard constraints the diagnoser **will** report. Read this before you write — it is cheaper
than fixing afterwards.

---

## 1. Headings must be pure English

Every top-level `##` section keeps a **pure English** primary heading, with the Chinese subtitle on
the following line in a blockquote:

```
## Overview

> 概述

Body text starts here...
```

`### N.X` subheadings may be entirely in Chinese.

### The headings that must be English

**`requirements.md`**: `# Requirements Document` / `## Introduction` /
`## Glossary` (suggested) / `## Requirements`

**`design.md`**: `# Design Document` / `## Overview` / `## Architecture` /
`## Data Models` / `## Components and Interfaces` /
`## Error Handling` (suggested) / `## Testing Strategy` (suggested) /
`## Correctness Properties` (suggested)

**`tasks.md`**: `# Implementation Plan` / `## Overview` (suggested) /
`## Task Dependency Graph` (**required**) / `## Tasks` (suggested) / `## Notes` (suggested)

⚠️ Matching is by **strict prefix**. `## Requirement` is not `## Requirements`.

---

## 2. The structure of each requirement

```
### 1. <requirement name>

**User Story:** As a <role>, I want <capability>, so that <value>.

#### Acceptance Criteria

1. WHEN <trigger> THEN THE SYSTEM SHALL <behaviour>.
2. IF <condition> THEN THE SYSTEM SHALL <behaviour>.
```

- The requirement heading **starts with a numeric id** (`### 1. xxx`). Do not write `### R1 -`.
- Acceptance criteria use **EARS** phrasing: `WHEN` / `WHILE` / `WHERE` / `IF...THEN` /
  `THE...SHALL`. EARS keywords are **uppercase**.
- Every requirement must have both `**User Story:**` and `#### Acceptance Criteria`.

---

## 3. Correctness Properties (suggested)

```
*For any* <input domain>, <property> holds.

**Validates: Requirements 1.2, 2.1**
```

- Each property **begins the line** with `*For any*` — literally, with italic asterisks,
  **not** `- **For any**`.
- Each carries a `**Validates: Requirements X.Y**` annotation.

---

## 4. Task states — there are only three

| Marker | Meaning |
|---|---|
| `- [ ] N.` | not started |
| `- [-] N.` | in progress |
| `- [x] N.` | done |

**Do not invent a fourth.**

> ⚠️ The reason is **not** "the host doesn't recognise it". In fact the real host *does* recognise
> `[~]` — it is the first-class `queued` state, and Kiro writes it itself. This is **this
> project's convention**: three states only.
> **Don't use "the host doesn't recognise it" as the reason** — that claim is simply false.

**Never leave `[-]` across sessions.** Write it at the moment work truly starts; before finishing,
converge to `[x]` or revert to `- [ ]`.

---

## 5. The task dependency graph (required)

It must be a **valid JSON code block**:

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["3"] }
  ]
}
```

**Three hard requirements. Violate any one and the host discards the entire graph and silently
falls back to fully serial execution** (no error, no warning):

1. `waves` is an **array of objects**, not a bare array `[[1,2],[3]]`;
2. Every wave carries a **numeric** `id` (0-based, consecutive) — a string `"0"` is rejected
   by the check (`typeof === "number"`);
3. Task ids are written as **strings** — `["1","2"]`, not `[1,2]`.

The numeric `id` carries no meaning (the host renumbers by array index), but it must exist and be
a number.

⚠️ The real linter **cannot detect (2) or (3)** (it only asserts that `waves` is a non-empty array).
So the only symptom of getting it wrong is that **parallelism disappears** — a performance problem
that never reports itself.

---

## 6. Verify the spec's stated premises before acting

Specs routinely take "reuse the existing X" as an established fact.

> **Before starting, verify that X actually exists and is in use at the call site.**

Confirming only the *callee* (that a function/type/constant is defined) **does not count** —
"defined but with no callers anywhere" is the most typical shape of this bug.

---

## 7. Lifecycle: a spec is a change snapshot, not a living document

Shipped with no follow-up iteration, superseded by a newer version, or an incomplete skeleton
untouched for more than 30 days — move it to `.kiro/specs/_archive/`.

**Archive by default, do not delete.**
