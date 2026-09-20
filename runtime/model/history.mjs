import { integer, plain } from '../core/common.mjs';
import {
  id, token, label, relativePath, entityRecord, relationRecord, interpretationRecord,
  certificate, activityRecord, lineageRecord, time,
} from './records.mjs';

const natural = value => integer(value) ? value : undefined;
const boolean = value => typeof value === 'boolean' ? value : undefined;
const identity = value => id(value) ?? undefined;
const parent = value => value === null ? null : identity(value);
const name = value => relativePath(value) ?? undefined;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? time(value) : undefined;
const hash = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;

function pick(value, fields) {
  if (!plain(value)) return null;
  const result = {};
  for (const [field, clean] of Object.entries(fields)) {
    const selected = clean(value[field]);
    if (selected !== undefined) result[field] = selected;
  }
  return result;
}
function list(values, limit, clean) {
  if (!Array.isArray(values) || values.length > limit) return null;
  const result = values.map(clean);
  return result.every(Boolean) ? result : null;
}
function unique(records) {
  return records.every(record => id(record.id)) && new Set(records.map(record => record.id)).size === records.length;
}
const counts = value => pick(value, Object.fromEntries([
  'inventoried', 'inspected', 'retained', 'inventoryDeferred', 'excluded', 'unsupported', 'unavailable',
  'oldestSequence', 'entities', 'relations', 'artifacts', 'imports', 'interpretations', 'scopes',
  'observed', 'resolved', 'unresolved', 'deferred',
].map(field => [field, natural])));

function coverageRecord(value, limits) {
  if (!plain(value)) return null;
  const scopes = list(value.scopes ?? [], limits.scopes, value => pick(value, {
    id: identity, parentId: parent, relativePath: name, label: value => value === undefined ? undefined : label(value),
    inventoried: natural, deferred: natural,
  }));
  const files = list(value.files ?? [], limits.artifacts, value => pick(value, {
    id: identity, relativePath: name, root: name, kind: value => token(value, 'file'), size: natural,
    mtimeMs: value => Number.isFinite(value) && value >= 0 ? value : undefined,
    scopeId: identity, parentId: parent, artifactId: identity,
  }));
  const enumerations = list(value.enumerations ?? [], limits.artifacts, certificate);
  const artifacts = list(value.artifacts ?? [], limits.artifacts, value => pick(value, {
    id: identity, hash, generation: natural, status: value => token(value),
    complete: boolean, fresh: boolean, observed: boolean, relativePath: name,
  }));
  if (!scopes || !files || !enumerations || !artifacts ||
      !unique(scopes) || !unique(files) || !unique(artifacts)) return null;
  return {
    ...counts(value), complete: value.complete === true, truncated: value.truncated === true,
    deferred: counts(value.deferred) ?? {}, relationships: counts(value.relationships) ?? {},
    scopes, files, enumerations, artifacts,
    ...(lineageRecord(value.lineage) ? { lineage: lineageRecord(value.lineage) } : {}),
  };
}

function validForest(entities) {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  for (const entity of entities) {
    const seen = new Set([entity.id]);
    let child = entity;
    while (child.parentId) {
      const owner = byId.get(child.parentId);
      if (!owner || seen.has(owner.id) || seen.size > 256) return false;
      if (child.artifactId && owner.basis !== 'metadata') {
        const span = child.sourceRefs.find(ref => ref.artifactId === child.artifactId);
        const enclosing = owner.sourceRefs.find(ref => ref.artifactId === child.artifactId);
        if (owner.artifactId !== child.artifactId || !span?.startLine || !enclosing?.startLine ||
            span.startLine < enclosing.startLine || span.endLine > enclosing.endLine) return false;
      }
      seen.add(owner.id);
      child = owner;
    }
  }
  return true;
}

/**
 * Frozen history records what was believed at its cutoff. Validate and copy it
 * without performing live restore, freshness reconciliation, or reconstruction.
 * This plain snapshot cannot authorize current evidence or new decisions.
 */
export function restoreFrozenSnapshot(value, { projectId, limits }) {
  if (!plain(value) || value.schemaVersion !== 2 || value.projectId !== projectId ||
      !integer(value.revision) || !integer(value.sequence)) return null;
  const entities = list(value.entities, limits.entities, record => entityRecord(record, limits.refs));
  const relations = list(value.relations, limits.relations, record => relationRecord(record, limits.refs));
  const interpretations = list(value.interpretations, limits.interpretations, record => interpretationRecord(record, limits.refs));
  const activity = list(value.activity, limits.activity, record => {
    if (!integer(record?.sequence) || record.sequence > value.sequence) return null;
    return activityRecord(record, record.sequence, Date.parse(record.recordedAt));
  });
  const sessions = list(value.sessions, limits.sessions, value => pick(value, {
    id: identity, host: value => token(value), status: value => token(value), startedAt: timestamp, endedAt: timestamp,
  }));
  // A checkpoint records its own marker as well as the previously retained
  // markers. Nested states are deliberately neither copied nor traversed.
  const checkpoints = list(value.checkpoints, limits.checkpoints + 1, marker => {
    if (!plain(marker) || marker.projectId !== projectId || !integer(marker.sequence) ||
        marker.sequence > value.sequence || !integer(marker.revision) || marker.revision > value.revision) return null;
    return pick(marker, {
      id: identity, projectId: identity, label: value => label(value, 'Checkpoint'),
      revision: natural, sequence: natural, at: timestamp, sessionId: identity,
    });
  });
  const coverage = coverageRecord(value.coverage, limits);
  if (!entities || !relations || !interpretations || !activity || !sessions || !checkpoints || !coverage ||
      ![entities, relations, interpretations, sessions, checkpoints].every(unique) || !validForest(entities)) return null;
  const entityIds = new Set(entities.map(entity => entity.id));
  if (entities.some(entity => entity.knownAtSequence > value.sequence || entity.createdAtSequence > value.sequence) ||
      relations.some(relation => !entityIds.has(relation.source) || !entityIds.has(relation.target)) ||
      interpretations.some(record => record.entityIds.some(entityId => !entityIds.has(entityId)))) return null;
  return {
    schemaVersion: 2, projectId, revision: value.revision, sequence: value.sequence,
    entities, relations, interpretations, activity, coverage, sessions, checkpoints,
  };
}
