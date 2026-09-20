import http from 'node:http';
import net from 'node:net';
import { readFile, chmod, rm } from 'node:fs/promises';
import { createPipeline } from '../pipeline.mjs';
import { createPolicy, materializeBundle, buildRelationProposals } from '../core/index.mjs';
import { createDecisionService } from '../jev/index.mjs';
import { projectPaths, canonicalProjectRoot, MAX_IPC_BYTES, MAX_STATE_BYTES, PROTOCOL, runtimeError } from './paths.mjs';
import { acquireLock } from './lock.mjs';
import { createAuth } from './auth.mjs';
import { createPersistence } from './persistence.mjs';
import { exportSnapshot } from './export.mjs';
import { createDiagnostics } from './diagnostics.mjs';

const WEB = new URL('../web/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/sidebar.js', ['sidebar.js', 'text/javascript; charset=utf-8']],
  ['/layout.js', ['layout.js', 'text/javascript; charset=utf-8']],
  ['/sketch.js', ['sketch.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const HOSTS = new Set(['claude', 'codex', 'kiro']);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function bodyJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw runtimeError('invalid_content_type');
  const chunks = []; let bytes = 0;
  const timer = setTimeout(() => req.destroy(), 1000);
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 4096) throw runtimeError('input_too_large');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw runtimeError('invalid_input');
    return value;
  } finally { clearTimeout(timer); }
}

