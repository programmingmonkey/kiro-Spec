> 🌐 **English** · [中文](../../docs/zh-CN/claude-spec/INSTALL.md)

# Installation and operations

> 📖 This is the public-facing version. The Chinese
> [original](../../docs/zh-CN/claude-spec/INSTALL.md) additionally preserves the dated
> troubleshooting record.

## Single supported install path

Install the plugin as a Claude plugin: `hooks/hooks.json` registers the `PreToolUse` stage gate,
`.mcp.json` registers the `claude-spec` MCP server, and `skills/claude-spec/SKILL.md` carries the
workflow instructions.

```bash
claude plugin marketplace add /absolute/path/to/marketplace-root
claude plugin add claude-spec@your-marketplace
```

Every `spec_*` MCP tool requires the target project's normalised absolute `projectRoot`, so the
server's own working directory does not affect correctness — it only decides what is *guessed* when
a caller omits the argument. The MCP-side project-root resolution order is: the tool argument
`projectRoot` → `CLAUDE_SPEC_PROJECT_ROOT` → `CLAUDE_PROJECT_DIR` → `process.cwd()`, and the startup
diagnostics report which one was used.

## Enabling, disabling and uninstalling

```bash
# inspect install and enablement status
claude plugin list

# uninstall
claude plugin remove claude-spec@your-marketplace

# remove the marketplace registration
claude plugin marketplace remove your-marketplace
```

Where there is no separate disable command, uninstalling is the deterministic way to disable and
roll back. Re-adding the same marketplace and installing again restores it.

## Configuration merging and rollback

Installation does not rewrite your project's settings. At runtime it creates or updates the Markdown
allowed by the write policy under `.kiro/specs/`, and creates `.kiro-spec-private/` at the project
root for rebuildable state; projects should add `.kiro-spec-private/` to `.gitignore`.

Rollback: uninstall the plugin, remove the marketplace you added only for it, then restart the
session. Uninstalling does **not** delete the project's `.kiro/specs/` or `.kiro-spec-private/`;
once you are sure the workflow state need not be recovered, the latter may be deleted by hand.
Shared spec Markdown is not installation residue and should not be removed along with an uninstall.

## Project adapter

The service requires the target project to have `.codex/codex-spec.json` — a **cross-host shared
project file**, not this plugin's identity (see [README.md](README.md)). Copy
`adapter.example.json` from the plugin directory, replace the date, authority file and rules with
the project's real values, and save it into the target project:

```bash
mkdir -p .codex
cp /absolute/path/to/claude-spec/adapter.example.json .codex/codex-spec.json
```

The example's `authorityHash` **must not be copied**. It has to be the SHA-256 of the raw bytes of
`authorityFile`, computable at the target project's root:

```bash
node --input-type=module -e "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs'; const raw = readFileSync('.kiro/steering/spec-conventions.md'); console.log('sha256:' + createHash('sha256').update(raw).digest('hex'));"
```

Write the whole output into `authorityHash`. With no adapter the service returns `ADAPTER_MISSING`;
with invalid JSON, paths or policy it returns `ADAPTER_INVALID`; on an authority-file hash mismatch
it returns `ADAPTER_UNTRUSTED`.

## Project root and host smoke test

After a first install, or after a host upgrade, you must run the host smoke test:

1. Start a new session in the target project.
2. Call `spec_health({ projectRoot })` with the target project's absolute path, and confirm the
   returned `projectRoot` matches.
3. Check `cwd` and `configuredProjectRoot` in the startup diagnostics on stderr.
4. Do not call `spec_init`, `spec_adopt` or `spec_write` before the project root is confirmed.

Before executing an existing `tasks.md`, use `spec_list` to confirm whether the target is `managed`
or `external`. An `external` spec must be explicitly `spec_adopt`ed first; then follow
`spec_task_plan` → `spec_task_begin` → `spec_task_record_check` → `spec_task_complete` /
`spec_task_fail`, passing a `workspaceSnapshot` collected under the same policy to
plan/begin/complete. Do not bypass the plugin to modify checkboxes mid-execution.

## The stage gate: installation and verification

`hooks/hooks.json` registers one `PreToolUse` (`matcher: "Write|Edit|MultiEdit"`) running
`${CLAUDE_PLUGIN_ROOT}/scripts/spec-stage-gate.sh`. That shell layer does exactly one thing: when
`node` is missing inside the container it **allows the write and says so**, rather than ending in a
hook failure of unclear meaning.

### Gate liveness probe (run after install / upgrade)

