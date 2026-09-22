import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EvidenceStore } from '../../runtime/core/evidence.mjs';
import { privateText, createPolicy, excluded, metadataEvent } from '../../runtime/core/privacy.mjs';
import { buildCandidates } from '../../runtime/core/candidates.mjs';

test('an environment fallback withholds the whole capture with a fixed reason and recovers after a safe edit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-evidence-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const safe = 'export const options = { secret: process.env.SESSION_SECRET };';
  const privateSource = safe.replace('process.env.SESSION_SECRET', "process.env.SESSION_SECRET || 'SYNTHETIC_FALLBACK_CREDENTIAL'");
  assert.equal(privateText(safe), false);
  assert.equal(privateText(privateSource), true);
  const store = new EvidenceStore({ projectRoot: root, policy: { transmitSource: true } });
  const file = path.join(root, 'server.js');
  await writeFile(file, safe);
  const [initial] = await store.capture([file]);
  const ref = { artifactId: initial.id, hash: initial.hash, generation: initial.generation };
  await writeFile(file, privateSource);
  const [withheld] = await store.reconcile();
  assert.equal(withheld.status, 'present');
  assert.equal(withheld.complete, true);
  assert.equal(withheld.text, null);
  assert.equal(withheld.sourceReason, 'source_withheld');
  assert.equal(store.isCurrent([ref]), false);
  assert.doesNotMatch(JSON.stringify(withheld), /SYNTHETIC_FALLBACK_CREDENTIAL|SESSION_SECRET/);
  const [same] = await store.reconcile();
  assert.equal(same.generation, withheld.generation);
  assert.equal(same.sourceReason, 'source_withheld');
  await writeFile(file, safe);
  const [recovered] = await store.reconcile();
  assert.equal(recovered.text, safe);
  assert.equal(recovered.sourceReason, undefined);
  assert.ok(recovered.generation > withheld.generation);
});

test('Graphlin state cannot become source evidence through explicit file reads, forged policies, or aliases', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-state-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = 'export function retainedPrivateDiagram() { return "STATE_ONLY_SENTINEL"; }\n';
  assert.equal(privateText(source), false, 'path exclusion must protect ordinary state without secret syntax');
  const files = [
    '.graphlin/settings.json', '.graphlin/project/model-state.json',
    '.graphlin/plugins/graphlin/1.0.0/code.js', 'nested/.graphlin/extensions/code.js',
    '.graphlin-data/state.json', '.graphlin-local/state.json', '.visualive/state.json',
  ];
  for (const name of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  await symlink(path.join(root, '.graphlin'), path.join(root, 'ordinary'));
  const branded = createPolicy({ transmitSource: true });
  const policy = Object.freeze({ ...branded, excludePaths: Object.freeze([]) });
  const store = new EvidenceStore({ projectRoot: root, policy });
  const captured = await store.capture([...files, 'ordinary/settings.json']);
  assert.equal(captured.length, files.length + 1);
  for (const artifact of captured) {
    assert.equal(artifact.status, 'unavailable');
    assert.equal(artifact.text, null);
    assert.equal(artifact.hash, null);
    assert.equal(artifact.complete, false);
  }
  for (const name of files) assert.equal(excluded(name, policy), true);
  assert.doesNotMatch(JSON.stringify(captured), /STATE_ONLY_SENTINEL|retainedPrivateDiagram/);
  const event = metadataEvent({ kind: 'tool.succeeded', toolCategory: 'read' });
  assert.deepEqual(buildCandidates({ artifacts: captured, policy, event }), []);
  // Even a caller supplying already-read bytes cannot bypass candidate intake.
  assert.deepEqual(buildCandidates({ artifacts: [{
    ...captured[0], text: source, status: 'present', exists: true, complete: true, hash: 'a'.repeat(64),
  }], policy, event }), []);
});
