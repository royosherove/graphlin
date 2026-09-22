import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REGISTRY = 'https://registry.npmjs.org/graphlin/latest';
const CACHE_MS = 30 * 60 * 1000;
const MAX_REGISTRY_BYTES = 32 * 1024;
const MAX_COMMAND_BYTES = 8192;
const PACKAGE = new URL('../../package.json', import.meta.url);
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const INSTRUCTIONS = [
  'Press Ctrl+C in the terminal running Graphlin to stop the viewer.',
  'Run the update command to restart the viewer in this project with the same Graphlin data directory.',
  'Start a new Claude Code or Codex agent session after the viewer restarts.',
];
const DEMO_INSTRUCTIONS = [
  'Press Ctrl+C in the terminal running Graphlin to stop the demo viewer.',
  'Run the update command to restart the offline demo with the same Graphlin data directory.',
];

const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) ||
      Buffer.byteLength(value) > 4096 || CONTROLS.test(value)) throw new Error('dashboard_info_unavailable');
  return path.resolve(value);
}

function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return match ? match.slice(1, 4).map(part => BigInt(part)) : null;
}

// null means unsupported/invalid, never "already latest". Build metadata does
// not affect stable SemVer precedence; numeric components are not lexical.
export function compareStableVersions(first, second) {
  const a = stableVersion(first), b = stableVersion(second);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function runningVersion(read) {
  try {
    const text = await read(PACKAGE, 'utf8');
    if (Buffer.byteLength(text) > 64 * 1024) return null;
    const metadata = JSON.parse(text);
    return metadata.name === 'graphlin' && stableVersion(metadata.version) ? metadata.version : null;
  } catch { return null; }
}

function branchInfo(projectRoot, execute) {
  return new Promise(resolve => {
    const unavailable = () => resolve({ status: 'unavailable' });
    try {
      execute('git', ['-c', 'core.fsmonitor=false', 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: projectRoot, shell: false, timeout: 750, killSignal: 'SIGKILL',
        maxBuffer: 4096, encoding: 'utf8',
        // Do not inherit credentials, Git overrides, or global config. This
        // local ref lookup never runs a shell, hook, installer or remote.
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
        },
      }, (error, stdout, stderr) => {
        if (error) {
          if (error.code === 1 && !error.killed) return resolve({ status: 'detached' });
          if (error.code === 128 && !error.killed && typeof stderr === 'string' &&
              stderr.includes('not a git repository')) return resolve({ status: 'not_git' });
          return unavailable();
        }
        const name = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
        if (!name || Buffer.byteLength(name) > 1024 || CONTROLS.test(name)) return unavailable();
        resolve({ status: 'branch', name });
      });
    } catch { unavailable(); }
  });
}

async function registryVersion(fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        // Fixed destination and headers: project paths, branch names, daemon
        // state, credentials and registry overrides never enter this request.
        const response = await fetchImpl(REGISTRY, {
          method: 'GET', headers: { Accept: 'application/json' },
          redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_REGISTRY_BYTES ||
            !response.body) throw new Error('registry_unavailable');
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_REGISTRY_BYTES) throw new Error('registry_unavailable');
            chunks.push(Buffer.from(value));
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const metadata = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
        if (metadata.name !== 'graphlin' || !stableVersion(metadata.version)) throw new Error('registry_unavailable');
        return metadata.version;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('registry_unavailable'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    // Raw network errors and response bodies may contain private content.
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Trusted startup context only; dependencies are injectable for offline tests.
// Creating the provider performs no registry request or Git subprocess.
export function createDashboardInfoProvider({ projectRoot, dataDir, mode = 'live' }, {
  fetch: fetchImpl = globalThis.fetch, execFile: execute = execFile,
  readFile: read = readFile, now = Date.now, timeoutMs = 1500,
} = {}) {
  const version = runningVersion(read);
  let cached, pending;
  async function latestVersion() {
    if (cached && now() < cached.expiresAt) return cached.latest;
    if (!pending) {
      pending = registryVersion(fetchImpl, timeoutMs).then(latest => {
        cached = { latest, expiresAt: now() + CACHE_MS };
        return latest;
      }).finally(() => { pending = null; });
    }
    return pending;
  }
  return async () => {
    // Metadata that cannot be displayed safely disables this optional endpoint,
    // never startup, capture, or the rest of the viewer.
    if (!['live', 'demo'].includes(mode)) throw new Error('dashboard_info_unavailable');
    const root = absolute(projectRoot), directory = absolute(dataDir);
    const demo = mode === 'demo';
    const customDataDir = demo || directory !== path.join(root, '.graphlin');
    const command = `${demo ? '' : `cd ${quote(root)} && `}${customDataDir ? `GRAPHLIN_DATA_DIR=${quote(directory)} ` : ''}npx --yes graphlin@latest${demo ? ' demo' : ''}`;
    // Never truncate a shell argument or offer instructions without a usable
    // command. Quoting can expand otherwise valid paths beyond the UI limit.
    const guide = Buffer.byteLength(command) <= MAX_COMMAND_BYTES
      ? { command, instructions: [...(demo ? DEMO_INSTRUCTIONS : INSTRUCTIONS),
        ...(!customDataDir ? ['State is repo-local in .graphlin. Unset GRAPHLIN_DATA_DIR in this terminal to keep using it.'] : [])] } : {};
    const [current, branch, latest] = await Promise.all([
      version, branchInfo(root, execute), latestVersion(),
    ]);
    if (!current) throw new Error('dashboard_info_unavailable');
    const comparison = compareStableVersions(latest, current);
    return {
      projectRoot: root, mode, branch, version: current,
      update: {
        status: comparison === null ? 'unavailable' : comparison > 0 ? 'available' : 'current',
        current, ...(latest ? { latest } : {}), ...guide,
      },
    };
  };
}
