// Decider provider: a self-hosted Strands Decider server (experimental).
// The provider has no queue and no state. The composition root gives the
// decision service concurrency 1 for this provider (runtime/daemon/providers.mjs).
import http from 'node:http';
import { Readable } from 'node:stream';
import { DecisionFault } from '../decisions/faults.mjs';
import { CONTRACT_VERSION } from '../decisions/contracts.mjs';
import {
  createSystemOneWire, toSystemOneRequest, fromSystemOneResponse, retryAfter, requireSystemOneShapes,
} from '../systemone/wire.mjs';

// The name that the Decider server serves for the v19 model.
export const DEFAULT_DECIDER_MODEL = 'strands-decider-2B-hobson-v19-bb282d7-b1485b2';
// Local end of the SSM tunnel to the instance.
export const DEFAULT_DECIDER_ENDPOINT = 'http://127.0.0.1:8099/v1/systemone';
// The error body of a refused request is small. Read no more than this.
const MAX_ERROR_BYTES = 4096;

const wire = createSystemOneWire(DecisionFault);

// The model name is a label check, not authentication. It starts with
// "strands-decider-" and has 64 characters or fewer, so that diagnostics can
// keep it without the risk of free text.
export const DECIDER_MODEL_PATTERN = /^strands-decider-[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
export const validDeciderModel = (value) => typeof value === 'string' && DECIDER_MODEL_PATTERN.test(value);

/**
 * Loopback only: 127.0.0.1, over http: only (the tunnel carries plain HTTP).
 * The name "localhost" is refused, because its address comes from the
 * resolver. [::1] is refused, because the decider server accepts only the
 * Host 127.0.0.1 or localhost. Path /v1/systemone, with no
 * user information, no query and no fragment. Returns the normalized URL or null.
 */
export function deciderEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username || url.password || url.search || url.hash
    || value.includes('?') || value.includes('#')
    || url.pathname !== '/v1/systemone') return null;
  return url.href;
}

async function refusalCode(response, signal) {
  // A 422 with code context_window_exceeded is a request that is too large.
  // All other 400 and 422 results are refused requests. The body text is not kept.
  try {
    const value = await wire.readResponse(response, MAX_ERROR_BYTES, signal);
    if (response.status === 422 && value?.code === 'context_window_exceeded') return 'request_too_large';
  } catch (error) {
    if (signal.aborted) throw error;
  }
  return 'request_rejected';
}

// A private agent with no proxy configuration. Node.js can send global fetch
// and the global agent through an environment proxy (NODE_USE_ENV_PROXY with
// HTTP_PROXY). This agent connects only to the host of the URL, thus the
// source goes only to the loopback endpoint.
const directAgent = new http.Agent({ keepAlive: false });
// fetch with redirect 'error' gives a network error for these statuses.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// A Response with these statuses cannot have a body.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * A small fetch-like function on node:http, for the decider endpoint only.
 * It does not use globalThis.fetch or the global agent. It accepts only an
 * http: URL that deciderEndpoint accepts. It supports the options that this
 * provider uses: method, headers, a string body, signal and redirect 'error'.
 * An abort closes the connection, also during the body. It returns a WHATWG
 * Response; the caller reads the body with its own size limit.
 */
