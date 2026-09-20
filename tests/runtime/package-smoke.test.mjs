import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPackages } from '../../scripts/build-packages.mjs';
import { smokeStablePackage } from '../../.github/scripts/smoke-stable-packages.mjs';

test('package smoke rejects silent hooks that deliver no session or no source evidence and closes the server', async t => {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin broken package smoke '));
  t.after(() => rm(base, { recursive: true, force: true }));
  const outputDir = path.join(base, 'packages');
  await buildPackages({ outputDir });
  const pluginRoot = path.join(outputDir, 'claude', 'graphlin');
  const { projectPaths } = await import(pathToFileURL(path.join(pluginRoot, 'runtime/daemon/paths.mjs')));
  for (const [name, entry, error] of [
    ['missing collector', null, /SessionStart must reach the packaged server through IPC/],
    ['session only', `
      import { collect, readHook } from '../runtime/collector/index.mjs';
      const payload = await readHook();
      if (payload?.hook_event_name === 'SessionStart') await collect(payload, { host: 'claude' });
    `, /packaged read hook must produce the first source-backed shape/],
  ]) {
    await t.test(name, async () => {
      const collector = path.join(pluginRoot, 'scripts/collector.mjs');
      if (entry === null) await rm(collector);
      else await writeFile(collector, entry);
      const projectRoot = path.join(base, name, 'project'), dataDir = path.join(base, name, 'data');
      await assert.rejects(smokeStablePackage({ pluginRoot, host: 'claude', projectRoot, dataDir }), error);
      const paths = await projectPaths(projectRoot, dataDir);
      await assert.rejects(lstat(paths.socket), { code: 'ENOENT' }, 'Failure must close and remove the IPC socket.');
      await assert.rejects(lstat(paths.lock), { code: 'ENOENT' }, 'Failure must release the server lock.');
    });
  }
});
