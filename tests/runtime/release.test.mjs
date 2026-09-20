import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { verifyReleaseContext, verifyReleaseVersions } from '../../.github/scripts/verify-release.mjs';
import { shouldPublishVersion, writePublishDecision } from '../../.github/scripts/check-npm-version.mjs';

const exec = promisify(execFile);
const metadata = { name: 'graphlin', private: false, version: '0.2.0' };
const context = { repository: 'royosherove/graphlin', isPrivate: false, enabled: 'true',
  event: 'push', ref: 'refs/heads/main' };
const manifestFiles = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const release = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('release guard accepts main pushes and manual dispatch without a tag', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.doesNotThrow(() => verifyReleaseContext({ ...context, event }, metadata));
  }
});

test('release guard rejects unauthorized repositories, events, refs, and metadata', () => {
  for (const replacement of [
    { repository: 'someone/graphlin' }, { repository: undefined },
    { isPrivate: true }, { isPrivate: undefined }, { isPrivate: 'false' },
    { enabled: undefined }, { enabled: 'false' }, { enabled: 'TRUE' }, { enabled: true },
    { event: 'pull_request' }, { event: 'pull_request_target' }, { event: 'workflow_run' },
    { event: 'schedule' }, { event: undefined }, { ref: undefined },
    { ref: 'refs/tags/v0.2.0' }, { ref: 'refs/heads/topic' }, { ref: 'refs/pull/1/merge' },
    { event: 'workflow_dispatch', ref: 'refs/heads/topic' },
    { event: 'workflow_dispatch', ref: 'refs/tags/main' },
  ]) assert.throws(() => verifyReleaseContext({ ...context, ...replacement }, metadata));
  for (const replacement of [
    { name: 'other' }, { private: true }, { private: undefined }, { private: 'false' },
    { version: '0.2.0-beta.1' }, { version: '0.2.0+build' }, { version: '00.2.0' },
    { version: undefined },
  ]) assert.throws(() => verifyReleaseContext(context, { ...metadata, ...replacement }));
});

test('all three plugin manifests must match the npm name and version', () => {
  const manifests = Object.fromEntries(manifestFiles.map(file => [file, { ...metadata }]));
  assert.doesNotThrow(() => verifyReleaseVersions(metadata, manifests));
  for (const file of manifestFiles) {
    for (const replacement of [undefined, { name: 'other', version: '0.2.0' },
      { name: 'graphlin', version: '0.1.0' }]) {
      assert.throws(() => verifyReleaseVersions(metadata, { ...manifests, [file]: replacement }));
    }
  }
});

const registry = (status, body, type = 'application/json') => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const published = { name: 'graphlin', versions: {
  '0.1.0': { name: 'graphlin', version: '0.1.0' },
  '0.2.0': { name: 'graphlin', version: '0.2.0' },
}, 'dist-tags': { latest: '0.1.0' } };

test('an existing exact version is a no-op even when latest points elsewhere', async () => {
  assert.equal(await shouldPublishVersion(metadata, registry(200, published)), false);
});

test('a different stable version or a confirmed missing package can publish', async () => {
  assert.equal(await shouldPublishVersion({ ...metadata, version: '0.3.0' }, registry(200, published)), true);
  assert.equal(await shouldPublishVersion(metadata, registry(404, { error: 'Not found' })), true);
});

