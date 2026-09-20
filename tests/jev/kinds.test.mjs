import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createPolicy, metadataEvent, buildCandidates, materializeBundle, buildRelationProposals,
  emptyGraph, compileDecision, applyPatch,
} from '../../runtime/core/index.mjs';
import { createDecisionService, createFixtureTransport, DEFAULT_ADMISSION_POLICY } from '../../runtime/jev/index.mjs';
import { buildGraphRequest, buildIntakeRequest, ROLES, RUBRICS } from '../../runtime/jev/questions.mjs';
import { validateResponse } from '../../runtime/jev/wire.mjs';
import { shapeProbes } from './fixtures/shape-probes.mjs';
import { v4KindFailures } from './fixtures/kind-failures-v4.mjs';
import { v5KindFailures } from './fixtures/kind-failures-v5.mjs';
import { inspectRequest, assessCoverage, preflightCase, scoreCase, parseEvaluationOptions } from '../../scripts/evaluate-jev.mjs';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({
  id: 'kind-test', projectId: 'kind-project', sessionId: 'kind-session',
  kind: 'artifact.changed', incomplete: false, sequence: 1,
});
function prepare(item) {
  const artifact = {
    id: `artifact-${createHash('sha256').update(item.id).digest('hex').slice(0, 32)}`,
    hash: createHash('sha256').update(item.source).digest('hex'), generation: 1,
    text: item.source, relativePath: item.filename ?? 'shape-test.js',
    status: 'present', exists: true, complete: true,
  };
  const candidates = buildCandidates({ event, artifacts: [artifact], policy });
  return { item, artifactId: artifact.id, event, candidates, policy };
}

async function classify(item, { changeAnswer, exclude } = {}) {
  const prepared = prepare(item);
  // Literal fixture expectations are scripted answers, not source interpretation.
  const fixture = createFixtureTransport({
    mode: 'demo', relations: [],
    candidates: Object.fromEntries(prepared.candidates.map(candidate => [candidate.label, {
      role: item.expected.nodes.find(node => node.name === candidate.label)?.role ?? 'module',
      relevant: candidate.label === exclude ? 0.01 : 0.98, sensitive: 0.01, support: 0.98,
    }])),
  });
  const requests = [], bodies = [];
  const transport = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    requests.push(inspectRequest(body));
    const response = await fixture(url, options);
    if (!changeAnswer || !body.questions.b_relevance) return response;
    const value = await response.json();
    changeAnswer(value, body);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  Object.defineProperty(transport, Symbol.for('graphlin.jev.recorded-fixture'), { value: true });
  const service = createDecisionService({ fetchImpl: transport, materializeBundle, buildRelationProposals });
  try {
    const decision = await service.classify({ event, candidates: prepared.candidates, policy });
    const initial = emptyGraph(), patch = compileDecision(initial, { event, decision, policy });
    const graph = patch ? applyPatch(initial, patch) : initial;
    return { ...prepared, decision, graph, requests, bodies };
  } finally {
    service.close();
  }
}

test('v6 has thirteen explicit kind choices, ordered binding rules, and unchanged question counts', () => {
  assert.equal(ROLES.length, 13);
  assert.equal(new Set(ROLES).size, 13);
  assert.deepEqual(RUBRICS, { A: 'intake-v3', B: 'architecture-v6' });
  for (const item of shapeProbes) {
    const prepared = prepare(item);
    const a = buildIntakeRequest('jev-1.13.0', event, prepared.candidates);
    const b = buildGraphRequest('jev-1.13.0', event, { candidates: prepared.candidates }, []);
    assert.equal(Object.keys(a.questions).length, 1 + a.state.evidence.length + prepared.candidates.length);
    assert.equal(Object.keys(b.questions).length, 1 + 2 * prepared.candidates.length);
    assert.match(a.questions.a_relevant_0.instructions.question, /interface, type/);
    const choice = b.questions.b_role_0;
    assert.deepEqual(Object.keys(choice.criteria), ROLES);
    assert.match(choice.instructions.focus, /`context.kind` and `context.kindLimits`/);
    assert.match(b.state.context.kind, /function, class, and interface declarations take precedence/);
    assert.match(b.state.context.kind, /rules in order: 1\).*2\).*3\)/);
    assert.match(b.state.context.kindLimits, /event-like name alone is insufficient/);
    assert.match(b.state.context.kindLimits, /Event\/data objects are not queues/);
    assert.match(b.state.context.kindLimits, /Imports, aliases, and module URLs never prove remote services or execution/);
    assert.match(b.state.context.kindLimits, /non-interface type aliases/);
    assert.match(b.state.context.kind, /namespace import binding \(import \* as alias\) has kind package/);
    assert.match(b.state.context.kind, /named-member import binding without a visible local declaration has kind module, including a database-driver constructor/);
    assert.match(b.state.context.kindLimits, /exact binding is a store or an instantiated receiver/);
    assert.match(b.state.context.kindLimits, /bare imported constructor is module, even when a separate receiver is constructed from it/);
    assert.match(b.state.context.kindLimits, /configuration only; no query or working connection is required/);
    assert.match(choice.criteria.module, /ordinary data object/);
    assert.match(choice.criteria.module, /named-member import \(including a driver constructor\)/);
    assert.match(choice.criteria.datastore, /never a bare constructor import/);
    assert.match(choice.criteria.event, /beyond its identifier name/);
  }
});

