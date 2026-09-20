import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startViewer } from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';
import { snapshot, graph, activity, connectionInfo } from './fixtures.mjs';

const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../../runtime/web/style.css', import.meta.url), 'utf8');

async function harness(t, initial = snapshot(), dashboard = null) {
  const document = createDocument(markup);
  const $ = id => document.getElementById(id);
  // Supply the ancestry relevant to panel focus handling; the shared DOM double
  // intentionally does not parse nested HTML or perform browser layout.
  $('live-sidebar').append($('inspector-body'), $('details-close'), $('onboarding-action'));
  $('live-sidebar').append($('version-update-status'), $('version-update-guide'));
  $('history-panel').append($('history'), $('replay'), $('live'));
  $('activity-panel').append($('activity-content'));
  $('activity-content').append($('activity-list'));
  const originals = new Map(['document', 'window', 'fetch', 'EventSource'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const streams = [], requests = [];
  let current = initial;
  globalThis.document = document;
  globalThis.window = {
    location: { hash: '', pathname: '/', search: '' }, history: {},
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.EventSource = class {
    constructor() { this.listeners = new Map(); streams.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() {}
  };
  globalThis.fetch = async url => {
    requests.push(url);
    if (url === '/api/about') return new Response(JSON.stringify(dashboard || {}), { status: dashboard ? 200 : 404 });
    if (url === '/api/connection-info') return new Response(JSON.stringify(connectionInfo()));
    if (url === '/api/diagnostics') return new Response('{"schemaVersion":1,"records":[]}');
    assert.equal(url, '/api/state');
    return new Response(JSON.stringify(current));
  };
  const viewer = startViewer();
  t.after(() => {
    viewer.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await viewer.ready;
  streams[0].emit('open');
  return {
    $, document, requests, viewer,
    send(value = current) { current = value; streams[0].emit('snapshot', JSON.stringify(value)); },
  };
}

test('workspace starts with a full-width diagram and hidden, explicitly labelled panels', () => {
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'controls retain unique IDs');
  for (const [toggle, panel, label] of [
    ['details-toggle', 'live-sidebar', 'Details'],
    ['history-toggle', 'history-panel', 'History'],
    ['activity-toggle', 'activity-panel', 'Activity'],
  ]) {
    assert.match(markup, new RegExp(`id="${toggle}"[^>]*aria-expanded="false"[^>]*aria-controls="${panel}">${label}</button>`));
    assert.match(markup, new RegExp(`id="${panel}"[^>]* hidden>`));
  }
  const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
  for (const id of ['project-label', 'project-branch', 'project-path', 'graphlin-version']) {
    assert.ok(header.includes(`id="${id}"`), `${id} remains in the always-visible header`);
  }
  assert.ok(header.includes('id="version-update-indicator"'));
  for (const id of ['node-type-filters', 'node-types-all', 'node-types-none']) assert.ok(ids.includes(id));
  assert.match(css, /\.page\s*\{[^}]*height: 100dvh/);
  assert.match(css, /\.workspace-body\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /#activity-content\s*\{[^}]*overflow: auto/);
  assert.doesNotMatch(css, /body\s*\{[^}]*overflow:\s*hidden/);
});

test('panel choices survive snapshots, retain live capture, and never call control APIs', async t => {
  const h = await harness(t);
  for (const id of ['live-sidebar', 'history-panel', 'activity-panel', 'activity-content']) assert.equal(h.$(id).hidden, true);
  const before = h.requests.length;
  await h.$('details-toggle').fire('click');
  await h.$('history-toggle').fire('click');
  assert.equal(h.$('workspace-body').dataset.detailsOpen, 'true');
  assert.equal(h.$('activity-panel').hidden, true);
  h.send(snapshot({ activity: [activity(), activity(2)] }));
  assert.equal(h.$('activity-list').children.length, 2, 'hidden activity keeps updating');
  assert.equal(h.$('live-sidebar').hidden, false);
  assert.equal(h.$('history-panel').hidden, false);
  await h.$('details-toggle').fire('click');
  await h.$('history-toggle').fire('click');
  h.send();
  assert.equal(h.$('workspace-body').dataset.detailsOpen, 'false');
  assert.equal(h.$('live-sidebar').hidden, true);
  assert.equal(h.$('history-panel').hidden, true);
  assert.deepEqual(h.requests.slice(before), []);
});

test('node and arrow keyboard selection opens Details without moving focus or reopening on snapshots', async t => {
  const h = await harness(t);
  const targets = [h.$('node-layer').children[0], h.$('edge-label-layer').querySelector('[role="button"]')];
  for (const [index, target] of targets.entries()) {
    target.focus();
    await target.fire('keydown', { key: index ? ' ' : 'Enter' });
    assert.equal(h.$('live-sidebar').hidden, false);
    assert.equal(h.$('details-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(h.document.activeElement, target);
    assert.match(h.$('inspector-body').textContent, /Source references/);
    await h.$('details-toggle').fire('click');
    h.send();
    assert.equal(h.$('live-sidebar').hidden, true, 'background refresh does not override a closed panel');
  }
});

test('related evidence and activity reveal the destination panel in both directions', async t => {
  const h = await harness(t);
  await h.$('activity-toggle').fire('click');
  assert.equal(h.$('activity-content').hidden, false);
  await h.$('activity-list').children[0].querySelector('button').fire('click');
  assert.equal(h.$('live-sidebar').hidden, false);
  await h.$('activity-toggle').fire('click');
  const related = h.$('inspector-body').children.find(element => element.className === 'related-event');
  assert.ok(related);
  await related.fire('click');
  assert.equal(h.$('activity-panel').hidden, false);
  assert.equal(h.$('activity-content').hidden, false);
  assert.equal(h.$('activity-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, h.$('activity-list').children[0].querySelector('button'));
});

test('Escape closes a focused panel and restores its toggle; hiding history preserves replay', async t => {
  const h = await harness(t);
  for (const [name, panel, control] of [
    ['details', 'live-sidebar', 'onboarding-action'],
    ['history', 'history-panel', 'replay'],
    ['activity', 'activity-panel', 'activity-list'],
  ]) {
    await h.$(`${name}-toggle`).fire('click');
    h.$(control).focus();
    await h.$(control).fire('keydown', { key: 'Escape' });
    assert.equal(h.$(panel).hidden, true);
    assert.equal(h.document.activeElement, h.$(`${name}-toggle`));
  }
  await h.$('history-toggle').fire('click');
  await h.$('replay').fire('click');
  await h.$('history-toggle').fire('click');
  h.send(snapshot({ graph: graph(3) }));
  assert.equal(h.$('history-panel').hidden, true);
  assert.equal(h.$('replay').getAttribute('aria-pressed'), 'true');
  assert.match(h.$('canvas-title').textContent, /replay/);
  await h.$('details-toggle').fire('click');
  await h.$('details-close').fire('click');
  assert.equal(h.document.activeElement, h.$('details-toggle'));
  h.viewer.close();
  await h.$('details-toggle').fire('click');
  assert.equal(h.$('live-sidebar').hidden, true, 'teardown removes panel listeners');
});

test('empty onboarding and errors stay reachable with Details initially closed', async t => {
  const h = await harness(t, snapshot({ graph: graph(0, { nodes: [], edges: [] }), history: [], activity: [] }));
  assert.equal(h.$('live-sidebar').hidden, true);
  assert.equal(h.$('empty-canvas').hidden, false);
  await h.$('how-to-connect').fire('click');
  assert.equal(h.$('connection-dialog').open, true);
  await h.$('connection-dialog-close').fire('click');
  await h.$('details-toggle').fire('click');
  assert.equal(h.$('live-sidebar').hidden, false);
  assert.match(h.$('onboarding-next').textContent, /hook|agent|trust/i);
  assert.match(markup, /id="error-banner"[^>]*role="alert"/);
});

test('replaying a sidebar revision reveals History and its return-to-Live control', async t => {
  const h = await harness(t);
  await h.$('details-toggle').fire('click');
  const revision = h.$('sidebar-change-list').querySelector('button');
  assert.ok(revision);
  assert.equal(h.$('history-panel').hidden, true);
  await revision.fire('click');
  assert.equal(h.$('history-panel').hidden, false);
  assert.equal(h.$('history-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(h.$('replay').getAttribute('aria-pressed'), 'true');
  assert.match(h.$('canvas-title').textContent, /replay/);
  await h.$('live').fire('click');
  assert.equal(h.$('live').getAttribute('aria-pressed'), 'true');
  assert.equal(h.$('history-panel').hidden, false);
});

test('the available-update header control reveals Details and opens the update guide', async t => {
  const h = await harness(t, snapshot(), {
    projectRoot: '/fixture/Notes project', version: '0.1.2',
    branch: { status: 'branch', name: 'main' },
    update: { status: 'available', latest: '0.1.10', command: 'npx --yes graphlin@latest' },
  });
  assert.equal(h.$('live-sidebar').hidden, true);
  assert.equal(h.$('version-update-indicator').hidden, false);
  const scrolls = [];
  h.$('live-sidebar').getBoundingClientRect = () => ({ top: 100, height: 400 });
  h.$('details-heading').getBoundingClientRect = () => ({ height: 46 });
  h.$('version-update-status').getBoundingClientRect = () => ({ top: 300, height: 20 });
  h.$('live-sidebar').scrollTo = options => scrolls.push(options);
  await h.$('version-update-indicator').fire('click');
  assert.equal(h.$('live-sidebar').hidden, false);
  assert.equal(h.$('details-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(h.$('version-update-guide').open, true);
  assert.equal(h.$('version-update-guide').hidden, false);
  assert.deepEqual(scrolls.map(({ top }) => top), [154], 'update guidance clears the sticky Details heading');
  assert.equal(h.$('history-panel').hidden, true);
  assert.equal(h.$('activity-panel').hidden, true);
});
