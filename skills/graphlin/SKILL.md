---
name: graphlin
description: Open, start, stop, inspect, diagnose, or guide explicit installation of the local Graphlin architecture and activity viewer for a coding project, or run its offline fixture demo.
---

# Graphlin

Use the bundled Graphlin MCP tools `start`, `stop`, `status`, and `doctor`
with an explicit `projectRoot`. The returned start URL contains a one-use,
one-minute launch token; open it for the user without copying it into project
files or logs. Run `start` again for a fresh URL if the token expires.

For “open Graphlin”, call `start` with the project and open the returned URL.
Omit policy fields to reuse the running or saved policy. A project without
saved consent defaults to metadata only. Set `allowSource: true` only when the user has
explicitly authorized sending permitted source snippets and public messages to
TypeSafe for this project. Set `persistEvidence: true` only for an explicit
request to retain approved evidence excerpts. Approved evidence display is on
by default and can be disabled with `displayEvidence: false`. Policies are
immutable for a running daemon; stop/start applies a policy change.

The service uses `TYPESAFE_API_KEY` or a privately saved user key when source
transmission is enabled. Never read credential settings or place keys in tool arguments, manifests, URLs,
graphs, source files, or chat. If the key is missing, explain the status without
asking the user to paste the key in chat. Direct them to `graphlin init` in their
own terminal for its masked prompt. Metadata collection remains available.
An explicitly empty environment key suppresses the saved key; unset it to use
the saved key.
For an incorrect/expired saved key, guide the user to `graphlin init --replace-key`
in their own terminal, then restart the viewer. The replacement prompt is masked.
Use `doctor` to inspect setup and classifier state; never test a key by sending
private project source.

For an empty diagram or missing shapes, use `status` and `doctor` first. Check
source consent, classifier/key status, and the viewer's hook feed. Use the
classification log or CLI `logs --file <path>` to investigate a specific file.
No hooks means check host installation and trust; hooks without shapes can
mean metadata mode, filtered source, stale evidence, or inconclusive classification.
Never treat installation success or a host version as proof hooks are active.

When MCP is unavailable, use the packaged CLI with Node.js 22 or later:

```text
node <plugin-root>/scripts/graphlin.mjs start --project <project>
node <plugin-root>/scripts/graphlin.mjs open --project <project>
node <plugin-root>/scripts/graphlin.mjs status --project <project>
node <plugin-root>/scripts/graphlin.mjs doctor --project <project>
node <plugin-root>/scripts/graphlin.mjs stop --project <project>
node <plugin-root>/scripts/graphlin.mjs export --project <project>
node <plugin-root>/scripts/graphlin.mjs logs --project <project>
node <plugin-root>/scripts/graphlin.mjs demo
```

Pass each path as a separate argument, quoting paths containing spaces. The
demo creates a dedicated local fixture project and runs source events through
the real pipeline using labeled offline answers. It never uses the paid API.
Export prints the currently displayed, sanitized snapshot as JSON.

The runtime supports private Unix sockets on macOS/Linux. Writable data defaults
to `.graphlin/` in the canonical repository root, automatically ignored by Git
and source discovery. This includes saved keys, settings, diagrams, logs, plugin
packages, and extensions. Subdirectories of one checkout share this folder;
worktrees keep separate state. Outside Git, the launch directory is the root.
`GRAPHLIN_DATA_DIR` or CLI `--data-dir` can select another private directory.
Hooks and controls must use the same data directory. Snapshots are atomically written with mode
0600 and bounded to 2 MiB. Replay entries expire after seven days; an expired
stopped-daemon snapshot is deleted on the next startup, not by a background job.
Credentials, environment files, binary/oversized files, excluded paths, and
symlinks outside the project are excluded locally. Raw hook bodies are never
spooled. The no-training statement in TypeSafe's docs does not establish
default zero retention; ZDR is an enterprise offering.

Do not call drawing tools after each agent action. Passive hooks supply events
when the host has separately loaded and trusted them. Do not install a plugin,
create a marketplace, or change global host configuration as part of opening
or diagnosing the viewer. For an explicit setup/install request, guide the user
to run this in their own project terminal:

```sh
npx --yes graphlin@latest init
```

The guided CLI detects Claude/Codex, installs through native host CLIs, asks for
project consent, and saves a key privately if required. It builds versioned
packages in the Graphlin data directory, outside npm's cache. Do not run an
interactive key prompt through an agent tool. Non-interactive setup requires
`--host claude|codex|both` and explicit `--no-source` or `--allow-source`;
source mode needs an existing saved/environment key. Never supply a key in argv.
Explicit source-enabled setup saves an environment key privately for future runs.
After installation, start a new host session in the project: `claude` or `codex`.
Review project trust and Graphlin in Claude's `/plugin`, or trust hooks using
Codex's `/hooks`. With a custom data directory, use the printed command.

For an explicit uninstall request, use `graphlin uninstall` (the same GitHub
package command with `uninstall` appended). It removes only Graphlin's host
plugins for all projects; keys, history, packages, and marketplace registrations
remain. Current project source/persistence consent resets, but a running viewer
keeps its active policy until stopped. Do not delete data to uninstall.

`doctor` reports versions and runtime connectivity; it does not
claim hook activation or trust. Kiro's profile is inactive and experimental.
Real host activation has not been certified by the package fixtures.

Explain diagram limits: source observations are not proof of runtime
connectivity, generic successful commands do not verify architecture, missing
events mean incomplete coverage, and private reasoning is not captured.
