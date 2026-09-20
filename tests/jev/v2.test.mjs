import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntakeRequest, buildGraphRequest, evidenceState } from '../../runtime/jev/questions.mjs';
import { createDecisionService, createFixtureTransport } from '../../runtime/jev/index.mjs';
import {
  candidate, proposal, input, makeCore, recordingTransport, wireEvent, MODEL,
} from './helpers.mjs';

const code = 'const db = new Pool({ connectionString: process.env.DATABASE_URL });\n'
  + 'export function saveNote(body) { return db.query("INSERT INTO notes VALUES ($1)", [body]); }';
function shared(id, label, overrides = {}) {
  return candidate(id, {
    artifactId: 'artifact-shared', hash: 'hash-shared', generation: 1,
    sourceRef: { type: 'artifact', artifactId: 'artifact-shared', hash: 'hash-shared', generation: 1 },
    text: code, startLine: 1, endLine: 2, label, ...overrides,
  });
}
function service(t, options) {
  const result = createDecisionService({ apiKey: 'offline-dummy', ...makeCore(), ...options });
  t.after(() => result.close());
  return result;
}

test('v2 sends one evidence record and ten questions for eight entities in the same span', () => {
  const labels = ['db', 'Pool', 'saveNote', 'env', 'DATABASE_URL', 'INSERT', 'INTO', 'VALUES'];
  const candidates = labels.map((label, i) => shared(`private-hash-${i}`, label));
  const request = buildIntakeRequest(MODEL, wireEvent, candidates);
  assert.equal(request.state.evidence.length, 1);
  assert.equal(request.state.evidence[0].code, code);
  assert.deepEqual(request.state.entities, labels.map(name => ({ name, sourceIndex: 0 })));
  assert.equal(Object.keys(request.questions).length, 10);
  assert.deepEqual(Object.keys(request.questions).filter(id => id.startsWith('a_sensitive_')),
    ['a_sensitive_0']);
  const encoded = JSON.stringify(request);
  for (const c of candidates) {
    for (const privateValue of [c.id, c.digest, c.entityKey, c.hash, c.artifactId]) {
      assert.ok(!encoded.includes(privateValue), 'source/version identifiers remain local');
    }
  }
  assert.ok(!encoded.includes('state.'));
  for (const [i] of labels.entries()) {
    const question = request.questions[`a_relevant_${i}`].instructions.question;
    assert.ok(question.includes('`evidence[0].code`'));
    assert.ok(question.includes(`\`entities[${i}].name\``));
  }
  assert.match(request.questions.a_relevant_0.instructions.focus, /database client bindings.*qualify/);
  assert.match(request.questions.a_sensitive_0.instructions.focus, /not the credential value/);
  assert.match(request.questions.a_sensitive_0.criteria.true, /actual credential/i);
  assert.match(request.questions.a_sensitive_0.criteria.false, /environment-variable/);
});

test('one shared sensitivity verdict reaches every original candidate digest unchanged', async t => {
  const candidates = [shared('local-db', 'db'), shared('local-save', 'saveNote')];
  const core = makeCore();
  const transport = recordingTransport();
  const result = await service(t, { ...core, ...transport }).classify(input({ candidates }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.bundle, core.calls.bundle);
  assert.deepEqual(core.calls.materialize[0].verdicts, candidates.map(c => ({
    candidateId: c.id, digest: c.digest, relevant: 0.97, sensitive: 0.01,
  })));
  assert.deepEqual(result.diagnostics.questionCounts, { A: 4, B: 5 });
  assert.equal(transport.calls[1].request.state.evidence.length, 1);
  assert.equal(result.stages.A.rubricVersion, 'intake-v3');
  assert.equal(result.stages.B.rubricVersion, 'architecture-v6');
});

test('unsafe shared evidence withholds all its names; B rebuilds clean indices after filtering', async t => {
  const candidates = [
    shared('blocked-a', 'WITHHELD_FIRST'),
    shared('blocked-b', 'WITHHELD_SECOND'),
    candidate('safe', { label: 'saveNote', text: 'export function saveNote() { return 1; }' }),
  ];
  const transport = recordingTransport(value => {
    if (value.answers.a_sensitive_0) value.answers.a_sensitive_0.noul = 0.11;
    return value;
  });
  const result = await service(t, transport).classify(input({ candidates }));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.bundle.candidates.map(c => c.id), ['safe']);
  const b = transport.calls[1].request;
  assert.deepEqual(b.state.entities, [{ name: 'saveNote', sourceIndex: 0 }]);
  assert.equal(b.state.evidence.length, 1);
  assert.ok(b.questions.b_role_0.instructions.question.includes('`entities[0].name`'));
  assert.ok(b.questions.b_role_0.instructions.question.includes('`evidence[0].code`'));
  assert.doesNotMatch(JSON.stringify(b), /WITHHELD_FIRST|WITHHELD_SECOND|INSERT INTO/);
});

test('shared sensitivity never turns a low-relevance sibling into an approved entity', async t => {
  const transport = recordingTransport(value => {
    if (value.answers.a_relevant_1) value.answers.a_relevant_1.noul = 0.3;
    return value;
  });
  const result = await service(t, transport).classify(input({
    candidates: [shared('local-db', 'db'), shared('local-sql', 'INSERT')],
  }));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.bundle.candidates.map(c => c.id), ['local-db']);
});

