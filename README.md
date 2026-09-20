# Graphlin

A local plugin for live architecture and activity diagrams while a coding agent works.

![Graphlin's Sketchbook diagram showing function calls, a cache write, and a browser-to-service connection](docs/images/graphlin-preview.png)

*A close-up from the offline demo. [See the full diagram](docs/images/graphlin-overview.png).*

**Development preview.** Graphlin is not published to npm yet. Use this checkout
to try it. The repository includes CI, plugin packaging, and a gated npm release
workflow; see [releasing](docs/releasing.md) for the remaining publication setup.

See the [proposed onboarding journey](docs/user-journey.md) for the recommended
one-time setup and everyday skill workflow. Its proposed `npx` commands are not
published commands yet.

The design uses Jev at two principal stages: **intelligent intake** (semantic normalization, contextual redaction, and candidate extraction) and **architecture decisions**. Focused code snippets go directly to Noul questions such as “does this function implement a database write?”, with optional Score evidence-strength diagnostics. Parsers help select context and resolve references; a library-specific semantic analyzer is not required for every relationship. A shared decision service can also support bounded alignment, grouping, enrichment, and contradiction checks. Local code owns privacy enforcement, evidence validity, precise drawing operations, and rendering.

## Try it

Requires Node.js 22.14+ on macOS or Linux. There are no package dependencies or
required build steps.

```sh
npm run demo
```

Open the local URL printed by the command. The demo uses synthetic source files
and recorded classifier answers; it makes no network API requests. It runs the
actual event normalization, evidence, decision, graph, and viewer components.
The command stays in your terminal. Press **Ctrl+C** to stop the service.
`start` behaves the same way; use `--background` only when you want it detached.

Starting again for the same canonical project and data directory reuses the
running service and port. A fresh one-use browser token does not mean a new
server. A foreground start can join an existing service; Ctrl+C stops that
joined service too. Separate projects or data directories have separate
services.

For your own project, start with metadata only:

```sh
node scripts/graphlin.mjs start --project /path/to/your/app
```

Source classification requires a TypeSafe key and explicit permission to
transmit sanitized excerpts:

```sh
node --env-file=.env.local scripts/graphlin.mjs start \
  --project /path/to/your/app --allow-source
```

Put `TYPESAFE_API_KEY=your-key` in `.env.local`. This file is ignored by Git.
Keep it local. The key is read by the daemon and never sent to the browser.
The command above loads the key file from your current directory.

Local filtering excludes credential/environment files, configured exclusions,
binary/oversized files, and obvious secret values before Jev sees anything.
Jev adds contextual filtering. Approved evidence is displayed by default;
use `--no-display-evidence` to hide it. Evidence persistence is a separate
opt-in, `--persist-evidence`. A policy change requires stopping and restarting
the daemon.

```sh
node scripts/graphlin.mjs doctor --project /path/to/your/app
node scripts/graphlin.mjs status --project /path/to/your/app
node scripts/graphlin.mjs export --project /path/to/your/app
node scripts/graphlin.mjs stop --project /path/to/your/app
```

State lives under `~/.local/state/graphlin` by default. Set
`GRAPHLIN_DATA_DIR` or use `--data-dir` to choose another location.
Source excerpts are ephemeral unless persistence is enabled. Retention and
payload sizes are bounded.

## Investigate a missing shape

Select **Classification log** in the viewer and search for a file, such as
`src/cache.ts`, or an entity name. The log connects file capture and candidate
selection to Jev's intake scores, role/relation decisions, and the final diagram
changes. It also explains work that never reaches Jev: duplicate events,
pre-tool intentions, withheld source, empty candidates, and capacity limits.

From another terminal:

```sh
node scripts/graphlin.mjs logs --project /path/to/your/app
node scripts/graphlin.mjs logs --project /path/to/your/app --file src/cache.ts
```

Logging is automatic. After updating Graphlin, stop the existing service with
**Ctrl+C** and run the same `start` command again. A running process cannot load
the new logger, and old classifier scores cannot be reconstructed.

Each classification records the effective thresholds, both request durations,
model/rubric versions, validated scores, and fixed rejection reasons. A successful
classification can still result in no change because source changed while it
was running, an entity is already current, or a drawing limit was reached.
The log distinguishes those outcomes from an API failure or timeout.

Logs contain no source bodies, prompts, credentials, launch tokens, or raw API
errors. Live file names and candidate labels follow the evidence-display setting;
persisted logs omit them unless `--persist-evidence` is enabled. The `--file`
filter also matches stable artifact IDs, including after a file is deleted.
The service prints its log location. Retention is bounded to a recent in-memory
window and two private JSONL files; logs remain separate from diagram exports.

## Plugin packages

```sh
npm run build
claude --plugin-dir ./dist/claude/graphlin
```

The build creates a `graphlin/` plugin inside `dist/portable`, `dist/claude`,
and `dist/codex`. Start
Graphlin for the project before working with the agent; passive hooks quietly
hand off events to the running service. A bundled MCP server also exposes
start, stop, status, and doctor controls.

The portable package uses Agent Plugins 1.0. Claude has its native manifest;
Codex has its portable extension and compatibility manifest. Kiro currently
has an experimental adapter profile. See [adapter coverage](adapters/README.md).
Building a package does not install it into your host configuration.

The first implementation is Claude-first. Configuration and payload fixtures
are tested separately from real host activation. It does not claim universal
hook coverage or access to private reasoning.

## Connect an agent

In the live viewer, select **How to connect**. The guide shows copyable commands
using that service's project, data directory, and available plugin packages.
Its build step puts versioned plugins under the service's data directory, so
setup also works when Graphlin's installation folder is read-only.
Keep Graphlin running in its terminal and run the agent in another terminal.
The Jev key stays with the service; the agent commands do not include it.

Claude Code uses `claude --plugin-dir` to load the built Claude profile.
The guide also shows how to resume a session with that profile.

The build includes a local Codex marketplace under `dist/codex`. From this
checkout, the setup commands are:

```sh
npm run build
codex plugin marketplace add "$PWD/dist/codex"
codex plugin add graphlin@graphlin-local
codex -C /path/to/your/app
```

Inside Codex, use `/hooks` to review and trust Graphlin's hooks. Start a new
session after installation. Building the marketplace only creates files;
the commands above register and install it when you run them.
If the service uses a custom data directory, use the guide's command so the
agent inherits the matching `GRAPHLIN_DATA_DIR`.

The command forms were checked against the installed CLIs and the official
[plugin packaging](https://developers.openai.com/plugins/build/plugins) and
[Codex hooks](https://developers.openai.com/codex/hooks) documentation.
Installation and hook trust still depend on your host configuration.

## Discover an existing project

Start Graphlin with `--allow-source`, connect Claude with the built plugin,
and ask it to **“orient yourself in this project”** or **“explore the architecture.”**
Completed reads, searches, and file listings can populate the diagram without
editing any files. There is no special prompt keyword or extra agent tool.

The existing `PostToolUse` hook supplies both the tool arguments and its result.
Graphlin recognizes returned file paths from Read, Glob, structured Grep results,
and common `find`, `rg --files`, and simple `ls` listings. It treats those paths as
hints and captures the current files from disk through the normal project and
privacy checks. Arbitrary shell output and an agent's summary do not become
confirmed source evidence. The hook never modifies Claude's tool result.

Classification runs asynchronously with two active workflows. Each receives its
own five-second deadline when it starts, so time waiting behind other file reads
does not consume that deadline. Queued source is checked again before
classification and before a result reaches the diagram. Work is deduplicated
within each session; another session can discover the same unchanged project.
The classification log records queue wait time and why work was skipped.

Discovery is bounded: the fallback directory scan visits at most 100 directories,
five levels deep, and selects up to 64 source files; explicit tool results can
identify additional files. The queue holds up to 64 waiting workflows for at most
two minutes. Excluded, unavailable, oversized, or sensitive files remain subject
to the existing evidence policy. A shape means code was observed; it does not
mean a database connection or other runtime operation succeeded.

Run `npm run eval:discovery` to replay a burst of orientation reads against real
Jev using a temporary, synthetic seven-file project. It reports per-file diagram
coverage, queue timing, and missing files. The probe uses `TYPESAFE_API_KEY` or
the local `.env.local`; it never reads your application or Claude transcript.

## Follow live work

A new Claude session automatically becomes the selected diagram when its
`SessionStart` hook arrives. Ordinary hooks, delayed classifications, and
background compaction from another session do not take the selection away.
You can still choose an older session manually.

Expand **Hooks received** in the sidebar to see individual hook receipts from
all sessions in this project, newest first. Pre-tool, post-tool, and repeated
deliveries remain separate. The feed holds up to 200 receipts in memory and
contains event metadata, not tool bodies, prompts, or credentials.

**Diagram changes** stacks miniature added, removed, and changed shapes, with
the latest revision at the top. Select a current shape to inspect its evidence,
or a removed shape to replay the preceding retained revision. History is bounded;
gaps and unavailable older revisions are identified. Theme, zoom, and layout
changes do not create architecture history.

Restart an older Graphlin service and reload the viewer to enable the detailed
hook feed. Receipts from before that restart cannot be reconstructed.

## Arrange the diagram

Choose **Hierarchy**, **Dependency flow**, **Group by type**, **Circular**,
**Grid**, or **Original**. Auto-arrange responds to changes in the diagram;
turn it off to keep existing shapes in place, then use **Arrange** when ready.
Hierarchy follows the arrows and handles cycles; it does not imply ownership.

Architecture changes, layout switches, and **Arrange** automatically fit the
diagram to the available width and height. The view zooms out before new shapes
appear, including below 50% for large hierarchies. Removal effects remain visible
before the view settles around the remaining shapes. Ordinary hook and status
updates preserve manual zoom and pan.

Twelve component kinds map to distinct shapes, including functions, classes,
interfaces, events, configuration, packages, queues, and datastores.
Select a component to choose among 15 shapes in the inspector. Long names
wrap to two lines; the inspector retains the full name.

Shapes use deterministic hand-drawn outlines. The **Theme** selector offers
Sketchbook, Ocean, Forest, Sunset, Berry, Sepia, Blueprint dark, and Midnight
dark. Component kinds have coordinated fill colors; evidence labels and line
patterns remain distinct in every theme. Themes apply to the diagram and its
controls, leaving the evidence inspector readable in the surrounding interface.

New components inflate with a small bounce. Removed components pop into
particles. Replay, initial loading, reconnection, and stale evidence do not
trigger these effects. Reduced-motion preferences are respected.

Layouts and shape overrides affect the view only. They do not change evidence,
classification, recorded coordinates, or exported graphs. View preferences
are kept in memory per project/session/replay view and reset on page refresh.

## Test

The following development and evaluation commands require a source checkout.
They are not part of the installed runtime package.

```sh
npm test
```

The automated suite uses local fixtures and injected transports. It checks
privacy, the A-to-B boundary, HTTP response validation, deadlines, event
correlation, source-version invalidation, graph integrity, replay, local
authentication, packaging, and viewer behavior.

An explicit live evaluation calls Jev with synthetic code cases:

```sh
npm run eval:jev
node scripts/evaluate-jev.mjs --repeat 3
```

This command reads `TYPESAFE_API_KEY`, optionally from `.env.local`, and saves
a numeric report in the ignored `.graphlin/` directory. It never sends your
project source. It reports missing candidates/questions and timeouts as
inconclusive. The default request cap is 128; explicit repeats keep their
earlier failures in the report. These examples are a smoke evaluation, not a
calibrated benchmark. See [live findings](docs/jev-integration-findings.md).

The implementation uses JavaScript ES modules on Node.js, with HTML, CSS,
and JavaScript in the viewer. TypeSafe provides an official JavaScript/TypeScript
SDK, `@typesafe-ai/sdk`. This first slice uses the documented HTTP API through
Node's built-in `fetch`, keeping installation dependency-free while controlling
the complete request deadline, response bounds, and retry policy.

## Evidence and limits

- Jev interprets focused snippets. A classified write path does not prove a
  live database connection or a successful write.
- Pre-tool events show pending activity; they cannot confirm future changes.
- File observations have their own versions and unknown authorship. Changes
  invalidate dependent claims across sessions even when Jev is unavailable.
- Restored claims start stale until fresh authorized observations support them.
- Streaming message assembly, semantic alias merging, broad static analysis,
  account-wide budgets, and Windows transport are outside this first slice.
- Request budgets are per daemon. Classification can pause while metadata and
  evidence invalidation continue.

## Design and review

- [Proposed design](docs/graphlin-design.md): architecture, plugin packaging, host coverage, Jev requests, state, drawing language, failure behavior, and delivery plan.
- [Interactive walkthrough](docs/graphlin-design.html): replay a build, failed check, later verification, component removal, and Jev outage; inspect the two-stage pipeline.
- [Independent review](docs/graphlin-review.md): prioritized findings and follow-up status.
- [Research coverage](docs/research-coverage.md): primary documentation and design decisions.
- [Implementation plan](docs/implementation-plan.md) and [module contracts](docs/module-contracts.md).
- [Preimplementation review](docs/implementation-review.md).
- [Implementation validation](docs/implementation-validation.md): code review,
  automated tests, browser checks, and remaining scope.
- [Jev patterns](docs/jev-patterns.md): intent routing, speculative fan-out,
  confidence gates, and evaluation before enabling domain routing.

Open the HTML file directly in a browser, or serve `docs/` with a local static web server. The walkthrough is self-contained and makes no network API calls.

The design walkthrough remains illustrative. The live viewer is served by the
runtime started through the commands above.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review guidance,
[SECURITY.md](SECURITY.md) for vulnerability reporting, and
[the release guide](docs/releasing.md) for npm publishing.
Graphlin is available under the [MIT license](LICENSE).
