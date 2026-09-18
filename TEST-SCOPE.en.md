> 🌐 [中文](TEST-SCOPE.md) · **English**

# Test scope: what is in this repository, and **what is not**

> This repository is a public subset exported from a larger development repository. Some things
> were deliberately left in; others were deliberately excluded. This document records both —
> **"the tests are green" and "the tests are complete" are two different sentences**, and
> conflating them is lying.

## How to run the tests here

```bash
pnpm install
npm test            # = pnpm -r test
```

**Some tests skip when no downstream consumer corpus is present.** That is a deliberate design
decision, not a malfunction.

Some regression tests must run against **a real downstream corpus** (synthetic corpora can't
reproduce the shapes real-world files take: indentation, CRLF, historic third-state markers,
malformed fences…). That corpus belongs to the project consuming this plugin, and is private — it
is not in this repository. The tests concerned resolve a **configurable** root through
`scripts/consumer-root.mjs`:

```bash
CONSUMER_REPO_ROOT=/path/to/your/project npm test
```

When it can't be resolved they **skip with a loud message** (printing every path they tried) and
**never pass silently**. The reason for that rule is worth recording: an earlier version wrote
`if (!existsSync(root)) return []`, so the whole corpus layer silently zeroed out while the checks
kept "passing" — the corpus disappeared and the tests went *greener*.

⚠️ **A skip is not a pass.** For a full run, set `CONSUMER_REPO_ROOT`.

## What was deliberately excluded, by category

### 1. Corpus-bound golden regressions

The excluded tests assert **byte-exact expectations of this repository's development corpus** —
for example, "the diagnostic output for 15 artifacts across 5 real specs is byte-identical to
before the extraction".

**Synthetic corpora cannot save them**: the assertions compare the bytes of those specific
documents, not their shape. And that corpus is the development repository's own `.kiro/specs/`,
which is self-documenting material about its own history and has no reason to be public. So the
whole block was excluded.

The cost, stated plainly: **this repository is missing that coverage.** Those tests still run in
the development repository.

This covers `test/corpus-*.test.mjs`, `test/*-reachability.test.mjs`, `test/*-closure.test.mjs`,
`test/assembly-equivalence.test.mjs`, `test/signature-fences.test.mjs`,
`test/amendments-guard.test.mjs`, `test/evidence.test.mjs` and others.

### 2. Downstream corpus artifacts and derived evidence archives

- Read-only copies of the downstream project's real spec files (once used as authoritative
  regression fixtures for the diagnoser);
- Goldens / baselines / conflict-consequence archives generated from that corpus;
- Tests that depend on the downstream project's **product domain** (the spec directory names
  themselves give away what that project does).

### 3. The development repository's internal material

Development retrospectives, research notes, task-level plans, sample assets, one-off probes —
irrelevant to anyone using the plugin.

### 4. Assertions specific to the author's machine

A few tests assert "this machine should resolve to a certain downstream project" or "the evidence
file referenced by the README exists". The former is necessarily false for any external reader; the
latter references files that are **deliberately unpublished**, and keeping it would leave dangling
references in the README. Excluded as a block.

## The export mechanism

The export script (which lives in the development repository) does three things, and **the third is
a hard gate**:

1. **Rename rather than delete** — the downstream project's name is replaced with a neutral term.
   The comments are this repository's argumentative backbone; deleting them would destroy
   maintainability. After renaming, an external reader still gets the full argument, with the
   protagonist recast as "a real corpus".
2. **Keep the tests, make them optional** — see the `CONSUMER_REPO_ROOT` section above.
3. **Forbidden content is an assertion, not a wish** — the output is scanned line by line, and a
   single hit exits non-zero. Three categories: the downstream project's identifier, local absolute
   paths, and the downstream project's corpus names.

The third category's "corpus names" rule was **added after being burned**: an archive file contained
no project name, yet held more than twenty of that project's real spec directory names. The
string-based gate let it through completely — and one glance at those names tells you what that
product does and where it's going. A gate can only catch strings; it cannot catch **corpus shape**.
So that layer relies on explicit exclusion plus a names list as a backstop.
