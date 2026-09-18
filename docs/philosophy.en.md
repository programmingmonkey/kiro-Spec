> 🌐 [中文](philosophy.md) · **English**

# Philosophy

This project is not "Kiro's prompts, copied". It is a **decision core** with three thin adapters.
The six principles below are why it looks the way it does — each one cost at least one real mistake.

---

## 1. Format is a verdict, not a style suggestion

The usual failure when a coding agent writes a spec is not "can't write it" — it is
"wrote it, but non-compliant": a heading off by one word, acceptance criteria written as prose,
a task list with no dependency graph.

So this project does not **guide** or **suggest**. It **adjudicates**: 41 rules, each with a rule
code and a severity (error / warning), reported by `spec_diagnostics`.

The rules are **replicated**, not invented — see principle 6.

---

## 2. Degradation must be loud

This is the single most important principle here, and the one that has cost the most.

**The same mistake can end three ways. The worst is not the one that errors:**

| Outcome | Example | Damage |
|---|---|---|
| Errors | A missing `## Requirements` section | Small — you'll fix it |
| **Silent degradation** | A malformed dependency graph → the host discards the whole graph and falls back to fully serial execution, **with no warning** | **Large** — you think nothing happened |
| **Silent zeroing** | A corpus path fails to resolve → `return []` → the check "passes" as usual | **Largest** — the corpus vanished and the tests went *greener* |

Hence the hard rule:

> When resolution fails, **silent degradation is not allowed**. The caller must either
> skip-with-a-loud-message or fail explicitly, embedding the list of every path it tried.

And the companion accounting discipline:

> **A skip is not a pass.** The delivery notes must say it didn't run.

[TEST-SCOPE.md](../TEST-SCOPE.en.md) is that discipline's output: it documents what this repository
does **not** contain, rather than "654 tests pass". Those are two different sentences.

### The three hard requirements on the dependency graph are worth memorising

`## Task Dependency Graph` must be `{"waves":[{"id":0,"tasks":["1"]}]}`:

1. Not a bare array `[[1,2],[3]]`;
2. Every wave must carry a **numeric** `id` (a string `"0"` is rejected — the check is
   `typeof === "number"`);
3. Task ids must be written as **strings** — `["1","2"]`, not `[1,2]`.

Violate any one and the host **discards the entire graph and silently falls back to fully serial
execution** (no error, no warning). The numeric `id` carries no meaning, but it must exist and be
a number.

⚠️ Worse: the real linter **cannot detect (2) or (3)** (it only asserts that `waves` is a non-empty
array). So the only symptom of getting it wrong is that **parallelism disappears** — a performance
problem that never reports itself.

---

## 3. The decision core must be host-agnostic

All three hosts (DSH / Codex / Claude) share **one** `packages/spec-diagnose`. So the same spec
must get the same verdict on all three — which is the problem this project set out to solve
(the same document passing on one host and failing on another).

This is enforced by a **hard architectural constraint**, not a house style:

> **Not a single `node:fs` may appear in `packages/`.** All I/O goes through injected ports.

The result: the decision core runs in any host, can be exhaustively unit-tested, and can be
verified without a filesystem. The layering is not decorative — the dependency direction between
`packages/` (adjudication) and `plugins/` (adapters) is a real constraint, guarded by tests.

---

## 4. Concurrency and collaboration rest on a state machine, not on good intentions

A spec gets touched by multiple sessions and multiple agents. So the write path carries three locks:

| Mechanism | What it prevents |
|---|---|
| **CAS** (`expectedRawRevision` + `stateEpoch`) | Overwriting someone else's change with a stale copy |
| **lease** (`ownerToken` + `planRevision`) | Two sessions doing the same task at once |
| **contextProof** (short-lived credential) | A rule changed but the agent is still working from its old understanding |

Plus one rule about not leaving intermediate states behind:

> Task markers have exactly three states — `- [ ]` / `- [-]` / `- [x]` — and **`[-]` must never
> survive across sessions**.

`[-]` is written at the moment work actually starts, and before finishing it must converge to
`[x]` or revert to `[ ]`. A task parked at `[-]` makes the next session believe someone is
working on it — a quiet deadlock.

Failure is the same: `spec_task_fail` reverts `[-]` to `[ ]` rather than leaving it.

---

## 5. State the boundaries honestly instead of pretending they don't exist

This plugin's tier is **`collaborative`**, not hard security. That sentence appears in the README
and in the gate documentation because **describing a collaboration convention as a security
boundary is the most dangerous mistake available** — it leads people to rely, in a place where they
genuinely need protection, on something that will not stop anyone determined to go around it.

What these checks stop is the normal flow of "didn't realise I was crossing a line".

Concretely, for the Claude host's stage gate, the documentation states explicitly when it **may be
dormant**, how to read each of the three `gate.status` values, and **which path the gate does not
cover at all**. "The gate exists" and "the gate is alive right now" are two different sentences.

---

## 6. When we disagree with Kiro, Kiro is right and we change

The rule table is replicated from Kiro's factory validator; its version and sha256 are recorded in
`packages/kiro-rules`, guarded by a **frozen test**: a Kiro upgrade turns it red and forces a
re-extraction.

That decides which side every bug gets fixed on:

> **When our verdict disagrees with Kiro's, we change — not Kiro.**

At the same time, **deliberate differences must be registered explicitly** rather than blended into
"we replicated it inaccurately". Which differences are intentional and which are simply not done
yet are listed in [compat.md](compat.en.md). "Not done" and "done wrong" are two different things;
mix them and nobody can tell whether something should be fixed.
