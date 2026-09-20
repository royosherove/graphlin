import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchitectureController } from '../../runtime/architecture/controller.mjs';

const artifact = (id, generation = 1, status = 'present') => ({
  id, generation, hash: status === 'present' ? String(generation).repeat(64) : null, status,
});
const result = (ids, extra = {}) => ({
  status: 'complete', interpretations: [], affectedEntityIds: [], sourceRefs: [],
  coverage: { analyzedArtifactIds: ids, deferredArtifactIds: [] }, ...extra,
});
const gate = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function fixture(t, options = {}) {
  const artifacts = new Map();
  const calls = [], commits = [];
  const controller = createArchitectureController({
    snapshot: () => ({ interpretations: [] }),
    capture: async ids => ids.flatMap(id => artifacts.has(id) ? [artifacts.get(id)] : []),
    analyze: async input => { calls.push(input); return result(input.affectedArtifactIds); },
    commit: async (...args) => { commits.push(args); return true; },
    settleMs: 60_000,
    ...options,
  });
  const observe = values => {
    for (const value of values) artifacts.set(value.id, value);
    controller.observe(values);
  };
  t.after(() => controller.close());
  return { controller, artifacts, calls, commits, observe };
}

test('source discovery coalesces into bounded jobs; unchanged scans are idle, manual retries all', async t => {
  const app = fixture(t);
  app.observe(Array.from({ length: 15 }, (_, i) => artifact(`file-${i}`)));
  await app.controller.whenIdle();
  assert.deepEqual(app.calls.map(call => call.artifacts.length), [6, 6, 3]);
  assert.equal(app.controller.status().pending, 0);
  assert.equal(app.controller.status().inspected, 15);
  app.observe([...app.artifacts.values()]);
  await app.controller.whenIdle();
  assert.equal(app.calls.length, 3);
  app.controller.request();
  await app.controller.whenIdle();
  assert.equal(app.calls.length, 6);
});

test('source changes cancel an old answer before commit, and refresh only the changed version', async t => {
  const entered = gate(), release = gate(), commits = [];
  let first = true;
  const app = fixture(t, {
    analyze: async input => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      return result(input.affectedArtifactIds, { affectedEntityIds: ['module'] });
    },
    commit: async (_result, context) => { commits.push(context); return true; },
  });
  app.observe([artifact('source')]);
  const idle = app.controller.whenIdle();
  await entered.promise;
  app.observe([artifact('source', 2)]);
  release.resolve();
  await idle;
  assert.equal(commits.length, 1);
  assert.equal(commits[0].artifacts[0].generation, 2);
  assert.equal(app.controller.status().pending, 0);
});

test('a source change while capture waits for parsing does not mark newer source inspected', async t => {
  const entered = gate(), release = gate(), analyzed = [];
  let first = true;
  const app = fixture(t, {
    capture: async () => {
      const value = app.artifacts.get('source');
      if (first) { first = false; entered.resolve(); await release.promise; }
      return [value];
    },
    analyze: async input => { analyzed.push(input.artifacts[0].generation); return result(input.affectedArtifactIds); },
  });
  app.observe([artifact('source')]);
  const idle = app.controller.whenIdle();
  await entered.promise;
  app.observe([artifact('source', 2)]);
  release.resolve();
  await idle;
  assert.deepEqual(analyzed, [2]);
  assert.equal(app.controller.status().pending, 0);
});

test('budget-deferred source moves to another batch and missing capture cannot loop', async t => {
  let count = 0;
  const app = fixture(t, {
    analyze: async input => {
      count++;
      assert.ok(count < 8, 'controller must terminate');
      const ids = input.affectedArtifactIds;
      return result(ids.slice(0, 2), {
        coverage: { analyzedArtifactIds: ids.slice(0, 2), deferredArtifactIds: ids.slice(2) },
      });
    },
  });
  app.observe(Array.from({ length: 7 }, (_, i) => artifact(`file-${i}`)));
  await app.controller.whenIdle();
  assert.equal(count, 4);
  assert.equal(app.controller.status().inspected, 7);
  const unavailable = fixture(t, {
    analyze: async input => result([], {
      status: 'unavailable',
      coverage: { analyzedArtifactIds: [], deferredArtifactIds: input.affectedArtifactIds },
    }),
  });
  unavailable.observe([artifact('gone')]);
  await unavailable.controller.whenIdle();
  assert.equal(unavailable.controller.status().pending, 0);
});

