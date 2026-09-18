> 🌐 [中文](../../../plugins/codex-spec/README.md) · **English**

# codex-spec

`codex-spec` is a Kiro-compatible Spec plugin for Codex. It provides the authoring loop for four
collaborative workflows, existing-Spec discovery, cross-artifact analysis and sync, serial task
execution, and an **evaluation-only admission** mode for a downstream project. It does not provide
parallel execution, hooks, or hard security.

## Support matrix

| Component | Currently pinned range |
|---|---|
| Codex | `0.150.0-alpha.8` or a later compatible version; a version change requires re-running the host smoke test |
| Node | `>=20 <26`; Node 20, 22 and 24 LTS are the support baseline |
| macOS | local stdio runtime on Apple Silicon and Intel |
| Linux | local stdio runtime on x86_64 and arm64 |

## Current capabilities and boundaries

MCP exposes `spec_health/list/template/validate_artifacts/init/adopt/read/context/write/status/diagnostics/analyze/quality_preview/sync_preview/sync_apply/record_analysis/request_approval/record_approval`, plus `spec_task_set` for manual three-state updates and `spec_task_plan/begin/record_check/complete/fail/reset_failures` for serial execution.

⚠️ **One unevaluated difference from `claude-spec`**: the shared layer `packages/spec-state` already
implements `spec_amend`, partial reads for `spec_read` (`outline`/`section`), and `knownRevisions`
for `spec_context` — but **this host's tool list does not expose them** (`lib/mcp/tools.mjs`). That
was not a considered decision: those three were done during token measurements on `claude-spec` and
never re-evaluated for this host. Exposing them means updating this directory's
`tool-schema.test.mjs` and `SKILL.md`, plus re-running the `pack-plugin` and `codex-spec-dist` drift
checks.

It supports requirements-first, design-first, bugfix and quick: design-first confirms the design
first, bugfix uses a separate `bugfix.md`, and quick must produce all three artifacts and then pass
a single whole-batch confirmation with `批准全部 artifacts`. `spec_template` provides
workflow-specific templates; `spec_diagnostics` reads the spec and `.config.kiro` straight off disk
for format diagnosis (the counterpart of Kiro's `getDiagnostics` spec branch), while
`spec_validate_artifacts` is only for drafts not yet on disk. `spec_analyze`,
`spec_quality_preview` and `spec_sync_preview` are all read-only comparisons of
requirements/design/tasks; `spec_sync_apply` applies only unambiguous design-traceability
appenditions, requiring the three source revisions, the design context proof and an explicit
confirmation, after which it invalidates the affected confirmations.

When the plugin is called, every tool requires the target project's normalised absolute
`projectRoot`; writes additionally require conformance with that project's
`.codex/codex-spec.json` `writePolicy`, an unexpired `spec_context` proof, and a matching
`rawRevision`. Confirmations, workspace snapshots and execution check records always report
`assurance=collaborative`.

The downstream adapter must stay `evaluation-only`: it permits only a single canonically-named
evaluation spec under `.kiro/specs/_eval-codex-YYYYMMDD/`, forbids nested sub-specs beneath it, and
binds the policy to the SHA-256 of the authoritative steering file. On an adapter hash mismatch, a
spec-name mismatch, or an invalid context proof, the server refuses the write. MCP only returns
validator argv from a built-in allowlist and never executes project commands itself.

Not currently included: converge, parallel execution, hooks, automatic cleanup, hard security. Sync
covers only unambiguous design-requirement trace appenditions; it will not automatically rewrite
approved content. `tasks.meta.json` is always read-only. Project commands are run by the host agent;
`spec_task_record_check` merely stores commands, exit codes and summaries explicitly marked
`agent-reported`.

`spec_list` discovers existing specs that have no private state and returns them with
`lifecycle=external`. Those must be explicitly `spec_adopt`ed before execution. Execution order is
plan → begin → record_check → complete/fail; cross-process locks, owner tokens, 30-minute leases,
state epochs, task raw revisions and a restartable reconciliation intent journal together refuse
duplicate execution, stale submissions and half-committed states. A third failure keeps returning
`HUMAN_REVIEW_REQUIRED` until a human calls `spec_task_reset_failures` with the exact confirmation
phrase.

`spec_task_plan/begin/complete` accept a structured `workspaceSnapshot` collected by the host; the
server canonicalises it and recomputes revisions but does not run Git itself, so this remains a
collaborative boundary. A pure check leaf task must be explicitly marked `_Type:_ verification` in
order to complete while the workspace revision is unchanged.

Startup diagnostics are written to stderr as a single line of JSON, including version, cwd, the
explicitly configured project root, `tools`, and `fileGuardrail=false`. That log contains no spec
content, tokens, receipts or private state. An absolute `projectRoot` in the tool arguments takes
highest priority; only legacy calls fall back, in order, to `KIRO_SPEC_PROJECT_ROOT` and then the
process cwd. `spec_health` echoes back the normalised `projectRoot`, and after installation you must
verify that it points at the intended project.

`.codex-spec-private/` holds the rebuildable workflow cache and collaborative confirmation
summaries; context proofs live only in the current process's memory, so after the process exits or
the five-minute validity window lapses, `spec_context` must be called again. Markdown remains the
shared source of truth. After a loss of private state, `spec_adopt` plus re-confirmation recovers
it, without raising assurance.

The current stdio transport handles requests globally serially in `mcp-server.mjs`, so MCP calls do
not enter the service concurrently. Concurrent calls after importing `createMcpService` directly are
outside this version's contract; enabling that would first require serialising every operation that
reads or writes spec state.

`spec_health`, `spec_list`, `spec_context` and `spec_diagnostics` create no private state and
declare `readOnlyHint=true`. `spec_read`, `spec_status` and `spec_task_plan` may refresh workflow
state upon discovering external changes, so they are conservatively declared non-read-only; tools
that replace shared Markdown additionally declare `destructiveHint=true`.

## Local verification

```bash
cd plugins/codex-spec
npm run doctor
```

Without hooks, this is the supported baseline mode: `fileGuardrail=false` means direct file tools
have no guardrail; it does not block the Skill or MCP startup of an installed plugin.

For installation, enabling, disabling, uninstalling, configuration merging/rollback and offline
verification, see [INSTALL.md](INSTALL.md).

## Evaluation-only admission

The plugin supports an **evaluation-only** admission mode for a downstream project that wants to
try the plugin out without touching its real specs. In that mode:

- writes are confined to `.kiro/specs/_eval-codex-YYYYMMDD/`, and nested sub-specs beneath it are
  refused;
- the policy is bound to the raw-byte SHA-256 of the project's authoritative steering file, so a
  sample hash is not a reusable default and **must be re-derived** before use;
- formal specs, and any prefix outside the evaluation directory, are refused.

The same mode is exercised by the plugin's own isolated test fixtures, which write requirements,
design and tasks through `createMcpService()`, read tasks back to verify byte stability, and then
run a fixed-argv linter over the result.

> 🔴 Writing into a real downstream project is a **cross-repository write**: it requires the user's
> explicit authorisation, and that project's working tree must be confirmed clean first. With either
> precondition unmet, only the plugin's isolated tests may be run — and their result must not be
> described as a real-host admission pass.
