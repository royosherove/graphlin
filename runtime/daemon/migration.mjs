import { constants } from 'node:fs';
import { lstat, realpath, open, mkdtemp, readdir, link, unlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateManifest, bundleDigest } from '../extensions/manifest.mjs';
import { validateGrant } from '../extensions/projection.mjs';

export const MIGRATION_LIMITS = Object.freeze({
  state: 2 * 1024 * 1024, model: 48 * 1024 * 1024, settings: 16 * 1024,
  diagnostics: 1024 * 1024, catalogue: 2 * 1024 * 1024, marker: 16 * 1024,
});
const MARKER = 'legacy-migration.json', EXTENSIONS = 'legacy-extensions.json';
const PROJECT_FILES = ['state.json', 'model-state.json', 'settings.json', 'diagnostics.jsonl', 'diagnostics.1.jsonl'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const owned = info => !process.getuid || info.uid === process.getuid();
const natural = value => Number.isSafeInteger(value) && value >= 0;
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };
const fail = (code = 'unsafe_legacy_state') => { throw Object.assign(new Error(code), { code }); };
const report = (status, extra = {}) => ({ status, copied: [], preserved: [], extensionsToReinstall: 0, ...extra });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function directory(filename, privateMode = true) {
  const info = await lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)
    || (info.mode & (privateMode ? 0o077 : 0o022)) || await realpath(filename) !== filename) fail();
  return info;
}
function regular(info, limit) {
  if (!info.isFile() || info.isSymbolicLink() || !owned(info) || info.nlink !== 1
    || (info.mode & 0o077) || info.size > limit) fail();
}
async function readBounded(filename, limit) {
  await directory(path.dirname(filename));
  const before = await lstat(filename).catch(missing);
  if (!before) return null;
  regular(before, limit);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    regular(opened, limit);
    if (!sameFile(before, opened)) fail('legacy_state_changed');
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat(), current = await lstat(filename);
    regular(after, limit); regular(current, limit);
    if (offset !== opened.size || !sameFile(opened, after) || !sameFile(after, current)) fail('legacy_state_changed');
    return { filename, info: after, bytes: buffer.subarray(0, offset) };
  } finally { await file.close(); }
}
function json(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_legacy_state'); }
  // JSON.parse is bounded by the file cap; also bound subsequent traversals.
  let count = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++count > 2_000_000 || depth > 64) fail('invalid_legacy_state');
    if (item && typeof item === 'object') for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return value;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function stopped(directoryName, projectId, isProcessAlive, code) {
  const lock = path.join(directoryName, 'daemon.lock');
  if (!await lstat(lock).catch(missing)) return;
  await directory(lock);
  const names = await readdir(lock);
  if (names.length > 64) fail('unsafe_legacy_state');
  for (const name of names) {
    if (name !== 'owner.json' && !/^owner\.json\.[0-9a-f-]+\.tmp$/.test(name)) fail();
    const source = await readBounded(path.join(lock, name), 4096);
    if (!source) continue;
    const owner = json(source.bytes);
    if (!plain(owner) || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || owner.protocol !== 1 || owner.projectId !== projectId || typeof owner.instanceId !== 'string'
      || !/^[0-9a-f-]{36}$/.test(owner.instanceId)) fail();
    if (isProcessAlive(owner.pid)) fail(code);
  }
}

