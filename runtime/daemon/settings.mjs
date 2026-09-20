import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { projectPaths, privateDirectory, readPrivateJSON, atomicJSON, runtimeError, uid } from './paths.mjs';
import { withPublicationGuard } from './lock.mjs';

const LIMIT = 16 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validKey = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const validPolicy = value => record(value) && Object.keys(value).length === 3 &&
  ['allowSource', 'persistEvidence', 'displayEvidence'].every(key => typeof value[key] === 'boolean');
const validHosts = value => Array.isArray(value) && value.length <= 2 &&
  new Set(value).size === value.length && value.every(host => ['claude', 'codex'].includes(host));
const validInstallation = value => record(value) &&
  Object.keys(value).every(key => ['hosts', 'version', 'pendingHosts'].includes(key)) &&
  validHosts(value.hosts) && (!('pendingHosts' in value) || validHosts(value.pendingHosts)) &&
  typeof value.version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version);

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
  // Reuse the daemon's cross-process bakery guard. Each claim has a unique
  // PID/UUID name before its ticket is written, so interrupted setup can be
  // recovered without racing to delete a shared lock pathname.
  await withPublicationGuard({ lock: path.join(paths.dataDir, '.settings') }, async () => {
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
  }).catch(error => {
    if (error.code === 'daemon_busy') throw runtimeError('settings_busy');
    throw error;
  });
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
