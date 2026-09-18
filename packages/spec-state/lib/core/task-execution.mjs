import { createHash } from 'node:crypto';

import { parseTasks } from './index.mjs';
import { computeRawRevision } from './revision.mjs';
import { replaceTaskState } from './task-format.mjs';

function resultError(code, message, details = {}) { return { code, message, details }; }
function flatten(tasks) { return tasks.flatMap((task) => [task, ...flatten(task.children)]); }
function ownerMatches(execution, ownerTokenHash) { return execution.activeTask?.ownerTokenHash === ownerTokenHash; }

export function hashOwnerToken(ownerToken) {
  return `sha256:${createHash('sha256').update(ownerToken).digest('hex')}`;
}

export function createTaskPlan({ markdown, waves = [], scope, taskId, waveId }) {
  let ast;
  try { ast = parseTasks(markdown); } catch (caught) { return resultError('INVALID_FORMAT', caught.message); }
  const tasks = flatten(ast.tasks).filter((task) => task.children.length === 0);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (tasks.some((task) => task.state === '-')) return resultError('RECOVERY_REQUIRED', 'tasks.md contains an active task without current owner evidence');

  let requested;
  let selectedWaveIndex = -1;
  if (scope === 'task') {
    if (!byId.has(taskId)) return resultError('TASK_NOT_FOUND', `task ${taskId ?? ''} does not exist`);
    selectedWaveIndex = waves.findIndex((wave) => wave.tasks.includes(taskId));
    requested = [taskId];
  } else if (scope === 'wave') {
    selectedWaveIndex = waves.findIndex((candidate) => candidate.id === waveId);
    const wave = waves[selectedWaveIndex];
    if (!wave) return resultError('WAVE_NOT_FOUND', `wave ${waveId ?? ''} does not exist`);
    requested = wave.tasks;
  } else if (scope === 'all') {
    if (waves.length > 0) {
      const waveTaskIds = waves.flatMap((wave) => wave.tasks);
      const expected = new Set(ast.executableTaskIds);
      if (waveTaskIds.length !== new Set(waveTaskIds).size || waveTaskIds.some((id) => !expected.has(id)) || ast.executableTaskIds.some((id) => !waveTaskIds.includes(id))) {
        return resultError('INVALID_FORMAT', 'waves must contain every executable task exactly once');
      }
      requested = waveTaskIds;
    } else requested = ast.executableTaskIds;
  } else return resultError('INVALID_SCOPE', 'scope must be task, wave, or all');

  // A single task obeys the same wave barrier as a whole wave, even without
  // explicit Dependencies metadata. Peers within its wave are not prerequisites.
  if (selectedWaveIndex > 0) {
    const unfinished = waves.slice(0, selectedWaveIndex).flatMap((wave) => wave.tasks)
      .find((id) => byId.get(id)?.state !== 'x');
    const selectedWaveId = waves[selectedWaveIndex].id;
    if (unfinished) return resultError('DEPENDENCY_NOT_MET', `wave ${selectedWaveId} cannot start before task ${unfinished} completes`, { taskId: unfinished, waveId: selectedWaveId });
  }

  const unique = [...new Set(requested)];
  const unknown = unique.find((id) => !byId.has(id));
  if (unknown) return resultError('TASK_NOT_FOUND', `task ${unknown} does not exist`);
  const selected = new Set(unique);
  const pending = unique.filter((id) => byId.get(id).state !== 'x');
  const ordered = [];
  const remaining = new Set(pending);
  while (remaining.size > 0) {
    const ready = [...remaining].find((id) => byId.get(id).dependencies.every((dependency) => byId.get(dependency)?.state === 'x' || (selected.has(dependency) && ordered.includes(dependency))));
    if (!ready) {
      const blockedTaskId = [...remaining][0];
      const unmet = byId.get(blockedTaskId).dependencies.filter((dependency) => byId.get(dependency)?.state !== 'x' && !ordered.includes(dependency));
      return resultError('DEPENDENCY_NOT_MET', `task ${blockedTaskId} has unmet dependencies`, { taskId: blockedTaskId, unmet });
    }
    ordered.push(ready);
    remaining.delete(ready);
  }
  const planInput = { tasksRevision: computeRawRevision(Buffer.from(markdown)), scope, taskId: taskId ?? null, waveId: waveId ?? null, taskIds: ordered };
  const taskTypes = Object.fromEntries(ordered.map((id) => [id, byId.get(id).taskType]));
  return { ...planInput, taskTypes, planRevision: computeRawRevision(Buffer.from(JSON.stringify(planInput))) };
}

