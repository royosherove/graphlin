# Adapter scope

The root `plugin.json` and `mcp.json` follow Agent Plugins 1.0.0. OpenAI
presentation and the Codex hook path are under `extensions.com.openai`.
`.codex-plugin/plugin.json` remains a compatibility manifest for skill validation.
The native Claude manifest references its own hook profile and `.mcp.json`
uses Claude's root-variable substitution.

`scripts/build-packages.mjs` generates self-contained `portable/graphlin`,
`claude/graphlin`, `codex/graphlin`, and `kiro/graphlin` directories from this
source tree. No package contains machine-specific paths, a credential, installed
config, or a marketplace. The portable package contains skills and an MCP server;
native hook behavior is an extension, not a portable observation guarantee.

All hook commands call the same guarded POSIX launcher with their host name.
They read a bounded JSON input, resolve its `cwd` to the canonical worktree,
handoff through a private Unix socket, and exit 0 with no output. The collector
does not make HTTP requests, start a daemon, write raw spools, or change agent
inputs, outputs, permissions, or stop behavior. A stopped daemon loses events;
no recovery claim is made for events that never reached it.

Node.js 22+ and macOS/Linux are the implemented runtime profile. Windows
private-pipe ACLs and launch behavior are not certified. Default data is
`~/.local/state/graphlin`, shared by host adapters. Use the same
`GRAPHLIN_DATA_DIR` in hooks and controls for an override.

Package tests exercise fixtures, launcher outages, local IPC, MCP, and relocated
package paths. They do not certify that host hooks are loaded, trusted, or active.

Kiro is an active adapter. It uses Kiro's agent-hook contract (docs:
features/hooks): hooks live in the agent config JSON (`~/.kiro/agents/<agent>.json`
or `.kiro/agents/<agent>.json`) under a `hooks` object keyed by trigger
(`agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`). Kiro
delivers a bounded JSON hook event on STDIN carrying `cwd`, `hook_event_name`,
`tool_name`, `tool_input`, and `tool_response`; each hook command calls the same
guarded `collect.sh kiro` launcher, which hands off through the private Unix
socket and exits 0. The builder emits a `kiro/graphlin` package plus a mergeable
`.kiro-plugin/agent-config.json` fragment (hooks + the Graphlin MCP server) that
references the package through `${GRAPHLIN_PLUGIN_ROOT}`. As with every host,
activation/trust is the user's responsibility and is not certified by the package
fixtures. Nothing in this repository edits the user's Kiro configuration.
