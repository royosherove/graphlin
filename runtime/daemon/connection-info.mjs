import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PROFILES = new Set(['claude', 'codex', 'portable']);
const MAX_PATH_BYTES = 4096;
const MAX_COMMAND_BYTES = 8192;
const MAX_MANIFEST_BYTES = 16 * 1024;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const version = value => typeof value === 'string' && value.length <= 80 &&
  /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(value);
const manifest = value => record(value) && value.name === 'graphlin' && version(value.version);

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || CONTROLS.test(value) ||
      Buffer.byteLength(value) > MAX_PATH_BYTES) throw new TypeError('invalid_connection_info');
  return path.resolve(value);
}

// A single POSIX shell argument. No caller value is treated as shell syntax.
const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

async function regularFile(filename) {
  try { return (await lstat(filename)).isFile(); }
  catch { return false; }
}

async function directory(filename) {
  try { return (await lstat(filename)).isDirectory(); }
  catch { return false; }
}

async function readSmall(filename, limit = MAX_MANIFEST_BYTES) {
  let handle;
  try {
    // NONBLOCK avoids waiting on a substituted FIFO; NOFOLLOW rejects a linked
    // metadata file. The handle check and bounded read also cover replacement.
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return { status: 'invalid' };
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > limit ? { status: 'invalid' }
      : { status: 'present', text: bytes.subarray(0, length).toString('utf8') };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'invalid' };
  } finally { await handle?.close(); }
}

async function json(filename) {
  const result = await readSmall(filename);
  try { return result.status === 'present' ? JSON.parse(result.text) : null; }
  catch { return null; }
}

async function packageMarker(root) {
  const result = await readSmall(path.join(root, '.graphlin-package'), 64);
  if (result.status !== 'present') return result;
  const profile = result.text.trim();
  return PROFILES.has(profile) ? { status: 'present', profile } : { status: 'invalid' };
}

async function hostPackage(root, host, currentVersion) {
  const [isDirectory, marker, portable, native, mcp, hooks, ...files] = await Promise.all([
    directory(root), packageMarker(root), json(path.join(root, 'plugin.json')),
    json(path.join(root, `.${host}-plugin/plugin.json`)),
    json(path.join(root, '.mcp.json')),
    json(path.join(root, `adapters/${host}/hooks.json`)),
    ...['scripts/control.mjs', 'scripts/collect.sh', 'scripts/collector.mjs', 'runtime/collector/index.mjs']
      .map(file => regularFile(path.join(root, file))),
  ]);
  const expectedRoot = host === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}';
  const server = mcp?.mcpServers?.graphlin;
  return isDirectory && marker.profile === host && manifest(portable) && manifest(native) &&
    portable.version === currentVersion && native.version === currentVersion && files.every(Boolean) &&
    server?.command === 'node' && Array.isArray(server.args) && server.args.length === 1 &&
    server.args[0] === `${expectedRoot}/scripts/control.mjs` &&
    record(hooks?.hooks) && Object.keys(hooks.hooks).length > 0 &&
    (host === 'claude' ? native.hooks === './adapters/claude/hooks.json'
      : native.mcpServers === './.mcp.json' &&
        portable.extensions?.['com.openai']?.hooks === './adapters/codex/hooks.json');
}

export async function inspectInstalledPackages({ dataDir, version: currentVersion }) {
  if (!version(currentVersion)) return { claude: false, codex: false };
  const root = path.join(absolute(dataDir), 'plugins', 'graphlin', currentVersion);
  const [claude, codex] = await Promise.all(['claude', 'codex'].map(host =>
    hostPackage(path.join(root, host, 'graphlin'), host, currentVersion)));
  return { claude, codex };
}

