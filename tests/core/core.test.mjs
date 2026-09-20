import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createPolicy, normalizeHostEvent, metadataEvent, EvidenceStore, buildCandidates, materializeBundle,
  buildRelationProposals, emptyGraph, compileDecision, invalidateArtifacts, applyPatch, projectGraph,
} from '../../runtime/core/index.mjs';
import { LIMITS, opaque } from '../../runtime/core/common.mjs';

const source = 'import { Pool } from "pg";\nconst db = new Pool();\nexport function saveNote(body) {\n  return db.query("INSERT INTO notes VALUES ($1)", [body]);\n}';
const policy = createPolicy({ transmitSource: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const event = (sequence = 1, raw = {}) => normalizeHostEvent({
  hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: `call-${sequence}`,
  session_id: 'session', ...raw,
}, { projectId: 'a'.repeat(24), sequence, now: '2026-09-19T12:00:00.000Z' }).event;
const artifact = (text = source, name = 'notes.js', generation = 1) => ({
  id: opaque('artifact', name), path: `/example/${name}`, relativePath: name, hash: digest(text),
  generation, exists: true, status: 'present', complete: true, text,
});
function input({ text = source, name, generation, e = event(), p = policy } = {}) {
  const a = artifact(text, name, generation);
  return { artifact: a, candidates: buildCandidates({ event: e, artifacts: [a], policy: p }), event: e, policy: p };
}
const verdicts = candidates => candidates.map(c => ({ candidateId: c.id, digest: c.digest, sensitive: 0.01, relevant: 0.99 }));
function decision(prepared, { edges = true, judgment = {} } = {}) {
  const bundle = materializeBundle({ ...prepared, verdicts: verdicts(prepared.candidates) });
  return {
    status: 'accepted', bundle, activity: 'implement',
    nodes: bundle.candidates.map(c => ({
      candidateId: c.id, role: 'module', supportProbability: 0.99, roleProbability: 0.99, roleConfidence: 0.95,
      roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted', ...judgment,
    })),
    edges: edges ? buildRelationProposals(bundle).proposals.map(({ id, ...proposal }) => ({
      proposalId: id, ...proposal, supportProbability: 0.99, missingContextProbability: 0.01, classification: 'accepted',
    })) : [],
  };
}
function compiled(prepared = input(), options) {
  const d = decision(prepared, options);
  const patch = compileDecision(emptyGraph(), { ...prepared, decision: d });
  assert.ok(patch);
  return { ...prepared, decision: d, patch, graph: applyPatch(emptyGraph(), patch) };
}
async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, canonical: await realpath(root) };
}

test('policy is immutable, default private, bounded, and idempotent', () => {
  const defaults = createPolicy();
  assert.equal(defaults.transmitSource, false);
  assert.equal(defaults.persistEvidence, false);
  assert.ok(Object.isFrozen(defaults.excludePaths));
  const configured = createPolicy({ transmitSource: true, excludePaths: Array.from({ length: 100 }, (_, i) => `custom-${i}/**`) });
  assert.deepEqual(createPolicy(configured), configured);
  assert.notEqual(configured.version, defaults.version);
  assert.notEqual(createPolicy({ ...configured, persistEvidence: true }).version, configured.version);
});

test('normalization emits only fixed metadata, ISO time, scoped IDs, and aligned categories', () => {
  const raw = {
    hook_event_name: 'PostToolUse', session_id: '/Users/example/private-session',
    tool_use_id: 'secret-call', tool_name: 'Bash', tool_input: { command: 'PRIVATE_COMMAND', path: 'notes.js' },
    tool_response: { success: true, token: 'PRIVATE_TOKEN', text: 'PRIVATE_RESULT' }, reasoning: 'PRIVATE_REASONING',
  };
  const normalized = normalizeHostEvent(raw, { projectId: 'b'.repeat(24), sequence: 3, now: '2026-09-19T12:00:00.000Z' });
  assert.equal(normalized.event.toolCategory, 'shell');
  assert.equal(normalized.event.at, '2026-09-19T12:00:00.000Z');
  assert.equal(normalized.event.projectId, 'b'.repeat(24));
  assert.equal(normalized.publicText, null);
  assert.deepEqual(normalized.paths, ['notes.js']);
  assert.doesNotMatch(JSON.stringify(normalized.event), /PRIVATE_|private-session|notes\.js|secret-call/);
  assert.deepEqual(metadataEvent({ ...normalized.event, command: 'PRIVATE_COMMAND' }), normalized.event);
  const other = normalizeHostEvent(raw, { projectId: 'c'.repeat(24) });
  assert.notEqual(other.event.sessionId, normalized.event.sessionId);
  assert.equal(event(1, { tool_name: 'WebFetch' }).toolCategory, 'other');
});

