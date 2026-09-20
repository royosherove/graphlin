# Viewer views

Graphlin keeps a source model separate from the drawing. The compact view picker
selects **Code**, **Blocks**, **C4**, **Changes**, **Activity timeline**, or an
installed visualizer. Details, History, and the legacy Activity panel remain
hidden until opened. The existing sketch renderer and eight palettes remain
available.

## Reference views

| View | What it shows |
| --- | --- |
| Code | Canonical declarations and supported relationships, using the existing sketch shapes and layouts |
| Blocks | Filesystem scopes and parsed containment, with expandable parent frames |
| C4 | Context, applications/datastores, components, and code; supported current interpretations determine architectural boundaries |
| Changes | Discoveries, creations, modifications, removals, and invalidations against an explicitly selected checkpoint |
| Activity timeline | Ordered tool/agent observations, attributed lanes, terminal outcomes, and attempts whose outcome is unresolved |

Folders do not establish applications, processes, or deployment boundaries.
Without a supported interpretation at the selected C4 level, source scopes
remain usable and the view reports that their responsibilities are unknown.
Missing interpretation does not trigger a classifier call from the browser.
The Blocks view does not invent responsibility labels.

**Set baseline now** creates a named checkpoint through the authenticated host
API, including the selected session. It is disabled during replay. Selecting a
retained checkpoint uses the core comparison implementation.
First observation is discovery unless the core records supported creation or a
compatible complete enumeration proves prior absence. Missing retained records
are not treated as deleted. Source edits do not establish runtime success.

The timeline works with zero entities and zero relations. Correlation uses
recorded tool/agent identifiers; an unpaired attempt stays unresolved. Selecting
an observation inspects its linked entity, or explains that no source entity is
linked. It never claims private reasoning capture.

## Navigation

Search and source-kind filters apply together. Matching declarations keep their
ancestor frames, and searches expand the path to a match. Escape clears the
search while retaining type choices. Filtering arranges and fits the result.
The inspector's **Open source scope** action and the breadcrumb buttons request
a bounded source scope. C4 interpretation groups can expand to their supported
source members.

Collapsed connections aggregate by source scope, target scope, relation type,
and validity. Calls and writes remain separate. Internal connections do not
become self-arrows. Each aggregate retains its relation IDs and count for the
host evidence inspector. Scene limits affect presentation, never discovery.
The coverage line reports truncation and available inventory/inspection counts.

Selection maps to canonical entities. Switching views preserves that entity
when represented, otherwise its nearest represented ancestor/group. Each view
retains its camera, layout, shape overrides, and theme. **Follow agent** reveals
newly arriving or newly active entities through containment; turning it off
keeps the camera in place. Fit and Arrange remain explicit user actions.

**Position** selects Live or a retained model checkpoint. Model replay uses
recorded snapshots and makes no inference calls. The older History scrubber
remains available when using the legacy API; model views use Position instead.
Custom views disable graph layout/zoom controls that they do not implement.

## Browser modules and lifecycle

`runtime/visualizers/` contains pure source-to-scene projectors, a common
containment/aggregation projector, and the first-party custom timeline.
`createBuiltin()` and `createExtensionFrame()` expose `update(input)` and
`dispose()` to the viewer host. Updates return a validated scene or bounded
custom status. The timeline mounts DOM through this same lifecycle and has no
dependency on the graph renderer.

`runtime/web/model-client.js` owns authenticated model snapshot/stream access.
`runtime/web/platform.js` owns view choice, per-view settings, checkpoints,
grants, cancellation, and scope. `runtime/web/scene.js` supplies containment
geometry, filtering, and canonical mappings. `runtime/web/app.js` retains
authentication, evidence inspection, diagnostics, sketch rendering, and the
legacy fallback.
Legacy source references accept both `jev_interpretation` and
`decision_interpretation`; alternate providers use the generic Decision
interpretation label while existing Jev labels remain compatible.

Browser-safe scene and message validation is imported from the SDK contract
modules rather than reimplemented by each built-in. Shared scenes contain
finite primitives, never extension-supplied HTML or SVG. Nested frames use a
title band, padded containment, and separated sibling rectangles.

## API integration

All requests use the existing host session cookie and same-origin credentials.
No launch token is forwarded to a visualizer.

| Route | Use |
| --- | --- |
| `GET /api/model/v1/snapshot` | Paged schema 2 model; optional `scope`, `session`, `checkpoint` |
| `GET /api/model/v1/entities`, `/relations`, `/interpretations`, `/activity`, `/sessions`, `/history` | Revision-bound cursor pages; history supplies checkpoints |
| `GET /api/model/v1/events` | Snapshot envelopes with the same pages/cursors; optional scope/session |
| `POST /api/model/v1/checkpoints` | Explicit host action with `label` and optional `sessionId` |
| `GET /api/extensions` | Catalog with manifest, digest, current grant, and declared profile descriptors |
| `POST /api/extensions/grant` | `{id, digest, fields, history, approved, profiles}` |
| `POST /api/extensions/analysis` | Explicit Run analysis action with `{id, digest, profileId, entityIds, revision}` |
| `GET /api/extensions/data/<id>` | Daemon policy/grant-projected model, with the same scope/session/checkpoint options |
| `GET /api/extensions/frame/<id>?nonce=...` | Daemon-generated document with response-level sandbox/CSP |

