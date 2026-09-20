import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArguments } from '../../scripts/arguments.mjs';
import { initOnboarding, needsOnboarding } from '../../scripts/onboarding.mjs';
import { readSettings, saveSettings, savedPolicy, resolvePolicy } from '../../runtime/daemon/settings.mjs';
import { collect } from '../../runtime/collector/index.mjs';
import { authenticate, workspace } from './helpers.mjs';

const metadata = { allowSource: false, persistEvidence: false, displayEvidence: true };
const local = { ...metadata, localSource: true };
const remote = { ...metadata, allowSource: true };
const entry = fileURLToPath(new URL('../../scripts/graphlin.mjs', import.meta.url));

test('--local-source grants local reading separately from remote consent and preserves other options', () => {
  for (const prefix of [[], ['start'], ['init']]) {
    const parsed = parseArguments([...prefix, '--local-source', '--persist-evidence', '--no-display-evidence']);
    assert.equal(parsed.localSource, true);
    assert.equal(parsed.allowSource, false);
    assert.equal(parsed.persistEvidence, true);
    assert.equal(parsed.displayEvidence, false);
    assert.equal(parsed.guided, prefix.length === 0);
  }
  assert.equal(parseArguments(['start']).localSource, undefined);
  assert.equal(parseArguments(['start']).allowSource, undefined, 'omission can reuse saved consent');
});

test('source modes are mutually exclusive in both flag orders and repeated local consent is rejected', () => {
  for (const command of ['start', 'init']) {
    for (const alternative of ['--allow-source', '--no-source']) {
      for (const flags of [['--local-source', alternative], [alternative, '--local-source']]) {
        assert.throws(() => parseArguments([command, ...flags]), /conflicting_arguments/);
      }
    }
  }
  assert.throws(() => parseArguments(['start', '--local-source', '--local-source']), /duplicate_argument/);
});

test('passive worker arguments accept explicit local reading but never default to it', () => {
  const defaults = parseArguments([], { worker: true });
  assert.equal(defaults.localSource, undefined);
  assert.equal(defaults.allowSource, false);
  assert.deepEqual(parseArguments(['--local-source'], { worker: true }), { ...defaults, localSource: true });
  for (const flags of [['--local-source', '--allow-source'], ['--allow-source', '--local-source']]) {
    assert.throws(() => parseArguments(flags, { worker: true }), /conflicting_arguments/);
  }
});

test('local consent round-trips through project settings without authorizing another project', async t => {
  const setup = await workspace(t);
  const consent = { ...local, persistEvidence: true, displayEvidence: false };
  await saveSettings(setup, { policy: consent });
  assert.deepEqual((await readSettings(setup)).policy, consent);
  assert.deepEqual(resolvePolicy(parseArguments(['start']), { saved: (await readSettings(setup)).policy }), consent);
  const otherProject = path.join(setup.base, 'another synthetic project');
  await mkdir(otherProject);
  assert.equal((await readSettings({ ...setup, projectRoot: otherProject })).policy, undefined);
  for (const invalid of [{ ...consent, allowSource: true }, { ...consent, localSource: 'true' }]) {
    await assert.rejects(saveSettings(setup, { policy: invalid }), { code: 'invalid_settings' });
  }
  assert.deepEqual((await readSettings(setup)).policy, consent, 'invalid updates leave valid consent intact');
  await saveSettings(setup, { policy: { ...consent, localSource: false } });
  assert.equal((await readSettings(setup)).policy.localSource, false);
});

