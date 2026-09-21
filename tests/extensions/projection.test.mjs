import test from 'node:test';
import assert from 'node:assert/strict';
import { getExtensionDataProjection, DATA_FIELDS } from '../../runtime/extensions/index.mjs';
import { model, PROJECT } from './fixtures.mjs';

const grant = (changes = {}) => ({
  projectId: PROJECT, extensionId: 'example.c4', digest: 'a'.repeat(64),
  fields: [...DATA_FIELDS], history: true, approved: true, ...changes,
});

test('projection is a pure allowlist for every nested namespace and history record', () => {
  const snapshot = model();
  const contaminate = value => {
    if (Array.isArray(value)) return value.forEach(contaminate);
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(contaminate);
    Object.assign(value, { source: 'DO_NOT_DISCLOSE', excerpt: 'DO_NOT_DISCLOSE', prompt: 'DO_NOT_DISCLOSE',
      transcript: 'DO_NOT_DISCLOSE', absolutePath: '/private/DO_NOT_DISCLOSE', credentials: { secret: 'DO_NOT_DISCLOSE' } });
  };
  // relation.source is itself an allowed canonical ID, so restore it after the
  // poison pass; unrestricted objects must not pass through any other field.
  contaminate(snapshot);
  snapshot.relations[0].source = 'gateway';
  snapshot.coverage.files = [{ id: 'f1', source: 'DO_NOT_DISCLOSE', absolutePath: '/private/DO_NOT_DISCLOSE' }];
  snapshot.entities[1].label = '/tmp/DO_NOT_DISCLOSE';
  snapshot.entities[1].qualifiedName = 'Error at /tmp/DO_NOT_DISCLOSE';
  const original = structuredClone(snapshot);
  const result = getExtensionDataProjection(snapshot, grant());
  assert.equal(result.schemaVersion, 2);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_DISCLOSE|excerpt|absolutePath|transcript|credentials|prompt/);
  assert.equal(result.entities[1].label, 'Entity');
  assert.equal(result.entities[1].sourceRefs[0].artifactId, 'artifact-gateway');
  assert.equal(result.entities[1].basis, 'parsed');
  assert.equal(result.entities[1].validity, 'current');
  assert.equal(result.relations[0].kind, 'writes');
  assert.deepEqual(snapshot, original);
});

test('denied, unapproved, invalid field and cross-project grants never receive data', () => {
  for (const value of [
    null, {}, grant({ approved: false }), grant({ projectId: 'other-project' }),
    grant({ fields: ['source'] }), grant({ fields: ['checkpoints'], history: false }),
  ]) assert.equal(getExtensionDataProjection(model(), value), null);
});

test('fields and history narrow projection, including activity-only extensions', () => {
  const snapshot = model();
  const result = getExtensionDataProjection(snapshot, grant({ fields: ['activity'], history: false }));
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.relations, []);
  assert.deepEqual(result.interpretations, []);
  assert.equal(result.activity.length, 1);
  assert.deepEqual(result.activity[0].entityIds, []);
  assert.deepEqual(result.checkpoints, []);
  assert.equal(getExtensionDataProjection({ ...snapshot, replay: true }, grant({ fields: ['entities'], history: false })), null);
  assert.equal(getExtensionDataProjection({ ...snapshot, checkpointId: 'checkpoint-1' },
    grant({ fields: ['entities'], history: false })), null);
});

test('file activity extensions receive bounded operation labels, never tool input', () => {
  const snapshot = model();
  Object.assign(snapshot.activity[0], { operation: 'read', mapping: 'decision',
    toolInput: { file: '/private/DO_NOT_DISCLOSE', command: 'DO_NOT_DISCLOSE' } });
  const visible = getExtensionDataProjection(snapshot, grant());
  assert.equal(visible.activity[0].operation, 'read');
  assert.equal(visible.activity[0].mapping, 'decision');
  assert.doesNotMatch(JSON.stringify(visible), /DO_NOT_DISCLOSE|toolInput/);
  const hidden = getExtensionDataProjection(snapshot, grant({ fields: ['entities'] }));
  assert.deepEqual(hidden.activity, []);
  Object.assign(snapshot.activity[0], { operation: 'execute', mapping: 'unbounded' });
  const invalid = getExtensionDataProjection(snapshot, grant());
  assert.equal(invalid.activity[0].operation, undefined);
  assert.equal(invalid.activity[0].mapping, undefined);
});
