# Graphlin: from installation to a live diagram

Proposal, September 20, 2026. This document describes the recommended onboarding
experience. Commands marked **proposed** are product design, not commands that
work in the current release.

## Recommendation

Ship one plugin with two complementary entry points:

1. A small CLI performs first-time setup and can run Graphlin without an agent.
2. The bundled skill starts or reconnects Graphlin during everyday coding.

The plugin already includes `skills/graphlin/SKILL.md`, passive hooks, and MCP
controls for `start`, `stop`, `status`, and `doctor`. Keep those pieces. Improve
their coordination instead of asking users to install a separate skill, server,
hook script, and connector.

The installation problem happens before the skill is available. A CLI or the
host's plugin marketplace handles that first step. Once installed, the skill
should do almost everything the user needs.

## The intended first experience

**“Show me this project's architecture while my agent works.”**

| Step | What the user does | What Graphlin does | Visible confirmation |
|---|---|---|---|
| Try | Chooses **Try the demo** | Starts the bundled offline example; needs no key | Shapes appear with a clear Demo label |
| Install | Runs the setup command, or installs from a supported host marketplace | Installs one versioned plugin bundle containing skill, hooks, MCP server, and runtime | Graphlin installed for the selected host |
| Connect Jev | Enters a TypeSafe key once in a masked local prompt | Stores it outside the repository and tests a synthetic decision | Jev connected, or a specific fix |
| Choose project | Accepts the current folder | Records project settings and reuses its existing service when possible | Human-readable project name and folder |
| Allow analysis | Chooses **Analyze this project** | Records permission to send filtered code excerpts and public prompts to TypeSafe for this project | “Analysis on” |
| Open | Accepts **Run in this terminal**, or explicitly chooses **Let my agent manage it** | Starts the foreground service by default, or the managed service with visible Stop controls; opens a fresh viewer link | Viewer connected; how to stop is visible |
| Discover | Asks **Orient yourself in this project** | Observes the agent's actual reads/searches, queues evidence, and draws supported components | First hook received → code examined → first shape |
| Continue | Codes normally, including starting another session | Follows new sessions and updates the diagram | New session selected; live changes continue |
| Stop | Presses Ctrl+C in CLI mode or **Stop Graphlin** in managed mode | Stops the project's service and releases its port | Stopped; restart remains one action |

Don't make new users infer that a blank canvas is normal. Show the remaining
setup step or the next useful action in the empty canvas.

## Entry point A: one-time CLI setup

**Proposed**, after publishing and verifying ownership of the package name:

```sh
npx graphlin init
```

The installer asks only for decisions it cannot safely infer:

1. **Where do you use your agent?** Detect installed clients and offer Claude
   first for the initial release. Codex stays labeled **Preview** until a real
   installed plugin has delivered a read hook and produced an admitted shape.
   Host manifests and package tests alone are insufficient.
2. **This project or all your projects?** Default to this project; host-wide
   installation is an explicit choice.
3. **Connect Jev.** Use a masked terminal prompt or reuse an existing credential.
4. **Analyze this project?** “Allow Graphlin to send filtered code excerpts
   and public prompts from this project to TypeSafe.” Offer activity-only mode.

Infer the host and current project when there is one obvious choice. Show
installation scope as an optional setting rather than forcing another decision.
Check Node.js 22+ and the supported operating system before starting setup.

The installer invokes the host's supported plugin installation flow. It should
show the exact change before applying configuration and preserve unrelated
settings. It must not bypass the host's trust or hook approval UI. If the host
requires reload or a new session, say so and provide one actionable command.

An npx invocation is a bootstrap mechanism, not a permanent installation
directory. Install the versioned bundle into a stable Graphlin-managed location
and point the host to that location. Hooks must not depend on an evictable npx
cache or on this development checkout.

The final screen should be short:

```text
Graphlin is ready for this project.
Jev connected.
Graphlin is running in this terminal. Ctrl+C stops it.
Open Claude in another terminal and ask it to orient itself.
```

For users who explicitly choose managed operation, the final instruction can
instead be “Run /graphlin:graphlin in Claude,” with a visible way to stop the
managed service.

Only show “ready” after actual credential and host checks. If hook activation
cannot be verified until a new agent session, show “Waiting for the first hook”
instead of claiming the connection works.

Other **proposed** commands:

```sh
npx graphlin demo
npx graphlin start
npx graphlin status
npx graphlin doctor
npx graphlin stop
```

Keep command-line `start` in the foreground: Ctrl+C stops it, matching the
current behavior. Never start a second service for the same canonical project
just because a browser link needs refreshing.

## Entry point B: the installed skill

The simplest host-independent instruction is **“Start Graphlin for this
project.”** Claude's plugin namespace makes the current explicit skill command
`/graphlin:graphlin`. Codex can discover the installed skill by name; its
available invocation UI depends on the client.

The skill should:

1. Resolve the current project and ask the local control service for its status.
2. Reuse the running service, including its port and project policy.
3. If necessary, direct the user through missing credential or source-permission
   setup. Never ask for a key in chat.
4. Start the service once and open a fresh authenticated viewer link.
5. Offer **“Explore this project and build its diagram”** for an existing
   project, or **“Continue working”** if the diagram is already populated.

Exploration should be normal agent work. The skill can ask the agent to inspect
entry points, dependencies, modules, and storage boundaries. It should not issue
drawing commands or describe claims as verified simply to make the canvas look
busy.

Agent-managed start is a deliberate separate lifecycle from foreground CLI
start. The viewer needs an obvious **Stop Graphlin** control, the active project,
and clear running/stopped status before managed start becomes the primary
onboarding path. Stopping must target the identified project/instance.

