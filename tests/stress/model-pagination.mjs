import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, entity, cursorQuery } from '../helpers/model-api-fixture.mjs';

test('20k inventory snapshots and every page stay bounded and all entities remain reachable', async t => {
  const f = await fixture(t);
  let recordEncodings = 0, pages = 1;
  const stringify = JSON.stringify, started = performance.now();
  // A recording mock would retain every full snapshot and encoded string.
  t.after(() => { JSON.stringify = stringify; });
  JSON.stringify = function (value, ...args) {
    if (value && typeof value.id === 'string' &&
        (Object.hasOwn(value, 'sourceRefs') || Object.hasOwn(value, 'source'))) recordEncodings++;
    return Reflect.apply(stringify, this, [value, ...args]);
  };
  f.state.entities = Array.from({ length: 20_000 }, (_, i) => entity(`node-${String(i).padStart(5, '0')}`));
  f.state.relations = Array.from({ length: 40_000 }, (_, i) => ({ id: `edge-${String(i).padStart(5, '0')}`,
    source: 'node-00000', target: 'node-00001', kind: 'calls' }));
  const snapshot = await f.request('snapshot');
  assert.equal(snapshot.status, 200, snapshot.raw.slice(0, 100));
  assert.equal(snapshot.data.partial, true);
  assert.equal(snapshot.data.pages.entities.total, 20_000);
  assert.equal(snapshot.data.pages.relations.total, 40_000);
  assert.ok(snapshot.data.activity.length);
  assert.ok(Buffer.byteLength(snapshot.raw) <= 512 * 1024);
  assert.ok(['entities', 'relations', 'interpretations', 'activity', 'sessions', 'checkpoints']
    .reduce((sum, field) => sum + snapshot.data[field].length, 0) <= 200);
  const ids = new Set(snapshot.data.entities.map(value => value.id));
  let cursor = snapshot.data.pages.entities.nextCursor;
  while (cursor) {
    const page = await f.request(`entities?cursor=${cursorQuery(cursor)}`);
    pages++;
    assert.equal(page.status, 200, page.raw.slice(0, 100));
    assert.ok(page.data.items.length <= 200);
    assert.ok(Buffer.byteLength(page.raw) <= 512 * 1024);
    assert.equal(page.data.revision, snapshot.data.revision);
    for (const value of page.data.items) { assert.equal(ids.has(value.id), false); ids.add(value.id); }
    cursor = page.data.page.nextCursor;
  }
  assert.equal(ids.size, 20_000);
  assert.equal(f.calls.length, pages, 'every page reads the current provider, even with unchanged revision');
  assert.ok(recordEncodings < 3 * (20_000 + 40_000),
    `unchanged records must not be reprojected/encoded on every page: ${recordEncodings} encodings`);
  t.diagnostic(`20k entity walk: ${pages} requests, ${recordEncodings} record encodings, ${(performance.now() - started).toFixed(0)} ms`);
});
