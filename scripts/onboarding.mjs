import { spawn } from 'node:child_process';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { readFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackages } from './build-packages.mjs';
import { validatePackage } from './validate-packages.mjs';
import { projectPaths, canonicalProjectRoot, privateDirectory, atomicJSON, readPrivateJSON, uid } from '../runtime/daemon/paths.mjs';
import { prepareProjectState } from '../runtime/daemon/migration.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOSTS = ['claude', 'codex'];
const PLUGIN = 'graphlin@graphlin-local';
const defaults = { allowSource: false, persistEvidence: false, displayEvidence: true };
const settingsAPI = () => import('../runtime/daemon/settings.mjs');
const fail = (code, message) => Object.assign(new Error(message), { onboarding: true, code });
const cancelled = () => fail('cancelled', 'Setup cancelled. Any completed host changes remain recorded; run init again to continue.');
const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Host output is intentionally not relayed: it can contain unrelated local
// configuration. Errors report the attempted operation, never raw stderr.
export function runHost(command, args, { cwd, env = process.env, signal, timeout = 30_000, capture = false } = {}) {
  const childEnv = { ...env };
  delete childEnv.TYPESAFE_API_KEY;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const child = spawn(command, args, { cwd, env: childEnv, shell: false,
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let finished = false, timer, escalation, reason, output = '', bytes = 0;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      child.stdout?.destroy();
      if (error) reject(error); else resolve(capture ? output : undefined);
    };
    const stop = error => {
      if (reason || finished) return;
      reason = error;
      child.kill('SIGTERM');
      escalation = setTimeout(() => { child.kill('SIGKILL'); finish(reason); }, 300);
    };
    const abort = () => stop(cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(fail('host_timeout',
      `${command} did not finish. Check its plugin setup in a terminal, then retry Graphlin init or uninstall.`)), timeout);
    child.stdout?.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) stop(fail('host_output_limit', 'Host plugin metadata exceeded the safe limit. Review its marketplace configuration in your terminal.'));
      else output += chunk.toString('utf8');
    });
    child.stdout?.on('error', () => stop(fail('host_unavailable', 'Could not read host plugin metadata. Retry setup.')));
    child.once('error', () => finish(fail('host_unavailable',
      `Could not run ${command}. Install its CLI and make it available on PATH, then retry.`)));
    child.once('close', (code, childSignal) => finish(reason || (code === 0 ? undefined :
      fail('host_failed', `${HOSTS.includes(command) ? `${command} ${args.slice(0, 3).join(' ')}` : 'Launcher'} ${childSignal ? 'was interrupted' : `failed (exit ${code})`}. Review that host's plugin setup, then retry Graphlin init or uninstall.`))));
  });
}

export async function detectHosts({ run = runHost, ...context } = {}) {
  const result = await Promise.all(HOSTS.map(async host => {
    try { await run(host, ['--version'], { ...context, timeout: 1500 }); return host; }
    catch (error) { if (context.signal?.aborted) throw cancelled(); return null; }
  }));
  return result.filter(Boolean);
}

