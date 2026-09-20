import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildIntakeRequest, buildGraphRequest, RUBRICS, RELATIONS, ACTIVITIES, ROLES } from './questions.mjs';
import {
  JevFault, isRecord, isProbability, validateResponse, readResponse, withAbort, abortFault,
} from './wire.mjs';
import { FIXTURE_TRANSPORT } from './fixture.mjs';

export { createFixtureTransport } from './fixture.mjs';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
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
  if (!isRecord(event)) throw new JevFault('invalid_event');
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
  if (!Array.isArray(input)) throw new JevFault('invalid_candidates');
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
      throw new JevFault('invalid_candidate');
    }
    // Bound local metadata too; it is retained for core, never sent on the wire.
    let encoded;
    try { encoded = JSON.stringify(candidate); } catch { throw new JevFault('invalid_candidate'); }
    if (Buffer.byteLength(encoded) > limits.maxCandidateBytes + limits.maxLabelBytes + 4096) {
      throw new JevFault('candidate_too_large');
    }
    candidates.push(freeze(JSON.parse(encoded)));
    ids.add(candidate.id);
  }
  return { candidates: freeze(candidates), omitted: input.length - candidates.length };
}

function endpointFor(value, injected) {
  let url;
  try { url = new URL(value); } catch { throw new JevFault('invalid_endpoint'); }
  if (url.href === ENDPOINT) return ENDPOINT;
  if (!injected || !['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash
    || url.pathname !== '/v1/systemone') {
    throw new JevFault('invalid_endpoint');
  }
  return url.href;
}

function normalizeLimits(options = {}) {
  if (!isRecord(options) || Object.keys(options).some((key) => !(key in DEFAULT_LIMITS))) {
    throw new JevFault('invalid_limits');
  }
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const [key, value] of Object.entries(limits)) {
    const minimum = ['maxQueue', 'maxRequestsPerEvent', 'maxRelationProposals'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > 16 * 1024 * 1024) {
      throw new JevFault('invalid_limits');
    }
  }
  if (limits.concurrency > 64 || limits.maxQueue > 4096 || limits.maxCandidates > 128
    || limits.maxQuestionsPerStage > 1024 || limits.eventDeadlineMs > 60_000
    || limits.maxCooldownMs > 300_000 || limits.cooldownMs > limits.maxCooldownMs) {
    throw new JevFault('invalid_limits');
  }
  return freeze(limits);
}

function normalizePolicy(input, defaults) {
  const result = { ...defaults, ...input };
  if (!validVersion(result.version)
    || Object.keys(defaults).some((key) => key !== 'version' && !isProbability(result[key]))) {
    throw new JevFault('invalid_thresholds');
  }
  return freeze(result);
}

