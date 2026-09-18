> 🌐 [中文](codex-spec.md) · **English**

# `codex-spec` tool reference

The Codex host. **25 MCP tools**, all schema-validated.

- Form: stdio MCP server (see [../en/codex-spec/INSTALL.md](../en/codex-spec/INSTALL.md))
- No hook, no stage gate: **the tools themselves are the only enforcement layer**
  (CAS, lease, approval, confirmation phrases)

---

## 1. Reconnaissance (read-only)

| Tool | Required | Meaning |
|---|---|---|
| `spec_health` | `projectRoot` | Check the target project's adapter, write boundary, and the plugin's basic capabilities |
| `spec_list` | `projectRoot` | Discover managed and external specs, **without adopting or modifying them** |
| `spec_template` | `projectRoot`, `workflow`, `artifact` | Return the canonical drafting template for a workflow+artifact; writes nothing |

`spec_health` is the one to call first: it answers "is the adapter there", "what is the write
boundary", and "is the gate alive" (the last one — see [claude-spec.md](claude-spec.en.md)).

## 2. Starting and adopting

| Tool | Required | Meaning |
|---|---|---|
| `spec_init` | `projectRoot`, `spec`, `workflow` | Create private state and the controlled directory; advance to that workflow's drafting stage |
| `spec_adopt` | `projectRoot`, `spec` | Adopt an existing spec and record the artifact baseline |

⚠️ **`spec_adopt` is not approval.** `workflow` may be omitted: when omitted it is derived from the
spec's own `.config.kiro`; **an explicit value that conflicts with it is refused** (it does not guess).

## 3. Writing

| Tool | Required | Meaning |
|---|---|---|
| `spec_read` | `projectRoot`, `spec`, `artifact` | Read one managed artifact and refresh its rawRevision and semantic-fingerprint baseline |
| `spec_context` | `projectRoot`, `spec`, `artifact` | Load the project's authoritative rules needed to write/execute; issue a **short-lived** `contextProof` |
| `spec_write` | `projectRoot`, `spec`, `artifact`, `content`, `expectedRawRevision`, `contextProof` | Atomically replace the current stage's Markdown, guarded by `contextProof` + **CAS** on rawRevision |

Those three form a chain: **read → obtain proof → write**.

- `expectedRawRevision` is an **optimistic lock**: writing with a stale revision is refused rather
  than silently overwriting someone else's change.
- `contextProof` is a **short-lived credential**: it proves that the current authoritative rules
  (steering) really were read before writing. Without it the write does not go through — this
  design exists so that "the rules changed but the agent is still working from its old
  understanding" cannot happen silently.

## 4. State and diagnostics

| Tool | Required | Read-only | Meaning |
|---|---|---|---|
| `spec_status` | `projectRoot`, `spec` | | Read phase, approvals, tasks, waves and execution-recovery state; refresh on external change |
| `spec_diagnostics` | `projectRoot`, `spec` | ✅ | The counterpart of Kiro's `getDiagnostics` spec branch |
| `spec_validate_artifacts` | `projectRoot`, `workflow`, `artifacts` | ✅ | Validate **caller-supplied** Markdown (drafts not yet on disk) |

`spec_diagnostics` deserves a note: it **reads every artifact of that spec straight off disk** and
returns findings under Kiro's rules plus this project's conventions (the spec type comes from what
`.config.kiro` states); absent ones are listed under `missingArtifacts`. It also attaches task-parse
warnings and the read-only validator plan the host should execute. **Read-only; it does not refresh
baselines.**

> ⚠️ `workflow` only determines **which artifacts are legal** — it does **not** represent the spec
> type. For a spec already on disk, use `spec_diagnostics`; you needn't pass the body.

## 5. Cross-artifact analysis (all read-only)

| Tool | Meaning |
|---|---|
| `spec_analyze` | Read-only comparison of requirements/design/tasks, returning traceability conclusions **with source locations** |
| `spec_quality_preview` | Read-only summary of the three artifacts' quality picture and source rawRevisions |
| `spec_sync_preview` | Read-only, **unambiguous, append-only** sync suggestions; modifies nothing |

`spec_analyze`'s conclusions can be recorded into private state via `spec_record_analysis` (CAS on
`stateEpoch`) **without rewriting the Markdown** — analysis and documents are two separate things.

## 6. Sync

| Tool | Required | Meaning |
|---|---|---|
| `spec_sync_apply` | `projectRoot`, `spec`, `sourceRevisions`, `contextProof`, `confirmationText` | Apply the single unambiguous append-only design sync suggestion |

It requires **three things together** before acting: the three source revisions, the design
`contextProof`, and the exact confirmation phrase. It then **invalidates the affected approvals**.

## 7. Approval

| Tool | Required | Meaning |
|---|---|---|
| `spec_request_approval` | `projectRoot`, `spec`, `artifact` | Freeze the current artifact fingerprint; return the **exact approval phrase** and `stateEpoch` |
| `spec_record_approval` | `projectRoot`, `spec`, `artifact`, `expectedStateEpoch`, `confirmationText` | Record an approval matching the latest request; advance the workflow stage |

The "exact approval phrase" is an anti-misclick design: approval must **echo back** the string the
system produced, not just say `yes`.

## 8. Task execution (serial, with leases)

| Tool | Required | Meaning |
|---|---|---|
| `spec_task_set` | `projectRoot`, `spec`, `taskId`, `state` | Manually set the three-state marker; **refuses to bypass an active execution lease** |
| `spec_task_plan` | `projectRoot`, `spec`, `scope`, `workspaceSnapshot` | Compute a serial execution plan (`task`/`wave`/`all`) for an adopted spec in `implementing`; refresh on external change |
| `spec_task_begin` | `projectRoot`, `spec`, `taskId`, `planRevision`, `expectedStateEpoch`, `workspaceSnapshot` | Verify plan and epoch, take a **single-task lease**, atomically flip `[ ]` → `[-]` |
| `spec_task_record_check` | `projectRoot`, `spec`, `ownerToken`, `expectedStateEpoch`, `command`, `exitCode`, `summary` | Record an agent-reported command, exit code and summary; **does not execute the command** |
| `spec_task_complete` | `projectRoot`, `spec`, `ownerToken`, `expectedStateEpoch`, `workspaceSnapshot`, `summary` | Require a successful check and a valid owner; atomically flip `[-]` → `[x]` |
| `spec_task_fail` | `projectRoot`, `spec`, `ownerToken`, `expectedStateEpoch`, `summary` | Close the attempt, revert the plugin-owned `[-]` to `[ ]`, accumulate the failure count |
| `spec_task_reset_failures` | `projectRoot`, `spec`, `taskId`, `expectedStateEpoch`, `confirmationText` | After human review, lift the **three-failure** gate with the exact confirmation phrase, retaining the audit record |

Design notes:

- **`planRevision` + `expectedStateEpoch` + `workspaceSnapshot` is a triple check**: the plan
  changed, the state changed, or the workspace changed — any of them refuses `begin`. This guards
  against the hardest class of bug to find: "advancing according to a stale plan".
- **`ownerToken` is the lease credential**: an expired owner cannot call complete/fail.
  `spec_task_fail` restores `[-]` to `[ ]` rather than leaving it in an intermediate state — no
  dangling in-progress markers.
- **Three consecutive failures hit a gate**; lifting it needs a human confirmation phrase, and the
  audit record is retained.
