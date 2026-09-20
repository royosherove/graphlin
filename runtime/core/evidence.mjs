import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, fail, freeze, hash, integer, isHash, opaque, plain } from './common.mjs';
import { createPolicy, excluded, privateText } from './privacy.mjs';

const absent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String).join(':');

export class EvidenceStore {
  #root; #inputRoot; #policy; #records = new Map(); #byId = new Map();
  #maxTrackedPaths; #reconcileCursor = 0; #lineage = null;
  constructor({ projectRoot, policy, maxTrackedPaths = LIMITS.trackedPaths } = {}) {
    try {
      this.#inputRoot = path.resolve(projectRoot);
      this.#root = realpathSync(projectRoot);
      if (!statSync(this.#root).isDirectory()) fail();
    } catch { fail('INVALID_PROJECT_ROOT'); }
    this.#policy = createPolicy(policy);
    this.#maxTrackedPaths = integer(maxTrackedPaths, 1, 20000) ? maxTrackedPaths : LIMITS.trackedPaths;
  }

  #locator(input) {
    if (typeof input !== 'string' || !input || input.length > 4096 || /[\0\r\n\\]/.test(input)) return null;
    let absolute = path.resolve(this.#root, input);
    // Accept the root spelling supplied by the caller (e.g. macOS /var ->
    // /private/var), while keeping the authority and stored identity canonical.
    const inputRelative = path.relative(this.#inputRoot, absolute);
    if (this.#inputRoot !== this.#root && inputRelative && inputRelative !== '..' &&
        !inputRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(inputRelative)) {
      absolute = path.resolve(this.#root, inputRelative);
    }
    const relative = path.relative(this.#root, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return { absolute, relative: relative.split(path.sep).join('/') };
  }

  async #inspect(locator) {
    // Fail closed on symlinks, including inside-root aliases. Never follow an
    // excluded path through a differently named alias.
    if (excluded(locator.relative, this.#policy)) {
      let stamp = 'excluded';
      try { stamp += `:${fingerprint(await lstat(locator.absolute, { bigint: true }))}`; } catch { /* No absence assertion through a policy exclusion. */ }
      return { status: 'unavailable', exists: null, complete: false, hash: null, text: null, stamp };
    }
    const parts = locator.relative.split('/');
    let current = this.#root;
    let finalStat;
    try {
      if (await realpath(this.#root) !== this.#root) return this.#unavailable('root_changed');
      for (const part of parts) {
        current = path.join(current, part);
        const stat = await lstat(current, { bigint: true });
        if (stat.isSymbolicLink()) return this.#unavailable(`symlink:${fingerprint(stat)}`);
        finalStat = stat;
      }
    } catch (error) {
      return absent(error) ? { status: 'missing', exists: false, complete: true, hash: null, text: null, stamp: 'missing' }
        : this.#unavailable('unreadable');
    }
    // Metadata consent permits names/stat observations, never content reads or
    // hashes. A local-source grant is distinct from permission to transmit it.
    if (!this.#policy.readSource) {
      if (!finalStat?.isFile()) return this.#unavailable('not_file');
      return { status: 'present', exists: true, complete: true,
        hash: null, text: null, stamp: fingerprint(finalStat) };
    }
    let handle;
    try {
      // NOFOLLOW closes the final-component race. Revalidate the complete path
      // and inode before and after reading to reject ancestor replacement races.
      handle = await open(locator.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = await handle.stat({ bigint: true });
      const stamp = fingerprint(before);
      if (!before.isFile() || (before.mode & 0o444n) === 0n) return this.#unavailable(stamp);
      if (before.size > BigInt(LIMITS.fileBytes)) return { status: 'partial', exists: true, complete: false, hash: null, text: null, stamp };
      if (!(await this.#sameFile(locator, before))) return this.#unavailable(stamp);
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (fingerprint(after) !== stamp || offset !== Number(before.size) || !(await this.#sameFile(locator, after))) {
        return { status: 'partial', exists: true, complete: false, hash: null, text: null, stamp: `unstable:${fingerprint(after)}` };
      }
      const bytes = buffer.subarray(0, offset);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
        return { status: 'partial', exists: true, complete: false, hash: hash(bytes), text: null, stamp };
      }
      if (text.includes('\0')) return { status: 'partial', exists: true, complete: false, hash: hash(bytes), text: null, stamp };
      return {
        status: 'present', exists: true, complete: true, hash: hash(bytes),
        text: !privateText(text) ? text : null, stamp,
      };
    } catch {
      // A disappearing/racing file during open/read is uncertainty. A subsequent
      // reconcile can confirm absence with a fresh path walk.
      return this.#unavailable('unreadable');
    } finally { if (handle) await handle.close().catch(() => {}); }
  }

  #unavailable(stamp) {
    return { status: 'unavailable', exists: null, complete: false, hash: null, text: null, stamp };
  }
  async #sameFile(locator, stat) {
    try {
      if (await realpath(locator.absolute) !== locator.absolute) return false;
      const current = await lstat(locator.absolute, { bigint: true });
      return current.isFile() && !current.isSymbolicLink() && fingerprint(current) === fingerprint(stat);
    } catch { return false; }
  }

  async #captureOne(locator) {
    const observed = await this.#inspect(locator);
    const previous = this.#records.get(locator.relative);
    const version = hash([this.#lineage, observed.status, observed.hash, observed.stamp]);
    const id = opaque('artifact', this.#root, locator.relative);
    const generation = previous ? previous.generation + (previous.version !== version ? 1 : 0) : 1;
    const artifact = {
      id, path: locator.absolute, relativePath: locator.relative,
      hash: observed.hash, generation, exists: observed.exists, status: observed.status,
      text: observed.text, complete: observed.complete,
    };
    // Registry retains no source bytes; returned captures are immutable private
    // snapshots. All path/cache cardinalities are bounded.
    const record = { ...locator, id, generation, hash: observed.hash, status: observed.status, version, lineage: this.#lineage };
    this.#records.set(locator.relative, record);
    this.#byId.set(id, record);
    return freeze(artifact);
  }

  async capture(paths = []) {
    if (!Array.isArray(paths)) return [];
    const results = [], seen = new Set();
    for (const input of paths.slice(0, LIMITS.paths)) {
      const locator = this.#locator(input);
      if (!locator || seen.has(locator.relative)) continue;
      seen.add(locator.relative);
      if (!this.#records.has(locator.relative) && this.#records.size >= this.#maxTrackedPaths) continue;
      results.push(await this.#captureOne(locator));
    }
    return results;
  }
  setLineage(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('INVALID_LINEAGE');
    if (id === this.#lineage) return [];
    this.#lineage = id;
    // A checkout change invalidates in-flight references immediately. The next
    // real capture advances each generation, even if its bytes are identical.
    return [...this.#records.values()].map(record => ({
      id: record.id, path: record.absolute, relativePath: record.relative,
      generation: record.generation, hash: record.hash, status: 'unavailable',
      complete: false, exists: null, text: null,
    }));
  }
  async reconcile({ refs, limit } = {}) {
    const results = [];
    let records;
    if (Array.isArray(refs)) {
      records = [...new Set(refs.slice(0, LIMITS.trackedPaths).map(ref => this.#byId.get(ref.artifactId)).filter(Boolean))];
    } else if (integer(limit, 1, this.#maxTrackedPaths)) {
      const all = [...this.#records.values()];
      const count = Math.min(limit, all.length);
      records = Array.from({ length: count }, (_, index) => all[(this.#reconcileCursor + index) % all.length]);
      this.#reconcileCursor = all.length ? (this.#reconcileCursor + count) % all.length : 0;
    } else records = [...this.#records.values()];
    for (const record of records) results.push(await this.#captureOne(record));
    return results;
  }
  isCurrent(refs) {
    if (!Array.isArray(refs) || refs.length > LIMITS.trackedPaths) return false;
    return refs.every(ref => {
      if (!plain(ref) || !isHash(ref.hash) || !integer(ref.generation, 1)) return false;
      const current = this.#byId.get(ref.artifactId);
      return current?.status === 'present' && current.lineage === this.#lineage &&
        current.hash === ref.hash && current.generation === ref.generation;
    });
  }
}
