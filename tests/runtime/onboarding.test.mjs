import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, chmod, stat, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { workspace, run as runCLI } from './helpers.mjs';
import { readSettings, saveSettings } from '../../runtime/daemon/settings.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { daemonStatus } from '../../runtime/daemon/manager.mjs';
import { parseArguments } from '../../scripts/arguments.mjs';
import { initOnboarding, uninstallOnboarding, needsOnboarding, runHost, terminalPrompt,
  preparePackages, agentInstructions, openViewer, packageVersion } from '../../scripts/onboarding.mjs';

const entry = path.resolve('scripts/graphlin.mjs');
const metadata = { allowSource: false, persistEvidence: false, displayEvidence: true };

function harness(overrides = {}) {
  let state = structuredClone(overrides.state ?? {});
  const marketplaces = new Map(Object.entries(overrides.marketplaces ?? {}));
  const installed = new Set(state.installation?.hosts ?? []);
  const calls = [], patches = [], output = [];
  return {
    calls, patches, output, state: () => state,
    dependencies: {
      settings: {
        readSettings: async () => structuredClone(state),
        saveSettings: async (_, patch) => { patches.push(patch); state = { ...state, ...patch }; },
      },
      interactive: false, env: {}, version: async () => '0.1.0',
      run: async (host, args, options) => {
        calls.push({ host, args, options });
        if (overrides.reject?.(host, args)) throw new Error('synthetic_host_failure');
        if (args[1] === 'marketplace') {
          if (args[2] === 'list') {
            const root = marketplaces.get(host);
            const entries = root ? [{ name: 'graphlin-local', source: 'directory', path: root, root,
              marketplaceSource: { sourceType: 'local', source: root } }] : [];
            return JSON.stringify(host === 'claude' ? entries : { marketplaces: entries });
          }
          if (args[2] === 'add') marketplaces.set(host, args[3]);
          if (args[2] === 'remove') { marketplaces.delete(host); installed.delete(host); }
        } else if (args[1] === 'list') {
          const plugins = installed.has(host) ? [{ id: 'graphlin@graphlin-local', pluginId: 'graphlin@graphlin-local', scope: 'user' }] : [];
          return JSON.stringify(host === 'claude' ? plugins : { installed: plugins });
        } else if (['install', 'update', 'add'].includes(args[1])) installed.add(host);
        else if (['uninstall', 'remove'].includes(args[1])) installed.delete(host);
      },
      prepare: async (dataDir, version = '0.1.0') => {
        const output = path.join(dataDir, 'plugins', 'graphlin', version);
        for (const host of ['claude', 'codex']) {
          const folder = path.join(output, host, host === 'claude' ? '.claude-plugin' : '.agents/plugins');
          await mkdir(folder, { recursive: true });
          await writeFile(path.join(folder, 'marketplace.json'), JSON.stringify({ name: 'graphlin-local',
            plugins: [{ name: 'graphlin', source: host === 'claude' ? './graphlin' : { source: 'local', path: './graphlin' } }] }));
        }
        return output;
      },
      write: value => output.push(value),
    },
  };
}

