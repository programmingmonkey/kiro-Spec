> 🌐 [中文](../../../plugins/dsh-spec/INSTALL.md) · **English**

# dsh-spec installation guide

> Normalises a feature or a fix into Kiro-style three-document specs and enforces staged progress.
> This package is a **DeepSeek Harness (DSH) cordis plugin** and is only valid inside a DSH
> environment.

## Prerequisites

- A working DSH environment (one that can resolve `@deepseek-ai/dsh-*` packages).
- This package declares exactly one peer dependency: `@deepseek-ai/dsh-tools` (shipped with DSH;
  no separate install).

## Installation

### Method A: build an archive (what users do)

Run the packer **from this repository's root**:

```bash
node scripts/pack-plugin.mjs dsh-spec --out dist/dsh-spec.plugin
```

It does three things, and **the third one turns red**:

1. Collects the plugin tree into a zip;
2. **Vendors** the `@my-harness/*` dependency closure into `vendor/`, rewriting bare specifiers in
   the source to relative paths — so the result **does not depend on the `workspace:` protocol**;
3. Self-checks: no bare `@my-harness/` specifier may remain, and every rewritten relative path must
   actually exist. Miss one package and it fails here, rather than after you install it and hit
   `ERR_MODULE_NOT_FOUND`.

Unpack the archive into your DSH profile directory:

```bash
unzip dist/dsh-spec.plugin -d <DSH_DIR>/.dsh/profiles/dsh-spec
```

Then point your profile's `cordis.patch.yml` at that directory (see "Mounting into your DSH
profile" below).

> ⚠️ **The archive's `package.json` is pruned**: any `script` naming a file that isn't in the
> archive is deleted. That is deliberate — "what you claim must be in the package". So you will see
> `package.json 剪掉 N 条不成立的 script` in the packer's log; that is not an error.
>
> To check whether an archive has drifted from the source:
> `node scripts/pack-plugin.mjs dsh-spec --check`.

> 🔴 **Why not `npm pack`?** `workspace:` is resolved only inside a workspace, by pnpm or yarn —
> **npm does not rewrite it**, so an archive produced by `npm pack` carries `workspace:*` verbatim
> in its `package.json`, and installing it outside the workspace fails with
> `EUNSUPPORTEDPROTOCOL`. The same applies to `file:` and `git+` references. **Use the packer.**
> This is precisely why the packer vendors the dependency closure: to remove that precondition.

### Method B: as part of this repository's workspace (what plugin developers do)

`pnpm-workspace.yaml` already includes `plugins/*` and `packages/*`. After `pnpm install` at the
repository root:

- `plugins/dsh-spec/node_modules/@my-harness/kiro-rules` is a symlink to `packages/kiro-rules` —
  a resolution location reachable **both with and without** `--preserve-symlinks`. Don't rely on
  hoisting to the root.
- That symlink must be created by `pnpm install`. Creating it by hand is a retired practice here.

On the DSH profile side you only need one symlink pointing at this directory:

```bash
ln -s /path/to/kiro-spec/plugins/dsh-spec <DSH_DIR>/.dsh/profiles/dsh-spec
```

The `name` in the profile's `cordis.patch.yml` must point at this plugin's **entry file** (next
section).

## Mounting into your DSH profile

Add an insert line to your profile's `cordis.patch.yml` (or `cordis.yml`):

```yaml
- insert:
    - id: dsh-spec
      # Path to the entry file, resolved relative to the profile directory.
      # .dsh/profiles/dsh-spec is a symlink to plugins/dsh-spec in this repo.
      name: '../dsh-spec/lib/index.js'
      config:
        specDir: .spec                 # single-spec compatibility location (default .spec)
        projectRootMarkers: ['.git']   # markers used to identify the project root
        specsRoot: null                # explicit spec parent directory (optional)
        useFeatureDirs: true           # use the .kiro/specs/<feature>/ layout
        subagentProvider: null         # used by /spec run; must be set to run
```

