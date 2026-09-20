import { createHash } from 'node:crypto';
import { DecisionFault } from './faults.mjs';
import { isRecord, validateQuestions } from './contracts.mjs';

export const DEFAULT_CACHE_LIMITS = Object.freeze({
  maxEntries: 512, maxBytes: 8 * 1024 * 1024, ttlMs: 60_000,
});
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const version = value => id(value) || (Number.isSafeInteger(value) && value >= 0);
const sourceFields = new Set([
  'code', 'text', 'snippet', 'snippets', 'sourcecode', 'sourcetext',
  'rawsource', 'rawhook', 'transcript', 'prompt', 'body', 'content',
  'apikey', 'credentials', 'password', 'secret', 'token', 'absolutepath',
]);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, child) =>
  isRecord(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);

// This is an accidental-source guard, not an authorization boundary. Only the
// trusted broker may call evaluate; it owns grants, consent and current versions.
function metadataSnapshot(value, maximumBytes) {
  const ancestors = new Set();
  let visited = 0;
  let bytes = 0;
  function visit(item, depth) {
    if (++visited > 10_000 || depth > 16) throw new DecisionFault('invalid_state');
    if (item === null || typeof item === 'boolean') { bytes += 5; return item; }
    if (typeof item === 'number' && Number.isFinite(item)) { bytes += 24; return item; }
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > maximumBytes || item.length > 8192) throw new DecisionFault('request_too_large', 'abstained');
      return item;
    }
    if (typeof item !== 'object' || ancestors.has(item)
      || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype
        && Object.getPrototypeOf(item) !== null)) throw new DecisionFault('invalid_state');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      result = Array.from(item, child => visit(child, depth + 1));
    } else {
      result = Object.fromEntries(Object.entries(item).map(([key, child]) => {
        if (!id(key)) throw new DecisionFault('invalid_state');
        if (sourceFields.has(key.replaceAll('_', '').replaceAll('-', '').toLowerCase())) {
          throw new DecisionFault('source_state_requires_intake');
        }
        if (key === 'source' && !id(child)) throw new DecisionFault('source_state_requires_intake');
        bytes += Buffer.byteLength(key);
        return [key, visit(child, depth + 1)];
      }));
    }
    ancestors.delete(item);
    if (bytes > maximumBytes) throw new DecisionFault('request_too_large', 'abstained');
    return result;
  }
  if (!isRecord(value)) throw new DecisionFault('invalid_state');
  return visit(value, 0);
}

export function buildEvaluation(input, limits) {
  if (!Array.isArray(input.questions) || !input.questions.length) throw new DecisionFault('invalid_question_type');
  if (input.questions.length > limits.maxQuestionsPerStage) throw new DecisionFault('question_budget', 'abstained');
  const seen = new Set();
  const questions = Object.fromEntries(input.questions.map(descriptor => {
    if (!isRecord(descriptor) || !id(descriptor.id) || seen.has(descriptor.id)
      || !['boolean', 'choice', 'score'].includes(descriptor.kind)
      || Object.keys(descriptor).some(key =>
        !['id', 'kind', 'question', 'focus', 'options', 'requiredMetrics'].includes(key))) {
      throw new DecisionFault('invalid_question_type');
    }
    seen.add(descriptor.id);
    let criteria;
    if (descriptor.kind === 'boolean') {
      if (descriptor.options !== undefined) throw new DecisionFault('invalid_question_type');
      criteria = { true: 'The proposition is supported.', false: 'The proposition is not supported.' };
    } else if (descriptor.kind === 'choice') {
      if (!Array.isArray(descriptor.options) || descriptor.options.some(option => !isRecord(option)
        || !id(option.id) || Object.keys(option).some(key => !['id', 'label'].includes(key)))
        || new Set(descriptor.options.map(option => option.id)).size !== descriptor.options.length) {
        throw new DecisionFault('invalid_question_type');
      }
      criteria = Object.fromEntries(descriptor.options.map(option => [option.id, option.label]));
    } else {
      criteria = descriptor.options;
    }
    return [descriptor.id, {
      type: descriptor.kind,
      instructions: {
        question: descriptor.question,
        ...(descriptor.focus === undefined ? {} : { focus: descriptor.focus }),
      },
      criteria,
      requiredMetrics: descriptor.requiredMetrics ?? [],
    }];
  }));
  validateQuestions(questions);
  let profile = null;
  if (input.profile !== undefined) {
    if (!isRecord(input.profile) || !id(input.profile.id) || !id(input.profile.version)
      || Object.keys(input.profile).some(key => !['id', 'version'].includes(key))) throw new DecisionFault('invalid_profile');
    profile = { id: input.profile.id, version: input.profile.version };
  }
  let cacheContext = null;
  if (input.cacheContext !== undefined) {
    const keys = ['projectId', 'worktreeId', 'lineage', 'policyVersion', 'evidenceVersion', 'taskScope'];
    if (!isRecord(input.cacheContext) || Object.keys(input.cacheContext).length !== keys.length
      || keys.some(key => !Object.hasOwn(input.cacheContext, key)
        || (key === 'taskScope' && input.cacheContext[key] === null ? false : !version(input.cacheContext[key])))) {
      throw new DecisionFault('invalid_cache_context');
    }
    cacheContext = { ...input.cacheContext };
  }
  const request = { state: metadataSnapshot(input.state, limits.maxRequestBytes), questions };
  if (Buffer.byteLength(JSON.stringify(request)) > limits.maxRequestBytes) {
    throw new DecisionFault('request_too_large', 'abstained');
  }
  // Clone before freezing: never freeze a caller's descriptors or arrays.
  return freeze(structuredClone({ request, profile, cacheContext }));
}

