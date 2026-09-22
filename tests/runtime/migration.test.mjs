import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MIGRATION_LIMITS, migrateLegacyProject, prepareProjectState } from '../../runtime/daemon/migration.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { acquireLock } from '../../runtime/daemon/lock.mjs';
import { createModelPersistence } from '../../runtime/daemon/model-persistence.mjs';
import { readSettings } from '../../runtime/daemon/settings.mjs';
import { packageFiles } from '../extensions/fixtures.mjs';
import { bundleDigest } from '../../runtime/extensions/manifest.mjs';

const NOW = 1_800_000_000_000;
const policy = { allowSource: false, localSource: true, persistEvidence: true, displayEvidence: true };
const missing = filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
const write = (filename, value) => fs.writeFile(filename,
  typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
const readJSON = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
function model(projectId, revision = 3) {
  return { schemaVersion: 2, projectId, revision, sequence: revision,
    entities: [{ id: 'project', kind: 'project', label: 'Synthetic project', parentId: null }],
    relations: [], interpretations: [], activity: [], sessions: [], checkpoints: [],
    coverage: { complete: true }, storage: { identityVersion: 1, synthetic: 'retained metadata' } };
}
function state(projectId) {
  return { schemaVersion: 1, savedAt: NOW, snapshot: {
    schemaVersion: 1, projectId: projectId.slice(0, 24), sessionId: 'synthetic-session',
    graph: { schemaVersion: 1, revision: 1, nodes: [], edges: [] },
    activity: [], history: [], sessionStates: [],
  } };
}
async function fixture(t, { legacy = true } = {}) {
  const saved = process.env.GRAPHLIN_DATA_DIR;
  delete process.env.GRAPHLIN_DATA_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.GRAPHLIN_DATA_DIR;
    else process.env.GRAPHLIN_DATA_DIR = saved;
  });
  const base = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'graphlin-migration-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const projectRoot = path.join(base, 'project'), legacyDataDir = path.join(base, 'legacy');
  await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true, mode: 0o700 });
  const paths = await projectPaths(projectRoot);
  const legacyProject = path.join(legacyDataDir, paths.projectId);
  if (legacy) await fs.mkdir(legacyProject, { recursive: true, mode: 0o700 });
  const options = { legacyDataDir, now: () => NOW };
  return { base, projectRoot, paths, legacyDataDir, legacyProject, options,
    prepare: () => prepareProjectState({ projectRoot }, options),
    state: () => write(path.join(legacyProject, 'state.json'), state(paths.projectId)),
  };
}

