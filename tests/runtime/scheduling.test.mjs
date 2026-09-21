import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathPriority, selectPrioritized } from '../../runtime/discovery/priority.mjs';
import { createArchitectureController } from '../../runtime/architecture/controller.mjs';
import { createPlatform } from '../../runtime/platform.mjs';
import { EvidenceStore } from '../../runtime/core/evidence.mjs';
import { extractStructure } from '../../runtime/discovery/index.mjs';
import { structure } from '../model/fixtures.mjs';

const gate = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture(t, files, extract = extractStructure) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-scheduling-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  const policy = { readSource: true };
  const platform = createPlatform({ projectRoot: root, projectId: 'synthetic-scheduling', policy, extract, now: () => 100 });
  const evidence = new EvidenceStore({ projectRoot: root, policy });
  t.after(async () => { await platform.close(); await rm(root, { recursive: true, force: true }); });
  async function capture(names) {
    const result = [];
    for (let i = 0; i < names.length; i += 32) result.push(...await evidence.capture(names.slice(i, i + 32)));
    return result;
  }
  return { platform, capture, root };
}

test('path priority schedules entry names without promoting tests or assigning roles', () => {
  for (const name of ['website/src/main.tsx', 'src/App.jsx', 'service/server.py', 'pkg/__main__.py', 'src/index.ts']) {
    assert.equal(pathPriority(name), 0, name);
  }
  for (const name of ['tests/main.ts', 'src/App.test.tsx', 'scripts/server.py', 'src/test_server.py']) {
    assert.equal(pathPriority(name), 2, name);
  }
  assert.equal(pathPriority('src/orders.ts'), 1);
  assert.equal(pathPriority(undefined), 1);
  const values = [
    { id: 'old-test', priority: 2 }, { id: 'old-tool', priority: 2 },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `entry-${index}`, priority: 0 })),
  ];
  const selected = selectPrioritized(values, 6);
  assert.deepEqual(selected.values.map(value => value.id),
    ['entry-0', 'entry-1', 'old-test', 'entry-2', 'entry-3', 'old-tool']);
  assert.equal(selected.cursor, 0);
  assert.equal(values.length, 10, 'selection does not discard pending work');
});

test('architecture finds late entry files ahead of a large test backlog while eventually inspecting every file', async t => {
  const inputs = [
    ...Array.from({ length: 2700 }, (_, i) => ({ id: `test-${i}`, relativePath: `tests/unit-${i}.ts` })),
    ...['main.tsx', 'index.ts', 'App.tsx', 'server.ts'].map((name, i) =>
      ({ id: `entry-${i}`, relativePath: `website/src/${name}` })),
  ].map(value => ({ ...value, hash: 'a'.repeat(64), generation: 1, status: 'present' }));
  const artifacts = new Map(inputs.map(value => [value.id, value])), batches = [];
  const controller = createArchitectureController({
    snapshot: () => ({ interpretations: [] }),
    capture: async ids => { batches.push(ids); return ids.map(id => artifacts.get(id)); },
    analyze: async () => ({ status: 'complete', interpretations: [], affectedEntityIds: [], coverage: {} }),
    commit: () => assert.fail('a filename alone must not produce an interpretation'),
  });
  t.after(() => controller.close());
  controller.observe(inputs);
  await controller.whenIdle();
  assert.deepEqual(batches[0], ['entry-0', 'entry-1', 'test-0', 'entry-2', 'entry-3', 'test-1']);
  assert.ok(batches.every(batch => batch.length <= 6));
  assert.equal(new Set(batches.flat()).size, inputs.length);
  assert.equal(controller.status().inspected, inputs.length);
  assert.equal(controller.status().applications, 0);
  assert.equal(controller.status().components, 0);
});

