import {
  ACTIVITY_STATES, CLASSIFICATIONS, EVIDENCE_STATES, LIMITS, RELATIONS, ROLES, ROLE_LABELS, ROLE_SHAPES, SHAPES, VALIDITIES,
  clone, equal, exactKeys, fail, freeze, hash, integer, isHash, isId, opaque, plain, probability,
} from './common.mjs';
import { createPolicy, metadataEvent, safeLabel, safeText } from './privacy.mjs';
import { proposalId, validBundle, validSourceRef } from './candidates.mjs';

const NODE = ['id', 'label', 'kind', 'shape', 'x', 'y', 'evidenceState', 'activityState', 'classification', 'validity', 'sourceRefs'];
const EDGE = ['id', 'source', 'target', 'relation', 'label', 'evidenceState', 'classification', 'validity', 'sourceRefs'];
const REF = ['artifactId', 'hash', 'generation', 'eventId', 'startLine', 'endLine', 'sourceClass', 'basis'];
// Experimental graph-admission floor v1. Below this, a judgment is not a
// drawable claim, even when its role is known or its classification says
// "accepted". This is separate from A's unchanged privacy/relevance gates.
const EXPERIMENTAL_SUPPORT_FLOOR = 0.5;
const patchHistory = new WeakMap();
// Only hashes/versions, never a content or path lookup. Unknown/restored claims
// cannot regain source labels merely by flipping a display/persistence switch.
const approvalVersions = new Map();
const contentKey = item => hash(item);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function approve(item, version) {
  approvalVersions.set(contentKey(item), version);
  if (approvalVersions.size > 8192) approvalVersions.delete(approvalVersions.keys().next().value);
}
function preserveApproval(before, after) {
  const version = approvalVersions.get(contentKey(before));
  if (version) approve(after, version);
}

function validReference(ref) {
  if (!exactKeys(ref, REF, ['excerpt', 'sourceRef']) || !isId(ref.artifactId) || !isHash(ref.hash) ||
      !integer(ref.generation, 1) || !isId(ref.eventId) || !integer(ref.startLine, 1, 10000000) ||
      !integer(ref.endLine, ref.startLine, 10000000) || ref.endLine - ref.startLine >= LIMITS.snippetLines ||
      !['source', 'public_intent'].includes(ref.sourceClass) ||
      !['jev_interpretation', 'decision_interpretation'].includes(ref.basis) ||
      (Object.hasOwn(ref, 'excerpt') && !safeText(ref.excerpt, LIMITS.excerptChars))) return false;
  if (ref.sourceClass === 'public_intent' && !ref.sourceRef) return false;
  if (ref.sourceRef) {
    if (!validSourceRef(ref.sourceRef)) return false;
    const source = ref.sourceRef;
    if (source.hash !== ref.hash || (source.artifactId ?? source.messageId) !== ref.artifactId ||
        (source.generation ?? source.contentVersion) !== ref.generation ||
        (source.type === 'artifact' ? 'source' : 'public_intent') !== ref.sourceClass) return false;
  }
  return true;
}
function validClaim(item) {
  return isId(item.id) && EVIDENCE_STATES.includes(item.evidenceState) &&
    CLASSIFICATIONS.includes(item.classification) && VALIDITIES.includes(item.validity) &&
    (!Object.hasOwn(item, 'confidence') || probability(item.confidence)) &&
    Array.isArray(item.sourceRefs) && item.sourceRefs.length > 0 && item.sourceRefs.length <= LIMITS.refs &&
    item.sourceRefs.every(validReference) &&
    // Public intent can never certify code or runtime, including through replay.
    (!item.sourceRefs.some(ref => ref.sourceClass === 'public_intent') || ['proposed', 'removed'].includes(item.evidenceState));
}
function validNode(node) {
  // Role and shape membership are independent so older persisted combinations
  // remain valid. Only fresh compilation applies the current default mapping.
  return exactKeys(node, NODE, ['confidence']) && validClaim(node) && safeLabel(node.label) &&
    ROLES.includes(node.kind) && SHAPES.includes(node.shape) &&
    Number.isFinite(node.x) && Number.isFinite(node.y) &&
    Math.abs(node.x) <= LIMITS.coordinate && Math.abs(node.y) <= LIMITS.coordinate &&
    ACTIVITY_STATES.includes(node.activityState);
}
function validEdge(edge) {
  return exactKeys(edge, EDGE, ['confidence']) && validClaim(edge) &&
    isId(edge.source) && isId(edge.target) && edge.source !== edge.target &&
    RELATIONS.includes(edge.relation) && edge.label === edge.relation;
}
function validGraph(graph) {
  if (!exactKeys(graph, ['schemaVersion', 'revision', 'nodes', 'edges']) || graph.schemaVersion !== 1 ||
      !integer(graph.revision) || !Array.isArray(graph.nodes) || graph.nodes.length > LIMITS.nodes ||
      !Array.isArray(graph.edges) || graph.edges.length > LIMITS.edges ||
      !graph.nodes.every(validNode) || !graph.edges.every(validEdge)) return false;
  const nodes = new Set(graph.nodes.map(n => n.id)), edges = new Set(graph.edges.map(e => e.id));
  return nodes.size === graph.nodes.length && edges.size === graph.edges.length &&
    graph.edges.every(edge => nodes.has(edge.source) && nodes.has(edge.target)) && bytes(graph) <= LIMITS.graphBytes;
}
function assertGraph(graph) { if (!validGraph(graph)) fail('INVALID_GRAPH'); }
export function emptyGraph() { return { schemaVersion: 1, revision: 0, nodes: [], edges: [] }; }

