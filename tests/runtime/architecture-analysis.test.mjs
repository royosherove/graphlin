import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  analyzeArchitecture, ARCHITECTURE_PROFILES, ARCHITECTURE_NAMESPACE, ARCHITECTURE_LIMITS,
} from '../../runtime/architecture/analysis.mjs';
import { createDecisionService } from '../../runtime/decisions/index.mjs';
import { EvidenceStore } from '../../runtime/core/evidence.mjs';
import { createPolicy } from '../../runtime/core/privacy.mjs';
import { opaque, hash } from '../../runtime/core/common.mjs';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { extractStructure } from '../../runtime/discovery/structure.mjs';
import { createRecordedProvider } from '../decisions/recorded-provider.mjs';
import { jevProvider } from '../decisions/jev-provider.mjs';

const projectId = opaque('project', 'synthetic-architecture');
const applicationSource = [
  "import { createServer } from 'node:http';",
  "import { orders } from './orders.js';",
  'export function startServer() {',
  '  const server = createServer(orders);',
  '  server.listen(8080);',
  '  return server;',
  '}',
].join('\n');
const componentSource = [
  'export function orders(request, response) {',
  "  response.end('Synthetic order response');",
  '}',
].join('\n');

async function fixture(t, { providerFactory = createRecordedProvider, transform, files, rolesByPath = {} } = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin-architecture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceFiles = files ?? { 'main.js': applicationSource, 'orders.js': componentSource };
  const policy = createPolicy({ transmitSource: true });
  const model = createProjectModel({ projectId, policy });
  const evidence = new EvidenceStore({ projectRoot: root, policy });
  const roles = new Map([[applicationSource, 'application'], [componentSource, 'component']]);
  const captures = new Map();
  model.observeInventory({
    entries: Object.keys(sourceFiles).map(relativePath => ({
      relativePath, kind: 'file', size: sourceFiles[relativePath].length, mtimeMs: 0, root: '',
    })),
    coverage: { total: Object.keys(sourceFiles).length, complete: true },
  });
  async function update(relativePath, text, role = roles.get(text) ?? 'unknown') {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), text);
    roles.set(text, role);
    const [capture] = await evidence.capture([relativePath]);
    const structure = await extractStructure({
      artifactId: capture.id, relativePath, text: capture.text, hash: capture.hash,
      generation: capture.generation, complete: capture.complete,
    });
    assert.equal(structure.enumeration.capability, 'parsed');
    assert.equal(structure.enumeration.complete, true);
    model.observeStructure({ ...structure, relativePath });
    captures.set(relativePath, capture);
    return capture;
  }
  for (const [name, text] of Object.entries(sourceFiles)) await update(name, text, rolesByPath[name] ?? roles.get(text) ?? 'unknown');
  const answer = async (value, request, call, context) => {
    if (request.questions.kind) {
      // Literal fixture answers to the actual source sent by the service, not a
      // production name/folder classifier. Tests do not call a live provider.
      const code = request.state.evidence.map(value => value.code).join('\n');
      const kind = roles.get(code) ?? 'unknown';
      value.answers.kind = {
        type: 'choice', choice: kind, confidence: 0.95,
        probabilities: Object.fromEntries(['application', 'component', 'unknown'].map(candidate =>
          [candidate, candidate === kind ? 0.97 : candidate === (kind === 'unknown' ? 'application' : 'unknown') ? 0.03 : 0])),
      };
      value.answers.supported = { type: 'boolean', probability: kind === 'unknown' ? 0.01 : 0.98 };
      value.answers.missing_context = { type: 'boolean', probability: 0.01 };
    }
    for (const id of Object.keys(request.questions)) {
      if (id.startsWith('member_')) value.answers[id] = { type: 'boolean', probability: 0.98 };
      if (id.startsWith('missing_')) value.answers[id] = { type: 'boolean', probability: 0.01 };
    }
    return transform ? transform(value, request, call, context) : value;
  };
  const provider = providerFactory === createRecordedProvider
    ? providerFactory({ transform: answer }) : providerFactory(answer);
  const delegate = createDecisionService({ provider, profiles: ARCHITECTURE_PROFILES });
  t.after(() => delegate.close());
  const calls = { source: [], metadata: [] };
  const service = {
    analyze(input) { calls.source.push(input); return delegate.analyze(input); },
    evaluate(input) { calls.metadata.push(input); return delegate.evaluate(input); },
  };
  const input = overrides => ({
    model: model.snapshot(), artifacts: [...captures.values()], service, policy, ...overrides,
  });
  const apply = result => model.replaceInterpretations(ARCHITECTURE_NAMESPACE, result.interpretations, {
    affectedEntityIds: result.affectedEntityIds, sourceRefs: result.sourceRefs,
  });
  const anchor = relativePath => model.snapshot().entities.find(entity =>
    entity.kind === 'module' && entity.artifactId === captures.get(relativePath).id).id;
  return { root, model, evidence, policy, provider, calls, service, captures, update, input, apply, anchor };
}

