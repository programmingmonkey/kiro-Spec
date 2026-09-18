> 🌐 [中文](../../../plugins/codex-spec/INSTALL.md) · **English**

# Installation and operations

## Single supported install path

The Codex marketplace must point at the repository's already-vendored `plugins/codex-spec-dist/`,
**not** at the development source directory `plugins/codex-spec/`. The source directory depends on
workspace packages, so installing it directly leaves `@my-harness/spec-state` missing at startup.

Before publishing, run
`node scripts/pack-plugin.mjs codex-spec --out /tmp/codex-spec.plugin` and unpack the archive into
`plugins/codex-spec-dist/`; this repository's marketplace already points at that directory. Then:

```bash
codex plugin marketplace add /absolute/path/to/marketplace-root
codex plugin add codex-spec@your-marketplace
```

This repository commits a **project-level** marketplace registry; it does not rewrite the user-level
Codex configuration. Deployers should point the marketplace entry's `source.path` at
`./plugins/codex-spec-dist`.

## Enabling, disabling and uninstalling

```bash
# inspect install and enablement status
codex plugin list

# uninstall (removes from both Codex's local config and its cache)
codex plugin remove codex-spec@your-marketplace

# remove the local marketplace registration
codex plugin marketplace remove your-marketplace
```

Codex currently manages enablement through install state; where there is no separate disable
command, uninstalling is the deterministic way to disable and roll back. Re-adding the same
marketplace and installing again restores it.

## Configuration merging and rollback

Installation does not rewrite the project's `.codex/config.toml`. At runtime it creates or updates
the Markdown allowed by the write policy under `.kiro/specs/`, and creates
`.codex-spec-private/` at the project root for rebuildable state; projects should add
`.codex-spec-private/` to `.gitignore`.

Codex registers the plugin's `.mcp.json` as a local stdio server named `codex-spec`. If you have a
same-named user-level MCP entry, remove or rename the conflicting entry before installing this
plugin.

Rollback: uninstall the plugin, remove the marketplace you added only for it, then restart the
Codex session. Uninstalling does **not** delete the project's `.kiro/specs/` or
`.codex-spec-private/`; once you are sure the workflow state need not be recovered, the latter may
be deleted by hand. Shared spec Markdown is not installation residue and should not be removed
along with an uninstall.

## Project adapter

The service requires the target project to have `.codex/codex-spec.json`. Copy
`adapter.example.json` from the plugin directory, replace the date, authority file and rules with
the project's real values, and save it into the target project:

```bash
mkdir -p .codex
cp /absolute/path/to/codex-spec/adapter.example.json .codex/codex-spec.json
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

The plugin's MCP starts from the installed plugin root using `cwd: "."` in `.mcp.json`. Every call
must pass the target project's normalised absolute path as the `projectRoot` argument; only legacy
calls that omit it fall back, in order, to `KIRO_SPEC_PROJECT_ROOT` and then the process cwd. After
a first install, or after a Codex upgrade, you must run the host smoke test:

1. Start a new Codex session in the target project.
2. Call `spec_health({ projectRoot })` with the target project's absolute path, and confirm the
   return value matches.
3. Check `cwd` and `configuredProjectRoot` in the startup diagnostics on stderr.
4. Do not call `spec_init`, `spec_adopt` or `spec_write` before the project root is confirmed.

Before executing an existing `tasks.md`, use `spec_list` to confirm whether the target is `managed`
or `external`. An `external` spec must be explicitly `spec_adopt`ed first; then follow the Skill's
`spec_task_plan` → `spec_task_begin` → `spec_task_record_check` → `spec_task_complete` /
`spec_task_fail` order, passing a `workspaceSnapshot` collected under the same policy to
plan/begin/complete. Do not bypass the plugin to modify checkboxes mid-execution.

Only if a legacy client cannot pass `projectRoot`, set `KIRO_SPEC_PROJECT_ROOT` to an absolute path
and restart the session. `codex mcp get codex-spec` helps inspect the registered configuration, but
does not replace an actual `spec_health` host smoke test.

## Offline verification

No network or npm registry required:

```bash
cd plugins/codex-spec
npm run doctor
npm_config_cache=/tmp/codex-spec-npm-cache npm pack --dry-run --json
```

⚠️ That is verification **in the source repository**. **The installed plugin
(`plugins/codex-spec-dist/`) has no `doctor` / `check` / `test`** — they all name files under
`test/`, and `test/` is not shipped, so the packer prunes them. What remains in the archive is
`npm run build` (running `node --check` over the runtime files).

(The reason for pruning: before it, `npm run check` inside the archive hit `MODULE_NOT_FOUND`
outright, and `npm test` ran zero tests and exited 0.)

Expected: syntax checks and tests pass, and the dry-run file list includes `mcp-server.mjs`, the
runtime `lib/`, the Skill, the docs and `adapter.example.json`.

## No-hook baseline

This plugin installs no hooks and requires no hook trust or security bootstrap. `fileGuardrail=false`
in the startup diagnostics is the expected result, not a startup failure. A guardrail for direct
file writes is not introduced here.

## Evaluation-only probe

`plugins/codex-spec/fixtures/admission-probe.mjs` is a repeatable probe for the evaluation-only
admission mode described in [README.md](README.md). It writes requirements, design and tasks
through the service, reads tasks back to verify byte stability, and reports the exit status of a
fixed-argv validator. It never modifies steering files, templates or validators.

The adapter sample shipped alongside it binds an **authority hash to a specific project's steering
file's raw bytes** — it is not a general-purpose default. Before use, re-derive the hash from the
project you actually intend to probe (see "Project adapter" above).

> 🔴 Probing a **real downstream project** is a cross-repository write: it requires the user's
> explicit authorisation, and that project's working tree must be confirmed clean first. With either
> precondition unmet, run only the plugin's isolated tests — and do not describe their result as a
> real-host admission pass. After any real run, independently re-check the authority hash and
> `git diff -- .kiro/steering`.