export async function startServer({ projectRoot, dataDir, policy: policyOptions,
  decisionService, apiKey: configuredKey, mode = 'live', port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw runtimeError('invalid_port');
  if (!['live', 'demo'].includes(mode)) throw runtimeError('invalid_mode');
  const paths = await projectPaths(projectRoot, dataDir, { create: true });
  const lock = await acquireLock(paths);
  let finished;
  const whenClosed = new Promise(resolve => { finished = resolve; });
  let web, ipc, pipeline, auth, diagnostics, interval, ping, closing, reconciling = false;
  let drops = 0, intake = 0;
  const receivedHooks = { claude: 0, codex: 0, kiro: 0 };
  const clients = new Set(), connections = new Set(), ipcConnections = new Set();
  const persistence = createPersistence(paths.state);
  const policy = createPolicy(policyOptions ?? {});
  const apiKey = !decisionService && policy.transmitSource && mode === 'live'
    ? configuredKey ?? process.env.TYPESAFE_API_KEY : undefined;
  const missingKey = !decisionService && policy.transmitSource && mode === 'live' && !apiKey;
  function snapshot(persistent = false) {
    const state = pipeline.getState({ persistent });
    return { ...state, status: { ...state.status,
      classifier: missingKey && !state.paused ? 'missing_key' : state.status.classifier,
      dropped: (state.status?.dropped ?? 0) + drops } };
  }
  function stream(res, state) {
    const message = `event: snapshot\ndata: ${JSON.stringify(state)}\n\n`;
    if (Buffer.byteLength(message) > MAX_STATE_BYTES || res.writableLength > MAX_STATE_BYTES) {
      res.destroy(); clients.delete(res); return;
    }
    res.write(message);
  }
  function notify() {
    if (!pipeline || closing) return;
    persistence.schedule(snapshot(true));
    const state = snapshot();
    for (const res of clients) stream(res, state);
  }
  async function reconcile() {
    if (reconciling || closing || !pipeline) return;
    reconciling = true;
    try { await pipeline.reconcile(); }
    catch { drops++; }
    finally { reconciling = false; }
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(interval); clearInterval(ping);
      auth?.clear();
      for (const res of clients) res.end();
      for (const socket of [...connections, ...ipcConnections]) socket.destroy();
      await Promise.all([web, ipc].filter(Boolean).map(server =>
        new Promise(resolve => server.close(() => resolve()))));
      try {
        await pipeline?.close();
        if (pipeline) persistence.schedule(snapshot(true));
        await persistence.close();
      } finally {
        try { await diagnostics?.close(); }
        finally {
          await rm(paths.socket, { force: true }).catch(() => {});
          await lock.release();
        }
      }
    })();
    closing.then(() => finished({ ok: true }), () => finished({ ok: false, code: 'shutdown_failed' }));
    return closing;
  }
  try {
    diagnostics = await createDiagnostics({ directory: paths.directory, projectRoot: paths.projectRoot, policy });
    // Reading the key is conditional on explicit source-transmission permission.
    // Test/demo services are injected; this module never logs request bodies.
    const service = decisionService ?? createDecisionService({
      apiKey,
      materializeBundle, buildRelationProposals,
      limits: { eventDeadlineMs: 5000 },
    });
    pipeline = createPipeline({ projectRoot: paths.projectRoot, policy, decisionService: service,
      classificationDeadlineMs: 5000,
      mode, restoredState: await persistence.load(), onChange: notify, onDiagnostic: diagnostics.record });
    web = http.createServer({ maxHeaderSize: 8192, requestTimeout: 2000, headersTimeout: 2000 }, (req, res) => {
      headers(res);
      void (async () => {
        if (!auth || !auth.validRequest(req, { mutation: req.method !== 'GET' })) {
          return json(res, 403, { error: 'forbidden_origin' });
        }
        if (typeof req.url !== 'string' || req.url.length > 1024 || req.url.includes('?')) {
          return json(res, 400, { error: 'invalid_route' });
        }
        if (req.method === 'POST' && req.url === '/api/auth') {
          const input = await bodyJSON(req);
          if (Object.keys(input).some(key => key !== 'token')) return json(res, 400, { error: 'invalid_input' });
          const cookie = auth.exchange(input.token);
          if (!cookie) return json(res, 401, { error: 'invalid_token' });
          res.setHeader('Set-Cookie', cookie);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && assets.has(req.url)) {
          const [filename, contentType] = assets.get(req.url);
          try {
            const body = await readFile(new URL(filename, WEB));
            if (body.length > 1024 * 1024) throw runtimeError('asset_too_large');
            res.writeHead(200, { 'Content-Type': contentType }); res.end(body);
          } catch { json(res, 503, { error: 'viewer_unavailable' }); }
          return;
        }
        if (!auth.authorized(req)) return json(res, 401, { error: 'authentication_required' });
        if (req.method === 'GET' && req.url === '/api/diagnostics') {
          return json(res, 200, diagnostics.snapshot());
        }
        if (req.method === 'GET' && req.url === '/api/connection-info') {
          try {
            const { createConnectionInfo } = await import('./connection-info.mjs');
            const info = await createConnectionInfo({ projectRoot: paths.projectRoot, dataDir: paths.dataDir, mode });
            if (Buffer.byteLength(JSON.stringify(info)) > 64 * 1024) throw runtimeError('connection_info_too_large');
            return json(res, 200, info);
          } catch { return json(res, 503, { error: 'connection_info_unavailable' }); }
        }
        if (req.method === 'GET' && ['/api/state', '/api/export'].includes(req.url)) {
          const state = req.url === '/api/export' ? exportSnapshot(snapshot()) : snapshot();
          if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) return json(res, 503, { error: 'snapshot_too_large' });
          if (req.url === '/api/export') res.setHeader('Content-Disposition', 'attachment; filename="graphlin-export.json"');
          return json(res, 200, state);
        }
        if (req.method === 'GET' && req.url === '/api/events') {
          if (clients.size >= 16) return json(res, 503, { error: 'viewer_limit' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders(); clients.add(res);
          stream(res, snapshot());
          req.on('close', () => clients.delete(res));
          return;
        }
        if (req.method === 'POST' && req.url === '/api/control') {
          const input = await bodyJSON(req);
          if (Object.keys(input).some(key => !['action', 'sessionId'].includes(key))) return json(res, 400, { error: 'invalid_control' });
          if (input.action === 'pause' || input.action === 'resume') pipeline.setPaused(input.action === 'pause');
          else if (input.action === 'session' && typeof input.sessionId === 'string' &&
            input.sessionId.length <= 100 && pipeline.selectSession(input.sessionId)) { /* selected */ }
          else return json(res, 400, { error: 'invalid_control' });
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'not_found' });
      })().catch(() => {
        if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'invalid_input' });
        else if (!res.destroyed) res.destroy();
      });
    });
    web.on('connection', socket => {
      if (connections.size >= 64) return socket.destroy();
      connections.add(socket); socket.on('close', () => connections.delete(socket));
    });
    web.on('clientError', (_error, socket) => socket.destroy());
    web.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => { web.once('error', reject); web.listen(port, '127.0.0.1', resolve); });
    const actualPort = web.address().port, origin = `http://127.0.0.1:${actualPort}`;
    auth = createAuth({ origin, instanceId: lock.owner.instanceId });
    const launchURL = () => `${origin}/#token=${auth.launchToken()}`;
    function describe() {
      return { ok: true, protocol: PROTOCOL, instanceId: lock.owner.instanceId,
        projectId: paths.projectId, pid: process.pid, port: actualPort, mode,
        policy: { transmitSource: policy.transmitSource, displayEvidence: policy.displayEvidence,
          persistEvidence: policy.persistEvidence, version: policy.version },
        status: snapshot().status, ...persistence.stats(), captureDropped: drops,
        observations: { hooks: { ...receivedHooks }, shapes: pipeline.getState().graph.nodes.length },
        logPath: diagnostics.stats().logPath, diagnostics: diagnostics.stats() };
    }
    // Only the exclusive owner may remove a stale socket from a prior process.
    await rm(paths.socket, { force: true });
    ipc = net.createServer(socket => {
      if (ipcConnections.size >= 32) { drops++; socket.destroy(); return; }
      ipcConnections.add(socket);
      let bytes = 0, chunks = [], handled = false;
      const timer = setTimeout(() => { drops++; socket.destroy(); }, 500);
      socket.on('error', () => {});
      socket.on('close', () => { clearTimeout(timer); ipcConnections.delete(socket); });
      const reply = value => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`); };
      socket.on('data', chunk => {
        if (handled) return;
        bytes += chunk.length;
        if (bytes > MAX_IPC_BYTES) { drops++; socket.destroy(); return; }
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        handled = true; clearTimeout(timer);
        void (async () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          chunks = [];
          // A connection carries one bounded message, never an unbounded stream.
          if (raw.slice(raw.indexOf('\n') + 1).trim()) throw runtimeError('invalid_input');
          const input = JSON.parse(raw.slice(0, raw.indexOf('\n')));
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw runtimeError('invalid_input');
          if (input.op) {
            if (input.instanceId !== lock.owner.instanceId) return reply({ ok: false, code: 'wrong_instance' });
            if (input.op === 'health') return reply(describe());
            if (input.op === 'launch') return reply({ ...describe(), url: launchURL() });
            if (input.op === 'shutdown') {
              reply({ ok: true });
              // whenClosed reports the failure; also observe the outer async
              // close() promise so a rejected shutdown is never unhandled.
              setImmediate(() => { void close().catch(() => {}); });
              return;
            }
            if (input.op === 'export') return reply({ ok: true, snapshot: exportSnapshot(snapshot()) });
            if (input.op === 'diagnostics') {
              if (Object.keys(input).some(key => !['op', 'instanceId', 'artifactId'].includes(key))) {
                return reply({ ok: false, code: 'invalid_input' });
              }
              return reply({ ok: true, ...diagnostics.snapshot({ artifactId: input.artifactId }) });
            }
            return reply({ ok: false, code: 'invalid_operation' });
          }
          if (!HOSTS.has(input.host) || !input.payload || Array.isArray(input.payload) ||
              typeof input.payload !== 'object' || typeof input.payload.cwd !== 'string') throw runtimeError('invalid_input');
          if (intake >= 32) { drops++; return reply({ ok: false, code: 'overloaded' }); }
          intake++;
          try {
            if (await canonicalProjectRoot(input.payload.cwd) !== paths.projectRoot) throw runtimeError('wrong_project');
            const result = await pipeline.ingest(input.payload, { host: input.host });
            if (result?.accepted !== false) receivedHooks[input.host]++;
            reply({ ok: result?.accepted !== false });
          } finally { intake--; }
        })().catch(() => { drops++; reply({ ok: false, code: 'invalid_input' }); });
      });
    });
    await new Promise((resolve, reject) => { ipc.once('error', reject); ipc.listen(paths.socket, resolve); });
    await chmod(paths.socket, 0o600);
    interval = setInterval(() => { void reconcile(); }, 2000);
    ping = setInterval(() => {
      for (const res of clients) {
        if (res.writableLength > MAX_STATE_BYTES) { res.destroy(); clients.delete(res); }
        else res.write(': heartbeat\n\n');
      }
    }, 15_000);
    await reconcile();
    notify();
    return { url: launchURL(), port: actualPort, close, pipeline, whenClosed };
  } catch (error) {
    await close();
    throw error;
  }
}
