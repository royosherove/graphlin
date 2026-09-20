import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDecisionService, createFixtureTransport, DEFAULT_LIMITS } from '../../runtime/jev/index.mjs';
import {
  candidate, proposal, event, policy, wireEvent, input, makeCore, responseValue,
  jsonResponse, recordingTransport, fakeClock, flush, stalledBody, MODEL,
} from './helpers.mjs';

const makeService = (t, options = {}) => {
  const service = createDecisionService({
    apiKey: 'test-key-never-sent-to-network', ...makeCore(), ...options,
  });
  t.after(() => service.close());
  return service;
};
const projection = c => ({
  code: c.text, sourceClass: c.sourceClass, complete: c.complete,
});

test('exact A/B wire bodies, HTTP options, materializer identity, and provenance', async t => {
  const core = makeCore();
  const transport = recordingTransport();
  const service = makeService(t, { ...core, ...transport });
  const result = await service.classify(input({
    event: { ...event, command: 'NEVER_TRANSMIT_COMMAND', graph: 'NEVER_TRANSMIT_GRAPH' },
  }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.bundle, core.calls.bundle);
  assert.equal(core.calls.proposals[0].bundle, result.bundle);
  assert.deepEqual(core.calls.materialize[0].verdicts, [{
    candidateId: 'c1', digest: candidate().digest, relevant: 0.97, sensitive: 0.01,
  }]);
  assert.equal(core.calls.materialize[0].intakePolicy.sensitiveMax, 0.1);
  assert.equal(core.calls.materialize[0].intakePolicy.relevantMin, 0.5);
  assert.ok(Object.isFrozen(result.bundle.candidates[0]));
  assert.equal(transport.calls.length, 2);
  for (const [i, stage] of ['A', 'B'].entries()) {
    const { url, options, request } = transport.calls[i];
    const expected = JSON.parse(await readFile(new URL(`./fixtures/request-${stage}.json`, import.meta.url)));
    assert.deepEqual(request, expected);
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, {
      authorization: 'Bearer test-key-never-sent-to-network', 'content-type': 'application/json',
    });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(result.stages[stage].inputHash,
      createHash('sha256').update(options.body).digest('hex'));
    assert.equal(result.stages[stage].mode, 'live');
    assert.equal(result.stages[stage].model, MODEL);
    assert.equal(result.stages[stage].rubricVersion,
      stage === 'A' ? 'intake-v3' : 'architecture-v6');
  }
  assert.equal(transport.calls[0].options.signal, transport.calls[1].options.signal);
  assert.deepEqual(result.diagnostics.usage, { input_tokens: 200, output_tokens: 20 });
  assert.equal(result.diagnostics.usageIncomplete, false);
  assert.equal(service.stats().calls, 2);
  assert.equal(service.stats().callsA, 1);
  assert.equal(service.stats().callsB, 1);
  assert.equal(result.nodes[0].roleProbability, 0.94);
  assert.equal(result.nodes[0].roleConfidence, 0.95);
});

test('sensitivity excludes entire candidate including label and copied context before B', async t => {
  const secret = candidate('private', { label: 'WITHHELD_LABEL', text: 'WITHHELD_CONTEXT' });
  const transport = recordingTransport((value, _request, call) => {
    if (call === 1) value.answers.a_sensitive_1.noul = 0.11;
    return value;
  });
  const service = makeService(t, transport);
  const result = await service.classify(input({ candidates: [candidate(), secret] }));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(transport.calls[0].request.state.evidence, [candidate(), secret].map(projection));
  assert.deepEqual(transport.calls[0].request.state.entities, [
    { name: 'saveNote', sourceIndex: 0 }, { name: 'WITHHELD_LABEL', sourceIndex: 1 },
  ]);
  assert.deepEqual(transport.calls[1].request.state.evidence, [projection(candidate())]);
  assert.deepEqual(transport.calls[1].request.state.entities, [{ name: 'saveNote', sourceIndex: 0 }]);
  for (const text of [transport.calls[1].options.body, JSON.stringify(result)]) {
    assert.doesNotMatch(text, /WITHHELD_LABEL|WITHHELD_CONTEXT|"private"/);
  }
});

