import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLiveSidebar } from '../../runtime/web/sidebar.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, graph, node, activity } from './fixtures.mjs';

const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../../runtime/web/style.css', import.meta.url), 'utf8');
const empty = () => graph(0, { nodes: [], edges: [] });
const frame = graph => ({ graph, revision: graph.revision, at: 1000 + graph.revision * 1000 });
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const buttons = root => descendants(root).filter(element => element.tagName === 'button');
const classElements = (root, name) => descendants(root).filter(element => element.classList.contains(name));

function setup(t, callbacks = {}) {
  const previous = Object.fromEntries(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = createDocument(markup);
  globalThis.document = document;
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const sidebar = createLiveSidebar(callbacks);
  t.after(() => {
    sidebar.destroy();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { sidebar, document, $: id => document.getElementById(id) };
}

test('sidebar is optional for older markup and absent documents', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    delete globalThis.document;
    assert.doesNotThrow(() => { const sidebar = createLiveSidebar(); sidebar.update(snapshot()); sidebar.destroy(); });
    globalThis.document = createDocument('<div id="live-sidebar"></div>');
    assert.doesNotThrow(() => { const sidebar = createLiveSidebar(); sidebar.update(snapshot()); sidebar.destroy(); });
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  }
});

test('hook receipts include every kind and every project session, newest receipt first and capped', t => {
  const { sidebar, $ } = setup(t);
  const events = Array.from({ length: 205 }, (_, index) => activity(index + 1, {
    receipt: index + 1, sessionId: index % 2 ? 'session-other' : 'session-1',
    kind: index % 2 ? 'tool.requested' : 'tool.succeeded',
    label: `${index % 2 ? 'Before' : 'After'} tool ${index + 1}`,
  }));
  sidebar.update(snapshot({ hookEvents: events }));
  const list = $('sidebar-hook-list');
  assert.equal(list.children.length, 200);
  assert.equal(list.children[0].getAttribute('data-receipt'), '205');
  assert.equal(list.children[199].getAttribute('data-receipt'), '6');
  assert.match(list.textContent, /tool\.requested/);
  assert.match(list.textContent, /tool\.succeeded/);
  assert.match(list.textContent, /Session other/);
  assert.equal($('sidebar-hook-count').textContent, '200');
  assert.match($('sidebar-hook-coverage').textContent, /across this project/);
  const first = list.children[0];
  sidebar.update(snapshot({ hookEvents: events }));
  assert.equal(list.children[0], first, 'same receipts preserve DOM nodes');
  sidebar.update(snapshot({ sessionId: 'session-other', hookEvents: events }), { replay: true });
  assert.equal(list.children[0], first, 'selected session changes do not replace a project-wide feed');
  assert.match($('sidebar-hook-coverage').textContent, /stays live during replay/);
});

test('older daemons show activity with an explicit limitation and preserve collapsed hooks', t => {
  const { sidebar, $ } = setup(t);
  $('sidebar-hooks').open = false;
  sidebar.update(snapshot({ activity: [activity(1), activity(2, { label: 'Latest known activity' })] }));
  assert.match($('sidebar-hook-coverage').textContent, /Detailed hook feed needs a server restart/);
  assert.match($('sidebar-hook-coverage').textContent, /not a list of every received hook/);
  assert.match($('sidebar-hook-list').children[0].textContent, /Latest known activity/);
  assert.equal($('sidebar-hooks').open, false);
  sidebar.update(snapshot({ hookEvents: [] }));
  assert.equal($('sidebar-hook-list').children.length, 0);
  assert.equal($('sidebar-hook-empty').hidden, false);
  assert.doesNotMatch($('sidebar-hook-coverage').textContent, /restart/);
});

test('only new receipts pulse and reduced motion, hidden documents and teardown stop motion', t => {
  const { sidebar, $, document } = setup(t);
  let pulses = 0;
  let cancellations = 0;
  $('sidebar-hook-dot').animate = () => { pulses++; return { cancel() { cancellations++; } }; };
  const first = activity(1, { receipt: 1 });
  const second = activity(2, { receipt: 2 });
  sidebar.update(snapshot({ hookEvents: [first] }));
  assert.equal(pulses, 0, 'an initial retained feed is not newly arriving work');
  sidebar.update(snapshot({ hookEvents: [second, first] }));
  assert.equal(pulses, 1);
  sidebar.update(snapshot({ hookEvents: [second, first] }), { theme: 'ocean' });
  assert.equal(pulses, 1);
  globalThis.window.matchMedia = () => ({ matches: true });
  sidebar.update(snapshot({ hookEvents: [activity(3, { receipt: 3 }), second] }));
  assert.equal(pulses, 1);
  globalThis.window.matchMedia = () => ({ matches: false });
  document.hidden = true;
  sidebar.update(snapshot({ hookEvents: [activity(4, { receipt: 4 })] }));
  assert.equal(pulses, 1);
  sidebar.destroy();
  assert.equal(cancellations, 1);
  assert.equal($('sidebar-hook-list').children.length, 0);
});

test('actual adjacent graph differences create shape and connection tiles, newest first', t => {
  const { sidebar, $ } = setup(t);
  const first = graph(1);
  const second = graph(2, {
    nodes: [node('api', { label: 'Orders API' }), node('queue', { label: 'Work queue', kind: 'queue', shape: 'queue' })],
    edges: [{ ...first.edges[0], id: 'api-queue', target: 'queue', label: 'publishes', relation: 'publishes' }],
  });
  sidebar.update(snapshot({ graph: second, history: [frame(empty()), frame(first), frame(second)] }));
  const cards = $('sidebar-change-list').children;
  assert.deepEqual(cards.map(card => card.getAttribute('data-revision')), ['2', '1']);
  assert.match(cards[0].textContent, /2 added · 2 removed · 1 changed/);
  const tiles = classElements(cards[0], 'change-tile');
  assert.equal(tiles.length, 5);
  assert.equal(tiles.filter(tile => tile.dataset.type === 'edge').length, 2);
  assert.match(cards[0].textContent, /\+ Added/);
  assert.match(cards[0].textContent, /− Removed/);
  assert.match(cards[0].textContent, /↻ Changed/);
  assert.match(cards[0].textContent, /Orders API/);
  assert.match(cards[0].textContent, /Orders API publishes Work queue/);
  assert.match(cards[0].textContent, /Notes API writes PostgreSQL/);
  assert.equal(classElements(cards[0], 'change-miniature').length, 5);
  assert.equal(cards[0].classList.contains('is-new-revision'), false, 'initial history does not animate as new events');
});

test('a first nonempty snapshot is a baseline, never fabricated additions', t => {
  const { sidebar, $ } = setup(t);
  sidebar.update(snapshot({ graph: graph(7), history: [] }));
  const baseline = $('sidebar-change-list').children[0];
  assert.match(baseline.textContent, /History baseline/);
  assert.match(baseline.textContent, /Earlier changes are unavailable/);
  assert.equal(classElements(baseline, 'change-tile').length, 0);
  assert.equal($('sidebar-change-count').textContent, '0');
  sidebar.update(snapshot({ graph: graph(8, { nodes: [], edges: [] }), history: [] }));
  assert.match($('sidebar-change-list').children[0].textContent, /3 removed/);
});

test('observing an empty revision establishes additions without needing a retained zero frame', t => {
  const { sidebar, $ } = setup(t);
  sidebar.update(snapshot({ graph: empty(), history: [] }));
  sidebar.update(snapshot({ graph: graph(1), history: [frame(graph(1))] }));
  const card = $('sidebar-change-list').children[0];
  assert.match(card.textContent, /3 added/);
  assert.equal(card.classList.contains('is-new-revision'), true);
  sidebar.update(snapshot({ graph: graph(1), history: [frame(graph(1))] }));
  assert.equal($('sidebar-change-list').children[0], card);
});

test('layout, theme, activity and source metadata updates invent no diagram changes or focus loss', t => {
  const { sidebar, $, document } = setup(t, { onInspect() {} });
  const first = graph(1);
  sidebar.update(snapshot({ graph: first, history: [frame(empty()), frame(first)] }));
  const card = $('sidebar-change-list').children[0];
  const tileButton = buttons(card)[1];
  tileButton.focus();
  const metadata = structuredClone(first);
  for (const item of metadata.nodes) {
    item.x += 100;
    item.y -= 40;
    item.activityState = 'running';
    item.confidence.supportProbability = .89;
    item.sourceRefs = [];
  }
  sidebar.update(snapshot({ graph: metadata, history: [frame(empty()), frame(metadata)], paused: true }), { theme: 'midnight' });
  assert.equal($('sidebar-change-list').children.length, 1);
  assert.equal($('sidebar-change-list').children[0], card);
  assert.equal(document.activeElement, tileButton);
  assert.equal($('sidebar-history').dataset.theme, 'midnight');
  sidebar.update(snapshot({ graph: { ...metadata, revision: 2 }, history: [frame(empty()), frame(first)] }));
  assert.equal($('sidebar-change-list').children.length, 1, 'a revision without semantic differences gets no card');
});

test('session and project switches never compare unrelated graphs', t => {
  const { sidebar, $ } = setup(t);
  const first = graph(1);
  sidebar.update(snapshot({ graph: first, history: [frame(empty()), frame(first)] }));
  sidebar.update(snapshot({ sessionId: 'session-2', graph: graph(9, { nodes: [node('other')], edges: [] }), history: [] }));
  assert.equal($('sidebar-change-list').children.length, 1);
  assert.match($('sidebar-change-list').textContent, /History baseline/);
  assert.doesNotMatch($('sidebar-change-list').textContent, /Removed|Added/);
  sidebar.update(snapshot({ graph: first, history: [frame(empty()), frame(first)] }));
  assert.match($('sidebar-change-list').textContent, /3 added/);
  assert.equal($('sidebar-change-list').children[0].classList.contains('is-new-revision'), false);
  sidebar.update(snapshot({ projectId: 'other-project', graph: graph(1, { nodes: [node('other')], edges: [] }), history: [] }));
  assert.match($('sidebar-change-list').textContent, /History baseline/);
});

test('a backward live revision clears an old session history, including after switching away', t => {
  const { sidebar, $ } = setup(t);
  const older = graph(2, { nodes: [node('old', { label: 'Old architecture' })], edges: [] });
  for (const switchAway of [false, true]) {
    sidebar.update(snapshot({ graph: older, history: [frame(empty()), frame(older)] }));
    if (switchAway) sidebar.update(snapshot({ sessionId: 'session-2', graph: graph(5), history: [] }));
    sidebar.update(snapshot({ graph: empty(), history: [frame(older)] }));
    assert.equal($('sidebar-change-list').children.length, 0, 'revision zero cannot retain later frames from an earlier incarnation');
    assert.equal($('sidebar-change-empty').hidden, false);
    const fresh = graph(1, { nodes: [node('fresh', { label: 'New architecture' })], edges: [] });
    sidebar.update(snapshot({ graph: fresh, history: [frame(fresh)] }));
    assert.deepEqual($('sidebar-change-list').children.map(card => card.getAttribute('data-revision')), ['1']);
    assert.match($('sidebar-change-list').textContent, /1 added/);
    assert.doesNotMatch($('sidebar-change-list').textContent, /Old architecture|Removed/);
  }
});

test('a vanished session loses cached history even if its later revision is higher', t => {
  const { sidebar, $ } = setup(t);
  const old = graph(2, { nodes: [node('old', { label: 'Evicted architecture' })], edges: [] });
  sidebar.update(snapshot({ graph: old, history: [frame(empty()), frame(old)] }));
  sidebar.update(snapshot({
    sessionId: 'session-2', sessions: [{ id: 'session-2', label: 'Session 2' }], graph: graph(4), history: [],
  }));
  sidebar.update(snapshot({ graph: graph(6, { nodes: [node('fresh')], edges: [] }), history: [] }));
  assert.deepEqual($('sidebar-change-list').children.map(card => card.getAttribute('data-revision')), ['6']);
  assert.match($('sidebar-change-list').textContent, /History baseline/);
  assert.doesNotMatch($('sidebar-change-list').textContent, /Evicted architecture|Added|Removed/);
});

test('replay keeps history because the supplied snapshot still carries the live revision', t => {
  const { sidebar, $ } = setup(t);
  const current = snapshot({ graph: graph(2), history: [frame(empty()), frame(graph(1)), frame(graph(2))] });
  sidebar.update(current);
  const original = $('sidebar-change-list').children[0];
  sidebar.update(structuredClone(current), { replay: true, theme: 'ocean' });
  assert.equal($('sidebar-change-list').children[0], original);
  assert.match($('sidebar-change-note').textContent, /stays live while you replay/);
  sidebar.update(structuredClone(current), { replay: false });
  assert.equal($('sidebar-change-list').children[0], original);
});

test('hook-only snapshots skip full history traversal and reuse cached comparisons and cards', t => {
  const { sidebar, $ } = setup(t);
  const dense = Array.from({ length: 101 }, (_, index) => frame(graph(index + 1, {
    nodes: Array.from({ length: 256 }, (_, index) => ({
      id: `n-${index}`, label: `Component ${index}`, kind: 'service', shape: 'component',
      evidenceState: 'observed', classification: 'accepted', validity: 'current',
    })),
    edges: Array.from({ length: 768 }, (_, edge) => ({
      id: `e-${edge}`, source: `n-${edge % 256}`, target: `n-${(edge + 1) % 256}`,
      relation: 'calls', label: `calls at ${index + 1}`,
      evidenceState: 'observed', classification: 'accepted', validity: 'current',
    })),
  })));
  const coldStart = performance.now();
  sidebar.update(snapshot({ history: dense, graph: dense.at(-1).graph }));
  const coldElapsed = performance.now() - coldStart;
  const firstCard = $('sidebar-change-list').children[0];
  let inspected = 0;
  const watch = values => new Proxy(values.map(value => ({ ...value })), {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) inspected++;
      return Reflect.get(target, property, receiver);
    },
  });
  // Recreate objects just as JSON/SSE intake does; reference identity is not
  // evidence that historical content changed.
  const fresh = dense.map(item => ({
    ...item, graph: { ...item.graph, nodes: watch(item.graph.nodes), edges: watch(item.graph.edges) },
  }));
  const next = snapshot({ history: fresh, graph: fresh.at(-1).graph, hookEvents: [activity(99, { receipt: 99 })] });
  const stringify = JSON.stringify;
  let serializations = 0;
  const start = performance.now();
  try {
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    sidebar.update(next);
  } finally { JSON.stringify = stringify; }
  const elapsed = performance.now() - start;
  assert.ok(inspected < 5000, `${inspected} source items inspected; retained history has over 100,000 items`);
  assert.ok(serializations < 200, `${serializations} serializations imply historical diffs were repeated`);
  assert.equal($('sidebar-change-list').children[0], firstCard);
  assert.match($('sidebar-hook-list').textContent, /Tool completed/);
  t.diagnostic(`101 frames × 256 nodes/768 edges: cold render ${coldElapsed.toFixed(2)}ms; hook update ${elapsed.toFixed(2)}ms; ${inspected} item reads, ${serializations} serializations.`);

  // Adding one revision must not recompute comparisons for all older pairs.
  const newest = structuredClone(dense.at(-1).graph);
  newest.revision++;
  newest.edges[0].label = 'new connection meaning';
  inspected = 0;
  serializations = 0;
  try {
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    sidebar.update(snapshot({ history: [...fresh.slice(1), frame(newest)], graph: newest }));
  } finally { JSON.stringify = stringify; }
  assert.ok(inspected < 7000, `one new revision read ${inspected} retained items`);
  assert.ok(serializations < 5000, `one new revision repeated ${serializations} serialization operations`);
  assert.equal($('sidebar-change-list').children[0].getAttribute('data-revision'), '102');
  assert.equal($('sidebar-change-list').children[1], firstCard, 'older cards remain attached');
});

