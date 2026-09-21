import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { currentPolicy } from '../../runtime/model/records.mjs';
import { createPolicy } from '../../runtime/core/privacy.mjs';
import { file, structure } from './fixtures.mjs';

test('cached policy normalization never delays mutable exclusions or source revocation in live and frozen reads', () => {
  const policy = { readSource: true, persistEvidence: true, excludePaths: [] };
  const model = createProjectModel({ projectId: 'synthetic-policy-cache', policy: () => policy });
  model.observeInventory({ entries: [file('src/demo.js')] });
  model.observeStructure(structure());
  const marker = model.checkpoint(), before = model.stats();
  const read = options => model.snapshot(options).entities.find(entity => entity.id === 'class-a').label;
  assert.equal(read(), 'Alpha');
  assert.equal(read({ checkpointId: marker.id }), 'Alpha');
  policy.excludePaths.push('src/**');
  assert.equal(read(), 'class');
  assert.equal(read({ checkpointId: marker.id }), 'class');
  assert.equal(read({ persistent: true }), 'class');
  policy.excludePaths.length = 0;
  assert.equal(read(), 'Alpha');
  policy.readSource = false;
  assert.equal(read(), 'class');
  assert.equal(read({ checkpointId: marker.id }), 'class');
  assert.equal(model.stats().revision, before.revision, 'privacy applies without a model notification');
  assert.equal(model.stats().sequence, before.sequence);
});

test('a provider is evaluated on every read while its branded result may safely retain identity', () => {
  let policy = createPolicy({ readSource: true });
  const provider = () => policy;
  assert.equal(currentPolicy(provider), policy);
  const model = createProjectModel({ projectId: 'synthetic-new-policy', policy: provider });
  model.observeStructure(structure());
  assert.equal(model.snapshot().entities.find(entity => entity.id === 'class-a').label, 'Alpha');
  policy = createPolicy({ readSource: false });
  assert.equal(currentPolicy(provider), policy);
  assert.equal(model.snapshot().entities.find(entity => entity.id === 'class-a').label, 'class');
  policy = createPolicy({ readSource: true });
  assert.equal(model.snapshot().entities.find(entity => entity.id === 'class-a').label, 'Alpha');
});
