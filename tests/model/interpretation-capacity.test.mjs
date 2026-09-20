import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { structure, ref, interpretation } from './fixtures.mjs';

const namespace = 'graphlin.architecture';
const create = limits => {
  const model = createProjectModel({
    projectId: 'synthetic-capacity', policy: { readSource: true, persistEvidence: true },
    now: () => 100, limits,
  });
  model.observeStructure(structure());
  return model;
};
const boundary = (id, kind = 'application', entityIds = ['class-a']) =>
  interpretation({ id, namespace, kind, entityIds, label: id });
const batch = () => [
  boundary('new-application'),
  boundary('new-component', 'component', ['class-b']),
  boundary('new-membership', 'architecture_membership', ['class-a', 'class-b']),
];
const scope = { artifactIds: ['artifact-demo'], sourceRefs: [ref()] };
function seeded({ limits, unrelated = 1, legacy = 0 } = {}) {
  const model = create(limits);
  model.observeInterpretations([
    ...Array.from({ length: unrelated }, (_, index) => interpretation({ id: `unrelated-${index}` })),
    ...Array.from({ length: legacy }, (_, index) =>
      interpretation({ id: `legacy-${index}`, namespace: 'graphlin.legacy-role' })),
    boundary('old-application'),
  ]);
  return model;
}
function assertDeferred(model, input) {
  const checkpoint = model.checkpoint(), history = model.snapshot({ checkpointId: checkpoint.id });
  const before = model.snapshot(), stats = model.stats();
  const result = model.replaceInterpretations(namespace, input, scope);
  assert.equal(result.accepted, true);
  assert.equal(result.changed, true);
  assert.equal(result.retained, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.deferred.interpretations - stats.deferred.interpretations, input.length);
  assert.deepEqual(model.snapshot().interpretations, before.interpretations);
  assert.equal(model.snapshot().coverage.truncated, true);
  assert.ok(model.stats().bytes <= model.stats().limits.bytes);
  assert.deepEqual(model.snapshot({ checkpointId: checkpoint.id }), history);
}

test('a full architecture batch cannot replace an old application with partial groups at the 512-record cap', () => {
  const model = seeded({ unrelated: 510 });
  assert.equal(model.stats().interpretations, 511);
  assertDeferred(model, batch());
  assert.equal(model.stats().interpretations, 511);
  assert.deepEqual(model.snapshot().interpretations.filter(value => value.namespace === namespace)
    .map(value => [value.label, value.validity]), [['old-application', 'current']]);
});

test('an impossible batch keeps prospective legacy victims even when the batch exceeds the configured count cap', () => {
  const model = seeded({ limits: { interpretations: 2 }, unrelated: 0, legacy: 1 });
  assert.equal(model.stats().interpretations, 2);
  assertDeferred(model, batch());
  assert.equal(model.snapshot().interpretations.filter(value => value.namespace === 'graphlin.legacy-role').length, 1);
});

test('a fitting batch evicts only the oldest necessary legacy records and preserves frozen history', () => {
  const model = seeded({ limits: { interpretations: 5 }, legacy: 3 });
  const before = model.snapshot().interpretations;
  const legacy = before.filter(value => value.namespace === 'graphlin.legacy-role');
  const unrelated = before.find(value => value.namespace === 'example.responsibility');
  const checkpoint = model.checkpoint(), history = model.snapshot({ checkpointId: checkpoint.id });
  const result = model.replaceInterpretations(namespace, batch(), scope);
  assert.equal(result.accepted, true);
  assert.equal(result.retained, 3);
  assert.equal(result.removed, 1);
  assert.equal(result.interpretations, 5);
  assert.equal(result.deferred.interpretations, 2);
  const after = model.snapshot().interpretations;
  assert.deepEqual(after.filter(value => value.namespace === 'graphlin.legacy-role'), [legacy[2]]);
  assert.deepEqual(after.find(value => value.id === unrelated.id), unrelated);
  assert.deepEqual(after.filter(value => value.namespace === namespace).map(value => value.kind).sort(),
    ['application', 'architecture_membership', 'component']);
  assert.ok(model.stats().bytes <= model.stats().limits.bytes);
  assert.deepEqual(model.snapshot({ checkpointId: checkpoint.id }), history);
});

test('full-batch byte preflight includes checkpoints and leaves old roles and legacy victims intact', () => {
  const probe = seeded({ legacy: 1 });
  probe.checkpoint();
  const byteLimit = probe.stats().bytes + 400;
  const model = seeded({ limits: { bytes: byteLimit }, legacy: 1 });
  const input = batch();
  input[2].sourceRefs = Array.from({ length: 16 }, (_, index) => ({
    ...ref(), startLine: index + 2, endLine: index + 2,
  }));
  assertDeferred(model, input);
  assert.equal(model.stats().limits.bytes, byteLimit);
  assert.ok(model.stats().historyBytes > 0);
});

test('shrinking updates release bytes before growing updates in a fitting atomic replacement', () => {
  const setup = bytes => {
    const model = create({ activity: 1, ...(bytes ? { bytes } : {}) });
    model.observeInterpretations([boundary('first'), boundary('second')]);
    const sorted = model.snapshot().interpretations.sort((a, b) => a.id < b.id ? -1 : 1);
    model.replaceInterpretations(namespace, [
      { ...sorted[0], label: 'Small' }, { ...sorted[1], label: 'Large '.repeat(35).trim() },
    ], scope);
    return model;
  };
  const byteLimit = setup().stats().bytes;
  const model = setup(byteLimit);
  const before = model.snapshot().interpretations.sort((a, b) => a.id < b.id ? -1 : 1);
  assert.equal(before[0].label, 'Small');
  const input = [
    { ...before[0], label: before[1].label }, { ...before[1], label: before[0].label },
  ];
  const result = model.replaceInterpretations(namespace, input, scope);
  assert.equal(result.accepted, true);
  assert.equal(result.retained, 2);
  assert.equal(result.removed, 0);
  assert.equal(result.deferred.interpretations, 0);
  assert.deepEqual(model.snapshot().interpretations.sort((a, b) => a.id < b.id ? -1 : 1), input);
  assert.ok(model.stats().bytes <= byteLimit);
  const current = model.snapshot();
  assert.equal(model.replaceInterpretations(namespace, input, scope).changed, false);
  assert.deepEqual(model.snapshot(), current);
});
