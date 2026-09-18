> 🌐 [中文](../../../plugins/claude-spec/README.md) · **English**

# claude-spec

`claude-spec` is a Kiro-compatible Spec plugin for Claude. It provides the authoring loop for four
collaborative workflows, existing-Spec discovery, cross-artifact analysis and sync, serial task
execution, and a `PreToolUse` stage gate. It does not provide parallel execution, automatic cleanup,
or security receipts.

> 📖 This is the public-facing version of the documentation. The Chinese
> [original](../../../plugins/claude-spec/README.md) additionally preserves the dated development record
> (incident forensics, measurement logs) — useful when you need to know *how* a conclusion was
> reached, not just what it is.

## Runtime topologies: local vs Cowork

Both are supported, and the difference lies only in **how liveness signals are read** — not in
features or security boundaries:

| | local Claude Code CLI (**default**) | Claude Cowork (explicit) |
|---|---|---|
| `CLAUDE_SPEC_TOPOLOGY` | omitted, or explicitly `local` | set to `cowork` |
| relationship between hook and MCP | same machine, same filesystem | hook in the session container, MCP on the user's machine — the two paths need not share a filesystem |
| how to read `gate.status === "unobserved"` | **more suspicious**: check whether `hooks.json` was claimed by this install and whether `PreToolUse` ever fired | **neutral** — it is not evidence that the gate wasn't called; use the liveness probe in [INSTALL.md](INSTALL.md), which reads the audit log inside the container |

`CLAUDE_SPEC_TOPOLOGY` is read **once**, when the MCP server starts; there is no automatic
detection. A misread topology sends troubleshooting in the wrong direction, which is worse than not
deciding. An invalid value makes the process **fail at startup** with the reason on stderr — it does
not quietly fall back to `local`. `spec_health` reports which one was used in `gate.topology`.

## Tier: `collaborative`

**This plugin is `collaborative` tier.** Checkboxes, confirmations and the stage gate are
**collaboration conventions**, not enforceable security boundaries — they stop the normal flow of
"didn't realise I was crossing a line", not someone determined to go around them.

That framing is not a hedge; it is the measured conclusion. On this host a model can rewrite its own
hook scripts with an ordinary tool call, and the change takes effect on the next hook event without
any reinstall. **So "make the hook attest something" and "make the hook attest something false" are
the same capability.**

The consequence is stated plainly below, in "What the gate does not cover" and "Not doing".

## Support matrix

| Component | Currently pinned range |
|---|---|
| Claude | host version `1.52386.3` (Electron `44.2.0`) |
| Node (hook side) | `engines` declares `>=20 <26`; the session container runs Node 22 |
| Node (MCP side) | ⚠️ **the MCP server is not on the same machine as the hook.** The `.mcp.json` server is a **local stdio process** launched by the desktop app on the **user's machine** and bridged in as `mcp__remote-devices__…` tools. Measured on macOS arm64 with Node 24 |
| macOS | local stdio runtime (Apple Silicon and Intel) |
| Linux | the session-container side — **this is where the hook executes, not the MCP server** |

## The stage gate (`PreToolUse`)

`hooks/hooks.json` registers a single event: `PreToolUse`, `matcher: "Write|Edit|MultiEdit"`, running
`${CLAUDE_PLUGIN_ROOT}/scripts/spec-stage-gate.sh`.

It only inspects writes landing inside `.kiro/specs/**`, and allows or refuses them by
"stage first, artifact second":

| Writing | Requires existing |
|---|---|
| `.kiro/specs/<f>/requirements.md` | (unconditional: the first stage of the feature workflow) |
| `.kiro/specs/<f>/bugfix.md` | (unconditional: the first stage of the bugfix workflow) |
| `.kiro/specs/<f>/design.md` | `requirements.md` **or** `bugfix.md` |
| `.kiro/specs/<f>/tasks.md` | `design.md` |

