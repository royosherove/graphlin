import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildCandidates, buildRelationProposals, createPolicy, materializeBundle, metadataEvent,
} from '../../runtime/core/index.mjs';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({ kind: 'artifact.changed', id: 'lexical-test', incomplete: false });
const example = `import { Pool } from "pg";
const db = new Pool({ connectionString: process.env.DATABASE_URL });
export function saveNote(body) {
  return db.query("INSERT INTO notes (body) VALUES ($1)", [body]);
}`;
function candidates(text, name = 'example.mjs') {
  return buildCandidates({ event, policy, artifacts: [{
    id: `artifact-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`,
    hash: createHash('sha256').update(text).digest('hex'), relativePath: name,
    text, generation: 1, complete: true, exists: true, status: 'present',
  }] });
}
function proposed(selected, limits, verdict = () => ({ relevant: 1, sensitive: 0 })) {
  const bundle = materializeBundle({
    candidates: selected, policy,
    verdicts: selected.map(c => ({ candidateId: c.id, digest: c.digest, ...verdict(c) })),
  });
  const labels = new Map(bundle.candidates.map(c => [c.id, c.label]));
  const result = buildRelationProposals(bundle, limits);
  return {
    bundle, ...result,
    named: result.proposals.map(p => ({ source: labels.get(p.sourceCandidateId), target: labels.get(p.targetCandidateId), relation: p.relation })),
  };
}

test('SQL text and environment properties do not compete with declarations, bindings, and imports', () => {
  const selected = candidates(example);
  assert.deepEqual(selected.map(c => c.label), ['saveNote', 'db', 'Pool']);
  assert.ok(selected.every(c => c.text === example), 'original evidence still contains the query and environment access');
  for (const c of selected) {
    const origin = c.labelOrigin, line = example.split('\n')[origin.startLine - 1];
    assert.equal(line.slice(origin.startColumn - 1, origin.endColumn - 1), c.label);
  }
  assert.equal(selected.find(c => c.label === 'Pool').labelOrigin.startLine, 1);
});

test('best function-to-receiver pair gets all six relation questions before constructor dependency fanout', () => {
  const { named, omitted } = proposed(candidates(example));
  assert.deepEqual(named, [
    ...['calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on'].map(relation => ({ source: 'saveNote', target: 'db', relation })),
    { source: 'db', target: 'Pool', relation: 'depends_on' },
  ]);
  assert.equal(omitted, 29);
});

test('comments, strings, templates, escaped quotes, and regex literals cannot declare entities', () => {
  const text = [
    'import { Client as Store } from "PackageNotAnEntity";',
    'const db = new Store();',
    '// class CommentGhost { }',
    '/* function BlockGhost() { FakeReceiver.query(); } */',
    'const sql = "SELECT \\"QuotedGhost\\" INTO VALUES";',
    'const template = `INSERT INTO TemplateGhost ${NotSelected.run()}`;',
    'const matcher = /class RegexGhost\\{\\}/;',
    'function saveNote() { return db.query(sql); }',
  ].join('\n');
  const selected = candidates(text);
  assert.deepEqual(selected.map(c => c.label), ['saveNote', 'db', 'sql', 'template', 'matcher', 'Store']);
  assert.ok(proposed(selected).named.slice(0, 6).every(p => p.source === 'saveNote' && p.target === 'db'));
});

test('template and comment bodies remain excluded across snippet boundaries; declarations take priority', () => {
  const text = [
    'const statement = `', ...Array.from({ length: 25 }, (_, i) => `class StringGhost${i} {}`), '`;',
    '/*', ...Array.from({ length: 25 }, (_, i) => `function CommentGhost${i}() {}`), '*/',
    'export function visible() { return client.send(); }',
  ].join('\n');
  const selected = candidates(text);
  assert.ok(selected.some(c => c.label === 'visible'));
  assert.ok(selected.some(c => c.label === 'client'));
  assert.ok(selected.every(c => !/Ghost/.test(c.label)));
  assert.equal(selected[0].label, 'visible');
});

