import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPlatform } from '../runtime/platform.mjs';
import { workspace } from './runtime/helpers.mjs';

test('initial inventory reports actual scanning across slices, then stays settled during background rescans', async t => {
  const setup = await workspace(t);
  await Promise.all(['first.js', 'second.js'].map(name =>
    writeFile(path.join(setup.projectRoot, name), 'export const value = 1;')));
  let now = 1000;
  const states = [];
  const platform = createPlatform({
    projectRoot: setup.projectRoot, projectId: 'progress-project', now: () => now,
    onChange: () => states.push(platform.getDiscoveryStatus().inventory.status),
  });
  t.after(() => platform.close());
  assert.deepEqual(platform.getDiscoveryStatus(), {
    inventory: { status: 'waiting', startedAt: null, finishedAt: null },
    sourceWithheld: 0,
  });
  await platform.discover({ limit: 1 });
  assert.equal(platform.getDiscoveryStatus().inventory.status, 'scanning');
  assert.equal(platform.getDiscoveryStatus().inventory.startedAt, 1000);
  now = 2000;
  for (let i = 0; i < 10 && platform.getDiscoveryStatus().inventory.status === 'scanning'; i++) {
    await platform.discover({ limit: 1 });
  }
  assert.deepEqual(platform.getDiscoveryStatus().inventory, {
    status: 'complete', startedAt: 1000, finishedAt: 2000,
  });
  assert.deepEqual(states, ['scanning', 'complete']);
  const copy = platform.getDiscoveryStatus();
  copy.inventory.status = 'scanning';
  now = 8000;
  await platform.discover({ limit: 1 });
  assert.deepEqual(platform.getDiscoveryStatus().inventory, {
    status: 'complete', startedAt: 1000, finishedAt: 2000,
  }, 'background rescans do not restart the initial-discovery clock');
});

test('an inventory ending at a traversal limit reports partial rather than an endless scan', async t => {
  const setup = await workspace(t);
  let directory = setup.projectRoot;
  for (let i = 0; i < 26; i++) {
    directory = path.join(directory, 'nested');
    await mkdir(directory);
  }
  const platform = createPlatform({ projectRoot: setup.projectRoot, projectId: 'limited-project' });
  t.after(() => platform.close());
  for (let i = 0; i < 20 && ['waiting', 'scanning'].includes(platform.getDiscoveryStatus().inventory.status); i++) {
    await platform.discover({ limit: 64 });
  }
  assert.equal(platform.getDiscoveryStatus().inventory.status, 'partial');
  assert.equal(platform.snapshot().coverage.complete, false);
  assert.ok(Number.isSafeInteger(platform.getDiscoveryStatus().inventory.finishedAt));
});
