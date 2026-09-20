# Graphlin design: independent review

**Current status:** the follow-up review below confirms that all three P1 boundaries are addressed in the design. The lead subsequently corrected the remaining F2/F10 wording inconsistencies; see the final resolution note. The original findings are retained as review history. None of this constitutes implementation or performance verification.

Reviewed 19 September 2026, including the added requirement for early Jev normalization/redaction/extraction and reusable decision checkpoints. **Recommendation: proceed with the Claude observation spike, but resolve the three P1 findings before treating the proposal as ready for MVP implementation.** The staged Jev approach is feasible in principle. No plugin, end-to-end latency, or classification accuracy has been demonstrated by this review.

This review covers the proposed design, not implemented code. Section and line references describe an earlier draft and may differ from the current document. The review checked Jev's API, models, confidence, model limitations, JavaScript references, and relevant platform documentation, as well as primary schemas. Third-party snapshots used during the review are not redistributed.

**Priority:** P1 means a contradiction or missing correctness boundary that could break a central product promise. P2 means a substantive contract or validation gap to settle during the relevant implementation spike. Findings distinguish documented facts from engineering judgments. Source identifiers resolve to literal URLs in the final source table.

## Normative manifest check

**Neither portable sample has the suspected missing-required-field error.** Both examples already include their required `$schema` property.

| Proposed sample | Normative check | Result |
|---|---|---|
| §2, “Minimal portable manifest,” lines 72–81 | The fetched 1.0.0 schema requires **`$schema` and `name`**. The schema URI is a constant, additional top-level properties are prohibited, and `name` has length and character constraints. `version` and `description` are permitted strings. | **Pass.** `graphlin` is valid; all required fields are present; no unsupported field appears. |
| §2, portable MCP configuration, lines 83–97 | The fetched MCP schema requires **`$schema` and `mcpServers`**. The selected stdio branch requires `type: "stdio"` and a nonempty `command`; the supplied string arguments and `${PLUGIN_DATA}` working directory satisfy its constraints. | **Pass.** The sample also uses the specification’s supported root/data substitutions. |
| Native Claude/Codex distributions, lines 65–69 and 105–114 | The proposal supplies directory names, not native manifest/configuration examples. | **Not testable from this draft.** Do not describe native distributions as schema-validated or install-tested. This is not evidence that the proposed directory names are invalid. |

These checks used the actual published JSON schemas, not an illustrative manifest from a guide. An in-memory check exercised every constraint applicable to these samples; removing either required root field from each sample was rejected. This is schema-level evidence, not a host installation test. The specification adds operational constraints beyond JSON Schema. [S1–S4]

**Current packaging clarification:** live Codex build documentation already describes root `plugin.json`, root `mcp.json`, and `extensions.com.openai`; `.codex-plugin/plugin.json` remains a compatibility fallback. Thus §16’s question about whether Codex supports portable packaging has a documented answer for the current surface, although installed-version testing remains necessary. Producing a compatibility distribution is a legitimate implementation choice, not a factual error. Claude’s native configuration uses `.claude-plugin/plugin.json`, root `.mcp.json` or inline MCP configuration, and its documented component paths and `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` variables. A release generator must translate configuration as well as move a manifest. [S5, S7]

The Kiro references establish separate IDE/CLI hook capabilities, not a tested Graphlin distribution. Keeping Kiro packaging conditional on a named release is appropriate. [S8, S9]

## Review of the added staged-Jev requirement

**The revised division of work is supported by Jev’s bounded-decision API.** Jev A can classify unfamiliar fields, select locally discovered spans/entities, judge downstream sensitivity, and choose a predefined enrichment plan. Local code must materialize those decisions; Jev B can then classify the resulting graph evidence. This uses inexpensive decisions without assuming arbitrary text generation. The proposal correctly keeps initial secret filtering and permission to transmit outside Jev. [S10, S16]

Section 6 correctly treats A → local redaction/extraction → B as sequential when B depends on A’s output. Questions within A are independent evaluations of their supplied state: a sensitivity question cannot implicitly inspect the candidate that another question will select. Each candidate must receive its own relevant checks, or a genuine dependent request is needed. Sharing a client or transport creates neither model memory nor an answer dependency. [S10, S17]

