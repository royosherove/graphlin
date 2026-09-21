import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlatform } from '../../runtime/platform.mjs';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { EvidenceStore } from '../../runtime/core/evidence.mjs';
import { hash } from '../../runtime/core/common.mjs';
import { extractStructure } from '../../runtime/discovery/index.mjs';
import { createModelPersistence } from '../../runtime/daemon/model-persistence.mjs';

function gate() {
  let resolve;
  const promise = new Promise(ready => { resolve = ready; });
  return { promise, resolve };
}

async function fixture(t, {
  files = { 'sample.js': 'export function sample() { return 1; }\n' },
  policy = { readSource: true }, ...options
} = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-platform-')));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  const platform = createPlatform({ projectRoot: root, projectId: hash(root), policy, ...options });
  const evidence = new EvidenceStore({ projectRoot: root, policy });
  t.after(async () => { await platform.close(); await rm(root, { recursive: true, force: true }); });
  async function capture(names) {
    const captures = [];
    for (let index = 0; index < names.length; index += 32) captures.push(...await evidence.capture(names.slice(index, index + 32)));
    return captures;
  }
  return { root, platform, capture, evidence };
}

test('metadata inventory stays useful without invoking a parser', async t => {
  let calls = 0;
  const { platform, capture } = await fixture(t, { policy: {}, extract: async () => { calls++; throw new Error('UNEXPECTED_PARSE'); } });
  const paths = await platform.discover();
  platform.observeArtifacts(await capture(paths));
  await platform.whenIdle();
  assert.equal(calls, 0);
  assert.ok(platform.snapshot().entities.some(value => value.kind === 'file' && value.label === 'sample.js'));
  assert.equal(platform.snapshot().entities.some(value => value.kind === 'function'), false);
});

test('local read and implied transmit-source consent both permit real local parsing', async t => {
  for (const policy of [{ readSource: true }, { transmitSource: true }]) {
    const { platform, capture } = await fixture(t, { policy });
    const paths = await platform.discover();
    platform.observeArtifacts(await capture(paths), { id: 'observed-event', kind: 'tool.succeeded', sessionId: 'session-one' });
    await platform.whenIdle();
    const symbol = platform.snapshot().entities.find(value => value.label === 'sample');
    assert.equal(symbol.basis, 'parsed');
    assert.equal(symbol.sourceRefs[0].eventId, 'observed-event');
    assert.equal(platform.snapshot().coverage.enumerations[0].complete, true);
  }
});

test('queue overflow is visible and retried through bounded discovery and fresh capture', async t => {
  const started = gate(), release = gate();
  let first = true;
  const files = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`item-${i}.js`, `export const item${i} = ${i};\n`]));
  const { platform, capture } = await fixture(t, {
    files, now: () => 100,
    extract: async input => {
      if (first) { first = false; started.resolve(); await release.promise; }
      return extractStructure(input);
    },
  });
  await platform.discover();
  platform.observeArtifacts(await capture(Object.keys(files)));
  await started.promise;
  assert.ok(platform.stats().queued <= 32);
  assert.equal(platform.stats().deferred, 38);
  assert.ok(platform.snapshot().coverage.deferred.artifacts >= 38);
  assert.ok(platform.snapshot().activity.some(event => event.kind === 'parse.deferred'));
  release.resolve();
  await platform.whenIdle();
  for (let pass = 0; pass < 5 && platform.stats().deferred; pass++) {
    const retry = await platform.discover();
    assert.ok(retry.length > 0, 'retry continues even during completed-scan cooldown');
    assert.ok(retry.length <= 64);
    assert.deepEqual(retry, [...retry].sort());
    platform.observeArtifacts(await capture(retry));
    await platform.whenIdle();
  }
  assert.equal(platform.stats().deferred, 0);
  assert.equal(platform.stats().parsed, 70);
  assert.equal(platform.snapshot().coverage.enumerations.length, 70);
  assert.equal(platform.snapshot().entities.filter(value => value.kind === 'variable').length, 70);
});

