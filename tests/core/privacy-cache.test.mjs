import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, excluded } from '../../runtime/core/privacy.mjs';

test('only policies created by Graphlin reuse their deeply frozen identity', () => {
  const policy = createPolicy({ readSource: true, excludePaths: ['private/**'] });
  assert.equal(createPolicy(policy), policy);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.excludePaths));
  assert.throws(() => policy.excludePaths.push('src/**'), TypeError);
  assert.equal(excluded('private/example.js', policy), true);
  assert.equal(excluded('src/example.js', policy), false);
  assert.equal(excluded('.env', policy), true);
});

test('forged versions and externally frozen policies cannot inherit cached exclusions', () => {
  const original = createPolicy({ excludePaths: ['private/**'] });
  assert.equal(excluded('private/example.js', original), true);
  const forged = Object.freeze({ ...original, excludePaths: Object.freeze(['other/**']) });
  const normalized = createPolicy(forged);
  assert.notEqual(normalized, forged);
  assert.notEqual(normalized.version, original.version);
  assert.equal(excluded('private/example.js', forged), false);
  assert.equal(excluded('other/example.js', forged), true);
  assert.equal(excluded('.env', forged), true, 'default exclusions cannot be removed by a forged version');
  assert.notEqual(createPolicy({ ...original }), original, 'a structural copy is not a branded policy');
});

test('mutable policy objects and exclusion arrays are normalized again on every read', () => {
  const paths = [], input = { readSource: true, excludePaths: paths };
  const initial = createPolicy(input);
  assert.equal(excluded('src/example.js', input), false);
  paths.push('src/**');
  assert.equal(excluded('src/example.js', input), true);
  assert.equal(excluded('src/example.js', initial), false, 'normalization copied the caller-owned array');
  assert.notEqual(createPolicy(input).version, initial.version);
  paths.length = 0;
  assert.equal(excluded('src/example.js', input), false);
  input.excludePaths = ['other/**'];
  input.readSource = false;
  assert.equal(excluded('other/example.js', input), true);
  assert.equal(createPolicy(input).readSource, false);
});