test('changed frame metadata refreshes its comparison and successor without rebuilding other cards', t => {
  const { sidebar, $ } = setup(t);
  const first = graph(1, { nodes: [node('api', { label: 'First API' })], edges: [] });
  const second = graph(2, { nodes: [node('api', { label: 'Second API' })], edges: [] });
  const third = graph(3, { nodes: [node('api', { label: 'Third API' })], edges: [] });
  sidebar.update(snapshot({ history: [frame(empty()), frame(first), frame(second), frame(third)], graph: third }));
  const thirdCard = $('sidebar-change-list').children[0];
  const replacement = frame({ ...first, nodes: [node('api', { label: 'Corrected first API' })] });
  replacement.at++;
  sidebar.update(snapshot({ history: [frame(empty()), replacement, frame(second), frame(third)], graph: third }));
  assert.match($('sidebar-change-list').textContent, /Corrected first API/);
  assert.equal($('sidebar-change-list').children[0], thirdCard);
});

test('privacy label reprojection refreshes cached visible history even when the current graph is empty', t => {
  const { sidebar, $ } = setup(t);
  const first = graph(1, { nodes: [node('api', { label: 'Private project service' })], edges: [] });
  const gone = graph(2, { nodes: [], edges: [] });
  sidebar.update(snapshot({ history: [frame(empty()), frame(first), frame(gone)], graph: gone }));
  assert.match($('sidebar-change-list').textContent, /Private project service/);
  const redacted = { ...first, nodes: [node('api', { label: 'Service' })] };
  sidebar.update(snapshot({ history: [frame(empty()), frame(redacted), frame(gone)], graph: gone }));
  assert.doesNotMatch($('sidebar-change-list').textContent, /Private project service/);
  assert.match($('sidebar-change-list').textContent, /Service/);
  assert.equal($('sidebar-change-list').children.length, 2);
});

