import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink, cp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnectionInfo } from '../../runtime/daemon/connection-info.mjs';
import { publicPackageFiles, validatePackage } from '../../scripts/validate-packages.mjs';

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
const currentVersion = '0.1.0';
async function fixture(t, suffix = 'project') {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin-connection-'));
  const projectRoot = path.join(base, suffix), dataDir = path.join(base, 'private data');
  await mkdir(projectRoot);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, projectRoot, dataDir };
}
async function file(root, name, content) {
  const filename = path.join(root, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, typeof content === 'string' ? content : JSON.stringify(content));
}
async function plugin(root, profile, { version = currentVersion, source = false } = {}) {
  await file(root, 'plugin.json', {
    name: 'graphlin', version,
    ...(profile === 'portable' ? {} : { extensions: { 'com.openai': { hooks: './adapters/codex/hooks.json' } } }),
  });
  if (!source) await file(root, '.graphlin-package', profile);
  await file(root, '.codex-plugin/plugin.json', { name: 'graphlin', version, mcpServers: './.mcp.json' });
  if (profile === 'claude' || source) {
    await file(root, '.claude-plugin/plugin.json', { name: 'graphlin', version, hooks: './adapters/claude/hooks.json' });
  }
  const variable = profile === 'codex' ? '${PLUGIN_ROOT}' : '${CLAUDE_PLUGIN_ROOT}';
  await file(root, '.mcp.json', { mcpServers: { graphlin: { command: 'node', args: [`${variable}/scripts/control.mjs`] } } });
  for (const host of ['claude', 'codex']) {
    await file(root, `adapters/${host}/hooks.json`, { hooks: { SessionStart: [] } });
  }
  for (const name of ['scripts/control.mjs', 'scripts/collect.sh', 'scripts/collector.mjs', 'runtime/collector/index.mjs']) {
    await file(root, name, '// fixture file, never executed\n');
  }
  // Packaged profiles contain this too; it is not proof of a source checkout.
  await file(root, 'scripts/build-packages.mjs', '// fixture builder, never executed\n');
}
async function marketplace(root, changes = {}) {
  await file(root, '.agents/plugins/marketplace.json', {
    name: 'graphlin-local',
    plugins: [{ name: 'graphlin', source: { source: 'local', path: './graphlin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
    ...changes,
  });
}
async function distribution(base) {
  const roots = Object.fromEntries(['claude', 'codex', 'portable'].map(profile =>
    [profile, path.join(base, 'distribution', profile, 'graphlin')]));
  for (const [profile, root] of Object.entries(roots)) await plugin(root, profile);
  await marketplace(path.dirname(roots.codex));
  return roots;
}
const byId = (info, id) => info.instructions.find(instruction => instruction.id === id);
const commands = info => info.instructions.flatMap(instruction => instruction.steps.map(step => step.command));
const terminal = (setup, words) => `cd ${quote(setup.projectRoot)} && GRAPHLIN_DATA_DIR=${quote(setup.dataDir)} ${words}`;
const outputFor = setup => path.join(setup.dataDir, 'plugins', 'graphlin', currentVersion);

test('source checkout requires a fresh build before exact Claude/Codex new and resume commands', async t => {
  const setup = await fixture(t), root = path.join(setup.base, 'source checkout');
  await plugin(root, 'claude', { source: true });
  const info = await createConnectionInfo({ ...setup, pluginRoot: root });
  assert.deepEqual(Object.keys(info), ['projectRoot', 'mode', 'instructions', 'notes']);
  assert.equal(info.projectRoot, setup.projectRoot);
  assert.equal(info.mode, 'live');
  assert.deepEqual(info.instructions.map(item => item.id),
    ['build-packages', 'claude-new', 'claude-resume', 'codex-setup', 'codex-new', 'codex-resume']);
  assert.equal(info.instructions[0].steps[0].command, terminal(setup, `node ${quote(path.join(root, 'scripts/build-packages.mjs'))} --out ${quote(outputFor(setup))}`));
  const claude = terminal(setup, `claude --plugin-dir ${quote(path.join(outputFor(setup), 'claude/graphlin'))}`);
  assert.equal(byId(info, 'claude-new').steps[0].command, claude);
  assert.equal(byId(info, 'claude-resume').steps[0].command, `${claude} --continue`);
  assert.deepEqual(byId(info, 'codex-setup').steps.map(step => step.command), [
    terminal(setup, `codex plugin marketplace add ${quote(path.join(outputFor(setup), 'codex'))}`),
    terminal(setup, "codex plugin add 'graphlin@graphlin-local'"),
  ]);
  const codex = terminal(setup, `codex -C ${quote(setup.projectRoot)}`);
  assert.equal(byId(info, 'codex-new').steps[0].command, codex);
  assert.equal(byId(info, 'codex-resume').steps[0].command, `${codex} resume --last`);
  assert.match(info.instructions[0].description, /prerequisite first/);
  assert.match(byId(info, 'claude-new').description, /build step above first/);
  assert.match(byId(info, 'codex-setup').description, /build step above first/);
  for (const id of ['codex-new', 'codex-resume']) {
    assert.deepEqual(byId(info, id).steps[1], {
      label: 'Inside Codex: /hooks', command: '/hooks',
      description: 'Inside Codex, review and trust Graphlin hooks; then start your work',
    });
    assert.doesNotMatch(JSON.stringify(byId(info, id)), /--plugin-dir/);
  }
});

test('connection guide builds usable host plugins from a read-only npm installation', async t => {
  const setup = await fixture(t), root = path.join(setup.base, 'read-only installation');
  for (const name of await publicPackageFiles(process.cwd())) {
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.resolve(name), destination);
  }
  const before = await readdir(root);
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const expectedOutput = path.join(setup.dataDir, 'plugins', 'graphlin', version);
  await chmod(root, 0o555);
  try {
    const info = await createConnectionInfo({ ...setup, pluginRoot: root });
    const command = byId(info, 'build-packages').steps[0].command;
    const { stdout } = await exec('/bin/sh', ['-c', command], { cwd: setup.base, timeout: 15000 });
    const built = JSON.parse(stdout);
    assert.equal(built.length, 3);
    for (const item of built) {
      assert.equal(path.dirname(path.dirname(item.directory)), expectedOutput);
      assert.equal((await validatePackage(item.directory)).valid, true);
    }
    assert.deepEqual(await readdir(root), before, 'no generated files enter the installation');
    assert.match(byId(info, 'claude-new').steps[0].command, /--plugin-dir/);
    const marketplaceRoot = path.join(expectedOutput, 'codex');
    const metadata = JSON.parse(await readFile(path.join(marketplaceRoot, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.equal(metadata.plugins[0].source.path, './graphlin');
  } finally { await chmod(root, 0o755); }
});

test('source checkout still rebuilds when old generated profiles have the same version', async t => {
  const setup = await fixture(t), root = path.join(setup.base, 'source');
  await plugin(root, 'claude', { source: true });
  for (const host of ['claude', 'codex']) await plugin(path.join(root, 'dist', host, 'graphlin'), host);
  await marketplace(path.join(root, 'dist/codex'));
  const info = await createConnectionInfo({ ...setup, pluginRoot: root });
  assert.equal(info.instructions[0].id, 'build-packages');
  assert.match(info.instructions[0].description, /may be out of date/);
});

test('relocated Claude, Codex, and portable packages locate verified siblings without rebuilding', async t => {
  const setup = await fixture(t), roots = await distribution(setup.base);
  for (const pluginRoot of Object.values(roots)) {
    const info = await createConnectionInfo({ ...setup, pluginRoot });
    assert.equal(info.instructions.length, 5);
    assert.equal(byId(info, 'build-packages'), undefined);
    assert.equal(byId(info, 'claude-new').steps[0].command,
      terminal(setup, `claude --plugin-dir ${quote(roots.claude)}`));
    assert.equal(byId(info, 'codex-setup').steps[0].command,
      terminal(setup, `codex plugin marketplace add ${quote(path.dirname(roots.codex))}`));
  }
});

test('standalone packages never invent missing siblings or rebuild from their copied builder', async t => {
  const setup = await fixture(t);
  for (const profile of ['claude', 'codex', 'portable']) {
    const root = path.join(setup.base, `standalone-${profile}`, 'graphlin');
    await plugin(root, profile);
    const info = await createConnectionInfo({ ...setup, pluginRoot: root });
    assert.equal(byId(info, 'build-packages'), undefined);
    assert.equal(byId(info, 'codex-setup'), undefined);
    assert.equal(Boolean(byId(info, 'claude-new')), profile === 'claude');
    assert.ok(info.notes.some(note => note.includes('Codex connection is unavailable')));
    if (profile !== 'claude') assert.ok(info.notes.some(note => note.includes('Claude connection is unavailable')));
  }
});

test('packaged profiles reject mismatched versions, markers, MCP substitutions, and missing hook files', async t => {
  const setup = await fixture(t), roots = await distribution(setup.base);
  for (const corrupt of [
    () => file(roots.claude, '.claude-plugin/plugin.json', { name: 'graphlin', version: '99.0.0', hooks: './adapters/claude/hooks.json' }),
    () => file(roots.claude, '.graphlin-package', 'codex'),
    () => file(roots.claude, '.mcp.json', { mcpServers: { graphlin: { command: 'node', args: ['${PLUGIN_ROOT}/scripts/control.mjs'] } } }),
    () => rm(path.join(roots.claude, 'adapters/claude/hooks.json')),
    () => rm(path.join(roots.claude, 'scripts/collector.mjs')),
  ]) {
    await plugin(roots.claude, 'claude');
    await corrupt();
    const info = await createConnectionInfo({ ...setup, pluginRoot: roots.portable });
    assert.equal(byId(info, 'claude-new'), undefined);
    assert.ok(byId(info, 'codex-new'));
  }
});

test('Codex marketplace must name the expected local plugin, path, and install policy', async t => {
  const setup = await fixture(t), roots = await distribution(setup.base);
  const root = path.dirname(roots.codex);
  const valid = { name: 'graphlin', source: { source: 'local', path: './graphlin' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' };
  for (const changes of [
    { name: 'other-marketplace' }, { plugins: [] }, { plugins: [valid, valid] },
    { plugins: [{ ...valid, source: { source: 'url', url: 'https://example.invalid/plugin' } }] },
    { plugins: [{ ...valid, source: { source: 'local', path: '../other' } }] },
    { plugins: [{ ...valid, source: './graphlin' }] },
    { plugins: [{ ...valid, policy: { installation: 'NOT_AVAILABLE', authentication: 'ON_INSTALL' } }] },
  ]) {
    await marketplace(root, changes);
    const info = await createConnectionInfo({ ...setup, pluginRoot: roots.claude });
    assert.equal(byId(info, 'codex-setup'), undefined);
    assert.ok(byId(info, 'claude-new'));
  }
  await rm(path.join(root, '.agents/plugins/marketplace.json'));
  assert.equal(byId(await createConnectionInfo({ ...setup, pluginRoot: roots.codex }), 'codex-new'), undefined);
});

test('malformed, oversized, linked, and non-file package metadata produce fixed setup notes', async t => {
  const setup = await fixture(t), root = path.join(setup.base, 'broken');
  for (const marker of ['unknown', 'claude'.repeat(20), '{"private":"DO_NOT_ECHO"}']) {
    await plugin(root, 'claude');
    await file(root, '.graphlin-package', marker);
    const info = await createConnectionInfo({ ...setup, pluginRoot: root });
    assert.deepEqual(info.instructions, []);
    assert.doesNotMatch(JSON.stringify(info), /DO_NOT_ECHO|unknown/);
  }
  await rm(path.join(root, '.graphlin-package'));
  await symlink(path.join(root, 'plugin.json'), path.join(root, '.graphlin-package'));
  assert.deepEqual((await createConnectionInfo({ ...setup, pluginRoot: root })).instructions, []);
  await rm(path.join(root, '.graphlin-package'));
  await mkdir(path.join(root, '.graphlin-package'));
  assert.deepEqual((await createConnectionInfo({ ...setup, pluginRoot: root })).instructions, []);
  await rm(path.join(root, '.graphlin-package'), { recursive: true });
  await file(root, '.graphlin-package', 'claude');
  for (const body of ['{invalid', '"DO_NOT_ECHO"', ' '.repeat(16385)]) {
    await file(root, 'plugin.json', body);
    assert.deepEqual((await createConnectionInfo({ ...setup, pluginRoot: root })).instructions, []);
  }
});

test('shell commands preserve hostile paths as literal arguments and never execute path contents', async t => {
  const hostile = `quotes ' " $(touch INJECTED) \`touch INJECTED\` ; & $HOME \\ unicode-שלום`;
  const setup = await fixture(t, hostile);
  setup.dataDir = path.join(setup.base, `data ${hostile}`);
  const root = path.join(setup.base, `plugin ${hostile}`);
  await plugin(root, 'claude', { source: true });
  const info = await createConnectionInfo({ ...setup, pluginRoot: root });
  // Functions stand in for all executables. Only this test's printf runs; no
  // host CLI, package builder, plugin installation, or network call can occur.
  const capture = "capture() { printf '%s\\0' \"$PWD\" \"$GRAPHLIN_DATA_DIR\" \"$@\"; }\n" +
    "node() { capture node \"$@\"; }\nclaude() { capture claude \"$@\"; }\ncodex() { capture codex \"$@\"; }\n";
  const expectedArgs = [
    ['node', path.join(root, 'scripts/build-packages.mjs'), '--out', outputFor(setup)],
    ['claude', '--plugin-dir', path.join(outputFor(setup), 'claude/graphlin')],
    ['claude', '--plugin-dir', path.join(outputFor(setup), 'claude/graphlin'), '--continue'],
    ['codex', 'plugin', 'marketplace', 'add', path.join(outputFor(setup), 'codex')],
    ['codex', 'plugin', 'add', 'graphlin@graphlin-local'],
    ['codex', '-C', setup.projectRoot],
    ['codex', '-C', setup.projectRoot, 'resume', '--last'],
  ];
  const shellCommands = commands(info).filter(command => command !== '/hooks');
  assert.equal(shellCommands.length, expectedArgs.length);
  for (const [index, command] of shellCommands.entries()) {
    const result = await exec('/bin/sh', ['-c', capture + command], { cwd: setup.base, timeout: 2000, maxBuffer: 64 * 1024 });
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.split('\0').slice(0, -1), [setup.projectRoot, setup.dataDir, ...expectedArgs[index]]);
  }
  assert.equal((await readdir(setup.base)).includes('INJECTED'), false);
  assert.deepEqual(await readdir(setup.projectRoot), []);
});

test('invalid path/mode inputs fail without echo and overlong commands are omitted intact', async t => {
  const setup = await fixture(t), root = path.join(setup.base, 'source');
  await plugin(root, 'claude', { source: true });
  for (const value of ['', 'relative', '/a\0SECRET', '/a\nSECRET', '/a\rSECRET', '/a\tSECRET', '/a\u202eSECRET', `/${'x'.repeat(4096)}`, null]) {
    for (const field of ['projectRoot', 'dataDir', 'pluginRoot']) {
      await assert.rejects(createConnectionInfo({ ...setup, pluginRoot: root, [field]: value }),
        error => error instanceof TypeError && error.message === 'invalid_connection_info');
    }
  }
  await assert.rejects(createConnectionInfo({ ...setup, pluginRoot: root, mode: 'SECRET' }),
    { message: 'invalid_connection_info' });
  const huge = `/${"'".repeat(1900)}`;
  const info = await createConnectionInfo({ projectRoot: huge, dataDir: huge, pluginRoot: root });
  assert.deepEqual(info.instructions, []);
  assert.ok(info.notes.some(note => note.includes('too long')));
});

test('helper is deterministic, preserves mode, and never copies unrelated fields or file contents', async t => {
  const setup = await fixture(t), root = path.join(setup.base, 'source');
  await plugin(root, 'claude', { source: true });
  await file(root, '.env', 'TYPESAFE_API_KEY=PRIVATE_ENV_SENTINEL');
  await file(setup.projectRoot, 'evidence.txt', 'PRIVATE_EVIDENCE_SENTINEL');
  const manifestPath = path.join(root, 'plugin.json');
  const metadata = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...metadata, private: 'PRIVATE_METADATA_SENTINEL' }));
  const input = { ...setup, pluginRoot: root, mode: 'demo', apiKey: 'PRIVATE_KEY_SENTINEL',
    token: 'PRIVATE_TOKEN_SENTINEL', url: 'http://localhost/#token=PRIVATE_URL_SENTINEL',
    state: { evidence: 'PRIVATE_STATE_SENTINEL' } };
  const before = structuredClone(input), files = await readdir(root);
  const first = await createConnectionInfo(input), second = await createConnectionInfo(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.deepEqual(await readdir(root), files);
  assert.equal(first.mode, 'demo');
  assert.ok(first.notes.some(note => note.includes('fixture classifications')));
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|\bapiKey\b|#token|\.env/);
  assert.ok(commands(first).every(command => Buffer.byteLength(command) <= 8192));
});