The client hydrates pages at one project/revision/model sequence and transport
epoch. It restarts stale cursors rather than mixing revisions. Transport sequence
and epoch govern SSE ordering independently of the model's observation sequence;
coalesced snapshots may skip transport positions. Scope/replay changes cancel
obsolete work. Selecting a checkpoint closes the live model subscription.

Hydration retains at most 2,048 entities, 4,096 relations, 512 interpretations,
2,048 activities, 100 sessions, and 100 checkpoints, within a 6 MiB budget.
The API's individual response limit remains 512 KiB. Coverage records retained
and total counts when these bounds truncate a scope. Opening a narrower source
scope requests that scope from the daemon; the browser does not need an
unbounded full-project model.

An absent model endpoint leaves the legacy `/api/state` and `/api/events` code
map usable. Capture/status, diagnostics, exports, and authentication keep their
existing routes. The model endpoint never replaces the host evidence policy.

## Installed visualizers

Installation alone does not grant data. The host shows explicit field and
history choices, and approval is bound to the project and installed digest.
Before approval, no projected-data request or model delivery is made.
Raw source, excerpts, prompts, transcripts, credentials, and unrestricted source
retrieval are not offered as grant fields.

An approved extension receives **only** the response from its daemon-projected
data endpoint. The host never forwards its own raw model as a fallback.
Catalog/grants are rechecked before each delivery, including history.
An independent two-second poll checks the mounted extension's grant and digest
even during replay. Unmounting cancels that poll.
Revocation, denied access, digest replacement, or frame navigation clears the
controlled view and disposes its port/frame. It cannot recall data already
copied by third-party code.

The iframe uses `sandbox="allow-scripts"` with no same-origin permission.
Both the host response policy and the HTML meta policy permit same-origin
frames. The browser check caught and fixed the missing HTML `frame-src 'self'`
directive; frame mounting now passes in the actual headless browser.
One bootstrap is sent to its exact window with a fresh nonce and a dedicated
MessageChannel. Readiness must echo that nonce before data is sent. The opaque
origin requires `*` for the bootstrap target origin; the exact frame window,
one-use nonce, and port supply the binding.

Typed project/result messages carry instance, project, revision, view epoch,
request ID, and API version. Late responses are ignored; scene mappings are
checked against the delivered projection. Payload size, message rate, readiness,
and update deadlines are bounded. Invalid output or navigation disposes the
frame; the host falls back to Code after extension failure. First-party projector failure keeps the
last accepted drawing. Policy/grant failures always clear affected content.
Selection and inspection requests require a declared request capability, an
active matching grant, and access to the mapped data field.

Declared analysis profiles have separate approval checkboxes. **Run analysis**
uses the selected canonical entity, or at most 256 entities in the current scope,
at the current revision. Mount, layout, theme, filtering, and replay do not call
analysis. Replay disables the action. The approval text explains that a profile
may send locally filtered evidence to the configured service and requires the
project's existing source-transmission consent; visualizer approval does not
enable that consent. The daemon rechecks the grant, profile, revision, candidates,
and source policy.

The first-party timeline is trusted bundled code using the custom lifecycle.
Third-party custom renderers use the opaque frame and bounded custom status;
they do not receive first-party inspector privileges. Iframes are not a promise
of hard CPU isolation or universal prevention of disclosure.

## Verification

`node --test tests/web/*.test.mjs` exercises both the existing viewer and model
views, including source-kind filters, group bounds, aggregation, C4 abstention,
checkpoint comparisons, custom activity, follow behavior, obsolete responses,
readiness, invalid scenes, and navigation teardown.
Focused tests also exercise actual model API paging beyond 200 records, bounded
hydration, transport epochs, and session-filtered checkpoint creation/replay.

`node tests/web/platform-browser-fixture.mjs` starts a disposable loopback-only
fixture for browser review. It supplies generated models and an installed
fixture visualizer; it does not run capture, inspect a user's project, read a
key, or persist user state. Its API is a test fixture, not an authentication
test or a replacement for the daemon's integration/isolation tests.

`node tests/web/platform-daemon-fixture.mjs` starts the actual daemon against a
generated source project and installed custom extension under a disposable
temporary directory. It uses a random loopback port and disables source
transmission. Its `change` and `revoke` input commands support manual browser
checks; stopping it removes its own fixture state.

`node tests/web/platform-browser-check.mjs` runs the actual fixture in a separate
headless Playwright browser with a temporary profile. Set
`GRAPHLIN_BROWSER_DEPENDENCIES` to a directory whose `node_modules` includes
Playwright, optionally `GRAPHLIN_BROWSER_EXECUTABLE` to a Chrome executable, and
`GRAPHLIN_BROWSER_ARTIFACTS` for screenshots and the verification report.
This explicit check covers the reference views, narrow-screen keyboard use,
real sandbox frame mounting, profile approval/run, selection, and grant
revocation during replay. It does not access existing user browser profiles,
projects, or daemon instances, and is not a privacy certification.