export function deciderFetch(url, { method = 'GET', headers = {}, body, signal, redirect = 'follow' } = {}) {
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const abortReason = () => signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
    const detach = () => signal?.removeEventListener('abort', onAbort);
    const fail = error => {
      if (settled) return;
      settled = true;
      detach();
      reject(error);
    };
    function onAbort() {
      // Close the connection at once. The server can continue its work.
      request?.destroy();
      response?.destroy();
      fail(abortReason());
      detach();
    }
    if (signal?.aborted) { reject(abortReason()); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const target = deciderEndpoint(String(url));
      if (!target || new URL(target).protocol !== 'http:') throw new TypeError('invalid_endpoint');
      const payload = body === undefined || body === null ? null : Buffer.from(String(body), 'utf8');
      const requestHeaders = Object.fromEntries(new Headers(headers));
      if (payload) requestHeaders['content-length'] = String(payload.byteLength);
      request = http.request(target, { method, agent: directAgent, headers: requestHeaders });
      request.on('error', fail);
      request.on('response', incoming => {
        response = incoming;
        incoming.on('error', () => {});
        if (settled) { incoming.destroy(); return; }
        if (redirect === 'error' && REDIRECT_STATUSES.has(incoming.statusCode)) {
          incoming.destroy();
          fail(new TypeError('unexpected_redirect'));
          return;
        }
        let result;
        try {
          const responseHeaders = new Headers();
          for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
            responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          }
          const nullBody = NULL_BODY_STATUSES.has(incoming.statusCode);
          if (nullBody) incoming.resume();
          result = new Response(nullBody ? null : Readable.toWeb(incoming),
            { status: incoming.statusCode, headers: responseHeaders });
        } catch {
          incoming.destroy();
          fail(new TypeError('invalid_http_response'));
          return;
        }
        settled = true;
        // Keep the abort listener until the body is complete or closed.
        incoming.once('close', detach);
        resolve(result);
      });
      request.end(payload ?? undefined);
    } catch (error) {
      request?.destroy();
      fail(error);
    }
  });
}

export function createDeciderProvider(options = {}) {
  const {
    endpoint = DEFAULT_DECIDER_ENDPOINT, model = DEFAULT_DECIDER_MODEL,
    // fetchImpl is the test seam. The default never uses an environment proxy.
    fetchImpl = deciderFetch, transmitSource = false,
  } = options;
  const target = deciderEndpoint(endpoint);
  if (typeof fetchImpl !== 'function' || !target || !validDeciderModel(model)
    || typeof transmitSource !== 'boolean') {
    throw new DecisionFault('invalid_configuration');
  }
  return Object.freeze({
    contractVersion: CONTRACT_VERSION, id: 'decider', version: '1', model,
    // The provider sends source over a network (the tunnel), thus it is live.
    mode: 'live',
    capabilities: Object.freeze({
      boolean: Object.freeze({ probability: true }),
      choice: Object.freeze({ probabilities: true, confidence: true }),
      score: Object.freeze({ probabilities: true, confidence: true }),
    }),
    // Without source consent, no request leaves the machine.
    unavailableCode: transmitSource ? null : 'provider_unavailable',
    encode(request) {
      requireSystemOneShapes(request);
      return JSON.stringify(toSystemOneRequest(model, request));
    },
    async execute(body, { signal, maxResponseBytes, now = Date.now, reportTransport = () => {} }) {
      if (!transmitSource) throw new DecisionFault('provider_unavailable', 'unavailable');
      try {
        // No authorization header: the server has no authentication. The
        // endpoint is loopback, and the tunnel controls the access.
        const response = await wire.withAbort(() => fetchImpl(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body, signal, redirect: 'error', credentials: 'omit',
        }), signal);
        if (!response || !Number.isInteger(response.status)) throw new DecisionFault('invalid_http_response');
        reportTransport({ httpStatus: response.status });
        if (response.status !== 200) {
          if ([400, 422].includes(response.status)) {
            throw new DecisionFault(await refusalCode(response, signal));
          }
          if (response.body?.cancel) Promise.resolve(response.body.cancel()).catch(() => {});
          if ([429, 503].includes(response.status)) {
            throw new DecisionFault('remote_cooldown', 'overloaded', { retryAfterMs: retryAfter(response, now) });
          }
          throw new DecisionFault('http_error', 'unavailable');
        }
        const value = await wire.readResponse(response, maxResponseBytes, signal);
        // The response model must be the same as the configured name.
        return fromSystemOneResponse(wire.validateResponse(value, JSON.parse(body)));
      } catch (error) {
        if (error instanceof DecisionFault) throw error;
        throw new DecisionFault('transport_failure', 'unavailable');
      }
    },
  });
}
