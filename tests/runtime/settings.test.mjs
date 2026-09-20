import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { workspace, run } from './helpers.mjs';
import { saveSettings, readSettings, resolvePolicy } from '../../runtime/daemon/settings.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { runForeground, daemonStatus, startDaemon, stopDaemon } from '../../runtime/daemon/manager.mjs';
import { collect } from '../../runtime/collector/index.mjs';

const consent = { allowSource: true, persistEvidence: false, displayEvidence: true };
const key = 'SYNTHETIC_LOCAL_SETTINGS_SENTINEL';

test('settings keep key private, consent canonical and project-scoped, and installation shared', async t => {
  const setup = await workspace(t);
  assert.deepEqual(await readSettings(setup), {});
  await mkdir(path.join(setup.projectRoot, '.git'));
  await mkdir(path.join(setup.projectRoot, 'src'));
  await saveSettings(setup, { apiKey: key, policy: consent, installation: { hosts: ['claude'], version: '0.1.0' } });
  assert.deepEqual((await readSettings({ ...setup, projectRoot: path.join(setup.projectRoot, 'src') })).policy, consent);
  const sibling = path.join(setup.base, 'another-project'); await mkdir(sibling);
  const other = await readSettings({ ...setup, projectRoot: sibling });
  assert.equal(other.apiKey, key);
  assert.equal(other.policy, undefined);
  assert.deepEqual(other.installation.hosts, ['claude']);
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  for (const file of [path.join(paths.dataDir, 'settings.json'), path.join(paths.directory, 'settings.json')]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.equal((await stat(paths.dataDir)).mode & 0o777, 0o700);
  assert.equal((await readFile(path.join(paths.directory, 'settings.json'), 'utf8')).includes(key), false);
  await saveSettings(setup, { installation: { hosts: [], version: '0.1.0' } });
  assert.equal((await readSettings(setup)).apiKey, key, 'installation update preserves key');
  await saveSettings(setup, { apiKey: null });
  assert.equal((await readSettings(setup)).apiKey, undefined);
});

test('unsafe settings and malformed consent fail closed without leaking contents', async t => {
  const setup = await workspace(t);
  await assert.rejects(saveSettings(setup, { policy: { allowSource: 'yes' } }), { code: 'invalid_settings' });
  await saveSettings(setup, { apiKey: key });
  const filename = path.join(setup.dataDir, 'settings.json');
  await chmod(filename, 0o644);
  await assert.rejects(readSettings(setup), { code: 'unsafe_settings' });
  await chmod(filename, 0o600);
  const linked = path.join(setup.base, 'linked-secret');
  await symlink(filename, linked);
  await rm(linked);
  await rm(filename);
  await symlink(path.join(setup.base, 'missing-secret'), filename);
  await assert.rejects(readSettings(setup), { code: 'unsafe_settings' });
});

test('policy omission reuses running or saved consent while explicit false wins', () => {
  assert.deepEqual(resolvePolicy({}), { allowSource: false, persistEvidence: false, displayEvidence: true });
  assert.deepEqual(resolvePolicy({}, { saved: consent }), consent);
  assert.equal(resolvePolicy({ allowSource: false }, { saved: consent }).allowSource, false);
  assert.equal(resolvePolicy({}, { saved: consent, current: {
    transmitSource: false, persistEvidence: false, displayEvidence: false,
  } }).allowSource, false);
});

test('concurrent processes cannot restore a deleted credential while recording installation', async t => {
  const setup = await workspace(t);
  await saveSettings(setup, { apiKey: key });
  const exited = await run(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  assert.equal(exited.code, 0);
  // Simulate a setup process killed immediately after claiming, before it
  // could write a ticket. Concurrent successors must reclaim only this unique
  // dead claim, never a new writer's claim.
  const deadClaim = path.join(setup.dataDir, '.settings.claims', `${Number(exited.stdout)}-${randomUUID()}`);
  await mkdir(deadClaim, { mode: 0o700 });
  const module = pathToFileURL(path.resolve('runtime/daemon/settings.mjs')).href;
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => {
    const patch = index % 2 ? { apiKey: null } : { installation: { hosts: ['claude'], version: '0.1.0' } };
    return run(process.execPath, ['--input-type=module', '-e',
      `import { saveSettings } from ${JSON.stringify(module)}; await saveSettings(${JSON.stringify(setup)}, ${JSON.stringify(patch)});`]);
  }));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const saved = await readSettings(setup);
  assert.equal(saved.apiKey, undefined);
  assert.deepEqual(saved.installation.hosts, ['claude']);
  await assert.rejects(stat(deadClaim), { code: 'ENOENT' });
});

