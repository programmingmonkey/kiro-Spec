import { parseTasks, wavesFromMarkdown } from './index.mjs';

function finding({ severity = 'error', artifact, line, ruleId, evidence, suggestedAction }) {
  return { severity, artifact, location: { line }, ruleId, evidence, suggestedAction };
}

function requirementIds(markdown) {
  const legacy = [...markdown.matchAll(/^(?:###\s+(\d+(?:\.\d+)*)\.|##\s+Requirement\s+(\d+(?:\.\d+)*))(?:\s|$)/gm)]
    .map((match) => ({ id: match[1] ?? match[2], line: markdown.slice(0, match.index).split(/\r?\n/).length }));
  const headings = [...markdown.matchAll(/^###\s+Requirement\s+(\d+)(?::|\s|$)/gm)];
  const canonical = headings.flatMap((heading, index) => {
    const sectionEnd = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(heading.index, sectionEnd);
    const acceptance = /^####\s+Acceptance Criteria\s*$/m.exec(section);
    if (!acceptance) return [];
    const criteria = section.slice(acceptance.index + acceptance[0].length);
    return [...criteria.matchAll(/^(\d+)\.\s+/gm)].map((criterion) => ({
      id: `${heading[1]}.${criterion[1]}`,
      line: markdown.slice(0, heading.index + acceptance.index + acceptance[0].length + criterion.index).split(/\r?\n/).length
    }));
  });
  return [...legacy, ...canonical];
}

function designReferences(markdown) {
  return [...markdown.matchAll(/\bRequirements?\s+([\d.,\s]+)/gi)].flatMap((match) => match[1].split(',').map((id) => id.trim()).filter((id) => /^\d+(?:\.\d+)*$/.test(id)));
}

function flatten(tasks) {
  return tasks.flatMap((task) => [task, ...flatten(task.children)]);
}

// 🔴 原先这里是一条自己手写的正则，`\s*\n\s*` 吃不掉标题与围栏之间的正文行，于是
// §3.1 合规写法（`## Task Dependency Graph` 下一行是 `> 中文副标题`）一律退化为 []。
// 现改为共用 `wavesFromMarkdown` —— 定位判据只此一处，见 spec-parser/lib/waves.js。
function wavesFromTasks(markdown) {
  return wavesFromMarkdown(markdown).waves;
}

function taskCycles(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  const cycles = new Set();
  function visit(id, trail = []) {
    if (visiting.has(id)) { cycles.add([...trail, id].join(' -> ')); return; }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  return [...cycles];
}

/** Return deterministic, source-located traceability findings without modifying Markdown. */
export function analyzeArtifacts({ requirements, design, tasks }) {
  const knownRequirements = requirementIds(requirements);
  const knownRequirementIds = new Set(knownRequirements.map((item) => item.id));
  const designRequirementIds = new Set(designReferences(design));
  const taskAst = parseTasks(tasks);
  const executableTasks = flatten(taskAst.tasks).filter((task) => task.children.length === 0);
  const coveredRequirements = new Set(executableTasks.flatMap((task) => task.requirements));
  const findings = [];

  for (const requirement of knownRequirements) {
    if (!designRequirementIds.has(requirement.id)) {
      findings.push(finding({ artifact: 'design', line: 1, ruleId: 'REQUIREMENT_WITHOUT_DESIGN_TRACE', evidence: `Requirement ${requirement.id} has no design trace`, suggestedAction: `Reference Requirement ${requirement.id} from the design.` }));
    }
    if (!coveredRequirements.has(requirement.id)) {
      findings.push(finding({ artifact: 'tasks', line: 1, ruleId: 'REQUIREMENT_WITHOUT_TASK', evidence: `Requirement ${requirement.id} has no executable task`, suggestedAction: `Add an executable task that references Requirement ${requirement.id}.` }));
    }
  }

  for (const task of executableTasks) {
    for (const requirement of task.requirements) {
      if (!knownRequirementIds.has(requirement)) {
        findings.push(finding({ artifact: 'tasks', line: task.sourceRange.start.line, ruleId: 'UNKNOWN_TASK_REQUIREMENT', evidence: `Task ${task.id} references unknown Requirement ${requirement}`, suggestedAction: 'Reference an existing Requirement ID or add the missing requirement.' }));
      }
    }
  }

  const waveByTask = new Map(wavesFromTasks(tasks).flatMap((wave, waveIndex) => wave.tasks.map((taskId) => [taskId, waveIndex])));
  for (const task of executableTasks) {
    for (const dependency of task.dependencies) {
      if (waveByTask.has(task.id) && waveByTask.has(dependency) && waveByTask.get(dependency) >= waveByTask.get(task.id)) {
        findings.push(finding({ artifact: 'tasks', line: task.sourceRange.start.line, ruleId: 'WAVE_DEPENDENCY_ORDER', evidence: `Task ${task.id} depends on ${dependency}, but its wave does not run later`, suggestedAction: 'Move the dependent task to a later wave or remove the dependency.' }));
      }
    }
  }

  for (const cycle of taskCycles(executableTasks)) {
    findings.push(finding({ artifact: 'tasks', line: 1, ruleId: 'TASK_DEPENDENCY_CYCLE', evidence: `Dependency cycle: ${cycle}`, suggestedAction: 'Break the task dependency cycle before execution.' }));
  }
  return findings;
}

/**
 * Suggest only unambiguous, append-only trace additions. Applying a proposal is
 * deliberately a separate, CAS-protected MCP operation.
 */
export function previewSynchronization({ requirements, design, tasks }) {
  parseTasks(tasks);
  const known = requirementIds(requirements).map((item) => item.id);
  const traced = new Set(designReferences(design));
  const missing = known.filter((id) => !traced.has(id));
  if (missing.length === 0) return [];
  return [{
    artifact: 'design',
    operation: 'append',
    markdown: `\n## Requirements Trace\n\nRequirements ${missing.join(', ')}\n`,
    ruleId: 'ADD_DESIGN_REQUIREMENT_TRACE'
  }];
}
