import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { structure, file, ref, interpretation } from './fixtures.mjs';

const create = () => createProjectModel({ projectId: 'synthetic-project', policy: { readSource: true }, now: () => 100 });
const capture = overrides => ({ id: 'artifact-demo', ...ref(), relativePath: 'src/demo.js', status: 'present', complete: true, ...overrides });

test('identical inventory and captured source rechecks leave revision, sequence, and answers unchanged', () => {
  for (const complete of [true, false]) {
    const model = create();
    const inventory = { entries: [file('src/demo.js')], coverage: { complete: true } };
    model.observeInventory(inventory);
    model.invalidateArtifacts([capture()]);
    model.observeStructure(structure({ complete }));
    model.observeInterpretations([interpretation()]);
    const baseline = model.snapshot();
    for (let pass = 0; pass < 3; pass++) {
      model.observeInventory(structuredClone(inventory));
      model.invalidateArtifacts([capture({ observedAt: pass + 1 })]);
      assert.deepEqual(model.snapshot(), baseline);
    }
    assert.equal(baseline.interpretations[0].validity, 'current');
    assert.equal(baseline.coverage.enumerations[0].complete, complete);
  }
});

test('exact repeated parsing is idempotent for complete and partial certificates', () => {
  for (const complete of [true, false]) {
    const model = create();
    model.observeInventory({ entries: [file('src/demo.js')] });
    model.invalidateArtifacts([capture()]);
    const input = structure({ complete, relations: [{ id: 'reference', source: 'class-a', target: 'class-b', kind: 'references' }] });
    assert.equal(model.observeStructure(input).accepted, true);
    const baseline = model.snapshot();
    for (let pass = 0; pass < 3; pass++) {
      assert.equal(model.observeStructure(structuredClone(input)).accepted, true);
      assert.deepEqual(model.snapshot(), baseline);
    }
  }
});

test('repeated lexical output with unresolved ownership does not manufacture revisions', () => {
  const model = create(), input = structure({ capability: 'lexical', complete: false });
  model.observeStructure(input);
  const baseline = model.snapshot();
  model.observeStructure(input);
  assert.deepEqual(model.snapshot(), baseline);
});

test('a real version or inventory change still advances once and invalidates support', () => {
  const model = create();
  model.observeStructure(structure());
  model.observeInterpretations([interpretation()]);
  const baseline = model.snapshot();
  const changed = capture({ ...ref('artifact-demo', 2) });
  model.invalidateArtifacts([changed]);
  const invalidated = model.snapshot();
  assert.equal(invalidated.revision, baseline.revision + 1);
  assert.equal(invalidated.sequence, baseline.sequence + 1);
  assert.equal(invalidated.interpretations[0].validity, 'stale');
  model.invalidateArtifacts([changed]);
  assert.deepEqual(model.snapshot(), invalidated);
  const inventory = { entries: [file('src/demo.js'), file('src/second.js')], coverage: { complete: true } };
  model.observeInventory(inventory);
  const updated = model.snapshot();
  assert.ok(updated.revision > invalidated.revision);
  model.observeInventory(inventory);
  assert.deepEqual(model.snapshot(), updated);
});
