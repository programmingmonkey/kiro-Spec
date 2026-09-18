# kiro-spec

**A Kiro-compatible Spec workflow — requirements → design → tasks — for three hosts.**

It turns "think it through before you code" into a **structured, enforced engineering process**:
requirements become verifiable items, design becomes traceable components, tasks become a
dependency-ordered checklist, execution follows that order, and a diagnoser watches the format
at every step.

One shared core, three hosts:

| Host | Plugin | Form | Tool surface |
|---|---|---|---|
| **DeepSeek Harness** | [`dsh-spec`](plugins/dsh-spec/) | cordis plugin | 13 tools + a `/spec` command |
| **Codex** | [`codex-spec`](plugins/codex-spec/) | MCP server | 25 tools, all schema-validated |
| **Claude** | [`claude-spec`](plugins/claude-spec/) | MCP server + `PreToolUse` gate | 26 tools |

All three hosts share the **same L0 decision core** (`packages/`). Only the adapters differ.
So the same spec gets the same diagnosis on all three — which is the problem this project
set out to solve.

> 🌐 **English** · [中文 README](README.zh-CN.md)

---

## Why this exists

The common failure mode of specs written by coding agents is not "can't write" — it is:

- **Written but non-compliant** — a heading off by one word, acceptance criteria written as prose,
  a task list with no dependency graph;
- **Non-compliant but silent** — a format problem that raises no error, only silently degrades
  behavior (the worst kind);
- **Reported, but on one host only** — swap the host and the same document passes on one and
  fails on the other.

This project's three claims are aimed exactly at those:

1. **Format is a verdict, not a style suggestion.** 41 rules, replicated from Kiro's factory
   validator, each with a rule code and severity.
2. **Degradation must be loud.** An unparseable dependency graph is **not allowed** to silently
   fall back to fully serial execution — see [docs/philosophy.md](docs/philosophy.md).
3. **The decision core is host-agnostic.** All three adapters call the same `spec-diagnose`;
   the verdict must agree.

Design rationale and trade-offs live in **[docs/philosophy.md](docs/philosophy.md)**.

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
| [docs/spec-conventions.md](docs/spec-conventions.md) | How to write: headings, EARS, task states, dependency graph |
| [docs/compat.md](docs/compat.md) | Differences from Kiro — including what is **deliberately not modelled** |

### Documentation layout

Core documents are **bilingual side by side**: `X.md` (English, the default filename) and
`X.zh-CN.md` (Chinese), cross-linked at the top of each.

The plugin-level documents (`plugins/<name>/README.md` and `INSTALL.md`) keep their Chinese
versions under [`docs/zh-CN/<name>/`](docs/zh-CN/) instead — same information, different location.

⚠️ Those plugin-level Chinese documents are the **original development version**, not a
translation of the English. The English ones are a **public-audience rewrite**: they drop a dated
incident record and remove references to internal-only material. Where the two differ in
substance, follow the English.

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
[TEST-SCOPE.md](TEST-SCOPE.md) — that file is bookkeeping, not a disclaimer.

## Relationship to Kiro

The rule table is replicated from Kiro's factory validator (version and sha256 are recorded in
`packages/kiro-rules`). **When our verdict disagrees with Kiro's, Kiro is right and we change** —
this is written down because it decides which side every bug gets fixed on.

Known un-modelled parts and deliberate differences are listed in [docs/compat.md](docs/compat.md).

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
