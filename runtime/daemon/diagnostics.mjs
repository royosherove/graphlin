import { constants } from 'node:fs';
import { open, lstat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CATEGORIES, KINDS, ROLES, RELATIONS, isId, opaque, plain } from '../core/common.mjs';
import { createPolicy, excluded, privateText, safeLabel } from '../core/privacy.mjs';
import { ACTIVITIES } from '../decisions/questions.mjs';
import { runtimeError, uid } from './paths.mjs';

export const DIAGNOSTIC_LIMITS = Object.freeze({
  records: 300, ringBytes: 512 * 1024, recordBytes: 32 * 1024,
  pendingBytes: 256 * 1024, fileBytes: 1024 * 1024, flushMs: 100,
});
const STAGES = new Set(['capture', 'candidates', 'classification', 'apply', 'skip']);
const STATUSES = new Set(['accepted', 'irrelevant', 'unavailable', 'timeout', 'overloaded', 'invalid',
  'abstained', 'observed', 'captured', 'queued', 'started', 'completed', 'applied', 'skipped',
  'deferred', 'stale', 'duplicate', 'failed', 'pending', 'present', 'missing', 'partial', 'unchanged',
  'ready', 'ok', 'rejected', 'tentative', 'added', 'updated']);
const REASONS = new Set([
  'ok', 'unknown', 'closed', 'overloaded', 'invalid', 'duplicate', 'capture_gap', 'capture_failed',
  'metadata_only', 'missing_key', 'paused', 'no_candidates', 'no_artifacts', 'no_changes',
  'unchanged', 'tool_requested', 'session_missing', 'session_evicted', 'no_decision_service',
  'queued', 'applied', 'no_patch', 'stale_evidence', 'policy_mismatch', 'pipeline_failure',
  'deadline_exceeded', 'queue_full', 'request_budget', 'question_budget', 'request_too_large',
  'remote_cooldown', 'no_approved_candidates', 'no_accepted_classification', 'insufficient_relevance',
  'cancelled', 'service_closed', 'core_unavailable', 'transport_failure', 'decision_failure',
  'authentication_failed', 'request_rejected', 'http_error', 'response_too_large',
  'invalid_event', 'invalid_candidates', 'invalid_candidate', 'candidate_too_large',
  'invalid_endpoint', 'invalid_limits', 'invalid_thresholds', 'invalid_bundle', 'invalid_proposals',
  'invalid_proposal', 'duplicate_proposal', 'invalid_configuration', 'invalid_clock',
  'invalid_http_response', 'invalid_policy', 'invalid_input', 'invalid_signal', 'invalid_deadline',
  'invalid_probabilities', 'invalid_probability_sum', 'invalid_response', 'invalid_answer_type',
  'invalid_noul', 'invalid_confidence', 'invalid_choice', 'invalid_score', 'invalid_question_type',
  'invalid_response_body', 'invalid_json', 'below_threshold', 'sensitive', 'irrelevant',
  'unknown_role', 'missing_context', 'unsupported', 'excluded', 'not_admitted',
  'pipeline_closed', 'classifier_unavailable', 'paused_deferred', 'classification_started',
  'classifier_exception', 'invalid_result', 'deadline_before_apply', 'deadline_after_revalidation',
  'patch_applied', 'no_graph_change', 'source_changed_during_classification', 'classification_not_drawable',
  'classification_pipeline_error', 'capture_queue_full', 'duplicate_event', 'artifacts_observed',
  'classification_queued', 'classification_queue_full', 'classification_queue_expired',
  'queued_source_superseded', 'queued_source_refreshed', 'queued_source_unavailable',
  'source_version_completed', 'source_version_pending',
  'artifact_changed', 'artifact_unchanged', 'tool_request_has_no_source_outcome', 'unsupported_event',
  'invalid_capture', 'source_reconciliation', 'no_session',
  'event_not_classifiable', 'excluded_path', 'file_missing', 'incomplete_artifact', 'artifact_unavailable',
  'source_withheld', 'empty_source', 'source_not_safe', 'candidate_limit', 'candidates_ready', 'artifact_limit', 'snippet_limit',
  'unsupported_source', 'source_unavailable', 'analysis_failed', 'architecture_complete', 'architecture_unknown',
  'architecture_partial', 'architecture_unavailable', 'architecture_cancelled',
  'architecture_capture_failed', 'architecture_analysis_failed', 'architecture_commit_failed', 'unknown_profile',
  'approved', 'sensitive_and_irrelevant', 'candidate_incomplete', 'event_incomplete',
  'node_support_below_min', 'role_probability_below_min', 'role_confidence_below_min',
  'source_not_accepted', 'target_not_accepted', 'evidence_incomplete', 'edge_support_below_min',
  'missing_context_above_max', 'inconsistent_evidence', 'unknown_fixture_question',
  'admitted', 'already_current', 'support_below_floor', 'stale_generation', 'node_limit', 'edge_limit',
  'graph_byte_limit', 'endpoints_not_drawable', 'reference_limit', 'revision_limit', 'invalid_graph',
  'decision_not_compilable', 'invalid_judgments', 'judgment_limit', 'duplicate_judgments',
  'empty_decision', 'no_change', 'no_drawable_change',
]);
const ID_KEYS = ['eventId', 'sourceEventId', 'sessionId'];
const PATCH_KEYS = ['revisionBefore', 'revisionAfter', 'nodesAdded', 'nodesUpdated', 'nodesRemoved',
  'edgesAdded', 'edgesUpdated', 'edgesRemoved'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const probability = value => finite(value) && value <= 1;
const code = value => REASONS.has(value) || STATUSES.has(value) ? value : 'unknown';
const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const copyFields = (input, keys, validate) => Object.fromEntries(keys
  .filter(key => validate(input?.[key])).map(key => [key, input[key]]));

function relativePath(value, policy) {
  if (typeof value !== 'string' || !value || value.length > 512 ||
      /[\u0000-\u001f\u007f-\u009f\\<>:\u202a-\u202e\u2066-\u2069]/.test(value) ||
      path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..') ||
      privateText(value) || excluded(value, policy)) return undefined;
  return value;
}

// Filtering uses the EvidenceStore identity, without touching the named file.
// Deleted files are therefore still searchable in the retained log.
export function diagnosticArtifactId(projectRoot, filename, inputRoot = projectRoot) {
  if (typeof filename !== 'string' || !filename || filename.length > 4096 || /[\0\r\n\\]/.test(filename)) {
    throw runtimeError('invalid_log_filter');
  }
  let absolute = path.resolve(projectRoot, filename);
  const aliasRelative = path.relative(path.resolve(inputRoot), absolute);
  if (path.resolve(inputRoot) !== projectRoot && aliasRelative && aliasRelative !== '..' &&
      !aliasRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(aliasRelative)) {
    absolute = path.resolve(projectRoot, aliasRelative);
  }
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw runtimeError('invalid_log_filter');
  }
  return opaque('artifact', projectRoot, relative.split(path.sep).join('/'));
}

