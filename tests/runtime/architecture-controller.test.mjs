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

test('a rejecting old capture preserves the newer pending version for analysis', async t => {
  const entered = gate(), release = gate(), analyzed = [];
  let first = true, ready = true;
  const app = fixture(t, {
    ready: () => ready,
    capture: async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
        ready = false;
        throw new Error('synthetic old capture failure');
      }
      return [app.artifacts.get('source')];
    },
    analyze: async input => {
      analyzed.push(input.artifacts[0].generation);
      return result(input.affectedArtifactIds);
    },
  });
  app.observe([artifact('source')]);
  const idle = app.controller.whenIdle();
  await entered.promise;
  app.observe([artifact('source', 2)]);
  release.resolve();
  await idle;
  assert.equal(app.controller.status().pending, 1);
  assert.equal(app.controller.status().attempted, 0);
  assert.equal(app.controller.status().unavailable, 0);
  assert.deepEqual(analyzed, []);
  ready = true;
  await app.controller.whenIdle();
  assert.deepEqual(analyzed, [2]);
  assert.equal(app.controller.status().status, 'complete');
  assert.equal(app.controller.status().pending, 0);
  assert.equal(app.controller.status().attempted, 1);
  assert.equal(app.controller.status().analyzed, 1);
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

test('privacy and unsupported coverage count attempts separately from analysis and reset on a new version', async t => {
  const diagnostics = [];
  let recovered = false;
  const app = fixture(t, {
    onDiagnostic: value => diagnostics.push(value),
    analyze: async input => recovered ? result(input.affectedArtifactIds) : result([], {
      status: 'unavailable', diagnostics: { code: 'source_withheld', providerRequests: 0 },
      coverage: {
        analyzedArtifactIds: [], withheldArtifactIds: ['private'], unsupportedArtifactIds: ['metadata'],
        unavailableArtifactIds: input.affectedArtifactIds,
      },
    }),
  });
  app.observe([artifact('private'), artifact('metadata')]);
  await app.controller.whenIdle();
  const state = app.controller.status();
  assert.equal(state.status, 'partial');
  assert.equal(state.reason, 'source_withheld');
  assert.equal(state.inspected, 2);
  assert.equal(state.attempted, 2);
  assert.equal(state.analyzed, 0);
  assert.equal(state.withheld, 1);
  assert.equal(state.unsupported, 1);
  assert.equal(state.unavailable, 0);
  assert.equal(state.failures, 0);
  assert.deepEqual(diagnostics[0], {
    status: 'partial', code: 'source_withheld', reason: 'source_withheld', stage: 'analysis',
    attempted: 2, analyzed: 0, withheld: 1, unsupported: 1, unavailable: 0, deferred: 0, providerRequests: 0,
  });
  recovered = true;
  app.observe([artifact('private', 2)]);
  assert.equal(app.controller.status().withheld, 0, 'old-version withholding is not carried into new work');
  await app.controller.whenIdle();
  assert.equal(app.controller.status().analyzed, 1);
  assert.equal(app.controller.status().attempted, 2);
});

test('a provider failure remains a failure alongside withheld source', async t => {
  const app = fixture(t, {
    analyze: async () => result([], {
      status: 'unavailable', diagnostics: { code: 'analysis_failed', failureCode: 'authentication_failed' },
      coverage: { analyzedArtifactIds: [], withheldArtifactIds: ['private'], failedArtifactIds: ['source'] },
    }),
  });
  app.observe([artifact('private'), artifact('source')]);
  await app.controller.whenIdle();
  const state = app.controller.status();
  assert.equal(state.reason, 'analysis_failed');
  assert.equal(state.status, 'unavailable');
  assert.equal(state.withheld, 1);
  assert.equal(state.unavailable, 1);
  assert.equal(state.analyzed, 0);
  assert.equal(state.failures, 1);
});

test('a successful sibling does not retain partial coverage after only the failed artifact recovers', async t => {
  const analyzed = [];
  const app = fixture(t, {
    analyze: async input => {
      const ids = input.affectedArtifactIds;
      analyzed.push(ids);
      if (input.artifacts.some(value => value.id === 'failed' && value.generation === 1)) {
        return result(['successful'], {
          status: 'partial', diagnostics: { code: 'analysis_failed' },
          coverage: { analyzedArtifactIds: ['successful'], failedArtifactIds: ['failed'],
            unavailableArtifactIds: ['failed'], omittedCandidates: 0 },
        });
      }
      return result(ids);
    },
  });
  app.observe([artifact('successful'), artifact('failed')]);
  await app.controller.whenIdle();
  assert.equal(app.controller.status().reason, 'analysis_failed');
  assert.equal(app.controller.status().analyzed, 1);
  assert.equal(app.controller.status().unavailable, 1);
  app.observe([artifact('failed', 2)]);
  await app.controller.whenIdle();
  assert.deepEqual(analyzed, [['successful', 'failed'], ['failed']]);
  assert.equal(app.controller.status().analyzed, 2);
  assert.equal(app.controller.status().unavailable, 0);
  assert.equal(app.controller.status().status, 'complete');
  assert.equal(app.controller.status().reason, 'none_supported');
});

