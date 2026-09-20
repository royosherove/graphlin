import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace, run } from './helpers.mjs';
import { collect } from '../../runtime/collector/index.mjs';

const launcher = path.resolve('scripts/collect.sh');
const assertSilent = result => { assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); };

test('passive launcher is silent for absent daemon, malformed/oversized input and missing runtime', async t => {
  const { projectRoot, dataDir } = await workspace(t);
  const env = { ...process.env, GRAPHLIN_DATA_DIR: dataDir };
  for (const input of ['', '{bad json', JSON.stringify({ cwd: projectRoot, hook_event_name: 'Stop' }), 'x'.repeat(300_000)]) {
    assertSilent(await run('/bin/sh', [launcher, 'claude'], { input, env }));
  }
  assertSilent(await run('/bin/sh', [launcher], { env: { ...env, GRAPHLIN_NODE: '/no/runtime/here' } }));
  assert.equal(await collect({ cwd: projectRoot }, { dataDir }), false);
});

test('guarded host command tolerates missing launcher and bundle paths with spaces', async t => {
  const { base, projectRoot, dataDir } = await workspace(t);
  const profile = JSON.parse(await readFile('adapters/claude/hooks.json', 'utf8'));
  const command = profile.hooks.Stop[0].hooks[0].command;
  assertSilent(await run('/bin/sh', ['-c', command], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: '/missing plugin' } }));
  const bundle = path.join(base, 'plugin with spaces'); await mkdir(path.join(bundle, 'scripts'), { recursive: true });
  await cp(launcher, path.join(bundle, 'scripts/collect.sh'));
  // Missing JS entry is silent too.
  assertSilent(await run('/bin/sh', ['-c', command], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: bundle } }));
  await cp('scripts/collector.mjs', path.join(bundle, 'scripts/collector.mjs'));
  // Missing imported runtime is handled outside the JS process.
  assertSilent(await run('/bin/sh', ['-c', command], { input: JSON.stringify({ cwd: projectRoot }),
    env: { ...process.env, GRAPHLIN_DATA_DIR: dataDir, CLAUDE_PLUGIN_ROOT: bundle } }));
});

test('outer watchdog bounds a broken executable before JavaScript can run', async t => {
  const { base } = await workspace(t), fake = path.join(base, 'hung runtime');
  await writeFile(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const started = Date.now();
  assertSilent(await run('/bin/sh', [launcher], { env: { ...process.env, GRAPHLIN_NODE: fake }, timeout: 4000 }));
  assert.ok(Date.now() - started < 2500);
});