// Connection guidance uses only the current instance's trusted startup context.
// npm onboarding owns package installation; the guide neither discovers local
// package paths nor reads project settings, credentials, or host configuration.
function format({ projectRoot, dataDir, mode }) {
  const result = { projectRoot, mode, instructions: [], notes: [] };
  const demo = mode === 'demo';
  // defaultDataDir() includes the daemon's environment override. Comparing to
  // it would wrongly hide custom directories needed by a second terminal.
  const customDataDir = !demo && dataDir !== path.resolve(homedir(), '.local/state/graphlin');
  const terminal = words => `${demo ? '' : `cd ${quote(projectRoot)} && `}${customDataDir ? `GRAPHLIN_DATA_DIR=${quote(dataDir)} ` : ''}${words}`;
  const instruction = (id, title, description, steps) => ({ id, title, description, steps });
  const entries = [
    instruction('npm-setup', demo ? '1. Start a live viewer' : 'Set up only if needed',
      demo
        ? 'Open a terminal in your own project. Run guided setup, choose Claude Code or Codex and source or metadata mode, then keep that terminal running. The live viewer opens automatically.'
        : 'This viewer is already running. If you completed guided setup for this project and your chosen host, skip this step. Otherwise, run setup alone in a second terminal; init does not start another server.',
      [{ label: demo ? 'In your project terminal' : 'Set up this project in a second terminal',
        command: terminal(`npx --yes graphlin@latest${demo ? '' : ' init'}`),
        description: 'Choose your host and source or metadata mode. Source mode needs a TypeSafe API key; enter it at the masked prompt if asked. Metadata mode needs no key.' }]),
    instruction('claude-new', demo ? '2. Start Claude Code (choose one agent)' : 'Start Claude Code (choose one agent)',
      'After setup, open a second terminal in the same project and start a new agent session. Accept the project trust prompt.',
      [{ label: 'Start Claude in the second terminal', command: terminal('claude') },
        { label: 'Inside Claude: /plugin', command: '/plugin',
          description: 'Confirm Graphlin is enabled.' }]),
    instruction('codex-new', demo ? '2. Start Codex (choose one agent)' : 'Start Codex (choose one agent)',
      'After setup, open a second terminal in the same project and start a new agent session. Accept the project trust prompt.',
      [{ label: 'Start Codex in the second terminal', command: terminal('codex') },
        { label: 'Inside Codex: /hooks', command: '/hooks',
          description: 'Review and trust Graphlin hooks before starting your work.' }]),
  ];
  // Omit the whole guide rather than offering launch commands without setup or
  // truncating a shell argument. The viewer applies the same command limit.
  if (entries.every(item => item.steps.every(step => Buffer.byteLength(step.command) <= MAX_COMMAND_BYTES))) {
    result.instructions.push(...entries);
  } else {
    result.notes.push('Connection commands are too long to display safely. Use shorter project or data directory paths.');
  }
  if (demo) {
    result.notes.push('This demo uses fixture classifications. Run the commands in your own project; its setup uses the normal data directory, not this demo’s custom directory.');
  } else {
    result.notes.push('Next time: npx --yes graphlin@latest in this project, then claude or codex in a second terminal. Keep the viewer running.');
    result.notes.push('Consent or key changes require stopping and restarting this project’s viewer with the same data directory. Until then, its current policy and classifier configuration stay in effect.');
  }
  result.notes.push(customDataDir
    ? 'Commands preserve this viewer’s custom data directory. Use the same GRAPHLIN_DATA_DIR for future viewer launches.'
    : 'Default data: ~/.local/state/graphlin. Unset GRAPHLIN_DATA_DIR in both terminals to use it.' +
      (demo ? ' For an intentional custom location, set the same GRAPHLIN_DATA_DIR in both terminals.' : ''));
  result.notes.push('Plugins install across projects; source consent is per project. Source mode sends locally filtered source excerpts, user prompts, and public agent messages to TypeSafe.');
  result.notes.push('Installation does not confirm hook activation. After setup and trust, ask: “Orient yourself in this project: read its main files and explain how the components connect.” Watch for hook delivery and diagram updates.');
  return result;
}

/**
 * Read-only connection instructions for an authenticated local endpoint.
 * All inputs must come from the daemon's trusted startup context, not a request
 * body/query. projectRoot and dataDir are already canonicalized by projectPaths.
 * No environment, graph, launch URL, or credential is copied into the result.
 */
export async function createConnectionInfo({ projectRoot, dataDir, mode = 'live' } = {}) {
  if (!['live', 'demo'].includes(mode)) throw new TypeError('invalid_connection_info');
  return format({ projectRoot: absolute(projectRoot), dataDir: absolute(dataDir), mode });
}