test('migration preserves diagrams, checkpoint storage, settings and diagnostics without touching the backup', async t => {
  const f = await fixture(t), snapshot = model(f.paths.projectId);
  snapshot.checkpoints.push({ id: 'baseline', projectId: f.paths.projectId, state: model(f.paths.projectId, 1) });
  await f.state();
  await write(path.join(f.legacyProject, 'model-state.json'),
    { schemaVersion: 2, projectId: f.paths.projectId, savedAt: NOW, snapshot });
  await write(path.join(f.legacyProject, 'settings.json'), { schemaVersion: 1, policy });
  await write(path.join(f.legacyDataDir, 'settings.json'), { schemaVersion: 1, apiKey: 'synthetic-test-key',
    installation: { hosts: ['claude'], version: '0.3.1', pendingHosts: ['claude'] } });
  for (const name of ['diagnostics.jsonl', 'diagnostics.1.jsonl']) {
    await write(path.join(f.legacyProject, name), JSON.stringify({
      schemaVersion: 1, at: new Date(NOW).toISOString(), stage: 'capture', outcome: 'observed',
    }) + '\n');
  }
  await write(path.join(f.legacyProject, 'unrecognized.json'), { source: 'Do not copy' });
  const foreign = path.join(f.legacyDataDir, 'b'.repeat(64));
  await fs.mkdir(foreign, { mode: 0o700 });
  await write(path.join(foreign, 'state.json'), { synthetic: 'foreign' });
  const originals = await Promise.all(['state.json', 'model-state.json', 'settings.json', 'diagnostics.jsonl',
    'diagnostics.1.jsonl'].map(async name => ({ name,
    bytes: await fs.readFile(path.join(f.legacyProject, name)),
    info: await fs.stat(path.join(f.legacyProject, name)),
  })));
  const result = await f.prepare();
  assert.equal(result.projectRoot, f.projectRoot);
  assert.equal(result.projectId, f.paths.projectId);
  assert.equal(result.dataDir, path.join(f.projectRoot, '.graphlin'));
  assert.equal(result.migration.status, 'migrated');
  assert.equal(result.migration.copied.length, 6);
  for (const { name, bytes, info } of originals) {
    assert.deepEqual(await fs.readFile(path.join(result.directory, name)), bytes);
    assert.deepEqual(await fs.readFile(path.join(f.legacyProject, name)), bytes);
    const old = await fs.stat(path.join(f.legacyProject, name));
    assert.equal(old.ino, info.ino); assert.equal(old.mtimeMs, info.mtimeMs);
    const current = await fs.stat(path.join(result.directory, name));
    assert.equal(current.mode & 0o777, 0o600); assert.equal(current.nlink, 1);
  }
  assert.deepEqual(await createModelPersistence(path.join(result.directory, 'model-state.json'),
    { projectId: result.projectId, now: () => NOW }).load(), snapshot);
  assert.deepEqual(await readSettings(result), { apiKey: 'synthetic-test-key',
    installation: { hosts: ['claude'], version: '0.3.1', pendingHosts: ['claude'] }, policy });
  assert.match(await fs.readFile(path.join(f.projectRoot, '.gitignore'), 'utf8'), /\/\.graphlin\//);
  assert.equal(await fs.readFile(path.join(result.dataDir, '.gitignore'), 'utf8'), '*\n');
  for (const name of ['unrecognized.json', 'daemon.lock', 'plugins', 'extensions']) {
    await missing(path.join(result.directory, name));
  }
  await missing(path.join(result.dataDir, 'b'.repeat(64)));
  assert.deepEqual(await readJSON(path.join(foreign, 'state.json')), { synthetic: 'foreign' });
  assert.equal((await fs.stat(result.dataDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(result.directory)).mode & 0o777, 0o700);
  assert.ok(!(await fs.readdir(result.directory)).some(name => name.startsWith('.legacy-migration-')));
  assert.ok(!JSON.stringify(result.migration).includes('synthetic-test-key'));
});

test('existing local files always win and the completion marker makes migration one-time', async t => {
  const f = await fixture(t);
  await f.state();
  await write(path.join(f.legacyDataDir, 'settings.json'), { schemaVersion: 1, apiKey: 'synthetic-old-key' });
  const local = await projectPaths(f.projectRoot, undefined, { create: true });
  await write(local.state, 'local state wins without replacement');
  await fs.utimes(local.state, 1, 1); // Even an older local file must not be overwritten.
  await write(path.join(local.dataDir, 'settings.json'), { schemaVersion: 1, apiKey: 'synthetic-new-key' });
  const info = await fs.stat(local.state);
  const first = await f.prepare();
  assert.deepEqual(first.migration.preserved.sort(), ['project/state.json', 'settings.json']);
  assert.equal(await fs.readFile(local.state, 'utf8'), 'local state wins without replacement');
  assert.equal((await fs.stat(local.state)).ino, info.ino);
  assert.equal((await readSettings(local)).apiKey, 'synthetic-new-key');
  await fs.unlink(local.state);
  assert.equal((await f.prepare()).migration.status, 'already_migrated');
  await missing(local.state);
});

test('completed migration ignores damaged backup content and retains its report when the backup is removed', async t => {
  const f = await fixture(t);
  await f.state();
  await f.prepare();
  await write(path.join(f.legacyProject, 'state.json'), '{damaged backup');
  await fs.symlink(f.base, path.join(f.legacyDataDir, 'extensions'));
  assert.equal((await f.prepare()).migration.status, 'already_migrated');
  await fs.rm(f.legacyDataDir, { recursive: true });
  assert.equal((await f.prepare()).migration.status, 'already_migrated');
  assert.deepEqual(await readJSON(f.paths.state), state(f.paths.projectId));
});

test('missing or empty legacy projects remain read-only, including nested project resolution', async t => {
  const f = await fixture(t, { legacy: false });
  await fs.mkdir(path.join(f.projectRoot, 'src'), { mode: 0o700 });
  const result = await prepareProjectState({ projectRoot: path.join(f.projectRoot, 'src') }, f.options);
  assert.equal(result.projectRoot, f.projectRoot);
  assert.equal(result.migration.status, 'no_legacy');
  await fs.mkdir(f.legacyProject, { recursive: true, mode: 0o700 });
  assert.equal((await f.prepare()).migration.status, 'no_legacy');
  await missing(f.paths.dataDir);
  await missing(path.join(f.projectRoot, '.gitignore'));
  await missing(path.join(f.legacyProject, 'daemon.lock.claims'));
});

test('explicit and environment data-directory overrides opt out even when they equal the default', async t => {
  const f = await fixture(t);
  await f.state();
  for (const dataDir of [f.paths.dataDir, path.join(f.base, 'custom')]) {
    const result = await prepareProjectState({ projectRoot: f.projectRoot, dataDir }, f.options);
    assert.equal(result.migration.status, 'skipped');
    await missing(dataDir);
  }
  process.env.GRAPHLIN_DATA_DIR = f.paths.dataDir;
  assert.equal((await f.prepare()).migration.status, 'skipped');
  await missing(f.paths.dataDir);
});

test('active legacy owners refuse migration before creating local state; stale locks stay in the backup', async t => {
  const f = await fixture(t);
  await f.state();
  const lock = path.join(f.legacyProject, 'daemon.lock');
  await fs.mkdir(lock, { mode: 0o700 });
  const owner = { protocol: 1, projectId: f.paths.projectId, pid: process.pid, instanceId: randomUUID() };
  await write(path.join(lock, 'owner.json'), owner);
  await assert.rejects(f.prepare(), { code: 'legacy_daemon_running', message: 'legacy_daemon_running' });
  await missing(f.paths.dataDir);
  const migrated = await migrateLegacyProject(f.paths, { ...f.options, isProcessAlive: () => false });
  assert.equal(migrated.status, 'migrated');
  assert.deepEqual(await readJSON(path.join(lock, 'owner.json')), owner);
  await missing(f.paths.lock);
  // Returning to an already-migrated project must still detect a live old server.
  await assert.rejects(f.prepare(), { code: 'legacy_daemon_running' });
});

test('real local daemon lock prevents publication and an interrupted legacy owner also blocks', async t => {
  const f = await fixture(t);
  await f.state();
  const local = await projectPaths(f.projectRoot, undefined, { create: true });
  const lock = await acquireLock(local);
  t.after(() => lock.release());
  await assert.rejects(f.prepare(), { code: 'local_daemon_running' });
  await missing(local.state);
  await lock.release();
  await fs.mkdir(path.join(f.legacyProject, 'daemon.lock'), { mode: 0o700 });
  await write(path.join(f.legacyProject, 'daemon.lock', `owner.json.${randomUUID()}.tmp`),
    { protocol: 1, projectId: f.paths.projectId, pid: process.pid, instanceId: randomUUID() });
  await assert.rejects(f.prepare(), { code: 'legacy_daemon_running' });
});

test('concurrent migrations serialize and never replace or duplicate the project state', async t => {
  const f = await fixture(t);
  await f.state();
  const results = await Promise.all([f.prepare(), f.prepare()]);
  assert.deepEqual(results.map(value => value.migration.status).sort(), ['already_migrated', 'migrated']);
  assert.deepEqual(await readJSON(f.paths.state), state(f.paths.projectId));
  assert.equal((await fs.stat(f.paths.state)).nlink, 1);
});

test('extension recovery retains installed inventory and only this project grants, with no executable packages', async t => {
  const f = await fixture(t);
  const { manifest } = packageFiles(), digest = bundleDigest(manifest);
  const grant = { projectId: f.paths.projectId, extensionId: manifest.id, digest,
    fields: ['entities', 'coverage'], approved: true, history: false };
  const extensions = path.join(f.legacyDataDir, 'extensions');
  await fs.mkdir(path.join(extensions, 'bundles'), { recursive: true, mode: 0o700 });
  await write(path.join(extensions, 'bundles', 'must-not-copy.js'), 'synthetic package code');
  await write(path.join(extensions, 'catalogue.json'), { schemaVersion: 1,
    installed: [{ id: manifest.id, version: manifest.version, digest, manifest, development: false }],
    grants: [grant, { ...grant, projectId: 'c'.repeat(64) }],
  });
  const result = await f.prepare();
  assert.equal(result.migration.extensionsToReinstall, 1);
  assert.deepEqual(await readJSON(path.join(result.directory, 'legacy-extensions.json')), {
    schemaVersion: 1, projectId: result.projectId, requiresReinstall: true,
    installed: [{ id: manifest.id, version: manifest.version, digest, development: false }], grants: [grant],
  });
  await missing(path.join(result.dataDir, 'extensions'));
  assert.equal((await f.prepare()).migration.extensionsToReinstall, 1);
});

test('malformed diagnostics are reported and retained while valid project state still migrates', async t => {
  const f = await fixture(t);
  await f.state();
  await write(path.join(f.legacyProject, 'diagnostics.jsonl'), '{"truncated":');
  const result = await f.prepare();
  assert.deepEqual(result.migration.skipped, ['diagnostics.jsonl']);
  assert.deepEqual(await readJSON(result.state), state(result.projectId));
  await missing(path.join(result.directory, 'diagnostics.jsonl'));
  assert.equal(await fs.readFile(path.join(f.legacyProject, 'diagnostics.jsonl'), 'utf8'), '{"truncated":');
});

test('foreign project identities and malformed state/settings fail before publishing anything', async t => {
  for (const kind of ['state', 'model', 'checkpoint', 'settings']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.state();
    if (kind === 'state') await write(path.join(f.legacyProject, 'state.json'), state('b'.repeat(64)));
    if (kind === 'model' || kind === 'checkpoint') {
      const snapshot = model(kind === 'model' ? 'b'.repeat(64) : f.paths.projectId);
      if (kind === 'checkpoint') snapshot.checkpoints.push({ id: 'foreign', state: model('b'.repeat(64)) });
      await write(path.join(f.legacyProject, 'model-state.json'),
        { schemaVersion: 2, savedAt: NOW, projectId: f.paths.projectId, snapshot });
    }
    if (kind === 'settings') await write(path.join(f.legacyDataDir, 'settings.json'),
      { schemaVersion: 1, apiKey: 'synthetic secret with whitespace' });
    await assert.rejects(f.prepare(), error => {
      assert.match(error.code, /^(invalid_legacy_state|legacy_migration_failed)$/);
      assert.equal(error.message, error.code);
      assert.ok(!error.message.includes(f.base) && !error.message.includes('synthetic'));
      return true;
    });
    await missing(f.paths.dataDir);
  });
});

test('unsafe source files and directories are rejected without publishing or following links', async t => {
  for (const kind of ['symlink', 'hardlink', 'permissions', 'directory', 'ancestor']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.state();
    const source = path.join(f.legacyProject, 'state.json');
    if (kind === 'symlink') {
      await fs.rename(source, path.join(f.base, 'outside.json'));
      await fs.symlink(path.join(f.base, 'outside.json'), source);
    } else if (kind === 'hardlink') await fs.link(source, path.join(f.base, 'alias.json'));
    else if (kind === 'permissions') await fs.chmod(source, 0o644);
    else if (kind === 'directory') await fs.chmod(f.legacyProject, 0o755);
    else {
      await fs.rename(f.legacyProject, path.join(f.base, 'outside'));
      await fs.symlink(path.join(f.base, 'outside'), f.legacyProject);
    }
    await assert.rejects(f.prepare(), { code: 'unsafe_legacy_state' });
    await missing(f.paths.dataDir);
  });
});

