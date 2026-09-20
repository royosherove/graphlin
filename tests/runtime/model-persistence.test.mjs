import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createModelPersistence, MAX_MODEL_STATE_BYTES } from '../../runtime/daemon/model-persistence.mjs';

const projectId = 'project-synthetic';
function snapshot(revision = 1) {
  return { schemaVersion: 2, projectId, revision, sequence: revision,
    entities: [{ id: 'root', kind: 'project', label: 'Project', parentId: null }],
    relations: [], interpretations: [], activity: [], coverage: { complete: false },
    sessions: [{ id: 'session-one', host: 'codex', status: 'active' }], checkpoints: [],
    storage: { identityVersion: 1, deferred: { entities: 4 }, approvedMetadata: 'Synthetic metadata' } };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'graphlin-model-storage-'));
  await fs.chmod(directory, 0o700);
  const filename = path.join(directory, 'model-v2.json');
  const store = createModelPersistence(filename, { projectId, now: () => 1000, ...options });
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const reopen = input => createModelPersistence(filename, { projectId, now: () => 1000, ...input });
  return { store, filename, directory, reopen };
}

test('separate schema-2 storage roundtrips persistent state and leaves legacy state.json byte-identical', async t => {
  const f = await fixture(t), model = snapshot();
  const legacy = path.join(f.directory, 'state.json'), previous = '{"schemaVersion":1,"snapshot":{"legacy":true}}\n';
  await fs.writeFile(legacy, previous, { mode: 0o600 });
  const oldInfo = await fs.stat(legacy);
  model.checkpoints.push({ id: 'checkpoint-one', projectId, revision: 0, sequence: 0,
    label: 'Baseline', state: snapshot(0) });
  assert.equal(f.store.schedule(model), true);
  await f.store.flush();
  assert.deepEqual(await f.reopen().load(), model);
  const encoded = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  assert.equal(encoded.schemaVersion, 2);
  assert.equal(encoded.snapshot.schemaVersion, 2);
  assert.equal(encoded.savedAt, 1000);
  assert.equal(encoded.projectId, projectId);
  assert.deepEqual(encoded.snapshot.storage, model.storage);
  assert.deepEqual(encoded.snapshot.checkpoints[0].state, snapshot(0));
  assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(legacy, 'utf8'), previous);
  assert.equal((await fs.stat(legacy)).ino, oldInfo.ino);
  assert.equal((await fs.stat(legacy)).mtimeMs, oldInfo.mtimeMs);
  assert.deepEqual(await fs.readdir(f.directory), ['model-v2.json', 'state.json']);
});

test('legacy filenames and limits above 48 MiB are rejected at construction', () => {
  const filename = path.join(tmpdir(), 'model-v2.json');
  assert.equal(MAX_MODEL_STATE_BYTES, 48 * 1024 * 1024);
  for (const bad of [path.join(tmpdir(), 'state.json'), path.join(tmpdir(), 'STATE.JSON'), 'model-v2.json']) {
    assert.throws(() => createModelPersistence(bad, { projectId }), /invalid_model_persistence_options/);
  }
  for (const options of [{ maxBytes: MAX_MODEL_STATE_BYTES + 1 }, { maxBytes: 0 },
    { maxBytes: NaN }, { debounceMs: -1 }, { debounceMs: 1001 }, { projectId: 'wrong/project' }]) {
    assert.throws(() => createModelPersistence(filename, { projectId, ...options }), /invalid_model_persistence_options/);
  }
});

test('parent filename-only factory supports model-state.json and full SHA-256 project IDs', async t => {
  const f = await fixture(t), filename = path.join(f.directory, 'model-state.json');
  const model = { ...snapshot(), projectId: 'a'.repeat(64) };
  const store = createModelPersistence(filename);
  assert.equal(await store.load(), undefined);
  assert.equal(store.schedule(model), true);
  assert.equal(store.schedule({ ...model, projectId: 'b'.repeat(64) }), false);
  await store.close();
  const restored = createModelPersistence(filename);
  assert.deepEqual(await restored.load(), model);
  assert.equal(restored.schedule({ ...model, projectId: 'b'.repeat(64) }), false);
  await restored.close();
  assert.equal(store.stats().writes, 1);
  assert.equal(store.stats().pending, false);
  assert.equal(store.stats().persistenceFailures, 1);
});