test('requested, interrupted, denied, failed, stop and unsupported deltas stay distinct', () => {
  assert.equal(event(1, { hook_event_name: 'PreToolUse' }).outcome, 'pending');
  assert.equal(event(1, { tool_response: { status: 'interrupted' } }).kind, 'tool.interrupted');
  assert.equal(event(1, { tool_response: { status: 'denied' } }).kind, 'tool.denied');
  assert.equal(event(1, { tool_response: { exit_code: 7 } }).kind, 'tool.failed');
  assert.equal(event(1, { hook_event_name: 'Stop' }).kind, 'turn.stopped');
  assert.equal(event(1, { delta: 'PRIVATE_REASONING' }).kind, 'capture.gap');
  assert.equal(event(1, { delta: 'PRIVATE_REASONING' }).incomplete, true);
  assert.equal(normalizeHostEvent('{not-json').event.kind, 'capture.gap');
});

test('evidence canonicalizes the configured root and rejects outside paths and all symlinks', async t => {
  const { root, canonical } = await project(t);
  await writeFile(path.join(root, 'notes.js'), source);
  await mkdir(path.join(root, 'nested'));
  await symlink('../notes.js', path.join(root, 'nested', 'inside.js'));
  await symlink(tmpdir(), path.join(root, 'outside'));
  const store = new EvidenceStore({ projectRoot: root, policy });
  const [file] = await store.capture([path.join(root, 'notes.js')]);
  assert.equal(file.path, path.join(canonical, 'notes.js'));
  assert.equal(file.text, source);
  assert.deepEqual(await store.capture(['../outside.js', tmpdir()]), []);
  const links = await store.capture(['nested/inside.js', 'outside/anything.js']);
  assert.ok(links.every(a => a.status === 'unavailable' && a.text === null));
  assert.equal(JSON.stringify(store), '{}');
});

test('excluded files, secret source and binary bytes never become candidates', async t => {
  const { root } = await project(t);
  await writeFile(path.join(root, '.env'), 'DB_PASSWORD=private-value');
  await writeFile(path.join(root, 'ordinary.js'), 'const api_key = "private-api-value";');
  await writeFile(path.join(root, 'binary.js'), Buffer.from([65, 0, 66, 255]));
  await writeFile(path.join(root, 'oversize.js'), 'x'.repeat(LIMITS.fileBytes + 1));
  const store = new EvidenceStore({ projectRoot: root, policy });
  const captures = await store.capture(['.env', 'ordinary.js', 'binary.js', 'oversize.js']);
  assert.deepEqual(captures.map(a => a.status), ['unavailable', 'present', 'partial', 'partial']);
  assert.ok(captures.every(a => a.text === null));
  assert.deepEqual(buildCandidates({ event: event(), artifacts: captures, policy }), []);
});

test('metadata-only store advances generations and hashes exact bytes, including BOM', async t => {
  const { root } = await project(t), file = path.join(root, 'notes.js');
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]);
  await writeFile(file, bytes);
  const store = new EvidenceStore({ projectRoot: root });
  const [first] = await store.capture(['notes.js']);
  assert.equal(first.text, null);
  assert.equal(first.hash, digest(bytes));
  const sourceStore = new EvidenceStore({ projectRoot: root, policy });
  const [withSource] = await sourceStore.capture([file]);
  assert.equal(withSource.text, bytes.toString('utf8'), 'source spans preserve the BOM as well as exact bytes');
  const ref = { artifactId: first.id, hash: first.hash, generation: first.generation };
  assert.equal(store.isCurrent([ref]), true);
  const [unchanged] = await store.reconcile();
  assert.equal(unchanged.generation, first.generation);
  await writeFile(file, source + '\n// changed');
  const [changed] = await store.reconcile();
  assert.ok(changed.generation > first.generation);
  assert.equal(store.isCurrent([ref]), false);
  await writeFile(file, bytes);
  const [returned] = await store.reconcile();
  assert.equal(returned.hash, first.hash);
  assert.ok(returned.generation > changed.generation, 'ABA bytes do not reuse an old generation');
});

