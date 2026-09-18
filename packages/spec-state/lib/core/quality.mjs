function finding(artifact, line, ruleId, evidence, suggestedAction, severity = 'warning') {
  return { severity, artifact, location: { line }, ruleId, evidence, suggestedAction };
}

/** Deterministic preview for clarify, checklist, and design validation. */
export function previewQuality({ requirements, design, tasks }) {
  const findings = [];
  for (const [index, line] of requirements.split(/\r?\n/).entries()) {
    if (/\b(fast|easy|robust|appropriate|user-friendly)\b/i.test(line)) findings.push(finding('requirements', index + 1, 'AMBIGUOUS_TERM', `Ambiguous wording: ${line.trim()}`, 'Replace the qualitative term with a measurable criterion.'));
  }
  if (!/####\s+Acceptance Criteria/i.test(requirements)) findings.push(finding('requirements', 1, 'MISSING_ACCEPTANCE_CRITERIA', 'No Acceptance Criteria section found.', 'Add measurable EARS acceptance criteria for every requirement.', 'error'));
  for (const [index, line] of tasks.split(/\r?\n/).entries()) {
    if (/^\s*-\s+\[[ xX-]\].*\b(and|以及)\b/i.test(line)) findings.push(finding('tasks', index + 1, 'NON_ATOMIC_TASK', `Task combines multiple actions: ${line.trim()}`, 'Split the task into independently verifiable tasks.'));
  }
  for (const section of ['Error Handling', 'Testing Strategy']) {
    if (!new RegExp(`^##\\s+${section}\\s*$`, 'mi').test(design)) findings.push(finding('design', 1, 'MISSING_DESIGN_SECTION', `Design is missing ${section}.`, `Add a ${section} section with concrete behavior.`, 'error'));
  }
  return { findings, checklist: findings.map((item) => ({ id: item.ruleId, artifact: item.artifact, question: item.suggestedAction })) };
}
