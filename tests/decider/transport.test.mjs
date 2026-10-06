import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createDeciderProvider, deciderFetch } from '../../runtime/decider/provider.mjs';
import { createDecisionService, DecisionFault } from '../../runtime/decisions/index.mjs';
import { createConfiguredProvider, decisionServiceOptions, deciderConfig } from '../../runtime/daemon/providers.mjs';
import { input, makeCore } from '../jev/helpers.mjs';
import { fakeDeciderServer } from './fake-server.mjs';

// These tests use the real node:http transport of the decider provider. Each
// server listens on 127.0.0.1 with a free port. No request leaves this host.
const providerURL = new URL('../../runtime/decider/provider.mjs', import.meta.url).href;
const booleanRequest = { state: { text: 'synthetic' }, questions: {
  q: { type: 'boolean', instructions: { question: 'Is this synthetic?' }, criteria: { true: 'Yes', false: 'No' } },
} };
const answer = body => JSON.stringify({ model: JSON.parse(body).model,
  answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } });

function execute(endpoint, { signal = new AbortController().signal, maxResponseBytes = 65536 } = {}) {
  const provider = createDeciderProvider({ endpoint, transmitSource: true });
  return provider.execute(provider.encode(booleanRequest), { signal, maxResponseBytes });
}

// Run a small ES module in a child process with an environment proxy that
// points to a local listener. The child prints one JSON line.
async function childWithProxy(proxyURL, source, extraEnv = {}) {
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyURL, http_proxy: proxyURL,
    HTTPS_PROXY: proxyURL, https_proxy: proxyURL, ...extraEnv };
  for (const name of ['NO_PROXY', 'no_proxy', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[name];
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout.trim());
}

const refusingProxy = t => fakeDeciderServer(t, (_entry, res) => { res.writeHead(502); res.end(); });

test('an environment proxy gets no decider request: the provider connects to the loopback endpoint', async t => {
  const decider = await fakeDeciderServer(t, (entry, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(answer(entry.body));
  });
  const proxy = await refusingProxy(t);
  const result = await childWithProxy(`http://127.0.0.1:${proxy.port}`, `
    const { createDeciderProvider } = await import(${JSON.stringify(providerURL)});
    const provider = createDeciderProvider({ endpoint: process.env.DECIDER_ENDPOINT, transmitSource: true });
    const request = ${JSON.stringify(booleanRequest)};
    try {
      const value = await provider.execute(provider.encode(request),
        { signal: AbortSignal.timeout(5000), maxResponseBytes: 65536 });
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); }
  `, { DECIDER_ENDPOINT: decider.endpoint });
  assert.equal(proxy.connections, 0, 'the proxy listener gets no connection');
  assert.equal(proxy.requests.length, 0, 'the proxy listener gets no request');
  assert.deepEqual(result, { ok: true, value: { answers: { q: { type: 'boolean', probability: 0.9 } },
    usage: { inputTokens: 3, outputTokens: 1 } } });
  assert.equal(decider.requests.length, 1);
  assert.equal(decider.requests[0].url, '/v1/systemone');
});

test('control: in the same environment, global fetch goes to the proxy listener', async t => {
  const decider = await fakeDeciderServer(t);
  const proxy = await refusingProxy(t);
  const result = await childWithProxy(`http://127.0.0.1:${proxy.port}`, `
    try {
      const response = await fetch(process.env.DECIDER_ENDPOINT, { method: 'POST', body: '{}',
        signal: AbortSignal.timeout(5000) });
      console.log(JSON.stringify({ status: response.status }));
    } catch { console.log(JSON.stringify({ status: 0 })); }
  `, { DECIDER_ENDPOINT: decider.endpoint });
  if (proxy.requests.length === 0) {
    t.skip('this Node.js version does not use NODE_USE_ENV_PROXY; the test above is then not a proof');
    return;
  }
  assert.equal(result.status, 502);
  assert.equal(decider.requests.length, 0);
});

test('deciderFetch sends the exact body with fixed headers and no authorization header', async t => {
  const decider = await fakeDeciderServer(t, (entry, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-extra': 'a' });
    res.end(answer(entry.body));
  });
  const provider = createDeciderProvider({ endpoint: decider.endpoint, transmitSource: true });
  const body = provider.encode(booleanRequest);
  const value = await provider.execute(body, { signal: new AbortController().signal, maxResponseBytes: 65536 });
  assert.equal(value.answers.q.probability, 0.9);
  const [request] = decider.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.body, body);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['content-length'], String(Buffer.byteLength(body)));
  assert.equal(request.headers.host, `127.0.0.1:${decider.port}`);
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.cookie, undefined);
  const response = await deciderFetch(decider.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-extra'), 'a');
  assert.equal(JSON.parse(await response.text()).model, JSON.parse(body).model);
});