// Every trace property has a finite schema. Unknown fields, arbitrary map keys,
// transport bodies, strings posing as numbers, and free-form errors are dropped.
function traceEntry(input) {
  const result = {
    ...copyFields(input, ['candidateId', 'artifactId', 'proposalId', 'sourceCandidateId', 'targetCandidateId'], isId),
    ...copyFields(input, ['sensitive', 'relevant', 'relevance', 'support', 'supportProbability',
      'roleProbability', 'roleConfidence', 'missingContext', 'missingContextProbability',
      'sensitiveMax', 'relevantMin', 'relevanceMin', 'nodeSupportMin', 'roleProbabilityMin',
      'roleConfidenceMin', 'edgeSupportMin', 'missingContextMax'], probability),
    ...copyFields(input, ['candidateCount', 'approvedCount', 'proposalCount', 'nodeCount', 'edgeCount',
      'omitted', 'calls', 'questionCount', 'requestBytes', 'responseBytes', 'durationMs'], finite),
    ...copyFields(input, ['approved', 'admitted', 'complete', 'accepted', 'dispatched',
      'sensitivityPassed', 'relevancePassed'], value => typeof value === 'boolean'),
  };
  for (const key of ['questionCount', 'requestBytes']) if (input[key] === null) result[key] = null;
  if (input.materialized === null || typeof input.materialized === 'boolean') result.materialized = input.materialized;
  for (const key of ['code', 'reason']) if (typeof input[key] === 'string') result[key] = code(input[key]);
  if (Array.isArray(input.reasons)) result.reasons = list(input.reasons, 16).map(code);
  if (STATUSES.has(input.status)) result.status = input.status;
  if (['accepted', 'tentative', 'abstained', 'skipped'].includes(input.classification)) result.classification = input.classification;
  if ([...ROLES, 'unknown'].includes(input.role)) result.role = input.role;
  if (RELATIONS.includes(input.relation)) result.relation = input.relation;
  if (plain(input.roleProbabilities)) result.roleProbabilities = copyFields(input.roleProbabilities, [...ROLES, 'unknown'], probability);
  if (['A', 'B'].includes(input.stage)) result.stage = input.stage;
  if (input.model === 'unknown' || (typeof input.model === 'string' && /^jev-\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.model))) result.model = input.model;
  if (typeof input.rubricVersion === 'string' && /^(?:intake|architecture)-v[1-9]\d{0,3}$/.test(input.rubricVersion)) result.rubricVersion = input.rubricVersion;
  if (input.httpStatus === null || (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599)) result.httpStatus = input.httpStatus;
  if (input.usage === null) result.usage = null;
  else if (plain(input.usage)) result.usage = copyFields(input.usage, ['input_tokens', 'output_tokens'], count);
  if (['source', 'public_intent'].includes(input.sourceClass)) result.sourceClass = input.sourceClass;
  for (const key of ['candidateIds', 'evidenceCandidateIds']) {
    if (Array.isArray(input[key])) result[key] = list(input[key], 12).filter(isId);
  }
  return result;
}

