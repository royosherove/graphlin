# Graphlin implementation plan

Baseline: `c3547e9`. This plan implements the Claude-first MVP from the design.
The coordinator owns integration and code review; workers own disjoint modules.
Design review must finish before implementation starts.

## Deliverable

A runnable Node.js 22+ plugin with no required build step: passive Claude hooks,
a per-project local daemon, actual two-stage Jev requests when explicitly
configured, deterministic evidence-backed graph updates, and a local live viewer.
An offline demo uses recorded classifier answers and is visibly identified as a
demo. Portable and native packages are generated from the same source.
Codex and Kiro profiles are supplied only at the compatibility level established
by fixtures; installing them does not imply end-to-end host certification.

## Decisions to review before coding

1. The default is metadata-only. A user command explicitly enables sanitized
   source transmission to TypeSafe. `TYPESAFE_API_KEY` is read only by the local
   decision worker. Keys never enter manifests, graph state, browser payloads,
   errors, or journals. No paid requests are needed for implementation tests.
2. The hook process has a short, bounded local handoff and exits successfully
   with no control/context output. It does not start a remote call. Missing
   runtime/daemon, malformed input, and overload must preserve agent behavior.
3. Start one daemon per canonical project/worktree root and data directory.
   Exclusive ownership and a health handshake prevent competing writers.
   Capture uses a private local socket; browser control uses authenticated
   loopback HTTP with strict Host/Origin checks and local assets.
4. Raw hook bodies and snippets remain ephemeral. The journal contains a
   bounded safe metadata projection. Local filtering runs before egress.
   Jev A evaluates sensitivity and relevance for immutable candidate snippets.
   Missing, conflicting, or uncertain sensitivity answers exclude the entire
   candidate. B receives only approved candidates. Separate policy switches
   govern source transmission, approved evidence persistence, and display.
   Core owns the shared bundle materializer and output projections; Jev and
   Runtime use those contracts instead of independently copying raw fields.
5. Capture snapshots are source observations with unknown authorship unless
   attribution is supported. File content hashes/generations are independent
   of graph revisions. Changed/absent files invalidate previous evidence
   without Jev; late classifier answers cannot revive superseded evidence.
   Generic passing commands never verify architecture. One artifact registry
   serves the whole worktree, across sessions. Capture distinguishes present,
   confirmed missing, unavailable, and partial results. Only confirmed missing
   can establish deletion; invalidation and answer acceptance are serialized.
6. Both Jev calls share a bounded queue, one absolute deadline, and explicit
   request/candidate/pair limits. No automatic retries. Calls use fixed
   reviewed questions and typed responses. Optional checkpoints are an
   extension point; the first vertical slice needs only A and B.
7. Candidate discovery is deliberately lightweight: approved file snippets,
   exact local identifier spans, imports and known resource names, plus fixed
   generic roles if needed. Jev interprets code with Noul questions per
   candidate/pair, including reads/writes. It does not generate labels,
   evidence, graph commands, paths, or tool outcomes.
8. The finite graph reducer validates revisions, operations, endpoint IDs,
   enum values and bounded strings atomically. It preserves evidence,
   classification uncertainty, and stable layout. Current state and accepted
   revision history power browser reconnect and replay.
9. Session/agent/call identities are scoped and opaque. Duplicate outcomes
   converge to one logical observation. `PreToolUse` creates activity only;
   `Stop` closes a turn; absent outcomes remain unresolved. Unsupported host
   events are explicit coverage gaps.
10. MVP limitations stay explicit: no private reasoning capture, no universal
    hook certification, no claimed runtime database connectivity from source,
    no unmeasured Jev accuracy/latency guarantees, no automatic installation
    into the user's agent configuration.

## Shared module boundaries

Use ES modules and Node's built-in test runner. Keep imports acyclic:

```text
CLI / MCP / collector → daemon → evidence + Jev → graph
browser ← HTTP/SSE ← graph + sanitized activity
```

The coordinator freezes the concrete interfaces after review, before workers
start. Source layout and exclusive ownership:

| Worker | Files | Responsibilities |
|---|---|---|
| Core | `runtime/core/`, `schemas/`, `tests/core/` | Privacy, bounded source capture, candidate/evidence records, graph compilation/reduction, immutable versions |
| Jev | `runtime/jev/`, `tests/jev/` | API adapter, fixed questions, response validation, A-to-B filtering, shared deadline and budgets, offline fixtures |
| Runtime | `runtime/daemon/`, `runtime/collector/`, `scripts/`, `adapters/`, native/root plugin manifests, `skills/`, `tests/runtime/` | IPC, HTTP/SSE, lifecycle, persistence/replay, hooks, CLI/MCP, package generation |
| Viewer | `runtime/web/`, `tests/web/` | Local live diagram, activity, evidence inspector, replay, pause/resume, connection/coverage status |
| Coordinator | Root package metadata, integration tests, README, review/fix integration | Contracts, integration, independent code review, end-to-end verification |

Workers edit directly within their assigned scope. They may request interface
changes; the coordinator resolves cross-module changes before integration.
The coordinator also owns `runtime/pipeline.mjs`, which integrates the frozen
interfaces in `docs/module-contracts.md` without duplicating workers' modules.

## Sequence and review gates

1. Commit design baseline and ignore rules. **Done.**
2. Independent design/plan review: identify blockers, freeze interfaces and
   document scope decisions. No implementation until these reviews finish.
3. Implement the four slices in parallel, sharing the frozen contracts.
4. Review all returned changes. Test the real pipeline with a local fake Jev
   endpoint or injected transport, including both request bodies.
5. Review the integrated code independently and fix actionable findings.
6. Generate packages, run validation and integration tests, and open the live
   viewer with a small local fixture project.
7. Commit reviewed implementation separately from the baseline.

## Required verification

- Passive hook behavior, malformed/oversized input, absent daemon/runtime,
  paths containing spaces, duplicate and failed tools, scoped sessions.
- Credential/forbidden-path fixtures absent from disk, both Jev bodies,
  browser state, and diagnostics. No contextual bypass through labels.
- Correct Jev request/response shapes; independent A/B requests; missing
  answers, uncertain sensitivity, invalid probabilities, outage, deadline,
  queue saturation and cancellation.
- Candidate/edge grounding; pre-tool cannot confirm nodes; configuration
  cannot prove a successful connection; comments/mocks/partial snippets stay
  appropriately qualified.
- Changed/deleted files stale/retract previous claims with Jev disconnected.
  Stale parallel answers rejected using artifact generation checks.
- Atomic reducer, referential integrity, replay equivalence, authenticated
  HTTP controls, Host/Origin restrictions, safe text rendering.
- Browser smoke test of live update, inspector, replay and disconnected state.
  MCP initialization/list/call and generated package path resolution.
- The full design's acceptance list also applies: empty message batches,
  per-tool/batch duplicate handling, policy tightening, startup staleness,
  enrichment safety, and cross-session invalidation. Unimplemented optional
  event types are reported as coverage gaps rather than silently accepted.

Real host activation and live Jev evaluation require the user's environment
and account. Report fixture validation separately from observed host support.
