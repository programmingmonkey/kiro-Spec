const projectRoot = { type: 'string', description: '目标项目的规范化绝对路径。' };
const spec = { type: 'string', minLength: 1, description: '相对 specsRoot 的安全 Spec 路径。' };
const artifact = { type: 'string', enum: ['requirements', 'design', 'tasks', 'bugfix'] };
const approvalArtifact = { type: 'string', enum: ['requirements', 'design', 'tasks', 'bugfix', 'all'], description: 'all 仅用于 quick 工作流的一次性整体确认。' };
const workflow = { type: 'string', enum: ['requirements-first', 'design-first', 'bugfix', 'quick'] };
const epoch = { type: 'integer', minimum: 0 };
const revision = { type: 'string', minLength: 1 };
const stringArray = { type: 'array', items: { type: 'string' } };
const workspacePathEntry = {
  anyOf: [
    { type: 'string' },
    object({ path: { type: 'string', minLength: 1 }, contentRevision: revision }, ['path', 'contentRevision'])
  ]
};
const markdown = { type: 'string' };
const artifactMarkdown = object({ requirements: markdown, design: markdown, tasks: markdown, bugfix: markdown }, []);
artifactMarkdown.description = '按 artifact 名索引的 Markdown 文本；只需提供待校验的部分。';
const sourceRevisions = object({ requirements: revision, design: revision, tasks: revision }, ['requirements', 'design', 'tasks']);
sourceRevisions.description = '来自 spec_sync_preview 的三份源 rawRevision，用于同步应用前的 CAS 校验。';
const findings = {
  type: 'array',
  description: '来自 spec_analyze 的只读结论，逐条带来源定位。',
  items: object({
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
    artifact,
    location: object({ line: { type: 'integer', minimum: 1 } }, ['line']),
    ruleId: { type: 'string', minLength: 1 },
    evidence: { type: 'string', minLength: 1 },
    suggestedAction: { type: 'string', minLength: 1 }
  }, ['severity', 'artifact', 'location', 'ruleId', 'evidence', 'suggestedAction'])
};
const workspaceSnapshot = object({
  head: { type: 'string' }, index: { type: 'string' }, trackedDirty: { type: 'array', items: workspacePathEntry },
  untracked: { type: 'array', items: workspacePathEntry }, untrackedPolicy: { type: 'string', enum: ['include', 'exclude'] },
  submodules: stringArray,
  lfs: object({ policy: { type: 'string' }, pointers: stringArray }, ['policy', 'pointers']),
  modes: stringArray, eol: { type: 'string', enum: ['lf', 'crlf'] },
  platform: { type: 'string', enum: ['darwin', 'linux'] }
}, ['head', 'index', 'trackedDirty', 'untracked', 'untrackedPolicy', 'submodules', 'lfs', 'modes', 'eol', 'platform']);
workspaceSnapshot.description = '由宿主采集的结构化工作区快照；路径集必须排除 .kiro/specs/**、.codex-spec-private/**（以及旧名的只读回退目录）、.claude/claude-spec-gate.log 与 .claude/claude-spec-gate.heartbeat。服务端会 canonicalize 并重算 revision，但不执行 Git。';
const nullableRevision = { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] };

function object(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function define(name, description, inputSchema, { readOnly = false, destructive = false } = {}) {
  return {
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false }
  };
}

