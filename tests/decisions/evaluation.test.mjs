import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionService } from '../../runtime/decisions/index.mjs';
import { input, makeCore, fakeClock, flush } from '../jev/helpers.mjs';
import { createRecordedProvider } from './recorded-provider.mjs';
import { jevProvider } from './jev-provider.mjs';

const questions = [
  { id: 'supported', kind: 'boolean', question: 'Is the supplied relation supported?' },
  { id: 'area', kind: 'choice', question: 'Which area contains `entities[0]`?',
    options: [{ id: 'runtime', label: 'Runtime' }, { id: 'unknown', label: 'Unknown' }] },
  { id: 'relevance', kind: 'score', question: 'Rate the relevance of `entities[0]`.',
    options: ['Low', 'Medium', 'High'] },
];
const profile = { id: 'example.area', version: '1' };
const cacheContext = {
  projectId: 'p1', worktreeId: 'w1', lineage: 'l1', policyVersion: 'policy-1',
  evidenceVersion: 'evidence-1', taskScope: null,
};
const metadata = (overrides = {}) => ({
  state: { entities: [{ id: 'entity-1', kind: 'module' }],
    relations: [{ source: 'entity-1', target: 'entity-2', kind: 'depends_on' }] },
  questions: structuredClone(questions), profile, ...overrides,
});
function setup(t, provider, options = {}) {
  const core = makeCore();
  const service = createDecisionService({ provider, ...core, ...options });
  t.after(() => service.close());
  return { service, core };
}

for (const [name, makeProvider] of [
  ['recorded', transform => createRecordedProvider({ transform })], ['jev', jevProvider],
]) {
  test(`${name}: same SDK descriptors evaluate without source intake or vendor types`, async t => {
    const provider = makeProvider();
    const { service, core } = setup(t, provider);
    const supplied = metadata();
    const untouched = structuredClone(supplied);
    const result = await service.decide(supplied);
    assert.deepEqual(supplied, untouched);
    assert.equal(Object.isFrozen(supplied.questions), false);
    assert.equal(service.decide, service.evaluate);
    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.answers, [
      { id: 'supported', kind: 'boolean', value: null, probability: 0.97, probabilities: null, confidence: null },
      { id: 'area', kind: 'choice', value: 'runtime', probability: null,
        probabilities: { runtime: 0.94, unknown: 0.06 }, confidence: 0.95 },
      { id: 'relevance', kind: 'score', value: 1, probability: null,
        probabilities: { 0: 0, 1: 1, 2: 0 }, confidence: 0.95 },
    ]);
    assert.equal(result.provenance.provider.id, name);
    assert.deepEqual(result.provenance.profile, profile);
    assert.equal(result.provenance.inputHash.length, 64);
    assert.equal(result.diagnostics.calls, 1);
    assert.equal(result.diagnostics.cache.status, 'disabled');
    assert.equal(core.calls.materialize.length, 0);
    assert.equal(provider.calls.length, 1);
    assert.equal(result.bundle, undefined);
  });

  test(`${name}: cache keys bind metadata, profile, taxonomy, evidence, policy, lineage and task scope`, async t => {
    const provider = makeProvider();
    const clock = fakeClock();
    const { service } = setup(t, provider, { clock });
    const first = await service.evaluate(metadata({ cacheContext }));
    const repeated = await service.evaluate(metadata({ cacheContext: { ...cacheContext } }));
    assert.equal(first.diagnostics.cache.status, 'miss');
    assert.equal(repeated.diagnostics.cache.status, 'hit');
    assert.equal(repeated.diagnostics.calls, 0);
    assert.deepEqual(repeated.provenance, first.provenance);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(repeated.provenance.cacheContext, cacheContext);
    for (const overrides of [
      { state: { entities: [{ id: 'entity-2', kind: 'module' }] } },
      { profile: { ...profile, version: '2' } },
      { questions: questions.map(q => q.id === 'area' ? { ...q,
        options: [{ id: 'tooling', label: 'Tooling' }, { id: 'unknown', label: 'Unknown' }] } : q) },
      ...Object.keys(cacheContext).map(key => ({ cacheContext: { ...cacheContext, [key]: 'changed' } })),
    ]) {
      const changed = await service.evaluate(metadata({ cacheContext, ...overrides }));
      assert.equal(changed.diagnostics.cache.status, 'miss');
      assert.notEqual(changed.provenance.cacheKey, first.provenance.cacheKey);
    }
    assert.equal(service.stats().cacheHits, 1);
  });

  test(`${name}: disposing one subscriber preserves another owner's shared request`, async t => {
    let release;
    const provider = makeProvider(value => new Promise(resolve => { release = () => resolve(value); }));
    const { service } = setup(t, provider);
    const controller = new AbortController();
    const first = service.evaluate(metadata({ cacheContext, signal: controller.signal }));
    const second = service.evaluate(metadata({ cacheContext }));
    await flush();
    assert.equal(provider.calls.length, 1);
    controller.abort(new Error('PRIVATE_OWNER_REASON'));
    const cancelled = await first;
    assert.equal(cancelled.status, 'abstained');
    assert.doesNotMatch(JSON.stringify(cancelled), /PRIVATE_OWNER_REASON/);
    assert.equal(provider.calls[0].context.signal.aborted, false);
    release();
    const shared = await second;
    assert.equal(shared.status, 'accepted');
    assert.equal(shared.diagnostics.cache.status, 'shared');
    assert.equal(service.stats().cacheEntries, 1);
    assert.equal(service.stats().evaluationSubscribers, 0);
    assert.equal((await service.evaluate(metadata({ cacheContext }))).diagnostics.cache.status, 'hit');
    assert.equal(provider.calls.length, 1);
  });
}