for (const [name, providerFactory] of [['recorded', createRecordedProvider], ['jev', jevProvider]]) {
  test(`${name}: captured source produces canonical boundaries and fixed-pair membership without model mutations`, async t => {
    const app = await fixture(t, { providerFactory });
    const before = app.model.snapshot();
    const result = await analyzeArchitecture(app.input());
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.deepEqual(app.model.snapshot(), before);
    assert.equal(result.interpretations.length, 3, JSON.stringify({
      coverage: result.coverage, kinds: result.interpretations.map(value => value.kind), relations: before.relations,
    }));
    const application = result.interpretations.find(value => value.kind === 'application');
    const component = result.interpretations.find(value => value.kind === 'component');
    const member = result.interpretations.find(value => value.kind === 'architecture_membership');
    assert.deepEqual(application.entityIds, [app.anchor('main.js')]);
    assert.deepEqual(component.entityIds, [app.anchor('orders.js')]);
    assert.deepEqual(member.entityIds, [app.anchor('main.js'), app.anchor('orders.js')]);
    assert.equal(application.sourceRefs.length, 1);
    assert.equal(component.sourceRefs.length, 1);
    assert.equal(member.sourceRefs.length, 2);
    assert.ok(result.interpretations.every(value => value.namespace === ARCHITECTURE_NAMESPACE
      && value.support === 'supported' && value.classification === 'accepted' && value.validity === 'current'));
    assert.ok(result.sourceRefs.every(ref => [...app.captures.values()].some(capture =>
      ref.artifactId === capture.id && ref.hash === capture.hash && ref.generation === capture.generation)));
    assert.equal(app.calls.source.length, 2);
    assert.equal(app.calls.metadata.length, 1);
    assert.ok(app.calls.metadata[0].state.proposals.every(value => value.sameProject === true
      && value.resolvedLocalDependency === true && value.currentSourceVersions === true));
    assert.ok(app.calls.metadata[0].state.boundaries.every(value =>
      value.basis === 'decision' && value.anchorBasis === 'parsed'));
    const sourceRequests = app.provider.calls.filter(call => call.request.questions.kind);
    assert.equal(sourceRequests.length, 2);
    for (const call of sourceRequests) assert.ok(call.request.state.evidence.every(value =>
      [applicationSource, componentSource].includes(value.code)), 'A-approved B evidence retains the complete short source');
    assert.equal(result.diagnostics.providerRequests, 5, 'two A/B workflows plus one finite metadata call');
    assert.equal(app.apply(result).accepted, true);
    assert.equal(app.model.snapshot().interpretations.length, 3);
    const metadata = JSON.stringify(app.calls.metadata[0].state);
    assert.doesNotMatch(metadata, /createServer|response\.end|startServer|sourceRefs|relativePath|generation|qualifiedName/);
    assert.doesNotMatch(JSON.stringify(result), /createServer|response\.end|startServer/);
  });
}

test('explicit unknown results carry guarded replacement scope and clear only the affected boundary and memberships', async t => {
  const app = await fixture(t);
  const initial = await analyzeArchitecture(app.input());
  app.apply(initial);
  const capture = await app.update('orders.js', "export const placeholder = 'synthetic';", 'unknown');
  const result = await analyzeArchitecture(app.input({ artifacts: [capture], affectedArtifactIds: [capture.id] }));
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.interpretations, []);
  assert.deepEqual(result.affectedEntityIds, [app.anchor('orders.js')]);
  assert.deepEqual(result.sourceRefs, [{ artifactId: capture.id, hash: capture.hash, generation: capture.generation }]);
  assert.deepEqual(result.coverage.unknownArtifactIds, [capture.id]);
  assert.equal(app.apply(result).accepted, true);
  assert.deepEqual(app.model.snapshot().interpretations.map(value => value.kind), ['application']);
});

