import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { structure, file, ref, interpretation } from './fixtures.mjs';

const namespace = 'graphlin.architecture';
const policy = () => ({ readSource: true, persistEvidence: true });
const create = options => createProjectModel({
  projectId: 'synthetic-project', policy: policy(), now: () => 100, ...options,
});
const boundary = (id, entityIds = ['class-a'], sourceRefs = [ref()]) => interpretation({
  id, namespace, kind: 'application', label: `Application ${id}`, entityIds, sourceRefs,
});
const architecture = model => model.snapshot().interpretations.filter(value => value.namespace === namespace);

function populated(options) {
  const model = create(options);
  model.observeInventory({ entries: [file('src/demo.js'), file('src/other.js')] });
  model.observeStructure(structure());
  model.observeStructure(structure({
    artifactId: 'artifact-other', relativePath: 'src/other.js', scopeId: 'module-other',
    symbols: [{ id: 'other-class', label: 'Other', kind: 'class', parentId: 'module-other', startLine: 2, endLine: 8 }],
  }));
  return model;
}
const first = () => boundary('first');
const second = () => boundary('second', ['other-class'], [ref('artifact-other')]);

test('an empty scoped answer withdraws affected boundaries while keeping unrelated interpretations and checkpoints', () => {
  const model = populated();
  const shared = boundary('shared', ['class-a', 'other-class'], [ref(), ref('artifact-other')]);
  model.replaceInterpretations(namespace, [first(), second(), shared]);
  model.observeInterpretations([interpretation()]);
  const untouched = architecture(model).find(value => value.label === 'Application second');
  const otherNamespace = model.snapshot().interpretations.find(value => value.namespace === 'example.responsibility');
  const checkpoint = model.checkpoint(), history = model.snapshot({ checkpointId: checkpoint.id });

  const result = model.replaceInterpretations(namespace, [], { affectedEntityIds: ['class-a'], sourceRefs: [ref()] });
  assert.equal(result.accepted, true);
  assert.equal(result.changed, true);
  assert.equal(result.removed, 2, 'a shared boundary is withdrawn as a whole, without inventing a smaller boundary');
  assert.deepEqual(architecture(model), [untouched]);
  assert.deepEqual(model.snapshot().interpretations.find(value => value.id === otherNamespace.id), otherNamespace);
  assert.deepEqual(model.snapshot({ checkpointId: checkpoint.id }), history);

  assert.equal(model.replaceInterpretations(namespace, [], {
    artifactIds: ['artifact-other'], sourceRefs: [ref('artifact-other')],
  }).removed, 1);
  assert.deepEqual(architecture(model), []);
});

test('scoped replacement can change a role in place and identical answers are idempotent', () => {
  const model = populated(), input = first();
  model.replaceInterpretations(namespace, [input, second()]);
  const original = architecture(model).find(value => value.label === input.label);
  const changed = { ...input, kind: 'datastore', label: 'Data store' };
  const result = model.replaceInterpretations(namespace, [changed], { artifactIds: ['artifact-demo'] });
  assert.equal(result.retained, 1);
  assert.equal(result.removed, 0);
  assert.equal(architecture(model).find(value => value.id === original.id).kind, 'datastore');
  const before = model.snapshot();
  assert.equal(model.replaceInterpretations(namespace, [changed], { artifactIds: ['artifact-demo'] }).changed, false);
  assert.deepEqual(model.snapshot(), before);
  // Returned canonical IDs also remain stable when a caller updates a record.
  const returned = architecture(model).find(value => value.id === original.id);
  assert.equal(model.replaceInterpretations(namespace, [returned], { artifactIds: ['artifact-demo'] }).changed, false);
});

test('explicit empty scope is harmless and an omitted scope replaces only the named namespace', () => {
  const model = populated();
  model.replaceInterpretations(namespace, [first(), second()]);
  model.observeInterpretations([interpretation()]);
  const before = model.snapshot();
  for (const scope of [{ affectedEntityIds: [] }, { artifactIds: [] }]) {
    assert.equal(model.replaceInterpretations(namespace, [], scope).changed, false);
    assert.deepEqual(model.snapshot(), before);
  }
  assert.equal(model.replaceInterpretations(namespace, []).removed, 2);
  assert.equal(model.snapshot().interpretations.length, 1);
});

