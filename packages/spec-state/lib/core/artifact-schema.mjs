// 适配层。findings 的组装已移入共享裁决层 `@my-harness/spec-diagnose`（第 3.5 期）。
//
// 本文件只做三件事：
//   ① 保留 `artifactsForWorkflow` / `validateArtifactSchemas` 两个导出名与两处调用点
//      （`lib/core/templates.mjs`、`lib/mcp/service.mjs`）——**一个都不删**；
//   ② 保留 `artifactsForWorkflow` 对不支持的工作流**抛** `INVALID_FORMAT` 的行为
//      （`templates.mjs:11` 依赖它）；
//   ③ 把共享层的 finding 映射回本插件对外的历史字段名（`ruleId` / `artifact` / `location` /
//      `evidence` / `suggestedAction`），并把**不是** artifact 白名单的判定留在本层。
//
// 第 3.5 期之前，本文件自己手写 3 条规则、用自造规则码（`MISSING_REQUIRED_SECTION` /
// `MISSING_TASK_DEPENDENCY_GRAPH`）、标题匹配放宽到 `^#{1,6}`、`location` 恒为 1。那些都不再存在：
// 判定是 Kiro 的 41 条 + 本仓约定，章节匹配按 Kiro 的严格语义。

import { diagnose } from '@my-harness/spec-diagnose'

const WORKFLOW_ARTIFACTS = {
  'requirements-first': new Set(['requirements', 'design', 'tasks']),
  'design-first': new Set(['requirements', 'design', 'tasks']),
  bugfix: new Set(['bugfix', 'design', 'tasks']),
  quick: new Set(['requirements', 'design', 'tasks']),
}

export function artifactsForWorkflow(workflow) {
  const artifacts = WORKFLOW_ARTIFACTS[workflow];
  if (!artifacts) throw Object.assign(new Error(`workflow is not supported: ${workflow}`), { code: 'INVALID_FORMAT' });
  return artifacts;
}

/** 共享层的 finding → 本插件的历史字段名。 */
function toHostFinding(finding, artifact) {
  const mapped = {
    severity: finding.severity,
    artifact,
    location: finding.location,
    ruleId: finding.code,
    evidence: finding.message,
  };
  if (finding.suggestedAction) mapped.suggestedAction = finding.suggestedAction;
  return mapped;
}

/**
 * Validate only workflow-specific document shape; callers decide whether to block a write.
 *
 * `workflow` 决定**哪些 artifact 合法**（白名单）；文档内的章节表与依赖图豁免则跟真机的
 * 输入走 —— 真机只认 `.config.kiro` 写明的 `specType`。所以 `specType` 是一个**独立**的
 * 可选参数，只在调用方手里真有那份声明时才传。
 *
 * ⚠️ 第 9 期 review（2026-09-17）前这里用 `isBugfix: workflow === 'bugfix'`，把本宿主自己的
 * workflow 当成了真机能看见的类型声明：bugfix 工作流的 `tasks.md` 因此被豁免依赖图、
 * `design.md` 被强制套 bugfix 表 —— 而本宿主建的 spec 没有 `.config.kiro`，真机打开它时
 * 会嗅探 design、并照常要求依赖图。两个模板都自带依赖图，所以正常起草不受影响。
 */
export function validateArtifactSchemas({ workflow, artifacts, specType }) {
  const allowed = artifactsForWorkflow(workflow);
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) throw Object.assign(new Error('artifacts must be an object'), { code: 'INVALID_FORMAT' });
  const findings = [];
  for (const [artifact, markdown] of Object.entries(artifacts)) {
    if (!allowed.has(artifact)) {
      // artifact 白名单不是文档判定，留在本层：它是「工作流允许哪些 artifact」的契约，
      // 共享裁决层收的是文档内容，看不到这件事。
      findings.push({
        severity: 'error',
        artifact,
        location: { line: 1 },
        ruleId: 'ARTIFACT_NOT_ALLOWED',
        evidence: `${artifact} is not an artifact of ${workflow}`,
        suggestedAction: `Use one of: ${[...allowed].join(', ')}.`,
      });
      continue;
    }
    if (typeof markdown !== 'string') throw Object.assign(new Error(`artifact ${artifact} must be Markdown text`), { code: 'INVALID_FORMAT' });
    // `strictTaskState: true` 是**本宿主**的策略绑定，与 `lib/core/task-format.mjs` 里
    // `parseTaskLine` 固定用的 STRICT 一致（四字符类 `[ xX-]`，去掉 `~`）。
    // 评审发现的缺陷：这里原先漏传，于是 codex-spec 的 findings 落在**宽松**策略上——
    // 对含 `[~]` 的文档产出 `tasks/invalid-task-state`，而 declared-diff `task-state-tilde`
    // 的 kiro 侧写的是「parseTasks 抛 Invalid task state」。两边的差异因此测不出来。
    for (const finding of diagnose({ artifact, markdown, specType, strictTaskState: true })) {
      findings.push(toHostFinding(finding, artifact));
    }
  }
  return findings;
}
