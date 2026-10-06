import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeciderProvider, deciderEndpoint, DEFAULT_DECIDER_MODEL, DEFAULT_DECIDER_ENDPOINT } from '../../runtime/decider/provider.mjs';
import { createDecisionService, DecisionFault } from '../../runtime/decisions/index.mjs';
import {
  createConfiguredProvider, decisionServiceOptions, deciderConfig, DECIDER_LIMITS, activityTargetDeadline,
} from '../../runtime/daemon/providers.mjs';
import { input, candidate, makeCore, responseValue, jsonResponse, fakeClock, flush } from '../jev/helpers.mjs';

// All tests use a fake fetch. No test opens a socket to a Decider server.
const deciderValue = (request, changes) => ({ ...responseValue(request, changes), model: request.model });

function fakeDecider(respond = request => jsonResponse(deciderValue(request))) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, options, request });
    return respond(request, calls.length, options);
  };
  return { fetchImpl, calls };
}

function deciderService(t, fetchImpl, options = {}) {
  const config = deciderConfig();
  const service = createDecisionService({
    provider: createConfiguredProvider(config, { transmitSource: true, fetchImpl }),
    ...makeCore(), ...decisionServiceOptions(config), ...options,
  });
  t.after(() => service.close());
  return service;
}

const booleanRequest = { state: { text: 'synthetic' }, questions: {
  q: { type: 'boolean', instructions: { question: 'Is this synthetic?' }, criteria: { true: 'Yes', false: 'No' } },
} };
const booleanAnswer = body => jsonResponse({ model: JSON.parse(body).model,
  answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } });

async function executeWith(response, options = {}) {
  const provider = createDeciderProvider({ transmitSource: true, fetchImpl: async () => response, ...options });
  const body = provider.encode(booleanRequest);
  return provider.execute(body, { signal: new AbortController().signal, maxResponseBytes: 65536 });
}

test('decider endpoint allows loopback IP addresses only, with the fixed path', () => {
  assert.equal(deciderEndpoint(DEFAULT_DECIDER_ENDPOINT), DEFAULT_DECIDER_ENDPOINT);
  // The decider server refuses the Host [::1], thus Graphlin refuses it too.
  assert.equal(deciderEndpoint('http://[::1]:8099/v1/systemone'), null);
  assert.equal(deciderEndpoint('http://[::1]/v1/systemone'), null);
  // The tunnel carries plain HTTP, thus an https: endpoint can only fail.
  assert.equal(deciderEndpoint('https://127.0.0.1/v1/systemone'), null);
  for (const value of [
    'http://localhost:8099/v1/systemone', 'http://10.0.0.1:8099/v1/systemone',
    'http://example.com/v1/systemone', 'http://127.0.0.1:8099/v1/other',
    'http://user:pass@127.0.0.1:8099/v1/systemone', 'http://127.0.0.1:8099/v1/systemone?x=1',
    'http://127.0.0.1:8099/v1/systemone#x', 'http://127.0.0.1:8099/v1/systemone?',
    'file:///v1/systemone', 'ftp://127.0.0.1/v1/systemone', 'not a url', 42, undefined,
  ]) assert.equal(deciderEndpoint(value), null, String(value));
});

test('decider configuration that is not valid fails closed at construction', () => {
  for (const options of [
    { endpoint: 'http://localhost:8099/v1/systemone' }, { model: 'jev-1.13.0' },
    { model: `strands-decider-${'x'.repeat(49)}` }, { model: 'strands-decider-RAW SECRET' },
    { fetchImpl: 'not-a-function' }, { transmitSource: 'yes' },
  ]) {
    assert.throws(() => createDeciderProvider({ fetchImpl: async () => null, ...options }),
      error => error instanceof DecisionFault && error.code === 'invalid_configuration');
  }
  const provider = createDeciderProvider({ fetchImpl: async () => null, transmitSource: true });
  assert.equal(provider.id, 'decider');
  assert.equal(provider.mode, 'live');
  assert.equal(provider.model, DEFAULT_DECIDER_MODEL);
  assert.equal(DEFAULT_DECIDER_MODEL.length <= 64, true);
  assert.equal(provider.unavailableCode, null);
});

