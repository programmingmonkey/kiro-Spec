import { createHash } from 'node:crypto';

// 依赖方向：本包 → `@my-harness/spec-parser`（单向）。三组依赖的归属决定见 README
// 「切法决策」：第 2、3 组（event-format / parseWaves）住在 spec-parser 是因为它们
// 本来就有 revision 之外的消费者；第 1 组（task-format 系）不搬，只把策略参数化。
import { metadataValue, parseTaskLine } from '@my-harness/spec-parser';
import { hasFenceClose, nextFenceMarker, taskIndentStack } from '@my-harness/spec-parser/scan-lines';
import { parseWaves } from '@my-harness/spec-parser/waves';
import { stripValidExecutionEvents } from '@my-harness/spec-parser/event-format';
// 第 8 期 `spec-sign-approval-clobber`：审批指纹要认得一行合法署名（协议标记豁免），
// 而识别器原本住在 `spec-analysis` —— 那会是反向边。它已搬到本包已依赖的 `spec-parser`。
import { parseSignatureLine } from '@my-harness/spec-parser/signature-line';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeSemanticText(markdown) {
  return markdown
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '\n');
}

function semanticTokens(markdown, ignoreTaskStates, strictTaskState, dropSignatures) {
  const lines = normalizeSemanticText(markdown).split('\n');
  const tokens = [];
  let fenceMarker;
  let taskIndents = [];
  const seenTaskIds = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fenceMarker) {
      const nextMarker = nextFenceMarker(line, fenceMarker, taskIndents);
      tokens.push({ kind: nextMarker === fenceMarker ? 'code' : 'fence', text: line });
      fenceMarker = nextMarker;
      continue;
    }
    const nextMarker = nextFenceMarker(line, undefined, taskIndents);
    if (nextMarker && (line.length - line.trimStart().length <= 3 || hasFenceClose(lines, index, nextMarker))) { fenceMarker = nextMarker; tokens.push({ kind: 'fence', text: line }); continue; }
    if (line.trim() === '') {
      if (index < lines.length - 1 && tokens.at(-1)?.kind !== 'paragraph-break') tokens.push({ kind: 'paragraph-break' });
      continue;
    }
    // 协议标记豁免（第 8 期 `spec-sign-approval-clobber`）：一行**合法**署名与合法
    // 执行事件块同类，都是约定要求落下的标记，不是语义。不豁免的后果是实打实的 ——
    // §4.3.2 要求的署名动作会被判成"tasks 被实质性重写"，触发 `observe()` 清空**整份**
    // spec 的审批并把 phase 退回起草阶段。
    //
    // 位置有讲究：必须在 heading 分支**之前**。`### <date> · <env> · <summary>` 是
    // 语料里真实存在的署名形态，放后面它会先落成一个 `heading` token。
    //
    // 判据用 `parseSignatureLine`（全仓「什么算署名」的唯一定义），**不是**更严的
    // 消费项目识别器 —— 后者要求列 0、`- ` 形式，会让 `###` 形式与嵌套缩进的署名
    // 豁免不到，缺陷在那些形态上静默残留。两个判据的边界（日期只校验形状、Claude 的
    // `Cowork` 要求不住在解析器里）钉在 `packages/spec-parser/test/signature-line.test.mjs`。
    //
    // 围栏内的行到不了这里（上面的 `fenceMarker` 分支已经 `continue`）——这是有意的：
    // 否则往示例代码块里加一行形如署名的文字就会变成不可见改动，那是 fail-open。
    if (dropSignatures && parseSignatureLine(line)) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      tokens.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      let fenceStart = index + 1;
      while (lines[fenceStart]?.trim() === '') fenceStart += 1;
      if (heading[2].trim() === 'Task Dependency Graph' && /^```json\s*$/.test(lines[fenceStart] ?? '')) {
        const end = lines.slice(fenceStart + 1).findIndex((candidate) => /^```\s*$/.test(candidate));
        if (end !== -1) {
          const endIndex = fenceStart + 1 + end;
          try { tokens.push({ kind: 'waves', waves: parseWaves(JSON.parse(lines.slice(fenceStart + 1, endIndex).join('\n'))).waves }); index = endIndex; continue; } catch { /* retain malformed graph as ordinary text below */ }
        }
      }
      continue;
    }
    // 🔴 策略是入参，不写死：kiro/claude 走 strict，dsh 走真机四字符类（含 `~`）。
    // 写死任一方向都会让另一侧的 approvalFingerprint 对 `[~]` 行判错。
    const task = parseTaskLine(line, { strictTaskState });
    taskIndents = taskIndentStack(taskIndents, task);
    const ancestorsPresent = task?.kind === 'task' && task.id.split('.').slice(0, -1).every((_, depth, parts) => seenTaskIds.has(parts.slice(0, depth + 1).join('.')));
    const isSemanticTask = task?.kind === 'task' && (task.indent === '' || (task.id.includes('.') && ancestorsPresent));
    if (isSemanticTask && ignoreTaskStates) { seenTaskIds.add(task.id); tokens.push({ kind: 'task', optional: task.optional, id: task.id, title: task.title.trim() }); continue; }
    const requirements = metadataValue(line, 'Requirements');
    if (requirements) { tokens.push({ kind: 'requirements', values: requirements.split(',').map((value) => value.trim()).filter(Boolean) }); continue; }
    const dependencies = metadataValue(line, 'Dependencies');
    if (dependencies) { tokens.push({ kind: 'dependencies', values: dependencies.split(',').map((value) => value.trim()).filter(Boolean) }); continue; }
    tokens.push({ kind: 'text', text: line });
  }
  return tokens;
}