test('selected parse versions settle despite continuous unrelated captures and a full queue', { timeout: 5000 }, async t => {
  const started = gate(), release = gate(), later = gate(), calls = [];
  t.after(() => { release.resolve(); later.resolve(); });
  const names = Array.from({ length: 100 }, (_, i) => `item-${String(i).padStart(2, '0')}.js`);
  let platform, arrivals = [];
  const f = await fixture(t, {
    files: Object.fromEntries(names.map((name, i) => [name, `export const item${i} = ${i};`])),
    extract: async input => {
      calls.push(input.relativePath);
      if (calls.length === 1) { started.resolve(); await release.promise; }
      else if (calls.length > 12) await later.promise;
      // Fresh unrelated arrivals keep the global queue busy after each parse.
      await Promise.resolve();
      if (arrivals.length) platform.observeArtifacts([arrivals.shift()]);
      return extractStructure(input);
    },
  });
  platform = f.platform;
  const captures = await f.capture(names), selected = captures.slice(60, 66);
  arrivals = captures.slice(66);
  platform.observeArtifacts(captures.slice(0, 33));
  await started.promise;
  platform.observeArtifacts(selected, undefined, { priority: true });
  assert.equal(platform.stats().queued, 32);
  assert.equal(platform.stats().deferred, 6, 'displaced captures remain metadata-only deferred work');
  const settled = platform.whenParsed(selected);
  release.resolve();
  assert.equal(await settled, true);
  assert.ok(platform.stats().queued > 0, 'the barrier does not drain future unrelated arrivals');
  assert.ok(calls.length <= 11, 'six selected files finish within bounded priority/oldest turns');
  assert.ok(calls.includes(names[1]), 'oldest ordinary work still advances');
  for (const artifact of selected) {
    assert.ok(platform.snapshot().entities.some(entity => entity.artifactId === artifact.id &&
      entity.kind === 'module' && entity.basis === 'parsed' && entity.validity === 'current'));
  }
  assert.ok(platform.stats().queued <= 32);
});

test('a targeted parse barrier rejects changed versions and failed attempts', async t => {
  const started = gate(), release = gate();
  t.after(() => release.resolve());
  let first = true;
  const { platform, capture, root } = await fixture(t, { extract: async input => {
    if (first) { first = false; started.resolve(); await release.promise; }
    else throw new Error('synthetic_parser_failure');
    return extractStructure(input);
  } });
  const old = await capture(['sample.js']);
  platform.observeArtifacts(old, undefined, { priority: true });
  await started.promise;
  const settled = platform.whenParsed(old);
  await writeFile(path.join(root, 'sample.js'), 'export const replacement = 2;');
  const fresh = await capture(['sample.js']);
  platform.observeArtifacts(fresh, undefined, { priority: true });
  release.resolve();
  assert.equal(await settled, false);
  assert.equal(await platform.whenParsed(fresh), false);
  assert.equal(platform.snapshot().entities.some(entity => entity.basis === 'parsed'), false);
  assert.equal(platform.stats().failed, 1);
});

test('cancelling a targeted wait does not wait for unrelated parser work', async t => {
  const started = gate(), release = gate(), controller = new AbortController();
  t.after(() => release.resolve());
  const { platform, capture } = await fixture(t, { extract: async input => {
    started.resolve(); await release.promise;
    return extractStructure(input);
  } });
  const artifacts = await capture(['sample.js']);
  platform.observeArtifacts(artifacts, undefined, { priority: true });
  await started.promise;
  const settled = platform.whenParsed(artifacts, { signal: controller.signal });
  controller.abort();
  assert.equal(await settled, false);
  assert.equal(platform.stats().active, 1);
});

test('a same-file change between revalidation and acceptance cannot install the old parse', async t => {
  const waiting = gate(), release = gate();
  let first = true;
  const { platform, capture, root } = await fixture(t, {
    accept: async operation => {
      if (first) { first = false; waiting.resolve(); await release.promise; }
      operation();
    },
  });
  await platform.discover();
  const before = await capture(['sample.js']);
  platform.observeArtifacts(before);
  await waiting.promise;
  await writeFile(path.join(root, 'sample.js'), 'export function latest() { return 2; }\n');
  platform.observeArtifacts(await capture(['sample.js']));
  release.resolve();
  await platform.whenIdle();
  assert.ok(platform.snapshot().entities.some(value => value.label === 'latest' && value.validity === 'current'));
  assert.equal(platform.snapshot().entities.some(value => value.label === 'sample'), false);
  platform.observeArtifacts(before);
  await platform.whenIdle();
  assert.equal(platform.snapshot().entities.some(value => value.label === 'sample'), false);
  assert.ok(platform.stats().stale >= 1);
});

