> 🌐 [中文](compat.md) · **English**

# Differences from Kiro

**When our verdict disagrees with Kiro's, Kiro is right and we change.** This page lists the
**known** differences, in three categories — mixing them together makes it impossible to tell
whether something should be fixed.

---

## 1. Deliberate differences (do not change)

These are **intentional**; "fixing" them would be wrong.

| Item | Kiro | This project | Why |
|---|---|---|---|
| Task state markers | recognises `[~]` (`queued`, a first-class state) | only `[ ]` / `[-]` / `[x]` | This project's convention is tighter; `[/]` / `[!]` are errors |
| Fence semantics | indentation-based | same as Kiro's indentation-based semantics | deliberately aligned, not a difference |

⚠️ Note that "three states only" is **not** justified by "Kiro doesn't recognise it" — Kiro does.
Don't use that as the reason.

---

## 2. Known un-modelled ("not done", not "done wrong")

### 1. Two workflow types are not modelled

The real `WorkflowType` enum has two more that this project **knows about but does not implement**:

| Real `workflowType` | Status here |
|---|---|
| `fast-task` | **not modelled.** The document set matches requirements-first (`​.config.kiro` + requirements/design/tasks), but the **flow and presentation order** differ (the real one is a tasks-first checklist). A number of instances were observed in the wild |
| `verify-first` | **not modelled.** **Zero** instances across a body of real `​.config.kiro` files — which does not mean it doesn't exist, only that the corpus doesn't cover it |

### 2. The document set for `quick` differs three ways

Kiro, certain implementations, and this project do not agree on the **document set** for `quick`.
This project requires `quick` to write all three artifacts and then pass a single whole-batch
confirmation; another known implementation produces no `design.md`.
**This one still needs a real-machine sample to settle.**

### 3. The declared-differences register

Deliberate differences are recorded one by one in `packages/spec-parser`'s `declared-diffs.json`.
That list is part of **authoritative provenance**: the diagnoser's `source` field states whether a
given verdict came from `kiro-binary` or from `repo-convention`.

---

## 3. Differences between the hosts

All three hosts share the decision core; only the adapters differ. Known capability gaps:

| Capability | dsh-spec | codex-spec | claude-spec |
|---|---|---|---|
| Tool count | 13 + `/spec` command | 25 | 26 |
| Stage gate (`PreToolUse`) | ❌ | ❌ | ✅ |
| `spec_amend` | ✅ | ❌ | ✅ |
| Partial reads (`outline` / `section`) | ❌ | ❌ | ✅ |
| `knownRevisions` receipts | ❌ | ❌ | ✅ |
| Signature merged into the atomic write | ❌ | ❌ | ✅ |

⚠️ **The capabilities missing from `codex-spec` (`spec_amend`, partial reads, `knownRevisions`) were
not a considered decision** — the shared layer already implements them; that host's tool list simply
doesn't expose them. Exposing them means updating that directory's `tool-schema.test.mjs` and
`SKILL.md`, plus re-running the packer drift checks. This is stated plainly so it isn't read as
"deliberately unsupported".

---

## 4. Replaced sources of truth

Some verdicts do **not** originate in Kiro — they originate in a consuming project's conventions
(the signature format, for example). In this project's public version, those verdicts are anchored
to **this project's own conventions document**, carried by
[spec-conventions.md](spec-conventions.en.md).

The reason: **the authority behind a verdict must be checkable.** Pointing at something the reader
cannot reach is equivalent to having no authority at all — the next person has no way to judge
whether it should change.
