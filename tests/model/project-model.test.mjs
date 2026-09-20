import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { extractStructure } from '../../runtime/discovery/index.mjs';
import { hash, opaque } from '../../runtime/core/common.mjs';
import { compareCheckpoint } from '../../runtime/model/changes.mjs';
import { structure, file, ref, sourceHash, interpretation } from './fixtures.mjs';

const create = options => createProjectModel({ projectId: 'synthetic-project', policy: { readSource: true }, now: () => 10, ...options });
const entity = (model, entityId) => model.snapshot().entities.find(value => value.id === entityId);

test('no-docs inventory supplies metadata roots and modules independently of scene size', () => {
  const model = create({ policy: {} });
  model.observeInventory({ entries: Array.from({ length: 800 }, (_, i) => file(`${i % 2 ? 'gateway' : 'web'}/file${i}.js`)), coverage: { complete: true } });
  const snapshot = model.snapshot();
  assert.equal(snapshot.schemaVersion, 2);
  assert.ok(snapshot.entities.length > 256);
  assert.ok(snapshot.entities.some(value => value.kind === 'directory' && value.label === 'gateway'));
  assert.ok(snapshot.entities.some(value => value.kind === 'directory' && value.label === 'web'));
  assert.ok(snapshot.entities.every(value => value.classification === 'unknown'));
  assert.ok(snapshot.entities.every(value => !('shape' in value) && !('x' in value)));
});

test('nested same-name methods retain parser identities and validated lexical ownership', () => {
  const model = create();
  model.observeInventory({ entries: [file('src/demo.js')] });
  model.observeStructure(structure());
  assert.equal(entity(model, 'method-a').parentId, 'class-a');
  assert.equal(entity(model, 'method-b').parentId, 'class-b');
  assert.equal(entity(model, 'method-a').label, 'run');
  assert.equal(entity(model, 'method-b').label, 'run');
  assert.equal(entity(model, 'module-demo').parentId, model.snapshot().entities.find(value => value.label === 'src').id);
  assert.equal(model.snapshot().coverage.enumerations[0].complete, true);
  assert.equal(entity(model, 'method-a').basis, 'parsed');
});

test('source parsing requires local permission, with transmitSource implying local permission', () => {
  const metadata = create({ policy: {} });
  metadata.observeStructure(structure());
  assert.equal(entity(metadata, 'class-a'), undefined);
  const local = create({ policy: { readSource: true, transmitSource: false } });
  local.observeStructure(structure());
  assert.equal(entity(local, 'class-a').label, 'Alpha');
  const remote = create({ policy: { transmitSource: true } });
  remote.observeStructure(structure());
  assert.equal(entity(remote, 'class-a').label, 'Alpha');
});

test('pre-tool intent is never accepted as parsed source support', () => {
  const model = create();
  model.observeStructure(structure(), { event: { kind: 'tool.requested' } });
  assert.equal(entity(model, 'class-a'), undefined);
});

test('partial omissions stale symbols; a later complete enumeration retracts them', () => {
  const model = create();
  model.observeStructure(structure());
  model.observeStructure(structure({ symbols: [], generation: 2, complete: false }));
  assert.equal(entity(model, 'method-a').validity, 'stale');
  model.observeStructure(structure({ symbols: [], generation: 2 }));
  assert.equal(entity(model, 'method-a').validity, 'retracted');
});

test('extractor and identity upgrades reconcile old symbols without false deletion', () => {
  for (const upgrade of [{ version: 'parser-2' }, { identityVersion: 'identity-2' }]) {
    const model = create();
    model.observeStructure(structure());
    const baseline = model.checkpoint();
    model.observeStructure(structure({ ...upgrade, symbols: [] }));
    model.observeStructure(structure({ ...upgrade, symbols: [] }));
    assert.equal(entity(model, 'method-a').validity, 'stale');
    assert.deepEqual(model.changes(baseline.id).removals, []);
  }
});