test('an empty current file retracts old declarations through the real parser', async t => {
  const { platform, capture, root } = await fixture(t);
  await platform.discover();
  platform.observeArtifacts(await capture(['sample.js']));
  await platform.whenIdle();
  await writeFile(path.join(root, 'sample.js'), '');
  platform.observeArtifacts(await capture(['sample.js']));
  await platform.whenIdle();
  assert.equal(platform.snapshot().entities.find(value => value.label === 'sample').validity, 'retracted');
  assert.equal(platform.snapshot().coverage.enumerations[0].complete, true);
});

test('discovery sorts each bounded batch and progresses past the first 64 paths', async t => {
  const files = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [
    `${String(149 - i).padStart(3, '0')}.js`, `export const item${i} = ${i};`,
  ]));
  const { platform } = await fixture(t, { files });
  const discovered = new Set();
  for (let pass = 0; pass < 10; pass++) {
    const batch = await platform.discover();
    assert.ok(batch.length <= 64);
    assert.deepEqual(batch, [...batch].sort());
    batch.forEach(name => discovered.add(name));
    if (platform.snapshot().coverage.complete) break;
  }
  assert.equal(discovered.size, 150);
});

test('persistent model snapshots keep omission certificates and frozen checkpoint states', async t => {
  const { platform, capture } = await fixture(t);
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  const baseline = platform.checkpoint({ label: 'Parsed baseline' });
  const persistent = platform.snapshot({ persistent: true });
  assert.equal(persistent.coverage.enumerations[0].complete, true);
  assert.deepEqual(persistent.coverage.enumerations[0].omissions, []);
  const saved = persistent.checkpoints.find(value => value.id === baseline.id).state;
  assert.equal(saved.coverage.enumerations[0].complete, true);
  assert.match(saved.coverage.enumerations[0].version, /@vscode\//);
  assert.equal(saved.coverage.parsing, undefined);
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-model-storage-')));
  const storage = createModelPersistence(path.join(data, 'model-state.json'), { projectId: persistent.projectId });
  t.after(async () => { await storage.close(); await rm(data, { recursive: true, force: true }); });
  storage.schedule(persistent);
  await storage.flush();
  assert.deepEqual(await storage.load(), JSON.parse(JSON.stringify(persistent)));
});

test('partial parser omissions remain explicit through current and checkpoint snapshots', async t => {
  const { platform, capture } = await fixture(t, {
    files: { 'partial.js': "function load(require) { return require('./target.js'); }\n" },
  });
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  const current = platform.snapshot().coverage.enumerations[0];
  assert.equal(current.complete, false);
  assert.ok(current.omissions.includes('require_resolution'));
  assert.deepEqual(current.coveredRanges, []);
  const marker = platform.checkpoint();
  assert.deepEqual(platform.snapshot({ checkpointId: marker.id }).coverage.enumerations[0], current);
});

test('parse failures report fixed diagnostics, retain metadata, and allow same-version retry', async t => {
  let fail = true;
  const { platform, capture } = await fixture(t, {
    extract: input => {
      if (fail) { fail = false; throw new Error('RAW_SYNTHETIC_SOURCE_OR_PATH'); }
      return extractStructure(input);
    },
  });
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  assert.equal(platform.stats().failed, 1);
  assert.equal(platform.stats().lastError, 'parse.failed');
  assert.equal(platform.stats().deferred, 1);
  assert.ok(platform.snapshot().entities.some(value => value.kind === 'file'));
  assert.doesNotMatch(JSON.stringify(platform.snapshot()), /RAW_SYNTHETIC/);
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  assert.equal(platform.stats().parsed, 1);
  assert.equal(platform.stats().deferred, 0);
  assert.equal(platform.snapshot().coverage.unavailable, 0);
});

test('observer errors cannot discard an accepted parse or escape as unhandled errors', async t => {
  const { platform, capture } = await fixture(t, { onChange: () => { throw new Error('OBSERVER_DETAIL'); } });
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  assert.equal(platform.stats().parsed, 1);
  assert.equal(platform.stats().lastError, 'observer_failed');
  assert.equal(platform.stats().failed, 0);
});

test('policy tightening blocks late acceptance and history never inherits live queue status', async t => {
  const policy = { readSource: true }, started = gate(), release = gate();
  const { platform, capture } = await fixture(t, {
    policy, extract: async input => { started.resolve(); await release.promise; return extractStructure(input); },
  });
  await platform.discover();
  const marker = platform.checkpoint();
  const history = platform.snapshot({ checkpointId: marker.id });
  platform.observeArtifacts(await capture(['sample.js']));
  await started.promise;
  policy.readSource = false;
  release.resolve();
  await platform.whenIdle();
  assert.equal(platform.stats().parsed, 0);
  assert.equal(platform.snapshot().entities.some(value => value.kind === 'function'), false);
  assert.deepEqual(platform.snapshot({ checkpointId: marker.id }), history);
  assert.equal(platform.snapshot({ checkpointId: marker.id }).coverage.parsing, undefined);
});

test('local-source pipeline populates structure without calling remote classification', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  const pipeline = createPipeline({
    projectRoot: root, policy: { readSource: true, transmitSource: false },
    decisionService: { classify: async () => { calls++; throw new Error('UNGRANTED_CLASSIFICATION'); } },
  });
  t.after(() => pipeline.close());
  await pipeline.ingest({ hook_event_name: 'SessionStart', session_id: 'local-fixture' });
  await pipeline.whenIdle();
  assert.equal(calls, 0);
  assert.ok(pipeline.getModelState().entities.some(value => value.label === 'sample' && value.basis === 'parsed'));
});

