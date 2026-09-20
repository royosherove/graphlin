import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecisionService, validateQuestions, validateResult, capabilityLimitations,
} from '../../runtime/decisions/index.mjs';
import { normalizeProfiles } from '../../runtime/decisions/profiles.mjs';
import { toJevRequest } from '../../runtime/jev/provider.mjs';
import { input, makeCore } from '../jev/helpers.mjs';
import { createRecordedProvider, capabilities } from './recorded-provider.mjs';

const request = {
  state: {},
  questions: {
    boolean: {
      type: 'boolean', instructions: { question: 'Is this supported?' },
      criteria: { true: 'Supported', false: 'Not supported' },
    },
    choice: {
      type: 'choice', instructions: { question: 'Choose a supplied alternative.' },
      criteria: { yes: 'Supported', unknown: 'Unknown' },
    },
    score: {
      type: 'score', instructions: { question: 'Rate the evidence.' },
      criteria: ['Low', 'Medium', 'High'],
    },
  },
};
const answer = () => ({
  answers: {
    boolean: { type: 'boolean', value: true },
    choice: { type: 'choice', choice: 'yes' },
    score: { type: 'score', score: 1 },
  },
});

test('boolean values, selections, and scores never manufacture probabilities or confidence', () => {
  const value = validateResult(answer(), request, { boolean: {}, choice: {}, score: {} });
  assert.deepEqual(value, {
    answers: {
      boolean: { type: 'boolean', value: true, probability: null },
      choice: { type: 'choice', choice: 'yes', probabilities: null, confidence: null },
      score: { type: 'score', score: 1, probabilities: null, confidence: null },
    },
    usage: null,
  });
});

test('provider capability limitations are explicit before any source leaves the service', async t => {
  const provider = createRecordedProvider({ capabilities: { boolean: {}, choice: {} } });
  const core = makeCore();
  const service = createDecisionService({ provider, ...core });
  t.after(() => service.close());
  const result = await service.classify(input());
  assert.equal(result.status, 'abstained');
  assert.equal(result.diagnostics.code, 'unsupported_capability');
  assert.deepEqual(result.diagnostics.capabilityLimitations, [
    { type: 'choice', metric: 'probabilities' },
    { type: 'choice', metric: 'confidence' },
    { type: 'boolean', metric: 'probability' },
  ]);
  assert.equal(provider.calls.length, 0);
  assert.equal(core.calls.materialize.length, 0);
  assert.deepEqual(service.capabilities, { boolean: {}, choice: {} });
  assert.deepEqual(capabilityLimitations(request, { boolean: {}, choice: {} }), [{ type: 'score', metric: null }]);
});

test('missing required probabilities stop intake, even if the provider declares them', async t => {
  const provider = createRecordedProvider({ transform(value) {
    for (const answer of Object.values(value.answers)) {
      if (answer.type === 'boolean') { delete answer.probability; answer.value = true; }
    }
    return value;
  } });
  const core = makeCore();
  const service = createDecisionService({ provider, ...core });
  t.after(() => service.close());
  const result = await service.classify(input());
  assert.equal(result.status, 'abstained');
  assert.equal(result.diagnostics.code, 'missing_answer_metrics');
  assert.equal(result.bundle, null);
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.diagnostics.trace.intake, []);
  assert.equal(provider.calls.length, 1);
  assert.equal(core.calls.materialize.length, 0);
});

test('missing B confidence retains A provenance and cannot admit a node', async t => {
  const provider = createRecordedProvider({ transform(value) {
    if (value.answers.b_role_0) delete value.answers.b_role_0.confidence;
    return value;
  } });
  const service = createDecisionService({ provider, ...makeCore() });
  t.after(() => service.close());
  const result = await service.classify(input());
  assert.equal(result.diagnostics.code, 'missing_answer_metrics');
  assert.ok(result.bundle);
  assert.equal(result.diagnostics.trace.intake[0].approved, true);
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.diagnostics.trace.nodes, []);
});

