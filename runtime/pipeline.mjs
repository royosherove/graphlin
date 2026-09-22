import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  createPolicy, normalizeHostEvent, metadataEvent, EvidenceStore,
  buildCandidates, emptyGraph, compileDecision, invalidateArtifacts,
  applyPatch, projectGraph,
} from './core/index.mjs';
import { safeLabel, safeText, excluded } from './core/privacy.mjs';
import { createPlatform } from './platform.mjs';
import { createArchitectureController } from './architecture/controller.mjs';
import { analyzeArchitecture, ARCHITECTURE_NAMESPACE } from './architecture/analysis.mjs';
import { classifyActivityTargets, isCurrentActivityTargetContext, ACTIVITY_TARGET_LIMITS } from './activity/targets.mjs';

const MAX_ACTIVITY = 200;
const MAX_HOOK_EVENTS = 200;
const MAX_HISTORY = 80;
const MAX_HISTORY_BYTES = 384 * 1024;
const MAX_RETENTION_BYTES = 1400 * 1024;
const MAX_SESSIONS = 16;
const MAX_DEDUP = 4000;
const MAX_LOCAL_QUEUE = 64;
const MAX_CLASSIFICATIONS = 2;
const MAX_CLASSIFICATION_QUEUE = 64;
const CLASSIFICATION_QUEUE_TTL_MS = 120_000;
const DEADLINE_MS = 2000;
const PENDING_LEASE_MS = 60_000;
const TERMINAL = new Set(['succeeded', 'failed', 'interrupted', 'unresolved']);
const FIXED_CLASSIFIER = new Set([
  'ready', 'metadata_only', 'missing_key', 'paused', 'unavailable', 'timeout', 'demo',
]);
const opaque = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);

function activityState(event) {
  if (event.kind === 'tool.requested') return 'pending';
  if (event.kind === 'tool.succeeded') return 'succeeded';
  if (event.kind === 'tool.failed' || event.kind === 'tool.denied') return 'failed';
  if (event.kind === 'tool.interrupted') return 'interrupted';
  if (event.kind === 'tool.unresolved') return 'unresolved';
  return 'observed';
}

function activityLabel(event) {
  const labels = {
    'session.started': 'Session started', 'turn.prompted': 'Request received',
    'intent.observed': 'Public intent observed', 'tool.requested': 'Tool requested',
    'tool.succeeded': 'Tool completed', 'tool.failed': 'Tool failed',
    'tool.denied': 'Tool denied', 'tool.interrupted': 'Tool interrupted',
    'tool.unresolved': 'Tool outcome unavailable', 'batch.completed': 'Tool batch completed',
    'artifact.changed': 'Source changed', 'verification.observed': 'Check result observed',
    'agent.started': 'Agent started', 'agent.stopped': 'Agent stopped',
    'turn.stopped': 'Turn ended', 'session.ended': 'Session ended',
    'capture.gap': 'Observation unavailable',
  };
  return labels[event.kind] ?? 'Activity observed';
}

function freshSession(id, label) {
  return { id, label, graph: emptyGraph(), activity: [], history: [] };
}

function restoreGraph(input, { stale = true } = {}) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.nodes) ||
      !Array.isArray(input.edges) || !Number.isSafeInteger(input.revision) ||
      input.revision < 0 || Object.keys(input).sort().join(',') !== 'edges,nodes,revision,schemaVersion') return emptyGraph();
  // Empty graphs have no legal patch operations, but their revision still
  // records real history (for example, removal of the final component).
  if (!input.nodes.length && !input.edges.length) return { ...emptyGraph(), revision: input.revision };
  try {
    // Validate the persisted finite grammar before importing it into live state.
    const graph = structuredClone(applyPatch(emptyGraph(), {
      schemaVersion: 1, id: opaque('restore'), baseRevision: 0, revision: 1, causedBy: [],
      operations: [
        ...input.nodes.map(node => ({ op: 'node.upsert', node })),
        ...input.edges.map(edge => ({ op: 'edge.upsert', edge })),
      ],
    }));
    graph.revision = Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0;
    for (const item of stale ? [...graph.nodes, ...graph.edges] : []) {
      item.validity = 'stale';
      item.classification = 'stale';
      if (item.evidenceState === 'verified') item.evidenceState = 'observed';
      if ('activityState' in item) item.activityState = 'unknown';
    }
    if (stale && graph.revision < Number.MAX_SAFE_INTEGER) graph.revision++;
    return graph;
  } catch {
    return emptyGraph();
  }
}

/**
 * Integrates independently testable modules. All artifact observations and graph
 * acceptance pass through one local sequence; remote classification runs outside it.
 */
