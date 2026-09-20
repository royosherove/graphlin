import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDemoProject, demoDecisionService, replayDemo, prepareDemoChange } from '../../runtime/daemon/demo.mjs';
import { startServer } from '../../runtime/daemon/server.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { requestIPC } from '../../runtime/daemon/ipc.mjs';
import { authenticate } from '../runtime/helpers.mjs';

// Capture the real server's event order before installing the renderer's fake
// clock/DOM. The injected offline classifier never reads a key or calls Jev.
export async function captureDemoStream() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'graphlin-viewer-stream-'));
  const controller = new AbortController();
  const frames = [], waiting = new Set();
  let server, reader, reading, failure;
  function ready(predicate) {
    if (failure) return Promise.reject(failure);
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        check() {
          if (!failure && !predicate()) return;
          clearTimeout(timer);
          waiting.delete(waiter);
          failure ? reject(failure) : resolve();
        },
      };
      const timer = setTimeout(() => {
        waiting.delete(waiter);
        reject(new Error('demo_snapshot_timeout'));
      }, 5000);
      waiting.add(waiter);
    });
  }
  try {
    const projectRoot = await createDemoProject(dataDir);
    server = await startServer({
      projectRoot, dataDir, mode: 'demo', decisionService: demoDecisionService(),
      policy: { transmitSource: true, displayEvidence: true },
    });
    await replayDemo(server.pipeline, projectRoot);
    const { origin, cookie } = await authenticate(server);
    const initial = await (await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } })).json();
    const response = await fetch(`${origin}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    reader = response.body.getReader();
    reading = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          assert.ok(buffer.length < 2 * 1024 * 1024, 'stream buffering is bounded');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!event.startsWith('event: snapshot\ndata: ')) continue;
            const data = event.slice('event: snapshot\ndata: '.length);
            assert.ok(frames.length < 40, 'the fixture cannot collect an unbounded stream');
            frames.push(JSON.parse(data));
            for (const waiter of waiting) waiter.check();
          }
        }
        if (!controller.signal.aborted) throw new Error('unexpected_stream_close');
      } catch (error) {
        if (controller.signal.aborted) return;
        failure = error;
        for (const waiter of waiting) waiter.check();
      }
    })();
    await ready(() => frames.length > 0);
    const paths = await projectPaths(projectRoot, dataDir);
    for (const action of ['add', 'remove', 'add', 'remove', 'add', 'remove']) {
      const after = frames.length;
      const message = await prepareDemoChange(projectRoot, { action });
      assert.equal((await requestIPC(paths.socket, message, { timeoutMs: 5000 })).ok, true);
      await server.pipeline.whenIdle();
      const expected = action === 'add' ? 20 : 18;
      await ready(() => frames.slice(after).some(frame => frame.graph.nodes.length === expected && frame.status.pending === 0));
    }
    return { initial, frames };
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await reading;
    await server?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