test('an application discovered later reconsiders an orphan component using prior current roles without recapturing its source', async t => {
  const app = await fixture(t);
  const component = app.captures.get('orders.js'), main = app.captures.get('main.js');
  const first = await analyzeArchitecture(app.input({ artifacts: [component], affectedArtifactIds: [component.id] }));
  assert.equal(app.apply(first).accepted, true);
  assert.deepEqual(first.interpretations.map(value => value.kind), ['component']);
  const sourceCalls = app.calls.source.length;
  const second = await analyzeArchitecture(app.input({ artifacts: [main], affectedArtifactIds: [main.id] }));
  assert.equal(second.status, 'complete');
  assert.equal(app.calls.source.length - sourceCalls, 1);
  assert.deepEqual(second.coverage.analyzedArtifactIds, [main.id]);
  assert.deepEqual(second.interpretations.map(value => value.kind), ['application', 'architecture_membership']);
  assert.equal(app.apply(second).accepted, true);
  assert.deepEqual(app.model.snapshot().interpretations.map(value => value.kind).sort(),
    ['application', 'architecture_membership', 'component']);
});

test('only current parsed dependencies with references to both canonical local endpoints qualify for membership metadata', async t => {
  const app = await fixture(t);
  for (const alter of [
    relation => { relation.basis = 'lexical'; },
    relation => { relation.validity = 'stale'; },
    relation => { relation.sourceRefs = relation.sourceRefs.slice(0, 1); },
    relation => { relation.target = opaque('entity', 'not-in-project'); },
  ]) {
    const model = app.model.snapshot();
    const dependency = model.relations.find(value => value.kind === 'imports');
    assert.ok(dependency);
    alter(dependency);
    const result = await analyzeArchitecture(app.input({ model }));
    assert.equal(result.status, 'complete');
    assert.equal(result.coverage.supportedBoundaries, 2);
    assert.equal(result.coverage.membershipProposals, 0);
    assert.equal(result.interpretations.some(value => value.kind === 'architecture_membership'), false);
  }
  assert.equal(app.calls.metadata.length, 0);
});

test('boundary and membership IDs stay stable while exact source versions change', async t => {
  const app = await fixture(t);
  const initial = await analyzeArchitecture(app.input());
  app.apply(initial);
  const old = initial.interpretations.find(value => value.kind === 'component');
  const capture = await app.update('orders.js', componentSource.replace('Synthetic order', 'New synthetic order'), 'component');
  const result = await analyzeArchitecture(app.input({ artifacts: [capture], affectedArtifactIds: [capture.id] }));
  const updated = result.interpretations.find(value => value.kind === 'component');
  assert.equal(updated.id, old.id);
  assert.notEqual(updated.sourceRefs[0].hash, old.sourceRefs[0].hash);
  assert.ok(updated.sourceRefs[0].generation > old.sourceRefs[0].generation);
  assert.equal(result.interpretations.find(value => value.kind === 'architecture_membership').id,
    initial.interpretations.find(value => value.kind === 'architecture_membership').id);
  assert.equal(app.apply(result).accepted, true);
});

test('privacy intake can withhold every source candidate and only a guarded unknown replaces the scope', async t => {
  const app = await fixture(t, { transform(value, request) {
    for (const id of Object.keys(request.questions)) {
      if (id.startsWith('a_sensitive_')) value.answers[id].probability = 0.5;
    }
    return value;
  } });
  const result = await analyzeArchitecture(app.input());
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.interpretations, []);
  assert.equal(result.affectedEntityIds.length, 2);
  assert.equal(result.sourceRefs.length, 2);
  assert.equal(app.calls.metadata.length, 0);
  assert.ok(app.provider.calls.every(call => call.request.questions.a_activity), 'withheld source never reaches B');
});