The new shared deadline and two-request cost example are improvements. They supersede the earlier draft’s missing workflow deadline. Remaining staged-flow issues are the actual privacy paths (F1), artifact/bundle identity (F3), conflicting intake decisions and lost candidate recall (F7), measured sequential capacity (F8), and enrichment/cache policy checks (F11). Using two passes is a user requirement and an implementation choice to measure, not an error to remove merely to save a round trip.

## Prioritized findings

### F1 — P1: the diagram and collector do not enforce the two stated privacy gates

**References:** §3 diagram, lines 126–143, and responsibilities, lines 152–161; §4 collector, lines 167–177; §6 privacy/bundle rules, lines 287–308; §11 privacy, lines 600–608.

**Classification: remaining internal design contradiction.** The revised prose correctly requires locally filtered durable intake and contextual redaction before evidence storage/display. However, the diagram still places the event journal before the minimum privacy filter, and the collector still appends a spool record without specifying that projection. The journal also feeds the browser activity stream directly, before Jev A’s contextual decisions. Those paths do not enforce the new prose contract.

Permission to send a span to TypeSafe is not automatically permission to persist or display it before its contextual sensitivity decision. Conversely, Jev A’s later decision cannot make its own input transmission private retroactively; the new draft correctly says this.

**Concrete fix:** move a bounded, platform-aware allowlist projection ahead of both journal and spool. Keep the immediate activity channel metadata-only until downstream content approval completes. Distinguish allowed-to-transmit, allowed-to-persist, and allowed-to-display data. Apply redaction to every copied representation—selected labels, original event fields, prior-intent context, graph descriptions, logs, and exports—not just one source string. Redaction must take precedence when a selected candidate overlaps a sensitive span.

**Acceptance:** inspect the first durable record and immediate viewer payload under normal operation, daemon-down spooling, and Jev-A failure. Check both prohibited secrets and text allowed into A but marked sensitive for downstream use. Define metadata-only fields explicitly. The documented SDK body-logging risk reinforces this boundary. [S13]

### F2 — P1: current evidence has no explicit invalidation path independent of Jev

**References:** §3 diagram, lines 129–140; §7 confidence, lines 444–448; §8 evidence states, lines 456–467; §11 outage behavior, lines 591–598; §13 example, lines 640–647; §14 phases, lines 659–669.

**Classification: missing correctness contract.** A verification record includes an artifact revision, but the proposal does not say when it stops qualifying as current verification. The graph path runs through Jev, while outage behavior preserves the last accepted semantic revision. Rename/deletion reconciliation and scoped test evidence are deferred to Phase 2.

Consider a verified repository component whose backing file is then deleted, or whose database call is removed, while Jev is unavailable. Keeping the old structure without invalidating its current evidence can leave a solid “observed” node or verified badge describing a state already known to be obsolete. Recording the deletion in activity is insufficient.

**Concrete fix:** give authoritative artifact observations a direct path to the reducer. Maintain claim-level evidence validity by artifact version and support set. Changes invalidate affected verification badges; confirmed absence retracts support; a node/edge disappears only when the relevant support is exhausted under a defined reconciliation scope. Where current truth cannot be established, retain history but visibly mark the live claim stale or unresolved.

Put these minimal invalidation rules in Phase 1. Rich rename inference and detailed test mapping can remain later enhancements. Define startup/resume reconciliation so retained graphs cannot appear current after edits made while Graphlin was stopped.

**Acceptance:** deletion, changed dependencies, restart after external edits, and a passing test followed by another edit must update evidence validity with Jev disconnected. This finding follows the proposal’s own evidence contract.

### F3 — P1: graph revisions do not solve the artifact snapshot race

**References:** §4 ordering rationale, line 175; §5 evidence and identity, lines 238–258; §6 bundle validation, line 308; §9 reducer and causality, lines 541–545.

**Classification: missing state/ordering boundary.** Content hashes, redaction-offset checks, and graph/entity versions are useful, but the proposal does not define when the underlying artifact bytes are captured. A delayed worker may read the current file after another agent has changed it. It can then attach agent B’s bytes to agent A’s earlier tool event. The graph may not yet have changed, so the stated stale-result check would pass.

The same problem affects verification: a test result cannot be bound to the current working tree merely because the result arrived last. Files may have changed during the test. A short synchronous collector handoff orders journal arrivals; it does not serialize parallel host tools. Claude explicitly permits concurrent per-tool post hooks. [S6]

