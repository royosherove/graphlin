import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDashboardInfoProvider, compareStableVersions } from '../../runtime/daemon/dashboard-info.mjs';
import { startServer } from '../../runtime/daemon/server.mjs';
import { buildPackages } from '../../scripts/build-packages.mjs';
import { workspace, authenticate } from './helpers.mjs';

const context = { projectRoot: '/fixture/project', dataDir: '/fixture/custom data' };
const registry = version => Response.json({ name: 'graphlin', version });
const branch = (_file, _args, _options, callback) => callback(null, 'main\n', '');
const readVersion = version => async () => JSON.stringify({ name: 'graphlin', version });
const dependencies = overrides => ({
  readFile: readVersion('0.1.9'), execFile: branch, fetch: async () => registry('0.1.10'), ...overrides,
});
const noRemote = () => ({ classify: async () => { throw new Error('unexpected_remote'); }, stats: () => ({ calls: 0 }), close() {} });

test('stable versions compare numeric components and ignore build metadata without guessing for invalid/prerelease versions', () => {
  for (const [a, b, expected] of [
    ['0.1.10', '0.1.9', 1], ['0.10.0', '0.9.99', 1], ['10.0.0', '9.99.99', 1],
    ['0.1.2', '0.1.2', 0], ['0.1.2+build.2', '0.1.2+build.1', 0],
    ['9007199254740993.0.0', '9007199254740992.0.0', 1],
    ['0.1.9', '0.1.10', -1], ['0.1.2-beta.1', '0.1.2', null],
    ['01.1.2', '0.1.2', null], ['0.1', '0.1.2', null], [null, '0.1.2', null],
    ['0.1.2', 'garbage', null], ['0.1.2\nPRIVATE', '0.1.2', null],
  ]) assert.equal(compareStableVersions(a, b), expected);
});

test('provider reports actual packaged version, minimal metadata, and only a fixed credential-free npm request', async () => {
  const actual = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const calls = [];
  const about = createDashboardInfoProvider(context, {
    execFile: branch,
    fetch: async (...args) => { calls.push(args); return registry('999.0.0'); },
  });
  assert.equal(calls.length, 0, 'constructing a server/provider does not check npm');
  const info = await about();
  assert.deepEqual(Object.keys(info), ['projectRoot', 'mode', 'branch', 'version', 'update']);
  assert.equal(info.projectRoot, context.projectRoot);
  assert.equal(info.mode, 'live');
  assert.equal(info.version, actual);
  assert.deepEqual(info.branch, { status: 'branch', name: 'main' });
  assert.equal(info.update.status, 'available');
  assert.equal(info.update.current, actual);
  assert.equal(info.update.latest, '999.0.0');
  assert.match(info.update.instructions.join(' '), /Ctrl\+C.*restart.*new Claude Code or Codex agent session/);
  const [url, options] = calls[0];
  assert.equal(url, 'https://registry.npmjs.org/graphlin/latest');
  assert.deepEqual(Object.keys(options).sort(), ['credentials', 'headers', 'method', 'redirect', 'referrerPolicy', 'signal']);
  assert.deepEqual(options.headers, { Accept: 'application/json' });
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.signal.aborted, true, 'completed requests release their deadline and network resources');
  assert.doesNotMatch(JSON.stringify(calls), /fixture|custom data|main|TYPESAFE|Cookie|Authorization/);
});

test('Git lookup is local, bounded, uses no shell or inherited secrets, and sees branch changes on the next request', async () => {
  let current = 'feature/first', count = 0;
  const about = createDashboardInfoProvider(context, dependencies({
    execFile(file, args, options, callback) {
      count++;
      assert.equal(file, 'git');
      assert.deepEqual(args, ['-c', 'core.fsmonitor=false', 'symbolic-ref', '--quiet', '--short', 'HEAD']);
      assert.equal(options.cwd, context.projectRoot);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 750);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.maxBuffer, 4096);
      assert.deepEqual(Object.keys(options.env).sort(), [
        'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'LC_ALL', 'PATH',
      ]);
      assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(options.env.TYPESAFE_API_KEY, undefined);
      assert.equal(options.env.GIT_DIR, undefined);
      callback(null, current + '\n', 'PRIVATE_STDERR_IGNORED');
    },
  }));
  assert.equal((await about()).branch.name, current);
  current = 'feature/second';
  assert.equal((await about()).branch.name, current);
  assert.equal(count, 2);
});

