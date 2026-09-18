const START = '<!-- kiro-spec:execution-events:v1:start -->';
const END = '<!-- kiro-spec:execution-events:v1:end -->';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^\d+(?:\.\d+)*$/;
const TRANSITIONS = new Set([' ->-', '-->x', '--> ']);

function count(content, token) { return content.split(token).length - 1; }

function validEvent(event) {
  const keys = Object.keys(event).sort();
  return JSON.stringify(keys) === JSON.stringify(['from', 'id', 'kind', 'taskId', 'to'])
    && typeof event.id === 'string' && UUID_RE.test(event.id)
    && typeof event.taskId === 'string' && TASK_ID_RE.test(event.taskId)
    && event.kind === 'task-transition' && typeof event.from === 'string' && typeof event.to === 'string'
    && TRANSITIONS.has(`${event.from}->${event.to}`);
}

function range(markdown, start, end) {
  const lineAt = (offset) => markdown.slice(0, offset).split(/\r?\n/).length;
  return { start: { offset: start, line: lineAt(start) }, end: { offset: end, line: lineAt(end) } };
}

/** Parse only one exact, standalone v1 execution-event comment block. */
export function parseExecutionEvents(markdown) {
  const starts = [...markdown.matchAll(/^<!-- kiro-spec:execution-events:v1:start -->$/gm)];
  const ends = [...markdown.matchAll(/^<!-- kiro-spec:execution-events:v1:end -->$/gm)];
  const hasDelimiterText = count(markdown, START) > 0 || count(markdown, END) > 0;
  if (!hasDelimiterText) return { valid: true, events: [], markdownWithoutEvents: markdown };
  const start = starts[0]?.index;
  const end = ends[0]?.index;
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end < start) return { valid: false, reason: 'execution-event delimiter is malformed', markdownWithoutEvents: markdown };
  const afterEnd = end + END.length;
  const json = markdown.slice(start + START.length, end).trim();
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(['events', 'schemaVersion']) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.events) || !parsed.events.every(validEvent) || new Set(parsed.events.map((event) => event.id)).size !== parsed.events.length) {
      return { valid: false, reason: 'execution-event v1 schema is invalid', markdownWithoutEvents: markdown };
    }
    return { valid: true, events: parsed.events, sourceRange: range(markdown, start, afterEnd), markdownWithoutEvents: `${markdown.slice(0, start)}${markdown.slice(afterEnd)}` };
  } catch {
    return { valid: false, reason: 'execution-event JSON is invalid', markdownWithoutEvents: markdown };
  }
}

export function stripValidExecutionEvents(markdown) { return parseExecutionEvents(markdown).markdownWithoutEvents; }

export function appendExecutionEvent(markdown, event) {
  if (!validEvent(event)) throw new TypeError('execution event is invalid');
  const parsed = parseExecutionEvents(markdown);
  if (!parsed.valid) throw new TypeError(parsed.reason);
  const base = parsed.markdownWithoutEvents.trimEnd();
  const payload = JSON.stringify({ schemaVersion: 1, events: [...parsed.events, event] }, null, 2);
  return `${base}\n\n${START}\n${payload}\n${END}\n`;
}
