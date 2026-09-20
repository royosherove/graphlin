import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnectionInfo, inspectInstalledPackages } from '../../runtime/daemon/connection-info.mjs';
import { parseArguments } from '../../scripts/arguments.mjs';

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
const { version: currentVersion } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
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
const byId = (info, id) => info.instructions.find(instruction => instruction.id === id);
const commands = info => info.instructions.flatMap(instruction => instruction.steps.map(step => step.command));
const terminal = (setup, words) => `cd ${quote(setup.projectRoot)} && GRAPHLIN_DATA_DIR=${quote(setup.dataDir)} ${words}`;
const outputFor = setup => path.join(setup.dataDir, 'plugins', 'graphlin', currentVersion);

test('live viewer offers optional npm setup alone and new agent sessions with host trust', async t => {
  const setup = await fixture(t);
  const info = await createConnectionInfo(setup);
  assert.deepEqual(Object.keys(info), ['projectRoot', 'mode', 'instructions', 'notes']);
  assert.equal(info.projectRoot, setup.projectRoot);
  assert.equal(info.mode, 'live');
  assert.deepEqual(info.instructions.map(item => item.id), ['npm-setup', 'claude-new', 'codex-new']);
  assert.equal(byId(info, 'npm-setup').steps[0].command, terminal(setup, 'npx --yes graphlin@latest init'));
  assert.match(byId(info, 'npm-setup').description, /already running.*skip this step.*init does not start another server/);
  for (const [host, review] of [['claude', '/plugin'], ['codex', '/hooks']]) {
    const instruction = byId(info, `${host}-new`);
    assert.equal(instruction.steps[0].command, terminal(setup, host));
    assert.equal(instruction.steps[1].command, review);
    assert.match(instruction.description, /second terminal.*same project.*new agent session.*project trust/);
  }
  assert.match(byId(info, 'codex-new').steps[1].description, /Review and trust/);
  assert.doesNotMatch(commands(info).join('\n'), /build-packages|--plugin-dir|marketplace|--continue|resume|--allow-source|--no-source/);
  const npmCommands = commands(info).filter(command => command.includes('npx'));
  assert.equal(npmCommands.length, 1);
  assert.ok(npmCommands[0].endsWith('graphlin@latest init'), 'current viewer never offers a redundant server launch');
});

test('guide explains README onboarding, consent, custom data directory and current instance limits', async t => {
  const info = await createConnectionInfo(await fixture(t));
  const text = JSON.stringify(info);
  assert.match(text, /Next time: npx --yes graphlin@latest.*claude or codex in a second terminal/);
  assert.match(text, /masked prompt.*Metadata mode needs no key/);
  assert.match(text, /current policy and classifier configuration stay in effect/);
  assert.match(text, /stopping and restarting.*same data directory/);
  assert.match(text, /Plugins install across projects; source consent is per project/);
  assert.match(text, /locally filtered source excerpts, user prompts, and public agent messages.*TypeSafe/);
  assert.match(text, /custom data directory/);
  assert.match(text, /Installation does not confirm hook activation/);
  assert.match(text, /Orient yourself in this project: read its main files and explain how the components connect/);
});

test('demo starts guided onboarding in the user project and never launches agents in the fixture project', async t => {
  const setup = await fixture(t, 'demo-fixture');
  const info = await createConnectionInfo({ ...setup, mode: 'demo' });
  assert.equal(byId(info, 'npm-setup').steps[0].command, 'npx --yes graphlin@latest');
  assert.match(byId(info, 'npm-setup').description, /terminal in your own project.*keep that terminal running/);
  for (const host of ['claude', 'codex']) {
    assert.equal(byId(info, `${host}-new`).steps[0].command, host);
  }
  assert.ok(commands(info).every(command => !command.includes(setup.projectRoot)));
  assert.match(info.notes.join(' '), /fixture classifications.*own project.*not this demo’s custom directory/);
});

