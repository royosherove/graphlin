import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, chmod, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers.mjs';
import { projectPaths, privateDirectory, atomicJSON, readPrivateJSON } from '../../runtime/daemon/paths.mjs';
import { acquireLock } from '../../runtime/daemon/lock.mjs';
import { createPersistence } from '../../runtime/daemon/persistence.mjs';

test('canonical project/worktree paths and private storage agree across symlinks', async t => {
  const { base, projectRoot, dataDir } = await workspace(t);
  await mkdir(path.join(projectRoot, '.git'));
  await mkdir(path.join(projectRoot, 'nested'));
  const alias = path.join(base, 'alias');
  await symlink(projectRoot, alias);
  const actual = await projectPaths(projectRoot, dataDir, { create: true });
  const viaAlias = await projectPaths(path.join(alias, 'nested'), dataDir);
  assert.equal(viaAlias.socket, actual.socket);
  assert.equal(viaAlias.projectRoot, actual.projectRoot);
  assert.ok(actual.socket.length < 100);
  assert.equal((await stat(actual.directory)).mode & 0o777, 0o700);
  await assert.rejects(privateDirectory(alias), { code: 'unsafe_data_directory' });
});

test('atomic 0600 state rejects symlinks/oversize and preserves last accepted file', async t => {
  const { base } = await workspace(t), file = path.join(base, 'state.json');
  await atomicJSON(file, { safe: true });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(atomicJSON(file, { oversized: 'a'.repeat(1000) }, 50), { code: 'state_too_large' });
  assert.deepEqual(await readPrivateJSON(file), { safe: true });
  const alias = path.join(base, 'alias.json'); await symlink(file, alias);
  await assert.rejects(readPrivateJSON(alias));
  await chmod(file, 0o644); await assert.rejects(readPrivateJSON(file), { code: 'unsafe_state_file' });
});

test('exclusive lock refuses a live owner and recovers a proven dead PID', async t => {
  const { projectRoot, dataDir } = await workspace(t), paths = await projectPaths(projectRoot, dataDir, { create: true });
  const lock = await acquireLock(paths);
  await assert.rejects(acquireLock(paths), { code: 'daemon_busy' });
  await lock.release();
  await mkdir(paths.lock, { mode: 0o700 });
  await atomicJSON(path.join(paths.lock, 'owner.json'), { pid: 2147483647, instanceId: 'dead',
    projectId: paths.projectId, protocol: 1 });
  const recovered = await acquireLock(paths);
  assert.notEqual(recovered.owner.instanceId, 'dead');
  await recovered.release();
});

test('bounded persistence prunes histories across sessions and expires after seven days', async t => {
  const { base } = await workspace(t), file = path.join(base, 'state.json');
  const graph = { schemaVersion: 1, revision: 1, nodes: [], edges: [] };
  const history = Array.from({ length: 12 }, (_, revision) => ({
    revision, at: new Date(revision * 1000).toISOString(), graph, padding: 'x'.repeat(120),
  }));
  const save = createPersistence(file, { maxBytes: 2400, now: () => 1000 });
  save.schedule({ schemaVersion: 1, projectId: 'safe', graph, activity: [], history,
    sessionStates: [{ id: 's1', graph, history }, { id: 's2', graph, history }] });
  await save.close();
  const encoded = await readFile(file, 'utf8');
  assert.ok(Buffer.byteLength(encoded) <= 2400);
  const restored = await createPersistence(file, { now: () => 2000 }).load();
  assert.equal(restored.projectId, 'safe');
  assert.deepEqual(restored.sessionStates[1].graph, graph);
  assert.equal(await createPersistence(file, { now: () => 8 * 86400_000 }).load(), undefined);
});
