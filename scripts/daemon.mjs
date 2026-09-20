import { startServer } from '../runtime/daemon/server.mjs';
import { parseArguments } from './arguments.mjs';

process.umask(0o077);
let server;
try {
  const options = parseArguments(process.argv.slice(2), { worker: true });
  const policy = { transmitSource: options.allowSource, persistEvidence: options.persistEvidence,
    displayEvidence: options.displayEvidence };
  let decisionService;
  if (options.mode === 'demo') {
    const { demoDecisionService } = await import('../runtime/daemon/demo.mjs');
    decisionService = demoDecisionService();
  }
  server = await startServer({ ...options, policy, decisionService });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    void server.close().then(() => process.exit(0), () => process.exit(1));
  });
  if (options.mode === 'demo') {
    const { replayDemo } = await import('../runtime/daemon/demo.mjs');
    await replayDemo(server.pipeline, options.projectRoot);
  }
  const stopped = await server.whenClosed;
  if (!stopped.ok) process.exitCode = 1;
} catch {
  await server?.close().catch(() => {});
  process.exitCode = 1;
}
