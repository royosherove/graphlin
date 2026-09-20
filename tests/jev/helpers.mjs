import { createHash } from 'node:crypto';

export const MODEL = 'jev-1.13.0';
export const policy = Object.freeze({
  transmitSource: true, displayEvidence: true, persistEvidence: false,
  excludePaths: [], version: 'policy-1',
});
export const event = Object.freeze({
  schemaVersion: 1, id: 'event-1', projectId: 'project-1', sessionId: 'session-1',
  agentId: 'agent-1', toolCallId: 'tool-1', kind: 'tool.succeeded',
  toolCategory: 'edit', outcome: 'succeeded', at: 0, sequence: 1, incomplete: false,
});
export const wireEvent = {
  kind: 'tool.succeeded', toolCategory: 'edit', outcome: 'succeeded', incomplete: false,
};
export function candidate(id = 'c1', overrides = {}) {
  const value = {
    id, artifactId: `artifact-${id}`, hash: `hash-${id}`, generation: 1,
    label: id === 'c1' ? 'saveNote' : 'PostgreSQL',
    text: 'export function saveNote(note) { return db.insert(note); }',
    startLine: 1, endLine: 1, sourceClass: 'source', complete: true,
    entityKey: `entity-${id}`, labelOrigin: { type: 'span', startLine: 1, endLine: 1 },
    sourceRef: { type: 'artifact', artifactId: `artifact-${id}`, hash: `hash-${id}`, generation: 1 },
    ...overrides,
  };
  value.digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return value;
}
export function proposal(id = 'p1', overrides = {}) {
  return { id, sourceCandidateId: 'c1', targetCandidateId: 'c2', relation: 'writes',
    evidenceCandidateIds: ['c1', 'c2'], ...overrides };
}
export function input(overrides = {}) {
  return { event, candidates: [candidate()], policy, ...overrides };
}
export function makeCore({ proposals = [] } = {}) {
  const calls = { materialize: [], proposals: [] };
  return {
    calls,
    materializeBundle(args) {
      calls.materialize.push(args);
      const { candidates, verdicts, policy: currentPolicy, intakePolicy } = args;
      const approved = candidates.filter(c => {
        const matching = verdicts.filter(v => v.candidateId === c.id);
        return matching.length === 1 && matching[0].digest === c.digest
          && matching[0].sensitive <= intakePolicy.sensitiveMax
          && matching[0].relevant >= intakePolicy.relevantMin;
      });
      const readSet = approved.map(c => c.sourceRef.type === 'message' ? { ...c.sourceRef }
        : { artifactId: c.artifactId, hash: c.hash, generation: c.generation });
      const bundle = { id: 'bundle-1', policyVersion: currentPolicy.version,
        candidates: approved, readSet };
      calls.bundle = bundle;
      return bundle;
    },
    buildRelationProposals(bundle, limits) {
      calls.proposals.push({ bundle, limits });
      return { proposals, omitted: 0 };
    },
  };
}
// Literal scripted answers; these helpers never evaluate code semantics.
export function responseValue(request, changes = {}) {
  const answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const choice = id === 'a_activity' ? 'implement'
        : request.state.entities[Number(id.slice('b_role_'.length))]?.name === 'PostgreSQL'
          ? 'datastore' : 'module';
      answers[id] = {
        type: 'choice', choice, confidence: 0.95,
        probabilities: Object.fromEntries(Object.keys(question.criteria)
          .map(key => [key, key === choice ? 0.94 : key === 'other' || key === 'unknown' ? 0.06 : 0])),
      };
    } else {
      answers[id] = { type: 'noul', noul: id.startsWith('a_sensitive_')
        || id.startsWith('b_context_') ? 0.01 : 0.97 };
    }
  }
  Object.assign(answers, changes);
  return { model: MODEL, answers, usage: { input_tokens: 100, output_tokens: 10 } };
}
export function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
export function recordingTransport(transform = value => value) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, options, request });
    const result = await transform(responseValue(request), request, calls.length);
    return result instanceof Response ? result : jsonResponse(result);
  };
  return { fetchImpl, calls };
}
export function fakeClock(start = 0) {
  let now = start;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = ++nextId;
      timers.set(id, { fn, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = target;
    },
    get timers() { return timers.size; },
  };
}
export async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
export function stalledBody() {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"model":')); },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body), get cancelled() { return cancelled; } };
}
