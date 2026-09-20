import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { createPolicy, materializeBundle } from '../../runtime/core/index.mjs';

function accepted({ candidates, policy }) {
  const bundle = materializeBundle({
    candidates, policy,
    verdicts: candidates.map(candidate => ({
      candidateId: candidate.id, digest: candidate.digest, relevant: 0.99, sensitive: 0.01,
    })),
  });
  return {
    status: 'accepted', bundle, edges: [],
    nodes: bundle.candidates.map(candidate => ({
      candidateId: candidate.id, role: 'module', supportProbability: 0.99,
      roleProbability: 0.99, roleConfidence: 0.95,
      roleProbabilities: { module: 0.99, unknown: 0.01 }, classification: 'accepted',
    })),
    diagnostics: {},
  };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-session-hooks-'));
  const pipelines = [];
  let now = Date.now();
  t.after(async () => {
    try {
      for (const pipeline of pipelines) await pipeline.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    advance(milliseconds) { now += milliseconds; },
    now: () => now,
    open(options = {}) {
      const changes = [];
      const pipeline = createPipeline({
        projectRoot: root, clock: () => now,
        onChange: state => changes.push(state),
        ...options,
      });
      pipelines.push(pipeline);
      return { pipeline, changes };
    },
  };
}

const start = (session, extra = {}) => ({
  hook_event_name: 'SessionStart', session_id: session, ...extra,
});
const requested = (session, call, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: session,
  tool_name: 'Read', tool_use_id: call, ...extra,
});
const completed = (session, call, extra = {}) => ({
  hook_event_name: 'PostToolUse', session_id: session,
  tool_name: 'Read', tool_use_id: call, tool_response: { success: true }, ...extra,
});

test('a new session takes selection while the old classification is still running', async t => {
  const project = await workspace(t);
  let release;
  let calls = 0;
  const { pipeline, changes } = project.open({
    policy: createPolicy({ transmitSource: true, displayEvidence: true }),
    decisionService: {
      classify(input) {
        calls++;
        return new Promise(resolve => { release = () => resolve(accepted(input)); });
      },
      stats: () => ({ calls }),
      close() {},
    },
  });
  await pipeline.ingest(start('old-session'));
  const oldId = pipeline.getState().sessionId;
  await pipeline.ingest({
    hook_event_name: 'UserPromptSubmit', session_id: 'old-session',
    prompt: 'Propose function previousWorker() {}',
  });
  assert.equal(calls, 1);
  assert.equal(pipeline.getState().status.pending, 1);
  await pipeline.ingest(start('new-session', { source: 'clear' }));
  const newId = pipeline.getState().sessionId;
  assert.notEqual(newId, oldId);
  assert.equal(pipeline.getState().status.pending, 1, 'following does not wait for the old judgment');
  assert.deepEqual(pipeline.getState().graph.nodes, []);
  assert.ok(changes.some(state => state.sessionId === newId && state.status.pending === 1));

  release();
  await pipeline.whenIdle();
  assert.equal(pipeline.getState().sessionId, newId, 'an old result cannot switch selection back');
  assert.deepEqual(pipeline.getState().graph.nodes, []);
  await pipeline.ingest(completed('old-session', 'old-read'));
  assert.equal(pipeline.getState().sessionId, newId, 'an ordinary old tool cannot switch selection back');
  await pipeline.ingest(requested('third-session', 'third-read'));
  assert.equal(pipeline.getState().sessionId, newId, 'ordinary activity cannot claim selection');
  assert.equal(pipeline.selectSession(oldId), true);
  assert.deepEqual(pipeline.getState().graph.nodes.map(node => node.label), ['previousWorker']);
});

test('a replayed SessionStart cannot override a manual selection but still produces a receipt', async t => {
  const project = await workspace(t);
  const { pipeline, changes } = project.open();
  await pipeline.ingest(start('first-session', { event_id: 'first-start' }));
  const firstId = pipeline.getState().sessionId;
  const next = start('second-session', { event_id: 'second-start' });
  await pipeline.ingest(next);
  assert.notEqual(pipeline.getState().sessionId, firstId);
  const original = pipeline.getState().hookEvents.at(-1);
  pipeline.selectSession(firstId);
  const before = changes.length;
  project.advance(100);
  assert.equal((await pipeline.ingest(next)).duplicate, true);
  const state = pipeline.getState();
  assert.equal(state.sessionId, firstId);
  assert.equal(changes.length, before + 1, 'even a duplicate wakes the live viewer');
  assert.equal(state.hookEvents.at(-1).id, original.id, 'preserve the normalized event identity');
  assert.equal(state.hookEvents.at(-1).receipt, original.receipt + 1);
  assert.equal(state.hookEvents.at(-1).at, new Date(project.now()).toISOString());
});

test('native starts without event IDs are replay-safe, and a distinct resume follows the known session', async t => {
  const project = await workspace(t);
  const { pipeline } = project.open();
  await pipeline.ingest(start('first-session', { source: 'startup' }));
  const firstId = pipeline.getState().sessionId;
  const next = start('second-session');
  await pipeline.ingest(next);
  const secondId = pipeline.getState().sessionId;
  pipeline.selectSession(firstId);
  assert.equal((await pipeline.ingest(JSON.stringify(next))).duplicate, true);
  assert.equal(pipeline.getState().sessionId, firstId);
  pipeline.selectSession(secondId);

  const resume = start('first-session', { source: 'resume' });
  assert.equal((await pipeline.ingest(resume)).duplicate, undefined);
  assert.equal(pipeline.getState().sessionId, firstId);
  pipeline.selectSession(secondId);
  assert.equal((await pipeline.ingest(resume)).duplicate, true);
  assert.equal(pipeline.getState().sessionId, secondId);
  await pipeline.ingest({ ...resume, event_id: 'another-resume' });
  assert.equal(pipeline.getState().sessionId, firstId, 'a host-supplied new event ID identifies a later resume');
});

test('pre, post, and retransmitted hooks each retain a receipt while activity stays coalesced', async t => {
  const project = await workspace(t);
  const { pipeline, changes } = project.open();
  const pre = requested('one', 'same-call');
  const post = completed('one', 'same-call');
  await pipeline.ingest(pre);
  await pipeline.ingest(post);
  const count = changes.length;
  assert.equal((await pipeline.ingest(pre)).duplicate, true);
  assert.equal((await pipeline.ingest(post)).duplicate, true);
  const state = pipeline.getState();
  assert.deepEqual(state.hookEvents.map(row => row.receipt), [1, 2, 3, 4]);
  assert.deepEqual(state.hookEvents.map(row => row.kind),
    ['tool.requested', 'tool.succeeded', 'tool.requested', 'tool.succeeded']);
  assert.deepEqual(state.hookEvents.map(row => row.state), ['pending', 'succeeded', 'pending', 'succeeded']);
  assert.equal(state.hookEvents[0].id, state.hookEvents[2].id);
  assert.equal(state.hookEvents[1].id, state.hookEvents[3].id);
  assert.equal(new Set(state.hookEvents.map(row => row.toolCallId)).size, 1);
  assert.equal(state.activity.length, 1);
  assert.equal(state.activity[0].state, 'succeeded');
  assert.equal(changes.length, count + 2);
});

test('background compaction records a receipt without stealing the new session selection', async t => {
  const project = await workspace(t);
  const { pipeline, changes } = project.open();
  await pipeline.ingest(start('first-session', { source: 'startup' }));
  const firstId = pipeline.getState().sessionId;
  await pipeline.ingest(start('second-session', { source: 'clear' }));
  const secondId = pipeline.getState().sessionId;
  const before = changes.length;
  await pipeline.ingest(start('first-session', { source: 'compact' }));
  assert.equal(pipeline.getState().sessionId, secondId);
  assert.ok(changes.slice(before).every(state => state.sessionId === secondId));
  assert.equal(pipeline.getState().hookEvents.at(-1).sessionId, firstId);
  assert.equal(pipeline.getState().hookEvents.at(-1).kind, 'session.started');

  await pipeline.ingest(start('second-session', { source: 'compact' }));
  assert.equal(pipeline.getState().sessionId, secondId, 'current-session compaction keeps its selection');
  await pipeline.ingest(start('first-session', { source: 'resume' }));
  assert.equal(pipeline.getState().sessionId, firstId, 'an explicit resume still follows the older session');
});

test('historical payloads receive fresh local timestamps and ordinals without rewriting activity', async t => {
  const project = await workspace(t);
  const beganAt = project.now();
  let tick = beganAt;
  // Normalization and receipt capture read the clock independently, as they
  // would when time advances during intake.
  const { pipeline } = project.open({ clock: () => tick++ });
  const raw = requested('one', 'replayed-read', {
    at: '1999-01-01T00:00:00.000Z', timestamp: '1999-01-01T00:00:00.000Z',
  });
  await pipeline.ingest(raw);
  const activity = pipeline.getState().activity[0];
  assert.equal(activity.at, new Date(beganAt).toISOString());
  assert.equal(pipeline.getState().hookEvents[0].at, new Date(beganAt + 1).toISOString(),
    'a receipt stamps its own arrival rather than copying the normalized event time');

  tick += 1000;
  const replayAt = tick + 1;
  assert.equal((await pipeline.ingest(raw)).duplicate, true);
  const state = pipeline.getState();
  assert.deepEqual(state.hookEvents.map(row => row.receipt), [1, 2]);
  assert.deepEqual(state.hookEvents.map(row => row.at),
    [new Date(beganAt + 1).toISOString(), new Date(replayAt).toISOString()]);
  assert.equal(state.hookEvents[0].id, state.hookEvents[1].id);
  assert.deepEqual(state.activity, [activity], 'the receipt clock does not rewrite activity history');
});

test('replayed prompt receipts are visible without adding another public-intent activity', async t => {
  const project = await workspace(t);
  const { pipeline, changes } = project.open();
  const prompt = {
    hook_event_name: 'UserPromptSubmit', session_id: 'one',
    message_id: 'same-message', prompt: 'Inspect this existing project',
  };
  await pipeline.ingest(prompt);
  const before = changes.length;
  assert.equal((await pipeline.ingest(prompt)).duplicate, true);
  const state = pipeline.getState();
  assert.equal(state.activity.length, 1);
  assert.equal(state.hookEvents.length, 2);
  assert.equal(state.hookEvents[0].id, state.hookEvents[1].id);
  assert.equal(state.hookEvents[1].label, 'Request received');
  assert.equal(state.hookEvents[1].state, 'observed');
  assert.equal(changes.length, before + 1);
});

test('receipts are bounded across sessions, survive session eviction, and do not resurrect replayed sessions', async t => {
  const project = await workspace(t);
  const { pipeline } = project.open();
  const first = start('session-0', { event_id: 'start-0' });
  await pipeline.ingest(first);
  const evictedId = pipeline.getState().sessionId;
  for (let index = 1; index < 20; index++) {
    await pipeline.ingest(start(`session-${index}`, { event_id: `start-${index}` }));
  }
  const selected = pipeline.getState().sessionId;
  let state = pipeline.getState();
  assert.equal(state.sessions.length, 16);
  assert.equal(state.sessions.some(session => session.id === evictedId), false);
  assert.equal(state.hookEvents[0].sessionId, evictedId, 'receipt history is project-wide');
  assert.equal((await pipeline.ingest(first)).duplicate, true);
  assert.equal(pipeline.getState().sessionId, selected);
  assert.equal(pipeline.getState().sessions.some(session => session.id === evictedId), false);

  for (let index = 0; index < 220; index++) await pipeline.ingest(requested('session-19', `read-${index}`));
  state = pipeline.getState();
  assert.equal(state.hookEvents.length, 200);
  assert.deepEqual(state.hookEvents.map(row => row.receipt),
    Array.from({ length: 200 }, (_, index) => index + 42));
  assert.equal(state.sessionId, selected);
  assert.equal(state.sessions.length, 16);
});

test('hook metadata has a fixed allowlist and is detached from inputs and returned snapshots', async t => {
  const project = await workspace(t);
  const { pipeline, changes } = project.open({
    policy: createPolicy({ transmitSource: true, displayEvidence: true, persistEvidence: true }),
  });
  const secret = 'PRIVATE_HOOK_SENTINEL_451';
  const raw = completed(`${secret}-session`, `${secret}-call`, {
    event_id: `${secret}-event`, agent_id: `${secret}-agent`,
    tool_name: `${secret}-tool`,
    tool_input: { command: secret },
    tool_response: { stdout: secret, nested: { password: secret } },
    prompt: secret, text: secret, source: secret, name: secret,
    label: secret, state: secret, receipt: 98765,
    timestamp: '1999-01-01T00:00:00.000Z',
  });
  await pipeline.ingest(raw);
  const row = pipeline.getState().hookEvents[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'agentId', 'at', 'id', 'incomplete', 'kind', 'label', 'outcome',
    'projectId', 'receipt', 'schemaVersion', 'sequence', 'sessionId',
    'state', 'toolCallId', 'toolCategory',
  ].sort());
  assert.equal(row.label, 'Tool completed');
  assert.equal(row.state, 'succeeded');
  assert.equal(row.toolCategory, 'other');
  assert.equal(row.receipt, 1);
  assert.equal(row.at, new Date(project.now()).toISOString(), 'timestamp is local receipt time');
  assert.equal(JSON.stringify(pipeline.getState()).includes(secret), false);
  raw.tool_response.stdout = 'CHANGED_PAYLOAD';
  row.label = secret;
  changes[0].hookEvents[0].label = secret;
  assert.equal(pipeline.getState().hookEvents[0].label, 'Tool completed');
  assert.equal(JSON.stringify(pipeline.getState().hookEvents).includes(secret), false);
});

