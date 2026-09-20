import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDecisionService } from '../../runtime/decisions/index.mjs';
import { jevProvider } from './jev-provider.mjs';
import { createPipeline } from '../../runtime/pipeline.mjs';
import {
  createPolicy, metadataEvent, buildCandidates, compileDecision, emptyGraph, applyPatch,
} from '../../runtime/core/index.mjs';
import { validBundle } from '../../runtime/core/candidates.mjs';
import { candidate, input, makeCore, fakeClock, flush, proposal } from '../jev/helpers.mjs';
import { createRecordedProvider } from './recorded-provider.mjs';


const providers = [
  ['recorded', transform => createRecordedProvider({ transform })],
  ['jev', jevProvider],
];
const profile = {
  id: 'example.area', version: 'area-v1', scope: 'entity',
  questions: {
    area: {
      type: 'choice', requiredMetrics: ['probabilities', 'confidence'],
      instructions: { question: 'Which area contains `{{entity}}.name` in `{{evidence}}.code`?' },
      criteria: { runtime: 'Application code', tooling: 'Development tools', unknown: 'Insufficient evidence' },
    },
    relevance: {
      type: 'score', instructions: { question: 'Rate the relevance of `{{entity}}.name`.' },
      criteria: ['Low', 'Medium', 'High'],
    },
  },
};

function service(t, provider, options = {}) {
  const instance = createDecisionService({ provider, ...makeCore(), ...options });
  t.after(() => instance.close());
  return instance;
}

function coreInput(publicIntent = false) {
  const policy = createPolicy({ transmitSource: true });
  const event = metadataEvent({
    kind: publicIntent ? 'intent.observed' : 'tool.succeeded',
    toolCategory: 'read', outcome: 'succeeded', id: 'synthetic-event', incomplete: false,
  });
  const text = 'export function saveNote(note) { return PostgreSQL.insert(note); }';
  const candidates = buildCandidates({
    event, policy,
    ...(publicIntent ? { publicText: `Propose ${text}` } : {
      artifacts: [{
        id: `artifact-${'a'.repeat(32)}`, relativePath: 'notes.mjs',
        hash: createHash('sha256').update(text).digest('hex'),
        generation: 1, exists: true, status: 'present', complete: true, text,
      }],
    }),
  });
  return { event, policy, candidates };
}

