import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecisionProfile } from '../../runtime/extensions/sdk.mjs';

const kinds = ['application', 'container', 'component', 'system', 'external_system',
  'actor', 'person', 'context', 'datastore'];
const profile = question => ({
  id: 'c4', questions: [question], selectors: { fields: ['entities'], candidateIds: [] },
});
const boolean = { id: 'boundary', kind: 'boolean', question: 'Is the declared boundary supported?' };
const choice = { id: 'role', kind: 'choice', question: 'Which role is supported?',
  options: ['application', 'unknown'], interpretationKind: 'selected-choice' };

test('SDK validation accepts each explicit C4 interpretation kind and keeps old questions compatible', () => {
  for (const question of [boolean, { ...boolean, kind: 'score' },
    { ...choice, interpretationKind: undefined, options: ['custom role', 'unknown'] }]) {
    assert.deepEqual(validateDecisionProfile(profile(question)), JSON.parse(JSON.stringify(profile(question))));
    for (const interpretationKind of kinds) {
      const input = profile({ ...question, interpretationKind, interpretationLabel: 'Order processing' });
      assert.deepEqual(validateDecisionProfile(input), input);
    }
  }
  const input = profile({ ...choice, options: [...kinds, 'unknown'] });
  const result = validateDecisionProfile(input);
  assert.deepEqual(result, input);
  result.questions[0].options[0] = 'datastore';
  assert.equal(input.questions[0].options[0], 'application', 'validation snapshots the declaration');
});

test('selected-choice only admits choice questions with exact bounded semantic options', () => {
  for (const patch of [
    { kind: 'boolean', options: undefined },
    { kind: 'score', options: undefined },
    { options: ['Application', 'unknown'] },
    { options: ['service', 'unknown'] },
    { options: ['application boundary', 'unknown'] },
    { options: ['application', 'unknown', '__proto__'] },
    { interpretationKind: 'unknown' },
    { interpretationKind: 'analysis-choice' },
    { interpretationKind: 'APPLICATION' },
    { interpretationKind: null },
    { interpretationKind: {} },
  ]) assert.throws(() => validateDecisionProfile(profile({ ...choice, ...patch })), /invalid_interpretation/);
});

test('interpretation labels require a mapping and remain bounded inert strings', () => {
  assert.equal(validateDecisionProfile(profile({
    ...choice, interpretationLabel: 'x'.repeat(80),
  })).questions[0].interpretationLabel.length, 80);
  for (const interpretationLabel of ['', 'x'.repeat(81), 'line\nbreak', '<b>Application</b>',
    'https://example.invalid', 'javascript:alert(1)', null, {}]) {
    assert.throws(() => validateDecisionProfile(profile({ ...choice, interpretationLabel })), /invalid_interpretation_label/);
  }
  assert.throws(() => validateDecisionProfile(profile({
    ...boolean, interpretationLabel: 'Application',
  })), /invalid_interpretation_label/);
  for (const patch of [{ interpretation: { kind: 'application' } }, { threshold: 0.01 }, { onAnswer: 'application' }]) {
    assert.throws(() => validateDecisionProfile(profile({ ...choice, ...patch })), /invalid_decision_question/);
  }
});