⚠️ **This section follows the Cowork topology** (`CLAUDE_SPEC_TOPOLOGY=cowork`): the hook is in the
session container while the MCP server is on the user's machine, so the two need not share a
filesystem, and judging liveness requires reading the audit log **inside the container**.
**The default local Claude Code CLI topology does not need this section** — hook and MCP are on the
same machine and filesystem, so calling `spec_health` and reading `gate.status` is enough
(`"observed"` is live evidence; `"unobserved"` is more suspicious, so check first whether
`hooks.json` was claimed by this install). `spec_health` returns a `gate.topology` field so you can
confirm which topology the verdict used.

🔴 **The audit log is on by default.** Its location prefers somewhere a human can actually read:

| Condition | Location | `logSource` |
|---|---|---|
| a project root is available in the environment | `<projectRoot>/.claude/claude-spec-gate.log` | `project` |
| otherwise | `os.tmpdir()/claude-spec-gate.log` | `tmpdir` |

```bash
CLAUDE_SPEC_GATE_LOG=/path/to/log   # relocate (absolute path; a relative path always lands in tmpdir)
CLAUDE_SPEC_GATE_LOG=off            # disable the audit log (**does not affect the heartbeat**)
```

**Why it is on by default**: in the incident that motivated it, that log was the *only* thing that
could answer "did the host call this script at all", and it was opt-in — turning it on required
changing the environment of the host's hook launch, a position nobody in Cowork could reach, so
troubleshooting stalled completely. **An observer you can only switch on once you can already
observe is not an observer.**

Each invocation appends **two lines**, each carrying `logPath` / `logSource` so a reader need not
guess whether it is in the container or the project directory:

| Line | Written when | Answers |
|---|---|---|
| `phase: "entry"` | process start, **before any parsing** | was this process **launched** by the host at all |
| `phase: "decision"` | after the verdict is reached | what was decided, why, plus `tool_name` / `target` / `agent_id` |

**Both allow and deny are logged** — logging only denials makes "the host didn't call it" and
"it was called but took an allow branch" look identical. There is a 1 MiB cap; past it, writing
**stops** (answering "was it called" depends on the earliest lines, not the latest).

#### How to read it — **run this with the Bash tool inside the session, don't go looking on the Mac**

The hook runs in the session container, and **the Bash tool is in that same container** — so reading
the log is a single in-session command:

```bash
# 1) look at the current state
cat "${CLAUDE_PROJECT_DIR:-.}/.claude/claude-spec-gate.log" 2>/dev/null || cat /tmp/claude-spec-gate.log
# 2) in .kiro/specs/<feature>/, write design.md out of stage (no requirements.md in the same directory)
# 3) cat again and look at the new lines
```

**Do a normal write first (one that takes the allow path) before interpreting "there is no deny
line"** — otherwise you cannot distinguish "the log is unreadable" from "the gate wasn't called".

#### The verdict table (four mutually exclusive outcomes)