test('stale positive and empty answers cannot replace a newer current boundary', () => {
  const model = populated();
  model.replaceInterpretations(namespace, [first()]);
  model.observeStructure(structure({ generation: 2 }));
  const current = boundary('first', ['class-a'], [ref('artifact-demo', 2)]);
  model.replaceInterpretations(namespace, [current]);
  const before = model.snapshot(), scope = { artifactIds: ['artifact-demo'] };
  for (const [values, options] of [
    [[first()], scope],
    [[], { ...scope, sourceRefs: [ref()] }],
    [[], { ...scope, sourceRefs: [ref('artifact-other')] }],
    [[{ ...current, sourceRefs: [{ ...ref('artifact-demo', 2), sourceClass: 'public_intent' }] }], scope],
  ]) {
    assert.equal(model.replaceInterpretations(namespace, values, options).accepted, false);
    assert.deepEqual(model.snapshot(), before);
  }
  assert.equal(model.replaceInterpretations(namespace, [], { ...scope, sourceRefs: current.sourceRefs }).removed, 1);
});

test('same-byte extractor identity changes reject interpretations carrying old parser support', () => {
  const model = populated();
  const oldRef = model.snapshot().entities.find(value => value.id === 'class-a').sourceRefs[0];
  model.observeStructure(structure({ identityVersion: 'identity-2' }));
  const newRef = model.snapshot().entities.find(value => value.id === 'class-a').sourceRefs[0];
  model.replaceInterpretations(namespace, [boundary('first', ['class-a'], [newRef])]);
  const before = model.snapshot();
  assert.equal(model.replaceInterpretations(namespace, [boundary('first', ['class-a'], [oldRef])]).accepted, false);
  assert.equal(model.replaceInterpretations(namespace, [], { artifactIds: ['artifact-demo'], sourceRefs: [oldRef] }).accepted, false);
  assert.deepEqual(model.snapshot(), before);
});

test('malformed or out-of-scope batches are rejected before withdrawing any boundary', () => {
  const model = populated();
  model.replaceInterpretations(namespace, [first(), second()]);
  const before = model.snapshot(), options = { artifactIds: ['artifact-demo'] };
  const otherId = architecture(model).find(value => value.label === 'Application second').id;
  for (const values of [
    [null], [{ ...first(), namespace: 'another.namespace' }], [first(), first()],
    [{ ...first(), sourceRefs: [{ ...ref(), hash: 'bad' }] }],
    [{ ...first(), entityIds: ['missing'] }], [second()],
    [{ ...first(), id: otherId }], Array.from({ length: 513 }, () => first()),
  ]) {
    assert.equal(model.replaceInterpretations(namespace, values, options).accepted, false);
    assert.deepEqual(model.snapshot(), before);
  }
  assert.equal(model.replaceInterpretations('invalid namespace', []).accepted, false);
  assert.deepEqual(model.snapshot(), before);
});

test('fresh architecture gets bounded room in a restored model filled by 512 legacy roles', () => {
  const original = populated();
  original.observeLegacy({
    nodes: Array.from({ length: 512 }, (_, index) => ({
      id: `legacy-${index}`, label: `Legacy ${index}`, kind: 'service',
      sourceRefs: [ref()], validity: 'current', classification: 'accepted',
    })), edges: [],
  }, { sessionId: 'synthetic-session', fresh: true });
  assert.equal(original.stats().interpretations, 512);
  const model = create({ restoredState: JSON.parse(JSON.stringify(original.snapshot({ persistent: true }))) });
  model.observeStructure(structure());
  const legacy = model.snapshot().interpretations.filter(value => value.namespace === 'graphlin.legacy-role');
  const checkpoint = model.checkpoint(), history = model.snapshot({ checkpointId: checkpoint.id });
  const result = model.replaceInterpretations(namespace, [first()], { artifactIds: ['artifact-demo'] });
  assert.equal(result.retained, 1);
  assert.equal(result.interpretations, 512);
  assert.equal(result.limits.interpretations, 512);
  assert.equal(model.snapshot().interpretations.some(value => value.id === legacy[0].id), false);
  assert.ok(model.snapshot().interpretations.some(value => value.id === legacy[1].id));
  assert.equal(architecture(model)[0].validity, 'current');
  assert.equal(model.snapshot().coverage.deferred.interpretations, 1);
  assert.equal(model.snapshot().coverage.truncated, true);
  assert.ok(model.stats().bytes <= model.stats().limits.bytes);
  assert.deepEqual(model.snapshot({ checkpointId: checkpoint.id }), history);
});

