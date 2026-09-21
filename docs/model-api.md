# Local model API v1

`runtime/daemon/model-api.mjs` is a standalone transport module. It does not
install routes, select a global session, capture source, invoke a classifier,
persist state, or change a model. The parent daemon owns integration.

```js
const api = createModelAPI({
  projectId,
  getSnapshot: options => model.snapshot(options),
  getSessions: () => sessions, // optional; only if snapshots omit sessions
  createCheckpoint: options => model.checkpoint(options), // optional
});

// AFTER validating the remote loopback address and the exact Host header:
if (await api.handle(req, res, { viewerAuthorized: auth.authorized(req) })) return;
// Continue existing routes and their existing authentication checks.

// After accepted model, activity, checkpoint, or disclosure-policy changes:
api.notify();
// During daemon shutdown:
api.close();
```

`handle` resolves to `false` outside `/api/model/v1/` and otherwise sends the
response and resolves to `true`. The model callback is synchronous and returns
schema 2: `{schemaVersion: 2, projectId, revision, sequence, entities, relations,
interpretations, activity, coverage, sessions, checkpoints}`. It accepts
`{sessionId?, checkpointId?, scopeId?, persistent: false}`. Checkpoint creation
is also synchronous and returns a fixed marker with `id`, `projectId`,
`revision`, `sequence`, optional `label`/`sessionId`, and `at`. Replay calls
the snapshot callback with that checkpoint ID; it never reconstructs history
from the current model. Unknown markers should throw
`MODEL_CHECKPOINT_UNAVAILABLE`; capacity refusal may throw
`MODEL_CHECKPOINT_CAPACITY`.

## Integration authentication requirements

Preserve loopback binding, remote-address checks, exactly one allowed Host,
header/request timeouts, and connection limits in the outer HTTP server.
Dispatch this module before the legacy blanket query-string rejection and
viewer-cookie gate. For this prefix only, delegate Origin and bearer checks
to this module after the address/Host checks. An outer same-origin-only gate
would prevent explicitly paired browser origins from working.

`viewerAuthorized` must mean a successfully authenticated host viewer. Never
derive it from an external grant. Host POSTs additionally require an exact
nonopaque Origin matching the validated Host. The outer host must validate
the scheme and its normal viewer CSRF rules before setting `viewerAuthorized`.
External bearer tokens are recognized only on this module's GET routes.
Never make them credentials for legacy endpoints, controls, capture, extension
installation, or the host evidence inspector. Any bearer header prevents a
request from acquiring viewer privileges, even alongside a viewer cookie.

The snapshot provider must apply **current** local-read/display and path
exclusion policy on every read, including checkpoints. The transport applies
a second, fixed field allowlist; it cannot infer project consent. Notify it
after policy tightening, before further model delivery. Viewer-cookie expiry
and host shutdown remain outer-server lifecycle responsibilities.

## Routes

All paths below are relative to `/api/model/v1/`.

| Method and path | Result |
| --- | --- |
| `GET capabilities` | Versions, granted fields, limits and stream bounds |
| `GET bootstrap` | Initial bounded snapshot plus capabilities |
| `GET snapshot` | Bounded schema-2 snapshot and continuation cursors |
| `GET entities`, `relations`, `interpretations`, `activity`, `sessions` | One collection page |
| `GET entities/:id` | One projected entity |
| `GET entities/:id/children` | Direct children, paged |
| `GET history` | Checkpoint markers; `kind=activity` selects observations |
| `GET events` | SSE scoped snapshot stream |
| `POST checkpoints` | Viewer-only fixed checkpoint creation |
| `POST grants` | Viewer-only external-client pairing |
| `POST grants/revoke` | Viewer-only revocation |
| `OPTIONS` on GET routes | Narrow preflight for an actively paired Origin |

Read selectors are `scope`, `session`, and `checkpoint`. Scope includes the
named entity, descendants and reachable ancestors; relations and interpretations
remain inside that selection. Session selects activity/session history, not a
different project inventory. These selectors are client-local and never invoke
`selectSession`. Clients retain camera, selected entity, and follow state locally.

Snapshot, bootstrap, stream and page routes accept `limit=1..200`. Collection,
children and history pages accept `cursor`. Capabilities and POST routes accept
no query parameters. Unknown, empty and duplicate parameters, malformed IDs,
invalid limits, unexpected JSON fields and duplicate JSON keys are rejected.
Bodies must be UTF-8 JSON objects of at most 4 KiB; request URLs at most 4 KiB.
Tokens in query strings are never accepted. Checkpoint POST body:
`{"label":"Task baseline","sessionId":"session-example"}`; both keys are optional.

## Pages, coverage and revision consistency

Each JSON response and SSE frame is bounded by 512 KiB. Snapshots contain at
most 200 records **across all six collections**, reserving room for activity
even with a large entity inventory. Byte limits can reduce this further.
`partial` and `pages.<collection>.{total,returned,nextCursor}` expose omitted
pages. A snapshot cursor goes to the corresponding collection route;
checkpoint cursors go to `history`. Keep exactly the same selectors.

