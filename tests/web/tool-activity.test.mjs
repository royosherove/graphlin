import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolActivity, activityTargets, sceneActivity } from '../../runtime/web/scene.js';
import { structureScene } from '../../runtime/visualizers/structure.mjs';
import { model, entity } from './model-fixtures.mjs';

const epoch = Date.parse('2026-09-21T12:00:00Z');
const event = (sequence, kind = 'tool.requested', extra = {}) => ({
  id: `event.${sequence}`, sequence, kind, at: new Date(epoch + sequence * 100).toISOString(),
  sessionId: 'session.one', agentId: 'agent.one', toolCallId: 'call.one',
  operation: 'read', mapping: 'exact', entityIds: ['run'], artifactIds: ['artifact.one'],
  outcome: kind === 'tool.requested' ? 'pending' : kind.slice(5), ...extra,
});
const context = { session: 'session.one', now: epoch + 1000 };
const update = (tracker, activity, extra = {}) => tracker.update(model({ activity }), { ...context, ...extra });

test('activity reduces by sequence, independent of latest-first API ordering; terminal wins over a late request', () => {
  const tracker = createToolActivity();
  update(tracker, [event(3, 'tool.succeeded'), event(1), event(2)]);
  assert.deepEqual(tracker.current(epoch + 1000).map(value => value.label), ['Read']);
  update(tracker, [event(1)]);
  assert.equal(tracker.current(epoch + 1000)[0].outcome, 'succeeded');
  assert.equal(tracker.current(epoch + 4300).length, 0);
});

test('mapping enriches a finished call without restarting its lifecycle or recent timer', () => {
  const tracker = createToolActivity();
  update(tracker, [event(1), event(2, 'tool.succeeded')]);
  update(tracker, [event(9, 'activity.mapped', { entityIds: ['save'], mapping: 'decision',
    outcome: 'succeeded', at: event(2).at, recordedAt: new Date(epoch + 3900).toISOString() })],
  { now: epoch + 3900 });
  const [call] = tracker.current(epoch + 4000);
  assert.equal(call.label, 'Read');
  assert.ok(call.entityIds.includes('save'));
  assert.equal(call.at, epoch + 200);
  assert.equal(tracker.current(epoch + 4200).length, 0);
});

test('a terminal retains decision targets when the backend validates and includes that decision set', () => {
  const tracker = createToolActivity();
  update(tracker, [event(1), event(2, 'activity.mapped', { outcome: 'pending', mapping: 'decision', entityIds: ['save'] })]);
  update(tracker, [event(3, 'tool.succeeded', { mapping: 'decision', entityIds: ['run', 'save'] })]);
  const [call] = tracker.current(epoch + 1000);
  assert.equal(call.outcome, 'succeeded');
  assert.deepEqual(call.entityIds, ['run', 'save']);
  assert.equal(call.mapping, 'decision');
});

test('an exact terminal withdraws mapped targets; older pages cannot restore them, but a newer mapping can', () => {
  const tracker = createToolActivity();
  const requested = event(1, 'tool.requested', { entityIds: ['api'] });
  const oldMapping = event(2, 'activity.mapped', { outcome: 'pending', mapping: 'decision', entityIds: ['api', 'run'] });
  const terminal = event(3, 'tool.succeeded', { entityIds: ['api'] });
  update(tracker, [oldMapping, requested]);
  assert.deepEqual(tracker.current(epoch + 1000)[0].entityIds, ['api', 'run']);
  update(tracker, [terminal]);
  const withdrawn = tracker.current(epoch + 1000)[0];
  assert.deepEqual(withdrawn.entityIds, ['api']);
  assert.equal(withdrawn.mapping, 'exact');
  update(tracker, [oldMapping, requested]);
  assert.deepEqual(tracker.current(epoch + 1000)[0].entityIds, ['api']);
  assert.equal(tracker.current(epoch + 1000)[0].mapping, 'exact');
  const started = update(tracker, [event(4, 'activity.mapped', { outcome: 'succeeded', at: terminal.at,
    mapping: 'decision', entityIds: ['api', 'save'] })], { now: epoch + 3500 });
  const remapped = tracker.current(epoch + 4000)[0];
  assert.deepEqual(remapped.entityIds, ['api', 'save']);
  assert.equal(remapped.mapping, 'decision');
  assert.equal(remapped.outcome, 'succeeded');
  assert.equal(remapped.at, epoch + 300);
  assert.deepEqual(started, []);
  assert.equal(tracker.current(epoch + 4300).length, 0, 'remapping does not extend the terminal timer');
});

test('a terminal after a long request keeps its own time and its authoritative empty target set', () => {
  const tracker = createToolActivity();
  update(tracker, [event(1)]);
  update(tracker, [event(80, 'tool.succeeded', { entityIds: [], artifactIds: [] })], { now: epoch + 8000 });
  assert.equal(tracker.current(epoch + 10000)[0].at, epoch + 8000);
  update(tracker, [event(1)], { now: epoch + 11000 });
  assert.deepEqual(tracker.current(epoch + 11000)[0].entityIds, []);
  assert.equal(tracker.current(epoch + 12000).length, 0);
});

