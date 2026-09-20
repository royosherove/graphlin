const MAX_PENDING = 10_000;
const BATCH_SIZE = 6;
const STATES = new Set(['waiting', 'queued', 'running', 'complete', 'partial', 'unavailable']);
const version = value => `${value.generation}:${value.hash}:${value.status}`;
const metadata = value => ({
  artifactId: value.id, generation: value.generation, hash: value.hash, status: value.status,
});

/** Coalesces observations. Captured source lives only for the active analysis job. */
export function createArchitectureController({
  snapshot, capture, commit, analyze, available = () => null, ready = () => true,
  onChange = () => {}, onDiagnostic = () => {}, now = Date.now, settleMs = 300,
}) {
  const known = new Map(), pending = new Map(), completed = new Map();
  const retries = new Map();
  let state = 'waiting', reason = 'no_source', timer, active, abort, activeVersions;
  let closed = false, epoch = 0, manual = false, omitted = 0, failures = 0, lastRunAt = null;

  function status() {
    const model = snapshot();
    const supported = (model.interpretations ?? []).filter(value =>
      value.namespace === 'graphlin.architecture' && value.validity === 'current' &&
      value.support === 'supported' && value.classification === 'accepted');
    const blocked = available();
    return {
      status: blocked ? 'unavailable' : state,
      ...(blocked || reason ? { reason: blocked || reason } : {}),
      applications: supported.filter(value => value.kind === 'application').length,
      components: supported.filter(value => value.kind === 'component').length,
      pending: pending.size, inspected: completed.size, total: known.size,
      omitted, failures, ...(lastRunAt === null ? {} : { lastRunAt }),
    };
  }
  function publish(next, why = null) {
    state = STATES.has(next) ? next : 'unavailable';
    reason = why;
    try { onChange(); } catch { /* Observation must remain fail-open. */ }
  }
  function diagnostic(result) {
    try {
      onDiagnostic({
        status: result.status, code: result.diagnostics?.code ?? 'architecture_unavailable',
        analyzed: result.coverage?.analyzedArtifactIds?.length ?? 0,
        deferred: result.coverage?.deferredArtifactIds?.length ?? 0,
        providerRequests: result.diagnostics?.providerRequests ?? 0,
      });
    } catch { /* Diagnostics cannot prevent admission or shutdown. */ }
  }
  function enqueue(id, { force = false } = {}) {
    const item = known.get(id);
    if (!item || (!force && completed.get(id) === version(item))) return;
    if (!pending.has(id) && pending.size >= MAX_PENDING) { omitted++; return; }
    pending.set(id, item);
  }
  function wake() {
    if (closed) return;
    const blocked = available();
    if (blocked) {
      clearTimeout(timer); timer = null;
      abort?.abort();
      return;
    }
    if (active || timer || (!pending.size && !manual)) return;
    timer = setTimeout(() => {
      timer = null;
      if (!ready()) { wake(); return; }
      void run();
    }, settleMs);
    timer.unref?.();
  }
  function observe(artifacts) {
    if (closed) return;
    for (const artifact of artifacts) {
      const item = metadata(artifact), old = known.get(artifact.id);
      if (old && version(old) === version(item)) continue;
      if (!old && known.size >= MAX_PENDING) { omitted++; continue; }
      known.set(artifact.id, item);
      completed.delete(artifact.id);
      retries.delete(artifact.id);
      enqueue(artifact.id);
      if (activeVersions?.has(artifact.id) && activeVersions.get(artifact.id) !== version(item)) abort?.abort();
    }
    if (!active && pending.size) { state = 'queued'; reason = null; }
    wake();
  }
  async function run() {
    if (active || closed || available()) return active;
    clearTimeout(timer); timer = null;
    if (manual) {
      retries.clear();
      completed.clear();
      omitted = 0;
      for (const id of known.keys()) enqueue(id, { force: true });
      manual = false;
    }
    if (!pending.size) { publish('waiting', 'no_source'); return; }
    const ids = [...pending.keys()].slice(0, BATCH_SIZE), generation = epoch;
    abort = new AbortController();
    const signal = abort.signal;
    publish('running');
    active = (async () => {
      const artifacts = await capture(ids);
      if (closed || signal.aborted || generation !== epoch) return;
      const captured = new Map(artifacts.map(value => [value.id, metadata(value)]));
      activeVersions = new Map(ids.flatMap(id => known.has(id)
        ? [[id, version(captured.get(id) ?? known.get(id))]] : []));
      // Parsing can settle after a newer capture was observed. Never mark that
      // newer version inspected using an older capture.
      if (ids.some(id => activeVersions.get(id) !== version(known.get(id) ?? {}))) return;
      const result = await analyze({ model: snapshot(), artifacts, affectedArtifactIds: ids, signal });
      if (closed || signal.aborted || generation !== epoch) return;
      diagnostic(result);
      const applied = result.affectedEntityIds?.length || result.coverage?.missingArtifactIds?.length
        ? await commit(result, { artifacts: artifacts.map(metadata), signal, epoch: generation })
        : true;
      if (closed || signal.aborted || generation !== epoch) return;
      if (!applied || applied.accepted === false) {
        // A source race may be retried, but a persistently rejected admission
        // must not become an endless background classification loop.
        for (const id of ids) {
          if (activeVersions.get(id) !== version(known.get(id) ?? {})) continue;
          const count = (retries.get(id) ?? 0) + 1;
          retries.set(id, count);
          if (count >= 2) { pending.delete(id); completed.set(id, activeVersions.get(id)); failures++; }
        }
        publish(pending.size ? 'queued' : 'partial', 'source_changed');
        return;
      }
      if (Number.isSafeInteger(applied.omitted) && applied.omitted > 0) omitted += applied.omitted;
      const deferred = new Set(result.coverage?.deferredArtifactIds ?? []);
      const progressed = ids.some(id => !deferred.has(id));
      for (const id of ids) {
        if (activeVersions.get(id) !== version(known.get(id) ?? {})) continue;
        pending.delete(id);
        // Move budget-deferred captures to the back, so the next batch can
        // spend its source budget on them. Stop if a whole batch made no
        // progress (for example, no capture is available).
        if (deferred.has(id) && progressed) continue;
        completed.set(id, activeVersions.get(id));
        if (deferred.has(id)) failures++;
      }
      for (const id of deferred) enqueue(id);
      for (const id of result.coverage?.deferredMembershipArtifactIds ?? []) {
        const count = retries.get(id) ?? 0;
        if (count < 2) { retries.set(id, count + 1); enqueue(id, { force: true }); }
        else if (count === 2) { retries.set(id, 3); omitted++; }
      }
      lastRunAt = now();
      if (result.status === 'unavailable') { failures++; publish('unavailable', 'analysis_failed'); }
      else if (result.status === 'partial' || omitted) publish('partial', 'partial_coverage');
      else {
        const totals = status();
        publish('complete', totals.applications + totals.components ? null : 'none_supported');
      }
    })().catch(() => {
      if (!closed && !signal.aborted) {
        failures++;
        for (const id of ids) {
          if (activeVersions && activeVersions.get(id) !== version(known.get(id) ?? {})) continue;
          pending.delete(id);
          if (known.has(id)) completed.set(id, version(known.get(id)));
        }
        publish('unavailable', 'analysis_failed');
      }
    }).finally(() => {
      active = null; abort = null; activeVersions = null;
      if (!closed) {
        if (pending.size || manual) { state = 'queued'; wake(); }
        else if (state === 'running') publish(available() ? 'unavailable' : 'partial', available() || 'source_changed');
      }
    });
    return active;
  }
  function request() {
    if (!closed) {
      manual = true;
      publish('queued', available());
      wake();
    }
    return status();
  }
  function invalidate() {
    epoch++;
    abort?.abort();
    completed.clear();
    retries.clear();
    for (const id of known.keys()) enqueue(id, { force: true });
    wake();
  }
  return {
    observe, wake, request, status, invalidate,
    async whenIdle() {
      clearTimeout(timer); timer = null;
      while (!closed && !available() && (active || pending.size || manual)) {
        if (!ready()) break;
        await (active ?? run());
      }
      clearTimeout(timer); timer = null;
    },
    async close() {
      closed = true;
      clearTimeout(timer); timer = null;
      abort?.abort();
      pending.clear();
      await active;
      known.clear(); completed.clear(); retries.clear();
    },
  };
}