test('rejected snapshots and failed loads cannot bind a filename-only store to another project', async t => {
  const f = await fixture(t);
  const store = createModelPersistence(f.filename);
  await fs.writeFile(f.filename, JSON.stringify({ schemaVersion: 1, projectId: 'wrong-project' }), { mode: 0o600 });
  assert.equal(await store.load(), undefined);
  assert.equal(store.schedule({ ...snapshot(), schemaVersion: 1, projectId: 'wrong-project' }), false);
  assert.equal(store.schedule(snapshot()), true);
  await store.close();
  assert.deepEqual(await createModelPersistence(f.filename).load(), snapshot());
});

test('debounced scheduling writes only the latest immutable snapshot and flush bypasses the timer', async t => {
  const f = await fixture(t, { debounceMs: 1000 });
  f.store.schedule(snapshot(1));
  const latest = snapshot(2);
  f.store.schedule(latest); latest.entities[0].label = 'Changed after scheduling';
  assert.equal(f.store.stats().writes, 0);
  await f.store.flush();
  assert.equal(f.store.stats().writes, 1);
  assert.equal(f.store.stats().pending, false);
  const loaded = await f.reopen().load();
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.entities[0].label, 'Project');
  await Promise.all([f.store.flush(), f.store.flush()]);
  assert.equal(f.store.stats().writes, 1);
});

test('timer drains accepted snapshots without an explicit flush', async t => {
  const f = await fixture(t, { debounceMs: 5 });
  f.store.schedule(snapshot(3));
  for (let i = 0; i < 100 && f.store.stats().writes === 0; i++) await delay(10);
  assert.equal(f.store.stats().writes, 1);
  assert.equal((await f.reopen().load()).revision, 3);
});

test('close drains pending data, is idempotent and rejects later scheduling', async t => {
  const f = await fixture(t, { debounceMs: 1000 });
  f.store.schedule(snapshot(4));
  const one = f.store.close(), two = f.store.close();
  assert.equal(one, two);
  await one;
  assert.equal(f.store.schedule(snapshot(5)), false);
  await f.store.flush();
  assert.equal((await f.reopen().load()).revision, 4);
  assert.equal(f.store.stats().writes, 1);
});

test('oversized admission preserves the complete accepted file, including checkpoints', async t => {
  const f = await fixture(t, { maxBytes: 2048 });
  const accepted = snapshot();
  accepted.checkpoints.push({ id: 'baseline', projectId, state: snapshot(0) });
  assert.equal(f.store.schedule(accepted), true);
  await f.store.flush();
  const previous = await fs.readFile(f.filename);
  const large = snapshot(2); large.storage.padding = 'x'.repeat(2048);
  assert.equal(f.store.schedule(large), false);
  await f.store.flush();
  assert.deepEqual(await fs.readFile(f.filename), previous);
  assert.deepEqual(await f.reopen({ maxBytes: 2048 }).load(), accepted);
  assert.equal(f.store.stats().persistenceFailures, 1);
});

test('UTF-8, JSON escaping and the complete envelope count toward the exact byte limit', async t => {
  const f = await fixture(t);
  const model = snapshot();
  model.storage.example = '世界 😀 \ud800 \udc00 \u0000\b\t\n\f\r"\\';
  const size = Buffer.byteLength(JSON.stringify({ schemaVersion: 2, savedAt: 1000, projectId, snapshot: model }));
  const exact = f.reopen({ maxBytes: size });
  assert.equal(exact.schedule(model), true);
  await exact.close();
  assert.equal((await fs.stat(f.filename)).size, size);
  assert.deepEqual(await exact.load(), model);
  const tooSmall = f.reopen({ maxBytes: size - 1 });
  assert.equal(tooSmall.schedule(model), false);
  await tooSmall.close();
  assert.equal((await fs.stat(f.filename)).size, size);
});