test('mapping alone does not start activity, and a terminal mapping cannot revive an older pending page', () => {
  const tracker = createToolActivity();
  update(tracker, [event(9, 'activity.mapped', { outcome: 'failed', at: event(3).at })]);
  assert.equal(tracker.current(epoch + 1000).length, 0);
  update(tracker, [event(1)]);
  assert.ok(tracker.current(epoch + 1000).every(call => call.outcome !== 'pending'));
});

test('concurrent read/edit calls and different agents remain independent', () => {
  const tracker = createToolActivity();
  update(tracker, [event(1), event(2, 'tool.requested', { operation: 'edit', toolCallId: 'call.two' }),
    event(3, 'tool.requested', { agentId: 'agent.two' }), event(4, 'tool.failed')]);
  assert.deepEqual(tracker.current(epoch + 1000).map(value => value.label).sort(), ['Editing', 'Read failed', 'Reading']);
});

test('session, project and replay transitions clear live badges; old timestamp requests never restart', () => {
  const tracker = createToolActivity();
  update(tracker, [event(1), event(2, 'tool.requested', { sessionId: 'session.other' })]);
  assert.equal(tracker.current(epoch + 1000).length, 1);
  update(tracker, [event(1)], { session: 'session.other' });
  assert.equal(tracker.current(epoch + 1000).length, 0);
  update(tracker, [event(1)], { replay: true });
  assert.equal(tracker.current(epoch + 1000).length, 0);
  tracker.update(model({ projectId: 'project.other', activity: [] }), context);
  assert.equal(tracker.current(epoch + 1000).length, 0);
  update(tracker, [event(1)], { now: epoch + 70000 });
  assert.equal(tracker.current(epoch + 70000).length, 0);
});

test('missing terminal expires after 60 seconds, with a short unresolved state; malformed time cannot stick', () => {
  const tracker = createToolActivity();
  update(tracker, [event(1)]);
  assert.equal(tracker.current(epoch + 60099)[0].label, 'Reading');
  assert.equal(tracker.current(epoch + 60100)[0].label, 'Read unresolved');
  assert.equal(tracker.current(epoch + 64100).length, 0);
  update(tracker, [event(2, 'tool.requested', { toolCallId: 'bad.time', at: 'invalid' })]);
  assert.equal(tracker.current(epoch + 70000).length, 0);
});

test('all terminal outcomes have distinct text; legacy finished uses its outcome and requests never imply success', () => {
  for (const outcome of ['failed', 'denied', 'interrupted', 'unresolved', 'succeeded']) {
    const tracker = createToolActivity();
    update(tracker, [event(1, 'tool.requested', { operation: 'edit' }),
      event(2, 'tool.finished', { operation: 'edit', outcome })]);
    assert.equal(tracker.current(epoch + 1000)[0].label, outcome === 'succeeded' ? 'Edited' : `Edit ${outcome}`);
  }
  const tracker = createToolActivity();
  update(tracker, [event(1, 'tool.requested', { operation: 'edit', outcome: 'succeeded' })]);
  assert.equal(tracker.current(epoch + 1000)[0].label, 'Editing');
});

test('exact artifact activity survives replacement of a metadata ID and marks containing collapsed blocks', () => {
  const entities = [entity('project', null, { kind: 'project', artifactId: undefined }),
    entity('folder', 'project', { kind: 'directory', artifactId: undefined }),
    entity('parsed.file', 'folder', { kind: 'module' }), entity('method', 'parsed.file', { kind: 'function' })];
  const input = model({ entities });
  const tracker = createToolActivity();
  tracker.update({ ...input, activity: [event(1, 'tool.requested', { entityIds: ['old.metadata.id'] })] }, context);
  const calls = tracker.current(epoch + 1000);
  assert.deepEqual(activityTargets(calls[0], input), ['parsed.file']);
  const collapsed = structureScene(input);
  assert.equal(sceneActivity(collapsed, input, calls).get('folder')[0].label, 'Reading');
  const expanded = structureScene(input, { expanded: ['folder', 'parsed.file'] });
  const badges = sceneActivity(expanded, input, calls);
  assert.equal(badges.get('parsed.file')[0].label, 'Reading');
  assert.equal(badges.get('folder')[0].label, 'Reading');
  assert.equal(badges.has('method'), false, 'reading a whole file does not claim each method was inspected');
});

test('descendant badges do not depend on the bounded group member list and show simultaneous operations', () => {
  const entities = [entity('root', null, { artifactId: undefined }),
    ...Array.from({ length: 300 }, (_, i) => entity(`child.${i}`, 'root', { artifactId: `artifact.${i}` }))];
  const input = model({ entities, relations: [] });
  const scene = structureScene(input, { collapsed: ['root'] });
  assert.equal(scene.groups[0].entityIds.includes('child.299'), false);
  const tracker = createToolActivity();
  tracker.update({ ...input, activity: [
    event(1, 'tool.requested', { entityIds: ['child.299'], artifactIds: [] }),
    event(2, 'tool.requested', { entityIds: ['child.299'], artifactIds: [], operation: 'edit', toolCallId: 'edit' }),
  ] }, context);
  assert.deepEqual(sceneActivity(scene, input, tracker.current(epoch + 1000)).get('root').map(value => value.label),
    ['Reading', 'Editing']);
});