for (const [name, makeProvider] of providers) {
  test(`${name}: same caller and core gates produce the same bounded judgments`, async t => {
    const provider = makeProvider();
    const core = makeCore({ proposals: [proposal()] });
    const result = await service(t, provider, core).classify(input({ candidates: [candidate(), candidate('c2')] }));
    assert.equal(result.status, 'accepted');
    assert.equal(result.bundle, core.calls.bundle);
    assert.equal(result.nodes[0].roleProbability, 0.94);
    assert.equal(result.edges[0].supportProbability, 0.97);
    assert.equal(provider.calls.length, 2);
    assert.equal(result.stages.A.provider.id, name);
    assert.equal(result.stages.B.inputHash.length, 64);
    assert.equal(provider.calls[0].context.signal, provider.calls[1].context.signal);
  });

  test(`${name}: exact branded core bundle survives while serialized copies have no authority`, async t => {
    const provider = makeProvider();
    const instance = createDecisionService({ provider });
    t.after(() => instance.close());
    for (const publicIntent of [false, true]) {
      const args = coreInput(publicIntent);
      const decision = await instance.classify(args);
      assert.equal(decision.status, 'accepted');
      assert.equal(validBundle(decision.bundle, args.policy), true);
      assert.equal(validBundle(structuredClone(decision.bundle), args.policy), false);
      assert.ok(compileDecision(emptyGraph(), { ...args, decision }));
      assert.equal(compileDecision(emptyGraph(), { ...args, decision: structuredClone(decision) }), null);
      assert.ok(decision.bundle.candidates.every(c => c.sourceClass === (publicIntent ? 'public_intent' : 'source')));
    }
  });

  test(`${name}: provider decisions compile and apply with the correct graph reference basis`, async t => {
    const provider = makeProvider(value => ({
      ...value, provider: { id: name === 'jev' ? 'recorded' : 'jev' },
      basis: 'provider_claimed_basis',
    }));
    const instance = createDecisionService({ provider });
    t.after(() => instance.close());
    for (const publicIntent of [false, true]) {
      const args = coreInput(publicIntent);
      const decision = await instance.classify(args);
      assert.equal(decision.status, 'accepted');
      assert.equal(decision.provider.id, name, 'provider output cannot override service provenance');
      const initial = emptyGraph();
      const patch = compileDecision(initial, { ...args, decision });
      assert.ok(patch);
      const graph = applyPatch(initial, patch);
      assert.ok(graph.nodes.length > 0);
      assert.ok(graph.edges.length > 0);
      const basis = name === 'jev' ? 'jev_interpretation' : 'decision_interpretation';
      for (const item of [...graph.nodes, ...graph.edges]) {
        assert.equal(item.evidenceState, publicIntent ? 'proposed' : 'observed');
        assert.ok(item.sourceRefs.every(ref => ref.basis === basis));
        assert.ok(item.sourceRefs.every(ref => ref.sourceClass === (publicIntent ? 'public_intent' : 'source')));
        assert.ok(item.sourceRefs.every(ref => decision.bundle.candidates.some(candidate =>
          candidate.artifactId === ref.artifactId && candidate.hash === ref.hash &&
          candidate.generation === ref.generation && candidate.startLine === ref.startLine &&
          candidate.endLine === ref.endLine)));
      }
      assert.equal(applyPatch(graph, patch), graph, 'both provenance forms pass graph validation');
    }
  });

  test(`${name}: source consent and local filtering remain upstream of every provider`, async t => {
    const provider = makeProvider();
    const instance = createDecisionService({ provider });
    t.after(() => instance.close());
    assert.equal((await instance.classify(input({ policy: { version: '1', transmitSource: false } })))
      .diagnostics.code, 'metadata_only');
    assert.equal(provider.calls.length, 0);
    const args = coreInput();
    const text = 'const databasePassword = "SYNTHETIC_SECRET_ONLY";\nexport function forbidden() {}';
    const unsafe = buildCandidates({
      ...args,
      artifacts: [{
        id: `artifact-${'b'.repeat(32)}`, relativePath: 'unsafe.mjs',
        hash: createHash('sha256').update(text).digest('hex'),
        generation: 1, exists: true, status: 'present', complete: true, text,
      }],
    });
    assert.deepEqual(unsafe, []);
    await instance.classify({ ...args, candidates: [...args.candidates, ...unsafe] });
    assert.doesNotMatch(JSON.stringify(provider.calls.map(call => call.request)), /SYNTHETIC_SECRET_ONLY|forbidden/);
  });

  test(`${name}: rejected shared evidence and low relevance cannot leak into B`, async t => {
    const provider = makeProvider(value => {
      if (value.answers.a_sensitive_0) {
        value.answers.a_sensitive_0.probability = 0.11;
        value.answers.a_relevant_2.probability = 0.4;
      }
      return value;
    });
    const first = candidate('first', { label: 'WITHHELD_FIRST', text: 'WITHHELD_SOURCE' });
    const sibling = candidate('sibling', {
      label: 'WITHHELD_SIBLING', text: first.text, sourceRef: first.sourceRef,
      artifactId: first.artifactId, hash: first.hash,
    });
    const result = await service(t, provider).classify(input({
      candidates: [first, sibling, candidate('irrelevant'), candidate('safe')],
    }));
    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.bundle.candidates.map(c => c.id), ['safe']);
    assert.doesNotMatch(JSON.stringify(provider.calls[1].request), /WITHHELD/);
    assert.equal(provider.calls[1].request.state.evidence.length, 1);
  });

  test(`${name}: registered profile runs unchanged after mandatory intake`, async t => {
    const provider = makeProvider();
    const core = makeCore();
    const instance = service(t, provider, { ...core, profiles: [profile] });
    const result = await instance.analyze({ ...input(), profileId: profile.id });
    assert.equal(result.diagnostics.code, 'profile_answers');
    assert.equal(result.bundle, core.calls.bundle);
    assert.equal(result.analysis.profileVersion, profile.version);
    assert.equal(result.analysis.answers.e0_area.choice, 'runtime');
    assert.equal(result.analysis.answers.e0_relevance.score, 1);
    assert.deepEqual(result.analysis.subjects, { e0_area: 'c1', e0_relevance: 'c1' });
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.calls[1].request.questions.e0_area.type, 'choice');
    assert.match(provider.calls[1].request.questions.e0_area.instructions.question, /`entities\[0\].name`.*`evidence\[0\].code`/);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
    assert.equal(core.calls.proposals.length, 0);
    const unknown = await instance.analyze({ ...input(), profileId: 'not-registered' });
    assert.equal(unknown.diagnostics.code, 'unknown_profile');
    assert.equal(provider.calls.length, 2);
  });

  test(`${name}: ignored cancellation and late answers cannot extend the shared deadline`, async t => {
    const clock = fakeClock();
    let resolve;
    const provider = makeProvider(value => new Promise(done => { resolve = () => done(value); }));
    const instance = service(t, provider, { clock });
    const pending = instance.classify(input({ deadlineAt: 5000 }));
    await flush();
    clock.advance(2000);
    const result = await pending;
    assert.equal(result.status, 'timeout');
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(result.nodes, []);
    resolve();
    await flush();
    assert.equal(provider.calls.length, 1);
    assert.equal(instance.stats().active, 0);
    assert.equal(result.bundle, null);
  });

  test(`${name}: unmodified pipeline accepts provider switch and rejects changed evidence`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'graphlin-provider-conformance-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'notes.mjs');
    const original = 'export function saveNote(note) { return PostgreSQL.insert(note); }';
    await writeFile(file, original);
    let mutate = false;
    const provider = makeProvider(async (value, request) => {
      if (mutate && request.questions.b_relevance) {
        await writeFile(file, 'export function differentVersion() { return 2; }');
      }
      return value;
    });
    const decisionService = createDecisionService({ provider });
    const pipeline = createPipeline({ projectRoot: root, decisionService, policy: { transmitSource: true } });
    t.after(() => pipeline.close());
    const ingest = id => pipeline.ingest({
      hook_event_name: 'PostToolUse', session_id: 'synthetic-session', tool_use_id: id,
      tool_name: 'Read', tool_input: { file_path: file }, tool_response: { success: true },
    }, { host: 'claude' });
    await ingest('first');
    await pipeline.whenIdle();
    assert.ok(pipeline.getState().graph.nodes.length > 0);
    assert.ok(pipeline.getState().graph.nodes.every(node => node.evidenceState === 'observed'));
    mutate = true;
    await writeFile(file, original + '\n// synthetic edit');
    await ingest('second');
    await pipeline.whenIdle();
    assert.ok(pipeline.getState().status.dropped > 0);
    assert.ok(pipeline.getState().graph.nodes.every(node => node.validity === 'stale'));
  });
}