const lookupFailures = [
  ...[401, 403, 408, 429, 500, 502, 503, 302].map(status => [String(status), registry(status, { error: 'Not found' })]),
  ['unrecognized 404', registry(404, { error: 'service unavailable' })],
  ['empty 404', registry(404, {})],
  ['HTML 404', registry(404, { error: 'Not found' }, 'text/html')],
  ['null metadata', registry(200, null)],
  ['array metadata', registry(200, [])],
  ['missing versions', registry(200, { name: 'graphlin' })],
  ['array versions', registry(200, { name: 'graphlin', versions: [] })],
  ['wrong package', registry(200, { ...published, name: 'other' })],
  ['error in 200', registry(200, { ...published, error: 'upstream failure' })],
  ['invalid existing version', registry(200, { ...published, versions: { '0.2.0': null } })],
  ['unpublished package', registry(404, { error: 'Not found', time: { unpublished: {} } })],
  ['unpublished version', registry(200, {
    name: 'graphlin', versions: {}, time: { '0.2.0': '2026-01-01T00:00:00Z' },
  })],
  ['bad JSON', async () => new Response('{', { headers: { 'content-type': 'application/json' } })],
  ['network failure', async () => { throw new TypeError('synthetic network failure'); }],
  ['timeout', async () => { throw new DOMException('synthetic timeout', 'TimeoutError'); }],
];

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'graphlin-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('registry errors fail closed and never write a publish output', async t => {
  const directory = await temporaryDirectory(t);
  for (const [name, fetchRegistry] of lookupFailures) {
    await t.test(name, async () => {
      const output = path.join(directory, 'output');
      await assert.rejects(writePublishDecision(metadata, output, fetchRegistry));
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    });
  }
});

test('registry lookup uses only public metadata and emits the exact workflow decision', async t => {
  const directory = await temporaryDirectory(t);
  for (const [version, expected] of [['0.2.0', false], ['0.3.0', true]]) {
    const output = path.join(directory, version);
    const result = await writePublishDecision({ ...metadata, version }, output, async (url, options) => {
      assert.equal(url, 'https://registry.npmjs.org/graphlin');
      assert.deepEqual(options.headers, { accept: 'application/json', 'cache-control': 'no-cache' });
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return registry(200, published)();
    });
    assert.equal(result, expected);
    assert.equal(await readFile(output, 'utf8'), `publish=${expected}\n`);
  }
});