for (const item of shapeProbes) {
  test(`recorded kind probe compiles and scores exact entities: ${item.id}`, async () => {
    const prepared = prepare(item);
    const preflight = preflightCase(prepared);
    assert.equal(preflight.routable, true, preflight.reason);
    const result = await classify(item);
    assert.equal(result.decision.stages.A.rubricVersion, 'intake-v3');
    assert.equal(result.decision.stages.B.rubricVersion, 'architecture-v6');
    assert.equal(result.decision.stages.B.mode, 'demo');
    assert.equal(scoreCase(result).outcome, 'pass', JSON.stringify(result.decision.diagnostics));
    for (const body of result.bodies) {
      assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 64 * 1024);
      assert.ok(Object.keys(body.questions).length <= 40);
    }
    const b = result.bodies[1];
    assert.equal(Object.keys(b.questions).length, 1 + 2 * b.state.entities.length + 2 * b.state.proposals.length);
    assert.ok(result.decision.nodes.every(node => Object.keys(node.roleProbabilities).length === 13));
    for (const expected of item.expected.nodes) {
      const node = result.graph.nodes.find(node => node.label === expected.name);
      assert.equal(node.kind, expected.role);
      assert.equal(node.classification, 'accepted');
      assert.equal(node.evidenceState, 'observed');
    }
  });
}

test('recorded constructor and receiver remain separate entities sharing one source snippet', async () => {
  const item = {
    id: 'constructor-receiver-contrast', expectation: 'kinds',
    expected: { nodes: [
      { name: 'ConnectionFactory', role: 'module' },
      { name: 'receiver', role: 'datastore' },
    ] },
    source: `import { Client as ConnectionFactory } from "pg";
export const receiver = new ConnectionFactory();
export { ConnectionFactory };`,
  };
  assert.equal(preflightCase(prepare(item)).routable, true);
  const result = await classify(item);
  assert.equal(scoreCase(result).outcome, 'pass');
  const body = result.bodies[1];
  assert.equal(body.state.entities.length, 2);
  assert.equal(body.state.evidence.length, 1);
  assert.equal(result.decision.bundle.candidates.length, 2);
  for (const expected of item.expected.nodes) {
    const index = body.state.entities.findIndex(entity => entity.name === expected.name);
    assert.ok(index >= 0);
    assert.equal(body.state.entities[index].sourceIndex, 0);
    assert.equal(body.questions[`b_role_${index}`].instructions.question,
      `What is the primary display kind of \`entities[${index}].name\` in \`evidence[0].code\`?`);
    assert.equal(result.graph.nodes.find(node => node.label === expected.name).kind, expected.role);
  }
});

test('all new kinds validate full distributions; a seven-option response is invalid for v6', () => {
  const prepared = prepare(shapeProbes[0]);
  const question = buildGraphRequest('jev-1.13.0', event, { candidates: prepared.candidates }, []).questions.b_role_0;
  const request = { model: 'jev-1.13.0', questions: { kind: question } };
  const answer = choice => ({
    model: request.model, usage: { input_tokens: 0, output_tokens: 0 },
    answers: { kind: { type: 'choice', choice, confidence: 0.99,
      probabilities: Object.fromEntries(ROLES.map(role => [role, role === choice ? 1 : 0])) } },
  });
  for (const role of ROLES) assert.equal(validateResponse(answer(role), request).answers.kind.choice, role);
  const old = answer('module');
  for (const role of ['function', 'class', 'interface', 'event', 'configuration', 'package']) {
    delete old.answers.kind.probabilities[role];
  }
  assert.throws(() => validateResponse(old, request), /invalid_probabilities/);
  const invalid = answer('function');
  invalid.answers.kind.probabilities.class = 0.2;
  assert.throws(() => validateResponse(invalid, request), /invalid_probability_sum/);
});