test('deterministic low-level answers without metrics stay unknown while source classification requires metrics', async t => {
  const provider = createRecordedProvider({
    capabilities: { boolean: {}, choice: {}, score: {} },
    execute: async () => ({
      answers: {
        supported: { type: 'boolean', value: true },
        area: { type: 'choice', choice: 'runtime' },
        relevance: { type: 'score', score: 1 },
      },
    }),
  });
  const { service } = setup(t, provider);
  const result = await service.evaluate(metadata());
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.answers.map(({ value, probability, probabilities, confidence }) => ({
    value, probability, probabilities, confidence,
  })), [true, 'runtime', 1].map(value => ({ value, probability: null, probabilities: null, confidence: null })));
  const unsupported = await service.classify(input());
  assert.equal(unsupported.diagnostics.code, 'unsupported_capability');
});

test('low-level validation rejects raw source fields, malformed questions, versions, and non-JSON state', async t => {
  const provider = createRecordedProvider();
  const { service } = setup(t, provider);
  const cycle = {}; cycle.cycle = cycle;
  const cases = [
    [metadata({ state: { entities: [{ code: 'SOURCE_MUST_USE_INTAKE' }] } }), 'source_state_requires_intake'],
    [metadata({ state: { apiKey: 'SYNTHETIC_KEY' } }), 'source_state_requires_intake'],
    [metadata({ state: { source: 'export function forbidden() {}' } }), 'source_state_requires_intake'],
    [metadata({ state: cycle }), 'invalid_state'],
    [metadata({ state: { value: Infinity } }), 'invalid_state'],
    [metadata({ state: { value: () => {} } }), 'invalid_state'],
    [metadata({ questions: [questions[0], questions[0]] }), 'invalid_question_type'],
    [metadata({ questions: [{ ...questions[0], kind: 'noul' }] }), 'invalid_question_type'],
    [metadata({ questions: [{ ...questions[0], options: ['Yes', 'No'] }] }), 'invalid_question_type'],
    [metadata({ questions: [{ ...questions[1], options: [{ id: 'x', label: 'X' }, { id: 'x', label: 'X' }] }] }), 'invalid_question_type'],
    [metadata({ cacheContext: { evidenceVersion: '1' } }), 'invalid_cache_context'],
    [metadata({ cacheContext: { ...cacheContext, policyVersion: undefined } }), 'invalid_cache_context'],
    [metadata({ profile: { id: 'example', version: '1', callback() {} } }), 'invalid_profile'],
  ];
  for (const [supplied, code] of cases) {
    const result = await service.evaluate(supplied);
    assert.equal(result.diagnostics.code, code);
    assert.deepEqual(result.answers, []);
  }
  assert.equal(provider.calls.length, 0);
});

test('cache bounds, expiry and invalidation leave no serialized approval or metadata state', async t => {
  const clock = fakeClock();
  const provider = createRecordedProvider();
  const { service } = setup(t, provider, { clock, cache: { maxEntries: 1, maxBytes: 8192, ttlMs: 100 } });
  const args = metadata({ cacheContext, state: { label: 'APPROVED_METADATA_NOT_RETAINED' } });
  const first = await service.evaluate(args);
  assert.equal(service.stats().cacheEntries, 1);
  assert.ok(service.stats().cacheBytes <= 8192);
  assert.doesNotMatch(JSON.stringify(first), /APPROVED_METADATA_NOT_RETAINED/);
  await service.evaluate(metadata({ cacheContext: { ...cacheContext, evidenceVersion: '2' } }));
  assert.equal(service.stats().cacheEntries, 1);
  assert.equal(service.stats().cacheEvictions, 1);
  assert.equal((await service.evaluate(args)).diagnostics.cache.status, 'miss');
  clock.advance(100);
  assert.equal((await service.evaluate(args)).diagnostics.cache.status, 'miss');
  service.invalidateCache();
  assert.equal(service.stats().cacheBytes, 0);
  assert.equal((await service.evaluate(args)).diagnostics.cache.status, 'miss');
});

