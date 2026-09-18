> 🌐 [中文](../../../plugins/dsh-spec/README.md) · **English**

# dsh-spec

A DeepSeek Harness cordis plugin replicating Kiro's Spec mechanism. It turns a feature or a fix
into formal spec documents and enforces staged, ordered progress through them.

## The four spec shapes

| Shape | Order | First artifact | Approval gate |
|---|---|---|---|
| **feature (requirements-first)** | requirements → design → tasks | `requirements.md` | yes |
| **feature (design-first)** | design → requirements (derived) → tasks | `design.md` (High / Low Level) | yes |
| **bugfix** | analysis → design → tasks | `bugfix.md` (current / expected / unchanged) | yes |
| **quick** | all three at once | all three | no |

### Two workflow types the real host has that this plugin does **not** model

`spec_init` accepts only the shapes above. The real `WorkflowType` enum has two more, which this
plugin **knows about but does not implement**:

| Real `workflowType` | Status here |
|---|---|
| `fast-task` | **not modelled.** The document set matches requirements-first (`​.config.kiro` + requirements/design/tasks), but the **flow and presentation order** differ (the real one is a tasks-first checklist). Five instances were observed running in the wild |
| `verify-first` | **not modelled**, and **zero** instances across 77 real `​.config.kiro` files on disk — which does not mean it doesn't exist, only that the corpus doesn't cover it |

### One difference that **still needs a real-machine sample** to settle

The **document set** for `quick` disagrees three ways: Kiro's `quick` produces **no `design.md`**,
while this plugin's `quick` produces **all three**.
⚠️ **This cannot be settled right now**: the real-machine `specType: "quick-spec"` has **zero**
instances across 77 real `​.config.kiro` files, so no real sample is available.
**Do not treat it as resolved** — when a `quick-spec` instance shows up in the corpus, the real
machine wins.
(The real enum and the `specType` → this plugin's `kind` mapping are implemented and asserted — see
`specTypeToKind` in `packages/spec-parser/lib/config-kiro.js`. **Only the document set is in doubt.**)

When it reads one of those two workflow types from `.config.kiro`, `spec_status` **states plainly in
`workflowNotes` that "this plugin does not model it and will follow the existing flow"**. Silently
applying a different flow is exactly the kind of degradation this project refuses elsewhere.
Implementing them is its own piece of work, not a spare enum value.

## Directory layout (Kiro's layout)