| Log | Meaning |
|---|---|
| has `entry`, last line `decision: "deny"` | the host called it and the gate decided correctly → the problem is that the **host did not enforce the denial** |
| has `entry`, last line `decision: "allow"` | the host called it and took an allow branch → `reason` says **which** branch |
| has `entry`, **no decision line** | the host called it but the process never reached a verdict (malformed payload / stdin never EOF'd) → see the `problem` field |
| **not a single line** | the host **never launched the process** |

🔴 **The table's premise**: "not a single line" only means something if **the path this probe reads
is the same filesystem the gate writes to**. That is a premise to be tested, not an established
fact — so do step 1 above first, confirming the probe *can* read a log that already has content,
before concluding anything from a missing deny line.
**An observer's failure must not be read as a phenomenon.**

#### The easier route: `spec_health`'s `gate` field

Each invocation also overwrites a heartbeat (`<projectRoot>/.claude/claude-spec-gate.heartbeat`),
which `spec_health` reads back. **Look at `status` first; only `"observed"` is live evidence:**

| `status` | Meaning | Can you conclude? |
|---|---|---|
| `"observed"` | a valid heartbeat was read | ✅ **yes** — the gate was called at least once; `lastSeen` / `ageMs` / `decision` are the evidence |
| `"unobserved"` | the path exists but holds no valid heartbeat (absent / empty / truncated JSON / illegal `ts`) | ❌ **no** — it is **neutral**; read the accompanying `caveat` |
| `"unavailable"` | the heartbeat path cannot be resolved at all (no `projectRoot`) | ❌ no |

```json
{"gate":{"status":"observed","heartbeatPath":"…","lastSeen":"2026-09-14T01:01:19.000Z",
         "ageMs":4200,"decision":"deny","event":"PreToolUse","reason":"out-of-stage write: …"}}
{"gate":{"status":"unobserved","heartbeatPath":"…","lastSeen":null,"ageMs":null,
         "decision":null,"event":null,"reason":null,
         "caveat":"this machine cannot read that hook's heartbeat, which is not evidence that the gate wasn't called: …"}}
```

`status: "unobserved"` is **not** the same as "was not called": it says "**I did not see it**", not
"it did not happen". The `caveat` exists for exactly that sentence — writing it only in the docs
and waiting for someone to read it would be equivalent to not writing it.

It deliberately does **not** provide `alive: true/false` or any time threshold: how often the gate is
called depends on writing pace, and any "no heartbeat for N minutes ⇒ dead" would misfire in normal
use. **`status` describes whether this read worked, not whether the gate is alive.**

🔴🔴 **Under the Cowork topology this read is *always* `unobserved`. Do not use it as a liveness
verdict.**

The heartbeat lands at `<projectDir>/.claude/…`, and the two sides' `projectDir` **cannot** be the
same directory:

| | who supplies `projectDir` | lands on |
|---|---|---|
| **writing** the heartbeat (hook) | the payload's `cwd` — a path inside the session container | the **container** filesystem |
| **reading** the heartbeat (`spec_health`) | the caller's `projectRoot` — a path on the user's machine | the **Mac** filesystem |

That is this plugin's own "hook in the container, MCP on the machine" two-path conclusion —
**the gap the heartbeat tries to cross is precisely the gap it was invented to explain.**

⚠️ So a `status` other than `"observed"` does **not** mean "never called": a live gate is also
`unobserved`. Reading it as "the gate is dead" yields a **false death signal** — worse than no
signal. From the MCP side there is **no way** to tell "not called" from "the two paths don't share
a filesystem", so the code does not pretend to have solved it: it writes the situation as
`status` + `caveat`.

**When it does work**: when hook and MCP are on the same machine and filesystem (for example the
local Claude Code CLI, rather than Cowork's container + bridge topology). In Cowork, liveness can
only be judged by the probe above, reading the audit log **inside the container**.

### If the probe produces no lines at all

- That the host supports `PreToolUse` remains a **measured fact** (and it covers subagents).
  **Do not write the conclusion as "Cowork does not support hooks"**, and do not downgrade to
  "rely on SKILL.md reminders".
- But equally, **do not** default to "I checked thoroughly, therefore I must have misconfigured it".
  The correct shape is: **exhaust your own side first** (the matcher, the location of
  `hooks/hooks.json`, the manifest's `hooks` field, the verdict table above) — and **after**
  exhausting it, pointing at the environment is allowed.
- Whichever way it points, **first confirm the probe can read a log that already has content** (by
  doing one write that takes the allow path). Otherwise "no deny line" cannot distinguish "the gate
  wasn't called" from "the log is unreadable" — **an observer's failure must not be read as a
  phenomenon.**

## Offline verification

No network or npm registry required:

```bash
cd plugins/claude-spec
npm run doctor                                        # = npm run check && npm test
npm_config_cache=/tmp/claude-spec-npm-cache npm pack --dry-run --json
```

## Rules derivation (`.claude/rules/`)

`scripts/gen-rules.mjs` derives five `.claude/rules/*.md` files from
`packages/kiro-rules/lib/kiro-rules.js` (**the single source of truth**): `spec-core.md` (no
`paths:`, always loaded) plus one each for requirements / design / tasks / bugfix.

⚠️ **The output directory must be passed explicitly** (`--out <dir>`); the generator does not guess
any downstream project's path. To check freshness, run it with `--check` against a directory you
have already generated into.

⚠️ **Change the source of truth and you must re-generate.** The consuming project's pre-commit
freshness check is error-level: changing `packages/kiro-rules` without re-running the generator will
have your next commit in that project refused.

## What has not been tested

This file marks untested slots with `⟨待测⟩` where a claim rests on inference rather than
measurement. Two are worth calling out explicitly, because both are places where a reasonable reader
would otherwise assume the opposite:

- **The MCP server and the hook are not on the same machine** in the Cowork topology. Anything that
  assumes a shared filesystem between them (including the heartbeat above) does not hold there.
- **`fileGuardrail` is `false`.** There is no guardrail on direct file writes. That is the expected
  value, not a startup failure.

## Evaluation-only probe

`plugins/claude-spec/fixtures/admission-probe.mjs` is a repeatable probe for the evaluation-only
admission mode. It writes requirements, design and tasks through the service, reads tasks back to
verify byte stability, and reports the exit status of a fixed-argv validator. It never modifies
steering files, templates or validators.

The adapter sample shipped alongside it binds an authority hash to a **specific project's** steering
file's raw bytes — not a general-purpose default. Re-derive the hash from the project you actually
intend to probe before use.

> 🔴 Probing a **real downstream project** is a cross-repository write: it requires the user's
> explicit authorisation, and that project's working tree must be confirmed clean first. With either
> precondition unmet, run only the plugin's isolated tests — and do not describe their result as a
> real-host admission pass. After any real run, independently re-check the authority hash and
> `git diff -- .kiro/steering`.
