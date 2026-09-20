import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { compareCheckpoint } from '../../runtime/model/changes.mjs';
import { c4Scene } from '../../runtime/visualizers/c4.mjs';
import { structure, file, interpretation, ref } from './fixtures.mjs';

const create = options => createProjectModel({ projectId: 'synthetic-project', policy: { readSource: true }, now: () => 100, ...options });

test('checkpoints replay recorded interpretations with no future source or activity leaks', () => {
  const model = create();
  model.observeStructure(structure());
  model.recordActivity({ id: 'attempt', kind: 'tool.requested', sessionId: 'one', at: 5 });
  const baseline = model.checkpoint({ label: 'Task start', sessionId: 'one' });
  const frozen = model.snapshot({ checkpointId: baseline.id });
  model.observeInterpretations([interpretation()]);
  model.recordActivity({ id: 'late', kind: 'tool.succeeded', sessionId: 'two', at: 1 });
  model.observeStructure(structure({ generation: 2 }));
  assert.deepEqual(model.snapshot({ checkpointId: baseline.id }), frozen);
  assert.equal(frozen.interpretations.length, 0);
  assert.equal(frozen.activity.some(value => value.id === 'late'), false);
  assert.ok(model.snapshot().activity.find(value => value.id === 'late').knownAtSequence > baseline.sequence);
});

test('activity advances journal sequence without pretending the architecture changed', () => {
  const model = create();
  const before = model.stats();
  model.recordActivity({ kind: 'tool.requested', toolCallId: 'call', at: 5, outcome: 'pending' });
  model.recordActivity({ kind: 'tool.succeeded', toolCallId: 'call', at: 8, outcome: 'succeeded' });
  const after = model.stats();
  assert.equal(before.revision, after.revision);
  assert.equal(after.sequence, before.sequence + 2);
  assert.equal(model.snapshot().activity.length, 2);
  assert.equal(model.snapshot().activity[0].outcome, 'pending');
});

test('a retained baseline survives activity journal trimming and marks expired checkpoints explicitly', () => {
  const model = create({ limits: { activity: 2, checkpoints: 2 } });
  model.observeStructure(structure());
  const baseline = model.checkpoint();
  for (let i = 0; i < 20; i++) model.recordActivity({ kind: 'tool.requested', id: `event-${i}` });
  model.observeStructure(structure({ generation: 2, symbols: [] }));
  assert.equal(model.snapshot().activity.length, 2);
  assert.equal(model.changes(baseline.id).removals.length, 4);
  model.checkpoint();
  model.checkpoint();
  assert.throws(() => model.snapshot({ checkpointId: baseline.id }), /MODEL_CHECKPOINT_UNAVAILABLE/);
  assert.throws(() => model.changes(baseline.id), /MODEL_CHECKPOINT_UNAVAILABLE/);
});

test('session filtering changes activity focus without removing project structure', () => {
  const model = create();
  model.observeStructure(structure());
  model.setSessions([{ id: 'one', host: 'claude' }, { id: 'two', host: 'codex' }]);
  model.recordActivity({ kind: 'tool.requested', sessionId: 'one' });
  model.recordActivity({ kind: 'tool.succeeded', sessionId: 'two' });
  const one = model.snapshot({ sessionId: 'one' });
  assert.equal(one.entities.length, model.snapshot().entities.length);
  assert.equal(one.sessions.length, 1);
  assert.ok(one.activity.every(value => value.sessionId === 'one'));
  assert.equal(model.snapshot().sessions.length, 2);
});

test('snapshots and returned markers are safe independent clones', () => {
  const model = create();
  model.observeStructure(structure());
  const snapshot = model.snapshot();
  snapshot.entities[1].label = 'mutated';
  snapshot.coverage.enumerations[0].complete = false;
  const marker = model.checkpoint();
  const markerId = marker.id;
  marker.id = 'changed';
  assert.notEqual(model.snapshot().entities[1].label, 'mutated');
  assert.equal(model.snapshot().coverage.enumerations[0].complete, true);
  assert.ok(model.snapshot({ checkpointId: markerId }));
});