**Concrete fix:** distinguish event-time tool evidence from later filesystem reconciliation. Preserve a tool’s supplied exact edit/result as one observation; capture a separately versioned filesystem observation with its own timestamp and attribution. Track artifact generations independently of graph revisions and reject decisions against superseded artifact generations. Bind A’s selected spans, the materialized bundle, and B’s decisions to the same immutable content versions. When historical bytes or exclusive attribution are unavailable, say so rather than assigning the latest bytes to the earlier call.

**Acceptance:** replay A-write, B-write, delayed-A-parser, and test-running-during-edit fixtures. They must not transfer authorship, resurrect old relationships, or mark B’s revision verified by A’s test.

### F4 — P2: the sample overstates pre-tool execution, and terminal coverage needs an explicit matrix

**References:** §2 adapter table, lines 105–122; §4 lifecycle, line 189; §5 sample, lines 204–214, and kinds, lines 228–233; §15 criteria 5 and 7.

**Classification: event-semantics mismatch plus coverage gap.** The sample maps `PreToolUse` to `tool.started`. That hook occurs before permission resolution and does not establish that execution began. The worked example’s “pending” wording is more accurate.

Claude’s current reference also says cancellation of a running tool does not fire `PostToolUseFailure`, and user interruption does not fire `Stop`. Permission denial and validation rejection have different event coverage. Codex now documents `Interrupt`, but only for an active main thread, not subagents. Kiro’s published example does not establish the same per-call identifiers as Claude. These differences cannot be collapsed into a universal terminal-state guarantee. [S6, S7a, S8]

**Concrete fix:** normalize pre-tool capture as `tool.requested`/`tool.pending`, or explicitly define the existing name as non-execution evidence. Publish a per-event matrix covering denial, cancellation, validation failure, background completion, and subagents, including identifier availability. Missing terminal evidence should expire to unresolved, never to a guessed interruption or success. Define session liveness separately so a missed stop does not keep a daemon session active forever.

The existing caveats about unavailable signals are correct; the matrix turns them into implementable behavior.

### F5 — P2: logical observations must be assembled before deduplication and classification

**References:** §5 deduplication, line 240; §9 version checks, lines 541–549; §10 coalescing, line 570.

**Classification: missing normalization protocol.** Message/batch identity prevents transport duplicates but does not reconstruct a public statement. Claude `MessageDisplay` supplies incremental `delta` text; its final batch can be empty. Interactive and non-interactive delivery also differ. Treating the last event’s content as the completed message loses text. Separately, `PostToolUse` and `PostToolBatch` can describe the same tool result using different representations. [S6]

**Concrete fix:** assemble messages by session/agent/message ID and batch index, track missing batches, and close on `final` even when `delta` is empty. If partial messages are classified, attach a message-content version so a late result cannot replace the interpretation of a later complete statement. Define whether a superseded proposal is withdrawn from the live graph while retained in history.

Normalize per-tool and batch observations onto the same logical tool/evidence identity. A batch can supply missing information, but must not double the evidence count or issue duplicate semantic work just because its source event has a different phase.

**Acceptance:** out-of-order deltas, an empty final batch, a revised public plan, and the same tool result delivered individually and in a batch must converge to one current interpretation.

### F6 — P2: the relevance question can discard two promised product behaviors

**References:** §1 product contract, lines 17–19; §6 catalogs, lines 280 and 314–320; §7 example, lines 383–385, and rules, lines 433–442; §13 proposal example, line 638.

**Classification: internal question/policy mismatch.** The example asks whether the event contains evidence of a component or dependency **change**, then routes low relevance to activity only. A read can reveal existing architecture without changing anything. A public proposal can name a useful future component without proving a completed change. Both are legitimate observations the product promises to draw, yet both can correctly fail this particular question.

**Concrete fix:** define relevance as supported architectural information, split into discovery, proposal, change, and contradiction/removal where needed. Keep evidence state deterministic and separate from relevance. Give explicit read-only discovery and proposal-only examples to the rubric.

Also clarify that a relevance answer included in the same mixed request gates application of sibling answers, not their API cost: those questions have already been submitted. Choose a local prefilter, speculative mixed request, or measured extra inference pass deliberately.

