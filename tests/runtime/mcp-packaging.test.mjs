import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildPackages } from '../../scripts/build-packages.mjs';
import { stopDaemon } from '../../runtime/daemon/manager.mjs';
import { validatePackage } from '../../scripts/validate-packages.mjs';
import { workspace, run } from './helpers.mjs';

function messages(projectRoot) {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'start', arguments: { projectRoot } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'status', arguments: { projectRoot } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'doctor', arguments: { projectRoot } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'start', arguments: { projectRoot, apiKey: 'not-allowed' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'stop', arguments: { projectRoot } } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
}

test('MCP initializes, lists and calls all four controls without extra stdout', async t => {
  const setup = await workspace(t);
  t.after(() => stopDaemon(setup).catch(() => {}));
  const result = await run(process.execPath, ['scripts/control.mjs'], {
    env: { ...process.env, GRAPHLIN_DATA_DIR: setup.dataDir, TYPESAFE_API_KEY: 'SENTINEL_NOT_FOR_METADATA' },
    input: messages(setup.projectRoot), timeout: 20_000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(output.length, 7);
  assert.equal(output[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(output[1].result.tools.map(tool => tool.name), ['start', 'stop', 'status', 'doctor']);
  assert.match(JSON.parse(output[2].result.content[0].text).url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  assert.equal(JSON.parse(output[3].result.content[0].text).status.classifier, 'metadata_only');
  assert.equal(JSON.parse(output[4].result.content[0].text).hosts.kiro.activation, 'not_verified');
  assert.equal(output[5].error.code, -32602);
  assert.equal(JSON.parse(output[6].result.content[0].text).stopped, true);
  assert.equal(result.stdout.includes('SENTINEL_NOT_FOR_METADATA'), false);
});

test('portable, Claude, Codex, and Kiro bundles run after relocation outside the checkout', async t => {
  const setup = await workspace(t);
  const packages = await buildPackages({ outputDir: path.join(setup.base, 'relocated packages with spaces') });
  assert.equal(packages.length, 4);
  for (const bundle of packages) {
    const root = bundle.directory;
    assert.equal((await validatePackage(root)).valid, true);
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(metadata.scripts).sort(), ['demo', 'doctor', 'prepack', 'start', 'validate']);
    const validation = await run(process.execPath, [path.join(root, 'scripts/validate-packages.mjs'), root]);
    assert.equal(validation.code, 0, validation.stderr);
    if (bundle.profile !== 'claude') await assert.rejects(stat(path.join(root, '.claude-plugin/plugin.json')), { code: 'ENOENT' });
    const portable = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
    assert.equal(portable.name, 'graphlin');
    assert.match(portable.$schema, /agent-plugins\.org/);
    const config = JSON.parse(await readFile(path.join(root, 'mcp.json'), 'utf8'));
    assert.equal(config.mcpServers.graphlin.type, 'stdio');
    const expanded = config.mcpServers.graphlin.args[0].replace('${PLUGIN_ROOT}', root);
    const result = await run(process.execPath, [expanded], {
      cwd: setup.base, input: messages(setup.projectRoot),
      env: { ...process.env, GRAPHLIN_DATA_DIR: setup.dataDir }, timeout: 20_000,
    });
    assert.equal(result.code, 0, result.stderr);
    const output = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(output[2].result.isError, false, JSON.stringify(output[2]));
    assert.equal(output[6].result.isError, false);
    const cli = await run(process.execPath, [path.join(root, 'scripts/graphlin.mjs'), 'status',
      '--project', setup.projectRoot, '--data-dir', setup.dataDir], { cwd: setup.base });
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).running, false);
    assert.equal((await stat(path.join(root, 'scripts/collect.sh'))).mode & 0o111, 0o111);
    const native = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.equal(native.mcpServers.graphlin.args[0],
      bundle.profile === 'codex' ? '${PLUGIN_ROOT}/scripts/control.mjs' : '${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs');
    assert.equal(JSON.stringify(portable).includes(setup.base), false);
  }
  const kiroProfile = JSON.parse(await readFile(path.join(setup.base,
    'relocated packages with spaces/kiro/graphlin/adapters/kiro/profile.json'), 'utf8'));
  assert.equal(kiroProfile.activation, 'not_verified');
  const kiroConfig = JSON.parse(await readFile(path.join(setup.base,
    'relocated packages with spaces/kiro/graphlin/.kiro-plugin/agent-config.json'), 'utf8'));
  assert.deepEqual(Object.keys(kiroConfig.hooks).sort(), [...kiroProfile.events].sort());
  assert.equal(kiroConfig.mcpServers.graphlin.args[0], '${GRAPHLIN_PLUGIN_ROOT}/scripts/control.mjs');
});

test('CLI demo creates only fixture state, exports it, and stops without remote credentials', async t => {
  const setup = await workspace(t), entry = path.resolve('scripts/graphlin.mjs');
  const env = { ...process.env, TYPESAFE_API_KEY: 'MUST_NOT_LEAVE_DEMO' };
  const started = await run(process.execPath, [entry, 'demo', '--background', '--data-dir', setup.dataDir], { env });
  assert.equal(started.code, 0, started.stderr);
  const details = JSON.parse(started.stdout);
  t.after(() => stopDaemon({ projectRoot: details.projectRoot, dataDir: setup.dataDir }).catch(() => {}));
  assert.equal(details.mode, 'demo');
  let snapshot;
  for (let attempt = 0; attempt < 30; attempt++) {
    const exported = await run(process.execPath, [entry, 'export', '--project', details.projectRoot, '--data-dir', setup.dataDir], { env });
    assert.equal(exported.code, 0, exported.stderr);
    snapshot = JSON.parse(exported.stdout);
    // A first relationship is an intermediate snapshot; discovery can emit
    // calls before the demo's read/write observations have all completed.
    if (snapshot.status.pending === 0 && snapshot.activity.some(event => event.kind === 'turn.stopped')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(snapshot.mode, 'demo');
  assert.equal(snapshot.status.pending, 0);
  assert.ok(snapshot.activity.some(event => event.kind === 'turn.stopped'), 'the demo finished its observations');
  assert.ok(snapshot.graph.edges.some(edge => edge.relation === 'writes'));
  assert.equal(JSON.stringify(snapshot).includes('MUST_NOT_LEAVE_DEMO'), false);
  const stopped = await run(process.execPath, [entry, 'stop', '--project', details.projectRoot, '--data-dir', setup.dataDir]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
});

test('CLI demo from a nested checkout needs no Git executable and keeps state in the caller repo-local base', async t => {
  const setup = await workspace(t), entry = path.resolve('scripts/graphlin.mjs');
  const nested = path.join(setup.projectRoot, 'src/nested'), dataDir = path.join(setup.projectRoot, '.graphlin');
  const projectRoot = path.join(dataDir, 'demo-project');
  const isolatedHome = path.join(setup.base, 'isolated-home'), emptyPath = path.join(setup.base, 'empty-path');
  await mkdir(nested, { recursive: true });
  await mkdir(path.join(setup.projectRoot, '.git'));
  await mkdir(isolatedHome);
  await mkdir(emptyPath);
  const env = { ...process.env, PATH: emptyPath, HOME: isolatedHome, XDG_STATE_HOME: path.join(isolatedHome, 'state'),
    GRAPHLIN_DATA_DIR: '', TYPESAFE_API_KEY: 'MUST_NOT_LEAVE_DEMO' };
  try {
    const started = await run(process.execPath, [entry, 'demo', '--background'], { cwd: nested, env });
    assert.equal(started.code, 0, started.stderr);
    const details = JSON.parse(started.stdout);
    assert.equal(details.projectRoot, projectRoot);
    assert.equal(details.mode, 'demo');
    assert.equal(path.dirname(path.dirname(details.logPath)), dataDir, 'daemon uses the caller base');
    assert.equal(await readFile(path.join(setup.projectRoot, '.gitignore'), 'utf8'), '/.graphlin/\n');
    assert.equal(await readFile(path.join(dataDir, '.gitignore'), 'utf8'), '*\n');
    await assert.rejects(stat(path.join(nested, '.graphlin')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(projectRoot, '.graphlin')), { code: 'ENOENT' });
    let snapshot;
    for (let attempt = 0; attempt < 30; attempt++) {
      const exported = await run(process.execPath,
        [entry, 'export', '--project', projectRoot, '--data-dir', dataDir], { cwd: nested, env });
      assert.equal(exported.code, 0, exported.stderr);
      snapshot = JSON.parse(exported.stdout);
      if (snapshot.status.pending === 0 && snapshot.activity.some(event => event.kind === 'turn.stopped')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(snapshot.mode, 'demo');
    assert.ok(snapshot.activity.some(event => event.kind === 'turn.stopped'));
    assert.ok(snapshot.graph.edges.some(edge => edge.relation === 'writes'));
    assert.equal(JSON.stringify(snapshot).includes('MUST_NOT_LEAVE_DEMO'), false);
    assert.deepEqual(await readdir(isolatedHome), [], 'demo creates no home state');
    const stopped = await run(process.execPath,
      [entry, 'stop', '--project', projectRoot, '--data-dir', dataDir], { cwd: nested, env });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).stopped, true);
  } finally {
    await stopDaemon({ projectRoot, dataDir }).catch(() => {});
  }
});
