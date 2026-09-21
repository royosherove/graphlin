import { safeText } from '../core/privacy.mjs';
import {
  DATA_FIELDS, EXTENSION_LIMITS as L, check, plain, exact, id, extensionId,
  digest, integer, text, uniqueStrings, jsonBytes,
} from './contracts.mjs';

export function validateGrant(grant) {
  check(exact(grant, ['projectId', 'extensionId', 'digest', 'fields', 'history', 'approved'], ['grantedAt', 'profiles']) &&
    id(grant.projectId) && extensionId(grant.extensionId) && digest(grant.digest) &&
    uniqueStrings(grant.fields, value => DATA_FIELDS.includes(value)) &&
    typeof grant.history === 'boolean' && typeof grant.approved === 'boolean' &&
    (!grant.fields.includes('checkpoints') || grant.history), 'invalid_extension_grant');
  check(grant.grantedAt === undefined || timestamp(grant.grantedAt), 'invalid_extension_grant');
  check(grant.profiles === undefined || uniqueStrings(grant.profiles,
    value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value), 8), 'invalid_extension_grant');
  return JSON.parse(JSON.stringify(grant));
}

const timestamp = value => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const safeId = value => id(value) && safeText(value, 160);
// Display metadata is still constrained. All locator fields are omitted, and
// even strings smuggled into a label cannot contain absolute paths or secrets.
const safeLabel = value => text(value) && safeText(value, L.text) &&
  !/(?:^|[\s"'`(=])(?:\/|[A-Za-z]:[\\/]|\\\\)|[\\]/.test(value);
const token = value => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(value);
const pick = (input, fields) => {
  if (!plain(input)) return {};
  return Object.fromEntries(Object.entries(fields).filter(([key, valid]) => valid(input[key]))
    .map(([key]) => [key, input[key]]));
};
const refs = values => Array.isArray(values) ? values.slice(0, 16).filter(plain).map(value => pick(value, {
  artifactId: safeId, eventId: safeId, hash: digest, generation: integer,
  startLine: value => integer(value, 10_000_000) && value > 0,
  endLine: value => integer(value, 10_000_000) && value > 0,
  sourceClass: value => ['source', 'public_intent', 'runtime'].includes(value),
})) : [];
const ids = values => Array.isArray(values) ? [...new Set(values.slice(0, 256).filter(safeId))] : [];
const basis = value => ['metadata', 'parsed', 'lexical', 'decision', 'legacy',
  'documentation', 'annotation', 'runtime'].includes(value);
const validity = value => ['current', 'stale', 'retracted'].includes(value);
const classification = value => ['accepted', 'tentative', 'unknown', 'stale', 'pending', 'abstained'].includes(value);
const base = { id: safeId, kind: token, basis, validity };
const map = (values, limit, project) => Array.isArray(values)
  ? values.slice(0, limit).filter(value => plain(value) && safeId(value.id)).map(project) : [];

function entity(value) {
  const result = {
    ...pick(value, { ...base, artifactId: safeId, qualifiedName: safeLabel, classification }),
    label: safeLabel(value.label) ? value.label : 'Entity',
    parentId: safeId(value.parentId) ? value.parentId : null,
    sourceRefs: refs(value.sourceRefs),
  };
  return result;
}
function relation(value) {
  return { ...pick(value, { ...base, source: safeId, target: safeId }), sourceRefs: refs(value.sourceRefs) };
}
function interpretation(value) {
  return {
    ...pick(value, { ...base, namespace: safeId, version: safeId, classification,
      support: value => ['supported', 'tentative', 'unknown', 'contradicted'].includes(value) }),
    label: safeLabel(value.label) ? value.label : 'Interpretation',
    entityIds: ids(value.entityIds), sourceRefs: refs(value.sourceRefs),
  };
}
function activity(value) {
  return {
    ...pick(value, { id: safeId, kind: token, sessionId: safeId, agentId: safeId, toolCallId: safeId,
      sequence: integer, knownAtSequence: integer, at: timestamp, recordedAt: timestamp,
      toolCategory: value => ['read', 'write', 'edit', 'shell', 'search', 'test', 'other'].includes(value),
      operation: value => ['read', 'edit'].includes(value),
      mapping: value => ['exact', 'decision'].includes(value),
      attribution: value => ['observed', 'correlated', 'unknown'].includes(value),
      outcome: value => ['pending', 'succeeded', 'failed', 'interrupted', 'denied', 'unresolved', 'observed'].includes(value),
      creation: value => typeof value === 'boolean' }),
    entityIds: ids(value.entityIds), artifactIds: ids(value.artifactIds), sourceRefs: refs(value.sourceRefs),
  };
}
const counts = Object.fromEntries(['total', 'inventoried', 'inspected', 'parsed', 'deferred', 'excluded',
  'unsupported', 'unavailable', 'truncated', 'retained', 'files', 'entities', 'relations']
  .map(key => [key, integer]));
function coverage(value) {
  if (!plain(value)) return {};
  return {
    ...pick(value, { ...counts, complete: value => typeof value === 'boolean', status: token }),
    ...(plain(value.counts) ? { counts: pick(value.counts, counts) } : {}),
    scopes: map(value.scopes, 1024, item => ({
      ...pick(item, { id: safeId, entityId: safeId, parentId: safeId, status: token, ...counts }),
      label: safeLabel(item.label) ? item.label : 'Scope',
    })),
  };
}

/**
 * Pure API-v1 disclosure ceiling. `snapshot` MUST already reflect the current
 * core policy, including when replaying. Obtain `grant` from getGrant for every
 * delivery; a copied grant is not a bearer credential or a live authorization.
 * Denied/unapproved/cross-project grants return null, never an empty snapshot.
 */
export function getExtensionDataProjection(snapshot, grant) {
  try { validateGrant(grant); } catch { return null; }
  if (!grant.approved || !plain(snapshot) || snapshot.projectId !== grant.projectId) return null;
  check(snapshot.schemaVersion === 2 && safeId(snapshot.projectId) &&
    integer(snapshot.revision) && integer(snapshot.sequence), 'invalid_model_snapshot');
  if ((snapshot.replay === true || snapshot.checkpointId !== undefined) && !grant.history) return null;
  const fields = new Set(grant.fields);
  const result = {
    schemaVersion: 2, projectId: snapshot.projectId, revision: snapshot.revision, sequence: snapshot.sequence,
    entities: fields.has('entities') ? map(snapshot.entities, L.entities, entity) : [],
    relations: fields.has('relations') && fields.has('entities') ? map(snapshot.relations, L.relations, relation) : [],
    interpretations: fields.has('interpretations') && fields.has('entities')
      ? map(snapshot.interpretations, 512, interpretation) : [],
    activity: fields.has('activity') ? map(snapshot.activity, 2048, activity) : [],
    coverage: fields.has('coverage') ? coverage(snapshot.coverage) : {},
    sessions: fields.has('sessions') ? map(snapshot.sessions, 64, value => pick(value, {
      id: safeId, host: value => ['claude', 'codex', 'kiro', 'demo', 'unknown'].includes(value),
      startedAt: timestamp, endedAt: timestamp, status: token,
    })) : [],
    checkpoints: fields.has('checkpoints') && grant.history ? map(snapshot.checkpoints, 64, value => ({
      ...pick(value, { id: safeId, revision: integer, sequence: integer, at: timestamp, createdAt: timestamp }),
      label: safeLabel(value.label) ? value.label : 'Checkpoint',
    })) : [],
  };
  const entityIds = new Set(result.entities.map(value => value.id));
  for (const value of result.entities) if (!entityIds.has(value.parentId)) value.parentId = null;
  result.relations = result.relations.filter(value => entityIds.has(value.source) && entityIds.has(value.target));
  result.interpretations = result.interpretations.filter(value => value.entityIds.every(entityId => entityIds.has(entityId)));
  for (const value of result.activity) value.entityIds = value.entityIds.filter(entityId => entityIds.has(entityId));
  jsonBytes(result, L.projectionBytes, 'extension_projection_limit');
  return result;
}
