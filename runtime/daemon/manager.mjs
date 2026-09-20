import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { projectPaths, defaultDataDir, MAX_STATE_BYTES, runtimeError, readPrivateJSON } from './paths.mjs';
import { health } from './lock.mjs';
import { requestIPC } from './ipc.mjs';
import { diagnosticArtifactId, readPersistedDiagnostics, DIAGNOSTIC_LIMITS } from './diagnostics.mjs';
import { readSettings, resolvePolicy } from './settings.mjs';
import { inspectInstalledPackages } from './connection-info.mjs';

const worker = fileURLToPath(new URL('../../scripts/daemon.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCodes = new Set(['already_running', 'daemon_busy', 'invalid_project', 'unsupported_platform',
  'unsafe_data_directory', 'policy_restart_required', 'port_restart_required', 'port_in_use',
  'daemon_start_failed', 'daemon_start_timeout', 'shutdown_failed', 'shutdown_pending',
  'restart_required', 'diagnostics_unavailable', 'invalid_log_filter', 'unsafe_settings', 'invalid_settings', 'settings_busy']);

export function publicError(error) {
  return safeCodes.has(error?.code) ? error.code : 'runtime_unavailable';
}

export async function daemonStatus({ projectRoot, dataDir } = {}) {
  let paths;
  try {
    paths = await projectPaths(projectRoot, dataDir);
    return { running: true, logPath: path.join(paths.directory, 'diagnostics.jsonl'), ...await health(paths) };
  } catch { return { running: false, code: 'not_running',
    ...(paths ? { logPath: path.join(paths.directory, 'diagnostics.jsonl') } : {}) }; }
}

function validateRuntime() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw runtimeError('unsupported_runtime');
}

function validateExisting(current, options) {
  const { allowSource, persistEvidence, displayEvidence } = resolvePolicy(options, { current: current.policy });
  const { mode = 'live', port = 0 } = options;
  if (current.mode !== mode || current.policy.transmitSource !== Boolean(allowSource) ||
      current.policy.persistEvidence !== Boolean(persistEvidence) ||
      current.policy.displayEvidence !== Boolean(displayEvidence)) throw runtimeError('policy_restart_required');
  if (port && port !== current.port) throw runtimeError('port_restart_required');
}

async function existingLaunch(paths, current, options) {
  validateExisting(current, options);
  const launch = await requestIPC(paths.socket, { op: 'launch', instanceId: current.instanceId });
  if (!launch.ok || launch.instanceId !== current.instanceId) throw runtimeError('daemon_start_failed');
  return { ...launch, reused: true };
}

async function waitForExisting(paths, options, signal) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !signal?.aborted) {
    const current = await daemonStatus(paths);
    if (current.running) return existingLaunch(paths, current, options);
    await delay(80);
  }
  if (!signal?.aborted) throw runtimeError('daemon_busy');
  return null;
}

async function ownerMatches(paths, instanceId) {
  const owner = await readPrivateJSON(path.join(paths.lock, 'owner.json'), 4096).catch(() => null);
  if (owner?.instanceId !== instanceId) return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function stopInstance(paths, instanceId) {
  if (!await ownerMatches(paths, instanceId)) return { ok: true, stopped: false };
  try {
    const result = await requestIPC(paths.socket, { op: 'shutdown', instanceId });
    if (!result.ok) return { ok: false, code: 'shutdown_pending' };
  } catch {
    if (!await ownerMatches(paths, instanceId)) return { ok: true, stopped: true };
    return { ok: false, code: 'shutdown_pending' };
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await ownerMatches(paths, instanceId)) return { ok: true, stopped: true };
    await delay(50);
  }
  return { ok: false, code: 'shutdown_pending' };
}

/**
 * Own a server in this process, or attach to the existing canonical instance.
 * onReady receives the one-use URL once; this promise stays pending until that
 * instance closes or the caller aborts. Abort never stops a replacement owner.
 */
