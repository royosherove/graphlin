import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readPrivateJSON } from './paths.mjs';

export const MAX_MODEL_STATE_BYTES = 48 * 1024 * 1024;
const MAX_NODES = 2_000_000, MAX_DEPTH = 64;
const COLLECTIONS = ['entities', 'relations', 'interpretations', 'activity', 'sessions', 'checkpoints'];
const ROOT_FIELDS = new Set(['schemaVersion', 'projectId', 'revision', 'sequence', 'coverage', 'storage', ...COLLECTIONS]);
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const invalid = () => { throw new Error('invalid_model_state'); };

function validateSnapshot(value, projectId, depth = 0) {
  if (!plain(value) || depth > 8 || value.schemaVersion !== 2 || value.projectId !== projectId ||
      !natural(value.revision) || !natural(value.sequence) || !plain(value.coverage) ||
      Object.keys(value).some(key => !ROOT_FIELDS.has(key)) ||
      COLLECTIONS.some(key => !Array.isArray(value[key])) ||
      (value.storage !== undefined && !plain(value.storage))) invalid();
  for (const checkpoint of value.checkpoints) {
    if (!plain(checkpoint) || !id(checkpoint.id) ||
        (checkpoint.projectId !== undefined && checkpoint.projectId !== projectId)) invalid();
    if (checkpoint.state !== undefined) validateSnapshot(checkpoint.state, projectId, depth + 1);
  }
}

// Count exact UTF-8 JSON bytes before allocating the complete encoded snapshot.
// Reject cycles, getters and non-JSON values instead of executing toJSON hooks or
// silently losing Map/BigInt values. Undefined object fields are omitted, as in
// JSON.stringify: current policy uses them to withhold display/path metadata.
function boundedJSON(value, limit) {
  let size = 0, nodes = 0;
  const ancestors = new Set();
  const add = count => { size += count; if (size > limit) invalid(); };
  function string(value) {
    add(2);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92) add(2);
      else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff &&
          value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3);
    }
  }
  function visit(value, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { string(value); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value).length); return; }
    if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid();
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) invalid();
    add(2);
    if (Array.isArray(value)) {
      if (value.length > MAX_NODES || keys.length !== value.length + 1) invalid();
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
        if (i) add(1);
        visit(descriptor.value, depth + 1);
      }
    } else {
      let emitted = 0;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
        if (descriptor.value === undefined) continue;
        if (emitted++) add(1);
        string(key); add(1); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
  }
  visit(value, 0);
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) !== size || size > limit) invalid();
  return result;
}

function owned(info) {
  return process.getuid === undefined || info.uid === process.getuid();
}
async function safeDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) ||
      (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) invalid();
  return info;
}
async function safeDestination(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info) ||
        (info.mode & 0o077) !== 0) invalid();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/**
 * The parent MUST pass model.snapshot({ persistent: true }) under current policy.
 * This storage layer preserves that JSON (including storage/checkpoint state);
 * it is not an export projector, source reader, migration, or policy authority.
 *
 * Use a separate, canonical private path such as <project-data>/model-state.json.
 * The parent retains its existing state.json writer and owns daemon locking.
 * An omitted projectId binds to the first successfully loaded/scheduled model.
 */
export function createModelPersistence(filename, {
  projectId, maxBytes = MAX_MODEL_STATE_BYTES, debounceMs = 100, now = Date.now,
} = {}) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0') || !path.isAbsolute(filename) ||
      path.resolve(filename) !== filename || path.basename(filename).toLowerCase() === 'state.json' ||
      (projectId !== undefined && !id(projectId)) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MODEL_STATE_BYTES ||
      !Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 1000 || typeof now !== 'function') {
    throw new TypeError('invalid_model_persistence_options');
  }
  const directory = path.dirname(filename);
  let pending = null, timer = null, running = null, closing = null, closed = false;
  let failures = 0, writes = 0;

  async function write(body) {
    const parent = await safeDirectory(directory);
    await safeDestination(filename);
    const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
    let file, directoryHandle;
    try {
      directoryHandle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const opened = await directoryHandle.stat();
      if (opened.dev !== parent.dev || opened.ino !== parent.ino) invalid();
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o600);
      await file.writeFile(body, 'utf8');
      await file.sync();
      await file.close(); file = null;
      const current = await safeDirectory(directory);
      if (current.dev !== parent.dev || current.ino !== parent.ino) invalid();
      await safeDestination(filename);
      await rename(temporary, filename);
      try { await directoryHandle.sync(); }
      catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
      writes++;
    } finally {
      await file?.close().catch(() => {});
      await directoryHandle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  function drain() {
    if (running) return running;
    running = (async () => {
      while (pending !== null) {
        const body = pending; pending = null;
        try { await write(body); } catch { failures++; }
      }
    })().finally(() => { running = null; });
    return running;
  }
  async function flush() {
    do {
      clearTimeout(timer); timer = null;
      await drain();
    } while (pending !== null || running !== null);
  }
  async function load() {
    try {
      await safeDirectory(directory);
      const envelope = await readPrivateJSON(filename, maxBytes);
      if (!plain(envelope) || envelope.schemaVersion !== 2 || !id(envelope.projectId) ||
          (projectId !== undefined && envelope.projectId !== projectId) ||
          !natural(envelope.savedAt) || envelope.savedAt > now() + 60_000 ||
          Object.keys(envelope).some(key => !['schemaVersion', 'savedAt', 'projectId', 'snapshot'].includes(key))) invalid();
      // Revalidate the same depth, JSON and schema limits when reading a file
      // made by an older daemon. Never delete an incompatible or invalid file.
      boundedJSON(envelope, maxBytes);
      validateSnapshot(envelope.snapshot, envelope.projectId);
      projectId ??= envelope.projectId;
      return envelope.snapshot;
    } catch (error) {
      if (error?.code !== 'ENOENT') failures++;
      return undefined;
    }
  }
  function schedule(snapshot) {
    if (closed) return false;
    try {
      const savedAt = now();
      if (!natural(savedAt)) invalid();
      const candidateProjectId = projectId ?? (plain(snapshot)
        ? Object.getOwnPropertyDescriptor(snapshot, 'projectId')?.value : undefined);
      if (!id(candidateProjectId)) invalid();
      // Bounded serialization runs first, before reading any schema properties
      // that could otherwise invoke a caller-provided getter.
      const body = boundedJSON({ schemaVersion: 2, savedAt, projectId: candidateProjectId, snapshot }, maxBytes);
      validateSnapshot(snapshot, candidateProjectId);
      projectId ??= candidateProjectId;
      pending = body; // An immutable serialization, never a caller-owned object.
      if (!timer && !running) {
        timer = setTimeout(() => { timer = null; void drain(); }, debounceMs);
        timer.unref?.();
      }
      return true;
    } catch {
      failures++;
      return false;
    }
  }
  function close() {
    if (!closing) { closed = true; closing = flush(); }
    return closing;
  }
  return { load, schedule, flush, close,
    stats: () => ({ persistenceFailures: failures, writes, pending: pending !== null || running !== null, maxBytes }) };
}
