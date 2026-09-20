import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createPolicy, metadataEvent, EvidenceStore, buildCandidates, materializeBundle,
  buildRelationProposals, emptyGraph, compileDecision, applyPatch,
} from '../../runtime/core/index.mjs';
import { buildGraphRequest } from '../../runtime/jev/questions.mjs';
import { createDecisionService, createFixtureTransport } from '../../runtime/jev/index.mjs';
import {
  EVALUATION_CASES, inspectRequest, assessCoverage, preflightCase, scoreCase,
  selectNumericAnswers, observeNumericResponse, parseEvaluationOptions,
} from '../../scripts/evaluate-jev.mjs';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({
  id: 'evaluation-test', kind: 'artifact.changed', projectId: 'evaluation',
  sessionId: 'evaluation-test', sequence: 1, incomplete: false,
});
const findCase = id => EVALUATION_CASES.find(item => item.id === id);

function prepare(id = 'postgres-write', { support = 0.98, context = 0.02, status = 'accepted' } = {}) {
  const item = findCase(id);
  const artifact = {
    id: `artifact-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`,
    hash: createHash('sha256').update(item.source).digest('hex'), generation: 1,
    text: item.source, relativePath: item.filename ?? 'repository-test.js',
    status: 'present', exists: true, complete: true,
  };
  const candidates = buildCandidates({ event, artifacts: [artifact], policy });
  const bundle = materializeBundle({
    candidates, policy, verdicts: candidates.map(candidate => ({
      candidateId: candidate.id, digest: candidate.digest, relevant: 1, sensitive: 0,
    })),
  });
  const { proposals } = buildRelationProposals(bundle, { maxQuestionsPerStage: 40 });
  const body = buildGraphRequest('jev-1.13.0', event, bundle, proposals);
  const requests = [inspectRequest(body)];
  const coverage = assessCoverage({ item, artifactId: artifact.id, bundle, requests });
  // Scripted judgments exercise scoring and compilation, never model accuracy.
  const decision = {
    status, bundle, stages: { B: { model: 'jev-1.13.0', rubricVersion: 'architecture-v6', mode: 'demo' } },
    nodes: candidates.map(candidate => {
      const role = candidate.label === item.expected.source ? item.expected.sourceRole
        : candidate.label === item.expected.target ? item.expected.targetRole : 'module';
      return {
        candidateId: candidate.id, role, supportProbability: 0.98,
        roleProbability: 0.99, roleConfidence: 0.99,
        roleProbabilities: { [role]: 0.99, unknown: 0.01 }, classification: 'accepted',
      };
    }),
    edges: proposals.map(({ id: proposalId, ...proposal }, index) => ({
      proposalId, ...proposal,
      supportProbability: index === coverage.proposalIndex ? support : 0.02,
      missingContextProbability: index === coverage.proposalIndex ? context : 0.02,
      classification: 'accepted',
    })),
  };
  const prepared = { item, artifactId: artifact.id, event, candidates, policy, decision, requests, body };
  return recompile(prepared);
}

function recompile(prepared) {
  const initial = emptyGraph();
  const patch = compileDecision(initial, { event, decision: prepared.decision, policy });
  prepared.graph = patch ? applyPatch(initial, patch) : initial;
  return prepared;
}

