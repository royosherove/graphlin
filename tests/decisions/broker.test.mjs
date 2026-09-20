import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisBroker } from '../../runtime/decisions/broker.mjs';
import { createDecisionService } from '../../runtime/decisions/index.mjs';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { createPolicy } from '../../runtime/core/privacy.mjs';
import { opaque } from '../../runtime/core/common.mjs';
import { c4Scene } from '../../runtime/visualizers/c4.mjs';
import { structure, sourceHash } from '../model/fixtures.mjs';
import { createRecordedProvider } from './recorded-provider.mjs';
import { jevProvider } from './jev-provider.mjs';

const projectId = 'project-analysis';
const extensionId = 'example.boundaries';
const digest = 'a'.repeat(64);
const namespace = `${extensionId}.architecture`;
const profile = {
  id: 'architecture',
  questions: [
    { id: 'supported', kind: 'boolean', question: 'Is the supplied structural boundary supported?' },
    { id: 'area', kind: 'choice', question: 'Which supplied area describes the selected entities?',
      options: ['runtime', 'unknown'] },
    { id: 'support', kind: 'score', question: 'How strongly do the supplied observations support the boundary?' },
  ],
  selectors: { fields: ['entities', 'relations'], candidateIds: [] },
  namespace,
};
const grant = {
  projectId, extensionId, digest, approved: true, fields: ['entities', 'relations', 'interpretations'],
  history: false, profiles: ['architecture'], grantedAt: '2026-09-20T10:00:00.000Z',
};

function fixture(t, { provider, modelOptions = {}, service: injectedService } = {}) {
  let policy = createPolicy({ transmitSource: true });
  let currentGrant = structuredClone(grant);
  let installed = {
    digest, manifest: { id: extensionId, capabilities: ['model.read', 'analysis.request'] },
    profiles: [structuredClone(profile)],
  };
  const model = { ...createProjectModel({ projectId, policy: () => policy, ...modelOptions }) };
  const initial = { ...structure(), relativePath: 'src/demo.js' };
  model.observeStructure(initial);
  const calls = { evaluate: [], assets: 0, grants: 0 };
  const delegate = injectedService ?? createDecisionService({ provider: provider ?? createRecordedProvider() });
  t.after(() => delegate.close?.());
  const service = { async evaluate(input) {
    calls.evaluate.push(structuredClone({ ...input, signal: undefined }));
    return delegate.evaluate(input);
  } };
  const registry = {
    async getAssets(id, options) {
      calls.assets++;
      assert.equal(id, extensionId);
      assert.deepEqual(options, { digest });
      return structuredClone(installed);
    },
    async getGrant(id) {
      calls.grants++;
      assert.equal(id, extensionId);
      return structuredClone(currentGrant);
    },
  };
  const run = createAnalysisBroker({ service, model, policy: () => policy, projectId, registry });
  return {
    model, registry, calls, service, run, initial,
    get policy() { return policy; },
    setPolicy(value) { policy = createPolicy(value); },
    revoke() { currentGrant = null; },
    setGrant(value) { currentGrant = value; },
    setInstalled(value) { installed = value; },
    request(overrides = {}) {
      return {
        projectId, extensionId, digest, profile: structuredClone(profile), entityIds: ['class-a'],
        revision: model.snapshot().revision, grant: structuredClone(grant), ...overrides,
      };
    },
  };
}

function assertRecorded(result, model, count = 3) {
  assert.equal(result.status, 'complete');
  assert.deepEqual(Object.keys(result).sort(), ['interpretationIds', 'requestId', 'status']);
  assert.match(result.requestId, /^analysis-[a-f0-9]{32}$/);
  assert.equal(result.interpretationIds.length, count);
  const snapshot = model.snapshot();
  const records = result.interpretationIds.map(id => snapshot.interpretations.find(value => value.id === id));
  assert.ok(records.every(record => record?.namespace === namespace && record.validity === 'current' && record.version === digest));
  return records;
}