test('unreadable and missing captures have distinct truth values and generations', async t => {
  const { root } = await project(t), file = path.join(root, 'notes.js');
  await writeFile(file, source);
  const store = new EvidenceStore({ projectRoot: root, policy });
  const [first] = await store.capture(['notes.js']);
  await chmod(file, 0);
  const [unreadable] = await store.reconcile();
  assert.equal(unreadable.status, 'unavailable');
  assert.equal(unreadable.exists, null);
  assert.ok(unreadable.generation > first.generation);
  await chmod(file, 0o600);
  await rm(file);
  const [missing] = await store.reconcile();
  assert.equal(missing.status, 'missing');
  assert.equal(missing.exists, false);
  assert.ok(missing.generation > unreadable.generation);
});

test('path registry is bounded and existing paths remain reconcilable at capacity', async t => {
  const { root } = await project(t);
  const store = new EvidenceStore({ projectRoot: root, policy });
  for (let i = 0; i < LIMITS.trackedPaths; i += LIMITS.paths) {
    await store.capture(Array.from({ length: LIMITS.paths }, (_, j) => `absent-${i + j}.js`));
  }
  assert.equal((await store.capture(['extra.js'])).length, 0);
  await writeFile(path.join(root, 'absent-0.js'), source);
  const [known] = await store.capture(['absent-0.js']);
  assert.equal(known.status, 'present');
  assert.equal((await store.reconcile()).length, LIMITS.trackedPaths);
});

test('candidate discovery exposes several exact entities with unchanged bounded spans', () => {
  const prepared = input();
  const labels = new Set(prepared.candidates.map(c => c.label));
  for (const expected of ['Pool', 'db', 'saveNote']) assert.ok(labels.has(expected), expected);
  for (const c of prepared.candidates) {
    assert.equal(c.text, source.split('\n').slice(c.startLine - 1, c.endLine).join('\n'));
    assert.ok(c.text.length <= LIMITS.snippetChars);
    assert.equal(c.complete, true);
    assert.equal(c.labelOrigin.type, 'span');
    const origin = c.labelOrigin;
    assert.equal(source.split('\n')[origin.startLine - 1].slice(origin.startColumn - 1, origin.endColumn - 1), c.label);
  }
  assert.deepEqual(buildCandidates({ ...prepared, artifacts: [prepared.artifact], event: event(1, { hook_event_name: 'PreToolUse' }) }), []);
});

test('generic identities differ across artifacts; oversized lines are skipped without invented spans', () => {
  const a = input({ text: 'lowercase words only', name: 'a.txt' }).candidates[0];
  const b = input({ text: 'lowercase words only', name: 'b.txt' }).candidates[0];
  assert.equal(a.label, 'Module');
  assert.equal(b.label, 'Module');
  assert.notEqual(a.entityKey, b.entityKey);
  const text = 'x'.repeat(LIMITS.snippetChars + 1) + '\nclass Visible {}\n';
  const candidates = input({ text }).candidates;
  assert.ok(candidates.some(c => c.label === 'Visible' && c.startLine === 2));
  assert.ok(candidates.every(c => !c.text.includes('x'.repeat(100))));
});

test('intake requires independent finite exact verdicts and excludes entire rejected candidates', () => {
  const prepared = input();
  const good = verdicts(prepared.candidates);
  const accepted = materializeBundle({ ...prepared, verdicts: good });
  assert.deepEqual(accepted.candidates, prepared.candidates);
  assert.ok(Object.isFrozen(accepted.candidates[0].sourceRef));
  for (const bad of [
    {}, { sensitive: NaN }, { sensitive: Infinity }, { sensitive: -1 }, { sensitive: 0.11 },
    { relevant: 0.49 }, { relevant: 1.1 }, { digest: '0'.repeat(64) },
  ]) {
    const v = Object.keys(bad).length ? { ...good[0], ...bad } : null;
    const selected = v ? [v, ...good.slice(1)] : good.slice(1);
    const bundle = materializeBundle({ ...prepared, verdicts: selected });
    assert.ok(bundle.candidates.every(c => c.id !== prepared.candidates[0].id));
    assert.ok(bundle.candidates.every(c => c.id !== undefined));
  }
  const duplicate = materializeBundle({ ...prepared, verdicts: [...good, good[0]] });
  assert.ok(duplicate.candidates.every(c => c.id !== prepared.candidates[0].id));
});

