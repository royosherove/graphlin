import { realpathSync, lstatSync } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { plain } from '../core/common.mjs';
import { createPolicy, excluded, safeText } from '../core/privacy.mjs';

export const INVENTORY_LIMITS = Object.freeze({
  paths: 10000, entriesPerSlice: 512, milliseconds: 50, depth: 24, directories: 256, batch: 200,
});
const SKIP = new Set([
  '.git', '.graphlin', '.graphlin-local', '.graphlin-data', 'node_modules', 'dist', 'build',
  'coverage', '.next', '.cache', '.venv', 'venv', 'vendor', '__pycache__',
]);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const clamp = (value, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(max, value) : max;

/**
 * Bounded metadata-only traversal. The instance owns its continuation (directory
 * handles); callers resume by calling next(), and must close abandoned scans.
 * One lane per top-level directory prevents tooling from exhausting later roots.
 */
export function createInventory({ projectRoot, excludePaths = [], limits: options = {} } = {}) {
  options = plain(options) ? options : {};
  const limits = Object.fromEntries(Object.entries(INVENTORY_LIMITS).map(([key, max]) => [key, clamp(options[key], max)]));
  const policy = createPolicy({ excludePaths });
  let root, rootStat;
  try {
    root = realpathSync(projectRoot);
    rootStat = lstatSync(root);
    if (!rootStat.isDirectory()) throw new Error();
  } catch { throw new TypeError('INVALID_PROJECT_ROOT'); }
  const lanes = new Map([['.', [{ relative: '', depth: 0, handle: null, stamp: rootStat }]]]);
  let cursor = 0, sequence = 0, queued = 1, finished = false, closed = false, busy = false;
  const totals = { visited: 0, inventoried: 0, excluded: 0, symlinks: 0, unavailable: 0, deferred: 0 };
  const permanent = new Set();
  const rootCounts = new Map();
  async function closeDescriptor(descriptor) {
    if (descriptor.handle) await descriptor.handle.close().catch(() => {});
    descriptor.handle = null;
  }
  async function clear() {
    for (const lane of lanes.values()) for (const descriptor of lane) await closeDescriptor(descriptor);
    lanes.clear(); queued = 0;
  }
  async function validDirectory(descriptor) {
    const absolute = path.join(root, descriptor.relative);
    if (await realpath(root) !== root || !same(await lstat(root), rootStat)) return false;
    if (await realpath(absolute) !== absolute) return false;
    const stat = await lstat(absolute);
    return !stat.isSymbolicLink() && stat.isDirectory() && same(stat, descriptor.stamp);
  }
  function response(entries, reasons = []) {
    const omissions = [...new Set([...permanent, ...reasons])];
    return {
      paths: entries.filter(entry => entry.kind === 'file').map(entry => entry.relativePath),
      entries,
      continuation: finished || closed ? null : { sequence, pendingDirectories: queued },
      coverage: { ...totals, complete: finished && !closed && permanent.size === 0,
        pendingDirectories: queued, roots: [...rootCounts].map(([root, inventoried]) => ({ root, inventoried })),
        omissions },
    };
  }
  async function next({ limit = 64, signal } = {}) {
    if (busy) throw new TypeError('INVENTORY_BUSY');
    if (closed) return response([], ['closed']);
    if (finished) return response([]);
    if (signal?.aborted) return response([], ['aborted']);
    busy = true;
    const entries = [], reasons = [], start = performance.now();
    let visited = 0;
    limit = clamp(limit, limits.batch);
    try {
      while (lanes.size && entries.length < limit) {
        if (signal?.aborted) { reasons.push('aborted'); break; }
        if (visited >= limits.entriesPerSlice) { reasons.push('entry_limit'); break; }
        if (performance.now() - start >= limits.milliseconds) { reasons.push('time_limit'); break; }
        if (totals.inventoried >= limits.paths) {
          totals.deferred += queued;
          permanent.add('path_limit');
          finished = true;
          await clear();
          break;
        }
        const keys = [...lanes.keys()];
        cursor %= keys.length;
        const key = keys[cursor];
        const lane = lanes.get(key);
        const descriptor = lane.shift();
        queued--;
        let keep = false;
        try {
          if (!await validDirectory(descriptor)) throw new Error('DIRECTORY_CHANGED');
          if (!descriptor.handle) descriptor.handle = await opendir(path.join(root, descriptor.relative), { bufferSize: 1 });
          const entry = await descriptor.handle.read();
          if (!entry) {
            await closeDescriptor(descriptor);
          } else {
            keep = true;
            visited++; totals.visited++;
            const relativePath = descriptor.relative ? `${descriptor.relative}/${entry.name}` : entry.name;
            // Exclusions happen before stat, and rejected names are never
            // projected. A directory match includes a trailing slash so **/*
            // rules protect the directory itself as well as its children.
            if (SKIP.has(entry.name.toLowerCase()) || excluded(relativePath, policy) ||
                excluded(`${relativePath}/`, policy) || !safeText(relativePath, 4096) || /[\\\r\n]/.test(relativePath)) {
              totals.excluded++;
            } else if (entry.isSymbolicLink()) {
              totals.symlinks++; totals.excluded++;
            } else {
              const stat = await lstat(path.join(root, relativePath));
              if (stat.isSymbolicLink()) {
                totals.symlinks++; totals.excluded++;
              } else if (!await validDirectory(descriptor)) {
                throw new Error('DIRECTORY_CHANGED');
              } else if (stat.isFile() || stat.isDirectory()) {
                const rootName = relativePath.split('/')[0];
                entries.push({ relativePath, kind: stat.isDirectory() ? 'directory' : 'file',
                  size: stat.size, mtimeMs: stat.mtimeMs, root: descriptor.relative ? rootName : stat.isDirectory() ? rootName : '.' });
                totals.inventoried++;
                rootCounts.set(entries.at(-1).root, (rootCounts.get(entries.at(-1).root) ?? 0) + 1);
                if (stat.isDirectory()) {
                  if (descriptor.depth >= limits.depth) { totals.deferred++; permanent.add('depth_limit'); }
                  // The current descriptor is temporarily outside the queue.
                  else if (queued + 1 >= limits.directories) { totals.deferred++; permanent.add('directory_limit'); }
                  else {
                    const target = descriptor.relative ? key : rootName;
                    if (!lanes.has(target)) lanes.set(target, []);
                    lanes.get(target).push({ relative: relativePath, depth: descriptor.depth + 1, handle: null, stamp: stat });
                    queued++;
                  }
                }
              } else totals.excluded++;
            }
          }
        } catch {
          totals.unavailable++;
          permanent.add('unavailable');
          keep = false;
          await closeDescriptor(descriptor);
        }
        if (keep) { lane.push(descriptor); queued++; }
        if (!lane.length) {
          lanes.delete(key);
          // The next lane moved into this slot.
        } else cursor++;
      }
      sequence++;
      if (!lanes.size) finished = true;
      return response(entries, reasons);
    } finally { busy = false; }
  }
  return {
    next,
    async close() {
      if (busy) throw new TypeError('INVENTORY_BUSY');
      closed = true;
      await clear();
    },
  };
}
