import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../../runtime/daemon/server.mjs';
import { runForeground } from '../../runtime/daemon/manager.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { workspace, run } from './helpers.mjs';

test('a long attachment does not accumulate promise callbacks and removes its abort listener on exit', { timeout: 30000 }, async t => {
  const setup = await workspace(t);
  const server = await startServer({ ...setup, decisionService: {
    classify() { throw new Error('unexpected_classification'); }, stats: () => ({ calls: 0 }), close() {},
  } });
  const controller = new AbortController();
  const originalTimeout = globalThis.setTimeout, originalThen = Promise.prototype.then;
  const reactions = new WeakMap();
  let polls = 0, maxReactions = 0, activePolls = 0, maxActivePolls = 0, tracking = false, timedOut = false;
  const watchdog = originalTimeout(() => { timedOut = true; controller.abort(); }, 20000);
  // Observe registration on actual promises, rather than asserting a noisy
  // heap threshold. The old loop registers 25,000 reactions on one pending
  // interruption promise, even though it has only one AbortSignal listener.
  t.mock.method(Promise.prototype, 'then', function (...args) {
    if (tracking) {
      const count = (reactions.get(this) ?? 0) + 1;
      reactions.set(this, count); maxReactions = Math.max(maxReactions, count);
    }
    return Reflect.apply(originalThen, this, args);
  });
  t.mock.method(globalThis, 'setTimeout', function (callback, ms, ...args) {
    if (ms !== 200 || !tracking) return originalTimeout(callback, ms, ...args);
    activePolls++; maxActivePolls = Math.max(maxActivePolls, activePolls);
    // Real owner-file reads and IPC remain in place; only the 200 ms interval
    // is accelerated so several hours of attachment can be checked promptly.
    return setImmediate(() => {
      activePolls--; polls++;
      if (polls === 25000) controller.abort();
      callback(...args);
    });
  });
  let attached;
  try {
    attached = runForeground({ ...setup, signal: controller.signal }, details => {
      assert.equal(details.reused, true);
      assert.equal(details.pid, process.pid);
      tracking = true;
      assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    });
    await attached;
    tracking = false;
    assert.equal(timedOut, false, 'accelerated attachment completes within the test budget');
    assert.equal(polls, 25000);
    assert.ok(maxReactions <= 8, `promise callback registrations must stay bounded, observed ${maxReactions}`);
    assert.equal(maxActivePolls, 1);
    assert.equal(activePolls, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(await server.whenClosed, { ok: true });
    const paths = await projectPaths(setup.projectRoot, setup.dataDir);
    await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
  } finally {
    tracking = false; clearTimeout(watchdog); controller.abort();
    t.mock.restoreAll();
    await attached?.catch(() => {});
    await server.close();
  }
});

test('IPC shutdown observes a rejected close while whenClosed reports failure and releases resources', async t => {
  const setup = await workspace(t);
  const moduleURL = filename => pathToFileURL(path.resolve(filename)).href;
  // Strict mode makes an unhandled rejection fatal, isolating the regression
  // from node:test's own rejection handlers and from other runtime tests.
  const script = `
    import assert from 'node:assert/strict';
    import { lstat } from 'node:fs/promises';
    import { startServer } from ${JSON.stringify(moduleURL('runtime/daemon/server.mjs'))};
    import { projectPaths } from ${JSON.stringify(moduleURL('runtime/daemon/paths.mjs'))};
    import { health } from ${JSON.stringify(moduleURL('runtime/daemon/lock.mjs'))};
    import { requestIPC } from ${JSON.stringify(moduleURL('runtime/daemon/ipc.mjs'))};
    const setup = ${JSON.stringify({ projectRoot: setup.projectRoot, dataDir: setup.dataDir })};
    let closes = 0;
    const server = await startServer({ ...setup, decisionService: {
      classify() { throw new Error('unexpected_classification'); },
      stats: () => ({ calls: 0 }),
      close() { closes++; throw new Error('fixture_close_failure'); }
    } });
    const paths = await projectPaths(setup.projectRoot, setup.dataDir);
    const owner = await health(paths);
    assert.deepEqual(await requestIPC(paths.socket, { op: 'shutdown', instanceId: owner.instanceId }), { ok: true });
    assert.deepEqual(await server.whenClosed, { ok: false, code: 'shutdown_failed' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(server.close(), /fixture_close_failure/);
    assert.equal(closes, 1);
    await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
    await assert.rejects(lstat(paths.socket), { code: 'ENOENT' });
    await assert.rejects(fetch(new URL('/', server.url), { signal: AbortSignal.timeout(1000) }));
    await new Promise(resolve => setImmediate(resolve));
    console.log('shutdown_failure_observed_and_cleaned');
  `;
  const result = await run(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script],
    { timeout: 5000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), 'shutdown_failure_observed_and_cleaned');
});
