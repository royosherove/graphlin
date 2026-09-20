import test from 'node:test';
import assert from 'node:assert/strict';
import { connectExtension, validateMessage } from '../../runtime/extensions/sdk.mjs';
import { model, c4Scene, PROJECT } from './fixtures.mjs';

function browser(t) {
  const old = { window: globalThis.window, document: globalThis.document };
  const listeners = new Map(), sent = [];
  const port = { start() {}, close() { this.closed = true; }, postMessage(value) { sent.push(value); } };
  globalThis.window = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type),
  };
  globalThis.document = { getElementById: () => ({}) };
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { sent, port, connect: () => listeners.get('graphlin:connect')({ detail: { port, assets: {} } }) };
}
const message = (changes = {}) => ({
  type: 'graphlin:project', apiVersion: 1, instanceId: 'instance-1', projectId: PROJECT,
  revision: 7, viewEpoch: 1, requestId: 'request-1', model: model(), ...changes,
});

test('SDK projects the synthetic C4 fixture and returns the exact model context', async t => {
  const fake = browser(t);
  connectExtension({ project: c4Scene });
  fake.connect();
  await fake.port.onmessage({ data: message() });
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].type, 'graphlin:scene');
  assert.equal(fake.sent[0].projectId, PROJECT);
  assert.equal(fake.sent[0].revision, 7);
  assert.equal(fake.sent[0].scene.groups[0].parentId, null);
  assert.throws(() => validateMessage(message({ apiVersion: 2 })), /invalid/);
  assert.throws(() => validateMessage(message({ viewEpoch: Infinity })), /invalid/);
});

test('SDK discards late projections and stops pending work on disposal', async t => {
  const fake = browser(t), pending = [];
  let disposed = 0;
  const stop = connectExtension({
    project: () => new Promise(resolve => pending.push(resolve)),
    dispose: () => { disposed++; },
  });
  fake.connect();
  const first = fake.port.onmessage({ data: message() });
  const second = fake.port.onmessage({ data: message({ viewEpoch: 2, requestId: 'request-2' }) });
  pending[0](c4Scene()); await first;
  assert.equal(fake.sent.length, 0);
  pending[1](c4Scene()); await second;
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].requestId, 'request-2');
  const third = fake.port.onmessage({ data: message({ viewEpoch: 3, requestId: 'request-3' }) });
  stop(); stop();
  pending[2](c4Scene()); await third;
  assert.equal(fake.sent.length, 1);
  assert.equal(disposed, 1);
  assert.equal(fake.port.closed, true);
});

test('SDK rejects wrong project/revision and reports only fixed errors', async t => {
  const fake = browser(t);
  connectExtension({ project: () => { throw new Error('private synthetic canary'); } });
  fake.connect();
  await fake.port.onmessage({ data: message({ projectId: 'other-project' }) });
  await fake.port.onmessage({ data: message() });
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[0].type, 'graphlin:error');
  assert.doesNotMatch(JSON.stringify(fake.sent), /private synthetic canary/);
});

test('custom status is bounded and host selections require the granted canonical projection', () => {
  const { model: snapshot, ...context } = message();
  const status = { ...context, type: 'graphlin:status', status: 'ready', itemCount: 3 };
  assert.equal(validateMessage(status, { model: snapshot, context }).status, 'ready');
  for (const patch of [{ status: '<svg>' }, { status: 'unbounded free text' }, { itemCount: Infinity },
    { itemCount: -1 }, { itemCount: 20_001 }, { viewEpoch: 3 }, { instanceId: 'other-instance' }]) {
    assert.throws(() => validateMessage({ ...status, ...patch }, { model: snapshot, context }));
  }
  for (const selection of [{ entityId: 'gateway' }, { relationId: 'writes-store' }, { activityId: 'activity-1' }]) {
    const request = { ...context, type: 'graphlin:select', selection };
    assert.deepEqual(validateMessage(request, { model: snapshot, context }).selection, selection);
    assert.throws(() => validateMessage(request), /projection_required/);
  }
  for (const selection of [{ entityId: 'ungranted' }, { path: '/private/source' }, {},
    { entityId: 'gateway', relationId: 'writes-store' }, { activityId: 'gateway' }]) {
    assert.throws(() => validateMessage({ ...context, type: 'graphlin:select', selection }, { model: snapshot, context }));
  }
  assert.throws(() => validateMessage({
    ...context, type: 'graphlin:select', selection: { entityId: 'gateway' }, projectId: 'other-project',
  }, { model: snapshot }), /context_mismatch/);
  assert.throws(() => validateMessage({ ...status, model: snapshot }), /invalid/);
  assert.throws(() => validateMessage({ ...context, type: 'graphlin:error', code: 'private payload' }), /invalid_extension_error/);
});
