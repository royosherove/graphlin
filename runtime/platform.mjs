import path from 'node:path';
import { createInventory, extractStructure } from './discovery/index.mjs';
import { createProjectModel } from './model/index.mjs';
import { integer, isHash, isId } from './core/common.mjs';
import { relativePath, currentPolicy } from './model/records.mjs';

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|sql|ya?ml|json|toml|tf)$/i;
const QUEUE_LIMIT = 32, TRACKED_LIMIT = 10000, FILE_BYTES = 256 * 1024;
const version = artifact => `${artifact.hash}:${artifact.generation}`;
const eligiblePath = value => SOURCE.test(value) && !/(?:package-lock|pnpm-lock|yarn\.lock)/.test(value);

/** Coordinates bounded local exploration without coupling model facts to a view. */
export function createPlatform({
  projectRoot, projectId, policy = {}, restoredState, now = Date.now,
  accept = operation => operation(), revalidate = async () => true, onChange = () => {},
  extract = extractStructure,
}) {
  const model = createProjectModel({ projectId, policy, restoredState, now });
  let inventory = createInventory({ projectRoot, excludePaths: currentPolicy(policy).excludePaths });
  const parsed = new Map(), queue = new Map(), latest = new Map(), deferred = new Map(), undispatched = new Set();
  const errors = { failed: 0, stale: 0, omitted: 0 };
  let lineageId = model.snapshot().coverage.lineage?.id ?? null;
  let lineageEpoch = 0;
  let lastError = null;
  let active = null, processing = null, closed = false, finishedScanAt = null;

  function notify() {
    try {
      Promise.resolve(onChange()).catch(() => { lastError = 'observer_failed'; });
    } catch { lastError = 'observer_failed'; }
  }
  function rememberDeferred(artifact, reason) {
    if (!artifact.relativePath || !currentPolicy(policy).readSource) return;
    if (!deferred.has(artifact.id) && deferred.size >= TRACKED_LIMIT) { errors.omitted++; return; }
    // Deferred work retains names/versions only. Normal discovery/capture must
    // reacquire authorized source; overflow never becomes a hidden source cache.
    deferred.set(artifact.id, {
      id: artifact.id, relativePath: artifact.relativePath, hash: artifact.hash,
      generation: artifact.generation, reason,
    });
  }
  function failure(reason, artifact) {
    errors.failed++;
    lastError = reason;
    if (artifact && isCurrent(artifact)) rememberDeferred(artifact, reason);
    model.recordActivity({ kind: reason, outcome: 'unresolved', artifactIds: artifact ? [artifact.id] : [] });
    notify();
  }
  function isCurrent(artifact) {
    const observed = latest.get(artifact.id), effective = currentPolicy(policy);
    return !closed && effective.readSource && observed?.status === 'present' &&
      artifact.lineageId === lineageId && artifact.lineageEpoch === lineageEpoch && version(observed) === version(artifact) &&
      !!relativePath(artifact.relativePath, effective);
  }

  function pump() {
    if (active || closed || !queue.size) return;
    const [id, item] = queue.entries().next().value;
    queue.delete(id);
    const controller = new AbortController();
    processing = { id, artifact: item.artifact, version: version(item.artifact), controller };
    active = (async () => {
      const { artifact, event } = item;
      if (!isCurrent(artifact)) { errors.stale++; return; }
      const structure = await extract({
        artifactId: artifact.id, relativePath: artifact.relativePath, text: artifact.text,
        hash: artifact.hash, generation: artifact.generation, complete: artifact.complete, signal: controller.signal,
      });
      if (!isCurrent(artifact)) { errors.stale++; return; }
      let current;
      try { current = await revalidate([{ artifactId: id, hash: artifact.hash, generation: artifact.generation }]); }
      catch { failure('parse.revalidation_failed', artifact); return; }
      if (!current || !isCurrent(artifact)) {
        errors.stale++;
        if (isCurrent(artifact)) rememberDeferred(artifact, 'revalidation_required');
        return;
      }
      if (!structure?.enumeration || structure.enumeration.artifactId !== id ||
          version(structure.enumeration) !== version(artifact)) {
        failure('parse.invalid_result', artifact);
        return;
      }
      try { await accept(() => {
        // The worktree may advance between async revalidation and serialized
        // acceptance. Recheck here before either admission or cache completion.
        if (!isCurrent(artifact)) { errors.stale++; return; }
        const before = model.stats();
        model.observeStructure(structure, { event });
        const after = model.stats();
        if (after.revision === before.revision || after.deferred.entities > before.deferred.entities) {
          rememberDeferred(artifact, 'model_capacity');
          return;
        }
        if (structure.enumeration.omissions?.includes('parser_unavailable')) {
          failure('parse.unavailable', artifact);
          return;
        }
        parsed.set(id, version(artifact));
        deferred.delete(id);
        notify();
      }); } catch { failure('parse.accept_failed', artifact); }
    })().catch(() => {
      if (isCurrent(item.artifact) && !controller.signal.aborted) failure('parse.failed', item.artifact);
      else errors.stale++;
    }).finally(() => { active = null; processing = null; pump(); });
  }

  function retryPaths() {
    if (!currentPolicy(policy).readSource) return [];
    return [...deferred.values()].slice(0, QUEUE_LIMIT).flatMap(item => {
      const name = relativePath(item.relativePath, currentPolicy(policy));
      return name ? [path.join(projectRoot, name)] : [];
    });
  }
  function dispatch(limit) {
    const pending = [...new Set([...retryPaths(), ...undispatched])].slice(0, limit);
    for (const name of pending) undispatched.delete(name);
    // Sort the selected bounded batch, not the filesystem traversal. Metadata
    // displaced by retries remains pending for the next discovery slice.
    return pending.sort();
  }
  function stats() {
    return {
      queued: queue.size, active: active ? 1 : 0, deferred: deferred.size + undispatched.size, parsed: parsed.size,
      ...errors, lastError,
    };
  }
  return {
    model,
    async discover({ limit = 64 } = {}) {
      if (closed) return [];
      const batchLimit = integer(limit, 1) ? Math.min(limit, 64) : 64;
      try {
        if (finishedScanAt !== null) {
          if (now() - finishedScanAt < 5000) return dispatch(batchLimit);
          await inventory.close();
          inventory = createInventory({ projectRoot, excludePaths: currentPolicy(policy).excludePaths });
          finishedScanAt = null;
        }
        const result = await inventory.next({ limit: batchLimit });
        model.observeInventory(result);
        if (!result.continuation) finishedScanAt = now();
        for (const file of result.paths.filter(eligiblePath)) {
          if (undispatched.size < TRACKED_LIMIT) undispatched.add(path.join(projectRoot, file));
          else errors.omitted++;
        }
        return dispatch(batchLimit);
      } catch {
        failure('inventory.failed');
        return dispatch(batchLimit);
      }
    },
    observeArtifacts(artifacts, event) {
      if (closed || !Array.isArray(artifacts)) return;
      model.invalidateArtifacts(artifacts);
      const overflow = [];
      for (const input of artifacts.slice(0, TRACKED_LIMIT)) {
        if (!isId(input?.id) || !integer(input.generation, 1)) continue;
        const old = latest.get(input.id);
        if (old && (input.generation < old.generation || input.generation === old.generation &&
            (old.hash && input.hash && old.hash !== input.hash || old.status !== 'present' && input.status === 'present'))) {
          errors.stale++;
          continue;
        }
        if (!old && latest.size >= TRACKED_LIMIT) { errors.omitted++; continue; }
        const effective = currentPolicy(policy);
        const name = relativePath(input.relativePath, effective);
        const artifact = { id: input.id, relativePath: name, hash: input.hash,
          generation: input.generation, status: input.status, complete: input.complete === true, lineageId, lineageEpoch };
        latest.set(input.id, artifact);
        if (processing?.id === input.id && (processing.version !== version(artifact) || artifact.status !== 'present')) {
          processing.controller.abort();
        }
        if (!effective.readSource || !name || !eligiblePath(name) || !isHash(input.hash) ||
            typeof input.text !== 'string' || Buffer.byteLength(input.text) > FILE_BYTES || input.status !== 'present') {
          queue.delete(input.id);
          deferred.delete(input.id);
          parsed.delete(input.id);
          continue;
        }
        if (parsed.get(input.id) === version(artifact) ||
            processing?.id === input.id && processing.version === version(artifact) && processing.artifact.lineageEpoch === lineageEpoch) continue;
        if (!queue.has(input.id) && queue.size >= QUEUE_LIMIT) {
          if (!deferred.has(input.id)) overflow.push(input.id);
          rememberDeferred(artifact, 'queue_capacity');
          continue;
        }
        const correlation = event ? { id: event.id, kind: event.kind, sessionId: event.sessionId } : undefined;
        // A pre-tool event may accompany a real capture, but is not its source
        // attribution. Only the separately captured, revalidated bytes are parsed.
        queue.set(input.id, {
          artifact: { ...artifact, text: input.text },
          event: event?.kind === 'tool.requested' ? undefined : correlation,
        });
        deferred.delete(input.id);
      }
      if (overflow.length) model.recordActivity({ kind: 'parse.deferred', outcome: 'unresolved', artifactIds: overflow.slice(0, 256) });
      pump();
    },
    observeLineage(value) {
      const before = model.stats().revision;
      const result = model.observeLineage(value);
      const nextId = result.lineage?.id ?? null;
      if (result.changed) {
        lineageEpoch++;
        parsed.clear();
        queue.clear();
        deferred.clear();
        processing?.controller.abort();
        for (const artifact of latest.values()) rememberDeferred(artifact, 'lineage_changed');
      } else if (lineageId === null && nextId !== null) {
        // Initial metadata names the current work; it is not a branch switch.
        for (const item of queue.values()) item.artifact.lineageId = nextId;
        if (processing) processing.artifact.lineageId = nextId;
        for (const artifact of latest.values()) artifact.lineageId = nextId;
      }
      lineageId = nextId;
      if (model.stats().revision !== before) notify();
      return result;
    },
    observeLegacy(graph, options) { model.observeLegacy(graph, options); },
    recordActivity(event) { model.recordActivity(event); },
    setSessions(sessions) { model.setSessions(sessions); },
    snapshot(options) {
      const snapshot = model.snapshot(options);
      // Current queue status must not be mixed into a historical checkpoint.
      if (!options?.checkpointId) {
        snapshot.coverage.parsing = stats();
        snapshot.coverage.deferred.artifacts += deferred.size + undispatched.size + queue.size + (active ? 1 : 0);
        snapshot.coverage.unavailable += [...deferred.values()].filter(item => item.reason.startsWith('parse.')).length;
        snapshot.coverage.truncated ||= deferred.size > 0 || undispatched.size > 0 || errors.omitted > 0;
      }
      return snapshot;
    },
    stats,
    checkpoint(options) { return model.checkpoint(options); },
    async whenIdle() {
      while (active || queue.size) { pump(); if (active) await active; }
    },
    async close() {
      closed = true;
      queue.clear();
      deferred.clear();
      undispatched.clear();
      processing?.controller.abort();
      try { await inventory.close(); } catch { failure('inventory.close_failed'); }
      await active;
    },
  };
}
