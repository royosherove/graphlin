import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
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

async function sourceCheckout(root, current) {
  const [claude, codex, builder] = await Promise.all([
    json(path.join(root, '.claude-plugin/plugin.json')),
    json(path.join(root, '.codex-plugin/plugin.json')),
    regularFile(path.join(root, 'scripts/build-packages.mjs')),
  ]);
  return builder && manifest(claude) && manifest(codex) &&
    claude.version === current.version && codex.version === current.version &&
    claude.hooks === './adapters/claude/hooks.json' &&
    current.extensions?.['com.openai']?.hooks === './adapters/codex/hooks.json';
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

async function localMarketplace(root, codexRoot) {
  const value = await json(path.join(root, '.agents/plugins/marketplace.json'));
  if (!record(value) || value.name !== 'graphlin-local' || !Array.isArray(value.plugins)) return false;
  const entries = value.plugins.filter(entry => entry?.name === 'graphlin');
  if (entries.length !== 1) return false;
  const entry = entries[0];
  return entry.source?.source === 'local' && entry.source.path === './graphlin' &&
    path.join(root, 'graphlin') === codexRoot &&
    entry.policy?.installation === 'AVAILABLE' && entry.policy?.authentication === 'ON_INSTALL';
}

export async function inspectInstalledPackages({ dataDir, version: currentVersion }) {
  if (!version(currentVersion)) return { claude: false, codex: false };
  const root = path.join(absolute(dataDir), 'plugins', 'graphlin', currentVersion);
  const [claude, codex] = await Promise.all(['claude', 'codex'].map(host =>
    hostPackage(path.join(root, host, 'graphlin'), host, currentVersion)));
  return { claude, codex };
}

// Discovery reads only fixed package metadata and checks file availability.
// It never scans the project, reads state/credentials, or executes commands.
async function discover(pluginRoot, dataDir) {
  const [marker, current, isDirectory] = await Promise.all([
    packageMarker(pluginRoot), json(path.join(pluginRoot, 'plugin.json')), directory(pluginRoot),
  ]);
  if (!isDirectory || !manifest(current) || marker.status === 'invalid') return { available: false };
  if (marker.status === 'missing') {
    if (!await sourceCheckout(pluginRoot, current)) return { available: false };
    // npm installations can be read-only. Generated host packages belong in
    // the same user-owned data directory as the running service, not beside
    // installed code. Versioned paths stay stable across projects and restarts.
    const output = path.join(dataDir, 'plugins', 'graphlin', current.version);
    const claudeRoot = path.join(output, 'claude/graphlin');
    const codexRoot = path.join(output, 'codex/graphlin');
    const [claudeReady, codexReady, marketplaceReady] = await Promise.all([
      hostPackage(claudeRoot, 'claude', current.version),
      hostPackage(codexRoot, 'codex', current.version),
      localMarketplace(path.dirname(codexRoot), codexRoot),
    ]);
    return {
      available: true,
      ...(claudeReady && codexReady && marketplaceReady ? {} : { build: path.join(pluginRoot, 'scripts/build-packages.mjs') }),
      output,
      claude: claudeRoot,
      marketplace: path.join(output, 'codex'),
    };
  }
  const distribution = path.resolve(pluginRoot, '../..');
  const claudeRoot = marker.profile === 'claude' ? pluginRoot : path.join(distribution, 'claude/graphlin');
  const codexRoot = marker.profile === 'codex' ? pluginRoot : path.join(distribution, 'codex/graphlin');
  const marketplaceRoot = path.dirname(codexRoot);
  const [claude, codex, marketplace] = await Promise.all([
    hostPackage(claudeRoot, 'claude', current.version),
    hostPackage(codexRoot, 'codex', current.version),
    localMarketplace(marketplaceRoot, codexRoot),
  ]);
  return {
    available: true, claude: claude ? claudeRoot : null,
    marketplace: codex && marketplace ? marketplaceRoot : null,
  };
}

function format({ projectRoot, dataDir, mode }, found) {
  const result = { projectRoot, mode, instructions: [], notes: [] };
  if (mode === 'demo') {
    result.notes.push('This viewer is in demo mode and uses fixture classifications. Open a live Graphlin viewer for your own project before connecting your work.');
  }
  if (!found.available) {
    result.notes.push('Connection setup is unavailable because this Graphlin source checkout or package could not be verified. Obtain a complete Graphlin distribution.');
    return result;
  }
  const terminal = words => `cd ${quote(projectRoot)} && GRAPHLIN_DATA_DIR=${quote(dataDir)} ${words}`;
  const instruction = (id, title, description, steps) => ({ id, title, description, steps });
  const fits = entries => entries.every(item => item.steps.every(step =>
    Buffer.byteLength(step.command) <= MAX_COMMAND_BYTES));
  function append(entries, host) {
    if (fits(entries)) result.instructions.push(...entries);
    else result.notes.push(`${host} commands are too long to display safely. Use shorter project, package, or data directory paths.`);
  }

  if (found.build) {
    const build = [instruction('build-packages', 'Build current plugin packages',
      'Run this prerequisite first. It rebuilds both host profiles in your Graphlin data directory; existing generated packages may be out of date.',
      [{ label: 'Build packages in Terminal', command: terminal(`node ${quote(found.build)} --out ${quote(found.output)}`) }])];
    if (!fits(build)) {
      result.notes.push('The build command is too long to display safely. Use shorter project, package, or data directory paths.');
      return result;
    }
    result.instructions.push(...build);
  }
  const prerequisite = found.build ? 'Complete the build step above first. ' : '';
  if (found.claude) {
    const launch = terminal(`claude --plugin-dir ${quote(found.claude)}`);
    append([
      instruction('claude-new', 'Claude: new session',
        `${prerequisite}Start a new Claude session with this Graphlin plugin loaded.`,
        [{ label: 'Start Claude in Terminal', command: launch }]),
      instruction('claude-resume', 'Claude: resume',
        `${prerequisite}Instead of starting a new session, continue the most recent conversation in this project.`,
        [{ label: 'Resume Claude in Terminal', command: `${launch} --continue` }]),
    ], 'Claude');
  } else {
    result.notes.push('Claude connection is unavailable: matching packaged files were not found. Rebuild or obtain the complete Graphlin distribution, including its Claude profile.');
  }
  if (found.marketplace) {
    const hooks = () => ({
      label: 'Inside Codex: /hooks', command: '/hooks',
      description: 'Inside Codex, review and trust Graphlin hooks; then start your work',
    });
    const launch = terminal(`codex -C ${quote(projectRoot)}`);
    append([
      instruction('codex-setup', 'Codex: install the local plugin',
        `${prerequisite}Run both setup commands before launching. They register this local marketplace and install its Graphlin package in Codex.`,
        [
          { label: 'Register marketplace in Terminal', command: terminal(`codex plugin marketplace add ${quote(found.marketplace)}`) },
          { label: 'Install Graphlin in Terminal', command: terminal(`codex plugin add ${quote('graphlin@graphlin-local')}`) },
        ]),
      instruction('codex-new', 'Codex: new session',
        'Complete Codex setup above, then start a new session and review the hooks inside Codex.',
        [{ label: 'Start Codex in Terminal', command: launch }, hooks()]),
      instruction('codex-resume', 'Codex: resume',
        'Complete Codex setup above. Instead of starting a new session, resume the most recent conversation in this project.',
        [{ label: 'Resume Codex in Terminal', command: `${launch} resume --last` }, hooks()]),
    ], 'Codex');
  } else {
    result.notes.push('Codex connection is unavailable: matching packaged files and a valid local marketplace were not found. Rebuild or obtain the complete Graphlin distribution, including its Codex marketplace.');
  }
  result.notes.push('Choose either a new session or resume. Keep the Graphlin viewer running while you work.');
  result.notes.push('Package discovery does not confirm that host hooks are active. Follow the host prompts to load and trust the plugin.');
  return result;
}

/**
 * Read-only connection instructions for an authenticated local endpoint.
 * All inputs must come from the daemon's trusted startup context, not a request
 * body/query. projectRoot and dataDir are already canonicalized by projectPaths.
 * No environment, graph, launch URL, or credential is copied into the result.
 */
export async function createConnectionInfo({
  projectRoot, dataDir, mode = 'live', pluginRoot = PLUGIN_ROOT,
} = {}) {
  if (!['live', 'demo'].includes(mode)) throw new TypeError('invalid_connection_info');
  const context = { projectRoot: absolute(projectRoot), dataDir: absolute(dataDir), mode };
  const root = absolute(pluginRoot);
  return format(context, await discover(root, context.dataDir));
}