- **Writes outside `.kiro/specs/**` are unaffected** — allowed silently.
- **Writes from inside subagents are intercepted too.** Each subagent tool call fires `PreToolUse`
  independently, with `agent_id` / `agent_type` in the payload; the verdict does not look at those
  fields, treating the parent session and subagents identically. Spawning a subagent is not a way
  around the gate.
- **When the gate itself breaks, it allows the write and says so loudly** (fail-open + loud). It
  cannot stop someone determined to go around it, so for a broken environment (missing node,
  malformed payload) blocking every normal write would only manufacture a harder-to-diagnose
  failure. *Silent* allowance is the one unacceptable outcome.

### 🔴 What the gate does not cover — read this before relying on it

The `matcher` is `Write|Edit|MultiEdit`. **Every other write path bypasses the gate entirely**, and
two of them are routine:

| Path | Gated? | Note |
|---|---|---|
| `Write` / `Edit` / `MultiEdit` | ✅ intercepted | measured: an out-of-stage write was refused; adding the previous stage allowed it |
| `Bash` (`cat > f`, `sed -i`, `tee`, …) | ❌ **not intercepted** | measured: the *same* out-of-stage write via a Bash heredoc landed silently |
| Writes bridged to the user's machine (`device_bash` / `device_commit_files`) | ❌ **not intercepted, and cannot be** | see below |

**Why the bridged path is "cannot", not "not done"**: the hook runs inside the **session
container**, so its `exists()` sees only the container's filesystem. In the Cowork + bridge topology
the real project lives on the **user's machine** — the container has no copy of that
`.kiro/specs/`. Even if the gate received a `device_commit_files` payload, the `devicePath` in it
points at **another machine**, so it cannot determine whether the previous stage's artifact exists.
Adding such events to the matcher would only produce empty verdicts that allow everything, plus a
false impression of coverage.

🔴 **So, stated bluntly: under the current deployment topology, the number of writes this gate
actually covers is close to zero.** It protects `.kiro/specs/**` on the container's filesystem, and
the specs aren't there.

The constraints that genuinely apply to a local project's specs are two other things, and neither is
at the hook layer:

1. **The MCP-side `spec_write`** — it runs on the user's machine and has `writePolicy` /
   `contextProof` / `rawRevision` CAS / phase checks; an out-of-stage write is refused with
   `PHASE_NOT_APPROVED`. **This is the primary gate for local specs.**
2. **The project's own pre-commit hook** — format linting and signature checks at commit time,
   effective in every environment.

The gate is the **third and weakest** layer, scoped to native writes inside the container. Do not
treat it as the reason `.kiro/specs/**` is protected.

- To see whether it fired at all: set `CLAUDE_SPEC_GATE_LOG=<path>` and each verdict appends a JSON
  line (event, tool, whether `agent_id` was present, target path, verdict, reason). Off by default.

## Signature: it can only land together with `spec_write`

`spec_write` takes an optional `signature` parameter (what changed this time). Given one, the plugin
renders the signature line and merges it into the content **in the same atomic write**:

```
- 2026-09-13 · Claude · design.md: added quota boundaries
```

🔴 **Why there is no separate "re-sign" tool.** The signature is meant to land *together with* the
change it describes: that removes a whole class of follow-up operations, and the environment
identifier (pinned to `Claude`) is validated by the plugin rather than left to the caller to get
right. Re-signing therefore means **calling `spec_write` again with `signature`**.

Three behaviours, each pinned by a test:

- **The environment identifier is pinned to `Claude`** and cannot be set by the caller — borrowing
  someone else's identity because you have none of your own is exactly the path to avoid.
- **An empty summary, or one that won't fit, is refused close to the source**
  (`SIGNATURE_INVALID`), rather than only surfacing at pre-commit time.
- **Omitting `signature` is not blocked**, but returns an `attributionWarning`. That level matches
  the consuming project's own choice (`check_spec_signature` is warn-level): "what counts as a
  substantive change can't be reliably detected automatically, and hard-blocking would misfire and
  push people toward skipping the hook".