This is a rubric design error, not a Jev API limitation. Jev’s documented literal interpretation makes the wording consequential. [S10, S16]

### F7 — P2: uncertainty is described in prose but lacks a complete state and admission contract

**References:** §6 intake/bundle contract, lines 278–308, and relation/alignment questions, lines 318–319; §7 confidence policy, lines 427–448; §8 state vocabulary, lines 461–465; §12 uncertain styling, line 624.

**Classification: missing contract; threshold values themselves are implementation choices.** The numerical distinction between probability and confidence is correct. However, the sample admission rule covers candidate support and role only. It does not define acceptance of an inferred relationship or identity match. The viewer promises “Uncertain,” while the listed evidence vocabulary has no place for analysis uncertainty; `Activity: unknown` describes something different.

**Concrete fix:** add a separate classification status such as pending, accepted, tentative, abstained, or stale. Preserve the evidence category independently. Specify admission predicates for the selected relation and the selected identity match, including support for that exact candidate and explicit handling of `none`/`unknown`. Do not let high certainty in `unknown` count as acceptance of a known role.

For Jev A, specify missing-answer, abstention, and conflict handling per selected span. A “relevant component” answer cannot override a sensitive/uncertain sensitivity result from another independent question. Measure local candidate recall, recall retained by A, contextual-redaction errors, and B’s conditional accuracy separately: B cannot recover a valid component that A removed. Conservative privacy filtering may intentionally reduce diagram coverage, which the UI and evaluation should disclose.

Keep distributions, provenance, model, and rubric version, as already proposed. Evaluate nodes, edges, and identity merges separately. Neither a high confidence statistic nor independent question execution proves a joint claim correct. [S11, S16]

### F8 — P2: request bounds and latency targets need an executable workload definition

**References:** §5 bounded candidates, lines 244–252; §6 staging/checkpoints, lines 326–349; §10 targets and scheduler, lines 553–585.

**Classification: validation gap, not a false benchmark claim.** The revised draft correctly includes sequential round trips, queue time, a shared absolute deadline, and stage-specific accounting. However, “the benchmark workload” remains undefined. Two individually fast calls do not establish a 500 ms capture-to-render p95, particularly when the second call must await local compilation and another scheduler slot.

The model page currently lists 1,200 requests/minute and 250,000 tokens/second, subject to change. With two requests per event, the request budget alone permits at most 600 such events/minute—10/second—before optional checkpoints, retries, or other sessions. This is arithmetic capacity, not a throughput guarantee. The omitted primitive bounds also matter: Choice allows up to 255 options; Score supports 2–10 levels. Alignment must reserve an escape option within the Choice limit. [S12, S14, S15]

**Concrete fix:** define representative machines/region, event rates, concurrency, payload size, candidate counts, and cold/warm modes. Use the proposed shared deadline from ingestion; reserve budget for B instead of consuming it all on A or optional checkpoints. Cap candidate/pair fan-out and specify which queued jobs expire or coalesce. Enforce token and primitive limits before dispatch. Record capture-to-display p50/p95/p99, queue age, losses, abstentions, and coverage for full staged, direct, and optional-checkpoint paths.

Phase 0 should establish whether 500 ms is attainable for that workload. It should not silently redefine the workload to exclude difficult events.

### F9 — P2: finite drawing output does not protect semantic claims from hostile evidence

**References:** §5 candidate extraction, lines 244–252; §6 intake and optional decisions, lines 278–338; §7 shared state, lines 370–380; §8 drawing restrictions, lines 529–531; §11 privacy/security; §15 acceptance criteria.

**Classification: missing evidence-integrity test, grounded in a documented model limitation.** Jev 1.13 explicitly warns that adversarial text in `state` can steer its answers. Repository comments, tool responses, and copied public text can therefore influence a component role, relation, or identity match while producing perfectly valid Choice values. [S16]

The finite drawing grammar is a valuable execution boundary. It does not by itself establish that an accepted edge is true. A source reference proves where input came from, not that arbitrary text there proves the chosen relation.

