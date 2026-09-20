import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildIntakeQuestions, buildGraphQuestions, RUBRICS, RELATIONS, ACTIVITIES, ROLES } from './questions.mjs';
import { DecisionFault, withAbort, abortFault } from './faults.mjs';
import { isRecord, isProbability, normalizeProvider, validateResult, capabilityLimitations, requireMetrics } from './contracts.mjs';
import { normalizeProfiles, buildProfileQuestions } from './profiles.mjs';
import { createEvaluationAPI, evaluationAnswers } from './evaluation.mjs';

export { CONTRACT_VERSION, validateQuestions, validateResult, requireCapabilities, capabilityLimitations } from './contracts.mjs';
export { DecisionFault } from './faults.mjs';
export { DEFAULT_CACHE_LIMITS } from './evaluation.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  concurrency: 2,
  maxQueue: 32,
  eventDeadlineMs: 2000,
  maxRequestsPerEvent: 2,
  maxCandidates: 12,
  maxQuestionsPerStage: 40,
  maxRelationProposals: 12,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  maxCandidateBytes: 8192,
  maxLabelBytes: 256,
  cooldownMs: 1000,
  maxCooldownMs: 30_000,
});
export const DEFAULT_INTAKE_POLICY = Object.freeze({
  version: 'intake-policy-v1', sensitiveMax: 0.1, relevantMin: 0.5,
});
export const DEFAULT_ADMISSION_POLICY = Object.freeze({
  version: 'admission-policy-v1',
  relevanceMin: 0.3,
  nodeSupportMin: 0.85,
  roleProbabilityMin: 0.8,
  roleConfidenceMin: 0.6,
  edgeSupportMin: 0.85,
  missingContextMax: 0.1,
});

const kinds = new Set([
  'session.started', 'turn.prompted', 'intent.observed', 'tool.requested',
  'tool.succeeded', 'tool.failed', 'tool.interrupted', 'tool.denied',
  'tool.unresolved', 'batch.completed', 'artifact.changed',
  'verification.observed', 'agent.started', 'agent.stopped', 'turn.stopped',
  'session.ended', 'capture.gap',
]);
const categories = new Set(['read', 'write', 'edit', 'search', 'shell', 'test', 'other']);
const outcomes = new Set(['succeeded', 'failed', 'interrupted', 'denied', 'unresolved',
  'pending', 'running', 'observed', 'unknown']);
const boundedId = (value) => typeof value === 'string'
  && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const validVersion = (value) => boundedId(value)
  || (Number.isSafeInteger(value) && value >= 0);
const hash = (value) => createHash('sha256').update(value).digest('hex');

// Audit data is a separate allowlisted projection, never a copy of inputs or
// transport errors. Core's opaque IDs retain their identity; arbitrary IDs from
// injected adapters are hashed so labels/relative paths cannot become log text.
const auditId = (value, prefix = 'candidate') =>
  new RegExp(`^${prefix}-[a-f0-9]{32}$`).test(value)
    ? value : `${prefix}-${hash(value).slice(0, 32)}`;
const auditStatuses = new Set([
  'ok', 'accepted', 'irrelevant', 'abstained', 'invalid', 'unavailable', 'timeout', 'overloaded',
]);
const auditCodes = new Set([
  'ok', 'invalid_event', 'invalid_candidates', 'invalid_candidate', 'candidate_too_large',
  'invalid_bundle', 'invalid_proposals', 'invalid_proposal', 'duplicate_proposal',
  'core_unavailable', 'deadline_exceeded', 'request_budget', 'question_budget',
  'request_too_large', 'invalid_http_response', 'remote_cooldown', 'authentication_failed',
  'request_rejected', 'http_error', 'transport_failure', 'no_approved_candidates',
  'insufficient_relevance', 'no_accepted_classification', 'decision_failure',
  'service_closed', 'invalid_input', 'invalid_signal', 'metadata_only', 'missing_key',
  'cancelled', 'invalid_deadline', 'queue_full', 'invalid_policy', 'no_candidates',
  'inconsistent_evidence', 'invalid_probabilities', 'invalid_probability_sum',
  'invalid_response', 'invalid_answer_type', 'invalid_noul', 'invalid_confidence',
  'invalid_choice', 'invalid_score', 'invalid_question_type', 'invalid_response_body',
  'response_too_large', 'invalid_json', 'unknown_fixture_question',
  'invalid_provider_request', 'unsupported_capability', 'missing_answer_metrics',
  'invalid_boolean', 'provider_unavailable', 'stale_evidence',
  'unknown_profile', 'profile_answers',
  'invalid_state', 'source_state_requires_intake', 'invalid_profile', 'invalid_cache_context',
]);
const auditOutcome = (status, code) => ({
  status: auditStatuses.has(status) ? status : 'unavailable',
  code: auditCodes.has(code) ? code : 'decision_failure',
});
const auditDuration = (start, end) => Number.isFinite(end - start)
  ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, end - start)) : 0;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function safeEvent(event) {
  if (!isRecord(event)) throw new DecisionFault('invalid_event');
  return {
    kind: kinds.has(event.kind) ? event.kind : 'capture.gap',
    toolCategory: categories.has(event.toolCategory) ? event.toolCategory : 'other',
    outcome: outcomes.has(event.outcome) ? event.outcome : 'unknown',
    incomplete: event.incomplete !== false,
  };
}