test('missing metrics and insufficient context never manufacture a supported boundary or membership', async t => {
  for (const mode of ['role-context', 'role-probability', 'membership-context', 'membership-probability']) {
    const app = await fixture(t, { transform(value, request) {
      if (request.questions.kind && mode === 'role-context') value.answers.missing_context.probability = 0.11;
      if (request.questions.kind && mode === 'role-probability') delete value.answers.kind.probabilities;
      if (request.questions.member_0 && mode === 'membership-context') value.answers.missing_0.probability = 0.11;
      if (request.questions.member_0 && mode === 'membership-probability') delete value.answers.member_0.probability;
      return value;
    } });
    const result = await analyzeArchitecture(app.input());
    assert.equal(result.interpretations.some(value => value.kind === 'architecture_membership'
      && value.support === 'supported'), false, mode);
    if (mode.startsWith('role')) assert.deepEqual(result.interpretations, [], mode);
    else if (mode === 'membership-context') {
      assert.equal(result.interpretations.length, 3, mode);
      const unknown = result.interpretations.find(value => value.kind === 'architecture_membership');
      assert.equal(unknown.support, 'unknown');
      assert.equal(unknown.classification, 'unknown');
      assert.equal('probability' in unknown, false);
    } else assert.equal(result.interpretations.length, 2, mode);
  }
});

test('consent, exact captures, source safety, parsed canonical anchors and replay are required before any call', async t => {
  const app = await fixture(t);
  for (const modify of [
    input => { input.policy = createPolicy({ readSource: true }); },
    input => { input.model.replay = true; },
    input => { input.model.checkpointId = 'old-checkpoint'; },
    input => { input.artifacts = input.artifacts.map(value => ({ ...value, hash: 'a'.repeat(64) })); },
    input => { input.artifacts = input.artifacts.map(value => ({ ...value, generation: value.generation + 1 })); },
    input => { input.artifacts = input.artifacts.map(value => ({ ...value, complete: false })); },
    input => { input.artifacts = input.artifacts.map(value => ({ ...value, relativePath: '.env' })); },
    input => { input.artifacts = input.artifacts.map(value => ({ ...value, text: null })); },
    input => { input.model.entities.forEach(value => { value.basis = 'lexical'; }); },
    input => { input.model.coverage.artifacts.forEach(value => { value.fresh = false; }); },
    input => {
      const privateSource = 'const password = "SYNTHETIC_PRIVATE_VALUE";';
      input.artifacts = input.artifacts.map(value => ({ ...value, text: privateSource, hash: hash(privateSource) }));
      input.model.coverage.artifacts.forEach(value => { value.hash = hash(privateSource); });
      input.model.entities.forEach(value => value.sourceRefs.forEach(ref => { ref.hash = hash(privateSource); }));
    },
  ]) {
    const input = app.input();
    modify(input);
    const result = await analyzeArchitecture(input);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.interpretations, []);
    assert.deepEqual(result.affectedEntityIds, []);
    assert.deepEqual(result.sourceRefs, []);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_VALUE/);
  }
  assert.equal(app.provider.calls.length, 0);
});

test('bounded source work exposes deferred IDs and empty affected scope makes no provider calls', async t => {
  const files = Object.fromEntries(Array.from({ length: ARCHITECTURE_LIMITS.artifacts + 2 }, (_, i) =>
    [`file-${i}.js`, `export function item${i}() { return ${i}; }`]));
  const app = await fixture(t, { files });
  const empty = await analyzeArchitecture(app.input({ affectedArtifactIds: [] }));
  assert.equal(empty.status, 'complete');
  assert.deepEqual(empty.affectedEntityIds, []);
  assert.equal(app.provider.calls.length, 0);
  const result = await analyzeArchitecture(app.input());
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.analyzedArtifactIds.length, ARCHITECTURE_LIMITS.artifacts);
  assert.equal(result.coverage.deferredArtifactIds.length, 2);
  assert.equal(app.calls.source.length, ARCHITECTURE_LIMITS.artifacts);
  assert.ok(result.coverage.deferredArtifactIds.every(id => !result.sourceRefs.some(ref => ref.artifactId === id)));
});

