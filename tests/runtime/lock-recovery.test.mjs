import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, lstat, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { workspace } from './helpers.mjs';
import { projectPaths, atomicJSON, readPrivateJSON } from '../../runtime/daemon/paths.mjs';
import { acquireLock } from '../../runtime/daemon/lock.mjs';

const workerPath = path.resolve('tests/runtime/fixtures/lock-worker.mjs');
const deadPid = 2147483647;
const deadOwner = paths => ({ pid: deadPid, instanceId: 'dead', projectId: paths.projectId, protocol: 1 });

async function worker(t, setup, phase = 'owner') {
  const child = spawn(process.execPath, [workerPath, setup.projectRoot, setup.dataDir, phase],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [], pending = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    const listener = pending.shift();
    if (listener) listener(message); else messages.push(message);
  });
  const exited = once(child, 'exit');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; };
  t.after(stop);
  const next = () => new Promise((resolve, reject) => {
    if (messages.length) { resolve(messages.shift()); return; }
    const timer = setTimeout(() => reject(new Error(`lock_worker_timeout: ${stderr}`)), 6000);
    pending.push(message => { clearTimeout(timer); resolve(message); });
  });
  assert.deepEqual(await next(), { ready: true });
  return { child, next, stop, exited };
}

test('dead and ownerless legacy locks recover even with an abandoned reaping directory', async t => {
  for (const ownerless of [false, true]) {
    await t.test(ownerless ? 'ownerless publication' : 'dead owner', async t => {
      const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
      await mkdir(paths.lock, { mode: 0o700 });
      await mkdir(`${paths.lock}.reaping`, { mode: 0o700 });
      if (!ownerless) await atomicJSON(path.join(paths.lock, 'owner.json'), deadOwner(paths));
      const lock = await acquireLock(paths);
      assert.equal((await readPrivateJSON(path.join(paths.lock, 'owner.json'))).instanceId, lock.owner.instanceId);
      await assert.rejects(lstat(`${paths.lock}.reaping`), { code: 'ENOENT' });
      await lock.release();
    });
  }
});

test('live owner is preserved despite abandoned recovery debris and failed IPC', async t => {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  const lock = await acquireLock(paths);
  await mkdir(`${paths.lock}.reaping`, { mode: 0o700 });
  await assert.rejects(acquireLock(paths), { code: 'daemon_busy' });
  assert.deepEqual(await readPrivateJSON(path.join(paths.lock, 'owner.json')), lock.owner);
  await lock.release();
});

test('legacy partial publication retains a readable live owner and rejects an unreadable published owner', async t => {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  await mkdir(paths.lock, { mode: 0o700 });
  const partial = path.join(paths.lock, 'owner.json.00000000-0000-0000-0000-000000000001.tmp');
  const owner = { ...deadOwner(paths), pid: process.pid, instanceId: 'live-publication' };
  await atomicJSON(partial, owner);
  await assert.rejects(acquireLock(paths), { code: 'daemon_busy' });
  assert.deepEqual(await readPrivateJSON(partial), owner);
  await writeFile(path.join(paths.lock, 'owner.json'), '{interrupted-or-corrupt', { mode: 0o600 });
  await assert.rejects(acquireLock(paths), { code: 'daemon_busy' });
  assert.deepEqual(await readPrivateJSON(partial), owner);
});

for (const phase of ['choosing', 'publication', 'owner']) {
  test(`a process killed during ${phase} leaves a recoverable lock without displacing a live process`, async t => {
    const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
    const contender = await worker(t, setup, phase);
    contender.child.send('acquire');
    const checkpoint = await contender.next();
    if (phase === 'owner') assert.equal(checkpoint.acquired, true);
    else {
      assert.equal(checkpoint.checkpoint, phase);
      // A partially prepared owner must never be exposed at the public path.
      await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
    }
    await assert.rejects(acquireLock(paths), { code: 'daemon_busy' });
    await contender.stop();
    const replacement = await acquireLock(paths);
    assert.equal((await readPrivateJSON(path.join(paths.lock, 'owner.json'))).instanceId, replacement.owner.instanceId);
    assert.deepEqual(await readdir(`${paths.lock}.claims`), []);
    await replacement.release();
  });
}

test('concurrent stale-lock recovery elects one owner and preserves it until release', async t => {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  await mkdir(paths.lock, { mode: 0o700 });
  await atomicJSON(path.join(paths.lock, 'owner.json'), deadOwner(paths));
  await mkdir(`${paths.lock}.reaping`, { mode: 0o700 });
  const contenders = await Promise.all(Array.from({ length: 6 }, () => worker(t, setup)));
  for (const contender of contenders) contender.child.send('acquire');
  const results = await Promise.all(contenders.map(contender => contender.next()));
  assert.equal(results.filter(result => result.acquired).length, 1, JSON.stringify(results));
  for (const result of results.filter(result => !result.acquired)) assert.equal(result.code, 'daemon_busy');
  const winner = results.findIndex(result => result.acquired);
  assert.deepEqual(await readPrivateJSON(path.join(paths.lock, 'owner.json')), results[winner].owner);
  for (const contender of contenders) contender.child.send('release');
  await Promise.all(contenders.map(contender => contender.exited));
  const replacement = await acquireLock(paths);
  await replacement.release();
});

test('a repeated old release cannot remove a subsequent live owner', async t => {
  const setup = await workspace(t), paths = await projectPaths(setup.projectRoot, setup.dataDir, { create: true });
  const first = await acquireLock(paths);
  await Promise.all([first.release(), first.release()]);
  const second = await acquireLock(paths);
  await first.release();
  assert.deepEqual(await readPrivateJSON(path.join(paths.lock, 'owner.json')), second.owner);
  await second.release();
});