The source of truth for the verdict is the consuming project's `.githooks/pre-commit`. Our
validator is a character-for-character port of it, and a test reads that hook directly and compares
— **if it drifts, we go red**.

## Write policy: authorised, straight into the formal directory

`adapter.example.json`'s `writePolicy.mode` is **`authorized`**, with `allowedPrefixes` **omitted** —
meaning "`specsRoot` itself", i.e. any formal `.kiro/specs/<feature>/`.

- This is **not** "allow everything": writes are still confined to `specsRoot`, and
  `PATH_OUTSIDE_PROJECT` and `SYMLINK_ESCAPE` are both still enforced. All that is dropped is
  "must the formal directory be registered in config first".
- `authorityFile` / `authorityHash` are still present, but under `authorized` they are a **ledger,
  not a gate**: the meaning is "the version we last checked against", and they do not participate in
  the allow/deny decision. Drift is reported by `spec_health`'s `authority.status`
  (`matches` / `drifted` / `unreadable` / `unrecorded`). Making the hash a gate would have the
  plugin suddenly refuse to work the moment an unrelated upstream typo changed.
- `evaluation-only` remains a **gate** for unlocked hosts (the prefix must be
  `_eval-codex-YYYYMMDD/` and the hash must match). What changed is the channel for *unlocked*
  hosts, not everyone's.

### The adapter path: `.codex/codex-spec.json`

The service requires the target project to have `.codex/codex-spec.json`. That path is a
**cross-host shared project file**, not this plugin's identity:

- `plugins/dsh-spec/lib/index.js` and `plugins/codex-spec/lib/mcp/adapter.mjs` declare the **same**
  path string — a **DSH** host plugin reads it too;
- the path's *location* and its "shared across hosts" status are unchanged by the plugin rename
  that turned `kiro` into `codex` in the filename. The consequence is worth writing down: this
  plugin reads a file **named after a different host**. That is the cost of following the existing
  `<host>-spec` naming convention and minimising the change surface, not a defect.

🔴 **The legacy name is still caught by a compatibility read**: when the new path does not exist but
the old one does, the old one is read and health reports `adapterSource: legacy`; when both exist
the new one wins and the conflict is *reported* rather than silently resolving. So already-deployed
projects do not turn into `ADAPTER_MISSING` because of the rename.

## `.claude/rules/` and the contextProof gap

`scripts/gen-rules.mjs` derives five `.claude/rules/*.md` files from the single-source rule table
(`packages/kiro-rules/lib/kiro-rules.js`): `spec-core.md` (no `paths:`, always loaded) plus one each
for requirements / design / tasks / bugfix (bearing `paths: [".kiro/specs/**/<artifact>.md"]`).

The four artifact files' rule codes have a **union of exactly 41 and pairwise-empty
intersections** — a test verifies this on the **generated files**, rather than only asserting
"41 total" (which a wrong implementation also satisfies when summed per variant).

🔴 **`paths:` replaces only half of Kiro's fileMatch router:**

| Kiro side | `.claude/rules/` side | Verdict |
|---|---|---|
| **routing** rules by path (which ones load) | `paths:` frontmatter — the exact counterpart | ✅ has an equivalent |
| `ruleLoadedToken` (**proving** a rule reached the context) | **no equivalent**: `InstructionsLoaded`'s `path_glob_match` can only log, not hand a token to MCP | ❌ none |

So "the rules were loaded by path" is a **collaborative constraint here, not a verifiable one**.
Do not cite any `paths:` configuration as evidence that a given rule was in the model's context.

### Keeping derived artifacts fresh

The derived artifacts land in another repository, so changing the source of truth immediately makes
them stale. Two layers of checking exist: one in this repository's tests, and one in the consuming
project's pre-commit hook which runs **for everyone who commits there**.