export function terminalPrompt(label, { secret = false, input = process.stdin, output = process.stderr, signal } = {}) {
  if (!input.isTTY || !output.isTTY) return Promise.reject(fail('terminal_required',
    'Run graphlin init in an interactive terminal. Keys are accepted only at its masked prompt or through TYPESAFE_API_KEY.'));
  if (signal?.aborted) return Promise.reject(cancelled());
  if (!secret) {
    return new Promise((resolve, reject) => {
      const reader = createInterface({ input, output, terminal: true });
      let answered = false;
      const abort = () => reader.close();
      signal?.addEventListener('abort', abort, { once: true });
      reader.once('SIGINT', abort);
      reader.once('close', () => {
        signal?.removeEventListener('abort', abort);
        if (!answered) reject(cancelled());
      });
      reader.question(label, answer => { answered = true; reader.close(); resolve(answer.trim()); });
    });
  }
  return new Promise((resolve, reject) => {
    let value = '', done = false;
    const wasRaw = input.isRaw, wasPaused = input.isPaused();
    const finish = error => {
      if (done) return;
      done = true;
      input.removeListener('keypress', keypress);
      input.removeListener('end', abort);
      signal?.removeEventListener('abort', abort);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      output.write('\n');
      if (error) { value = ''; reject(error); } else resolve(value);
    };
    const abort = () => finish(cancelled());
    const keypress = (text, key = {}) => {
      if (key.ctrl && ['c', 'd'].includes(key.name)) { abort(); return; }
      if (['return', 'enter'].includes(key.name)) { finish(); return; }
      if (key.name === 'backspace') {
        if (value) { value = value.slice(0, -1); output.write('\b \b'); }
        return;
      }
      if (!key.ctrl && !key.meta && text && /^[\x21-\x7e]+$/.test(text) && value.length + text.length <= 4096) {
        value += text; output.write('*'.repeat(text.length));
      }
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', keypress);
    input.once('end', abort);
    signal?.addEventListener('abort', abort, { once: true });
    output.write(label);
    input.resume();
  });
}

async function choose(label, choices, prompt) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = (await prompt(label)).toLowerCase();
    if (choices.includes(value)) return value;
  }
  throw fail('invalid_choice', `Choose ${choices.join(', ')}. Run graphlin init again.`);
}

export async function packageVersion() {
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw fail('invalid_version', 'Obtain a complete Graphlin distribution.');
  return version;
}

export async function preparePackages(dataDir, version, { build = buildPackages } = {}) {
  const outputDir = path.join(dataDir, 'plugins', 'graphlin', version);
  // The builder rejects symlink ancestors; use that same boundary before
  // reading a completion marker or creating the Claude marketplace.
  let current = path.parse(outputDir).root;
  for (const part of outputDir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw fail('unsafe_package_path', 'Use a private Graphlin data directory without symlinks.');
  }
  const marker = path.join(outputDir, '.onboarding.json');
  let complete;
  try { complete = await readPrivateJSON(marker, 1024); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (complete?.version === version) {
    try {
      for (const host of HOSTS) await validatePackage(path.join(outputDir, host, 'graphlin'));
      const claude = await readPrivateJSON(path.join(outputDir, 'claude/.claude-plugin/marketplace.json'), 4096);
      const codex = JSON.parse(await readFile(path.join(outputDir, 'codex/.agents/plugins/marketplace.json'), 'utf8'));
      if (claude.name === 'graphlin-local' && claude.plugins?.length === 1 &&
          claude.plugins[0].name === 'graphlin' && claude.plugins[0].source === './graphlin' &&
          codex.name === 'graphlin-local' && codex.plugins?.length === 1 &&
          codex.plugins[0].source?.path === './graphlin') return outputDir;
    } catch { /* The builder safely recovers missing or incomplete managed files. */ }
  }
  try {
    await privateDirectory(dataDir);
    await build({ outputDir });
    const marketplace = path.join(outputDir, 'claude', '.claude-plugin');
    await privateDirectory(marketplace);
    await atomicJSON(path.join(marketplace, 'marketplace.json'), {
      name: 'graphlin-local',
      owner: { name: 'Graphlin contributors' },
      plugins: [{ name: 'graphlin', source: './graphlin', version,
        description: 'Local architecture and activity viewer.' }],
    });
    await atomicJSON(marker, { version });
    return outputDir;
  } catch {
    throw fail('package_build_failed',
      'Could not prepare Graphlin plugins. Use the complete GitHub package: npx --yes --package=github:royosherove/graphlin graphlin init');
  }
}

async function hostList(host, kind, run, context) {
  const output = await run(host, ['plugin', ...(kind === 'marketplace' ? ['marketplace'] : []), 'list', '--json'],
    { ...context, capture: true });
  try {
    const value = JSON.parse(output);
    const list = host === 'claude' ? value : value[kind === 'marketplace' ? 'marketplaces' : 'installed'];
    if (!Array.isArray(list) || list.some(item => !item || typeof item !== 'object')) throw new Error();
    return list;
  } catch {
    throw fail('host_metadata_invalid', `Could not verify ${host} plugin metadata. Update its CLI and inspect plugin marketplace list --json before retrying.`);
  }
}

async function managedDirectories(directory, ownershipRoot) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_marketplace_directory');
    if ((current === ownershipRoot || current.startsWith(ownershipRoot + path.sep)) &&
        ((uid() !== undefined && info.uid !== uid()) || (info.mode & 0o022))) {
      throw new Error('unsafe_marketplace_owner');
    }
  }
}