Pages return `{items, page: {total, offset, returned, complete, nextCursor}}`
along with model revision, model sequence, selection and transport metadata.
Entities use deterministic breadth-first containment order, with siblings sorted
by ID. Current, accepted, supported `graphlin.architecture` applications,
components, and memberships with source hash/generation references and current
canonical anchors receive priority: their anchors and complete ancestor chains
come first, preserving containment order, followed by the remaining entities in
their original order. These interpretations likewise precede other interpretations,
with ID order preserved within each portion. Priority uses only records disclosed
by the caller's field grant and scope. Without eligible architecture, ordering is
unchanged. Every bounded prefix keeps parents before children; subsequent pages
extend the same assembly without repeating ancestors. Relations and sessions use
ID order; activity and checkpoints use model sequence and then ID.
Cursors are signed and bind project/daemon epoch,
principal, collection or parent, selectors, revision, model sequence, and
the complete safe projection fingerprint. They expire after five minutes.
Changes, policy redaction, or expiry produce `409 stale_cursor`: discard the
partial assembly and obtain a fresh snapshot. Never merge inconsistent pages.
A cursor for a different principal, scope, or collection is invalid.

A 20,000-entity / 40,000-relation model is paged rather than rejected for
snapshot size. Inventory coverage exports allowlisted counts, completeness,
deferred counts, relationship counts, detail counts and parsing status.
`coverage.parsing` preserves `queued`, `active`, `deferred`, `parsed`, `failed`,
`stale`, `omitted`, and a bounded error code. It never contains parser source.

`coverage.lineage` preserves a bounded `id`, exactly one of the statuses `git`,
`not_git`, or `unavailable`, and optional safe `branch` and 40- or 64-character
hexadecimal `head`. Invalid required fields omit the lineage record; invalid
optional fields and unknown properties are stripped. Checkpoint GET and SSE
reads preserve the lineage recorded in that checkpoint, subject to current
disclosure policy. The API does not overlay the live branch or infer freshness;
the model owns branch/HEAD reconciliation. Lineage requires the `coverage`
grant field and participates in page consistency checks.

Entity `createdAtSequence` preserves a positive integer creation-observation
marker. `coverage.enumerations` preserves strictly validated certificates:
artifact/scope IDs, hash/generation, extractor and version, identity version,
covered line ranges, omission codes, capability and completeness. No arbitrary
certificate properties or range payloads are copied. A certificate cannot be
complete with invalid/missing ranges, unknown versions, omissions or a
nonparsed capability. Duplicate artifact certificates are withheld.

Certificates are bounded to 64 records/64 KiB and count toward the snapshot's
200-record budget. At most half of a caller's smaller `limit` is allocated to
certificates. Scoped reads retain certificates for artifacts supporting the
selected entities. `coverage.enumerationCoverage` reports `total`, `returned`,
`omitted` and `truncated`; omitted proof must remain unknown in comparisons.
Clients can narrow the scope to recover relevant proof in a large project.
Inventory file/artifact arrays are still represented by counts.
`coverage.projection.omitted` counts records
withheld by record validation. Unknown fields and nested extension payloads are
never copied. A transport page being complete does not establish complete
discovery, source support, or runtime execution.

## Stream and reconnect

Use streaming `fetch` with an Authorization header for external clients.
Native `EventSource` does not supply an arbitrary bearer header.

The SSE `snapshot` event contains the same bounded scoped schema as a snapshot
GET. Its ID is `epoch:transportSequence:selectionKey`; model `sequence` and
`revision` remain separate. Each `notify()` advances the transport sequence,
including activity-only and disclosure changes. Delivery is scheduled outside
the notifying call and can coalesce updates. The initial subscriber is
registered before its synchronous snapshot is obtained, without an intervening
await, so updates cannot fall between snapshot and subscription.

Reconnect with `Last-Event-ID`. The last 128 transport positions are retained.
A matching epoch, principal/selection and retained position yields one **fresh,
full replacement** snapshot with `transport.resume.fromSequence` and
`coalesced: true`. This is snapshot continuity, not replay of every intermediate
transition. The retained ring stores only positions, never old payloads.
Activity history comes from the model's ordered observations and named
checkpoints. Clients needing every observation must inspect model coverage and
history bounds; transport continuity does not imply unlimited model history.

Wrong lineage/selection, a future/evicted position or missing history permission
yields a `reset` event containing a reason and retained bounds, then a fresh
snapshot. Drop the old partial page assembly and scene. Duplicate snapshot
positions can be ignored within the same live selection. No semantic deltas
are currently emitted. Checkpoint streams continue to read their fixed marker.
Revocation/policy changes cannot recover data already copied by a client.

There are at most 16 open streams. A stream whose queued bytes plus its next
frame would exceed 512 KiB is disconnected; it can recover by reconnecting.
Snapshot failures close affected streams with `unavailable`. `notify()` and
`close()` are safe after shutdown. The provider remains responsible for keeping
its synchronous snapshot work bounded.

## Pairing an external client

An authenticated same-origin host POST can create a grant:

