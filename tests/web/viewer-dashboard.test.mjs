import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startDashboardInfo } from '../../runtime/web/app.js';
import { createDocument } from './fake-dom.mjs';

const info = overrides => ({
  projectRoot: '/fixture/Project with spaces',
  branch: { status: 'branch', name: 'feature/search' },
  version: '0.1.2',
  update: { status: 'available', latest: '0.1.10',
    command: "cd '/fixture/Project with spaces' && npx --yes graphlin@latest" },
  ...overrides,
});

async function harness(load, clipboard = { writeText: async () => {} }) {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const keys = ['document', 'window', 'setTimeout', 'clearTimeout'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const timers = new Map();
  let id = 0;
  globalThis.document = document;
  globalThis.window = { navigator: { clipboard } };
  globalThis.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); return id; };
  globalThis.clearTimeout = key => timers.delete(key);
  const view = startDashboardInfo({ load });
  return {
    view, timers, $: key => document.getElementById(key),
    close() {
      view.close();
      assert.equal(timers.size, 0);
      for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else delete globalThis[key];
      }
    },
  };
}

test('dashboard displays project metadata literally and copies the complete update command', async () => {
  const copied = [];
  const supplied = info({ projectRoot: '/fixture/<img src=x>',
    branch: { status: 'branch', name: '<script>branch</script>' } });
  const h = await harness(async () => supplied, { writeText: async command => copied.push(command) });
  try {
    await h.view.refresh();
    assert.equal(h.$('project-path').textContent, supplied.projectRoot);
    assert.equal(h.$('project-path').children.length, 0);
    assert.equal(h.$('project-branch').textContent, supplied.branch.name);
    assert.equal(h.$('graphlin-version').textContent, '0.1.2');
    assert.equal(h.$('version-update-status').textContent, 'Graphlin 0.1.10 is available');
    assert.equal(h.$('version-update-guide').hidden, false);
    await h.$('version-update-copy').fire('click');
    assert.deepEqual(copied, [supplied.update.command]);
    assert.equal(h.$('version-update-copy-status').textContent, 'Copied');
    assert.equal([...h.timers.values()][0].delay, 30000);
  } finally { h.close(); }
});

test('branch changes refresh, detached/non-Git states are explicit, and failed checks never claim current', async () => {
  let supplied = info();
  const h = await harness(async () => { if (supplied instanceof Error) throw supplied; return supplied; });
  try {
    await h.view.refresh();
    supplied = info({ branch: { status: 'branch', name: 'main' }, update: { status: 'current', latest: '0.1.2' } });
    await h.view.refresh();
    assert.equal(h.$('project-branch').textContent, 'main');
    assert.equal(h.$('version-update-status').textContent, 'No newer release found');
    assert.equal(h.$('version-update-guide').hidden, true);
    for (const [status, text] of [['detached', 'Detached HEAD'], ['not_git', 'Not a Git repository'], ['unavailable', 'Branch unavailable']]) {
      supplied = info({ branch: { status }, update: { status: 'unavailable' } });
      await h.view.refresh();
      assert.equal(h.$('project-branch').textContent, text);
      assert.equal(h.$('version-update-status').textContent, 'Update check unavailable');
    }
    supplied = new Error('PRIVATE_ERROR');
    await h.view.refresh();
    assert.equal(h.$('graphlin-version').textContent, '0.1.2', 'known running version survives an update request failure');
    assert.equal(h.$('version-update-status').textContent, 'Update check unavailable');
    assert.equal(h.$('version-update-command').textContent, '');
    supplied = info({ mode: 'demo' });
    await h.view.refresh();
    assert.match(h.$('version-update-steps').textContent, /updated offline demo/);
    assert.doesNotMatch(h.$('version-update-steps').textContent, /Claude|Codex/);
  } finally { h.close(); }
});

test('dashboard refresh is single-flight, retries after synchronous failure, and aborts on close', async () => {
  let calls = 0, resolve, signal;
  const h = await harness(value => {
    calls++;
    signal = value;
    if (calls === 1) throw new Error('failed');
    return new Promise(done => { resolve = done; });
  });
  try {
    await h.view.refresh();
    const first = h.view.refresh(), second = h.view.refresh();
    await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal(first, second);
    h.view.close();
    assert.equal(signal.aborted, true);
    resolve(info());
    await first;
    assert.equal(h.$('version-update-status').textContent, 'Update check unavailable');
    assert.equal(h.timers.size, 0);
  } finally { h.close(); }
});

test('unusable metadata and unsafe update commands are withheld; clipboard denial leaves manual copying available', async () => {
  let supplied = info({ update: { status: 'available', latest: '0.1.10', command: 'npx\0bad' } });
  const h = await harness(async () => supplied, { writeText: async () => { throw new Error('denied'); } });
  try {
    await h.view.refresh();
    assert.equal(h.$('version-update-guide').hidden, true);
    supplied = info();
    await h.view.refresh();
    await h.$('version-update-copy').fire('click');
    assert.match(h.$('version-update-copy-status').textContent, /copy it manually/);
    supplied = { version: 'not-a-version', projectRoot: '/fixture/project' };
    await h.view.refresh();
    assert.equal(h.$('version-update-status').textContent, 'Update check unavailable');
  } finally { h.close(); }
});

test('a late clipboard rejection cannot restore guidance for an update no longer offered', async () => {
  let supplied = info(), rejectCopy;
  const h = await harness(async () => supplied, {
    writeText: () => new Promise((_, reject) => { rejectCopy = reject; }),
  });
  try {
    await h.view.refresh();
    const copying = h.$('version-update-copy').fire('click');
    supplied = info({ update: { status: 'current', latest: '0.1.2' } });
    await h.view.refresh();
    rejectCopy(new Error('denied'));
    await copying;
    assert.equal(h.$('version-update-guide').hidden, true);
    assert.equal(h.$('version-update-copy-status').textContent, '');
  } finally { h.close(); }
});