test('saved key works in foreground; repeated start joins its policy and explicit opt-out does not replace it', async t => {
  const setup = await workspace(t);
  await saveSettings(setup, { apiKey: key, policy: consent });
  const controller = new AbortController();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const task = runForeground({ ...setup, signal: controller.signal }, readyResolve);
  t.after(() => controller.abort());
  try {
    const started = await ready;
    assert.equal(started.policy.transmitSource, true);
    assert.notEqual(started.status.classifier, 'missing_key');
    assert.equal(started.status.calls, 0, 'no remote request without observations');
    const reused = await startDaemon(setup);
    assert.equal(reused.instanceId, started.instanceId);
    assert.equal(reused.reused, true);
    await assert.rejects(startDaemon({ ...setup, allowSource: false }), { code: 'policy_restart_required' });
    assert.equal((await daemonStatus(setup)).instanceId, started.instanceId);
    assert.equal(JSON.stringify(started).includes(key), false);
  } finally { controller.abort(); await task; }
});

test('MCP reuses saved consent and key without exposing either key or shell environment in diagnostics', async t => {
  const setup = await workspace(t);
  await saveSettings(setup, { apiKey: key, policy: consent });
  const env = { ...process.env, GRAPHLIN_DATA_DIR: setup.dataDir };
  delete env.TYPESAFE_API_KEY;
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start', arguments: { projectRoot: setup.projectRoot } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stop', arguments: { projectRoot: setup.projectRoot } } },
  ];
  const result = await run(process.execPath, ['scripts/control.mjs'], {
    env, input: messages.map(value => JSON.stringify(value)).join('\n') + '\n',
  });
  assert.equal(result.code, 0, result.stderr);
  const started = JSON.parse(JSON.parse(result.stdout.split('\n')[1]).result.content[0].text);
  assert.equal(started.policy.transmitSource, true);
  assert.notEqual(started.status.classifier, 'missing_key');
  assert.equal(result.stdout.includes(key), false);
  assert.equal(result.stderr, '');
});

test('doctor reports actual accepted hook delivery without claiming credential validation', async t => {
  const setup = await workspace(t);
  await startDaemon(setup);
  const env = { ...process.env, GRAPHLIN_DATA_DIR: setup.dataDir, PATH: setup.base };
  delete env.TYPESAFE_API_KEY;
  const inspect = async () => {
    const result = await run(process.execPath, ['scripts/graphlin.mjs', 'doctor', '--project', setup.projectRoot], { env });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  let report = await inspect();
  assert.equal(report.credential, 'missing');
  assert.equal(report.hosts.claude.activation, 'not_verified');
  assert.ok(report.nextActions.length > 0);
  assert.equal(await collect({
    cwd: setup.projectRoot, session_id: 'synthetic-onboarding-session', hook_event_name: 'SessionStart',
  }, { dataDir: setup.dataDir, host: 'claude' }), true);
  report = await inspect();
  assert.equal(report.hosts.claude.activation, 'hook_observed');
  assert.equal(report.hosts.codex.activation, 'not_verified');
  assert.equal(report.hosts.claude.receivedHooks, 1);
  assert.equal(report.coverage, 'hook_delivery_observed');
  await stopDaemon(setup);
});