function trace(input) {
  const result = {};
  if (input.version === 1) result.version = 1;
  if (input.activity === null) result.activity = null;
  else if (plain(input.activity)) result.activity = {
    ...copyFields(input.activity, ['choice'], value => ACTIVITIES.includes(value)),
    ...copyFields(input.activity, ['confidence'], probability),
    ...(plain(input.activity.probabilities)
      ? { probabilities: copyFields(input.activity.probabilities, ACTIVITIES, probability) } : {}),
  };
  if (input.relevance === null || probability(input.relevance)) result.relevance = input.relevance;
  if (plain(input.outcome)) result.outcome = {
    ...copyFields(input.outcome, ['status'], value => STATUSES.has(value)),
    code: code(input.outcome.code),
  };
  if (plain(input.thresholds)) result.thresholds = {
    intake: copyFields(input.thresholds.intake, ['sensitiveMax', 'relevantMin'], probability),
    admission: copyFields(input.thresholds.admission, ['relevanceMin', 'nodeSupportMin', 'roleProbabilityMin',
      'roleConfidenceMin', 'edgeSupportMin', 'missingContextMax'], probability),
  };
  for (const key of ['intake', 'nodes', 'edges', 'requests']) {
    if (Array.isArray(input[key])) result[key] = list(input[key], key === 'requests' ? 2 : 12).filter(plain).map(traceEntry);
  }
  return result;
}

