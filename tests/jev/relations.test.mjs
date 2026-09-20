import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDecisionService, DEFAULT_ADMISSION_POLICY } from '../../runtime/jev/index.mjs';
import { buildGraphRequest, RELATIONS } from '../../runtime/jev/questions.mjs';
import { relationContextProbes } from './fixtures/relation-context.mjs';
import { candidate, input, proposal, makeCore, recordingTransport, MODEL, wireEvent } from './helpers.mjs';

test('all six relation verbs and function-level context scopes have a fixed wire contract', async () => {
  const candidates = [candidate(), candidate('c2')];
  const proposals = RELATIONS.map((relation, i) => proposal(`p${i}`, { relation }));
  const request = buildGraphRequest(MODEL, wireEvent, { candidates }, proposals);
  const golden = JSON.parse(await readFile(new URL('./fixtures/request-relations.json', import.meta.url)));
  assert.deepEqual(request, golden);
  assert.equal(Object.keys(request.questions).length, 17);
  const verbs = [
    'invoke', 'retrieve application data from', 'submit an operation that persists or changes application data in',
    'send messages or events to', 'receive or handle messages or events from', 'use as a software dependency',
  ];
  for (const [i, verb] of verbs.entries()) {
    const support = request.questions[`b_relation_${i}`];
    const missing = request.questions[`b_context_${i}`];
    assert.ok(support.instructions.question.includes(verb));
    assert.ok(missing.instructions.question.includes(verb));
    assert.match(missing.instructions.question, /local implementation, receiver binding, or operation/);
    assert.match(missing.instructions.focus, /unresolved wrapper such as repository\.save/);
    assert.match(missing.instructions.focus, /unknown receiver, or unknown SQL/);
    assert.match(missing.instructions.focus, /Upstream callers, live DATABASE_URL values, successful connections, and third-party driver internals are not required/);
    assert.match(missing.instructions.focus, /unsupported does not itself mean missing context/);
    assert.doesNotMatch(support.instructions.focus, /absent caller path/);
  }
  assert.match(request.questions.b_relation_3.criteria.false, /ordinary database INSERT or UPDATE is not message publication/);
  assert.match(request.questions.b_relation_4.criteria.false, /result rows, INSERT, SELECT/);
  assert.match(request.questions.b_relation_4.criteria.false, /not message consumption/);
});

for (const fixture of relationContextProbes) {
  test(`offline admission fixture: ${fixture.id}`, async t => {
    const hash = createHash('sha256').update(fixture.source).digest('hex');
    const sourceRef = { type: 'artifact', artifactId: 'artifact-fixture', hash, generation: 1 };
    const shared = { artifactId: sourceRef.artifactId, hash, generation: 1, sourceRef,
      text: fixture.source, startLine: 1, endLine: fixture.source.split('\n').length };
    const candidates = [
      candidate('c1', { ...shared, label: fixture.sourceLabel }),
      candidate('c2', { ...shared, label: fixture.targetLabel }),
    ];
    // Scripted answers exercise transport/admission only; live evaluation must
    // establish whether Jev follows these rubric distinctions on the snippets.
    const transport = recordingTransport((value, request) => {
      if (request.questions.b_relation_0) {
        value.answers.b_relation_0.noul = fixture.support;
        value.answers.b_context_0.noul = fixture.missingContext;
      }
      return value;
    });
    const service = createDecisionService({
      apiKey: 'offline-dummy', ...transport,
      ...makeCore({ proposals: [proposal('p1', { relation: fixture.relation })] }),
    });
    t.after(() => service.close());
    const decision = await service.classify(input({ candidates }));
    assert.equal(decision.edges[0].classification, fixture.classification);
    assert.equal(decision.edges[0].missingContextProbability, fixture.missingContext);
    assert.equal(decision.stages.A.rubricVersion, 'intake-v3');
    assert.equal(decision.stages.B.rubricVersion, 'architecture-v6');
    const b = transport.calls[1].request;
    assert.equal(b.state.evidence.length, 1);
    assert.equal(b.state.evidence[0].code, fixture.source);
    assert.match(b.state.context.scope, /when invoked/);
    assert.match(b.questions.b_context_0.instructions.focus, /known driver import, receiver binding/);
    assert.deepEqual(decision.diagnostics.questionCounts, { A: 4, B: 7 });
  });
}

test('the observed 0.93 support / 0.32 missing-context combination still stays tentative', async t => {
  const transport = recordingTransport((value, request) => {
    if (request.questions.b_relation_0) {
      value.answers.b_relation_0.noul = 0.93;
      value.answers.b_context_0.noul = 0.32;
    }
    return value;
  });
  const service = createDecisionService({
    apiKey: 'offline-dummy', ...transport, ...makeCore({ proposals: [proposal()] }),
  });
  t.after(() => service.close());
  const decision = await service.classify(input({ candidates: [candidate(), candidate('c2')] }));
  assert.equal(DEFAULT_ADMISSION_POLICY.edgeSupportMin, 0.85);
  assert.equal(DEFAULT_ADMISSION_POLICY.missingContextMax, 0.1);
  assert.equal(decision.edges[0].classification, 'tentative');
});