test('detached HEAD, non-Git projects, failures, and malformed branch output are graceful and never echo errors', async () => {
  for (const [error, stdout, stderr, status] of [
    [{ code: 1 }, '', '', 'detached'],
    [{ code: 128 }, '', 'fatal: not a git repository (or any of the parent directories): .git PRIVATE', 'not_git'],
    [{ code: 'ENOENT', message: 'PRIVATE' }, '', '', 'unavailable'],
    [{ code: 1, killed: true }, '', '', 'unavailable'],
    [{ code: 128 }, '', 'PRIVATE git configuration failure', 'unavailable'],
    [null, 'branch\nPRIVATE', '', 'unavailable'],
    [null, 'branch\u202ePRIVATE\n', '', 'unavailable'],
    [null, 'x'.repeat(1025), '', 'unavailable'],
  ]) {
    const about = createDashboardInfoProvider(context, dependencies({
      execFile: (_file, _args, _options, callback) => callback(error, stdout, stderr),
    }));
    const info = await about();
    assert.deepEqual(info.branch, { status });
    assert.doesNotMatch(JSON.stringify(info), /PRIVATE/);
  }
});

test('registry checks are singleflight and cached for 30 minutes, including failures', async () => {
  let now = 0, calls = 0, complete;
  const about = createDashboardInfoProvider(context, dependencies({
    now: () => now,
    fetch: () => { calls++; return new Promise(resolve => { complete = resolve; }); },
  }));
  const first = about(), second = about();
  assert.equal(calls, 1);
  complete(registry('0.1.10'));
  assert.deepEqual(await first, await second);
  now = 30 * 60 * 1000 - 1;
  assert.equal((await about()).update.status, 'available');
  assert.equal(calls, 1);
  now++;
  const expired = about();
  assert.equal(calls, 2);
  complete(new Response('PRIVATE FAILURE', { status: 503 }));
  assert.deepEqual((await expired).update.status, 'unavailable');
  now += 1000;
  assert.equal((await about()).update.status, 'unavailable');
  assert.equal(calls, 2, 'failure is cached instead of hammering npm on dashboard polls');
});

test('equal or older npm stable versions report current; unreachable or invalid registry responses report unavailable', async () => {
  for (const latest of ['0.1.9', '0.1.8']) {
    const about = createDashboardInfoProvider(context, dependencies({ fetch: async () => registry(latest) }));
    assert.equal((await about()).update.status, 'current');
  }
  for (const fetchImpl of [
    async () => { throw new Error('PRIVATE_NETWORK_ERROR'); },
    async () => new Response('PRIVATE', { status: 503 }),
    async () => new Response('PRIVATE', { status: 302, headers: { Location: 'https://evil.example' } }),
    async () => new Response('PRIVATE'),
    async () => Response.json({ name: 'other', version: '99.0.0', private: 'PRIVATE' }),
    async () => registry('0.1.10-beta.1'),
    async () => registry('not a version PRIVATE'),
    async () => new Response('PRIVATE', { headers: { 'content-length': '32769' } }),
    async () => new Response('x'.repeat(32769)),
  ]) {
    const about = createDashboardInfoProvider(context, dependencies({ fetch: fetchImpl }));
    const info = await about();
    assert.equal(info.update.status, 'unavailable');
    assert.equal(info.update.latest, undefined);
    assert.doesNotMatch(JSON.stringify(info), /PRIVATE|evil\.example/);
  }
});

test('npm timeout bounds stalled headers and body reads and aborts the request', async () => {
  for (const phase of ['headers', 'body']) {
    let signal;
    const about = createDashboardInfoProvider(context, dependencies({
      timeoutMs: 15,
      fetch: async (_url, options) => {
        signal = options.signal;
        if (phase === 'headers') return new Promise(() => {});
        return new Response(new ReadableStream({ start() {} }));
      },
    }));
    const info = await about();
    assert.equal(info.update.status, 'unavailable');
    assert.equal(signal.aborted, true);
  }
});