function validOperation(op) {
  if (op?.op === 'node.upsert') return exactKeys(op, ['op', 'node']) && validNode(op.node);
  if (op?.op === 'edge.upsert') return exactKeys(op, ['op', 'edge']) && validEdge(op.edge);
  return ['node.remove', 'edge.remove'].includes(op?.op) && exactKeys(op, ['op', 'id']) && isId(op.id);
}
function validPatch(patch) {
  return exactKeys(patch, ['schemaVersion', 'id', 'baseRevision', 'revision', 'causedBy', 'operations']) &&
    patch.schemaVersion === 1 && (isId(patch.id) || patch.id === 'restore') &&
    integer(patch.baseRevision) && integer(patch.revision, 1) && patch.revision === patch.baseRevision + 1 &&
    Array.isArray(patch.causedBy) && patch.causedBy.length <= LIMITS.candidates && patch.causedBy.every(isId) &&
    Array.isArray(patch.operations) && patch.operations.length > 0 && patch.operations.length <= LIMITS.operations &&
    patch.operations.every(validOperation);
}
function reduce(graph, operations) {
  const nodes = new Map(graph.nodes.map(node => [node.id, clone(node)]));
  const edges = new Map(graph.edges.map(edge => [edge.id, clone(edge)]));
  for (const op of operations) {
    if (op.op === 'node.upsert') nodes.set(op.node.id, clone(op.node));
    else if (op.op === 'edge.upsert') edges.set(op.edge.id, clone(op.edge));
    else if (op.op === 'edge.remove') edges.delete(op.id);
    else {
      nodes.delete(op.id);
      for (const [id, edge] of edges) if (edge.source === op.id || edge.target === op.id) edges.delete(id);
    }
  }
  return { schemaVersion: 1, revision: graph.revision + 1, nodes: [...nodes.values()], edges: [...edges.values()] };
}
export function applyPatch(graph, patch) {
  assertGraph(graph);
  if (!validPatch(patch)) fail('INVALID_PATCH');
  const history = patchHistory.get(graph) ?? new Map(), fingerprint = hash(patch);
  if (history.has(patch.id)) {
    if (history.get(patch.id) !== fingerprint) fail('PATCH_ID_CONFLICT');
    return graph;
  }
  if (patch.baseRevision !== graph.revision) fail('REVISION_CONFLICT');
  // All operations and final endpoints are checked before publishing a result.
  const result = reduce(graph, patch.operations);
  assertGraph(result);
  const nextHistory = new Map(history);
  nextHistory.set(patch.id, fingerprint);
  if (nextHistory.size > 1024) nextHistory.delete(nextHistory.keys().next().value);
  patchHistory.set(result, nextHistory);
  return result;
}