async function managedText(filename, limit = 16 * 1024) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > limit || info.nlink !== 1 ||
        (info.mode & 0o022) || (uid() !== undefined && info.uid !== uid())) throw new Error('unsafe_marketplace_file');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('marketplace_file_too_large');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await file?.close(); }
}

// Host registrations are shared, but their Graphlin-owned packages may belong
// to another repo or the former home default. Read only generated metadata:
// a familiar marketplace name or directory layout alone is not ownership.
async function verifyManagedMarketplace(root, host, paths, saved, env) {
  const outputDir = path.dirname(root), version = path.basename(outputDir);
  const dataDir = path.dirname(path.dirname(path.dirname(outputDir)));
  const home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : homedir();
  const sameDataDir = dataDir === paths.dataDir;
  const repoLocal = !sameDataDir && path.basename(dataDir) === '.graphlin';
  const legacy = !sameDataDir && dataDir === path.resolve(home, '.local/state/graphlin');
  try {
    if (version.length > 80 || !/^\d+\.\d+\.\d+$/.test(version) ||
        root !== path.join(dataDir, 'plugins', 'graphlin', version, host) ||
        !(sameDataDir || repoLocal || legacy)) throw new Error('foreign_marketplace');
    const ownershipRoot = repoLocal ? path.dirname(dataDir) : legacy ? path.resolve(home) : dataDir;
    await managedDirectories(dataDir, ownershipRoot);
    if ((await lstat(dataDir)).mode & 0o077) throw new Error('unsafe_marketplace_data');
    if (repoLocal && await canonicalProjectRoot(path.dirname(dataDir)) !== path.dirname(dataDir)) {
      throw new Error('noncanonical_marketplace_project');
    }
    try {
      await managedDirectories(outputDir, ownershipRoot);
    } catch (error) {
      // Only this data directory's saved installation can authorize recovery
      // of a deleted version. Missing cross-repo markers never prove ownership.
      if (error.code === 'ENOENT' && sameDataDir &&
          saved.installation?.version === version && saved.installation.hosts?.includes(host)) return;
      throw error;
    }
    const completion = await readPrivateJSON(path.join(outputDir, '.onboarding.json'), 1024);
    if (completion?.version !== version) throw new Error('unmarked_marketplace');
    const catalogDirectory = path.join(root, host === 'claude' ? '.claude-plugin' : '.agents/plugins');
    await managedDirectories(catalogDirectory, ownershipRoot);
    const catalog = JSON.parse(await managedText(path.join(catalogDirectory, 'marketplace.json')));
    const source = catalog.plugins?.[0]?.source;
    if (catalog.name !== 'graphlin-local' || !Array.isArray(catalog.plugins) || catalog.plugins.length !== 1 ||
        catalog.plugins[0].name !== 'graphlin' ||
        (host === 'claude'
          ? source !== './graphlin' || catalog.owner?.name !== 'Graphlin contributors' || catalog.plugins[0].version !== version
          : source?.source !== 'local' || source.path !== './graphlin' || catalog.interface?.displayName !== 'Graphlin local')) {
      throw new Error('foreign_marketplace_catalog');
    }
    const plugin = path.join(root, 'graphlin');
    await managedDirectories(path.join(plugin, `.${host}-plugin`), ownershipRoot);
    if (await managedText(path.join(plugin, '.graphlin-package'), 64) !== host) throw new Error('foreign_package');
    for (const filename of ['plugin.json', `.${host}-plugin/plugin.json`]) {
      const manifest = JSON.parse(await managedText(path.join(plugin, filename)));
      if (manifest?.name !== 'graphlin' || manifest.version !== version) throw new Error('foreign_package_manifest');
    }
  } catch {
    throw fail('marketplace_conflict', 'The existing graphlin-local catalogue could not be verified as Graphlin-only. Inspect its host registration before retrying; no replacement was attempted.');
  }
}