test('older module judgments with seven probabilities remain valid for core compilation', () => {
  const prepared = prepare(shapeProbes[0]);
  const bundle = materializeBundle({
    ...prepared, verdicts: prepared.candidates.map(candidate => ({
      candidateId: candidate.id, digest: candidate.digest, relevant: 1, sensitive: 0,
    })),
  });
  const decision = {
    status: 'accepted', bundle, edges: [],
    stages: { B: { rubricVersion: 'architecture-v3', mode: 'demo' } },
    nodes: bundle.candidates.map(candidate => ({
      candidateId: candidate.id, role: 'module', supportProbability: 0.98,
      roleProbability: 0.99, roleConfidence: 0.99, classification: 'accepted',
      roleProbabilities: { client: 0, service: 0, datastore: 0, queue: 0, external: 0, module: 0.99, unknown: 0.01 },
    })),
  };
  const graph = emptyGraph(), patch = compileDecision(graph, { event, decision, policy });
  assert.ok(patch);
  assert.equal(applyPatch(graph, patch).nodes[0].kind, 'module');
});

test('kind scoring rejects a confident wrong kind and ambiguity still abstains at unchanged thresholds', async () => {
  const item = shapeProbes.find(probe => probe.id === 'kind-function');
  const wrong = await classify(item, { changeAnswer(value) {
    value.answers.b_role_0.choice = 'service';
    value.answers.b_role_0.probabilities = Object.fromEntries(ROLES.map(role => [role, role === 'service' ? 1 : 0]));
  } });
  assert.equal(wrong.graph.nodes[0].classification, 'accepted');
  assert.equal(scoreCase(wrong).outcome, 'fail');
  const ambiguous = await classify(item, { changeAnswer(value) {
    value.answers.b_role_0.probabilities = Object.fromEntries(ROLES.map(role =>
      [role, role === 'function' ? 0.55 : role === 'service' ? 0.45 : 0]));
  } });
  assert.equal(DEFAULT_ADMISSION_POLICY.roleProbabilityMin, 0.8);
  assert.equal(DEFAULT_ADMISSION_POLICY.roleConfidenceMin, 0.6);
  assert.equal(ambiguous.decision.status, 'abstained');
  assert.equal(ambiguous.graph.nodes[0].classification, 'tentative');
  assert.equal(scoreCase(ambiguous).outcome, 'fail');
});

test('kind coverage needs the exact role/support questions and all expected entities after intake', async () => {
  const item = shapeProbes.find(probe => probe.id === 'kind-interface');
  const result = await classify(item);
  const missing = structuredClone(result.bodies[1]);
  delete missing.questions.b_role_0;
  const requests = [inspectRequest(missing)];
  assert.equal(assessCoverage({ ...result, bundle: result.decision.bundle, requests }).asked, false);
  assert.equal(scoreCase({ ...result, requests }).outcome, 'inconclusive');
  const missingSupport = structuredClone(result.bodies[1]);
  delete missingSupport.questions.b_support_0;
  assert.equal(scoreCase({ ...result, requests: [inspectRequest(missingSupport)] }).outcome, 'inconclusive');
  const filtered = await classify(shapeProbes.find(probe => probe.id === 'kind-configuration'), { exclude: 'poolOptions' });
  assert.ok(filtered.decision.nodes.length > 0);
  assert.equal(scoreCase(filtered).outcome, 'inconclusive');
});

for (const [version, failure] of [
  ...v4KindFailures.map(failure => ['v4', failure]),
  ...v5KindFailures.map(failure => ['v5', failure]),
]) {
  test(`recorded ${version} failure still fails unchanged gates: ${failure.caseId} repeat ${failure.repeat}`, async () => {
    const item = shapeProbes.find(probe => probe.id === failure.caseId);
    const result = await classify(item, { changeAnswer(value, body) {
      for (const judgment of failure.judgments) {
        const index = body.state.entities.findIndex(entity => entity.name === judgment.name);
        assert.ok(index >= 0);
        value.answers[`b_role_${index}`] = {
          type: 'choice', choice: judgment.choice, confidence: judgment.confidence,
          probabilities: Object.fromEntries(ROLES.map(role => [role, judgment.probabilities[role] ?? 0])),
        };
        value.answers[`b_support_${index}`].noul = judgment.support;
      }
    } });
    const score = scoreCase(result);
    assert.equal(result.decision.status, failure.status);
    assert.equal(score.coverage.asked, true);
    assert.equal(score.outcome, 'fail');
    for (const original of failure.judgments) {
      const replayed = score.kindJudgments.find(judgment => judgment.name === original.name);
      assert.equal(replayed.role, original.choice);
      assert.equal(replayed.roleProbability, original.probabilities[original.choice]);
      assert.equal(replayed.roleConfidence, original.confidence);
      assert.equal(replayed.supportProbability, original.support);
      assert.equal(replayed.expectedRole, original.expectedRole);
    }
  });
}

