import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { projectPaths, privateDirectory, readPrivateJSON, atomicJSON, runtimeError, uid } from './paths.mjs';
import { withPublicationGuard } from './lock.mjs';
import { validProviderSetting, retiredProviderSetting } from './providers.mjs';

const LIMIT = 16 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validKey = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const validPolicy = value => record(value) &&
  Object.keys(value).every(key => ['allowSource', 'localSource', 'persistEvidence', 'displayEvidence'].includes(key)) &&
  ['allowSource', 'persistEvidence', 'displayEvidence'].every(key => typeof value[key] === 'boolean') &&
  (value.localSource === undefined || typeof value.localSource === 'boolean') &&
  !(value.localSource && value.allowSource);
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
 * Credentials/installation live in the repository-local data directory.
 * An explicit shared data-directory override can share them across projects.
 * Consent is scoped to the canonical project. Never serialize this result into
 * a diagnostic, MCP response, snapshot, browser payload, or subprocess argument.
 */
export async function readSettings(context = {}) {
  const paths = await projectPaths(context.projectRoot, context.dataDir);
  const [user, project] = await Promise.all([
    // A saved [::1] value is readable, but each start refuses it with invalid_provider.
    readFile(path.join(paths.dataDir, 'settings.json'), { apiKey: validKey, installation: validInstallation,
      decisionProvider: value => validProviderSetting(value) || retiredProviderSetting(value) }),
    readFile(path.join(paths.directory, 'settings.json'), { policy: validPolicy }),
  ]);
  return {
    ...(user.apiKey ? { apiKey: user.apiKey } : {}),
    ...(user.installation ? { installation: user.installation } : {}),
    ...(user.decisionProvider ? { decisionProvider: user.decisionProvider } : {}),
    ...(project.policy ? { policy: project.policy } : {}),
  };
}

export async function saveSettings(context, patch) {
  if (!record(patch) || Object.keys(patch).some(key => !['apiKey', 'policy', 'installation', 'decisionProvider'].includes(key)) ||
      ('apiKey' in patch && patch.apiKey !== null && !validKey(patch.apiKey)) ||
      ('decisionProvider' in patch && patch.decisionProvider !== null && !validProviderSetting(patch.decisionProvider)) ||
      ('policy' in patch && !validPolicy(patch.policy)) ||
      ('installation' in patch && !validInstallation(patch.installation))) throw runtimeError('invalid_settings');
  const paths = await projectPaths(context.projectRoot, context.dataDir, { create: true });
  await privateDirectory(paths.dataDir);
  // Reuse the daemon's cross-process bakery guard. Each claim has a unique
  // PID/UUID name before its ticket is written, so interrupted setup can be
  // recovered without racing to delete a shared lock pathname.
  await withPublicationGuard({ lock: path.join(paths.dataDir, '.settings') }, async () => {
    const current = await readSettings(paths);
    if ('apiKey' in patch || 'installation' in patch || 'decisionProvider' in patch) {
      const user = { schemaVersion: 1 };
      const key = 'apiKey' in patch ? patch.apiKey : current.apiKey;
      const installation = patch.installation ?? current.installation;
      // Keep the provider choice in each write. null removes it (Jev).
      const provider = 'decisionProvider' in patch ? patch.decisionProvider : current.decisionProvider;
      if (key) user.apiKey = key;
      if (installation) user.installation = installation;
      if (provider) user.decisionProvider = provider;
      await atomicJSON(path.join(paths.dataDir, 'settings.json'), user, LIMIT);
    }
    if ('policy' in patch) await atomicJSON(path.join(paths.directory, 'settings.json'),
      { schemaVersion: 1, policy: patch.policy }, LIMIT);
  }).catch(error => {
    if (error.code === 'daemon_busy') throw runtimeError('settings_busy');
    throw error;
  });
}

// The next step for unsafe_settings. It names the files and the keys that
// Graphlin accepts. It never shows the file content.
export const UNSAFE_SETTINGS_STEP = 'Examine settings.json in the Graphlin data directory (.graphlin/ at the repository root, '
  + 'or --data-dir PATH or GRAPHLIN_DATA_DIR). It must be a private file in a private directory, with schemaVersion 1 and only '
  + 'the keys apiKey, installation and decisionProvider. The project file <data directory>/<project>/settings.json accepts '
  + 'only schemaVersion and policy. If decisionProvider is not valid, run graphlin provider jev to remove it.';

/**
 * Remove the saved provider value, also a value that is not valid. All other
 * keys of the user file, and the project file, must be valid, else the result
 * is unsafe_settings and the file does not change. Returns removedInvalid:
 * true when the removed value was not valid.
 */
export async function removeProviderSetting(context) {
  const paths = await projectPaths(context.projectRoot, context.dataDir, { create: true });
  await privateDirectory(paths.dataDir);
  let removedInvalid = false;
  await withPublicationGuard({ lock: path.join(paths.dataDir, '.settings') }, async () => {
    const filename = path.join(paths.dataDir, 'settings.json');
    // The same checks as readSettings, but any decisionProvider value passes.
    // Examine the project file first: a command that fails changes no file.
    const [user] = await Promise.all([
      readFile(filename, { apiKey: validKey, installation: validInstallation, decisionProvider: () => true }),
      readFile(path.join(paths.directory, 'settings.json'), { policy: validPolicy }),
    ]);
    if (!('decisionProvider' in user)) return;
    removedInvalid = !validProviderSetting(user.decisionProvider);
    const next = { schemaVersion: 1 };
    if (user.apiKey) next.apiKey = user.apiKey;
    if (user.installation) next.installation = user.installation;
    await atomicJSON(filename, next, LIMIT);
  }).catch(error => {
    if (error.code === 'daemon_busy') throw runtimeError('settings_busy');
    throw error;
  });
  return { removedInvalid };
}

export function savedPolicy(policy) {
  return policy ? {
    allowSource: policy.transmitSource,
    persistEvidence: policy.persistEvidence,
    displayEvidence: policy.displayEvidence,
    ...(policy.readSource && !policy.transmitSource ? { localSource: true } : {}),
  } : {};
}

// An omitted field means reuse consent, while false is an explicit opt-out.
export function resolvePolicy(options, { current, saved } = {}) {
  const fallback = current ? savedPolicy(current) : saved ?? {};
  const allowSource = options.allowSource ?? fallback.allowSource ?? false;
  const localSource = !allowSource && (options.localSource ??
    (options.allowSource === false ? false : fallback.localSource) ?? false);
  return {
    allowSource,
    ...(localSource ? { localSource: true } : {}),
    persistEvidence: options.persistEvidence ?? fallback.persistEvidence ?? false,
    displayEvidence: options.displayEvidence ?? fallback.displayEvidence ?? true,
  };
}
