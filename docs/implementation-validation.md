# Graphlin implementation validation

19 September 2026. First runnable Claude-first slice following the independent
preimplementation review of baseline `c3547e9`.

## Automated verification

`npm test`: **200 passed, 0 failed**. The suite uses generated local fixtures,
recorded classifier answers, and injected transports. It makes no live Jev
requests.

Coverage includes:

- Source permissions, secret/path exclusions, immutable evidence, contextual
  intake, exact approved bundles, strict typed HTTP responses, deadlines,
  cancellation, and bounded queues.
- Finite graph operations, evidence versions, cross-session invalidation,
  message edits including A→B→A, pause/resume with multi-file relationships,
  final-reread races, empty graph restoration, and replay.
- Passive hooks, absent/broken runtimes, TERM-ignoring subprocesses, private
  IPC, local HTTP authentication, origin checks, bounded persistence, and
  source-free default exports.
- Interrupted lock creation, stale/ownerless lock recovery, concurrent
  startup, preserving live owners, and rejecting package-output symlinks.
- Viewer rendering, literal text handling, exact controls, stable layout,
  parallel arrows, selection, confidence display, and exports.
- MCP initialization and controls, generated package relocation, and demo
  startup/export/shutdown.

`npm run build` produced portable, Claude, and Codex packages. The plugin
manifest validator passed. Kiro remains an experimental adapter profile.
No package was installed into a host configuration.

## Independent review and fixes

The coordinator integrated four worker-owned modules. An independent reviewer
reviewed the pipeline and runtime, then rechecked the concrete fixes.

Resolved findings included source excerpts in default exports, incomplete
subprocess termination, interrupted lock recovery, Kiro output symlinks,
deduplication of reverted messages, preserving multi-file context after pause,
empty revision restoration, and pausing during final evidence reconciliation.
The reviewer verified all four new pipeline regressions and the targeted
runtime regressions, with no remaining critical finding in that scope.

This review does not certify the entire system against every possible issue.

## Browser verification

The actual local daemon and offline demo were opened in the in-app browser.
The checks exercised authenticated startup, token removal from the URL,
live snapshots, component and arrow selection, the evidence inspector,
pause/resume, historical replay, and disconnected/reconnecting states.

A generated source file was edited while classification was paused, then
submitted through the real passive collector and private IPC. The collector
returned success with empty stdout/stderr. The existing session's source
claims became stale while paused, and refreshed after resume.

At an 824-pixel viewport, the inspector stacks below the canvas and node
labels remain readable. A reported arrow-selection issue was fixed and
retested in the browser; selection survives classification control updates.

The demo is explicitly labeled as recorded fixture behavior and makes no
external classifier calls.

## Live model evaluation and remaining scope

See [Jev integration findings](jev-integration-findings.md) for the separate
138-request synthetic live evaluation, including the cold timeout and the
CommonJS borderline result. Offline passing tests do not establish model
accuracy, live database connectivity, or production latency.

The implementation observes supported public events and source versions.
It does not capture private reasoning, certify installed Claude/Codex/Kiro
hook behavior, or implement the optional domain-routing extension. Those
limits are visible in the documentation and viewer.

## Diagram and connection revision

The diagram now supports twelve primary kinds, fifteen shapes, six deterministic
layouts, live balloon appearance/removal effects, hand-drawn outlines, and eight
color themes. A larger offline demo exercises eighteen components, cycles,
disconnected components, long names, and parallel relationships.

The CLI now runs `start` and `demo` in the foreground. Process tests verify
Ctrl+C cleanup, joining an existing instance, simultaneous starts, canonical
project/data aliases, startup failure, and avoiding shutdown of a replacement
instance. MCP start remains explicitly detached. The authenticated connection
guide generates quoted Claude/Codex commands from trusted local paths; package
discovery and command rendering do not execute installation commands.

