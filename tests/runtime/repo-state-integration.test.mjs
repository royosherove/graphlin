import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../runtime/daemon/server.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { saveSettings, readSettings } from '../../runtime/daemon/settings.mjs';
import { workspace, run } from './helpers.mjs';

const cli = fileURLToPath(new URL('../../scripts/graphlin.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../../scripts/collect.sh', import.meta.url));

test('default storage and real passive hooks isolate two repositories without an environment override', async t => {
  const original = process.env.GRAPHLIN_DATA_DIR;
  delete process.env.GRAPHLIN_DATA_DIR;
  t.after(() => {
    if (original === undefined) delete process.env.GRAPHLIN_DATA_DIR;
    else process.env.GRAPHLIN_DATA_DIR = original;
  });
  const setup = await workspace(t);
  const roots = [setup.projectRoot, path.join(setup.base, 'second repository')];
  for (const root of roots) {
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  }
  const paths = await Promise.all(roots.map(root => projectPaths(root)));
  for (let index = 0; index < roots.length; index++) {
    await saveSettings({ projectRoot: roots[index] }, {
      apiKey: `synthetic-repo-${index}-key`,
      policy: { allowSource: false, displayEvidence: true, persistEvidence: false },
    });
    assert.equal(paths[index].dataDir, path.join(roots[index], '.graphlin'));
    assert.equal((await readSettings({ projectRoot: path.join(roots[index], 'src') })).apiKey,
      `synthetic-repo-${index}-key`);
    assert.match(await readFile(path.join(roots[index], '.gitignore'), 'utf8'), /(?:^|\n)\/\.graphlin\/(?:\r?\n|$)/);
  }
  const servers = [];
  t.after(async () => { for (const server of servers) await server.close(); });
  for (const root of roots) servers.push(await startServer({ projectRoot: root,
    policy: { transmitSource: false, readSource: false } }));
  assert.notEqual(paths[0].socket, paths[1].socket);

  const env = { ...process.env, GRAPHLIN_NODE: process.execPath };
  delete env.GRAPHLIN_DATA_DIR;
  delete env.TYPESAFE_API_KEY;
  for (let index = 0; index < roots.length; index++) {
    const nested = path.join(roots[index], 'src', 'nested');
    const delivered = await run('/bin/sh', [hook, 'claude'], {
      // The plugin's own checkout is unrelated to the project in the event.
      cwd: setup.base, env,
      input: JSON.stringify({ cwd: nested, hook_event_name: 'SessionStart', session_id: `local-repo-${index}` }),
    });
    assert.deepEqual(delivered, { code: 0, stdout: '', stderr: '' });
    await servers[index].pipeline.whenIdle();
    assert.equal(servers[index].pipeline.getState().sessions.length, 1);
    if (index === 0) assert.equal(servers[1].pipeline.getState().sessions.length, 0);

    const status = await run(process.execPath, [cli, 'status'], { cwd: nested, env });
    assert.equal(status.code, 0, status.stderr);
    const details = JSON.parse(status.stdout);
    assert.equal(details.running, true);
    assert.equal(details.port, Number(new URL(servers[index].url).port));
    assert.ok(details.logPath.startsWith(path.join(roots[index], '.graphlin') + path.sep));
  }
  for (const server of servers) await server.close();
  for (const local of paths) {
    for (const filename of [local.state, path.join(local.directory, 'model-state.json')]) {
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
    }
  }
});