async function guard(lock, action) {
  // Loaded only during an explicit migration, after paths have been resolved.
  // Reuse daemon startup's publication guard so an old daemon cannot restart
  // between the stopped check and publication. No static paths dependency.
  const claims = `${lock}.claims`;
  if (await lstat(claims).catch(missing)) await directory(claims);
  const { withPublicationGuard } = await import('./lock.mjs');
  return withPublicationGuard({ lock }, action);
}
async function extensionRecovery(filename, projectId) {
  const source = await readBounded(filename, MIGRATION_LIMITS.catalogue);
  if (!source) return null;
  const state = json(source.bytes);
  if (!plain(state) || state.schemaVersion !== 1
    || Object.keys(state).some(key => !['schemaVersion', 'installed', 'grants'].includes(key))
    || !Array.isArray(state.installed) || state.installed.length > 128
    || !Array.isArray(state.grants) || state.grants.length > 2048) fail('invalid_legacy_extensions');
  const seen = new Set();
  const installed = state.installed.map(row => {
    if (!plain(row) || Object.keys(row).some(key =>
      !['id', 'version', 'digest', 'manifest', 'development'].includes(key))
      || typeof row.development !== 'boolean') fail('invalid_legacy_extensions');
    const manifest = validateManifest(row.manifest);
    if (row.id !== manifest.id || row.version !== manifest.version
      || row.digest !== bundleDigest(manifest) || seen.has(row.id)) fail('invalid_legacy_extensions');
    seen.add(row.id);
    // Keep the shared installed inventory, never its code, assets or paths.
    return { id: row.id, version: row.version, digest: row.digest, development: row.development };
  });
  const grants = state.grants.filter(value => value?.projectId === projectId).map(validateGrant);
  if (!installed.length && !grants.length) return null;
  const bytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, projectId, requiresReinstall: true, installed, grants,
  }));
  if (bytes.length > MIGRATION_LIMITS.catalogue) fail('invalid_legacy_extensions');
  return { source, bytes, installed: installed.length };
}
async function completed(paths) {
  if (!await lstat(paths.dataDir).catch(missing)) return null;
  await directory(paths.dataDir);
  if (!await lstat(paths.directory).catch(missing)) return null;
  await directory(paths.directory);
  const marker = await readBounded(path.join(paths.directory, MARKER), MIGRATION_LIMITS.marker);
  if (!marker) return null;
  const value = json(marker.bytes);
  if (value?.schemaVersion !== 1 || value.projectId !== paths.projectId
    || !natural(value.completedAt) || !natural(value.extensionsToReinstall)
    || value.extensionsToReinstall > 128) fail('invalid_migration_marker');
  return report('already_migrated', { extensionsToReinstall: value.extensionsToReinstall });
}

/**
 * Explicit setup/start migration only. Never call from hooks, status or doctor.
 * No legacy data is removed, and every existing destination file wins.
 * Extension recovery is deliberately not an active extension catalogue.
 * Errors contain fixed codes only; callers must never log settings or buffers.
 */
