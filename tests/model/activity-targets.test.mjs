import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { file, ref, structure } from './fixtures.mjs';

test('exact file activity follows canonical parsing while its checkpoint keeps recorded anchors', () => {
  const model = createProjectModel({ projectId: 'synthetic-activity-model', policy: { readSource: true } });
  model.observeInventory({ entries: [file('src/demo.js')] });
  const fileId = model.resolveActivityTargets(['src/demo.js']).entityIds[0];
  model.recordActivity({ id: 'request', kind: 'tool.requested', outcome: 'pending', operation: 'read',
    mapping: 'exact', entityIds: [fileId], artifactIds: ['artifact-demo'], sourceRefs: [],
    command: 'SYNTHETIC_PRIVATE_COMMAND', source: 'SYNTHETIC_PRIVATE_BODY' });
  const checkpoint = model.checkpoint();
  const frozen = model.snapshot({ checkpointId: checkpoint.id });
  model.observeStructure(structure());
  const current = model.snapshot().activity.find(row => row.id === 'request');
  assert.deepEqual(current.entityIds, ['module-demo']);
  assert.equal(current.outcome, 'pending');
  assert.equal(current.mapping, 'exact');
  assert.deepEqual(current.sourceRefs, []);
  assert.deepEqual(model.snapshot({ checkpointId: checkpoint.id }), frozen);
  assert.deepEqual(frozen.activity.find(row => row.id === 'request').entityIds, [fileId]);
  assert.doesNotMatch(JSON.stringify(model.snapshot({ persistent: true })), /SYNTHETIC_PRIVATE/);
});

test('mapping observations cannot imply creation or modify the recorded lifecycle', () => {
  const model = createProjectModel({ projectId: 'synthetic-activity-lifecycle', policy: { readSource: true } });
  model.observeStructure(structure());
  model.recordActivity({ id: 'finished', kind: 'tool.succeeded', outcome: 'succeeded',
    at: '2026-09-21T01:00:00.000Z', operation: 'edit', mapping: 'exact', entityIds: ['module-demo'] });
  const revision = model.stats().revision, before = model.snapshot().activity.at(-1);
  model.recordActivity({ ...before, id: 'mapped', kind: 'activity.mapped', mapping: 'decision',
    entityIds: ['method-a'], sourceRefs: [ref()], creation: true });
  const current = model.snapshot();
  assert.equal(model.stats().revision, revision);
  assert.deepEqual(current.activity.find(row => row.id === 'finished'), before);
  assert.equal(current.activity.at(-1).at, before.at);
  assert.equal(current.activity.at(-1).outcome, before.outcome);
  assert.equal(current.activity.at(-1).creation, false);
  assert.equal(current.entities.find(entity => entity.id === 'method-a').createdAtSequence, undefined);
  model.recordActivity({ operation: 'execute', mapping: 'guessed' });
  assert.equal(model.snapshot().activity.at(-1).operation, undefined);
  assert.equal(model.snapshot().activity.at(-1).mapping, undefined);
});