export const tools = [
  define('spec_health', '检查目标项目 adapter、写入边界和 codex-spec 基础能力。', object({ projectRoot }, ['projectRoot']), { readOnly: true }),
  define('spec_list', '发现目标项目中的已管理与 external Spec，不接管或修改它们。', object({ projectRoot }, ['projectRoot']), { readOnly: true }),
  define('spec_template', '返回某工作流某 artifact 的规范起草模板，不写入任何文件。', object({ projectRoot, workflow, artifact }, ['projectRoot', 'workflow', 'artifact']), { readOnly: true }),
  define('spec_validate_artifacts', '只读校验**调用方传入的** Markdown（尚未落盘的草稿用它）；workflow 只决定哪些 artifact 合法，不代表 spec 类型。已落盘的 spec 请用 spec_diagnostics，不必传正文。', object({ projectRoot, workflow, artifacts: artifactMarkdown }, ['projectRoot', 'workflow', 'artifacts']), { readOnly: true }),
  define('spec_init', '创建新 Spec 的私有状态和受控目录，并推进到该工作流的起草阶段。', object({ projectRoot, spec, workflow }, ['projectRoot', 'spec', 'workflow'])),
  // T3b（第 9 期）：`workflow` 由必填改为**可选** —— 省略时按 spec 自己的 `.config.kiro`
  // 派生（真机写在 spec 目录里的类型声明）。显式值与它冲突时**拒绝接管**，
  // 不替调用方在两者之间选：那两套 workflow 的 artifact 与审批链不同，选错不是措辞问题。
  define('spec_adopt', '接管已有 Spec 并记录 artifact 基线；接管不等于批准。workflow 可省略：省略时按 spec 自己的 .config.kiro 派生；显式值与它冲突则拒绝接管。', object({ projectRoot, spec, workflow }, ['projectRoot', 'spec'])),
  define('spec_read', '读取一个已管理 artifact，并刷新其 rawRevision 与语义指纹基线。', object({ projectRoot, spec, artifact }, ['projectRoot', 'spec', 'artifact'])),
  define('spec_context', '加载写入或执行当前 artifact 所需的项目权威规则，并签发短期 contextProof。', object({ projectRoot, spec, artifact }, ['projectRoot', 'spec', 'artifact']), { readOnly: true }),
  define('spec_write', '使用 contextProof 与 rawRevision CAS 原子替换当前阶段的 Spec Markdown。', object({ projectRoot, spec, artifact, content: { type: 'string' }, expectedRawRevision: nullableRevision, contextProof: { type: 'string', minLength: 1 } }, ['projectRoot', 'spec', 'artifact', 'content', 'expectedRawRevision', 'contextProof']), { destructive: true }),
  define('spec_status', '读取已管理 Spec 的 phase、批准、任务、waves 与执行恢复状态；发现外部变化时刷新状态。', object({ projectRoot, spec }, ['projectRoot', 'spec'])),
  define('spec_diagnostics', '对标 Kiro getDiagnostics 的 spec 分支：直接读盘上该 spec 的全部 artifact，按 Kiro 规则与本仓约定返回 findings（spec 类型取 .config.kiro 写明的值），缺席的列入 missingArtifacts；另附 tasks 解析警告与应由宿主执行的只读 validator 计划。只读，不刷新基线。不含代码的编译/类型诊断。', object({ projectRoot, spec }, ['projectRoot', 'spec']), { readOnly: true }),
  define('spec_analyze', '只读比较 requirements/design/tasks，返回带来源定位的可追溯性结论。', object({ projectRoot, spec }, ['projectRoot', 'spec']), { readOnly: true }),
  define('spec_quality_preview', '只读汇总三份 artifact 的质量画面与其源 rawRevision。', object({ projectRoot, spec }, ['projectRoot', 'spec']), { readOnly: true }),
  define('spec_sync_preview', '只读给出无歧义的追加型同步建议，不修改任何 artifact。', object({ projectRoot, spec }, ['projectRoot', 'spec']), { readOnly: true }),
  define('spec_sync_apply', '在三份源 revision、design contextProof 与精确确认短语齐备时，应用唯一的追加型设计同步建议。', object({ projectRoot, spec, sourceRevisions, contextProof: { type: 'string', minLength: 1 }, confirmationText: { type: 'string', minLength: 1 } }, ['projectRoot', 'spec', 'sourceRevisions', 'contextProof', 'confirmationText']), { destructive: true }),
  define('spec_record_analysis', '把一次 spec_analyze 的结论以 stateEpoch CAS 记入私有状态，不改写 Markdown。', object({ projectRoot, spec, findings, expectedStateEpoch: epoch }, ['projectRoot', 'spec', 'findings', 'expectedStateEpoch'])),
  define('spec_request_approval', '固定当前 artifact 指纹并返回精确批准短语与 stateEpoch。', object({ projectRoot, spec, artifact: approvalArtifact }, ['projectRoot', 'spec', 'artifact'])),
  define('spec_record_approval', '记录与最新请求匹配的 collaborative 批准并推进当前工作流阶段。', object({ projectRoot, spec, artifact: approvalArtifact, expectedStateEpoch: epoch, confirmationText: { type: 'string', minLength: 1 } }, ['projectRoot', 'spec', 'artifact', 'expectedStateEpoch', 'confirmationText'])),
  define('spec_task_set', '手动将一个任务标为未开始、进行中或完成；严格执行 lease 存在时拒绝绕过。', object({ projectRoot, spec, taskId: { type: 'string', minLength: 1 }, state: { type: 'string', enum: ['pending', 'in-progress', 'done'] } }, ['projectRoot', 'spec', 'taskId', 'state']), { destructive: true }),
  define('spec_task_plan', '为已 adopt 且进入 implementing 的 Spec 计算 task、wave 或 all 串行执行计划；发现外部变化时刷新状态。', object({ projectRoot, spec, scope: { type: 'string', enum: ['task', 'wave', 'all'] }, taskId: { type: 'string', minLength: 1 }, waveId: { type: 'integer', minimum: 0 }, workspaceSnapshot }, ['projectRoot', 'spec', 'scope', 'workspaceSnapshot'])),
  define('spec_task_begin', '验证计划与 epoch，取得单个任务 lease，并将 checkbox 从 [ ] 原子改为 [-]。', object({ projectRoot, spec, taskId: { type: 'string', minLength: 1 }, planRevision: revision, expectedStateEpoch: epoch, workspaceSnapshot, recoverExpired: { type: 'boolean' } }, ['projectRoot', 'spec', 'taskId', 'planRevision', 'expectedStateEpoch', 'workspaceSnapshot']), { destructive: true }),
  define('spec_task_record_check', '为当前 owner 记录 agent-reported 命令、退出码和结果摘要，不执行命令。', object({ projectRoot, spec, ownerToken: revision, expectedStateEpoch: epoch, command: { type: 'string', minLength: 1 }, exitCode: { type: 'integer' }, summary: { type: 'string', minLength: 1 } }, ['projectRoot', 'spec', 'ownerToken', 'expectedStateEpoch', 'command', 'exitCode', 'summary'])),
  define('spec_task_complete', '要求成功检查和有效 owner，将活动任务从 [-] 原子改为 [x]。', object({ projectRoot, spec, ownerToken: revision, expectedStateEpoch: epoch, workspaceSnapshot, summary: { type: 'string', minLength: 1 } }, ['projectRoot', 'spec', 'ownerToken', 'expectedStateEpoch', 'workspaceSnapshot', 'summary']), { destructive: true }),
  define('spec_task_fail', '关闭当前 attempt，将插件拥有的 [-] 恢复为 [ ] 并累计失败次数。', object({ projectRoot, spec, ownerToken: revision, expectedStateEpoch: epoch, summary: { type: 'string', minLength: 1 } }, ['projectRoot', 'spec', 'ownerToken', 'expectedStateEpoch', 'summary']), { destructive: true }),
  define('spec_task_reset_failures', '在人工复核后用精确确认短语解除某任务的三次失败门禁，并保留审计记录。', object({ projectRoot, spec, taskId: { type: 'string', minLength: 1 }, expectedStateEpoch: epoch, confirmationText: { type: 'string', minLength: 1 } }, ['projectRoot', 'spec', 'taskId', 'expectedStateEpoch', 'confirmationText']), { destructive: true })
];

