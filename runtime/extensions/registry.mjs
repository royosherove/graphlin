import { mkdir, mkdtemp, writeFile, rename, rm, open, lstat, watch } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MANIFEST_FILE, EXTENSION_LIMITS as L, check, exact, id, extensionId, digest,
  extensionError, assetPath, jsonBytes,
} from './contracts.mjs';
import { validateManifest, validateAssets, bundleDigest, decisionProfiles } from './manifest.mjs';
import { validateGrant } from './projection.mjs';
import {
  safeDirectory, readRegular, readLocalPackage, readPackageArchive, npmPackTransport,
  parsePackageSpec, checkCancelled,
} from './packages.mjs';

async function makePrivate(directory) {
  try { await safeDirectory(directory, { owned: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await makeParent(path.dirname(directory));
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await safeDirectory(directory, { owned: true });
  }
  return directory;
}
async function makeParent(directory) {
  try { await safeDirectory(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await makeParent(path.dirname(directory));
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await safeDirectory(directory);
  }
}
async function atomicJSON(filename, value) {
  const body = jsonBytes(value, 2 * 1024 * 1024, 'catalogue_limit');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(body); await file.sync(); await file.close(); file = null;
    await rename(temporary, filename);
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
}

export async function createExtensionRegistry({ dataDir, projectId, transport = npmPackTransport } = {}) {
  check(typeof dataDir === 'string' && path.isAbsolute(dataDir) && id(projectId), 'invalid_registry_options');
  await makePrivate(dataDir);
  const directory = await makePrivate(path.join(dataDir, 'extensions'));
  const bundles = await makePrivate(path.join(directory, 'bundles'));
  const staging = await makePrivate(path.join(directory, 'staging'));
  const catalogue = path.join(directory, 'catalogue.json');
  const lock = path.join(directory, 'write.lock');
  const bundlePath = row => path.join(bundles, row.id, row.version, row.digest);

  async function readState() {
    let state;
    try { state = JSON.parse((await readRegular(catalogue, 2 * 1024 * 1024, { privateFile: true })).toString('utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, installed: [], grants: [] };
      throw extensionError('invalid_extension_catalogue');
    }
    check(exact(state, ['schemaVersion', 'installed', 'grants']) && state.schemaVersion === 1 &&
      Array.isArray(state.installed) && state.installed.length <= 128 &&
      Array.isArray(state.grants) && state.grants.length <= 2048, 'invalid_extension_catalogue');
    const seen = new Set();
    for (const row of state.installed) {
      check(exact(row, ['id', 'version', 'digest', 'manifest', 'development']) &&
        typeof row.development === 'boolean', 'invalid_extension_catalogue');
      const manifest = validateManifest(row.manifest);
      check(row.id === manifest.id && row.version === manifest.version &&
        row.digest === bundleDigest(manifest) && !seen.has(row.id), 'invalid_extension_catalogue');
      seen.add(row.id);
    }
    state.grants.forEach(validateGrant);
    return state;
  }
  async function locked(action, signal) {
    checkCancelled(signal);
    await safeDirectory(directory, { owned: true });
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await lstat(lock);
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_extension_lock');
      await delay(20); checkCancelled(signal);
    }
    check(acquired, 'extension_registry_busy');
    try {
      const state = await readState();
      const result = await action(state);
      checkCancelled(signal);
      await atomicJSON(catalogue, state);
      return result;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  function rowFor(state, extension) {
    check(extensionId(extension), 'invalid_extension_id');
    const row = state.installed.find(value => value.id === extension);
    check(row, 'extension_not_installed');
    return row;
  }
  function currentGrant(state, row) {
    return state.grants.find(value => value.projectId === projectId &&
      value.extensionId === row.id && value.digest === row.digest && value.approved) ?? null;
  }
  function describe(state, row, profiles = []) {
    return { ...row, profiles, grant: currentGrant(state, row) };
  }
  async function loadAssets(row) {
    const root = await safeDirectory(bundlePath(row), { owned: true });
    const manifest = validateManifest(JSON.parse((await readRegular(path.join(root, MANIFEST_FILE),
      L.manifestBytes, { privateFile: true })).toString('utf8')));
    check(bundleDigest(manifest) === row.digest, 'installed_manifest_changed');
    const inputs = {};
    for (const name of Object.keys(manifest.assets)) {
      inputs[name] = await readRegular(path.join(root, name), L.assetBytes, { privateFile: true });
    }
    const assets = validateAssets(manifest, inputs);
    return { manifest, assets, profiles: decisionProfiles(manifest, assets),
      digest: row.digest, development: row.development };
  }
  async function saveBundle(bundle, temporary) {
    const row = { id: bundle.manifest.id, version: bundle.manifest.version, digest: bundle.digest };
    const destination = bundlePath(row);
    try {
      await safeDirectory(destination, { owned: true });
      await loadAssets({ ...row, manifest: bundle.manifest });
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const root = await makePrivate(path.join(temporary, 'bundle'));
    await writeFile(path.join(root, MANIFEST_FILE), JSON.stringify(bundle.manifest), { flag: 'wx', mode: 0o400 });
    for (const [name, bytes] of Object.entries(bundle.assets)) {
      await makeParent(path.dirname(path.join(root, name)));
      await writeFile(path.join(root, name), bytes, { flag: 'wx', mode: 0o400 });
    }
    await makeParent(path.dirname(destination));
    // No existing immutable bundle is overwritten; install is serialized.
    await rename(root, destination);
  }
  async function install(source, { signal, dev = false } = {}) {
    check(typeof source === 'string' && source.length > 0 && source.length <= 4096, 'invalid_extension_source');
    checkCancelled(signal);
    const local = path.isAbsolute(source) || source.startsWith('./') || source.startsWith('../');
    check(!dev || local, 'development_directory_required');
    const temporary = await mkdtemp(path.join(staging, 'install-'));
    try {
      let bundle;
      if (local) bundle = await readLocalPackage(source, { signal });
      else {
        parsePackageSpec(source);
        let packed = await transport(source, { directory: temporary, signal });
        checkCancelled(signal);
        if (typeof packed === 'string') {
          const filename = path.resolve(packed);
          check(filename.startsWith(`${temporary}${path.sep}`), 'unsafe_transport_path');
          packed = await readRegular(filename, L.archiveBytes);
        }
        bundle = readPackageArchive(packed, source);
      }
      checkCancelled(signal);
      return await locked(async state => {
        await saveBundle(bundle, temporary);
        checkCancelled(signal);
        const row = { id: bundle.manifest.id, version: bundle.manifest.version, digest: bundle.digest,
          manifest: bundle.manifest, development: dev };
        // An update invalidates every project's old approval, including rollback
        // to a previously approved digest. Installation never approves access.
        const prior = state.installed.find(value => value.id === row.id);
        if (!prior || prior.digest !== row.digest) {
          state.grants = state.grants.filter(value => value.extensionId !== row.id);
        }
        state.installed = state.installed.filter(value => value.id !== row.id);
        state.installed.push(row);
        return describe(state, row, bundle.profiles);
      }, signal);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async function getAssets(extension, { digest: requestedDigest, assetPath: name } = {}) {
    const state = await readState(), row = rowFor(state, extension);
    check(requestedDigest === undefined || (digest(requestedDigest) && requestedDigest === row.digest),
      'extension_digest_changed');
    if (name !== undefined) check(assetPath(name) && Object.hasOwn(row.manifest.assets, name), 'unknown_extension_asset');
    const loaded = await loadAssets(row);
    return name === undefined ? loaded : {
      bytes: loaded.assets[name], contentType: name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/json',
      digest: row.digest, assetPath: name,
    };
  }
  async function grant(extension, request) {
    return locked(async state => {
      const row = rowFor(state, extension);
      check(exact(request, ['digest', 'fields', 'history', 'approved'], ['profiles']), 'invalid_extension_grant');
      check(request.digest === row.digest, 'extension_digest_changed');
      const value = validateGrant({ ...request, extensionId: extension, projectId, grantedAt: new Date().toISOString() });
      const capabilities = row.manifest.capabilities;
      for (const field of value.fields) {
        check(capabilities.includes(field === 'activity' ? 'activity.read' : 'model.read'), 'unrequested_data_field');
      }
      check(!value.history || capabilities.includes('history.read'), 'unrequested_history');
      if (value.profiles?.length) {
        check(capabilities.includes('analysis.request'), 'unrequested_analysis');
        const loaded = await loadAssets(row);
        check(value.profiles.every(profile => loaded.profiles.some(item => item.id === profile)), 'unrequested_profile');
      }
      state.grants = state.grants.filter(item => !(item.projectId === projectId && item.extensionId === extension));
      state.grants.push(value);
      return value;
    });
  }
  async function revoke(extension) {
    return locked(state => {
      rowFor(state, extension);
      state.grants = state.grants.filter(value => !(value.projectId === projectId && value.extensionId === extension));
      return { id: extension, revoked: true };
    });
  }
  async function remove(extension) {
    // Remove visibility and grants in one atomic write. Retained immutable
    // versions are inaccessible through getAssets after removal; keeping them
    // avoids deleting bytes held by a concurrent reader or a pinned checkpoint.
    return locked(state => {
      rowFor(state, extension);
      state.installed = state.installed.filter(value => value.id !== extension);
      state.grants = state.grants.filter(value => value.extensionId !== extension);
      return { id: extension, removed: true };
    });
  }
  async function doctor() {
    const results = [];
    let state;
    try { state = await readState(); }
    catch (error) { return { ok: false, results: [{ code: error.code ?? 'invalid_extension_catalogue' }] }; }
    for (const row of state.installed) {
      try { await loadAssets(row); results.push({ id: row.id, ok: true, code: 'verified', digest: row.digest }); }
      catch (error) { results.push({ id: row.id, ok: false, code: error.code ?? 'invalid_installed_extension' }); }
    }
    try { await lstat(lock); results.push({ ok: false, code: 'extension_registry_busy' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ok: results.every(value => value.ok), results };
  }
  async function dev(source, { signal, watch: watchChanges = false, onChange = () => {} } = {}) {
    check(path.isAbsolute(source) || source.startsWith('./') || source.startsWith('../'), 'development_directory_required');
    const installed = await install(source, { signal, dev: true });
    if (!watchChanges) return installed;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const done = (async () => {
      let last = installed.digest;
      try {
        for await (const event of watch(source, { recursive: true, signal: controller.signal })) {
          if (!event.filename) continue;
          try {
            const row = await install(source, { signal: controller.signal, dev: true });
            if (row.digest !== last) { last = row.digest; onChange({ ok: true, extension: row }); }
          } catch (error) {
            if (controller.signal.aborted) break;
            onChange({ ok: false, code: error.code ?? 'extension_reload_failed' });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) onChange({ ok: false, code: 'extension_watch_failed' });
      } finally { signal?.removeEventListener('abort', abort); }
    })();
    return { ...installed, close: abort, done };
  }
  return {
    list: async () => {
      const state = await readState(), rows = [];
      for (const row of state.installed) {
        const profiles = row.manifest.decisionProfiles?.length ? (await loadAssets(row)).profiles : [];
        rows.push(describe(state, row, profiles));
      }
      return rows;
    },
    install, remove, grant, revoke, getAssets, doctor, dev,
    getGrant: async extension => { const state = await readState(); return currentGrant(state, rowFor(state, extension)); },
  };
}