test('late parsing cannot revive changed, missing, or unavailable artifact versions', () => {
  const model = create();
  model.observeStructure(structure());
  model.invalidateArtifacts([{ id: 'artifact-demo', hash: sourceHash(2), generation: 2, status: 'present', complete: true }]);
  model.observeStructure(structure());
  assert.equal(entity(model, 'class-a').validity, 'stale');
  model.observeStructure(structure({ generation: 2 }));
  assert.equal(entity(model, 'class-a').validity, 'current');
  model.invalidateArtifacts([{ id: 'artifact-demo', generation: 3, status: 'missing', complete: true }]);
  model.observeStructure(structure({ generation: 2 }));
  assert.equal(entity(model, 'class-a').validity, 'retracted');
});

test('invalid containment never leaves cycles, missing parents, or out-of-span ownership', () => {
  const model = create();
  const malformed = structure({ symbols: [
    { id: 'a', label: 'A', kind: 'class', parentId: 'b', startLine: 2, endLine: 10 },
    { id: 'b', label: 'B', kind: 'class', parentId: 'a', startLine: 2, endLine: 10 },
    { id: 'c', label: 'C', kind: 'method', parentId: 'missing', startLine: 2, endLine: 3 },
    { id: 'd', label: 'D', kind: 'method', parentId: 'a', startLine: 20, endLine: 30 },
  ] });
  model.observeStructure(malformed);
  assert.ok(entity(model, 'a').parentId === null || entity(model, 'b').parentId === null);
  assert.equal(entity(model, 'c').parentId, null);
  assert.equal(entity(model, 'd').parentId, null);
  assert.equal(model.snapshot().coverage.enumerations[0].complete, false);
});

test('parent disappearance leaves a surviving child reachable with unresolved ownership', () => {
  const model = create();
  model.observeStructure(structure());
  model.observeStructure(structure({ generation: 2, symbols: [
    { id: 'method-a', label: 'run', kind: 'method', parentId: null, startLine: 3, endLine: 8 },
  ] }));
  assert.equal(entity(model, 'class-a').validity, 'retracted');
  assert.equal(entity(model, 'method-a').validity, 'current');
  assert.equal(entity(model, 'method-a').parentId, null);
  assert.equal(entity(model, 'method-a').ownership, 'unresolved');
});

test('observed source body edits preserve identity and classify changes as modifications', () => {
  const model = create();
  model.observeStructure(structure());
  const baseline = model.checkpoint();
  model.observeStructure(structure({ generation: 2 }));
  const changes = model.changes(baseline.id);
  assert.equal(changes.modifications.length, 5);
  assert.deepEqual(changes.creations, []);
  assert.deepEqual(changes.discoveries, []);
});

test('first observation is discovery unless complete compatible baseline establishes prior absence', () => {
  for (const complete of [false, true]) {
    const model = create();
    model.observeStructure(structure({ symbols: [], complete }));
    const baseline = model.checkpoint();
    model.observeStructure(structure({ generation: 2 }));
    const changes = model.changes(baseline.id);
    assert.equal(changes.creations.length, complete ? 4 : 0);
    assert.equal(changes.discoveries.length, complete ? 0 : 4);
  }
});

test('browser changes tolerate count-only coverage and use retained explicit creation observations', () => {
  const model = create();
  const before = { ...model.snapshot(), coverage: { retained: 1 } };
  model.observeStructure(structure());
  model.recordActivity({ kind: 'tool.succeeded', outcome: 'succeeded', creation: true, entityIds: ['class-a'], sourceRefs: [ref()] });
  const after = { ...model.snapshot(), coverage: { retained: 6 } };
  after.entities = after.entities.map(({ createdAtSequence, ...entity }) => entity);
  const changes = compareCheckpoint(before, after, 'browser-baseline');
  assert.deepEqual(changes.creations.map(value => value.id), ['class-a']);
  assert.equal(changes.discoveries.length, 4);
});

test('observed creation requires successful version-correlated evidence for the exact entity', () => {
  const model = create();
  const baseline = model.checkpoint();
  model.recordActivity({ kind: 'tool.requested', outcome: 'pending', creation: true, entityIds: ['class-a'], sourceRefs: [ref()] });
  model.observeStructure(structure());
  assert.equal(model.changes(baseline.id).creations.length, 0);
  model.recordActivity({ kind: 'tool.succeeded', outcome: 'succeeded', creation: true, entityIds: ['class-a'], sourceRefs: [ref()] });
  assert.deepEqual(model.changes(baseline.id).creations.map(value => value.id), ['class-a']);
});