export async function migrateLegacyProject(paths, {
  legacyDataDir = path.join(homedir(), '.local', 'state', 'graphlin'),
  customDataDir = false, now = Date.now, isProcessAlive = alive,
} = {}) {
  try {
    if (customDataDir || process.env.GRAPHLIN_DATA_DIR) return report('skipped');
    if (typeof paths?.projectRoot !== 'string' || typeof paths?.dataDir !== 'string') fail('invalid_migration_paths');
    const targetBase = path.join(paths.projectRoot, '.graphlin');
    if (paths.dataDir !== targetBase) return report('skipped');
    if (!path.isAbsolute(paths.projectRoot) || path.resolve(paths.projectRoot) !== paths.projectRoot
      || paths.projectId !== hash(paths.projectRoot) || paths.directory !== path.join(targetBase, paths.projectId)
      || typeof legacyDataDir !== 'string' || !path.isAbsolute(legacyDataDir)
      || typeof now !== 'function' || typeof isProcessAlive !== 'function') fail('invalid_migration_paths');
    const legacyBase = path.resolve(legacyDataDir), legacyProject = path.join(legacyBase, paths.projectId);
    if (legacyBase === targetBase) return report('skipped');
    const previous = await completed(paths);
    if (!await lstat(legacyBase).catch(missing)) return previous ?? report('no_legacy');
    await directory(legacyBase);
    if (!await lstat(legacyProject).catch(missing)) return previous ?? report('no_legacy');
    await directory(legacyProject);
    // A completed migration does not depend on retained backup contents, but
    // an old daemon restarted against that backup still requires a stop.
    await stopped(legacyProject, paths.projectId, isProcessAlive, 'legacy_daemon_running');
    if (previous) return previous;
    const candidates = [...PROJECT_FILES.map(name => path.join(legacyProject, name)),
      path.join(legacyBase, 'settings.json'), path.join(legacyBase, 'extensions', 'catalogue.json')];
    let present = false;
    for (const filename of candidates) {
      // Inspect the optional parent before traversing it (notably extensions).
      const parent = path.dirname(filename);
      if (!await lstat(parent).catch(missing)) continue;
      await directory(parent);
      if (await lstat(filename).catch(missing)) present = true;
    }
    if (!present) return report('no_legacy');
    await directory(paths.projectRoot, false);
    if (await lstat(targetBase).catch(missing)) await directory(targetBase);
    if (await lstat(paths.directory).catch(missing)) await directory(paths.directory);

    return await guard(path.join(legacyProject, 'daemon.lock'), async () => {
      await stopped(legacyProject, paths.projectId, isProcessAlive, 'legacy_daemon_running');
      const markerFile = path.join(paths.directory, MARKER);
      const current = await completed(paths);
      if (current) return current;
      const plan = [], sources = [], skipped = [];
      const add = (source, destination, name, bytes = source.bytes) => {
        sources.push(source); plan.push({ destination, name, bytes });
      };
      for (const name of PROJECT_FILES) {
        const limit = name === 'state.json' ? MIGRATION_LIMITS.state
          : name === 'model-state.json' ? MIGRATION_LIMITS.model
            : name === 'settings.json' ? MIGRATION_LIMITS.settings : MIGRATION_LIMITS.diagnostics;
        const source = await readBounded(path.join(legacyProject, name), limit);
        if (!source) continue;
        if (name === 'state.json') {
          const value = json(source.bytes), snapshot = value?.snapshot;
          if (value.schemaVersion !== 1 || !natural(value.savedAt) || value.savedAt > now() + 60_000
            || snapshot?.schemaVersion !== 1 || snapshot.projectId !== paths.projectId.slice(0, 24)
            || !plain(snapshot.graph) || !Array.isArray(snapshot.activity) || !Array.isArray(snapshot.history)
            || (snapshot.sessionStates !== undefined && (!Array.isArray(snapshot.sessionStates)
              || snapshot.sessionStates.length > 16))) fail('invalid_legacy_state');
        } else if (name === 'model-state.json') {
          const { createModelPersistence } = await import('./model-persistence.mjs');
          const persistence = createModelPersistence(source.filename, { projectId: paths.projectId, now });
          if (!await persistence.load()) fail('invalid_legacy_state');
        } else if (name.startsWith('diagnostics')) {
          // A crashed append can leave a truncated final record. Preserve the
          // old file, report it, and let diagrams/settings migrate independently.
          try {
            for (const line of source.bytes.toString('utf8').split('\n').filter(Boolean)) {
              const value = json(Buffer.from(line));
              if (Buffer.byteLength(line) > 32 * 1024 || value?.schemaVersion !== 1
                || !['capture', 'candidates', 'classification', 'apply', 'skip'].includes(value.stage)
                || !Number.isFinite(Date.parse(value.at))
                || value.projectId !== undefined && ![paths.projectId, paths.projectId.slice(0, 24)].includes(value.projectId)) {
                fail('invalid_legacy_state');
              }
            }
          } catch { skipped.push(name); continue; }
        }
        add(source, path.join(paths.directory, name), `project/${name}`);
      }
      const userSettings = await readBounded(path.join(legacyBase, 'settings.json'), MIGRATION_LIMITS.settings);
      if (userSettings) add(userSettings, path.join(targetBase, 'settings.json'), 'settings.json');
      if (userSettings || plan.some(value => value.name === 'project/settings.json')) {
        const { readSettings } = await import('./settings.mjs');
        await readSettings({ projectRoot: paths.projectRoot, dataDir: legacyBase });
      }
      let recovery;
      const extensions = path.join(legacyBase, 'extensions');
      if (await lstat(extensions).catch(missing)) {
        await directory(extensions);
        recovery = await extensionRecovery(path.join(extensions, 'catalogue.json'), paths.projectId);
        if (recovery) add(recovery.source, path.join(paths.directory, EXTENSIONS), `project/${EXTENSIONS}`, recovery.bytes);
      }
      if (!plan.length) return report('no_legacy', { skipped });
      const directories = new Map();
      for (const name of [legacyBase, legacyProject, ...(recovery ? [extensions] : [])]) {
        directories.set(name, await directory(name));
      }
      // Use the normal setup path so ignore protection precedes copying keys.
      // Resolution and an absent legacy project remain entirely read-only.
      const { projectPaths } = await import('./paths.mjs');
      const created = await projectPaths(paths.projectRoot, targetBase, { create: true });
      if (created.directory !== paths.directory || created.dataDir !== targetBase) fail('invalid_migration_paths');
      directories.set(targetBase, await directory(targetBase));
      directories.set(paths.directory, await directory(paths.directory));
      const checkDirectories = async () => {
        for (const [name, previous] of directories) {
          const current = await directory(name);
          if (current.dev !== previous.dev || current.ino !== previous.ino) fail('legacy_state_changed');
        }
      };
      return guard(path.join(paths.directory, 'daemon.lock'), async () => {
        await stopped(paths.directory, paths.projectId, isProcessAlive, 'local_daemon_running');
        await checkDirectories();
        const outcome = report('migrated', { skipped, extensionsToReinstall: recovery?.installed ?? 0 });
        const stage = await mkdtemp(path.join(paths.directory, '.legacy-migration-'));
        try {
          // Validate the entire plan before publishing any files.
          for (const source of sources) {
            const current = await lstat(source.filename);
            regular(current, source.bytes.length);
            if (!sameFile(source.info, current)) fail('legacy_state_changed');
          }
          for (const item of plan) {
            const current = await lstat(item.destination).catch(missing);
            if (current) regular(current, Number.MAX_SAFE_INTEGER);
          }
          const publish = async (destination, bytes, index) => {
            await checkDirectories();
            const temporary = path.join(stage, String(index));
            const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
            try {
              // Atomic no-clobber publication; unlinking the staging name
              // leaves the private destination with exactly one hard link.
              await link(temporary, destination);
              await unlink(temporary);
              return true;
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
              regular(await lstat(destination), Number.MAX_SAFE_INTEGER);
              return false;
            }
          };
          for (const [index, item] of plan.entries()) {
            const copied = await publish(item.destination, item.bytes, index);
            outcome[copied ? 'copied' : 'preserved'].push(item.name);
          }
          await stopped(legacyProject, paths.projectId, isProcessAlive, 'legacy_daemon_running');
          const completedAt = now();
          if (!natural(completedAt)) fail('invalid_migration_options');
          const marker = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: paths.projectId, completedAt, ...outcome }));
          if (marker.length > MIGRATION_LIMITS.marker) fail('invalid_migration_marker');
          await publish(markerFile, marker, 'complete');
          return outcome;
        } finally { await rm(stage, { recursive: true, force: true }); }
      });
    });
  } catch (error) {
    const codes = new Set(['unsafe_legacy_state', 'legacy_state_changed', 'invalid_legacy_state',
      'invalid_legacy_extensions', 'invalid_migration_paths', 'invalid_migration_options',
      'invalid_migration_marker', 'legacy_daemon_running', 'local_daemon_running',
      'tracked_state_directory', 'unsafe_ignore_file', 'unsafe_data_directory']);
    fail(codes.has(error?.code) ? error.code : error?.code === 'daemon_busy' ? 'migration_busy' : 'legacy_migration_failed');
  }
}

/** Resolve without creation; only explicit setup/start callers opt into migration. */
export async function prepareProjectState({ projectRoot, dataDir } = {}, options = {}) {
  const { projectPaths } = await import('./paths.mjs');
  const paths = await projectPaths(projectRoot, dataDir);
  const customDataDir = dataDir !== undefined || Boolean(process.env.GRAPHLIN_DATA_DIR);
  const migration = customDataDir ? report('skipped') : await migrateLegacyProject(paths, { ...options, customDataDir });
  return { ...paths, migration };
}