function makePatch(graph, operations, causedBy = []) {
  if (!operations.length || graph.revision === Number.MAX_SAFE_INTEGER) return null;
  return freeze({
    schemaVersion: 1, id: opaque('patch', graph.revision, causedBy, operations),
    baseRevision: graph.revision, revision: graph.revision + 1, causedBy, operations,
  });
}
function sourceReference(candidate, event, policy, basis = 'jev_interpretation') {
  const ref = {
    artifactId: candidate.artifactId, hash: candidate.hash, generation: candidate.generation, eventId: event.id,
    startLine: candidate.startLine, endLine: candidate.endLine, sourceClass: candidate.sourceClass,
    basis, sourceRef: clone(candidate.sourceRef),
  };
  if (policy.displayEvidence || policy.persistEvidence) {
    const excerpt = candidate.text.slice(0, LIMITS.excerptChars);
    if (safeText(excerpt, LIMITS.excerptChars)) ref.excerpt = excerpt;
  }
  return ref;
}
const refKey = ref => JSON.stringify([ref.artifactId, ref.hash, ref.generation, ref.startLine, ref.endLine, ref.sourceClass]);
function mergeReferences(old, fresh) {
  const replaced = new Set(fresh.map(ref => ref.artifactId));
  const merged = new Map();
  for (const ref of old.filter(ref => !replaced.has(ref.artifactId))) merged.set(refKey(ref), ref);
  for (const ref of fresh) merged.set(refKey(ref), ref);
  return [...merged.values()].slice(-LIMITS.refs);
}
function validNodeJudgment(node, ids) {
  if (!exactKeys(node, ['candidateId', 'role', 'supportProbability', 'roleProbability', 'roleConfidence', 'roleProbabilities', 'classification']) ||
      !ids.has(node.candidateId) || ![...ROLES, 'unknown'].includes(node.role) ||
      !probability(node.supportProbability) || !probability(node.roleProbability) || !probability(node.roleConfidence) ||
      !['accepted', 'tentative'].includes(node.classification) || !plain(node.roleProbabilities)) return false;
  const entries = Object.entries(node.roleProbabilities);
  return entries.length > 0 && entries.length <= ROLES.length + 1 && entries.every(([role, p]) => [...ROLES, 'unknown'].includes(role) && probability(p)) &&
    Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) <= 0.0100000001 &&
    node.roleProbabilities[node.role] === node.roleProbability &&
    entries.every(([, p]) => p <= node.roleProbability + 1e-12);
}
function validEdgeJudgment(edge, bundle, ids) {
  if (!exactKeys(edge, ['proposalId', 'sourceCandidateId', 'targetCandidateId', 'relation', 'evidenceCandidateIds',
    'supportProbability', 'missingContextProbability', 'classification']) ||
      !ids.has(edge.sourceCandidateId) || !ids.has(edge.targetCandidateId) ||
      edge.sourceCandidateId === edge.targetCandidateId || !RELATIONS.includes(edge.relation) ||
      !Array.isArray(edge.evidenceCandidateIds) || edge.evidenceCandidateIds.length < 2 ||
      edge.evidenceCandidateIds.length > LIMITS.candidates ||
      new Set(edge.evidenceCandidateIds).size !== edge.evidenceCandidateIds.length ||
      !edge.evidenceCandidateIds.every(id => ids.has(id)) ||
      ![edge.sourceCandidateId, edge.targetCandidateId].every(id => edge.evidenceCandidateIds.includes(id)) ||
      !probability(edge.supportProbability) || !probability(edge.missingContextProbability) ||
      !['accepted', 'tentative'].includes(edge.classification)) return false;
  return edge.proposalId === proposalId(bundle, edge.sourceCandidateId, edge.targetCandidateId, edge.relation, edge.evidenceCandidateIds);
}

