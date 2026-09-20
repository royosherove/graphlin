import { isDeepStrictEqual } from 'node:util';
import { freeze, hash, integer } from '../core/common.mjs';
import { createPolicy } from '../core/privacy.mjs';
import { validBundle } from '../core/candidates.mjs';
import { buildProfileQuestions } from '../decisions/profiles.mjs';
import { validateResult, isProbability } from '../decisions/contracts.mjs';
import { buildEvaluation } from '../decisions/evaluation.mjs';
import { withAbort } from '../decisions/faults.mjs';
import { DEFAULT_ADMISSION_POLICY as thresholds } from '../decisions/index.mjs';
import {
  ARCHITECTURE_NAMESPACE, ARCHITECTURE_VERSION, ARCHITECTURE_PROFILES, ROLE_PROFILE_ID, MEMBERSHIP_PROFILE_ID,
} from './profile.mjs';
import {
  ARCHITECTURE_LIMITS as L, requireValue, indexModel, moduleForArtifact, requestedArtifacts,
  candidatesForCapture, unionRefs, analysisEvent, unchanged, lineageOf, recordId,
} from './evidence.mjs';

export { ARCHITECTURE_PROFILES, ARCHITECTURE_NAMESPACE, ARCHITECTURE_VERSION } from './profile.mjs';
export { ARCHITECTURE_LIMITS } from './evidence.mjs';
const capabilities = { boolean: { probability: true }, choice: { probabilities: true, confidence: true } };
const knownKind = value => ['application', 'component'].includes(value);
const currentPolicy = policy => createPolicy(typeof policy === 'function' ? policy() : policy);
const versionRef = artifact => ({ artifactId: artifact.id, hash: artifact.hash, generation: artifact.generation });
const supported = answer => isProbability(answer?.probability) && answer.probability >= thresholds.nodeSupportMin;
const sufficient = answer => isProbability(answer?.probability) && answer.probability <= thresholds.missingContextMax;

function roleAnswer(result, selection, event, policy) {
  if (!validBundle(result?.bundle, policy) || result.bundle.candidates.some(candidate =>
    !selection.candidates.some(input => isDeepStrictEqual(input, candidate)))) return undefined;
  if (!result.bundle.candidates.length && result.diagnostics?.code === 'no_approved_candidates') return null;
  const analysis = result.analysis;
  if (analysis?.profileId !== ROLE_PROFILE_ID || analysis.profileVersion !== ARCHITECTURE_VERSION
    || analysis.status !== 'answered' || !result.bundle.candidates.length) return undefined;
  const { request, subjects } = buildProfileQuestions(ARCHITECTURE_PROFILES[0], event, result.bundle);
  if (!isDeepStrictEqual(analysis.subjects, subjects)) return undefined;
  const answers = validateResult({ answers: analysis.answers }, request, capabilities).answers;
  const role = answers.kind;
  return knownKind(role.choice) && isProbability(role.probabilities?.[role.choice])
    && role.probabilities[role.choice] >= thresholds.roleProbabilityMin
    && isProbability(role.confidence) && role.confidence >= thresholds.roleConfidenceMin
    && supported(answers.supported) && sufficient(answers.missing_context) ? role.choice : null;
}

function boundary(projectId, anchor, kind, ref) {
  return {
    id: recordId(projectId, 'boundary', anchor.id), namespace: ARCHITECTURE_NAMESPACE,
    kind, label: anchor.label, entityIds: [anchor.id], sourceRefs: [ref],
    basis: 'decision', validity: 'current', support: 'supported', classification: 'accepted',
    version: ARCHITECTURE_VERSION,
  };
}

