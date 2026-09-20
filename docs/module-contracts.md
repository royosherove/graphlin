# MVP module contracts

Shared implementation contract, incorporating review R1/R2. ES modules; Node.js 22+. All counts,
bytes, timeouts, and text fields are bounded. No module imports browser code.

## Common data

`Policy`: `{ transmitSource, displayEvidence, persistEvidence, excludePaths,
version }`. Defaults: no transmission, no evidence persistence. Display applies
only to approved content, never pending intake. Version is derived locally.

`Event`: `{ schemaVersion:1, id, projectId, sessionId, agentId, toolCallId,
kind, toolCategory, outcome, at, sequence, incomplete }`. IDs are opaque,
scoped hashes; absent tool IDs are null. `kind` follows the design's normalized
vocabulary. The immediate activity feed derives fixed labels from this data.
No arbitrary host strings, paths, commands, or error messages enter this object.

`Artifact`: `{ id, path, relativePath, hash, generation, exists, status, text,
complete }`. `status` is `present`, `missing`, `unavailable`, or `partial`;
`exists` is true, false, or null. Only confirmed missing retracts support.
Absolute paths and raw source are private, ephemeral data.
Files excluded by policy, symlinks outside the root, binary/oversized files,
and obvious credentials never become outgoing candidates.

`Candidate`: `{ id, artifactId, hash, generation, label, text, startLine,
endLine, sourceClass, complete, entityKey, labelOrigin, sourceRef, digest }`.
`sourceRef` is `{type:"artifact",artifactId,hash,generation}` or
`{type:"message",messageId,hash,contentVersion}`. `labelOrigin` is a source span
or a fixed generic label marker. `digest` binds label, text and source version.
Labels and text are sanitized before A.
`sourceClass` is `source` or `public_intent`. Exact IDs and versions are local.
Candidate discovery uses bounded source spans, not semantic truth rules.
One snippet can have several entity candidates. Generic labels have distinct
entity keys per artifact; they never merge every database into one identity.
`complete` means capture completeness, not semantic context completeness.

`Bundle`: `{ id, policyVersion, candidates, readSet }`. Core owns its
materialization: exact candidate copies, immutable artifact versions, no raw
lookup backdoors. Missing/uncertain sensitivity verdicts exclude candidates and
all their copied labels/text. Jev consumes this constructor before building B.
`readSet` is an array of `{artifactId, hash, generation}`.
Message refs use the discriminated message form above. The pipeline separately
tracks message versions. Unimplemented streaming/delta events report a coverage
gap; the first adapter does not claim to assemble them.

`Decision`: `{ status, activity, bundle, nodes, edges, stages, diagnostics }`.
`stages.A`/`stages.B` record `{model,rubricVersion,inputHash,usage,mode}`.

- `status`: `accepted`, `irrelevant`, `unavailable`, `timeout`, `overloaded`,
  `invalid`, or `abstained`.
- Node judgment: `{ candidateId, role, supportProbability, roleProbability,
  roleConfidence, roleProbabilities, classification }`.
- Edge judgment: `{ proposalId, sourceCandidateId, targetCandidateId, relation,
  evidenceCandidateIds, supportProbability, missingContextProbability,
  classification }`.
- Roles: `client`, `service`, `datastore`, `queue`, `external`, `module`.
- Relations: `calls`, `reads`, `writes`, `publishes`, `consumes`, `depends_on`.
- `unknown` is also a legal role answer but never an admitted known role.
- Classification: `accepted` or `tentative`. Missing answers do not fabricate
  judgments. Decisions contain the exact approved bundle, not IDs which
  can restore content from the original unfiltered collection.
- Diagnostics contain fixed codes, counts, model/rubric, duration, and usage;
  no body/error echo, credentials, or arbitrary model strings.

The compiler's experimental drawing floor is support >= 0.5 for both nodes
and edges. Lower support remains in decision diagnostics but produces no
drawable claim. Acceptance additionally requires the stricter support,
role, context, and endpoint checks; privacy thresholds are independent.

`Graph`: `{ schemaVersion:1, revision, nodes:[], edges:[] }`.

- Node: `{ id, label, kind, shape, x, y, evidenceState, activityState,
  classification, validity, sourceRefs:[], confidence? }`.
- Edge: `{ id, source, target, relation, label, evidenceState,
  classification, validity, sourceRefs:[], confidence? }`.
- Reference: `{ artifactId, hash, generation, eventId, startLine, endLine,
  sourceClass, basis:"jev_interpretation", excerpt? }`.
- State/classification/validity enumerations follow the design.
- IDs never contain source text. No runtime verification is inferred from a
  classifier answer or generic successful shell command.

`Patch`: `{ schemaVersion:1, id, baseRevision, revision, causedBy:[],
operations:[] }`. MVP operations: `node.upsert`/`edge.upsert` with a `node`/`edge`
object; `node.remove`/`edge.remove` with `id`. A patch is applied atomically.
Stable coordinates are compiler-owned. Unsupported operations are rejected.