test('standard home data uses short commands even when the daemon environment has an override', async t => {
  const setup = await fixture(t);
  const original = process.env.GRAPHLIN_DATA_DIR;
  process.env.GRAPHLIN_DATA_DIR = setup.dataDir;
  t.after(() => {
    if (original === undefined) delete process.env.GRAPHLIN_DATA_DIR;
    else process.env.GRAPHLIN_DATA_DIR = original;
  });
  const info = await createConnectionInfo({ ...setup, dataDir: path.join(homedir(), '.local/state/graphlin') });
  assert.equal(byId(info, 'npm-setup').steps[0].command, `cd ${quote(setup.projectRoot)} && npx --yes graphlin@latest init`);
  for (const host of ['claude', 'codex']) {
    assert.equal(byId(info, `${host}-new`).steps[0].command, `cd ${quote(setup.projectRoot)} && ${host}`);
  }
  assert.ok(commands(info).every(command => !command.includes('GRAPHLIN_DATA_DIR')));
  assert.match(info.notes.join(' '), /Unset GRAPHLIN_DATA_DIR in both terminals/);
  const custom = await createConnectionInfo(setup);
  assert.equal(byId(custom, 'npm-setup').steps[0].command, terminal(setup, 'npx --yes graphlin@latest init'),
    'an environment-selected custom directory still needs an explicit assignment');
});

test('shell commands preserve hostile paths as literal arguments and match the CLI setup behavior', async t => {
  const hostile = `quotes ' " $(touch INJECTED) \`touch INJECTED\` ; & $HOME \\ unicode-שלום`;
  const setup = await fixture(t, hostile);
  setup.dataDir = path.join(setup.base, `data ${hostile}`);
  // Functions stand in for executables; no host, npm, network, or server runs.
  const capture = "capture() { printf '%s\\0' \"$PWD\" \"$GRAPHLIN_DATA_DIR\" \"$@\"; }\n" +
    "npx() { capture npx \"$@\"; }\nclaude() { capture claude \"$@\"; }\ncodex() { capture codex \"$@\"; }\n";
  for (const mode of ['live', 'demo']) {
    const info = await createConnectionInfo({ ...setup, mode });
    const expectedArgs = [['npx', '--yes', 'graphlin@latest', ...(mode === 'live' ? ['init'] : [])], ['claude'], ['codex']];
    const shellCommands = commands(info).filter(command => !command.startsWith('/'));
    assert.equal(shellCommands.length, expectedArgs.length);
    for (const [index, command] of shellCommands.entries()) {
      const result = await exec('/bin/sh', ['-c', capture + command], { cwd: setup.projectRoot, env: { PATH: process.env.PATH, GRAPHLIN_DATA_DIR: '' }, timeout: 2000, maxBuffer: 64 * 1024 });
      assert.equal(result.stderr, '');
      const captured = result.stdout.split('\0').slice(0, -1);
      assert.deepEqual(captured, [setup.projectRoot, mode === 'live' ? setup.dataDir : '', ...expectedArgs[index]]);
      if (index === 0) {
        const parsed = parseArguments(captured.slice(5));
        assert.equal(parsed.command, mode === 'live' ? 'init' : 'start');
        assert.equal(parsed.guided, mode === 'demo');
        assert.equal(parsed.allowSource, undefined, 'guide never opts the user into source');
      }
    }
  }
  assert.equal((await readdir(setup.base)).includes('INJECTED'), false);
  assert.deepEqual(await readdir(setup.projectRoot), []);
});

test('invalid path/mode inputs fail without echo and overlong commands are omitted intact', async t => {
  const setup = await fixture(t);
  for (const value of ['', 'relative', '/a\0SECRET', '/a\nSECRET', '/a\rSECRET', '/a\tSECRET', '/a\u202eSECRET', `/${'x'.repeat(4096)}`, null]) {
    for (const field of ['projectRoot', 'dataDir']) {
      await assert.rejects(createConnectionInfo({ ...setup, [field]: value }),
        error => error instanceof TypeError && error.message === 'invalid_connection_info');
    }
  }
  await assert.rejects(createConnectionInfo({ ...setup, mode: 'SECRET' }), { message: 'invalid_connection_info' });
  const huge = `/${"'".repeat(1900)}`;
  const info = await createConnectionInfo({ projectRoot: huge, dataDir: huge });
  assert.deepEqual(info.instructions, []);
  assert.ok(info.notes.some(note => note.includes('too long')));
});

