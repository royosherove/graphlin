import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResponse, readResponse, withAbort } from '../../runtime/jev/wire.mjs';
import { createDecisionService } from '../../runtime/jev/index.mjs';
import { MODEL, input, makeCore, flush } from './helpers.mjs';

const scoreRequest = {
  model: MODEL,
  questions: { check: {
    type: 'score', instructions: 'Grade the explicitly supplied proposition.',
    criteria: ['No support', 'Partial support', 'Full support'],
  } },
};
const scoreResponse = () => ({
  model: MODEL,
  answers: { check: {
    type: 'score', score: 1.5, confidence: 0.7,
    legend: { 0: 'No support', 1: 'Partial support', 2: 'Full support' },
    probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
  } },
  usage: { input_tokens: 1, output_tokens: 1 },
});

test('documented Score wire response requires indexed level keys, matching legend, weighted value', () => {
  assert.deepEqual(validateResponse(scoreResponse(), scoreRequest), scoreResponse());
  for (const corrupt of [
    value => { delete value.answers.check.probabilities['0']; },
    value => { value.answers.check.probabilities['3'] = 0; },
    value => { value.answers.check.legend['1'] = 'wrong level'; },
    value => { value.answers.check.score = 0; },
    value => { value.answers.check.score = 3; },
    value => { value.answers.check.score = NaN; },
    value => { value.answers.check.confidence = Infinity; },
    value => { value.answers.check.probabilities['1'] = -0.1; },
  ]) {
    const value = scoreResponse();
    corrupt(value);
    assert.throws(() => validateResponse(value, scoreRequest));
  }
});

test('probability sums tolerate 0.01 rounding without silently normalizing missing values', () => {
  const request = { model: MODEL, questions: {
    q: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } },
  } };
  const response = {
    model: MODEL, answers: { q: {
      type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.6, b: 0.39 },
    } }, usage: { input_tokens: 0, output_tokens: 0 },
  };
  assert.equal(validateResponse(response, request).answers.q.probabilities.b, 0.39);
  response.answers.q.probabilities.b = 0.389;
  assert.throws(() => validateResponse(response, request), /invalid_probability_sum/);
  delete response.answers.q.probabilities.b;
  assert.throws(() => validateResponse(response, request), /invalid_probabilities/);
});

test('Noul rejects non-finite, coercible, missing, and out-of-range answers', () => {
  const request = { model: MODEL, questions: { q: { type: 'noul', instructions: 'Test' } } };
  for (const noul of [NaN, Infinity, -Infinity, undefined, null, '0.9', -0.01, 1.01]) {
    assert.throws(() => validateResponse({
      model: MODEL, answers: { q: { type: 'noul', noul } },
      usage: { input_tokens: 0, output_tokens: 0 },
    }, request), /invalid_noul/);
  }
});

test('response extensions are discarded, never retained as diagnostics or provenance', () => {
  const value = scoreResponse();
  value.debug = 'SENSITIVE_RESPONSE_EXTENSION';
  value.answers.check.reasoning = 'SENSITIVE_RESPONSE_EXTENSION';
  value.usage.note = 'SENSITIVE_RESPONSE_EXTENSION';
  const validated = validateResponse(value, scoreRequest);
  assert.doesNotMatch(JSON.stringify(validated), /SENSITIVE_RESPONSE_EXTENSION/);
  assert.deepEqual(validated, scoreResponse());
});

test('response byte cap applies to actual chunks even without Content-Length', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(100));
      controller.enqueue(new Uint8Array(100));
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readResponse(response, 150, new AbortController().signal), /response_too_large/);
  assert.equal(cancelled, true);
});

test('declared oversized bodies are cancelled before reading', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-length': '10000' } });
  await assert.rejects(readResponse(response, 100, new AbortController().signal), /response_too_large/);
  assert.equal(cancelled, true);
});

test('malformed JSON, malformed UTF-8, empty body, and bad response body fail closed', async t => {
  const responses = [
    [new Response('{"secret":"SENSITIVE_UNFINISHED'), 'invalid_json'],
    [new Response(new Uint8Array([0xc3, 0x28])), 'invalid_json'],
    [new Response(''), 'invalid_json'],
    [new Response(null), 'invalid_response_body'],
  ];
  for (const [response, code] of responses) {
    const service = createDecisionService({ apiKey: 'dummy', ...makeCore(), fetchImpl: async () => response });
    t.after(() => service.close());
    const result = await service.classify(input());
    assert.equal(result.status, 'invalid');
    assert.equal(result.diagnostics.code, code);
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_UNFINISHED/);
  }
});

test('an abort in the scheduling gap prevents the pending operation from starting', async () => {
  let called = false;
  const controller = new AbortController();
  const pending = withAbort(() => { called = true; }, controller.signal);
  controller.abort(new Error('private reason'));
  await assert.rejects(pending, /cancelled/);
  await flush();
  assert.equal(called, false);
});