async function stubHosts(setup) {
  const bin = path.join(setup.base, 'stub executables');
  await mkdir(bin);
  const log = path.join(setup.base, 'host-events.jsonl');
  const program = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const host = path.basename(process.argv[1]).replace(/\\.mjs$/, '');
appendFileSync(process.env.STUB_LOG, JSON.stringify({ host, args,
  keyInherited: Object.hasOwn(process.env, 'TYPESAFE_API_KEY'), cwd: process.cwd() }) + '\\n');
if (process.env.STUB_HANG === '1') { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }
else if (process.env.STUB_FAIL === '1' ||
  process.env.STUB_FAIL_CODEX_ADD === '1' && host === 'codex' && args[1] === 'add') {
  console.error('PRIVATE_HOST_OUTPUT_SENTINEL'); process.exit(7);
}
else if (args[0] === 'plugin') {
  let state = {}; try { state = JSON.parse(readFileSync(process.env.STUB_STATE, 'utf8')); } catch {}
  state[host] ??= {};
  if (args[1] === 'marketplace') {
    if (args[2] === 'add') state[host].root = args[3];
    if (args[2] === 'remove') delete state[host].root;
    if (args[2] === 'list') {
      const root = state[host].root;
      const entries = root ? [{name:'graphlin-local',source:'directory',path:root,root,marketplaceSource:{sourceType:'local',source:root}}] : [];
      console.log(JSON.stringify(host === 'claude' ? entries : {marketplaces:entries}));
    }
  } else if (args[1] === 'list') {
    const plugins = state[host].installed ? [{id:'graphlin@graphlin-local',pluginId:'graphlin@graphlin-local',scope:'user'}] : [];
    console.log(JSON.stringify(host === 'claude' ? plugins : {installed:plugins}));
  } else if (['install','update','add'].includes(args[1])) state[host].installed = true;
  else if (['uninstall','remove'].includes(args[1])) state[host].installed = false;
  writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
}
`;
  for (const host of ['claude', 'codex', 'xdg-open', 'open']) {
    await writeFile(path.join(bin, `${host}.mjs`), program);
    await chmod(path.join(bin, `${host}.mjs`), 0o700);
    await symlink(`${host}.mjs`, path.join(bin, host));
  }
  return { bin, log, env: { PATH: bin, HOME: setup.base, STUB_LOG: log, STUB_STATE: path.join(setup.base, 'synthetic-host-state.json') },
    events: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('policy omission differs from explicit opt-out and workers keep safe defaults', () => {
  assert.deepEqual(parseArguments(['start']), {
    command: 'start', guided: false, projectRoot: process.cwd(), allowSource: undefined,
    persistEvidence: undefined, displayEvidence: undefined, background: false,
  });
  assert.equal(parseArguments([]).guided, true);
  assert.equal(parseArguments(['--project', '/tmp/project']).guided, true);
  assert.equal(parseArguments(['start', '--no-source']).allowSource, false);
  assert.equal(parseArguments(['init', '--host', 'both', '--allow-source']).host, 'both');
  assert.equal(parseArguments([], { worker: true }).allowSource, false);
  assert.equal(parseArguments([], { worker: true }).displayEvidence, true);
  assert.throws(() => parseArguments(['start', '--allow-source', '--no-source']), /conflicting/);
  assert.throws(() => parseArguments(['start', '--no-source', '--allow-source']), /conflicting/);
  assert.throws(() => parseArguments(['init', '--host', 'unsupported']), /invalid_host/);
  assert.throws(() => parseArguments(['init', '--api-key', 'synthetic']), /unknown_argument/);
  assert.throws(() => parseArguments(['--no-source'], { worker: true }), /unknown_argument/);
});

test('noninteractive setup requires explicit host and consent before invoking hosts or asking for a key', async t => {
  const setup = await workspace(t), h = harness();
  for (const options of [setup, { ...setup, host: 'claude' }, { ...setup, allowSource: false }]) {
    await assert.rejects(initOnboarding(options, h.dependencies), { code: 'setup_required' });
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.patches.length, 0);
  await assert.rejects(initOnboarding({ ...setup, host: 'claude', allowSource: true }, h.dependencies), { code: 'key_required' });
  assert.equal(h.calls.every(call => call.args[0] === '--version'), true);
  assert.equal(h.patches.length, 0);
});

test('guided metadata consent installs both hosts through exact argv and records each success', async t => {
  const setup = await workspace(t), h = harness();
  const answers = ['both', 'metadata'];
  const result = await initOnboarding(setup, { ...h.dependencies, interactive: true,
    prompt: async (_, options) => { assert.equal(options?.secret, undefined); return answers.shift(); } });
  assert.deepEqual(result.policy, metadata);
  assert.deepEqual(h.patches.map(patch => patch.installation?.hosts).filter(Boolean), [[], ['claude'], ['claude', 'codex']]);
  assert.deepEqual(h.patches[0].installation.pendingHosts, ['claude', 'codex']);
  const install = h.calls.filter(call => call.args[0] === 'plugin' && !call.args.includes('list'));
  assert.deepEqual(install.map(call => [call.host, ...call.args]), [
    ['claude', 'plugin', 'marketplace', 'add', path.join(setup.dataDir, 'plugins/graphlin/0.1.0/claude')],
    ['claude', 'plugin', 'install', 'graphlin@graphlin-local', '--scope', 'user'],
    ['codex', 'plugin', 'marketplace', 'add', path.join(setup.dataDir, 'plugins/graphlin/0.1.0/codex')],
    ['codex', 'plugin', 'add', 'graphlin@graphlin-local'],
  ]);
  assert.match(h.output.join(''), /GRAPHLIN_DATA_DIR=/);
  assert.match(h.output.join(''), /\/hooks/);
});

test('masked key is saved only in settings and never in output, results, or host argv', async t => {
  const setup = await workspace(t), h = harness();
  const secret = 'SYNTHETIC_ONLY_KEY';
  const result = await initOnboarding({ ...setup, host: 'codex', allowSource: true }, {
    ...h.dependencies, interactive: true,
    prompt: async (_, options) => { assert.equal(options.secret, true); return secret; },
  });
  assert.equal(h.state().apiKey, secret);
  assert.equal(JSON.stringify({ result, output: h.output, calls: h.calls }).includes(secret), false);
  const envKey = harness();
  await initOnboarding({ ...setup, host: 'codex', allowSource: true },
    { ...envKey.dependencies, env: { TYPESAFE_API_KEY: secret } });
  assert.equal(envKey.state().apiKey, secret, 'explicit source setup persists the environment key');
  assert.equal(JSON.stringify(envKey.output).includes(secret), false);
});

test('an empty environment override cannot accidentally use a saved key', async t => {
  const setup = await workspace(t), h = harness({ state: { apiKey: 'SYNTHETIC_SAVED' } });
  await assert.rejects(initOnboarding({ ...setup, host: 'codex', allowSource: true },
    { ...h.dependencies, env: { TYPESAFE_API_KEY: '' } }), { code: 'empty_environment_key' });
  assert.equal(h.patches.length, 0);
});

test('a single detected host is selected automatically and replacing a saved key stays masked', async t => {
  const setup = await workspace(t);
  const h = harness({ state: { apiKey: 'SYNTHETIC_OLD_KEY' },
    reject: (host, args) => host === 'claude' && args[0] === '--version' });
  const prompts = [];
  await initOnboarding({ ...setup, replaceKey: true }, { ...h.dependencies, interactive: true,
    prompt: async (label, options) => {
      prompts.push({ label, secret: options?.secret });
      return options?.secret ? 'SYNTHETIC_REPLACEMENT' : 'source';
    } });
  assert.deepEqual(h.state().installation.hosts, ['codex']);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].secret, true);
  assert.equal(h.state().apiKey, 'SYNTHETIC_REPLACEMENT');
  assert.equal(h.output.join('').includes('SYNTHETIC_REPLACEMENT'), false);
  await assert.rejects(initOnboarding({ ...setup, host: 'codex', allowSource: false, replaceKey: true },
    h.dependencies), { code: 'terminal_required' });
});

test('retry after a partial install reuses registered marketplaces and updates the installed Claude plugin', async t => {
  const setup = await workspace(t);
  let failCodex = true;
  const h = harness({ reject: (host, args) => failCodex && host === 'codex' && args[1] === 'add' });
  const options = { ...setup, host: 'both', allowSource: false };
  await assert.rejects(initOnboarding(options, h.dependencies), /synthetic_host_failure/);
  assert.deepEqual(h.state().installation.hosts, ['claude']);
  assert.deepEqual(h.state().installation.pendingHosts, ['codex']);
  failCodex = false;
  h.calls.length = 0;
  await initOnboarding(options, h.dependencies);
  assert.equal(h.calls.some(call => call.args[1] === 'marketplace' && call.args[2] === 'add'), false);
  assert.equal(h.calls.some(call => call.host === 'claude' && call.args[1] === 'update'), true);
  assert.deepEqual(h.state().installation.hosts, ['claude', 'codex']);
  assert.equal(h.state().installation.pendingHosts, undefined);
});

test('a partial first installation resumes its remaining host on the next plain invocation', async t => {
  const setup = await workspace(t);
  let failCodex = true;
  const h = harness({ reject: (host, args) => failCodex && host === 'codex' && args[1] === 'add' });
  await assert.rejects(initOnboarding({ ...setup, host: 'both', allowSource: false }, h.dependencies), /synthetic_host_failure/);
  assert.deepEqual(h.state().installation, { hosts: ['claude'], version: '0.1.0', pendingHosts: ['codex'] });
  assert.equal(await needsOnboarding(setup, { readSettings: h.dependencies.settings.readSettings,
    version: h.dependencies.version, inspect: async () => ({ claude: true, codex: true }) }), true);
  failCodex = false;
  h.calls.length = 0;
  await initOnboarding(setup, h.dependencies);
  assert.deepEqual(h.state().installation, { hosts: ['claude', 'codex'], version: '0.1.0' });
  assert.equal(h.calls.some(call => call.host === 'claude' && call.args[0] === 'plugin'), false);
});

test('version upgrades include every recorded host and partial failure never claims a complete upgrade', async t => {
  const setup = await workspace(t);
  const oldRoot = path.join(setup.dataDir, 'plugins/graphlin/0.1.0');
  let failCodex = true;
  const h = harness({ state: { policy: metadata, installation: { hosts: ['claude', 'codex'], version: '0.1.0' } },
    marketplaces: { claude: path.join(oldRoot, 'claude'), codex: path.join(oldRoot, 'codex') },
    reject: (host, args) => failCodex && host === 'codex' && args[1] === 'add' });
  await h.dependencies.prepare(setup.dataDir, '0.1.0');
  const dependencies = { ...h.dependencies, version: async () => '0.2.0' };
  await assert.rejects(initOnboarding({ ...setup, host: 'claude', allowSource: false }, dependencies), /synthetic_host_failure/);
  assert.equal(h.state().installation.version, '0.1.0');
  assert.deepEqual(h.state().installation.hosts, ['claude'], 'Codex was removed for rebind and never reinstalled');
  assert.deepEqual(h.state().installation.pendingHosts, ['codex']);
  assert.equal(h.calls.some(call => call.host === 'claude' && call.args[2] === 'remove'), false);
  assert.equal(h.calls.some(call => call.host === 'codex' && call.args[2] === 'remove'), true);
  failCodex = false;
  await initOnboarding(setup, dependencies);
  assert.deepEqual(h.state().installation, { hosts: ['claude', 'codex'], version: '0.2.0' });
});

test('same-name unrelated marketplace is not replaced and malformed host output cannot imply success', async t => {
  const setup = await workspace(t), h = harness({ marketplaces: { claude: path.join(setup.base, 'unrelated') } });
  await assert.rejects(initOnboarding({ ...setup, host: 'claude', allowSource: false }, h.dependencies),
    { code: 'marketplace_conflict' });
  assert.equal(h.calls.some(call => call.args[2] === 'add' || call.args[2] === 'remove'), false);
  const invalid = harness();
  await assert.rejects(initOnboarding({ ...setup, host: 'codex', allowSource: false },
    { ...invalid.dependencies, run: async (_, args) => args.includes('list') ? 'not JSON' : undefined }),
  { code: 'host_metadata_invalid' });
  assert.deepEqual(invalid.state().installation, { hosts: [], version: '0.1.0', pendingHosts: ['codex'] });
});

test('a failed or cancelled install does not claim success for that host', async t => {
  const setup = await workspace(t), h = harness({ reject: (host, args) => host === 'codex' && args[1] === 'add' });
  await assert.rejects(initOnboarding({ ...setup, host: 'both', allowSource: false }, h.dependencies), /synthetic_host_failure/);
  assert.deepEqual(h.state().installation.hosts, ['claude']);
  assert.equal(h.output.join('').includes('Graphlin installed for codex'), false);
  const controller = new AbortController(), c = harness();
  controller.abort();
  await assert.rejects(initOnboarding({ ...setup, host: 'codex', allowSource: false, signal: controller.signal }, c.dependencies), { code: 'cancelled' });
  assert.equal(c.patches.length, 0);
});

test('partial uninstall preserves remaining host record, credential, history, and unrelated settings', async t => {
  const setup = await workspace(t), h = harness({ state: {
    apiKey: 'SYNTHETIC_SAVED', installation: { hosts: ['claude', 'codex'], version: '0.1.0' },
    policy: { ...metadata, allowSource: true },
  }, reject: host => host === 'codex' });
  await assert.rejects(uninstallOnboarding(setup, h.dependencies), /synthetic_host_failure/);
  assert.deepEqual(h.state().installation.hosts, ['codex']);
  assert.equal(h.state().apiKey, 'SYNTHETIC_SAVED');
  assert.deepEqual(h.calls[0].args, ['plugin', 'uninstall', 'graphlin@graphlin-local', '--scope', 'user', '--keep-data']);
  assert.match(h.output.join(''), /all projects/);
  assert.equal(h.output.join('').includes('SYNTHETIC_SAVED'), false);
});

test('successful uninstall resets only current consent and leaves saved key/history in place', async t => {
  const setup = await workspace(t), h = harness();
  await saveSettings(setup, { apiKey: 'SYNTHETIC_SAVED', policy: { ...metadata, allowSource: true, persistEvidence: true },
    installation: { hosts: ['codex'], version: '0.1.0' } });
  const paths = await projectPaths(setup.projectRoot, setup.dataDir);
  const history = path.join(paths.directory, 'synthetic-history');
  await writeFile(history, 'synthetic retained history');
  await uninstallOnboarding(setup, { ...h.dependencies, settings: { readSettings, saveSettings } });
  assert.deepEqual(await readSettings(setup), {
    apiKey: 'SYNTHETIC_SAVED', policy: metadata, installation: { hosts: [], version: '0.1.0' },
  });
  assert.equal(await readFile(history, 'utf8'), 'synthetic retained history');
});

test('explicit uninstall preserves other pending hosts and cancels verified absent pending plugins', async t => {
  const setup = await workspace(t);
  const h = harness({ state: { policy: metadata,
    installation: { hosts: ['claude'], version: '0.1.0', pendingHosts: ['codex'] } } });
  await uninstallOnboarding({ ...setup, host: 'claude' }, h.dependencies);
  assert.deepEqual(h.state().installation, { hosts: [], version: '0.1.0', pendingHosts: ['codex'] });
  h.calls.length = 0;
  const result = await uninstallOnboarding(setup, h.dependencies);
  assert.deepEqual(h.state().installation, { hosts: [], version: '0.1.0' });
  assert.deepEqual(result.cancelledPending, ['codex']);
  assert.deepEqual(result.removed, []);
  assert.equal(h.calls.some(call => call.args[1] === 'remove'), false);
});

test('bare command needs setup only when project consent or current installation is missing', async t => {
  const setup = await workspace(t);
  const version = await packageVersion();
  assert.equal(await needsOnboarding(setup), true);
  await saveSettings(setup, { policy: metadata, installation: { hosts: ['codex'], version } });
  assert.equal(await needsOnboarding(setup), true, 'missing installed packages need recovery');
  await preparePackages(setup.dataDir, version);
  assert.equal(await needsOnboarding(setup), false);
  await rm(path.join(setup.dataDir, 'plugins/graphlin', version, 'codex/graphlin/scripts/control.mjs'));
  assert.equal(await needsOnboarding(setup), true, 'deleted control entry point needs repair');
  await preparePackages(setup.dataDir, version);
  assert.equal(await needsOnboarding(setup), false);
  assert.equal(await needsOnboarding({ ...setup, host: 'claude' }), true);
  const other = path.join(setup.base, 'other project');
  await mkdir(other);
  assert.equal(await needsOnboarding({ ...setup, projectRoot: other }), true);
});

test('masked terminal input handles deletion and Ctrl+C without echoing secrets, restoring raw mode', async () => {
  function streams() {
    const input = new PassThrough(), output = new PassThrough();
    input.isTTY = true; output.isTTY = true; input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    let text = ''; output.on('data', chunk => { text += chunk; });
    return { input, output, text: () => text };
  }
  const first = streams();
  const answer = terminalPrompt('Masked: ', { ...first, secret: true });
  first.input.write('synthetix\x7fc\r');
  assert.equal(await answer, 'synthetic');
  assert.equal(first.input.isRaw, false);
  assert.equal(first.text().includes('syntheti'), false);
  assert.match(first.text(), /\*+/);
  const second = streams(), controller = new AbortController();
  const cancelled = terminalPrompt('Masked: ', { ...second, secret: true, signal: controller.signal });
  second.input.write('do-not-echo');
  controller.abort();
  await assert.rejects(cancelled, { code: 'cancelled' });
  assert.equal(second.input.isRaw, false);
  assert.equal(second.text().includes('do-not-echo'), false);
  const third = streams();
  const interrupt = terminalPrompt('Masked: ', { ...third, secret: true });
  third.input.write('\x03');
  await assert.rejects(interrupt, { code: 'cancelled' });
});

test('native subprocess argv are literal, secrets are stripped, and failure output stays private', async t => {
  const setup = await workspace(t), stubs = await stubHosts(setup);
  const literal = path.join(setup.base, "marketplace ' ; $(touch NEVER)");
  await runHost('codex', ['plugin', 'marketplace', 'add', literal],
    { cwd: setup.projectRoot, env: { ...stubs.env, TYPESAFE_API_KEY: 'SYNTHETIC_KEY' } });
  const [event] = await stubs.events();
  assert.equal(event.args[3], literal);
  assert.equal(event.keyInherited, false);
  const error = await runHost('codex', ['plugin', 'add', 'graphlin@graphlin-local'],
    { env: { ...stubs.env, STUB_FAIL: '1' } }).catch(error => error);
  assert.equal(error.code, 'host_failed');
  assert.match(error.message, /exit 7/);
  assert.equal(error.message.includes('PRIVATE_HOST_OUTPUT_SENTINEL'), false);
});

test('subprocess timeout and cancellation are bounded even if SIGTERM is ignored', async t => {
  const setup = await workspace(t), stubs = await stubHosts(setup);
  await assert.rejects(runHost('codex', ['plugin', 'add', 'graphlin@graphlin-local'],
    { env: { ...stubs.env, STUB_HANG: '1' }, timeout: 100 }), { code: 'host_timeout' });
  const controller = new AbortController();
  const pending = runHost('codex', ['plugin', 'add', 'graphlin@graphlin-local'],
    { env: { ...stubs.env, STUB_HANG: '1' }, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'cancelled' });
});

test('browser launcher accepts only a local viewer URL and never inherits the API key', async t => {
  const setup = await workspace(t), stubs = await stubHosts(setup);
  const url = 'http://127.0.0.1:34567/#token=synthetic';
  await openViewer(url, { platform: 'linux', env: { ...stubs.env, TYPESAFE_API_KEY: 'SYNTHETIC_KEY' } });
  assert.equal((await stubs.events())[0].keyInherited, false);
  await assert.rejects(openViewer('https://example.invalid/'), { code: 'invalid_viewer_url' });
});

test('real builder creates stable install packages and both marketplace files outside source checkout', async t => {
  const setup = await workspace(t), version = await packageVersion();
  const output = await preparePackages(setup.dataDir, version);
  assert.equal(output, path.join(setup.dataDir, 'plugins', 'graphlin', version));
  const claude = JSON.parse(await readFile(path.join(output, 'claude/.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(claude.name, 'graphlin-local');
  assert.equal(claude.plugins[0].source, './graphlin');
  const codex = JSON.parse(await readFile(path.join(output, 'codex/.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(codex.plugins[0].source.path, './graphlin');
  assert.equal(await preparePackages(setup.dataDir, version, { build: () => { throw new Error('must_not_rebuild'); } }), output);
  assert.equal((await stat(path.join(output, '.onboarding.json'))).mode & 0o777, 0o600);
  await rm(path.join(output, 'claude/.claude-plugin/marketplace.json'));
  await preparePackages(setup.dataDir, version);
  assert.equal(JSON.parse(await readFile(path.join(output, 'claude/.claude-plugin/marketplace.json'), 'utf8')).name, 'graphlin-local');
});

test('installer refuses symlink package destinations without writing through them', async t => {
  const setup = await workspace(t), version = await packageVersion();
  await mkdir(path.join(setup.dataDir, 'plugins'), { recursive: true });
  const unrelated = path.join(setup.base, 'unrelated package destination');
  await mkdir(unrelated);
  await symlink(unrelated, path.join(setup.dataDir, 'plugins/graphlin'));
  await assert.rejects(preparePackages(setup.dataDir, version), { code: 'unsafe_package_path' });
  await assert.rejects(stat(path.join(unrelated, version)), { code: 'ENOENT' });
});

test('non-TTY CLI offers actionable setup and explicit init/uninstall work entirely with temporary host stubs', async t => {
  const setup = await workspace(t), stubs = await stubHosts(setup);
  const args = ['--project', setup.projectRoot, '--data-dir', setup.dataDir];
  const fresh = await runCLI(process.execPath, [entry, ...args], { env: stubs.env });
  assert.equal(fresh.code, 1);
  assert.match(fresh.stderr, /--host claude\|codex\|both --no-source/);
  const unrelated = path.join(setup.base, 'unrelated-config');
  await writeFile(unrelated, 'unrelated plugin and host options');
  const installed = await runCLI(process.execPath, [entry, 'init', ...args, '--host', 'both', '--no-source'],
    { env: { ...stubs.env, TYPESAFE_API_KEY: 'DO_NOT_INHERIT' }, timeout: 25_000 });
  assert.equal(installed.code, 0, installed.stderr);
  assert.deepEqual(JSON.parse(installed.stdout).installed, ['claude', 'codex']);
  assert.equal(installed.stdout.includes('DO_NOT_INHERIT'), false);
  assert.equal((await stubs.events()).some(event => event.keyInherited), false);
  const child = spawn(process.execPath, [entry, ...args, '--no-open'], {
    env: stubs.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  const exited = new Promise(resolve => child.once('close', code => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      try { resolve(JSON.parse(stdout)); } catch { /* Wait for ready JSON. */ }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', () => reject(new Error(`Bare CLI exited before ready: ${stderr}`)));
  });
  const details = await ready;
  assert.equal(details.foreground, true);
  assert.equal(details.pid, child.pid, 'bare invocation owns the foreground viewer');
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  const removed = await runCLI(process.execPath, [entry, 'uninstall', ...args], { env: stubs.env });
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual((await readSettings(setup)).installation.hosts, []);
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated plugin and host options');
  const sourceInit = await runCLI(process.execPath,
    [entry, 'init', ...args, '--host', 'codex', '--allow-source'],
    { env: { ...stubs.env, TYPESAFE_API_KEY: 'SYNTHETIC_PERSISTED_KEY' } });
  assert.equal(sourceInit.code, 0, sourceInit.stderr);
  assert.equal((await readSettings(setup)).apiKey, 'SYNTHETIC_PERSISTED_KEY');
  assert.equal((await stubs.events()).some(event => event.keyInherited), false);
  assert.equal((sourceInit.stdout + sourceInit.stderr).includes('SYNTHETIC_PERSISTED_KEY'), false);
});

test('agent instructions quote paths for copying and disclose hook trust and custom data directory', () => {
  const text = agentInstructions({ projectRoot: "/tmp/synthetic 'project", dataDir: '/tmp/private data', hosts: ['codex'] });
  assert.match(text, /GRAPHLIN_DATA_DIR='\/tmp\/private data' codex/);
  assert.match(text, /'\"'\"'/);
  assert.match(text, /\/hooks/);
  assert.match(text, /does not verify hook activation/);
});

test('guided metadata consent cannot silently rejoin a running source-enabled viewer', async t => {
  const setup = await workspace(t), stubs = await stubHosts(setup);
  const args = ['--project', setup.projectRoot, '--data-dir', setup.dataDir];
  const env = { ...stubs.env, TYPESAFE_API_KEY: '' };
  const started = await runCLI(process.execPath, [entry, 'start', ...args, '--allow-source', '--background'], { env });
  assert.equal(started.code, 0, started.stderr);
  const previous = JSON.parse(started.stdout);
  const preload = path.join(setup.base, 'synthetic-terminal.mjs');
  await writeFile(preload, `
Object.defineProperty(process.stdin, 'isTTY', {value: true});
Object.defineProperty(process.stderr, 'isTTY', {value: true});
`);
  const guided = await runCLI(process.execPath,
    ['--import', preload, entry, ...args, '--host', 'claude', '--no-open'],
    { env, input: 'metadata\n' });
  assert.equal(guided.code, 1, guided.stderr);
  assert.match(guided.stderr, /policy_restart_required/);
  assert.equal(guided.stdout, '');
  assert.equal((await readSettings(setup)).policy.allowSource, false);
  const current = await daemonStatus(setup);
  assert.equal(current.instanceId, previous.instanceId);
  assert.equal(current.policy.transmitSource, true, 'the existing service still requires explicit stop/start');
});

test('bare CLI resumes a partial first install using saved consent without extra flags or prompts', async t => {
  const setup = await workspace(t), stubs = await stubHosts(setup);
  const args = ['--project', setup.projectRoot, '--data-dir', setup.dataDir];
  const failed = await runCLI(process.execPath, [entry, 'init', ...args, '--host', 'both', '--no-source'],
    { env: { ...stubs.env, STUB_FAIL_CODEX_ADD: '1' } });
  assert.equal(failed.code, 1);
  const first = await readSettings(setup);
  assert.deepEqual(first.installation.hosts, ['claude']);
  assert.deepEqual(first.installation.pendingHosts, ['codex']);
  const resumed = await runCLI(process.execPath, [entry, ...args, '--background', '--no-open'], { env: stubs.env });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).policy.transmitSource, false);
  const completed = await readSettings(setup);
  assert.deepEqual(completed.installation.hosts, ['claude', 'codex']);
  assert.equal(completed.installation.pendingHosts, undefined);
});
