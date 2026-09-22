import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../../runtime/daemon/server.mjs';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { discoveryProgressView } from '../../runtime/web/discovery-progress.js';
import { authenticate, workspace } from './helpers.mjs';

test('authenticated viewer snapshots distinguish source modes without revealing policy or credentials', async t => {
  for (const [sourceMode, policy] of [
    ['metadata', { readSource: false, transmitSource: false }],
    ['local', { readSource: true, transmitSource: false }],
    ['source', { readSource: true, transmitSource: true }],
  ]) await t.test(sourceMode, async t => {
    const setup = await workspace(t);
    let calls = 0;
    const server = await startServer({
      ...setup, policy,
      decisionService: {
        classify: async () => { calls++; throw new Error('unexpected_provider_request'); },
        stats: () => ({ calls }), close() {},
      },
    });
    t.after(() => server.close());
    const { origin, cookie } = await authenticate(server);
    assert.equal((await fetch(origin + '/api/state')).status, 401);
    const response = await fetch(origin + '/api/state', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.sourceMode, sourceMode);
    assert.equal(Object.hasOwn(state, 'policy'), false);
    assert.equal(Object.hasOwn(state, 'apiKey'), false);
    assert.equal(calls, 0);
  });
});

test('finishing file inventory does not claim a ready map before the first captures are registered', async t => {
  const setup = await workspace(t);
  await writeFile(path.join(setup.projectRoot, 'entry.js'), 'export function run() { return 1; }');
  const observed = [];
  let pipeline;
  pipeline = createPipeline({
    projectRoot: setup.projectRoot, policy: { readSource: true, transmitSource: false },
    onChange() {
      if (!pipeline) return;
      observed.push({
        discovery: pipeline.getDiscoveryStatus(), coverage: pipeline.getModelState().coverage,
      });
    },
  });
  t.after(() => pipeline.close());
  await pipeline.reconcile();
  await pipeline.whenIdle();
  const gap = observed.find(value =>
    value.discovery.inventory.status === 'complete' && value.coverage.parsing.parsed === 0);
  assert.ok(gap, 'exercise the notification between inventory completion and source capture');
  assert.equal(gap.discovery.initialCaptureComplete, false);
  assert.equal(discoveryProgressView({ ...gap, connection: 'connected', sourceMode: 'local' }).settled, false);
  assert.equal(pipeline.getDiscoveryStatus().initialCaptureComplete, true);
  assert.equal(pipeline.getModelState().coverage.parsing.parsed, 1);
});

test('local source withholding prevents readiness and clears on safe replacement or deletion without remote calls', async t => {
  const setup = await workspace(t), filename = path.join(setup.projectRoot, 'entry.js');
  const safe = 'export const settings = { secret: process.env.SESSION_SECRET };';
  const withheld = safe.replace('process.env.SESSION_SECRET', "process.env.SESSION_SECRET || 'SYNTHETIC_ONLY'");
  await writeFile(filename, withheld);
  let calls = 0;
  const pipeline = createPipeline({
    projectRoot: setup.projectRoot, policy: { readSource: true, transmitSource: false },
    decisionService: {
      classify: async () => { calls++; throw new Error('unexpected_provider_request'); },
      stats: () => ({ calls }), close() {},
    },
  });
  t.after(() => pipeline.close());
  const view = () => discoveryProgressView({
    discovery: pipeline.getDiscoveryStatus(), coverage: pipeline.getModelState().coverage,
    connection: 'connected', sourceMode: 'local',
  });
  await pipeline.reconcile();
  await pipeline.whenIdle();
  assert.equal(pipeline.getDiscoveryStatus().sourceWithheld, 1);
  assert.equal(view().settled, false);
  assert.match(view().note, /privacy|withheld/i);
  await writeFile(filename, safe);
  await pipeline.reconcile();
  await pipeline.whenIdle();
  assert.equal(pipeline.getDiscoveryStatus().sourceWithheld, 0);
  assert.equal(view().settled, true);
  await writeFile(filename, withheld);
  await pipeline.reconcile();
  await pipeline.whenIdle();
  assert.equal(pipeline.getDiscoveryStatus().sourceWithheld, 1);
  await rm(filename);
  await pipeline.reconcile();
  await pipeline.whenIdle();
  assert.equal(pipeline.getDiscoveryStatus().sourceWithheld, 0);
  assert.equal(calls, 0);
});