test('digests bind labels, text, source versions and policy, while JSON candidate snapshots remain valid', () => {
  const prepared = input(), copied = JSON.parse(JSON.stringify(prepared.candidates));
  assert.equal(materializeBundle({ ...prepared, candidates: copied, verdicts: verdicts(copied) }).candidates.length, copied.length);
  for (const mutate of [
    c => { c.text += 'x'; }, c => { c.label = 'Invented'; }, c => { c.generation++; },
    c => { c.sourceRef.generation++; }, c => { c.labelOrigin.startColumn++; },
    c => { c.extra = 'PRIVATE'; },
  ]) {
    const candidates = structuredClone(prepared.candidates);
    mutate(candidates[0]);
    const bundle = materializeBundle({ ...prepared, candidates, verdicts: verdicts(candidates) });
    assert.ok(bundle.candidates.every(c => c.id !== candidates[0].id));
  }
  const tightened = createPolicy({ ...policy, excludePaths: ['notes.js'] });
  assert.equal(materializeBundle({ ...prepared, policy: tightened, verdicts: verdicts(copied) }).candidates.length, 0);
  assert.equal(materializeBundle({ ...prepared, candidates: [copied[0], copied[0]], verdicts: [verdicts(copied)[0]] }).candidates.length, 0);
});

test('shared context cannot carry a rejected sensitive entity into B; unrelated candidates remain independent', () => {
  const shared = input().candidates, unrelated = input({ name: 'unrelated.js', text: 'class Independent {}' }).candidates;
  const candidates = [...shared, ...unrelated];
  const v = verdicts(candidates);
  v[0].sensitive = 0.9;
  const bundle = materializeBundle({ candidates, policy, verdicts: v });
  assert.deepEqual(bundle.candidates.map(c => c.id), unrelated.map(c => c.id));
  assert.doesNotMatch(JSON.stringify(bundle), /saveNote|INSERT INTO/);
});

test('a bundle cannot mix two versions of one artifact', () => {
  const first = input().candidates[0];
  const second = input({ generation: 2, text: source + '\n// a later capture' }).candidates[0];
  const candidates = [first, second];
  assert.notEqual(first.digest, second.digest);
  const bundle = materializeBundle({ candidates, policy, verdicts: verdicts(candidates) });
  assert.deepEqual(bundle.candidates, []);
  assert.deepEqual(bundle.readSet, []);
});

test('CRLF source snippets remain exact rather than silently rewriting line endings', () => {
  const text = source.replaceAll('\n', '\r\n');
  const candidates = input({ text }).candidates;
  assert.ok(candidates.length);
  assert.equal(candidates[0].text, text);
  assert.equal(materializeBundle({ candidates, policy, verdicts: verdicts(candidates) }).candidates.length, candidates.length);
});

test('sensitive labels cannot bypass text screening; public statements retain message versions', () => {
  const secret = input({ text: 'const token = "PRIVATE_SECRET_VALUE";' });
  assert.deepEqual(secret.candidates, []);
  const e = event(7, { hook_event_name: 'PublicMessage', message_id: 'message-1' });
  const candidates = buildCandidates({ event: e, publicText: 'Use NotesService and Postgres.', policy });
  assert.ok(candidates.length > 0);
  const ref = { type: 'message', messageId: e.id, hash: digest('Use NotesService and Postgres.'), contentVersion: 7 };
  assert.deepEqual(candidates[0].sourceRef, ref);
  const prepared = { event: e, candidates, policy };
  const { graph, decision: d } = compiled(prepared);
  assert.deepEqual(d.bundle.readSet, [ref]);
  assert.ok(graph.nodes.every(n => n.evidenceState === 'proposed'));
  assert.ok(graph.edges.every(n => n.evidenceState === 'proposed'));
  assert.deepEqual(graph.nodes[0].sourceRefs[0].sourceRef, ref);
  assert.equal(graph.nodes[0].sourceRefs[0].basis, 'jev_interpretation');
});

