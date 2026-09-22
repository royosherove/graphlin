import { isDeepStrictEqual } from 'node:util';
import { LIMITS, hash, isHash, isId, integer, opaque } from '../core/common.mjs';
import { createPolicy, metadataEvent, safeLabel, safeText } from '../core/privacy.mjs';
import { buildModuleCandidates } from '../core/candidates.mjs';
import { id, references, relativePath } from '../model/records.mjs';
import { sourceLanguage } from '../discovery/structure.mjs';
import { ARCHITECTURE_NAMESPACE } from './profile.mjs';

export const ARCHITECTURE_LIMITS = Object.freeze({
  artifacts: 6, candidatesPerArtifact: LIMITS.candidates, membershipChecks: 6,
  sourceRefs: 16, guardRefs: 128, sourceBytes: 512 * 1024,
});
export const requireValue = value => { if (!value) throw new Error('architecture_input_invalid'); };
export const lineageOf = model => model.coverage?.lineage?.id ?? model.projectId;
export const recordId = (projectId, ...parts) => opaque('architecture', projectId, ...parts);

export function indexModel(model, policy) {
  requireValue(model?.schemaVersion === 2 && id(model.projectId) && integer(model.revision)
    && !model.replay && model.checkpointId === undefined && id(lineageOf(model))
    && Array.isArray(model.entities) && model.entities.length <= 20_000
    && Array.isArray(model.relations) && model.relations.length <= 40_000
    && Array.isArray(model.interpretations) && model.interpretations.length <= 512
    && Array.isArray(model.coverage?.artifacts) && model.coverage.artifacts.length <= 10_000);
  const entities = new Map(), artifacts = new Map(), byArtifact = new Map();
  for (const artifact of model.coverage.artifacts) {
    requireValue(id(artifact?.id) && !artifacts.has(artifact.id));
    artifacts.set(artifact.id, artifact);
  }
  function currentRefs(value, max = ARCHITECTURE_LIMITS.sourceRefs) {
    const refs = references(value, max);
    if (!refs?.length || !isDeepStrictEqual(refs, value)) return null;
    return refs.every(ref => {
      const artifact = artifacts.get(ref.artifactId);
      return ref.sourceClass !== 'public_intent' && artifact?.status === 'present'
        && artifact.fresh === true && artifact.hash === ref.hash && artifact.generation === ref.generation
        && relativePath(artifact.relativePath, policy);
    }) ? refs : null;
  }
  for (const entity of model.entities) {
    requireValue(id(entity?.id) && !entities.has(entity.id));
    entities.set(entity.id, entity);
    if (!byArtifact.has(entity.artifactId)) byArtifact.set(entity.artifactId, []);
    if (entity.basis === 'parsed' && entity.validity === 'current' && entity.classification === 'accepted'
      && safeLabel(entity.label) && currentRefs(entity.sourceRefs)) byArtifact.get(entity.artifactId).push(entity);
  }
  const relations = model.relations.filter(value => value?.validity === 'current'
    && value.basis === 'parsed' && entities.has(value.source) && entities.has(value.target)
    && ['contains', 'imports', 'calls', 'depends_on'].includes(value.kind) && currentRefs(value.sourceRefs));
  const capabilities = new Map((model.coverage.enumerations ?? []).slice(0, 10_000).flatMap(value => {
    const artifact = artifacts.get(value.artifactId);
    return artifact?.hash === value.hash && artifact?.generation === value.generation
      ? [[value.artifactId, value.capability]] : [];
  }));
  return { entities, artifacts, byArtifact, relations, currentRefs, capabilities };
}

export function moduleForArtifact(index, artifactId) {
  const modules = (index.byArtifact.get(artifactId) ?? []).filter(entity => ['module', 'file'].includes(entity.kind));
  return modules.length === 1 ? modules[0] : null;
}

export function requestedArtifacts(model, index, captures, affectedArtifactIds) {
  const supplied = captures.map(value => value?.id);
  requireValue(supplied.every(isId) && new Set(supplied).size === supplied.length);
  if (affectedArtifactIds === undefined) return supplied;
  requireValue(Array.isArray(affectedArtifactIds) && affectedArtifactIds.length <= 128
    && affectedArtifactIds.every(isId) && new Set(affectedArtifactIds).size === affectedArtifactIds.length);
  const seeds = new Set(affectedArtifactIds), requested = new Set(seeds);
  // One-hop dependencies nominate source for reconsideration, never membership.
  for (const relation of index.relations) {
    const source = index.entities.get(relation.source).artifactId;
    const target = index.entities.get(relation.target).artifactId;
    if (seeds.has(source) && isId(target)) requested.add(target);
    if (seeds.has(target) && isId(source)) requested.add(source);
  }
  // Existing groups can depend on a changed file even if an import disappeared.
  for (const value of model.interpretations) {
    if (value.namespace !== ARCHITECTURE_NAMESPACE || !Array.isArray(value.sourceRefs)
      || value.sourceRefs.length > ARCHITECTURE_LIMITS.sourceRefs
      || !value.sourceRefs.some(ref => seeds.has(ref.artifactId))) continue;
    for (const ref of value.sourceRefs) if (isId(ref.artifactId)) requested.add(ref.artifactId);
  }
  return [...seeds, ...[...requested].filter(value => !seeds.has(value)).sort()];
}

export function candidatesForCapture(capture, index, event, policy) {
  const current = index.artifacts.get(capture.id);
  const anchor = moduleForArtifact(index, capture.id);
  if (!anchor || !current || current.status !== 'present' || current.fresh !== true
    || capture.status !== 'present' || capture.exists !== true || capture.complete !== true
    || !isHash(capture.hash) || !integer(capture.generation, 1)
    || current.hash !== capture.hash || current.generation !== capture.generation
    || !relativePath(capture.relativePath, policy) || current.relativePath !== capture.relativePath
    || typeof capture.text !== 'string' || Buffer.byteLength(capture.text) > LIMITS.fileBytes
    || !safeText(capture.text, LIMITS.fileBytes) || hash(capture.text) !== capture.hash) return null;
  const { candidates, omitted } = buildModuleCandidates({ event, artifact: capture, policy });
  return { anchor, candidates, omitted,
    sourceRef: { artifactId: capture.id, hash: capture.hash, generation: capture.generation } };
}
export function unsupportedCapture(capture, index, policy) {
  return index.capabilities.get(capture.id) === 'unsupported'
    || Boolean(relativePath(capture.relativePath, policy) && !sourceLanguage(capture.relativePath));
}
export function unionRefs(...groups) {
  const refs = new Map(groups.flat().map(ref => [JSON.stringify(ref), structuredClone(ref)]));
  return refs.size <= ARCHITECTURE_LIMITS.guardRefs ? [...refs.values()] : null;
}
export function analysisEvent(model) {
  return metadataEvent({
    projectId: model.projectId, id: opaque('event', ARCHITECTURE_NAMESPACE, model.projectId, model.revision, lineageOf(model)),
    kind: 'artifact.changed', toolCategory: 'read', outcome: 'observed', incomplete: false,
  });
}
export function unchanged(model, basis, policy, signal) {
  return !signal?.aborted && model.revision === basis.revision && model.projectId === basis.projectId
    && lineageOf(model) === basis.lineageId && createPolicy(policy).version === basis.policyVersion;
}
