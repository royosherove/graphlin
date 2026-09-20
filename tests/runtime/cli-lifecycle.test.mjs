import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, symlink, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace, run } from './helpers.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { daemonStatus, stopDaemon } from '../../runtime/daemon/manager.mjs';
import { parseArguments } from '../../scripts/arguments.mjs';

const entry = path.resolve('scripts/graphlin.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const argumentsFor = setup => ['--project', setup.projectRoot, '--data-dir', setup.dataDir];
async function bounded(promise, ms = 8000, label = 'lifecycle_timeout') {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  })]); } finally { clearTimeout(timer); }
}

function foreground(t, args, { env = process.env, nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > 65536) { child.kill('SIGKILL'); readyReject(new Error('unexpected_stdout')); return; }
    try { readyResolve(JSON.parse(stdout)); } catch { /* Wait for complete JSON. */ }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', readyReject);
  const exited = new Promise(resolve => child.on('close', (code, signal) => {
    readyReject(new Error(`exited_before_ready: ${stderr}`));
    resolve({ code, signal, stdout, stderr });
  }));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGCONT');
      child.kill('SIGINT');
    }
    try { await bounded(exited, 4000); }
    catch { child.kill('SIGKILL'); await bounded(exited, 2000); }
  };
  t.after(stop);
  return { child, ready: () => bounded(ready), exited, stop };
}

async function background(setup, extra = []) {
  const result = await run(process.execPath, [entry, 'start', ...argumentsFor(setup), '--background', ...extra]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function assertClosed(setup, details) {
  assert.equal((await daemonStatus(setup)).running, false);
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
  await assert.rejects(fetch(new URL('/', details.url), { signal: AbortSignal.timeout(1000) }));
}

test('background is opt-in only for CLI start/demo and cannot be passed to a passive worker or other commands', () => {
  assert.equal(parseArguments(['start']).background, false);
  assert.equal(parseArguments(['demo']).background, false);
  assert.equal(parseArguments(['start', '--background']).background, true);
  assert.equal(parseArguments(['demo', '--background']).background, true);
  for (const command of ['status', 'doctor', 'stop', 'export']) {
    assert.throws(() => parseArguments([command, '--background']), /unknown_argument/);
  }
  assert.throws(() => parseArguments(['--background'], { worker: true }), /unknown_argument/);
});

test('default CLI start owns the foreground process, announces its URL, and SIGINT releases port and lock', async t => {
  const setup = await workspace(t);
  const cli = foreground(t, ['start', ...argumentsFor(setup)]);
  try {
    const details = await cli.ready();
    assert.equal(details.pid, cli.child.pid, 'foreground CLI owns the server directly');
    assert.equal(details.foreground, true);
    assert.equal(details.reused, false);
    assert.equal(details.status.classifier, 'metadata_only');
    await delay(100);
    assert.equal(cli.child.exitCode, null);
    assert.equal((await daemonStatus(setup)).instanceId, details.instanceId);
    cli.child.kill('SIGINT');
    const completed = await bounded(cli.exited, 4000);
    assert.equal(completed.code, 0, completed.stderr);
    assert.equal(completed.signal, null);
    assert.equal(completed.stderr, '');
    await assertClosed(setup, details);
  } finally { await cli.stop(); }
});

test('node --env-file source-enabled start also remains foreground without making a keyless request', async t => {
  const setup = await workspace(t), file = path.join(setup.base, 'ignored local env');
  await writeFile(file, `GRAPHLIN_DATA_DIR=${JSON.stringify(setup.dataDir)}\nTYPESAFE_API_KEY=\n`, { mode: 0o600 });
  const env = { ...process.env }; delete env.TYPESAFE_API_KEY; delete env.GRAPHLIN_DATA_DIR;
  const cli = foreground(t, ['start', '--project', setup.projectRoot, '--allow-source'], {
    env, nodeArgs: [`--env-file=${file}`],
  });
  try {
    const details = await cli.ready();
    assert.equal(details.pid, cli.child.pid);
    assert.equal(details.status.classifier, 'missing_key');
    assert.equal(details.status.calls, 0);
    await delay(100);
    assert.equal(cli.child.exitCode, null);
    cli.child.kill('SIGINT');
    assert.equal((await bounded(cli.exited, 4000)).code, 0);
    await assertClosed(setup, details);
  } finally { await cli.stop(); }
});

test('default CLI demo is foreground and serves a real fixture graph before returning its URL', async t => {
  const setup = await workspace(t);
  const cli = foreground(t, ['demo', '--data-dir', setup.dataDir], {
    env: { ...process.env, TYPESAFE_API_KEY: 'DO_NOT_SEND_DEMO_SENTINEL' },
  });
  try {
    const details = await cli.ready();
    assert.equal(details.pid, cli.child.pid);
    assert.equal(details.mode, 'demo');
    assert.equal(details.foreground, true);
    assert.equal(cli.child.exitCode, null);
    const exported = await run(process.execPath, [entry, 'export', '--project', details.projectRoot, '--data-dir', setup.dataDir]);
    assert.equal(exported.code, 0, exported.stderr);
    const snapshot = JSON.parse(exported.stdout);
    assert.equal(snapshot.mode, 'demo');
    assert.ok(snapshot.graph.nodes.length > 0);
    assert.ok(snapshot.graph.edges.some(edge => edge.relation === 'writes'));
    assert.equal(exported.stdout.includes('DO_NOT_SEND_DEMO_SENTINEL'), false);
    cli.child.kill('SIGINT');
    assert.equal((await bounded(cli.exited, 4000)).code, 0);
    await assertClosed({ ...setup, projectRoot: details.projectRoot }, details);
  } finally { await cli.stop(); }
});

test('background returns promptly; canonical project/data aliases and repeated starts reuse its exact instance and port', async t => {
  const setup = await workspace(t);
  await mkdir(path.join(setup.projectRoot, '.git'));
  await mkdir(path.join(setup.projectRoot, 'nested'));
  const first = await background(setup);
  assert.equal(first.foreground, false);
  assert.equal(first.reused, false);
  assert.equal((await daemonStatus(setup)).running, true);
  const projectAlias = path.join(setup.base, 'project alias'), dataAlias = path.join(setup.base, 'data alias');
  await symlink(setup.projectRoot, projectAlias); await symlink(setup.dataDir, dataAlias);
  const alias = { projectRoot: path.join(projectAlias, 'nested'), dataDir: dataAlias };
  const second = await background(alias);
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(second.pid, first.pid);
  assert.equal(second.port, first.port);
  assert.equal(second.reused, true);
  assert.notEqual(second.url, first.url, 'a fresh launch token does not imply a new server');
  const cli = foreground(t, ['start', ...argumentsFor(alias)]);
  try {
    const joined = await cli.ready();
    assert.equal(joined.instanceId, first.instanceId);
    assert.equal(joined.pid, first.pid);
    assert.equal(joined.port, first.port);
    assert.equal(joined.foreground, true);
    assert.equal(joined.reused, true);
    assert.notEqual(joined.url, second.url);
    await delay(100); assert.equal(cli.child.exitCode, null);
    cli.child.kill('SIGINT');
    assert.equal((await bounded(cli.exited, 4000)).code, 0);
    await assertClosed(setup, first);
  } finally { await cli.stop(); }
});

test('an existing foreground owner is reused by foreground/background clients and explicit stop releases both terminals', async t => {
  const setup = await workspace(t);
  const owner = foreground(t, ['start', ...argumentsFor(setup)]);
  let joined;
  try {
    const first = await owner.ready();
    const detachedRequest = await background(setup);
    assert.equal(detachedRequest.instanceId, first.instanceId);
    assert.equal(detachedRequest.pid, owner.child.pid);
    joined = foreground(t, ['start', ...argumentsFor(setup)]);
    assert.equal((await joined.ready()).instanceId, first.instanceId);
    const result = await run(process.execPath, [entry, 'stop', ...argumentsFor(setup)]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).stopped, true);
    assert.equal((await bounded(owner.exited, 4000)).code, 0);
    assert.equal((await bounded(joined.exited, 4000)).code, 0);
    await assertClosed(setup, first);
  } finally { await owner.stop(); await joined?.stop(); }
});

test('concurrent foreground starters elect one owner and both block on the same port', async t => {
  const setup = await workspace(t);
  const clients = [foreground(t, ['start', ...argumentsFor(setup)]), foreground(t, ['start', ...argumentsFor(setup)])];
  try {
    const ready = await Promise.all(clients.map(client => client.ready()));
    assert.equal(ready[0].instanceId, ready[1].instanceId);
    assert.equal(ready[0].port, ready[1].port);
    assert.equal(ready.filter(value => !value.reused).length, 1);
    const joined = ready.findIndex(value => value.reused);
    clients[joined].child.kill('SIGINT');
    for (const client of clients) assert.equal((await bounded(client.exited, 4000)).code, 0);
    await assertClosed(setup, ready[0]);
  } finally { await Promise.all(clients.map(client => client.stop())); }
});

test('policy/port conflicts fail without replacing or stopping the current owner', async t => {
  const setup = await workspace(t), first = await background(setup);
  for (const [extra, code] of [
    [['--allow-source'], 'policy_restart_required'],
    [['--port', String(first.port === 65535 ? 65534 : first.port + 1)], 'port_restart_required'],
  ]) {
    const result = await run(process.execPath, [entry, 'start', ...argumentsFor(setup), ...extra], { timeout: 4000 });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(code));
    const current = await daemonStatus(setup);
    assert.equal(current.instanceId, first.instanceId);
    assert.equal(current.port, first.port);
  }
});