Independent review found and prompted fixes for offscreen layouts, wide title
overflow, diamond/component arrow anchors, drag state crossing views, callbacks
retained by a long-lived foreground attachment, and an unhandled shutdown
rejection. Regression tests cover the concrete failures.

Browser checks exercised the running foreground demo, same-port restart,
connection-guide loading, exact command copying, Escape/focus restoration,
layout changes, component shape controls, and diagram themes. The guide's
commands were checked against the installed host CLIs and official host
documentation; host installation and trust approval were not performed.

The expanded Jev evaluation adds 176 synthetic requests across three rubric
iterations. The final v6 run used 96 requests for 48 case evaluations:
46 passed, one timed out, and one mock case narrowly missed the context
criterion without producing a write. All twenty new-kind evaluations passed.
Earlier failures remain recorded; see the updated
[findings](jev-integration-findings.md). These results describe the sampled
cases, not a general accuracy guarantee.

The completed revision passes **326 automated tests**. Three real IPC/SSE
add/remove cycles verify animation lifetimes through status snapshots.
Browser checks confirm all eight palettes render distinct colors while node
positions and selection stay unchanged. Contrast, short-corner limits, and
stroke visibility at normal zoom have dedicated tests. Independent review
reported no remaining P1/P2 findings in the reviewed theme, outline, and
lifecycle changes.

Portable, Claude, and Codex distributions were rebuilt. Claude's native plugin
validator passed. The old background service and design-preview server were
stopped; the demo remains on port 51275.
# Classification diagnostics

The diagnostic log follows capture, candidate selection, both Jev calls, and
graph admission. It records activity routing, full role distributions, effective
thresholds, validated scores, request timing/outcomes, and fixed skip reasons.
Local selection reports per-file omissions before its 12-candidate cap, with
explicit lower bounds when source-window limits stop inspection.

The authenticated viewer and `logs --project … --file …` expose the bounded
metadata log. Private JSONL rotation retains two files of at most 1 MiB each.
Raw source, prompts, credentials, launch tokens, and raw API errors are excluded;
display and persistence permissions apply independently to names and paths.
Restarting with tighter source permission hides previously persisted names.

Validation: **419 automated tests passed**, package builds passed, and the
rebuilt Claude profile passed `claude plugin validate`. Browser checks covered
the older-service restart message, search, native record expansion, request and
threshold tables, scores, Escape, and focus restoration. Independent review
found no remaining P1/P2 issues after fixes to native collection handling,
request cancellation, and candidate-limit reporting.

A targeted cache investigation used four isolated classifications/eight live
requests. At the normal 2,000 ms deadline, one timed out after A consumed 1,315 ms;
the next two succeeded in 1,992 and 961 ms. An isolated 8,000 ms experiment
completed in 885 ms. Successful results classified the cache functions and Redis
receiver; the tests did not change the live project diagram or production
deadline. Historical scores were not retained, so the original omission remains
unconfirmed. A separate lexical regression was fixed: conditional constructors
guarded by an environment lookup retain their declared binding.

# Existing-project discovery

An orientation investigation compared observable Claude tool calls/results
with Graphlin's classification log. Its file reads were received,
including `cache.ts`. Several jobs then exhausted their two-second deadline
while queued behind other reads. Directory discovery also discarded unchanged
files already known to the daemon, even when the new session had no diagram.

Completed Read, Glob, structured Grep, and recognized shell listings now supply
bounded filename hints. Only freshly authorized disk captures become source
evidence. The coordinator uses two active classification workflows, 64 waiting
jobs, and a 120-second queue expiry. The daemon gives each dispatched workflow
five seconds for both Jev passes and final evidence validation. Exact ordered
candidate inputs are deduplicated within a session; fuller reads and joint file
context remain eligible.