test('missing or invalid shared sensitivity invalidates A without materializing a bundle', async t => {
  for (const invalid of [undefined, NaN, 1.1]) {
    const core = makeCore();
    const transport = recordingTransport(value => {
      if (invalid === undefined) delete value.answers.a_sensitive_0;
      else value.answers.a_sensitive_0.noul = invalid;
      return value;
    });
    const result = await service(t, { ...core, ...transport }).classify(input({
      candidates: [shared('local-db', 'db'), shared('local-save', 'saveNote')],
    }));
    assert.equal(result.status, 'invalid');
    assert.equal(core.calls.materialize.length, 0);
    assert.equal(transport.calls.length, 1);
  }
});

test('evidence grouping requires the same source, hash, generation, and exact range', () => {
  const a = shared('a', 'db');
  const variants = [
    shared('b', 'saveNote'),
    shared('other-source', 'db', { sourceRef: { ...a.sourceRef, artifactId: 'other-artifact' } }),
    shared('other-hash', 'db', { sourceRef: { ...a.sourceRef, hash: 'new-hash' } }),
    shared('other-generation', 'db', { sourceRef: { ...a.sourceRef, generation: 2 } }),
    shared('other-range', 'db', { startLine: 2, endLine: 3 }),
    shared('message', 'db', { sourceClass: 'public_intent',
      sourceRef: { type: 'message', messageId: 'artifact-shared', hash: 'hash-shared', contentVersion: 1 } }),
  ];
  const state = evidenceState([a, ...variants]);
  assert.equal(state.evidence.length, 6);
  assert.deepEqual(state.entities.map(e => e.sourceIndex), [0, 0, 1, 2, 3, 4, 5]);
  assert.throws(() => evidenceState([a, shared('conflict', 'db', { text: 'different content' })]),
    /inconsistent_evidence/);
  assert.throws(() => evidenceState([a, shared('partial', 'db', { complete: false })]),
    /inconsistent_evidence/);
});

test('B addresses reordered endpoints and each evidence span directly without copying local IDs', () => {
  const candidates = [shared('target-private', 'db'), shared('source-private', 'saveNote')];
  const proposals = [proposal('proposal-private', {
    sourceCandidateId: 'source-private', targetCandidateId: 'target-private',
    evidenceCandidateIds: ['source-private', 'target-private'],
  })];
  const request = buildGraphRequest(MODEL, wireEvent, { candidates }, proposals);
  assert.deepEqual(request.state.proposals, [{
    sourceEntityIndex: 1, targetEntityIndex: 0, relation: 'writes', evidenceIndices: [0],
  }]);
  for (const id of ['b_relation_0', 'b_context_0']) {
    const question = request.questions[id].instructions.question;
    assert.ok(question.includes('`entities[1].name`'));
    assert.ok(question.includes('submit an operation'));
    assert.ok(question.includes('`entities[0].name`'));
    assert.equal(question.split('`evidence[0].code`').length - 1, 1);
    assert.ok(question.includes('relation "writes"'));
  }
  assert.doesNotMatch(JSON.stringify(request), /source-private|target-private|proposal-private|state\./);
  assert.match(request.questions.b_role_0.criteria.datastore, /visible real database driver/);
  assert.match(request.state.context.kindLimits, /mock.*not a datastore/);
  assert.match(request.questions.b_context_0.instructions.focus, /unresolved wrapper/i);
});

test('twelve shared-span candidates cost fourteen A questions and stay inside the forty-question B cap', async t => {
  const candidates = Array.from({ length: 12 }, (_, i) => shared(`local-${i}`, `entity${i}`));
  const transport = recordingTransport();
  const result = await service(t, transport).classify(input({ candidates }));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.diagnostics.questionCounts, { A: 14, B: 25 });
  assert.equal(transport.calls[0].request.state.evidence.length, 1);
});

test('v2 fixture lookup uses entity names, combines shared safety, and still never interprets code', async t => {
  const fetchImpl = createFixtureTransport({
    mode: 'demo',
    candidates: {
      saveNote: { role: 'module', relevant: 0.98, sensitive: 0.01, support: 0.97 },
      db: { role: 'datastore', relevant: 0.98, sensitive: 0.01, support: 0.97 },
    },
    relations: [{ sourceLabel: 'saveNote', targetLabel: 'db', relation: 'writes',
      support: 0.97, missingContext: 0.02 }],
  });
  const core = makeCore({ proposals: [proposal('local-proposal', {
    sourceCandidateId: 'source-private', targetCandidateId: 'target-private',
    evidenceCandidateIds: ['source-private', 'target-private'],
  })] });
  const result = await service(t, { ...core, fetchImpl }).classify(input({
    candidates: [shared('source-private', 'saveNote'), shared('target-private', 'db')],
  }));
  assert.equal(result.edges[0].classification, 'accepted');
  assert.equal(result.edges[0].sourceCandidateId, 'source-private');
  assert.equal(result.diagnostics.mode, 'demo');
  assert.deepEqual(result.diagnostics.questionCounts, { A: 4, B: 7 });
  const blocked = await service(t, { fetchImpl }).classify(input({
    candidates: [shared('known', 'saveNote'), shared('unknown', 'unrecorded')],
  }));
  assert.equal(blocked.bundle.candidates.length, 0);
  assert.equal(blocked.diagnostics.calls, 1);
});
