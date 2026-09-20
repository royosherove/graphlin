import path from 'node:path';
import { lstat, open, rm } from 'node:fs/promises';
import { projectPaths, privateDirectory, readPrivateJSON, atomicJSON, runtimeError, uid } from './paths.mjs';

const LIMIT = 16 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validKey = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const validPolicy = value => record(value) && Object.keys(value).length === 3 &&
  ['allowSource', 'persistEvidence', 'displayEvidence'].every(key => typeof value[key] === 'boolean');
const validInstallation = value => record(value) && Object.keys(value).length === 2 &&
  Array.isArray(value.hosts) && value.hosts.length <= 2 &&
  new Set(value.hosts).size === value.hosts.length && value.hosts.every(host => ['claude', 'codex'].includes(host)) &&
  typeof value.version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version);

async function lockSettings(dataDir) {
  const filename = path.join(dataDir, '.settings.lock');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    let handle;
    try {
      handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
      return async () => { await handle.close(); await rm(filename, { force: true }); };
    } catch (error) {
      if (handle) { await handle.close(); await rm(filename, { force: true }); throw runtimeError('unsafe_settings'); }
      if (error.code !== 'EEXIST') throw runtimeError('unsafe_settings');
      // Recover a completed process's lock; never evict a live writer or
      // overwrite an unsafe/symlinked lock. Compare identity before removal.
      let validLock = false;
      try {
        const before = await lstat(filename);
        validLock = before.isFile() && !before.isSymbolicLink() && before.nlink === 1 &&
          (before.mode & 0o077) === 0 && (uid() === undefined || before.uid === uid());
        if (!validLock) throw runtimeError('unsafe_settings');
        const owner = await readPrivateJSON(filename, 128);
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          let dead = false;
          try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; }
          if (dead) {
            const after = await lstat(filename);
            if (before.ino === after.ino && before.dev === after.dev) await rm(filename);
          }
        }
      } catch (failure) {
        // A writer can release after lstat/open; readPrivateJSON then rejects
        // the now-unlinked handle (nlink=0). Retry acquisition in that case.
        if (failure.code !== 'ENOENT' && !(validLock && failure.code === 'unsafe_state_file') &&
            !(failure instanceof SyntaxError)) throw runtimeError('unsafe_settings');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw runtimeError('settings_busy');
}

async function readFile(filename, allowed) {
  try {
    // Refuse unsafe settings instead of silently losing a user's consent choice.
    // No settings data or filesystem error text becomes a public error.
    const file = await lstat(filename);
    if (!file.isFile() || file.isSymbolicLink()) throw runtimeError('unsafe_settings');
    const info = await lstat(path.dirname(filename));
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (uid() !== undefined && info.uid !== uid())) throw runtimeError('unsafe_settings');
    const value = await readPrivateJSON(filename, LIMIT);
    if (!record(value) || value.schemaVersion !== 1 ||
        Object.keys(value).some(key => !['schemaVersion', ...Object.keys(allowed)].includes(key)) ||
        Object.entries(allowed).some(([key, validate]) => key in value && !validate(value[key]))) {
      throw runtimeError('unsafe_settings');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw runtimeError('unsafe_settings');
  }
}

/**
 * User credentials/installation are shared by projects in one data directory.
 * Consent is scoped to the canonical project. Never serialize this result into
 * a diagnostic, MCP response, snapshot, browser payload, or subprocess argument.
 */
export async function readSettings(context = {}) {
  const paths = await projectPaths(context.projectRoot, context.dataDir);
  const [user, project] = await Promise.all([
    readFile(path.join(paths.dataDir, 'settings.json'), { apiKey: validKey, installation: validInstallation }),
    readFile(path.join(paths.directory, 'settings.json'), { policy: validPolicy }),
  ]);
  return {
    ...(user.apiKey ? { apiKey: user.apiKey } : {}),
    ...(user.installation ? { installation: user.installation } : {}),
    ...(project.policy ? { policy: project.policy } : {}),
  };
}

export async function saveSettings(context, patch) {
  if (!record(patch) || Object.keys(patch).some(key => !['apiKey', 'policy', 'installation'].includes(key)) ||
      ('apiKey' in patch && patch.apiKey !== null && !validKey(patch.apiKey)) ||
      ('policy' in patch && !validPolicy(patch.policy)) ||
      ('installation' in patch && !validInstallation(patch.installation))) throw runtimeError('invalid_settings');
  const paths = await projectPaths(context.projectRoot, context.dataDir, { create: true });
  await privateDirectory(paths.dataDir);
  const release = await lockSettings(paths.dataDir);
  try {
    const current = await readSettings(paths);
    if ('apiKey' in patch || 'installation' in patch) {
      const user = { schemaVersion: 1 };
      const key = 'apiKey' in patch ? patch.apiKey : current.apiKey;
      const installation = patch.installation ?? current.installation;
      if (key) user.apiKey = key;
      if (installation) user.installation = installation;
      await atomicJSON(path.join(paths.dataDir, 'settings.json'), user, LIMIT);
    }
    if ('policy' in patch) await atomicJSON(path.join(paths.directory, 'settings.json'),
      { schemaVersion: 1, policy: patch.policy }, LIMIT);
  } finally { await release(); }
}

export function savedPolicy(policy) {
  return policy ? {
    allowSource: policy.transmitSource,
    persistEvidence: policy.persistEvidence,
    displayEvidence: policy.displayEvidence,
  } : {};
}

// An omitted field means reuse consent, while false is an explicit opt-out.
export function resolvePolicy(options, { current, saved } = {}) {
  const fallback = current ? savedPolicy(current) : saved ?? {};
  return {
    allowSource: options.allowSource ?? fallback.allowSource ?? false,
    persistEvidence: options.persistEvidence ?? fallback.persistEvidence ?? false,
    displayEvidence: options.displayEvidence ?? fallback.displayEvidence ?? true,
  };
}
