import test from 'node:test';
import assert from 'node:assert/strict';
import { architectureSources, createArchitectureFixture } from '../helpers/architecture-fixture.mjs';

test('architecture preserves completed work through unknown lineage and resumes changed source on confirmation', { timeout: 12_000 }, async t => {
  const f = await createArchitectureFixture();
  t.after(f.close);
  const lineage = f.pipeline.getModelState().coverage.lineage;
  const complete = f.pipeline.getArchitectureStatus(), calls = f.provider.calls.length;
  assert.equal(complete.status, 'complete');
  assert.equal(complete.inspected, 2);
  const baseline = f.pipeline.createCheckpoint();
  const frozen = f.pipeline.getModelState({ checkpointId: baseline.id });
  await f.pipeline.observeLineage({ ...lineage, status: 'unavailable' });
  assert.equal(f.pipeline.getArchitectureStatus().reason, 'lineage_unavailable');
  assert.equal(f.pipeline.getArchitectureStatus().inspected, complete.inspected);
  await f.pipeline.whenIdle();
  assert.equal(f.provider.calls.length, calls);
  await f.pipeline.observeLineage(lineage);
  await f.pipeline.whenIdle();
  assert.equal(f.provider.calls.length, calls, 'same-identity recovery does not restart completed discovery');

  await f.pipeline.observeLineage({ ...lineage, status: 'unavailable' });
  await f.updateSource('orders.js', architectureSources['orders.js'].replace('Synthetic order response', 'Changed response'), 'component');
  assert.equal(f.provider.calls.length, calls, 'changed source waits for confirmed lineage');
  assert.equal(f.pipeline.getArchitectureStatus().status, 'unavailable');
  await f.pipeline.observeLineage(lineage);
  await f.pipeline.whenIdle();
  const status = f.pipeline.getArchitectureStatus();
  assert.equal(status.status, 'complete');
  assert.equal(status.applications, 1);
  assert.equal(status.components, 1);
  assert.equal(status.pending, 0);
  assert.equal(f.provider.calls.length - calls, 3, 'only the changed role and its membership need new decisions');
  assert.deepEqual(f.pipeline.getModelState({ checkpointId: baseline.id }), frozen);
});
