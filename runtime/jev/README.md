# Jev decision service

Dependency-free ES modules for Node.js 22+. The service classifies supplied candidates
with fixed Choice/Noul questions; it never generates entities, source excerpts,
relations, or graph patches. Core owns discovery, bundle materialization, relation
proposals, and graph compilation. The coordinator owns evidence capture, shared
worktree state, and freshness checks.

```js
import { createDecisionService } from './runtime/jev/index.mjs';

const service = createDecisionService({
  apiKey, // Explicit server-side value; this module never reads environment keys.
  // model: 'jev-1.13.0',
  // fetchImpl, materializeBundle, buildRelationProposals, clock, limits,
  // intakePolicy, admissionPolicy,
});
const decision = await service.classify({
  event, candidates, policy,
  deadlineAt, // Absolute milliseconds on the same clock as ingestion.
  signal,    // Optional cancellation; its reason is never echoed.
});
service.stats(); // Includes calls, callsA/B, queued, active, statuses, token totals.
service.close(); // Cancels queued and active work. Idempotent.
```

Every result includes `diagnostics.trace`, a bounded metadata-only account of
the decision. It retains effective intake/admission thresholds, A's relevance
and sensitivity scores, actual bundle membership, B's role/support/context
scores, and failed predicates. Request records identify model, rubric, duration,
question/byte counts, HTTP status, and validated usage. Intake remains visible
when B times out or fails; unavailable answers remain null or empty rather
than becoming zero scores. These diagnostics do not change classification.
They exclude candidate names, paths, source bodies, keys, and raw API errors.
The pipeline correlates opaque IDs with authorized local display metadata and
adds extraction and graph-admission outcomes for the viewer's classification log.

Both core functions are optional injections with the exact signatures in
`docs/module-contracts.md`; missing functions load from `../core/index.mjs`.
`materializeBundle` receives immutable candidate snapshots and
`[{candidateId,digest,relevant,sensitive}]` verdicts. B uses only its exact approved
bundle. The returned `Decision.bundle` is that same core object. The service
rejects altered candidates, disallowed verdicts, inconsistent read sets, and
out-of-bundle proposals before B. There is no local fallback materializer.

A sends fixed task context, event metadata, `evidence[]` containing
`{code,sourceClass,complete}`, and `entities[]` containing `{name,sourceIndex}`.
Each exact source/version/range appears once in evidence; conflicting copies are
rejected. Candidate, artifact, digest, and proposal IDs remain local. Questions
point directly to backticked paths such as `evidence[0].code` and `entities[1].name`,
without a `state.` prefix or a hash lookup.

A asks one activity Choice, one sensitivity Noul per unique evidence record, and
one narrow relevance Noul per entity. The shared sensitivity answer maps to every
member candidate's original digest before core materialization. Actual secret
values/private personal data require withholding; variable names and environment
references alone do not reveal their values. Named functions, classes, interfaces,
types, modules, bindings (including database clients), explicit events, settings
objects, and package/dependency namespaces qualify for relevance; SQL keywords,
scalar configuration keys, and incidental words alone do not.
Thresholds remain sensitivity <=0.1 and relevance >=0.5.

B rebuilds evidence and entity indices solely from the exact approved core bundle.
Its `proposals[]` contains `{sourceEntityIndex,targetEntityIndex,relation,evidenceIndices}`.
Question text directly names the endpoint paths and each evidence code path;
private core IDs are restored locally when constructing the Decision.
It asks one relevance Noul, role Choice and component-support Noul per candidate,
then relation-support and missing-context Nouls per proposition. Support questions
do not depend on another answer in the same request. Reads and writes are separate.
An actual database-driver client binding can represent a datastore; a mock, stub,
ordinary object, or suggestive name alone cannot establish that role.
Unknown roles, weak support, ambiguous roles, incomplete capture, or missing
relation context cannot produce an accepted judgment. Public intent remains a
proposal when core compiles the decision. No model probability establishes runtime
success, deletion, or verification.