async function registeredMarketplace(host, paths, saved, run, context) {
  const entries = (await hostList(host, 'marketplace', run, context)).filter(item => item.name === 'graphlin-local');
  if (entries.length > 1) throw fail('marketplace_conflict', 'Multiple graphlin-local marketplaces are configured. Resolve them in your host before retrying.');
  const entry = entries[0];
  if (entry) {
    const oldRoot = host === 'claude' && entry.source === 'directory' ? entry.path :
      host === 'codex' && entry.marketplaceSource?.sourceType === 'local' &&
        entry.marketplaceSource.source === entry.root ? entry.root : null;
    if (typeof oldRoot !== 'string' || oldRoot.length > 4096 || !path.isAbsolute(oldRoot) ||
        oldRoot !== path.resolve(oldRoot) || /[\u0000-\u001f\u007f-\u009f]/.test(oldRoot)) throw fail('marketplace_conflict',
      'graphlin-local is not a verified local marketplace. Inspect the host registration before retrying.');
    await verifyManagedMarketplace(oldRoot, host, paths, saved, context.env);
    return oldRoot;
  }
  return null;
}

async function configureMarketplace(host, outputDir, paths, saved, run, context, onRemoved) {
  const root = path.join(outputDir, host);
  // Package preparation can take time; re-read the host registration before
  // changing it instead of relying on the preflight's earlier source.
  const oldRoot = await registeredMarketplace(host, paths, saved, run, context);
  if (oldRoot) {
    if (oldRoot === root) return;
    if (host === 'codex') {
      await run(host, ['plugin', 'marketplace', 'remove', 'graphlin-local'], context);
      await onRemoved();
    }
  }
  // Claude replaces a verified same-name directory registration; Codex only
  // permits add after a different source has been removed. Both were probed
  // using isolated synthetic catalogues, not inferred from an error string.
  await run(host, ['plugin', 'marketplace', 'add', root], context);
  const registered = (await hostList(host, 'marketplace', run, context)).find(item => item.name === 'graphlin-local');
  const registeredRoot = host === 'claude' ? registered?.path : registered?.root;
  if (typeof registeredRoot !== 'string' || path.resolve(registeredRoot) !== root) throw fail('host_registration_failed',
    `The ${host} marketplace did not register the requested Graphlin package. Retry init --host both after inspecting the host configuration.`);
}

export function agentInstructions({ projectRoot, dataDir, hosts = HOSTS }) {
  // Printed commands are for a second terminal; execution always uses argv.
  const customDataDir = dataDir !== path.join(projectRoot, '.graphlin');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(projectRoot + dataDir)) {
    return `Start your chosen agent in the same project${customDataDir ? ' with GRAPHLIN_DATA_DIR set to the same data directory' : ''}. Review and trust Graphlin in the host; use /hooks in Codex.\n`;
  }
  return 'Keep Graphlin running. In a second terminal, start a new agent session:\n' +
    hosts.map(host => `  cd ${quote(projectRoot)} && ${customDataDir ? `GRAPHLIN_DATA_DIR=${quote(dataDir)} ` : ''}${host}\n` +
      (host === 'claude' ? '  Claude: accept the project trust prompt; use /plugin to confirm Graphlin is enabled.\n' :
        '  Codex: accept project trust, then use /hooks to review and trust Graphlin hooks.\n')).join('') +
    (customDataDir ? '' : 'Repo-local state uses .graphlin in this project. Unset GRAPHLIN_DATA_DIR in both terminals to use it.\n') +
    'Ask: “Orient yourself in this project and explain how its components connect.”\n' +
    'Installation does not verify hook activation. Use graphlin doctor and the viewer hook feed to diagnose missing events.\n';
}