test('unavailable neighbors are attempted once per version rather than requeuing each other', async t => {
  const calls = [];
  const app = fixture(t, {
    analyze: async input => {
      calls.push(input);
      assert.ok(calls.length <= 2);
      return result([], { status: 'unavailable', coverage: {
        analyzedArtifactIds: [], unavailableArtifactIds: input.affectedArtifactIds,
        deferredArtifactIds: ['left', 'right'].filter(id => !input.affectedArtifactIds.includes(id)),
      } });
    },
  });
  app.observe([artifact('left'), artifact('right')]);
  await app.controller.whenIdle();
  assert.equal(calls.length, 1);
  assert.equal(app.controller.status().pending, 0);
});

test('persistent admission rejection stops after a bounded retry', async t => {
  let commits = 0;
  const app = fixture(t, {
    analyze: async input => result(input.affectedArtifactIds, { affectedEntityIds: ['module'] }),
    commit: async () => { commits++; return false; },
  });
  app.observe([artifact('source')]);
  await app.controller.whenIdle();
  assert.equal(commits, 2);
  assert.equal(app.controller.status().pending, 0);
  assert.equal(app.controller.status().reason, 'source_changed');
});

test('partial model admission reports partial coverage instead of successful complete discovery', async t => {
  const app = fixture(t, {
    analyze: async input => result(input.affectedArtifactIds, { affectedEntityIds: ['module'] }),
    commit: async () => ({ accepted: true, omitted: 1 }),
  });
  app.observe([artifact('source')]);
  await app.controller.whenIdle();
  assert.equal(app.controller.status().status, 'partial');
  assert.equal(app.controller.status().reason, 'partial_coverage');
  assert.equal(app.controller.status().omitted, 1);
  assert.equal(app.controller.status().pending, 0);
});

test('repeatedly deferred membership is bounded and explicitly reports partial coverage', async t => {
  let calls = 0;
  const app = fixture(t, {
    analyze: async input => {
      assert.ok(++calls <= 3, 'rejected earlier pairs must not starve an endless tail');
      return result(input.affectedArtifactIds, {
        status: 'partial', coverage: {
          analyzedArtifactIds: input.affectedArtifactIds, deferredArtifactIds: [],
          deferredMembershipArtifactIds: input.affectedArtifactIds,
        },
      });
    },
  });
  app.observe([artifact('shared-component')]);
  await app.controller.whenIdle();
  assert.equal(calls, 3);
  assert.equal(app.controller.status().pending, 0);
  assert.equal(app.controller.status().omitted, 1);
  assert.equal(app.controller.status().status, 'partial');
});

test('confirmed missing artifacts reach guarded commit even when their entities have been evicted', async t => {
  const app = fixture(t, {
    analyze: async input => result([], {
      coverage: { analyzedArtifactIds: [], missingArtifactIds: input.affectedArtifactIds },
    }),
  });
  app.observe([artifact('source', 2, 'missing')]);
  await app.controller.whenIdle();
  assert.equal(app.commits.length, 1);
  assert.equal(app.commits[0][1].artifacts[0].status, 'missing');
});

test('consent, pause, and parser readiness gate automatic and manual calls', async t => {
  let blocked = 'source_consent_required', ready = false;
  const app = fixture(t, { available: () => blocked, ready: () => ready });
  app.observe([artifact('source')]);
  app.controller.request();
  await app.controller.whenIdle();
  assert.equal(app.calls.length, 0);
  assert.equal(app.controller.status().reason, blocked);
  blocked = null;
  await app.controller.whenIdle();
  assert.equal(app.calls.length, 0);
  ready = true;
  await app.controller.whenIdle();
  assert.equal(app.calls.length, 1);
});

test('lineage invalidation discards active answers and retries current sources', async t => {
  const entered = gate(), release = gate();
  let count = 0, committed = 0;
  const app = fixture(t, {
    analyze: async input => {
      if (++count === 1) { entered.resolve(); await release.promise; }
      return result(input.affectedArtifactIds, { affectedEntityIds: ['module'] });
    },
    commit: async () => { committed++; return true; },
  });
  app.observe([artifact('source')]);
  const idle = app.controller.whenIdle();
  await entered.promise;
  app.controller.invalidate();
  release.resolve();
  await idle;
  assert.equal(count, 2);
  assert.equal(committed, 1);
});

test('closing cancels analysis, leaves no pending work, and does not accept a late result', async t => {
  const entered = gate(), release = gate();
  const app = fixture(t, {
    analyze: async input => {
      entered.resolve();
      await release.promise;
      return result(input.affectedArtifactIds, { affectedEntityIds: ['module'] });
    },
  });
  app.observe([artifact('source')]);
  const idle = app.controller.whenIdle();
  await entered.promise;
  const closing = app.controller.close();
  release.resolve();
  await Promise.all([idle, closing]);
  assert.equal(app.commits.length, 0);
  assert.equal(app.controller.status().pending, 0);
});