test('the 48 MiB boundary is enforced before encoding a larger storage string', async t => {
  const f = await fixture(t);
  f.store.schedule(snapshot()); await f.store.flush();
  const tooLarge = snapshot(2);
  tooLarge.storage.metadata = 'x'.repeat(MAX_MODEL_STATE_BYTES);
  assert.equal(f.store.schedule(tooLarge), false);
  assert.equal(f.store.stats().maxBytes, MAX_MODEL_STATE_BYTES);
  assert.equal((await f.reopen().load()).revision, 1);
});

test('missing, malformed, wrong-project, future and schema-1 files fail open without deletion', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.load(), undefined);
  assert.equal(f.store.stats().persistenceFailures, 0);
  for (const contents of ['{', JSON.stringify({ schemaVersion: 1, savedAt: 1000, snapshot: snapshot() }),
    JSON.stringify({ schemaVersion: 2, savedAt: 1000, projectId: 'other', snapshot: snapshot() }),
    JSON.stringify({ schemaVersion: 2, savedAt: 61_001, projectId, snapshot: snapshot() }),
    JSON.stringify({ schemaVersion: 2, savedAt: 1000, projectId, snapshot: { ...snapshot(), projectId: 'other' } })]) {
    await fs.writeFile(f.filename, contents, { mode: 0o600 });
    assert.equal(await f.store.load(), undefined);
    assert.equal(await fs.readFile(f.filename, 'utf8'), contents);
  }
  assert.equal(f.store.stats().persistenceFailures, 5);
});

test('old valid model files do not expire or remove rollback history', async t => {
  const f = await fixture(t);
  f.store.schedule(snapshot()); await f.store.close();
  assert.deepEqual(await f.reopen({ now: () => 365 * 86400_000 }).load(), snapshot());
});

test('schema and JSON failures never replace an already accepted pending snapshot', async t => {
  const f = await fixture(t, { debounceMs: 1000 });
  f.store.schedule(snapshot());
  const cycle = snapshot(); cycle.storage.self = cycle;
  const nestedProject = snapshot(); nestedProject.checkpoints = [{ id: 'baseline', state: { ...snapshot(), projectId: 'other' } }];
  const getter = snapshot();
  let invoked = false;
  Object.defineProperty(getter.storage, 'secret', { enumerable: true, get: () => { invoked = true; return 'hidden'; } });
  for (const input of [null, { ...snapshot(), schemaVersion: 1 }, { ...snapshot(), projectId: 'other' },
    { ...snapshot(), revision: -1 }, { ...snapshot(), coverage: null }, { ...snapshot(), entities: {} },
    { ...snapshot(), raw: 'unexpected' }, { ...snapshot(), storage: { invalid: [undefined] } },
    { ...snapshot(), storage: { value: new Map() } }, { ...snapshot(), storage: { value: Infinity } },
    { ...snapshot(), storage: { value: 1n } }, cycle, nestedProject, getter]) {
    assert.equal(f.store.schedule(input), false);
  }
  assert.equal(invoked, false);
  await f.store.flush();
  assert.deepEqual(await f.reopen().load(), snapshot());
});

test('deep or cyclic history is rejected without throwing through schedule', async t => {
  const f = await fixture(t);
  const model = snapshot(); let current = model.storage;
  for (let i = 0; i < 70; i++) current = current.next = {};
  assert.equal(f.store.schedule(model), false);
  assert.equal(f.store.stats().persistenceFailures, 1);
});

test('current policy snapshots from the actual model persist withheld paths and frozen checkpoint state', async t => {
  const { createProjectModel } = await import('../../runtime/model/index.mjs');
  const { structure, file } = await import('../model/fixtures.mjs');
  const f = await fixture(t);
  let policy = { readSource: true, persistEvidence: true };
  const model = createProjectModel({ projectId, policy: () => policy, now: () => 1000 });
  model.observeInventory({ entries: [file('src/demo.js')] });
  model.observeStructure(structure());
  const baseline = model.checkpoint({ label: 'Source baseline' });
  policy = { readSource: true, persistEvidence: false, excludePaths: ['src/**'] };
  const projected = model.snapshot({ persistent: true });
  assert.equal(f.store.schedule(projected), true);
  await f.store.flush();
  const loaded = await f.reopen().load();
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(projected)));
  assert.ok(loaded.checkpoints.some(value => value.id === baseline.id && value.state));
  const disk = await fs.readFile(f.filename, 'utf8');
  assert.doesNotMatch(disk, /Alpha|Source baseline|src\/demo\.js/);
  const restored = createProjectModel({ projectId, restoredState: loaded, policy });
  assert.equal(restored.snapshot().schemaVersion, 2);
  assert.equal(restored.snapshot({ checkpointId: baseline.id }).projectId, projectId);
});

