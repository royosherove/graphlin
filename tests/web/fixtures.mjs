export function connectionInfo(overrides = {}) {
  return { projectRoot: '/fixture/Notes project', mode: 'live', instructions: [], notes: [], ...overrides };
}

export function reference(overrides = {}) {
  return {
    artifactId: 'artifact-1', hash: 'a'.repeat(64), generation: 1,
    eventId: 'event-1', startLine: 4, endLine: 9, sourceClass: 'source',
    basis: 'jev_interpretation', excerpt: 'database.save(note);', ...overrides,
  };
}

export function node(id = 'api', overrides = {}) {
  return {
    id, label: id === 'api' ? 'Notes API' : 'PostgreSQL',
    kind: id === 'api' ? 'service' : 'datastore',
    shape: id === 'api' ? 'rounded_rect' : 'cylinder',
    x: id === 'api' ? 50 : 380, y: 80,
    evidenceState: 'observed', activityState: 'idle',
    classification: 'accepted', validity: 'current',
    sourceRefs: [reference()],
    confidence: { supportProbability: .94, roleProbability: .91, roleConfidence: .86 },
    ...overrides,
  };
}

export function graph(revision = 1, overrides = {}) {
  return {
    schemaVersion: 1, revision,
    nodes: [node(), node('database')],
    edges: [{
      id: 'api-write-db', source: 'api', target: 'database', relation: 'writes',
      label: 'writes', evidenceState: 'observed', classification: 'accepted',
      validity: 'current', sourceRefs: [reference()], confidence: { supportProbability: .93 },
    }],
    ...overrides,
  };
}

export function activity(sequence = 1, overrides = {}) {
  return {
    schemaVersion: 1, id: `event-${sequence}`, projectId: 'project-1',
    sessionId: 'session-1', agentId: 'agent-1', toolCallId: `call-${sequence}`,
    kind: 'tool.succeeded', toolCategory: 'write', outcome: 'succeeded',
    at: '2026-09-19T09:00:00Z', sequence, incomplete: false,
    label: 'Tool completed', state: 'succeeded', ...overrides,
  };
}

export function snapshot(overrides = {}) {
  return {
    schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1',
    mode: 'live', paused: false,
    sessions: [{ id: 'session-1', label: 'Session 1' }, { id: 'session-2', label: 'Session 2' }],
    graph: graph(2), activity: [activity()],
    history: [{ revision: 1, at: '2026-09-19T09:00:00Z', graph: graph(1) }],
    status: { connection: 'connected', classifier: 'ready', coverage: 'tools_only', dropped: 0, pending: 0, calls: 2 },
    ...overrides,
  };
}