test('optional profile metrics remain null and scores preserve their supplied value', async t => {
  const provider = createRecordedProvider({ transform(value, req) {
    if (req.questions.score) return answer();
    return value;
  } });
  const service = createDecisionService({
    provider, ...makeCore(),
    profiles: [{ id: 'optional', version: '1', scope: 'bundle', questions: request.questions }],
  });
  t.after(() => service.close());
  const result = await service.analyze({ ...input(), profileId: 'optional' });
  assert.equal(result.analysis.status, 'answered');
  assert.equal(result.analysis.answers.boolean.probability, null);
  assert.equal(result.analysis.answers.choice.confidence, null);
  assert.equal(result.analysis.answers.score.score, 1);
  assert.equal(result.analysis.answers.score.probabilities, null);
});

test('invalid types, metrics, distributions, scores, or usage never survive normalization', () => {
  for (const corrupt of [
    value => { value.answers.boolean.probability = 1.01; },
    value => { value.answers.boolean.probability = '0.5'; },
    value => { value.answers.boolean.probability = 0.1; },
    value => { value.answers.boolean.value = 'true'; },
    value => { value.answers.choice.choice = 'invented'; },
    value => { value.answers.choice.confidence = Infinity; },
    value => { value.answers.choice.probabilities = { yes: 0.9 }; },
    value => { value.answers.choice.probabilities = { yes: 0.6, unknown: 0.6 }; },
    value => { value.answers.choice.probabilities = { yes: 0.1, unknown: 0.9 }; },
    value => { value.answers.score.score = 3; },
    value => { value.answers.score.score = NaN; },
    value => { value.answers.score.probabilities = { 0: 1, 1: 0, 2: 0 }; },
    value => { value.answers.score.type = 'noul'; },
    value => { delete value.answers.boolean; },
    value => { value.answers.extra = { type: 'boolean', value: true }; },
    value => { value.usage = { inputTokens: -1, outputTokens: 0 }; },
  ]) {
    const value = answer();
    corrupt(value);
    assert.throws(() => validateResult(value, request, capabilities), /invalid_/);
  }
  const value = answer();
  value.answers.boolean.probability = 0.9;
  assert.throws(() => validateResult(value, request, { boolean: {}, choice: {}, score: {} }), /invalid_boolean/);
});

test('normalization discards provider output fields instead of creating a data channel', () => {
  const value = answer();
  value.raw = 'RAW_PROVIDER_TEXT';
  value.answers.choice.explanation = 'RAW_EXPLANATION';
  value.usage = { inputTokens: 1, outputTokens: 2, text: 'RAW_USAGE' };
  const result = validateResult(value, request, capabilities);
  assert.doesNotMatch(JSON.stringify(result), /RAW_/);
  assert.throws(() => validateResult(value, request, capabilities, 20), /response_too_large/);
});

test('profile questions are neutral and reject unsupported types, keys, and executable definitions', () => {
  assert.equal(validateQuestions(request.questions), request.questions);
  for (const type of ['noul', 'free_text', 'tool']) {
    assert.throws(() => validateQuestions({ test: { ...request.questions.boolean, type } }), /invalid_question_type/);
  }
  assert.throws(() => validateQuestions(JSON.parse('{"__proto__":{"type":"boolean"}}')), /invalid_question_type/);
  assert.throws(() => normalizeProfiles([{
    id: 'unsafe', version: '1', scope: 'entity', questions: request.questions, execute() {},
  }]), /invalid_profile/);
  assert.throws(() => normalizeProfiles([{
    id: 'unsafe', version: '1', scope: 'bundle', questions: () => request.questions,
  }]), /invalid_question_type/);
  assert.throws(() => normalizeProfiles([{
    id: 'unsafe', version: '1', scope: 'bundle',
    questions: { item: { ...request.questions.boolean, instructions: { question: '{{entity}}' } } },
  }]), /invalid_profile/);
});

test('Jev alone translates neutral descriptors; profiles contain no endpoint, model or key', () => {
  const wire = toJevRequest('jev-1.13.0', request);
  assert.equal(wire.questions.boolean.type, 'noul');
  assert.equal(wire.questions.choice.type, 'choice');
  assert.equal(wire.questions.score.type, 'score');
  assert.doesNotMatch(JSON.stringify(request), /jev|typesafe|apiKey|endpoint|noul/);
  assert.equal(request.questions.boolean.type, 'boolean', 'translation cannot mutate a profile');
});