test('unsafe file permissions, symlinks and hard links are never followed or overwritten', async t => {
  const f = await fixture(t), target = path.join(f.directory, 'state.json');
  await fs.writeFile(target, 'legacy bytes', { mode: 0o600 });
  for (const linked of ['symbolic', 'hard']) {
    if (linked === 'symbolic') await fs.symlink(target, f.filename);
    else await fs.link(target, f.filename);
    assert.equal(await f.store.load(), undefined);
    f.store.schedule(snapshot()); await f.store.flush();
    assert.equal(await fs.readFile(target, 'utf8'), 'legacy bytes');
    assert.equal((await fs.lstat(f.filename)).isSymbolicLink(), linked === 'symbolic');
    await fs.unlink(f.filename);
  }
  await fs.writeFile(f.filename, 'untrusted file', { mode: 0o644 });
  assert.equal(await f.store.load(), undefined);
  f.store.schedule(snapshot()); await f.store.flush();
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'untrusted file');
  assert.deepEqual(await fs.readdir(f.directory), ['model-v2.json', 'state.json']);
});

test('symlinked or nonprivate parent directories fail without creating model files', async t => {
  const f = await fixture(t);
  const actual = path.join(f.directory, 'actual'), alias = path.join(f.directory, 'alias');
  await fs.mkdir(actual, { mode: 0o700 }); await fs.symlink(actual, alias);
  const linked = createModelPersistence(path.join(alias, 'model-v2.json'), { projectId });
  linked.schedule(snapshot()); await linked.close();
  assert.equal(await linked.load(), undefined);
  assert.deepEqual(await fs.readdir(actual), []);
  await fs.chmod(actual, 0o755);
  const publicParent = createModelPersistence(path.join(actual, 'model-v2.json'), { projectId });
  publicParent.schedule(snapshot()); await publicParent.close();
  assert.equal(await publicParent.load(), undefined);
  assert.deepEqual(await fs.readdir(actual), []);
});

test('atomic rename failure keeps the old file, cleans temporary data and can recover', async t => {
  const f = await fixture(t);
  f.store.schedule(snapshot()); await f.store.flush();
  const previous = await fs.readFile(f.filename), original = fs.rename;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === f.filename) throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' });
    return original(source, destination);
  });
  syncBuiltinESMExports();
  try {
    f.store.schedule(snapshot(2)); await f.store.flush();
    assert.deepEqual(await fs.readFile(f.filename), previous);
    assert.deepEqual(await fs.readdir(f.directory), ['model-v2.json']);
    assert.equal(f.store.stats().persistenceFailures, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  f.store.schedule(snapshot(3)); await f.store.flush();
  assert.equal((await f.reopen().load()).revision, 3);
});

test('an update during an active write is serialized after it and concurrent flush waits for both', async t => {
  const f = await fixture(t), original = fs.rename;
  let release, started, first = true;
  const reached = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === f.filename && first) { first = false; started(); await blocked; }
    return original(source, destination);
  });
  syncBuiltinESMExports();
  try {
    f.store.schedule(snapshot(1));
    const flushed = f.store.flush();
    await reached;
    f.store.schedule(snapshot(2)); f.store.schedule(snapshot(3));
    const alsoFlushed = f.store.flush();
    release();
    await Promise.all([flushed, alsoFlushed]);
    assert.equal((await f.reopen().load()).revision, 3);
    assert.equal(f.store.stats().writes, 2);
    assert.equal(f.store.stats().pending, false);
  } finally { release(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});