test('without source consent the decider is unavailable and sends nothing', async t => {
  const transport = fakeDecider();
  const provider = createDeciderProvider({ fetchImpl: transport.fetchImpl });
  assert.equal(provider.unavailableCode, 'provider_unavailable');
  const service = createDecisionService({ provider, ...makeCore() });
  t.after(() => service.close());
  const result = await service.classify(input());
  assert.equal(result.status, 'unavailable');
  assert.equal(result.diagnostics.code, 'provider_unavailable');
  await assert.rejects(provider.execute(provider.encode(booleanRequest),
    { signal: new AbortController().signal, maxResponseBytes: 1024 }), { code: 'provider_unavailable' });
  assert.equal(transport.calls.length, 0);
});

test('decider request has no authorization header, no credentials and no redirects', async t => {
  const transport = fakeDecider();
  const result = await deciderService(t, transport.fetchImpl).classify(input({ candidates: [candidate(), candidate('c2')] }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.provider.id, 'decider');
  assert.equal(result.stages.A.model, DEFAULT_DECIDER_MODEL);
  assert.equal(result.stages.A.mode, 'live');
  assert.equal(result.diagnostics.provider, 'decider');
  assert.equal(result.diagnostics.admissionPolicyVersion, 'admission-policy-v1-decider-experimental');
  assert.equal(transport.calls.length, 2);
  for (const call of transport.calls) {
    assert.equal(call.url, DEFAULT_DECIDER_ENDPOINT);
    assert.deepEqual(Object.keys(call.options.headers), ['content-type']);
    assert.equal(Object.keys(call.options.headers).some(name => name.toLowerCase() === 'authorization'), false);
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.request.model, DEFAULT_DECIDER_MODEL);
  }
});

test('the extra latency_ms response field is accepted and not kept', async () => {
  const response = jsonResponse({ model: DEFAULT_DECIDER_MODEL, answers: { q: { type: 'noul', noul: 0.8 } },
    usage: { input_tokens: 3, output_tokens: 1 }, latency_ms: 63.27 });
  const value = await executeWith(response);
  assert.deepEqual(value, { answers: { q: { type: 'boolean', probability: 0.8 } }, usage: { inputTokens: 3, outputTokens: 1 } });
});

test('a different model name in the response is invalid_response (label check)', async () => {
  const response = jsonResponse({ model: 'strands-decider-other', answers: { q: { type: 'noul', noul: 0.8 } },
    usage: { input_tokens: 3, output_tokens: 1 } });
  await assert.rejects(executeWith(response), error => error instanceof DecisionFault
    && error.code === 'invalid_response' && error.status === 'invalid');
});

test('server results map to fixed fault codes and statuses', async () => {
  const cases = [
    [new Response(JSON.stringify({ detail: 'prompt of 5000 tokens exceeds the context window of 4096 tokens',
      code: 'context_window_exceeded' }), { status: 422 }), 'request_too_large', 'invalid'],
    [new Response(JSON.stringify({ detail: 'RAW_DETAIL_SECRET' }), { status: 422 }), 'request_rejected', 'invalid'],
    [new Response('not json RAW_SECRET', { status: 422 }), 'request_rejected', 'invalid'],
    [new Response(JSON.stringify({ detail: 'bad', code: 'context_window_exceeded' }), { status: 400 }), 'request_rejected', 'invalid'],
    [new Response('x'.repeat(10_000), { status: 422 }), 'request_rejected', 'invalid'],
    [new Response('', { status: 401 }), 'http_error', 'unavailable'],
    [new Response('', { status: 403 }), 'http_error', 'unavailable'],
    [new Response('RAW_INTERNAL', { status: 500 }), 'http_error', 'unavailable'],
    [new Response('', { status: 404 }), 'http_error', 'unavailable'],
    [new Response(JSON.stringify({ detail: 'busy', code: 'busy' }), { status: 503, headers: { 'retry-after': '1' } }),
      'remote_cooldown', 'overloaded', 1000],
    [new Response('', { status: 429, headers: { 'retry-after-ms': '250' } }), 'remote_cooldown', 'overloaded', 250],
  ];
  for (const [response, code, status, retryAfterMs] of cases) {
    await assert.rejects(executeWith(response), error => {
      assert.ok(error instanceof DecisionFault);
      assert.equal(error.name, 'DecisionFault', 'no JevFault copy');
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, retryAfterMs);
      assert.doesNotMatch(String(error.message), /RAW_|tokens/);
      return true;
    }, `${response.status} ${code}`);
  }
});

