import { DecisionFault } from '../decisions/faults.mjs';
import { withAbort as withDecisionAbort } from '../decisions/faults.mjs';

export class JevFault extends DecisionFault {
  constructor(code, status = 'invalid') {
    super(code, status);
    this.name = 'JevFault';
    this.code = code;
    this.status = status;
  }
}

export function abortFault(signal) {
  return signal.reason instanceof DecisionFault ? signal.reason : new JevFault('cancelled', 'abstained');
}

export async function withAbort(operation, signal) {
  try { return await withDecisionAbort(operation, signal); }
  catch (error) {
    if (signal.aborted) throw abortFault(signal);
    throw error;
  }
}

export const isRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);
export const isProbability = (value) => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1;

const sameKeys = (value, expected) => isRecord(value)
  && Object.keys(value).length === expected.length
  && expected.every((key) => Object.hasOwn(value, key));

function distribution(value, keys) {
  if (!sameKeys(value, keys) || !keys.every((key) => isProbability(value[key]))) {
    throw new JevFault('invalid_probabilities');
  }
  const total = keys.reduce((sum, key) => sum + value[key], 0);
  if (Math.abs(total - 1) > 0.01 + Number.EPSILON) {
    throw new JevFault('invalid_probability_sum');
  }
}

export function validateResponse(value, request) {
  const questions = request.questions;
  if (!isRecord(value) || value.model !== request.model
    || !sameKeys(value.answers, Object.keys(questions))
    || !isRecord(value.usage)
    || !['input_tokens', 'output_tokens'].every((key) =>
      Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0)) {
    throw new JevFault('invalid_response');
  }
  // Reconstruct only the documented fields; never preserve arbitrary response strings.
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = value.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new JevFault('invalid_answer_type');
    }
    if (question.type === 'noul') {
      if (!isProbability(answer.noul)) throw new JevFault('invalid_noul');
      answers[id] = { type: 'noul', noul: answer.noul };
      continue;
    }
    if (!isProbability(answer.confidence)) throw new JevFault('invalid_confidence');
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      distribution(answer.probabilities, keys);
      if (typeof answer.choice !== 'string' || !keys.includes(answer.choice)
        || keys.some((key) => answer.probabilities[key]
          > answer.probabilities[answer.choice] + 1e-9)) {
        throw new JevFault('invalid_choice');
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
        throw new JevFault('invalid_score');
      }
      const expected = keys.reduce((sum, key) =>
        sum + Number(key) * answer.probabilities[key], 0);
      if (Math.abs(expected - answer.score) > 0.01 * (keys.length - 1) + 1e-9) {
        throw new JevFault('invalid_score');
      }
      answers[id] = {
        type: 'score', score: answer.score, legend: { ...answer.legend },
        probabilities: { ...answer.probabilities }, confidence: answer.confidence,
      };
    } else {
      throw new JevFault('invalid_question_type');
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

export async function readResponse(response, maximumBytes, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new JevFault('invalid_response_body');
  }
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && Number(declared) > maximumBytes) {
    Promise.resolve(response.body.cancel()).catch(() => {});
    throw new JevFault('response_too_large');
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
      if (!(value instanceof Uint8Array)) throw new JevFault('invalid_response_body');
      total += value.byteLength;
      if (total > maximumBytes) throw new JevFault('response_too_large');
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, total);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new JevFault('invalid_json');
    }
  } finally {
    if (!finished) Promise.resolve(reader.cancel()).catch(() => {});
    try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
  }
}