The wire field `role` is one primary display kind, with 12 known choices:
`client`, `service`, `datastore`, `queue`, `external`, `module`, `function`,
`class`, `interface`, `event`, `configuration`, and `package`, plus `unknown`.
Visible function/class/interface declarations take precedence over purpose or
names such as Service or Event. Other bindings use their explicitly supported
kind. `module` is the known-entity fallback, including non-interface type aliases,
ordinary objects, and imported members without a visible declaration.
`unknown` means insufficient evidence.

Events require explicit event definitions, instances, or payloads; data objects
and event-like names alone do not establish events or queues. Configuration needs
an explicit settings object/module. A package kind identifies the package/module
namespace itself, including a namespace alias, rather than every imported member.
Imports never prove remote services or execution. The compiler owns kind-to-shape
mapping; Jev does not return SVG or layout instructions.

B's `architecture-v6` rubric applies declaration and import rules before other
binding kinds. Namespace imports are `package`; named-member imports without a
local declaration are `module`, including database-driver constructors. Datastore
requires evidence that the exact binding is a store or an instantiated driver
receiver. Constructing a separate receiver does not change the imported
constructor's kind. That receiver can be `datastore` when only its configuration
is shown; a query or working connection is unnecessary. Ordinary data objects use
`module`; event kind requires evidence beyond the identifier name. This clarifies
Choice boundaries without changing intake, fixture expectations, admission
thresholds, or question counts.

The relation rubric judges a function's operation **when invoked**.
Missing context concerns a local receiver, wrapper, binding, or operation needed
to identify the relation. A visible known driver import, receiver binding, and
SQL/API operation suffice; upstream callers, live configuration values, successful
connections, and third-party driver internals are not required. An unresolved
`repository.save` wrapper or unknown SQL can still leave a write undetermined.
A visible read, mock, or configuration-only body can conclusively reject a write
with low missing-context probability.

Each relation question defines its verb. `calls` invokes the target; `reads`
retrieves stored data; `writes` issues a data-changing operation; `publishes`
sends messages/events; `consumes` receives or handles messages/events; and
`depends_on` uses a software dependency. Ordinary SQL reads/writes are not
message publication or consumption. These are rubric definitions, not local
rules that fabricate model answers.

## Bounds and failure behavior

Defaults exported as `DEFAULT_LIMITS`: concurrency 2, pending queue 32, deadline
2000 ms, two requests per event, 12 candidates, 40 questions per stage, 64 KiB
request and 256 KiB response. Candidate text is additionally capped at 8192 UTF-8
bytes and labels at 256 bytes. An event reserves two requests before A; if configured
below two, it returns `abstained` / `request_budget` without a call. A with no approved
evidence skips B. A uses `1+E+C` questions, where E is the unique evidence count;
B uses `1+2C+2R`. At C=12, B fits seven
propositions. Core may impose tighter limits. Candidate/proposal omissions appear
in diagnostics and do not trigger more requests. Byte caps are not token estimates.

The v6 offline capacity fixture sends 12 distinct spans of 1800 ASCII characters
and 24 lines each. Both stages dispatch: A has 25 questions and 42,799 bytes;
B retains all 12 entities and seven proposals in 39 questions and **61,438 bytes**
under the unchanged 65,536-byte cap. This fixture is a measured case, not a bound
for every UTF-8 input; requests exceeding the byte cap still fail explicitly.

One workflow owns a concurrency slot through A and B. Queue time, local work,
HTTP headers, response body, and both stages share the earlier of `deadlineAt`
and service-start + 2000 ms. Missing `deadlineAt` uses service-start + 2000 ms.
Clock injection is `{now(),setTimeout(fn,delayMs),clearTimeout(handle)}`. Timer and
abort races bound transports that ignore the signal. No retry occurs. HTTP 429/529
settles that event as `overloaded` and creates a shared cooldown before further
requests, including B of other active workflows. Default cooldown is 1000 ms;
`Retry-After` / `retry-after-ms` may extend it up to 30000 ms.