**Concrete fix:** distinguish literal observations, parser-established facts, and Jev interpretations in provenance and UI. Have the compiler check that the relevant evidence class is eligible to support each claim; an incidental comment must not become execution or deployment proof. Keep external text in data fields and use fixed, reviewed rubrics. Test hostile inputs against A’s normalization/sensitivity/enrichment choices as well as B’s graph decisions. A model-chosen field mapping must not overwrite host IDs, execution status, or path permissions.

Do not add a Jev “is this injection?” score as an authorization boundary. Evaluate semantic errors directly.

### F10 — P2: “always silent and successful” needs a host-specific launch contract

**References:** §2 runtime and native packages, lines 65–99; §4 collector rules, lines 167–183; §14 host phases, lines 653–681; §15 criteria 1 and 11.

**Classification: implementation/compatibility gap.** Returning zero inside collector code does not cover a missing executable, unavailable runtime, shell startup output, or a host timeout before that code returns. Kiro’s documented shell-action error behavior can block pre-tool invocation or prompt submission, making these failures relevant to the passive-observer promise. Agent-prompt hook actions would deliberately add model work. [S9]

Codex’s documentation additionally requires JSON stdout for successful `Stop`/`SubagentStop` handlers, while its general success description is broader. The draft’s universal empty-output rule should be verified for those events, not assumed. This review did not execute Codex to resolve that documentation ambiguity. [S7a]

**Concrete fix:** define and test a quiet, guarded launcher for each host and OS, with its own deadline below the host timeout and no setup/network work in the hook. Use only passive-compatible event/action types; exclude lifecycle overrides such as Claude `WorktreeCreate`, whose handler must actually create and return a worktree. Use an inert JSON acknowledgement where a host demonstrably requires one, with no context or control fields. [S6]

Add generated native configuration examples and install fixtures that exercise path substitutions, spaces in paths, runtime absence, upgrade/uninstall, and duplicate registration. This is release engineering work, not grounds to reject the portable manifests.

### F11 — P2: enrichment and cache reuse need a policy-aware stage protocol

**References:** §6 enrichment selection, lines 283 and 303; referenced-content gate, line 289; direct/cached path, line 328; optional checkpoints and cache keys, lines 332–349.

**Classification: staged-flow contract gap.** Jev A may select `nearby_imports`, which obtains evidence that was not in the state A classified. That new evidence has no inherited contextual-sensitivity verdict. Likewise, a cached intake answer may have been produced under different retention/display settings even when its allowed-to-transmit state is unchanged. The listed cache key includes model, state, candidates, rubric, and graph revision, but not the effective privacy policy.

**Concrete fix:** define enrichment as a bounded transition that fetches only locally authorized sources, re-applies the minimum privacy gate, and contextual-filters any newly introduced content before it reaches B or display. Either use metadata/previously approved evidence or budget another A evaluation; do not treat selection of an enrichment plan as approval of its eventual contents. All paths must share the existing deadline and request/spending limits.

Include privacy-policy identity/version and project/worktree scope in reusable decision/bundle validity, or re-check current policy on every reuse. Define overlapping-redaction precedence and invalidate materialized bundles after relevant content or policy changes. Optional grouping/alignment/conflict checks must consume only the appropriately approved bundle and cannot restore excluded text by resolving an opaque ID.

**Acceptance:** tightening display policy, enriching a safe event with a sensitive imported file, and reusing an old bundle after a source edit must not bypass either privacy gate. This preserves the requested reusable Jev service while making its reuse rules concrete.

## Checks that did not produce findings

1. **Observable work is the right contract.** The proposal correctly disclaims access to private reasoning. Current Claude documentation supports the named `MessageDisplay` and `PostToolBatch` events, with version/surface validation still required. [S6]
2. **The Jev API example is consistent with the inspected documentation.** Endpoint, bearer authentication, structured state, mixed primitives, JavaScript helper signatures, explicit retry disabling, and cancellation are supported. No arbitrary text-generation capability is assumed. The example remains conceptual and was not executed against a live account. [S10, S13, S17]
3. **Confidence and cost are mostly described accurately.** Choice/Score confidence differs from option probability; Noul has no separate confidence field. The $0.84 single-request and $1.68 two-request examples are correct for their stated billed input totals and price. Neither that price nor the timing targets are an SLA. [S11, S12]
4. **Several difficult boundaries are already handled well.** Missing host coverage is not treated as inactivity; replay uses accepted historical patches; layout and drawing commands are deterministic; resource declarations do not prove deployment; provider no-training statements are not misrepresented as universal zero retention. These are strengths to retain. Provider data-handling wording matches the inspected model/legal pages. [S12, S18]

