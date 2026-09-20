import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../runtime/daemon/server.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { workspace, authenticate } from './helpers.mjs';

for (const mode of ['live', 'demo']) {
  test(`connection instructions are authenticated and use the canonical server roots in ${mode} mode`, async t => {
    const setup = await workspace(t);
    const originalKey = process.env.TYPESAFE_API_KEY;
    const key = 'CONNECTION_ROUTE_KEY_MUST_NOT_BE_RETURNED_9241';
    process.env.TYPESAFE_API_KEY = key;
    t.after(() => {
      if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = originalKey;
    });
    let calls = 0;
    const server = await startServer({ ...setup, mode, decisionService: {
      classify() { calls++; throw new Error('unexpected_classification'); },
      stats: () => ({ calls }), close() {},
    } });
    try {
      const { origin, cookie, token } = await authenticate(server);
      assert.equal((await fetch(`${origin}/api/connection-info`)).status, 401);
      const foreign = await fetch(`${origin}/api/connection-info`, {
        headers: { Cookie: cookie, Origin: 'https://untrusted.example' },
      });
      assert.equal(foreign.status, 403);
      assert.equal((await fetch(`${origin}/api/connection-info?projectRoot=other`, {
        headers: { Cookie: cookie },
      })).status, 400);
      const response = await fetch(`${origin}/api/connection-info`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      const info = await response.json();
      const { createConnectionInfo } = await import('../../runtime/daemon/connection-info.mjs');
      const paths = await projectPaths(setup.projectRoot, setup.dataDir);
      assert.deepEqual(info, await createConnectionInfo({
        projectRoot: paths.projectRoot, dataDir: paths.dataDir, mode,
      }));
      assert.equal(info.projectRoot, paths.projectRoot);
      assert.equal(info.mode, mode);
      assert.ok(Object.hasOwn(info, 'instructions'));
      assert.ok(Object.hasOwn(info, 'notes'));
      const commands = info.instructions.flatMap(instruction => instruction.steps.map(step => step.command));
      assert.ok(commands.length > 0, 'verified source packages offer usable connection steps');
      assert.ok(commands.every(command => typeof command === 'string' && command.length > 0));
      assert.ok(commands.some(command => command.includes('claude --plugin-dir')));
      assert.ok(commands.some(command => command.includes('codex plugin marketplace add')));
      assert.ok(commands.some(command => command.includes(paths.projectRoot) && command.includes(paths.dataDir)));
      const serialized = JSON.stringify(info);
      assert.equal(serialized.includes(token), false);
      assert.equal(serialized.includes(cookie.split('=')[1]), false);
      assert.equal(serialized.includes(key), false);
      for (const route of ['/api/state', '/api/export']) {
        const snapshotResponse = await fetch(origin + route, { headers: { Cookie: cookie } });
        assert.equal(snapshotResponse.status, 200);
        const snapshot = await snapshotResponse.json(), body = JSON.stringify(snapshot);
        assert.equal(snapshot.mode, mode);
        for (const field of ['projectRoot', 'dataDir', 'instructions', 'notes']) {
          assert.equal(Object.hasOwn(snapshot, field), false, `${route} does not acquire connection metadata`);
        }
        for (const forbidden of [paths.projectRoot, paths.dataDir, key, token, cookie.split('=')[1],
          'claude --plugin-dir', 'codex plugin marketplace add']) {
          assert.equal(body.includes(forbidden), false, `${route} does not leak roots, commands, or credentials`);
        }
      }
      assert.equal(calls, 0);
    } finally { await server.close(); }
  });
}
