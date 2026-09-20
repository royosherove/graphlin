import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createDecisionService, DEFAULT_INTAKE_POLICY, DEFAULT_ADMISSION_POLICY,
} from '../../runtime/jev/index.mjs';
import { JevFault } from '../../runtime/jev/wire.mjs';
import { RUBRICS, ACTIVITIES, ROLES } from '../../runtime/jev/questions.mjs';
import {
  candidate, proposal, event, policy, input, makeCore, responseValue,
  jsonResponse, recordingTransport, fakeClock, flush, stalledBody, MODEL,
} from './helpers.mjs';

function service(t, options = {}) {
  const result = createDecisionService({
    apiKey: 'OFFLINE_API_KEY', ...makeCore(),
    fetchImpl: recordingTransport().fetchImpl, ...options,
  });
  t.after(() => result.close());
  return result;
}
const numericPolicy = value => Object.fromEntries(Object.entries(value)
  .filter(([key]) => key !== 'version'));
const auditId = (id, prefix = 'candidate') =>
  `${prefix}-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
const decision = value => value.diagnostics.trace;
function checkEmpty(trace, status, code) {
  assert.equal(trace.version, 1);
  assert.deepEqual(trace.outcome, { status, code });
  assert.equal(trace.activity, null);
  assert.equal(trace.relevance, null);
  for (const key of ['intake', 'nodes', 'edges', 'requests']) assert.deepEqual(trace[key], []);
}

test('audit records accepted predicates, effective policies and request metadata without changing judgments', async t => {
  const ids = ['candidate-' + 'a'.repeat(32), 'candidate-' + 'b'.repeat(32)];
  const candidates = ids.map(id => candidate(id));
  const p = proposal('proposal-' + 'c'.repeat(32), {
    sourceCandidateId: ids[0], targetCandidateId: ids[1], evidenceCandidateIds: ids,
  });
  const clock = fakeClock(100);
  const transport = recordingTransport((value, _request, count) => {
    clock.advance(count === 1 ? 7 : 11);
    return value;
  });
  const core = makeCore({ proposals: [p] });
  const result = await service(t, { clock, ...transport, ...core }).classify(input({ candidates }));
  const trace = decision(result);
  assert.equal(result.bundle, core.calls.bundle);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(trace.outcome, { status: 'accepted', code: 'ok' });
  assert.deepEqual(trace.activity, {
    choice: 'implement', confidence: 0.95,
    probabilities: Object.fromEntries(ACTIVITIES.map(activity =>
      [activity, activity === 'implement' ? 0.94 : activity === 'other' ? 0.06 : 0])),
  });
  assert.equal(result.activity, trace.activity.choice);
  assert.deepEqual(trace.thresholds, {
    intake: numericPolicy(DEFAULT_INTAKE_POLICY), admission: numericPolicy(DEFAULT_ADMISSION_POLICY),
  });
  assert.deepEqual(trace.intake, ids.map(candidateId => ({
    candidateId, relevant: 0.97, sensitive: 0.01,
    approved: true, reason: 'approved', materialized: true,
  })));
  assert.equal(trace.relevance, 0.97);
  assert.deepEqual(trace.nodes, result.nodes.map(node => ({ ...node, reasons: [] })));
  assert.deepEqual(Object.keys(trace.nodes[0].roleProbabilities), ROLES);
  assert.notEqual(trace.nodes[0].roleProbabilities, result.nodes[0].roleProbabilities);
  assert.deepEqual(trace.edges, result.edges.map(({ evidenceCandidateIds: _evidence, ...edge }) =>
    ({ ...edge, reasons: [] })));
  assert.deepEqual(trace.requests, transport.calls.map(({ options }, index) => ({
    stage: index ? 'B' : 'A', model: MODEL, rubricVersion: RUBRICS[index ? 'B' : 'A'],
    status: 'ok', code: 'ok', durationMs: index ? 11 : 7,
    dispatched: true, questionCount: index ? 7 : 5,
    requestBytes: Buffer.byteLength(options.body), httpStatus: 200,
    usage: { input_tokens: 100, output_tokens: 10 },
  })));
  assert.ok(Object.isFrozen(trace));
  assert.ok(Object.isFrozen(trace.activity));
  assert.ok(Object.isFrozen(trace.activity.probabilities));
  assert.ok(Object.isFrozen(trace.intake[0]));
  assert.ok(Object.isFrozen(trace.thresholds.admission));
  assert.ok(Object.isFrozen(trace.nodes[0].reasons));
  assert.ok(Object.isFrozen(trace.nodes[0].roleProbabilities));
  assert.ok(Object.isFrozen(trace.requests[0].usage));
});

test('intake logs both rejection predicates and inclusive boundaries before filtering candidates', async t => {
  const scores = [[0.1, 0.5], [0.1001, 0.9], [0.01, 0.499], [0.1001, 0.499]];
  const transport = recordingTransport((value, request) => {
    if (request.questions.a_activity) scores.forEach(([sensitive, relevant], i) => {
      value.answers[`a_sensitive_${i}`].noul = sensitive;
      value.answers[`a_relevant_${i}`].noul = relevant;
    });
    return value;
  });
  const result = await service(t, transport).classify(input({
    candidates: scores.map((_, i) => candidate(`c${i}`)),
  }));
  assert.deepEqual(decision(result).intake, scores.map(([sensitive, relevant], i) => ({
    candidateId: auditId(`c${i}`), relevant, sensitive, approved: i === 0,
    reason: ['approved', 'sensitive', 'irrelevant', 'sensitive_and_irrelevant'][i],
    materialized: i === 0,
  })));
  assert.deepEqual(result.nodes.map(n => n.candidateId), ['c0']);
});

test('shared evidence sensitivity is audited for every entity, with no B when none pass', async t => {
  const first = candidate();
  const second = candidate('c2', {
    artifactId: first.artifactId, hash: first.hash, sourceRef: first.sourceRef, text: first.text,
  });
  const transport = recordingTransport(value => {
    value.answers.a_sensitive_0.noul = 0.2;
    return value;
  });
  const result = await service(t, transport).classify(input({ candidates: [first, second] }));
  assert.equal(result.diagnostics.code, 'no_approved_candidates');
  assert.equal(decision(result).activity.choice, 'implement');
  assert.deepEqual(decision(result).intake.map(row => [row.sensitive, row.approved, row.reason]),
    [[0.2, false, 'sensitive'], [0.2, false, 'sensitive']]);
  assert.equal(decision(result).requests.length, 1);
  assert.equal(decision(result).requests[0].questionCount, 4);
  assert.equal(decision(result).relevance, null);
  assert.deepEqual(decision(result).nodes, []);
});

test('successful intake distinguishes downstream materializer exclusion from a rejected score', async t => {
  const result = await service(t, {
    materializeBundle() {
      return { id: 'empty-bundle', policyVersion: policy.version, candidates: [], readSet: [] };
    },
  }).classify(input());
  assert.equal(result.diagnostics.code, 'no_approved_candidates');
  assert.deepEqual(decision(result).intake[0], {
    candidateId: auditId('c1'), relevant: 0.97, sensitive: 0.01,
    approved: true, reason: 'approved', materialized: false,
  });
});

test('validated B scores survive irrelevant results without returning graph judgments', async t => {
  const transport = recordingTransport((value, request) => {
    if (request.questions.b_relevance) {
      value.answers.b_relevance.noul = 0.29;
      value.answers.b_support_0.noul = 0.84;
      value.answers.b_context_0.noul = 0.11;
    }
    return value;
  });
  const result = await service(t, { ...transport, ...makeCore({ proposals: [proposal()] }) })
    .classify(input({ candidates: [candidate(), candidate('c2')] }));
  const trace = decision(result);
  assert.equal(result.status, 'irrelevant');
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
  assert.equal(trace.relevance, 0.29);
  assert.equal(trace.nodes[0].supportProbability, 0.84);
  assert.equal(trace.nodes[0].classification, 'skipped');
  assert.deepEqual(Object.keys(trace.nodes[0].roleProbabilities), ROLES);
  assert.equal(trace.nodes[0].roleProbabilities.module, 0.94);
  assert.equal(trace.nodes[0].roleProbabilities.unknown, 0.06);
  assert.deepEqual(trace.nodes[0].reasons, ['insufficient_relevance', 'node_support_below_min']);
  assert.deepEqual(trace.nodes[1].reasons, ['insufficient_relevance']);
  assert.equal(trace.edges[0].classification, 'skipped');
  assert.equal(trace.edges[0].supportProbability, 0.97);
  assert.equal(trace.edges[0].missingContextProbability, 0.11);
  assert.deepEqual(trace.edges[0].reasons, [
    'insufficient_relevance', 'source_not_accepted', 'target_not_accepted', 'missing_context_above_max',
  ]);
  assert.ok(trace.intake.every(row => row.approved && row.materialized));
  assert.ok(trace.requests.every(row => row.status === 'ok'));
});

test('node audit reports every failed predicate rather than only the first one', async t => {
  const transport = recordingTransport((value, request) => {
    if (request.questions.b_role_0) {
      const role = value.answers.b_role_0;
      role.choice = 'unknown';
      role.confidence = 0.59;
      role.probabilities = Object.fromEntries(Object.keys(role.probabilities)
        .map(key => [key, key === 'unknown' ? 0.79 : key === 'module' ? 0.21 : 0]));
      value.answers.b_support_0.noul = 0.84;
    }
    return value;
  });
  const result = await service(t, transport).classify(input({
    candidates: [candidate('c1', { complete: false })], event: { ...event, incomplete: true },
  }));
  assert.equal(result.status, 'abstained');
  assert.equal(result.nodes[0].classification, 'tentative');
  assert.deepEqual(decision(result).nodes[0].reasons, [
    'candidate_incomplete', 'event_incomplete', 'unknown_role',
    'node_support_below_min', 'role_probability_below_min', 'role_confidence_below_min',
  ]);
});

test('edge audit distinguishes each endpoint, incomplete evidence, support and missing context', async t => {
  const transport = recordingTransport((value, request) => {
    if (request.questions.b_relation_0) {
      value.answers.b_support_0.noul = 0.84;
      value.answers.b_relation_0.noul = 0.84;
      value.answers.b_context_0.noul = 0.1001;
    }
    return value;
  });
  const result = await service(t, { ...transport, ...makeCore({ proposals: [proposal()] }) })
    .classify(input({ candidates: [candidate(), candidate('c2', { complete: false })] }));
  assert.deepEqual(decision(result).edges[0].reasons, [
    'source_not_accepted', 'target_not_accepted', 'evidence_incomplete',
    'edge_support_below_min', 'missing_context_above_max',
  ]);
  assert.equal(result.edges[0].classification, 'tentative');
});

test('effective custom thresholds have inclusive admission boundaries', async t => {
  const intakePolicy = { version: 'custom-intake', sensitiveMax: 0.2, relevantMin: 0.7 };
  const admissionPolicy = {
    version: 'custom-admission', relevanceMin: 0.6, nodeSupportMin: 0.7,
    roleProbabilityMin: 0.75, roleConfidenceMin: 0.65, edgeSupportMin: 0.8, missingContextMax: 0.2,
  };
  const transport = recordingTransport((value, request) => {
    for (const [key, answer] of Object.entries(value.answers)) {
      if (key.startsWith('a_sensitive_')) answer.noul = intakePolicy.sensitiveMax;
      if (key.startsWith('a_relevant_')) answer.noul = intakePolicy.relevantMin;
      if (key.startsWith('b_support_')) answer.noul = admissionPolicy.nodeSupportMin;
      if (key.startsWith('b_role_')) {
        answer.confidence = admissionPolicy.roleConfidenceMin;
        answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities)
          .map(role => [role, role === answer.choice ? 0.75 : role === 'unknown' ? 0.25 : 0]));
      }
    }
    if (request.questions.b_relevance) {
      value.answers.b_relevance.noul = admissionPolicy.relevanceMin;
      value.answers.b_relation_0.noul = admissionPolicy.edgeSupportMin;
      value.answers.b_context_0.noul = admissionPolicy.missingContextMax;
    }
    return value;
  });
  const result = await service(t, {
    ...transport, ...makeCore({ proposals: [proposal()] }), intakePolicy, admissionPolicy,
  }).classify(input({ candidates: [candidate(), candidate('c2')] }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.edges[0].classification, 'accepted');
  assert.deepEqual(decision(result).thresholds, {
    intake: numericPolicy(intakePolicy), admission: numericPolicy(admissionPolicy),
  });
  assert.ok([...decision(result).nodes, ...decision(result).edges].every(row => row.reasons.length === 0));
});

test('B validation failure preserves intake but never publishes partially validated scores', async t => {
  const transport = recordingTransport((value, request) => {
    if (request.questions.b_role_0) {
      value.answers.b_relevance.noul = 0.29;
      delete value.answers.b_support_0;
    }
    return value;
  });
  const result = await service(t, transport).classify(input());
  const trace = decision(result);
  assert.equal(result.status, 'invalid');
  assert.equal(trace.intake[0].approved, true);
  assert.equal(trace.activity.choice, 'implement');
  assert.equal(trace.relevance, null);
  assert.deepEqual(trace.nodes, []);
  assert.deepEqual(trace.requests.map(row => [row.stage, row.status, row.code]),
    [['A', 'ok', 'ok'], ['B', 'invalid', 'invalid_response']]);
  assert.equal(trace.requests[1].usage, null);
});

test('A validation failure publishes no unvalidated intake values', async t => {
  const transport = recordingTransport(value => {
    value.answers.a_sensitive_0.noul = 'RAW_RESPONSE_TEXT';
    return value;
  });
  const result = await service(t, transport).classify(input());
  assert.equal(decision(result).activity, null);
  assert.deepEqual(decision(result).intake, []);
  assert.equal(decision(result).requests[0].code, 'invalid_noul');
  assert.equal(decision(result).requests[0].usage, null);
  assert.doesNotMatch(JSON.stringify(decision(result)), /RAW_RESPONSE_TEXT/);
});

test('materializer failures retain A scores even before a bundle exists', async t => {
  for (const invalidBundle of [false, true]) {
    const result = await service(t, {
      materializeBundle() {
        if (invalidBundle) return { id: 'bad-bundle' };
        throw new Error('RAW_CORE_ERROR');
      },
    }).classify(input());
    const trace = decision(result);
    assert.equal(trace.intake[0].approved, true);
    assert.equal(trace.activity.choice, 'implement');
    assert.equal(trace.intake[0].materialized, null);
    assert.equal(trace.outcome.code, invalidBundle ? 'invalid_bundle' : 'decision_failure');
    assert.equal(trace.requests.length, 1);
    assert.equal(trace.requests[0].code, 'ok');
    assert.equal(result.bundle, null);
    assert.doesNotMatch(JSON.stringify(trace), /RAW_CORE_ERROR/);
  }
});

test('stalled A and B requests record terminal timeouts before request cleanup runs', async t => {
  for (const stalledStage of ['A', 'B']) {
    const clock = fakeClock();
    const stream = stalledBody();
    const s = service(t, {
      clock,
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        if ((request.questions.a_activity ? 'A' : 'B') === stalledStage) return stream.response;
        clock.advance(1400);
        return jsonResponse(responseValue(request));
      },
    });
    const pending = s.classify(input());
    await flush();
    clock.advance(stalledStage === 'A' ? 2000 : 600);
    const result = await pending;
    const trace = decision(result);
    const beforeCleanup = JSON.stringify(trace);
    assert.equal(result.status, 'timeout');
    assert.equal(trace.requests.length, stalledStage === 'A' ? 1 : 2);
    assert.deepEqual(trace.requests.at(-1), {
      stage: stalledStage, model: MODEL, rubricVersion: RUBRICS[stalledStage],
      status: 'timeout', code: 'deadline_exceeded',
      durationMs: stalledStage === 'A' ? 2000 : 600, dispatched: true,
      questionCount: 3, requestBytes: trace.requests.at(-1).requestBytes,
      httpStatus: 200, usage: null,
    });
    assert.ok(trace.requests.at(-1).requestBytes > 0);
    assert.equal(trace.intake.length, stalledStage === 'A' ? 0 : 1);
    if (stalledStage === 'A') assert.equal(trace.activity, null);
    else assert.equal(trace.activity.choice, 'implement');
    assert.equal(trace.relevance, null);
    if (stalledStage === 'B') {
      assert.equal(trace.intake[0].reason, 'approved');
      assert.equal(trace.requests[0].status, 'ok');
      assert.equal(trace.requests[0].durationMs, 1400);
    }
    await flush();
    assert.equal(stream.cancelled, true);
    assert.equal(JSON.stringify(trace), beforeCleanup);
    assert.equal(s.stats().active, 0);
  }
});

test('late transport resolution cannot mutate a published timeout audit', async t => {
  const clock = fakeClock();
  let release;
  const s = service(t, {
    clock, fetchImpl: (_url, options) => new Promise(resolve => {
      release = () => resolve(jsonResponse(responseValue(JSON.parse(options.body))));
    }),
  });
  const pending = s.classify(input());
  await flush();
  clock.advance(2000);
  const result = await pending;
  const before = JSON.stringify(decision(result));
  assert.equal(decision(result).requests[0].httpStatus, null);
  release();
  await flush();
  assert.equal(JSON.stringify(decision(result)), before);
  assert.equal(s.stats().calls, 1);
  assert.equal(s.stats().completed, 1);
});

test('timeout during materialization keeps successful A and its intake reasons', async t => {
  const clock = fakeClock();
  const pending = service(t, {
    clock, materializeBundle: () => new Promise(() => {}),
  }).classify(input());
  await flush();
  clock.advance(2000);
  const trace = decision(await pending);
  assert.equal(trace.outcome.code, 'deadline_exceeded');
  assert.equal(trace.activity.choice, 'implement');
  assert.equal(trace.intake[0].reason, 'approved');
  assert.equal(trace.intake[0].materialized, null);
  assert.equal(trace.requests.length, 1);
  assert.equal(trace.requests[0].code, 'ok');
});

test('cancellation and service close finalize active attempts using fixed codes', async t => {
  for (const close of [false, true]) {
    const clock = fakeClock();
    const controller = new AbortController();
    const s = service(t, { clock, fetchImpl: () => new Promise(() => {}) });
    const pending = s.classify(input({ signal: controller.signal }));
    await flush();
    clock.advance(25);
    if (close) s.close();
    else controller.abort(new Error('RAW_CANCEL_SECRET'));
    const trace = decision(await pending);
    assert.deepEqual(trace.outcome, { status: 'abstained', code: close ? 'service_closed' : 'cancelled' });
    assert.equal(trace.requests[0].code, trace.outcome.code);
    assert.equal(trace.requests[0].durationMs, 25);
    assert.doesNotMatch(JSON.stringify(trace), /RAW_CANCEL_SECRET/);
  }
});

test('HTTP, parse and transport failures expose only fixed outcomes and numeric HTTP status', async t => {
  const cases = [
    [async () => new Response('RAW_HTTP_SECRET', { status: 401 }), 'unavailable', 'authentication_failed', 401],
    [async () => new Response('RAW_HTTP_SECRET', { status: 422 }), 'invalid', 'request_rejected', 422],
    [async () => new Response('RAW_HTTP_SECRET', { status: 529 }), 'overloaded', 'remote_cooldown', 529],
    [async () => new Response('RAW_HTTP_SECRET', { status: 500 }), 'unavailable', 'http_error', 500],
    [async () => new Response('RAW_HTTP_SECRET'), 'invalid', 'invalid_json', 200],
    [async () => { throw new Error('RAW_TRANSPORT_SECRET'); }, 'unavailable', 'transport_failure', null],
    [async () => ({ status: 'RAW_STATUS_SECRET' }), 'invalid', 'invalid_http_response', null],
  ];
  for (const [fetchImpl, status, code, httpStatus] of cases) {
    const trace = decision(await service(t, { fetchImpl }).classify(input()));
    assert.deepEqual(trace.outcome, { status, code });
    assert.equal(trace.requests[0].status, status);
    assert.equal(trace.requests[0].code, code);
    assert.equal(trace.requests[0].httpStatus, httpStatus);
    assert.equal(trace.requests[0].usage, null);
    assert.doesNotMatch(JSON.stringify(trace), /RAW_|OFFLINE_API_KEY/);
  }
});

test('an injected JevFault cannot put arbitrary status or error text into the audit', async t => {
  const result = await service(t, {
    fetchImpl: async () => { throw new JevFault('RAW_FAULT_SECRET', 'RAW_STATUS_SECRET'); },
  }).classify(input());
  assert.deepEqual(decision(result).outcome, { status: 'unavailable', code: 'decision_failure' });
  assert.equal(decision(result).requests[0].code, 'decision_failure');
  assert.doesNotMatch(JSON.stringify(decision(result)), /RAW_|OFFLINE_API_KEY/);
});

test('immediate rejections have explicit audit outcomes without invented request attempts', async t => {
  const clock = fakeClock(100);
  const cases = [
    [{ apiKey: undefined }, input(), 'unavailable', 'missing_key'],
    [{}, input({ policy: { ...policy, transmitSource: false } }), 'abstained', 'metadata_only'],
    [{}, input({ deadlineAt: 100 }), 'timeout', 'deadline_exceeded'],
    [{}, input({ deadlineAt: NaN }), 'invalid', 'invalid_deadline'],
    [{}, input({ signal: {} }), 'invalid', 'invalid_signal'],
    [{}, null, 'invalid', 'invalid_input'],
    [{ limits: { maxRequestsPerEvent: 1 } }, input(), 'abstained', 'request_budget'],
    [{}, input({ candidates: [] }), 'irrelevant', 'no_candidates'],
    [{}, input({ candidates: [candidate('c1', { label: 'x'.repeat(257) })] }), 'invalid', 'invalid_candidate'],
    [{ limits: { maxQuestionsPerStage: 2 } }, input(), 'abstained', 'question_budget'],
  ];
  for (const [options, value, status, code] of cases) {
    checkEmpty(decision(await service(t, { ...options, clock }).classify(value)), status, code);
  }
  const closed = service(t);
  closed.close();
  checkEmpty(decision(await closed.classify(input())), 'abstained', 'service_closed');
});

test('queue overload and queued expiry have no fabricated calls', async t => {
  const clock = fakeClock();
  const s = service(t, {
    clock, limits: { concurrency: 1, maxQueue: 1 }, fetchImpl: () => new Promise(() => {}),
  });
  const first = s.classify(input());
  await flush();
  const queued = s.classify(input({ deadlineAt: 100 }));
  checkEmpty(decision(await s.classify(input())), 'overloaded', 'queue_full');
  clock.advance(100);
  checkEmpty(decision(await queued), 'timeout', 'deadline_exceeded');
  s.close();
  await first;
});

test('request size rejection is visible as an attempted stage with zero dispatched calls', async t => {
  const transport = recordingTransport();
  const result = await service(t, { ...transport, limits: { maxRequestBytes: 1000 } }).classify(input());
  const trace = decision(result);
  assert.equal(trace.outcome.code, 'request_too_large');
  assert.equal(trace.requests[0].stage, 'A');
  assert.equal(trace.requests[0].dispatched, false);
  assert.equal(trace.requests[0].questionCount, 3);
  assert.ok(trace.requests[0].requestBytes > 1000);
  assert.equal(trace.requests[0].httpStatus, null);
  assert.equal(trace.requests[0].code, 'request_too_large');
  assert.equal(result.diagnostics.calls, 0);
  assert.equal(transport.calls.length, 0);
});

test('all audit strings come from finite metadata or opaque IDs, never candidate or response text', async t => {
  const secretId = 'cache.ts';
  const secondId = 'SENSITIVE_ID_TEXT';
  const candidates = [
    candidate(secretId, {
      label: 'LABEL_SECRET', text: 'SOURCE_SECRET',
      relativePath: '/private/PATH_SECRET/cache.ts', notes: 'PROMPT_SECRET',
    }),
    candidate(secondId, { label: 'SENSITIVE_LABEL', text: 'SENSITIVE_SOURCE' }),
  ];
  const transport = recordingTransport((value, request) => {
    if (request.questions.a_activity) value.answers.a_sensitive_1.noul = 0.9;
    value.usage.extra = 'USAGE_SECRET';
    value.extra = 'RAW_RESPONSE_SECRET';
    for (const answer of Object.values(value.answers)) answer.explanation = 'EXPLANATION_SECRET';
    return value;
  });
  const result = await service(t, {
    ...transport,
    intakePolicy: { version: 'INTAKE_VERSION_SECRET', extra: 'EXTRA_POLICY_SECRET' },
    admissionPolicy: { version: 'ADMISSION_VERSION_SECRET', extra: 'EXTRA_POLICY_SECRET' },
  }).classify(input({
    candidates,
    event: { ...event, prompt: 'PUBLIC_PROMPT_SECRET', path: '/private/EVENT_PATH_SECRET' },
    policy: { ...policy, version: 'POLICY_VERSION_SECRET' },
  }));
  const trace = decision(result);
  assert.deepEqual(trace.intake.map(row => row.candidateId),
    [auditId(secretId), auditId(secondId)]);
  assert.equal(trace.nodes[0].candidateId, trace.intake[0].candidateId);
  assert.deepEqual(Object.keys(trace.activity), ['choice', 'confidence', 'probabilities']);
  assert.deepEqual(Object.keys(trace.activity.probabilities), ACTIVITIES);
  assert.deepEqual(Object.keys(trace.nodes[0].roleProbabilities), ROLES);
  assert.doesNotMatch(JSON.stringify(trace), /SECRET|cache\.ts|\/private|OFFLINE_API_KEY/);
  assert.equal(result.nodes[0].candidateId, secretId, 'existing result IDs retain their semantics');
  assert.ok(trace.requests.every(row => Object.keys(row.usage).length === 2));
});

test('candidate/proposal budget omissions remain visible while audit cardinality stays bounded', async t => {
  const candidates = Array.from({ length: 16 }, (_, i) => candidate(`c${i}`));
  const relations = ['calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on'];
  const proposals = Array.from({ length: 12 }, (_, i) => proposal(`p${i}`, {
    sourceCandidateId: 'c0', targetCandidateId: `c${1 + Math.floor(i / 6)}`,
    relation: relations[i % 6], evidenceCandidateIds: ['c0', `c${1 + Math.floor(i / 6)}`],
  }));
  const result = await service(t, makeCore({ proposals })).classify(input({ candidates }));
  const trace = decision(result);
  assert.equal(result.diagnostics.candidatesOmitted, 4);
  assert.equal(result.diagnostics.proposalsOmitted, 5);
  assert.equal(trace.intake.length, 12);
  assert.equal(trace.nodes.length, 12);
  assert.equal(trace.edges.length, 7);
  assert.equal(trace.requests.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(trace)) < 12_000);
  assert.equal(trace.edges[0].proposalId, auditId('p0', 'proposal'));
  assert.equal(trace.edges[0].sourceCandidateId, trace.nodes[0].candidateId);
  assert.equal(trace.edges[0].targetCandidateId, trace.nodes[1].candidateId);
});

test('activity audit retains every valid Choice and full distribution without admitting graph changes', async t => {
  for (const choice of ACTIVITIES) {
    const probabilities = Object.fromEntries(ACTIVITIES.map(activity => [
      activity, activity === choice ? 0.91 : activity === (choice === 'other' ? 'implement' : 'other') ? 0.09 : 0,
    ]));
    const transport = recordingTransport((value, request) => {
      if (request.questions.a_activity) {
        value.answers.a_activity = { type: 'choice', choice, confidence: 0.88, probabilities };
        value.answers.a_relevant_0.noul = 0.1;
      }
      return value;
    });
    const result = await service(t, transport).classify(input());
    assert.equal(result.status, 'irrelevant');
    assert.equal(result.activity, choice);
    assert.deepEqual(decision(result).activity, { choice, confidence: 0.88, probabilities });
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
  }
});

test('invalid or extra activity values never enter the audit', async t => {
  const corruptions = [
    answer => { answer.choice = 'RAW_CHOICE_SECRET'; },
    answer => { answer.confidence = NaN; },
    answer => { answer.probabilities.implement = -1; },
    answer => { answer.probabilities.other = 'RAW_PROBABILITY_SECRET'; },
    answer => { answer.probabilities.RAW_ACTIVITY_SECRET = 0; },
    answer => { delete answer.probabilities.other; },
  ];
  for (const corrupt of corruptions) {
    const transport = recordingTransport(value => {
      corrupt(value.answers.a_activity);
      return value;
    });
    const result = await service(t, transport).classify(input());
    assert.equal(result.status, 'invalid');
    assert.equal(decision(result).activity, null);
    assert.deepEqual(decision(result).intake, []);
    assert.doesNotMatch(JSON.stringify(decision(result)), /RAW_|SECRET/);
  }
});

test('invalid role distributions publish no partial node scores and retain validated activity', async t => {
  const corruptions = [
    probabilities => { probabilities.unknown = Infinity; },
    probabilities => { probabilities.unknown = 'RAW_ROLE_SECRET'; },
    probabilities => { probabilities.RAW_ROLE_SECRET = 0; },
    probabilities => { delete probabilities.unknown; },
  ];
  for (const corrupt of corruptions) {
    const transport = recordingTransport((value, request) => {
      if (request.questions.b_role_0) corrupt(value.answers.b_role_0.probabilities);
      return value;
    });
    const result = await service(t, transport).classify(input());
    assert.equal(result.status, 'invalid');
    assert.equal(decision(result).activity.choice, 'implement');
    assert.deepEqual(decision(result).nodes, []);
    assert.deepEqual(result.nodes, []);
    assert.doesNotMatch(JSON.stringify(decision(result)), /RAW_|SECRET/);
  }
});