## Conclusion

The design has a credible core: observe public work, discover candidates locally, use Jev A for bounded normalization/sensitivity/extraction choices, materialize an approved bundle, then use Jev B and justified optional checkpoints for further decisions. Local code remains responsible for exact text, privacy enforcement, evidence validity, and drawing. The principal readiness problems are **enforcing both privacy gates on actual data paths, evidence invalidation independent of inference, and artifact-time correctness under concurrency**.

There is no demonstrated invalid portable manifest, no basis for claiming a universal private-thinking hook, and no evidence yet of the proposed end-to-end latency. Native compatibility packaging, a second classification pass, renderer choice, and experimental thresholds are engineering decisions to validate rather than factual errors.

The parent may append resolution status against F1–F11 after revising the proposal. This report intentionally does not change it or implement the plugin.

## Primary source record

URLs are code text for reproducibility. Live retrieval was performed on the review date; no host binary versions or account-specific Jev limits were tested. Where a web-index rendering differed from freshly fetched official HTML, the direct official page and local snapshot were inspected before drawing a conclusion, particularly for current Codex packaging and interruption hooks.

| ID | Primary source |
|---|---|
| S1 | `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` |
| S2 | `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` |
| S3 | `https://agent-plugins.org/specification` |
| S4 | `https://agent-plugins.org/mcp-servers` |
| S5 | `https://code.claude.com/docs/en/plugins-reference` |
| S6 | `https://code.claude.com/docs/en/hooks` |
| S7 | `https://developers.openai.com/codex/plugins/build` |
| S7a | `https://developers.openai.com/codex/hooks` |
| S8 | `https://kiro.dev/docs/hooks/types/` |
| S9 | `https://kiro.dev/docs/hooks/actions/` |
| S10 | `https://docs.typesafe.ai/api.md` |
| S11 | `https://docs.typesafe.ai/confidence.md` |
| S12 | `https://docs.typesafe.ai/models.md` |
| S13 | `https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md`, `https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions.md`, `https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md` |
| S14 | `https://docs.typesafe.ai/primitives/choice.md` |
| S15 | `https://docs.typesafe.ai/primitives/score.md` |
| S16 | `https://docs.typesafe.ai/model-jaggedness/jev-1.13.md` |
| S17 | `https://docs.typesafe.ai/sdk/javascript.md`, `https://docs.typesafe.ai/sdk/javascript/api/functions/choice.md`, `https://docs.typesafe.ai/sdk/javascript/api/functions/noul.md`, `https://docs.typesafe.ai/sdk/javascript/api/functions/score.md` |
| S18 | `https://docs.typesafe.ai/legal.md` |

Fetched schema SHA-256 values:

1. Plugin schema: `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`.
2. MCP schema: `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb`.

## Follow-up review

Reviewed 19 September 2026 against the revised **836-line** proposal, SHA-256 `d3be91bf81344b790efb8c407fed63ab8316f82825f38273399dbef535f7b3c8`. References below use that revision. This was a focused reread of the affected design sections. **No implementation, host integration, Jev calls, runtime privacy enforcement, or performance was verified.** The HTML remains an illustrative walkthrough and is not evidence of those capabilities.

**All three P1 boundaries are addressed in the design.** The remaining issues are wording inconsistencies identified below, not an unresolved architectural bypass.

