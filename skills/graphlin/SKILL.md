---
name: graphlin
description: Start, stop, inspect, or diagnose the local Graphlin architecture and activity viewer for a coding project, or run its offline fixture demo.
---

# Graphlin

Use the bundled Graphlin MCP tools `start`, `stop`, `status`, and `doctor`
with an explicit `projectRoot`. The returned start URL contains a one-use,
one-minute launch token; open it for the user without copying it into project
files or logs. Run `start` again for a fresh URL if the token expires.

Default to metadata-only start. Set `allowSource: true` only when the user has
explicitly authorized sending permitted source snippets and public messages to
TypeSafe for this project. Set `persistEvidence: true` only for an explicit
request to retain approved evidence excerpts. Approved evidence display is on
by default and can be disabled with `displayEvidence: false`. Policies are
immutable for a running daemon; stop/start applies a policy change.

The service reads `TYPESAFE_API_KEY` only from its environment when source
transmission is enabled. Never place keys in tool arguments, manifests, URLs,
graphs, source files, or chat. If the key is missing, explain the status without
asking the user to paste the key. Metadata collection remains available.

When MCP is unavailable, use the packaged CLI with Node.js 22 or later:

```text
node <plugin-root>/scripts/graphlin.mjs start --project <project>
node <plugin-root>/scripts/graphlin.mjs status --project <project>
node <plugin-root>/scripts/graphlin.mjs doctor --project <project>
node <plugin-root>/scripts/graphlin.mjs stop --project <project>
node <plugin-root>/scripts/graphlin.mjs export --project <project>
node <plugin-root>/scripts/graphlin.mjs demo
```

Pass each path as a separate argument, quoting paths containing spaces. The
demo creates a dedicated local fixture project and runs source events through
the real pipeline using labeled offline answers. It never uses the paid API.
Export prints the currently displayed, sanitized snapshot as JSON.

The runtime supports private Unix sockets on macOS/Linux. Writable data defaults
to `~/.local/state/graphlin`, outside the installed bundle; `GRAPHLIN_DATA_DIR`
or CLI `--data-dir` can select another private directory. Hooks and controls
must use the same data directory. Snapshots are atomically written with mode
0600 and bounded to 2 MiB. Replay entries expire after seven days; an expired
stopped-daemon snapshot is deleted on the next startup, not by a background job.
Credentials, environment files, binary/oversized files, excluded paths, and
symlinks outside the project are excluded locally. Raw hook bodies are never
spooled. The no-training statement in TypeSafe's docs does not establish
default zero retention; ZDR is an enterprise offering.

Do not call drawing tools after each agent action. Passive hooks supply events
when the host has separately loaded and trusted them. Do not install a plugin,
create a marketplace, or change global host configuration as part of starting
the viewer. `doctor` reports versions and runtime connectivity; it does not
claim hook activation or trust. Kiro's profile is inactive and experimental.
Real host activation has not been certified by the package fixtures.

Explain diagram limits: source observations are not proof of runtime
connectivity, generic successful commands do not verify architecture, missing
events mean incomplete coverage, and private reasoning is not captured.