export async function needsOnboarding(options, {
  readSettings, version = packageVersion, inspect, run = runHost, env = process.env,
} = {}) {
  readSettings ??= (await settingsAPI()).readSettings;
  const saved = await readSettings(options);
  if (!saved.policy || !saved.installation?.hosts?.length || saved.installation.pendingHosts?.length ||
    saved.installation.version !== await version() ||
    ((options.allowSource ?? saved.policy.allowSource) && !(env.TYPESAFE_API_KEY ?? saved.apiKey)) ||
    options.host !== undefined) return true;
  inspect ??= (await import('../runtime/daemon/connection-info.mjs')).inspectInstalledPackages;
  const paths = await projectPaths(options.projectRoot, options.dataDir);
  const packages = await inspect({ dataDir: paths.dataDir, version: saved.installation.version });
  if (saved.installation.hosts.some(host => !HOSTS.includes(host) || !packages[host])) return true;
  // Repo receipts survive a global host uninstall from another repo. Verify
  // the host's current installation; local packages alone cannot prove it.
  const installed = await Promise.all(saved.installation.hosts.map(async host => {
    try {
      const plugins = await hostList(host, 'plugin', run, {
        cwd: paths.projectRoot, env, signal: options.signal, timeout: 1500,
      });
      return plugins.some(plugin => host === 'claude'
        ? plugin.id === PLUGIN && plugin.scope === 'user' : plugin.pluginId === PLUGIN);
    } catch {
      if (options.signal?.aborted) throw cancelled();
      return false;
    }
  }));
  return installed.some(present => !present);
}

