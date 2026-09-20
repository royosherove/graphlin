import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startViewer } from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, graph, activity } from './fixtures.mjs';

test('full-snapshot UI flow renders evidence as text, pins replay, preserves focus, and uses exact controls', async () => {
  const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
  const document = createDocument(markup);
  const $ = id => document.getElementById(id);
  const calls = [];
  const streams = [];
  const launchToken = 'a'.repeat(43);
  let current = snapshot({ mode: 'demo' });
  class FakeEventSource {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      streams.push(this);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() { this.closed = true; }
  }
  const originals = Object.fromEntries(['document', 'window', 'fetch', 'EventSource'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const location = { hash: `#token=${launchToken}`, pathname: '/', search: '' };
  const window = {
    location,
    history: { state: null, replaceState(_state, _title, url) { calls.push({ erase: url }); location.hash = ''; } },
    addEventListener() {},
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (url === '/api/auth') return new Response('{"ok":true}');
    if (url === '/api/control') {
      const body = JSON.parse(options.body);
      if (body.action === 'pause') current = { ...current, paused: true };
      if (body.action === 'resume') current = { ...current, paused: false };
      if (body.action === 'session') current = { ...current, sessionId: body.sessionId, graph: graph(0, { nodes: [], edges: [] }), history: [], activity: [] };
      return new Response('{"ok":true}');
    }
    assert.equal(url, '/api/state');
    return new Response(JSON.stringify(current));
  };
  let viewer;
  try {
    viewer = startViewer();
    await viewer.ready;
    assert.equal(location.hash, '');
    assert.equal(calls[0].url, '/api/auth');
    assert.deepEqual(JSON.parse(calls[0].body), { token: launchToken });
    assert.equal(calls[0].credentials, 'same-origin');
    assert.deepEqual(calls[1], { erase: '/' });
    assert.equal(streams.length, 1);
    const stream = streams[0];
    assert.equal(stream.url, '/api/events');
    assert.ok(stream.listeners.has('snapshot'));
    assert.equal(stream.listeners.has('message'), false);
    stream.emit('open');
    assert.equal($('pause').disabled, false);
    assert.equal($('demo-banner').hidden, false);
    assert.equal($('node-layer').children.length, 2);

    const edgeGroup = $('edge-layer').children[0];
    const edgeButton = $('edge-label-layer').querySelector('[role="button"]');
    assert.equal(edgeButton.getAttribute('aria-label'), 'Notes API writes PostgreSQL. Code evidence. Inspect evidence.');
    assert.equal(edgeGroup.getAttribute('role'), null, 'the broad curve group is not the semantic click target');
    assert.equal(edgeButton.querySelector('path'), null, 'the button bounds contain the compact label, not the curve');
    const labelBackground = edgeButton.querySelector('rect');
    assert.equal(labelBackground.getAttribute('pointer-events'), 'all');
    assert.ok(Number(labelBackground.getAttribute('x')) < 0 && Number(labelBackground.getAttribute('y')) < 0);
    assert.ok(Number(labelBackground.getAttribute('width')) <= 198 && Number(labelBackground.getAttribute('height')) === 26);
    await labelBackground.fire('click');
    assert.equal(edgeButton.getAttribute('aria-pressed'), 'true');
    assert.match($('inspector-body').textContent, /Writes relationship/);
    await edgeButton.fire('click');
    assert.equal(edgeButton.getAttribute('aria-pressed'), 'true', 'repeated semantic clicks do not clear the selection');
    edgeButton.focus();
    stream.emit('snapshot', JSON.stringify(current));
    assert.equal($('edge-label-layer').querySelector('[role="button"]'), edgeButton);
    assert.equal(document.activeElement, edgeButton);
    assert.equal(edgeButton.getAttribute('aria-pressed'), 'true', 'same-session snapshots preserve selection');
    await $('fit').fire('click');
    await $('zoom-in').fire('click');
    await $('live').fire('click');
    assert.equal(edgeButton.getAttribute('aria-pressed'), 'true', 'sibling view controls preserve selection');
    await $('clear-selection').fire('click');
    assert.equal(edgeButton.getAttribute('aria-pressed'), 'false');
    await edgeGroup.children.find(child => child.getAttribute('class') === 'edge-hit').fire('click');
    assert.equal(edgeButton.getAttribute('aria-pressed'), 'true', 'the arrow hit path also opens the inspector');
    await edgeButton.fire('keydown', { key: 'Enter' });
    assert.equal(edgeButton.getAttribute('aria-pressed'), 'true', 'keyboard activation is idempotent');

    $('auto-arrange').checked = false;
    await $('auto-arrange').fire('change');
    const originalNodes = [...$('node-layer').children];
    const nodeTransforms = originalNodes.map(group => group.getAttribute('transform'));
    const baseEdge = current.graph.edges[0];
    current.graph.edges = [
      ...['calls', 'writes', 'depends_on'].map(relation => ({ ...baseEdge, id: relation, relation, label: relation })),
      { ...baseEdge, id: 'reverse-writes', source: 'database', target: 'api' },
    ];
    stream.emit('snapshot', JSON.stringify(current));
    const parallelEdges = [...$('edge-layer').children].map(group => ({
      group,
      path: group.children.find(child => child.getAttribute('class') === 'edge-line').getAttribute('d'),
      labelTransform: group.control.getAttribute('transform'),
      accessibleLabel: group.control.getAttribute('aria-label'),
    }));
    assert.equal(new Set(parallelEdges.map(edge => edge.path)).size, 4);
    assert.equal(new Set(parallelEdges.map(edge => edge.labelTransform)).size, 4);
    assert.ok(parallelEdges.some(edge => edge.accessibleLabel === 'Notes API calls PostgreSQL. Code evidence. Inspect evidence.'));
    assert.ok(parallelEdges.some(edge => edge.accessibleLabel === 'PostgreSQL writes Notes API. Code evidence. Inspect evidence.'));
    current.graph.edges.reverse();
    stream.emit('snapshot', JSON.stringify(current));
    for (const edge of parallelEdges) {
      assert.equal(edge.group.children.find(child => child.getAttribute('class') === 'edge-line').getAttribute('d'), edge.path);
      assert.equal(edge.group.control.getAttribute('aria-label'), edge.accessibleLabel);
    }
    assert.deepEqual($('node-layer').children, originalNodes);
    assert.deepEqual(originalNodes.map(group => group.getAttribute('transform')), nodeTransforms);
    assert.equal($('edge-label-layer').children.length, 4, 'removed edges do not leave stale label buttons behind');

    const malicious = '<img src=x onerror=alert(1)>';
    current = snapshot({ mode: 'demo' });
    current.graph.nodes[0].label = malicious;
    current.graph.nodes[0].sourceRefs[0].excerpt = '<script>globalThis.exposed=true</script>';
    stream.emit('snapshot', JSON.stringify(current));
    const nodeGroup = $('node-layer').children[0];
    nodeGroup.focus();
    await nodeGroup.fire('click');
    assert.ok($('inspector-body').textContent.includes(malicious));
    assert.ok($('inspector-body').textContent.includes('<script>globalThis.exposed=true</script>'));
    assert.equal($('inspector-body').querySelector('img'), null);
    assert.equal($('inspector-body').querySelector('script'), null);
    assert.match($('inspector-body').textContent, /Not established by this snapshot/);
    assert.match($('inspector-body').textContent, /94\.0%/);
    const details = $('inspector-body').querySelector('details');
    details.open = true;

    current = { ...current, activity: [...current.activity, activity(2, { label: 'Source changed' })] };
    stream.emit('snapshot', JSON.stringify(current));
    assert.equal($('inspector-body').querySelector('details'), details, 'activity-only snapshots preserve the open evidence panel');
    assert.equal(details.open, true);
    assert.equal(document.activeElement, nodeGroup, 'the focused SVG component is retained');
    assert.equal($('activity-list').children.length, 2);
    assert.match($('activity-list').children[0].textContent, /Source changed/);

    await $('replay').fire('click');
    assert.equal($('revision').textContent, 'Revision 1');
    assert.equal($('replay').getAttribute('aria-pressed'), 'true');
    current = { ...current, graph: graph(3), history: [...current.history, { revision: 2, at: 100, graph: current.graph }], activity: [...current.activity, activity(3)] };
    stream.emit('snapshot', JSON.stringify(current));
    assert.equal($('revision').textContent, 'Revision 1');
    assert.match($('activity-count').textContent, /3 recent/);
    assert.match($('activity-note').textContent, /Live activity continues/);

    const replayEdgeButton = $('edge-label-layer').querySelector('[role="button"]');
    await replayEdgeButton.fire('click');
    await $('pause').fire('click');
    const pauseCall = calls.find(call => call.url === '/api/control');
    assert.deepEqual(JSON.parse(pauseCall.body), { action: 'pause' });
    assert.equal(pauseCall.headers['Content-Type'], 'application/json');
    assert.equal($('pause').textContent, 'Resume classification');
    assert.match($('capture-note').textContent, /Capture and evidence invalidation continue/);
    assert.equal($('revision').textContent, 'Revision 1');
    assert.equal(replayEdgeButton.getAttribute('aria-pressed'), 'true', 'classification controls and their refreshed snapshot preserve edge selection');
    assert.match($('inspector-body').textContent, /Writes relationship/);

    await $('live').fire('click');
    assert.equal($('revision').textContent, 'Revision 3');
    stream.emit('snapshot', '{broken');
    assert.equal($('revision').textContent, 'Revision 3');
    assert.equal($('error-banner').hidden, false);
    stream.emit('error');
    assert.equal($('pause').disabled, true);
    assert.match($('connection-label').textContent, /Disconnected/);
    stream.emit('snapshot', JSON.stringify(current));
    assert.equal($('pause').disabled, false);
    assert.equal($('error-banner').hidden, true);

    $('session').value = 'session-2';
    await $('session').fire('change');
    const sessionCall = calls.filter(call => call.url === '/api/control').at(-1);
    assert.deepEqual(JSON.parse(sessionCall.body), { action: 'session', sessionId: 'session-2' });
    assert.equal($('revision').textContent, 'Revision 0');
    assert.equal($('node-layer').children.length, 0);
    assert.equal($('edge-label-layer').children.length, 0);
    assert.equal($('empty-canvas').hidden, false);
    assert.equal($('live').getAttribute('aria-pressed'), 'true');
    assert.equal(calls.filter(call => call.url === '/api/auth').length, 1, 'launch token is used only once');
  } finally {
    viewer?.close();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
