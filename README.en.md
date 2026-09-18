> 🌐 [中文](README.md) · **English**

# kiro-spec

**Built on Kiro's Spec system. One core, running on three hosts at once, collaborating with Kiro
on the same spec.**

The same Spec capability runs on **Codex**, **DeepSeek Harness** and **Claude** — and the specs it
writes match Kiro's native format, so **Kiro and those three hosts can collaborate on one spec**:
whatever any of them writes, the others can pick up, edit and execute.

## The four participants

| Participant | Form | Tool surface |
|---|---|---|
| **DeepSeek Harness** | [`dsh-spec`](plugins/dsh-spec/) — cordis plugin | 13 tools + a `/spec` command |
| **Codex** | [`codex-spec`](plugins/codex-spec/) — MCP server | 25 tools, all schema-validated |
| **Claude** | [`claude-spec`](plugins/claude-spec/) — MCP server + `PreToolUse` gate | 26 tools |
| **Kiro** | native — the spec layout and the decision rules match, so it reads and writes the same specs | — |

The three plugins **share one decision core** (`packages/`); only thin adapters differ. So the same
spec gets the same verdict on all three — a document cannot pass on one host and fail on another.

---

## What a Spec is

**Requirements-driven, with a matching document for every feature.**

A feature does not start with code. It starts with three documents that **constrain each other**:

| Document | Answers |
|---|---|
| `requirements.md` | **what** — each requirement carries a `**User Story:**` and EARS acceptance criteria (`WHEN … THE SYSTEM SHALL …`) |
| `design.md` | **how** — architecture, data models, component interfaces, error handling, testing strategy |
| `tasks.md` | **what it takes** — a dependency-ordered implementation checklist, each item pointing back at `_Requirements: x.y_` |

Three more shapes exist: **bugfix** uses its own document (`bugfix.md`, with Current / Expected /
Unchanged sections and `SHALL CONTINUE TO` for regression protection), **design-first** confirms the
design before deriving requirements, and **quick** writes all three and confirms them in one batch.

**"A matching document for every feature" is not an appeal — it is decidable.** 41 rules report
missing sections, acceptance criteria written as prose, a malformed dependency graph, a fourth task
state… **a non-compliant spec gets pointed out by the diagnoser**, not left to good intentions.
That is the difference between this and "write a design doc".

## Why this exists

The common failure mode of specs written by coding agents is not "can't write" — it is:

- **Written but non-compliant** — a heading off by one word, acceptance criteria written as prose,
  a task list with no dependency graph;
- **Non-compliant but silent** — no error, just a behaviour that **quietly degrades** (the worst
  kind: a malformed dependency graph makes the host discard the whole graph and silently fall back
  to fully serial execution, with no error and no warning);
- **Reported, but on one host only** — swap the host and the same document passes on one and fails
  on the other.

This project's three claims are aimed exactly at those: **format is a verdict, not a style
suggestion**; **degradation must be loud**; **the decision core is host-agnostic**. Expanded in
[docs/philosophy.md](docs/philosophy.en.md).

## What this repository is good at

**① It covers the whole Spec lifecycle, not just authoring.**

Init → authoring → diagnosis → cross-document analysis → approval → dependency-ordered execution.
The three hosts expose 13 / 25 / 26 tools, and `dsh-spec` adds a `/spec` command. This is not
"a template generator" — the entire flow is inside the tool surface.

**② The rule table is replicated rule by rule, guarded by a frozen test.**

41 decision rules replicated from Kiro's factory validator; the version and sha256 are recorded in
`packages/kiro-rules`, and a frozen test goes red when Kiro upgrades, forcing a re-extraction.
**When our verdict disagrees with Kiro's, we change — not Kiro.** That decides which side every
bug gets fixed on.

**③ Built for engineering modes with high process requirements.**