for (const [name, makeProvider] of [
  ['recorded', () => createRecordedProvider()], ['jev', jevProvider],
]) {
  test(`${name}: broker records exact current namespaced interpretations through the shared neutral service`, async t => {
    const provider = makeProvider();
    const app = fixture(t, { provider });
    const request = app.request();
    const untouched = structuredClone(request);
    const result = await app.run(request);
    assert.deepEqual(request, untouched);
    const records = assertRecorded(result, app.model);
    assert.ok(records.every(value => value.support === 'supported'));
    assert.ok(records.every(value => value.basis === 'decision' && value.classification === 'accepted'));
    assert.ok(records.every(value => value.sourceRefs[0].artifactId === 'artifact-demo'
      && value.sourceRefs[0].hash === sourceHash(1) && value.sourceRefs[0].generation === 1));
    assert.equal(provider.calls.length, 1);
    assert.equal(app.calls.evaluate.length, 1);
    assert.equal(app.calls.grants, 3);
    const sent = app.calls.evaluate[0];
    assert.deepEqual(sent.profile, { id: namespace, version: digest });
    assert.deepEqual(sent.questions[1].options, [
      { id: 'option-0', label: 'runtime' }, { id: 'option-1', label: 'unknown' },
    ]);
    assert.deepEqual(sent.questions[2].options, ['Low', 'High']);
    assert.deepEqual(sent.state.context.entityIds, ['class-a']);
    assert.equal(sent.cacheContext.projectId, projectId);
    assert.equal(sent.cacheContext.worktreeId, projectId);
    assert.doesNotMatch(JSON.stringify(sent.state), /src\/demo|sourceRefs|sourceHash|extractor|generation|qualifiedName/);
  });
}

test('deterministic values without probabilities record unknown, never supported interpretations', async t => {
  const provider = createRecordedProvider({
    capabilities: { boolean: {}, choice: {}, score: {} },
    execute: async () => ({
      answers: {
        'question-0': { type: 'boolean', value: true },
        'question-1': { type: 'choice', choice: 'option-0' },
        'question-2': { type: 'score', score: 1 },
      },
    }),
  });
  const app = fixture(t, { provider });
  const records = assertRecorded(await app.run(app.request()), app.model);
  assert.ok(records.every(record => record.support === 'unknown' && record.classification === 'unknown' && record.label === 'Unknown'));
  assert.ok(records.every(record => record.sourceRefs.length === 1));
});

test('metadata entities without references can receive only unknown interpretations', async t => {
  const app = fixture(t);
  const root = app.model.snapshot().entities.find(value => value.kind === 'project');
  const records = assertRecorded(await app.run(app.request({ entityIds: [root.id] })), app.model);
  assert.ok(records.every(record => record.support === 'unknown' && record.sourceRefs.length === 0));
});

test('hidden evidence display still returns actual records under the core label projection', async t => {
  const app = fixture(t);
  app.setPolicy({ transmitSource: true, displayEvidence: false });
  const records = assertRecorded(await app.run(app.request()), app.model);
  assert.ok(records.every(record => record.label === 'Interpretation'));
  assert.equal(app.calls.evaluate[0].state.entities[0].label, 'class');
});

test('current source consent, exact project, profile, canonical IDs and grants are required before evaluation', async t => {
  const cases = [
    app => app.setPolicy({ readSource: true, transmitSource: false }),
    app => app.revoke(),
    app => app.setGrant({ ...grant, approved: false }),
    app => app.setGrant({ ...grant, digest: 'b'.repeat(64) }),
    app => app.setGrant({ ...grant, profiles: [] }),
    app => app.setGrant({ ...grant, fields: ['entities'] }),
    app => app.setGrant({ ...grant, grantedAt: '2026-09-20T10:01:00.000Z' }),
    app => app.setInstalled({ digest: 'b'.repeat(64), manifest: { id: extensionId, capabilities: ['analysis.request'] }, profiles: [profile] }),
    app => app.setInstalled({ digest, manifest: { id: extensionId, capabilities: ['model.read'] }, profiles: [profile] }),
  ];
  for (const mutate of cases) {
    const app = fixture(t);
    const request = app.request();
    mutate(app);
    assert.deepEqual(await app.run(request), { status: 'unavailable' });
    assert.equal(app.calls.evaluate.length, 0);
    assert.deepEqual(app.model.snapshot().interpretations, []);
  }
  for (const override of [
    { projectId: 'other-project' },
    { revision: -1 },
    { revision: 999 },
    { entityIds: ['not-a-canonical-entity'] },
    { entityIds: ['class-a', 'class-a'] },
    { entityIds: [] },
    { profile: { ...profile, questions: [{ ...profile.questions[0], question: 'Changed question' }] } },
    { profile: { ...profile, namespace: 'another.extension.profile' } },
    { grant: { ...grant, projectId: 'other-project' } },
    { rawSource: 'EXTRA_CALLBACK_FIELD' },
  ]) {
    const app = fixture(t);
    assert.deepEqual(await app.run(app.request(override)), { status: 'unavailable' });
    assert.equal(app.calls.evaluate.length, 0);
  }
});

