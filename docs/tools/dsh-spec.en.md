> 🌐 [中文](dsh-spec.md) · **English**

# `dsh-spec` tool reference

The DeepSeek Harness (cordis plugin) host. **13 tools + 1 `/spec` command.**

- Form: a cordis plugin mounted into a DSH profile (see
  [../en/dsh-spec/INSTALL.md](../en/dsh-spec/INSTALL.md))
- How it differs from the other two hosts: the smallest tool surface, and it has a command
  surface (`/spec`); no MCP schema-validation layer

---

## 1. Starting and adopting

### `spec_init`

Start a Kiro-style spec.

> Start a Kiro-style spec. kind: `'feature'` (requirements-first by default), `'bugfix'`
> (bugfix.md), or `'quick'` (no approval gates). feature supports the `'design-first'` workflow
> and detailLevel.

| Parameter | Required | Meaning |
|---|---|---|
| `goal` | ✅ | High-level goal, seeded into the requirements introduction |
| `kind` | | `feature` (default) \| `bugfix` \| `quick` |
| `workflow` | | feature only: `requirements-first` (default) \| `design-first` |
| `detailLevel` | | design-first only: `high` (default) \| `low` |
| `feature` | | explicitly name the spec directory |

**The four shapes and their ordering:**

| Shape | Order | First artifact | Approval gate |
|---|---|---|---|
| `feature` (requirements-first) | requirements → design → tasks | `requirements.md` | yes |
| `feature` (design-first) | design → requirements (derived) → tasks | `design.md` | yes |
| `bugfix` | analysis → design → tasks | `bugfix.md` (current/expected/unchanged) | yes |
| `quick` | all three at once | all three | no |

---

## 2. Writing

### `spec_write`

Write (create or overwrite) one spec file. **Enforces workflow-aware stage order**:
bugfix goes `bugfix.md → design → tasks`; feature goes `requirements → design → tasks`.

### `spec_read`

Read one spec file; when `file` is `'status'` (the default), read the overall status.

### `spec_amend`

The **incremental correction channel** for a frozen spec — change one thing without resending the
whole body.

| `kind` | Semantics |
|---|---|
| `param` | edit a parameter value **in place** via `from`/`to` (`from` must match exactly once) |
| `requirement` | append a requirement, numbered after the current maximum |
| `design` | append a `## Amendments` entry and insert a pointer after the anchor line |
| `archive` | archive-related operations |

### `spec_task_set`

Mark a task in `tasks.md` by id. State mapping: `pending` → `[ ]`, `active`/`in-progress` → `[-]`,
`done` → `[x]`.

### `spec_sign`

Append a signature line to `tasks.md`'s `## Notes` (format
`- YYYY-MM-DD · DSH · <what changed>`).

### `spec_meta`

Read or write `tasks.meta.json` (the `{pbtResults, executionHistory}` shape).

### `spec_archive`

Move one spec directory into `.kiro/specs/_archive/<feature>/`. **Refuses to overwrite an existing
archive.**

---

## 3. Diagnosis and quality (all read-only)

### `spec_diagnostics`

Lint the active spec against Kiro's heading/format conventions: `##` headings matched by
**strict prefix**, task states, dependency graph JSON shape, and so on.

### `spec_checklist`

A **read-only** requirements-quality check for one spec: missing acceptance criteria / missing
user story / criteria that aren't testable…

### `spec_drift`

A **read-only** drift report: which requirements have no landing point — based on task state and
the design's traceability.

### `spec_status`

Report the workflow phase, task completion, and **the next required step**.

---

## 4. Execution

### `spec_run`

Execute `tasks.md` in the order given by `## Task Dependency Graph`:
**waves run serially, tasks within a wave may run in parallel**.

> ⚠️ The graph must be written as `{"waves":[{"id":0,"tasks":["1"]}]}` — waves carry a **numeric
> `id`**, task ids are **strings**. Violate any of the three requirements and the host **discards
> the entire graph and silently falls back to fully serial execution** (no error, no warning).
> See [../spec-conventions.md](../spec-conventions.en.md).

---

## 5. The `/spec` command

The command surface is unique to this host (the other two are pure MCP). Its subcommands map
one-to-one onto the tool surface, for driving progress directly in an interactive session instead
of having the agent call tools one at a time.