test('relation proposals stay in the approved bundle and respect question budgets', () => {
  const candidates = input({ text: Array.from({ length: 20 }, (_, i) => `class Entity${i} {}`).join('\n') }).candidates;
  assert.equal(candidates.length, 12);
  const bundle = materializeBundle({ candidates, policy, verdicts: verdicts(candidates) });
  const result = buildRelationProposals(bundle);
  assert.equal(result.proposals.length, 7);
  assert.ok(result.omitted > 0);
  assert.ok(1 + 2 * candidates.length + 2 * result.proposals.length <= 40);
  assert.equal(buildRelationProposals(bundle, { maxProposals: 1 }).proposals.length, 1);
  assert.equal(buildRelationProposals(bundle, { maxQuestionsPerStage: 24 }).proposals.length, 0);
  const ids = new Set(candidates.map(c => c.id));
  for (const p of result.proposals) assert.ok([p.sourceCandidateId, p.targetCandidateId, ...p.evidenceCandidateIds].every(id => ids.has(id)));
  assert.deepEqual(buildRelationProposals(structuredClone(bundle)).proposals, []);
  const two = materializeBundle({ candidates: candidates.slice(0, 2), policy, verdicts: verdicts(candidates.slice(0, 2)) });
  const relations = new Set(buildRelationProposals(two).proposals.map(p => p.relation));
  assert.ok(relations.has('reads') && relations.has('writes'));
});

test('compiler accepts only the exact core bundle and known candidate/proposition identities', () => {
  const prepared = input(), d = decision(prepared);
  const compile = decision => compileDecision(emptyGraph(), { ...prepared, decision });
  assert.equal(compile({ ...d, bundle: structuredClone(d.bundle) }), null);
  assert.equal(compile({ ...d, nodes: [{ ...d.nodes[0], candidateId: opaque('candidate', 'unknown') }] }), null);
  assert.equal(compile({ ...d, edges: [{ ...d.edges[0], relation: 'invented' }] }), null);
  assert.equal(compile({ ...d, edges: [{ ...d.edges[0], proposalId: opaque('proposal', 'fake') }] }), null);
  assert.equal(compile({ ...d, nodes: [d.nodes[0], d.nodes[0]] }), null);
  assert.equal(compile({ ...d, status: 'unavailable' }), null);
  assert.equal(compileDecision(emptyGraph(), { ...prepared, decision: d, policy: createPolicy() }), null);
});

test('probability and role confidence are distinct; uncertain capture stays tentative and never verified', () => {
  const prepared = input({ e: event(1, { tool_name: 'Bash' }) });
  const lowConfidence = compiled(prepared, { judgment: { roleConfidence: 0.4 } }).graph;
  assert.ok(lowConfidence.nodes.every(n => n.classification === 'tentative' && n.confidence === 0.4));
  const incomplete = compiled(input({ e: event(1, { incomplete: true }) })).graph;
  assert.ok(incomplete.nodes.every(n => n.classification === 'tentative'));
  const normal = compiled(prepared).graph;
  assert.ok([...normal.nodes, ...normal.edges].every(n => n.evidenceState === 'observed'));
  assert.ok(normal.nodes.every(n => n.activityState === 'unknown'));
  const unknown = decision(prepared, { edges: false, judgment: {
    role: 'unknown', roleProbability: 0.99, roleProbabilities: { module: 0.01, unknown: 0.99 },
  } });
  assert.equal(compileDecision(emptyGraph(), { ...prepared, decision: unknown }), null);
});

test('compiled graph uses stable coordinates and every edge retains endpoint source dependencies', () => {
  const initial = compiled();
  const again = compileDecision(initial.graph, { ...initial, decision: initial.decision });
  assert.equal(again, null);
  for (const edge of initial.graph.edges) {
    assert.ok(initial.graph.nodes.some(n => n.id === edge.source));
    assert.ok(initial.graph.nodes.some(n => n.id === edge.target));
    assert.ok(edge.sourceRefs.every(ref => ref.eventId === initial.event.id));
  }
  const changed = input({ text: source + '\n// changed', generation: 2, e: event(2) });
  const patch = compileDecision(initial.graph, { ...changed, decision: decision(changed) });
  const next = applyPatch(initial.graph, patch);
  for (const node of initial.graph.nodes) {
    const updated = next.nodes.find(n => n.id === node.id);
    assert.deepEqual([updated.x, updated.y], [node.x, node.y]);
  }
});

