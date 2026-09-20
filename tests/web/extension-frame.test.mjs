import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionFrame } from '../../runtime/web/extension-frame.js';
import { structureScene } from '../../runtime/visualizers/structure.mjs';
import { createDocument } from './fake-dom.mjs';
import { model } from './model-fixtures.mjs';

const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
function harness(renderer = 'graphlin-scene', capabilities = ['selection.request']) {
  const document = createDocument(''), root = document.createElement('section'), selections = [];
  const ports = [], sent = [], bootstraps = [];
  let failures = 0;
  class Port {
    postMessage(message) { sent.push(message); }
    start() {}
    close() { this.closed = true; }
    emit(data) { this.onmessage?.({ data }); }
  }
  class Channel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); ports.push(this.port1); }
  }
  const extension = { id: 'example.fixture', digest: 'b'.repeat(64), manifest: { renderer: { kind: renderer }, capabilities },
    grant: { approved: true, projectId: 'project.fixture', extensionId: 'example.fixture', digest: 'b'.repeat(64),
      fields: ['entities', 'relations', 'activity'] } };
  const instance = createExtensionFrame({ root, Channel, nonce: 'a'.repeat(48), timeout: 1000, extension,
    onSelect: value => selections.push(value), onFailure: () => failures++ });
  const frame = root.children[0];
  frame.contentWindow = { postMessage: (...args) => bootstraps.push(args) };
  return { instance, extension, root, frame, sent, bootstraps, selections, port: ports[0],
    get failures() { return failures; },
    async ready() {
      await frame.fire('load');
      ports[0].emit({ type: 'graphlin:ready', apiVersion: 1, nonce: 'a'.repeat(48) });
      await settle();
    },
  };
}
const response = (request, extra = {}) => {
  const { model: _model, settings: _settings, selection: _selection, ...context } = request;
  return { ...context, type: 'graphlin:scene', ...extra };
};

test('frame bootstrap targets the exact sandbox window and sends no data before matching readiness', async () => {
  const h = harness(), input = model();
  const update = h.instance.update({ model: input, viewEpoch: 2 });
  assert.equal(h.sent.length, 0);
  assert.equal(h.frame.getAttribute('sandbox'), 'allow-scripts');
  assert.match(h.frame.getAttribute('src'), /^\/api\/extensions\/frame\/example.fixture\?nonce=/);
  await h.ready();
  assert.equal(h.bootstraps.length, 1);
  assert.equal(h.bootstraps[0][0].type, 'graphlin:bootstrap');
  assert.equal(h.bootstraps[0][2].length, 1);
  assert.equal(h.sent[0].type, 'graphlin:project');
  assert.equal(h.sent[0].viewEpoch, 2);
  h.port.emit(response(h.sent[0], { scene: structureScene(input) }));
  assert.equal((await update).kind, 'scene');
  h.port.emit(response(h.sent[0], { type: 'graphlin:select', selection: { entityId: 'run' } }));
  assert.deepEqual(h.selections, [{ entityId: 'run' }]);
  h.instance.dispose();
  assert.equal(h.root.childElementCount, 0);
  assert.equal(h.port.closed, true);
});

test('stale responses cannot replace the latest scene, and hostile geometry tears down the frame', async () => {
  const h = harness(), input = model();
  const update = h.instance.update({ model: input, viewEpoch: 4 });
  const rejected = assert.rejects(update, /invalid_scene_coordinate/);
  await h.ready();
  h.port.emit(response(h.sent[0], { viewEpoch: 3, scene: structureScene(input) }));
  assert.equal(h.failures, 0);
  const scene = structureScene(input); scene.groups[0].x = Infinity;
  h.port.emit(response(h.sent[0], { scene }));
  await rejected;
  assert.equal(h.failures, 1);
  assert.equal(h.root.childElementCount, 0);
});

test('frame navigation revokes its one-use port; custom status does not need a graph', async () => {
  const h = harness('custom'), input = model({ entities: [], relations: [] });
  const update = h.instance.update({ model: input });
  await h.ready();
  h.port.emit(response(h.sent[0], { type: 'graphlin:status', status: 'busy', itemCount: 0 }));
  h.port.emit(response(h.sent[0], { type: 'graphlin:status', status: 'ready', itemCount: 3 }));
  assert.deepEqual(await update, { kind: 'custom', status: 'ready', itemCount: 3 });
  await h.frame.fire('load');
  assert.equal(h.failures, 1);
  assert.equal(h.port.closed, true);
  assert.equal(h.bootstraps.length, 1);
});

test('frame selection needs a declared request capability and an active matching data grant', async () => {
  for (const capabilities of [[], ['inspection.request']]) {
    const h = harness('graphlin-scene', capabilities), input = model();
    const update = h.instance.update({ model: input });
    await h.ready();
    h.port.emit(response(h.sent[0], { scene: structureScene(input) })); await update;
    const select = response(h.sent[0], { type: 'graphlin:select', selection: { entityId: 'run' } });
    h.port.emit(select);
    assert.equal(h.selections.length, capabilities.length ? 1 : 0);
    h.extension.grant.approved = false;
    h.port.emit(select);
    assert.equal(h.selections.length, capabilities.length ? 1 : 0);
    h.instance.dispose();
  }
});