Writes go through CAS (`expectedRawRevision` + `stateEpoch`), execution through a lease (`ownerToken`
with a 30-minute validity), rule changes through a short-lived credential (`contextProof`). The three
task states, the approval handshake and the three-consecutive-failures gate are all enforced **at the
tool layer**, not left to "remember to do it". Concurrency rests on a state machine, not on good
intentions.

**④ The decision core is decoupled from the filesystem.**

Across the six public packages, **no file under `lib/` imports `node:fs` or `node:path`** — so the
core can be driven entirely on an in-memory port (`packages/spec-analysis/test/port-contract.test.mjs`
does exactly that), and exercised without a filesystem.

**⑤ The three hosts are one semantic, not three implementations.**

The adapters are thin: the 13 files under `plugins/*/lib/core/*` are byte-identical across hosts.
Twelve of them are nothing but `export * from '@my-harness/spec-state/core/…'`; the thirteenth,
`storage.mjs`, is the **only boundary where real `node:fs` enters the pure implementation** —
eight lines wiring a filesystem port in. Diagnosis, state machine and approval all come from one
body of code, and the place where I/O enters is a single file you can point at.

> In terms of **tool-surface completeness and rule coverage** for Spec workflows, this is
> **among the most complete Spec plugins available anywhere**.

## Quick start

```bash
git clone <this-repo> && cd kiro-spec
pnpm install
npm test
```

### Install into a host

Each plugin ships its own `INSTALL.md`:

- [`plugins/dsh-spec/INSTALL.md`](plugins/dsh-spec/INSTALL.md)
- [`plugins/codex-spec/INSTALL.md`](plugins/codex-spec/INSTALL.md)
- [`plugins/claude-spec/INSTALL.md`](plugins/claude-spec/INSTALL.md)

Or build distributable archives yourself:

```bash
npm run pack:all          # archives for all three hosts → dist/
```

The packer **vendors the `@my-harness/*` dependencies into the archive**, so the resulting
package does not rely on the `workspace:` protocol and installs on a machine without this repo.

> ⚠️ **The profile namespace is `kiro-spec/`.** The adapter's `profile` values are checked
> against a **hard whitelist** — a mismatched value is refused at load time, not ignored:
>
> ```json
> "validators": [
>   { "id": "spec-tasks-lint", "profile": "kiro-spec/spec-tasks-lint-v1" },
>   { "id": "spec-validator",   "profile": "kiro-spec/kiro-rules-v1" }
> ]
> ```

### Using it

Ask the agent to call `spec_init` in your project, or use `/spec` in DSH:

```
spec_init(projectRoot, spec="user-login", workflow="requirements-first")
→ creates .kiro/specs/user-login/requirements.md

spec_write(projectRoot, spec="user-login", artifact="requirements", content=..., ...)
→ writes, then diagnoses the format

spec_diagnostics(projectRoot, spec="user-login")
→ reports each format problem with its rule code and severity

spec_task_plan / spec_task_begin / spec_task_complete
→ serial execution with lease and recovery
```

## Reference

| Document | Contents |
|---|---|
| [docs/tools/dsh-spec.md](docs/tools/dsh-spec.md) | 13 tools + the `/spec` command |
| [docs/tools/codex-spec.md](docs/tools/codex-spec.md) | 25 MCP tools |
| [docs/tools/claude-spec.md](docs/tools/claude-spec.md) | 26 MCP tools + the stage gate |
| [docs/spec-conventions.md](docs/spec-conventions.en.md) | How to write: headings, EARS, task states, dependency graph |
| [docs/compat.md](docs/compat.en.md) | Differences from Kiro — including what is **deliberately not modelled** |

### Documentation layout

Core documents are **bilingual side by side**: `X.md` (**Chinese**, the default filename) and
`X.en.md` (English), cross-linked at the top of each.

The plugin-level documents (`plugins/<name>/README.md` and `INSTALL.md`) keep their English
versions under [`docs/en/<name>/`](docs/en/) instead — same information, different location.