function priorRoles(model, index) {
  const roles = new Map(), conflicting = new Set();
  for (const record of model.interpretations) {
    if (record.namespace !== ARCHITECTURE_NAMESPACE || record.version !== ARCHITECTURE_VERSION
      || !knownKind(record.kind) || record.validity !== 'current'
      || record.support !== 'supported' || record.classification !== 'accepted'
      || record.entityIds?.length !== 1 || !index.currentRefs(record.sourceRefs)) continue;
    const entity = index.entities.get(record.entityIds[0]);
    const anchor = moduleForArtifact(index, entity?.artifactId);
    if (!anchor || entity.id !== anchor.id
      || record.sourceRefs.some(ref => ref.artifactId !== anchor.artifactId)) continue;
    if (roles.has(anchor.id)) conflicting.add(anchor.id);
    roles.set(anchor.id, { anchor, kind: record.kind, ref: versionRef(index.artifacts.get(anchor.artifactId)) });
  }
  for (const id of conflicting) roles.delete(id);
  return roles;
}

function membershipPairs(index, roles, processed) {
  const pairs = new Map();
  for (const relation of index.relations) {
    if (relation.kind === 'contains') continue;
    const parent = moduleForArtifact(index, index.entities.get(relation.source).artifactId);
    const child = moduleForArtifact(index, index.entities.get(relation.target).artifactId);
    if (!parent || !child || parent.id === child.id || roles.get(parent.id)?.kind !== 'application'
      || roles.get(child.id)?.kind !== 'component'
      || ![parent.artifactId, child.artifactId].some(id => processed.has(id))
      || relation.sourceRefs.some(ref => ![parent.artifactId, child.artifactId].includes(ref.artifactId))
      || ![parent.artifactId, child.artifactId].every(id => relation.sourceRefs.some(ref => ref.artifactId === id))) continue;
    const key = `${parent.id}:${child.id}`;
    // Both canonical parsed anchors belong to this single-project index, and
    // the resolved parsed relation carries current versions of both artifacts.
    if (!pairs.has(key)) pairs.set(key, {
      parent: roles.get(parent.id), child: roles.get(child.id), kinds: new Set(),
      sameProject: index.entities.has(parent.id) && index.entities.has(child.id),
      resolvedLocalDependency: [parent.artifactId, child.artifactId].every(id => index.artifacts.has(id)),
      currentSourceVersions: Boolean(index.currentRefs(relation.sourceRefs)),
    });
    pairs.get(key).kinds.add(relation.kind);
  }
  return [...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

function priorMembership(model, index, pair) {
  return model.interpretations.find(value => value.namespace === ARCHITECTURE_NAMESPACE
    && value.version === ARCHITECTURE_VERSION && value.kind === 'architecture_membership'
    && value.validity === 'current'
    && (value.support === 'supported' && value.classification === 'accepted'
      || value.support === 'unknown' && value.classification === 'unknown')
    && isDeepStrictEqual(value.entityIds, [pair.parent.anchor.id, pair.child.anchor.id])
    && index.currentRefs(value.sourceRefs)
    && value.sourceRefs.length === 2 && value.sourceRefs.every(ref =>
      [pair.parent.ref, pair.child.ref].some(expected => isDeepStrictEqual(ref, expected))));
}

function membership(projectId, pair, accepted) {
  return {
    id: recordId(projectId, 'membership', pair.parent.anchor.id, pair.child.anchor.id),
    namespace: ARCHITECTURE_NAMESPACE, kind: 'architecture_membership',
    label: accepted ? 'Application component' : 'Membership unknown',
    entityIds: [pair.parent.anchor.id, pair.child.anchor.id], sourceRefs: [pair.parent.ref, pair.child.ref],
    basis: 'decision', validity: 'current',
    support: accepted ? 'supported' : 'unknown', classification: accepted ? 'accepted' : 'unknown',
    version: ARCHITECTURE_VERSION,
  };
}

function membershipEvaluation(pairs, basis) {
  const roles = new Map();
  for (const pair of pairs) for (const role of [pair.parent, pair.child]) {
    roles.set(role.anchor.id, {
      id: role.anchor.id, kind: role.kind, label: role.anchor.label, support: 'supported', classification: 'accepted',
      basis: 'decision', anchorBasis: role.anchor.basis, validity: role.anchor.validity,
    });
  }
  const state = {
    context: {
      basis: 'current_source_backed_roles_and_parsed_dependencies',
      membership: 'A source composition link means an accepted application source module directly declares a parsed '
        + 'import, call or depends_on dependency on an accepted component source module. This records a static source '
        + 'dependency between the roles, not exclusive ownership, active usage, deployment or runtime hosting.',
      instruction: 'Roles were accepted from current source through privacy intake. Dependencies are parsed facts. '
        + 'sameProject, resolvedLocalDependency and currentSourceVersions are core-verified from canonical parsed '
        + 'anchors and exact current references for both endpoints, not inferred from their labels. '
        + 'Assess only the proposed finite pairs. Do not infer membership from folders or names, invent entities, '
        + 'or assert exclusive ownership, runtime deployment or successful execution.',
    },
    boundaries: [...roles.values()],
    proposals: pairs.map(pair => ({
      parentId: pair.parent.anchor.id, childId: pair.child.anchor.id, relationKinds: [...pair.kinds].sort(),
      sameProject: pair.sameProject, resolvedLocalDependency: pair.resolvedLocalDependency,
      currentSourceVersions: pair.currentSourceVersions,
    })),
  };
  const questions = pairs.flatMap((_pair, i) => [
    {
      id: `member_${i}`, kind: 'boolean', requiredMetrics: ['probability'],
      question: `Do the accepted roles in \`boundaries\` and directed parsed dependency in \`proposals[${i}]\` `
        + 'establish this exact source composition link as defined by `context.membership`?',
      focus: 'Both endpoints must have accepted, supported application/component roles. A direct parsed import, call '
        + 'or depends_on relation between these endpoints suffices for the declared source dependency. A folder/name '
        + 'match, co-occurrence, unknown role or unrelated dependency does not. Imported implementation, proof of active '
        + 'use, exclusive ownership, upstream callers and runtime hosting are outside this static claim.',
    },
    {
      id: `missing_${i}`, kind: 'boolean', requiredMetrics: ['probability'],
      question: `Is an accepted endpoint role or the exact directed parsed dependency missing from \`proposals[${i}]\` `
        + 'and `boundaries`, preventing determination of the source composition link defined by `context.membership`?',
      focus: 'The role analysis already inspected approved source. Both accepted roles and an exact parsed import, call '
        + 'or depends_on relation are sufficient here. Do not require source bodies again, proof the import is actively '
        + 'used, imported dependency internals, callers, runtime observations, deployment facts or optional documents.',
    },
  ]);
  return {
    state, questions, profile: { id: MEMBERSHIP_PROFILE_ID, version: ARCHITECTURE_VERSION },
    cacheContext: {
      projectId: basis.projectId, worktreeId: basis.projectId, lineage: basis.lineageId,
      policyVersion: basis.policyVersion,
      evidenceVersion: hash([basis.revision, pairs.map(pair => [pair.parent.ref, pair.child.ref])]),
      taskScope: ARCHITECTURE_NAMESPACE,
    },
  };
}

function membershipAnswers(result, evaluation) {
  requireValue(result?.status === 'accepted' && Array.isArray(result.answers)
    && result.answers.length === evaluation.questions.length);
  const answers = {};
  for (const answer of result.answers) {
    requireValue(answer.kind === 'boolean' && evaluation.questions.some(q => q.id === answer.id)
      && !Object.hasOwn(answers, answer.id));
    answers[answer.id] = { type: 'boolean', value: answer.value, probability: answer.probability };
  }
  const { request } = buildEvaluation(evaluation, { maxQuestionsPerStage: 40, maxRequestBytes: 64 * 1024 });
  return validateResult({ answers }, request, capabilities).answers;
}

/**
 * One bounded, stateless analysis job over authorized captures and a model
 * snapshot. The controller owns capture, scheduling, freshness revalidation and
 * replaceInterpretations(namespace, interpretations, { affectedEntityIds, sourceRefs }).
 * Explicit empty scope means no replacement. Missing captures also return
 * coverage.withdrawnEntityIds for a separate, controller-version-guarded clear;
 * present-source guards cannot authorize absence. No source text is returned.
 */
export async function analyzeArchitecture({ model, artifacts = [], service, policy, signal, affectedArtifactIds } = {}) {
  const coverage = {
    requestedArtifactIds: [], analyzedArtifactIds: [], deferredArtifactIds: [], unavailableArtifactIds: [],
    missingArtifactIds: [], withdrawnEntityIds: [], deferredMembershipArtifactIds: [],
    unknownArtifactIds: [], omittedCandidates: 0, membershipProposals: 0, membershipChecks: 0,
    deferredMemberships: 0, supportedBoundaries: 0, supportedMemberships: 0, unknownMemberships: 0, complete: false,
  };
  const diagnostics = { code: 'architecture_unavailable', profileCalls: 0, evaluationCalls: 0, providerRequests: 0 };
  const empty = status => ({ status, interpretations: [], sourceRefs: [], affectedEntityIds: [], coverage, diagnostics });
  try {
    const consent = currentPolicy(policy);
    requireValue(consent.transmitSource && typeof service?.analyze === 'function'
      && Array.isArray(artifacts) && artifacts.length <= 64);
    const index = indexModel(model, consent);
    const basis = { projectId: model.projectId, revision: model.revision,
      lineageId: lineageOf(model), policyVersion: consent.version };
    Object.assign(diagnostics, basis);
    const check = () => requireValue(unchanged(model, basis, currentPolicy(policy), signal));
    const wait = operation => signal ? withAbort(operation, signal) : operation();
    const countRequests = result => {
      if (integer(result?.diagnostics?.calls, 0, 2)) diagnostics.providerRequests += result.diagnostics.calls;
    };
    check();
    const roles = priorRoles(model, index);
    const priorArtifacts = new Set([...roles.values()].map(role => role.anchor.artifactId));
    const seeds = new Set(affectedArtifactIds ?? []);
    const requested = requestedArtifacts(model, index, artifacts, affectedArtifactIds)
      .filter(id => affectedArtifactIds === undefined || seeds.has(id) || !priorArtifacts.has(id));
    coverage.requestedArtifactIds = requested;
    const captures = new Map(artifacts.map(capture => [capture.id, capture]));
    const interpretations = [], affected = [], guards = new Map(), processed = new Set(), missing = new Map();
    let sourceBytes = 0, partial = false;
    const event = analysisEvent(model);
    for (const artifactId of requested) {
      check();
      const capture = captures.get(artifactId);
      if (!capture || coverage.analyzedArtifactIds.length + coverage.unavailableArtifactIds.length
        + coverage.missingArtifactIds.length >= L.artifacts) {
        coverage.deferredArtifactIds.push(artifactId); partial = true; continue;
      }
      const observation = index.artifacts.get(artifactId);
      if (capture.status === 'missing' && capture.exists === false && capture.complete === true
        && capture.hash === null && integer(capture.generation, 1)
        && observation?.status === 'missing' && observation.complete === true && observation.hash === null
        && observation.generation === capture.generation) {
        const ids = new Set(model.interpretations.filter(value => value.namespace === ARCHITECTURE_NAMESPACE)
          .flatMap(value => Array.isArray(value.entityIds) && value.entityIds.length <= 2 ? value.entityIds : [])
          .filter(id => index.entities.get(id)?.artifactId === artifactId));
        affected.push(...ids); coverage.withdrawnEntityIds.push(...ids);
        coverage.missingArtifactIds.push(artifactId); missing.set(artifactId, capture.generation);
        for (const id of ids) roles.delete(id);
        continue;
      }
      const size = typeof capture.text === 'string' ? Buffer.byteLength(capture.text) : 0;
      const selected = candidatesForCapture(capture, index, event, consent);
      if (!selected) {
        coverage.unavailableArtifactIds.push(artifactId); partial = true; continue;
      }
      if (sourceBytes + size > L.sourceBytes) {
        coverage.deferredArtifactIds.push(artifactId); partial = true; continue;
      }
      sourceBytes += size;
      coverage.omittedCandidates += selected.omitted;
      if (selected.omitted) partial = true;
      let kind = null;
      if (selected.candidates.length) {
        try {
          diagnostics.profileCalls++;
          const result = await wait(() => service.analyze({
            event, candidates: selected.candidates, profileId: ROLE_PROFILE_ID, policy: consent,
            ...(signal ? { signal } : {}),
          }));
          check(); countRequests(result);
          kind = roleAnswer(result, selected, event, consent);
        } catch {
          check(); kind = undefined;
        }
      }
      if (kind === undefined) {
        coverage.unavailableArtifactIds.push(artifactId); partial = true; continue;
      }
      coverage.analyzedArtifactIds.push(artifactId);
      processed.add(artifactId); affected.push(selected.anchor.id); guards.set(artifactId, selected.sourceRef);
      roles.delete(selected.anchor.id);
      if (kind) {
        roles.set(selected.anchor.id, { anchor: selected.anchor, kind, ref: selected.sourceRef });
        interpretations.push(boundary(model.projectId, selected.anchor, kind, selected.sourceRef));
      } else coverage.unknownArtifactIds.push(artifactId);
    }
    coverage.supportedBoundaries = interpretations.length;
    const proposed = membershipPairs(index, roles, processed);
    coverage.membershipProposals = proposed.length;
    const pending = [];
    for (const pair of proposed) {
      const previous = priorMembership(model, index, pair);
      if (!previous) { pending.push(pair); continue; }
      interpretations.push(structuredClone(previous));
      for (const role of [pair.parent, pair.child]) guards.set(role.ref.artifactId, role.ref);
      coverage[previous.support === 'supported' ? 'supportedMemberships' : 'unknownMemberships']++;
    }
    const pairs = pending.slice(0, L.membershipChecks);
    coverage.deferredMemberships = pending.length - pairs.length;
    coverage.deferredMembershipArtifactIds = [...new Set(pending.slice(L.membershipChecks).map(pair => pair.child.ref.artifactId))];
    if (coverage.deferredMemberships) partial = true;
    if (pairs.length) {
      for (const pair of pairs) for (const role of [pair.parent, pair.child]) guards.set(role.ref.artifactId, role.ref);
      let answers;
      try {
        check(); requireValue(typeof service.evaluate === 'function');
        const evaluation = membershipEvaluation(pairs, basis);
        diagnostics.evaluationCalls++;
        const result = await wait(() => service.evaluate({ ...evaluation, ...(signal ? { signal } : {}) }));
        check(); countRequests(result);
        answers = membershipAnswers(result, evaluation);
        coverage.membershipChecks = pairs.length;
      } catch { check(); partial = true; }
      // Only validated answers establish a versioned observation. A transient
      // failure leaves no pair record, so a later Discover can retry it.
      if (answers) pairs.forEach((pair, i) => {
        const accepted = supported(answers[`member_${i}`]) && sufficient(answers[`missing_${i}`]);
        interpretations.push(membership(model.projectId, pair, accepted));
        coverage[accepted ? 'supportedMemberships' : 'unknownMemberships']++;
      });
    }
    check();
    const sourceRefs = unionRefs([...guards.values()]);
    const fresh = indexModel(model, consent);
    requireValue(sourceRefs && (!sourceRefs.length || fresh.currentRefs(sourceRefs, L.guardRefs))
      && [...missing].every(([id, generation]) => fresh.artifacts.get(id)?.status === 'missing'
        && fresh.artifacts.get(id)?.complete === true
        && fresh.artifacts.get(id)?.generation === generation && fresh.artifacts.get(id)?.hash === null)
      && affected.every(id => fresh.entities.get(id)?.validity === 'current' || coverage.withdrawnEntityIds.includes(id))
      && interpretations.every(value => value.entityIds.every(id => fresh.entities.get(id)?.validity === 'current')));
    coverage.complete = !partial;
    diagnostics.code = partial ? 'architecture_partial'
      : interpretations.length ? 'architecture_complete' : 'architecture_unknown';
    return freeze({
      status: partial ? (affected.length ? 'partial' : 'unavailable') : 'complete',
      interpretations, sourceRefs, affectedEntityIds: affected, coverage, diagnostics,
    });
  } catch {
    diagnostics.code = signal?.aborted ? 'architecture_cancelled' : 'architecture_unavailable';
    coverage.deferredArtifactIds = [];
    coverage.deferredMembershipArtifactIds = [];
    return freeze(empty(signal?.aborted ? 'cancelled' : 'unavailable'));
  }
}
