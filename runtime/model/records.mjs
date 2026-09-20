import { opaque, plain, integer } from '../core/common.mjs';
import { excluded, safeText } from '../core/privacy.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  entities: 20_000, relations: 40_000, artifacts: 10_000, interpretations: 512,
  imports: 20_000, scopes: 1_024, activity: 2_048, sessions: 64, checkpoints: 8,
  bytes: 48 * 1024 * 1024, softBytes: 32 * 1024 * 1024,
  checkpointBytes: 32 * 1024 * 1024, refs: 16,
});
export const id = value => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) && safeText(value, 160) ? value : null;
export const token = (value, fallback = 'unknown') => typeof value === 'string' &&
  /^[a-z][a-z0-9_.-]{0,63}$/.test(value) && safeText(value, 64) ? value : fallback;
export const label = (value, fallback = 'Unknown') => typeof value === 'string' &&
  safeText(value, 240) && !/[\r\n<>]/.test(value) && !/^(?:\/|[a-z]+:)/i.test(value) ? value : fallback;
export const validity = value => ['current', 'stale', 'retracted'].includes(value) ? value : 'stale';
export const classification = value => ['accepted', 'tentative', 'unknown', 'stale', 'pending', 'abstained'].includes(value)
  ? value : 'unknown';
export const basis = value => ['metadata', 'parsed', 'lexical', 'decision', 'legacy'].includes(value) ? value : 'legacy';
export const byteSize = value => Buffer.byteLength(JSON.stringify(value));
export const key = (prefix, ...parts) => opaque(prefix, ...parts);
const version = value => typeof value === 'string' && value.length <= 256 &&
  /^[@A-Za-z0-9][A-Za-z0-9_.@+/-]*$/.test(value) && safeText(value, 256) ? value : null;

export function relativePath(value, policy = {}) {
  if (typeof value !== 'string' || value.length > 512 || !value ||
      /[\\:\0\r\n<>%]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..') ||
      !safeText(value, 512) || excluded(value, policy)) return null;
  return value;
}

export function currentPolicy(provider) {
  const value = (typeof provider === 'function' ? provider() : provider) ?? {};
  return {
    readSource: value.readSource === true || value.transmitSource === true,
    displayEvidence: value.displayEvidence !== false,
    persistEvidence: value.persistEvidence === true,
    excludePaths: Array.isArray(value.excludePaths) ? value.excludePaths : [],
  };
}

export function lineageRecord(value) {
  if (!plain(value) || !id(value.id)) return null;
  const branch = label(value.branch, '');
  return {
    id: value.id, status: token(value.status),
    ...(branch ? { branch } : {}),
    ...(typeof value.head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head) ? { head: value.head } : {}),
  };
}

export function references(values, max = DEFAULT_LIMITS.refs) {
  if (!Array.isArray(values) || values.length > max) return null;
  const result = [];
  for (const value of values) {
    if (!plain(value) || !id(value.artifactId) || !integer(value.generation, 1) ||
        typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) return null;
    const ref = { artifactId: value.artifactId, hash: value.hash, generation: value.generation };
    if (integer(value.startLine, 1, 10_000_000) && integer(value.endLine, value.startLine, 10_000_000)) {
      ref.startLine = value.startLine;
      ref.endLine = value.endLine;
    }
    if (id(value.eventId)) ref.eventId = value.eventId;
    if (id(value.extractor)) ref.extractor = value.extractor;
    if (version(value.extractorVersion)) ref.extractorVersion = value.extractorVersion;
    if (version(value.identityVersion)) ref.identityVersion = value.identityVersion;
    // Intent references cannot be promoted to deterministic source support.
    if (value.sourceClass === 'public_intent') ref.sourceClass = 'public_intent';
    result.push(ref);
  }
  return result;
}

export function entityRecord(value, maxRefs) {
  if (!plain(value) || !id(value.id)) return null;
  const sourceRefs = references(value.sourceRefs ?? [], maxRefs);
  if (!sourceRefs) return null;
  const entity = {
    id: value.id, label: label(value.label), kind: token(value.kind),
    parentId: id(value.parentId), sourceRefs, basis: basis(value.basis),
    validity: validity(value.validity), classification: classification(value.classification),
  };
  if (id(value.artifactId)) entity.artifactId = value.artifactId;
  if (value.qualifiedName) entity.qualifiedName = label(value.qualifiedName);
  if (id(value.sessionId)) entity.sessionId = value.sessionId;
  if (id(value.legacyId)) entity.legacyId = value.legacyId;
  if (relativePath(value.relativePath)) entity.relativePath = value.relativePath;
  if (integer(value.knownAtSequence)) entity.knownAtSequence = value.knownAtSequence;
  if (integer(value.createdAtSequence, 1)) entity.createdAtSequence = value.createdAtSequence;
  if (value.ownership === 'unresolved') entity.ownership = 'unresolved';
  return entity;
}