test('capacity pressure never evicts unrelated boundaries or lets legacy roles displace architecture', () => {
  const model = populated({ limits: { interpretations: 3 } });
  model.observeInterpretations([
    interpretation(),
    interpretation({ id: 'legacy', namespace: 'graphlin.legacy-role' }),
  ]);
  model.replaceInterpretations(namespace, [second()], { artifactIds: ['artifact-other'] });
  const untouched = architecture(model)[0];
  model.replaceInterpretations(namespace, [first()], { artifactIds: ['artifact-demo'] });
  assert.equal(model.stats().interpretations, 3);
  assert.deepEqual(architecture(model).find(value => value.id === untouched.id), untouched);
  assert.equal(model.snapshot().interpretations.filter(value => value.namespace === 'graphlin.legacy-role').length, 0);
  model.observeInterpretations([interpretation({ id: 'another-legacy', namespace: 'graphlin.legacy-role' })]);
  assert.equal(architecture(model).length, 2);
  const result = model.replaceInterpretations(namespace, [boundary('extra')], { affectedEntityIds: ['class-b'] });
  assert.equal(result.accepted, false, 'an unrelated scope cannot clear existing architecture to make room');
  assert.equal(architecture(model).length, 2);
});

test('architecture also reclaims legacy room at the byte cap without increasing the budget', () => {
  const legacy = ['one', 'two'].map(id => interpretation({ id, namespace: 'graphlin.legacy-role' }));
  const probe = populated();
  probe.observeInterpretations(legacy);
  const byteLimit = probe.stats().bytes + 100;
  const model = populated({ limits: { bytes: byteLimit } });
  model.observeInterpretations(legacy);
  assert.equal(model.stats().interpretations, 2);
  const result = model.replaceInterpretations(namespace, [{
    ...first(), label: 'Application boundary '.repeat(8).trim(),
    sourceRefs: Array.from({ length: 3 }, (_, index) => ({ ...ref(), startLine: index + 2, endLine: index + 2 })),
  }], { artifactIds: ['artifact-demo'] });
  assert.equal(result.retained, 1);
  assert.ok(model.snapshot().coverage.deferred.interpretations > 0);
  assert.ok(model.stats().bytes <= byteLimit);
  assert.equal(model.stats().limits.bytes, byteLimit);
});

test('architecture persistence preserves frozen boundaries while live restore and deletion require fresh support', () => {
  const activePolicy = policy(), model = populated({ policy: activePolicy });
  model.replaceInterpretations(namespace, [first(), second()]);
  const checkpoint = model.checkpoint(), frozen = model.snapshot({ checkpointId: checkpoint.id });
  model.replaceInterpretations(namespace, [], { artifactIds: ['artifact-demo'] });
  const restored = create({
    policy: activePolicy, restoredState: JSON.parse(JSON.stringify(model.snapshot({ persistent: true }))),
  });
  assert.equal(architecture(restored)[0].validity, 'stale');
  assert.deepEqual(restored.snapshot({ checkpointId: checkpoint.id }), frozen);
  assert.equal(restored.replaceInterpretations(namespace, [second()], { artifactIds: ['artifact-other'] }).accepted, false);
  model.invalidateArtifacts([{ id: 'artifact-other', generation: 2, status: 'missing', complete: true }]);
  assert.equal(architecture(model)[0].validity, 'retracted');
  assert.equal(model.replaceInterpretations(namespace, [second()]).accepted, false);

  activePolicy.readSource = false;
  const before = model.snapshot();
  assert.equal(model.replaceInterpretations(namespace, []).accepted, false);
  assert.deepEqual(model.snapshot(), before);
  assert.equal(JSON.stringify(restored.snapshot({ checkpointId: checkpoint.id })).includes('Application first'), false);
  assert.equal(restored.snapshot({ checkpointId: checkpoint.id }).interpretations[0].validity, 'current');
});

