import { metadataValue, scanTaskLines } from './task-format.mjs';

// `parseWaves` 的实现已移入共享包 `@my-harness/spec-parser`（第 4 期）。
// 在这里继续导出它，是为了不动 `test/parser.test.mjs` 与 `lib/core/analysis.mjs` /
// `lib/mcp/service.mjs` 的 import 路径（计划 Task 3 Step 1：其余 import 路径一律不动）。
// 实现逐字节照搬本文件原先的同名函数，判据由 scripts/fixtures/revision-golden.json 兜住。
export { parseWaves } from '@my-harness/spec-parser/waves';

// `wavesFromMarkdown` 是第 6.1 条缺陷的修复落点：它同时管「图在哪」和「读不到时出声」。
// 从这里再导出一次，是为了让 `analysis.mjs` 与 `index.mjs` 两个消费者共用**同一个**判据
// —— 它们此前各自手写了一份正则，且两份都漏掉了标题与围栏之间的正文行。
export { wavesFromMarkdown, locateWavesJson } from '@my-harness/spec-parser/waves';

function parseReferenceList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function sourceRange(startLine, endLine) {
  return { start: { line: startLine }, end: { line: endLine } };
}

function isDescendant(id, ancestorId) {
  return id.startsWith(`${ancestorId}.`);
}

/**
 * Parse a generic Markdown artifact into a deliberately neutral heading AST.
 * Feature/bugfix schemas are selected by later adapters, not guessed here.
 */
export function parseArtifact(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (match) sections.push({ level: match[1].length, title: match[2], sourceRange: sourceRange(index + 1, index + 1) });
  }
  for (let index = 0; index < sections.length; index += 1) {
    sections[index].sourceRange.end.line = index + 1 < sections.length ? sections[index + 1].sourceRange.start.line - 1 : lines.length;
  }
  return { kind: 'markdown', sections, sourceRange: sourceRange(1, lines.length) };
}

/**
 * Parse canonical task checkboxes into a tree. IDs deliberately remain strings.
 */
export function parseTasks(markdown) {
  const { lines, syntaxes } = scanTaskLines(markdown);
  const flat = [];
  for (let index = 0; index < lines.length; index += 1) {
    const syntax = syntaxes[index];
    if (syntax?.kind === 'invalid-state') throw new Error(`Invalid task state at line ${index + 1}; use [ ], [-], or [x]`);
    // 第 3 期删除了 `invalid-format`：它的两个生产者（空标题、顶层无尾点 id）已归并到真机语义
    // （真机的两条任务正则都是前缀测试，不要求标题也不要求尾点），故该枚举不再有生产者。
    if (syntax?.kind === 'task') flat.push({ id: syntax.id, state: syntax.state, optional: syntax.optional, title: syntax.title, indent: syntax.indent.length, line: index + 1, children: [] });
  }

  const byId = new Map();
  const roots = [];
  for (const task of flat) {
    if (byId.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    const parentId = task.id.includes('.') ? task.id.slice(0, task.id.lastIndexOf('.')) : undefined;
    if (parentId && byId.has(parentId)) byId.get(parentId).children.push(task);
    else roots.push(task);
    byId.set(task.id, task);
  }

  for (let index = 0; index < flat.length; index += 1) {
    const task = flat[index];
    const nextPeerOrAncestor = flat.slice(index + 1).find((candidate) => !isDescendant(candidate.id, task.id));
    const endLine = nextPeerOrAncestor ? nextPeerOrAncestor.line - 1 : lines.length;
    task.sourceRange = sourceRange(task.line, endLine);
  }

  for (const task of flat) {
    const endLine = task.sourceRange.end.line;
    const directBodyLines = lines.slice(task.line, endLine).filter((_, relativeIndex) => {
      const lineNumber = task.line + relativeIndex + 1;
      return !task.children.some((child) => lineNumber >= child.line && lineNumber <= child.sourceRange.end.line);
    });
    const body = directBodyLines.join('\n').trim();
    const requirements = metadataValue(body, 'Requirements');
    const dependencies = metadataValue(body, 'Dependencies');
    const taskType = metadataValue(body, 'Type')?.toLowerCase();
    task.body = body;
    task.requirements = requirements ? parseReferenceList(requirements) : [];
    task.dependencies = dependencies ? parseReferenceList(dependencies) : [];
    task.taskType = taskType === 'verification' ? 'verification' : 'implementation';
    delete task.indent;
    delete task.line;
  }

  const executable = flat.filter((task) => task.children.length === 0);
  const warnings = executable
    .filter((task) => task.requirements.length === 0)
    .map((task) => ({ code: 'TASK_MISSING_REQUIREMENTS', severity: 'warning', taskId: task.id, message: `Executable task ${task.id} is missing _Requirements:_` }));
  return { kind: 'tasks', tasks: roots, executableTaskIds: executable.map((task) => task.id), warnings, sourceRange: sourceRange(1, lines.length) };
}

/** Read modern string-ID waves and the historical integer forms without numeric ID loss. */
// 注：`parseWaves` 已移入共享包，见文件顶部 re-export。此处不再保留实现副本。

function flatten(tasks) {
  return tasks.flatMap((task) => [task, ...flatten(task.children)]);
}

/** Write tasks in the default canonical Markdown form. */
export function writeTasks(ast) {
  const lines = ['# Implementation Plan', '', '## Tasks', ''];
  for (const task of flatten(ast.tasks)) {
    const depth = task.id.split('.').length - 1;
    lines.push(`${'  '.repeat(depth)}- [${task.state}]${task.optional ? '*' : ''} ${task.id}${depth === 0 ? '.' : ''} ${task.title}`);
    if (task.children.length === 0) {
      lines.push(`${'  '.repeat(depth + 1)}- _Requirements: ${task.requirements.join(', ')}_`);
      if (task.dependencies.length > 0) lines.push(`${'  '.repeat(depth + 1)}- _Dependencies: ${task.dependencies.join(', ')}_`);
      if (task.taskType === 'verification') lines.push(`${'  '.repeat(depth + 1)}- _Type: verification_`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Write the versioned default: waves with explicit ids and string task IDs. */
export function writeWaves(wavesOrAst) {
  const waves = Array.isArray(wavesOrAst) ? wavesOrAst : wavesOrAst.waves;
  return `${JSON.stringify({ waves: waves.map((wave, index) => ({ id: Number.isInteger(wave.id) ? wave.id : index, tasks: wave.tasks.map(String) })) }, null, 2)}\n`;
}