test('explicit CLI source choices override saved local or remote consent without changing evidence options', () => {
  const saved = { ...local, persistEvidence: true, displayEvidence: false };
  const evidence = { persistEvidence: true, displayEvidence: false };
  assert.deepEqual(resolvePolicy({}, { saved }), saved);
  assert.deepEqual(resolvePolicy(parseArguments(['start', '--no-source']), { saved }),
    { allowSource: false, ...evidence });
  assert.deepEqual(resolvePolicy({ localSource: false }, { saved }), { allowSource: false, ...evidence });
  assert.deepEqual(resolvePolicy(parseArguments(['start', '--allow-source']), { saved }),
    { allowSource: true, ...evidence });
  assert.deepEqual(resolvePolicy(parseArguments(['start', '--local-source']), { saved: remote }), local);
  assert.deepEqual(resolvePolicy({}, { saved: metadata }), metadata, 'metadata consent does not upgrade to local');
  assert.deepEqual(resolvePolicy({}), metadata);
});

test('running local policy maps back to saved consent and takes precedence over older saved settings', () => {
  const current = { readSource: true, transmitSource: false, persistEvidence: true, displayEvidence: false };
  const consent = { ...local, persistEvidence: true, displayEvidence: false };
  assert.deepEqual(savedPolicy(current), consent);
  assert.deepEqual(resolvePolicy({}, { current, saved: remote }), consent);
  assert.deepEqual(resolvePolicy({ allowSource: false }, { current, saved: remote }),
    { ...metadata, persistEvidence: true, displayEvidence: false });
  assert.deepEqual(resolvePolicy({}, { current: { ...current, readSource: false }, saved: local }),
    { ...metadata, persistEvidence: true, displayEvidence: false });
  assert.equal(savedPolicy({ ...current, transmitSource: true }).localSource, undefined);
});

// Only synthetic Codex metadata is modeled here; no host CLI or package build runs.
function onboardingFixture() {
  let registered, failInstall = false;
  const calls = [], output = [];
  return {
    calls, output,
    failInstall: value => { failInstall = value; },
    dependencies: {
      interactive: false, env: {}, version: async () => '0.2.0',
      prompt: async () => assert.fail('Local mode must not request a key or repeat saved consent'),
      write: value => output.push(value),
      prepare: async (dataDir, version) => {
        const root = path.join(dataDir, 'plugins', 'graphlin', version);
        const catalog = path.join(root, 'codex', '.agents', 'plugins');
        await mkdir(catalog, { recursive: true });
        await writeFile(path.join(catalog, 'marketplace.json'), JSON.stringify({
          name: 'graphlin-local',
          plugins: [{ name: 'graphlin', source: { source: 'local', path: './graphlin' } }],
        }));
        return root;
      },
      run: async (host, args) => {
        calls.push({ host, args });
        if (host !== 'codex') throw new Error('synthetic_host_unavailable');
        if (args[0] === '--version') return 'synthetic codex';
        if (args[1] === 'marketplace') {
          if (args[2] === 'list') return JSON.stringify({ marketplaces: registered ? [{
            name: 'graphlin-local', root: registered,
            marketplaceSource: { sourceType: 'local', source: registered },
          }] : [] });
          if (args[2] === 'add') { registered = args[3]; return; }
        }
        if (args[1] === 'add') {
          if (failInstall) throw new Error('synthetic_install_interrupted');
          return;
        }
        assert.fail(`Unexpected synthetic host operation: ${JSON.stringify(args)}`);
      },
    },
  };
}

