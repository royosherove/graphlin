// Synthetic source and real daemon/decision-service plumbing for the explicit
// browser check. No activity, entities, interpretations, or sessions are seeded.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../runtime/daemon/server.mjs';
import { createRecordedProvider } from '../decisions/recorded-provider.mjs';

const sources = {
  'app/orders.js': [
    'export class OrderBook {',
    "  loadOrders() { return [{ id: 'demo-order', open: true }]; }",
    '  saveOrder(order) { return { ...order, saved: true }; }',
    '}',
    'export function formatOrder(order) { return String(order.id); }',
    '',
  ].join('\n'),
  'app/receipts.js': [
    'export class ReceiptDesk {',
    "  sendReceipt(order) { return `Receipt for ${order.id}`; }",
    '}',
    '',
  ].join('\n'),
};
const selectedLabels = {
  read: new Set(['loadOrders', 'sendReceipt']),
  edit: new Set(['saveOrder', 'sendReceipt']),
};

export async function createActivityDaemonFixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-activity-browser-')));
  const projectRoot = path.join(directory, 'Harbor Orders'), dataDir = path.join(directory, 'state');
  const gates = new Set(), mappings = [];
  let server, nextGate, closing;
  const provider = createRecordedProvider({ async transform(value, request, _call, context) {
    const questions = Object.keys(request.questions);
    if (questions.length && questions.every(id => /^target_\d+$/.test(id))) {
      // This is the real service.evaluate adapter output, not an evaluate stub.
      assert.ok(context.signal instanceof AbortSignal);
      assert.ok(Number.isFinite(context.deadlineAt));
      assert.ok(['read', 'edit'].includes(request.state.hook.toolCategory));
      const selected = [];
      for (const [id, question] of Object.entries(request.questions)) {
        assert.equal(question.type, 'boolean');
        assert.equal(typeof question.instructions.question, 'string');
        // target_N addresses the Nth bounded entity; rubric wording can change
        // without changing this literal synthetic provider's choices.
        const entity = request.state.entities[Number(id.slice('target_'.length))];
        assert.match(entity.id, /^entity_\d+$/);
        const accept = selectedLabels[request.state.hook.toolCategory].has(entity.label);
        if (accept) selected.push(entity.label);
        value.answers[id] = { type: 'boolean', probability: accept ? 0.99 : 0.01 };
      }
      const call = { operation: request.state.hook.toolCategory, kind: request.state.hook.kind,
        neutralEvaluation: true, selectedLabels: selected, deadlineAt: context.deadlineAt, returned: false };
      mappings.push(call);
      if (nextGate) {
        const gate = nextGate;
        nextGate = null;
        gate.enter(call);
        await gate.wait;
      }
      call.returned = true;
    } else if (request.questions.kind) {
      // Architecture is deliberately unknown: Blocks needs only parsed source.
      value.answers.kind = { type: 'choice', choice: 'unknown', confidence: 0.99,
        probabilities: { application: 0, component: 0, unknown: 1 } };
      value.answers.supported = { type: 'boolean', probability: 0.01 };
      value.answers.missing_context = { type: 'boolean', probability: 0.01 };
    }
    if (value.answers.b_relevance) value.answers.b_relevance.probability = 0.01;
    return value;
  } });
  function holdNextMapping() {
    assert.ok(!nextGate);
    let enter, release;
    const started = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const gate = { enter, wait, released: false, release() {
      gate.released = true; gates.delete(gate); release();
    } };
    gates.add(gate); nextGate = gate;
    return { started, release: gate.release, get released() { return gate.released; } };
  }
  const close = () => closing ??= (async () => {
    nextGate = null;
    for (const gate of gates) gate.release();
    try { await server?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  })();
  try {
    await mkdir(path.join(projectRoot, 'app'), { recursive: true, mode: 0o700 });
    await Promise.all(Object.entries(sources).map(([name, source]) => writeFile(path.join(projectRoot, name), source)));
    server = await startServer({ projectRoot, dataDir, port: 0,
      policy: { transmitSource: true, displayEvidence: true }, decisionProvider: provider });
    await server.pipeline.whenIdle();
    const model = () => server.pipeline.getModelState();
    assert.ok(model().entities.some(entity => entity.label === 'loadOrders' && entity.basis === 'parsed'));
    assert.deepEqual(model().activity.filter(event => event.kind.startsWith('tool.')), []);
    const launch = new URL(server.url), origin = launch.origin;
    const token = new URLSearchParams(launch.hash.slice(1)).get('token');
    const response = await fetch(origin + '/api/auth', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), signal: AbortSignal.timeout(2500),
    });
    assert.equal(response.status, 200);
    await response.text();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    function file(name) {
      assert.ok(Object.hasOwn(sources, name));
      return path.join(projectRoot, name);
    }
    async function hook(payload) {
      const result = await server.pipeline.ingest({ cwd: projectRoot, ...payload }, { host: 'claude' });
      assert.equal(result.accepted, true);
      return server.pipeline.getState().hookEvents.at(-1);
    }
    async function startSession(session_id) {
      await hook({ hook_event_name: 'SessionStart', session_id, source: 'startup' });
      await server.pipeline.whenIdle();
      return server.pipeline.getState().sessionId;
    }
    const rows = event => model().activity.filter(row => row.sessionId === event.sessionId &&
      row.agentId === event.agentId && row.toolCallId === event.toolCallId)
      .sort((a, b) => a.sequence - b.sequence);
    return {
      server, pipeline: server.pipeline, projectRoot, origin, cookie, model, file, hook,
      startSession, rows, mappings, holdNextMapping, close,
      async editOrders() {
        const filename = file('app/orders.js');
        const previous = await readFile(filename, 'utf8');
        await writeFile(filename, previous.replace('saved: true', "saved: true, status: 'ready'"));
      },
    };
  } catch (error) { await close(); throw error; }
}
