# Graphlin

Live architecture diagrams while **Claude Code or Codex** explores and builds your code.

![Graphlin showing function calls, a cache write, and a browser-to-service connection](docs/images/graphlin-preview.png)

## Get started

**You need:** macOS or Linux, Node.js 22.14+, and Claude Code or Codex CLI.
Source classification also needs a TypeSafe API key; metadata mode needs no key.

### 1. Start the viewer

In your project's terminal:

```sh
npx --yes graphlin@latest
```

Graphlin asks which host to install, offers **source or metadata** mode for this
project, and accepts your key at a **masked prompt** if needed. It stores the key
privately and builds stable plugins outside the npm cache. The browser opens
automatically. Keep this terminal running; **Ctrl+C** stops the viewer.

Source mode permits locally filtered source excerpts, user prompts, and public
agent messages to be sent to TypeSafe for classification.

### 2. Start your agent

Open a **second terminal in the same project**. Choose one:

**Claude Code**

```sh
claude
```

**Codex**

```sh
codex
```

Accept the host's project trust prompt. In Claude, use **`/plugin`** to confirm
Graphlin is enabled. In Codex, use **`/hooks`** to review and trust Graphlin's
hooks. Start a new agent session after installation. Then ask either agent:

> Orient yourself in this project: read its main files and explain how the components connect.

Watch the diagram populate as it explores. On later runs, repeat step 1 and
launch your agent; Graphlin reuses the saved setup. Use the printed agent command
if you selected a custom data directory.

For setup alone, append `init` to the command. Append `uninstall` to remove
Graphlin's host plugins across projects while keeping your saved key and history.

## Just looking?

Try the offline demo—no key or agent required:

```sh
npx --yes graphlin@latest demo
```

## More

[User guide](docs/usage.md) · [Design](docs/graphlin-design.md) ·
[Contributing](CONTRIBUTING.md) · [Releasing](docs/releasing.md) · [MIT license](LICENSE)

Graphlin visualizes observable actions and code evidence. It does not capture
private reasoning or prove runtime connectivity. Development preview.