test('environment values, property names and uppercase constants are not fallback entities', () => {
  const selected = candidates(`import { Pool } from "pg";
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_URL = import.meta.env.PUBLIC_URL;
const db = new Pool();
function readNotes() { return db.notes.findMany({ env: DATABASE_URL }); }`);
  assert.deepEqual(selected.map(c => c.label), ['readNotes', 'db', 'Pool']);
  assert.ok(proposed(selected).named.slice(0, 6).every(p => p.source === 'readNotes' && p.target === 'db'));
});

test('import aliases, namespaces, destructuring and arrow functions retain exact local names', () => {
  const text = `import { Pool as PgPool } from "pg";
import * as cache from "cache-package";
const { Queue: WorkQueue } = require("queue-package");
const db = new PgPool();
export const saveNote = async (body) => { return db.query(body); };`;
  const selected = candidates(text);
  assert.deepEqual(selected.map(c => c.label), ['saveNote', 'WorkQueue', 'db', 'PgPool', 'cache']);
  const named = proposed(selected).named;
  assert.ok(named.slice(0, 6).every(p => p.source === 'saveNote' && p.target === 'db'));
  assert.deepEqual(named[6], { source: 'db', target: 'PgPool', relation: 'depends_on' });
  for (const c of selected) {
    const ref = c.labelOrigin;
    assert.equal(text.split('\n')[ref.startLine - 1].slice(ref.startColumn - 1, ref.endColumn - 1), c.label);
  }
});

test('scope ranking selects the innermost function and does not attribute sibling call sites', () => {
  const selected = candidates(`const db = new Store();
function outer() {
  function inner() { return db.query(); }
  return inner();
}
function sibling() { return queue.send(); }`);
  const named = proposed(selected).named;
  assert.ok(named.slice(0, 6).every(p => p.source === 'inner' && p.target === 'db'));
  assert.deepEqual(named[6], { source: 'sibling', target: 'queue', relation: 'calls' });
});

test('concise arrow bodies and imported direct call targets produce directed lexical hints', () => {
  const selected = candidates('import postgres from "postgres";\nexport const saveNote = body => postgres(body);');
  assert.deepEqual(selected.map(c => c.label), ['saveNote', 'postgres']);
  assert.ok(proposed(selected).named.slice(0, 6).every(p => p.source === 'saveNote' && p.target === 'postgres'));
});

test('other language declaration/import fallbacks retain whole names outside literals', () => {
  const python = candidates('from storage import Client\nclass NotesService:\n    async def save_note(self):\n        return client.write("INSERT INTO VALUES")', 'notes.py');
  assert.deepEqual(python.map(c => c.label), ['NotesService', 'save_note', 'Client', 'client']);
  const go = candidates('type NotesService struct {}\nfunc (s *NotesService) SaveNote() { db.Save(); }', 'notes.go');
  assert.deepEqual(go.map(c => c.label), ['NotesService', 'SaveNote', 'db']);
  const rust = candidates('pub struct NotesService {}\npub fn save_note() { client.write("SELECT INTO"); }', 'notes.rs');
  assert.deepEqual(rust.map(c => c.label), ['NotesService', 'save_note', 'client']);
});

test('ranking is bounded, preserves reads/writes, and never recovers excluded candidate endpoints', () => {
  const selected = candidates(example);
  const result = proposed(selected, { maxProposals: 6, maxQuestionsPerStage: 40 });
  assert.equal(result.proposals.length, 6);
  assert.ok(1 + 2 * selected.length + 2 * result.proposals.length <= 40);
  assert.deepEqual(new Set(result.named.map(p => p.relation)), new Set(['calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on']));
  const filtered = proposed(selected, {}, c => ({ sensitive: 0, relevant: c.label === 'db' ? 0 : 1 }));
  assert.ok(filtered.named.every(p => p.source !== 'db' && p.target !== 'db'));
  const sensitive = proposed(selected, {}, c => ({ relevant: 1, sensitive: c.label === 'db' ? 1 : 0 }));
  assert.equal(sensitive.bundle.candidates.length, 0);
  assert.equal(sensitive.proposals.length, 0);
  assert.equal(proposed(selected, { maxQuestionsPerStage: 7 }).proposals.length, 0);
});