function validateBundle(bundle, candidates, verdicts, policy, intakePolicy) {
  if (!isRecord(bundle) || !boundedId(bundle.id) || bundle.policyVersion !== policy.version
    || !Array.isArray(bundle.candidates) || !Array.isArray(bundle.readSet)
    || bundle.candidates.length > candidates.length || bundle.readSet.length > candidates.length) {
    throw new JevFault('invalid_bundle');
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const allowed = new Set(verdicts.filter((verdict) =>
    verdict.sensitive <= intakePolicy.sensitiveMax && verdict.relevant >= intakePolicy.relevantMin)
    .map((verdict) => verdict.candidateId));
  const seen = new Set();
  for (const candidate of bundle.candidates) {
    if (!isRecord(candidate) || seen.has(candidate.id) || !allowed.has(candidate.id)
      || !isDeepStrictEqual(candidate, byId.get(candidate.id))) {
      throw new JevFault('invalid_bundle');
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
    throw new JevFault('invalid_bundle');
  }
  return freeze(bundle); // Preserve the exact core-owned bundle, including object identity.
}

function validateProposals(result, bundle, maximum) {
  if (!isRecord(result) || !Array.isArray(result.proposals)
    || !Number.isSafeInteger(result.omitted) || result.omitted < 0) {
    throw new JevFault('invalid_proposals');
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
      throw new JevFault('invalid_proposal');
    }
    const identity = JSON.stringify([proposal.sourceCandidateId, proposal.targetCandidateId,
      proposal.relation, proposal.evidenceCandidateIds]);
    if (propositions.has(identity)) throw new JevFault('duplicate_proposal');
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

/**
 * Dependency-free, per-daemon two-stage classifier. Only supplied apiKey is used;
 * environment credentials are never read. Core functions can be injected, and
 * otherwise are lazily imported from ../core/index.mjs.
 */
export function createDecisionService(options = {}) {
  const {
    apiKey, model = 'jev-1.13.0', fetchImpl = globalThis.fetch,
    endpoint = ENDPOINT,
  } = options;
  if (typeof fetchImpl !== 'function' || !/^jev-\d+\.\d+\.\d+$/.test(model)
    || (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096
      || /[\r\n]/.test(apiKey)))) {
    throw new JevFault('invalid_configuration');
  }
  const target = endpointFor(endpoint, Object.hasOwn(options, 'fetchImpl'));
  const limits = normalizeLimits(options.limits);
  const intakePolicy = normalizePolicy(options.intakePolicy, DEFAULT_INTAKE_POLICY);
  const admissionPolicy = normalizePolicy(options.admissionPolicy, DEFAULT_ADMISSION_POLICY);
  if (intakePolicy.sensitiveMax >= 0.5 || admissionPolicy.missingContextMax >= 0.5) {
    throw new JevFault('invalid_thresholds');
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
    throw new JevFault('invalid_clock');
  }
  const mode = fetchImpl[FIXTURE_TRANSPORT] === true ? 'demo' : 'live';
  const key = mode === 'demo' ? 'graphlin-offline-fixture' : apiKey;
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
    try { core = await corePromise; } catch { throw new JevFault('core_unavailable', 'unavailable'); }
    const result = {
      materializeBundle: options.materializeBundle ?? core.materializeBundle,
      buildRelationProposals: options.buildRelationProposals ?? core.buildRelationProposals,
    };
    if (Object.values(result).some((value) => typeof value !== 'function')) {
      throw new JevFault('core_unavailable', 'unavailable');
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
    submitted: 0, completed: 0, calls: 0, callsA: 0, callsB: 0,
    inputTokens: 0, outputTokens: 0, rejected: 0,
  };
  const statuses = {};

  function check(job) {
    if (!job.controller.signal.aborted && clock.now() >= job.deadlineAt) {
      job.controller.abort(new JevFault('deadline_exceeded', 'timeout'));
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
        rubricVersion: RUBRICS[entry.stage],
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
    return freeze({
      status,
      activity: job.activity ?? 'other',
      bundle: job.bundle ?? null,
      nodes,
      edges,
      stages: { ...job.stages },
      diagnostics: {
        code: code ?? 'ok',
        codes: code ? [code] : [],
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
            .reduce((sum, stage) => sum + stage.usage.input_tokens, 0),
          output_tokens: Object.values(job.stages ?? {})
            .reduce((sum, stage) => sum + stage.usage.output_tokens, 0),
        },
        // Failed requests may have been billed even when no usage reached us.
        usageIncomplete: (job.calls ?? 0) > Object.keys(job.stages ?? {}).length,
        intakePolicyVersion: intakePolicy.version,
        admissionPolicyVersion: admissionPolicy.version,
        trace: traceFor(job, status, code),
      },
    });
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

  function cooldown(response) {
    let delay = limits.cooldownMs;
    const milliseconds = response.headers?.get('retry-after-ms');
    const seconds = response.headers?.get('retry-after');
    if (milliseconds && milliseconds.length <= 128 && Number.isFinite(Number(milliseconds))) {
      delay = Number(milliseconds);
    } else if (seconds && seconds.length <= 128) {
      delay = /^\d+(?:\.\d+)?$/.test(seconds)
        ? Number(seconds) * 1000 : Date.parse(seconds) - clock.now();
    }
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
    job.trace.requests.push(attempt); // At most one A and one B attempt per job.
    try {
      check(job);
      if (job.calls >= limits.maxRequestsPerEvent) throw new JevFault('request_budget', 'abstained');
      const questionCount = Object.keys(payload.questions).length;
      attempt.questionCount = questionCount;
      if (questionCount < 1 || questionCount > limits.maxQuestionsPerStage) {
        throw new JevFault('question_budget', 'abstained');
      }
      const body = JSON.stringify(payload);
      attempt.requestBytes = Buffer.byteLength(body);
      if (attempt.requestBytes > limits.maxRequestBytes) {
        throw new JevFault('request_too_large', 'abstained');
      }
      await waitForCooldown(job);
      check(job);
      job.calls += 1;
      job.questionCounts[stage] = questionCount;
      job.stageStartedAt[stage] = clock.now();
      attempt.dispatched = true;
      counters.calls += 1;
      counters[`calls${stage}`] += 1;
      let response;
      try {
        response = await withAbort(() => fetchImpl(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body,
          signal: job.controller.signal,
          redirect: 'error',
          credentials: 'omit',
        }), job.controller.signal);
        check(job);
        if (!response || !Number.isInteger(response.status)) throw new JevFault('invalid_http_response');
        if (response.status >= 100 && response.status <= 599) attempt.httpStatus = response.status;
        if (response.status !== 200) {
          if (response.body?.cancel) Promise.resolve(response.body.cancel()).catch(() => {});
          if ([429, 529].includes(response.status)) {
            cooldown(response);
            throw new JevFault('remote_cooldown', 'overloaded');
          }
          if (response.status === 401 || response.status === 403) {
            throw new JevFault('authentication_failed', 'unavailable');
          }
          if (response.status === 400 || response.status === 422) {
            throw new JevFault('request_rejected');
          }
          throw new JevFault('http_error', 'unavailable');
        }
        const value = await readResponse(response, limits.maxResponseBytes, job.controller.signal);
        check(job);
        const validated = validateResponse(value, payload);
        job.stages[stage] = freeze({
          model: validated.model,
          rubricVersion: RUBRICS[stage],
          inputHash: hash(body),
          usage: validated.usage,
          mode,
        });
        attempt.outcome = auditOutcome('ok', 'ok');
        attempt.usage = validated.usage;
        counters.inputTokens += validated.usage.input_tokens;
        counters.outputTokens += validated.usage.output_tokens;
        return validated.answers;
      } catch (error) {
        check(job);
        if (error instanceof JevFault) throw error;
        throw new JevFault('transport_failure', 'unavailable');
      }
    } catch (error) {
      attempt.outcome = error instanceof JevFault
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
    const core = await withAbort(coreFunctions, job.controller.signal);
    check(job);
    const intakeRequest = buildIntakeRequest(model, job.event, job.candidates);
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
      relevant: a[`a_relevant_${i}`].noul,
      sensitive: a[`a_sensitive_${intakeRequest.state.entities[i].sourceIndex}`].noul,
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

    const maximum = Math.min(limits.maxRelationProposals,
      Math.max(0, Math.floor((limits.maxQuestionsPerStage - 1 - 2 * job.bundle.candidates.length) / 2)));
    const proposed = await withAbort(() => core.buildRelationProposals(job.bundle, {
      ...limits, maxProposals: maximum, maxRelationProposals: maximum,
    }), job.controller.signal);
    check(job);
    const { proposals, omitted } = validateProposals(proposed, job.bundle, maximum);
    job.proposalsOmitted = omitted;
    const b = await request(job, 'B', buildGraphRequest(model, job.event, job.bundle, proposals));
    job.trace.relevance = b.b_relevance.noul;
    const irrelevant = b.b_relevance.noul < admissionPolicy.relevanceMin;
    const nodes = job.bundle.candidates.map((candidate, i) => {
      const role = b[`b_role_${i}`];
      const support = b[`b_support_${i}`].noul;
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
      const support = b[`b_relation_${i}`].noul;
      const missing = b[`b_context_${i}`].noul;
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
      const job = queue.shift();
      if (job.settled) continue;
      active += 1;
      running.add(job);
      // One workflow owns a slot through A and B; there is no nested request queue.
      run(job)
        .then((result) => finish(job, result))
        .catch((error) => {
          const fault = error instanceof JevFault ? error : new JevFault('decision_failure', 'unavailable');
          finish(job, resultFor(job, fault.status, fault.code));
        })
        .finally(() => {
          active -= 1;
          running.delete(job);
          pump();
        });
    }
  }

  function classify(input = {}) {
    counters.submitted += 1;
    const startedAt = clock.now();
    const base = {
      startedAt, stages: {}, questionCounts: {}, stageStartedAt: {}, stageDurationMs: {},
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
    if (input.signal !== undefined && (!input.signal
      || typeof input.signal.aborted !== 'boolean'
      || typeof input.signal.addEventListener !== 'function'
      || typeof input.signal.removeEventListener !== 'function')) {
      return immediate('invalid', 'invalid_signal');
    }
    if (input.policy?.transmitSource !== true) return immediate('abstained', 'metadata_only');
    if (!key) return immediate('unavailable', 'missing_key');
    if (input.signal?.aborted) return immediate('abstained', 'cancelled');
    if (limits.maxRequestsPerEvent < 2) return immediate('abstained', 'request_budget');
    const deadlineAt = Math.min(input.deadlineAt ?? startedAt + limits.eventDeadlineMs,
      startedAt + limits.eventDeadlineMs);
    if (!Number.isFinite(deadlineAt)) return immediate('invalid', 'invalid_deadline');
    if (deadlineAt <= startedAt) return immediate('timeout', 'deadline_exceeded');
    if (queue.length >= limits.maxQueue
      && (active >= limits.concurrency || clock.now() < cooldownUntil)) {
      return immediate('overloaded', 'queue_full');
    }
    let snapshot;
    let event;
    let policy;
    try {
      if (!validVersion(input.policy.version)) throw new JevFault('invalid_policy');
      policy = freeze(structuredClone(input.policy));
      event = freeze(safeEvent(input.event));
      snapshot = snapshotCandidates(input.candidates, limits);
      base.candidatesOmitted = snapshot.omitted;
      if (snapshot.candidates.length === 0) {
        return immediate(input.candidates.length ? 'abstained' : 'irrelevant',
          input.candidates.length ? 'question_budget' : 'no_candidates');
      }
    } catch (error) {
      return immediate('invalid', error instanceof JevFault ? error.code : 'invalid_input');
    }
    return new Promise((resolve) => {
      const job = {
        ...base, ...snapshot, candidatesOmitted: snapshot.omitted,
        event, policy, deadlineAt, resolve, calls: 0,
        externalSignal: input.signal, controller: new AbortController(),
      };
      job.cancel = () => job.controller.abort(new JevFault('cancelled', 'abstained'));
      job.onAbort = () => {
        const fault = abortFault(job.controller.signal);
        finish(job, resultFor(job, fault.status, fault.code));
        pump();
      };
      job.controller.signal.addEventListener('abort', job.onAbort, { once: true });
      job.externalSignal?.addEventListener('abort', job.cancel, { once: true });
      job.timer = clock.setTimeout(() => job.controller.abort(
        new JevFault('deadline_exceeded', 'timeout')), deadlineAt - clock.now());
      queue.push(job);
      if (job.externalSignal?.aborted) job.cancel();
      pump();
    });
  }

  return Object.freeze({
    classify,
    stats: () => ({
      ...counters, active, queued: queue.length, closed, mode,
      cooldownRemainingMs: Math.max(0, cooldownUntil - clock.now()),
      statuses: { ...statuses },
    }),
    close() {
      if (closed) return;
      closed = true;
      clock.clearTimeout(wakeTimer);
      for (const job of [...queue, ...running]) {
        job.controller.abort(new JevFault('service_closed', 'abstained'));
      }
    },
  });
}