// These focused source assertions protect the workflow wiring without adding a
// YAML dependency to the package. GitHub remains the workflow execution engine.
function job(name) {
  const match = release.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]+:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing ${name} job`);
  return match[1];
}

test('main releases require the entire existing CI matrix and package smoke checks', () => {
  assert.match(release, /push:\n    branches: \[main\]\n  workflow_dispatch:/);
  assert.doesNotMatch(release, /tags:|pull_request|workflow_run|continue-on-error|always\(\)/);
  assert.match(ci, /branches: \['\*\*', '!main'\]/);
  assert.match(ci, /  pull_request:\n  workflow_call:\n  workflow_dispatch:/);
  assert.match(ci, /node: \['22', '24', '26'\]/);
  assert.match(ci, /os: \[ubuntu-latest, macos-latest\]/);
  assert.match(ci, /fail-fast: false/);
  assert.doesNotMatch(ci, /continue-on-error|secrets:|id-token:|npm publish/);
  for (const command of ['npm run validate', 'npm test', 'npm run build', 'npm run pack:check']) {
    assert.ok(ci.includes(`- run: ${command}\n`), command);
  }
  assert.match(job('checks'), /uses: \.\/\.github\/workflows\/ci.yml/);
  assert.doesNotMatch(job('checks'), /if:|needs:|secrets:|environment:/);
  assert.match(job('guard'), /needs: checks/);
  assert.match(job('publish'), /needs: \[guard, checks\]/);
  assert.match(release, /group: graphlin-npm-release\n  cancel-in-progress: false/);
  for (const source of [ci, job('guard'), job('publish')]) {
    assert.match(source, /persist-credentials: false\n\s+ref: \$\{\{ github.sha \}\}/);
  }
});

test('workflow conditions block failed, cancelled, skipped CI and untrusted contexts', () => {
  const base = {
    needs: { guard: { result: 'success' }, checks: { result: 'success' } },
    github: { ref: 'refs/heads/main', event_name: 'push', repository: 'royosherove/graphlin',
      event: { repository: { private: false } } },
    vars: { NPM_PUBLISH_ENABLED: 'true' },
  };
  for (const name of ['guard', 'publish']) {
    const condition = job(name).match(/    if: >-\n((?:      .+\n)+)/)?.[1].trim();
    assert.ok(condition);
    // The workflow uses only comparisons and boolean operators shared with JS.
    assert.equal(runInNewContext(condition, structuredClone(base)), true);
    const manual = structuredClone(base);
    manual.github.event_name = 'workflow_dispatch';
    assert.equal(runInNewContext(condition, manual), true);
    for (const [key, value] of [
      ['needs.checks.result', 'failure'], ['needs.checks.result', 'cancelled'],
      ['needs.checks.result', 'skipped'],
      ...(name === 'publish' ? [['needs.guard.result', 'failure'], ['needs.guard.result', 'skipped']] : []),
      ['github.ref', 'refs/heads/topic'], ['github.ref', 'refs/tags/v0.2.0'],
      ['github.event_name', 'pull_request'], ['github.event_name', 'pull_request_target'],
      ['github.event_name', 'workflow_run'], ['github.repository', 'someone/graphlin'],
      ['github.event.repository.private', true], ['vars.NPM_PUBLISH_ENABLED', ''],
      ['vars.NPM_PUBLISH_ENABLED', 'false'],
    ]) {
      const input = structuredClone(base), keys = key.split('.');
      const last = keys.pop();
      keys.reduce((object, part) => object[part], input)[last] = value;
      assert.equal(runInNewContext(condition, input), false, `${name}: ${key}=${value}`);
    }
  }
});

test('publish step uses only the environment token after a successful registry decision', async t => {
  const publish = job('publish');
  assert.match(publish, /environment: npm/);
  assert.match(publish, /id-token: write/);
  assert.equal((release.match(/secrets\.NPM_TOKEN/g) || []).length, 1);
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}/);
  assert.match(publish, /if: steps.registry.outputs.publish == 'true'/);
  for (const value of ['false', '', undefined, 'true']) {
    assert.equal(runInNewContext("steps.registry.outputs.publish == 'true'",
      { steps: { registry: { outputs: { publish: value } } } }), value === 'true');
  }
  const guardPosition = publish.indexOf('run: npm run release:check');
  const buildPosition = publish.indexOf('run: npm run build');
  const packPosition = publish.indexOf('run: npm run pack:check');
  const lookupPosition = publish.indexOf('run: node .github/scripts/check-npm-version.mjs');
  const publishPosition = publish.indexOf('npm publish --access public');
  assert.ok(guardPosition >= 0 && guardPosition < buildPosition && buildPosition < packPosition &&
    packPosition < lookupPosition && lookupPosition < publishPosition);

  const script = publish.match(/        run: \|\n((?:          .*\n)+)/)?.[1]
    .split('\n').map(line => line.slice(10)).join('\n');
  assert.ok(script);
  const directory = await temporaryDirectory(t), record = path.join(directory, 'invocations');
  // Execute the real workflow shell block against a synthetic npm executable.
  // No npm authentication, registry request, or publication is performed.
  await writeFile(path.join(directory, 'npm'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$RELEASE_TEST_RECORD"\nexit "${RELEASE_TEST_EXIT:-0}"\n', { mode: 0o700 });
  const env = { PATH: `${directory}:/usr/bin:/bin`, RELEASE_TEST_RECORD: record, NODE_AUTH_TOKEN: '' };
  await assert.rejects(exec('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], { env }));
  await assert.rejects(readFile(record), { code: 'ENOENT' });
  await exec('/bin/bash', ['-e', '-o', 'pipefail', '-c', script],
    { env: { ...env, NODE_AUTH_TOKEN: 'synthetic-test-token' } });
  assert.equal(await readFile(record, 'utf8'),
    'publish\n--access\npublic\n--provenance\n--ignore-scripts\n--registry=https://registry.npmjs.org/\n');
  await assert.rejects(exec('/bin/bash', ['-e', '-o', 'pipefail', '-c', script],
    { env: { ...env, NODE_AUTH_TOKEN: 'synthetic-test-token', RELEASE_TEST_EXIT: '1' } }));
});