The pre-commit check is stronger than the original request in two ways: it reads the **git index**
rather than the working tree (so "regenerated but forgot to `git add`" is also caught), and it is
**error-level and aborts the commit**, not a warning.

⚠️ **One environment caveat — don't read a skip as a pass.** Its default path holds on the author's
machine, but on a desktop VM where the connected folder is mounted elsewhere the default path does
not exist, so it **skips loudly and says that is not a pass**. Running it for real there means
pointing it at the mounted root.

## Three measured boundaries (no beautification)

1. **A model can rewrite its own hook scripts.** Measured: an ordinary tool call rewrote an
   installed plugin's `scripts/record.sh`, and the change took effect on the very next hook event,
   with no reinstall. So "have the hook attest" and "have the hook attest falsely" are the same
   capability.
2. **The signature is self-reported, and all four environments are treated alike.** Nothing can
   prove which host wrote that line. The verdict's source of truth is the consuming project's
   pre-commit hook, not this plugin, and it is not proof of authorship.
3. **The hook attests the state of the session container at that moment** — not the user's machine
   (macOS/arm64 locally; the container is Linux), and certainly not "the model that actually
   answered". Do not conflate the three when reading gate or log conclusions.

## Not doing

**"Machine-attested signatures" is not being done** — not deferred, *not done*. Its entire
premise is "the model cannot change the hook", and measurement disproved that. Building machine
attestation on a host where the model can rewrite its own hook scripts only dresses up a forgeable
field to look more convincing — **worse than not doing it**, because it invites downstream to treat
it as evidence.

**No claim of `Level 2` / hard security; no claim that the signature or the gate is unforgeable.**
This plugin has no enforceable security boundary, and adding `PreToolUse` does not change that
(`fileGuardrail` is **still `false`** in the startup diagnostics).

**Entry points for re-evaluation** (not "let's think about it again"):

- The host gains a **private-state location a model cannot modify** (managed plugins, read-only
  org-plugins) → `privateStateIntegrity` can be re-measured, and only then is machine attestation
  on the table.
- Cowork gains a **configuration surface** equivalent to `sandbox.filesystem.denyWrite` → the
  write-side integrity can be re-measured.

  ⚠️ The current state is that this host does **not read** that settings file, so the configuration
  surface **does not exist** there — which is different from "is not enabled".

## Current capabilities and boundaries

MCP exposes `spec_health/list/template/validate_artifacts/init/adopt/read/context/write/amend/status/diagnostics/analyze/quality_preview/sync_preview/sync_apply/record_analysis/request_approval/record_approval`,
plus `spec_task_set` for manual three-state updates and
`spec_task_plan/begin/record_check/complete/fail/reset_failures` for serial execution.

**Approval handshake**: after finishing a document the agent **does not** initiate approval; it asks
the user to review at the end of its reply, allows direct file edits, and waits for the approval
phrase. On receiving the phrase the agent first reads everything back, reconciles the changes
against its own version (stopping to ask about anything it cannot explain), and then calls
`spec_request_approval` → `spec_record_approval` in order, telling the user which version was
approved. The plugin only checks the literal phrase, the state version, and "content unchanged
between request and record" — it **cannot tell** whether the phrase was said before or after the
request. Matching versions to approvals rests on the agent's reconciliation and reporting.

**Three token-saving channels** (only for *definitely duplicated* text; no verdict is relaxed):

- `spec_amend` — incremental correction of an approved spec (`param` / `requirement` / `design`),
  with the body transformed in place on the server rather than resent. Still requires a valid
  `spec_context` proof and CAS; refuses to modify task bodies and refuses `_archive/`; **a write
  always invalidates** the approval of the changed artifact and everything downstream of it.
- `spec_read`'s `outline` / `section` — partial reads, returning `partial: true`. **Do not** use a
  partial read's `rawRevision` for a full `spec_write`: CAS will pass and the sections you never
  read will be silently overwritten. When the same `##` heading occurs more than once, `section`
  refuses and reports the ambiguity.