## Core worker — `runtime/core/index.mjs`

Exports:

```js
createPolicy(options = {})                         // Policy
normalizeHostEvent(raw, { host, projectId, sequence, now })
  // { event, paths: string[], publicText: string|null }
metadataEvent(event)                                // safe allowlist copy
class EvidenceStore {
  constructor({ projectRoot, policy })
  async capture(paths)                             // Artifact[]
  async reconcile()                                // Artifact[] known paths
  isCurrent(refs)                                   // bool: hash + generation
}
buildCandidates({ event, artifacts, publicText, policy }) // Candidate[]
materializeBundle({ candidates, verdicts, policy, intakePolicy })  // Bundle
  // verdicts: [{ candidateId, digest, relevant:number, sensitive:number }]
buildRelationProposals(bundle, limits)              // { proposals, omitted }
  // { id, sourceCandidateId, targetCandidateId, relation, evidenceCandidateIds }
emptyGraph()                                       // Graph revision 0
compileDecision(graph, { event, decision, policy })  // Patch|null
invalidateArtifacts(graph, artifacts)               // Patch|null
applyPatch(graph, patch)                            // new Graph; rejects invalid
projectGraph(graph, policy, { persistent = false } = {}) // safe Graph copy
```

Exactly one EvidenceStore belongs to the canonical worktree and is shared by
every session pipeline. `capture` updates generations even when content is not transmissible.
`reconcile` checks only authorized tracked paths and can confirm deletion.
Pipeline invokes reconciliation before accepting a decision, then `isCurrent`.
Pipeline serializes capture/invalidation/decision acceptance. A version change
invalidates dependent claims in every session, without assigning authorship.
Graph invalidation runs even when no key, paused classification, or Jev outage.
Unavailable/partial observations make support stale; they cannot prove deletion.
For public intent, candidates may create only proposed claims and cannot prove
runtime or artifact state. All graph support must refer to accepted candidates.
Intake policy v1 uses `sensitiveMax:0.1`, `relevantMin:0.5`. Approval requires
both finite probabilities in [0,1], sensitivity <= maximum, relevance >= minimum,
and an exact digest match. Missing, duplicate, mismatched or invalid verdicts
exclude the entire candidate. These are experimental thresholds.

## Jev worker — `runtime/jev/index.mjs`

```js
createDecisionService({
  apiKey, model = "jev-1.13.0", fetchImpl = globalThis.fetch,
  endpoint = "https://api.typesafe.ai/v1/systemone",
  materializeBundle, buildRelationProposals, intakePolicy, admissionPolicy,
  clock, limits
})
  // { classify, stats, close }
async classify({ event, candidates, policy, deadlineAt, signal })
  // Decision; bounded service queue covers both stages
stats() // safe aggregate counts
close() // cancels work
```

An endpoint override is an injected testing option, not a browser setting.
A and B use separate HTTP requests. A sends only already-permitted candidate
content. Each candidate's sensitivity answer must explicitly be low enough
before it can appear in B, labels, or approved evidence. A choice cannot override
a sensitivity exclusion. B serializes only the approved bundle plus fixed
metadata; no unrestricted graph context or original candidate collection.
B validates exact pair propositions and context. Core's relation proposals
require all endpoints/evidence in that bundle; reads and writes are separate.
Wire state uses deduplicated `evidence[]` records and `entities[]` records
with a `sourceIndex`. Questions name direct backticked paths such as
`evidence[0].code` and `entities[0].name`; stable private IDs remain local.
Intake asks one sensitivity question per shared evidence span and one
relevance question per entity, so A's count is `1 + E + C`. All entities
sharing a rejected span are excluded before B. Rubrics are `intake-v2` and
`architecture-v3`; the latter defines each relation and limits missing
context to local bindings, wrappers, or operations needed for a code-level
judgment. Live connectivity, credentials, upstream callers, and known
third-party driver internals are not prerequisites for a code-level edge.
Defaults: concurrency 2, maxQueue 32, event deadline 2000 ms, two attempts per
event, 12 candidates, 40 questions per stage, 64 KiB request/256 KiB response.
B's question count is `1 + 2C + 2R`; at C=12 admit at most R=7 proposals.
Omissions are counted as coverage loss. No exact tokenizer claim.
The shared injected clock defaults to Date.now/timers. A call to `classify`
establishes its absolute deadline; any queueing inside this service, body reads,
and both stages consume it. The daemon configures a 5,000 ms workflow budget and
holds discovery work in the coordinator until a slot is available, so discovery
queue wait precedes that deadline. Reserve two attempts before A; skip B if no
approved evidence. No retries. 429/529
create a bounded cooldown. Budgets are per daemon, not account-wide.
Validate all requested answer IDs/types, finite ranges, option membership,
probability sums (tolerance 0.01), winner consistency, and Score level keys.
Never turn a missing probability into zero. Errors contain fixed codes only.
The implementation exports a fixture transport factory for offline demo/tests;
fixture results must be labeled and cannot be mistaken for real Jev evaluation.