test('admitted applications advance deferred neighbors with bounded batches and oldest-work fairness', async t => {
  for (const scenario of ['application', 'capacity', 'component', 'stale']) {
    await t.test(scenario, async t => {
      const inputs = [
        ...Array.from({ length: 3000 }, (_, i) => ({ id: `file-${i}`, relativePath: `src/feature-${i}.ts` })),
        { id: 'application', relativePath: 'src/main.ts' },
        { id: 'neighbor', relativePath: 'src/renderer.ts' },
      ].map(value => ({ ...value, hash: 'a'.repeat(64), generation: 1, status: 'present' }));
      const artifacts = new Map(inputs.map(value => [value.id, value])), batches = [];
      const interpretation = { id: 'boundary', namespace: 'graphlin.architecture',
        kind: scenario === 'component' ? 'component' : 'application',
        validity: scenario === 'stale' ? 'stale' : 'current',
        classification: 'accepted', support: 'supported' };
      let retained = [];
      const controller = createArchitectureController({
        snapshot: () => ({ interpretations: retained }),
        capture: async ids => { batches.push(ids); return ids.map(id => artifacts.get(id)); },
        analyze: async ({ affectedArtifactIds }) => affectedArtifactIds.includes('application')
          ? { status: 'partial', interpretations: [interpretation], affectedEntityIds: ['anchor'],
            coverage: { deferredArtifactIds: ['neighbor'] } }
          : { status: 'complete', interpretations: [], affectedEntityIds: [], coverage: {} },
        commit: result => {
          if (scenario === 'capacity') return { accepted: true, omitted: 1 };
          retained = result.interpretations;
          return true;
        },
      });
      t.after(() => controller.close());
      controller.observe(inputs);
      await controller.whenIdle();
      assert.equal(batches[0][0], 'application');
      assert.equal(batches[1][0], scenario === 'application' ? 'neighbor' : 'file-5');
      assert.equal(batches[1][2], scenario === 'application' ? 'file-6' : 'file-7',
        'every third selection still advances the oldest pending file');
      assert.ok(batches.every(batch => batch.length <= 6));
      assert.equal(batches.flat().length, inputs.length, 'neighbors do not reopen completed versions');
      assert.equal(new Set(batches.flat()).size, inputs.length);
      assert.equal(retained.some(value => value.kind === 'architecture_membership'), false,
        'queue promotion never supplies membership evidence');
    });
  }
});

test('bounded parser admission and selection prioritize known entries while preserving overflow for later work', async t => {
  const started = gate(), release = gate(), calls = [];
  const tests = Array.from({ length: 40 }, (_, i) => `tests/unit-${String(i).padStart(2, '0')}.js`);
  const entries = ['website/src/main.tsx', 'website/src/App.tsx', 'website/src/index.ts'];
  const names = [...tests, ...entries];
  const f = await fixture(t, Object.fromEntries(names.map(name => [name, 'export const value = 1;'])), async input => {
    calls.push(input.relativePath);
    if (calls.length === 1) { started.resolve(); await release.promise; }
    return extractStructure(input);
  });
  f.platform.observeArtifacts(await f.capture([tests[0]]));
  await started.promise;
  f.platform.observeArtifacts(await f.capture(names.slice(1)));
  assert.equal(f.platform.stats().queued, 32);
  assert.ok(f.platform.stats().deferred > 0);
  release.resolve();
  await f.platform.whenIdle();
  assert.ok(entries.every(name => calls.slice(0, 7).includes(name)), 'entry files fit admission and reach the parser early');
  for (let attempt = 0; attempt < 4 && f.platform.stats().deferred; attempt++) {
    const pending = await f.platform.discover();
    assert.ok(pending.length <= 64);
    assert.deepEqual(pending, [...pending].sort(), 'the selected bounded path batch remains lexical');
    f.platform.observeArtifacts(await f.capture(pending));
    await f.platform.whenIdle();
  }
  assert.equal(new Set(calls).size, names.length);
  assert.equal(calls.length, names.length, 'overflow retries do not reparse unchanged completed files');
  assert.equal(f.platform.snapshot().interpretations.length, 0);
});