- `spec_context`'s `knownRevisions` — byte-unchanged rule files get a receipt rather than their body;
  the proof still covers every file.

**Spec format diagnostics** (the counterpart of Kiro's `getDiagnostics` spec branch):
`spec_diagnostics` reads every artifact of that spec plus `.config.kiro` straight off disk and
returns `findings` (rules from the same source as Kiro), `specType` and `missingArtifacts`.
Read-only; it does not refresh baselines. `spec_validate_artifacts` is only for drafts **not yet on
disk**: it needs the full body from the caller and cannot see `.config.kiro`.
**Code** diagnostics (compilation / lint / types — the other half of `getDiagnostics`) are not in
this plugin: use your IDE's diagnostics when connected, otherwise run the project's own checks.

It supports requirements-first, design-first, bugfix and quick: design-first confirms the design
first, bugfix uses a separate `bugfix.md`, and quick must produce all three artifacts and then pass
a single whole-batch confirmation. `spec_analyze`, `spec_quality_preview` and `spec_sync_preview`
are read-only comparisons; `spec_sync_apply` applies only unambiguous design-traceability
appenditions, requiring the three source revisions, the design context proof and an explicit
confirmation.

Every tool requires the target project's normalised absolute `projectRoot`; writes additionally
require conformance with that project's `writePolicy`, an unexpired `spec_context` proof, and a
matching `rawRevision`. Confirmations, workspace snapshots and execution check records always report
`assurance=collaborative`.

`spec_list` discovers existing specs with no private state and returns them as `lifecycle=external`;
those must be explicitly `spec_adopt`ed before execution. Execution order is plan → begin →
record_check → complete/fail; cross-process locks, owner tokens, 30-minute leases, state epochs,
task raw revisions and an intent journal together refuse duplicate execution and half-committed
state. A third failure keeps returning `HUMAN_REVIEW_REQUIRED` until a human calls
`spec_task_reset_failures` with the exact phrase. `tasks.meta.json` is always read-only.

`spec_task_plan/begin/complete` accept a structured `workspaceSnapshot` collected by the host (its
path set must exclude `.kiro/specs/**` and `.kiro-spec-private/**`); the server canonicalises it and
recomputes revisions but does not run Git itself. A pure check leaf task must be explicitly marked
`_Type:_ verification`.

Startup diagnostics are a single line of JSON on stderr: `version`, `cwd`, `configuredProjectRoot`
and its `configuredProjectRootSource`, `tools`, `hooks`, `trustTier: "collaborative"` and
`fileGuardrail: false`. The log contains no spec content and no tokens. `spec_health` echoes back
the normalised `projectRoot`, `writeMode`, `allowedPrefixes` and `authority`.

`.kiro-spec-private/` holds the rebuildable workflow cache and collaborative confirmation summaries;
context proofs live only in the current process's **memory**, so after the process exits or the
five-minute window lapses, `spec_context` must be called again. Markdown remains the shared source
of truth.

🔴 `.kiro-spec-private/` and the `<!-- kiro-spec:execution-events:v1:start -->` marker pair in
`tasks.md` are **both already-persisted state**, and their **historical names are deliberately kept**: renaming them would orphan workflow state already deployed in consuming projects and would
make the parser **silently** blind to existing event blocks. Do not "tidy them up".

The stdio transport handles requests **globally serially** in `mcp-server.mjs`, so MCP calls do not
enter the service concurrently. Concurrent calls after importing `createMcpService` directly are
outside this version's contract.

## Local verification

```bash
cd plugins/claude-spec
npm run doctor          # = npm run check && npm test
```

`npm run check` walks every `.mjs` / `.sh` in the plugin for syntax and `JSON.parse`s every
constrained JSON file — it walks rather than using a hand-written list, so new files enter the
covered set automatically.

For installation, enabling, disabling, uninstalling, configuration merging/rollback and offline
verification, see [INSTALL.md](INSTALL.md).
