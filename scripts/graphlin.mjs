#!/usr/bin/env node
import { startDaemon, runForeground, stopDaemon, daemonStatus, doctor, exportDaemon, diagnosticLogs, publicError } from '../runtime/daemon/manager.mjs';
import { parseArguments } from './arguments.mjs';
import { initOnboarding, uninstallOnboarding, needsOnboarding, openViewer, agentInstructions } from './onboarding.mjs';
import { readSettings } from '../runtime/daemon/settings.mjs';
import { projectPaths } from '../runtime/daemon/paths.mjs';
import { prepareProjectState } from '../runtime/daemon/migration.mjs';
import { runExtensions } from './extensions.mjs';

const HELP = `Graphlin — local architecture and activity viewer (Node.js 22.14+, macOS/Linux).
  graphlin                           Guided setup if needed, then foreground start
  init [--host claude|codex|both] [--allow-source|--local-source|--no-source] [--replace-key]
  start --project PATH [--allow-source|--local-source|--no-source] [--persist-evidence] [--no-display-evidence] [--background] [--no-open]
  open --project PATH                Open/reopen the viewer; start detached if needed
  uninstall [--host claude|codex|both]
  stop --project PATH
  status --project PATH
  doctor --project PATH
  demo [--data-dir PATH] [--background]
  export --project PATH
  logs --project PATH [--file PATH]
  extensions list                    List installed visualizers and approvals
  extensions add PACKAGE@VERSION     Install without running package scripts
  extensions dev ./DIRECTORY         Install a local development snapshot
  extensions update PACKAGE@VERSION  Replace an installed visualizer
  extensions remove ID
  extensions doctor
All commands accept --project PATH and --data-dir PATH (or GRAPHLIN_DATA_DIR).
Writable data defaults to .graphlin/ at the canonical repository root, ignored
by Git. Subfolders share that root; worktrees have separate state. Keys, settings,
diagrams, logs, plugin packages and extensions stay there unless overridden.
init installs for your user account using the host CLIs; it saves project consent
and offers a masked key prompt only in a terminal. Non-interactive init requires
--host and one source mode; remote source also needs a saved/environment key.
init --replace-key replaces a saved key at the masked prompt; it requires a terminal.
uninstall removes only Graphlin host plugins for all projects, retaining keys,
history, packages and marketplace registrations; it resets current project consent.
Start and demo stay in this terminal by default; Ctrl+C gracefully stops the
joined instance. --background explicitly detaches. Repeated starts for the same
canonical project/data directory reuse its port and issue a fresh one-use URL.
Omitted policy flags reuse current/saved consent. Without consent: metadata only.
--no-source explicitly opts out; --allow-source permits sanitized source/public
intent to TypeSafe using TYPESAFE_API_KEY or the privately saved key. Approved evidence
is displayed by default; excerpts are persisted only with --persist-evidence.
--local-source parses supported source on this machine, without remote decisions.
Metadata mode inventories paths without opening source files. Visualizers require
project approval in the viewer before receiving data; custom renderers run in a
sandboxed frame. Install or mount does not run decision profiles.
Credentials, environment files, excluded paths, binary and oversized files are
filtered locally. Replay history is bounded to 7 days; an expired stopped-daemon
snapshot is deleted on the next startup. Current snapshots are private and bounded.
Policy changes require stop/start. Hooks never install themselves. Interactive
starts open a browser automatically; --no-open suppresses this.
Demo uses local fixture answers and makes no remote requests.
Diagnostics retain bounded metadata in a private 300-record/512 KiB ring and two
1 MiB JSONL files. Source, prompts, and credentials are never logged. Safe paths
and labels require source permission and their display/persistence settings.
logs also works stopped, with paths and labels hidden; --file matches retained
artifact identity, including files since deleted.
`;

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args[0] === 'help') process.stdout.write(HELP);
  else if (args[0] === 'extensions') {
    const globalArgs = [], extensionArgs = [];
    for (let index = 1; index < args.length; index++) {
      if (['--project', '--data-dir'].includes(args[index])) globalArgs.push(args[index], args[++index]);
      else extensionArgs.push(args[index]);
    }
    const { projectRoot, dataDir } = parseArguments(['status', ...globalArgs]);
    await runExtensions(extensionArgs, { projectRoot, dataDir });
  }
  else {
    const options = parseArguments(args);
    const print = result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    let result;
    if (['start', 'demo', 'open', 'init', 'uninstall'].includes(options.command)) {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
      try {
        if (['start', 'open', 'init'].includes(options.command)) {
          const { migration } = await prepareProjectState(options);
          if (migration.status === 'migrated') {
            process.stderr.write('Repository state migrated into .graphlin/. Existing local files were preserved; the old data remains as a backup.\n');
            if (migration.extensionsToReinstall) process.stderr.write(
              'Legacy visualizer extensions need reinstalling and approval in this repository. A recovery inventory is saved in .graphlin/.\n');
            if (migration.skipped?.length) process.stderr.write(
              'Some incomplete legacy diagnostic logs were left in the backup; the migration record lists them.\n');
          }
        }
        if (options.command === 'init') result = await initOnboarding({ ...options, signal: controller.signal });
        else if (options.command === 'uninstall') result = await uninstallOnboarding({ ...options, signal: controller.signal });
        else {
          if (options.guided && await needsOnboarding(options)) {
            const setup = await initOnboarding({ ...options, signal: controller.signal });
            Object.assign(options, setup.policy);
          }
          if (options.command === 'demo') {
            const { createDemoProject } = await import('../runtime/daemon/demo.mjs');
            const caller = await projectPaths(options.projectRoot, options.dataDir, { create: true });
            options.dataDir = caller.dataDir;
            options.projectRoot = await createDemoProject(caller.dataDir, { projectRoot: caller.projectRoot });
            options.mode = 'demo'; options.allowSource = true;
          }
          let browser = Promise.resolve();
          let instructions;
          if (interactive && options.command !== 'demo') {
            const paths = await projectPaths(options.projectRoot, options.dataDir);
            const saved = await readSettings(paths);
            instructions = agentInstructions({ ...paths, hosts: saved.installation?.hosts?.length ? saved.installation.hosts : undefined });
          }
          const ready = value => {
            print(options.command === 'demo' ? { ...value, projectRoot: options.projectRoot } : value);
            if (instructions) process.stderr.write(instructions);
            if (options.openBrowser !== false && (interactive || options.command === 'open')) {
              browser = openViewer(value.url, { signal: controller.signal }).catch(() => {
                process.stderr.write('Could not open a browser automatically. Open the printed one-use URL; run graphlin open for a fresh URL if it expires.\n');
              });
            }
          };
          if (options.background || options.command === 'open') ready(await startDaemon({ ...options, background: true }));
          else await runForeground({ ...options, signal: controller.signal }, ready);
          await browser;
        }
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
  const argumentErrors = new Set(['duplicate_argument', 'invalid_argument', 'invalid_port', 'conflicting_arguments',
    'unknown_argument', 'invalid_host', 'unknown_command']);
  const message = error?.onboarding ? error.message : argumentErrors.has(error?.message) ? error.message : publicError(error);
  const nextStep = message === 'legacy_daemon_running'
    ? 'Stop the existing viewer with Ctrl+C, then run Graphlin again to migrate this repository into .graphlin/.'
    : message === 'tracked_state_directory'
      ? 'Graphlin could not verify that .graphlin/ is untracked. Make Git available and review any tracked files there; remove them from the index while keeping local copies before retrying.'
    : /legacy|migration/.test(message)
      ? 'The previous data remains in its original location. Stop older viewers and retry, or use --data-dir PATH to inspect that location.'
    : message === 'policy_restart_required'
    ? 'Stop the current viewer with Ctrl+C or graphlin stop, then run Graphlin again to apply the saved settings.'
    : 'Run with --help for usage.';
  process.stderr.write(`Graphlin: ${message}. ${nextStep}\n`);
  process.exitCode = error?.code === 'cancelled' ? 130 : 1;
}