test('legacy identities stay session-scoped and ambiguous despite equal labels', () => {
  const model = create();
  const graph = { nodes: [{ id: 'same', label: 'run', kind: 'function', shape: 'cylinder', x: 40, sourceRefs: [ref()] }], edges: [] };
  model.observeLegacy(graph, { sessionId: 'one' });
  model.observeLegacy(graph, { sessionId: 'two' });
  model.observeLegacy(graph, { sessionId: 'one' });
  model.observeStructure(structure());
  const legacy = model.snapshot().entities.filter(value => value.basis === 'legacy');
  assert.equal(legacy.length, 2);
  assert.notEqual(legacy[0].id, legacy[1].id);
  assert.ok(legacy.every(value => value.parentId === null && value.classification === 'unknown'));
  assert.ok(legacy.every(value => !('shape' in value)));
});

test('incremental legacy observations retain omitted nodes and edges beyond the scene cap', () => {
  const model = create();
  for (let batch = 0; batch < 30; batch++) model.observeLegacy({
    nodes: Array.from({ length: 12 }, (_, i) => ({
      id: `node-${batch * 12 + i}`, label: `declaration${batch * 12 + i}`, kind: 'function', sourceRefs: [ref()],
    })),
    edges: [{ id: `edge-${batch}`, source: `node-${batch * 12}`, target: `node-${batch * 12 + 1}`, relation: 'calls', sourceRefs: [ref()] }],
  }, { sessionId: 'one' });
  model.observeLegacy({ nodes: [], edges: [] }, { sessionId: 'one' });
  assert.equal(model.snapshot().entities.filter(value => value.basis === 'legacy').length, 360);
  assert.equal(model.snapshot().relations.length, 30);
});

test('fresh validated decisions keep current roles and edges before parsing, while restore stays stale', () => {
  const model = create();
  model.invalidateArtifacts([{ id: 'artifact-demo', ...ref(), status: 'present', complete: true }]);
  const graph = {
    nodes: ['db', 'writer'].map((name, i) => ({
      id: name, label: name, kind: i ? 'function' : 'datastore', validity: 'current',
      classification: 'accepted', sourceRefs: [ref()],
    })),
    edges: [{ id: 'writes', source: 'writer', target: 'db', relation: 'writes', validity: 'current', sourceRefs: [ref()] }],
  };
  model.observeLegacy(graph, { sessionId: 'one', fresh: true });
  assert.ok(model.snapshot().entities.filter(value => value.basis === 'decision').every(value => value.validity === 'current'));
  assert.equal(model.snapshot().interpretations.find(value => value.kind === 'datastore').support, 'supported');
  assert.equal(model.snapshot().relations[0].validity, 'current');
  model.observeStructure(structure());
  assert.equal(model.snapshot().relations[0].validity, 'current', 'same-version parsing cannot retire a decision relation');
  const restored = create();
  restored.observeLegacy(graph, { sessionId: 'one' });
  assert.ok(restored.snapshot().entities.filter(value => value.basis === 'legacy').every(value => value.validity === 'stale'));
  model.invalidateArtifacts([{ id: 'artifact-demo', generation: 2, hash: sourceHash(2), status: 'present' }]);
  model.observeLegacy(graph, { sessionId: 'one', fresh: true });
  assert.equal(model.snapshot().relations[0].validity, 'stale');
});