test('importing the evaluation harness performs no credential loading or live work', async () => {
  const moduleUrl = new URL('../../scripts/evaluate-jev.mjs', import.meta.url).href;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    process.loadEnvFile = () => { throw new Error('ENV_LOADING_FORBIDDEN'); };
    const module = await import(${JSON.stringify(moduleUrl)});
    console.log(module.EVALUATION_CASES.length);
  `], { timeout: 3000 });
  assert.equal(stdout.trim(), '14');
  assert.equal(stderr, '');
});

test('all fourteen synthetic sources route their declared pairs through real capture and core preflight', async t => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'graphlin-evaluation-test-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const store = new EvidenceStore({ projectRoot, policy });
  assert.equal(EVALUATION_CASES.length, 14);
  for (const item of EVALUATION_CASES) {
    const relativePath = `${item.id}${path.extname(item.filename ?? 'repository-test.js')}`;
    await writeFile(path.join(projectRoot, relativePath), item.source);
    const [artifact] = await store.capture([relativePath]);
    const candidates = buildCandidates({ event, artifacts: [artifact], policy });
    const result = preflightCase({ item, artifactId: artifact.id, event, candidates, policy });
    assert.equal(result.routable, true, `${item.id}: ${result.reason}`);
    assert.ok(result.questionCount <= 40);
    assert.ok(result.proposalCount <= 7);
    assert.equal(result.mode, 'routing_only_all_candidates_approved');
    if (item.id === 'configuration-only') {
      assert.deepEqual([item.expected.source, item.expected.target], ['db', 'Pool']);
      assert.equal(result.proposalIndex, 3);
    }
  }
});

test('coverage requires the exact structural write proposal, not prose mentioning writes', () => {
  const prepared = prepare();
  const body = structuredClone(prepared.body);
  body.state.proposals = [body.state.proposals[0]]; // calls; its context question mentions writes.
  const request = inspectRequest(body);
  assert.match(JSON.stringify(body.questions.b_context_0), /write/);
  assert.equal(request.writesAsked, false);
  const coverage = assessCoverage({ ...prepared, bundle: prepared.decision.bundle, requests: [request] });
  assert.equal(coverage.asked, false);
  assert.equal(coverage.reason, 'missing_or_ambiguous_proposal');
  assert.equal(scoreCase({ ...prepared, requests: [request] }).outcome, 'inconclusive');
});

test('both Noul questions and endpoint evidence indices must be present', () => {
  const prepared = prepare();
  const index = prepared.requests[0].proposals.find(proposal => proposal.relation === 'writes').index;
  for (const change of [
    body => { delete body.questions[`b_relation_${index}`]; },
    body => { delete body.questions[`b_context_${index}`]; },
    body => { body.questions[`b_context_${index}`].type = 'choice'; },
    body => { body.state.proposals[index].evidenceIndices = []; },
    body => { body.state.proposals[index].evidenceIndices = [999]; },
  ]) {
    const body = structuredClone(prepared.body);
    change(body);
    const coverage = assessCoverage({ ...prepared, bundle: prepared.decision.bundle, requests: [inspectRequest(body)] });
    assert.equal(coverage.asked, false);
    assert.equal(coverage.reason, 'missing_question_or_evidence');
  }
});

test('coverage binds request indices to approved candidate identities and the expected artifact', () => {
  const prepared = prepare('commonjs-write');
  assert.equal(assessCoverage({ ...prepared, bundle: prepared.decision.bundle }).asked, true);
  const requests = structuredClone(prepared.requests);
  [requests[0].entities[0], requests[0].entities[1]] = [requests[0].entities[1], requests[0].entities[0]];
  assert.equal(assessCoverage({ ...prepared, bundle: prepared.decision.bundle, requests }).reason, 'request_bundle_mismatch');
  assert.equal(assessCoverage({ ...prepared, bundle: prepared.decision.bundle, artifactId: 'another-artifact' }).reason, 'missing_candidate');
  const bundle = { ...prepared.decision.bundle, candidates: prepared.decision.bundle.candidates.filter(c => c.label !== 'db') };
  assert.equal(assessCoverage({ ...prepared, bundle }).reason, 'missing_candidate');
});

test('real A/B service and core compilation score recorded cases after intake rebuilds indices', async () => {
  for (const [id, support, context, nodeSupport] of [
    ['postgres-write', 0.98, 0.02, 0.98],
    ['commonjs-write', 0.98, 0.02, 0.98],
    ['configuration-only', 0.02, 0.02, 0.98],
    ['postgres-read', 0.02, 0.02, 0.7],
    ['unresolved-wrapper', 0.7, 0.9, 0.98],
  ]) {
    const prepared = prepare(id);
    const fixture = createFixtureTransport({
      mode: 'demo',
      candidates: Object.fromEntries(prepared.candidates.map(candidate => [candidate.label, {
        role: candidate.label === prepared.item.expected.source ? prepared.item.expected.sourceRole
          : candidate.label === prepared.item.expected.target ? prepared.item.expected.targetRole : 'module',
        // Removing this earlier CommonJS binding rebuilds db's request-local index.
        relevant: id === 'commonjs-write' && candidate.label === 'Pool' ? 0.01 : 0.98,
        sensitive: 0.01, support: nodeSupport,
      }])),
      relations: [{
        sourceLabel: prepared.item.expected.source, targetLabel: prepared.item.expected.target,
        relation: 'writes', support, missingContext: context,
      }],
    });
    const requests = [];
    const transport = async (url, options) => {
      requests.push(inspectRequest(JSON.parse(options.body)));
      return fixture(url, options);
    };
    Object.defineProperty(transport, Symbol.for('graphlin.jev.recorded-fixture'), { value: true });
    const service = createDecisionService({ fetchImpl: transport, materializeBundle, buildRelationProposals });
    try {
      const decision = await service.classify({ event, candidates: prepared.candidates, policy });
      const initial = emptyGraph(), patch = compileDecision(initial, { event, decision, policy });
      const graph = patch ? applyPatch(initial, patch) : initial;
      const score = scoreCase({ ...prepared, decision, graph, requests });
      assert.equal(score.outcome, 'pass', `${id}: ${JSON.stringify(score)}`);
      assert.deepEqual(requests.map(request => request.stage), ['A', 'B']);
      if (id === 'commonjs-write') {
        assert.notEqual(requests[0].candidateLabels.indexOf('db'), requests[1].candidateLabels.indexOf('db'));
      }
      if (id === 'postgres-read') assert.equal(decision.status, 'abstained');
    } finally {
      service.close();
    }
  }
});

test('positive scoring requires the exact compiled write and accepted endpoints with expected roles', () => {
  const prepared = prepare();
  assert.equal(scoreCase(prepared).outcome, 'pass');
  const endpointId = prepared.graph.edges[0].target;
  for (const change of [
    node => { node.classification = 'tentative'; },
    node => { node.kind = 'module'; },
    node => { node.validity = 'stale'; },
    node => { node.evidenceState = 'proposed'; },
    node => { node.sourceRefs[0].artifactId = 'foreign-artifact'; },
  ]) {
    const graph = structuredClone(prepared.graph);
    change(graph.nodes.find(node => node.id === endpointId));
    assert.equal(scoreCase({ ...prepared, graph }).outcome, 'fail');
  }
  const graph = structuredClone(prepared.graph);
  graph.edges[0].target = graph.nodes.find(node => node.label === 'Pool').id;
  const result = scoreCase({ ...prepared, graph });
  assert.equal(result.outcome, 'fail', 'an accepted write to the wrong target is not success');
  assert.equal(result.checks.noUnexpectedWrites, false);
});

test('an extra incorrect tentative write also fails a positive graph', () => {
  const prepared = prepare();
  const graph = structuredClone(prepared.graph);
  graph.edges.push({ ...graph.edges[0], id: 'unexpected-edge', classification: 'tentative',
    target: graph.nodes.find(node => node.label === 'Pool').id });
  assert.equal(scoreCase({ ...prepared, graph }).outcome, 'fail');
});

test('known negatives require low support, resolved context, and no drawn write even for abstained decisions', () => {
  for (const status of ['accepted', 'abstained']) {
    const prepared = prepare('postgres-read', { support: 0.02, context: 0.02, status });
    const result = scoreCase(prepared);
    assert.equal(result.outcome, 'pass');
    assert.equal(result.checks.noRenderedWrite, true);
  }
  assert.equal(scoreCase(prepare('postgres-read', { support: 0.49, context: 0.1 })).outcome, 'pass');
  for (const [support, context] of [[0.5, 0.02], [0.93, 0.32], [0.02, 0.9]]) {
    assert.equal(scoreCase(prepare('postgres-read', { support, context })).outcome, 'fail');
  }
});

test('a role failure cannot disguise high write support as a successful negative', () => {
  const prepared = prepare('postgres-read', { support: 0.93, context: 0.02 });
  prepared.decision.nodes.forEach(node => { node.supportProbability = 0.1; });
  recompile(prepared);
  assert.equal(prepared.graph.edges.length, 0);
  const result = scoreCase(prepared);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.checks.lowWriteSupport, false);
});

test('uncertainty requires a context veto; weak support alone is insufficient', () => {
  const strong = scoreCase(prepare('unresolved-wrapper', { support: 0.7, context: 0.9 }));
  assert.equal(strong.outcome, 'pass');
  assert.equal(strong.checks.contextClearlyMissing, true);
  const marginal = scoreCase(prepare('dynamic-sql', { support: 0.93, context: 0.32 }));
  assert.equal(marginal.outcome, 'pass');
  assert.equal(marginal.checks.contextBlocksAdmission, true);
  assert.equal(marginal.checks.contextClearlyMissing, false);
  for (const context of [0.02, 0.1]) {
    assert.equal(scoreCase(prepare('unresolved-wrapper', { support: 0.02, context })).outcome, 'fail');
  }
  assert.equal(scoreCase(prepare('postgres-write', { support: 0.93, context: 0.32 })).outcome, 'fail');
});

test('unavailable results, stale evidence, and missing judgments remain inconclusive after dispatch', () => {
  const prepared = prepare();
  assert.equal(scoreCase({ ...prepared, current: false }).reason, 'stale_evidence');
  for (const status of ['timeout', 'invalid', 'irrelevant', 'unavailable']) {
    const result = scoreCase({ ...prepared, decision: { ...prepared.decision, status } });
    assert.equal(result.outcome, 'inconclusive');
    assert.equal(result.coverage.asked, true, 'question dispatch is independent of successful assessment');
  }
  const result = scoreCase({ ...prepared, decision: { ...prepared.decision, edges: [] } });
  assert.equal(result.outcome, 'inconclusive');
});

const numericQuestions = {
  n: { type: 'noul' },
  role: { type: 'choice', criteria: { module: 'Module', unknown: 'Unknown' } },
};
test('numeric observation allowlists answer types/options and discards arbitrary fields and invalid numbers', () => {
  const payload = { answers: {
    n: { type: 'noul', noul: 0.2, explanation: 'DROP_ME' },
    role: { type: 'choice', choice: 'module', confidence: 'DROP_ME',
      probabilities: { module: 0.9, unknown: 0.1, arbitrary: { text: 'DROP_ME' } } },
    unrequested: { type: 'noul', noul: 1 },
  }, arbitrary: 'DROP_ME' };
  assert.deepEqual(selectNumericAnswers(payload, numericQuestions), {
    n: { noul: 0.2 }, role: { choice: 'module', probabilities: { module: 0.9, unknown: 0.1 } },
  });
  for (const value of [-0.1, 1.1, NaN, Infinity, '0.5', null]) {
    payload.answers.n.noul = value;
    payload.answers.role.confidence = value;
    payload.answers.role.probabilities.module = value;
    const selected = selectNumericAnswers(payload, numericQuestions);
    assert.equal(selected.n, undefined);
    assert.equal(selected.role.confidence, undefined);
    assert.equal(selected.role.probabilities.module, undefined);
  }
  payload.answers.role.choice = 'unrequested';
  assert.deepEqual(selectNumericAnswers(payload, numericQuestions), {});
  assert.deepEqual(selectNumericAnswers({ answers: { n: { type: 'choice', choice: 'module' } } }, numericQuestions), {});
});

test('a complete numeric observation leaves the original response readable', async () => {
  const response = new Response(JSON.stringify({ answers: { n: { type: 'noul', noul: 0.1 } } }));
  const result = await observeNumericResponse(response, numericQuestions);
  assert.deepEqual(result, { observation: 'complete', answers: { n: { noul: 0.1 } } });
  assert.equal((await response.json()).answers.n.noul, 0.1);
  const invalid = await observeNumericResponse(new Response('PRIVATE_INVALID_JSON'), numericQuestions);
  assert.deepEqual(invalid, { observation: 'unavailable' });
});

function stuckResponse({ chunk } = {}) {
  let reads = 0, cancelled = 0, released = 0;
  return {
    clone() {
      return { body: { getReader() { return {
        read() {
          reads++;
          return chunk && reads === 1 ? Promise.resolve({ done: false, value: chunk }) : new Promise(() => {});
        },
        cancel() { cancelled++; return new Promise(() => {}); },
        releaseLock() { released++; },
      }; } } };
    },
    get cancelled() { return cancelled; },
    get released() { return released; },
  };
}

test('observer deadline and cleanup do not await a stalled read or stalled cancellation', { timeout: 1000 }, async () => {
  const response = stuckResponse();
  assert.deepEqual(await observeNumericResponse(response, numericQuestions, { timeoutMs: 10 }), { observation: 'timed_out' });
  assert.equal(response.cancelled, 1);
  assert.equal(response.released, 1);
});

test('observer abort bounds final cleanup independently of fetch and its body', { timeout: 1000 }, async () => {
  const response = stuckResponse();
  const controller = new AbortController();
  const result = observeNumericResponse(response, numericQuestions, { signal: controller.signal, timeoutMs: 10000 });
  controller.abort();
  assert.deepEqual(await result, { observation: 'aborted' });
  assert.equal(response.cancelled, 1);
  assert.equal(response.released, 1);
  assert.deepEqual(await observeNumericResponse({
    clone() { throw new Error('SHOULD_NOT_CLONE'); },
  }, numericQuestions, { signal: controller.signal }), { observation: 'aborted' });
});

test('observer byte limit stops before parsing and does not await cancellation', { timeout: 1000 }, async () => {
  const response = stuckResponse({ chunk: new Uint8Array(9) });
  assert.deepEqual(await observeNumericResponse(response, numericQuestions, { maxBytes: 8 }), { observation: 'too_large' });
  assert.equal(response.cancelled, 1);
  assert.equal(response.released, 1);
});

test('CLI parsing retains explicit repeats and diagnostic deadlines without executing live work', () => {
  const defaults = parseEvaluationOptions([]);
  assert.equal(defaults.deadlineMs, 2000);
  assert.equal(defaults.repeats, 1);
  assert.equal(defaults.selectedCases.length, 14);
  const diagnostic = parseEvaluationOptions(['--case', 'postgres-write', '--repeat', '3',
    '--deadline-ms', '8000', '--request-limit', '6']);
  assert.equal(diagnostic.deadlineMs, 8000);
  assert.equal(diagnostic.repeats, 3);
  assert.equal(diagnostic.requestLimit, 6);
  assert.equal(diagnostic.selectedCases[0].id, 'postgres-write');
  assert.throws(() => parseEvaluationOptions(['--case']), /UNKNOWN_EVALUATION_CASE/);
  assert.throws(() => parseEvaluationOptions(['--repeat', '0']), /INVALID_REPEAT/);
  assert.throws(() => parseEvaluationOptions(['--deadline-ms', '1999']), /INVALID_DEADLINE/);
  assert.throws(() => parseEvaluationOptions(['--request-limit', '1']), /EVALUATION_EXCEEDS_REQUEST_LIMIT/);
});