test('invalidation runs without Jev, distinguishes uncertainty from absence, and prevents same-version revival', () => {
  const initial = compiled();
  const stale = applyPatch(initial.graph, invalidateArtifacts(initial.graph, [{ ...initial.artifact, status: 'unavailable', exists: null, hash: null, generation: 2 }]));
  assert.equal(stale.nodes.length, initial.graph.nodes.length);
  assert.ok([...stale.nodes, ...stale.edges].every(item => item.validity === 'stale'));
  assert.equal(compileDecision(stale, { ...initial, decision: initial.decision }), null);
  const missing = { ...initial.artifact, status: 'missing', exists: false, hash: null, generation: 3 };
  const removed = applyPatch(stale, invalidateArtifacts(stale, [missing]));
  assert.equal(removed.nodes.length, 0);
  assert.equal(removed.edges.length, 0);
  assert.ok(initial.graph.nodes.every(node => node.validity === 'current'), 'input graph never mutated');
});

test('unrelated artifact invalidation does not affect claims; missing one support keeps the other stale', () => {
  const initial = compiled();
  assert.equal(invalidateArtifacts(initial.graph, [artifact('other', 'other.js', 2)]), null);
  const independent = { ...initial.graph.nodes[0].sourceRefs[0], artifactId: opaque('artifact', 'independent'),
    sourceRef: { ...initial.graph.nodes[0].sourceRefs[0].sourceRef, artifactId: opaque('artifact', 'independent') } };
  const node = { ...initial.graph.nodes[0], sourceRefs: [...initial.graph.nodes[0].sourceRefs, independent] };
  const patch = { schemaVersion: 1, id: opaque('patch', 'support'), baseRevision: initial.graph.revision,
    revision: initial.graph.revision + 1, causedBy: [], operations: [{ op: 'node.upsert', node }] };
  const multiple = applyPatch(initial.graph, patch);
  const next = applyPatch(multiple, invalidateArtifacts(multiple, [{ ...initial.artifact, status: 'missing', exists: false, generation: 2 }]));
  assert.equal(next.nodes.length, 1);
  assert.equal(next.nodes[0].sourceRefs.length, 1);
  assert.equal(next.nodes[0].validity, 'stale');
  assert.equal(next.edges.length, 0);
});

test('reducer is atomic, revision checked and idempotent; it rejects foreign grammar and dangling edges', () => {
  const initial = compiled();
  assert.equal(applyPatch(initial.graph, initial.patch), initial.graph);
  const apply = operations => applyPatch(initial.graph, {
    schemaVersion: 1, id: opaque('patch', 'bad', operations), baseRevision: initial.graph.revision,
    revision: initial.graph.revision + 1, causedBy: [], operations,
  });
  const before = structuredClone(initial.graph);
  for (const operations of [
    [{ op: 'node.upsert', node: { ...initial.graph.nodes[0], command: 'PRIVATE' } }],
    [{ op: 'node.upsert', node: { ...initial.graph.nodes[0], x: Infinity } }],
    [{ op: 'node.upsert', node: { ...initial.graph.nodes[0], label: 'token="private-secret"' } }],
    [{ op: 'edge.upsert', edge: { ...initial.graph.edges[0], target: opaque('node', 'missing') } }],
    [{ op: 'node.remove', id: initial.graph.nodes[0].id }, { op: 'freeform', text: 'invented' }],
  ]) assert.throws(() => apply(operations), /INVALID_/);
  assert.deepEqual(initial.graph, before);
  assert.throws(() => applyPatch(initial.graph, { ...initial.patch, id: opaque('patch', 'revision') }), /REVISION_CONFLICT/);
  assert.throws(() => applyPatch(initial.graph, { ...initial.patch, causedBy: [] }), /PATCH_ID_CONFLICT/);
  const removed = apply([{ op: 'node.remove', id: initial.graph.nodes[0].id }]);
  assert.ok(removed.edges.every(edge => edge.source !== initial.graph.nodes[0].id && edge.target !== initial.graph.nodes[0].id));
});

