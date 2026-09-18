const WORKFLOWS = {
  'requirements-first': ['initialized', 'requirements_draft', 'requirements_approved', 'design_draft', 'design_approved', 'tasks_draft', 'tasks_approved', 'implementing', 'validating', 'complete'],
  'design-first': ['initialized', 'design_draft', 'design_approved', 'requirements_draft', 'requirements_approved', 'tasks_draft', 'tasks_approved', 'implementing', 'validating', 'complete'],
  bugfix: ['initialized', 'bug_analysis_draft', 'bug_analysis_approved', 'root_cause_design_draft', 'design_approved', 'tasks_draft', 'tasks_approved', 'implementing', 'validating', 'complete'],
  quick: ['initialized', 'clarifying', 'artifacts_generated', 'overall_review', 'approved', 'implementing', 'validating', 'complete']
};

const APPROVAL_CHAINS = {
  'requirements-first': ['requirements', 'design', 'tasks'],
  'design-first': ['design', 'requirements', 'tasks'],
  bugfix: ['bugfix', 'design', 'tasks'],
  quick: ['requirements', 'design', 'tasks']
};

function ensureWorkflow(workflow) {
  if (!WORKFLOWS[workflow]) throw new Error(`Unsupported workflow: ${workflow}`);
}

function approvalForPhase(phase) {
  return {
    requirements_approved: ['requirements'],
    design_approved: ['design'],
    bug_analysis_approved: ['bugfix'],
    tasks_approved: ['tasks'],
    approved: ['requirements', 'design', 'tasks']
  }[phase] ?? [];
}

function approvalPhase(workflow, artifact) {
  return {
    'requirements-first': { requirements: 'requirements_draft', design: 'design_draft', tasks: 'tasks_draft' },
    'design-first': { design: 'design_draft', requirements: 'requirements_draft', tasks: 'tasks_draft' },
    bugfix: { bugfix: 'bug_analysis_draft', design: 'root_cause_design_draft', tasks: 'tasks_draft' },
    quick: { all: 'overall_review' }
  }[workflow][artifact];
}

export function isValidWorkflowState(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isInteger(state.stateEpoch) || state.stateEpoch < 0 || !WORKFLOWS[state.workflow]?.includes(state.phase) || !state.approvals || typeof state.approvals !== 'object') return false;
  const expected = APPROVAL_CHAINS[state.workflow];
  if (Object.keys(state.approvals).length !== expected.length || !expected.every((artifact) => ['pending', 'granted', 'invalidated'].includes(state.approvals[artifact]))) return false;
  const phaseIndex = WORKFLOWS[state.workflow].indexOf(state.phase);
  return expected.every((artifact) => {
    const gate = approvalPhase(state.workflow, state.workflow === 'quick' ? 'all' : artifact);
    return phaseIndex <= WORKFLOWS[state.workflow].indexOf(gate) || state.approvals[artifact] === 'granted';
  });
}

export function createWorkflowState({ workflow }) {
  ensureWorkflow(workflow);
  return { schemaVersion: 1, workflow, phase: 'initialized', stateEpoch: 0, approvals: Object.fromEntries(APPROVAL_CHAINS[workflow].map((artifact) => [artifact, 'pending'])) };
}

/** Record collaborative approval state only; evidence persistence is a later storage concern. */
export function recordApproval({ state, artifact, expectedStateEpoch }) {
  if (!isValidWorkflowState(state)) return { code: 'INVALID_WORKFLOW_STATE', message: 'workflow state is malformed' };
  ensureWorkflow(state.workflow);
  if (expectedStateEpoch !== state.stateEpoch) return { code: 'STATE_EPOCH_CONFLICT', message: 'stateEpoch is stale' };
  const artifacts = artifact === 'all' && state.workflow === 'quick' ? APPROVAL_CHAINS.quick : [artifact];
  if (!artifacts.every((item) => Object.hasOwn(state.approvals, item))) return { code: 'UNKNOWN_APPROVAL_ARTIFACT', message: `Unknown approval artifact: ${artifact}` };
  if (approvalPhase(state.workflow, artifact) !== state.phase) return { code: 'APPROVAL_NOT_AVAILABLE', message: `Approval for ${artifact} is not available in ${state.phase}` };
  return { ...state, approvals: { ...state.approvals, ...Object.fromEntries(artifacts.map((item) => [item, 'granted'])) }, stateEpoch: state.stateEpoch + 1 };
}

/** Advance one declared phase using a private-state epoch compare-and-swap. */
export function transitionWorkflow({ state, to, expectedStateEpoch }) {
  if (!isValidWorkflowState(state)) return { code: 'INVALID_WORKFLOW_STATE', message: 'workflow state is malformed' };
  ensureWorkflow(state.workflow);
  if (expectedStateEpoch !== state.stateEpoch) return { code: 'STATE_EPOCH_CONFLICT', message: 'stateEpoch is stale' };
  const phases = WORKFLOWS[state.workflow];
  const currentIndex = phases.indexOf(state.phase);
  if (phases[currentIndex + 1] !== to) return { code: 'INVALID_STATE_TRANSITION', message: `${state.phase} cannot transition to ${to}` };
  if (!approvalForPhase(to).every((artifact) => state.approvals[artifact] === 'granted')) return { code: 'APPROVAL_REQUIRED', message: `Approval is required before ${to}` };
  return { ...state, phase: to, stateEpoch: state.stateEpoch + 1 };
}

/** Invalidate only the current approval and its declared downstream approvals. */
export function invalidateApprovals({ state, changedArtifact, expectedStateEpoch }) {
  if (!isValidWorkflowState(state)) return { code: 'INVALID_WORKFLOW_STATE', message: 'workflow state is malformed' };
  ensureWorkflow(state.workflow);
  if (expectedStateEpoch !== state.stateEpoch) return { code: 'STATE_EPOCH_CONFLICT', message: 'stateEpoch is stale' };
  const chain = APPROVAL_CHAINS[state.workflow];
  const changedIndex = chain.indexOf(changedArtifact);
  if (changedIndex === -1) throw new Error(`Artifact ${changedArtifact} is not in ${state.workflow}`);
  const invalidated = state.workflow === 'quick' ? new Set(chain) : new Set(chain.slice(changedIndex));
  const retryPhase = approvalPhase(state.workflow, state.workflow === 'quick' ? 'all' : changedArtifact);
  const currentPhaseIndex = WORKFLOWS[state.workflow].indexOf(state.phase);
  const retryPhaseIndex = WORKFLOWS[state.workflow].indexOf(retryPhase);
  return { ...state, phase: currentPhaseIndex >= retryPhaseIndex ? retryPhase : state.phase, approvals: Object.fromEntries(Object.entries(state.approvals).map(([artifact, approval]) => [artifact, invalidated.has(artifact) ? 'invalidated' : approval])), stateEpoch: state.stateEpoch + 1 };
}

export function isExecutionPhase(phase) {
  return phase === 'implementing' || phase === 'validating';
}