test('failed and oversized cache results are not retained', async t => {
  for (const [cache, transform, status] of [
    [{ maxBytes: 1 }, value => value, 'accepted'],
    [{ maxBytes: 8192 }, () => ({ answers: {} }), 'invalid'],
    [{ maxEntries: 0 }, value => value, 'accepted'],
  ]) {
    const provider = createRecordedProvider({ transform });
    const { service } = setup(t, provider, { cache });
    for (let i = 0; i < 2; i++) assert.equal((await service.evaluate(metadata({ cacheContext }))).status, status);
    assert.equal(service.stats().cacheEntries, 0);
    assert.equal(provider.calls.length, 2);
  }
});

test('invalidation and losing all subscribers abort shared work and discard late responses', async t => {
  for (const action of ['invalidate', 'cancel', 'close']) {
    let release;
    const clock = fakeClock();
    const provider = createRecordedProvider({ transform: value => new Promise(resolve => { release = () => resolve(value); }) });
    const { service } = setup(t, provider, { clock });
    const controller = new AbortController();
    const pending = service.evaluate(metadata({ cacheContext, signal: controller.signal }));
    await flush();
    if (action === 'invalidate') service.invalidateCache();
    if (action === 'cancel') controller.abort();
    if (action === 'close') service.close();
    const result = await pending;
    assert.equal(result.status, 'abstained');
    assert.equal(result.diagnostics.code, { invalidate: 'stale_evidence', cancel: 'cancelled', close: 'service_closed' }[action]);
    assert.equal(provider.calls[0].context.signal.aborted, true);
    release();
    await flush();
    assert.equal(service.stats().cacheEntries, 0);
    assert.equal(service.stats().active, 0);
    assert.equal(clock.timers, 0);
  }
});

test('shared callers retain independent deadlines and the workflow deadline never extends', async t => {
  const clock = fakeClock();
  let release;
  const provider = createRecordedProvider({ transform: value => new Promise(resolve => { release = () => resolve(value); }) });
  const { service } = setup(t, provider, { clock });
  const short = service.evaluate(metadata({ cacheContext, deadlineAt: 50 }));
  const long = service.evaluate(metadata({ cacheContext, deadlineAt: 500 }));
  await flush();
  clock.advance(50);
  assert.equal((await short).status, 'timeout');
  assert.equal(provider.calls[0].context.signal.aborted, false);
  release();
  assert.equal((await long).status, 'accepted');
  assert.equal(provider.calls.length, 1);
  assert.equal(service.stats().evaluationSubscribers, 0);
});

test('late subscriber results are rejected even before the event loop delivers deadline timers', async t => {
  let now = 0;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout() {} };
  const provider = createRecordedProvider({ transform(value) { now = 100; return value; } });
  const { service } = setup(t, provider, { clock });
  const result = await service.evaluate(metadata({ cacheContext, deadlineAt: 50 }));
  assert.equal(result.status, 'timeout');
  assert.equal(service.stats().cacheEntries, 0);
});

test('evaluation shares classification queue, request budget and pending-owner bounds', async t => {
  const clock = fakeClock();
  const provider = createRecordedProvider({ transform: () => new Promise(() => {}) });
  const { service } = setup(t, provider, { clock, limits: { concurrency: 1, maxQueue: 0 } });
  const classification = service.classify(input());
  await flush();
  assert.equal((await service.evaluate(metadata())).diagnostics.code, 'queue_full');
  service.close();
  await classification;
  const ownerProvider = createRecordedProvider({ transform: () => new Promise(() => {}) });
  const owners = setup(t, ownerProvider, { clock, limits: { concurrency: 1, maxQueue: 0 } }).service;
  const first = owners.evaluate(metadata({ cacheContext }));
  const rejected = await owners.evaluate(metadata({ cacheContext }));
  assert.equal(rejected.diagnostics.code, 'queue_full');
  owners.close();
  await first;
  const one = setup(t, createRecordedProvider(), { limits: { maxRequestsPerEvent: 1 } }).service;
  assert.equal((await one.evaluate(metadata())).status, 'accepted');
  assert.equal((await one.classify(input())).diagnostics.code, 'request_budget');
  const none = setup(t, createRecordedProvider(), { limits: { maxRequestsPerEvent: 0 } }).service;
  assert.equal((await none.evaluate(metadata())).diagnostics.code, 'request_budget');
});

test('large SDK requests and provider expansions are rejected before dispatch', async t => {
  for (const [provider, supplied, limits, code] of [
    [createRecordedProvider(), metadata({ state: { label: 'é'.repeat(5000) } }), { maxRequestBytes: 8192 }, 'request_too_large'],
    [createRecordedProvider({ encode: () => 'x'.repeat(2049) }), metadata(), { maxRequestBytes: 2048 }, 'request_too_large'],
    [createRecordedProvider(), metadata(), { maxQuestionsPerStage: 2 }, 'question_budget'],
  ]) {
    const { service } = setup(t, provider, { limits });
    assert.equal((await service.evaluate(supplied)).diagnostics.code, code);
    assert.equal(provider.calls.length, 0);
  }
});