test('architecture sends all 12 approved spans of a 283-line application, including its final bootstrap', async t => {
  const source = [
    "import { createRoot } from 'react-dom/client';", 'function App() {',
    ...Array.from({ length: 278 }, (_, index) => `  // synthetic module context ${index}`),
    '  return <main>Generated application</main>;', '}',
    "createRoot(document.getElementById('root')).render(<App />);",
  ].join('\n');
  const app = await fixture(t, { files: { 'main.tsx': source }, rolesByPath: { 'main.tsx': 'application' } });
  const result = await analyzeArchitecture(app.input());
  assert.equal(result.status, 'complete');
  assert.equal(result.coverage.omittedCandidates, 0);
  assert.deepEqual(result.interpretations.map(value => value.kind), ['application']);
  assert.equal(app.calls.source[0].candidates.length, 12);
  assert.equal(app.provider.calls.length, 2, 'one bounded intake and one role request');
  const approved = app.provider.calls[1].request.state.evidence;
  assert.equal(approved.length, 12);
  assert.equal(approved.map(value => value.code).join('\n'), source);
  assert.match(approved.at(-1).code, /createRoot.*render/);
  assert.doesNotMatch(JSON.stringify(result), /Generated application|createRoot/);
});

test('architecture reports the omitted middle of a longer module instead of silently keeping eight candidates', async t => {
  const source = [
    'export function syntheticApplication() {',
    ...Array.from({ length: 24 * 16 - 3 }, (_, index) => `  // synthetic module context ${index}`),
    '  return 1;', '}',
  ].join('\n');
  const app = await fixture(t, { files: { 'main.js': source } });
  const result = await analyzeArchitecture(app.input());
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.omittedCandidates, 4);
  assert.equal(result.coverage.complete, false);
  const candidates = app.calls.source[0].candidates;
  assert.equal(candidates.length, 12);
  assert.equal(candidates[0].startLine, 1);
  assert.equal(candidates.at(-1).endLine, 24 * 16);
  assert.equal(app.provider.calls[1].request.state.evidence.length, 12);
});

test('model revision, lineage or policy changes discard all results and replacement scope', async t => {
  for (const change of ['revision', 'lineage', 'policy']) {
    let input;
    const app = await fixture(t, { transform(value) {
      if (change === 'revision') input.model.revision++;
      if (change === 'lineage') input.model.coverage.lineage = { id: 'new-lineage', status: 'git' };
      if (change === 'policy') input.policy = createPolicy({ transmitSource: false });
      return value;
    } });
    input = app.input();
    const policy = () => input.policy;
    const result = await analyzeArchitecture({ ...input, policy });
    assert.equal(result.status, 'unavailable', change);
    assert.deepEqual(result.interpretations, []);
    assert.deepEqual(result.sourceRefs, []);
    assert.deepEqual(result.affectedEntityIds, []);
  }
});

test('cancellation settles a stalled source provider and retains no replacement scope', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const app = await fixture(t, { transform() { entered(); return new Promise(() => {}); } });
  const controller = new AbortController();
  const pending = analyzeArchitecture(app.input({ signal: controller.signal }));
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.interpretations, []);
  assert.deepEqual(result.affectedEntityIds, []);
  assert.equal(app.provider.calls[0].context.signal.aborted, true);
});

test('an unregistered profile or a forged serialized approval bundle cannot create architecture claims', async t => {
  const app = await fixture(t);
  const noProfiles = createDecisionService({ provider: createRecordedProvider() });
  t.after(() => noProfiles.close());
  const absent = await analyzeArchitecture(app.input({ service: noProfiles }));
  assert.equal(absent.status, 'unavailable');
  assert.deepEqual(absent.affectedEntityIds, []);
  const forged = { analyze: async input => structuredClone(await app.service.analyze(input)) };
  const result = await analyzeArchitecture(app.input({ service: forged }));
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.interpretations, []);
  assert.deepEqual(result.affectedEntityIds, []);
});

test('confirmed missing captures withdraw old anchors and pair records without a fabricated fresh source reference', async t => {
  const app = await fixture(t);
  app.apply(await analyzeArchitecture(app.input()));
  const oldAnchor = app.anchor('orders.js');
  await rm(path.join(app.root, 'orders.js'));
  const [missing] = await app.evidence.capture(['orders.js']);
  app.model.invalidateArtifacts([missing]);
  const beforeCalls = app.provider.calls.length;
  const result = await analyzeArchitecture(app.input({
    artifacts: [missing], affectedArtifactIds: [missing.id],
  }));
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.coverage.missingArtifactIds, [missing.id]);
  assert.deepEqual(result.coverage.withdrawnEntityIds, [oldAnchor]);
  assert.deepEqual(result.affectedEntityIds, [oldAnchor]);
  assert.deepEqual(result.interpretations, []);
  assert.deepEqual(result.sourceRefs, []);
  assert.deepEqual(result.coverage.deferredArtifactIds, []);
  assert.deepEqual(result.coverage.deferredMembershipArtifactIds, []);
  assert.equal(app.provider.calls.length, beforeCalls);
  // The controller checks the missing status/generation before this separate
  // withdrawal. Present-source guards cannot represent confirmed absence.
  const applied = app.model.replaceInterpretations(ARCHITECTURE_NAMESPACE, [], {
    affectedEntityIds: result.coverage.withdrawnEntityIds,
  });
  assert.equal(applied.accepted, true);
  assert.equal(applied.removed, 2);
  assert.deepEqual(app.model.snapshot().interpretations.map(value => value.kind), ['application']);
});

