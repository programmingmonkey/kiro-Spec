import { parseTasks } from './index.mjs';
import { computeApprovalFingerprint, computeRawRevision } from './revision.mjs';
import { isExecutionPhase } from './workflow.mjs';
import { parseExecutionEvents, stripValidExecutionEvents } from './event-format.mjs';

export { parseExecutionEvents, stripValidExecutionEvents };

function taskStates(markdown) {
  const byId = new Map();
  const visit = (tasks) => tasks.forEach((task) => {
    byId.set(task.id, task.state);
    visit(task.children);
  });
  visit(parseTasks(markdown).tasks);
  return byId;
}

function changedTaskStates(previousMarkdown, currentMarkdown) {
  const before = taskStates(stripValidExecutionEvents(previousMarkdown));
  const after = taskStates(stripValidExecutionEvents(currentMarkdown));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].flatMap((taskId) => before.get(taskId) === after.get(taskId) ? [] : [{ taskId, from: before.get(taskId), to: after.get(taskId) }]);
}

/**
 * Classify an observed Markdown change without performing any storage, CAS, or
 * journal mutation. Journal evidence is caller-provided and remains non-authoritative.
 */
export function classifyExternalChange({ previousMarkdown, currentMarkdown, phase, journalEvidence = [] }) {
  const rawChanged = computeRawRevision(previousMarkdown) !== computeRawRevision(currentMarkdown);
  if (!rawChanged) return { disposition: 'unchanged', rawChanged: false, semanticChanged: false };
  const semanticChanged = computeApprovalFingerprint({ artifact: 'tasks', markdown: previousMarkdown, strictTaskState: true }) !== computeApprovalFingerprint({ artifact: 'tasks', markdown: currentMarkdown, strictTaskState: true });
  if (semanticChanged) return { disposition: isExecutionPhase(phase) ? 'external_change_detected' : 'approval_invalidated', rawChanged, semanticChanged };

  const previousEvents = parseExecutionEvents(previousMarkdown);
  const currentEvents = parseExecutionEvents(currentMarkdown);
  let taskChanges;
  try {
    taskChanges = changedTaskStates(previousMarkdown, currentMarkdown);
  } catch {
    return { disposition: 'recovery_required', rawChanged, semanticChanged };
  }
  const eventsChanged = JSON.stringify(previousEvents.events) !== JSON.stringify(currentEvents.events);
  if (taskChanges.length === 0 && !eventsChanged) return { disposition: 'reread_required', rawChanged, semanticChanged };
  const previousEventIds = new Set(previousEvents.events.map((event) => event.id));
  const newEvents = currentEvents.events.filter((event) => !previousEventIds.has(event.id));
  const eventFor = (change) => newEvents.filter((event) => event.taskId === change.taskId && event.from === change.from && event.to === change.to);
  const evidenceMatches = isExecutionPhase(phase)
    && taskChanges.length > 0
    && currentEvents.valid
    && newEvents.length === taskChanges.length
    && taskChanges.every((change) => eventFor(change).length === 1)
    && newEvents.every((event) => journalEvidence.some((evidence) => evidence.taskId === event.taskId && evidence.from === event.from && evidence.to === event.to && evidence.eventId === event.id));
  return { disposition: evidenceMatches ? 'legal_execution_transition' : 'recovery_required', rawChanged, semanticChanged, taskChanges };
}
