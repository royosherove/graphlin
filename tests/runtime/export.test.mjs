import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../runtime/daemon/server.mjs';
import { exportSnapshot } from '../../runtime/daemon/export.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { health } from '../../runtime/daemon/lock.mjs';
import { requestIPC } from '../../runtime/daemon/ipc.mjs';
import { workspace, authenticate } from './helpers.mjs';

function withEvidence(base) {
  const graph = (revision, label) => ({
    schemaVersion: 1, revision,
    nodes: [{ id: 'node-safe', label, kind: 'service', sourceRefs: [
      { artifactId: 'artifact-safe', hash: 'hash-safe', startLine: 2, endLine: 3, excerpt: `EXCERPT_${label}_NODE` },
    ] }],
    edges: [{ id: 'edge-safe', source: 'node-safe', target: 'other-safe', label: 'writes', sourceRefs: [
      { artifactId: 'artifact-safe', hash: 'hash-safe', excerpt: `EXCERPT_${label}_EDGE` },
    ] }],
  });
  return { ...base, graph: graph(3, 'safe current label'),
    history: [{ revision: 2, graph: graph(2, 'safe historical label') }],
    sessionStates: [{ id: 'saved-session', graph: graph(4, 'safe session label'),
      history: [{ revision: 1, graph: graph(1, 'safe session historical label') }] }],
  };
}

function assertSafeExport(result, source) {
  assert.equal(JSON.stringify(result).includes('EXCERPT_'), false);
  assert.equal(JSON.stringify(result).includes('"excerpt"'), false);
  assert.equal(result.graph.nodes[0].label, 'safe current label');
  assert.equal(result.history[0].graph.nodes[0].label, 'safe historical label');
  assert.equal(result.sessionStates[0].graph.nodes[0].label, 'safe session label');
  assert.equal(result.sessionStates[0].history[0].graph.nodes[0].label, 'safe session historical label');
  assert.equal(result.graph.nodes[0].sourceRefs[0].hash, 'hash-safe');
  assert.equal(JSON.stringify(source).match(/"excerpt"/g).length, 8, 'the original viewer projection stays intact');
}

test('shared export projection strips node/edge excerpts at every graph depth without removing safe labels', () => {
  const source = withEvidence({ schemaVersion: 1 });
  assertSafeExport(exportSnapshot(source), source);
});

test('authenticated HTTP and private IPC exports omit excerpts regardless of display and persistence settings', async t => {
  for (const displayEvidence of [true, false]) for (const persistEvidence of [false, true]) {
    await t.test(`display=${displayEvidence}, persist=${persistEvidence}`, async t => {
      const setup = await workspace(t);
      let calls = 0;
      // Temporary in-process transport fixture only: no detached daemon,
      // source capture, fixture replay, or live decision service.
      const server = await startServer({ ...setup, policy: { displayEvidence, persistEvidence },
        decisionService: { classify() { calls++; throw new Error('unexpected_request'); },
          stats: () => ({ calls }), close() {} } });
      try {
        const source = withEvidence(server.pipeline.getState());
        // Inject a projected snapshot at the transport boundary to include all
        // graph containers, even ones currently omitted by a display policy.
        const originalState = server.pipeline.getState;
        server.pipeline.getState = () => structuredClone(source);
        const { origin, cookie } = await authenticate(server);
        const displayed = await (await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } })).json();
        assert.equal(JSON.stringify(displayed).match(/"excerpt"/g).length, 8);
        const response = await fetch(`${origin}/api/export`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-disposition'), /attachment/);
        const httpExport = await response.json();
        assertSafeExport(httpExport, source);
        const paths = await projectPaths(setup.projectRoot, setup.dataDir);
        const owner = await health(paths);
        const ipcExport = await requestIPC(paths.socket, { op: 'export', instanceId: owner.instanceId });
        assert.equal(ipcExport.ok, true);
        assertSafeExport(ipcExport.snapshot, source);
        assert.deepEqual(ipcExport.snapshot, httpExport);
        assert.equal(calls, 0);
        server.pipeline.getState = originalState;
      } finally { await server.close(); }
    });
  }
});