Only `https://api.typesafe.ai/v1/systemone` is a production endpoint. Redirects are
disabled. An endpoint override accepts only loopback `/v1/systemone` URLs when
`fetchImpl` is explicitly injected for tests. Nothing logs request/response bodies
or propagates raw transport errors.

`Decision.status` is `accepted`, `irrelevant`, `unavailable`, `timeout`,
`overloaded`, `invalid`, or `abstained`. `diagnostics.code` is the primary fixed
reason (`ok` on acceptance); `codes` is its list form. Useful codes include
`missing_key`, `metadata_only`, `deadline_exceeded`, `queue_full`, `request_budget`,
`request_too_large`, `remote_cooldown`, `no_approved_candidates`, and
`no_accepted_classification`. Missing keys return `unavailable` / `missing_key`.
Invalid answers create no judgments; an invalid B retains only valid A provenance.
The pipeline should compile only `accepted`/`abstained` decisions after checking
the approved bundle's policy version and current evidence refs.

Stage provenance records pinned model, rubric version (`intake-v3` /
`architecture-v6`), exact outgoing JSON SHA-256,
validated usage, and `live`/`demo` mode. Choice preserves selected-option probability,
the full distribution, and confidence separately. Noul has no additional confidence.
All answer IDs, types, finite probabilities, complete distributions, sums (0.01
tolerance), winners, usage counts, and model are checked. The wire validator also
covers Score's indexed legend/distribution and weighted score; the fixed MVP
questions do not use Score.
Expanded-kind responses require all 13 requested probability keys. Older core judgments
using the previous kinds and valid smaller distributions remain compatible;
that does not permit a seven-option response to a new request.

Admission defaults are exported as `DEFAULT_ADMISSION_POLICY`: relevance >=0.3,
node/edge support >=0.85, selected role probability >=0.8, role confidence >=0.6,
and missing context <=0.1. These and intake thresholds are experimental,
not calibrated accuracy guarantees. A change to thresholds should supply a new
policy `version`. Diagnostics record both versions. Core may enforce its own
admission floor. Failed requests may have consumed usage: `usageIncomplete` is true
when a request has no validated stage usage.

`diagnostics.stageDurationMs.A/B` measures each dispatched request through body
consumption and validation, including elapsed time of a failed/timed-out request.
`diagnostics.durationMs` also includes queueing, cooldown, and local core work.
Use `stages.A/B.usage` for measured per-stage usage; absent usage is unknown, not zero.

## Offline demo transport

```js
import { createDecisionService, createFixtureTransport } from './runtime/jev/index.mjs';

const fetchImpl = createFixtureTransport({
  mode: 'demo', // Required. No 'live' option.
  candidates: {
    saveNote: { role: 'function', relevant: 0.98, sensitive: 0.01, support: 0.97 },
    PostgreSQL: { role: 'datastore', relevant: 0.98, sensitive: 0.01, support: 0.97 },
  },
  relations: [{
    sourceLabel: 'saveNote', targetLabel: 'PostgreSQL', relation: 'writes',
    support: 0.97, missingContext: 0.02,
  }],
  activity: 'implement',
  relevance: 0.98,
});
const service = createDecisionService({ fetchImpl }); // No key, sockets, or paid calls.
// Pass this service to createPipeline/startServer with mode:'demo'.
// await pipeline.whenIdle() waits for the offline A/B flow before asserting state.
```

The factory returns a fetch-compatible function and never delegates to fetch.
It looks up literal entity names and exact `(sourceLabel,targetLabel,relation)`
recordings. Source text is not interpreted. Unrecorded labels are withheld;
shared evidence uses the maximum recorded sensitivity of its member names.
An unknown or unsafe member therefore withholds the entire shared demo snippet.
unrecorded relations receive low support and high missing context. The defaults
record `Notes API`, `Notes repository`, `saveNote`, and `PostgreSQL`. Override records
to match the demo's actual core candidate labels.

