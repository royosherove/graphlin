import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  validateManifest, validateAssets, validateScene, validateDecisionProfile,
  createFrameDocument, bundleDigest,
} from '../../runtime/extensions/index.mjs';
import { packageFiles, model, c4Scene, profile } from './fixtures.mjs';

test('manifest negotiates exact versions, capabilities, feature tokens and hashes', () => {
  const { manifest, assets } = packageFiles();
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.deepEqual(validateAssets(manifest, assets), assets);
  for (const patch of [
    { graphlinApi: '^1' }, { modelSchema: '3' }, { requiredFeatures: ['unknown'] },
    { capabilities: ['filesystem.read'] }, { entry: '../evil.js' },
    { assets: { 'https://example.invalid/x.js': 'sha256-' + 'a'.repeat(64) } },
    { entry: 'dist/%2e%2e/evil.js' }, { renderer: { kind: 'svg' } }, { source: 'not allowed' },
  ]) assert.throws(() => validateManifest({ ...manifest, ...patch }));
  assert.throws(() => validateAssets(manifest, { ...assets, 'dist/visualizer.js': Buffer.from('different') }), /integrity/);
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(bundleDigest(reordered), bundleDigest(manifest));
  assert.notEqual(bundleDigest({ ...manifest, version: '1.0.1' }), bundleDigest(manifest));
});

test('decision profiles admit bounded neutral descriptors and reject source selectors and executable fields', () => {
  assert.deepEqual(validateDecisionProfile(profile), profile);
  for (const bad of [
    { ...profile, selectors: { fields: ['source'], candidateIds: [] } },
    { ...profile, selectors: { ...profile.selectors, path: '/private/source' } },
    { ...profile, threshold: 0.7 },
    { ...profile, questions: [{ id: 'role', kind: 'choice', question: 'Role?', options: ['same', 'same'] }] },
    { ...profile, questions: [{ id: 'role', kind: 'boolean', question: 'Role?', options: ['yes', 'no'] }] },
  ]) assert.throws(() => validateDecisionProfile(bad));
});

test('synthetic C4 scene maps canonical entities and preserves group parent references', () => {
  const snapshot = model(), scene = c4Scene(snapshot);
  const validated = validateScene(scene, { model: snapshot });
  assert.deepEqual(validated, scene);
  assert.notEqual(validated.nodes[0], scene.nodes[0]);
  assert.equal(validated.nodes[0].parentId, 'group-project');
  for (const modify of [
    value => { value.nodes[0].label = '<svg onload=evil()>'; },
    value => { value.nodes[0].url = 'https://example.invalid'; },
    value => { value.nodes[0].style = 'background:url(example)'; },
    value => { value.nodes[0].x = Infinity; },
    value => { value.nodes[0].y = NaN; },
    value => { value.nodes[0].width = 1_000_000; },
    value => { value.nodes[0].entityId = 'invented'; },
    value => { value.nodes[0].parentId = 'node-store'; },
    value => { value.groups[0].parentId = 'group-project'; },
    value => { value.edges[0].target = 'absent'; },
    value => { value.edges[0].kind = 'calls'; },
    value => { value.edges[0].relationIds = ['invented']; },
    value => { value.edges[0].count = 99; },
    value => { value.groups[0].html = '<div>'; },
    value => { value.nodes = Array.from({ length: 257 }, (_, i) => ({ ...value.nodes[0], id: `node-${i}` })); },
  ]) {
    const candidate = structuredClone(scene); modify(candidate);
    assert.throws(() => validateScene(candidate, { model: snapshot }));
  }
});

test('frame response applies sandbox to direct navigation and admits only exact inline scripts', () => {
  const { manifest, assets } = packageFiles({ source: 'window.label = "</script><script>malicious()</script>";' });
  const result = createFrameDocument({ manifest, assets, nonce: 'n'.repeat(32) });
  assert.equal(result.headers['Content-Security-Policy'], result.csp);
  assert.match(result.csp, /sandbox allow-scripts/);
  assert.doesNotMatch(result.csp, /allow-same-origin|unsafe-inline|unsafe-eval|https:|blob:/);
  assert.match(result.csp, /connect-src 'none'/);
  assert.match(result.csp, /worker-src 'none'/);
  assert.equal((result.body.match(/<script>/g) ?? []).length, 1);
  assert.equal((result.body.match(/<\/script>/g) ?? []).length, 1);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.throws(() => createFrameDocument({ manifest, assets, nonce: 'weak' }), /nonce/);
});

test('trusted bootstrap requires parent, nonce, one port and consumes it only once', () => {
  const { manifest, assets } = packageFiles();
  const result = createFrameDocument({ manifest, assets, nonce: 'n'.repeat(32) });
  const listeners = new Map(), events = [], scripts = [], parent = {};
  const window = {
    parent, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type),
    dispatchEvent: event => events.push(event),
  };
  const document = { createElement: () => ({}), body: { appendChild: script => scripts.push(script.textContent) } };
  vm.runInNewContext(result.body.match(/<script>([\s\S]+)<\/script>/)[1], { window, document });
  assert.equal(scripts[0], assets[manifest.entry].toString());
  const receive = listeners.get('message'), sent = [];
  const port = { start() {}, postMessage: message => sent.push(message) };
  const input = { source: parent, data: { type: 'graphlin:bootstrap', apiVersion: 1, nonce: 'n'.repeat(32) }, ports: [port] };
  receive({ ...input, source: {} });
  receive({ ...input, data: { ...input.data, nonce: 'x'.repeat(32) } });
  receive({ ...input, ports: [] });
  assert.equal(sent.length, 0);
  receive(input); receive(input);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'graphlin:ready');
  assert.equal(events[0].type, 'graphlin:connect');
  assert.equal(events[0].detail.port, port);
  assert.equal(listeners.has('message'), false);
});