test('fresh decisions match unique parsed entities without overwriting code kind or merging ambiguous methods', () => {
  const model = create();
  model.observeStructure(structure());
  model.observeLegacy({
    nodes: [
      { id: 'alpha-decision', label: 'Alpha', kind: 'datastore', validity: 'current', classification: 'accepted', sourceRefs: [ref()] },
      { id: 'ambiguous-run', label: 'run', kind: 'function', validity: 'current', classification: 'accepted', sourceRefs: [ref()] },
    ], edges: [],
  }, { sessionId: 'one', fresh: true });
  assert.equal(model.snapshot().entities.filter(value => value.label === 'Alpha').length, 1);
  assert.equal(entity(model, 'class-a').kind, 'class');
  assert.deepEqual(model.snapshot().interpretations.find(value => value.kind === 'datastore').entityIds, ['class-a']);
  assert.equal(model.snapshot().entities.filter(value => value.label === 'run').length, 3);
});

test('later canonical matching preserves omitted decision edges from earlier partial graphs', () => {
  const model = create();
  model.invalidateArtifacts([{ id: 'artifact-demo', ...ref(), status: 'present', complete: true }]);
  const graph = {
    nodes: ['Alpha', 'Beta'].map(label => ({
      id: label.toLowerCase(), label, kind: 'service', validity: 'current', classification: 'accepted', sourceRefs: [ref()],
    })),
    edges: [{ id: 'calls', source: 'alpha', target: 'beta', relation: 'calls', validity: 'current', sourceRefs: [ref()] }],
  };
  model.observeLegacy(graph, { fresh: true, sessionId: 'one' });
  model.observeStructure(structure());
  model.observeLegacy({ nodes: [graph.nodes[0]], edges: [] }, { fresh: true, sessionId: 'one' });
  const snapshot = model.snapshot();
  assert.equal(snapshot.entities.filter(value => value.label === 'Alpha').length, 1);
  assert.equal(snapshot.relations.length, 1);
  assert.equal(snapshot.relations[0].source, 'class-a');
  assert.equal(snapshot.relations[0].validity, 'current');
  assert.ok(snapshot.entities.some(value => value.id === snapshot.relations[0].target));
});