// Diagnostics contain only fixed outcomes and opaque IDs. Buffer them until
// the patch is complete so a callback cannot interfere with later admissions.
// The bound is 12 candidate outcomes + 7 proposal outcomes + one null summary.
function compilerAudit(onDiagnostic) {
  const outcomes = typeof onDiagnostic === 'function' ? [] : null;
  function record(status, reason, field, id) {
    if (!outcomes || outcomes.length >= LIMITS.candidates + LIMITS.proposals + 1) return;
    const prefix = field === 'candidateId' ? 'candidate-' : 'proposal-';
    outcomes.push({ ...(field && isId(id) && id.startsWith(prefix) ? { [field]: id } : {}), status, reason });
  }
  function dataValue(object, key) {
    // Rejecting malformed inputs must not invoke additional caller getters.
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
  }
  return {
    record,
    reject(decision, reason) {
      if (outcomes) for (const [key, field, limit] of [
        ['nodes', 'candidateId', LIMITS.candidates], ['edges', 'proposalId', LIMITS.proposals],
      ]) {
        const judgments = dataValue(decision, key);
        if (Array.isArray(judgments)) for (let i = 0; i < Math.min(judgments.length, limit); i++) {
          record('skipped', reason, field, dataValue(dataValue(judgments, i), field));
        }
      }
      record('skipped', reason);
      return null;
    },
    finish(patch, empty) {
      if (!patch && outcomes) {
        if (outcomes.some(outcome => ['added', 'updated'].includes(outcome.status))) {
          // makePatch refuses an exhausted revision even if upserts were built.
          for (const outcome of outcomes) if (['added', 'updated'].includes(outcome.status)) {
            outcome.status = 'skipped'; outcome.reason = 'revision_limit';
          }
          record('skipped', 'revision_limit');
        } else if (empty) record('skipped', 'empty_decision');
        else if (outcomes.some(outcome => outcome.status === 'unchanged')) record('unchanged', 'no_change');
        else record('skipped', 'no_drawable_change');
      }
      return patch;
    },
    flush() {
      for (const outcome of outcomes ?? []) {
        try {
          // Do not await observers; also contain rejected async callbacks.
          Promise.resolve(onDiagnostic(Object.freeze(outcome))).catch(() => {});
        } catch { /* Observability cannot change the compiler result. */ }
      }
    },
  };
}

export function compileDecision(graph, { event, decision, policy, onDiagnostic } = {}) {
  const audit = compilerAudit(onDiagnostic);
  try { return compileAuditedDecision(graph, { event, decision, policy }, audit); }
  finally { audit.flush(); }
}