The installed skill can repair its runtime connection. Installing a missing
plugin still belongs to the host or CLI, since the missing skill cannot run.

## The viewer's onboarding states

Use the canvas as a short checklist with one next action, rather than a separate
setup manual:

| State | Main message | Next action |
|---|---|---|
| Demo | “This is an example project.” | Use my project |
| No Jev key | “Connect Jev to draw architecture from your code.” | Connect Jev |
| Activity only | “Hooks are connected. Code analysis is off.” | Enable code analysis |
| Host not connected | “Waiting for your agent.” | How to connect |
| Host ready, no discovery | “Ask your agent to explore this project.” | Copy an orientation prompt |
| First hook | “Agent connected. Reading project files…” | Show hooks |
| Classification queued | “Building your diagram…” with completed/waiting counts | Show progress |
| No admissible shapes | “Activity arrived, but no code components were identified yet.” | See the reason |
| Working | The diagram, active session, and recent changes | Inspect evidence |
| Reconnecting | “The local service disconnected.” | Reconnect |
| Stopped | “Graphlin stopped for this project.” | Tell your agent “Start Graphlin,” or copy the foreground start command |

The first-hook signal must come from a real hook receipt, not a successful
health check. Likewise, “Jev connected” requires a validated response, and the
first-shape step requires an admitted graph change.

The optional hook feed and newest-first shape-change history make this journey
observable. They answer different questions: **Did the agent reach Graphlin?**
and **What changed in the diagram?**

## Credentials and consent without repeated setup

Store the key in the operating system's credential store where supported, with
a private user-level file as an explicit fallback. Avoid a `.env.local` in every
project. The CLI and daemon resolve the same credential reference; hooks need
neither the key nor a copy of it.

Retain project-scoped permission for filtered code excerpts and public prompts
so each new session doesn't ask again. Evidence display and evidence persistence
remain separate settings.
Changing a running service's immutable policy requires a controlled restart;
explain that consequence, keep the project selected, and reopen the viewer with
a fresh authenticated link. A page whose backend has stopped cannot restart that
backend by itself; use the installed CLI or agent skill.

Treat an inherited `TYPESAFE_API_KEY` as an existing credential. Never print
keys in generated commands, browser launch URLs, diagnostics, exported diagrams,
or installation reports.

## Returning-user journey

**“Start Graphlin.”**

The skill resolves the project, reuses or starts the service, opens the viewer,
and confirms the connection. A new Claude session automatically becomes the
active diagram when its SessionStart hook arrives. Old-session background work
does not steal the view. Users can still select another session deliberately.

Do not automatically launch servers from every hook. Passive hooks should stay
small and quiet when Graphlin is stopped.

## What exists, and what is missing

| Capability | Current repository | Needed for the proposed journey |
|---|---|---|
| Offline demo | Available | One obvious entry from the installer/viewer |
| CLI | Available as `scripts/graphlin.mjs` | Publishable package, short command, guided `init` |
| Skill | Included in the plugin | Credential setup guidance and verified readiness flow |
| MCP controls | Start, stop, status, doctor | Shared credential/config resolution |
| Plugin packages | Portable, Claude, Codex build outputs | Versioned public distribution and host installation orchestration |
| Hook installation | Host loads/trusts the plugin | Guided setup with real receipt verification |
| Jev key | Inherited environment, optional local env file in development | Secure user-level credential setup |
| Source consent | CLI flag or MCP argument | Durable project preference and clear setup choice |
| Server lifecycle | Foreground CLI, managed MCP start, project reuse | Obvious viewer stop control for managed mode |
| Diagnostics | Classification log, local status/doctor | First-hook/first-shape onboarding checks |
| Windows/Kiro | Current runtime is macOS/Linux; Kiro inactive | Separate compatibility work, not an installer promise |

The root npm package is currently private. **Do not advertise the proposed npx
commands as available until distribution, package ownership, and installation
tests are complete.**

## Delivery order

1. **Make the current experience understandable:** human project names,
   distinct waiting states, first-hook feedback, first-shape feedback, an
   orientation prompt, and a visible managed-service stop control.
2. **Remove repeated setup:** shared credential storage, per-project
   configuration, and a skill that starts/reconnects reliably.
3. **Ship one-command installation:** publish a versioned package and host
   plugin distributions, then implement idempotent `init`, update, and uninstall.
4. **Broaden compatibility:** graduate Codex from preview after real host
   activation checks, and then test Kiro/Windows
   separately, without presenting experimental adapters as ready.

The minimum first release is a tested Claude installation into a stable
directory, prerequisite checks, one masked key setup, persistent project consent,
foreground operation, and the existing skill improved for status/reuse and
orientation. Keep the demo optional. Defer browser credential editing, a resident
restart helper, and combined multi-host installation.

Success means a new user reaches a live diagram without editing hook JSON,
copying tokens, finding ports, or understanding the internal pipeline. Measure
time to first hook, time to first admitted shape, setup abandonment, successful
restart, and clean uninstall. Targets should be set after observing fresh-user
trials.

## Sources checked

- Existing implementation: `skills/graphlin/SKILL.md`, `scripts/arguments.mjs`,
  `scripts/control.mjs`, plugin manifests, `scripts/build-packages.mjs`, README.
- Claude plugin skills and namespaces:
  https://code.claude.com/docs/en/plugins
- Claude installation and marketplace flow:
  https://code.claude.com/docs/en/plugin-marketplaces
- OpenAI plugin packaging and distribution:
  https://developers.openai.com/plugins/build/plugins
- OpenAI skill discovery:
  https://developers.openai.com/codex/skills

Host capabilities and installation interfaces were checked on September 20,
2026. The journey deliberately distinguishes supported host flows from proposed
Graphlin commands.