test('A threshold boundaries and no approved bundle short circuit B', async t => {
  for (const [sensitive, relevant, expected] of [[0.1, 0.5, 2], [0.1001, 0.9, 1], [0.01, 0.499, 1]]) {
    const transport = recordingTransport((value, _req, call) => {
      if (call === 1) {
        value.answers.a_sensitive_0.noul = sensitive;
        value.answers.a_relevant_0.noul = relevant;
      }
      return value;
    });
    const core = makeCore();
    const service = makeService(t, { ...transport, ...core });
    const result = await service.classify(input());
    assert.equal(transport.calls.length, expected);
    if (expected === 1) {
      assert.equal(result.status, 'irrelevant');
      assert.equal(result.diagnostics.code, 'no_approved_candidates');
      assert.deepEqual(result.bundle.candidates, []);
      assert.equal(core.calls.proposals.length, 0);
    }
  }
});

test('snapshot protects the exact A to B materializer input from caller mutation', async t => {
  const source = candidate();
  const transport = recordingTransport((value, _req, count) => {
    if (count === 1) {
      source.text = 'MUTATED_AFTER_A';
      source.label = 'MUTATED_AFTER_A';
      source.sourceRef.hash = 'MUTATED_AFTER_A';
    }
    return value;
  });
  const result = await makeService(t, transport).classify(input({ candidates: [source] }));
  assert.equal(result.status, 'accepted');
  assert.doesNotMatch(JSON.stringify(result.bundle), /MUTATED_AFTER_A/);
  assert.doesNotMatch(transport.calls[1].options.body, /MUTATED_AFTER_A/);
});

test('materializer bypass, changed copies, policy and read-set mismatch fail closed', async t => {
  for (const corrupt of [
    bundle => { bundle.candidates[0] = { ...bundle.candidates[0], label: 'REINTRODUCED' }; },
    bundle => { bundle.policyVersion = 'old-policy'; },
    bundle => { bundle.readSet[0].hash = 'wrong-hash'; },
    bundle => { bundle.candidates.push(bundle.candidates[0]); },
  ]) {
    const core = makeCore();
    const transport = recordingTransport();
    const result = await makeService(t, {
      ...transport, ...core,
      materializeBundle(args) {
        const bundle = core.materializeBundle(args);
        corrupt(bundle);
        return bundle;
      },
    }).classify(input());
    assert.equal(result.status, 'invalid');
    assert.equal(result.bundle, null);
    assert.equal(transport.calls.length, 1);
  }
  const core = makeCore();
  const transport = recordingTransport(value => {
    if (value.answers.a_sensitive_0) value.answers.a_sensitive_0.noul = 1;
    return value;
  });
  const result = await makeService(t, {
    ...transport, ...core,
    materializeBundle(args) {
      return core.materializeBundle({ ...args,
        verdicts: args.verdicts.map(v => ({ ...v, sensitive: 0 })) });
    },
  }).classify(input());
  assert.equal(result.diagnostics.code, 'invalid_bundle');
  assert.equal(transport.calls.length, 1);
});

test('Noul pair judgments keep reads/writes distinct; missing context blocks edge admission', async t => {
  const proposals = [
    proposal('read', { relation: 'reads' }), proposal('write'),
    proposal('call', { relation: 'calls' }),
  ];
  const core = makeCore({ proposals });
  const transport = recordingTransport((value, request) => {
    if (request.questions.b_relation_0) {
      value.answers.b_relation_0.noul = 0.02;
      value.answers.b_context_2.noul = 0.8;
    }
    return value;
  });
  const result = await makeService(t, { ...core, ...transport })
    .classify(input({ candidates: [candidate(), candidate('c2')] }));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.edges.map(e => [e.relation, e.classification]),
    [['reads', 'tentative'], ['writes', 'accepted'], ['calls', 'tentative']]);
  assert.equal(result.edges[2].missingContextProbability, 0.8);
  const b = transport.calls[1].request;
  for (const [i, p] of proposals.entries()) {
    for (const prefix of ['b_relation_', 'b_context_']) {
      const question = b.questions[prefix + i];
      assert.equal(question.type, 'noul');
      assert.ok(question.instructions.question.includes('`entities[0].name`'));
      assert.ok(question.instructions.question.includes('`entities[1].name`'));
      assert.ok(question.instructions.question.includes('`evidence[0].code`, `evidence[1].code`'));
      assert.ok(question.instructions.question.includes(`relation "${p.relation}"`));
    }
    assert.match(b.questions[`b_relation_${i}`].instructions.focus, /mock/);
    assert.match(b.questions[`b_context_${i}`].instructions.question, /missing/);
  }
  assert.match(b.questions.b_relation_0.instructions.focus, /read is not a write/);
  assert.match(b.questions.b_relation_1.instructions.focus, /read is not a write/);
  assert.deepEqual(b.state.proposals, proposals.map(p => ({
    sourceEntityIndex: 0, targetEntityIndex: 1, relation: p.relation, evidenceIndices: [0, 1],
  })));
});