export function createPipeline({
  projectRoot, policy: policyOptions, decisionService, onChange = () => {},
  onDiagnostic = () => {}, restoredState, restoredModel, mode = 'live', clock = Date.now,
  classificationDeadlineMs = DEADLINE_MS, missingKey = false,
} = {}) {
  if (!Number.isSafeInteger(classificationDeadlineMs) ||
      classificationDeadlineMs < DEADLINE_MS || classificationDeadlineMs > 10_000) {
    throw new TypeError('INVALID_CLASSIFICATION_DEADLINE');
  }
  const root = realpathSync(projectRoot);
  const inputRoot = path.resolve(projectRoot);
  const projectId = opaque(root);
  const modelProjectId = createHash('sha256').update(root).digest('hex');
  const policy = createPolicy(policyOptions ?? {});
  // Restored claims stay stale until recaptured, and their versions must never
  // collide with a new daemon's counters. No saved content is trusted here.
  let generationFloor = 0;
  const retainGeneration = value => {
    if (Number.isSafeInteger(value) && value > generationFloor && value < Number.MAX_SAFE_INTEGER) generationFloor = value;
  };
  const retainRefs = rows => {
    for (const row of Array.isArray(rows) ? rows.slice(0, 40000) : []) {
      for (const ref of Array.isArray(row?.sourceRefs) ? row.sourceRefs.slice(0, 16) : []) retainGeneration(ref.generation);
    }
  };
  if (restoredModel?.projectId === modelProjectId) {
    const artifacts = restoredModel.coverage?.artifacts;
    for (const artifact of Array.isArray(artifacts) ? artifacts.slice(0, 10000) : []) retainGeneration(artifact?.generation);
    for (const rows of [restoredModel.entities, restoredModel.relations, restoredModel.interpretations]) retainRefs(rows);
  }
  if (restoredState?.projectId === projectId) {
    const states = Array.isArray(restoredState.sessionStates) ? restoredState.sessionStates.slice(0, MAX_SESSIONS) : [];
    for (const session of [restoredState, ...states]) {
      retainRefs(session?.graph?.nodes); retainRefs(session?.graph?.edges);
    }
  }
  const evidence = new EvidenceStore({ projectRoot, policy, maxTrackedPaths: 10000, generationFloor });
  const sessions = new Map();
  const dedup = new Map();
  const sessionStarts = new Map();
  const hookEvents = [];
  const knownArtifacts = new Map();
  const lineageWork = new Set();
  const messageVersions = new Map();
  const deferredWork = new Map();
  const classificationQueue = [];
  const activeClassifications = new Set();
  const completedClassifications = new Map();
  const activityCalls = new Map(), activityMappingQueue = new Map(), activityMappings = new Map();
  const tasks = new Set();
  let selectedSession = null;
  let sequence = 0;
  let receipt = 0;
  let paused = false;
  let closed = false;
  let localQueue = 0;
  let dropped = 0;
  let pending = 0;
  let classifier = mode === 'demo' ? 'demo' : policy.transmitSource ? 'ready' : 'metadata_only';
  let serial = Promise.resolve();
  let reconciliationTask = null;
  let initialCaptureComplete = false;
  let resumeScheduled = false;
  let lineageId = null;
  let lineageAvailable = true, lineageEpoch = 0;
  let architecture;
  let architectureEpoch = 0;
  const architectureGuards = new WeakMap();

  const serialized = (fn) => {
    const operation = serial.then(fn);
    serial = operation.catch(() => {});
    return operation;
  };
  const platform = createPlatform({
    projectRoot: root, projectId: modelProjectId,
    policy, restoredState: restoredModel, now: clock,
    accept: operation => serialized(operation),
    revalidate: refs => serialized(async () => {
      if (closed || !lineageAvailable) return false;
      registerArtifacts(await evidence.reconcile({ refs }));
      return evidence.isCurrent(refs);
    }),
    onChange: () => { architecture?.wake(); wakeActivityMappings(); notify(); },
  });
  lineageAvailable = platform.snapshot().coverage.lineage?.status !== 'unavailable';
  architecture = createArchitectureController({
    snapshot: () => platform.snapshot(),
    capture: captureArchitecture,
    commit: commitArchitecture,
    analyze: async input => {
      const guard = {
        epoch: architectureEpoch, signal: input.signal, policyVersion: policy.version,
        lineageId: input.model.coverage.lineage?.id ?? modelProjectId,
      };
      const result = await analyzeArchitecture({ ...input, service: decisionService, policy });
      architectureGuards.set(result, guard);
      return result;
    },
    available: architectureUnavailable,
    onChange: notify,
    onDiagnostic: result => trace(null, 'classification', {
      status: result.status === 'complete' ? 'accepted' : result.status === 'partial' ? 'partial' : 'unavailable',
      reason: result.reason,
      diagnostics: { code: result.code, calls: result.providerRequests, architecture: {
        stage: result.stage, attempted: result.attempted, analyzed: result.analyzed,
        withheld: result.withheld, unsupported: result.unsupported, unavailable: result.unavailable,
        deferred: result.deferred,
      } },
    }),
    now: clock,
  });

  function architectureUnavailable() {
    if (closed) return 'closed';
    if (!policy.transmitSource) return 'source_consent_required';
    if (missingKey) return 'missing_key';
    if (paused) return 'paused';
    if (!lineageAvailable) return 'lineage_unavailable';
    if (mode === 'demo') return 'demo';
    if (typeof decisionService?.analyze !== 'function' || typeof decisionService?.evaluate !== 'function') {
      return 'unsupported_service';
    }
    return null;
  }

  async function captureArchitecture(ids, { signal } = {}) {
    const artifacts = await serialized(async () => {
      if (architectureUnavailable() || signal?.aborted) return [];
      const refs = ids.slice(0, 64).filter(id => knownArtifacts.has(id)).map(artifactId => ({ artifactId }));
      const captures = await evidence.reconcile({ refs });
      registerArtifacts(captures, undefined, { priority: true });
      return captures;
    });
    // Wait outside serialization for these versions only. Inventory can keep
    // adding unrelated work while their parser attempts settle.
    await platform.whenParsed(artifacts, { signal });
    return artifacts;
  }

  function commitArchitecture(result, context) {
    return serialized(async () => {
      const guard = architectureGuards.get(result);
      architectureGuards.delete(result);
      const current = () => guard && guard.signal === context.signal && !context.signal.aborted &&
        guard.epoch === architectureEpoch && guard.policyVersion === policy.version &&
        guard.lineageId === (lineageId ?? platform.snapshot().coverage.lineage?.id ?? modelProjectId) &&
        !architectureUnavailable();
      if (!current() || result.sourceRefs.length > 256 || context.artifacts.length > 64) return false;
      const expected = new Map();
      const sameVersion = (a, b) => a && b && a.hash === b.hash &&
        a.generation === b.generation && a.status === b.status;
      for (const value of [...context.artifacts, ...result.sourceRefs.map(ref => ({ ...ref, status: 'present' }))]) {
        if (!knownArtifacts.has(value.artifactId) ||
            expected.has(value.artifactId) && !sameVersion(expected.get(value.artifactId), value)) return false;
        expected.set(value.artifactId, value);
      }
      if (expected.size > 256) return false;
      const observed = new Map();
      const refs = [...expected.keys()].map(artifactId => ({ artifactId }));
      // Re-read all selected versions, including absence, and any extra
      // membership support. Retain metadata only across these bounded reads.
      for (let offset = 0; offset < refs.length; offset += 32) {
        const captures = await evidence.reconcile({ refs: refs.slice(offset, offset + 32) });
        registerArtifacts(captures);
        for (const artifact of captures) observed.set(artifact.id, {
          hash: artifact.hash, generation: artifact.generation, status: artifact.status,
          exists: artifact.exists, complete: artifact.complete,
        });
        if (!current()) return false;
      }
      if ([...expected].some(([id, value]) => !sameVersion(value, observed.get(id)))) return false;
      const missing = new Set(result.coverage.missingArtifactIds ?? []);
      const selected = new Set(context.artifacts.map(value => value.artifactId));
      for (const id of missing) {
        const value = observed.get(id);
        if (!selected.has(id) || value?.status !== 'missing' || value.hash !== null ||
            value.exists !== false || value.complete !== true) return false;
      }
      const withdrawn = new Set(result.coverage.withdrawnEntityIds ?? []);
      const model = platform.snapshot();
      const entities = new Map(model.entities.map(value => [value.id, value]));
      if ([...withdrawn].some(id => !missing.has(entities.get(id)?.artifactId))) return false;
      const affected = result.affectedEntityIds.filter(id => !withdrawn.has(id));
      let omitted = 0;
      if (affected.length || result.interpretations.length) {
        const replacement = platform.model.replaceInterpretations(ARCHITECTURE_NAMESPACE, result.interpretations, {
          affectedEntityIds: affected, sourceRefs: result.sourceRefs,
        });
        if (!replacement.accepted) return false;
        omitted = Math.max(0, result.interpretations.length - replacement.retained);
      }
      if (missing.size) {
        // Present-source guards cannot prove deletion. The serialized reread
        // above authorizes this clear, even when deleted anchors were evicted.
        const cleared = platform.model.replaceInterpretations(ARCHITECTURE_NAMESPACE, [], {
          affectedEntityIds: [...withdrawn], artifactIds: [...missing],
        });
        if (!cleared.accepted) return false;
      }
      return omitted ? { accepted: true, omitted } : true;
    });
  }

  function artifactMetadata(artifact) {
    const relative = artifact.relativePath;
    return {
      artifactId: artifact.id, status: artifact.status, complete: artifact.complete === true,
      ...(artifact.sourceReason === 'source_withheld' ? { reason: 'source_withheld' } : {}),
      ...(policy.transmitSource && (policy.displayEvidence || policy.persistEvidence) && typeof relative === 'string' &&
        safeText(relative, 4096) && !excluded(relative, policy) ? { path: relative } : {}),
    };
  }

  function candidateMetadata(candidates) {
    return candidates.map(candidate => ({
      candidateId: candidate.id, artifactId: candidate.artifactId,
      sourceClass: candidate.sourceClass, complete: candidate.complete,
      startLine: candidate.startLine, endLine: candidate.endLine,
      ...(policy.transmitSource && (policy.displayEvidence || policy.persistEvidence) && safeLabel(candidate.label)
        ? { label: candidate.label } : {}),
    }));
  }

  function trace(event, stage, detail = {}) {
    try {
      const record = {
        schemaVersion: 1, at: new Date(clock()).toISOString(), stage,
        ...(event ? { eventId: event.id, sessionId: event.sessionId,
          eventKind: event.kind, toolCategory: event.toolCategory } : {}),
        ...detail,
      };
      // Observers only receive a detached metadata record, never evidence objects.
      const pending = onDiagnostic(structuredClone(record));
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch { /* Logging cannot interrupt capture, classification, or acceptance. */ }
  }

  function classificationContext(candidates, sourceEventId) {
    const ids = new Set(candidates.map(candidate => candidate.artifactId));
    return {
      ...(sourceEventId ? { sourceEventId } : {}),
      artifacts: [...ids].flatMap(id => {
        const artifact = knownArtifacts.get(id);
        return artifact ? [{ ...artifact.metadata,
          candidateCount: candidates.filter(candidate => candidate.artifactId === id).length }] : [];
      }),
      candidates: candidateMetadata(candidates),
    };
  }

  function observedCandidates(event, artifacts, publicText, sourceEventId) {
    const extraction = [];
    const candidates = buildCandidates({
      event, artifacts, publicText, policy, onDiagnostic: entry => extraction.push(entry),
    });
    trace(event, 'candidates', {
      ...classificationContext(candidates, sourceEventId),
      artifacts: artifacts.map(artifact => {
        const entry = extraction.find(item => item.artifactId === artifact.id);
        return { ...artifactMetadata(artifact), candidateCount: entry?.selected ?? 0,
          availableCandidates: entry?.available ?? 0, reason: entry?.reason ?? 'no_candidates' };
      }),
      status: candidates.length ? 'ready' : 'skipped',
      reason: !policy.transmitSource ? 'metadata_only' : candidates.length ? 'candidates_ready' : 'no_candidates',
      diagnostics: { extraction },
    });
    return candidates;
  }

  function ensureSession(id) {
    if (sessions.has(id)) return sessions.get(id);
    if (sessions.size >= MAX_SESSIONS) {
      // Eviction loses live coverage for an old session; it never merges identities.
      const victim = [...sessions.keys()].find(key => key !== selectedSession);
      if (victim) evictSession(victim);
      dropped++;
    }
    const session = freshSession(id, `Session ${sessions.size + 1}`);
    sessions.set(id, session);
    selectedSession ??= id;
    platform.setSessions([...sessions.values()].map(item => ({ id: item.id, label: item.label })));
    return session;
  }

  function evictSession(id) {
    sessions.delete(id);
    syncSessions();
    deferredWork.delete(id);
    for (const [key, call] of activityCalls) if (call.event.sessionId === id) {
      activityCalls.delete(key); activityMappingQueue.delete(key); activityMappings.get(key)?.abort();
    }
    for (const key of completedClassifications.keys()) {
      if (key.startsWith(`${id}:`)) completedClassifications.delete(key);
    }
  }

  function syncSessions() {
    platform.setSessions([...sessions.values()].map(({ id, label, host, status, startedAt, endedAt }) =>
      ({ id, label, host, status, startedAt, endedAt })));
  }

  if (restoredState?.projectId === projectId) {
    const saved = Array.isArray(restoredState.sessionStates)
      ? [restoredState, ...restoredState.sessionStates.filter(s => s.id !== restoredState.sessionId)].slice(-MAX_SESSIONS)
      : [restoredState];
    for (const entry of saved) {
      const id = entry.sessionId ?? entry.id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) continue;
      const session = ensureSession(id);
      session.graph = restoreGraph(entry.graph);
      platform.observeLegacy(session.graph, { sessionId: session.id });
      // Activity is reconstructed through the metadata allowlist, never trusted verbatim.
      session.activity = (Array.isArray(entry.activity) ? entry.activity : [])
        .slice(-MAX_ACTIVITY).map(item => {
          const event = metadataEvent(item);
          return { ...event, label: activityLabel(event), state: activityState(event) };
        });
      session.history = (Array.isArray(entry.history) ? entry.history : []).slice(-MAX_HISTORY)
        .filter(item => Number.isSafeInteger(item.revision) && item.revision >= 0 &&
          item.graph?.revision === item.revision &&
          typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)))
        .map(item => ({ revision: item.revision, at: new Date(item.at).toISOString(),
          graph: restoreGraph(item.graph, { stale: false }) }))
        .filter(item => item.graph.revision === item.revision);
      if (session.graph.revision && session.history.at(-1)?.revision !== session.graph.revision) session.history.push({
        revision: session.graph.revision, at: new Date(clock()).toISOString(),
        graph: structuredClone(session.graph),
      });
    }
    if (sessions.has(restoredState.sessionId)) selectedSession = restoredState.sessionId;
    trimRetention();
  }

  function snapshotSession(session, persistent) {
    return {
      id: session.id, sessionId: session.id, label: session.label,
      graph: projectGraph(session.graph, policy, { persistent }),
      activity: structuredClone(session.activity),
      history: session.history.map(item => ({
        revision: item.revision, at: item.at,
        graph: projectGraph(item.graph, policy, { persistent }),
      })),
    };
  }

  function getState({ persistent = false } = {}) {
    const current = selectedSession ? sessions.get(selectedSession) : null;
    const view = current ? snapshotSession(current, persistent)
      : { graph: emptyGraph(), activity: [], history: [] };
    const stats = decisionService?.stats?.() ?? {};
    const calls = Number.isSafeInteger(stats.calls) ? stats.calls
      : Number.isSafeInteger(stats.requests) ? stats.requests : 0;
    const state = {
      schemaVersion: 1, projectId, sessionId: selectedSession,
      mode: mode === 'demo' ? 'demo' : 'live', paused,
      sessions: [...sessions.values()].map(session => ({ id: session.id, label: session.label })),
      graph: view.graph, activity: view.activity, history: view.history,
      status: {
        connection: closed ? 'closed' : 'connected',
        classifier: paused ? 'paused' : FIXED_CLASSIFIER.has(classifier) ? classifier : 'unavailable',
        coverage: 'Tools and public prompts; source observations have unknown authorship. Streamed reasoning is not captured.',
        dropped, pending, calls,
      },
    };
    if (persistent) {
      // The selected session is already at the root; avoid duplicating its graph.
      state.sessionStates = [...sessions.values()].filter(session => session.id !== selectedSession)
        .map(session => snapshotSession(session, true));
    } else state.hookEvents = structuredClone(hookEvents);
    return state;
  }

  function notify() {
    if (closed) return;
    try { onChange(getState()); } catch { /* Observers cannot break capture. */ }
  }

  function recordHook(event) {
    const metadata = metadataEvent(event);
    hookEvents.push({
      ...metadata, at: new Date(clock()).toISOString(),
      label: activityLabel(metadata), state: activityState(metadata), receipt: ++receipt,
    });
    if (hookEvents.length > MAX_HOOK_EVENTS) hookEvents.shift();
    // Receipt visibility is independent of queue admission, replay suppression,
    // and the coalesced activity list. Never retain the host payload here.
    notify();
  }

  function sessionStartIdentity(raw, event, host) {
    // Native hooks do not always supply an event ID. A fixed sequence gives
    // those starts a stable replay identity without hashing raw host content.
    // Without a host ID, identical repeated resumes cannot be distinguished
    // from transport replay and keep the same identity.
    const stable = normalizeHostEvent(raw, { host, projectId, sequence: 0, now: event.at }).event;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const source = ['startup', 'resume', 'clear', 'compact'].includes(payload?.source) ? payload.source : 'other';
    return { key: `${stable.id}:${source}`, follow: source !== 'compact' };
  }

  function recordPatch(session, patch) {
    if (!patch || !patch.operations?.length) return;
    session.graph = applyPatch(session.graph, patch);
    platform.observeLegacy(session.graph, { sessionId: session.id, fresh: true });
    session.history.push({
      revision: session.graph.revision, at: new Date(clock()).toISOString(),
      graph: structuredClone(session.graph),
    });
    if (session.history.length > MAX_HISTORY) session.history.shift();
    trimRetention();
  }

  function trimRetention() {
    const size = value => Buffer.byteLength(JSON.stringify(value));
    let historyBytes = [...sessions.values()].reduce((sum, session) => sum + size(session.history), 0);
    while (historyBytes > MAX_HISTORY_BYTES) {
      const owner = [...sessions.values()].filter(session => session.history.length)
        .sort((a, b) => a.history[0].at.localeCompare(b.history[0].at))[0];
      if (!owner) break;
      historyBytes -= size(owner.history.shift());
    }
    // Bound retained inactive sessions as well as replay. Eviction is reported
    // as lost coverage and cannot merge an old session into the selected one.
    while (sessions.size > 1 && size([...sessions.values()]) > MAX_RETENTION_BYTES) {
      const victim = [...sessions.keys()].find(id => id !== selectedSession);
      if (!victim) break;
      evictSession(victim);
      dropped++;
    }
  }

  function registerArtifacts(artifacts, event, options) {
    const changed = [];
    for (const artifact of artifacts) {
      const previous = knownArtifacts.get(artifact.id);
      if (!previous || previous.hash !== artifact.hash ||
          previous.generation !== artifact.generation || previous.status !== artifact.status) {
        changed.push(artifact);
      }
      knownArtifacts.set(artifact.id, {
        hash: artifact.hash, generation: artifact.generation, status: artifact.status,
        path: artifact.path, metadata: artifactMetadata(artifact),
      });
    }
    if (changed.length) {
      for (const session of sessions.values()) {
        const supported = new Set([...session.graph.nodes, ...session.graph.edges]
          .flatMap(item => item.sourceRefs.map(ref => ref.artifactId)));
        if (paused && policy.transmitSource) {
          const ids = changed.filter(artifact => supported.has(artifact.id)).map(artifact => artifact.id);
          if (ids.length) {
            let work = deferredWork.get(session.id);
            if (!work && deferredWork.size < MAX_SESSIONS) {
              work = { artifacts: new Set(), messages: new Map() };
              deferredWork.set(session.id, work);
            }
            if (work) for (const id of ids) {
              if (work.artifacts.size < 128) work.artifacts.add(id);
              else dropped++;
            }
          }
        }
        recordPatch(session, invalidateArtifacts(session.graph, changed));
      }
    }
    platform.observeArtifacts(artifacts, event, options);
    if (changed.length) architecture.observe(changed);
    return changed;
  }

  function addActivity(session, event, targets) {
    const state = activityState(event);
    const existing = event.toolCallId
      ? session.activity.findIndex(item => item.toolCallId === event.toolCallId &&
          item.agentId === event.agentId && item.kind?.startsWith('tool.'))
      : -1;
    const old = existing >= 0 ? session.activity[existing] : null;
    if (TERMINAL.has(old?.state) && state === 'pending') return old;
    const operation = event.operation ?? old?.operation;
    const mapping = targets?.mapping ?? (targets ? 'exact' : old?.mapping ?? 'exact');
    const row = { ...metadataEvent(event), label: activityLabel(event), state,
      ...(['read', 'edit'].includes(operation) ? {
        operation, mapping,
        entityIds: targets?.entityIds ?? old?.entityIds ?? [],
        artifactIds: targets?.artifactIds ?? old?.artifactIds ?? [],
        sourceRefs: state === 'pending' || mapping !== 'decision' ? [] : targets?.sourceRefs ?? old?.sourceRefs ?? [],
      } : {}),
    };
    platform.recordActivity(row);
    if (existing >= 0) {
      session.activity[existing] = row;
    } else {
      session.activity.push(row);
      if (session.activity.length > MAX_ACTIVITY) session.activity.shift();
    }
    if (operation) {
      const key = activityKey(row), previous = activityCalls.get(key);
      const call = previous ?? { key, session, versions: [] };
      call.event = row;
      call.paths = targets?.paths.length ? targets.paths : call.paths ?? [];
      if (targets?.lineRanges?.length && JSON.stringify(targets.lineRanges) !== JSON.stringify(call.lineRanges)) {
        call.lineRanges = targets.lineRanges;
        call.attempted = false;
        activityMappings.get(key)?.abort();
      }
      call.lineRanges ??= [];
      call.artifactIds = row.artifactIds;
      activityCalls.set(key, call);
      while (activityCalls.size > MAX_ACTIVITY) {
        const victim = activityCalls.keys().next().value;
        activityCalls.delete(victim); activityMappingQueue.delete(victim); activityMappings.get(victim)?.abort();
      }
    }
    return row;
  }

  const activityKey = event => `${event.sessionId}:${event.agentId}:${event.toolCallId ?? event.id}`;
  const sameSource = (left, right) => left.artifactId === right.artifactId &&
    left.hash === right.hash && left.generation === right.generation;

  async function retainTerminalMapping(event, targets, previous) {
    if (!TERMINAL.has(activityState(event)) || previous?.event.mapping !== 'decision' ||
        !previous.event.sourceRefs?.length || !targets || !lineageAvailable) return targets;
    const sameFiles = [...targets.artifactIds].sort().join(',') === [...previous.artifactIds].sort().join(',');
    if (!sameFiles) return targets;
    const epoch = lineageEpoch, refs = previous.event.sourceRefs;
    try {
      registerArtifacts(await evidence.reconcile({ refs }));
      if (epoch !== lineageEpoch || !lineageAvailable || !evidence.isCurrent(refs)) return targets;
      return { ...targets, mapping: 'decision', sourceRefs: refs,
        entityIds: [...new Set([...targets.entityIds, ...previous.event.entityIds])] };
    } catch { return targets; }
  }

  function finishPendingActivity(session, event) {
    for (const row of [...session.activity]) {
      if (row.state !== 'pending' || event.kind !== 'session.ended' && row.agentId !== event.agentId) continue;
      addActivity(session, { ...row, id: opaque(`${row.id}:${event.id}:finished`),
        kind: 'tool.unresolved', outcome: 'unresolved', at: event.at, incomplete: true });
    }
  }

  function observeActivityVersions(event, artifacts) {
    const call = activityCalls.get(activityKey(event));
    if (!call) return;
    const versions = artifacts.filter(artifact => call.artifactIds.includes(artifact.id) &&
      artifact.status === 'present' && artifact.hash).sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, ACTIVITY_TARGET_LIMITS.files)
      .map(artifact => ({ artifactId: artifact.id, hash: artifact.hash, generation: artifact.generation }));
    if (artifacts.some(artifact => call.artifactIds.includes(artifact.id)) &&
        JSON.stringify(versions) !== JSON.stringify(call.versions)) {
      call.versions = versions;
      call.attempted = false;
      activityMappings.get(call.key)?.abort();
    }
    if (!activityMappingAvailable()) {
      const reason = !policy.transmitSource ? 'metadata_only' : missingKey ? 'missing_key'
        : paused ? 'paused' : !lineageAvailable ? 'stale_evidence' : 'no_decision_service';
      if (call.fallbackReason !== reason) {
        call.fallbackReason = reason;
        traceActivityMapping(call, { status: 'unknown', entityIds: [] }, reason);
      }
    }
    wakeActivityMappings();
  }

  function activityMappingAvailable() {
    return !closed && !paused && lineageAvailable && !missingKey && mode !== 'demo' &&
      policy.transmitSource && typeof decisionService?.evaluate === 'function';
  }

  function traceActivityMapping(call, result, reason) {
    const accepted = result.status === 'accepted';
    const code = reason ?? (accepted ? 'approved' : result.status === 'unknown' ? 'no_accepted_classification'
      : result.diagnostics?.code === 'deadline_exceeded' ? 'deadline_exceeded'
        : result.status === 'cancelled' ? 'cancelled' : 'decision_failure');
    trace(call.event, 'classification', {
      status: accepted ? 'accepted' : result.status === 'unknown' ? 'abstained' : 'unavailable', reason: code,
      diagnostics: { code, candidatesOmitted: result.diagnostics?.omitted ?? 0,
        trace: { version: 1, requests: [{ status: accepted ? 'accepted' : 'unavailable', code,
          candidateCount: result.diagnostics?.candidates ?? 0, approvedCount: result.entityIds?.length ?? 0 }] } },
    });
  }

  function wakeActivityMappings() {
    if (!activityMappingAvailable()) return;
    for (const call of activityCalls.values()) {
      if (call.attempted || !call.versions.length || call.event.mapping === 'decision' ||
          clock() - Date.parse(call.event.at) > PENDING_LEASE_MS ||
          call.session.status === 'ended' || activityMappings.has(call.key)) continue;
      const current = platform.currentActivityTargets(call.paths);
      if (!call.versions.every(ref => current.sourceRefs.some(value => sameSource(ref, value)))) continue;
      if (!activityMappingQueue.has(call.key) && activityMappingQueue.size >= 32) {
        call.attempted = true; // Exact file attribution remains available at capacity.
        traceActivityMapping(call, { status: 'unknown', entityIds: [] }, 'queue_full');
        continue;
      }
      activityMappingQueue.set(call.key, call);
    }
    queueMicrotask(pumpActivityMappings);
  }

  function pumpActivityMappings() {
    if (!activityMappingAvailable()) return;
    while (activityMappingQueue.size && activityMappings.size < 2) {
      const [key, call] = activityMappingQueue.entries().next().value;
      activityMappingQueue.delete(key);
      if (activityCalls.get(key) !== call || call.attempted) continue;
      const controller = new AbortController();
      activityMappings.set(key, controller);
      call.attempted = true;
      const task = mapActivity(call, controller).catch(() => {
        traceActivityMapping(call, { status: 'unavailable', entityIds: [] }, 'decision_failure');
      }).finally(() => {
        if (controller.signal.aborted) call.attempted = false;
        activityMappings.delete(key);
        tasks.delete(task);
        wakeActivityMappings();
      });
      tasks.add(task);
    }
  }

  async function mapActivity(call, controller) {
    const epoch = lineageEpoch, policyVersion = policy.version, versions = call.versions, lineRanges = call.lineRanges;
    const current = () => activityMappingAvailable() && !controller.signal.aborted &&
      activityCalls.get(call.key) === call && sessions.get(call.event.sessionId) === call.session &&
      call.session.status !== 'ended' && lineageEpoch === epoch && policy.version === policyVersion &&
      call.versions === versions && call.lineRanges === lineRanges && clock() - Date.parse(call.event.at) <= PENDING_LEASE_MS;
    const model = await serialized(() => current() ? platform.snapshot() : null);
    if (!model || !current()) {
      traceActivityMapping(call, { status: 'cancelled', entityIds: [] }, 'stale_evidence');
      return;
    }
    const input = {
      service: decisionService, model, policy,
      event: { ...metadataEvent(call.event), projectId: modelProjectId, toolCategory: call.event.operation },
      artifactIds: versions.map(ref => ref.artifactId),
      namedEntityIds: platform.currentActivityTargets(call.paths).entityIds.slice(0, ACTIVITY_TARGET_LIMITS.namedEntities),
      lineRanges: lineRanges.filter(range => versions.some(ref => ref.artifactId === range.artifactId)),
      signal: controller.signal,
    };
    const result = await classifyActivityTargets(input);
    if (result.status !== 'accepted' || !result.entityIds.length) { traceActivityMapping(call, result); return; }
    if (!current()) { traceActivityMapping(call, { ...result, status: 'stale' }, 'stale_evidence'); return; }
    const applied = await serialized(async () => {
      if (!current() || result.provenance?.policyVersion !== policy.version ||
          result.provenance.lineageId !== (lineageId ?? modelProjectId) ||
          result.sourceRefs.some(ref => !versions.some(value => sameSource(ref, value)))) return;
      // Every context reference is checked. Activity retains one version per
      // artifact, not the classifier's larger set of symbol/relationship spans.
      registerArtifacts(await evidence.reconcile({ refs: versions }));
      if (!current() || !evidence.isCurrent(result.sourceRefs)) return;
      const fresh = platform.snapshot(), entities = new Map(fresh.entities.map(value => [value.id, value]));
      if (!isCurrentActivityTargetContext({ ...input, model: fresh, policy }, result)) return;
      if (result.entityIds.some(id => {
        const entity = entities.get(id);
        return !entity || entity.basis !== 'parsed' || entity.validity !== 'current' ||
          !versions.some(ref => ref.artifactId === entity.artifactId);
      })) return;
      const exact = platform.currentActivityTargets(call.paths);
      const entityIds = [...new Set([...exact.entityIds, ...result.entityIds])];
      const event = call.event;
      platform.recordActivity({ ...event, id: opaque(`${event.id}:mapped:${result.provenance.evidenceVersion}`),
        kind: 'activity.mapped', mapping: 'decision', entityIds, sourceRefs: versions,
        attribution: 'correlated', creation: false });
      const row = { ...event, mapping: 'decision', entityIds, sourceRefs: versions };
      const index = call.session.activity.indexOf(event);
      if (index >= 0) call.session.activity[index] = row;
      call.event = row;
      notify();
      return true;
    });
    traceActivityMapping(call, applied ? result : { ...result, status: 'stale' },
      applied ? undefined : 'stale_evidence');
  }

  function expirePending() {
    let changed = false;
    for (const session of sessions.values()) {
      for (let index = 0; index < session.activity.length; index++) {
        const row = session.activity[index];
        if (row.state !== 'pending' || clock() - Date.parse(row.at) < PENDING_LEASE_MS) continue;
        const event = {
          ...row, id: opaque(`${row.id}:expired`), kind: 'tool.unresolved',
          outcome: 'unresolved', at: new Date(clock()).toISOString(),
          sequence: ++sequence, incomplete: true,
        };
        addActivity(session, event);
        changed = true;
      }
    }
    return changed;
  }

  async function discoverPaths() {
    return platform.discover({ limit: 64 });
  }

  function settleInitialCapture(captured) {
    if (!closed && captured && !initialCaptureComplete &&
        ['complete', 'partial'].includes(platform.getDiscoveryStatus().inventory.status)) {
      initialCaptureComplete = true;
      notify();
    }
  }

  function canonicalNamedPaths(paths, raw, workingDirectory) {
    const aliases = [inputRoot];
    // A host can report a system alias such as /var instead of /private/var.
    // Normalize only an established project-root prefix, never child symlinks.
    if (typeof raw?.cwd === 'string') {
      try { if (realpathSync(raw.cwd) === root) aliases.push(path.resolve(raw.cwd)); } catch {}
    }
    const canonical = absolute => {
      for (const alias of aliases) {
        const relative = path.relative(alias, absolute);
        if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          return path.resolve(root, relative);
        }
      }
      return absolute;
    };
    let directory = root;
    if (workingDirectory !== undefined) {
      if (typeof workingDirectory !== 'string') return [];
      directory = canonical(path.resolve(inputRoot, workingDirectory));
      const relative = path.relative(root, directory);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
      try { if (realpathSync(directory) !== directory) return []; } catch { return []; }
    }
    return paths.slice(0, 32).filter(file => typeof file === 'string').map(file =>
      canonical(path.resolve(directory, file))).filter(absolute => {
      const relative = path.relative(root, absolute);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
  }

  function messageCurrent(candidate) {
    const ref = candidate.sourceRef;
    if (ref?.type !== 'message') return true;
    const current = messageVersions.get(ref.messageId);
    return current?.hash === ref.hash && current?.contentVersion === ref.contentVersion;
  }

  function observeMessage(event, text) {
    if (!['intent.observed', 'turn.prompted'].includes(event.kind)) return;
    const ref = {
      type: 'message', messageId: event.id,
      hash: createHash('sha256').update(text ?? '').digest('hex'),
      contentVersion: event.sequence,
    };
    const previous = messageVersions.get(ref.messageId);
    messageVersions.set(ref.messageId, ref);
    if (messageVersions.size > MAX_DEDUP) messageVersions.delete(messageVersions.keys().next().value);
    if (!previous || previous.hash === ref.hash) return;
    for (const session of sessions.values()) {
      const operations = [];
      const removed = new Set();
      for (const [kind, items] of [['node', session.graph.nodes], ['edge', session.graph.edges]]) {
        for (const item of items) {
          const refs = item.sourceRefs.filter(old => old.sourceRef?.messageId !== ref.messageId ||
            old.hash === ref.hash && old.generation === ref.contentVersion);
          if (refs.length === item.sourceRefs.length) continue;
          if (!refs.length) {
            operations.push({ op: `${kind}.remove`, id: item.id });
            if (kind === 'node') removed.add(item.id);
          } else {
            operations.push({ op: `${kind}.upsert`, [kind]: {
              ...item, sourceRefs: refs, classification: 'stale', validity: 'stale',
              evidenceState: refs.some(r => r.sourceClass === 'public_intent') ? 'proposed' : 'observed',
              ...(kind === 'node' ? { activityState: 'unknown' } : {}),
            } });
          }
        }
      }
      const effective = operations.filter(op => op.op !== 'edge.upsert' ||
        !removed.has(op.edge.source) && !removed.has(op.edge.target));
      if (effective.length) recordPatch(session, {
        schemaVersion: 1, id: opaque(`${event.id}:${event.sequence}:${session.id}:${session.graph.revision}`),
        baseRevision: session.graph.revision, revision: session.graph.revision + 1,
        causedBy: [event.id], operations: effective,
      });
    }
  }

  function deferClassification(event, candidates) {
    if (!candidates.length || !policy.transmitSource) return;
    let work = deferredWork.get(event.sessionId);
    if (!work) {
      if (deferredWork.size >= MAX_SESSIONS) { dropped++; return; }
      work = { artifacts: new Set(), messages: new Map() };
      deferredWork.set(event.sessionId, work);
    }
    for (const candidate of candidates) {
      if (candidate.sourceRef?.type === 'message') {
        if (!messageCurrent(candidate)) continue;
        if (!work.messages.has(event.id) && work.messages.size >= 16) { dropped++; continue; }
        work.messages.set(event.id, { event, candidates: candidates.filter(c =>
          c.sourceRef?.messageId === candidate.sourceRef.messageId) });
      } else if (work.artifacts.size < 128) work.artifacts.add(candidate.artifactId);
      else dropped++;
    }
  }

  function observationEvent(sessionId) {
    return {
      schemaVersion: 1, id: opaque(randomUUID()), projectId, sessionId,
      agentId: opaque(`${projectId}:unattributed`), toolCallId: null,
      kind: 'artifact.changed', toolCategory: 'other', outcome: 'observed',
      at: new Date(clock()).toISOString(), sequence: ++sequence, incomplete: false,
    };
  }

  async function flushDeferred() {
    if (closed || paused || !lineageAvailable || !deferredWork.size) return;
    const work = [...deferredWork];
    deferredWork.clear();
    const needed = new Set(work.flatMap(([, entry]) => [...entry.artifacts]));
    for (const [sessionId] of work) {
      for (const edge of sessions.get(sessionId)?.graph.edges ?? []) {
        if (edge.sourceRefs.some(ref => needed.has(ref.artifactId))) {
          edge.sourceRefs.forEach(ref => needed.add(ref.artifactId));
        }
      }
    }
    const artifacts = await evidence.reconcile({ refs: [...needed].map(artifactId => ({ artifactId })) });
    registerArtifacts(artifacts);
    for (const [sessionId, entry] of work) {
      const session = sessions.get(sessionId);
      if (!session) continue;
      const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
      const covered = new Set();
      const groups = new Map();
      // A relationship may need several files. Reassemble its currently
      // authorized dependencies instead of classifying each endpoint alone.
      for (const edge of session.graph.edges) {
        const ids = [...new Set(edge.sourceRefs.filter(ref => ref.sourceClass === 'source')
          .map(ref => ref.artifactId))].sort();
        if (!ids.some(id => entry.artifacts.has(id))) continue;
        if (groups.size >= 16) { dropped++; continue; }
        groups.set(ids.join(','), ids.flatMap(id => byId.has(id) ? [byId.get(id)] : []));
        ids.forEach(id => covered.add(id));
      }
      const remaining = artifacts.filter(a => entry.artifacts.has(a.id) && !covered.has(a.id));
      for (let index = 0; index < remaining.length; index += 4) {
        if (groups.size >= 16) { dropped += remaining.length - index; break; }
        const group = remaining.slice(index, index + 4);
        groups.set(group.map(a => a.id).join(','), group);
      }
      for (const group of groups.values()) {
        const event = observationEvent(sessionId);
        const candidates = observedCandidates(event, group, null);
        scheduleClassification(event, candidates);
      }
      for (const message of entry.messages.values()) {
        scheduleClassification(message.event, message.candidates.filter(messageCurrent));
      }
    }
    notify();
  }

  function sourceVersions(candidates) {
    return [...new Map(candidates.filter(candidate => candidate.sourceRef?.type !== 'message')
      .map(candidate => [candidate.artifactId, {
        artifactId: candidate.artifactId, hash: candidate.hash, generation: candidate.generation,
      }])).values()];
  }

  const versionKey = ref => `${ref.hash}:${ref.generation}`;
  const sourceIdentity = job => job.candidates.some(candidate => candidate.sourceRef?.type === 'message')
    ? null : sourceVersions(job.candidates).map(ref => ref.artifactId).sort().join(',');
  const classificationKey = job => `${job.event.sessionId}:${opaque(JSON.stringify([
    policy.version, job.lineageId,
    { kind: job.event.kind, toolCategory: job.event.toolCategory,
      outcome: job.event.outcome, incomplete: job.event.incomplete !== false },
    job.candidates.map(candidate => candidate.digest),
  ]))}`;

  function coverageReason(job) {
    if (!sourceIdentity(job)) return null;
    const key = classificationKey(job);
    // Only the exact ordered candidate input has been examined. A union of
    // individual file judgments does not cover a cross-file relationship, and
    // a small shared budget does not cover a later fuller Read. Order also
    // affects which finite relation proposals are considered. Include the event
    // metadata given to Jev: complete capture can promote an earlier tentative
    // judgment even when its candidate evidence has not changed.
    if (completedClassifications.has(key)) return 'source_version_completed';
    if ([...activeClassifications, ...classificationQueue].some(other =>
      other !== job && other.session === job.session && !other.controller?.signal.aborted &&
      other.lineageEpoch === job.lineageEpoch && classificationKey(other) === key)) {
      return 'source_version_pending';
    }
    return null;
  }

  function queueDiagnostics(job, extra = {}) {
    return { queue: {
      waitMs: Math.max(0, clock() - job.enqueuedAt),
      depth: classificationQueue.length, active: activeClassifications.size,
      capacity: MAX_CLASSIFICATION_QUEUE, ...extra,
    } };
  }

  function skipJob(job, reason, status = 'skipped') {
    trace(job.event, 'skip', {
      ...classificationContext(job.candidates, job.sourceEventId), status, reason,
      diagnostics: queueDiagnostics(job),
    });
  }

  function scheduleClassification(event, candidates, sourceEventId) {
    const context = classificationContext(candidates, sourceEventId);
    const skip = reason => trace(event, 'skip', { ...context, status: 'skipped', reason });
    if (closed) { skip('pipeline_closed'); return; }
    if (!policy.transmitSource) { skip('metadata_only'); return; }
    if (!candidates.length) { skip('no_candidates'); return; }
    if (!decisionService) { skip('classifier_unavailable'); return; }
    const session = sessions.get(event.sessionId);
    if (!session) { skip('session_evicted'); return; }
    if (paused || !lineageAvailable) {
      deferClassification(event, candidates); skip(paused ? 'paused_deferred' : 'source_withheld'); return;
    }
    const job = { event, candidates, sourceEventId, session, lineageId, lineageEpoch, enqueuedAt: clock(),
      needsRefresh: activeClassifications.size >= MAX_CLASSIFICATIONS };
    const covered = coverageReason(job);
    if (covered) { skipJob(job, covered); return; }
    const identity = sourceIdentity(job);
    const superseded = identity && classificationQueue.findIndex(other =>
      other.session === session && sourceIdentity(other) === identity &&
      sourceVersions(other.candidates).some(ref => !sourceVersions(candidates).some(current =>
        current.artifactId === ref.artifactId && versionKey(current) === versionKey(ref))));
    if (Number.isInteger(superseded) && superseded >= 0) {
      skipJob(classificationQueue[superseded], 'queued_source_superseded');
      job.needsRefresh = true;
      classificationQueue[superseded] = job;
    } else {
      if (classificationQueue.length >= MAX_CLASSIFICATION_QUEUE) {
        dropped++;
        skipJob(job, 'classification_queue_full');
        return;
      }
      pending++;
      classificationQueue.push(job);
    }
    trace(event, 'classification', { ...context, status: 'queued', reason: 'classification_queued',
      diagnostics: queueDiagnostics(job) });
    pumpClassifications();
  }

  function pumpClassifications() {
    if (closed || paused || !lineageAvailable) return;
    while (classificationQueue.length && activeClassifications.size < MAX_CLASSIFICATIONS) {
      const job = classificationQueue.shift();
      activeClassifications.add(job);
      job.controller = new AbortController();
      const task = runClassification(job).catch(() => {
        // Fixed diagnostics only: neither input nor API error bodies enter the feed.
        dropped++;
        classifier = 'unavailable';
        skipJob(job, 'classification_pipeline_error', 'failed');
      }).finally(() => {
        pending--;
        activeClassifications.delete(job);
        tasks.delete(task);
        pumpClassifications();
        notify();
      });
      tasks.add(task);
    }
  }

  async function refreshQueuedJob(job) {
    if (closed || sessions.get(job.event.sessionId) !== job.session) {
      skipJob(job, closed ? 'pipeline_closed' : 'session_evicted');
      return false;
    }
    if (paused || !lineageAvailable) {
      deferClassification(job.event, job.candidates);
      skipJob(job, paused ? 'paused_deferred' : 'source_withheld'); return false;
    }
    if (clock() - job.enqueuedAt >= CLASSIFICATION_QUEUE_TTL_MS) {
      dropped++;
      skipJob(job, 'classification_queue_expired');
      return false;
    }
    const before = sourceVersions(job.candidates);
    if (before.length) {
      // Queued snippets may no longer describe the worktree. Reauthorize and
      // reread the entire source before rebuilding any candidate from it.
      const artifacts = await evidence.capture(before.flatMap(ref => {
        const file = knownArtifacts.get(ref.artifactId)?.path;
        return file ? [file] : [];
      }));
      registerArtifacts(artifacts);
      const messages = job.candidates.filter(candidate =>
        candidate.sourceRef?.type === 'message' && messageCurrent(candidate));
      job.candidates = [...observedCandidates(job.event, artifacts, null, job.sourceEventId), ...messages].slice(0, 12);
      if (!job.candidates.length) { skipJob(job, 'queued_source_unavailable'); return false; }
      if (before.some(ref => !sourceVersions(job.candidates).some(current =>
        current.artifactId === ref.artifactId && versionKey(current) === versionKey(ref)))) {
        trace(job.event, 'classification', {
          ...classificationContext(job.candidates, job.sourceEventId),
          status: 'queued', reason: 'queued_source_refreshed', diagnostics: queueDiagnostics(job),
        });
      }
    } else {
      job.candidates = job.candidates.filter(messageCurrent);
      if (!job.candidates.length) { skipJob(job, 'source_changed_during_classification'); return false; }
    }
    const covered = coverageReason(job);
    if (covered) { skipJob(job, covered); return false; }
    return true;
  }

  async function runClassification(job) {
    if (job.needsRefresh && !await serialized(() => refreshQueuedJob(job))) return;
    const { event, candidates, sourceEventId, session } = job;
    const context = classificationContext(candidates, sourceEventId);
    const skip = reason => skipJob(job, reason);
    if (closed || job.controller.signal.aborted) {
      skip(closed ? 'pipeline_closed' : 'source_changed_during_classification'); return;
    }
    if (sessions.get(event.sessionId) !== session) { skip('session_evicted'); return; }
    if (paused || !lineageAvailable) {
      deferClassification(event, candidates); skip(paused ? 'paused_deferred' : 'source_withheld'); return;
    }
    if (clock() - job.enqueuedAt >= CLASSIFICATION_QUEUE_TTL_MS) {
      dropped++;
      skip('classification_queue_expired');
      return;
    }
    // Waiting for a free workflow does not spend Jev's configured active
    // deadline. The slot remains occupied until final local acceptance ends.
    const deadlineAt = clock() + classificationDeadlineMs;
    trace(event, 'classification', { ...context, status: 'started', reason: 'classification_started',
      diagnostics: queueDiagnostics(job) });
    let timer;
    let cancel;
    try {
      let result;
      try {
        const interrupted = new Promise(resolve => {
          cancel = () => resolve({ status: 'unavailable', diagnostics: { code: closed ? 'service_closed' : 'cancelled' } });
          job.controller.signal.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => {
            resolve({ status: 'timeout', diagnostics: { code: 'deadline_exceeded' } });
            job.controller.abort();
          }, classificationDeadlineMs);
        });
        result = await Promise.race([
          decisionService.classify({ event, candidates, policy, deadlineAt, signal: job.controller.signal }),
          interrupted,
        ]);
      } catch {
        result = { status: 'unavailable', diagnostics: { code: 'classifier_exception' } };
      }
      clearTimeout(timer);
      trace(event, 'classification', { ...context, status: result?.status ?? 'invalid',
        reason: result?.diagnostics?.code ?? result?.status ?? 'invalid_result',
        diagnostics: result?.diagnostics ?? {} });
      await serialized(async () => {
        if (closed || !sessions.has(event.sessionId)) { skip(closed ? 'pipeline_closed' : 'session_evicted'); return; }
        if (!lineageAvailable || job.lineageId !== lineageId || job.lineageEpoch !== lineageEpoch) {
          skip('source_changed_during_classification'); return;
        }
        if (paused) { deferClassification(event, candidates); skip('paused_deferred'); notify(); return; }
        if (clock() >= deadlineAt) { classifier = 'timeout'; dropped++; skip('deadline_before_apply'); notify(); return; }
        if (result.status === 'timeout') classifier = 'timeout';
        else if (result.status === 'unavailable') {
          classifier = result.diagnostics?.code === 'missing_key' ? 'missing_key' : 'unavailable';
        } else if (result.status === 'invalid' || result.status === 'overloaded') {
          classifier = 'unavailable';
        } else classifier = mode === 'demo' ? 'demo' : 'ready';
        const bundle = result.bundle;
        if (['accepted', 'abstained', 'irrelevant'].includes(result.status) &&
            bundle?.policyVersion === policy.version && Array.isArray(bundle.candidates)) {
          // Reobserve the worktree before accepting remote answers; a tool could
          // have edited these files while either Jev request was in flight.
          registerArtifacts(await evidence.reconcile({ refs: sourceVersions(candidates) }));
          if (closed || sessions.get(event.sessionId) !== session) { skip(closed ? 'pipeline_closed' : 'session_evicted'); return; }
          if (!lineageAvailable || job.lineageEpoch !== lineageEpoch) { skip('source_changed_during_classification'); return; }
          if (paused) { deferClassification(event, candidates); skip('paused_deferred'); notify(); return; }
          const artifactRefs = sourceVersions(candidates);
          if (clock() >= deadlineAt) {
            classifier = 'timeout';
            dropped++;
            skip('deadline_after_revalidation');
          } else if (evidence.isCurrent(artifactRefs) && candidates.every(messageCurrent)) {
            // Remember only completed judgments over still-current source.
            // Timeouts, unavailable results, and stale answers remain retryable.
            const remember = () => {
              if (!artifactRefs.length) return;
              completedClassifications.set(classificationKey(job), true);
              if (completedClassifications.size > MAX_DEDUP) {
                completedClassifications.delete(completedClassifications.keys().next().value);
              }
            };
            if (result.status === 'irrelevant') {
              remember();
              skip('classification_not_drawable');
              notify();
              return;
            }
            const before = session.graph;
            const admission = [];
            const patch = compileDecision(before, { event, decision: result, policy,
              onDiagnostic: entry => admission.push(entry) });
            recordPatch(session, patch);
            // The legacy canvas cap is not a semantic admission cap. Compile
            // this bounded decision independently so the model can retain it.
            const independent = compileDecision(emptyGraph(), { event, decision: result, policy });
            if (independent) platform.observeLegacy(applyPatch(emptyGraph(), independent), { sessionId: session.id, fresh: true });
            remember();
            const after = session.graph;
            const counts = { revisionBefore: before.revision, revisionAfter: after.revision };
            for (const kind of ['nodes', 'edges']) {
              const previous = new Map(before[kind].map(item => [item.id, item]));
              const current = new Map(after[kind].map(item => [item.id, item]));
              counts[`${kind}Added`] = [...current.keys()].filter(id => !previous.has(id)).length;
              counts[`${kind}Removed`] = [...previous.keys()].filter(id => !current.has(id)).length;
              counts[`${kind}Updated`] = [...current].filter(([id, item]) =>
                previous.has(id) && JSON.stringify(previous.get(id)) !== JSON.stringify(item)).length;
            }
            trace(event, 'apply', { ...context, status: patch ? 'applied' : 'unchanged',
              reason: patch ? 'patch_applied' : 'no_graph_change', patch: counts, diagnostics: { admission } });
          } else {
            dropped++;
            skip('source_changed_during_classification');
          }
        } else skip(['accepted', 'abstained'].includes(result.status) ? 'invalid_bundle' : 'classification_not_drawable');
        notify();
      });
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener('abort', cancel);
    }
  }

  function scheduleSourceGroup(event, artifacts, sourceEventId) {
    const observation = {
      ...event, id: opaque(`${event.id}:snapshot:${artifacts.map(a => `${a.id}:${a.generation}`).join(',')}`),
      kind: 'artifact.changed', agentId: opaque(`${projectId}:unattributed`),
      toolCallId: null, toolCategory: 'other', outcome: 'observed',
    };
    scheduleClassification(observation, observedCandidates(observation, artifacts, null, sourceEventId), sourceEventId);
  }

  async function ingest(raw, { host = 'claude' } = {}) {
    if (closed) { trace(null, 'skip', { status: 'skipped', reason: 'pipeline_closed' }); return { accepted: false, reason: 'closed' }; }
    let prepared;
    try {
      prepared = normalizeHostEvent(raw, {
        host, projectId, sequence: ++sequence, now: new Date(clock()).toISOString(),
      });
    } catch {
      recordHook({
        projectId, id: opaque(randomUUID()), kind: 'capture.gap',
        sequence, at: new Date(clock()).toISOString(),
      });
      dropped++;
      trace(null, 'skip', { status: 'failed', reason: 'invalid_capture' });
      notify();
      return { accepted: false, reason: 'invalid' };
    }
    recordHook(prepared.event);
    if (localQueue >= MAX_LOCAL_QUEUE) {
      dropped++;
      trace(null, 'skip', { status: 'skipped', reason: 'capture_queue_full' });
      notify();
      return { accepted: false, reason: 'overloaded' };
    }
    localQueue++;
    let captured = false;
    try {
      return await serialized(async () => {
        if (closed) return { accepted: false, reason: 'closed' };
        const event = prepared.event;
        if (!event?.sessionId || !event.id) { dropped++; return { accepted: false, reason: 'invalid' }; }
        let followSession = false;
        const isMessage = ['intent.observed', 'turn.prompted'].includes(event.kind);
        const key = event.toolCallId && event.kind.startsWith('tool.')
          ? `${event.sessionId}:${event.agentId}:${event.toolCallId}:${event.kind}`
          : event.id;
        if (isMessage) {
          const hash = createHash('sha256').update(prepared.publicText ?? '').digest('hex');
          if (messageVersions.get(event.id)?.hash === hash) {
            trace(event, 'skip', { status: 'skipped', reason: 'duplicate_event' });
            return { accepted: true, duplicate: true };
          }
        } else if (event.kind === 'session.started') {
          const start = sessionStartIdentity(raw, event, host);
          if (sessionStarts.has(start.key)) {
            trace(event, 'skip', { status: 'skipped', reason: 'duplicate_event' });
            return { accepted: true, duplicate: true };
          }
          // Keep lifecycle replay identities apart from ordinary tool traffic,
          // including when the corresponding old session has been evicted.
          sessionStarts.set(start.key, true);
          if (sessionStarts.size > MAX_DEDUP) sessionStarts.delete(sessionStarts.keys().next().value);
          // Compaction can run in another active session. Its lifecycle receipt
          // remains visible without overriding the user's current session.
          followSession = start.follow;
        } else {
          if (dedup.has(key)) {
            trace(event, 'skip', { status: 'skipped', reason: 'duplicate_event' });
            return { accepted: true, duplicate: true };
          }
          dedup.set(key, true);
          if (dedup.size > MAX_DEDUP) dedup.delete(dedup.keys().next().value);
        }
        const session = ensureSession(event.sessionId);
        session.host = host;
        session.startedAt ??= event.at;
        session.status = event.kind === 'session.ended' ? 'ended' : 'active';
        if (event.kind === 'session.ended') session.endedAt = event.at;
        syncSessions();
        if (followSession) selectedSession = session.id;
        observeMessage(event, prepared.publicText);
        const requestedPaths = canonicalNamedPaths(prepared.activityPaths ?? [], raw, prepared.workingDirectory);
        const previousActivity = activityCalls.get(activityKey(event));
        let activityTargets = event.operation || previousActivity?.event.operation
          ? await platform.activityTargets(requestedPaths.length ? requestedPaths : previousActivity?.paths ?? []) : undefined;
        if (activityTargets) activityTargets.lineRanges = (prepared.activityRanges ?? []).slice(0, 32).flatMap(range => {
          const [absolute] = canonicalNamedPaths([range.path], raw, prepared.workingDirectory);
          if (!absolute) return [];
          const name = path.relative(root, absolute).split(path.sep).join('/');
          const index = activityTargets.paths.indexOf(name);
          return index >= 0 ? [{ artifactId: activityTargets.artifactIds[index],
            startLine: range.startLine, endLine: range.endLine }] : [];
        });
        activityTargets = await retainTerminalMapping(event, activityTargets, previousActivity);
        const activity = addActivity(session, event, activityTargets);
        if (['turn.stopped', 'agent.stopped', 'session.ended'].includes(event.kind)) finishPendingActivity(session, event);
        if (event.kind === 'capture.gap') dropped++;
        // Named-file intent is visible before source capture, parsing or any
        // remote enrichment. Their progress cannot delay the tool lifecycle.
        if (event.kind === 'session.started' || event.kind.startsWith('tool.') ||
            ['turn.stopped', 'agent.stopped', 'session.ended'].includes(event.kind)) notify();
        let artifacts = [];
        let namedSet = new Set();
        try {
          const named = [...new Set([...canonicalNamedPaths(prepared.paths ?? [], raw, prepared.workingDirectory), ...requestedPaths])];
          const discover = event.kind === 'session.started' ||
            ['tool.succeeded', 'tool.failed'].includes(event.kind);
          const sessionPaths = event.kind === 'session.started'
            ? [...knownArtifacts.values()].filter(item => item.status === 'present').slice(0, 64).map(item => item.path) : [];
          const paths = [...new Set([...named, ...sessionPaths, ...(discover ? await discoverPaths() : [])])];
          // EvidenceStore bounds each capture to 32 paths. Process the bounded
          // discovery list in chunks rather than silently losing its tail.
          for (let index = 0; index < paths.length; index += 32) {
            artifacts.push(...await evidence.capture(paths.slice(index, index + 32)));
          }
          const changed = registerArtifacts(artifacts, metadataEvent(event));
          captured = true;
          if (activity.id === event.id) observeActivityVersions(event, artifacts);
          trace(event, 'capture', { status: 'observed', reason: 'artifacts_observed',
            artifacts: artifacts.map(artifact => ({ ...artifactMetadata(artifact),
              reason: artifact.sourceReason === 'source_withheld' ? 'source_withheld'
                : changed.some(item => item.id === artifact.id) ? 'artifact_changed' : 'artifact_unchanged' })) });
          // A tool completion also reconciles prior support, including deletions
          // omitted from the tool's returned file list.
          if (event.kind.startsWith('tool.') && event.kind !== 'tool.requested') {
            registerArtifacts(await evidence.reconcile({ limit: 32 }));
          }
          namedSet = new Set(named.map(file => path.resolve(root, file)));
          // Global observation history is not a session's classification
          // history. A new session may discover entirely unchanged source.
          artifacts = artifacts.filter(a => discover || changed.some(c => c.id === a.id) || namedSet.has(a.path));
        } catch {
          dropped++;
          trace(event, 'skip', { status: 'failed', reason: 'capture_failed' });
        }
        notify();
        // Requests describe intentions. They cannot confirm future file content.
        if (event.kind !== 'tool.requested' && event.kind !== 'capture.gap') {
          if (artifacts.length && !prepared.publicText) {
            // Preserve explicit multi-file context in small groups. Incidental
            // discovery gets its own per-file budget, so a busy source file
            // cannot crowd the rest of an existing project out of the diagram.
            const named = artifacts.filter(artifact => namedSet.has(artifact.path));
            for (let index = 0; index < named.length; index += 4) {
              scheduleSourceGroup(event, named.slice(index, index + 4), event.id);
            }
            for (const artifact of artifacts.filter(artifact => !namedSet.has(artifact.path))) {
              scheduleSourceGroup(event, [artifact], event.id);
            }
          } else {
            const candidates = observedCandidates(event, artifacts, prepared.publicText, event.id);
            scheduleClassification(event, candidates, event.id);
          }
          notify();
        } else trace(event, 'skip', { status: 'skipped',
          reason: event.kind === 'tool.requested' ? 'tool_request_has_no_source_outcome' : 'unsupported_event' });
        return { accepted: true, eventId: event.id };
      });
    } catch {
      dropped++;
      trace(null, 'skip', { status: 'failed', reason: 'invalid_capture' });
      notify();
      return { accepted: false, reason: 'invalid' };
    } finally {
      localQueue--;
      settleInitialCapture(captured);
    }
  }

  function reconcile() {
    if (reconciliationTask) return reconciliationTask;
    if (closed || localQueue >= MAX_LOCAL_QUEUE) return Promise.resolve();
    localQueue++;
    let captured = false;
    reconciliationTask = serialized(async () => {
      if (closed) return;
      const expired = expirePending();
      const beforeModel = platform.model.stats();
      const paths = await discoverPaths();
      const artifacts = [];
      for (let index = 0; index < paths.length; index += 32) {
        artifacts.push(...await evidence.capture(paths.slice(index, index + 32)));
      }
      const known = await evidence.reconcile({ limit: 32 });
      const observed = [...artifacts, ...known];
      const changed = registerArtifacts(observed);
      captured = true;
      // Parser revalidation may have already refreshed a file's generation.
      // Retain canceled classifier work until this dispatch path sees it.
      for (const artifact of observed) {
        if (!lineageWork.delete(artifact.id)) continue;
        if (!changed.some(item => item.id === artifact.id)) changed.push(artifact);
      }
      if (!changed.length) {
        const afterModel = platform.model.stats();
        if (expired || beforeModel.revision !== afterModel.revision || beforeModel.sequence !== afterModel.sequence) notify();
        return;
      }
      const session = selectedSession ? sessions.get(selectedSession) : null;
      if (session) {
        const event = observationEvent(session.id);
        addActivity(session, event);
        trace(event, 'capture', { status: 'observed', reason: 'source_reconciliation',
          artifacts: changed.map(artifactMetadata) });
        for (let index = 0; index < changed.length; index += 4) {
          scheduleSourceGroup(event, changed.slice(index, index + 4), event.id);
        }
      } else trace(null, 'skip', { status: 'skipped', reason: 'no_session',
        artifacts: changed.map(artifactMetadata) });
      notify();
    }).finally(() => {
      localQueue--;
      reconciliationTask = null;
      settleInitialCapture(captured);
    });
    return reconciliationTask;
  }

  function setPaused(value) {
    const wasPaused = paused;
    paused = Boolean(value);
    if (wasPaused !== paused) architectureEpoch++;
    if (!wasPaused && paused) {
      for (const controller of activityMappings.values()) controller.abort();
      activityMappingQueue.clear();
      for (const job of classificationQueue.splice(0)) {
        deferClassification(job.event, job.candidates);
        skipJob(job, 'paused_deferred');
        pending--;
      }
    }
    if (wasPaused && !paused && !resumeScheduled) {
      resumeScheduled = true;
      serialized(flushDeferred).catch(() => { dropped++; })
        .finally(() => { resumeScheduled = false; });
    }
    architecture.wake();
    wakeActivityMappings();
    notify();
    return getState();
  }

  function observeLineage(lineage) {
    return serialized(() => {
      const available = lineage.status !== 'unavailable', wasAvailable = lineageAvailable;
      if (closed || lineage.id === lineageId && available === wasAvailable) return;
      const changed = lineage.id !== lineageId;
      lineageAvailable = available;
      platform.observeLineage(lineage);
      lineageId = lineage.id;
      if (changed || !available) {
        for (const controller of activityMappings.values()) controller.abort();
        activityMappingQueue.clear();
        lineageEpoch++;
        architectureEpoch++;
        for (const job of activeClassifications) {
          if (!available) deferClassification(job.event, job.candidates);
          job.controller.abort();
        }
        for (const job of classificationQueue.splice(0)) {
          if (!available) deferClassification(job.event, job.candidates);
          pending--;
          skipJob(job, 'source_changed_during_classification');
        }
      }
      if (changed) {
        architecture.invalidate();
        completedClassifications.clear();
        for (const artifactId of knownArtifacts.keys()) lineageWork.add(artifactId);
        registerArtifacts(evidence.setLineage(lineage.id));
      } else architecture.wake();
      if (available && !wasAvailable && !paused) serialized(flushDeferred).catch(() => { dropped++; });
      wakeActivityMappings();
      notify();
    });
  }

  function selectSession(id) {
    if (!sessions.has(id)) return false;
    selectedSession = id;
    notify();
    return true;
  }

  async function whenIdle() {
    do {
      await serial;
      await platform.whenIdle();
      await serial;
      while (tasks.size || classificationQueue.length || activityMappingAvailable() && activityMappingQueue.size) {
        pumpClassifications();
        pumpActivityMappings();
        await Promise.allSettled([...tasks]);
        await serial;
      }
      await platform.whenIdle();
      await architecture.whenIdle();
      await serial;
    } while (tasks.size || classificationQueue.length || platform.stats().active || lineageAvailable && platform.stats().queued);
  }

  async function close() {
    if (closed) return;
    closed = true;
    architectureEpoch++;
    activityMappingQueue.clear();
    for (const controller of activityMappings.values()) controller.abort();
    const architectureClosed = architecture.close();
    deferredWork.clear();
    for (const job of classificationQueue.splice(0)) {
      skipJob(job, 'pipeline_closed');
      pending--;
    }
    for (const job of activeClassifications) job.controller.abort();
    decisionService?.close?.();
    await platform.close();
    await architectureClosed;
    await whenIdle();
  }

  return {
    ingest, getState, reconcile, observeLineage, setPaused, selectSession, whenIdle, close,
    getArchitectureStatus: () => architecture.status(),
    getDiscoveryStatus: () => ({ ...platform.getDiscoveryStatus(), initialCaptureComplete }),
    discoverArchitecture: () => { platform.retryCapacity(); return architecture.request(); },
    getModelState: options => platform.snapshot(options),
    createCheckpoint: options => platform.checkpoint(options),
    model: platform.model,
  };
}