test('foreground startup failure is bounded and releases its unpublished service lock', async t => {
  const setup = await workspace(t);
  const occupied = http.createServer((_request, response) => response.end('unrelated local fixture'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const result = await run(process.execPath, [entry, 'start', ...argumentsFor(setup), '--port', String(occupied.address().port)],
      { timeout: 4000 });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /port_in_use/);
    const paths = await projectPaths(setup.projectRoot, setup.dataDir);
    await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
    assert.equal((await daemonStatus(setup)).running, false);
    assert.equal(await (await fetch(`http://127.0.0.1:${occupied.address().port}/`)).text(), 'unrelated local fixture');
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('Ctrl+C on an old attachment never shuts down a replacement instance', async t => {
  const setup = await workspace(t), first = await background(setup);
  const joined = foreground(t, ['start', ...argumentsFor(setup)]);
  try {
    assert.equal((await joined.ready()).instanceId, first.instanceId);
    joined.child.kill('SIGSTOP');
    assert.equal((await stopDaemon(setup)).stopped, true);
    const replacement = await background(setup);
    assert.notEqual(replacement.instanceId, first.instanceId);
    joined.child.kill('SIGINT'); joined.child.kill('SIGCONT');
    assert.equal((await bounded(joined.exited, 4000)).code, 0);
    assert.equal((await daemonStatus(setup)).instanceId, replacement.instanceId);
  } finally { await joined.stop(); }
});
