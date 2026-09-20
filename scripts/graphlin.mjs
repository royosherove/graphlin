#!/usr/bin/env node
import { startDaemon, runForeground, stopDaemon, daemonStatus, doctor, exportDaemon, diagnosticLogs, publicError } from '../runtime/daemon/manager.mjs';
import { parseArguments } from './arguments.mjs';

const HELP = `Graphlin — local architecture and activity viewer (Node.js 22.14+, macOS/Linux).
  start --project PATH [--allow-source] [--persist-evidence] [--no-display-evidence] [--background]
  stop --project PATH
  status --project PATH
  doctor --project PATH
  demo [--data-dir PATH] [--background]
  export --project PATH
  logs --project PATH [--file PATH]
All commands accept --data-dir PATH (or GRAPHLIN_DATA_DIR).
Start and demo stay in this terminal by default; Ctrl+C gracefully stops the
joined instance. --background explicitly detaches. Repeated starts for the same
canonical project/data directory reuse its port and issue a fresh one-use URL.
Default: metadata only. --allow-source permits sanitized source/public intent to
TypeSafe using TYPESAFE_API_KEY from the daemon's environment. Approved evidence
is displayed by default; excerpts are persisted only with --persist-evidence.
Credentials, environment files, excluded paths, binary and oversized files are
filtered locally. Replay history is bounded to 7 days; an expired stopped-daemon
snapshot is deleted on the next startup. Current snapshots are private and bounded.
Policy changes require stop/start. Hooks never install themselves.
Demo uses local fixture answers and makes no remote requests.
Diagnostics retain bounded metadata in a private 300-record/512 KiB ring and two
1 MiB JSONL files. Source, prompts, and credentials are never logged. Safe paths
and labels require source permission and their display/persistence settings.
logs also works stopped, with paths and labels hidden; --file matches retained
artifact identity, including files since deleted.
`;

try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args[0] === 'help') process.stdout.write(HELP);
  else {
    const options = parseArguments(args);
    const print = result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    let result;
    if (options.command === 'start' || options.command === 'demo') {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      if (!options.background) for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
      try {
        if (options.command === 'demo') {
          const { createDemoProject } = await import('../runtime/daemon/demo.mjs');
          options.projectRoot = await createDemoProject(options.dataDir);
          options.mode = 'demo'; options.allowSource = true;
        }
        const ready = value => print(options.command === 'demo' ? { ...value, projectRoot: options.projectRoot } : value);
        if (options.background) ready(await startDaemon({ ...options, background: true }));
        else await runForeground({ ...options, signal: controller.signal }, ready);
      } finally {
        for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
      }
    } else if (options.command === 'stop') result = await stopDaemon(options);
    else if (options.command === 'status') result = await daemonStatus(options);
    else if (options.command === 'doctor') result = await doctor(options);
    else if (options.command === 'export') result = await exportDaemon(options);
    else if (options.command === 'logs') result = await diagnosticLogs(options);
    else throw new Error('unknown_command');
    if (result !== undefined) print(result);
  }
} catch (error) {
  process.stderr.write(`Graphlin: ${publicError(error)}. Run with --help for usage.\n`);
  process.exitCode = 1;
}
