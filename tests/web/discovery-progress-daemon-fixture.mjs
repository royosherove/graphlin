// Generated source and an isolated authenticated daemon for the explicit browser
// check. This never reads a user's project, settings, key, or running daemon.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../runtime/daemon/server.mjs';
import { createDecisionService } from '../../runtime/decisions/index.mjs';
import { ARCHITECTURE_PROFILES } from '../../runtime/architecture/profile.mjs';
import { createRecordedProvider } from '../decisions/recorded-provider.mjs';

export const WITHHELD_SENTINEL = 'SYNTHETIC_WITHHELD_PROGRESS_VALUE';
const sources = {
  'app/orders.js': [
    'export class OrderBook {',
    "  loadOrders() { return [{ id: 'sample-order' }]; }",
    '  saveOrder(order) { return { ...order, saved: true }; }',
    '}',
  ].join('\n'),
  'app/receipts.js': [
    'export class ReceiptDesk {',
    '  sendReceipt(order) { return { orderId: order.id, sent: true }; }',
    '}',
  ].join('\n'),
  'app/settings.js': 'export function readSettings() { return { theme: "daylight" }; }\n',
};

export async function createDiscoveryProgressFixture({
  sourceMode = 'source', metadataFiles = 160, holdArchitecture = true,
} = {}) {
  assert.ok(['source', 'local', 'metadata'].includes(sourceMode));
  assert.ok(Number.isInteger(metadataFiles) && metadataFiles >= 0 && metadataFiles <= 256);
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-progress-browser-')));
  const projectRoot = path.join(directory, 'Harbor Atlas'), dataDir = path.join(directory, 'state');
  const providerCalls = [], gates = new Set();
  let server, service, nextGate, closing;
  function holdNextArchitecture() {
    assert.ok(!nextGate);
    let enter, release;
    const started = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const gate = { enter, wait, released: false, release() {
      gate.released = true; gates.delete(gate); release();
    } };
    nextGate = gate; gates.add(gate);
    return { started, release: gate.release, get released() { return gate.released; } };
  }
  const initialGate = holdArchitecture && sourceMode === 'source' ? holdNextArchitecture() : null;
  const provider = createRecordedProvider({ async transform(value, request, _call, context) {
    assert.equal(JSON.stringify(request).includes(WITHHELD_SENTINEL), false,
      'locally withheld synthetic source must never reach the fake provider');
    if (request.questions.kind) {
      const call = { deadlineAt: context.deadlineAt, returned: false };
      providerCalls.push(call);
      if (nextGate) {
        const gate = nextGate; nextGate = null;
        gate.enter(call);
        await gate.wait;
      }
      // Literal fixture answers exercise actual analysis/admission. These are
      // selected synthetic examples, not a substitute language classifier.
      const code = request.state.evidence.map(value => value.code).join('\n').trim();
      const kind = [sources['app/orders.js'], sources['app/receipts.js']].includes(code) ? 'component' : 'unknown';
      value.answers.kind = { type: 'choice', choice: kind, confidence: 0.99,
        probabilities: { application: 0, component: kind === 'component' ? 0.99 : 0.01,
          unknown: kind === 'unknown' ? 0.99 : 0.01 } };
      value.answers.supported = { type: 'boolean', probability: kind === 'component' ? 0.99 : 0.01 };
      value.answers.missing_context = { type: 'boolean', probability: 0.01 };
      call.returned = true;
    }
    if (value.answers.b_relevance) value.answers.b_relevance.probability = 0.01;
    return value;
  } });
  const close = () => closing ??= (async () => {
    nextGate = null;
    for (const gate of gates) gate.release();
    try { if (server) await server.close(); else await service?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  })();
  try {
    await mkdir(path.join(projectRoot, 'app'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(projectRoot, 'notes'), { mode: 0o700 });
    await Promise.all([
      ...Object.entries(sources).map(([name, text]) => writeFile(path.join(projectRoot, name), text)),
      ...Array.from({ length: metadataFiles }, (_, index) => writeFile(
        path.join(projectRoot, 'notes', `note-${String(index + 1).padStart(3, '0')}.txt`),
        'Synthetic planning note. No executable source.\n')),
    ]);
    // The real service and profile adapter run normally. Only its deadline is
    // extended so screenshots can inspect a deliberately held fake response;
    // these fixture timings are not production performance estimates.
    service = createDecisionService({ provider, profiles: ARCHITECTURE_PROFILES,
      limits: { eventDeadlineMs: 20_000 } });
    const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    server = await startServer({ projectRoot, dataDir, port: 0, decisionService: service,
      policy: { readSource: sourceMode !== 'metadata', transmitSource: sourceMode === 'source', displayEvidence: true },
      dashboardInfoDependencies: {
        fetch: async () => Response.json({ name: 'graphlin', version }),
        execFile(_command, _args, _options, callback) {
          callback(Object.assign(new Error('synthetic_not_git'), { code: 128 }), '', 'not a git repository');
        },
      },
    });
    const launch = new URL(server.url), origin = launch.origin;
    const token = new URLSearchParams(launch.hash.slice(1)).get('token');
    const auth = await fetch(origin + '/api/auth', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), signal: AbortSignal.timeout(2500),
    });
    assert.equal(auth.status, 200);
    await auth.text();
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    async function request(route, { method = 'GET', body } = {}) {
      assert.ok(route.startsWith('/api/'));
      const response = await fetch(origin + route, {
        method, headers: { Cookie: cookie,
          ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      const raw = await response.text();
      assert.equal(raw.includes(WITHHELD_SENTINEL), false, 'HTTP data must not disclose the synthetic withheld value');
      return { status: response.status, data: JSON.parse(raw) };
    }
    return {
      server, origin, cookie, projectRoot, sourceMode, initialGate, providerCalls,
      holdNextArchitecture, request, close,
      model: () => server.pipeline.getModelState(),
      architecture: () => server.pipeline.getArchitectureStatus(),
      async withholdSettings() {
        await writeFile(path.join(projectRoot, 'app/settings.js'),
          `const SESSION_SECRET = '${WITHHELD_SENTINEL}';\nexport function readSettings() { return SESSION_SECRET; }\n`);
        await server.pipeline.reconcile();
      },
      async restoreSettings() {
        await writeFile(path.join(projectRoot, 'app/settings.js'), sources['app/settings.js']);
        await server.pipeline.reconcile();
      },
    };
  } catch (error) { await close(); throw error; }
}