test('current policy applies to live snapshots, changes, and historical snapshots', () => {
  let policy = { readSource: true, persistEvidence: true };
  const model = create({ policy: () => policy });
  model.observeInventory({ entries: [file('src/demo.js')] });
  model.observeStructure(structure());
  const baseline = model.checkpoint({ label: 'Sensitive task name' });
  model.observeInterpretations([interpretation()]);
  model.observeStructure(structure({ generation: 2 }));
  assert.ok(JSON.stringify(model.snapshot()).includes('Alpha'));
  policy = {};
  for (const value of [model.snapshot(), model.snapshot({ checkpointId: baseline.id }), model.changes(baseline.id)]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('Alpha'), false);
    assert.equal(serialized.includes('Sensitive task name'), false);
    assert.equal(serialized.includes('Request handling'), false);
  }
  assert.ok(model.snapshot().entities.some(value => value.label === 'demo.js'));
});

test('persistence strips source labels unless granted and always strips raw excerpts and extra fields', () => {
  for (const persistEvidence of [false, true]) {
    const model = create({ policy: { readSource: true, persistEvidence } });
    const input = structure();
    input.entities[1].text = 'raw_synthetic_source';
    input.entities[1].excerpt = 'raw_synthetic_excerpt';
    input.entities[1].shape = 'cylinder';
    model.observeStructure(input);
    model.recordActivity({
      kind: 'tool.succeeded', prompt: 'raw_synthetic_prompt', transcript: 'raw_synthetic_transcript',
      sourceRefs: [{ ...ref(), excerpt: 'raw_synthetic_excerpt' }],
    });
    model.checkpoint({ label: 'Baseline' });
    const saved = JSON.stringify(model.snapshot({ persistent: true }));
    assert.equal(saved.includes('Alpha'), persistEvidence);
    assert.equal(saved.includes('raw_synthetic'), false);
    assert.equal(saved.includes('cylinder'), false);
    assert.equal(saved.includes('excerpt'), false);
  }
});

test('live restored evidence is stale while checkpoint evidence keeps its recorded validity', () => {
  const policy = { readSource: true, persistEvidence: true };
  const model = create({ policy });
  model.observeInventory({ entries: [file('src/demo.js')] });
  model.observeStructure(structure());
  model.observeInterpretations([interpretation()]);
  const marker = model.checkpoint();
  const restored = create({ policy, restoredState: model.snapshot({ persistent: true }) });
  const before = restored.snapshot();
  assert.equal(before.entities.find(value => value.id === 'class-a').validity, 'stale');
  assert.equal(before.interpretations[0].validity, 'stale');
  const history = restored.snapshot({ checkpointId: marker.id });
  assert.equal(history.entities.find(value => value.id === 'class-a').validity, 'current');
  assert.equal(history.interpretations[0].validity, 'current');
  assert.equal(history.interpretations[0].classification, 'accepted');
  restored.observeStructure(structure());
  assert.equal(restored.snapshot().entities.find(value => value.id === 'class-a').validity, 'current');
  assert.equal(restored.snapshot().interpretations[0].validity, 'stale');
  assert.deepEqual(restored.snapshot({ checkpointId: marker.id }), history);
});

test('frozen checkpoint C4 representation and diffs survive a JSON roundtrip exactly', () => {
  const policy = { readSource: true, persistEvidence: true };
  const model = create({ policy });
  model.observeInventory({ entries: [file('src/demo.js')], coverage: { complete: true } });
  model.setSessions([{ id: 'task', host: 'codex', status: 'ended', startedAt: 1, endedAt: 2 }]);
  model.observeStructure(structure());
  model.observeInterpretations([interpretation({ kind: 'application' })]);
  const first = model.checkpoint({ label: 'Before', sessionId: 'task' });
  model.observeStructure(structure({ generation: 2 }));
  model.observeInterpretations([interpretation({ kind: 'application', sourceRefs: [ref('artifact-demo', 2)] })]);
  const second = model.checkpoint({ label: 'After' });
  const before = model.snapshot({ checkpointId: first.id }), after = model.snapshot({ checkpointId: second.id });
  const diff = compareCheckpoint(before, after, first.id);
  assert.ok(c4Scene(before).groups.some(value => value.label === 'Request handling'));
  assert.equal(diff.modifications.length, 5);
  const restored = create({ policy, restoredState: JSON.parse(JSON.stringify(model.snapshot({ persistent: true }))) });
  const restoredBefore = restored.snapshot({ checkpointId: first.id }), restoredAfter = restored.snapshot({ checkpointId: second.id });
  assert.deepEqual(restoredBefore, before);
  assert.deepEqual(restoredAfter, after);
  assert.deepEqual(c4Scene(restoredBefore), c4Scene(before));
  assert.deepEqual(c4Scene(restoredAfter), c4Scene(after));
  assert.deepEqual(compareCheckpoint(restoredBefore, restoredAfter, first.id), diff);
  assert.equal(restored.snapshot().interpretations[0].validity, 'stale');

  policy.readSource = false;
  const redacted = restored.snapshot({ checkpointId: first.id });
  assert.doesNotMatch(JSON.stringify(redacted), /Alpha|Request handling/);
  assert.equal(redacted.interpretations[0].validity, 'current');
  assert.equal(redacted.interpretations[0].classification, 'accepted');
  assert.equal(redacted.sequence, first.sequence);
});