export async function runForeground({ projectRoot, dataDir = defaultDataDir(), signal,
  allowSource, persistEvidence, displayEvidence, mode = 'live', port = 0 } = {}, onReady = () => {}) {
  validateRuntime();
  if (signal?.aborted) return;
  const paths = await projectPaths(projectRoot, dataDir);
  const options = { allowSource, persistEvidence, displayEvidence, mode, port };
  let server, launch, interrupted;
  const interruption = new Promise(resolve => { interrupted = resolve; });
  const interrupt = () => interrupted();
  signal?.addEventListener('abort', interrupt, { once: true });
  try {
    const current = await daemonStatus(paths);
    if (current.running) launch = await existingLaunch(paths, current, options);
    else if (!signal?.aborted) {
      const settings = mode === 'demo' ? {} : await readSettings(paths);
      const policy = resolvePolicy(options, { saved: settings.policy });
      await projectPaths(projectRoot, dataDir, { create: true });
      const { startServer } = await import('./server.mjs');
      const demo = mode === 'demo' ? await import('./demo.mjs') : null;
      try {
        server = await startServer({ projectRoot: paths.projectRoot, dataDir: paths.dataDir, mode, port,
          policy: { transmitSource: policy.allowSource, persistEvidence: policy.persistEvidence,
            displayEvidence: policy.displayEvidence },
          apiKey: policy.allowSource ? process.env.TYPESAFE_API_KEY ?? settings.apiKey : undefined,
          decisionService: demo?.demoDecisionService() });
      } catch (error) {
        if (['daemon_busy', 'already_running'].includes(error.code)) launch = await waitForExisting(paths, options, signal);
        else if (error.code === 'EADDRINUSE') throw runtimeError('port_in_use');
        else throw error;
      }
      if (server && !signal?.aborted) {
        launch = { ...await health(paths), url: server.url, reused: false };
        if (demo) {
          const replay = demo.replayDemo(server.pipeline, paths.projectRoot);
          await Promise.race([replay, interruption]);
          // Closing the pipeline cancels work; observe the replay's eventual
          // rejection if a signal interrupted it before the ready announcement.
          replay.catch(() => {});
        }
      }
    }
    if (!launch || signal?.aborted) return;
    onReady({ ...launch, foreground: true });
    if (server) {
      const closed = await Promise.race([server.whenClosed, interruption]);
      if (closed && !closed.ok) throw runtimeError('shutdown_failed');
    } else {
      while (!signal?.aborted && await ownerMatches(paths, launch.instanceId)) {
        // Each poll settles independently; racing the same pending signal
        // promise here would retain one callback per poll until interruption.
        await delay(200);
      }
      if (signal?.aborted) {
        const stopped = await stopInstance(paths, launch.instanceId);
        if (!stopped.ok) throw runtimeError(stopped.code);
      }
    }
  } finally {
    signal?.removeEventListener('abort', interrupt);
    await server?.close();
  }
}

// Detached operation is reserved for an explicit CLI --background request or
// MCP. The normal interactive CLI uses runForeground instead.
export async function startDaemon({ projectRoot, dataDir = defaultDataDir(), background = true,
  allowSource, persistEvidence, displayEvidence, mode = 'live', port = 0 } = {}) {
  validateRuntime();
  if (background !== true) throw runtimeError('background_required');
  const paths = await projectPaths(projectRoot, dataDir);
  const options = { allowSource, persistEvidence, displayEvidence, mode, port };
  const existing = await daemonStatus({ projectRoot: paths.projectRoot, dataDir: paths.dataDir });
  if (existing.running) return { ...await existingLaunch(paths, existing, options), foreground: false };
  const settings = mode === 'demo' ? {} : await readSettings(paths);
  const policy = resolvePolicy(options, { saved: settings.policy });
  await projectPaths(projectRoot, dataDir, { create: true });
  const args = [worker, '--project', paths.projectRoot, '--data-dir', paths.dataDir, '--mode', mode, '--port', String(port)];
  if (policy.allowSource) args.push('--allow-source');
  if (policy.persistEvidence) args.push('--persist-evidence');
  if (!policy.displayEvidence) args.push('--no-display-evidence');
  const env = { ...process.env };
  // A metadata-only or fixture daemon does not inherit the paid-service key.
  if (!policy.allowSource || mode !== 'live') delete env.TYPESAFE_API_KEY;
  else if (env.TYPESAFE_API_KEY === undefined && settings.apiKey) env.TYPESAFE_API_KEY = settings.apiKey;
  const child = spawn(process.execPath, args, {
    detached: true, stdio: 'ignore', env, cwd: paths.projectRoot,
  });
  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const current = await daemonStatus({ projectRoot: paths.projectRoot, dataDir: paths.dataDir });
    if (current.running) return { ...await existingLaunch(paths, current, options),
      reused: current.pid !== child.pid, foreground: false };
    if (spawnFailed) throw runtimeError('daemon_start_failed');
    if (child.exitCode !== null || child.signalCode !== null) {
      // Another concurrent starter may have won the lock. Wait for that owner
      // to finish starting rather than launching a second server or failing it.
      const owner = await readPrivateJSON(path.join(paths.lock, 'owner.json'), 4096).catch(() => null);
      if (!owner || owner.pid === child.pid) throw runtimeError('daemon_start_failed');
    }
    await delay(80);
  }
  child.kill('SIGTERM');
  const escalation = setTimeout(() => { child.kill('SIGKILL'); }, 250);
  child.once('exit', () => clearTimeout(escalation));
  throw runtimeError('daemon_start_timeout');
}

export async function stopDaemon({ projectRoot, dataDir } = {}) {
  const paths = await projectPaths(projectRoot, dataDir);
  const current = await daemonStatus({ projectRoot, dataDir });
  if (!current.running) return { ok: true, stopped: false };
  return stopInstance(paths, current.instanceId);
}

export async function exportDaemon({ projectRoot, dataDir } = {}) {
  const paths = await projectPaths(projectRoot, dataDir);
  const current = await health(paths);
  const response = await requestIPC(paths.socket, { op: 'export', instanceId: current.instanceId },
    { maxResponseBytes: MAX_STATE_BYTES + 4096 });
  if (!response.ok) throw runtimeError('export_unavailable');
  return response.snapshot;
}