export function relationRecord(value, maxRefs) {
  if (!plain(value) || !id(value.id) || !id(value.source) || !id(value.target)) return null;
  const sourceRefs = references(value.sourceRefs ?? [], maxRefs);
  if (!sourceRefs) return null;
  return {
    id: value.id, source: value.source, target: value.target, kind: token(value.kind),
    basis: basis(value.basis), validity: validity(value.validity), sourceRefs,
  };
}

export function interpretationRecord(value, maxRefs) {
  if (!plain(value) || !id(value.id) || typeof value.namespace !== 'string' ||
      !/^[a-z][a-z0-9_-]*(?:[.:][a-z0-9_-]+)+$/.test(value.namespace) || !safeText(value.namespace, 80)) return null;
  const sourceRefs = references(value.sourceRefs ?? [], maxRefs);
  if (!sourceRefs || !Array.isArray(value.entityIds) || value.entityIds.length > 256 ||
      value.entityIds.some(value => !id(value))) return null;
  return {
    id: value.id, namespace: value.namespace, kind: token(value.kind),
    label: label(value.label), entityIds: [...new Set(value.entityIds)],
    basis: 'decision', validity: validity(value.validity),
    classification: classification(value.classification),
    support: ['supported', 'tentative', 'unknown', 'contradicted'].includes(value.support) ? value.support : 'unknown',
    sourceRefs, version: id(String(value.version ?? '1')) ?? '1',
    ...(id(value.sessionId) ? { sessionId: value.sessionId } : {}),
  };
}

export function certificate(value) {
  if (!plain(value) || !id(value.artifactId) || !id(value.scopeId) ||
      !integer(value.generation, 1) || !/^[a-f0-9]{64}$/.test(value.hash)) return null;
  const ranges = Array.isArray(value.coveredRanges) ? value.coveredRanges.slice(0, 128).flatMap(range => {
    const startLine = Array.isArray(range) ? range[0] : range?.startLine;
    const endLine = Array.isArray(range) ? range[1] : range?.endLine;
    return integer(startLine, 1, 10_000_000) && integer(endLine, startLine, 10_000_000) ? [{ startLine, endLine }] : [];
  }) : [];
  const omissions = Array.isArray(value.omissions) ? value.omissions.slice(0, 32).map(v => token(v, 'unspecified')) : ['unspecified'];
  const validVersions = version(String(value.version ?? '')) && version(String(value.identityVersion ?? '')) && id(value.extractor);
  return {
    artifactId: value.artifactId, scopeId: value.scopeId, hash: value.hash, generation: value.generation,
    complete: value.complete === true && omissions.length === 0 && !!validVersions && ranges.length > 0 &&
      value.coveredRanges.length === ranges.length && value.capability === 'parsed',
    extractor: id(value.extractor) ?? 'unknown', version: version(String(value.version ?? '')) ?? 'unknown',
    identityVersion: version(String(value.identityVersion ?? '')) ?? 'unknown',
    coveredRanges: ranges, omissions, capability: token(value.capability),
  };
}

export function activityRecord(value, sequence, now) {
  if (!plain(value)) return null;
  const at = time(value.at ?? value.timestamp, now);
  const record = {
    id: id(value.id) ?? key('activity', sequence, at),
    kind: token(value.kind, 'capture.gap'), sequence, knownAtSequence: sequence,
    at, recordedAt: time(now, now),
    outcome: ['pending', 'succeeded', 'failed', 'interrupted', 'denied', 'unresolved', 'observed'].includes(value.outcome)
      ? value.outcome : 'unresolved',
    toolCategory: token(value.toolCategory, 'other'),
    attribution: ['observed', 'correlated', 'unknown'].includes(value.attribution) ? value.attribution : 'unknown',
  };
  for (const field of ['sessionId', 'agentId', 'toolCallId']) if (id(value[field])) record[field] = value[field];
  for (const field of ['entityIds', 'artifactIds']) {
    record[field] = Array.isArray(value[field]) ? [...new Set(value[field].slice(0, 256).filter(id))] : [];
  }
  const sourceRefs = references(value.sourceRefs ?? []);
  record.sourceRefs = sourceRefs ?? [];
  // Creation is accepted only as an explicit successful observation with source
  // version correlation. A write attempt or a new file in inventory is not one.
  record.creation = value.creation === true && record.outcome === 'succeeded' &&
    record.kind !== 'tool.requested' && record.sourceRefs.length > 0 &&
    record.sourceRefs.every(ref => ref.sourceClass !== 'public_intent');
  return record;
}

