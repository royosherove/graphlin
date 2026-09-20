// Browser-review fixture only. No collector, project scan, credentials, source
// transmission, or persisted user state. Bind to a random loopback port.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { model, entity, relation, ref } from './model-fixtures.mjs';
import { snapshot, connectionInfo } from './fixtures.mjs';
import { createFrameDocument } from '../../runtime/extensions/frame.mjs';
import { bundleDigest } from '../../runtime/extensions/manifest.mjs';
import { getExtensionDataProjection } from '../../runtime/extensions/projection.mjs';

export async function startPlatformBrowserFixture() {
  const source = `window.addEventListener('graphlin:connect', event => {
    const port = event.detail.port;
    port.onmessage = event => {
      const message = event.data;
      if (message.type !== 'graphlin:project') return;
      const { instanceId, projectId, revision, viewEpoch, requestId, model } = message;
      const entity = model.entities[0];
      port.postMessage({type:'graphlin:scene',apiVersion:1,instanceId,projectId,revision,viewEpoch,requestId,
        scene:{sceneVersion:1,groups:[],edges:[],nodes:entity?[{id:'fixture.node',entityId:entity.id,label:entity.label,kind:'module'}]:[]}});
    }; port.start();
  });`;
  const manifest = {
    manifestVersion: 1, graphlinApi: '1', modelSchema: '2', id: 'example.fixture', name: 'Installed fixture',
    version: '0.1.0', entry: 'view.js', assets: { 'view.js': `sha256-${createHash('sha256').update(source).digest('hex')}` },
    views: ['main'], renderer: { kind: 'graphlin-scene', sceneVersion: '1' },
    requiredFeatures: [], capabilities: ['model.read'],
  };
  const digest = bundleDigest(manifest);
  let grant = null, baseline = null;
  const state = model({ entities: [
    entity('root', null, { label: 'Notes workspace', kind: 'directory', basis: 'metadata', sourceRefs: [] }),
    entity('gateway', 'root', { label: 'gateway.ts', kind: 'module' }),
    entity('route', 'gateway', { label: 'routeNote', kind: 'function' }),
    entity('sessions', 'root', { label: 'SessionStore', kind: 'class' }),
    entity('load', 'sessions', { label: 'loadSession', kind: 'method' }),
    entity('save', 'sessions', { label: 'saveSession', kind: 'method' }),
    entity('web', 'root', { label: 'web.ts', kind: 'module' }),
    entity('render', 'web', { label: 'renderNotes', kind: 'function' }),
  ], relations: [relation('calls', 'route', 'load'), relation('writes', 'route', 'save', 'writes'),
    relation('reads', 'render', 'route', 'calls')], activity: [
    { id: 'one', sequence: 1, at: '2026-09-20T09:00:00Z', kind: 'tool.requested', toolCategory: 'read', outcome: 'pending',
      agentId: 'agent.one', toolCallId: 'read.one', entityIds: ['route'], attribution: 'observed' },
    { id: 'two', sequence: 2, at: '2026-09-20T09:00:01Z', kind: 'tool.requested', toolCategory: 'test', outcome: 'pending',
      agentId: 'agent.two', toolCallId: 'test.one', entityIds: [], attribution: 'observed' },
    { id: 'three', sequence: 3, at: '2026-09-20T09:00:02Z', kind: 'tool.finished', toolCategory: 'read', outcome: 'succeeded',
      agentId: 'agent.one', toolCallId: 'read.one', entityIds: ['route'], attribution: 'correlated' },
  ], sequence: 3, interpretations: [
    { id: 'application', namespace: 'fixture.boundary', kind: 'application', label: 'Notes application', entityIds: ['gateway', 'route', 'web', 'render'],
      basis: 'decision', validity: 'current', support: 'supported', classification: 'accepted', sourceRefs: [ref()] },
  ] });
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    try {
      if (url.pathname === '/api/state') return json(snapshot({ mode: 'demo' }));
      if (url.pathname === '/api/connection-info') return json(connectionInfo({ projectRoot: '/fixture/Notes workspace' }));
      if (url.pathname === '/api/model/v1/snapshot') return json(url.searchParams.has('checkpoint') && baseline ? baseline : state);
      if (url.pathname === '/api/model/v1/checkpoints' && req.method === 'POST') {
        baseline = structuredClone(state);
        state.checkpoints = [{ id: 'baseline.fixture', label: 'Task baseline', revision: state.revision, sequence: state.sequence }];
        return json(state.checkpoints[0]);
      }
      if (url.pathname === '/api/extensions') return json({ extensions: [{ id: manifest.id, digest, manifest, grant }] });
      if (url.pathname === '/api/extensions/grant' && req.method === 'POST') {
        let body = ''; for await (const bytes of req) body += bytes;
        const value = JSON.parse(body);
        grant = { projectId: state.projectId, extensionId: manifest.id, digest, fields: value.fields,
          history: value.history, approved: value.approved };
        return json({ ok: true });
      }
      if (url.pathname === '/api/extensions/data/example.fixture') {
        const projection = getExtensionDataProjection(state, grant);
        if (!projection) { res.statusCode = 403; return json({}); }
        return json(projection);
      }
      if (url.pathname === '/api/extensions/frame/example.fixture') {
        const frame = createFrameDocument({ manifest, assets: { 'view.js': source }, nonce: url.searchParams.get('nonce') });
        res.writeHead(200, frame.headers); return res.end(frame.body);
      }
      if (['/api/events', '/api/model/v1/events'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(url.pathname.includes('/model/') ? state : snapshot({ mode: 'demo' }))}\n\n`);
        streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      const file = url.pathname === '/' ? 'web/index.html'
        : /^\/(?:visualizers|extensions|model)\/[\w-]+\.mjs$/.test(url.pathname) ? url.pathname.slice(1)
        : /^\/[\w-]+\.(?:js|css)$/.test(url.pathname) ? `web${url.pathname}` : null;
      if (!file) { res.statusCode = 404; return res.end('{}'); }
      const content = await readFile(new URL(`../../runtime/${file}`, import.meta.url));
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(content);
    } catch { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() { for (const res of streams) res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startPlatformBrowserFixture();
  console.log(fixture.origin);
  process.on('SIGTERM', async () => { await fixture.close(); process.exit(); });
  process.on('SIGINT', async () => { await fixture.close(); process.exit(); });
}