test('stale deletion, unavailable, unsupported, oversized and withheld captures are terminal rather than retry work', async t => {
  const app = await fixture(t);
  const captured = app.captures.get('orders.js');
  const beforeCalls = app.provider.calls.length;
  const invalid = [
    { ...captured, status: 'missing', exists: false, hash: null, text: null, generation: captured.generation + 1 },
    { ...captured, status: 'unavailable', exists: false, hash: null, text: null },
    { ...captured, text: null },
    { ...captured, text: 'x'.repeat(ARCHITECTURE_LIMITS.sourceBytes + 1) },
  ];
  for (const capture of invalid) {
    const result = await analyzeArchitecture(app.input({ artifacts: [capture] }));
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.coverage.unavailableArtifactIds, [captured.id]);
    assert.deepEqual(result.coverage.deferredArtifactIds, []);
    assert.deepEqual(result.coverage.deferredMembershipArtifactIds, []);
    assert.deepEqual(result.affectedEntityIds, []);
  }
  const model = app.model.snapshot();
  model.entities.forEach(value => { if (value.artifactId === captured.id) value.basis = 'lexical'; });
  const unsupported = await analyzeArchitecture(app.input({ model, artifacts: [captured] }));
  assert.deepEqual(unsupported.coverage.unavailableArtifactIds, [captured.id]);
  assert.deepEqual(unsupported.coverage.deferredArtifactIds, []);
  assert.equal(app.provider.calls.length, beforeCalls);
});

for (const accepted of [true, false]) {
  test(`a new app with many old components drains only tail children (${accepted ? 'supported' : 'unknown'} pairs)`, async t => {
    const children = Array.from({ length: ARCHITECTURE_LIMITS.membershipChecks + 2 }, (_, i) => `child${i}`);
    const main = [
      ...children.map(name => `import { ${name} } from './${name}.js';`),
      `export function start() { return [${children.map(name => `${name}()`).join(', ')}]; }`,
    ].join('\n');
    const files = { 'main.js': main, ...Object.fromEntries(children.map(name =>
      [`${name}.js`, `export function ${name}() { return '${name} result'; }`])) };
    const app = await fixture(t, {
      files, rolesByPath: Object.fromEntries(Object.keys(files).map(name => [name, name === 'main.js' ? 'application' : 'component'])),
      transform(value, request) {
        if (!accepted) for (const id of Object.keys(request.questions)) {
          if (id.startsWith('member_')) value.answers[id].probability = 0.01;
        }
        return value;
      },
    });
    const components = children.map(name => app.captures.get(`${name}.js`));
    for (let i = 0; i < components.length; i += ARCHITECTURE_LIMITS.artifacts) {
      const batch = components.slice(i, i + ARCHITECTURE_LIMITS.artifacts);
      const result = await analyzeArchitecture(app.input({
        artifacts: batch, affectedArtifactIds: batch.map(value => value.id),
      }));
      assert.equal(app.apply(result).accepted, true);
    }
    const sourceCalls = app.calls.source.length;
    const mainCapture = app.captures.get('main.js');
    const first = await analyzeArchitecture(app.input({
      artifacts: [mainCapture], affectedArtifactIds: [mainCapture.id],
    }));
    assert.equal(first.status, 'partial');
    assert.equal(first.coverage.membershipChecks, ARCHITECTURE_LIMITS.membershipChecks);
    assert.equal(first.coverage.deferredMembershipArtifactIds.length, 2);
    assert.deepEqual(first.coverage.deferredArtifactIds, []);
    assert.equal(app.apply(first).accepted, true);
    const tail = first.coverage.deferredMembershipArtifactIds;
    const second = await analyzeArchitecture(app.input({
      artifacts: components.filter(value => tail.includes(value.id)), affectedArtifactIds: tail,
    }));
    assert.equal(second.status, 'complete');
    assert.equal(second.coverage.membershipChecks, 2);
    assert.deepEqual(second.coverage.deferredMembershipArtifactIds, []);
    assert.deepEqual(second.coverage.deferredArtifactIds, []);
    assert.equal(app.apply(second).accepted, true);
    const pairs = app.model.snapshot().interpretations.filter(value => value.kind === 'architecture_membership');
    assert.equal(pairs.length, children.length);
    assert.ok(pairs.every(value => value.support === (accepted ? 'supported' : 'unknown')));
    assert.equal(app.calls.source.length - sourceCalls, 1 + tail.length, 'the app is not reanalyzed for tail children');
    assert.equal(app.calls.metadata.length, 2);
    assert.ok(app.calls.metadata[1].state.proposals.every(pair =>
      !app.calls.metadata[0].state.proposals.some(firstPair => firstPair.childId === pair.childId)));
  });
}