test('guided onboarding saves local consent without requesting a key', async t => {
  const setup = await workspace(t), fixture = onboardingFixture(), prompts = [];
  const result = await initOnboarding({ ...setup, host: 'codex' }, {
    ...fixture.dependencies, interactive: true,
    prompt: async (label, options) => {
      prompts.push(label);
      assert.equal(options?.secret, undefined);
      return 'local';
    },
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /source, local, or metadata/);
  assert.deepEqual(result.policy, local);
  const saved = await readSettings(setup);
  assert.deepEqual(saved.policy, local);
  assert.equal(saved.apiKey, undefined);
  assert.equal(await needsOnboarding(setup, {
    version: fixture.dependencies.version, inspect: async () => ({ codex: true }),
  }), false, 'a completed local installation needs no key');
});

test('noninteractive --local-source consent survives interrupted onboarding and resumes without a key', async t => {
  const setup = await workspace(t), fixture = onboardingFixture();
  const options = { ...parseArguments(['init', '--host', 'codex', '--local-source']), ...setup };
  fixture.failInstall(true);
  await assert.rejects(initOnboarding(options, fixture.dependencies), /synthetic_install_interrupted/);
  const pending = await readSettings(setup);
  assert.deepEqual(pending.policy, local);
  assert.deepEqual(pending.installation.pendingHosts, ['codex']);
  assert.equal(pending.apiKey, undefined);
  fixture.failInstall(false);
  const result = await initOnboarding(setup, fixture.dependencies);
  assert.deepEqual(result.policy, local);
  const saved = await readSettings(setup);
  assert.deepEqual(saved.policy, local);
  assert.deepEqual(saved.installation.hosts, ['codex']);
  assert.equal(saved.installation.pendingHosts, undefined);
  assert.equal(saved.apiKey, undefined);
});

async function bounded(promise, timeout = 8000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('local_mode_cli_timeout')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

test('foreground CLI parses synthetic source in local mode with zero outbound HTTP and provider calls', async t => {
  const setup = await workspace(t);
  await writeFile(path.join(setup.projectRoot, 'local-example.js'), 'export function localExample() { return 42; }\n');
  const outbound = path.join(setup.base, 'outbound-attempts.txt');
  const preload = path.join(setup.base, 'deny-outbound-http.mjs');
  await writeFile(outbound, '');
  await writeFile(preload, `
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  appendFileSync(${JSON.stringify(outbound)}, 'outbound-attempt\\n');
  throw new Error('outbound_http_forbidden_in_local_mode_test');
};
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
syncBuiltinESMExports();
`);
  const child = spawn(process.execPath, ['--import', preload, entry, 'start',
    '--project', setup.projectRoot, '--data-dir', setup.dataDir, '--local-source', '--no-open'], {
    env: { PATH: path.dirname(process.execPath), HOME: setup.base,
      TYPESAFE_API_KEY: 'SYNTHETIC_UNUSED_LOCAL_MODE_KEY' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
    try { await bounded(exited, 3000); }
    catch { child.kill('SIGKILL'); await bounded(exited, 2000); }
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 65536) { child.kill('SIGKILL'); reject(new Error('unexpected_stdout')); return; }
      try { resolve(JSON.parse(stdout)); } catch { /* Wait for the complete ready announcement. */ }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', () => reject(new Error(`local_mode_exited_before_ready: ${stderr}`)));
  });
  const details = await bounded(ready);
  assert.equal(details.foreground, true);
  assert.equal(details.pid, child.pid);
  assert.equal(details.policy.readSource, true);
  assert.equal(details.policy.transmitSource, false);
  assert.equal(details.status.calls, 0);
  assert.equal(await collect({
    cwd: setup.projectRoot, session_id: 'synthetic-local-cli', hook_event_name: 'SessionStart',
  }, { dataDir: setup.dataDir, host: 'claude' }), true);
  const { origin, cookie } = await authenticate(details);
  const read = async route => {
    const response = await fetch(`${origin}${route}`, {
      headers: { Origin: origin, Cookie: cookie }, signal: AbortSignal.timeout(1500),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  let symbol;
  const deadline = Date.now() + 5000;
  do {
    const snapshot = await read('/api/model/v1/snapshot');
    symbol = snapshot.entities.find(entity => entity.label === 'localExample' && entity.basis === 'parsed');
    if (!symbol) await delay(30);
  } while (!symbol && Date.now() < deadline);
  assert.ok(symbol, 'local consent must produce a real parsed declaration through the CLI');
  assert.equal((await read('/api/state')).status.calls, 0);
  child.kill('SIGINT');
  assert.deepEqual(await bounded(exited, 4000), { code: 0, signal: null });
  assert.equal(stderr, '');
  assert.equal(await readFile(outbound, 'utf8'), '', 'no provider HTTP request was attempted');
});
