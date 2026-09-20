import { DecisionFault } from '../decisions/faults.mjs';
import { CONTRACT_VERSION, validateQuestions } from '../decisions/contracts.mjs';
import { JevFault, readResponse, validateResponse, withAbort } from './wire.mjs';
import { FIXTURE_TRANSPORT } from './fixture.mjs';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

function endpointFor(value, injected) {
  let url;
  try { url = new URL(value); } catch { throw new JevFault('invalid_endpoint'); }
  if (url.href === ENDPOINT) return ENDPOINT;
  if (!injected || !['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash
    || url.pathname !== '/v1/systemone') throw new JevFault('invalid_endpoint');
  return url.href;
}

export function toJevRequest(model, request) {
  validateQuestions(request.questions);
  return {
    model, state: request.state,
    questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, {
      type: question.type === 'boolean' ? 'noul' : question.type,
      instructions: question.instructions, criteria: question.criteria,
    }])),
  };
}

export function fromJevResponse(value) {
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

function retryAfter(response, now) {
  const milliseconds = response.headers?.get('retry-after-ms');
  const seconds = response.headers?.get('retry-after');
  if (milliseconds && milliseconds.length <= 128 && Number.isFinite(Number(milliseconds))) return Number(milliseconds);
  if (seconds && seconds.length <= 128) {
    return /^\d+(?:\.\d+)?$/.test(seconds) ? Number(seconds) * 1000 : Date.parse(seconds) - now();
  }
  return undefined;
}

export function createJevProvider(options = {}) {
  const { apiKey, model = 'jev-1.13.0', fetchImpl = globalThis.fetch, endpoint = ENDPOINT } = options;
  if (typeof fetchImpl !== 'function' || !/^jev-\d+\.\d+\.\d+$/.test(model)
    || (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n]/.test(apiKey)))) {
    throw new JevFault('invalid_configuration');
  }
  const target = endpointFor(endpoint, Object.hasOwn(options, 'fetchImpl'));
  const mode = fetchImpl[FIXTURE_TRANSPORT] === true ? 'demo' : 'live';
  const key = mode === 'demo' ? 'graphlin-offline-fixture' : apiKey;
  return Object.freeze({
    contractVersion: CONTRACT_VERSION, id: 'jev', version: '1', model, mode,
    capabilities: Object.freeze({
      boolean: Object.freeze({ probability: true }),
      choice: Object.freeze({ probabilities: true, confidence: true }),
      score: Object.freeze({ probabilities: true, confidence: true }),
    }),
    unavailableCode: key ? null : 'missing_key',
    encode(request) { return JSON.stringify(toJevRequest(model, request)); },
    async execute(body, { signal, maxResponseBytes, now = Date.now, reportTransport = () => {} }) {
      if (!key) throw new JevFault('missing_key', 'unavailable');
      try {
        const response = await withAbort(() => fetchImpl(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body, signal, redirect: 'error', credentials: 'omit',
        }), signal);
        if (!response || !Number.isInteger(response.status)) throw new JevFault('invalid_http_response');
        reportTransport({ httpStatus: response.status });
        if (response.status !== 200) {
          if (response.body?.cancel) Promise.resolve(response.body.cancel()).catch(() => {});
          if ([429, 529].includes(response.status)) {
            throw new DecisionFault('remote_cooldown', 'overloaded', { retryAfterMs: retryAfter(response, now) });
          }
          if ([401, 403].includes(response.status)) throw new JevFault('authentication_failed', 'unavailable');
          if ([400, 422].includes(response.status)) throw new JevFault('request_rejected');
          throw new JevFault('http_error', 'unavailable');
        }
        const value = await readResponse(response, maxResponseBytes, signal);
        return fromJevResponse(validateResponse(value, JSON.parse(body)));
      } catch (error) {
        if (error instanceof DecisionFault) throw error;
        throw new JevFault('transport_failure', 'unavailable');
      }
    },
  });
}