The synthetic orientation probe is available as `npm run eval:discovery`.
It first observes seven existing files, then starts a fresh session and delivers
a file listing followed by a burst of Read results without editing the files.
A two-second active-budget replay still missed four files because of timeouts.
Two successive runs with the five-second daemon budget each covered **all seven
files**, producing **17 nodes and 15 edges** from **19 live Jev requests**, with
**zero dropped jobs, zero pending jobs, and zero runtime-verified claims**.
Local in-process capture took 62 and 70 ms; total classification drain took
10,094 and 10,701 ms. Maximum queue waits were 8,045 and 8,676 ms. These are
isolated local observations, not hook latency or production percentile claims.
No user application files or transcript contents were sent by this probe.

Independent review found and reproduced two deduplication regressions before
release: separate file judgments incorrectly suppressed a later joint analysis,
and a limited shared candidate budget suppressed fuller individual reads.
Both were corrected and covered by regression tests. Additional tests cover
new-session discovery, the directory-scan tail after 32 files, queued edits and
deletions, failure retry eligibility, queue expiry/overflow, pause/resume, and
cancellation of unresponsive classifiers.

Final validation: **452 automated tests passed** with a 30-second test timeout.
The real passive shell hook was exercised through collector IPC, the daemon,
the offline two-stage Jev transport, and authenticated viewer/diagnostic routes.
Deep files outside the fallback scan were discovered through returned paths;
tool-returned source was rejected in favor of the disk snapshot. Metadata-only
policy and failed listing results remained excluded. Review also corrected
dotted-directory `ls` resolution and completion deduplication that could leave
a later complete observation tentative. Packages were rebuilt and Claude's
plugin validator passed.

One earlier unrestricted full-suite run stalled in the existing server test
file. After stopping that test child, the isolated five-test server suite and
the full bounded run passed; the stall was not reproduced.

# Session following, live receipts, and automatic fitting

New session starts select their diagram before discovery and classification
finish. Delayed results and ordinary hooks from another session preserve that
selection. Compaction also preserves it; an explicit resume may select an older
session. Replayed lifecycle events do not override a manual selection.
ID-less native hooks cannot distinguish an identical later resume from a
transport replay; distinct host event IDs remain eligible.

The sidebar receives a separate, in-memory stream of up to 200 normalized hook
receipts. Each receipt has a local arrival time and increasing ordinal, including
pre/post pairs, duplicates, and captures rejected by the local queue. Raw tool
content, source, prompts, credentials, and launch tokens are excluded. Persistent
snapshots do not retain this stream.

Semantic history shows added, removed, and changed components and relationships
as themed miniature tiles. Current items open the evidence inspector; removed
items replay the preceding retained revision. It distinguishes a history baseline
and gaps from actual changes. Zoom, theme, layout, confidence-only, and hook-only
updates do not manufacture architecture changes.

Fitting uses both physical canvas dimensions. Graph changes fit before entering
shapes animate, and layout switches and Arrange also fit. Manual camera choices
survive ordinary status updates. During removals, the camera includes the burst
effects and then fits the remaining graph. Reduced motion and interruption
cancel effects without retaining stale camera bounds.

Browser checks exercised a new-session takeover, old-session pre/post receipts,
manual zoom through a status update, 18→20→18 component changes, removal replay,
theme consistency, and sidebar-only scrolling to selected evidence. All shapes
fit after layout changes at both desktop and narrow-screen sizes; the narrow
hierarchy reached 11% zoom without horizontal page overflow. The browser
reported no console errors or warnings.

Independent review reproduced and corrected background compaction stealing
selection, removal effects falling outside a shrinking viewport, and history
surviving a session reset. It also identified full-history work on each receipt;
cached projections and comparisons reduced a 101-frame, 256-node/768-edge
fixture's hook-only sidebar update from 41–51 ms to roughly 1.1–1.5 ms in local
in-memory checks. These measurements exclude transport and browser rendering.
Privacy reprojection still updates displayed historical labels.

Final validation: **497 automated tests passed**. A demo packaging test was
corrected to wait for its completed observations, rather than stopping at the
first intermediate relationship. Package builds and Claude's native plugin
validator passed. Independent re-review found no remaining actionable issues
in the reported fixes. The updated offline demo remains available on port 51275.