test('installed selectors constrain the requested scope', async t => {
  const app = fixture(t);
  const scoped = { ...profile, selectors: { fields: ['entities'], candidateIds: ['class-b'] } };
  app.setInstalled({ digest, manifest: { id: extensionId, capabilities: ['analysis.request'] }, profiles: [scoped] });
  const refused = await app.run(app.request({ profile: scoped }));
  assert.deepEqual(refused, { status: 'unavailable' });
  assert.equal(app.calls.evaluate.length, 0);
  assertRecorded(await app.run(app.request({ profile: scoped, entityIds: ['class-b'] })), app.model);
});

test('revocation, policy changes, package updates and model revisions during evaluation prevent admission', async t => {
  for (const mutation of ['revoke', 'policy', 'package', 'revision', 'refs']) {
    let app;
    const provider = createRecordedProvider({ transform(value) {
      if (mutation === 'revoke') app.revoke();
      if (mutation === 'policy') app.setPolicy({ transmitSource: false });
      if (mutation === 'package') app.setInstalled({ digest: 'b'.repeat(64), manifest: { id: extensionId, capabilities: ['analysis.request'] }, profiles: [profile] });
      if (mutation === 'revision') app.model.setSessions([{ id: 'concurrent-session', host: 'demo' }]);
      if (mutation === 'refs') app.model.invalidateArtifacts([{
        id: 'artifact-demo', generation: 2, hash: sourceHash(2), status: 'present', complete: true,
      }]);
      return value;
    } });
    app = fixture(t, { provider });
    assert.deepEqual(await app.run(app.request()), { status: 'unavailable' }, mutation);
    assert.equal(app.calls.evaluate.length, 1);
    assert.deepEqual(app.model.snapshot().interpretations, [], mutation);
  }
});

test('post-admission revocation never returns IDs after the grant is lost', async t => {
  const app = fixture(t);
  const original = app.registry.getGrant;
  app.registry.getGrant = async id => {
    if (app.calls.grants === 2) app.revoke();
    return original(id);
  };
  assert.deepEqual(await app.run(app.request()), { status: 'unavailable' });
  assert.equal(app.model.snapshot().interpretations.length, 3, 'the write occurred while authorization was current');
});

test('stale, public-intent, changed or excluded references cannot support analysis', async t => {
  for (const change of ['stale', 'public-intent', 'version-without-revision', 'excluded']) {
    const app = fixture(t);
    if (change === 'stale') {
      app.model.invalidateArtifacts([{ id: 'artifact-demo', generation: 2, hash: sourceHash(2), status: 'present' }]);
    } else if (change === 'excluded') {
      app.setPolicy({ transmitSource: true, excludePaths: ['src/**'] });
    } else {
      const original = app.model.snapshot;
      app.model.snapshot = () => {
        const snapshot = original();
        const entity = snapshot.entities.find(value => value.id === 'class-a');
        if (change === 'public-intent') entity.sourceRefs[0].sourceClass = 'public_intent';
        else entity.sourceRefs[0].generation = 2;
        return snapshot;
      };
    }
    assert.deepEqual(await app.run(app.request()), { status: 'unavailable' }, change);
    assert.equal(app.calls.evaluate.length, 0);
  }
});