export function time(value, fallback = 0) {
  const number = typeof value === 'string' ? Date.parse(value) : value;
  const safe = Number.isFinite(number) && number >= 0 && number <= 8_640_000_000_000_000 ? number : fallback;
  return new Date(Number.isFinite(safe) ? safe : 0).toISOString();
}

/** Projection is an allowlist, including for restored state and old checkpoints. */
export function projectSnapshot(state, policy, { persistent = false, sessionId, scopeId } = {}) {
  const sourceLabels = policy.readSource && policy.displayEvidence && (!persistent || policy.persistEvidence);
  const blockedArtifacts = new Set((state.coverage.artifacts ?? []).filter(value =>
    value.relativePath && !relativePath(value.relativePath, policy)).map(value => value.id));
  let entities = state.entities.map(value => entityRecord(value)).filter(Boolean).map(entity => {
    const path = relativePath(entity.relativePath, policy);
    const metadata = path && (entity.basis === 'metadata' || ['file', 'module'].includes(entity.kind));
    if (metadata) entity.label = path.split('/').at(-1);
    if (!sourceLabels || blockedArtifacts.has(entity.artifactId) || entity.relativePath && !path) {
      if (!metadata) {
        entity.label = entity.kind === 'project' ? 'Project' : token(entity.kind, 'entity');
      }
      delete entity.qualifiedName;
    }
    if (entity.basis === 'metadata' && !path && entity.kind !== 'project') entity.label = entity.kind;
    if (!path) delete entity.relativePath;
    return entity;
  });
  if (scopeId) {
    const children = new Map();
    for (const entity of entities) {
      if (!children.has(entity.parentId)) children.set(entity.parentId, []);
      children.get(entity.parentId).push(entity.id);
    }
    const selected = new Set(), pending = [scopeId];
    while (pending.length) {
      const next = pending.pop();
      if (selected.has(next)) continue;
      selected.add(next);
      pending.push(...(children.get(next) ?? []));
    }
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    let parent = byId.get(scopeId)?.parentId;
    while (parent && !selected.has(parent)) { selected.add(parent); parent = byId.get(parent)?.parentId; }
    entities = entities.filter(entity => selected.has(entity.id));
  }
  const entityIds = new Set(entities.map(entity => entity.id));
  const relations = state.relations.map(value => relationRecord(value)).filter(value =>
    value && entityIds.has(value.source) && entityIds.has(value.target));
  const interpretations = state.interpretations.map(value => interpretationRecord(value)).filter(value =>
    value && value.entityIds.every(entityId => entityIds.has(entityId))).map(value =>
    sourceLabels && !value.sourceRefs.some(ref => blockedArtifacts.has(ref.artifactId)) ? value : { ...value, label: 'Interpretation' });
  const activity = state.activity.filter(value => !sessionId || value.sessionId === sessionId).map(value => {
    const record = activityRecord(value, value.sequence, Date.parse(value.recordedAt));
    record.entityIds = record.entityIds.filter(value => entityIds.has(value));
    return record;
  });
  const coverage = structuredClone(state.coverage);
  coverage.scopes = (coverage.scopes ?? []).map(scope => {
    const path = relativePath(scope.relativePath, policy);
    return { ...scope, label: path ?? 'Scope', ...(path ? { relativePath: path } : { relativePath: undefined }) };
  });
  coverage.files = (coverage.files ?? []).map(file => {
    const path = relativePath(file.relativePath, policy);
    return { ...file, relativePath: path ?? undefined, root: relativePath(file.root, policy) ?? undefined };
  });
  coverage.artifacts = (coverage.artifacts ?? []).map(artifact => ({
    ...artifact, relativePath: relativePath(artifact.relativePath, policy) ?? undefined,
  }));
  return {
    schemaVersion: 2, projectId: state.projectId, revision: state.revision, sequence: state.sequence,
    entities, relations, interpretations, activity, coverage,
    sessions: state.sessions.filter(value => !sessionId || value.id === sessionId).map(value => ({ ...value })),
    checkpoints: state.checkpoints.map(value => ({ ...value, label: sourceLabels ? label(value.label, 'Checkpoint') : 'Checkpoint' })),
  };
}