test('unknown roles, weak support, ambiguous choices, and incomplete capture stay tentative', async t => {
  const cases = [
    { alter(value) {
      value.answers.b_role_0.choice = 'unknown';
      value.answers.b_role_0.probabilities = Object.fromEntries(
        Object.keys(value.answers.b_role_0.probabilities).map(role => [role, role === 'unknown' ? 1 : 0]));
    } },
    { alter(value) { value.answers.b_support_0.noul = 0.7; } },
    { alter(value) { value.answers.b_role_0.confidence = 0.2; } },
    { alter(value) {
      value.answers.b_role_0.probabilities.module = 0.55;
      value.answers.b_role_0.probabilities.unknown = 0.45;
    } },
    { candidate: candidate('c1', { complete: false }) },
    { event: { ...event, incomplete: true } },
    { event: { ...event, incomplete: undefined } },
  ];
  for (const fixture of cases) {
    const transport = recordingTransport((value, req) => {
      if (req.questions.b_role_0) fixture.alter?.(value);
      return value;
    });
    const result = await makeService(t, transport).classify(input({
      candidates: [fixture.candidate ?? candidate()], event: fixture.event ?? event,
    }));
    assert.equal(result.status, 'abstained');
    assert.equal(result.nodes[0].classification, 'tentative');
  }
});

test('public-intent refs survive exactly; Jev never asserts runtime verification', async t => {
  const c = candidate('c1', { sourceClass: 'public_intent',
    sourceRef: { type: 'message', messageId: 'message-1', hash: 'hash-1', contentVersion: 1 } });
  const transport = recordingTransport();
  const result = await makeService(t, transport).classify(input({ candidates: [c] }));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.bundle.readSet, [c.sourceRef]);
  assert.equal(result.bundle.candidates[0].sourceClass, 'public_intent');
  assert.equal('evidenceState' in result.nodes[0], false);
  assert.equal('validity' in result.nodes[0], false);
  assert.match(transport.calls[1].request.questions.b_support_0.criteria.true, /explicit proposal/);
});

test('B can decline relevance while preserving activity and approved bundle', async t => {
  const transport = recordingTransport((value, req) => {
    if (req.questions.b_relevance) value.answers.b_relevance.noul = 0.29;
    return value;
  });
  const result = await makeService(t, transport).classify(input());
  assert.equal(result.status, 'irrelevant');
  assert.equal(result.activity, 'implement');
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
});

test('all required answers and distributions are validated before downstream use', async t => {
  const corruptions = [
    value => { delete value.answers.a_sensitive_0; },
    value => { value.answers.extra = { type: 'noul', noul: 0 }; },
    value => { value.answers.a_sensitive_0.noul = null; },
    value => { value.answers.a_sensitive_0.noul = 1.1; },
    value => { value.answers.a_sensitive_0.type = 'choice'; },
    value => { value.answers.a_activity.choice = 'invented-role'; },
    value => { value.answers.a_activity.choice = 'inspect'; },
    value => { delete value.answers.a_activity.probabilities.other; },
    value => { value.answers.a_activity.probabilities.other = 0.5; },
    value => { value.answers.a_activity.confidence = '0.9'; },
    value => { value.model = 'unexpected-model-body-string'; },
    value => { value.usage.output_tokens = -1; },
  ];
  for (const corrupt of corruptions) {
    const core = makeCore();
    const transport = recordingTransport(value => { corrupt(value); return value; });
    const result = await makeService(t, { ...core, ...transport }).classify(input());
    assert.equal(result.status, 'invalid');
    assert.equal(result.bundle, null);
    assert.equal(transport.calls.length, 1);
    assert.equal(core.calls.materialize.length, 0);
    assert.deepEqual(result.stages, {});
    assert.equal(result.diagnostics.usageIncomplete, true);
    assert.doesNotMatch(JSON.stringify(result), /unexpected-model-body-string|invented-role/);
  }
});