test('unchanged capacity-partial parses settle until capacity, source, lineage, or explicit discovery changes', { timeout: 15_000 }, async t => {
  let calls = 0;
  const f = await fixture(t, { 'sample.js': 'export const value = 1;' }, input => {
    calls++;
    return extractStructure(input);
  });
  await f.platform.discover();
  const captures = await f.capture(['sample.js']), capture = captures[0];
  const alias = { id: 'old-alias', kind: 'module', label: 'sample.js', qualifiedName: 'sample.js',
    validity: 'current', classification: 'accepted',
    sourceRefs: [{ artifactId: capture.id, hash: capture.hash, generation: capture.generation }] };
  f.platform.model.observeLegacy({ nodes: [alias], edges: [] }, { sessionId: 'synthetic' });
  const count = f.platform.model.stats().limits.entities - f.platform.model.stats().entities - 1;
  f.platform.model.observeStructure(structure({
    artifactId: 'filler-artifact', relativePath: 'filler.js', scopeId: 'filler-module',
    symbols: Array.from({ length: count }, (_, i) => ({
      id: `filler-${i}`, label: `value${i}`, kind: 'variable', parentId: 'filler-module',
      startLine: i + 2, endLine: i + 2,
    })),
  }));
  assert.equal(f.platform.model.stats().entities, 20_000);
  f.platform.observeArtifacts(captures);
  await f.platform.whenIdle();
  assert.equal(calls, 1);
  assert.equal(f.platform.stats().parsed, 1, 'the accepted module anchor is retained');
  assert.equal(f.platform.stats().deferred, 1, 'omitted symbol detail remains visible');
  const initial = f.platform.snapshot(), baseline = f.platform.model.stats();
  assert.equal(initial.coverage.enumerations.find(value => value.artifactId === capture.id).complete, false);
  assert.equal(initial.entities.filter(value => value.id.startsWith('filler-') && value.id !== 'filler-module').length, count);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await f.platform.discover(), []);
    f.platform.observeArtifacts(await f.capture(['sample.js']));
    await f.platform.whenIdle();
  }
  assert.equal(calls, 1);
  assert.equal(f.platform.model.stats().revision, baseline.revision);
  assert.equal(f.platform.model.stats().sequence, baseline.sequence);

  // Canonical alias reconciliation frees a real slot without evicting records.
  f.platform.model.observeLegacy({ nodes: [alias], edges: [] }, { sessionId: 'synthetic', fresh: true });
  assert.equal(f.platform.model.stats().entities, 19_999);
  const retry = await f.platform.discover();
  assert.equal(retry.length, 1);
  f.platform.observeArtifacts(await f.capture(retry));
  await f.platform.whenIdle();
  assert.equal(calls, 2);
  assert.equal(f.platform.stats().deferred, 0);
  assert.equal(f.platform.model.stats().entities, 20_000);
  assert.equal(f.platform.snapshot().coverage.enumerations.find(value => value.artifactId === capture.id).complete, true);

  await writeFile(path.join(f.root, 'sample.js'), 'export const value = 1; export const extra = 2;');
  f.platform.observeArtifacts(await f.capture(['sample.js']));
  await f.platform.whenIdle();
  assert.equal(calls, 3);
  assert.equal(f.platform.stats().deferred, 1);
  f.platform.retryCapacity();
  f.platform.observeArtifacts(await f.capture(['sample.js']));
  await f.platform.whenIdle();
  assert.equal(calls, 4, 'explicit discovery permits one fresh attempt at the same capacity');
  f.platform.observeLineage({ id: 'first-lineage', status: 'git' });
  f.platform.observeLineage({ id: 'next-lineage', status: 'git' });
  f.platform.observeArtifacts(await f.capture(await f.platform.discover()));
  await f.platform.whenIdle();
  assert.equal(calls, 5);
  assert.ok(f.platform.model.stats().entities <= 20_000);
});