| Finding | Follow-up status | Evidence and remaining action |
|---|---|---|
| **F1 — Privacy paths** | **Addressed in design** | §3, lines 130–153, now projects before journaling and exposes only metadata immediately. §4, lines 174–178, applies the same projection to fallback spooling and defines the metadata allowlist. §6, lines 319–344, separates transmit/persist/display permission, excludes uncertain content, and covers copied representations and overlapping redactions. |
| **F2 — Independent evidence invalidation** | **Boundary addressed; wording cleanup remains** | §3, lines 141–142, adds facts directly to the reducer. §8, lines 514–518, defines support retraction, immediate verification invalidation, outage behavior, and startup reconciliation; §14, line 738, includes these in the MVP. Update §13, line 722: retaining the prior *architecture revision* is inconsistent with validity mutations that can advance the live revision. Say “retain semantic interpretation while applying validity changes.” Qualify §14, line 744, as **richer** reconciliation/test scoping so it cannot suggest deferring the MVP minimum. |
| **F3 — Artifact-time correctness** | **Addressed in design** | §5, lines 286–290, separates tool evidence from later reads, binds both Jev stages to immutable evidence, and prevents tests from verifying unestablished revisions. §9, line 598, explicitly requires artifact-generation checks even when the graph revision is unchanged. |
| **F4 — Tool lifecycle semantics** | **Addressed in design** | §5, lines 213–256, uses `tool.requested`, restricts running state to an execution signal, and supplies the terminal-coverage matrix. §4, line 196, distinguishes explicit interruption from unresolved attempts and tracks liveness separately. |
| **F5 — Message/result normalization** | **Addressed in design** | §5, lines 262–264, specifies ordered delta assembly, empty final batches, incomplete content, message versions, proposal withdrawal, and one logical identity for individual/batched tool results. |
| **F6 — Relevance scope** | **Addressed in design** | §6, line 350, and §7, lines 419–423, explicitly include discovery and proposals. §7, line 465, distinguishes answer-application gating from avoiding inference cost. |
| **F7 — Admission and uncertainty** | **Addressed in design** | §6, line 340, makes missing/conflicting sensitivity decisions exclude content. §7, lines 477–491, gates exact roles, relations, and matches. §8, lines 504–507, separates classification and evidence validity; §15, line 781, measures each stage’s recall/errors. Threshold calibration remains implementation work. |
| **F8 — Sequential latency and bounds** | **Addressed in design** | §10, lines 623–647, defines the shared deadline, reserves budget for B, and supplies workload, candidate/question/primitive bounds, concurrency, and overload reporting. These are test specifications, not achieved measurements. |
| **F9 — Hostile evidence** | **Addressed in design** | §8, line 586, defines evidence classes and protects authoritative fields. §11, line 683, requires adversarial evaluation of both stages and excludes model scores from authorization decisions. |
| **F10 — Passive launcher contract** | **Contract addressed; acceptance contradiction remains** | §4, lines 176–186, allows tested inert acknowledgements, guarded launchers, compatibility fixtures, and omission of incompatible events. However, §15 criterion 1, line 762, still requires universally empty output. Replace it with “the tested inert response for that host/event, with no context/control fields and unchanged tool input.” Installation fixtures remain unexecuted. |
| **F11 — Enrichment/cache policy** | **Addressed in design** | §6, lines 340–344, requires renewed filtering of enriched content and prevents IDs from restoring exclusions. Line 385 scopes cache validity by policy, project/worktree, artifact generations, and current-policy rechecks. |

The staged flow is now consistent at the design level: local permission/filtering precedes Jev A; independent intake answers are reconciled locally; B receives the accepted, redacted bundle; enrichment re-enters the applicable gates; and optional decisions share deadlines and budgets. Correct the two wording clusters above, then validate these contracts in the implementation spike. This follow-up supersedes the original findings’ open design status only; it does not certify a working plugin.

## Final resolution note from the lead

The remaining follow-up wording changes have been applied:

1. **F2:** the timeout example now preserves semantic interpretation while applying evidence-validity changes. Phase 2 explicitly adds richer reconciliation/test scoping beyond the mandatory MVP behavior.
2. **F10:** acceptance criterion 1 now requires the tested inert response for the specific host/event, with no context/control fields and unchanged tool input.

All F1–F11 findings have corresponding design changes. Host installation, collector overhead, privacy enforcement, Jev latency/accuracy, and production evidence handling remain implementation validation tasks. The illustrative browser walkthrough was checked separately for replay controls, both scenarios, stale-evidence display, component inspection, diagram-change inspection, and narrow-layout overlap.

## Subsequent user-directed clarification

The proposal now makes focused code snippets evaluated directly by Jev Noul questions the primary semantic path, with optional Score support-strength diagnostics. Parsers aid context selection and exact references; a handwritten semantic recognizer for each library is not required. Code-level claims retain Jev interpretation provenance, and runtime verification remains separate. This clarification and its illustrative question catalog were added after the independent follow-up review and have not received another independent review or live Jev evaluation.