test('guide is deterministic, read-only, and independent of local package or private contents', async t => {
  const setup = await fixture(t), root = path.join(setup.base, 'source');
  await file(root, '.env', 'TYPESAFE_API_KEY=PRIVATE_ENV_SENTINEL');
  await file(setup.projectRoot, 'evidence.txt', 'PRIVATE_EVIDENCE_SENTINEL');
  await file(root, 'plugin.json', '{invalid PRIVATE_METADATA_SENTINEL');
  const input = { ...setup, pluginRoot: root, apiKey: 'PRIVATE_KEY_SENTINEL',
    token: 'PRIVATE_TOKEN_SENTINEL', url: 'http://localhost/#token=PRIVATE_URL_SENTINEL',
    state: { evidence: 'PRIVATE_STATE_SENTINEL' } };
  const before = structuredClone(input), files = await readdir(root);
  const first = await createConnectionInfo(input), second = await createConnectionInfo(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.deepEqual(await readdir(root), files);
  assert.deepEqual(await readdir(setup.projectRoot), ['evidence.txt']);
  assert.equal(first.instructions.length, 3, 'npm setup does not depend on discovering sibling packages');
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|\bapiKey\b|#token|\.env/);
  assert.ok(commands(first).every(command => Buffer.byteLength(command) <= 8192));
});

test('onboarding package inspection still verifies matching host profiles, versions, MCP and hooks', async t => {
  const setup = await fixture(t);
  const roots = Object.fromEntries(['claude', 'codex'].map(host => [host, path.join(outputFor(setup), host, 'graphlin')]));
  const inspect = () => inspectInstalledPackages({ dataDir: setup.dataDir, version: currentVersion });
  assert.deepEqual(await inspect(), { claude: false, codex: false });
  for (const host of ['claude', 'codex']) await plugin(roots[host], host);
  assert.deepEqual(await inspect(), { claude: true, codex: true });
  for (const host of ['claude', 'codex']) {
    for (const corrupt of [
      () => file(roots[host], `.${host}-plugin/plugin.json`, { name: 'graphlin', version: '99.0.0' }),
      () => file(roots[host], '.graphlin-package', 'portable'),
      () => file(roots[host], '.mcp.json', { mcpServers: { graphlin: { command: 'node', args: ['wrong/scripts/control.mjs'] } } }),
      () => rm(path.join(roots[host], `adapters/${host}/hooks.json`)),
      () => rm(path.join(roots[host], 'scripts/collector.mjs')),
    ]) {
      await plugin(roots[host], host);
      await corrupt();
      assert.deepEqual(await inspect(), { claude: true, codex: true, [host]: false });
    }
    await plugin(roots[host], host);
  }
});

test('package inspector rejects malformed, oversized, linked, and non-file metadata', async t => {
  const setup = await fixture(t), root = path.join(outputFor(setup), 'claude/graphlin');
  const inspect = () => inspectInstalledPackages({ dataDir: setup.dataDir, version: currentVersion });
  await plugin(root, 'claude');
  for (const marker of ['unknown', 'claude'.repeat(20), '{"private":"DO_NOT_ECHO"}']) {
    await file(root, '.graphlin-package', marker);
    assert.deepEqual(await inspect(), { claude: false, codex: false });
  }
  await rm(path.join(root, '.graphlin-package'));
  await symlink(path.join(root, 'plugin.json'), path.join(root, '.graphlin-package'));
  assert.equal((await inspect()).claude, false);
  await rm(path.join(root, '.graphlin-package'));
  await mkdir(path.join(root, '.graphlin-package'));
  assert.equal((await inspect()).claude, false);
  await rm(path.join(root, '.graphlin-package'), { recursive: true });
  await file(root, '.graphlin-package', 'claude');
  for (const body of ['{invalid', '"DO_NOT_ECHO"', ' '.repeat(16385)]) {
    await file(root, 'plugin.json', body);
    assert.equal((await inspect()).claude, false);
  }
});
