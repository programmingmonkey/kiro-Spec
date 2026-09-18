---
name: codex-spec
description: Use the codex-spec Codex plugin for collaborative Kiro-compatible Spec workflows, read-only traceability analysis, and serial task execution.
---

# codex-spec

This Hook-free release supports `requirements-first`, `design-first`, `bugfix`, and `quick` collaborative workflows, plus serial task execution.

- Use `npm run doctor` in the plugin directory to verify the local package.
- Pass the current project's normalized absolute path as `projectRoot` on every MCP tool call. Do not infer the project from the plugin process cwd.
- Treat `fileGuardrail=false` as the normal base-mode state. Do not require or imply Hook trust.
- Before a Spec write, call `spec_context`; send the returned context proof and the latest `rawRevision` to `spec_write`.
- Approvals follow the handshake below: the user sends the exact phrase, you verify changes, then call `spec_request_approval` and `spec_record_approval`. Treat all confirmations as `assurance=collaborative`.
- Use `spec_template` to select workflow-specific templates. To check **format** (the same rules as Kiro's `getDiagnostics` on spec files): after a document is on disk, call `spec_diagnostics` with just the spec name — it reads the files and the spec's `.config.kiro` itself and returns `findings`. Use `spec_validate_artifacts` only for a draft that is not written yet; it needs the full Markdown as input (costly) and cannot see `.config.kiro`.
- This plugin does not diagnose **code** (compile / lint / type errors — the other half of Kiro's `getDiagnostics`). If the host exposes an IDE diagnostics tool, use it; otherwise run the project's own checks (type checker, linter, tests) in the shell.
- Use `spec_analyze` and `spec_quality_preview` only after requirements, design, and tasks exist. They are read-only and return source-located findings.
- `spec_sync_preview` returns only unambiguous append proposals. `spec_sync_apply` requires its source revisions, a fresh design proof, and the exact confirmation `应用同步建议`; it invalidates affected collaborative approvals.
- For quick, write requirements/design/tasks before asking for the single `批准全部 artifacts` approval.
- Do not use this release for converge, parallel task execution, automatic cleanup, or security receipts.
- If the MCP server cannot start, inspect the JSON startup diagnostic on stderr and follow `INSTALL.md`.

## Approval handshake — the user sends the phrase, you verify

Agreed with the user on 2026-09-17. It replaces "request approval as soon as a document is written".

1. **After writing a document, do not call `spec_request_approval`.** End the reply with the path, a short summary, and this request (fill in the artifact):
   > `<path>` 已写完。请 review，可直接修改文件；改完后发送「批准 <artifact>」，我会核对改动后完成审批。

   For `quick`, do this once, after all three documents are written, with 「批准全部 artifacts」 (the tool calls in step 2 then use `artifact=all`).
   While waiting, do not write that document again. If the user asks for changes in chat instead, make them and end with the same request.
2. **When the user sends the exact phrase** (`批准 requirements` / `批准 design` / `批准 tasks` / `批准 bugfix` / `批准全部 artifacts`), in one turn and with **no writes in between**:
   1. `spec_read` the artifact in full (for `quick`, all three). `externalChange` non-null means the file differs from what you last wrote or read — those are the user's edits.
   2. Compare with the version you wrote. If something changed that the user's review cannot explain (for example a section rewritten that they did not mention, or edits from another tool), **stop here** and ask — do not request approval.
   3. `spec_request_approval`, then immediately `spec_record_approval` with the user's phrase verbatim and the `stateEpoch` the request returned.
   4. Tell the user **which version was approved**: "未改动", or a short list of what their edits changed compared with your version.
3. **Do not fix anything between the phrase and the record.** If `spec_diagnostics` or your own reading finds a problem in the user's version, report it and ask whether to approve as-is or fix first; after a fix, the user must send the phrase again.
4. If `spec_record_approval` returns `APPROVAL_STALE`, the file changed after the request. Re-read, tell the user what changed, and wait for the phrase again. `APPROVAL_TEXT_INVALID` means the text was not verbatim — show the exact phrase and wait.
5. After a successful approval, continue with the next document in the workflow, then repeat from step 1.

The plugin only checks the phrase text, the state epoch, and that the content did not change between request and record. It cannot tell whether the user actually read the document, and it cannot tell whether the phrase was said before or after the request — steps 2.2 and 2.4 are what keep the approval tied to the version the user reviewed.

## Execute an existing tasks.md

When the user asks to execute a Spec, use the plugin instead of treating `tasks.md` as an untracked generic plan:

1. Call `spec_health`, then `spec_list` with the absolute `projectRoot`.
2. If the target is `external`, call `spec_adopt` and **omit `workflow`** — the spec's own `.config.kiro` declares its type (Kiro reads it too), so it is derived, and the reply tells you the `workflowSource`. Pass `workflow` explicitly only when that file is absent or unusable (the call then fails with `WORKFLOW_UNKNOWN`, naming which case it is); never pass a value that contradicts it — the call is refused with `WORKFLOW_CONFLICT` rather than picking one for you. Adoption records a baseline; it does not approve artifacts.
3. Call `spec_context` with `artifact=tasks`, then `spec_read` so the full project rules and current Markdown are in context.
4. Call `spec_diagnostics`, review its `findings` (format issues in the spec itself), and run its validator plan with the host shell before changing code.
5. Have the host collect a structured `workspaceSnapshot`, excluding `.kiro/specs/**` and `.codex-spec-private/**` (plus its legacy-named read-only fallback directory) from its path sets. Use the same collection policy before and after a task. Call `spec_task_plan` with `scope=task`, `wave`, or `all` and that snapshot; the server canonicalizes it and computes the revision but does not run Git itself.
6. For one task at a time, call `spec_task_begin`, modify code, run relevant checks, and report every check through `spec_task_record_check`, passing the latest returned `stateEpoch` to the next owner mutation.
7. Call `spec_task_complete` only after a successful check and an observable workspace change. On implementation or verification failure, call `spec_task_fail` before stopping.
8. Repeat from `spec_task_plan` for the next task, then call `spec_status` for the final report.

Never edit task checkboxes directly during plugin-managed execution. Never claim the requested scope or entire Spec is complete while `spec_status` reports remaining tasks or recovery work. If status reports `RECOVERY_REQUIRED`, inspect the workspace and use `spec_task_begin` with `recoverExpired=true` only to resume the same expired task and plan.

Mark a check-only leaf task with `_Type:_ verification`; only such a task may complete without a workspace revision change. After three failures, stop on `HUMAN_REVIEW_REQUIRED`. A human must review the failure history and explicitly call `spec_task_reset_failures` using the exact phrase `确认重置任务 <taskId>` before planning that task again.