export async function initOnboarding(options, dependencies = {}) {
  const { readSettings, saveSettings } = dependencies.settings ?? await settingsAPI();
  const write = dependencies.write ?? (text => process.stderr.write(text));
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const prompt = dependencies.prompt ?? ((label, extra) => terminalPrompt(label, { ...extra, signal: options.signal }));
  const env = dependencies.env ?? process.env;
  const run = dependencies.run ?? runHost;
  const paths = await prepareProjectState(options);
  const saved = await readSettings(paths);
  const previousPending = saved.installation?.pendingHosts ?? [];
  const resuming = previousPending.length > 0 && options.host === undefined;
  if (options.replaceKey && !interactive) throw fail('terminal_required',
    'Replacing a key requires a terminal: run graphlin init --replace-key and enter it at the masked prompt.');
  if (!interactive && ((!options.host && !resuming) ||
      (options.allowSource === undefined && !(resuming && saved.policy)))) {
    throw fail('setup_required', 'Setup needs a terminal, or explicit options: graphlin init --host claude|codex|both --no-source (or --allow-source with a saved key or TYPESAFE_API_KEY).');
  }
  const detected = await detectHosts({ run, env, cwd: paths.projectRoot, signal: options.signal });
  write(`Detected host CLIs: ${detected.join(', ') || 'none'}.\n`);
  if (!detected.length) throw fail('missing_host', 'Install Claude Code or Codex CLI and add it to PATH, then run graphlin init again.');
  const selected = options.host ?? (resuming ? null : detected.length === 1 ? detected[0] :
    await choose('Install for claude, codex, or both? ', ['claude', 'codex', 'both'], prompt));
  const version = await (dependencies.version ?? packageVersion)();
  const upgrading = Boolean((saved.installation?.hosts?.length || previousPending.length) && saved.installation.version !== version);
  const hosts = [...new Set([...(selected === 'both' ? HOSTS : selected ? [selected] : []),
    ...previousPending, ...(upgrading ? saved.installation.hosts : [])])];
  if (hosts.some(host => !detected.includes(host))) throw fail('missing_host',
    'A selected host CLI is unavailable. Install it and add it to PATH, then run graphlin init again.');
  write(paths.dataDir === path.join(paths.projectRoot, '.graphlin')
    ? 'Graphlin keeps state, settings, saved keys, and plugin packages in this repo’s .graphlin directory.\n'
    : 'Graphlin keeps state, settings, saved keys, and plugin packages in your selected data directory.\n');
  write('Your host manages plugin registrations and caches across projects. Source consent applies only to this canonical project.\n');
  write(`Project: ${JSON.stringify(paths.projectRoot)}\n`);
  if (upgrading) write('Updating every recorded Graphlin host to keep the installed version consistent.\n');
  let allowSource = options.allowSource ?? (resuming ? saved.policy?.allowSource : undefined);
  let localSource = options.localSource === true ||
    (resuming && options.allowSource === undefined && saved.policy?.localSource === true);
  if (allowSource === undefined) {
    write('Source mode sends locally filtered source excerpts and public messages to the decision provider (Jev by default). Local mode parses code on this machine without sending it. Metadata mode reads no source content. Local and metadata need no key.\n');
    const mode = await choose('For this project, choose source, local, or metadata: ', ['source', 'local', 'metadata'], prompt);
    allowSource = mode === 'source';
    localSource = mode === 'local';
  }
  const policy = { ...defaults, ...saved.policy, allowSource,
    persistEvidence: options.persistEvidence ?? saved.policy?.persistEvidence ?? false,
    displayEvidence: options.displayEvidence ?? saved.policy?.displayEvidence ?? true };
  if (localSource && !allowSource) policy.localSource = true;
  else delete policy.localSource;
  // Explicit setup plus source consent authorizes saving the supplied key so
  // later launches do not depend on this terminal's environment.
  let apiKey = allowSource && env.TYPESAFE_API_KEY ? env.TYPESAFE_API_KEY : undefined;
  if (allowSource && env.TYPESAFE_API_KEY === '' && !options.replaceKey) throw fail('empty_environment_key',
    'TYPESAFE_API_KEY is set but empty. Unset it to use a saved key or the masked prompt, or choose --no-source.');
  if (options.replaceKey || allowSource && !(env.TYPESAFE_API_KEY ?? saved.apiKey)) {
    if (!interactive) throw fail('key_required',
      'Source mode needs a key. Run graphlin init in a terminal for the masked prompt, provide TYPESAFE_API_KEY through your environment, or choose --no-source.');
    apiKey = await prompt('TypeSafe API key (masked; saved in this Graphlin data directory): ', { secret: true });
    if (!apiKey) throw fail('key_required', 'No key was supplied. Run init again or choose --no-source.');
    if (env.TYPESAFE_API_KEY !== undefined) write('The environment key still takes precedence. Unset TYPESAFE_API_KEY to use the newly saved key.\n');
  }
  if (options.signal?.aborted) throw cancelled();
  const context = { cwd: paths.projectRoot, env, signal: options.signal };
  // Verify registrations before preparing packages: a rebuild must not turn
  // a foreign catalogue at the desired destination into apparent ownership.
  for (const host of hosts) {
    await registeredMarketplace(host, paths, saved, run, context);
  }
  // Protect repo-local output before preparing packages or saving credentials.
  await projectPaths(paths.projectRoot, paths.dataDir, { create: true });
  const outputDir = await (dependencies.prepare ?? preparePackages)(paths.dataDir, version);
  if (options.signal?.aborted) throw cancelled();
  const installed = new Set(saved.installation?.hosts ?? []);
  const pending = new Set(hosts);
  const installation = () => ({ hosts: [...installed],
    version: pending.size ? saved.installation?.version ?? version : version,
    ...(pending.size ? { pendingHosts: [...pending] } : {}) });
  await saveSettings(paths, { policy, ...(apiKey ? { apiKey } : {}), installation: installation() });
  apiKey = undefined;
  for (const host of hosts) {
    write(`Installing Graphlin for ${host}…\n`);
    await configureMarketplace(host, outputDir, paths, saved, run, context, async () => {
      installed.delete(host);
      await saveSettings(paths, { installation: installation() });
      write(`Rebinding Codex's Graphlin marketplace. An interrupted installation resumes on the next bare graphlin run.\n`);
    });
    const plugins = host === 'claude' ? await hostList(host, 'plugin', run, context) : [];
    const alreadyInstalled = plugins.some(plugin => plugin.id === PLUGIN && plugin.scope === 'user');
    await run(host, ['plugin', host === 'claude' ? alreadyInstalled ? 'update' : 'install' : 'add', PLUGIN,
      ...(host === 'claude' ? ['--scope', 'user'] : [])], context);
    installed.add(host);
    pending.delete(host);
    await saveSettings(paths, { installation: installation() });
    write(`Graphlin installed for ${host}.\n`);
  }
  write(agentInstructions({ ...paths, hosts }));
  return { installed: hosts, version, policy };
}