The marked transport causes service stats, every Decision, and stage provenance
to report `demo`. The caller must also choose pipeline/server `mode:'demo'` for
visible UI labeling. Recorded values are synthetic demo answers, never an accuracy
benchmark or a replacement for actual Jev classification.

## Offline tests

Run `node --test tests/jev/*.test.mjs`. Tests use injected transports and a controlled
clock; core integration tests use actual local discovery/materialization/compiler
with the recorded demo transport. Request JSON fixtures pin the complete A/B wire
catalog; other fixtures exercise snippet propositions and exclusion boundaries.
No test requires credentials or calls the model.

Six small synthetic source cases for a separately authorized live smoke probe are
exported from `tests/jev/fixtures/synthetic-probes.mjs`: direct write, read only,
configuration only, mock, unresolved wrapper, and hostile comment. They contain no
recorded answers and execute nothing. An offline test checks that each yields two
core candidates and includes the intended directed `writes` proposition within
the proposal budget. Actual A may still exclude a candidate, making the live case
inconclusive.

A live runner must use the real service and core capture, never the demo transport.
Keep explicit request limits, no automatic retries, and the production 2000 ms
deadline. Determine coverage from the exact `(sourceEntityIndex,
targetEntityIndex,relation)` in `state.proposals`, resolving names directly from
`state.entities`. Decision edges still use original core candidate IDs.
Do not search instruction text for “write”: relation and context rubrics may mention
it while evaluating another relation.
Missing target pairs, missing B, or transport/validation failures are inconclusive.
Report the raw probabilities and context result for the unresolved wrapper rather
than treating any lack of accepted edges as a pass. These six examples cannot
establish accuracy or calibrated thresholds.

`scripts/evaluate-jev.mjs` defaults to 14 synthetic write cases. Its separate
`--suite kinds` selects ten exportable expectations in
`tests/jev/fixtures/shape-probes.mjs` (`shapeProbes`): declarations, an arrow
function, a non-interface type alias, an event, configuration plus a datastore
binding, a namespace alias, an imported member alias, and ordinary data.
Importing the fixtures or runner performs no I/O or classification.

For an explicitly authorized parent-run live evaluation:

```sh
node scripts/evaluate-jev.mjs --suite kinds
node scripts/evaluate-jev.mjs --case kind-interface
```

Kind cases score exact candidate identities, role/support question coverage,
validated judgments, and accepted current nodes after core compilation. Reports
include actual kind, probability, confidence, and compiled shape; they do not test
SVG rendering. Missing candidates/questions are inconclusive. Routing preflight
uses hypothetical approvals only to check discovery/coverage and never supplies
live answers. `--suite all` selects both suites; `--repeat`, `--request-limit`, and
the explicitly marked diagnostic `--deadline-ms` override remain available.
Ten kind cases can dispatch at most 20 requests per repeat. No script run certifies
model accuracy or changes production thresholds.

## Recorded final v6 live smoke results

The parent-run all-suite report recorded 48 decisions / 96 requests:
**46 passed, one failed, and one timed out**. All 20 kind decisions passed,
including both named-constructor alias cases. These are repeated synthetic
development examples, not independent accuracy measurements.

The lone failure was `mock-write` repeat 1: write support 0.20, missing context
0.11. Only the strict resolved-context expectation (<=0.10) failed. No write was
accepted or compiled into the graph; support was below core's 0.50 display floor.
The decision's `accepted` status refers to its accepted component nodes, not to
every relation. The repeat passed with support 0.19 and missing context 0.10.
The first PostgreSQL write timed out under the shared 2000 ms deadline and had no
valid B decision. Thresholds, deadline, rubric, and case expectations remain fixed.

Report: `.graphlin/jev-live-evaluation-all-1789857008041.json` (Git-ignored).
See [live findings](../../docs/jev-integration-findings.md) for the retained v4/v5
failures, exact run totals, and limits of these measurements.