test('lineage changes clear the parse cache so unchanged bytes are recaptured and reprocessed', async t => {
  let calls = 0;
  const { platform, capture } = await fixture(t, {
    now: () => 100, extract: input => { calls++; return extractStructure(input); },
  });
  const lineage = { id: 'lineage-one', status: 'available' };
  platform.observeLineage(lineage);
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  assert.equal(calls, 1);
  const before = platform.snapshot();
  assert.equal(platform.observeLineage(lineage).changed, false);
  assert.deepEqual(platform.snapshot(), before);
  assert.equal(platform.observeLineage({ ...lineage, id: 'lineage-two' }).changed, true);
  assert.equal(platform.stats().parsed, 0);
  assert.equal(platform.snapshot().entities.find(value => value.label === 'sample').validity, 'stale');
  const retry = await platform.discover();
  assert.equal(retry.length, 1, 'recapture bypasses the five-second inventory cooldown');
  platform.observeArtifacts(await capture(retry));
  await platform.whenIdle();
  assert.equal(calls, 2);
  assert.equal(platform.stats().deferred, 0);
  assert.equal(platform.snapshot().entities.find(value => value.label === 'sample').validity, 'current');
});

test('unavailable lineage pauses new parses and same-identity recovery retains completed parses', async t => {
  let calls = 0;
  const { platform, capture } = await fixture(t, {
    files: { 'one.js': 'export const one = 1;', 'two.js': 'export const two = 2;' },
    extract: input => { calls++; return extractStructure(input); },
  });
  const lineage = { id: 'lineage-one', status: 'git' };
  platform.observeLineage(lineage);
  const first = await capture(['one.js']);
  platform.observeArtifacts(first);
  await platform.whenIdle();
  assert.equal(platform.stats().parsed, 1);
  const before = platform.snapshot().entities;
  platform.observeLineage({ ...lineage, status: 'unavailable' });
  platform.observeArtifacts(await capture(['two.js']));
  await platform.whenIdle();
  assert.equal(calls, 1);
  assert.equal(platform.stats().parsed, 1);
  assert.equal(platform.stats().queued, 1);
  assert.equal(platform.snapshot().coverage.lineage.status, 'unavailable');
  assert.ok(before.every(entity => platform.snapshot().entities.some(value =>
    value.id === entity.id && value.validity === entity.validity)));
  platform.observeLineage(lineage);
  await platform.whenIdle();
  assert.equal(calls, 2);
  assert.equal(platform.stats().parsed, 2);
  assert.equal((await capture(['one.js']))[0].generation, first[0].generation);
  platform.observeArtifacts(first);
  await platform.whenIdle();
  assert.equal(calls, 2, 'the confirmed same lineage does not discard completed parser work');
});