test('invalid B yields no fabricated judgments and retains only valid A provenance', async t => {
  const transport = recordingTransport((value, req) => {
    if (req.questions.b_role_0) delete value.answers.b_support_0;
    return value;
  });
  const result = await makeService(t, transport).classify(input());
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(Object.keys(result.stages), ['A']);
  assert.equal(result.diagnostics.usageIncomplete, true);
});

test('missing key, disabled transmission, expired work, invalid input, and two-request reservation skip calls', async t => {
  const transport = recordingTransport();
  const clock = fakeClock(100);
  for (const [options, payload, status, code] of [
    [{ apiKey: undefined }, input(), 'unavailable', 'missing_key'],
    [{}, input({ policy: { ...policy, transmitSource: false } }), 'abstained', 'metadata_only'],
    [{}, input({ deadlineAt: 100 }), 'timeout', 'deadline_exceeded'],
    [{}, input({ deadlineAt: NaN }), 'invalid', 'invalid_deadline'],
    [{}, input({ signal: {} }), 'invalid', 'invalid_signal'],
    [{}, null, 'invalid', 'invalid_input'],
    [{ limits: { maxRequestsPerEvent: 1 } }, input(), 'abstained', 'request_budget'],
    [{}, input({ candidates: [] }), 'irrelevant', 'no_candidates'],
    [{ limits: { maxQuestionsPerStage: 2 } }, input(), 'abstained', 'question_budget'],
  ]) {
    const service = makeService(t, { ...transport, clock, ...options });
    const result = await service.classify(payload);
    assert.equal(result.status, status);
    assert.equal(result.diagnostics.code, code);
    assert.equal(result.diagnostics.calls, 0);
  }
  assert.equal(transport.calls.length, 0);
});

test('request bytes are bounded using UTF-8 size before any transport attempt', async t => {
  const transport = recordingTransport();
  const service = makeService(t, { ...transport, limits: { maxRequestBytes: 1000 } });
  const result = await service.classify(input());
  assert.equal(result.status, 'abstained');
  assert.equal(result.diagnostics.code, 'request_too_large');
  assert.equal(service.stats().calls, 0);
  const tooLarge = await makeService(t, transport).classify(input({
    candidates: [candidate('c1', { text: '界'.repeat(3000) })],
  }));
  assert.equal(tooLarge.status, 'invalid');
  assert.equal(transport.calls.length, 0);
});

