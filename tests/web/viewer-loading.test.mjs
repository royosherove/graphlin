import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createViewPlatform } from '../../runtime/web/platform.js';
import { createDocument } from './fake-dom.mjs';
import { entity, model } from './model-fixtures.mjs';

const settle = async () => { for (let index = 0; index < 50; index++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

test('Blocks is the clean-load default, but an explicit Code choice wins while loading', async () => {
  for (const choice of [null, 'graphlin.code']) {
    const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
    const snapshot = deferred(), views = [];
    const platform = createViewPlatform({ document, onView: value => views.push(value), onSelect() {},
      request: async path => path === '/api/extensions' ? { extensions: [] } : snapshot.promise });
    const opening = platform.start();
    try {
      assert.equal(document.getElementById('visualizer').value, 'graphlin.blocks');
      if (choice) await platform.choose(choice);
      snapshot.resolve(model()); await opening; await settle();
      assert.equal(platform.active, choice || 'graphlin.blocks');
      assert.equal(views.at(-1).id, choice || 'graphlin.blocks');
      platform.serverSession('session.new'); await settle();
      assert.equal(platform.active, choice || 'graphlin.blocks', 'session transitions keep the selected view');
    } finally { platform.close(); snapshot.resolve(model()); await opening; }
  }
});

test('a C4 choice made before the snapshot survives first-page rendering and background hydration', async () => {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const snapshot = deferred(), page = deferred(), views = [];
  const platform = createViewPlatform({ document, onView: value => views.push(value), onSelect() {},
    request: async path => {
      if (path.startsWith('/api/model/v1/snapshot')) return snapshot.promise;
      if (path.startsWith('/api/model/v1/entities?')) return page.promise;
      if (path === '/api/extensions') return { extensions: [] };
      if (path === '/api/architecture') return { status: 'idle' };
      assert.fail(`Unexpected route ${path}`);
    },
  });
  const opening = platform.start(), select = document.getElementById('visualizer');
  const initial = model({ entities: [entity('root')], relations: [],
    pages: { entities: { total: 2, returned: 1, nextCursor: 'synthetic.cursor' } } });
  try {
    await settle();
    assert.equal([...select.children].find(value => value.value === 'graphlin.c4').disabled, false);
    select.value = 'graphlin.c4'; await select.fire('change');
    assert.equal(select.value, 'graphlin.c4');
    assert.match(document.getElementById('view-status').textContent, /loading/i);
    snapshot.resolve(initial); await settle();
    assert.equal(platform.active, 'graphlin.c4');
    assert.equal(views.filter(value => value.model).length, 1, 'render before the held page returns');
    assert.equal(views.at(-1).id, 'graphlin.c4');
    assert.equal(views.at(-1).model.partial, true);
    page.resolve({ ...initial, kind: 'entities', items: [entity('child', 'root')],
      page: { total: 2, offset: 1, returned: 1, nextCursor: null } });
    await opening; await settle();
    assert.equal(platform.active, 'graphlin.c4');
    assert.deepEqual(views.filter(value => value.model).map(value => [value.id, value.model.entities.length]),
      [['graphlin.c4', 1], ['graphlin.c4', 2]]);
  } finally { platform.close(); snapshot.resolve(initial); page.resolve({}); await opening; }
});

test('an unavailable model endpoint clears a pending view and preserves legacy Code fallback', async () => {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const snapshot = deferred(), views = [];
  const platform = createViewPlatform({ document, onView: value => views.push(value), onSelect() {},
    request: async path => path === '/api/extensions' ? { extensions: [] } : snapshot.promise,
  });
  const opening = platform.start();
  try {
    await platform.choose('graphlin.c4');
    snapshot.reject(Object.assign(new Error('unsupported'), { status: 404 }));
    await opening; await settle();
    assert.equal(platform.active, 'graphlin.code');
    assert.equal(document.getElementById('visualizer').value, 'graphlin.code');
    assert.match(document.getElementById('view-status').textContent, /Model views unavailable/);
    assert.equal(views.length, 0, 'keep the legacy map visible');
  } finally { platform.close(); await opening; }
});

test('a cancelled startup request cannot clear the pending C4 choice while the new server session loads', async () => {
  const document = createDocument(await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8'));
  const old = deferred(), current = deferred(), paths = [], views = [];
  const platform = createViewPlatform({ document, onView: value => views.push(value), onSelect() {},
    request: async path => {
      paths.push(path);
      if (path === '/api/extensions') return { extensions: [] };
      if (path === '/api/architecture') return { status: 'idle' };
      return path.includes('session=session.next') ? current.promise : old.promise;
    },
  });
  const opening = platform.start();
  try {
    await platform.choose('graphlin.c4');
    platform.serverSession('session.next');
    old.reject(Object.assign(new Error('old request'), { status: 404 }));
    await opening; await settle();
    assert.equal(document.getElementById('visualizer').value, 'graphlin.c4');
    assert.match(document.getElementById('view-status').textContent, /loading/i);
    current.resolve(model()); await settle();
    assert.ok(paths.includes('/api/model/v1/snapshot?session=session.next'));
    assert.equal(platform.active, 'graphlin.c4');
    assert.equal(views.at(-1).id, 'graphlin.c4');
    assert.equal(platform.selection.session, 'session.next');
  } finally { platform.close(); old.resolve(model()); current.resolve(model()); await opening; }
});