export async function uninstallOnboarding(options, dependencies = {}) {
  const { readSettings, saveSettings } = dependencies.settings ?? await settingsAPI();
  const write = dependencies.write ?? (text => process.stderr.write(text));
  const run = dependencies.run ?? runHost;
  const paths = await projectPaths(options.projectRoot, options.dataDir);
  const saved = await readSettings(paths);
  const installed = new Set(saved.installation?.hosts ?? []);
  const pending = new Set(saved.installation?.pendingHosts ?? []);
  const hosts = options.host === 'both' ? HOSTS : options.host ? [options.host] : [...new Set([...installed, ...pending])];
  const removed = [], cancelledPending = [];
  const record = async () => saveSettings(paths, { installation: { hosts: [...installed],
    version: saved.installation?.version ?? await (dependencies.version ?? packageVersion)(),
    ...(pending.size ? { pendingHosts: [...pending] } : {}) } });
  write('Uninstall removes the selected Graphlin host plugin for all projects. Saved keys, history, plugin packages, and marketplace registrations are kept.\n');
  if (!hosts.length) write('No Graphlin hosts are recorded. If installed manually, select --host claude, codex, or both.\n');
  for (const host of hosts) {
    const context = { cwd: paths.projectRoot, env: dependencies.env ?? process.env, signal: options.signal };
    if (pending.has(host) && !installed.has(host)) {
      const plugins = await hostList(host, 'plugin', run, context);
      if (!plugins.some(plugin => host === 'claude' ? plugin.id === PLUGIN && plugin.scope === 'user' : plugin.pluginId === PLUGIN)) {
        pending.delete(host);
        cancelledPending.push(host);
        await record();
        write(`Cancelled pending installation for ${host}; its CLI reported no installed Graphlin plugin.\n`);
        continue;
      }
    }
    await run(host, ['plugin', host === 'claude' ? 'uninstall' : 'remove', PLUGIN,
      ...(host === 'claude' ? ['--scope', 'user', '--keep-data'] : [])],
    context);
    installed.delete(host);
    pending.delete(host);
    removed.push(host);
    await record();
    write(`Graphlin removed from ${host}.\n`);
  }
  await saveSettings(paths, { policy: { ...defaults, ...saved.policy, allowSource: false,
    ...(saved.policy?.localSource ? { localSource: false } : {}), persistEvidence: false } });
  write('Source and evidence-persistence consent reset for this project. A running viewer keeps its current policy until stopped; use graphlin stop.\n');
  return { removed, ...(cancelledPending.length ? { cancelledPending } : {}), retainedData: true };
}

export async function openViewer(url, { run = runHost, platform = process.platform, ...options } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw fail('invalid_viewer_url', 'The viewer returned an invalid local URL.');
  }
  await run(platform === 'darwin' ? 'open' : 'xdg-open', [url], { ...options, timeout: 3000 });
}
