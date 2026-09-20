import { DecisionFault } from './faults.mjs';

export const CONTRACT_VERSION = 1;
export const isRecord = value => value !== null && typeof value === 'object'
  && !Array.isArray(value);
export const isProbability = value => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const sameKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const metrics = Object.freeze({
  boolean: ['probability'], choice: ['probabilities', 'confidence'],
  score: ['probabilities', 'confidence'],
});

export function normalizeProvider(provider) {
  if (!isRecord(provider) || provider.contractVersion !== CONTRACT_VERSION
    || !identifier(provider.id) || !identifier(provider.version)
    || !['live', 'demo', 'local'].includes(provider.mode)
    || (provider.model !== undefined && !identifier(provider.model))
    || !isRecord(provider.capabilities)
    || Object.keys(provider.capabilities).some(type => !Object.hasOwn(metrics, type))
    || typeof provider.encode !== 'function' || typeof provider.execute !== 'function'
    || ![undefined, null, 'missing_key', 'provider_unavailable'].includes(provider.unavailableCode)) {
    throw new DecisionFault('invalid_provider');
  }
  const capabilities = {};
  for (const [type, supported] of Object.entries(provider.capabilities)) {
    if (!isRecord(supported) || Object.entries(supported)
      .some(([key, value]) => !metrics[type].includes(key) || typeof value !== 'boolean')) {
      throw new DecisionFault('invalid_provider');
    }
    capabilities[type] = Object.freeze({ ...supported });
  }
  return Object.freeze({
    contractVersion: CONTRACT_VERSION, id: provider.id, version: provider.version,
    mode: provider.mode, ...(provider.model === undefined ? {} : { model: provider.model }),
    unavailableCode: provider.unavailableCode ?? null,
    capabilities: Object.freeze(capabilities),
    encode: provider.encode.bind(provider), execute: provider.execute.bind(provider),
  });
}

// Declarative profile descriptors use only neutral types. The host supplies
// questions; an extension never gets an executable provider or intake bypass.
export function validateQuestions(questions) {
  if (!isRecord(questions) || !Object.keys(questions).length || Object.keys(questions).length > 1024) {
    throw new DecisionFault('invalid_question_type');
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!identifier(id) || !isRecord(question) || !Object.hasOwn(metrics, question.type)
      || !isRecord(question.instructions)
      || typeof question.instructions.question !== 'string' || !question.instructions.question.length
      || question.instructions.question.length > 8192
      || (question.instructions.focus !== undefined && (typeof question.instructions.focus !== 'string'
        || question.instructions.focus.length > 8192))) throw new DecisionFault('invalid_question_type');
    const { type, criteria, requiredMetrics = [] } = question;
    if (!Array.isArray(requiredMetrics) || new Set(requiredMetrics).size !== requiredMetrics.length
      || Array.from(requiredMetrics).some(metric => !metrics[type].includes(metric))) {
      throw new DecisionFault('invalid_question_type');
    }
    if (type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 128
        || Array.from(criteria).some(value => typeof value !== 'string')) {
        throw new DecisionFault('invalid_question_type');
      }
    } else if (!isRecord(criteria) || (type === 'boolean' && !sameKeys(criteria, ['true', 'false']))
      || (type === 'choice' && (Object.keys(criteria).length < 2 || Object.keys(criteria).length > 128
        || Object.keys(criteria).some(key => !identifier(key))))) {
      throw new DecisionFault('invalid_question_type');
    }
    if (Object.values(criteria).some(value => typeof value !== 'string' || !value.length || value.length > 8192)) {
      throw new DecisionFault('invalid_question_type');
    }
  }
  return questions;
}

export function capabilityLimitations(request, capabilities) {
  validateQuestions(request.questions);
  const limitations = new Map();
  for (const question of Object.values(request.questions)) {
    if (!Object.hasOwn(capabilities, question.type)) {
      limitations.set(question.type, { type: question.type, metric: null });
    } else for (const metric of question.requiredMetrics ?? []) {
      if (capabilities[question.type][metric] !== true) {
        limitations.set(`${question.type}:${metric}`, { type: question.type, metric });
      }
    }
  }
  return [...limitations.values()];
}