test('replay snapshots and missing artifact paths cannot authorize metadata transmission', async t => {
  for (const change of ['replay', 'checkpoint', 'missing-path']) {
    const app = fixture(t);
    const original = app.model.snapshot;
    app.model.snapshot = () => {
      const snapshot = original();
      if (change === 'replay') snapshot.replay = true;
      else if (change === 'checkpoint') snapshot.checkpointId = 'older-checkpoint';
      else delete snapshot.coverage.artifacts[0].relativePath;
      return snapshot;
    };
    assert.deepEqual(await app.run(app.request()), { status: 'unavailable' }, change);
    assert.equal(app.calls.evaluate.length, 0);
  }
});

test('metadata byte and relation bounds refuse evaluation without silently widening or truncating scope', async t => {
  for (const change of ['metadata-bytes', 'relations']) {
    const app = fixture(t);
    const original = app.model.snapshot;
    const extraId = index => `extra-${index}-${'a'.repeat(140)}`;
    app.model.snapshot = () => {
      const snapshot = original();
      const entity = snapshot.entities.find(value => value.id === 'class-a');
      snapshot.entities.push(...Array.from({ length: 128 }, (_, index) => ({
        ...entity, id: extraId(index), label: 'a'.repeat(80),
      })));
      if (change === 'relations') {
        snapshot.relations.push(...Array.from({ length: 129 }, (_, index) => ({
          id: `relation-${index}`, source: 'class-a', target: 'class-b',
          kind: 'uses', basis: 'parsed', validity: 'current', sourceRefs: entity.sourceRefs,
        })));
      }
      return snapshot;
    };
    const entityIds = change === 'metadata-bytes'
      ? Array.from({ length: 128 }, (_, index) => extraId(index)) : ['class-a', 'class-b'];
    assert.deepEqual(await app.run(app.request({ entityIds })), { status: 'unavailable' }, change);
    assert.equal(app.calls.evaluate.length, 0);
  }
});

test('metadata filtering strips raw fields, local paths and secret-bearing display labels', async t => {
  const app = fixture(t);
  const original = app.model.snapshot;
  app.model.snapshot = () => {
    const snapshot = original();
    const entity = snapshot.entities.find(value => value.id === 'class-a');
    entity.label = 'password="SYNTHETIC_PRIVATE_LABEL"';
    entity.code = 'RAW_SOURCE_SENTINEL';
    entity.path = '/private/SYNTHETIC_LOCAL_PATH';
    entity.qualifiedName = '/private/SYNTHETIC_QUALIFIED_PATH';
    return snapshot;
  };
  const records = assertRecorded(await app.run(app.request()), app.model);
  const transmitted = JSON.stringify(app.calls.evaluate[0]);
  assert.doesNotMatch(transmitted, /SYNTHETIC_PRIVATE_LABEL|RAW_SOURCE_SENTINEL|SYNTHETIC_LOCAL_PATH|SYNTHETIC_QUALIFIED_PATH/);
  assert.equal(app.calls.evaluate[0].state.entities[0].label, 'Entity');
  assert.ok(records.every(record => record.support === 'unknown'));
});

test('secret-bearing approved profile text is rejected locally, not transmitted', async t => {
  const app = fixture(t);
  const unsafe = { ...profile, questions: [{
    id: 'unsafe', kind: 'boolean', question: 'Does password="SYNTHETIC_PROFILE_SECRET" configure this component?',
  }] };
  app.setInstalled({ digest, manifest: { id: extensionId, capabilities: ['analysis.request'] }, profiles: [unsafe] });
  assert.deepEqual(await app.run(app.request({ profile: unsafe })), { status: 'unavailable' });
  assert.equal(app.calls.evaluate.length, 0);
});

test('capacity refusal returns only IDs actually retained by core in the requested namespace', async t => {
  const app = fixture(t, { modelOptions: { limits: { interpretations: 1 } } });
  assertRecorded(await app.run(app.request()), app.model, 1);
  const refused = fixture(t);
  refused.model.observeInterpretations = () => refused.model.stats();
  assert.deepEqual(await refused.run(refused.request()), { status: 'unavailable' });
});

