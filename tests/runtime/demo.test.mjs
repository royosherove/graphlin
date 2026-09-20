import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDemoProject, demoDecisionService, replayDemo, replayDemoChange,
  prepareDemoChange, DEMO_SESSION_ID,
} from '../../runtime/daemon/demo.mjs';
import { createPipeline } from '../../runtime/pipeline.mjs';
import { ROLES, ROLE_SHAPES } from '../../runtime/core/common.mjs';

async function setup(t, { onChange = () => {} } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'graphlin-demo-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const projectRoot = await createDemoProject(dataDir);
  const service = demoDecisionService();
  const pipeline = createPipeline({
    projectRoot, decisionService: service, mode: 'demo', onChange,
    policy: { transmitSource: true, displayEvidence: true },
  });
  t.after(() => pipeline.close());
  return { dataDir, projectRoot, service, pipeline };
}

function relation(graph, source, target, kind) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  return graph.edges.find(edge => nodes.get(edge.source)?.label === source &&
    nodes.get(edge.target)?.label === target && edge.relation === kind);
}

test('expanded offline demo uses real capture, intake and compiler with all twelve roles, a hierarchy, a cycle, and isolated declarations', async t => {
  let remoteCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { remoteCalls++; throw new Error('unexpected_network'); });
  const { pipeline, projectRoot, service } = await setup(t);
  const snapshot = await replayDemo(pipeline, projectRoot);
  assert.equal(snapshot.mode, 'demo');
  assert.equal(service.stats().mode, 'demo');
  assert.equal(remoteCalls, 0);
  assert.equal(snapshot.graph.nodes.length, 18, JSON.stringify(snapshot.status));
  assert.deepEqual([...new Set(snapshot.graph.nodes.map(node => node.kind))].sort(), [...ROLES].sort());
  assert.equal(new Set(snapshot.graph.nodes.map(node => node.shape)).size, 12);
  for (const node of snapshot.graph.nodes) {
    assert.equal(node.shape, ROLE_SHAPES[node.kind]);
    assert.equal(node.classification, 'accepted', node.label);
    assert.equal(node.validity, 'current', node.label);
    assert.equal(node.evidenceState, 'observed');
    assert.ok(node.sourceRefs.length > 0);
    assert.ok(node.sourceRefs.every(ref => ref.sourceClass === 'source' && ref.basis === 'jev_interpretation'));
  }
  assert.ok(relation(snapshot.graph, 'saveNote', 'PostgreSQL', 'writes'), 'original notes write remains');
  assert.ok(relation(snapshot.graph, 'createNote', 'persistNote', 'calls'));
  assert.ok(relation(snapshot.graph, 'persistNote', 'NoteCache', 'writes'));
  assert.ok(relation(snapshot.graph, 'WarmGreetingStrategy', 'EnthusiasticGreetingStrategy', 'calls'));
  assert.ok(relation(snapshot.graph, 'EnthusiasticGreetingStrategy', 'WarmGreetingStrategy', 'calls'));
  for (const kind of ['calls', 'consumes', 'depends_on']) {
    assert.ok(relation(snapshot.graph, 'NotificationDeliveryService', 'PendingNotificationsQueue', kind));
  }
  const disconnected = snapshot.graph.nodes.filter(node => !snapshot.graph.edges.some(edge => edge.source === node.id || edge.target === node.id));
  assert.ok(disconnected.some(node => node.kind === 'interface'));
  assert.ok(disconnected.some(node => node.kind === 'event'));
  assert.ok(snapshot.graph.nodes.some(node => node.label === 'EnthusiasticGreetingStrategy'));
  assert.ok(snapshot.activity.some(event => event.kind === 'tool.succeeded' && event.toolCategory === 'read'));
  assert.ok(snapshot.history.length > 1);
  assert.equal(snapshot.status.pending, 0);
  assert.equal(snapshot.status.dropped, 0);
  assert.ok(snapshot.status.calls >= 18);
});