Specs are written to `.kiro/specs/<feature>/` (Kiro's multi-spec subdirectory layout), one directory
per feature:

```
<projectRoot>/.kiro/specs/<feature>/
├── requirements.md    # feature / quick
├── bugfix.md          # bugfix (the Analysis artifact, in place of requirements.md)
├── design.md
├── tasks.md
└── tasks.meta.json    # execution history + the _workflow marker
```

- **Active spec pointer**: `.kiro/specs/_active` records the current feature name, so later
  `spec_write/read/status/task_set` calls need not pass a feature name.
- **Single-spec compatibility**: older specs written directly under the configured `specDir`
  (e.g. `.spec/`) can still be read.
- **Non-destructive migration**: if the old location already holds a spec on the first `spec_init`,
  the files are **copied** into the `<feature>/` subdirectory and the old location is left alone
  (Kiro's zero-migration rule).
- The `specsRoot` config can point the root at any parent directory.

## The three stages (feature, requirements-first)

| Stage | File | Contents |
|---|---|---|
| Requirements | `requirements.md` | User stories + EARS acceptance criteria (`WHEN … THE SYSTEM SHALL …`) |
| Design | `design.md` | Architecture, data flow, error handling, testing strategy |
| Tasks | `tasks.md` | A checkbox implementation plan, each item referencing `_Requirements: x.y_` |

> For bugfix, the Analysis stage produces `bugfix.md` (Current / Expected / Unchanged Behavior,
> with EARS using lowercase `the system` and `SHALL CONTINUE TO` for regression protection), and the
> design stage adds root-cause analysis and the properties that need testing.

## Capabilities

- **System prompt section** (`spec:workflow`, order 120): injects the spec-first workflow into every
  request as a standing behavioural constraint.
- **Three task states** (Kiro's): `- [ ]` pending / `- [-]` in progress / `- [x]` done. A fourth
  state is rejected.
- **Task dependency graph**: the `## Task Dependency Graph` section of `tasks.md`; waves run
  serially, tasks within a wave concurrently. The shape is
  `{"waves":[{"id":0,"tasks":["1","2"]},{"id":1,"tasks":["3"]}]}` — an array of **objects** (not a
  bare array), each wave carrying a **numeric `id`** (0-based, consecutive), with task ids as
  **strings**. DSH itself does not enforce the last two (it normalises them), but the real Kiro
  host discards the whole graph and falls back to serial execution if either is missing — so
  `spec_diagnostics` raises a warning. Based on a real-machine measurement of `kiro-agent` 1.0.794.
- **The waves executor** (`spec_run` tool + `/spec run`): parses the dependency graph and executes
  in wave order; waves serially, tasks within a wave concurrently via subagents (4 by default, see
  `maxConcurrency`). Only tasks that are both incomplete (not `[x]`) and declared in the graph are
  run; a failed task reverts to `[ ]`, a successful one is marked `[x]`. `/spec plan` previews the
  plan without dispatching.
  - **Task state is written exclusively by the executor.** Dispatched subagents are explicitly told
    **not** to edit `tasks.md` and not to call `spec_task_set` — several subagents in the same wave
    doing read-modify-write on the whole file concurrently would overwrite each other. State is
    marked by the runner once subagents settle.
  - A failed state write is **listed explicitly in the returned result** (it is never lost
    silently), and on an abnormal interruption the current wave's `[-]` markers fall back to `[ ]`.
  - **No dependency graph ⇒ strictly serial** (one task at a time), with a warning explaining why
    and how to fix it. The real host's `getReadyTasksSequential()` returns **only the first** ready
    leaf when there is no graph. There is a harder reason than parity for going serial:
    `tasks/missing-dependency-graph` is `severity: "error"` in **both** the real table and this
    plugin's — that is, **the diagnoser calls it an error while the runner treated it as eligible
    for concurrency**, which is self-contradictory. And "no dependencies declared" is not the same
    as "declared safe to parallelise": concurrent subagents would edit the same files at once
    (task state is already closed off by "executor owns the write", but source files are still
    exposed). The affected surface is 3.1% (7 of 224 `tasks.md` files in one real corpus); wanting
    concurrency just means writing a graph.
  - An **empty** graph `{"waves":[]}` still differs in meaning from **no** graph: the former
    dispatches **nothing** (with a warning); the latter runs **everything serially** as above.
  - Task `_Requirements:` references are resolved, and only the referenced requirement blocks are
    injected into the subagent's prompt; the remaining context (such as `design.md`) is capped by
    the `maxContextBytes` budget and truncated past it.
- **Tools** (`spec_*`):
  - `spec_init(goal, kind?, workflow?, detailLevel?, feature?)` — start a spec; `kind` =
    feature (default) / bugfix / quick; `workflow` = requirements-first (default) / design-first;
    `detailLevel` = high (default) / low
  - `spec_write(file, content)` — write a spec file (`requirements` / `design` / `tasks` /
    `bugfix`); workflow-aware stage gating; returns a non-blocking diagnostic summary after writing
    (it does not block the write)
  - `spec_read(file?)` — read a file, `meta` (tasks.meta.json), or the overall status
  - `spec_status()` — stage + task completion + the next step
  - `spec_task_set(index, {done?|state?})` — set a task's state (`pending` / `active` / `done`)
  - `spec_meta(action?, task?, ...)` — read/write `tasks.meta.json` in the spec directory.

    ⚠️ **This is the pre-1.1.28 execution-history shape** (`{pbtResults, executionHistory}`, capped
    at **10 entries** per task, byte-identical to the real host). The real host has since moved that
    data to `~/.kiro/tasks/<workspace-hash>/<feature>.meta.json` (with a different shape), and
    **this plugin does not write that store**: it belongs to Kiro, Kiro is still writing it today,
    and it holds its own file lock and applies `slice(-10)` on **its** write path — records we
    inserted would be truncated away. Writing outside the workspace would also mean bypassing
    `ctx.fs`, which is the `port.move` path the repository specifically guards with
    `assertInsideProject`.

    Keeping the old location is deliberate: **96 of 211** specs in one real corpus carry this file,
    and the repository's standing principle is that `tasks.meta.json` "is NOT ours to reconstruct".
    **So: be precise about what it is, and don't move it.** Anyone reading it must know they are
    **not** looking at the current Kiro execution history.
  - `spec_run(wave?, dryRun?)` — the waves executor; `wave` runs one wave only, `dryRun` previews
    the plan
  - `spec_diagnostics()` — the diagnoser (Kiro's `getDiagnostics` equivalent): validates strict
    `##` heading prefix matching, the H1 title, dependency graph JSON shape, a fourth task state;
    raises soft warnings for a missing `**User Story:**` / `#### Acceptance Criteria`. Reports only;
    never blocks a write
- **Command** `/spec [status|diagnose|new <name>|view [name] [file]|run|plan|analyze_requirements [name]|init <goal>]`
  - `new <name>` — create a spec and switch to its feature directory
  - `view [name] [file]` — open a spec document (defaults to requirements.md and the active spec)
  - `run` / `plan` — execute per the dependency graph / preview the plan
  - `diagnose` / `diag` / `lint` — run the diagnoser against the active spec (the command face of
    `spec_diagnostics`)
  - `analyze_requirements [name]` — guide the current agent through a consistency analysis across
    the whole requirement set (logical contradictions, ambiguities, conflicting constraints,
    undeclared assumptions, missing boundaries)

## Configuration

Override in your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-spec
      name: ../dsh-spec/lib/index.js
      config:
        specDir: .spec               # default; the single-spec compatibility location
        projectRootMarkers: ['.git'] # markers used to identify the project root
        specsRoot: null              # explicit spec parent directory (optional)
        useFeatureDirs: true         # use the .kiro/specs/<feature>/ layout
        subagentProvider: null       # subagent provider name used by /spec run; required to run
        maxConcurrency: 4            # max concurrent subagents within one wave (default 4)
        maxContextBytes: 32000       # spec-context byte budget per task prompt (default 32000)
```

> Set `subagentProvider` to `spawn`: `dsh-base` already mounts
> `@deepseek-ai/dsh-subagent-spawn-in-process`, whose registered name is `spawn` by default.
> When it is not configured, `spec_run` / `/spec run` fail with an explicit error (the core
> three-document workflow is unaffected, and `/spec plan` still previews).

Spec files are written to `<projectRoot>/.kiro/specs/<feature>/`, where the project root is the
nearest ancestor of the session cwd containing `.git` (falling back to cwd).