function validateSourceRef(ref) {
  if (!isRecord(ref) || !boundedId(ref.hash)) return false;
  if (ref.type === 'artifact') {
    return boundedId(ref.artifactId)
      && Number.isSafeInteger(ref.generation) && ref.generation >= 0;
  }
  return ref.type === 'message' && boundedId(ref.messageId)
    && validVersion(ref.contentVersion);
}

function snapshotCandidates(input, limits) {
  if (!Array.isArray(input)) throw new DecisionFault('invalid_candidates');
  // Candidate overflow is coverage loss, not another request or unbounded cloning.
  const maximum = Math.min(limits.maxCandidates,
    Math.max(0, Math.floor((limits.maxQuestionsPerStage - 1) / 2)));
  const candidates = [];
  const ids = new Set();
  for (const candidate of input.slice(0, maximum)) {
    if (!isRecord(candidate) || !boundedId(candidate.id) || ids.has(candidate.id)
      || !boundedId(candidate.digest) || !boundedId(candidate.entityKey)
      || typeof candidate.label !== 'string'
      || Buffer.byteLength(candidate.label) > limits.maxLabelBytes
      || typeof candidate.text !== 'string'
      || Buffer.byteLength(candidate.text) > limits.maxCandidateBytes
      || !['source', 'public_intent'].includes(candidate.sourceClass)
      || typeof candidate.complete !== 'boolean'
      || !Number.isSafeInteger(candidate.startLine) || candidate.startLine < 1
      || !Number.isSafeInteger(candidate.endLine) || candidate.endLine < candidate.startLine
      || !validateSourceRef(candidate.sourceRef)
      || (candidate.sourceClass === 'source' && candidate.sourceRef.type !== 'artifact')
      || (candidate.sourceClass === 'public_intent' && candidate.sourceRef.type !== 'message')) {
      throw new DecisionFault('invalid_candidate');
    }
    // Bound local metadata too; it is retained for core, never sent on the wire.
    let encoded;
    try { encoded = JSON.stringify(candidate); } catch { throw new DecisionFault('invalid_candidate'); }
    if (Buffer.byteLength(encoded) > limits.maxCandidateBytes + limits.maxLabelBytes + 4096) {
      throw new DecisionFault('candidate_too_large');
    }
    candidates.push(freeze(JSON.parse(encoded)));
    ids.add(candidate.id);
  }
  return { candidates: freeze(candidates), omitted: input.length - candidates.length };
}

function normalizeLimits(options = {}) {
  if (!isRecord(options) || Object.keys(options).some((key) => !(key in DEFAULT_LIMITS))) {
    throw new DecisionFault('invalid_limits');
  }
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const [key, value] of Object.entries(limits)) {
    const minimum = ['maxQueue', 'maxRequestsPerEvent', 'maxRelationProposals'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > 16 * 1024 * 1024) {
      throw new DecisionFault('invalid_limits');
    }
  }
  if (limits.concurrency > 64 || limits.maxQueue > 4096 || limits.maxCandidates > 128
    || limits.maxQuestionsPerStage > 1024 || limits.eventDeadlineMs > 60_000
    || limits.maxCooldownMs > 300_000 || limits.cooldownMs > limits.maxCooldownMs) {
    throw new DecisionFault('invalid_limits');
  }
  return freeze(limits);
}

function normalizePolicy(input, defaults) {
  const result = { ...defaults, ...input };
  if (!validVersion(result.version)
    || Object.keys(defaults).some((key) => key !== 'version' && !isProbability(result[key]))) {
    throw new DecisionFault('invalid_thresholds');
  }
  return freeze(result);
}

