import { createHash } from 'node:crypto';

function sorted(values) { return [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); }
function hash(value) { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
const NON_EVIDENCE_PATHS = new Set(['.claude/claude-spec-gate.log', '.claude/claude-spec-gate.heartbeat']);
function evidenceEntries(values) {
  return values.filter((entry) => !NON_EVIDENCE_PATHS.has(typeof entry === 'string' ? entry : entry?.path));
}

/** Build a portable, caller-supplied workspace snapshot; this module never invokes Git. */
export function canonicalWorkspaceSnapshot({ head, index, trackedDirty = [], untracked = [], untrackedPolicy, submodules = [], lfs = { policy: 'none', pointers: [] }, modes = [], eol, platform }) {
  if (!['include', 'exclude'].includes(untrackedPolicy)) throw new TypeError('untrackedPolicy must be include or exclude');
  if (!['lf', 'crlf'].includes(eol)) throw new TypeError('eol must be lf or crlf');
  if (!['darwin', 'linux'].includes(platform)) throw new TypeError('platform must be darwin or linux');
  const canonical = {
    schemaVersion: 1, head, index, trackedDirty: sorted(evidenceEntries(trackedDirty)),
    untrackedPolicy, untracked: untrackedPolicy === 'include' ? sorted(evidenceEntries(untracked)) : [],
    submodules: sorted(submodules), lfs: { policy: lfs.policy, pointers: sorted(lfs.pointers ?? []) },
    modes: sorted(modes), eol, platformPolicy: 'portable'
  };
  return { ...canonical, revision: hash(canonical) };
}
