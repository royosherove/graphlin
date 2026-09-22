# Graphlin

Live architecture diagrams while **Claude Code or Codex** explores and builds your code.

![Claude Code builds a checkout app while Graphlin draws its files and connections, starting from an empty canvas](docs/images/graphlin-live.gif)

*Real Claude Code terminal beside Graphlin's live diagram. Recorded session, accelerated. [Still image](docs/images/graphlin-preview.png).*

## Get started

**You need:** macOS or Linux, Node.js 22.14+, and Claude Code or Codex CLI.
Local parsing needs no key. Optional AI classification uses a TypeSafe API key.

### 1. Start the viewer

In your project's terminal:

```sh
npx --yes graphlin@latest
```

Graphlin asks which host to install, offers **local, source, or metadata** mode for this
project, and accepts your key at a **masked prompt** if needed. It stores the key
privately and builds stable plugins outside the npm cache. The browser opens
automatically. Keep this terminal running; **Ctrl+C** stops the viewer.

Source mode permits locally filtered source excerpts, user prompts, and public
agent messages to be sent to TypeSafe for classification.
Local mode parses JavaScript, TypeScript, TSX, and Python on your machine.

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

Watch **Blocks** light up as it explores: eyes for reading, a pen for editing.
On later runs, repeat step 1 and
launch your agent; Graphlin reuses the saved setup. Use the printed agent command
if you selected a custom data directory.

For setup alone, append `init` to the command. Append `uninstall` to remove
Graphlin's host plugins across projects while keeping your saved key and history.

Start in nested **Blocks**, or choose **Code**, **C4**, **Changes**, or **Activity timeline**.
Search with `/`, expand a source scope, or set a task baseline. Architecture
documents are optional; uncertain boundaries stay marked as unknown.

Build another view with the [visualizer SDK](docs/extension-authoring.md).
Install it with `npx graphlin extensions add package-name@version`, then approve
its project access in the viewer.

## Just looking?

Try the offline demo—no key or agent required:

```sh
npx --yes graphlin@latest demo
```

## How it works

The local diagram works without Jev. Optional requests require source consent
and local filtering, which can withhold whole files containing detected secrets.

```mermaid
sequenceDiagram
    box rgba(59,130,246,0.08) Your machine
        participant H as Agent hooks / repo scan
        participant P as Pipeline + local parser
        participant V as Project model + viewer
        participant D as DecisionService<br/>replaceable provider
    end
    box rgba(168,85,247,0.08) Optional external service
        participant J as Jev / TypeSafe
    end
    H->>P: Tool events + changed files
    P->>V: Parsed model + immediate exact-file activity
    P->>D: Source consent + locally filtered input
    alt Source analysis: classify / analyze
        D->>J: A — filtered text, privacy + relevance
        J-->>D: Intake verdicts
        D->>D: Select approved candidates locally
        opt Approved candidates remain
            D->>J: B — approved text, roles, links or boundaries
            J-->>D: Decisions
        end
    else Structured metadata: evaluate
        D->>J: Bounded metadata — membership or activity targets
        J-->>D: Decisions
    end
    D-->>P: Results + evidence references
    P->>V: Revalidate, apply, stream authenticated snapshots / SSE
```

**Source and architecture:** session/tool captures, changed source and public
messages can trigger `classify` for roles/links. Startup, source changes or
**Discover** trigger `analyze` for architecture boundaries; `evaluate` can then
check proposed membership pairs.

**Read/Edit:** the exact file highlights immediately. A bounded `evaluate` call
can add related symbols using filtered labels, ownership and safe line ranges.

## More

[User guide](docs/usage.md) · [Views](docs/visualizer-views.md) · [Design](docs/graphlin-design.md) ·
[Contributing](CONTRIBUTING.md) · [Releasing](docs/releasing.md) · [MIT license](LICENSE)

Graphlin visualizes observable actions and code evidence. It does not capture
private reasoning or prove runtime connectivity. Development preview.