⚠️ The two are **not translations of each other**. The Chinese plugin documents are the
**original development record**; the English ones are a **public-audience rewrite** that drops a
dated incident record and removes references to internal-only material. Both describe the same
behaviour — reach for the Chinese when you want to know *how* a conclusion was reached.

## Repository layout

```
packages/                    host-agnostic decision core (zero external dependencies)
  kiro-rules/                the 41-rule table — single source of truth
  spec-parser/               recognizer + scanner (which line is a task / which is in a fence)
  spec-analysis/             checklist / drift / amendments / archive / signature
  spec-revision/             rawRevision (dual hash)
  spec-state/                state machine, lease, approval, recovery
  spec-diagnose/             adjudication: assembles the above into unified findings
plugins/                     thin adapters for the three hosts
  dsh-spec/  codex-spec/  claude-spec/
scripts/                     pack-plugin.mjs (packer), consumer-root.mjs, kiro-bundle-root.mjs
```

The layering is a **hard constraint**, not a house style: `packages/` must not contain a single
`node:fs` (all I/O goes through injected ports), so the decision core runs in any host and can be
exhaustively unit-tested.

## Testing

```bash
npm test
```

### Two Node version claims — they are not the same thing

| | Requirement | Why |
|---|---|---|
| **Plugin runtime**<br>(`plugins/*/package.json`) | `>=20 <26` | All three plugins declare this. Node 18 is EOL, so declaring `>=18` would invite installs on an unsupported runtime |
| **This repo's toolchain**<br>(root `package.json`) | `>=22 <26` | pnpm 11 depends on `node:sqlite` (Node 22.5+), so it **cannot start on Node 20** |

CI runs **22 and 24** only — consistent with the toolchain claim. Putting Node 20 in the matrix
would fail, and the failure would have nothing to do with the plugins (the package manager won't
start), which would point people at the wrong conclusion.

> This distinction was added on 2026-09-18. Previously the root `package.json` said `>=20`,
> and that number **could never be verified in CI**. An unverifiable compatibility claim is worse
> than no claim: it packages "untested" as "supported".
>
> ⚠️ An earlier version of this table justified the plugin range with "the code only uses
> `import.meta.dirname`". That was **inaccurate** — `import.meta.dirname` appears in the **tests**,
> not in the runtime code. The range is a support-policy statement, not a derived minimum.

**Some tests skip when no downstream corpus is present** — that is by design. For a full run:

```bash
CONSUMER_REPO_ROOT=/path/to/your/project npm test
```

⚠️ This repo is a public subset exported from a larger development repository. **What is not here,
and why**, plus the difference between a `skip` and a pass, is documented in
[TEST-SCOPE.md](TEST-SCOPE.en.md) — that file is bookkeeping, not a disclaimer.

## Relationship to Kiro

The rule table is replicated from Kiro's factory validator (version and sha256 are recorded in
`packages/kiro-rules`). **When our verdict disagrees with Kiro's, Kiro is right and we change** —
this is written down because it decides which side every bug gets fixed on.

Known un-modelled parts and deliberate differences are listed in [docs/compat.md](docs/compat.en.md).

## Versioning

**Repo tags and plugin versions are two different things, and they are meant to be.**

| | Value |
|---|---|
| latest repo tag | `v1.0.1` |
| root `package.json` | `1.0.1` |
| `claude-spec` | `1.0.0` |
| `codex-spec` | `1.0.0` |
| `dsh-spec` | `0.2.0` |

A repo tag (`vX.Y.Z`) labels a **release of the set** — "this is the state of the three plugins
together". Each plugin also carries **its own version** in its manifest, and that is the version
that shows after installing.

The two are independent on purpose: the three plugins evolve at different rates, and forcing one
shared number would either overstate a small change or bury a large one. So a `claude-spec.plugin`
downloaded from release `v1.0.1` reports `1.0.0` — that is the plugin's own version, not a
mismatch.

## License

MIT — see [LICENSE](LICENSE).