test('frozen history is validated and allowlisted without importing nested states', () => {
  const policy = { readSource: true, persistEvidence: true };
  const model = create({ policy });
  model.observeInventory({ entries: [file('src/demo.js')] });
  model.observeStructure(structure());
  const marker = model.checkpoint();
  const state = model.snapshot({ persistent: true });
  const saved = state.checkpoints[0].state;
  saved.entities[1].excerpt = 'RAW_SYNTHETIC_EXTRA';
  saved.coverage.scopes[0].credentials = 'RAW_SYNTHETIC_EXTRA';
  saved.coverage.artifacts[0].text = 'RAW_SYNTHETIC_EXTRA';
  saved.checkpoints[0].state = { transcript: 'RAW_SYNTHETIC_EXTRA' };
  saved.sessions.push({ id: 'session', startedAt: 'Jan 1 2020 (RAW_SYNTHETIC_EXTRA)' });
  const restored = create({ policy, restoredState: state });
  assert.doesNotMatch(JSON.stringify(restored.snapshot({ persistent: true })), /RAW_SYNTHETIC_EXTRA/);
  assert.equal(restored.snapshot({ checkpointId: marker.id }).entities.find(value => value.id === 'class-a').validity, 'current');

  for (const corrupt of [
    saved => { saved.entities.find(value => value.id === 'class-a').parentId = 'method-a'; },
    saved => { saved.entities.find(value => value.id === 'class-a').knownAtSequence = saved.sequence + 1; },
    saved => { saved.activity[0].sequence = saved.sequence + 1; },
  ]) {
    const malformed = structuredClone(state);
    corrupt(malformed.checkpoints[0].state);
    const rejected = create({ policy, restoredState: malformed });
    assert.throws(() => rejected.snapshot({ checkpointId: marker.id }), /MODEL_CHECKPOINT_UNAVAILABLE/);
    assert.ok(rejected.snapshot().entities.length > 0);
  }
});

test('inventory accepts only safe relative metadata and never exposes absolute locators', () => {
  const model = create({ policy: {} });
  model.observeInventory({ entries: [
    file('/Users/example/private/demo.js'), file('../escape.js'), file('C:\\private\\demo.js'),
    file('.env'), file('src/.env.local'), file('src/demo.js'),
  ] });
  const serialized = JSON.stringify(model.snapshot());
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('escape.js'), false);
  assert.equal(serialized.includes('.env'), false);
  assert.ok(serialized.includes('src/demo.js'));
});

test('restore rejects another project and sanitizes hostile extra fields', () => {
  assert.throws(() => create({ restoredState: { schemaVersion: 2, projectId: 'another' } }), /MODEL_PROJECT_MISMATCH/);
  const model = create();
  model.observeStructure(structure());
  const state = model.snapshot({ persistent: true });
  state.entities[1].excerpt = 'raw_private_text';
  state.coverage.credentials = 'raw_private_text';
  state.sessions.push({ id: 'session', label: 'raw_private_text', transcript: 'raw_private_text' });
  const restored = create({ restoredState: state });
  assert.equal(JSON.stringify(restored.snapshot()).includes('raw_private_text'), false);
});

test('tightened path exclusions also redact descendant and historical source labels', () => {
  const policy = { readSource: true, persistEvidence: true };
  const model = create({ policy });
  model.observeInventory({ entries: [file('src/demo.js')] });
  model.observeStructure(structure());
  model.observeInterpretations([interpretation()]);
  const baseline = model.checkpoint();
  policy.excludePaths = ['src/**'];
  for (const value of [model.snapshot(), model.snapshot({ persistent: true }), model.snapshot({ checkpointId: baseline.id })]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('Alpha'), false);
    assert.equal(serialized.includes('Request handling'), false);
    assert.equal(serialized.includes('src/demo.js'), false);
  }
});
