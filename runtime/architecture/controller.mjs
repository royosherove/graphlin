import { pathPriority, selectPrioritized } from '../discovery/priority.mjs';

const MAX_PENDING = 10_000;
const BATCH_SIZE = 6;
const STATES = new Set(['waiting', 'queued', 'running', 'complete', 'partial', 'unavailable']);
const COVERAGE_REASONS = new Set(['source_withheld', 'unsupported_source', 'source_unavailable']);
const DIAGNOSTIC_CODES = new Set([
  ...COVERAGE_REASONS, 'architecture_complete', 'architecture_unknown', 'architecture_partial',
  'architecture_unavailable', 'architecture_cancelled', 'analysis_failed', 'decision_failure',
  'architecture_capture_failed', 'architecture_analysis_failed', 'architecture_commit_failed',
  'authentication_failed', 'missing_key', 'deadline_exceeded', 'remote_cooldown', 'queue_full',
  'request_too_large', 'response_too_large', 'transport_failure', 'http_error', 'request_rejected',
  'unknown_profile', 'invalid_input', 'invalid_result', 'invalid_bundle', 'invalid_response',
]);
const safeCode = value => DIAGNOSTIC_CODES.has(value) ? value : 'decision_failure';
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_PENDING ? value : 0;
const version = value => `${value.generation}:${value.hash}:${value.status}`;
const metadata = value => ({
  artifactId: value.id, generation: value.generation, hash: value.hash, status: value.status,
});
function outcome(result, id) {
  const coverage = result.coverage ?? {};
  if (coverage.analyzedArtifactIds?.includes(id)) return 'analyzed';
  if (coverage.withheldArtifactIds?.includes(id)) return 'withheld';
  if (coverage.unsupportedArtifactIds?.includes(id)) return 'unsupported';
  if (coverage.missingArtifactIds?.includes(id)) return 'checked';
  if (coverage.deferredArtifactIds?.includes(id)) return 'deferred';
  return 'unavailable';
}
function failed(result) {
  return result.diagnostics?.code === 'analysis_failed'
    || result.status === 'unavailable' && !COVERAGE_REASONS.has(result.diagnostics?.code)
      && result.diagnostics?.code !== 'architecture_partial'
      && (!result.coverage?.deferredArtifactIds?.length || result.coverage?.unavailableArtifactIds?.length > 0);
}
function completion(result, id, version) {
  const disposition = outcome(result, id), coverage = result.coverage ?? {};
  const analysisFailed = failed(result);
  const failure = analysisFailed && (coverage.failedArtifactIds?.length
    ? coverage.failedArtifactIds.includes(id) : ['analyzed', 'unavailable'].includes(disposition));
  const partial = disposition === 'deferred' || coverage.omittedCandidates > 0
    || result.status === 'partial' && !analysisFailed && !coverage.deferredArtifactIds?.length
      && !coverage.deferredMembershipArtifactIds?.length && !COVERAGE_REASONS.has(result.diagnostics?.code);
  return { version, outcome: disposition,
    reason: failure ? 'analysis_failed'
      : disposition === 'withheld' ? 'source_withheld'
        : disposition === 'unsupported' ? 'unsupported_source'
          : disposition === 'unavailable' ? 'source_unavailable'
            : partial ? 'partial_coverage' : null };
}
function counts(values) {
  const result = { attempted: 0, analyzed: 0, withheld: 0, unsupported: 0, unavailable: 0 };
  for (const value of values) {
    if (value.outcome === 'deferred') continue;
    result.attempted++;
    if (Object.hasOwn(result, value.outcome) && value.outcome !== 'attempted') result[value.outcome]++;
  }
  return result;
}