test('update command quotes hostile project and custom data paths literally without invoking npm or an installer', async t => {
  const setup = await workspace(t);
  const hostile = `quote ' " $(touch INJECTED) \`touch INJECTED\` ; & $HOME \\ unicode-שלום`;
  const projectRoot = path.join(setup.base, hostile), dataDir = path.join(setup.base, `data ${hostile}`);
  await mkdir(projectRoot);
  const info = await createDashboardInfoProvider({ projectRoot, dataDir }, dependencies())();
  const capture = "npx() { printf '%s\\0' \"$PWD\" \"$GRAPHLIN_DATA_DIR\" \"$@\"; }\n";
  // This shell only tests quoting with a local fake npx; Git and fetch are
  // stubbed above and no installer or network command can be invoked.
  const result = await promisify(execFile)('/bin/sh', ['-c', capture + info.update.command], {
    cwd: setup.base, env: { PATH: '/usr/bin:/bin', GRAPHLIN_DATA_DIR: '/wrong' }, timeout: 1000, maxBuffer: 32 * 1024,
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), [projectRoot, dataDir, '--yes', 'graphlin@latest']);
});

test('repo-local updates omit the data override while legacy home updates preserve it', async t => {
  const setup = await workspace(t);
  const local = { projectRoot: setup.projectRoot, dataDir: path.join(setup.projectRoot, '.graphlin') };
  const info = await createDashboardInfoProvider(local, dependencies())();
  assert.equal(info.update.command, `cd '${setup.projectRoot}' && npx --yes graphlin@latest`);
  assert.match(info.update.instructions.join(' '), /State is repo-local in \.graphlin.*Unset GRAPHLIN_DATA_DIR/);
  const result = await promisify(execFile)('/bin/sh', ['-c',
    "npx() { printf '%s\\0' \"$PWD\" \"$GRAPHLIN_DATA_DIR\" \"$@\"; }\n" + info.update.command], {
    cwd: setup.base, env: { PATH: '/usr/bin:/bin' }, timeout: 1000,
  });
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), [setup.projectRoot, '', '--yes', 'graphlin@latest']);
  const legacy = { ...local, dataDir: path.join(setup.base, '.local/state/graphlin') };
  const formerDefault = await createDashboardInfoProvider(legacy, dependencies())();
  assert.ok(formerDefault.update.command.includes(`GRAPHLIN_DATA_DIR='${legacy.dataDir}'`));
  assert.doesNotMatch(formerDefault.update.instructions.join(' '), /State is repo-local/);
});

test('demo update restarts the offline demo from any directory with quoted custom data and no agent instructions', async t => {
  const setup = await workspace(t);
  const dataDir = path.join(setup.base, `data ' " $HOME \`echo PRIVATE\` $(echo PRIVATE)`);
  const server = await startServer({
    ...setup, dataDir, mode: 'demo', decisionService: noRemote(),
    dashboardInfoDependencies: dependencies(),
  });
  t.after(() => server.close());
  const { origin, cookie } = await authenticate(server);
  const response = await fetch(origin + '/api/about', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.mode, 'demo');
  assert.equal(info.projectRoot, setup.projectRoot);
  assert.equal(info.update.command.includes(setup.projectRoot), false);
  assert.match(info.update.command, / npx --yes graphlin@latest demo$/);
  assert.match(info.update.instructions.join(' '), /Ctrl\+C.*restart the offline demo/);
  assert.doesNotMatch(info.update.instructions.join(' '), /Claude|Codex|agent session/);
  const capture = "npx() { printf '%s\\0' \"$PWD\" \"$GRAPHLIN_DATA_DIR\" \"$@\"; }\n";
  const result = await promisify(execFile)('/bin/sh', ['-c', capture + info.update.command], {
    cwd: setup.base, env: { PATH: '/usr/bin:/bin', GRAPHLIN_DATA_DIR: '/wrong' }, timeout: 1000, maxBuffer: 32 * 1024,
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), [setup.base, dataDir, '--yes', 'graphlin@latest', 'demo']);
});

test('update guide includes commands at 8192 bytes and omits both command and instructions above the bound', async () => {
  const short = await createDashboardInfoProvider(context, dependencies())();
  const overhead = Buffer.byteLength(short.update.command) -
    Buffer.byteLength(context.projectRoot) - Buffer.byteLength(context.dataDir);
  const projectRoot = '/' + 'r'.repeat(4095);
  const dataDir = '/' + 'd'.repeat(8192 - overhead - projectRoot.length - 1);
  const exact = await createDashboardInfoProvider({ projectRoot, dataDir }, dependencies())();
  assert.equal(Buffer.byteLength(exact.update.command), 8192);
  assert.ok(exact.update.instructions.length > 0);
  for (const input of [
    { projectRoot, dataDir: dataDir + 'd' },
    { ...context, projectRoot: '/' + "'".repeat(1700) },
    { ...context, mode: 'demo', dataDir: '/' + "'".repeat(1700) },
    { ...context, dataDir: '/' + "'".repeat(1600) + 'שלום'.repeat(30) },
  ]) {
    const info = await createDashboardInfoProvider(input, dependencies())();
    assert.equal(Object.hasOwn(info.update, 'command'), false);
    assert.equal(Object.hasOwn(info.update, 'instructions'), false);
    assert.equal(info.update.status, 'available', 'overlong instructions do not discard version metadata');
    assert.equal(info.projectRoot, input.projectRoot);
    assert.equal(info.mode, input.mode || 'live');
  }
});