function decisionDiagnostics(input) {
  if (!plain(input)) return undefined;
  const result = {
    ...copyFields(input, ['durationMs', 'calls', 'candidatesOmitted', 'proposalsOmitted'], finite),
    ...copyFields(input, ['usageIncomplete'], value => typeof value === 'boolean'),
  };
  if (typeof input.code === 'string') result.code = code(input.code);
  if (Array.isArray(input.codes)) result.codes = list(input.codes, 16).map(code);
  if (['demo', 'live'].includes(input.mode)) result.mode = input.mode;
  for (const key of ['questionCounts', 'stageDurationMs']) {
    if (plain(input[key])) result[key] = copyFields(input[key], ['A', 'B'], finite);
  }
  if (plain(input.usage)) result.usage = copyFields(input.usage, ['input_tokens', 'output_tokens'], count);
  for (const key of ['intakePolicyVersion', 'admissionPolicyVersion']) {
    if (typeof input[key] === 'string' && /^(?:intake|admission)-policy-v[1-9]\d{0,3}$/.test(input[key])) result[key] = input[key];
  }
  if (plain(input.trace)) result.trace = trace(input.trace);
  if (plain(input.queue)) result.queue = copyFields(input.queue,
    ['waitMs', 'depth', 'active', 'capacity', 'omitted'], finite);
  if (plain(input.architecture)) result.architecture = {
    ...copyFields(input.architecture, ['stage'], value => ['capture', 'analysis', 'commit'].includes(value)),
    ...copyFields(input.architecture, ['attempted', 'analyzed', 'withheld', 'unsupported', 'unavailable', 'deferred'],
      value => count(value) && value <= 10_000),
  };
  if (Array.isArray(input.extraction)) result.extraction = list(input.extraction, 33).filter(plain).map(value => ({
    ...copyFields(value, ['artifactId'], isId),
    ...copyFields(value, ['available', 'selected'], count),
    ...copyFields(value, ['truncated'], flag => typeof flag === 'boolean'),
    reason: code(value.reason),
  }));
  if (Array.isArray(input.admission)) result.admission = list(input.admission, 32).filter(plain).map(value => ({
    ...copyFields(value, ['candidateId', 'proposalId'], isId),
    ...copyFields(value, ['status'], status => STATUSES.has(status)),
    reason: code(value.reason),
  }));
  return result;
}