test('current shapes inspect, removals open the prior frame, and unavailable history cannot inspect current namesakes', async t => {
  const inspected = [];
  const replayed = [];
  const { sidebar, $ } = setup(t, { onInspect: (...args) => inspected.push(args), onReplay: revision => replayed.push(revision) });
  const first = graph(1);
  const second = graph(2, { nodes: [node('api', { label: 'Updated API' })], edges: [] });
  sidebar.update(snapshot({ graph: second, history: [frame(empty()), frame(first), frame(second)] }));
  const top = $('sidebar-change-list').children[0];
  await buttons(top)[0].fire('click');
  assert.deepEqual(replayed, [2]);
  const changed = classElements(top, 'change-tile').find(tile => tile.dataset.change === 'changed');
  await changed.querySelector('button').fire('click');
  assert.deepEqual(inspected, [['node', 'api']]);
  const removed = classElements(top, 'change-tile').find(tile => tile.dataset.change === 'removed' && tile.dataset.type === 'node');
  assert.match(removed.querySelector('button').getAttribute('aria-label'), /View removed PostgreSQL at revision 1/);
  await removed.querySelector('button').fire('click');
  assert.deepEqual(replayed, [2, 1]);

  // Reusing a removed ID must still open its old frame, never the new node.
  sidebar.update(snapshot({ graph: graph(3), history: [frame(first), frame(second), frame(graph(3))] }));
  const removalCard = $('sidebar-change-list').children.find(card => card.getAttribute('data-revision') === '2');
  const removal = classElements(removalCard, 'change-tile').find(tile => tile.dataset.change === 'removed' && tile.dataset.type === 'node').querySelector('button');
  await removal.fire('click');
  assert.deepEqual(inspected, [['node', 'api']]);
  assert.deepEqual(replayed, [2, 1, 1]);

  sidebar.update(snapshot({ graph: graph(3), history: [frame(graph(3))] }));
  assert.equal(removal.disabled, true);
  await removal.fire('click');
  assert.deepEqual(replayed, [2, 1, 1]);
});

