import { DecisionFault } from '../decisions/faults.mjs';
import { CONTRACT_VERSION } from '../decisions/contracts.mjs';
import { JevFault, readResponse, validateResponse, withAbort } from './wire.mjs';
import { toSystemOneRequest, fromSystemOneResponse, retryAfter } from '../systemone/wire.mjs';
import { FIXTURE_TRANSPORT } from './fixture.mjs';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export { ENDPOINT as JEV_ENDPOINT };

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

// The System One wire rules are shared with other providers.
export const toJevRequest = toSystemOneRequest;
export const fromJevResponse = fromSystemOneResponse;

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