test('candidate and relation bounds enforce 1+2C+2R within 40; omissions are counted', async t => {
  const candidates = Array.from({ length: 16 }, (_, i) => candidate(`c${i + 1}`));
  const relations = ['calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on'];
  const proposals = Array.from({ length: 12 }, (_, i) => proposal(`p${i}`, {
    targetCandidateId: `c${2 + Math.floor(i / 6)}`, relation: relations[i % 6],
    evidenceCandidateIds: ['c1', `c${2 + Math.floor(i / 6)}`],
  }));
  const core = makeCore({ proposals });
  const transport = recordingTransport();
  const result = await makeService(t, { ...core, ...transport }).classify(input({ candidates }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.bundle.candidates.length, 12);
  assert.equal(result.edges.length, 7);
  assert.equal(core.calls.proposals[0].limits.maxProposals, 7);
  assert.deepEqual(result.diagnostics.questionCounts, { A: 25, B: 39 });
  assert.equal(result.diagnostics.candidatesOmitted, 4);
  assert.equal(result.diagnostics.proposalsOmitted, 5);
  assert.equal(DEFAULT_LIMITS.maxQuestionsPerStage, 40);
});

test('out-of-bundle relation endpoints and evidence never enter B', async t => {
  for (const p of [
    proposal('p', { targetCandidateId: 'excluded' }),
    proposal('p', { evidenceCandidateIds: ['excluded'] }),
    proposal('p', { evidenceCandidateIds: ['c1'] }),
    proposal('p', { targetCandidateId: 'c1' }),
    proposal('p', { relation: 'invented' }),
  ]) {
    const transport = recordingTransport();
    const result = await makeService(t, { ...transport, ...makeCore({ proposals: [p] }) })
      .classify(input({ candidates: [candidate(), candidate('c2')] }));
    assert.equal(result.diagnostics.code, 'invalid_proposal');
    assert.equal(transport.calls.length, 1);
  }
});

test('one absolute deadline includes a stalled A response body', async t => {
  const clock = fakeClock();
  const stream = stalledBody();
  const service = makeService(t, { clock, fetchImpl: async () => stream.response });
  const pending = service.classify(input({ deadlineAt: 1700 }));
  await flush();
  assert.equal(service.stats().calls, 1);
  clock.advance(1699);
  await flush();
  assert.equal(service.stats().completed, 0);
  clock.advance(1);
  const result = await pending;
  await flush();
  assert.equal(result.status, 'timeout');
  assert.equal(result.diagnostics.durationMs, 1700);
  assert.deepEqual(result.diagnostics.stageDurationMs, { A: 1700 });
  assert.equal(stream.cancelled, true);
  assert.equal(service.stats().active, 0);
  assert.equal(clock.timers, 0);
});

test('A time consumes B body budget; later caller deadline never extends 2000ms', async t => {
  const clock = fakeClock();
  const stream = stalledBody();
  let calls = 0;
  const service = makeService(t, { clock, fetchImpl: async (_url, options) => {
    calls++;
    if (calls === 2) return stream.response;
    clock.advance(1400);
    return jsonResponse(responseValue(JSON.parse(options.body)));
  } });
  const pending = service.classify(input({ deadlineAt: 50_000 }));
  await flush();
  assert.equal(calls, 2);
  clock.advance(599);
  await flush();
  assert.equal(service.stats().completed, 0);
  clock.advance(1);
  const result = await pending;
  await flush();
  assert.equal(result.status, 'timeout');
  assert.equal(result.diagnostics.durationMs, 2000);
  assert.deepEqual(result.diagnostics.stageDurationMs, { A: 1400, B: 600 });
  assert.deepEqual(Object.keys(result.stages), ['A']);
  assert.equal(stream.cancelled, true);
});

test('slow materialization cannot dispatch B after deadline', async t => {
  const clock = fakeClock();
  const transport = recordingTransport();
  const core = makeCore();
  const service = makeService(t, { ...transport, ...core, clock, materializeBundle(args) {
    clock.advance(2000);
    return core.materializeBundle(args);
  } });
  const result = await service.classify(input());
  assert.equal(result.status, 'timeout');
  assert.equal(transport.calls.length, 1);
});

test('bounded queue, queued expiry, and cancellation of transports ignoring AbortSignal', async t => {
  const clock = fakeClock();
  const service = makeService(t, { clock, limits: { concurrency: 1, maxQueue: 1 },
    fetchImpl: () => new Promise(() => {}) });
  const first = service.classify(input());
  await flush();
  const second = service.classify(input({ deadlineAt: 100 }));
  const third = await service.classify(input());
  assert.equal(third.status, 'overloaded');
  assert.equal(third.diagnostics.code, 'queue_full');
  assert.equal(service.stats().active, 1);
  assert.equal(service.stats().queued, 1);
  clock.advance(100);
  assert.equal((await second).status, 'timeout');
  assert.equal(service.stats().calls, 1);
  clock.advance(1900);
  assert.equal((await first).status, 'timeout');
  await flush();
  assert.equal(service.stats().active, 0);
  assert.equal(service.stats().queued, 0);
  assert.equal(clock.timers, 0);
});

test('queued work has only its remaining deadline, and zero-length queue still permits active work', async t => {
  const clock = fakeClock();
  let release;
  let calls = 0;
  const service = makeService(t, { clock, limits: { concurrency: 1, maxQueue: 1 },
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) await new Promise(resolve => { release = resolve; });
      if (calls === 3) return new Promise(() => {});
      return jsonResponse(responseValue(JSON.parse(options.body)));
    } });
  const first = service.classify(input());
  const second = service.classify(input());
  await flush();
  clock.advance(1300);
  release();
  assert.equal((await first).status, 'accepted');
  await flush();
  assert.equal(calls, 3);
  clock.advance(700);
  assert.equal((await second).diagnostics.durationMs, 2000);
  assert.equal(service.stats().callsB, 1);
  const zeroQueue = makeService(t, { clock, limits: { concurrency: 1, maxQueue: 0 },
    fetchImpl: () => new Promise(() => {}) });
  const work = zeroQueue.classify(input());
  assert.equal((await zeroQueue.classify(input())).diagnostics.code, 'queue_full');
  zeroQueue.close();
  assert.equal((await work).diagnostics.code, 'service_closed');
});

