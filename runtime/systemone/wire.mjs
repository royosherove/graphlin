// Shared System One wire rules. Jev and Decider use the same wire format.
// Each provider keeps its own policy: endpoint, credentials and model check.
// This module imports no vendor module.
import { DecisionFault, withAbort as withDecisionAbort } from '../decisions/faults.mjs';
import { validateQuestions } from '../decisions/contracts.mjs';

// Wire limits of the System One format (strands_decider/schema.py).
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
export const MAX_CHOICE_OPTIONS = 255;

export const isRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);
export const isProbability = (value) => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1;

const sameKeys = (value, expected) => isRecord(value)
  && Object.keys(value).length === expected.length
  && expected.every((key) => Object.hasOwn(value, key));

export function toSystemOneRequest(model, request) {
  validateQuestions(request.questions);
  return {
    model, state: request.state,
    questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, {
      type: question.type === 'boolean' ? 'noul' : question.type,
      instructions: question.instructions, criteria: question.criteria,
    }])),
  };
}

export function fromSystemOneResponse(value) {
  return {
    answers: Object.fromEntries(Object.entries(value.answers).map(([id, answer]) => [id,
      answer.type === 'noul' ? { type: 'boolean', probability: answer.noul }
        : answer.type === 'choice' ? {
          type: 'choice', choice: answer.choice,
          probabilities: answer.probabilities, confidence: answer.confidence,
        } : {
          type: 'score', score: answer.score,
          probabilities: answer.probabilities, confidence: answer.confidence,
        },
    ])),
    usage: { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens },
  };
}

export function retryAfter(response, now) {
  const milliseconds = response.headers?.get('retry-after-ms');
  const seconds = response.headers?.get('retry-after');
  if (milliseconds && milliseconds.length <= 128 && Number.isFinite(Number(milliseconds))) return Number(milliseconds);
  if (seconds && seconds.length <= 128) {
    return /^\d+(?:\.\d+)?$/.test(seconds) ? Number(seconds) * 1000 : Date.parse(seconds) - now();
  }
  return undefined;
}

// The shape guard: a score question has 2 to 10 levels, and a choice question
// has 255 options or fewer. The server refuses other shapes, thus the request
// stops here and sends nothing.
// In the decision service, validateQuestions (runtime/decisions/contracts.mjs)
// applies first: it permits 2 to 128 score levels and 2 to 128 choice options.
// Thus there, the lower score limit and the 255-option branch cannot occur.
// These branches are a second barrier for a direct encode call.
export function requireSystemOneShapes(request) {
  for (const question of Object.values(request.questions)) {
    if (question.type === 'score' && (question.criteria.length < MIN_SCORE_LEVELS
      || question.criteria.length > MAX_SCORE_LEVELS)) {
      throw new DecisionFault('unsupported_capability', 'abstained');
    }
    if (question.type === 'choice' && Object.keys(question.criteria).length > MAX_CHOICE_OPTIONS) {
      throw new DecisionFault('unsupported_capability', 'abstained');
    }
  }
  return request;
}

/**
 * Make the validation and body functions for one fault class. Jev gives
 * JevFault, so its old errors stay the same. Decider gives DecisionFault.
 */
export function createSystemOneWire(Fault = DecisionFault) {
  function abortFault(signal) {
    return signal.reason instanceof DecisionFault ? signal.reason : new Fault('cancelled', 'abstained');
  }

  async function withAbort(operation, signal) {
    try { return await withDecisionAbort(operation, signal); }
    catch (error) {
      if (signal.aborted) throw abortFault(signal);
      throw error;
    }
  }

  function distribution(value, keys) {
    if (!sameKeys(value, keys) || !keys.every((key) => isProbability(value[key]))) {
      throw new Fault('invalid_probabilities');
    }
    const total = keys.reduce((sum, key) => sum + value[key], 0);
    if (Math.abs(total - 1) > 0.01 + Number.EPSILON) {
      throw new Fault('invalid_probability_sum');
    }
  }

  function validateResponse(value, request) {
    const questions = request.questions;
    if (!isRecord(value) || value.model !== request.model
      || !sameKeys(value.answers, Object.keys(questions))
      || !isRecord(value.usage)
      || !['input_tokens', 'output_tokens'].every((key) =>
        Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0)) {
      throw new Fault('invalid_response');
    }
    // Reconstruct only the documented fields; never preserve arbitrary response strings.
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = value.answers[id];
      if (!isRecord(answer) || answer.type !== question.type) {
        throw new Fault('invalid_answer_type');
      }
      if (question.type === 'noul') {
        if (!isProbability(answer.noul)) throw new Fault('invalid_noul');
        answers[id] = { type: 'noul', noul: answer.noul };
        continue;
      }
      if (!isProbability(answer.confidence)) throw new Fault('invalid_confidence');
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria);
        distribution(answer.probabilities, keys);
        if (typeof answer.choice !== 'string' || !keys.includes(answer.choice)
          || keys.some((key) => answer.probabilities[key]
            > answer.probabilities[answer.choice] + 1e-9)) {
          throw new Fault('invalid_choice');
        }
        answers[id] = {
          type: 'choice', choice: answer.choice,
          probabilities: { ...answer.probabilities }, confidence: answer.confidence,
        };
      } else if (question.type === 'score') {
        const keys = question.criteria.map((_, i) => String(i));
        distribution(answer.probabilities, keys);
        if (!sameKeys(answer.legend, keys)
          || !keys.every((key) => answer.legend[key] === question.criteria[Number(key)])
          || typeof answer.score !== 'number' || !Number.isFinite(answer.score)
          || answer.score < 0 || answer.score > keys.length - 1) {
          throw new Fault('invalid_score');
        }
        const expected = keys.reduce((sum, key) =>
          sum + Number(key) * answer.probabilities[key], 0);
        if (Math.abs(expected - answer.score) > 0.01 * (keys.length - 1) + 1e-9) {
          throw new Fault('invalid_score');
        }
        answers[id] = {
          type: 'score', score: answer.score, legend: { ...answer.legend },
          probabilities: { ...answer.probabilities }, confidence: answer.confidence,
        };
      } else {
        throw new Fault('invalid_question_type');
      }
    }
    return {
      model: request.model, answers,
      usage: {
        input_tokens: value.usage.input_tokens,
        output_tokens: value.usage.output_tokens,
      },
    };
  }

  async function readResponse(response, maximumBytes, signal) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new Fault('invalid_response_body');
    }
    const declared = response.headers?.get('content-length');
    if (declared !== null && declared !== undefined && Number(declared) > maximumBytes) {
      Promise.resolve(response.body.cancel()).catch(() => {});
      throw new Fault('response_too_large');
    }
    const reader = response.body.getReader();
    let total = 0;
    let finished = false;
    const chunks = [];
    try {
      while (true) {
        const { value, done } = await withAbort(() => reader.read(), signal);
        if (done) {
          finished = true;
          break;
        }
        if (!(value instanceof Uint8Array)) throw new Fault('invalid_response_body');
        total += value.byteLength;
        if (total > maximumBytes) throw new Fault('response_too_large');
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks, total);
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new Fault('invalid_json');
      }
    } finally {
      if (!finished) Promise.resolve(reader.cancel()).catch(() => {});
      try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
    }
  }

  return Object.freeze({ abortFault, withAbort, validateResponse, readResponse });
}
