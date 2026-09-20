// Disposable actual-daemon fixture for browser checks. Its generated project,
// extension, state and credentials live together under one temporary directory.
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { startServer } from '../../runtime/daemon/server.mjs';
import { demoDecisionService } from '../../runtime/daemon/demo.mjs';
import { createExtensionRegistry } from '../../runtime/extensions/registry.mjs';

const gatewaySource = `export class NotesGateway {
  routeNote(note) { return this.validateNote(note); }
  validateNote(note) { return Boolean(note); }
}
export function startGateway() { return new NotesGateway(); }
`;
export async function startDaemonBrowserFixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-viewer-check-')));
  const projectRoot = path.join(directory, 'Notes workspace'), dataDir = path.join(directory, 'data');
  let server;
  try {
    await mkdir(path.join(projectRoot, 'app'), { recursive: true, mode: 0o700 });
    await mkdir(dataDir, { mode: 0o700 });
    await writeFile(path.join(projectRoot, 'app', 'gateway.js'), gatewaySource);
    await writeFile(path.join(projectRoot, 'app', 'sessions.js'),
      'export class SessionStore { loadSession(id) { return id; } saveSession(value) { return value; } }\n');
    await writeFile(path.join(projectRoot, 'app', 'web.js'),
      'export function renderNotes(notes) { return notes.map(formatNote); }\nfunction formatNote(note) { return String(note); }\n');
    server = await startServer({ projectRoot, dataDir, port: 0, mode: 'demo',
      policy: { readSource: true, transmitSource: false, displayEvidence: true },
      decisionService: demoDecisionService() });
    await server.pipeline.whenIdle();
    const state = server.pipeline.getModelState();
    const module = state.entities.find(entity => entity.relativePath?.endsWith('gateway.js') && entity.sourceRefs.length);
    if (module) {
      const members = state.entities.filter(entity => entity.artifactId === module.artifactId);
      server.pipeline.model.observeInterpretations([{
        id: 'notes-application', namespace: 'fixture.c4', kind: 'application', label: 'Notes application',
        entityIds: members.map(entity => entity.id), sourceRefs: module.sourceRefs,
        support: 'supported', classification: 'accepted', validity: 'current',
      }]);
      server.pipeline.model.recordActivity({
        id: 'fixture-read', kind: 'tool.requested', toolCategory: 'read', agentId: 'agent.one',
        toolCallId: 'fixture-call', outcome: 'pending', attribution: 'observed', entityIds: [module.id],
      });
      server.pipeline.model.recordActivity({
        id: 'fixture-test', kind: 'tool.requested', toolCategory: 'test', agentId: 'agent.two',
        toolCallId: 'fixture-test-call', outcome: 'pending', attribution: 'observed', entityIds: [],
      });
      server.pipeline.model.recordActivity({
        id: 'fixture-result', kind: 'tool.finished', toolCategory: 'read', agentId: 'agent.one',
        toolCallId: 'fixture-call', outcome: 'succeeded', attribution: 'correlated', entityIds: [module.id],
      });
    }
    const extensionRoot = path.join(directory, 'timeline-extension');
    await mkdir(extensionRoot, { mode: 0o700 });
    const script = `window.addEventListener('graphlin:connect', event => {
      const port = event.detail.port, root = document.getElementById('graphlin-extension');
      port.onmessage = event => {
        const message = event.data;
        if (message.type !== 'graphlin:project') return;
        const { instanceId, projectId, revision, viewEpoch, requestId, model } = message;
        const context = {apiVersion:1,instanceId,projectId,revision,viewEpoch,requestId};
        const heading = document.createElement('h2'); heading.textContent = 'Installed activity renderer';
        const list = document.createElement('ol');
        for (const activity of model.activity) {
          const row = document.createElement('li'), button = document.createElement('button');
          button.textContent = (activity.toolCategory || activity.kind) + ': ' + activity.outcome;
          button.onclick = () => port.postMessage({...context,type:'graphlin:select',selection:{activityId:activity.id}});
          row.append(button); list.append(row);
        }
        root.replaceChildren(heading,list);
        port.postMessage({...context,type:'graphlin:status',status:'ready',itemCount:model.activity.length});
      }; port.start();
    });`;
    const profile = JSON.stringify({ id: 'grouping', questions: [{
      id: 'coherent', kind: 'boolean', question: 'Does this supplied evidence establish a coherent source scope?',
    }], selectors: { fields: ['entities'], candidateIds: [] } });
    const hash = value => `sha256-${createHash('sha256').update(value).digest('hex')}`;
    await writeFile(path.join(extensionRoot, 'view.js'), script);
    await writeFile(path.join(extensionRoot, 'grouping.json'), profile);
    await writeFile(path.join(extensionRoot, 'graphlin.extension.json'), JSON.stringify({
      manifestVersion: 1, graphlinApi: '1', modelSchema: '2', id: 'example.timeline-fixture',
      name: 'Installed activity fixture', version: '0.1.0', entry: 'view.js',
      assets: { 'view.js': hash(script), 'grouping.json': hash(profile) },
      requiredFeatures: ['activity'], views: ['activity'], renderer: { kind: 'custom' },
      capabilities: ['model.read', 'activity.read', 'selection.request', 'history.read', 'analysis.request'],
      decisionProfiles: ['grouping.json'],
    }));
    const registry = await createExtensionRegistry({ dataDir, projectId: state.projectId });
    await registry.install(extensionRoot);
    return {
      url: server.url, directory, server,
      async change() {
        await writeFile(path.join(projectRoot, 'app', 'gateway.js'), `${gatewaySource}\nexport function summarizeNotes(notes) { return notes.length; }\n`);
        await server.pipeline.reconcile(); await server.pipeline.whenIdle();
      },
      async revoke() { await registry.revoke('example.timeline-fixture'); },
      async close() { await server.close(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await server?.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startDaemonBrowserFixture();
  console.log(fixture.url);
  console.log(JSON.stringify(fixture.server.pipeline.model.stats()));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async input => {
    if (input.trim() === 'change') { await fixture.change(); console.log('Fixture source changed'); }
    if (input.trim() === 'revoke') { await fixture.revoke(); console.log('Fixture grant revoked'); }
  });
  const close = async () => { await fixture.close(); process.exit(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