test('external cancellation and close settle active/queued work, using fixed diagnostics', async t => {
  const controller = new AbortController();
  const clock = fakeClock();
  const service = makeService(t, { clock, limits: { concurrency: 1 },
    fetchImpl: () => new Promise(() => {}) });
  const first = service.classify(input({ signal: controller.signal }));
  await flush();
  const queued = service.classify(input());
  controller.abort(new Error('RAW_ERROR_DO_NOT_ECHO'));
  assert.equal((await first).diagnostics.code, 'cancelled');
  service.close();
  assert.equal((await queued).diagnostics.code, 'service_closed');
  assert.equal((await service.classify(input())).diagnostics.code, 'service_closed');
  await flush();
  assert.equal(service.stats().active, 0);
  assert.equal(clock.timers, 0);
});

test('429 and 529 create bounded shared cooldown without retries', async t => {
  for (const status of [429, 529]) {
    const clock = fakeClock();
    let calls = 0;
    const service = makeService(t, { clock, fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) return new Response('RAW_ERROR_DO_NOT_ECHO', {
        status, headers: { 'retry-after-ms': '500' },
      });
      return jsonResponse(responseValue(JSON.parse(options.body)));
    } });
    const rejected = await service.classify(input());
    assert.equal(rejected.status, 'overloaded');
    assert.equal(rejected.diagnostics.code, 'remote_cooldown');
    assert.equal(rejected.diagnostics.calls, 1);
    assert.doesNotMatch(JSON.stringify(rejected), /RAW_ERROR/);
    const pending = service.classify(input());
    await flush();
    assert.equal(calls, 1);
    clock.advance(499);
    await flush();
    assert.equal(calls, 1);
    clock.advance(1);
    assert.equal((await pending).status, 'accepted');
    assert.equal(calls, 3);
    await flush();
    assert.equal(clock.timers, 0);
  }
});

test('long cooldown is capped; jobs may expire waiting without spending a call', async t => {
  const clock = fakeClock();
  const service = makeService(t, { clock, fetchImpl: async () => new Response(null, {
    status: 529, headers: { 'retry-after': '99999999' },
  }) });
  assert.equal((await service.classify(input())).status, 'overloaded');
  assert.equal(service.stats().cooldownRemainingMs, 30_000);
  const pending = service.classify(input());
  clock.advance(2000);
  assert.equal((await pending).status, 'timeout');
  assert.equal(service.stats().calls, 1);
  service.close();
  await flush();
  assert.equal(clock.timers, 0);
});

test('a sibling 429 delays B on an existing workflow; concurrency remains bounded', async t => {
  const clock = fakeClock();
  const held = [];
  let calls = 0;
  let inFlight = 0;
  let maximum = 0;
  const service = makeService(t, { clock, limits: { concurrency: 2, maxQueue: 1 },
    fetchImpl: (_url, options) => {
      calls++;
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      return new Promise(resolve => {
        held.push({
          request: JSON.parse(options.body),
          release(response) { inFlight--; resolve(response); },
        });
      });
    } });
  const first = service.classify(input());
  const second = service.classify(input());
  const third = service.classify(input());
  await flush();
  assert.equal(calls, 2);
  assert.equal(service.stats().queued, 1);
  held[0].release(new Response(null, { status: 429, headers: { 'retry-after-ms': '500' } }));
  assert.equal((await first).status, 'overloaded');
  held[1].release(jsonResponse(responseValue(held[1].request)));
  await flush();
  assert.equal(calls, 2, 'no B and no queued A during shared cooldown');
  clock.advance(500);
  await flush();
  assert.equal(calls, 4, 'one B plus one newly admitted A');
  assert.equal(service.stats().active, 2);
  for (const entry of held.slice(2)) entry.release(jsonResponse(responseValue(entry.request)));
  await flush();
  assert.equal(calls, 5);
  held[4].release(jsonResponse(responseValue(held[4].request)));
  assert.equal((await second).status, 'accepted');
  assert.equal((await third).status, 'accepted');
  await flush();
  assert.equal(maximum, 2);
  assert.equal(service.stats().active, 0);
  assert.equal(clock.timers, 0);
});