test('display, persistence and tightened policy independently strip source content, including historical copies', () => {
  const initial = compiled();
  const displayed = projectGraph(initial.graph, policy);
  assert.ok(displayed.nodes.some(n => n.label === 'saveNote'));
  assert.ok(displayed.nodes[0].sourceRefs[0].excerpt);
  const persisted = projectGraph(initial.graph, policy, { persistent: true });
  assert.ok(persisted.nodes.every(n => n.label === 'Module'));
  assert.doesNotMatch(JSON.stringify(persisted), /INSERT INTO|saveNote|connectionString/);
  const hidden = projectGraph(structuredClone(initial.graph), createPolicy({ ...policy, displayEvidence: false }));
  assert.doesNotMatch(JSON.stringify(hidden), /INSERT INTO|saveNote/);
  const excluded = projectGraph(initial.graph, createPolicy({ ...policy, excludePaths: ['notes.js'] }));
  assert.doesNotMatch(JSON.stringify(excluded), /INSERT INTO|saveNote/);
  const p = createPolicy({ transmitSource: true, displayEvidence: false, persistEvidence: true });
  const permitted = compiled(input({ p }));
  assert.ok(projectGraph(permitted.graph, p, { persistent: true }).nodes[0].sourceRefs[0].excerpt);
  assert.equal(projectGraph(permitted.graph, p).nodes[0].sourceRefs[0].excerpt, undefined);
  assert.ok(initial.graph.nodes[0].sourceRefs[0].excerpt, 'projection does not mutate graph');
});

test('byte admission is bounded and uncertainty maintenance can still run at capacity', () => {
  const seed = compiled();
  let graph = seed.graph;
  for (let i = 0; i < 50; i++) {
    const prepared = input({ name: `part-${i}.js`, text: Array.from({ length: 12 }, (_, j) => `class Part${i}_${j} {}`).join('\n') });
    const patch = compileDecision(graph, { ...prepared, decision: decision(prepared) });
    if (patch) graph = applyPatch(graph, patch);
  }
  assert.ok(graph.nodes.length <= 256 && graph.edges.length <= 768);
  assert.ok(Buffer.byteLength(JSON.stringify(graph)) <= LIMITS.admissionBytes);
  const ids = new Map([...graph.nodes, ...graph.edges].flatMap(item => item.sourceRefs.map(r => [r.artifactId, r])));
  const observations = [...ids.values()].map(ref => ({ id: ref.artifactId, status: 'unavailable', exists: null, generation: ref.generation + 1 }));
  const patch = invalidateArtifacts(graph, observations);
  assert.ok(patch);
  const stale = applyPatch(graph, patch);
  assert.ok(stale.nodes.every(n => n.validity === 'stale'));
  assert.ok(Buffer.byteLength(JSON.stringify(stale)) < LIMITS.graphBytes);
});

test('invalidation at the hard serialized-byte limit sheds optional excerpts instead of failing', () => {
  const template = compiled().graph.nodes[0];
  const refs = Array.from({ length: LIMITS.refs }, (_, i) => {
    const artifactId = opaque('artifact', `limit-${i}`);
    return { ...template.sourceRefs[0], artifactId, excerpt: 'x'.repeat(LIMITS.excerptChars),
      sourceRef: { ...template.sourceRefs[0].sourceRef, artifactId } };
  });
  const graph = { ...emptyGraph(), revision: 1 };
  for (let i = 0; i < LIMITS.nodes; i++) {
    const node = { ...template, id: opaque('node', `limit-${i}`), sourceRefs: refs, classification: 'stale', validity: 'stale', activityState: 'idle' };
    graph.nodes.push(node);
    if (Buffer.byteLength(JSON.stringify(graph)) > LIMITS.graphBytes) { graph.nodes.pop(); break; }
  }
  let remaining = LIMITS.graphBytes - Buffer.byteLength(JSON.stringify(graph));
  for (const node of graph.nodes) {
    const extra = Math.min(remaining, LIMITS.labelChars - node.label.length);
    node.label += 'x'.repeat(extra);
    remaining -= extra;
  }
  assert.equal(remaining, 0, 'exercise the actual byte boundary');
  const restored = applyPatch(emptyGraph(), { schemaVersion: 1, id: 'restore', baseRevision: 0, revision: 1,
    causedBy: [], operations: graph.nodes.map(node => ({ op: 'node.upsert', node })) });
  const observations = refs.map(ref => ({ id: ref.artifactId, generation: 2, status: 'partial', exists: true }));
  const patch = invalidateArtifacts(restored, observations);
  const result = applyPatch(restored, patch);
  assert.ok(result.nodes.every(node => node.activityState === 'unknown'));
  assert.ok(result.nodes.every(node => node.sourceRefs.every(ref => !Object.hasOwn(ref, 'excerpt'))));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < LIMITS.graphBytes);
});