export function requireCapabilities(request, capabilities) {
  if (capabilityLimitations(request, capabilities).length) {
    throw new DecisionFault('unsupported_capability', 'abstained');
  }
}

function distribution(value, keys) {
  if (value === undefined || value === null) return null;
  if (!sameKeys(value, keys) || keys.some(key => !isProbability(value[key]))) {
    throw new DecisionFault('invalid_probabilities');
  }
  if (Math.abs(keys.reduce((sum, key) => sum + value[key], 0) - 1) > 0.01 + Number.EPSILON) {
    throw new DecisionFault('invalid_probability_sum');
  }
  return { ...value };
}

function optionalProbability(value, code) {
  if (value === undefined || value === null) return null;
  if (!isProbability(value)) throw new DecisionFault(code);
  return value;
}

export function validateResult(value, request, capabilities, maximumBytes = 256 * 1024) {
  validateQuestions(request.questions);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new DecisionFault('invalid_response'); }
  if (encoded === undefined) throw new DecisionFault('invalid_response');
  if (Buffer.byteLength(encoded) > maximumBytes) throw new DecisionFault('response_too_large');
  if (!isRecord(value) || !sameKeys(value.answers, Object.keys(request.questions))) {
    throw new DecisionFault('invalid_response');
  }
  const answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = value.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) throw new DecisionFault('invalid_answer_type');
    const supported = capabilities[question.type] ?? {};
    if (question.type === 'boolean') {
      if (answer.value !== undefined && answer.value !== null && typeof answer.value !== 'boolean') {
        throw new DecisionFault('invalid_boolean');
      }
      const probability = optionalProbability(answer.probability, 'invalid_boolean');
      if (probability !== null && supported.probability !== true) throw new DecisionFault('invalid_boolean');
      if (probability !== null && ((answer.value === true && probability < 0.5)
        || (answer.value === false && probability > 0.5))) throw new DecisionFault('invalid_boolean');
      answers[id] = { type: 'boolean', value: answer.value ?? null, probability };
      continue;
    }
    const keys = question.type === 'choice' ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index));
    const probabilities = distribution(answer.probabilities, keys);
    const confidence = optionalProbability(answer.confidence, 'invalid_confidence');
    if (probabilities !== null && supported.probabilities !== true) throw new DecisionFault('invalid_probabilities');
    if (confidence !== null && supported.confidence !== true) throw new DecisionFault('invalid_confidence');
    if (question.type === 'choice') {
      if (!keys.includes(answer.choice) || (probabilities && keys.some(key =>
        probabilities[key] > probabilities[answer.choice] + 1e-9))) throw new DecisionFault('invalid_choice');
      answers[id] = { type: 'choice', choice: answer.choice, probabilities, confidence };
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > keys.length - 1
        || (probabilities && Math.abs(keys.reduce((sum, key) =>
          sum + Number(key) * probabilities[key], 0) - answer.score) > 0.01 * (keys.length - 1) + 1e-9)) {
        throw new DecisionFault('invalid_score');
      }
      answers[id] = { type: 'score', score: answer.score, probabilities, confidence };
    }
  }
  let usage = null;
  if (value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage) || !['inputTokens', 'outputTokens']
      .every(key => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0)) {
      throw new DecisionFault('invalid_response');
    }
    usage = { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens };
  }
  return { answers, usage };
}

export function requireMetrics(request, answers) {
  for (const [id, question] of Object.entries(request.questions)) {
    if ((question.requiredMetrics ?? []).some(metric => answers[id][metric] === null
      || answers[id][metric] === undefined)) throw new DecisionFault('missing_answer_metrics', 'abstained');
  }
}
