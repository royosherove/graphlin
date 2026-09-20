import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_VIEWS, createBuiltin } from '../../runtime/visualizers/index.mjs';
import { structureScene } from '../../runtime/visualizers/structure.mjs';
import { c4Scene } from '../../runtime/visualizers/c4.mjs';
import { changesScene } from '../../runtime/visualizers/changes.mjs';
import { timelineRows } from '../../runtime/visualizers/timeline.mjs';
import { validateScene } from '../../runtime/extensions/scene.mjs';
import { layoutScene, filterScene, representedSelection } from '../../runtime/web/scene.js';
import { createDocument } from './fake-dom.mjs';
import { model, entity, ref, relation } from './model-fixtures.mjs';

test('every built-in uses update/dispose and passes the shared scene validator', () => {
  const document = createDocument('');
  for (const view of BUILTIN_VIEWS) {
    const root = document.createElement('section');
    const instance = createBuiltin(view.id, { root });
    const input = model();
    const result = instance.update({ model: input, settings: {} });
    if (result.kind === 'scene') assert.deepEqual(validateScene(result.scene, { model: input }), result.scene);
    else { assert.equal(result.kind, 'custom'); assert.match(root.textContent, /No observations/); }
    instance.dispose();
    assert.throws(() => instance.update({ model: input }), /disposed/);
  }
});

test('collapsed boundaries aggregate only matching directed relation types, preserving supporting IDs', () => {
  const input = model({ relations: [
    relation('first', 'run', 'save'), relation('second', 'run', 'save'),
    relation('write', 'run', 'save', 'writes'), relation('internal', 'api', 'run'),
  ] });
  const scene = validateScene(structureScene(input), { model: input });
  assert.deepEqual(scene.groups.map(group => [group.id, group.parentId, group.collapsed]),
    [['root', undefined, false], ['api', 'root', true], ['store', 'root', true]]);
  assert.equal(scene.edges.length, 2);
  assert.deepEqual(scene.edges[0].relationIds, ['first', 'second']);
  assert.equal(scene.edges[0].count, 2);
  assert.equal(scene.edges[1].kind, 'writes');
  assert.equal(scene.edges.some(edge => edge.source === edge.target), false);
  assert.equal(representedSelection('run', scene, input), 'api');
});

test('search and source type filters retain ancestor frames and reveal lexical children', () => {
  const input = model();
  const scene = structureScene(input, { query: 'save', kinds: ['method'] });
  assert.deepEqual(scene.nodes.map(node => node.entityId), ['save']);
  assert.deepEqual(scene.groups.map(group => group.id), ['root', 'store']);
  const filtered = filterScene(structureScene(input, { depth: 4 }),
    { query: 'save', kinds: new Set(['method']) }, input);
  assert.deepEqual(filtered.nodes.map(node => node.entityId), ['save']);
  assert.equal(filtered.groups.some(group => group.id === 'root'), true);
  assert.equal(filterScene(scene, { kinds: new Set() }, input).nodes.length, 0);
});

test('nested geometry contains children with a title band and disjoint sibling frames', () => {
  const scene = layoutScene(structureScene(model(), { depth: 4 }));
  const items = new Map([...scene.groups, ...scene.nodes].map(item => [item.id, item]));
  for (const child of items.values()) {
    if (!child.parentId) continue;
    const parent = items.get(child.parentId);
    assert.ok(child.x >= parent.x + 28);
    assert.ok(child.y >= parent.y + 64);
    assert.ok(child.x + child.width <= parent.x + parent.width - 28);
    assert.ok(child.y + child.height <= parent.y + parent.height - 28);
  }
  const api = items.get('api'), store = items.get('store');
  assert.ok(api.x + api.width < store.x || api.y + api.height < store.y);
});

test('C4 abstains without current supported interpretations at the chosen abstraction level', () => {
  const input = model();
  assert.match(c4Scene(input).coverage.label, /unknown/);
  assert.equal(c4Scene(input).groups.some(group => group.kind === 'service'), false);
  input.interpretations.push({ id: 'boundary', kind: 'application', label: 'Gateway',
    entityIds: ['api', 'run'], validity: 'current', classification: 'accepted',
    support: 'supported', sourceRefs: [ref()] });
  const scene = validateScene(c4Scene(input, { level: 'applications' }), { model: input });
  assert.equal(scene.groups[0].label, 'Gateway');
  assert.equal(scene.groups[0].membershipId, 'boundary');
  assert.ok(scene.groups.some(group => group.label === 'Responsibility unknown'));
  assert.match(c4Scene(input, { level: 'context' }).coverage.label, /unknown/);
  input.interpretations[0].validity = 'stale';
  assert.match(c4Scene(input).coverage.label, /unknown/);
});

test('task changes distinguish discovery from evidence-backed creation and never delete evicted records', () => {
  const baseline = model();
  const current = model({ sequence: 3, revision: 3,
    entities: [entity('newly-seen'), ...baseline.entities.filter(value => value.id !== 'store')] });
  assert.match(changesScene(current, {}, baseline).coverage.label, /1 discovered, 0 created.*0 removed/);
  current.entities[0].createdAtSequence = 2;
  assert.match(changesScene(current, {}, baseline).coverage.label, /0 discovered, 1 created/);
  assert.match(changesScene(current).coverage.label, /Choose.*baseline/);
});

test('scene budget limits rendering without preventing requested scope from being reached', () => {
  const input = model({ entities: Array.from({ length: 1000 }, (_, index) => entity(`root.${index}`)), relations: [] });
  const scene = structureScene(input);
  assert.equal(scene.nodes.length, 256);
  assert.equal(scene.coverage.truncated, true);
  assert.equal(scene.coverage.total, 1000);
  assert.deepEqual(structureScene(input, { scope: 'root.999' }).nodes.map(node => node.id), ['root.999']);
});

test('activity-only custom timeline preserves parallel attempts and unresolved outcomes, with keyboard buttons', async () => {
  const document = createDocument(''), root = document.createElement('section'), selected = [];
  const input = model({ entities: [], relations: [], sequence: 4, activity: [
    { id: 'a', sequence: 1, at: '2026-01-01T00:00:00Z', kind: 'tool.requested', toolCategory: 'test',
      agentId: 'agent.a', toolCallId: 'one', outcome: 'pending', attribution: 'observed', entityIds: [] },
    { id: 'b', sequence: 2, at: '2026-01-01T00:00:00Z', kind: 'tool.requested', toolCategory: 'read',
      agentId: 'agent.b', toolCallId: 'two', outcome: 'pending', attribution: 'observed', entityIds: [] },
    { id: 'c', sequence: 3, at: '2026-01-01T00:00:01Z', kind: 'tool.finished', toolCategory: 'test',
      agentId: 'agent.a', toolCallId: 'one', outcome: 'failed', attribution: 'correlated', entityIds: [] },
  ] });
  assert.deepEqual(timelineRows(input).map(row => row.outcome), ['failed', 'unresolved', 'failed']);
  const instance = createBuiltin('graphlin.timeline', { root, select: value => selected.push(value) });
  const result = instance.update({ model: input, settings: {} });
  assert.equal(result.itemCount, 3);
  assert.match(root.textContent, /agent.a/);
  assert.match(root.textContent, /agent.b/);
  await root.querySelector('button').fire('click');
  assert.equal(selected[0].activityId, 'a');
  instance.dispose(); assert.equal(root.childElementCount, 0);
});