export function updateTaskState(markdown, taskId, from, to) {
  const allowed = new Set([' ->-', '-->x', '--> ']);
  if (!allowed.has(`${from}->${to}`)) throw Object.assign(new Error('INVALID_TASK_TRANSITION'), { code: 'INVALID_TASK_TRANSITION' });
  return replaceTaskState(markdown, taskId, from, to);
}

export function beginTaskExecution({ execution = {}, taskId, taskType = 'implementation', ownerTokenHash, leaseExpiresAt, workspaceRevision }) {
  if (execution.activeTask) return resultError('TASK_ALREADY_ACTIVE', `task ${execution.activeTask.taskId} is already active`);
  return {
    ...execution,
    activeTask: { taskId, taskType, ownerTokenHash, leaseExpiresAt, startedWorkspaceRevision: workspaceRevision, checks: [] },
    attemptsByTask: { ...(execution.attemptsByTask ?? {}) },
    failures: [...(execution.failures ?? [])]
  };
}

export function recordTaskCheck({ execution, ownerTokenHash, command, exitCode, summary }) {
  if (!execution.activeTask) return resultError('TASK_NOT_ACTIVE', 'no task is active');
  if (!ownerMatches(execution, ownerTokenHash)) return resultError('OWNER_TOKEN_INVALID', 'owner token does not match the active task');
  return {
    ...execution,
    activeTask: {
      ...execution.activeTask,
      checks: [...execution.activeTask.checks, { command, exitCode, summary, source: 'agent-reported' }]
    }
  };
}

export function completeTaskExecution({ execution, ownerTokenHash, workspaceRevision, summary }) {
  if (!execution.activeTask) return resultError('TASK_NOT_ACTIVE', 'no task is active');
  if (!ownerMatches(execution, ownerTokenHash)) return resultError('OWNER_TOKEN_INVALID', 'owner token does not match the active task');
  if (!execution.activeTask.checks.some((check) => check.exitCode === 0)) return resultError('CHECK_REQUIRED', 'at least one successful check is required');
  if (execution.activeTask.taskType !== 'verification' && workspaceRevision === execution.activeTask.startedWorkspaceRevision) return resultError('NO_WORKSPACE_CHANGE', 'workspace revision did not change');
  return {
    ...execution,
    activeTask: null,
    lastCompleted: { taskId: execution.activeTask.taskId, summary, workspaceRevision },
    completedTaskIds: [...new Set([...(execution.completedTaskIds ?? []), execution.activeTask.taskId])]
  };
}

export function failTaskExecution({ execution, ownerTokenHash, summary }) {
  if (!execution.activeTask) return resultError('TASK_NOT_ACTIVE', 'no task is active');
  if (!ownerMatches(execution, ownerTokenHash)) return resultError('OWNER_TOKEN_INVALID', 'owner token does not match the active task');
  const taskId = execution.activeTask.taskId;
  const attempts = (execution.attemptsByTask?.[taskId] ?? 0) + 1;
  const updated = {
    ...execution,
    activeTask: null,
    attemptsByTask: { ...(execution.attemptsByTask ?? {}), [taskId]: attempts },
    failures: [...(execution.failures ?? []), { taskId, summary, attempt: attempts }]
  };
  return attempts >= 3 ? { ...resultError('HUMAN_REVIEW_REQUIRED', `task ${taskId} failed three times`), execution: updated } : updated;
}
