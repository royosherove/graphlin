import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, createPolicy, metadataEvent } from '../../runtime/core/index.mjs';
import { hash, opaque } from '../../runtime/core/common.mjs';

function artifact(index) {
  const text = `export function component${index}() { return "BODY_SENTINEL"; }`;
  return {
    id: opaque('artifact', index), relativePath: `component${index}.ts`,
    text, hash: hash(text), generation: 1, status: 'present', exists: true, complete: true,
  };
}
const event = metadataEvent({ kind: 'artifact.changed', incomplete: false });
const policy = createPolicy({ transmitSource: true });

test('candidate logs distinguish per-file selection losses and the artifact boundary', () => {
  const records = [];
  const artifacts = Array.from({ length: 34 }, (_, index) => artifact(index));
  const result = buildCandidates({ event, artifacts, policy, onDiagnostic: r => records.push(r) });
  assert.equal(result.length, 12);
  assert.equal(records.filter(r => r.reason === 'candidates_ready').length, 12);
  assert.equal(records.filter(r => r.reason === 'candidate_limit').length, 20);
  assert.deepEqual(records.at(-1), { reason: 'artifact_limit', available: 34, selected: 32 });
  for (const record of records.filter(r => r.artifactId)) {
    assert.equal(record.available, 1);
    assert.equal(record.selected, result.filter(c => c.artifactId === record.artifactId).length);
  }
  assert.doesNotMatch(JSON.stringify(records), /BODY_SENTINEL|component\d/);
});

test('extraction audit callbacks cannot mutate output or turn rejection into an unhandled promise', async () => {
  const input = { event, policy, artifacts: [artifact(1)] };
  const expected = buildCandidates(input);
  const actual = buildCandidates({ ...input, onDiagnostic(record) {
    assert.ok(Object.isFrozen(record));
    return Promise.reject(new Error('observer failure'));
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actual, expected);
  assert.deepEqual(buildCandidates({ event, policy, artifacts: null }), []);
});

test('thirteen declarations inside one snippet report the local selection cap', () => {
  const file = artifact(1);
  file.text = Array.from({ length: 13 }, (_, index) => `export function item${index}() {}`).join('\n');
  file.hash = hash(file.text);
  const records = [];
  const candidates = buildCandidates({ event, policy, artifacts: [file], onDiagnostic: r => records.push(r) });
  assert.equal(candidates.length, 12);
  assert.deepEqual(records, [{ artifactId: file.id, available: 13, selected: 12, reason: 'candidate_limit' }]);
});

test('uninspected source windows report truncation rather than complete extraction coverage', () => {
  const file = artifact(1);
  file.text = Array.from({ length: 400 }, (_, index) => `export function item${index}() {}`).join('\n');
  file.hash = hash(file.text);
  const records = [];
  const candidates = buildCandidates({ event, policy, artifacts: [file], onDiagnostic: r => records.push(r) });
  assert.equal(candidates.length, 12);
  assert.equal(records[0].reason, 'snippet_limit');
  assert.equal(records[0].truncated, true);
  assert.ok(records[0].available > 12 && records[0].available < 400);
});