test('HTTP errors and thrown transport errors never echo bodies, keys, or arbitrary messages', async t => {
  for (const [status, expected] of [[401, 'unavailable'], [422, 'invalid'], [500, 'unavailable']]) {
    const service = makeService(t, { fetchImpl: async () => new Response('RAW_ERROR_SECRET', { status }) });
    const result = await service.classify(input());
    assert.equal(result.status, expected);
    assert.equal(service.stats().calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /RAW_ERROR_SECRET|test-key/);
  }
  const service = makeService(t, { fetchImpl: async () => { throw new Error('RAW_ERROR_SECRET'); } });
  assert.equal((await service.classify(input())).diagnostics.code, 'transport_failure');
});

test('endpoint allowlist only permits documented HTTPS or explicitly injected loopback tests', async t => {
  for (const endpoint of [
    'http://api.typesafe.ai/v1/systemone', 'https://example.org/v1/systemone',
    'https://api.typesafe.ai/v1/systemone?key=no', 'https://user:pass@api.typesafe.ai/v1/systemone',
    'http://127.0.0.1:12345/v1/systemone',
  ]) assert.throws(() => createDecisionService({ endpoint }), /invalid_endpoint/);
  assert.throws(() => createDecisionService({
    fetchImpl: async () => {}, endpoint: 'https://example.org/v1/systemone',
  }), /invalid_endpoint/);
  const transport = recordingTransport();
  const service = makeService(t, { ...transport, endpoint: 'http://127.0.0.1:12345/v1/systemone' });
  assert.equal((await service.classify(input())).status, 'accepted');
  assert.equal(transport.calls[0].url, 'http://127.0.0.1:12345/v1/systemone');
});

test('fixture factory is explicit, deterministic, offline, and marked as demo throughout', async t => {
  assert.throws(() => createFixtureTransport(), /fixture_requires_demo_mode/);
  assert.throws(() => createFixtureTransport({ mode: 'live' }), /fixture_requires_demo_mode/);
  const fetchImpl = createFixtureTransport({ mode: 'demo' });
  const service = makeService(t, { apiKey: undefined, fetchImpl,
    ...makeCore({ proposals: [proposal()] }) });
  const request = input({ candidates: [candidate(), candidate('c2')] });
  const result = await service.classify(request);
  assert.equal(result.status, 'accepted');
  assert.equal(result.edges[0].classification, 'accepted');
  assert.equal(result.diagnostics.mode, 'demo');
  assert.equal(result.stages.A.mode, 'demo');
  assert.equal(result.stages.B.mode, 'demo');
  assert.equal(service.stats().mode, 'demo');
  assert.deepEqual(result.diagnostics.usage, { input_tokens: 0, output_tokens: 0 });
  // Deliberately nonsensical text with a recorded label gives the same recording,
  // demonstrating why this must never be mistaken for model evaluation.
  const altered = await service.classify(input({ candidates: [
    candidate('c1', { text: 'arbitrary text is not interpreted' }), candidate('c2'),
  ] }));
  assert.deepEqual(altered.nodes, result.nodes);
  assert.deepEqual(altered.edges, result.edges);
  const unknown = await service.classify(input({ candidates: [candidate('x', { label: 'not recorded' })] }));
  assert.equal(unknown.status, 'irrelevant');
  assert.equal(unknown.diagnostics.calls, 1);
  assert.deepEqual(unknown.bundle.candidates, []);
});
