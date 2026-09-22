import path from 'node:path';
import { CATEGORIES, KINDS, LIMITS, OUTCOMES, freeze, hash, integer, isId, opaque, plain } from './common.mjs';
import { toolActivityTargets, toolResultPaths } from './tool-discovery.mjs';

const DEFAULT_EXCLUDES = Object.freeze([
  '**/.git/**', '**/node_modules/**', '**/.env*', '**/.ssh/**', '**/.aws/**',
  '**/.graphlin/**', '**/.graphlin-data/**', '**/.graphlin-local/**',
  '**/.visualive/**', '**/.visualive-data/**',
  '**/.npmrc*', '**/.pypirc*', '**/.netrc*', '**/_netrc*', '**/.yarnrc*',
  '**/.gitconfig', '**/.dockercfg', '**/.docker/config.json', '**/.kube/config',
  '**/.config/gcloud/**', '**/.config/gh/hosts.yml', '**/.boto', '**/.s3cfg',
  '**/.pgpass', '**/.my.cnf', '**/pip.conf', '**/pip.ini', '**/nuget.config', '**/auth.json',
  '**/*credential*', '**/*secret*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  '**/id_rsa*', '**/id_ed25519*',
]);
const policies = new WeakSet();
const compiledExclusions = new WeakMap();
export function createPolicy(options = {}) {
  if (policies.has(options)) return options;
  options = plain(options) ? options : {};
  const excludePaths = [...new Set([...DEFAULT_EXCLUDES, ...(
    Array.isArray(options.excludePaths) ? options.excludePaths.slice(0, 128)
      .filter(p => typeof p === 'string' && p.length > 0 && p.length <= 256 && !/[\0\r\n]/.test(p))
      .map(p => p.replaceAll('\\', '/').replace(/^\.\//, ''))
      .filter(p => !DEFAULT_EXCLUDES.includes(p)).slice(0, 64) : []
  )])].sort();
  const fields = {
    readSource: options.readSource === true || options.transmitSource === true,
    transmitSource: options.transmitSource === true,
    displayEvidence: options.displayEvidence !== false,
    persistEvidence: options.persistEvidence === true,
    excludePaths,
  };
  const policy = freeze({ ...fields, version: `policy-${hash(fields).slice(0, 32)}` });
  policies.add(policy);
  return policy;
}

function globRegex(pattern) {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { result += '(?:.*/)?'; i++; }
      else result += '.*';
    } else if (pattern[i] === '*') result += '[^/]*';
    else if (pattern[i] === '?') result += '[^/]';
    else result += pattern[i].replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^(?:${result})(?:/.*)?$`, 'i');
}

export function excluded(relativePath, policy) {
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || /[\0\r\n\\]/.test(relativePath)) return true;
  const normalized = relativePath.replace(/^\.\//, '');
  const effective = createPolicy(policy);
  let patterns = compiledExclusions.get(effective);
  if (!patterns) {
    patterns = effective.excludePaths.map(globRegex);
    compiledExclusions.set(effective, patterns);
  }
  return patterns.some(pattern => pattern.test(normalized));
}

const SECRET_NAME = /(?:password|passwd|passphrase|pwd|apikey|accesskeyid|(?:access|secret|private|signing|encryption)key|token|secret|auth|credentials?)(?:value)?$/i;
const ENV_NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
const ENV_LOOKUP = '(?:' + [
  String.raw`(?:process\.env|import\.meta\.env|Bun\.env)(?:\.${ENV_NAME}|\[\s*["']${ENV_NAME}["']\s*\])`,
  String.raw`os\.environ\[\s*["']${ENV_NAME}["']\s*\]`,
  String.raw`(?:os\.getenv|os\.environ\.get|Deno\.env\.get)\(\s*["']${ENV_NAME}["']\s*\)`,
].join('|') + ')';
const REFERENCE_VALUE = new RegExp(String.raw`^(?:${ENV_LOOKUP}|\$(?:${ENV_NAME}|\{${ENV_NAME}\})|(["'\x60])\$(?:${ENV_NAME}|\{(?:${ENV_NAME}|${ENV_LOOKUP})\})\1|""|''|\x60\x60|null\b|undefined\b)`);

function referenceOnly(value) {
  const reference = REFERENCE_VALUE.exec(value);
  if (!reference) return false;
  const tail = value.slice(reference[0].length);
  const trivia = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*/.exec(tail)[0];
  const next = tail.slice(trivia.length);
  if (!next || /^[;,})\]]/.test(next)) return true;
  // A newline may terminate an assignment without a semicolon, but a continued
  // expression (including a literal fallback) must never inherit the exemption.
  return /[\r\n]/.test(trivia) &&
    !/^(?:[.?'"\x60+*/%|&^<>=!:([\\-]|(?:in|instanceof|or|and|if|else)\b)/.test(next);
}

function privateBinding(text) {
  // Match the entire binding/property name before normalizing separators.
  // A word boundary immediately before "API_KEY" misses TYPESAFE_API_KEY and
  // camelCase names. The value check deliberately withholds unknown expressions.
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$-]*)['"]?\s*(?:\]\s*)?([:=])\s*/g)) {
    if (!SECRET_NAME.test(match[1].replace(/[_$-]/g, ''))) continue;
    let value = text.slice(match.index + match[0].length);
    // A common TypeScript scalar annotation is not the assigned value.
    if (match[2] === ':') value = value.replace(/^(?:string|String)(?:\s*\|\s*(?:null|undefined))*\s*=\s*/, '');
    if (!referenceOnly(value)) return true;
  }
  return false;
}

export function privateText(text) {
  if (typeof text !== 'string') return true;
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/i.test(text) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/.test(text) ||
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*['"]?(?:bearer|basic)\s+[^\s'"]+/i.test(text) ||
    privateBinding(text) ||
    /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(text) ||
    /(?:^|[\s"'`(=])(?:\/(?:Users|home|private|etc|root)\/|[A-Za-z]:[\\/])/.test(text);
}
export function safeText(text, max = LIMITS.snippetChars) {
  return typeof text === 'string' && text.length > 0 && text.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text) &&
    !privateText(text);
}
export function safeLabel(label) {
  return safeText(label, LIMITS.labelChars) && !/[\r\n<>]/.test(label) && !/^(?:\/|https?:|file:|javascript:)/i.test(label);
}

const EVENTS = Object.freeze({
  SessionStart: 'session.started', UserPromptSubmit: 'turn.prompted',
  PreToolUse: 'tool.requested', PostToolUse: 'tool.succeeded',
  PostToolUseFailure: 'tool.failed', PermissionDenied: 'tool.denied',
  Interrupt: 'tool.interrupted', Stop: 'turn.stopped', SessionEnd: 'session.ended',
  SubagentStart: 'agent.started', SubagentStop: 'agent.stopped',
  AssistantMessage: 'intent.observed', PublicMessage: 'intent.observed',
  // Kiro emits camelCase hook_event_name values (docs: features/hooks). Its
  // agentSpawn is the session-start trigger and it has no failure trigger, so
  // a failed tool is distinguished from the PostToolUse tool_response below.
  agentSpawn: 'session.started', userPromptSubmit: 'turn.prompted',
  preToolUse: 'tool.requested', postToolUse: 'tool.succeeded',
  stop: 'turn.stopped',
});
const TOOLS = new Map([
  ['read', 'read'], ['read_file', 'read'], ['readfile', 'read'],
  ['write', 'write'], ['write_file', 'write'], ['writefile', 'write'],
  ['edit', 'edit'], ['multiedit', 'edit'], ['apply_patch', 'edit'],
  ['bash', 'shell'], ['exec_command', 'shell'], ['execute_bash', 'shell'],
  ['shell', 'shell'], ['terminal', 'shell'], ['test', 'test'],
  ['grep', 'search'], ['glob', 'search'], ['search', 'search'],
  ['webfetch', 'other'], ['websearch', 'other'],
  // Kiro built-in tool names (docs: features/hooks tool matching table).
  ['fs_read', 'read'], ['fsread', 'read'],
  ['fs_write', 'write'], ['fswrite', 'write'],
  ['execute_cmd', 'shell'], ['executebash', 'shell'], ['executecmd', 'shell'],
  ['web_fetch', 'other'], ['web_search', 'other'],
]);
const boundedString = (value, max = 1024) => typeof value === 'string' && value.length <= max ? value : '';
const safeIdentity = (value, prefix, ...scope) => isId(value) ? value : opaque(prefix, ...scope, boundedString(value));
function safeTime(value) {
  const time = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= 0 && time <= 8640000000000000 ? new Date(time).toISOString() : '1970-01-01T00:00:00.000Z';
}

export function metadataEvent(event = {}) {
  const projectId = safeIdentity(event.projectId, 'project');
  const sessionId = safeIdentity(event.sessionId, 'session', projectId);
  return freeze({
    schemaVersion: 1,
    id: safeIdentity(event.id, 'event', projectId, sessionId),
    projectId, sessionId,
    agentId: safeIdentity(event.agentId, 'agent', projectId, sessionId),
    toolCallId: event.toolCallId == null ? null : safeIdentity(event.toolCallId, 'call', projectId, sessionId),
    kind: KINDS.includes(event.kind) ? event.kind : 'capture.gap',
    toolCategory: CATEGORIES.includes(event.toolCategory) ? event.toolCategory : 'other',
    outcome: OUTCOMES.includes(event.outcome) ? event.outcome : 'unresolved',
    at: safeTime(event.at),
    sequence: integer(event.sequence) ? event.sequence : 0,
    incomplete: event.incomplete !== false,
    ...(['read', 'edit'].includes(event.operation) ? { operation: event.operation } : {}),
  });
}

export function normalizeHostEvent(raw, { host = 'claude', projectId = '', sequence = 0, now = Date.now() } = {}) {
  let incomplete = false;
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.rawChars) { raw = {}; incomplete = true; }
    else { try { raw = JSON.parse(raw); } catch { raw = {}; incomplete = true; } }
  }
  if (!plain(raw)) { raw = {}; incomplete = true; }
  host = ['claude', 'codex', 'kiro'].includes(host) ? host : 'unknown';
  projectId = safeIdentity(projectId, 'project');
  const sessionId = opaque('session', projectId, host, boundedString(raw.session_id ?? raw.sessionId));
  const agentId = opaque('agent', sessionId, boundedString(raw.agent_id ?? raw.agentId) || 'root');
  const call = boundedString(raw.tool_use_id ?? raw.tool_call_id ?? raw.toolCallId);
  const toolCallId = call ? opaque('call', sessionId, agentId, call) : null;
  const sourceKind = boundedString(raw.hook_event_name ?? raw.event_type ?? raw.type ?? raw.kind, 80);
  let kind = EVENTS[sourceKind] ?? (KINDS.includes(sourceKind) ? sourceKind : 'capture.gap');
  // Delta/batch reconstruction is deliberately outside the first adapter's coverage.
  if (raw.delta !== undefined || raw.batch_index !== undefined || raw.batchIndex !== undefined ||
      /(?:delta|batch)/i.test(sourceKind)) kind = 'capture.gap';
  const input = plain(raw.tool_input) ? raw.tool_input : plain(raw.input) ? raw.input
    : typeof raw.tool_input === 'string' ? { input: raw.tool_input }
      : typeof raw.input === 'string' ? { input: raw.input } : {};
  const result = plain(raw.tool_response) ? raw.tool_response : plain(raw.result) ? raw.result : {};
  const status = raw.outcome ?? result.status;
  if (kind === 'tool.succeeded') {
    if (status === 'denied') kind = 'tool.denied';
    else if (status === 'interrupted' || status === 'cancelled' || result.interrupted === true) kind = 'tool.interrupted';
    else if (status === 'failed' || result.is_error === true || raw.is_error === true ||
      result.success === false || (Number.isInteger(result.exit_code) && result.exit_code !== 0)) kind = 'tool.failed';
    else if (host !== 'claude' && status !== 'succeeded' && result.success !== true && result.exit_code !== 0) kind = 'tool.unresolved';
  }
  if (kind === 'capture.gap') incomplete = true;
  const toolCategory = TOOLS.get(boundedString(raw.tool_name ?? raw.toolName, 100).toLowerCase()) ?? 'other';
  const activity = kind.startsWith('tool.') ? toolActivityTargets({ toolCategory, input }) : { paths: [] };
  let outcome = 'observed';
  if (kind.startsWith('tool.')) outcome = kind === 'tool.requested' ? 'pending' : kind.slice(5);
  if (kind === 'capture.gap') outcome = 'unresolved';
  const paths = new Set();
  function add(value) {
    if (paths.size < LIMITS.paths && typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value)) paths.add(value);
  }
  if (kind !== 'capture.gap') {
    // Returned filenames take priority over input directories and are only hints
    // for a fresh EvidenceStore capture, never source evidence from tool output.
    if (kind === 'tool.succeeded') for (const value of toolResultPaths(result, { toolCategory, input })) add(value);
    for (const value of [input.file_path, input.path]) add(value);
    for (const key of ['paths', 'files', 'changed_files']) {
      if (Array.isArray(input[key])) for (const value of input[key].slice(0, LIMITS.paths)) add(plain(value) ? value.path ?? value.file_path : value);
    }
    const patch = boundedString(input.patch ?? input.input, LIMITS.rawChars);
    if (toolCategory === 'edit') for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)$/gm)) add(match[1]);
  }
  const publicText = ['intent.observed', 'turn.prompted'].includes(kind)
    ? boundedString(raw.publicText ?? raw.prompt ?? raw.text ?? raw.message?.text, LIMITS.snippetChars * 4) || null : null;
  const sourceId = boundedString(raw.event_id ?? raw.id ?? raw.message_id);
  const id = opaque('event', projectId, sessionId, agentId, sourceId || toolCallId || sequence, kind, outcome);
  const timestamp = typeof now === 'function' ? now() : now;
  const directory = input.workdir ?? input.cwd ?? raw.cwd;
  const safeDirectory = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
  let workingDirectory = directory === undefined ? undefined : safeDirectory(directory) ? directory : null;
  if (workingDirectory && !path.isAbsolute(workingDirectory)) {
    workingDirectory = safeDirectory(raw.cwd) && path.isAbsolute(raw.cwd)
      ? path.resolve(raw.cwd, workingDirectory) : null;
  }
  const event = metadataEvent({
    id, projectId, sessionId, agentId, toolCallId, kind, toolCategory, outcome,
    at: timestamp, sequence, incomplete: incomplete || raw.incomplete === true, operation: activity.operation,
  });
  return { event, paths: [...paths], activityPaths: activity.paths, activityRanges: activity.ranges ?? [],
    workingDirectory, publicText };
}