test('real scoped-package parser versions permit complete enumeration and empty-file removal', async () => {
  const model = create();
  const artifactId = opaque('artifact', 'real-parser-fixture'), relativePath = 'src/actual.js';
  model.observeInventory({ entries: [file(relativePath)] });
  const extract = (text, generation) => extractStructure({ artifactId, relativePath, text, hash: hash(text), generation });
  const before = await extract('export function actual() { return 1; }', 1);
  assert.match(before.enumeration.version, /@vscode\//);
  const leading = create();
  leading.observeStructure({ ...before, enumeration: {
    ...before.enumeration, version: before.enumeration.version.slice(before.enumeration.version.indexOf('@')),
  } });
  assert.equal(leading.snapshot().coverage.enumerations[0].complete, true);
  model.observeStructure(before);
  assert.equal(model.snapshot().coverage.enumerations[0].complete, true);
  const declarationId = before.entities.find(value => value.label === 'actual').id;
  model.observeStructure(await extract('', 2));
  assert.equal(entity(model, declarationId).validity, 'retracted');
});

test('supported local file imports resolve conservatively and invalidate with either endpoint', () => {
  const model = create();
  model.observeInventory({ entries: [file('src/demo.js'), file('src/target.js')] });
  model.observeStructure(structure({ artifactId: 'artifact-target', relativePath: 'src/target.js', scopeId: 'module-target', symbols: [] }));
  model.observeStructure(structure({ imports: [
    { id: 'import-local', ownerId: 'module-demo', artifactId: 'artifact-demo', specifier: './target.js', kind: 'import', startLine: 1, endLine: 1 },
    { id: 'import-node', ownerId: 'module-demo', artifactId: 'artifact-demo', specifier: 'node:fs', kind: 'import', startLine: 1, endLine: 1 },
  ] }));
  const snapshot = model.snapshot();
  const relation = snapshot.relations.find(value => value.kind === 'imports');
  assert.equal(relation.target, 'module-target');
  assert.equal(relation.sourceRefs.length, 2);
  assert.deepEqual(snapshot.coverage.relationships, { observed: 2, resolved: 1, unresolved: 1, deferred: 0 });
  model.invalidateArtifacts([{ id: 'artifact-target', status: 'partial', generation: 2 }]);
  assert.equal(model.snapshot().relations[0].validity, 'stale');
});

test('ambiguous local imports and external names never invent canonical targets', () => {
  const model = create();
  model.observeInventory({ entries: [file('src/demo.js'), file('src/target.js'), file('src/target.ts')] });
  model.observeStructure(structure({ imports: [
    { id: 'ambiguous', ownerId: 'module-demo', artifactId: 'artifact-demo', specifier: './target', kind: 'import' },
  ] }));
  assert.equal(model.snapshot().relations.length, 0);
  assert.equal(model.snapshot().coverage.relationships.unresolved, 1);
});

test('require calls remain unresolved while exact import, reexport, and dynamic import resolve', () => {
  const model = create();
  model.observeInventory({ entries: [file('src/demo.js'), file('src/target.js')] });
  model.observeStructure(structure({ artifactId: 'artifact-target', relativePath: 'src/target.js', scopeId: 'module-target', symbols: [] }));
  model.observeStructure(structure({ imports: ['require_reference', 'import', 'reexport', 'dynamic_import'].map(kind => ({
    id: kind, ownerId: 'module-demo', artifactId: 'artifact-demo', specifier: './target.js', kind,
  })) }));
  assert.equal(model.snapshot().relations.length, 3);
  assert.equal(model.snapshot().coverage.relationships.unresolved, 1);
  model.observeStructure(structure({ imports: [
    { id: 'import', ownerId: 'module-demo', artifactId: 'artifact-demo', specifier: './target.js', kind: 'require_reference' },
  ] }));
  assert.equal(model.snapshot().coverage.relationships.resolved, 0);
});

test('namespaced interpretations retain uncertainty and require current support', () => {
  const model = create();
  model.observeStructure(structure());
  model.observeInterpretations([interpretation(), interpretation({ namespace: 'another.layer', support: 'unknown', sourceRefs: [] })]);
  assert.equal(model.snapshot().interpretations.length, 2);
  assert.equal(model.snapshot().interpretations[1].support, 'unknown');
  model.invalidateArtifacts([{ id: 'artifact-demo', hash: sourceHash(2), generation: 2, status: 'present', complete: true }]);
  model.observeInterpretations([interpretation({ id: 'late' })]);
  assert.equal(model.snapshot().interpretations.length, 2);
  assert.equal(model.snapshot().interpretations[0].validity, 'stale');
});

test('scoped snapshots include ancestry and only relationships with retained endpoints', () => {
  const model = create();
  model.observeStructure(structure());
  const scoped = model.snapshot({ scopeId: 'class-a' });
  assert.deepEqual(new Set(scoped.entities.map(value => value.id)), new Set(['module-demo', 'class-a', 'method-a']));
  assert.equal(model.snapshot({ scopeId: 'missing' }).entities.length, 0);
});

test('20k model cap preserves newly inventoried product roots after tooling expansion', () => {
  const model = create();
  model.observeInventory({ entries: [file('tooling/demo.js')] });
  const symbols = Array.from({ length: 21_000 }, (_, i) => ({
    id: `helper-${i}`, label: `helper${i}`, kind: 'function', parentId: 'module-demo', startLine: i + 2, endLine: i + 2,
  }));
  model.observeStructure(structure({ relativePath: 'tooling/demo.js', symbols }));
  model.observeInventory({ entries: [file('gateway/main.py'), file('web/index.ts')] });
  const snapshot = model.snapshot();
  assert.ok(snapshot.entities.length <= 20_000);
  assert.ok(snapshot.entities.some(value => value.relativePath === 'gateway/main.py'));
  assert.ok(snapshot.entities.some(value => value.relativePath === 'web/index.ts'));
  assert.ok(snapshot.coverage.deferred.entities > 0);
  const entityIds = new Set(snapshot.entities.map(value => value.id));
  assert.ok(snapshot.entities.every(value => !value.parentId || entityIds.has(value.parentId)));
  assert.ok(model.stats().bytes <= model.stats().limits.bytes);
});

test('late roots can replace nested metadata summaries when scope capacity is full', () => {
  const model = create({ limits: { scopes: 2 } });
  model.observeInventory({ entries: [file('tooling/deep/demo.js')] });
  model.observeInventory({ entries: [file('gateway/main.py')] });
  assert.ok(model.snapshot().entities.some(value => value.kind === 'directory' && value.label === 'gateway'));
  model.observeStructure(structure({ relativePath: 'tooling/deep/demo.js' }));
  const snapshot = model.snapshot(), ids = new Set(snapshot.entities.map(value => value.id));
  assert.ok(snapshot.entities.every(value => !value.parentId || ids.has(value.parentId)));
});

test('eviction by bounded capacity does not fabricate deletions from a retained baseline', () => {
  const model = create({ limits: { entities: 7 } });
  model.observeStructure(structure());
  const baseline = model.checkpoint();
  model.observeInventory({ entries: [file('gateway/main.py'), file('web/index.ts')] });
  assert.deepEqual(model.changes(baseline.id).removals, []);
  assert.equal(model.snapshot({ checkpointId: baseline.id }).entities.length, 6);
});

test('an entity evicted before the baseline cannot turn rediscovery into creation', () => {
  const model = create({ limits: { entities: 4 } });
  const symbols = [
    { id: 'class-a', label: 'Alpha', kind: 'class', parentId: 'module-demo', startLine: 2, endLine: 20 },
    { id: 'class-b', label: 'Beta', kind: 'class', parentId: 'module-demo', startLine: 22, endLine: 40 },
  ];
  model.observeStructure(structure({ symbols }));
  assert.equal(model.snapshot().coverage.enumerations[0].complete, true);
  model.observeInventory({ entries: [file('src/demo.js')] });
  assert.equal(entity(model, 'class-a'), undefined);
  assert.equal(model.snapshot().coverage.enumerations[0].complete, false);
  const baseline = model.checkpoint();
  model.observeStructure(structure({ symbols: [symbols[0]], generation: 2 }));
  const changes = model.changes(baseline.id);
  assert.deepEqual(changes.creations, []);
  assert.ok(changes.discoveries.some(value => value.id === 'class-a'));
});

test('docs are metadata and cannot establish source declarations', () => {
  const model = create();
  model.observeInventory({ entries: [file('docs/design.md')] });
  model.observeStructure(structure({ relativePath: 'docs/design.md' }));
  assert.equal(entity(model, 'class-a'), undefined);
});

test('creation evidence remains attached after journal retention and subsequent body edits', () => {
  const model = create({ limits: { activity: 2 } });
  const baseline = model.checkpoint();
  model.observeStructure(structure());
  model.recordActivity({ kind: 'tool.succeeded', outcome: 'succeeded', creation: true, entityIds: ['class-a'], sourceRefs: [ref()] });
  for (let i = 0; i < 10; i++) model.recordActivity({ kind: 'tool.requested' });
  model.observeStructure(structure({ generation: 2 }));
  assert.deepEqual(model.changes(baseline.id).creations.map(value => value.id), ['class-a']);
});

test('changing parser identity invalidates membership even with the same artifact hash', () => {
  const model = create();
  model.observeStructure(structure());
  model.observeInterpretations([interpretation(), interpretation({ id: 'second' })]);
  model.observeStructure(structure({ symbols: [], identityVersion: 'identity-2' }));
  assert.ok(model.snapshot().interpretations.every(value => value.validity === 'stale'));
});

test('unavailable or partial evidence is never treated as confirmed absence', () => {
  for (const status of ['missing', 'unavailable', 'partial']) {
    const model = create();
    model.observeStructure(structure());
    model.invalidateArtifacts([{ id: 'artifact-demo', status, generation: 2, complete: false }]);
    assert.equal(entity(model, 'class-a').validity, 'stale');
  }
});

test('lexical capability cannot claim parsed ownership or certify absence', () => {
  const model = create();
  model.observeStructure(structure());
  model.observeStructure(structure({ capability: 'lexical', symbols: [] }));
  assert.equal(entity(model, 'class-a').validity, 'stale');
  assert.equal(entity(model, 'module-demo').basis, 'lexical');
  assert.equal(model.snapshot().coverage.enumerations[0].complete, false);
});