for (const mode of ['unknown', 'unavailable']) {
  test(`a child shared by more than six apps ${mode === 'unknown' ? 'advances past unknown answers' : 'recovers after an unavailable evaluation'}`, async t => {
    const mains = Array.from({ length: ARCHITECTURE_LIMITS.membershipChecks + 1 }, (_, i) => `main${i}`);
    const files = {
      ...Object.fromEntries(mains.map(name => [`${name}.js`, applicationSource.replace('startServer', name)])),
      'orders.js': componentSource,
    };
    let offline = mode === 'unavailable';
    const app = await fixture(t, {
      files, rolesByPath: Object.fromEntries(mains.map(name => [`${name}.js`, 'application'])),
      transform(value, request) {
        if (request.questions.member_0) {
          if (offline) throw new Error('Synthetic offline failure');
          for (const id of Object.keys(request.questions)) {
            if (mode === 'unknown' && id.startsWith('member_')) value.answers[id].probability = 0.5;
          }
        }
        return value;
      },
    });
    const applications = mains.map(name => app.captures.get(`${name}.js`));
    for (let i = 0; i < applications.length; i += ARCHITECTURE_LIMITS.artifacts) {
      const batch = applications.slice(i, i + ARCHITECTURE_LIMITS.artifacts);
      const result = await analyzeArchitecture(app.input({
        artifacts: batch, affectedArtifactIds: batch.map(value => value.id),
      }));
      assert.equal(app.apply(result).accepted, true);
    }
    const child = app.captures.get('orders.js');
    const analyzeChild = () => analyzeArchitecture(app.input({ artifacts: [child], affectedArtifactIds: [child.id] }));
    let first = await analyzeChild();
    assert.deepEqual(first.coverage.deferredMembershipArtifactIds, [child.id]);
    assert.equal(app.apply(first).accepted, true);
    if (offline) {
      assert.equal(first.status, 'partial');
      assert.equal(first.coverage.membershipChecks, 0);
      assert.equal(first.coverage.unknownMemberships, 0);
      assert.equal(first.interpretations.filter(value => value.kind === 'architecture_membership').length, 0);
      // The controller bounds automatic retries; a new manual Discover is
      // allowed to run again against these identical source versions.
      offline = false;
      first = await analyzeChild();
      assert.equal(first.coverage.membershipChecks, ARCHITECTURE_LIMITS.membershipChecks);
      assert.equal(app.apply(first).accepted, true);
    }
    const second = await analyzeChild();
    assert.deepEqual(second.coverage.deferredMembershipArtifactIds, []);
    assert.equal(second.coverage.unknownMemberships, mode === 'unknown' ? mains.length : 0);
    assert.equal(app.apply(second).accepted, true);
    const final = await analyzeChild();
    assert.deepEqual(final.coverage.deferredMembershipArtifactIds, []);
    assert.equal(final.coverage.membershipChecks, 0);
    assert.equal(app.calls.metadata.length, mode === 'unknown' ? 2 : 3);
    assert.equal(app.model.snapshot().interpretations.filter(value =>
      value.kind === 'architecture_membership' && value.support === 'supported').length, mode === 'unknown' ? 0 : mains.length);
  });
}