```json
{
  "projectId": "project-example",
  "fields": ["entities", "relations", "activity", "coverage"],
  "history": false,
  "ttlSeconds": 900,
  "origins": []
}
```

The response contains public grant metadata and a one-time plaintext `token`.
Only its SHA-256 hash is retained for authentication. A token is short-lived,
project-bound and read-only. `fields` is an explicit nonempty subset of
`entities`, `relations`, `interpretations`, `activity`, `coverage`, `sessions`,
and `checkpoints`. TTL is 1–3600 seconds (default 900); at most 32 grants exist.
Grants are memory-only and all expire on daemon restart.

`history: false` allows current snapshots, including the current activity
window; it forbids checkpoint/session selectors, history routes and historical
stream resume, and withholds checkpoint markers. Requesting an ungranted
collection is forbidden. Empty arrays stand in for ungranted snapshot fields;
coverage contains only transport withholding counts unless granted.

Native clients omit Origin. Browser clients must use an exact HTTP(S) origin
listed in the grant, such as `https://visualizer.example`. Wildcards, URL paths,
credentials and opaque `null` origins are rejected. CORS responses echo only
that origin, allow GET and Authorization/Last-Event-ID headers, and never allow
credentials. A preflight reveals no model and requires an active paired origin.
The subsequent GET must still authenticate its individual token and Origin.

Revoke with `POST grants/revoke`, body `{"grantId":"grant-example"}`.
Revocation ends existing streams immediately. Independent expiry timers plus
an idle sweep end expired streams without requiring a model update or another
request. Neither external bearer credentials nor a paired origin can create
checkpoints/grants, revoke other clients, install extensions or control capture.

Every route, history response and stream uses the same record allowlists.
There is no raw source, excerpt, prompt, transcript, hook input, credential,
absolute locator, or arbitrary namespace payload field in this contract.
Labels are approved display metadata supplied by the core, additionally checked
by the local secret/text filter. This is not a general-purpose sanitizer for
arbitrary source embedded in labels; providers must never supply such content.

## Separate model persistence

`runtime/daemon/model-persistence.mjs` is an optional, separate parent integration.
It neither opens nor changes legacy `state.json`. Use the canonical private
project-data directory already established by the daemon:

```js
const modelStore = createModelPersistence(
  path.join(paths.directory, 'model-state.json'),
);
const restoredModel = await modelStore.load(); // undefined when absent/unusable
// Pass restoredModel to the model constructor; it revalidates evidence/policy.
modelStore.schedule(model.snapshot({ persistent: true }));
await modelStore.flush(); // explicit durability point
await modelStore.close(); // stop scheduling and drain before releasing daemon lock
```

The interface is `createModelPersistence(filename, {projectId?, maxBytes?,
debounceMs?, now?} = {})`. The filename-only call matches the legacy factory.
An omitted project ID binds to the first successfully loaded or scheduled
snapshot; rejected data never binds it. Later cross-project data is refused.
Passing `{projectId: paths.projectId}` additionally validates the project on
the first load. Full SHA-256 project IDs are supported.
Its methods are `load`, `schedule`, `flush`, `close` and
`stats`. `schedule` synchronously captures immutable JSON and returns whether
the snapshot was accepted. Calls coalesce within a 100 ms window; a running
write retains at most one replacement snapshot, so continuous updates do not
starve persistence. `flush` and `close` wait for accepted writes, including a
replacement queued during a write. The parent supplies its existing exclusive
daemon lock; this module is not a multiprocess lock service.

The disk envelope is `{schemaVersion: 2, savedAt, projectId, snapshot}`.
The **complete envelope** must fit 48 MiB; `maxBytes` can lower but never raise
that ceiling. Byte counting precedes full JSON encoding, including UTF-8 and
escape expansion. Oversized or invalid input is refused intact: no records,
checkpoint states or support are silently trimmed. The previous accepted file
and pending snapshot survive refusal. Persistent `.storage` and checkpoint
states are preserved; they still cannot pass through HTTP API projection.

The parent must supply `model.snapshot({persistent: true})` under current
policy, rather than a display snapshot or raw model internals. Persistence does
not grant new source access, reinterpret evidence, or replace policy filtering.
Undefined object fields used for withheld paths are omitted using normal JSON
semantics; unsupported values, accessors, cycles and oversized nesting are refused.
Loading likewise does not establish current evidence validity; restore through
the core model and reapply current policy before serving anything.

Writes use an exclusive 0600 temporary file in the same private directory,
file sync, atomic rename and directory sync where supported. The target and
directory must be owned by the current user, private, and free of symlink or
hard-link substitutions. The directory must already exist at its canonical
path. The legacy `state.json` filename is explicitly rejected. Failed writes
clean their temporary file and report aggregate `persistenceFailures` through
`stats`; no contents, credentials or paths are logged.

Missing, malformed, oversized, incompatible, wrong-project or unsafe model
files return `undefined`. They are never automatically removed, and valid
model files have no implicit age expiry. The parent can retain legacy-only
operation when model load fails. Rollback continues to read untouched
`state.json`; the parent owns any deliberate migration and package rollback.