test('explicit add/remove uses the same live session and canonical removal, while unaffected IDs and evidence stay intact', async t => {
  const changes = [];
  const { pipeline, projectRoot } = await setup(t, { onChange: snapshot => changes.push(snapshot) });
  const before = await replayDemo(pipeline, projectRoot);
  const originalIds = before.graph.nodes.map(node => node.id);
  changes.length = 0;
  const added = await replayDemoChange(pipeline, projectRoot, { action: 'add' });
  assert.equal(added.sessionId, before.sessionId);
  assert.equal(added.graph.nodes.length, 20);
  assert.ok(added.graph.revision > before.graph.revision);
  assert.deepEqual(added.graph.nodes.filter(node => originalIds.includes(node.id)), before.graph.nodes);
  assert.ok(relation(added.graph, 'renderLiveGreetingPreview', 'LivePreviewBrowser', 'calls'));
  assert.ok(changes.some(snapshot => snapshot.graph.nodes.length === 20), 'observers receive a complete added-node snapshot');
  const liveIds = added.graph.nodes.filter(node => !originalIds.includes(node.id)).map(node => node.id);

  const callsBeforePause = pipeline.getState().status.calls;
  pipeline.setPaused(true);
  const removed = await replayDemoChange(pipeline, projectRoot, { action: 'remove' });
  assert.equal(removed.graph.nodes.length, 18, 'deletion removes records rather than merely making them stale');
  assert.equal(removed.status.calls, callsBeforePause, 'capture invalidation removes nodes even while classification is paused');
  assert.equal(removed.sessionId, before.sessionId);
  assert.deepEqual(removed.graph.nodes, before.graph.nodes);
  assert.ok(removed.graph.edges.every(edge => !liveIds.includes(edge.source) && !liveIds.includes(edge.target)));
  assert.ok(removed.history.some(frame => frame.graph.nodes.length === 20), 'replay retains the added-node revision');
  pipeline.setPaused(false);
  await pipeline.whenIdle();
  const readded = await replayDemoChange(pipeline, projectRoot, { action: 'add' });
  assert.deepEqual(readded.graph.nodes.filter(node => !originalIds.includes(node.id)).map(node => node.id), liveIds);
  const sameContent = await replayDemoChange(pipeline, projectRoot, { action: 'add' });
  assert.equal(sameContent.graph.nodes.length, 20, 'repeating the explicit add cannot duplicate nodes');
});

test('replaying the recording keeps one session and deterministic component identities and relation decisions', async t => {
  const { pipeline, projectRoot } = await setup(t);
  const first = await replayDemo(pipeline, projectRoot);
  const again = await replayDemo(pipeline, projectRoot);
  const semantics = graph => ({
    nodes: graph.nodes.map(({ id, label, kind, shape, classification }) => ({ id, label, kind, shape, classification })),
    edges: graph.edges.map(({ id, source, target, relation, classification }) => ({ id, source, target, relation, classification })),
  });
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(again.sessions.length, 1);
  assert.deepEqual(semantics(again.graph), semantics(first.graph));
});

test('parent can trigger the live change through the existing IPC capture-message shape without a new route', async t => {
  const { pipeline, projectRoot } = await setup(t);
  await replayDemo(pipeline, projectRoot);
  const message = await prepareDemoChange(projectRoot, { action: 'add' });
  assert.deepEqual(Object.keys(message).sort(), ['host', 'payload']);
  assert.equal(message.host, 'claude');
  assert.equal(message.payload.session_id, DEMO_SESSION_ID);
  assert.equal(message.payload.hook_event_name, 'PostToolUse');
  assert.equal(message.payload.tool_name, 'Write');
  assert.equal(message.payload.cwd, projectRoot);
  assert.match(await readFile(message.payload.tool_input.file_path, 'utf8'), /renderLiveGreetingPreview/);
  await pipeline.ingest(message.payload, { host: message.host });
  await pipeline.whenIdle();
  assert.equal(pipeline.getState().graph.nodes.length, 20);
  const removal = await prepareDemoChange(projectRoot, { action: 'remove' });
  assert.equal(removal.payload.tool_name, 'apply_patch');
  await assert.rejects(stat(removal.payload.tool_input.file_path), { code: 'ENOENT' });
});

test('fixture files are private and reset excludes the optional live nodes; unmarked roots and unsafe action names are refused', async t => {
  const { projectRoot, dataDir, pipeline } = await setup(t);
  for (const name of await readdir(projectRoot)) assert.equal((await stat(path.join(projectRoot, name))).mode & 0o777, 0o600);
  const live = await prepareDemoChange(projectRoot, { action: 'add' });
  await createDemoProject(dataDir);
  await assert.rejects(stat(live.payload.tool_input.file_path), { code: 'ENOENT' });
  await assert.rejects(prepareDemoChange(projectRoot, { action: '../notes.mjs' }), { code: 'invalid_demo_action' });
  const other = path.join(dataDir, 'not-the-demo');
  await mkdir(other);
  await writeFile(path.join(other, 'keep.mjs'), 'untouched');
  await assert.rejects(prepareDemoChange(other, { action: 'add' }));
  assert.equal(await readFile(path.join(other, 'keep.mjs'), 'utf8'), 'untouched');
  await symlink(path.join(other, 'keep.mjs'), live.payload.tool_input.file_path);
  await assert.rejects(prepareDemoChange(projectRoot, { action: 'add' }));
  assert.equal(await readFile(path.join(other, 'keep.mjs'), 'utf8'), 'untouched');
  await assert.rejects(replayDemoChange({ getState: () => ({ mode: 'live' }) }, projectRoot, { action: 'remove' }),
    { code: 'demo_mode_required' });
  assert.equal(pipeline.getState().graph.nodes.length, 0);
});
