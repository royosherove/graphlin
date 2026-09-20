import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionService, DecisionFault } from '../../runtime/decisions/index.mjs';
import { input, makeCore, fakeClock, flush } from '../jev/helpers.mjs';
import { createRecordedProvider } from './recorded-provider.mjs';

function setup(t, provider, options = {}) {
  const service = createDecisionService({ provider, ...makeCore(), ...options });
  t.after(() => service.close());
  return service;
}

test('alternate provider obeys request reservation and encoded UTF-8 byte limits', async t => {
  for (const [options, provider, code] of [
    [{ limits: { maxRequestsPerEvent: 1 } }, createRecordedProvider(), 'request_budget'],
    [{ limits: { maxRequestBytes: 10 } }, createRecordedProvider(), 'request_too_large'],
    [{ limits: { maxRequestBytes: 10 } }, createRecordedProvider({ encode: () => 'é'.repeat(6) }), 'request_too_large'],
    [{}, createRecordedProvider({ encode: () => ({ wrong: 'not an encoded string' }) }), 'invalid_provider_request'],
  ]) {
    const result = await setup(t, provider, options).classify(input());
    assert.equal(result.diagnostics.code, code);
    assert.equal(provider.calls.length, 0);
  }
});

test('alternate provider uses the same bounded queue and external cancellation', async t => {
  const clock = fakeClock();
  const provider = createRecordedProvider({ execute: () => new Promise(() => {}) });
  const service = setup(t, provider, { clock, limits: { concurrency: 1, maxQueue: 1 } });
  const cancel = new AbortController();
  const first = service.classify(input({ signal: cancel.signal }));
  const second = service.classify(input());
  const rejected = await service.classify(input());
  assert.equal(rejected.diagnostics.code, 'queue_full');
  await flush();
  cancel.abort(new Error('PRIVATE_ABORT_REASON'));
  assert.equal((await first).diagnostics.code, 'cancelled');
  await flush();
  assert.equal(service.stats().active, 1);
  service.close();
  const result = await second;
  assert.equal(result.diagnostics.code, 'service_closed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ABORT_REASON/);
  await flush();
  assert.equal(service.stats().active, 0);
  assert.equal(service.stats().queued, 0);
  assert.equal(clock.timers, 0);
});

test('alternate provider overload uses core cooldown, no retries, and the same absolute deadlines', async t => {
  const clock = fakeClock();
  const provider = createRecordedProvider({
    transform() { throw new DecisionFault('remote_cooldown', 'overloaded', { retryAfterMs: 100_000 }); },
  });
  const service = setup(t, provider, { clock });
  assert.equal((await service.classify(input())).status, 'overloaded');
  assert.equal(service.stats().cooldownRemainingMs, 30_000);
  const waiting = service.classify(input());
  clock.advance(2000);
  assert.equal((await waiting).status, 'timeout');
  assert.equal(provider.calls.length, 1);
});

test('provider result limits and raw faults produce fixed, private diagnostics', async t => {
  for (const provider of [
    createRecordedProvider({ transform: value => ({ ...value, text: 'x'.repeat(300_000) }) }),
    createRecordedProvider({ transform() { throw new Error('RAW_SECRET'); } }),
    createRecordedProvider({ transform() { throw new DecisionFault('RAW_SECRET', 'RAW_STATUS'); } }),
  ]) {
    const result = await setup(t, provider).classify(input());
    assert.ok(['invalid', 'unavailable'].includes(result.status));
    assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET|RAW_STATUS/);
    assert.deepEqual(result.nodes, []);
  }
});

test('provider receives immutable projections and cannot mutate evidence or materializer inputs', async t => {
  let protectedRequest = false;
  const provider = createRecordedProvider({
    encode(request) {
      assert.throws(() => { request.state.evidence[0].code = 'CORRUPTION'; }, TypeError);
      const question = Object.values(request.questions)[0];
      assert.throws(() => { question.criteria.inspection = 'CORRUPTION'; }, TypeError);
      protectedRequest = true;
      return JSON.stringify(request);
    },
  });
  const result = await setup(t, provider).classify(input());
  assert.equal(protectedRequest, true);
  assert.equal(result.status, 'accepted');
  assert.ok(result.bundle);
  assert.doesNotMatch(JSON.stringify(result), /CORRUPTION/);
});

test('profile budgets cannot create extra stages or bypass A exclusions', async t => {
  const questions = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`q${i}`, {
    type: 'boolean', instructions: { question: 'Is the supplied entity supported?' },
    criteria: { true: 'Supported', false: 'Unsupported' },
  }]));
  const profile = { id: 'bounded', version: '1', scope: 'bundle', questions };
  const provider = createRecordedProvider();
  const service = setup(t, provider, { profiles: [profile] });
  const result = await service.analyze({ ...input(), profileId: profile.id });
  assert.equal(result.diagnostics.code, 'question_budget');
  assert.equal(provider.calls.length, 1);

  const withheld = createRecordedProvider({ transform(value) {
    value.answers.a_sensitive_0.probability = 1;
    return value;
  } });
  const excluded = await setup(t, withheld, { profiles: [profile] })
    .analyze({ ...input(), profileId: profile.id });
  assert.equal(excluded.diagnostics.code, 'no_approved_candidates');
  assert.equal(withheld.calls.length, 1);
  assert.equal(excluded.analysis, undefined);
});
