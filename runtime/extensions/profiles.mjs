import { check, exact, id, text, uniqueStrings, jsonBytes } from './contracts.mjs';

const INTERPRETATION_KINDS = new Set([
  'application', 'container', 'component', 'system', 'external_system',
  'actor', 'person', 'context', 'datastore',
]);

/** Declarative decisions only; the service broker owns evidence and execution. */
export function validateDecisionProfile(profile) {
  jsonBytes(profile, 32 * 1024, 'decision_profile_limit');
  check(exact(profile, ['id', 'questions', 'selectors']) &&
    typeof profile.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(profile.id) &&
    Array.isArray(profile.questions) && profile.questions.length > 0 && profile.questions.length <= 16,
  'invalid_decision_profile');
  const seen = new Set();
  for (const question of profile.questions) {
    check(exact(question, ['id', 'kind', 'question'], ['options', 'interpretationKind', 'interpretationLabel']) && id(question.id) &&
      !seen.has(question.id) && ['boolean', 'choice', 'score'].includes(question.kind) &&
      text(question.question, 400), 'invalid_decision_question');
    check(question.kind === 'choice' ? uniqueStrings(question.options, value => text(value, 80), 16) &&
      question.options.length >= 2 : question.options === undefined, 'invalid_decision_options');
    check(question.interpretationKind === undefined || INTERPRETATION_KINDS.has(question.interpretationKind) ||
      (question.interpretationKind === 'selected-choice' && question.kind === 'choice' &&
        question.options.every(value => value === 'unknown' || INTERPRETATION_KINDS.has(value))),
    'invalid_interpretation_kind');
    check(question.interpretationLabel === undefined ||
      (question.interpretationKind !== undefined && text(question.interpretationLabel, 80)),
    'invalid_interpretation_label');
    seen.add(question.id);
  }
  check(exact(profile.selectors, ['fields', 'candidateIds']) &&
    uniqueStrings(profile.selectors.fields, value => ['entities', 'relations', 'interpretations'].includes(value), 3) &&
    profile.selectors.fields.length > 0 &&
    uniqueStrings(profile.selectors.candidateIds, id, 256), 'invalid_decision_selectors');
  return JSON.parse(JSON.stringify(profile));
}