test('unavailable, malformed and malicious service responses cannot fabricate IDs or leak fields', async t => {
  for (const value of [
    { status: 'unavailable', requestId: 'PRIVATE_REQUEST', interpretationIds: ['fake'] },
    { status: 'accepted', answers: [] },
    { status: 'accepted', answers: [
      { id: 'question-0', kind: 'boolean', value: true, probability: 0.99 },
      { id: 'question-1', kind: 'choice', value: 'invented', probabilities: null, confidence: null },
      { id: 'question-2', kind: 'score', value: 2, probabilities: null, confidence: null },
    ] },
  ]) {
    const app = fixture(t, { service: { evaluate: async () => value } });
    assert.deepEqual(await app.run(app.request()), { status: 'unavailable' });
    assert.deepEqual(app.model.snapshot().interpretations, []);
  }
});

test('cancellation stops a stalled provider without adding broker queues or retained results', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const provider = createRecordedProvider({ transform() { entered(); return new Promise(() => {}); } });
  const app = fixture(t, { provider });
  const controller = new AbortController();
  const pending = app.run(app.request({ signal: controller.signal }));
  await started;
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  assert.deepEqual(await pending, { status: 'unavailable' });
  assert.equal(provider.calls[0].context.signal.aborted, true);
  assert.deepEqual(app.model.snapshot().interpretations, []);
});

test('namespace isolation prevents an unrelated existing interpretation ID from being returned', async t => {
  const app = fixture(t);
  app.model.observeInterpretations([{
    id: 'other-answer', namespace: 'other.extension.profile', kind: 'analysis-boolean',
    label: 'Supported', entityIds: ['class-a'], sourceRefs: app.model.snapshot().entities.find(e => e.id === 'class-a').sourceRefs,
    validity: 'current', classification: 'accepted', support: 'supported', version: digest,
  }]);
  const otherId = opaque('interpretation', projectId, 'other.extension.profile', 'other-answer');
  const result = await app.run(app.request());
  assertRecorded(result, app.model);
  assert.ok(!result.interpretationIds.includes(otherId));
});

const c4Question = {
  id: 'role', kind: 'choice', question: 'Which supplied boundary is supported?',
  options: ['application', 'unknown'], interpretationKind: 'selected-choice',
};
function semanticRequest(app, question = c4Question, overrides = {}) {
  const selected = { ...profile, questions: [question] };
  app.setInstalled({ digest, manifest: { id: extensionId, capabilities: ['analysis.request'] }, profiles: [selected] });
  return app.request({ ...overrides, profile: structuredClone(selected) });
}

test('fixed granted semantic kinds use core or bounded profile labels rather than answer labels', async t => {
  for (const question of [
    { id: 'boundary', kind: 'boolean', question: 'Is the application boundary supported?',
      interpretationKind: 'application', interpretationLabel: 'Order processing' },
    { id: 'boundary', kind: 'score', question: 'How strongly is the component boundary supported?',
      interpretationKind: 'component' },
    { ...c4Question, interpretationKind: 'component' },
  ]) {
    const provider = createRecordedProvider({ transform(value) {
      // Provider-added semantic declarations have no authority.
      value.answers['question-0'].interpretationKind = 'external_system';
      value.answers['question-0'].label = 'PROVIDER_OUTPUT_LABEL';
      return value;
    } });
    const app = fixture(t, { provider });
    const request = semanticRequest(app, question);
    const [record] = assertRecorded(await app.run(request), app.model, 1);
    assert.equal(record.kind, question.interpretationKind);
    assert.equal(record.label, question.interpretationLabel ?? 'Alpha');
    assert.equal(record.support, 'supported');
    assert.equal(record.classification, 'accepted');
    assert.deepEqual(record.sourceRefs, app.model.snapshot().entities.find(value => value.id === 'class-a').sourceRefs);
    assert.doesNotMatch(JSON.stringify(app.calls.evaluate[0]), /interpretationKind|interpretationLabel|Order processing/);
  }
});

