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
API. Selecting a retained checkpoint uses the core comparison implementation.
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

Browser-safe scene and message validation is imported from the SDK contract
modules rather than reimplemented by each built-in. Shared scenes contain
finite primitives, never extension-supplied HTML or SVG. Nested frames use a
title band, padded containment, and separated sibling rectangles.

## API integration

All requests use the existing host session cookie and same-origin credentials.
No launch token is forwarded to a visualizer.

| Route | Use |
| --- | --- |
| `GET /api/model/v1/snapshot` | Schema 2 model; optional `scope`, `session`, `checkpoint` |
| `GET /api/model/v1/events` | Full `snapshot` events, optional scope/session; `reset` refreshes the snapshot |
| `POST /api/model/v1/checkpoints` | Explicit host action with a checkpoint label |
| `GET /api/extensions` | `{extensions: [...]}` catalog with manifest, digest, and current grant |
| `POST /api/extensions/grant` | `{id, digest, fields, history, approved}` |
| `GET /api/extensions/data/<id>` | Daemon policy/grant-projected model, with the same scope/session/checkpoint options |
| `GET /api/extensions/frame/<id>?nonce=...` | Daemon-generated document with response-level sandbox/CSP |

The client accepts monotonic full snapshots, ignores duplicates, and rejects
late requests after scope/replay changes. Full snapshots can legitimately skip
sequence numbers; no partial delta is applied across a gap. Selecting a
checkpoint closes the live model subscription.

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
Revocation, denied access, digest replacement, or frame navigation clears the
controlled view and disposes its port/frame. It cannot recall data already
copied by third-party code.

The iframe uses `sandbox="allow-scripts"` with no same-origin permission.
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

The first-party timeline is trusted bundled code using the custom lifecycle.
Third-party custom renderers use the opaque frame and bounded custom status;
they do not receive first-party inspector privileges. Iframes are not a promise
of hard CPU isolation or universal prevention of disclosure.

## Verification

`node --test tests/web/*.test.mjs` exercises both the existing viewer and model
views, including source-kind filters, group bounds, aggregation, C4 abstention,
checkpoint comparisons, custom activity, follow behavior, obsolete responses,
readiness, invalid scenes, and navigation teardown.

`node tests/web/platform-browser-fixture.mjs` starts a disposable loopback-only
fixture for browser review. It supplies generated models and an installed
fixture visualizer; it does not run capture, inspect a user's project, read a
key, or persist user state. Its API is a test fixture, not an authentication
test or a replacement for the daemon's integration/isolation tests.