export async function diagnosticLogs({ projectRoot, dataDir, file } = {}) {
  const paths = await projectPaths(projectRoot, dataDir);
  const artifactId = file === undefined ? undefined : diagnosticArtifactId(paths.projectRoot, file, projectRoot);
  let current;
  try { current = await health(paths); } catch { /* A stopped project can read its private retained log. */ }
  if (!current) return readPersistedDiagnostics(paths, { artifactId });
  const response = await requestIPC(paths.socket, { op: 'diagnostics', instanceId: current.instanceId, artifactId },
    { maxResponseBytes: DIAGNOSTIC_LIMITS.ringBytes + 64 * 1024, timeoutMs: 1500 });
  if (!response.ok) throw runtimeError(response.code === 'invalid_operation' ? 'restart_required' : 'diagnostics_unavailable');
  if (response.schemaVersion !== 1 || !Array.isArray(response.records) || !response.stats) {
    throw runtimeError('restart_required');
  }
  const { ok, ...envelope } = response;
  return envelope;
}

async function version(command) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
    let stdout = '', bytes = 0, finished = false, terminating = false, escalation;
    const deadline = setTimeout(terminate, 1000);
    function finish(value) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(escalation);
      child.stdout.destroy();
      resolve(value);
    }
    function terminate() {
      if (finished || terminating) return;
      terminating = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        child.kill('SIGKILL');
        // Do not wait indefinitely for an inherited stdout pipe to close.
        finish(null);
      }, 200);
    }
    child.on('error', () => finish(null));
    child.stdout.on('error', () => terminate());
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4096) { terminate(); return; }
      stdout += chunk.toString('utf8');
    });
    child.on('close', code => {
      const found = !terminating && code === 0 && stdout.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/);
      finish(found ? found[0] : null);
    });
  });
}

export async function doctor({ projectRoot, dataDir } = {}) {
  const [status, claude, codex, kiro, settingsResult] = await Promise.all([
    daemonStatus({ projectRoot, dataDir }), version('claude'), version('codex'), version('kiro'),
    readSettings({ projectRoot, dataDir }).then(value => ({ value }), () => ({ error: 'unsafe_settings' })),
  ]);
  const settings = settingsResult.value ?? {};
  const packages = settings.installation ? await inspectInstalledPackages({
    dataDir: (await projectPaths(projectRoot, dataDir)).dataDir, version: settings.installation.version,
  }).catch(() => ({ claude: false, codex: false })) : {};
  const credential = (process.env.TYPESAFE_API_KEY ?? settings.apiKey) ? 'configured_not_verified' : 'missing';
  const received = status.running ? status.observations?.hooks ?? {} : {};
  const hosts = Object.fromEntries(Object.entries({ claude, codex }).map(([host, hostVersion]) => [host, {
    version: hostVersion,
    installation: settings.installation?.hosts.includes(host) ? 'recorded' : 'not_recorded',
    packageFiles: packages[host] ? 'verified' : 'not_verified',
    activation: received[host] > 0 ? 'hook_observed' : 'not_verified',
    receivedHooks: received[host] ?? 0,
  }]));
  const policy = resolvePolicy({}, { current: status.running ? status.policy : undefined, saved: settings.policy });
  const nextActions = [];
  if (settingsResult.error) nextActions.push('Settings could not be safely read. Check permissions on the Graphlin data directory.');
  if (!settings.installation?.hosts.length) nextActions.push('Run graphlin init in this project to install an agent plugin.');
  else if (settings.installation.hosts.some(host => !packages[host])) {
    nextActions.push('Installed package files are missing or invalid. Run graphlin init to repair the installation.');
  }
  if (!status.running) nextActions.push('Run graphlin in this project and keep that terminal open.');
  if (!policy.allowSource) nextActions.push('Architecture classification needs source-sharing consent. Run graphlin init to choose it.');
  if (policy.allowSource && credential === 'missing') nextActions.push('Run graphlin init to save your TypeSafe key at its hidden prompt.');
  if (['unavailable', 'timeout'].includes(status.status?.classifier)) {
    nextActions.push('Run graphlin logs for the classifier failure reason. If authentication failed, run graphlin init --replace-key, then restart Graphlin.');
  }
  if (status.running && !Object.values(received).some(count => count > 0)) {
    nextActions.push('Start Claude Code or Codex with Graphlin installed, review its hook permissions, and ask it to explore this project.');
  } else if (status.running && !status.observations?.shapes) {
    nextActions.push('Ask your agent to read the main source files. Use graphlin logs to see why observations have not produced shapes.');
  }
  return {
    runtime: { node: process.versions.node, supported: Number(process.versions.node.split('.')[0]) >= 22,
      platform: process.platform, privateIPC: process.platform !== 'win32' },
    hosts: { ...hosts,
      kiro: { version: kiro, activation: 'inactive_experimental' } },
    daemon: status,
    coverage: Object.values(received).some(count => count > 0) ? 'hook_delivery_observed' : 'host_activation_unverified',
    credential, settings: settingsResult.error ?? 'readable', nextActions,
    note: 'No remote credential check was sent. An observed hook confirms delivery, not every host permission or runtime connectivity.',
  };
}