test('semantic declarations cannot upgrade unknown, weak, missing-metric or contradicted answers', async t => {
  const mappedBoolean = { id: 'boundary', kind: 'boolean', question: 'Is the application boundary supported?',
    interpretationKind: 'application' };
  const mappedScore = { ...mappedBoolean, kind: 'score' };
  for (const [question, answer, support] of [
    [c4Question, { type: 'choice', choice: 'option-1',
      probabilities: { 'option-0': 0.02, 'option-1': 0.98 }, confidence: 0.95 }, 'unknown'],
    [c4Question, { type: 'choice', choice: 'option-0' }, 'unknown'],
    [c4Question, { type: 'choice', choice: 'option-0',
      probabilities: { 'option-0': 0.99, 'option-1': 0.01 }, confidence: 0.2 }, 'unknown'],
    [mappedBoolean, { type: 'boolean', value: true }, 'unknown'],
    [mappedBoolean, { type: 'boolean', probability: 0.6 }, 'unknown'],
    [mappedBoolean, { type: 'boolean', probability: 0.02 }, 'contradicted'],
    [mappedScore, { type: 'score', score: 1 }, 'unknown'],
    [mappedScore, { type: 'score', score: 0.01,
      probabilities: { 0: 0.99, 1: 0.01 }, confidence: 0.95 }, 'contradicted'],
  ]) {
    const provider = createRecordedProvider({ transform(value) {
      value.answers['question-0'] = answer;
      return value;
    } });
    const app = fixture(t, { provider });
    const [record] = assertRecorded(await app.run(semanticRequest(app, question)), app.model, 1);
    assert.equal(record.kind, `analysis-${question.kind}`);
    assert.equal(record.support, support);
    if (support === 'unknown') {
      assert.equal(record.classification, 'unknown');
      assert.equal(record.label, 'Unknown');
    }
    assert.match(c4Scene(app.model.snapshot()).coverage.label, /unknown/);
  }
  const app = fixture(t);
  const root = app.model.snapshot().entities.find(value => value.kind === 'project');
  const [record] = assertRecorded(await app.run(semanticRequest(app, c4Question, { entityIds: [root.id] })), app.model, 1);
  assert.equal(record.kind, 'analysis-choice');
  assert.equal(record.support, 'unknown');
  assert.deepEqual(record.sourceRefs, []);
  assert.match(c4Scene(app.model.snapshot()).coverage.label, /unknown/);
});

test('unmapped application choices remain generic and cannot implicitly populate C4', async t => {
  const app = fixture(t);
  const { interpretationKind, ...unmapped } = c4Question;
  const [record] = assertRecorded(await app.run(semanticRequest(app, unmapped)), app.model, 1);
  assert.equal(record.kind, 'analysis-choice');
  assert.equal(record.label, 'application');
  assert.equal(record.support, 'supported');
  assert.match(c4Scene(app.model.snapshot()).coverage.label, /unknown/);
  assert.equal(c4Scene(app.model.snapshot()).groups.some(value => value.membershipId === record.id), false);
});

test('semantic mappings and labels must match the current installed digest-granted profile before and after evaluation', async t => {
  for (const patch of [{ interpretationKind: 'component' }, { interpretationLabel: 'Different boundary' }]) {
    const app = fixture(t);
    const request = semanticRequest(app);
    request.profile.questions[0] = { ...c4Question, ...patch };
    assert.deepEqual(await app.run(request), { status: 'unavailable' });
    assert.equal(app.calls.evaluate.length, 0);
  }
  let app;
  const provider = createRecordedProvider({ transform(value) {
    app.setInstalled({
      digest, manifest: { id: extensionId, capabilities: ['analysis.request'] },
      profiles: [{ ...profile, questions: [{ ...c4Question, interpretationKind: 'component' }] }],
    });
    return value;
  } });
  app = fixture(t, { provider });
  assert.deepEqual(await app.run(semanticRequest(app)), { status: 'unavailable' });
  assert.equal(app.calls.evaluate.length, 1);
  assert.deepEqual(app.model.snapshot().interpretations, []);
});