/** Coalesces observations. Captured source lives only for the active analysis job. */
export function createArchitectureController({
  snapshot, capture, commit, analyze, available = () => null, ready = () => true,
  onChange = () => {}, onDiagnostic = () => {}, now = Date.now, settleMs = 300,
}) {
  const known = new Map(), pending = new Map(), completed = new Map();
  const retries = new Map();
  let state = 'waiting', reason = 'no_source', timer, active, abort, activeVersions;
  let closed = false, epoch = 0, manual = false, omitted = 0, failures = 0, lastRunAt = null;
  let selectionCursor = 0;

  function status() {
    const model = snapshot();
    const supported = (model.interpretations ?? []).filter(value =>
      value.namespace === 'graphlin.architecture' && value.validity === 'current' &&
      value.support === 'supported' && value.classification === 'accepted');
    const blocked = available();
    const totals = counts(completed.values());
    return {
      status: blocked ? 'unavailable' : state,
      ...(blocked || reason ? { reason: blocked || reason } : {}),
      applications: supported.filter(value => value.kind === 'application').length,
      components: supported.filter(value => value.kind === 'component').length,
      pending: pending.size, inspected: totals.attempted, total: known.size, ...totals,
      omitted, failures, ...(lastRunAt === null ? {} : { lastRunAt }),
    };
  }
  function publish(next, why = null) {
    state = STATES.has(next) ? next : 'unavailable';
    reason = why;
    try { onChange(); } catch { /* Observation must remain fail-open. */ }
  }
  function publishCompleted() {
    const reasons = new Set([...completed.values()].map(value => value.reason));
    if (reasons.has('analysis_failed')) {
      publish(counts(completed.values()).analyzed ? 'partial' : 'unavailable', 'analysis_failed');
      return;
    }
    for (const why of ['source_withheld', 'source_unavailable', 'unsupported_source', 'source_changed', 'partial_coverage']) {
      if (reasons.has(why)) { publish('partial', why); return; }
    }
    if (omitted) { publish('partial', 'partial_coverage'); return; }
    const totals = status();
    publish('complete', totals.applications + totals.components ? null : 'none_supported');
  }
  function diagnostic(result, ids, stage = 'analysis') {
    try {
      onDiagnostic({
        status: COVERAGE_REASONS.has(result.diagnostics?.code) ? 'partial'
          : STATES.has(result.status) ? result.status : 'unavailable',
        code: safeCode(result.diagnostics?.failureCode ?? result.diagnostics?.code),
        reason: safeCode(result.diagnostics?.code), stage,
        ...counts(ids.map(id => ({ outcome: outcome(result, id) }))),
        deferred: boundedCount(result.coverage?.deferredArtifactIds?.length),
        providerRequests: boundedCount(result.diagnostics?.providerRequests),
      });
    } catch { /* Diagnostics cannot prevent admission or shutdown. */ }
  }
  function enqueue(id, { force = false } = {}) {
    const item = known.get(id);
    if (!item || (!force && completed.get(id)?.version === version(item))) return;
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
      known.set(artifact.id, { ...item, priority: pathPriority(artifact.relativePath) });
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
    const selected = selectPrioritized(pending.keys(), BATCH_SIZE, {
      cursor: selectionCursor, priority: id => pending.get(id).priority,
    });
    selectionCursor = selected.cursor;
    const ids = selected.values, generation = epoch;
    const selectedVersions = new Map(ids.map(id => [id, version(known.get(id))]));
    abort = new AbortController();
    const signal = abort.signal;
    let stage = 'capture';
    publish('running');
    active = (async () => {
      const artifacts = await capture(ids, { signal });
      if (closed || signal.aborted || generation !== epoch) return;
      const captured = new Map(artifacts.map(value => [value.id, metadata(value)]));
      activeVersions = new Map(ids.flatMap(id => known.has(id)
        ? [[id, version(captured.get(id) ?? known.get(id))]] : []));
      // Parsing can settle after a newer capture was observed. Never mark that
      // newer version inspected using an older capture.
      if (ids.some(id => activeVersions.get(id) !== version(known.get(id) ?? {}))) return;
      stage = 'analysis';
      const result = await analyze({ model: snapshot(), artifacts, affectedArtifactIds: ids, signal });
      if (closed || signal.aborted || generation !== epoch) return;
      diagnostic(result, ids);
      stage = 'commit';
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
          if (count >= 2) {
            pending.delete(id);
            completed.set(id, { version: activeVersions.get(id), outcome: 'unavailable', reason: 'source_changed' });
            failures++;
          }
        }
        publish(pending.size ? 'queued' : 'partial', 'source_changed');
        return;
      }
      if (Number.isSafeInteger(applied.omitted) && applied.omitted > 0) omitted += applied.omitted;
      const deferred = new Set(result.coverage?.deferredArtifactIds ?? []);
      const advanceNeighbors = !(applied.omitted > 0) && result.interpretations?.some(value =>
        value.namespace === 'graphlin.architecture' && value.kind === 'application' &&
        value.validity === 'current' && value.support === 'supported' && value.classification === 'accepted');
      const progressed = ids.some(id => !deferred.has(id));
      for (const id of ids) {
        if (activeVersions.get(id) !== version(known.get(id) ?? {})) continue;
        pending.delete(id);
        // Move budget-deferred captures to the back, so the next batch can
        // spend its source budget on them. Stop if a whole batch made no
        // progress (for example, no capture is available).
        if (deferred.has(id) && progressed) continue;
        completed.set(id, completion(result, id, activeVersions.get(id)));
      }
      for (const id of deferred) {
        // Follow an admitted application's evidence next. This changes queue
        // order only; a neighbor still needs its own supported interpretation.
        if (advanceNeighbors && known.has(id)) known.set(id, { ...known.get(id), priority: 0 });
        enqueue(id);
      }
      for (const id of result.coverage?.deferredMembershipArtifactIds ?? []) {
        const count = retries.get(id) ?? 0;
        if (count < 2) { retries.set(id, count + 1); enqueue(id, { force: true }); }
        else if (count === 2) { retries.set(id, 3); omitted++; }
      }
      lastRunAt = now();
      if (failed(result)) failures++;
      publishCompleted();
    })().catch(() => {
      if (!closed && !signal.aborted) {
        failures++;
        diagnostic({ status: 'unavailable', diagnostics: { code: `architecture_${stage}_failed` } }, ids, stage);
        const expectedVersions = activeVersions ?? selectedVersions;
        for (const id of ids) {
          if (expectedVersions.get(id) !== version(known.get(id) ?? {})) continue;
          pending.delete(id);
          if (known.has(id)) completed.set(id, {
            version: expectedVersions.get(id), outcome: 'unavailable', reason: 'analysis_failed',
          });
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