function compileAuditedDecision(graph, { event, decision, policy }, audit) {
  try { assertGraph(graph); }
  catch (error) { audit.record('skipped', 'invalid_graph'); throw error; }
  policy = createPolicy(policy);
  if (!['accepted', 'abstained'].includes(decision?.status)) return audit.reject(decision, 'decision_not_compilable');
  if (!validBundle(decision.bundle, policy)) return audit.reject(decision, 'invalid_bundle');
  if (!plain(event) || ['tool.requested', 'capture.gap'].includes(event.kind)) return audit.reject(decision, 'invalid_event');
  event = metadataEvent(event);
  const bundle = decision.bundle, candidates = new Map(bundle.candidates.map(c => [c.id, c]));
  if (!Array.isArray(decision.nodes) || !Array.isArray(decision.edges)) return audit.reject(decision, 'invalid_judgments');
  if (decision.nodes.length > LIMITS.candidates || decision.edges.length > LIMITS.proposals) return audit.reject(decision, 'judgment_limit');
  if (new Set(decision.nodes.map(n => n?.candidateId)).size !== decision.nodes.length ||
      new Set(decision.edges.map(e => e?.proposalId)).size !== decision.edges.length) return audit.reject(decision, 'duplicate_judgments');
  if (!decision.nodes.every(n => validNodeJudgment(n, candidates)) ||
      !decision.edges.every(e => validEdgeJudgment(e, bundle, candidates))) return audit.reject(decision, 'invalid_judgments');
  // The service supplies validated provider provenance. Older manual decisions
  // omit it and keep the legacy basis; answers/candidates cannot select a basis.
  const providerId = decision.provider?.id;
  const basis = providerId && providerId !== 'jev' ? 'decision_interpretation' : 'jev_interpretation';
  const existingNodes = new Map(graph.nodes.map(n => [n.id, n]));
  const existingEdges = new Map(graph.edges.map(e => [e.id, e]));
  const admitted = new Map(), operations = [];
  let projected = graph;
  function add(op) {
    const next = reduce(projected, [op]);
    next.revision = graph.revision + 1;
    if (next.nodes.length > LIMITS.nodes) return 'node_limit';
    if (next.edges.length > LIMITS.edges) return 'edge_limit';
    if (bytes(next) > LIMITS.admissionBytes) return 'graph_byte_limit';
    operations.push(op); projected = next; return null;
  }
  for (const judgment of decision.nodes) {
    const report = (status, reason) => audit.record(status, reason, 'candidateId', judgment.candidateId);
    if (judgment.role === 'unknown') { report('skipped', 'unknown_role'); continue; }
    if (judgment.supportProbability < EXPERIMENTAL_SUPPORT_FLOOR) { report('skipped', 'support_below_floor'); continue; }
    const candidate = candidates.get(judgment.candidateId);
    const id = opaque('node', event.projectId, event.sessionId, candidate.entityKey), old = existingNodes.get(id);
    // A stale record with the same version needs a newly captured generation.
    // A delayed answer cannot revive it merely because its bytes match again.
    if (old && approvalVersions.has(contentKey(old)) && old.sourceRefs.some(ref => ref.artifactId === candidate.artifactId &&
      (ref.generation > candidate.generation || (old.validity !== 'current' && ref.generation === candidate.generation)))) {
      report('skipped', 'stale_generation'); continue;
    }
    const classification = judgment.classification === 'accepted' && candidate.complete && !event.incomplete &&
      judgment.supportProbability >= 0.85 && judgment.roleProbability >= 0.8 && judgment.roleConfidence >= 0.6 ? 'accepted' : 'tentative';
    const index = projected.nodes.length;
    const refs = mergeReferences(old?.sourceRefs ?? [], [sourceReference(candidate, event, policy, basis)]);
    const node = {
      id, label: candidate.label, kind: judgment.role, shape: ROLE_SHAPES[judgment.role],
      x: old?.x ?? 80 + (index % 6) * 220, y: old?.y ?? 80 + Math.floor(index / 6) * 140,
      evidenceState: refs.some(ref => ref.sourceClass === 'public_intent') ? 'proposed' : 'observed',
      activityState: 'unknown', classification, validity: 'current', sourceRefs: refs, confidence: judgment.roleConfidence,
    };
    if (old && equal(old, node)) { admitted.set(candidate.id, old); report('unchanged', 'already_current'); continue; }
    const rejected = add({ op: 'node.upsert', node });
    if (rejected) report('skipped', rejected);
    else { approve(node, policy.version); admitted.set(candidate.id, node); report(old ? 'updated' : 'added', 'admitted'); }
  }
  for (const judgment of decision.edges) {
    const report = (status, reason) => audit.record(status, reason, 'proposalId', judgment.proposalId);
    if (judgment.supportProbability < EXPERIMENTAL_SUPPORT_FLOOR) { report('skipped', 'support_below_floor'); continue; }
    const source = admitted.get(judgment.sourceCandidateId), target = admitted.get(judgment.targetCandidateId);
    if (!source || !target || source.id === target.id) { report('skipped', 'endpoints_not_drawable'); continue; }
    const id = opaque('edge', source.id, target.id, judgment.relation), old = existingEdges.get(id);
    const evidence = judgment.evidenceCandidateIds.map(id => candidates.get(id));
    if (old && approvalVersions.has(contentKey(old)) && old.sourceRefs.some(ref => evidence.some(c => ref.artifactId === c.artifactId &&
      (ref.generation > c.generation || (old.validity !== 'current' && ref.generation === c.generation))))) {
      report('skipped', 'stale_generation'); continue;
    }
    const refs = mergeReferences([], evidence.map(c => sourceReference(c, event, policy, basis)));
    // Every relation retains all dependencies; never silently drop evidence
    // when the reference budget is exceeded.
    if (refs.length !== new Set(evidence.map(c => refKey(sourceReference(c, event, policy, basis)))).size) {
      report('skipped', 'reference_limit'); continue;
    }
    const classification = judgment.classification === 'accepted' && source.classification === 'accepted' &&
      target.classification === 'accepted' && evidence.every(c => c.complete) && !event.incomplete &&
      judgment.supportProbability >= 0.85 && judgment.missingContextProbability <= 0.1 ? 'accepted' : 'tentative';
    const edge = {
      id, source: source.id, target: target.id, relation: judgment.relation, label: judgment.relation,
      evidenceState: refs.some(ref => ref.sourceClass === 'public_intent') ? 'proposed' : 'observed',
      classification, validity: 'current', sourceRefs: refs,
    };
    if (old && equal(old, edge)) { report('unchanged', 'already_current'); continue; }
    const rejected = add({ op: 'edge.upsert', edge });
    if (rejected) report('skipped', rejected);
    else { approve(edge, policy.version); report(old ? 'updated' : 'added', 'admitted'); }
  }
  return audit.finish(makePatch(graph, operations, [event.id]), !decision.nodes.length && !decision.edges.length);
}