test('ordered architecture membership persists as an interpretation without changing source containment', () => {
  const model = populated();
  const parents = model.snapshot().entities.map(value => [value.id, value.parentId]);
  const membership = {
    ...boundary('membership', ['class-a', 'other-class'], [ref(), ref('artifact-other')]),
    kind: 'architecture_membership',
  };
  const result = model.replaceInterpretations(namespace, [first(), { ...second(), kind: 'component' }, membership], {
    artifactIds: ['artifact-demo', 'artifact-other'], sourceRefs: membership.sourceRefs,
  });
  assert.equal(result.retained, 3);
  const record = architecture(model).find(value => value.kind === 'architecture_membership');
  assert.deepEqual(record.entityIds, ['class-a', 'other-class']);
  assert.equal(record.sourceRefs.length, 2);
  assert.deepEqual(model.snapshot().entities.map(value => [value.id, value.parentId]), parents);
  const checkpoint = model.checkpoint(), history = model.snapshot({ checkpointId: checkpoint.id });
  const restored = create({ restoredState: JSON.parse(JSON.stringify(model.snapshot({ persistent: true }))) });
  assert.deepEqual(restored.snapshot({ checkpointId: checkpoint.id }), history);
  assert.deepEqual(architecture(restored).find(value => value.kind === 'architecture_membership').entityIds, record.entityIds);
});

test('batch guards cover 64 to 256 artifacts while each stored interpretation remains limited to 16 refs', () => {
  const model = create(), refs = [];
  model.observeInventory({ entries: Array.from({ length: 256 }, (_, index) => file(`src/unit-${index}.js`)) });
  for (let index = 0; index < 256; index++) {
    model.observeStructure(structure({
      artifactId: `artifact-${index}`, relativePath: `src/unit-${index}.js`, scopeId: `module-${index}`, symbols: [],
    }));
    refs.push(ref(`artifact-${index}`));
  }
  const records = [
    boundary('application', ['module-0'], [refs[0]]),
    { ...boundary('component', ['module-1'], [refs[1]]), kind: 'component' },
    { ...boundary('membership', ['module-0', 'module-1'], refs.slice(0, 2)), kind: 'architecture_membership' },
  ];
  for (const count of [64, 256]) {
    const guards = refs.slice(0, count);
    const result = model.replaceInterpretations(namespace, records, {
      artifactIds: guards.map(value => value.artifactId), sourceRefs: guards,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.retained, 3);
    assert.ok(architecture(model).every(value => value.sourceRefs.length <= 16));
  }
  const before = model.snapshot();
  for (const [values, guards] of [
    [[{ ...records[2], sourceRefs: refs.slice(0, 17) }], refs],
    [[], [...refs.slice(0, 64), ref('artifact-0', 2)]],
    [[], Array.from({ length: 257 }, () => refs[0])],
  ]) {
    assert.equal(model.replaceInterpretations(namespace, values, { sourceRefs: guards }).accepted, false);
    assert.deepEqual(model.snapshot(), before);
  }
});

test('confirmed deletion can clear stale boundaries without present refs while history and other boundaries survive', () => {
  const model = populated();
  const membership = {
    ...boundary('membership', ['class-a', 'other-class'], [ref(), ref('artifact-other')]),
    kind: 'architecture_membership',
  };
  model.replaceInterpretations(namespace, [first(), second(), membership]);
  const checkpoint = model.checkpoint(), history = model.snapshot({ checkpointId: checkpoint.id });
  model.invalidateArtifacts([{ id: 'artifact-demo', generation: 2, status: 'unavailable' }]);
  assert.equal(architecture(model).find(value => value.label === first().label).validity, 'stale');
  model.invalidateArtifacts([{ id: 'artifact-demo', generation: 3, status: 'missing', complete: true }]);
  // The coordinator performs its missing-version and epoch checks before this
  // synchronous clear. A missing file has no present-source hash to validate.
  const result = model.replaceInterpretations(namespace, [], { artifactIds: ['artifact-demo'] });
  assert.equal(result.accepted, true);
  assert.equal(result.removed, 2);
  assert.equal(architecture(model).length, 1);
  assert.equal(architecture(model)[0].label, second().label);
  assert.equal(architecture(model)[0].validity, 'current');
  assert.deepEqual(model.snapshot({ checkpointId: checkpoint.id }), history);

  model.observeStructure(structure({ generation: 4 }));
  model.replaceInterpretations(namespace, [boundary('first', ['class-a'], [ref('artifact-demo', 4)])], {
    artifactIds: ['artifact-demo'], sourceRefs: [ref('artifact-demo', 4)],
  });
  const current = model.snapshot();
  assert.equal(model.replaceInterpretations(namespace, [], {
    artifactIds: ['artifact-demo'], sourceRefs: [ref()],
  }).accepted, false, 'late present-source results cannot erase the recreated boundary');
  assert.deepEqual(model.snapshot(), current);
});