export function evaluationAnswers(answers) {
  return Object.entries(answers).map(([id, answer]) => ({
    id, kind: answer.type,
    value: answer.type === 'boolean' ? answer.value : answer.type === 'choice' ? answer.choice : answer.score,
    probability: answer.type === 'boolean' ? answer.probability : null,
    probabilities: answer.type === 'boolean' ? null : answer.probabilities,
    confidence: answer.type === 'boolean' ? null : answer.confidence,
  }));
}

function normalizeCache(options = {}) {
  if (!isRecord(options) || Object.keys(options).some(key => !Object.hasOwn(DEFAULT_CACHE_LIMITS, key))) {
    throw new DecisionFault('invalid_cache_limits');
  }
  const value = { ...DEFAULT_CACHE_LIMITS, ...options };
  for (const [key, maximum] of [['maxEntries', 4096], ['maxBytes', 32 * 1024 * 1024], ['ttlMs', 3_600_000]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > maximum) {
      throw new DecisionFault('invalid_cache_limits');
    }
  }
  return value;
}

export function createEvaluationAPI({ provider, clock, limits, cache: cacheOptions, submit, failure }) {
  const bounds = normalizeCache(cacheOptions);
  const cache = new Map();
  const shared = new Map();
  let bytes = 0;
  let epoch = 0;
  let closed = false;
  let cacheHits = 0;
  let sharedHits = 0;
  let cacheEvictions = 0;
  let subscribers = 0;
  const remove = key => {
    const entry = cache.get(key);
    if (entry) { bytes -= entry.bytes; cache.delete(key); cacheEvictions++; }
  };
  const expire = () => {
    for (const [key, entry] of cache) if (entry.expiresAt <= clock.now()) remove(key);
  };
  function remember(key, result, generation) {
    if (closed || epoch !== generation || result.status !== 'accepted' || !bounds.maxEntries
      || !bounds.maxBytes || !bounds.ttlMs) return;
    expire();
    const size = Buffer.byteLength(JSON.stringify(result)) + Buffer.byteLength(key);
    if (size > bounds.maxBytes) return;
    remove(key);
    while (cache.size >= bounds.maxEntries || bytes + size > bounds.maxBytes) remove(cache.keys().next().value);
    cache.set(key, { result, bytes: size, expiresAt: clock.now() + bounds.ttlMs });
    bytes += size;
  }
  function decorate(result, status, key, startedAt) {
    return freeze({
      ...result,
      provenance: result.provenance ? { ...result.provenance, cacheKey: key } : null,
      diagnostics: {
        ...result.diagnostics,
        ...(status === 'hit' ? {
          calls: 0, questionCounts: {}, stageDurationMs: {},
          usage: { input_tokens: 0, output_tokens: 0 }, usageIncomplete: false,
          trace: { ...result.diagnostics.trace, requests: [] },
        } : {}),
        durationMs: Math.max(0, clock.now() - startedAt),
        cache: { status, key },
      },
    });
  }
  function subscribe(entry, { signal, deadlineAt, startedAt }, cacheStatus, key) {
    entry.owners++;
    subscribers++;
    const waiter = { signal, deadlineAt };
    entry.waiters.add(waiter);
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = result => {
        if (settled) return;
        if (result.status === 'accepted' && clock.now() >= deadlineAt) {
          result = failure('deadline_exceeded', 'timeout', startedAt);
        }
        settled = true;
        clock.clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        entry.owners--;
        entry.waiters.delete(waiter);
        subscribers--;
        if (!entry.owners && !entry.finished) {
          if (shared.get(key) === entry) shared.delete(key);
          entry.controller.abort();
        }
        resolve(decorate(result, cacheStatus, key, startedAt));
      };
      const cancel = () => finish(failure('cancelled', 'abstained', startedAt));
      signal?.addEventListener('abort', cancel, { once: true });
      timer = clock.setTimeout(() => finish(failure('deadline_exceeded', 'timeout', startedAt)), deadlineAt - clock.now());
      entry.promise.then(finish);
      if (signal?.aborted) cancel();
    });
  }
  function evaluate(input = {}) {
    const startedAt = clock.now();
    if (closed) return Promise.resolve(failure('service_closed', 'abstained', startedAt));
    let evaluation;
    let deadlineAt;
    try {
      if (!isRecord(input)) throw new DecisionFault('invalid_input');
      if (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean'
        || typeof input.signal.addEventListener !== 'function' || typeof input.signal.removeEventListener !== 'function')) {
        throw new DecisionFault('invalid_signal');
      }
      if (input.signal?.aborted) throw new DecisionFault('cancelled', 'abstained');
      deadlineAt = Math.min(input.deadlineAt ?? startedAt + limits.eventDeadlineMs, startedAt + limits.eventDeadlineMs);
      if (!Number.isFinite(deadlineAt)) throw new DecisionFault('invalid_deadline');
      if (deadlineAt <= startedAt) throw new DecisionFault('deadline_exceeded', 'timeout');
      if (provider.unavailableCode) throw new DecisionFault(provider.unavailableCode, 'unavailable');
      evaluation = buildEvaluation(input, limits);
      if (clock.now() >= deadlineAt) throw new DecisionFault('deadline_exceeded', 'timeout');
    } catch (error) {
      return Promise.resolve(failure(error instanceof DecisionFault ? error.code : 'invalid_input',
        error instanceof DecisionFault ? error.status : 'invalid', startedAt));
    }
    const cacheEnabled = bounds.maxEntries > 0 && bounds.maxBytes > 0 && bounds.ttlMs > 0 && evaluation.cacheContext;
    if (!cacheEnabled) return submit({ ...input, evaluation }, 'evaluate')
      .then(result => decorate(result, 'disabled', null, startedAt));
    const key = hash(canonical({
      contractVersion: provider.contractVersion, provider: provider.id, version: provider.version,
      model: provider.model ?? null, mode: provider.mode, capabilities: provider.capabilities, evaluation,
    }));
    expire();
    const hit = cache.get(key);
    if (hit) {
      cacheHits++;
      cache.delete(key); cache.set(key, hit);
      return Promise.resolve(decorate(hit.result, 'hit', key, startedAt));
    }
    if (subscribers >= limits.maxQueue + limits.concurrency) {
      return Promise.resolve(failure('queue_full', 'overloaded', startedAt));
    }
    let entry = shared.get(key);
    let cacheStatus = 'shared';
    if (!entry) {
      cacheStatus = 'miss';
      const generation = epoch;
      entry = { controller: new AbortController(), owners: 0, finished: false, waiters: new Set() };
      shared.set(key, entry);
      // Each subscriber owns its own shorter deadline. The shared workflow
      // remains bounded by the original service deadline and active owners.
      entry.promise = submit({
        evaluation, signal: entry.controller.signal, deadlineAt: startedAt + limits.eventDeadlineMs,
      }, 'evaluate').then(result => {
        entry.finished = true;
        if (shared.get(key) === entry) shared.delete(key);
        if ([...entry.waiters].some(waiter => !waiter.signal?.aborted && waiter.deadlineAt > clock.now())) {
          remember(key, result, generation);
        }
        return result;
      });
    } else sharedHits++;
    return subscribe(entry, { signal: input.signal, deadlineAt, startedAt }, cacheStatus, key);
  }
  function invalidate() {
    epoch++;
    cache.clear(); bytes = 0;
    for (const entry of shared.values()) entry.controller.abort(new DecisionFault('stale_evidence', 'abstained'));
    shared.clear();
  }
  return {
    evaluate, invalidate,
    close() { closed = true; invalidate(); },
    stats() {
      expire();
      return { cacheHits, sharedHits, cacheEvictions, cacheEntries: cache.size, cacheBytes: bytes,
        sharedEvaluations: shared.size, evaluationSubscribers: subscribers };
    },
  };
}