test('the live receipt feed is omitted from persistence and empty after a restore', async t => {
  const project = await workspace(t);
  const { pipeline } = project.open();
  await pipeline.ingest(start('restored-session'));
  await pipeline.ingest(requested('restored-session', 'old-call'));
  const saved = pipeline.getState({ persistent: true });
  assert.equal(Object.hasOwn(saved, 'hookEvents'), false);
  assert.ok(saved.sessionStates.every(session => !Object.hasOwn(session, 'hookEvents')));
  const sessionId = saved.sessionId;
  const restored = project.open({
    restoredState: { ...saved, hookEvents: [{ receipt: 999, prompt: 'DO_NOT_RESTORE_HOOKS' }] },
  }).pipeline;
  assert.equal(restored.getState().sessionId, sessionId);
  assert.ok(restored.getState().activity.length > 0, 'existing persisted activity still restores');
  assert.deepEqual(restored.getState().hookEvents, []);
  await restored.ingest(completed('restored-session', 'new-call'));
  assert.deepEqual(restored.getState().hookEvents.map(row => row.receipt), [1]);
  assert.equal(Object.hasOwn(restored.getState({ persistent: true }), 'hookEvents'), false);
});

test('receipt capture stays live when classification is paused and when the local queue is full', async t => {
  const project = await workspace(t);
  const { pipeline, changes } = project.open();
  pipeline.setPaused(true);
  const before = changes.length;
  const tasks = Array.from({ length: 70 }, (_, index) =>
    pipeline.ingest(requested('one', `burst-${index}`)));
  assert.equal(pipeline.getState().hookEvents.length, 70, 'receipt capture precedes local queue processing');
  assert.ok(changes.length >= before + 70, 'every incoming receipt notifies the viewer');
  const results = await Promise.all(tasks);
  assert.equal(results.filter(result => result.reason === 'overloaded').length, 6);
  const state = pipeline.getState();
  assert.equal(state.hookEvents.length, 70, 'overloaded receipts are still retained');
  assert.equal(state.activity.length, 64, 'rejected hooks do not become accepted activity');
  assert.equal(state.paused, true);
  assert.equal(state.status.dropped, 6);
  assert.equal(state.status.pending, 0);
});

test('malformed and unsupported hooks produce finite capture-gap receipts', async t => {
  const project = await workspace(t);
  const { pipeline } = project.open();
  await pipeline.ingest('not valid JSON');
  await pipeline.ingest({ hook_event_name: 'PRIVATE_UNKNOWN_HOOK', prompt: 'PRIVATE_UNKNOWN_BODY' });
  const throws = { get session_id() { throw new Error('PRIVATE_NORMALIZATION_ERROR'); } };
  assert.equal((await pipeline.ingest(throws)).accepted, false);
  const rows = pipeline.getState().hookEvents;
  assert.deepEqual(rows.map(row => row.receipt), [1, 2, 3]);
  assert.ok(rows.every(row => row.kind === 'capture.gap' && row.label === 'Observation unavailable'));
  assert.ok(rows.every(row => row.incomplete === true));
  assert.equal(JSON.stringify(rows).includes('PRIVATE_'), false);
  await pipeline.close();
  assert.equal((await pipeline.ingest(requested('one', 'after-close'))).reason, 'closed');
  assert.equal(pipeline.getState().hookEvents.length, 3, 'closed pipelines do not claim to receive hooks');
});
