> 🌐 [中文](claude-spec.md) · **English**

# `claude-spec` tool reference

The Claude host. **26 MCP tools**, plus a `PreToolUse` stage gate.

- Form: stdio MCP server + hooks (see
  [../en/claude-spec/INSTALL.md](../en/claude-spec/INSTALL.md))
- One more tool than `codex-spec` (`spec_amend`), and partial reads / signature merging are
  **unique to this host**

---

## 1. How it differs from `codex-spec` (only three ways)

| Item | claude-spec | codex-spec |
|---|---|---|
| `spec_amend` | ✅ present (incremental correction, below) | ❌ absent |
| `spec_read`'s `outline` / `section` | ✅ partial reads | ❌ full text only |
| `spec_context`'s `knownRevisions` | ✅ byte-identical files get a receipt only | ❌ always returns full text |
| `spec_write`'s `signature` | ✅ merged into the same atomic write | ❌ absent |

The other 22 tools' semantics and required parameters are **identical** to `codex-spec` — see the
same-named entries in [codex-spec.md](codex-spec.en.md).

### `spec_amend` (unique to this host)

The incremental correction channel for an approved spec — change one thing without resending the
whole body.

| `kind` | Semantics |
|---|---|
| `param` | edit a parameter value in place via `from`/`to` (`from` must match exactly once) |
| `requirement` | append a requirement, numbered after the current maximum |
| `design` | append a `## Amendments` entry and insert a pointer after the `anchor` line |

⚠️ **`heading` (or its equivalent `title`, pick one) is the title of *this amendment itself***
(`### …` or bare text). **Do not** pass the section name `## Amendments` — that section is created
by the tool, and passing it produces two identically-named level-2 headings in the document.

It refuses to modify task bodies and refuses specs under `_archive/`. A write **invalidates** that
artifact's approval and everything downstream of it.

### Partial reads and receipts

- `spec_read(outline=true)` returns only a section index (headings / line numbers / character
  counts); `spec_read(section="<heading>")` returns only that section's body. Both return
  `partial: true` — **do not use a partial read's `rawRevision` to overwrite the whole file.**
- `spec_context(knownRevisions=...)` passes back the `rawRevision` you last received: files that
  are byte-identical get a receipt only (`unchanged: true`), changed ones return full text as
  usual. This exists for long sessions' token budgets.

### Signature merging

`spec_write(..., signature=...)` merges the signature into **the same atomic write**: signature and
content land together, removing a whole class of follow-up operations, with the environment
identifier validated by the plugin. **Appending a line by hand afterwards is not covered by that
guarantee** — whether it counts as a valid signature is decided by the parser, and if it's malformed
it is still a substantive change and still invalidates the approval.

---

## 2. The stage gate (`PreToolUse`)

This host has a `PreToolUse` hook that checks stage order **before** a write happens; an
out-of-stage write is refused.

🔴 **It is a collaboration convention, not an enforceable security boundary.** What it stops is the
normal flow of "didn't realise I was crossing a line", not someone determined to go around it. The
plugin describes its own tier as `collaborative`.

🔴 **The gate may be in an unobserved state.** `spec_health` returns a `gate.status` with three
values, and **only `"observed"` is evidence that the gate is alive**:

| `gate.status` | How to read it |
|---|---|
| `observed` | ✅ live evidence: the hook really was called (a heartbeat was written) |
| `unobserved` | ⚠️ **neutral** — it does not constitute evidence that the gate wasn't called |
| `unavailable` | there isn't even a heartbeat path |

**Paths that go through the MCP tools are unaffected by the gate**: `spec_write` and friends carry
their own CAS, lease, approval and signature protection. The only unprotected path is bypassing the
MCP layer and using the host's native `Write`/`Edit` directly.

### The two runtime topologies

The `CLAUDE_SPEC_TOPOLOGY` environment variable (read once when the MCP server starts; there is
**no automatic detection**):

| | `local` (default) | `cowork` (explicit) |
|---|---|---|
| Relationship between hook and MCP | same machine, same filesystem | hook in the session container, MCP on the user's machine |
| How to read `gate.status === "unobserved"` | **more suspicious**: check whether `hooks.json` was claimed by this install and whether `PreToolUse` ever fired | **neutral** |

An invalid value (neither `local` nor `cowork`) makes the process **fail at startup** with the reason
on stderr — it does **not** quietly fall back to `local`. The reason: a wrong topology reading sends
troubleshooting in the wrong direction, which is worse than not deciding at all.