test('a parse started before lineage became unavailable cannot commit after same-identity recovery', async t => {
  const started = gate(), release = gate();
  let calls = 0;
  const { platform, capture } = await fixture(t, { extract: async input => {
    calls++;
    if (calls === 1) { started.resolve(); await release.promise; }
    return extractStructure({ ...input, signal: undefined });
  } });
  const lineage = { id: 'lineage-one', status: 'git' };
  platform.observeLineage(lineage);
  const artifacts = await capture(['sample.js']);
  platform.observeArtifacts(artifacts);
  await started.promise;
  platform.observeLineage({ ...lineage, status: 'unavailable' });
  platform.observeLineage(lineage);
  release.resolve();
  await platform.whenIdle();
  assert.equal(platform.stats().parsed, 0);
  assert.equal(platform.snapshot().entities.some(value => value.basis === 'parsed'), false);
  platform.observeArtifacts(artifacts);
  await platform.whenIdle();
  assert.equal(platform.stats().parsed, 1);
  assert.equal(calls, 2);
});

test('lineage changes abort active and queued work and reject a late parse even after switching back', async t => {
  const started = gate(), release = gate();
  let signal, calls = 0;
  const { platform, capture } = await fixture(t, {
    files: { 'a.js': 'export const first = 1;', 'b.js': 'export const second = 2;' },
    extract: async input => {
      calls++;
      if (calls === 1) { signal = input.signal; started.resolve(); await release.promise; }
      return extractStructure(input);
    },
  });
  const lineage = { id: 'lineage-one', status: 'available' };
  platform.observeLineage(lineage);
  platform.observeArtifacts(await capture(await platform.discover()));
  await started.promise;
  assert.equal(platform.stats().queued, 1);
  platform.observeLineage({ ...lineage, id: 'lineage-two' });
  platform.observeLineage(lineage);
  assert.equal(signal.aborted, true);
  assert.equal(platform.stats().queued, 0);
  release.resolve();
  await platform.whenIdle();
  assert.equal(calls, 1);
  assert.equal(platform.stats().failed, 0);
  assert.equal(platform.stats().parsed, 0);
  assert.equal(platform.snapshot().entities.some(value => value.kind === 'variable'), false);
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  assert.equal(calls, 3);
  assert.equal(platform.snapshot().entities.filter(value => value.kind === 'variable').length, 2);
});

test('lineage is checked again inside serialized acceptance after asynchronous revalidation', async t => {
  const waiting = gate(), release = gate();
  let first = true;
  const { platform, capture } = await fixture(t, {
    accept: async operation => {
      if (first) { first = false; waiting.resolve(); await release.promise; }
      operation();
    },
  });
  platform.observeLineage({ id: 'lineage-one', status: 'available' });
  platform.observeArtifacts(await capture(await platform.discover()));
  await waiting.promise;
  platform.observeLineage({ id: 'lineage-two', status: 'available' });
  platform.observeArtifacts(await capture(['sample.js']));
  release.resolve();
  await platform.whenIdle();
  assert.equal(platform.stats().stale, 1);
  assert.equal(platform.stats().parsed, 1);
  assert.equal(platform.snapshot().entities.filter(value => value.kind === 'function').length, 1);
});

test('idle inventory scans and source reconciliations do not create model activity or revisions', async t => {
  let now = 100, calls = 0;
  const { platform, capture, evidence } = await fixture(t, {
    now: () => now, extract: input => { calls++; return extractStructure(input); },
  });
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  const baseline = platform.snapshot();
  for (let pass = 0; pass < 3; pass++) {
    now += 6000;
    platform.observeArtifacts(await capture(await platform.discover()));
    platform.observeArtifacts(await evidence.reconcile({ limit: 32 }));
    await platform.whenIdle();
    assert.deepEqual(platform.snapshot(), baseline);
  }
  assert.equal(calls, 1);
});

test('a retry can finish cache admission when its structure was already applied', async t => {
  let fail = true;
  const { platform, capture } = await fixture(t, {
    accept: operation => {
      operation();
      if (fail) { fail = false; throw new Error('AFTER_ACCEPT'); }
    },
  });
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  assert.equal(platform.stats().deferred, 1);
  const revision = platform.snapshot().revision;
  platform.observeArtifacts(await capture(await platform.discover()));
  await platform.whenIdle();
  assert.equal(platform.stats().deferred, 0);
  assert.equal(platform.stats().parsed, 1);
  assert.equal(platform.snapshot().revision, revision);
});