test('deciderFetch refuses a URL that is not a loopback http decider endpoint and opens no connection', async t => {
  const decider = await fakeDeciderServer(t);
  for (const url of [`https://127.0.0.1:${decider.port}/v1/systemone`, `http://localhost:${decider.port}/v1/systemone`,
    `http://127.0.0.1:${decider.port}/other`, 'http://192.0.2.1/v1/systemone', 'not a url']) {
    await assert.rejects(deciderFetch(url, { method: 'POST', body: '{}' }), TypeError, url);
  }
  assert.equal(decider.connections, 0);
});

test('server results through the real transport keep the fault codes, statuses and Retry-After', async t => {
  const replies = {
    '422w': [422, {}, JSON.stringify({ detail: 'prompt too long', code: 'context_window_exceeded' })],
    422: [422, {}, JSON.stringify({ detail: 'RAW_DETAIL' })],
    400: [400, {}, '{}'],
    401: [401, {}, ''],
    500: [500, {}, 'RAW_INTERNAL'],
    503: [503, { 'retry-after': '1' }, JSON.stringify({ detail: 'busy', code: 'busy' })],
    429: [429, { 'retry-after-ms': '250' }, ''],
    204: [204, {}, undefined],
    307: [307, { location: 'http://192.0.2.1/v1/systemone' }, ''],
  };
  let current;
  const decider = await fakeDeciderServer(t, (_entry, res) => {
    const [status, headers, body] = replies[current];
    res.writeHead(status, headers);
    res.end(body);
  });
  const expected = [
    ['422w', 'request_too_large', 'invalid'], [422, 'request_rejected', 'invalid'], [400, 'request_rejected', 'invalid'],
    [401, 'http_error', 'unavailable'], [500, 'http_error', 'unavailable'], [503, 'remote_cooldown', 'overloaded', 1000],
    [429, 'remote_cooldown', 'overloaded', 250], [204, 'http_error', 'unavailable'],
    // fetch with redirect 'error' gives a network error; the transport keeps that rule.
    [307, 'transport_failure', 'unavailable'],
  ];
  for (const [name, code, status, retryAfterMs] of expected) {
    current = name;
    await assert.rejects(execute(decider.endpoint), error => {
      assert.ok(error instanceof DecisionFault);
      assert.deepEqual([error.code, error.status, error.retryAfterMs], [code, status, retryAfterMs]);
      assert.doesNotMatch(String(error.message), /RAW_/);
      return true;
    }, String(name));
  }
  assert.equal(decider.requests.length, expected.length, 'no redirect is followed');
});

test('a body above maxResponseBytes stops as response_too_large and closes the connection', async t => {
  const decider = await fakeDeciderServer(t, (_entry, res, count) => {
    res.writeHead(200, count === 1 ? { 'content-length': String(1024 * 1024) } : {});
    const chunk = Buffer.alloc(16 * 1024, 0x20);
    let written = 0;
    const write = () => {
      while (written < 1024 * 1024 && !res.destroyed) {
        written += chunk.length;
        if (!res.write(chunk)) { res.once('drain', write); return; }
      }
      if (!res.destroyed) res.end();
    };
    res.on('error', () => {});
    write();
  });
  for (let index = 0; index < 2; index++) {
    await assert.rejects(execute(decider.endpoint, { maxResponseBytes: 4096 }),
      error => error instanceof DecisionFault && error.code === 'response_too_large');
  }
  const deadline = Date.now() + 2000;
  while (decider.openSockets && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(decider.openSockets, 0);
});

test('an abort during the response body settles as cancelled and closes the connection', async t => {
  let wrote;
  const written = new Promise(resolve => { wrote = resolve; });
  const decider = await fakeDeciderServer(t, (_entry, res) => {
    res.writeHead(200, { 'content-length': '1000' });
    res.write('{"model":');
    res.on('error', () => {});
    wrote();
  });
  const controller = new AbortController();
  const pending = execute(decider.endpoint, { signal: controller.signal });
  await written;
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, error => error instanceof DecisionFault && error.code === 'cancelled');
  const deadline = Date.now() + 2000;
  while (decider.openSockets && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(decider.openSockets, 0);
});

test('the event deadline stops a stalled server through the real transport', async t => {
  const decider = await fakeDeciderServer(t, (_entry, res) => { res.on('error', () => {}); });
  const config = deciderConfig({ endpoint: decider.endpoint });
  const options = decisionServiceOptions(config);
  const service = createDecisionService({
    provider: createConfiguredProvider(config, { transmitSource: true }), ...makeCore(),
    ...options, limits: { ...options.limits, eventDeadlineMs: 200 },
  });
  t.after(() => service.close());
  const result = await service.classify(input());
  assert.equal(result.status, 'timeout');
  assert.equal(result.diagnostics.code, 'deadline_exceeded');
  assert.equal(decider.requests.length, 1);
  const deadline = Date.now() + 2000;
  while (decider.openSockets && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(decider.openSockets, 0);
});

test('a tunnel that is down (connection refused) is transport_failure through the real transport', async () => {
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(execute(`http://127.0.0.1:${port}/v1/systemone`),
    error => error instanceof DecisionFault && error.code === 'transport_failure' && error.status === 'unavailable');
});