test('a tunnel that is down (connection refused) is transport_failure and unavailable', async t => {
  const refused = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8099'),
      { code: 'ECONNREFUSED' }) });
  };
  const provider = createDeciderProvider({ transmitSource: true, fetchImpl: refused });
  await assert.rejects(provider.execute(provider.encode(booleanRequest),
    { signal: new AbortController().signal, maxResponseBytes: 1024 }),
  error => error instanceof DecisionFault && error.code === 'transport_failure' && error.status === 'unavailable');
  const result = await deciderService(t, refused).classify(input());
  assert.equal(result.status, 'unavailable');
  assert.equal(result.diagnostics.code, 'transport_failure');
  assert.doesNotMatch(JSON.stringify(result), /ECONNREFUSED|8099/);
});

test('a 503 from the server starts the shared cooldown with Retry-After', async t => {
  const clock = fakeClock();
  let calls = 0;
  const service = deciderService(t, async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ detail: 'busy', code: 'busy' }),
      { status: 503, headers: { 'retry-after': '1' } });
    return jsonResponse(deciderValue(JSON.parse(options.body)));
  }, { clock });
  const rejected = await service.classify(input());
  assert.equal(rejected.status, 'overloaded');
  assert.equal(rejected.diagnostics.code, 'remote_cooldown');
  const pending = service.classify(input());
  await flush();
  assert.equal(calls, 1);
  clock.advance(999);
  await flush();
  assert.equal(calls, 1, 'no request during the cooldown');
  clock.advance(1);
  assert.equal((await pending).status, 'accepted');
  assert.equal(calls, 3);
});

test('the composition root runs one decider job at a time; an aborted queued job sends nothing', async t => {
  assert.equal(DECIDER_LIMITS.concurrency, 1);
  const clock = fakeClock();
  let release;
  const transport = fakeDecider((request, count) => count === 1
    ? new Promise(resolve => { release = () => resolve(jsonResponse(deciderValue(request))); })
    : jsonResponse(deciderValue(request)));
  const service = deciderService(t, transport.fetchImpl, { clock });
  const first = service.classify(input());
  await flush();
  const controller = new AbortController();
  const queued = service.classify(input({ signal: controller.signal }));
  await flush();
  assert.equal(service.stats().active, 1);
  assert.equal(service.stats().queued, 1);
  assert.equal(transport.calls.length, 1);
  controller.abort(new Error('RAW_ERROR_DO_NOT_ECHO'));
  assert.equal((await queued).diagnostics.code, 'cancelled');
  release();
  await first;
  await flush();
  // The first job made A and B. The aborted job made no request.
  assert.equal(transport.calls.length, 2);
  assert.equal(service.stats().queued, 0);
});