test('kind suite selection is explicit; default write suite, repeats, and deadlines remain intact', () => {
  assert.equal(parseEvaluationOptions([]).selectedCases.length, 14);
  const kinds = parseEvaluationOptions(['--suite', 'kinds', '--repeat', '2', '--deadline-ms', '8000']);
  assert.equal(kinds.selectedCases.length, shapeProbes.length);
  assert.equal(kinds.repeats, 2);
  assert.equal(kinds.deadlineMs, 8000);
  assert.equal(parseEvaluationOptions(['--case', 'kind-interface']).suite, 'kinds');
  assert.equal(parseEvaluationOptions(['--suite', 'all']).selectedCases.length, 14 + shapeProbes.length);
  assert.throws(() => parseEvaluationOptions(['--suite', 'unknown']), /UNKNOWN_EVALUATION_SUITE/);
  assert.throws(() => parseEvaluationOptions(['--suite', 'writes', '--case', 'kind-interface']), /UNKNOWN_EVALUATION_CASE/);
});

test('twelve maximum ASCII spans retain all 39 B questions inside the unchanged 64 KiB cap', async t => {
  const artifacts = Array.from({ length: 12 }, (_, i) => {
    const lines = [
      `export function handleRecord${i}(record) {`,
      '  if (!record) return null;',
      ...Array.from({ length: 19 }, (_, j) =>
        `  if (record.kind === "status-${j}") return { id: record.id, active: true };`),
      '  // ',
      '  return { id: record.id, active: false };',
      '}',
    ];
    lines[21] += 'Bounded input transformation. '.repeat(100).slice(0, 1800 - lines.join('\n').length);
    const text = lines.join('\n');
    assert.equal(text.length, 1800);
    assert.equal(lines.length, 24);
    return {
      id: `artifact-${String(i).padStart(32, '0')}`, relativePath: `record-${i}.mjs`,
      hash: createHash('sha256').update(text).digest('hex'), generation: 1,
      text, complete: true, exists: true, status: 'present',
    };
  });
  const candidates = buildCandidates({ event, artifacts, policy });
  assert.equal(candidates.length, 12);
  assert.ok(candidates.every(candidate => candidate.text.length === 1800));
  const fixture = createFixtureTransport({
    mode: 'demo', relations: [],
    candidates: Object.fromEntries(candidates.map(candidate => [candidate.label, {
      role: 'function', relevant: 0.98, sensitive: 0.01, support: 0.98,
    }])),
  });
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ bytes: Buffer.byteLength(options.body), body: JSON.parse(options.body) });
    return fixture(url, options);
  };
  Object.defineProperty(transport, Symbol.for('graphlin.jev.recorded-fixture'), { value: true });
  const service = createDecisionService({ fetchImpl: transport, materializeBundle, buildRelationProposals });
  t.after(() => service.close());
  const decision = await service.classify({ event, candidates, policy });
  assert.equal(decision.status, 'accepted', JSON.stringify(decision.diagnostics));
  assert.equal(calls.length, 2, 'both stages dispatch without silently losing the common 12-candidate case');
  assert.deepEqual(decision.diagnostics.questionCounts, { A: 25, B: 39 });
  assert.equal(decision.nodes.length, 12);
  assert.equal(decision.edges.length, 7);
  assert.equal(calls[1].body.state.evidence.length, 12);
  assert.equal(calls[1].body.state.proposals.length, 7);
  assert.ok(calls.every(call => call.bytes <= 65536));
  assert.ok(decision.nodes.every(node => Object.keys(node.roleProbabilities).length === 13));
  t.diagnostic(`12 candidates, 12 spans of 1800 ASCII characters/24 lines: A=${calls[0].bytes} bytes; B=${calls[1].bytes} bytes; cap=65536.`);
});
