# Graphlin preimplementation review

19 September 2026. Reviewed baseline `c3547e9`, the 912-line design, revised 130-line implementation plan, revised 241-line module contracts, and earlier review/resolution notes. Contract SHA-256: `a3b4e3051eb45354bf7c1b7d7386ff34fcb9a5695b076e90f76950496b53a357`.

**GO — the coding gate is satisfied at the design level.** The revised contracts establish the necessary boundaries for the offline Claude-first slice. Implementation may proceed under the frozen worker/coordinator ownership. No further pre-coding review round, live credentials, paid requests, or production deployment is required by this review.

This is document review, not implementation verification. No code, host activation, model accuracy, or latency was tested. The independent Jev review covers its specialized API/rubric amendments. Only this review file was written.

## Resolution of the contract concerns

| Concern | Final disposition |
|---|---|
| **R1 — Observation outcomes and shared generations** | **Addressed in contracts.** Lines 18–23 distinguish present, missing, unavailable and partial. Lines 109–118 require one worktree registry, serialized invalidation/acceptance, and invalidation across sessions without transferring authorship. Only confirmed missing establishes deletion. |
| **R2 — Restart recovery from opaque references** | **Proceed with conservative recovery; verify in integration.** The first slice need not add a durable locator index. Restored evidence remains stale until fresh authorized capture/reconciliation establishes its backing versions; unresolvable references cannot become current or be treated as deletions. This implements the design’s startup safety rule despite the absence of a locator-hydration API. Automatic recovery of every prior path is not certified or required for this slice. |
| **R3 — Non-candidate egress and approval ownership** | **Addressed in contracts.** Core owns the materializer; the bundle carries a policy version, exact candidate copies and source read set (lines 37–44). `classify` no longer accepts graph context; B serializes only the approved bundle and fixed metadata (lines 134–145). No unrestricted graph or original candidate collection may enter B. |
| **R4 — Public-message identity/versioning** | **Addressed for the explicitly limited first adapter.** Candidate references distinguish artifacts from messages, and the pipeline tracks message versions (lines 25–44). Unimplemented streamed/delta events report coverage gaps rather than pretending to assemble messages. The graph/compiler must preserve the corresponding source identity; full streaming support can follow. |

The earlier design P1 fixes remain intact: privacy projection precedes journal/spool writes, the immediate feed is metadata-only, direct artifact facts invalidate evidence without Jev, and source generations are independent of graph revisions. The earlier F2/F10 wording corrections are present.

## Required integrated-code review checks

These are implementation acceptance requirements, not additional pre-coding gates.

1. **P1 — Privacy through every output.** Verify the same metadata projection protects normal journaling and fallback spooling. Inspect both fake-Jev request bodies, labels, diagnostics, exports, current snapshots and historical snapshots. Require candidate digest/policy agreement and conservative rejection of missing/conflicting sensitivity answers. Treat policy as fixed for a pipeline instance unless explicit change handling cancels/revalidates work. Restart/reuse under tighter policy must reproject historical content too. Resolved-file checks must prevent excluded paths and symlink escapes from entering source capture/egress.
2. **P1 — Snapshot and evidence truth.** Exercise unreadable/partial versus deleted files, concurrent sessions, source changes during classification, and restart with no surviving in-memory registry. Restored claims stay stale until validated. Invalidation continues with no key, paused classification, or inference failure. A late answer cannot revive superseded support; current-generation checks and graph acceptance share the serialized boundary.
3. **P1 — Preserve interpretation provenance.** Accepted snippet relationships retain exact approved evidence, source versions and `jev_interpretation` basis through compilation, replay and display. A classified write path is not successful connectivity. Generic labels do not merge distinct resources. Generic passing commands do not verify architecture. Optional parser helpers must not become a requirement for a handwritten recognizer for every library.
4. **P2 — Passive hooks and packaging.** Test the declared Claude profile with absent runtime/daemon, malformed input and paths containing spaces. Validate generated portable/native manifests, inert hook responses, MCP initialization and packages copied outside the source checkout. Unsupported events remain visible coverage gaps; fixture success does not establish installed-host certification.
5. **P2 — Bounded, honest operation.** Use the frozen module-contract limits as the implementation source of truth. Full-snapshot SSE is acceptable with bounded history/payloads. Contract lines 148–155 explicitly scope budgets per daemon: do not claim account-wide enforcement across several projects. Default metadata-only mode makes no remote requests; injected demo results remain visibly labeled.

## Reasonable future features

Full streamed-message assembly, automatic persistent locator recovery, Windows transport, actual Codex/Kiro activation, account-wide scheduling, specialized parser/ORM helpers, semantic alias merging, optional grouping/contradiction passes, broad language coverage and richer runtime verification can follow. Unsupported capabilities must be reported rather than simulated as implemented.

Paid accuracy/latency evaluation and observed host certification are later milestones. Fake endpoints and recorded answers are appropriate for implementing the real pipeline and checking its contracts, while proving neither model quality nor host compatibility.

**Next gate:** independent review of the integrated implementation and its offline test evidence. No implementation work was performed in this review task.
