import test from 'node:test';
import assert from 'node:assert/strict';
import { c4Scene } from '../../runtime/visualizers/c4.mjs';
import { validateScene } from '../../runtime/extensions/scene.mjs';
import { layoutScene } from '../../runtime/web/scene.js';
import { model, entity, ref } from './model-fixtures.mjs';

const boundary = (id, kind, entityIds, extra = {}) => ({
  id, kind, label: id, namespace: 'graphlin.architecture', entityIds,
  sourceRefs: [ref()], validity: 'current', classification: 'accepted', support: 'supported', ...extra,
});
const pair = (entityIds = ['store', 'api'], extra = {}) => boundary('membership', 'architecture_membership', entityIds, extra);
const fixture = (extra = []) => model({ interpretations: [
  boundary('application', 'application', ['api']), boundary('component', 'component', ['store']),
  pair(), ...extra,
] });

test('source-backed anchor pairs show expanded applications and nested components without copying model memberships', () => {
  const input = fixture(), before = structuredClone(input);
  const scene = validateScene(c4Scene(input), { model: input });
  const application = scene.groups.find(group => group.id === 'c4.application');
  const component = scene.groups.find(group => group.id === 'c4.component');
  assert.equal(application.collapsed, false);
  assert.equal(component.parentId, application.id);
  assert.equal(component.collapsed, true);
  assert.deepEqual(component.entityIds, ['store', 'save']);
  assert.ok(scene.nodes.some(node => node.entityId === 'run' && node.parentId === application.id));
  assert.deepEqual(input, before, 'display containment does not mutate canonical evidence');
  const expanded = validateScene(c4Scene(input, { expanded: ['c4.component'] }), { model: input });
  assert.ok(expanded.nodes.some(node => node.entityId === 'save' && node.parentId === component.id));
  const packed = layoutScene(expanded);
  const parent = packed.groups.find(group => group.id === application.id);
  const child = packed.groups.find(group => group.id === component.id);
  assert.ok(child.x >= parent.x + 28 && child.y >= parent.y + 64);
  assert.ok(child.x + child.width <= parent.x + parent.width - 28);
  const collapsed = c4Scene(input, { collapsed: ['c4.application'], expanded: ['c4.component'] });
  assert.equal(collapsed.groups.some(group => group.id === component.id), false);
  assert.equal(collapsed.nodes.length, 0);
});

test('expanded current components exclude retracted methods and preserve descendant freshness', () => {
  const input = fixture();
  input.entities.push(
    entity('stale-method', 'store', { kind: 'method', validity: 'stale' }),
    entity('retracted-method', 'store', { kind: 'method', validity: 'retracted' }),
    entity('tentative-method', 'store', { kind: 'method', classification: 'tentative' }),
  );
  const scene = validateScene(c4Scene(input, { expanded: ['c4.component'] }), { model: input });
  const child = id => scene.nodes.find(node => node.entityId === id);
  assert.equal(child('retracted-method'), undefined);
  assert.equal(child('stale-method').parentId, 'c4.component');
  assert.equal(child('stale-method').style, 'stale');
  assert.equal(child('tentative-method').style, 'tentative');
  assert.equal(child('save').style, 'default');
});

test('anchor nesting rejects missing, stale, duplicate, conflicting, and unsupported membership evidence', () => {
  const invalid = [
    [],
    [pair(['api', 'api'])],
    [pair(['api', 'missing'])],
    [pair(['api', 'store'], { validity: 'stale' })],
    [pair(['api', 'store'], { classification: 'tentative' })],
    [pair(['api', 'store'], { support: 'unknown' })],
    [pair(['api', 'store'], { sourceRefs: [] })],
    [pair(['api', 'store'], { namespace: 'other.extension' })],
    [pair(), boundary('duplicate-app', 'application', ['api'])],
    [pair(), boundary('other-app', 'application', ['run']), pair(['run', 'store'], { id: 'conflicting-pair' })],
  ];
  for (const records of invalid) {
    const input = fixture();
    input.interpretations = input.interpretations.slice(0, 2).concat(records);
    const scene = validateScene(c4Scene(input, { level: 'components' }), { model: input });
    assert.equal(scene.groups.find(group => group.id === 'c4.component').parentId, undefined);
  }
  const stale = fixture();
  stale.entities.find(value => value.id === 'api').validity = 'stale';
  assert.equal(c4Scene(stale, { level: 'components' }).groups.find(group => group.id === 'c4.component').parentId, undefined);
});

test('other interpretations nest only with one strict superset and preserve unambiguous old expansion keys', () => {
  const input = model({ interpretations: [
    boundary('application', 'application', ['api', 'run', 'store', 'save'], { namespace: 'example.boundaries' }),
    boundary('component', 'component', ['store', 'save'], { namespace: 'example.boundaries' }),
  ] });
  let scene = c4Scene(input, { level: 'components', expanded: ['store'] });
  assert.equal(scene.groups.find(group => group.id === 'c4.component').parentId, 'c4.application');
  assert.equal(scene.groups.find(group => group.id === 'c4.component').collapsed, false);
  input.interpretations.push(boundary('other-app', 'application', ['api', 'store', 'save'], { namespace: 'example.boundaries' }));
  scene = c4Scene(input, { level: 'components' });
  assert.equal(scene.groups.find(group => group.id === 'c4.component').parentId, undefined);
  input.interpretations = input.interpretations.slice(0, 2);
  input.interpretations[0].entityIds = ['store', 'save'];
  assert.equal(c4Scene(input, { level: 'components' }).groups.find(group => group.id === 'c4.component').parentId, undefined);
});

test('large parsed component subtrees stay bounded and report display truncation', () => {
  const input = fixture();
  input.entities.push(...Array.from({ length: 4500 }, (_, index) =>
    entity(`member.${index}`, 'store', { kind: 'function' })));
  const scene = validateScene(c4Scene(input, { expanded: ['c4.component'] }), { model: input });
  assert.ok(scene.groups.every(group => group.entityIds.length <= 256));
  assert.ok(scene.groups.length + scene.nodes.length <= 256);
  assert.equal(scene.coverage.truncated, true);
  assert.deepEqual(input.interpretations[0].entityIds, ['api']);
  assert.deepEqual(input.interpretations[1].entityIds, ['store']);
});
