# Graphlin

Live architecture diagrams while **Claude Code or Codex** explores and builds your code.

![Graphlin showing function calls, a cache write, and a browser-to-service connection](docs/images/graphlin-preview.png)

## Get started

**You need:** macOS or Linux, Node.js 22.14+, Git, Claude Code or Codex CLI,
and a TypeSafe API key. No npm release or dependency install needed.

### 1. Start the viewer

In your project's terminal, enter your API key at the hidden prompt:

```sh
printf 'TypeSafe API key: '; read -r -s TYPESAFE_API_KEY; export TYPESAFE_API_KEY; printf '\n'
```

Clone Graphlin once, build its plugins, and start it for your current project:

```sh
git clone https://github.com/royosherove/graphlin.git "$HOME/graphlin" && node "$HOME/graphlin/scripts/build-packages.mjs"
node "$HOME/graphlin/scripts/graphlin.mjs" start --project "$PWD" --allow-source
```

Open the printed URL. Keep this terminal running; **Ctrl+C** stops the viewer.
`--allow-source` permits locally filtered source excerpts, user prompts, and
public agent messages to be sent to TypeSafe for classification.

### 2. Start your agent

Open a **second terminal in the same project**. Choose one:

**Claude Code**

```sh
claude --plugin-dir "$HOME/graphlin/dist/claude/graphlin"
```

**Codex**

```sh
codex plugin marketplace add "$HOME/graphlin/dist/codex" && codex plugin add graphlin@graphlin-local && codex
```

Approve plugin setup when prompted. In Codex, use **`/hooks`** to review and trust
Graphlin's hooks. Then ask either agent:

> Orient yourself in this project: read its main files and explain how the components connect.

Watch the diagram populate as it explores. On later runs, skip cloning,
building, and marketplace installation; start the viewer and launch your agent.

## Just looking?

Try the offline demo—no key or agent required:

```sh
npx --yes --package=github:royosherove/graphlin graphlin demo
```

## More

[User guide](docs/usage.md) · [Design](docs/graphlin-design.md) ·
[Contributing](CONTRIBUTING.md) · [Releasing](docs/releasing.md) · [MIT license](LICENSE)

Graphlin visualizes observable actions and code evidence. It does not capture
private reasoning or prove runtime connectivity. Development preview.