export function invalidateArtifacts(graph, artifacts = []) {
  assertGraph(graph);
  if (!Array.isArray(artifacts)) return null;
  const observations = new Map();
  for (const artifact of artifacts.slice(0, LIMITS.trackedPaths)) {
    if (!plain(artifact) || !isId(artifact.id) || !integer(artifact.generation, 1) ||
        !['present', 'missing', 'unavailable', 'partial'].includes(artifact.status)) continue;
    const previous = observations.get(artifact.id);
    if (!previous || artifact.generation > previous.generation) observations.set(artifact.id, artifact);
  }
  const operations = [];
  for (const [kind, items] of [['node', graph.nodes], ['edge', graph.edges]]) for (const item of items) {
    let changed = false;
    const refs = item.sourceRefs.filter(ref => {
      if (ref.sourceClass !== 'source') return true;
      const artifact = observations.get(ref.artifactId);
      if (!artifact || artifact.generation < ref.generation) return true;
      if (artifact.status === 'missing' && artifact.exists === false) { changed = true; return false; }
      if (artifact.status !== 'present' || artifact.hash !== ref.hash || artifact.generation !== ref.generation) changed = true;
      return true;
    });
    if (!changed) continue;
    if (!refs.length) { operations.push({ op: `${kind}.remove`, id: item.id }); continue; }
    const updated = {
      ...clone(item), sourceRefs: clone(refs), classification: 'stale', validity: 'stale',
      evidenceState: refs.some(ref => ref.sourceClass === 'public_intent') ? 'proposed' : 'observed',
      ...(kind === 'node' ? { activityState: 'unknown' } : {}),
    };
    if (!equal(item, updated)) {
      preserveApproval(item, updated);
      operations.push({ op: `${kind}.upsert`, [kind]: updated });
    }
  }
  // Node removal cascades. Do not reinsert an incident edge later in the patch.
  const removed = new Set(operations.filter(op => op.op === 'node.remove').map(op => op.id));
  let effective = operations.filter(op => op.op !== 'edge.upsert' || !removed.has(op.edge.source) && !removed.has(op.edge.target));
  const next = reduce(graph, effective);
  if (bytes(next) > LIMITS.graphBytes) {
    // Maintenance gets reserved headroom; even a graph restored at the hard
    // limit can shed optional excerpts instead of blocking invalidation.
    const byOperation = new Map(effective.map(op => [`${op.op.split('.')[0]}:${op.id ?? op.node?.id ?? op.edge?.id}`, op]));
    for (const [kind, items] of [['node', next.nodes], ['edge', next.edges]]) for (const item of items) {
      const compact = { ...item, sourceRefs: item.sourceRefs.map(({ excerpt, ...ref }) => ref) };
      if (!equal(item, compact)) {
        preserveApproval(item, compact);
        byOperation.set(`${kind}:${item.id}`, { op: `${kind}.upsert`, [kind]: compact });
      }
    }
    effective = [...byOperation.values()];
  }
  return makePatch(graph, effective);
}

export function projectGraph(graph, policy, { persistent = false } = {}) {
  assertGraph(graph);
  policy = createPolicy(policy);
  const permitted = policy.transmitSource && (persistent ? policy.persistEvidence : policy.displayEvidence);
  function project(item, node) {
    const approved = permitted && approvalVersions.get(contentKey(item)) === policy.version;
    const result = clone(item);
    if (node && !approved) result.label = ROLE_LABELS[item.kind];
    result.sourceRefs = result.sourceRefs.map(ref => {
      if (!approved) delete ref.excerpt;
      return ref;
    });
    if (approved) approve(result, policy.version);
    return result;
  }
  return {
    schemaVersion: 1, revision: graph.revision,
    nodes: graph.nodes.map(item => project(item, true)), edges: graph.edges.map(item => project(item, false)),
  };
}
