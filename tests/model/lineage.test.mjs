import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { structure, file, interpretation } from './fixtures.mjs';

const firstLineage = { id: 'lineage-a', status: 'available', branch: 'feature/one', head: 'a'.repeat(40) };
const nextLineage = { id: 'lineage-b', status: 'available', branch: 'feature/two', head: 'b'.repeat(40) };
const create = options => createProjectModel({
  projectId: 'synthetic-project', policy: { readSource: true, persistEvidence: true }, now: () => 100, ...options,
});

test('lineage changes invalidate live source authority without changing frozen history', () => {
  const model = create();
  assert.deepEqual(model.observeLineage(firstLineage), { changed: false, lineage: firstLineage });
  model.observeInventory({ entries: [file('src/demo.js')] });
  const input = structure({ relations: [{ id: 'uses', source: 'class-a', target: 'class-b', kind: 'references' }] });
  model.observeStructure(input);
  model.observeInterpretations([interpretation({ kind: 'application' })]);
  const baseline = model.checkpoint();
  const frozen = model.snapshot({ checkpointId: baseline.id });
  assert.equal(model.observeLineage(nextLineage).changed, true);
  const current = model.snapshot();
  assert.ok(current.entities.filter(value => value.basis !== 'metadata').every(value => value.validity === 'stale'));
  assert.ok(current.entities.filter(value => value.basis === 'metadata').every(value => value.validity === 'current'));
  assert.equal(current.relations[0].validity, 'stale');
  assert.equal(current.interpretations[0].validity, 'stale');
  assert.equal(current.interpretations[0].classification, 'stale');
  assert.equal(current.coverage.artifacts[0].fresh, false);
  assert.ok(!current.coverage.artifacts[0].observed);
  assert.equal(current.coverage.enumerations[0].complete, false);
  assert.deepEqual(current.coverage.lineage, nextLineage);
  assert.deepEqual(model.snapshot({ checkpointId: baseline.id }), frozen);

  // Identical bytes and generation can be freshly captured in another branch.
  model.observeStructure(input);
  assert.equal(model.snapshot().entities.find(value => value.id === 'class-a').validity, 'current');
  assert.equal(model.snapshot().relations[0].validity, 'current');
  assert.equal(model.snapshot().interpretations[0].validity, 'stale');
});

test('matching restored lineage causes no extra revision and retains stale live evidence', () => {
  const model = create();
  model.observeLineage(firstLineage);
  model.observeStructure(structure());
  model.checkpoint();
  const restored = create({ restoredState: JSON.parse(JSON.stringify(model.snapshot({ persistent: true }))) });
  const before = restored.snapshot();
  const result = restored.observeLineage(firstLineage);
  result.lineage.branch = 'mutated';
  assert.equal(result.changed, false);
  assert.deepEqual(restored.snapshot(), before);
  assert.equal(before.entities.find(value => value.id === 'class-a').validity, 'stale');
  assert.deepEqual(before.coverage.lineage, firstLineage);
  const history = restored.snapshot({ checkpointId: before.checkpoints[0].id });
  assert.deepEqual(history.coverage.lineage, firstLineage);
  assert.equal(history.entities.find(value => value.id === 'class-a').validity, 'current');
});

test('absence in another lineage never establishes creation', () => {
  const model = create();
  model.observeLineage(firstLineage);
  model.observeStructure(structure({ symbols: [] }));
  const baseline = model.checkpoint();
  model.observeLineage(nextLineage);
  model.observeStructure(structure({ generation: 2 }));
  assert.deepEqual(model.changes(baseline.id).creations, []);
  assert.ok(model.changes(baseline.id).discoveries.some(value => value.id === 'class-a'));
});

test('lineage stores only safe observed metadata and does not treat metadata updates as branch changes', () => {
  const model = create();
  model.observeLineage({ ...firstLineage, source: 'RAW_SYNTHETIC_SOURCE', cwd: '/private/worktree' });
  model.observeStructure(structure());
  assert.equal(model.observeLineage({ ...firstLineage, status: 'detached', branch: undefined }).changed, false);
  const snapshot = model.snapshot();
  assert.equal(snapshot.entities.find(value => value.id === 'class-a').validity, 'current');
  assert.deepEqual(snapshot.coverage.lineage, { id: firstLineage.id, status: 'detached', head: firstLineage.head });
  assert.doesNotMatch(JSON.stringify(snapshot), /RAW_SYNTHETIC_SOURCE|private\/worktree/);
  assert.equal(model.observeLineage({ id: '/private/worktree' }).changed, false);
});