/** Hash the supplied bytes without decoding, newline conversion, or trimming. */
export function computeRawRevision(raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
    throw new TypeError('raw revision input must be a UTF-8 string or byte array');
  }
  return sha256(raw);
}

/**
 * Hash **semantic-v2** content. Excluded from `tasks.md` semantics: a valid
 * execution-event block, valid task checkbox state, **and valid attribution
 * signature lines**. All other Markdown text remains represented in the
 * canonical input.
 *
 * 🔴 第 8 期 `spec-sign-approval-clobber` —— 为什么署名进豁免集：消费项目 §4.3.2 要求
 * 「改 spec 正文后在 `tasks.md` 的 `## Notes` 留一行署名」，而 DSH 把它做成了**独立工具**
 * `spec_sign`，即署名是一次**事后追加**。追加前它被当成实质语义变更，触发 `observe()` 的
 * `state.approvals = {}` —— 兄弟宿主上**整份** spec 的审批被清空、phase 从 `implementing`
 * 退回 `tasks_draft`。署名与执行事件块同类：都是约定要求落下的协议标记，不是内容。
 *
 * `schemaVersion` 由 `semantic-v1` 升为 **`semantic-v2`**：算法变了，旧指纹与新指纹不可比，
 * 这件事必须**在数据里可见**，否则表现为一次无法解释的静默失配。迁移方向是 fail-safe
 *（存量记录在"文件确有改动"时一次性失配 → 丢掉审批 → 要求重新批准），不是放过改动。
 *
 * `strictTaskState` 是**策略入参**，由三个 host 各自传（见 README）：
 *   - `true` → codex-spec / claude-spec 的历史契约：四字符类 `[ x-]`，`[~]` 不算任务；
 *   - `false` → dsh-spec 对齐真机：四字符类 `[ x~-]`，`[~]` 算任务。
 * 默认值取 `true` 是**向后兼容**的选择（两个 host 的既有调用点与测试都依赖 strict 语义），
 * 不是"kiro 更正确"。新接入方必须显式表态 —— dsh-spec 侧一律显式传 `false`。
 */
export function computeApprovalFingerprint({ artifact, markdown, strictTaskState = true }) {
  if (typeof artifact !== 'string' || typeof markdown !== 'string') throw new TypeError('artifact and markdown are required strings');
  const withoutEvents = stripValidExecutionEvents(markdown);
  // 作用域与 `stripValidExecutionEvents` 对齐：都只对 `tasks` 生效。DSH 的 `spec_sign`
  // 恒签 tasks.md；claude 的署名搭车在正文写里。`design.md` 内的人工署名仍会改变指纹 ——
  // 那是一次人工编辑设计文档，作废审批在语义上说得过去，本次明确不扩大范围。
  const dropSignatures = artifact === 'tasks';
  const content = artifact === 'tasks' ? withoutEvents : markdown;
  return sha256(JSON.stringify({ schemaVersion: 'semantic-v2', artifact, tokens: semanticTokens(content, artifact === 'tasks', strictTaskState, dropSignatures) }));
}