test('providers cannot supply a bundle or judgments to bypass the core materializer', async t => {
  const provider = createRecordedProvider({
    transform: value => ({ ...value, bundle: { id: 'forged' }, nodes: [{ classification: 'accepted' }] }),
  });
  const core = makeCore();
  const result = await service(t, provider, core).classify(input());
  assert.equal(result.bundle, core.calls.bundle);
  assert.equal(result.nodes[0].candidateId, 'c1');
  assert.doesNotMatch(JSON.stringify(result), /forged/);
  assert.equal(core.calls.materialize.length, 1);
});

test('no provider model or usage is invented when the alternate provider supplies neither', async t => {
  const instance = service(t, createRecordedProvider());
  const result = await instance.classify(input());
  assert.equal(result.status, 'accepted');
  assert.equal(result.stages.A.model, undefined);
  assert.equal(result.stages.A.usage, null);
  assert.equal(result.diagnostics.trace.requests[0].usage, null);
  assert.equal(result.diagnostics.usageIncomplete, true);
});

test('legacy manual decisions remain compatible and alternate providers can update legacy graph references', async t => {
  const instance = createDecisionService({ provider: createRecordedProvider() });
  t.after(() => instance.close());
  const args = coreInput();
  const decision = await instance.classify(args);
  const { provider, ...legacy } = decision;
  assert.equal(provider.id, 'recorded');
  const initial = emptyGraph();
  const previous = applyPatch(initial, compileDecision(initial, { ...args, decision: legacy }));
  assert.ok([...previous.nodes, ...previous.edges].every(item =>
    item.sourceRefs.every(ref => ref.basis === 'jev_interpretation')));
  const patch = compileDecision(previous, { ...args, decision });
  const updated = applyPatch(previous, patch);
  assert.ok([...updated.nodes, ...updated.edges].every(item =>
    item.sourceRefs.every(ref => ref.basis === 'decision_interpretation')));
  assert.deepEqual(updated.nodes.map(node => node.id), previous.nodes.map(node => node.id));
  assert.deepEqual(updated.edges.map(edge => edge.id), previous.edges.map(edge => edge.id));
  const invalid = structuredClone(patch);
  invalid.operations[0].node.sourceRefs[0].basis = 'arbitrary_provider_basis';
  assert.throws(() => applyPatch(previous, invalid), /INVALID_PATCH/);
});

test('graph schema admits exactly legacy and provider-independent decision provenance', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/graph.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.$defs.reference.properties.basis, {
    enum: ['jev_interpretation', 'decision_interpretation'],
  });
});