test('semantic profile labels receive core secret, source and locator filtering before any provider call', async t => {
  for (const interpretationLabel of [
    'password="SYNTHETIC_BOUNDARY_LABEL"', '/private/SYNTHETIC_BOUNDARY_PATH', 'unsafe();',
  ]) {
    const app = fixture(t);
    assert.deepEqual(await app.run(semanticRequest(app, { ...c4Question, interpretationLabel })), { status: 'unavailable' });
    assert.equal(app.calls.evaluate.length, 0);
    assert.deepEqual(app.model.snapshot().interpretations, []);
  }
});

test('opaque model lineage binds cache provenance without sending branch or HEAD to the provider', async t => {
  const provider = createRecordedProvider();
  const app = fixture(t, { provider });
  const original = app.model.snapshot;
  app.model.snapshot = () => {
    const snapshot = original();
    snapshot.coverage.lineage = {
      id: 'lineage-current', status: 'git',
      branch: 'PRIVATE_SYNTHETIC_BRANCH', head: 'd'.repeat(40),
    };
    return snapshot;
  };
  assertRecorded(await app.run(app.request()), app.model);
  assert.equal(app.calls.evaluate[0].cacheContext.lineage, 'lineage-current');
  assert.doesNotMatch(JSON.stringify(provider.calls[0].request),
    /lineage-current|PRIVATE_SYNTHETIC_BRANCH|dddddddddddddddddddddddddddddddddddddddd/);
});

test('lineage changes reject in-flight results even with identical source and model revision', async t => {
  let lineage = 'lineage-before';
  const provider = createRecordedProvider({ transform(value) {
    lineage = 'lineage-after';
    return value;
  } });
  const app = fixture(t, { provider });
  const original = app.model.snapshot;
  app.model.snapshot = () => {
    const snapshot = original();
    snapshot.coverage.lineage = { id: lineage, status: 'git' };
    return snapshot;
  };
  const request = semanticRequest(app);
  assert.deepEqual(await app.run(request), { status: 'unavailable' });
  assert.equal(app.calls.evaluate[0].cacheContext.lineage, 'lineage-before');
  assert.equal(app.model.snapshot().revision, request.revision);
  assert.deepEqual(app.model.snapshot().interpretations, []);
  assert.equal(provider.calls.length, 1);
  assertRecorded(await app.run(semanticRequest(app)), app.model, 1);
  assert.equal(app.calls.evaluate[1].cacheContext.lineage, 'lineage-after');
  assert.notEqual(app.calls.evaluate[0].cacheContext.evidenceVersion, app.calls.evaluate[1].cacheContext.evidenceVersion);
  assert.equal(provider.calls.length, 2, 'the new lineage cannot reuse the old successful provider response');
  assert.deepEqual(provider.calls[0].request, provider.calls[1].request, 'the opaque lineage remains local');
});

test('post-admission lineage changes do not return old-lineage interpretation IDs', async t => {
  const app = fixture(t);
  let lineage = 'lineage-before';
  const snapshot = app.model.snapshot;
  app.model.snapshot = () => {
    const value = snapshot();
    value.coverage.lineage = { id: lineage, status: 'git' };
    return value;
  };
  const getGrant = app.registry.getGrant;
  app.registry.getGrant = async id => {
    if (app.calls.grants === 2) lineage = 'lineage-after';
    return getGrant(id);
  };
  assert.deepEqual(await app.run(semanticRequest(app)), { status: 'unavailable' });
});

test('legacy snapshots fall back to project lineage and malformed lineage IDs cannot enter evaluation', async t => {
  for (const lineage of [undefined, { id: '/private/SYNTHETIC_LINEAGE_PATH', status: 'git' }]) {
    const app = fixture(t);
    const original = app.model.snapshot;
    app.model.snapshot = () => {
      const snapshot = original();
      if (lineage === undefined) delete snapshot.coverage.lineage;
      else snapshot.coverage.lineage = lineage;
      return snapshot;
    };
    const result = await app.run(app.request());
    if (lineage === undefined) {
      assertRecorded(result, app.model);
      assert.equal(app.calls.evaluate[0].cacheContext.lineage, projectId);
    } else {
      assert.deepEqual(result, { status: 'unavailable' });
      assert.equal(app.calls.evaluate.length, 0);
    }
  }
});