export const toolNames = tools.map(({ name }) => name);

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function validationError(schema, value, location) {
  if (schema.anyOf) return schema.anyOf.some((candidate) => !validationError(candidate, value, location)) ? null : `${location} does not match any allowed schema`;
  if (schema.type && !matchesType(value, schema.type)) return `${location} must be ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${location} must be one of ${schema.enum.join(', ')}`;
  if (schema.minLength !== undefined && value.length < schema.minLength) return `${location} is too short`;
  if (schema.minimum !== undefined && value < schema.minimum) return `${location} must be at least ${schema.minimum}`;
  if (schema.type === 'object') {
    for (const required of schema.required ?? []) if (!(required in value)) return `${location}.${required} is required`;
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !(key in (schema.properties ?? {})));
      if (extra) return `${location}.${extra} is not allowed`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) { const issue = validationError(child, value[key], `${location}.${key}`); if (issue) return issue; }
    }
  }
  if (schema.type === 'array' && schema.items) {
    for (let index = 0; index < value.length; index += 1) { const issue = validationError(schema.items, value[index], `${location}[${index}]`); if (issue) return issue; }
  }
  return null;
}

export function validateToolArguments(name, value) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return `unknown tool: ${name}`;
  return validationError(tool.inputSchema, value, 'arguments');
}