test('about endpoint requires authentication and origin protection before Git/npm, stays read-only, and omits credentials', async t => {
  const setup = await workspace(t);
  await writeFile(path.join(setup.projectRoot, '.env'), 'TYPESAFE_API_KEY=PRIVATE_FILE_SENTINEL');
  let gitCalls = 0, registryCalls = 0;
  const server = await startServer({
    ...setup, apiKey: 'PRIVATE_KEY_SENTINEL', decisionService: noRemote(),
    dashboardInfoDependencies: {
      execFile: (...args) => { gitCalls++; branch(...args); },
      fetch: async () => { registryCalls++; return registry('999.0.0'); },
    },
  });
  t.after(() => server.close());
  const { origin, cookie, token } = await authenticate(server);
  assert.equal((await fetch(origin + '/api/about')).status, 401);
  assert.equal((await fetch(origin + '/api/about', { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(origin + '/api/about?projectRoot=/evil', { headers: { Cookie: cookie } })).status, 400);
  assert.equal((await fetch(origin + '/api/about', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 404);
  assert.equal(gitCalls, 0);
  assert.equal(registryCalls, 0);
  const before = server.pipeline.getState();
  const response = await fetch(origin + '/api/about', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const info = await response.json(), text = JSON.stringify(info);
  assert.equal(info.projectRoot, setup.projectRoot);
  assert.equal(info.version, JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version);
  assert.equal(info.update.status, 'available');
  assert.doesNotMatch(text, /PRIVATE_|apiKey|sourceRefs|#token/);
  assert.equal(text.includes(token), false);
  assert.equal(text.includes(cookie), false);
  assert.deepEqual(server.pipeline.getState(), before);
  await fetch(origin + '/api/about', { headers: { Cookie: cookie } });
  assert.equal(gitCalls, 2);
  assert.equal(registryCalls, 1);
});

test('invalid actual package version yields a sanitized unavailable endpoint rather than a fabricated version', async t => {
  const setup = await workspace(t);
  const server = await startServer({
    ...setup, decisionService: noRemote(),
    dashboardInfoDependencies: dependencies({ readFile: async () => { throw new Error('PRIVATE_PACKAGE_ERROR'); } }),
  });
  t.after(() => server.close());
  const { origin, cookie } = await authenticate(server);
  const response = await fetch(origin + '/api/about', { headers: { Cookie: cookie } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'dashboard_info_unavailable' });
});

test('undisplayable paths disable only the optional about endpoint, never server startup or normal snapshots', async t => {
  const setup = await workspace(t);
  const projectRoot = path.join(setup.base, 'project\nPRIVATE');
  await mkdir(projectRoot);
  const server = await startServer({
    ...setup, projectRoot, decisionService: noRemote(),
    dashboardInfoDependencies: dependencies({
      fetch: () => { assert.fail('invalid display metadata must not trigger npm'); },
      execFile: () => { assert.fail('invalid display metadata must not trigger Git'); },
    }),
  });
  t.after(() => server.close());
  const { origin, cookie } = await authenticate(server);
  assert.equal((await fetch(origin + '/api/state', { headers: { Cookie: cookie } })).status, 200);
  const response = await fetch(origin + '/api/about', { headers: { Cookie: cookie } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'dashboard_info_unavailable' });
});

test('every generated plugin includes the dashboard module and reads its own packaged version', async t => {
  const setup = await workspace(t);
  const profiles = await buildPackages({ outputDir: path.join(setup.base, 'packages') });
  for (const { directory } of profiles) {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    assert.ok(metadata.files.includes('./runtime/daemon/dashboard-info.mjs'));
    const module = await import(pathToFileURL(path.join(directory, 'runtime/daemon/dashboard-info.mjs')));
    const info = await module.createDashboardInfoProvider(context, { execFile: branch, fetch: async () => registry('999.0.0') })();
    assert.equal(info.version, metadata.version);
  }
});