test('the decider limits have the expected values', () => {
  assert.deepEqual({ ...DECIDER_LIMITS }, { eventDeadlineMs: 5000, concurrency: 1, maxCandidates: 7, maxRequestBytes: 65536,
    activityTargetDeadlineMs: 5000 });
  // The target deadline comes from the provider limits. Jev keeps 1500 ms.
  assert.equal(activityTargetDeadline(deciderConfig()), 5000);
  assert.equal(activityTargetDeadline({ id: 'jev' }), 1500);
  assert.equal(activityTargetDeadline(undefined), 1500);
  assert.equal('activityTargetDeadlineMs' in decisionServiceOptions(deciderConfig()).limits, false);
  assert.equal('activityTargetDeadlineMs' in decisionServiceOptions({ id: 'jev' }).limits, false);
});

test('three events at the same time: one open request, and the 5000 ms deadline includes the queue time', async t => {
  const clock = fakeClock();
  let open = 0, maxOpen = 0;
  const sent = [];
  // Each stage gets its answer after 1500 ms of fake time.
  const fetchImpl = (_url, options) => {
    const request = JSON.parse(options.body);
    sent.push({ at: clock.now(), stage: request.questions.a_activity ? 'A' : 'B' });
    open++;
    maxOpen = Math.max(maxOpen, open);
    return new Promise((resolve, reject) => {
      const done = () => { open--; options.signal.removeEventListener('abort', onAbort); };
      const timer = clock.setTimeout(() => { done(); resolve(jsonResponse(deciderValue(request))); }, 1500);
      function onAbort() {
        clock.clearTimeout(timer);
        done();
        reject(options.signal.reason);
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const service = deciderService(t, fetchImpl, { clock });
  const pending = [service.classify(input()), service.classify(input()), service.classify(input())];
  for (let elapsed = 0; elapsed < 7000; elapsed += 100) {
    await flush();
    clock.advance(100);
  }
  await flush();
  const [first, second, third] = await Promise.all(pending);
  assert.equal(maxOpen, 1, 'the fake fetch never has more than one open request');
  assert.equal(open, 0);
  assert.equal(first.status, 'accepted');
  // The second event starts at 3000 ms. Its stage B is still open at 5000 ms.
  assert.equal(second.status, 'timeout');
  assert.equal(second.diagnostics.code, 'deadline_exceeded');
  // The third event waits in the queue past 5000 ms and sends nothing.
  assert.equal(third.status, 'timeout');
  assert.equal(third.diagnostics.code, 'deadline_exceeded');
  assert.equal(third.diagnostics.calls, 0);
  assert.equal(third.diagnostics.trace.requests.some(entry => entry.dispatched), false);
  assert.deepEqual(sent, [{ at: 0, stage: 'A' }, { at: 1500, stage: 'B' }, { at: 3000, stage: 'A' }, { at: 4500, stage: 'B' }]);
  assert.equal(sent.some(entry => entry.at >= DECIDER_LIMITS.eventDeadlineMs), false, 'nothing is sent after 5000 ms');
});

test('a request above maxRequestBytes stops locally as request_too_large', async t => {
  const transport = fakeDecider();
  // Each quote becomes two bytes in JSON, thus 7 candidates are above 65536 bytes.
  const text = '"'.repeat(5000);
  const service = deciderService(t, transport.fetchImpl);
  const candidates = Array.from({ length: DECIDER_LIMITS.maxCandidates }, (_, index) => candidate(`c${index + 1}`, { text }));
  const result = await service.classify(input({ candidates }));
  assert.equal(result.diagnostics.code, 'request_too_large');
  assert.ok(result.diagnostics.trace.requests[0].requestBytes > DECIDER_LIMITS.maxRequestBytes);
  assert.equal(transport.calls.length, 0, 'no source leaves the machine');
});

test('a window 422 below the byte cap fails the event closed and starts no cooldown', async t => {
  const clock = fakeClock();
  const transport = fakeDecider((request, count) => count === 1
    ? new Response(JSON.stringify({ detail: 'prompt of 4200 tokens exceeds the context window of 4096 tokens',
      code: 'context_window_exceeded' }), { status: 422 })
    : jsonResponse(deciderValue(request)));
  const service = deciderService(t, transport.fetchImpl, { clock });
  const rejected = await service.classify(input({ candidates: [candidate(), candidate('c2')] }));
  // 1. Fail closed: no accepted result, no nodes, no edges for this event.
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.diagnostics.code, 'request_too_large');
  assert.ok(rejected.diagnostics.trace.requests[0].requestBytes < DECIDER_LIMITS.maxRequestBytes);
  assert.equal(rejected.diagnostics.trace.requests[0].httpStatus, 422);
  assert.deepEqual([rejected.nodes, rejected.edges], [[], []]);
  assert.equal(transport.calls.length, 1, 'no stage B after a refused stage A');
  // 2. No cooldown: the next event goes to the server at once.
  assert.equal(service.stats().cooldownRemainingMs, 0);
  const next = service.classify(input({ candidates: [candidate(), candidate('c2')] }));
  await flush();
  // The fake clock does not move, thus a request here was sent with no wait.
  assert.ok(transport.calls.length >= 2, 'the next request is sent with no wait');
  assert.equal((await next).status, 'accepted');
});

test('an HTTP 503 from the server goes to the overloaded cooldown path', async t => {
  const clock = fakeClock();
  const transport = fakeDecider((request, count) => count === 1
    ? new Response(JSON.stringify({ detail: 'busy', code: 'busy' }), { status: 503, headers: { 'retry-after': '1' } })
    : jsonResponse(deciderValue(request)));
  const service = deciderService(t, transport.fetchImpl, { clock });
  const rejected = await service.classify(input());
  assert.equal(rejected.status, 'overloaded');
  assert.equal(rejected.diagnostics.code, 'remote_cooldown');
  assert.equal(rejected.diagnostics.trace.requests[0].httpStatus, 503);
  assert.equal(service.stats().cooldownRemainingMs, 1000);
});

test('the decider service sends no more than maxCandidates candidates', async t => {
  const transport = fakeDecider();
  const service = deciderService(t, transport.fetchImpl);
  const candidates = Array.from({ length: 8 }, (_, index) => candidate(`c${index + 1}`));
  const result = await service.classify(input({ candidates }));
  assert.equal(result.diagnostics.candidatesOmitted, 8 - DECIDER_LIMITS.maxCandidates);
  assert.equal(Object.keys(transport.calls[0].request.questions).filter(id => id.startsWith('a_relevant_')).length,
    DECIDER_LIMITS.maxCandidates);
});

test('score questions with more than 10 levels stop locally (shared shape guard)', async () => {
  const transport = fakeDecider();
  const provider = createDeciderProvider({ transmitSource: true, fetchImpl: transport.fetchImpl });
  const levels = Array.from({ length: 11 }, (_, index) => `Level ${index}`);
  assert.throws(() => provider.encode({ state: {}, questions: {
    s: { type: 'score', instructions: { question: 'Rate it.' }, criteria: levels },
  } }), error => error instanceof DecisionFault && error.code === 'unsupported_capability' && error.status === 'abstained');
  assert.ok(provider.encode({ state: {}, questions: {
    s: { type: 'score', instructions: { question: 'Rate it.' }, criteria: levels.slice(0, 10) },
  } }));
  assert.equal(transport.calls.length, 0);
});

test('an abort during the request settles as cancelled', async () => {
  const controller = new AbortController();
  const provider = createDeciderProvider({ transmitSource: true, fetchImpl: () => new Promise(() => {}) });
  const pending = provider.execute(provider.encode(booleanRequest), { signal: controller.signal, maxResponseBytes: 1024 });
  controller.abort(new Error('RAW_ERROR'));
  await assert.rejects(pending, error => error instanceof DecisionFault && error.code === 'cancelled');
  const ok = createDeciderProvider({ transmitSource: true, fetchImpl: async (_url, options) => booleanAnswer(options.body) });
  assert.equal((await ok.execute(ok.encode(booleanRequest),
    { signal: new AbortController().signal, maxResponseBytes: 1024 })).answers.q.probability, 0.9);
});