> ⚠️ `name` is **a path to the entry file**, not a package name. `name: 'dsh-spec'` will **not**
> resolve: the profile's `node_modules` directories contain no package by that name, so nothing on
> the resolution chain can match. (This is an **inference** from that resolution chain — starting
> with the package-name form was never actually tried.) The package-name form would only make sense
> if this package were installed as a dependency of the profile, and that path does not work (see
> the installation section).

## Minimal configuration

If you only want the core three-document workflow (no waves execution), the whole `config` block
can be omitted and the defaults apply:

```yaml
- insert:
    - id: dsh-spec
      name: '../dsh-spec/lib/index.js'
```

## Capabilities and usage

See [README.md](README.md) (the four shapes / directory layout / the `spec_*` tools / the `/spec`
command).

## Verifying the mount

Three steps, in order. Failing any one tells you which layer is broken: symlinks → composition →
tool visibility.

### Step 1: confirm both symlinks exist

This package is **not in the profile's dependency tree** — it is a profile directory reached by
symlink. So `pnpm list dsh-spec` inside the profile directory finds nothing; that is the layout
working as intended, not a failed install. What you check is these two:

```bash
# (1) profile side: the profile directory is this directory
ls -l <DSH_DIR>/.dsh/profiles/dsh-spec

# (2) this package's side: the workspace dependency resolved to the shared package
ls -l plugins/dsh-spec/node_modules/@my-harness/kiro-rules
```

Both must be symlinks. If (1) is broken, the profile has no such plugin. If (2) is broken, run
`pnpm install` at the repository root first (see "Installation").

### Step 2: confirm the composition contains this line

```bash
dsh --dump-config
```

You should see this among the plugin list (or the profile's composition tree):

```
- id: dsh-spec
  name: '../dsh-spec/lib/index.js'
```

- A "module not found" error means the file produced by joining that `name` path against the
  profile directory does not exist (the two symlinks from step 1).
- If the line is simply absent, the `cordis.patch.yml` insert did not take effect — check the id
  and the indentation.

### Step 3: confirm the tools are actually visible

Start a session (or inspect the tool list in `dsh --dump-config`) and confirm the `spec_*` tools
appear:

```
spec_init / spec_write / spec_read / spec_status / spec_task_set / spec_meta / spec_run
```

plus the `/spec` command.

- **None of the tools are present** → one of the plugin's `inject` entries (tools / systemPrompt /
  fs / subagents) is missing from the target profile.
  ⚠️ `inject` is a **hard dependency**: if any one is missing, the whole plugin fails to load and
  **every** `spec_*` tool disappears (not just `spec_run`). `subagents` is provided by
  `@deepseek-ai/dsh-subagent`, which `dsh-base` already mounts, so profiles based on `dsh-base` are
  fine. If your profile doesn't include `dsh-base`, you must ensure all four services exist.
- **The tools are present but `spec_run` / `/spec run` reports "requires
  config.subagentProvider"** → that is **not configured**, not a missing dependency. Add
  `config: { subagentProvider: spawn }` to the `dsh-spec` line in your profile (`dsh-base` already
  mounts `@deepseek-ai/dsh-subagent-spawn-in-process`, whose registered name is `spawn` by
  default). Until it is set, the core three-document workflow is unaffected and `/spec plan` still
  previews the execution plan.

  > In this repository's own layout nothing needs doing by hand: that configuration lives in a
  > profile patch file which is not itself version-controlled, so an idempotent script invoked by
  > the version-controlled launcher fills it in — creating it if missing, leaving it byte-for-byte
  > alone if already correct, and preserving an explicitly different provider. Doing it by hand is
  > only necessary for a custom layout.

### Smoke test (optional, end-to-end)

In any project directory containing `.git`, start a session and have the agent run:

```
/spec init smoke test
/spec status
```

`/spec status` should report the `requirements` stage, and `.kiro/specs/<feature>/requirements.md`
should now exist in the project. That proves the package, the composition, the tools and the write
location are all working — the whole spec mechanism is available in that project.