test('later successful batches preserve current-version withholding and failure until the affected files recover', async t => {
  let recovered = false;
  const app = fixture(t, {
    analyze: async input => {
      const ids = input.affectedArtifactIds;
      if (recovered) return result(ids);
      const withheld = ids.filter(id => id === 'private'), failures = ids.filter(id => id === 'failed');
      return result(ids.filter(id => !withheld.includes(id) && !failures.includes(id)), {
        status: withheld.length || failures.length ? 'partial' : 'complete',
        diagnostics: { code: failures.length ? 'analysis_failed' : withheld.length ? 'source_withheld' : 'architecture_unknown' },
        coverage: {
          analyzedArtifactIds: ids.filter(id => !withheld.includes(id) && !failures.includes(id)),
          withheldArtifactIds: withheld, failedArtifactIds: failures,
        },
      });
    },
  });
  app.observe(['private', ...Array.from({ length: 7 }, (_, i) => `valid-${i}`)].map(id => artifact(id)));
  await app.controller.whenIdle();
  assert.equal(app.controller.status().status, 'partial');
  assert.equal(app.controller.status().reason, 'source_withheld');
  assert.equal(app.controller.status().withheld, 1);
  assert.equal(app.controller.status().analyzed, 7);

  app.observe(['failed', ...Array.from({ length: 7 }, (_, i) => `more-${i}`)].map(id => artifact(id)));
  await app.controller.whenIdle();
  assert.equal(app.controller.status().reason, 'analysis_failed');
  assert.equal(app.controller.status().withheld, 1);
  assert.equal(app.controller.status().unavailable, 1);
  recovered = true;
  app.observe([artifact('failed', 2)]);
  await app.controller.whenIdle();
  assert.equal(app.controller.status().reason, 'source_withheld', 'only the recovered version loses its failure');
  app.controller.request();
  await app.controller.whenIdle();
  assert.equal(app.controller.status().status, 'complete');
  assert.equal(app.controller.status().withheld, 0);
  assert.equal(app.controller.status().unavailable, 0);
  assert.equal(app.controller.status().analyzed, 16);
});

test('budget-only deferrals are incomplete rather than attempted, analyzed or failed', async t => {
  const diagnostics = [];
  const app = fixture(t, {
    onDiagnostic: value => diagnostics.push(value),
    analyze: async input => result([], {
      status: 'unavailable', diagnostics: { code: 'architecture_partial' },
      coverage: { deferredArtifactIds: input.affectedArtifactIds },
    }),
  });
  app.observe([artifact('large')]);
  await app.controller.whenIdle();
  const state = app.controller.status();
  assert.equal(state.status, 'partial');
  assert.equal(state.reason, 'partial_coverage');
  assert.equal(state.inspected, 0);
  assert.equal(state.attempted, 0);
  assert.equal(state.analyzed, 0);
  assert.equal(state.unavailable, 0);
  assert.equal(state.failures, 0);
  assert.equal(state.total, 1);
  assert.equal(diagnostics[0].attempted, 0);
  assert.equal(diagnostics[0].deferred, 1);
});

test('capture, analysis and commit exceptions emit fixed safe diagnostics and permit a bounded manual retry', async t => {
  for (const stage of ['capture', 'analysis', 'commit']) await t.test(stage, async t => {
    const diagnostics = [];
    let fail = true, calls = 0;
    const app = fixture(t, {
      onDiagnostic: value => diagnostics.push(value),
      [stage === 'analysis' ? 'analyze' : stage]: async () => {
        calls++;
        if (fail) throw new Error('SYNTHETIC_PRIVATE_EXCEPTION_BODY');
        if (stage === 'capture') return [artifact('source')];
        if (stage === 'analysis') return result(['source']);
        return true;
      },
      ...(stage === 'commit' ? { analyze: async () => result(['source'], { affectedEntityIds: ['module'] }) } : {}),
    });
    app.observe([artifact('source')]);
    await app.controller.whenIdle();
    const last = diagnostics.at(-1);
    assert.equal(last.stage, stage);
    assert.equal(last.code, `architecture_${stage}_failed`);
    assert.equal(last.attempted, 1);
    assert.equal(last.unavailable, 1);
    assert.equal(app.controller.status().reason, 'analysis_failed');
    assert.equal(app.controller.status().pending, 0);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(diagnostics), /SYNTHETIC_PRIVATE_EXCEPTION_BODY/);
    fail = false;
    app.controller.request();
    await app.controller.whenIdle();
    assert.equal(calls, 2);
    assert.equal(app.controller.status().analyzed, 1);
  });
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