test('oversized legacy files are refused before allocating or creating local state', async t => {
  for (const [filename, limit] of [['state.json', MIGRATION_LIMITS.state],
    ['model-state.json', MIGRATION_LIMITS.model], ['settings.json', MIGRATION_LIMITS.settings],
    ['diagnostics.jsonl', MIGRATION_LIMITS.diagnostics]]) await t.test(filename, async t => {
    const f = await fixture(t), file = await fs.open(path.join(f.legacyProject, filename), 'wx', 0o600);
    await file.truncate(limit + 1); await file.close();
    await assert.rejects(f.prepare(), { code: 'unsafe_legacy_state' });
    await missing(f.paths.dataDir);
  });
});

test('unsafe existing destinations and unsafe ignore files refuse migration without changing their targets', async t => {
  for (const kind of ['symlink', 'hardlink', 'permissions', 'ignore']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.state();
    const outside = path.join(f.base, 'outside.json');
    await write(outside, 'synthetic original');
    if (kind === 'ignore') await fs.symlink(outside, path.join(f.projectRoot, '.gitignore'));
    else {
      await projectPaths(f.projectRoot, undefined, { create: true });
      if (kind === 'symlink') await fs.symlink(outside, f.paths.state);
      else if (kind === 'hardlink') await fs.link(outside, f.paths.state);
      else { await write(f.paths.state, 'existing'); await fs.chmod(f.paths.state, 0o644); }
    }
    await assert.rejects(f.prepare());
    assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic original');
    await missing(path.join(f.paths.directory, 'legacy-migration.json'));
  });
});