function validateBundle(bundle, candidates, verdicts, policy, intakePolicy) {
  if (!isRecord(bundle) || !boundedId(bundle.id) || bundle.policyVersion !== policy.version
    || !Array.isArray(bundle.candidates) || !Array.isArray(bundle.readSet)
    || bundle.candidates.length > candidates.length || bundle.readSet.length > candidates.length) {
    throw new DecisionFault('invalid_bundle');
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const allowed = new Set(verdicts.filter((verdict) =>
    verdict.sensitive <= intakePolicy.sensitiveMax && verdict.relevant >= intakePolicy.relevantMin)
    .map((verdict) => verdict.candidateId));
  const seen = new Set();
  for (const candidate of bundle.candidates) {
    if (!isRecord(candidate) || seen.has(candidate.id) || !allowed.has(candidate.id)
      || !isDeepStrictEqual(candidate, byId.get(candidate.id))) {
      throw new DecisionFault('invalid_bundle');
    }
    seen.add(candidate.id);
  }
  const refMatches = (ref, candidate) => {
    const source = candidate.sourceRef;
    if (source.type === 'message') return isDeepStrictEqual(ref, source);
    return isDeepStrictEqual(ref, source) || isDeepStrictEqual(ref, {
      artifactId: source.artifactId, hash: source.hash, generation: source.generation,
    });
  };
  if (!bundle.readSet.every((ref) => bundle.candidates.some((candidate) => refMatches(ref, candidate)))
    || !bundle.candidates.every((candidate) => bundle.readSet.some((ref) => refMatches(ref, candidate)))) {
    throw new DecisionFault('invalid_bundle');
  }
  return freeze(bundle); // Preserve the exact core-owned bundle, including object identity.
}

function validateProposals(result, bundle, maximum) {
  if (!isRecord(result) || !Array.isArray(result.proposals)
    || !Number.isSafeInteger(result.omitted) || result.omitted < 0) {
    throw new DecisionFault('invalid_proposals');
  }
  const ids = new Set(bundle.candidates.map((candidate) => candidate.id));
  const seen = new Set();
  const propositions = new Set();
  const proposals = result.proposals.slice(0, maximum).map((proposal) => {
    if (!isRecord(proposal) || !boundedId(proposal.id) || seen.has(proposal.id)
      || !ids.has(proposal.sourceCandidateId) || !ids.has(proposal.targetCandidateId)
      || proposal.sourceCandidateId === proposal.targetCandidateId
      || !RELATIONS.includes(proposal.relation) || !Array.isArray(proposal.evidenceCandidateIds)
      || proposal.evidenceCandidateIds.length < 2 || proposal.evidenceCandidateIds.length > ids.size
      || ![proposal.sourceCandidateId, proposal.targetCandidateId]
        .every((id) => proposal.evidenceCandidateIds.includes(id))
      || new Set(proposal.evidenceCandidateIds).size !== proposal.evidenceCandidateIds.length
      || !proposal.evidenceCandidateIds.every((id) => ids.has(id))) {
      throw new DecisionFault('invalid_proposal');
    }
    const identity = JSON.stringify([proposal.sourceCandidateId, proposal.targetCandidateId,
      proposal.relation, proposal.evidenceCandidateIds]);
    if (propositions.has(identity)) throw new DecisionFault('duplicate_proposal');
    seen.add(proposal.id);
    propositions.add(identity);
    return freeze({
      id: proposal.id,
      sourceCandidateId: proposal.sourceCandidateId,
      targetCandidateId: proposal.targetCandidateId,
      relation: proposal.relation,
      evidenceCandidateIds: [...proposal.evidenceCandidateIds],
    });
  });
  return {
    proposals: freeze(proposals),
    omitted: result.omitted + result.proposals.length - proposals.length,
  };
}

/** Core-owned intake, scheduling and admission; providers supply answers only. */
export function createDecisionService(options = {}) {
  const provider = normalizeProvider(options.provider);
  const profiles = normalizeProfiles(options.profiles);
  const { model = null, mode } = provider;
  const limits = normalizeLimits(options.limits);
  const intakePolicy = normalizePolicy(options.intakePolicy, DEFAULT_INTAKE_POLICY);
  const admissionPolicy = normalizePolicy(options.admissionPolicy, DEFAULT_ADMISSION_POLICY);
  if (intakePolicy.sensitiveMax >= 0.5 || admissionPolicy.missingContextMax >= 0.5) {
    throw new DecisionFault('invalid_thresholds');
  }
  const auditThresholds = freeze({
    intake: Object.fromEntries(Object.keys(DEFAULT_INTAKE_POLICY)
      .filter((key) => key !== 'version').map((key) => [key, intakePolicy[key]])),
    admission: Object.fromEntries(Object.keys(DEFAULT_ADMISSION_POLICY)
      .filter((key) => key !== 'version').map((key) => [key, admissionPolicy[key]])),
  });
  const auditModel = typeof model === 'string' && model.length <= 64 ? model : 'unknown';
  const clock = options.clock ?? {
    now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  };
  if (!['now', 'setTimeout', 'clearTimeout'].every((key) => typeof clock[key] === 'function')) {
    throw new DecisionFault('invalid_clock');
  }
  let corePromise;
  async function coreFunctions() {
    if (options.materializeBundle && options.buildRelationProposals) {
      return {
        materializeBundle: options.materializeBundle,
        buildRelationProposals: options.buildRelationProposals,
      };
    }
    corePromise ??= import('../core/index.mjs');
    let core;
    try { core = await corePromise; } catch { throw new DecisionFault('core_unavailable', 'unavailable'); }
    const result = {
      materializeBundle: options.materializeBundle ?? core.materializeBundle,
      buildRelationProposals: options.buildRelationProposals ?? core.buildRelationProposals,
    };
    if (Object.values(result).some((value) => typeof value !== 'function')) {
      throw new DecisionFault('core_unavailable', 'unavailable');
    }
    return result;
  }

  let closed = false;
  let active = 0;
  let cooldownUntil = 0;
  let wakeTimer;
  const queue = [];
  const running = new Set();
  const counters = {
    submitted: 0, completed: 0, calls: 0, callsA: 0, callsB: 0, callsD: 0,
    inputTokens: 0, outputTokens: 0, rejected: 0,
  };
  const statuses = {};
  const rubricFor = (job, stage) => stage === 'D'
    ? job.evaluation.profile?.version ?? 'decision-questions-v1'
    : stage === 'B' && job.profile ? job.profile.version : RUBRICS[stage];

  function check(job) {
    if (!job.controller.signal.aborted && clock.now() >= job.deadlineAt) {
      job.controller.abort(new DecisionFault('deadline_exceeded', 'timeout'));
    }
    if (job.controller.signal.aborted) throw abortFault(job.controller.signal);
  }

  // Trace v1: intake.approved is the A threshold decision; materialized is null
  // until core returns a valid bundle, then records actual bundle membership.
  // Null activity/relevance and empty judgments mean no validated answers were
  // available. Choice distributions contain only the known activity/role keys.
  // "skipped" judgments retain B scores vetoed by overall relevance. Request
  // duration includes any cooldown wait; dispatched distinguishes network calls
  // from local rejections/waits. Existing diagnostics retain omission counts.
  function traceFor(job, status, code) {
    const outcome = auditOutcome(status, code ?? 'ok');
    return {
      version: 1,
      outcome,
      thresholds: auditThresholds,
      activity: job.trace.activity ? {
        ...job.trace.activity, probabilities: { ...job.trace.activity.probabilities },
      } : null,
      intake: job.trace.intake.map((entry) => ({ ...entry })),
      relevance: job.trace.relevance,
      nodes: job.trace.nodes.map((entry) => ({
        ...entry, roleProbabilities: { ...entry.roleProbabilities }, reasons: [...entry.reasons],
      })),
      edges: job.trace.edges.map((entry) => ({ ...entry, reasons: [...entry.reasons] })),
      // Abort listeners settle results before request catch/finally handlers.
      // Snapshot unfinished attempts with the terminal outcome here; never freeze
      // the mutable request records or leave a published "pending" record behind.
      requests: job.trace.requests.map((entry) => ({
        stage: entry.stage,
        model: auditModel,
        rubricVersion: rubricFor(job, entry.stage),
        ...(entry.outcome ?? outcome),
        durationMs: auditDuration(entry.startedAt, entry.finishedAt ?? clock.now()),
        dispatched: entry.dispatched,
        questionCount: entry.questionCount,
        requestBytes: entry.requestBytes,
        httpStatus: entry.httpStatus,
        usage: entry.usage ? { ...entry.usage } : null,
      })),
    };
  }

  function resultFor(job, status, code, nodes = [], edges = []) {
    ({ status, code } = auditOutcome(status, code ?? 'ok'));
    const result = {
      status,
      provider: { id: provider.id, version: provider.version },
      activity: job.activity ?? 'other',
      bundle: job.bundle ?? null,
      nodes,
      edges,
      ...(job.analysis ? { analysis: job.analysis } : {}),
      stages: { ...job.stages },
      diagnostics: {
        code: code ?? 'ok',
        codes: code === 'ok' ? [] : [code],
        mode,
        durationMs: Math.max(0, clock.now() - job.startedAt),
        calls: job.calls ?? 0,
        candidatesOmitted: job.candidatesOmitted ?? 0,
        proposalsOmitted: job.proposalsOmitted ?? 0,
        questionCounts: { ...job.questionCounts },
        stageDurationMs: Object.fromEntries(Object.entries(job.stageStartedAt ?? {})
          .map(([stage, startedAt]) => [stage, job.stageDurationMs?.[stage]
            ?? Math.max(0, clock.now() - startedAt)])),
        usage: {
          input_tokens: Object.values(job.stages ?? {})
            .reduce((sum, stage) => sum + (stage.usage?.input_tokens ?? 0), 0),
          output_tokens: Object.values(job.stages ?? {})
            .reduce((sum, stage) => sum + (stage.usage?.output_tokens ?? 0), 0),
        },
        // Failed requests may have been billed even when no usage reached us.
        usageIncomplete: (job.calls ?? 0) > Object.values(job.stages ?? {}).filter(stage => stage.usage !== null).length,
        intakePolicyVersion: intakePolicy.version,
        admissionPolicyVersion: admissionPolicy.version,
        ...(job.capabilityLimitations?.length ? { capabilityLimitations: job.capabilityLimitations } : {}),
        trace: traceFor(job, status, code),
      },
    };
    if (job.operation === 'evaluate') {
      const stage = job.stages?.D;
      return freeze({
        status, answers: job.evaluationAnswers ?? [],
        provenance: stage ? {
          contractVersion: 1,
          provider: { id: provider.id, version: provider.version, ...(model === null ? {} : { model }) },
          profile: job.evaluation.profile,
          cacheContext: job.evaluation.cacheContext,
          inputHash: stage.inputHash,
          completedAt: clock.now(),
          usage: stage.usage ? { inputTokens: stage.usage.input_tokens, outputTokens: stage.usage.output_tokens } : null,
          mode,
        } : null,
        diagnostics: result.diagnostics,
      });
    }
    return freeze(result);
  }

  function finish(job, result) {
    if (job.settled) return;
    job.settled = true;
    clock.clearTimeout(job.timer);
    job.externalSignal?.removeEventListener('abort', job.cancel);
    job.controller.signal.removeEventListener('abort', job.onAbort);
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    counters.completed += 1;
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    job.resolve(result);
  }

  function cooldown(delay) {
    if (!Number.isFinite(delay) || delay <= 0) delay = limits.cooldownMs;
    cooldownUntil = Math.max(cooldownUntil, clock.now() + Math.min(delay, limits.maxCooldownMs));
  }

  async function waitForCooldown(job) {
    while (clock.now() < cooldownUntil) {
      check(job);
      let timer;
      try {
        await withAbort(() => new Promise((resolve) => {
          timer = clock.setTimeout(resolve, cooldownUntil - clock.now());
        }), job.controller.signal);
      } finally {
        clock.clearTimeout(timer);
      }
    }
    check(job);
  }

  async function request(job, stage, payload) {
    const attempt = {
      stage, startedAt: clock.now(), finishedAt: null, outcome: null,
      dispatched: false, questionCount: null, requestBytes: null, httpStatus: null, usage: null,
    };
    job.trace.requests.push(attempt); // A/B for source, one D for broker metadata.
    try {
      check(job);
      if (job.calls >= limits.maxRequestsPerEvent) throw new DecisionFault('request_budget', 'abstained');
      const questionCount = Object.keys(payload.questions).length;
      attempt.questionCount = questionCount;
      if (questionCount < 1 || questionCount > limits.maxQuestionsPerStage) {
        throw new DecisionFault('question_budget', 'abstained');
      }
      job.capabilityLimitations = capabilityLimitations(payload, provider.capabilities);
      if (job.capabilityLimitations.length) throw new DecisionFault('unsupported_capability', 'abstained');
      const body = provider.encode(freeze(payload));
      if (typeof body !== 'string') throw new DecisionFault('invalid_provider_request');
      attempt.requestBytes = Buffer.byteLength(body);
      if (attempt.requestBytes > limits.maxRequestBytes) {
        throw new DecisionFault('request_too_large', 'abstained');
      }
      await waitForCooldown(job);
      check(job);
      job.calls += 1;
      job.questionCounts[stage] = questionCount;
      job.stageStartedAt[stage] = clock.now();
      attempt.dispatched = true;
      counters.calls += 1;
      counters[`calls${stage}`] += 1;
      try {
        const value = await withAbort(() => provider.execute(body, {
          signal: job.controller.signal, deadlineAt: job.deadlineAt,
          maxResponseBytes: limits.maxResponseBytes, now: () => clock.now(),
          reportTransport(metadata) {
            if (job.settled || job.controller.signal.aborted || !isRecord(metadata)) return;
            if (Number.isInteger(metadata.httpStatus) && metadata.httpStatus >= 100
              && metadata.httpStatus <= 599) attempt.httpStatus = metadata.httpStatus;
          },
        }), job.controller.signal);
        check(job);
        const validated = validateResult(value, payload, provider.capabilities, limits.maxResponseBytes);
        const usage = validated.usage === null ? null : {
          input_tokens: validated.usage.inputTokens, output_tokens: validated.usage.outputTokens,
        };
        job.stages[stage] = freeze({
          provider: { id: provider.id, version: provider.version },
          ...(model === null ? {} : { model }),
          rubricVersion: rubricFor(job, stage),
          ...(stage === 'B' && job.profile ? { profileId: job.profile.id } : {}),
          inputHash: hash(body),
          usage,
          mode,
        });
        attempt.usage = usage;
        counters.inputTokens += usage?.input_tokens ?? 0;
        counters.outputTokens += usage?.output_tokens ?? 0;
        requireMetrics(payload, validated.answers);
        attempt.outcome = auditOutcome('ok', 'ok');
        return validated.answers;
      } catch (error) {
        check(job);
        if (error instanceof DecisionFault) {
          if (error.status === 'overloaded') cooldown(error.retryAfterMs);
          throw error;
        }
        throw new DecisionFault('transport_failure', 'unavailable');
      }
    } catch (error) {
      attempt.outcome = error instanceof DecisionFault
        ? auditOutcome(error.status, error.code) : auditOutcome('unavailable', 'decision_failure');
      throw error;
    } finally {
      attempt.finishedAt = clock.now();
      if (attempt.dispatched) {
        job.stageDurationMs[stage] = Math.max(0, clock.now() - job.stageStartedAt[stage]);
      }
    }
  }

  async function run(job) {
    check(job);
    if (job.operation === 'evaluate') {
      const answers = await request(job, 'D', job.evaluation.request);
      check(job);
      job.evaluationAnswers = evaluationAnswers(answers);
      return resultFor(job, 'accepted', 'ok');
    }
    const core = await withAbort(coreFunctions, job.controller.signal);
    check(job);
    const intakeRequest = buildIntakeQuestions(job.event, job.candidates);
    const a = await request(job, 'A', intakeRequest);
    job.activity = a.a_activity.choice;
    job.trace.activity = {
      choice: a.a_activity.choice,
      confidence: a.a_activity.confidence,
      probabilities: Object.fromEntries(ACTIVITIES.map((activity) =>
        [activity, a.a_activity.probabilities[activity]])),
    };
    const verdicts = job.candidates.map((candidate, i) => ({
      candidateId: candidate.id,
      digest: candidate.digest,
      relevant: a[`a_relevant_${i}`].probability,
      sensitive: a[`a_sensitive_${intakeRequest.state.entities[i].sourceIndex}`].probability,
    }));
    job.trace.intake = verdicts.map(({ candidateId, relevant, sensitive }) => {
      const tooSensitive = sensitive > intakePolicy.sensitiveMax;
      const irrelevant = relevant < intakePolicy.relevantMin;
      return {
        candidateId: auditId(candidateId), relevant, sensitive,
        approved: !tooSensitive && !irrelevant,
        reason: tooSensitive ? (irrelevant ? 'sensitive_and_irrelevant' : 'sensitive')
          : (irrelevant ? 'irrelevant' : 'approved'),
        materialized: null,
      };
    });
    const materialized = await withAbort(() => core.materializeBundle({
      candidates: job.candidates, verdicts: freeze(verdicts),
      policy: job.policy, intakePolicy,
    }), job.controller.signal);
    check(job);
    job.bundle = validateBundle(materialized, job.candidates, verdicts, job.policy, intakePolicy);
    const materializedIds = new Set(job.bundle.candidates.map((candidate) => auditId(candidate.id)));
    job.trace.intake.forEach((entry) => { entry.materialized = materializedIds.has(entry.candidateId); });
    if (!job.bundle.candidates.length) return resultFor(job, 'irrelevant', 'no_approved_candidates');

    if (job.profile) {
      const { request: payload, subjects } = buildProfileQuestions(job.profile, job.event, job.bundle);
      const answers = await request(job, 'B', payload);
      check(job);
      job.analysis = {
        profileId: job.profile.id, profileVersion: job.profile.version,
        status: 'answered', answers, subjects,
      };
      // These are bounded semantic answers, not graph judgments. Only core may
      // admit interpretations; the legacy compiler sees no new nodes or edges.
      return resultFor(job, 'abstained', 'profile_answers');
    }

    const maximum = Math.min(limits.maxRelationProposals,
      Math.max(0, Math.floor((limits.maxQuestionsPerStage - 1 - 2 * job.bundle.candidates.length) / 2)));
    const proposed = await withAbort(() => core.buildRelationProposals(job.bundle, {
      ...limits, maxProposals: maximum, maxRelationProposals: maximum,
    }), job.controller.signal);
    check(job);
    const { proposals, omitted } = validateProposals(proposed, job.bundle, maximum);
    job.proposalsOmitted = omitted;
    const b = await request(job, 'B', buildGraphQuestions(job.event, job.bundle, proposals));
    job.trace.relevance = b.b_relevance.probability;
    const irrelevant = b.b_relevance.probability < admissionPolicy.relevanceMin;
    const nodes = job.bundle.candidates.map((candidate, i) => {
      const role = b[`b_role_${i}`];
      const support = b[`b_support_${i}`].probability;
      const accepted = candidate.complete && !job.event.incomplete && role.choice !== 'unknown'
        && support >= admissionPolicy.nodeSupportMin
        && role.probabilities[role.choice] >= admissionPolicy.roleProbabilityMin
        && role.confidence >= admissionPolicy.roleConfidenceMin;
      job.trace.nodes.push({
        candidateId: auditId(candidate.id), role: role.choice,
        supportProbability: support, roleProbability: role.probabilities[role.choice],
        roleConfidence: role.confidence,
        roleProbabilities: Object.fromEntries(ROLES.map((kind) => [kind, role.probabilities[kind]])),
        classification: irrelevant ? 'skipped' : accepted ? 'accepted' : 'tentative',
        reasons: [
          ...(irrelevant ? ['insufficient_relevance'] : []),
          ...(!candidate.complete ? ['candidate_incomplete'] : []),
          ...(job.event.incomplete ? ['event_incomplete'] : []),
          ...(role.choice === 'unknown' ? ['unknown_role'] : []),
          ...(support < admissionPolicy.nodeSupportMin ? ['node_support_below_min'] : []),
          ...(role.probabilities[role.choice] < admissionPolicy.roleProbabilityMin
            ? ['role_probability_below_min'] : []),
          ...(role.confidence < admissionPolicy.roleConfidenceMin ? ['role_confidence_below_min'] : []),
        ],
      });
      return {
        candidateId: candidate.id,
        role: role.choice,
        supportProbability: support,
        roleProbability: role.probabilities[role.choice],
        roleConfidence: role.confidence,
        roleProbabilities: role.probabilities,
        classification: accepted ? 'accepted' : 'tentative',
      };
    });
    const acceptedNodes = new Set(nodes.filter((node) => !irrelevant && node.classification === 'accepted')
      .map((node) => node.candidateId));
    const candidateById = new Map(job.bundle.candidates.map((candidate) => [candidate.id, candidate]));
    const edges = proposals.map((proposal, i) => {
      const support = b[`b_relation_${i}`].probability;
      const missing = b[`b_context_${i}`].probability;
      const accepted = acceptedNodes.has(proposal.sourceCandidateId)
        && acceptedNodes.has(proposal.targetCandidateId)
        && proposal.evidenceCandidateIds.every((id) => candidateById.get(id).complete)
        && support >= admissionPolicy.edgeSupportMin && missing <= admissionPolicy.missingContextMax;
      job.trace.edges.push({
        proposalId: auditId(proposal.id, 'proposal'),
        sourceCandidateId: auditId(proposal.sourceCandidateId),
        targetCandidateId: auditId(proposal.targetCandidateId),
        relation: proposal.relation, supportProbability: support, missingContextProbability: missing,
        classification: irrelevant ? 'skipped' : accepted ? 'accepted' : 'tentative',
        reasons: [
          ...(irrelevant ? ['insufficient_relevance'] : []),
          ...(!acceptedNodes.has(proposal.sourceCandidateId) ? ['source_not_accepted'] : []),
          ...(!acceptedNodes.has(proposal.targetCandidateId) ? ['target_not_accepted'] : []),
          ...(!proposal.evidenceCandidateIds.every((id) => candidateById.get(id).complete)
            ? ['evidence_incomplete'] : []),
          ...(support < admissionPolicy.edgeSupportMin ? ['edge_support_below_min'] : []),
          ...(missing > admissionPolicy.missingContextMax ? ['missing_context_above_max'] : []),
        ],
      });
      return {
        proposalId: proposal.id,
        sourceCandidateId: proposal.sourceCandidateId,
        targetCandidateId: proposal.targetCandidateId,
        relation: proposal.relation,
        evidenceCandidateIds: [...proposal.evidenceCandidateIds],
        supportProbability: support,
        missingContextProbability: missing,
        classification: accepted ? 'accepted' : 'tentative',
      };
    });
    if (irrelevant) return resultFor(job, 'irrelevant', 'insufficient_relevance');
    check(job);
    const status = acceptedNodes.size ? 'accepted' : 'abstained';
    return resultFor(job, status, status === 'accepted' ? null : 'no_accepted_classification', nodes, edges);
  }

  function pump() {
    if (closed) return;
    clock.clearTimeout(wakeTimer);
    wakeTimer = undefined;
    if (queue.length && clock.now() < cooldownUntil) {
      wakeTimer = clock.setTimeout(pump, cooldownUntil - clock.now());
      return;
    }
    while (active < limits.concurrency && queue.length) {
      // Broker evaluations yield to queued source/intake work.
      const sourceIndex = queue.findIndex(job => job.operation !== 'evaluate');
      const [job] = queue.splice(sourceIndex < 0 ? 0 : sourceIndex, 1);
      if (job.settled) continue;
      active += 1;
      running.add(job);
      // One workflow owns a slot through A and B; there is no nested request queue.
      run(job)
        .then((result) => finish(job, result))
        .catch((error) => {
          const fault = error instanceof DecisionFault ? error : new DecisionFault('decision_failure', 'unavailable');
          finish(job, resultFor(job, fault.status, fault.code));
        })
        .finally(() => {
          active -= 1;
          running.delete(job);
          pump();
        });
    }
  }

  function classify(input = {}, operation = 'classify') {
    counters.submitted += 1;
    const startedAt = clock.now();
    const base = {
      startedAt, operation, stages: {}, questionCounts: {}, stageStartedAt: {}, stageDurationMs: {},
      trace: { activity: null, intake: [], relevance: null, nodes: [], edges: [], requests: [] },
    };
    const immediate = (status, code) => {
      counters.completed += 1;
      counters.rejected += 1;
      statuses[status] = (statuses[status] ?? 0) + 1;
      return Promise.resolve(resultFor(base, status, code));
    };
    if (closed) return immediate('abstained', 'service_closed');
    if (!isRecord(input)) return immediate('invalid', 'invalid_input');
    if (operation === 'analyze') {
      base.profile = profiles.get(input.profileId);
      if (!base.profile) return immediate('invalid', 'unknown_profile');
    }
    if (input.signal !== undefined && (!input.signal
      || typeof input.signal.aborted !== 'boolean'
      || typeof input.signal.addEventListener !== 'function'
      || typeof input.signal.removeEventListener !== 'function')) {
      return immediate('invalid', 'invalid_signal');
    }
    if (operation !== 'evaluate' && input.policy?.transmitSource !== true) return immediate('abstained', 'metadata_only');
    if (provider.unavailableCode) return immediate('unavailable', provider.unavailableCode);
    if (input.signal?.aborted) return immediate('abstained', 'cancelled');
    if (limits.maxRequestsPerEvent < (operation === 'evaluate' ? 1 : 2)) return immediate('abstained', 'request_budget');
    const deadlineAt = Math.min(input.deadlineAt ?? startedAt + limits.eventDeadlineMs,
      startedAt + limits.eventDeadlineMs);
    if (!Number.isFinite(deadlineAt)) return immediate('invalid', 'invalid_deadline');
    if (deadlineAt <= startedAt) return immediate('timeout', 'deadline_exceeded');
    if (queue.length >= limits.maxQueue
      && (active >= limits.concurrency || clock.now() < cooldownUntil)) {
      return immediate('overloaded', 'queue_full');
    }
    let snapshot = { candidates: [], omitted: 0 };
    let event;
    let policy;
    try {
      if (operation === 'evaluate') {
        base.evaluation = input.evaluation;
      } else {
        if (!validVersion(input.policy.version)) throw new DecisionFault('invalid_policy');
        policy = freeze(structuredClone(input.policy));
        event = freeze(safeEvent(input.event));
        snapshot = snapshotCandidates(input.candidates, limits);
        base.candidatesOmitted = snapshot.omitted;
        if (snapshot.candidates.length === 0) {
          return immediate(input.candidates.length ? 'abstained' : 'irrelevant',
            input.candidates.length ? 'question_budget' : 'no_candidates');
        }
      }
    } catch (error) {
      return immediate('invalid', error instanceof DecisionFault ? error.code : 'invalid_input');
    }
    return new Promise((resolve) => {
      const job = {
        ...base, ...snapshot, candidatesOmitted: snapshot.omitted,
        event, policy, deadlineAt, resolve, calls: 0,
        externalSignal: input.signal, controller: new AbortController(),
      };
      job.cancel = () => job.controller.abort(new DecisionFault(
        operation === 'evaluate' && job.externalSignal?.reason instanceof DecisionFault
          && job.externalSignal.reason.code === 'stale_evidence' ? 'stale_evidence' : 'cancelled', 'abstained'));
      job.onAbort = () => {
        const fault = abortFault(job.controller.signal);
        finish(job, resultFor(job, fault.status, fault.code));
        pump();
      };
      job.controller.signal.addEventListener('abort', job.onAbort, { once: true });
      job.externalSignal?.addEventListener('abort', job.cancel, { once: true });
      job.timer = clock.setTimeout(() => job.controller.abort(
        new DecisionFault('deadline_exceeded', 'timeout')), deadlineAt - clock.now());
      queue.push(job);
      if (job.externalSignal?.aborted) job.cancel();
      pump();
    });
  }

  const evaluation = createEvaluationAPI({
    provider, limits, clock, cache: options.cache, submit: classify,
    failure: (code, status, startedAt) => resultFor({
      startedAt, operation: 'evaluate', stages: {},
      trace: { activity: null, intake: [], relevance: null, nodes: [], edges: [], requests: [] },
    }, status, code),
  });
  return Object.freeze({
    capabilities: provider.capabilities,
    classify: input => classify(input),
    analyze: input => classify(input, 'analyze'),
    evaluate: evaluation.evaluate,
    decide: evaluation.evaluate,
    invalidateCache: evaluation.invalidate,
    stats: () => ({
      ...counters, ...evaluation.stats(), active, queued: queue.length, closed, mode,
      provider: { id: provider.id, version: provider.version },
      cooldownRemainingMs: Math.max(0, cooldownUntil - clock.now()),
      statuses: { ...statuses },
    }),
    close() {
      if (closed) return;
      closed = true;
      clock.clearTimeout(wakeTimer);
      for (const job of [...queue, ...running]) {
        job.controller.abort(new DecisionFault('service_closed', 'abstained'));
      }
      evaluation.close();
    },
  });
}
