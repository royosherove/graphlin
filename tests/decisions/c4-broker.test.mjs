import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { createAnalysisBroker } from '../../runtime/decisions/broker.mjs';
import { createDecisionService } from '../../runtime/decisions/index.mjs';
import { createExtensionRegistry, validateScene } from '../../runtime/extensions/index.mjs';
import { createProjectModel } from '../../runtime/model/index.mjs';
import { createPolicy } from '../../runtime/core/privacy.mjs';
import { c4Scene } from '../../runtime/visualizers/c4.mjs';
import { structure, sourceHash } from '../model/fixtures.mjs';
import { temporary, PROJECT } from '../extensions/fixtures.mjs';
import { createRecordedProvider } from './recorded-provider.mjs';
import { jevProvider } from './jev-provider.mjs';

const execute = promisify(execFile);
const guide = await readFile(new URL('../../docs/extension-authoring.md', import.meta.url), 'utf8');
const blocks = [...guide.matchAll(/^```(\w+)\n([\s\S]*?)^```/gm)].map(([, language, code]) => ({ language, code }));
const visualizer = blocks.find(value => value.language === 'js' && value.code.includes("window.addEventListener('graphlin:connect'")).code;
const json = blocks.filter(value => value.language === 'json').map(value => JSON.parse(value.code));
const exampleProfile = json.find(value => value.id === 'architecture');
const examplePackage = json.find(value => value.name === 'my-graphlin-c4');
const manifestScript = blocks.find(value => value.language === 'sh' && value.code.includes("await writeFile('graphlin.extension.json'"))
  .code.match(/<<'JS'\n([\s\S]*?)\nJS/)[1];

function exampleProjector() {
  const listeners = new Map(), sent = [];
  vm.runInNewContext(visualizer, {
    window: { addEventListener: (type, callback) => listeners.set(type, callback) },
  });
  const port = {
    start() {}, close() {},
    postMessage: message => sent.push(JSON.parse(JSON.stringify(message))),
  };
  listeners.get('graphlin:connect')({ detail: { port } });
  assert.deepEqual(sent, [], 'mounting the documented extension does not request analysis');
  return model => {
    port.onmessage({ data: {
      type: 'graphlin:project', apiVersion: 1, instanceId: 'instance-example',
      projectId: model.projectId, revision: model.revision, viewEpoch: 1,
      requestId: 'request-example', model,
    } });
    assert.equal(sent.at(-1).type, 'graphlin:scene');
    return validateScene(sent.at(-1).scene, { model });
  };
}

for (const [name, makeProvider] of [['recorded', createRecordedProvider], ['jev', jevProvider]]) {
  test(`${name}: shipped C4 example installs, grants, evaluates, records and renders an explicit semantic boundary`, async t => {
    const root = await temporary(t);
    const directory = path.join(root, 'my-c4');
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await mkdir(path.join(directory, 'profiles'), { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, 'dist/visualizer.js'), visualizer),
      writeFile(path.join(directory, 'profiles/c4.json'), JSON.stringify(exampleProfile)),
      writeFile(path.join(directory, 'package.json'), JSON.stringify(examplePackage)),
    ]);
    await execute(process.execPath, ['--input-type=module', '-e', manifestScript], { cwd: directory });
    const registry = await createExtensionRegistry({ dataDir: path.join(root, 'state'), projectId: PROJECT });
    const installed = await registry.install(directory);
    const loaded = await registry.getAssets(installed.id);
    const profile = loaded.profiles[0];
    assert.equal(profile.questions[0].interpretationKind, 'selected-choice');
    const grant = await registry.grant(installed.id, {
      digest: installed.digest, fields: ['entities', 'relations', 'interpretations', 'coverage'],
      history: false, approved: true, profiles: [profile.id],
    });
    const policy = createPolicy({ transmitSource: true });
    const model = createProjectModel({ projectId: PROJECT, policy });
    model.observeStructure({ ...structure(), relativePath: 'src/demo.js' });
    const provider = makeProvider();
    const service = createDecisionService({ provider });
    t.after(() => service.close());
    const run = createAnalysisBroker({ service, model, policy, projectId: PROJECT, registry });
    const projectExample = exampleProjector();
    const before = model.snapshot();
    assert.match(c4Scene(before).coverage.label, /unknown/);
    assert.equal(projectExample(before).groups.length, 0);
    assert.equal(provider.calls.length, 0);
    const result = await run({
      projectId: PROJECT, extensionId: installed.id, digest: installed.digest,
      profile, entityIds: ['class-a'], revision: before.revision, grant,
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.interpretationIds.length, 1);
    const snapshot = model.snapshot();
    const record = snapshot.interpretations.find(value => value.id === result.interpretationIds[0]);
    assert.equal(record.kind, 'application');
    assert.equal(record.label, 'Alpha');
    assert.equal(record.namespace, 'example.c4.architecture');
    assert.equal(record.version, installed.digest);
    assert.equal(record.support, 'supported');
    assert.equal(record.classification, 'accepted');
    assert.deepEqual(record.sourceRefs, before.entities.find(value => value.id === 'class-a').sourceRefs);
    const scene = validateScene(c4Scene(snapshot, { level: 'applications' }), { model: snapshot });
    for (const rendered of [scene, projectExample(snapshot)]) {
      const boundary = rendered.groups.find(value => value.membershipId === record.id);
      assert.ok(boundary, 'the actual broker record reaches the C4 boundary renderer');
      assert.equal(boundary.kind, 'service');
      assert.equal(boundary.label, 'Alpha');
      assert.deepEqual(boundary.entityIds, ['class-a']);
    }
    assert.equal(provider.calls.length, 1);
    const wire = JSON.stringify(provider.calls[0]);
    assert.doesNotMatch(wire, /interpretationKind|interpretationLabel/);
    await writeFile(path.join(directory, 'profiles/c4.json'), JSON.stringify({
      ...exampleProfile,
      questions: [{ ...exampleProfile.questions[0], interpretationLabel: 'Changed declaration' }],
    }));
    await execute(process.execPath, ['--input-type=module', '-e', manifestScript], { cwd: directory });
    const updated = await registry.install(directory);
    assert.notEqual(updated.digest, installed.digest);
    assert.equal(await registry.getGrant(installed.id), null, 'changing output semantics requires fresh approval');
    assert.deepEqual(await run({
      projectId: PROJECT, extensionId: installed.id, digest: installed.digest,
      profile, entityIds: ['class-a'], revision: model.snapshot().revision, grant,
    }), { status: 'unavailable' });
    assert.equal(provider.calls.length, 1);
    model.invalidateArtifacts([{
      id: 'artifact-demo', generation: 2, hash: sourceHash(2), status: 'present',
    }]);
    const stale = model.snapshot();
    assert.match(c4Scene(stale).coverage.label, /unknown/);
    assert.equal(projectExample(stale).groups.length, 0);
    assert.equal(provider.calls.length, 1, 'rendering and stale projection never activate analysis');
  });
}