## Coordinator — `runtime/pipeline.mjs`

```js
createPipeline({ projectRoot, policy, decisionService, onChange,
  restoredState, mode = "live", classificationDeadlineMs = 2000 })
  // { ingest, getState, reconcile, setPaused, selectSession, whenIdle, close }
async ingest(raw, { host = "claude" } = {}) // local preparation + queue; no remote wait
getState({ persistent = false } = {})      // viewer/persistence-safe Snapshot
async reconcile()
setPaused(boolean)                         // classifier pause; capture continues
selectSession(sessionId)
async whenIdle()                           // wait for local and remote work
async close()
```

Coordinator integrates event normalization, per-session graphs/activities,
bounded deduplication, immutable snapshots, async classification, current-version
checks, independent invalidation, history and safe public projections.
The daemon may call `getState` on every change. `onChange(snapshot)` is
notification only; callers never receive raw evidence.

The coordinator permits two active workflows and 64 waiting jobs. Waiting jobs
expire after 120 seconds and reauthorize their current source before dispatch.
`classificationDeadlineMs` bounds dispatch through final acceptance; the daemon
sets it and the Jev service's `eventDeadlineMs` to 5,000 ms. Capture does not wait
for remote decisions. `status.pending` includes waiting and active jobs.
Completion deduplication is session-local and covers exact classifier inputs,
so a later observation with additional candidates or joint file context can
still produce new shapes and relationships. Source is checked again before
applying answers. Pausing retains bounded references for resume; closing cancels
active work and discards waiting work.

Successful post-tool results supply bounded filename hints, including structured
Read/Glob/Grep output and recognized shell file listings. Hints only select fresh
EvidenceStore captures. Tool output is never promoted directly to source evidence
or public intent. Globally unchanged artifacts remain discoverable by a new
session.

`Snapshot`:

```js
{
  schemaVersion: 1, projectId, sessionId, mode, paused,
  sessions: [{ id, label }],
  graph, activity: [{ ...Event, label, state }],
  history: [{ revision, at, graph }],
  status: { connection, classifier, coverage, dropped, pending, calls }
}
```

`status.classifier` is a fixed code: `ready`, `metadata_only`, `missing_key`,
`paused`, `unavailable`, `timeout`, `demo`. Activity `state` is `pending`,
`succeeded`, `failed`, `interrupted`, `unresolved`, or `observed`.

## Runtime worker

`runtime/daemon/server.mjs` exports `startServer({ projectRoot, dataDir,
policy, decisionService?, mode?, port? })`, returning `{ url, port, close,
pipeline }`. Imports `createPipeline` from `../pipeline.mjs` and the Jev factory.
Coordinator implements that file to the interface above.

Private local IPC accepts bounded JSON `{ host, payload }`. It never accepts
browser credentials or external connections. HTTP serves bundled assets:

| Route | Purpose |
|---|---|
| `GET /` | Viewer |
| `POST /api/auth` | Exchange one-use fragment launch token for HttpOnly session cookie |
| `GET /api/state` | Current Snapshot |
| `GET /api/events` | SSE `snapshot` events; full state resync on connect |
| `POST /api/control` | `{ action:"pause"|"resume"|"session", sessionId? }` |
| `GET /api/export` | Sanitized current Snapshot JSON |

Strict loopback Host/Origin validation; no permissive CORS. Capture uses the
private IPC socket, not HTTP. Browser JS erases a fragment launch token after
exchange. State/log files use private permissions and atomic writes. Startup
restores sanitized state as stale and reconciles authorized support.

CLI `node scripts/graphlin.mjs`:
`start --project PATH [--allow-source] [--persist-evidence]`,
`stop`, `status`, `doctor`, `demo`, `export`.
Document default display policy and exclusions. `demo` starts with injected
fixture responses and generated project files, never external API access.
`scripts/control.mjs` exposes start/stop/status/doctor via stdio MCP.
`scripts/build-packages.mjs` generates portable + Claude + Codex bundles; Kiro
gets a documented experimental adapter profile, no false package guarantee.

## Viewer worker

`runtime/web/index.html`, `app.js`, `style.css`; no CDN or build dependencies.
Uses only the HTTP API above. It receives complete snapshots, so missed SSE
events recover without graph corruption. Renders finite shape/role tokens and
plain text. Never interpolate evidence as HTML.

Live/replay toggle, recent revision slider, evidence inspector, stable diagram,
pause/resume capture interpretation, session selection, connection/coverage
labels, JSON export, and visible `demo` labeling. All empty/unavailable states
must still show safe activity and a useful explanation.