function sanitize(input, policy, evidence) {
  if (!plain(input) || input.schemaVersion !== 1 || !STAGES.has(input.stage)) return null;
  const at = typeof input.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(input.at)
    && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  const result = {
    schemaVersion: 1, at, stage: input.stage,
    ...copyFields(input, ID_KEYS, isId),
    eventKind: KINDS.includes(input.eventKind) ? input.eventKind : 'capture.gap',
    toolCategory: CATEGORIES.includes(input.toolCategory) ? input.toolCategory : 'other',
    status: STATUSES.has(input.status) ? input.status : 'invalid',
    reason: code(input.reason),
    artifacts: list(input.artifacts, 32).filter(plain).filter(value => isId(value.artifactId)).map(value => ({
      artifactId: value.artifactId,
      ...copyFields(value, ['status'], status => ['present', 'missing', 'unavailable', 'partial'].includes(status)),
      ...copyFields(value, ['complete'], complete => typeof complete === 'boolean'),
      ...copyFields(value, ['candidateCount', 'availableCandidates'], count),
      ...(typeof value.reason === 'string' ? { reason: code(value.reason) } : {}),
      ...(evidence && relativePath(value.path, policy) ? { path: value.path } : {}),
    })),
    candidates: list(input.candidates, 12).filter(plain).filter(value => isId(value.candidateId)).map(value => ({
      candidateId: value.candidateId, ...copyFields(value, ['artifactId'], isId),
      ...copyFields(value, ['sourceClass'], source => ['source', 'public_intent'].includes(source)),
      ...copyFields(value, ['complete'], complete => typeof complete === 'boolean'),
      ...(count(value.startLine) && value.startLine > 0 && count(value.endLine) && value.endLine >= value.startLine
        ? { startLine: value.startLine, endLine: value.endLine } : {}),
      ...(evidence && safeLabel(value.label) && !/[`"'{};=]/.test(value.label) ? { label: value.label } : {}),
    })),
  };
  const diagnostics = decisionDiagnostics(input.diagnostics);
  if (diagnostics) result.diagnostics = diagnostics;
  if (plain(input.patch)) result.patch = copyFields(input.patch, PATCH_KEYS, count);
  if (input.truncated === true) result.truncated = true;
  return result;
}

function filenames(directory) {
  return { logPath: path.join(directory, 'diagnostics.jsonl'), backupPath: path.join(directory, 'diagnostics.1.jsonl') };
}
async function privateDir(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) ||
      (uid() !== undefined && info.uid !== uid())) throw runtimeError('unsafe_diagnostic_file');
}
function privateFile(info) {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) ||
      info.size > DIAGNOSTIC_LIMITS.fileBytes || (uid() !== undefined && info.uid !== uid())) {
    throw runtimeError('unsafe_diagnostic_file');
  }
}
async function inspectFile(filename) {
  try { const info = await lstat(filename); privateFile(info); return info; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readLines(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat(); privateFile(info);
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > DIAGNOSTIC_LIMITS.fileBytes) throw runtimeError('unsafe_diagnostic_file');
    // A process killed during append can leave one partial last line.
    const body = buffer.subarray(0, offset).toString('utf8');
    return body.slice(0, body.lastIndexOf('\n') + 1).split('\n');
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  finally { await file?.close(); }
}

function retained() {
  const records = [];
  let bytes = 0, evicted = 0;
  return {
    add(record) {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (size > DIAGNOSTIC_LIMITS.recordBytes) return false;
      records.push({ record, size }); bytes += size;
      while (records.length > DIAGNOSTIC_LIMITS.records || bytes > DIAGNOSTIC_LIMITS.ringBytes) {
        bytes -= records.shift().size; evicted++;
      }
      return true;
    },
    values: () => records.map(item => item.record),
    stats: () => ({ recordCount: records.length, ringBytes: bytes, evicted }),
  };
}
function envelope(ring, stats, source, artifactId) {
  if (artifactId !== undefined && !/^artifact-[a-f0-9]{32}$/.test(artifactId)) throw runtimeError('invalid_log_filter');
  const records = ring.values().filter(record => artifactId === undefined ||
    record.artifacts.some(item => item.artifactId === artifactId) ||
    record.candidates.some(item => item.artifactId === artifactId));
  return { schemaVersion: 1, source, records: structuredClone(records),
    stats: { ...stats, ...ring.stats(), returned: records.length }, logPath: stats.logPath };
}

async function load({ directory, policy }) {
  const ring = retained(), stats = { ...filenames(directory), readFailures: 0, invalidRecords: 0, lastSeq: 0 };
  try { await privateDir(directory); }
  catch (error) { if (error.code !== 'ENOENT') stats.readFailures++; return { ring, stats }; }
  for (const filename of [stats.backupPath, stats.logPath]) {
    let lines;
    try { lines = await readLines(filename); } catch { stats.readFailures++; continue; }
    for (const line of lines) {
      if (!line) continue;
      try {
        if (Buffer.byteLength(line) > DIAGNOSTIC_LIMITS.recordBytes) throw new Error();
        const input = JSON.parse(line), record = sanitize(input, policy, policy.transmitSource && policy.displayEvidence);
        if (!record || !count(input.seq) || input.seq < 1 || !/^diagnostic-[a-f0-9]{32}$/.test(input.id)) throw new Error();
        if (input.seq <= stats.lastSeq) continue;
        stats.lastSeq = input.seq;
        if (!ring.add({ ...record, id: input.id, seq: input.seq })) throw new Error();
      } catch { stats.invalidRecords++; }
    }
  }
  return { ring, stats };
}

// A stopped caller has no current source/display consent. Explicit internal
// callers may supply policy; CLI fallback intentionally uses the safe defaults.
export async function readPersistedDiagnostics({ directory, policy }, { artifactId } = {}) {
  const { ring, stats } = await load({ directory, policy: createPolicy(policy) });
  return envelope(ring, stats, 'persisted', artifactId);
}

export async function createDiagnostics({ directory, projectRoot, policy: options } = {}) {
  const policy = createPolicy(options), { ring, stats } = await load({ directory, policy });
  Object.assign(stats, { accepted: 0, written: 0, dropped: 0, truncated: 0, persistenceFailures: 0, rotations: 0 });
  let pending = [], pendingBytes = 0, inFlightBytes = 0, timer, running, closed = false;
  const instance = randomUUID();
  async function append(body) {
    await privateDir(directory);
    let current = await inspectFile(stats.logPath);
    if (current && current.size + body.length > DIAGNOSTIC_LIMITS.fileBytes) {
      await inspectFile(stats.backupPath);
      await rename(stats.logPath, stats.backupPath);
      stats.rotations++; current = null;
    }
    let file;
    try {
      file = await open(stats.logPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT |
        constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const info = await file.stat(); privateFile(info);
      if (info.size + body.length > DIAGNOSTIC_LIMITS.fileBytes) throw runtimeError('diagnostic_file_full');
      if (info.size) {
        const tail = Buffer.alloc(Math.min(info.size, DIAGNOSTIC_LIMITS.recordBytes + 1));
        await file.read(tail, 0, tail.length, info.size - tail.length);
        if (tail.at(-1) !== 10) {
          const newline = tail.lastIndexOf(10);
          if (newline < 0 && info.size > tail.length) throw runtimeError('invalid_diagnostic_tail');
          await file.truncate(info.size - tail.length + newline + 1);
          stats.invalidRecords++;
        }
      }
      await file.writeFile(body);
      await file.sync();
    } finally { await file?.close(); }
  }
  function drain() {
    if (running) return running;
    running = (async () => {
      while (pending.length) {
        const batch = pending; pending = [];
        const bytes = pendingBytes; pendingBytes = 0; inFlightBytes = bytes;
        try { await append(Buffer.from(batch.join(''))); stats.written += batch.length; }
        catch { stats.persistenceFailures++; stats.dropped += batch.length; }
        finally { inFlightBytes = 0; }
      }
    })().finally(() => {
      running = null;
      // A record can arrive after the loop settles but before this callback.
      // Include that handoff in the shared promise, even if close() joined it.
      if (pending.length) return drain();
    });
    return running;
  }
  const getStats = () => ({ ...stats, ...ring.stats(), pendingBytes: pendingBytes + inFlightBytes,
    limits: DIAGNOSTIC_LIMITS });
  return {
    record(input) {
      if (closed) return false;
      try {
        const record = sanitize(input, policy, policy.transmitSource);
        if (!record || stats.lastSeq >= Number.MAX_SAFE_INTEGER) { stats.invalidRecords++; return false; }
        const seq = ++stats.lastSeq, id = opaque('diagnostic', projectRoot, instance, seq);
        // Keep an oversized event's identity and reason instead of silently
        // losing it. Normal pipeline records fit without this fallback.
        if (Buffer.byteLength(JSON.stringify(record)) > DIAGNOSTIC_LIMITS.recordBytes - 128) {
          record.truncated = true;
          for (const artifact of record.artifacts) delete artifact.path;
          for (const candidate of record.candidates) delete candidate.label;
          if (Buffer.byteLength(JSON.stringify(record)) > DIAGNOSTIC_LIMITS.recordBytes - 128) {
            if (record.diagnostics) delete record.diagnostics.trace;
          }
          stats.truncated++;
        }
        const live = { ...sanitize(record, policy, policy.transmitSource && policy.displayEvidence), id, seq };
        const persistent = { ...sanitize(record, policy, policy.transmitSource && policy.persistEvidence), id, seq };
        const line = `${JSON.stringify(persistent)}\n`, bytes = Buffer.byteLength(line);
        if (bytes > DIAGNOSTIC_LIMITS.recordBytes || !ring.add(live)) { stats.dropped++; return false; }
        stats.accepted++;
        if (pendingBytes + inFlightBytes + bytes > DIAGNOSTIC_LIMITS.pendingBytes) { stats.dropped++; return true; }
        pending.push(line); pendingBytes += bytes;
        if (!timer && !running) timer = setTimeout(() => { timer = null; void drain(); }, DIAGNOSTIC_LIMITS.flushMs);
        return true;
      } catch { stats.invalidRecords++; return false; }
    },
    snapshot: ({ artifactId } = {}) => envelope(ring, getStats(), 'live', artifactId),
    stats: getStats,
    async flush() { clearTimeout(timer); timer = null; await drain(); },
    async close() { closed = true; clearTimeout(timer); timer = null; await drain(); },
  };
}