test('history caps cards and tiles, reports overflow, and marks missing revisions as net changes', t => {
  const { sidebar, $ } = setup(t);
  const revisions = [frame(empty())];
  for (let index = 1; index <= 40; index++) {
    revisions.push(frame(graph(index, { nodes: [node('api', { label: `API ${index}` })], edges: [] })));
  }
  sidebar.update(snapshot({ graph: revisions.at(-1).graph, history: revisions }));
  assert.equal($('sidebar-change-list').children.length, 30);
  assert.equal($('sidebar-change-list').children[0].getAttribute('data-revision'), '40');
  const many = graph(42, { nodes: Array.from({ length: 20 }, (_, index) => node(`new-${index}`)), edges: [] });
  sidebar.update(snapshot({ graph: many, history: revisions }));
  const latest = $('sidebar-change-list').children[0];
  assert.equal(classElements(latest, 'change-tile').length, 12);
  assert.match(latest.textContent, /\+ 9 more changes/);
  assert.match(latest.textContent, /Net changes since revision 40/);
});

test('labels remain text and every palette applies without adding or replacing history', t => {
  const { sidebar, $ } = setup(t);
  const unsafe = '<img src=x onerror=alert(1)>';
  const current = graph(1, { nodes: [node('api', { label: unsafe })], edges: [] });
  const snap = snapshot({ graph: current, history: [frame(empty())], hookEvents: [activity(1, { receipt: 1, label: unsafe })] });
  sidebar.update(snap);
  const card = $('sidebar-change-list').children[0];
  for (const theme of ['sketchbook', 'ocean', 'forest', 'sunset', 'berry', 'sepia', 'blueprint', 'midnight']) {
    sidebar.update(snap, { theme });
    assert.equal($('sidebar-history').dataset.theme, theme);
    assert.equal($('sidebar-change-list').children[0], card);
    if (theme !== 'sketchbook') assert.match(css, new RegExp(`\\.sidebar-theme\\[data-theme="${theme}"\\]`));
  }
  sidebar.update(snap, { theme: 'untrusted-theme' });
  assert.equal($('sidebar-history').dataset.theme, 'sketchbook');
  assert.match(card.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(card.querySelector('img'), null);
  assert.equal($('sidebar-hook-list').querySelector('img'), null);
  sidebar.destroy();
  sidebar.update(snap);
  assert.equal($('sidebar-change-list').children.length, 0);
});

test('sidebar has bounded independent scrolling, reduced motion, and no announcement for each receipt', () => {
  assert.match(markup, /<details class="sidebar-hooks" id="sidebar-hooks" open>/);
  const region = markup.slice(markup.indexOf('<aside class="live-sidebar"'), markup.indexOf('</aside>', markup.indexOf('<aside class="live-sidebar"')));
  const feed = region.slice(region.indexOf('<details class="sidebar-hooks"'));
  assert.doesNotMatch(feed, /aria-live|role="(?:status|alert|log)"/);
  assert.match(region, /id="inspector-body"/);
  assert.match(css, /\.workspace-body\s*\{[^}]*align-items: stretch/);
  assert.match(css, /\.diagram-stage\s*\{[^}]*flex: 1 1 0/);
  assert.match(css, /\.live-sidebar\s*\{[^}]*max-height:[^}]*overflow-y: auto/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
});
