# Authoring a Graphlin visualizer

An extension receives a policy-filtered model and returns a small scene, or
renders a custom view in an isolated browser frame. It never runs inside the
Graphlin daemon. It needs no collector, agent plugin, API key, source access, or
runtime dependency installation.

Extension API **1**, model schema **2**, and scene schema **1** are separate
versions. The browser SDK is `runtime/extensions/sdk.mjs`; its public types are
in `runtime/extensions/sdk.d.ts`. The runtime entry is
`runtime/extensions/index.mjs`. Package authors can subscribe to the browser
protocol directly, so a build tool is optional.

The public package export `graphlin/extensions/sdk` resolves to that browser
entry and its types; `graphlin/extensions/scene` exposes scene validation alone.
Bundle these imports into the single executable asset.

## Create an independent package

Create a directory containing only these package files:

```text
my-c4/
  graphlin.extension.json
  package.json
  dist/
    visualizer.js
  profiles/
    c4.json
```

The optional `README.md` and `LICENSE` files are also allowed. Other files must
be declared JS/JSON assets. Keep authoring sources, environment files,
dependencies, maps, and build tools outside this install directory. Symlinks,
hard links, special files, undeclared files, and `node_modules` are rejected.

Save this as `dist/visualizer.js`. This small C4 projection reads explicitly
typed, supported application/datastore interpretations. A class, directory,
generic analysis answer, or label does not create an application boundary.
If the model has no supported interpretations, it abstains.

```js
window.addEventListener('graphlin:connect', ({ detail: { port } }) => {
  const kinds = { application: 'service', container: 'service', datastore: 'datastore' };
  port.onmessage = ({ data: message }) => {
    if (message.type === 'graphlin:dispose') { port.close(); return; }
    if (message.type !== 'graphlin:project') return;
    const model = message.model;
    const byId = new Map(model.entities.map(entity => [entity.id, entity]));
    const chosen = model.interpretations.filter(value =>
      Object.hasOwn(kinds, value.kind) &&
      value.validity === 'current' && value.support === 'supported' &&
      value.classification === 'accepted' && value.sourceRefs.length &&
      value.entityIds.length && value.entityIds.every(id => byId.get(id)?.validity === 'current')
    ).slice(0, 64);
    const groups = chosen.map(value => ({
      id: `boundary-${value.id}`, entityIds: value.entityIds,
      membershipId: value.id, label: value.label,
      kind: kinds[value.kind], parentId: null, collapsed: true
    }));
    const owner = new Map(groups.flatMap(group => group.entityIds.map(id => [id, group.id])));
    const relationKinds = new Set([
      'calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on'
    ]);
    const edges = model.relations.filter(relation =>
      owner.has(relation.source) && owner.has(relation.target) &&
      owner.get(relation.source) !== owner.get(relation.target) &&
      relation.validity === 'current' && relationKinds.has(relation.kind)
    ).slice(0, 256).map(relation => ({
      id: `edge-${relation.id}`,
      source: owner.get(relation.source),
      target: owner.get(relation.target),
      kind: relation.kind,
      relationIds: [relation.id],
      count: 1
    }));
    port.postMessage({
      type: 'graphlin:scene', apiVersion: 1,
      instanceId: message.instanceId, projectId: message.projectId,
      revision: message.revision, viewEpoch: message.viewEpoch,
      requestId: message.requestId,
      scene: {
        sceneVersion: 1, nodes: [], edges, groups,
        coverage: {
          shown: owner.size, total: model.entities.length,
          truncated: model.entities.length > owner.size,
          label: groups.length ? 'Supported interpretations only' : 'Application boundaries unknown'
        }
      }
    });
  };
  port.start();
});
```

Save this as `profiles/c4.json`. The optional `interpretationKind` mapping
declares the meaning of a supported answer. The broker uses the selected
entity's core label for the resulting boundary, not the word `application`.
`unknown` cannot create a C4 boundary.

```json
{
  "id": "architecture",
  "questions": [
    {
      "id": "role",
      "kind": "choice",
      "question": "Which role, if any, is supported for the selected entities by the supplied current model metadata? Choose unknown when the metadata does not establish a boundary.",
      "options": ["application", "datastore", "unknown"],
      "interpretationKind": "selected-choice"
    }
  ],
  "selectors": {
    "fields": ["entities", "relations"],
    "candidateIds": []
  }
}
```

This profile runs only after explicit host activation, profile approval, and
source-transmission consent. Opening or rendering the extension never runs it.
Metadata often cannot establish an architectural boundary; the default C4
view and this example remain unknown until core admits a supported mapping.

Save `package.json`:

```json
{
  "name": "my-graphlin-c4",
  "version": "1.0.0",
  "files": ["graphlin.extension.json", "dist/visualizer.js", "profiles/c4.json"]
}
```

Generate the manifest from the final asset bytes. Run this in `my-c4`:

```sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const entry = 'dist/visualizer.js';
const assets = {};
for (const name of [entry, 'profiles/c4.json']) {
  assets[name] = 'sha256-' + createHash('sha256').update(await readFile(name)).digest('hex');
}
await writeFile('graphlin.extension.json', JSON.stringify({
  manifestVersion: 1,
  id: 'example.c4',
  name: 'My C4 view',
  version: '1.0.0',
  graphlinApi: '1',
  modelSchema: '2',
  requiredFeatures: ['canonical-mappings', 'scene-groups'],
  entry,
  assets,
  decisionProfiles: ['profiles/c4.json'],
  views: ['applications'],
  renderer: { kind: 'graphlin-scene', sceneVersion: '1' },
  capabilities: ['model.read', 'selection.request', 'analysis.request']
}, null, 2));
JS
```

The manifest filename and keys are exact. Unknown keys, capabilities, required
features, and incompatible versions fail closed. Asset paths are relative
without `./`, `..`, encoded characters, URL suffixes, or backslashes.

API 1 capabilities are `model.read`, `activity.read`, `history.read`,
`selection.request`, `inspection.request`, and `analysis.request`.
Supported required features are `containment`, `canonical-mappings`,
`scene-groups`, `activity`, and `checkpoints`. A feature name is a compatibility
requirement, not a grant.

The renderer is `{ "kind": "graphlin-scene", "sceneVersion": "1" }` or
`{ "kind": "custom" }`. There is exactly one executable `.js` asset: the entry.
Bundle any SDK or third-party library into that classic script. ES module
imports/exports, source maps, runtime dependencies, and external assets are not
supported. Additional declared `.json` assets are inert data supplied in the
`graphlin:connect` event.

## Install, update, inspect, and remove

The parent CLI calls `runExtensions(args, { projectRoot, dataDir })` from
`scripts/extensions.mjs`. With that dispatch integrated, the commands are:

```sh
graphlin extensions add ./my-c4
graphlin extensions list
graphlin extensions doctor
graphlin extensions dev ./my-c4
graphlin extensions add my-graphlin-c4@1.0.0
graphlin extensions update my-graphlin-c4@1.0.1
graphlin extensions remove example.c4
```

`dev` requires an explicit directory, copies a development snapshot, and marks
it visibly in the catalogue. Rerunning it reloads the directory. For a live
authoring session, the integration may use
`registry.dev(directory, { watch: true, signal, onChange })`. Its returned
`close()` stops watching; `done` resolves when closed. Invalid intermediate
builds report an error and retain the installed version. Successful changes
have new digests, require new grants, and require frame replacement.

To produce an npm archive locally:

```sh
npm pack --ignore-scripts
```

Publishing is a separate, explicitly authorized author operation. Graphlin
remote installation accepts only an exact `name@version` or
`@scope/name@version`. It runs `npm pack --ignore-scripts` in a private temporary
directory with a clean npm configuration, then validates tar contents in
memory. No lifecycle scripts or dependency installation are run.

Archive validation rejects path traversal, links, device/sparse files, PAX/GNU
extended headers, duplicate or case-colliding paths, corrupt checksums,
truncation, and oversized contents. Packages requiring extended headers should
use shorter file paths. Package name/version must match the requested identity.

Limits are 32 assets, 128 package entries, 2 MiB per file, 8 MiB package content,
and 12 MiB compressed or expanded archive size. Hashes are SHA-256 hex strings
prefixed with `sha256-`. The bundle digest also covers the canonical manifest,
so changes to capabilities, profiles, or labels create a different identity.

Installed assets live under the repository's private `.graphlin/` directory at
`extensions/bundles/<id>/<version>/<digest>/`. The runtime never edits a stored
bundle. An atomic catalogue write activates a verified bundle. Failed validation,
cancelled transport, or a failed catalogue write leaves the active version and
its grants intact. Old bundle bytes are retained for recovery. Removal atomically
removes catalogue access and grants; retained bytes are unreachable through
the registry. The authoring runtime currently has no automatic bundle garbage
collection.

## Approve data explicitly

Installation alone delivers no project data. The authenticated host owns approval:

```js
await registry.grant('example.c4', {
  digest: installed.digest,
  fields: ['entities', 'relations', 'interpretations', 'coverage'],
  history: false,
  approved: true,
  profiles: ['architecture']
});
```

Allowed field groups are `entities`, `relations`, `interpretations`, `activity`,
`coverage`, `sessions`, and `checkpoints`. Each needs the corresponding declared
read capability. `checkpoints` requires `history: true`, and history requires
`history.read`. A grant can optionally approve named `profiles`.
HTTP session selectors also require history, because they can address earlier work.

Approval is bound to project, extension ID, exact bundle digest, fields, history,
and profiles. An update to different bytes clears earlier approvals across
projects. Rolling back does not restore approval automatically. An unchanged
bundle may keep its existing grant. `revoke(id)` stops current-project access;
removal stops access across projects.

For every delivery, the broker calls:

```js
const grant = await registry.getGrant(extensionId);
const projected = getExtensionDataProjection(currentPolicySnapshot, grant);
if (projected === null) {
  // Destroy the frame and purge host-controlled scenes/caches.
}
```

`getExtensionDataProjection(snapshot, grant)` is pure: it never reads storage,
mutates a model, or grants authority. It returns `null` for invalid, denied,
unapproved, or cross-project grants. A copied grant object is not a token; the
broker must get the current grant again and compare the mounted digest before
every delivery. Concurrent updates/revocations must invalidate in-flight work.

The input snapshot must already reflect current core policy. Reapply that
policy to history too. Mark historical inputs with `replay: true` or
`checkpointId` and check `grant.history`; the pure function cannot distinguish
an unmarked old snapshot from a live one.

The output shape is:

```text
{
  schemaVersion: 2, projectId, revision, sequence,
  entities: [{
    id, label, kind, parentId, artifactId?, qualifiedName?,
    sourceRefs, basis, validity, classification
  }],
  relations: [{id, source, target, kind, basis, validity, sourceRefs}],
  interpretations, activity, coverage, sessions, checkpoints
}
```

Unapproved collections are empty. Relations and interpretations only reference
delivered entities. Activity-only visualizers are supported. Every nested
record is built from allowed fields, including coverage, interpretation
namespaces, source references, sessions, and checkpoint metadata. Source
references contain bounded IDs, hashes, generations, and line numbers, never
source text.

No API 1 grant includes source, excerpts, prompts, transcripts, absolute paths,
raw hook bodies, credentials, arbitrary object namespaces, or arbitrary
inspection responses. Labels are bounded and filtered for secrets and absolute
locators. Only the host inspector can display separately authorized evidence.
Parsed structure, public intent, interpretation, and execution remain distinct;
an extension cannot upgrade an attempted operation into observed success.

## Validate scenes and messages

Use `validateScene(scene, { model: deliveredProjection })` in the host.
`validateScene(scene)` checks structure alone and is useful for author tests;
it is insufficient at the data boundary.

A scene has `sceneVersion: 1`, `nodes`, `groups`, `edges`, and optional `coverage`.
Nodes have `id`, `entityId`, `label`, and `kind`. Groups have `id`, `entityIds`,
and `label`; optional `membershipId` is an opaque membership reference.
Both accept `parentId`, finite layout hints, and finite style/shape tokens.
Parent IDs always refer to scene groups. Group cycles and missing parents fail.

Edges have `id`, `source`, `target`, and `kind`. Under model validation,
`relationIds` must identify delivered relations of that exact kind connecting
the represented endpoint entities. A group's `entityIds` is its bounded
membership set. `count`, when present, equals the supplied relation count.
Never combine calls, reads, and writes into a stronger relation. The renderer
can lay out a legacy-compatible node kind while retaining group parent links.

Limits are 256 nodes, 64 groups, 768 edges, 256 members per mapping, 240 label
characters, and 1 MiB per serialized scene. Coordinates must be finite within
±100,000; dimensions must be positive and at most 20,000. Arbitrary HTML, SVG,
CSS, URLs, event handlers, and unknown fields are rejected. Styles are tokens
such as `default`, `tentative`, `stale`, `active`, and `discovered`, not CSS.
The complete token sets are exported from `sdk.mjs`.

Each asynchronous message carries this context:

```js
{
  apiVersion: 1,
  instanceId, projectId, revision, viewEpoch, requestId
}
```

The SDK supports:

| Type | Payload |
| --- | --- |
| `graphlin:project` | `model`, optional `settings`, optional `selection` |
| `graphlin:scene` | `scene` |
| `graphlin:status` | `status`: `ready`, `busy`, `empty`, or `error`; `itemCount`: integer 0–20,000 |
| `graphlin:select` | `selection`: exactly one `entityId`, `relationId`, or `activityId` |
| `graphlin:error` | Fixed diagnostic `code` |
| `graphlin:dispose` | No payload |

The host calls `validateMessage(message, { model: deliveredProjection, context })`
before handling responses. Supplying `context` verifies instance, project,
revision, view epoch, request, and API version. Selection validation requires
the granted projection and rejects targets absent from it. The host additionally
checks the active `selection.request`/`inspection.request` capability, current
grant, message rate, outstanding requests, and projection deadline.

When bundled, `connectExtension({ project, mount, dispose })` handles the basic
project/scene lifecycle and discards superseded asynchronous results. A custom
renderer may update its DOM during `project` and return no scene, then post
bounded status and selection messages using the same protocol. Host-owned
controls, keyboard access, readable labels, reduced motion, and teardown remain
custom-renderer responsibilities.

## Declare neutral analysis profiles

The C4 package above declares `analysis.request`,
`decisionProfiles: ["profiles/c4.json"]`, and the profile file's SHA-256 in
`assets`. Each file contains one profile. The SDK's `DecisionQuestion` and
`DecisionProfile` types describe the same validated fields.

Question kinds are `boolean`, `choice`, and `score` (0–1). Limits are 8 profiles,
16 questions/profile, 400 characters/question, 2–16 choice options of at most
80 characters, and 256 candidate IDs. Selectors may name only `entities`,
`relations`, and `interpretations`; an empty candidate list requests a bounded
host-selected scope. Source/path/URL fields, thresholds, and executable
callbacks are not part of the schema.

Questions may declare `interpretationKind` as `application`, `container`,
`component`, `system`, `external_system`, `actor`, `person`, `context`, or
`datastore`. A choice question may instead declare `selected-choice`, but
every option must then be one of those exact lowercase kinds or `unknown`.
Arbitrary choice labels cannot select a semantic kind. Without this field,
answers retain the generic `analysis-boolean`, `analysis-choice`, or
`analysis-score` kind and never implicitly create C4 boundaries.

For a fixed mapping, an independently answerable question can be:

```json
{
  "id": "application-supported",
  "kind": "boolean",
  "question": "Does the supplied current metadata support the selected entities as one application boundary?",
  "interpretationKind": "application",
  "interpretationLabel": "Order processing"
}
```

`interpretationLabel` is optional, requires an interpretation mapping, and is
limited to 80 characters with no markup, controls, or URLs. Core also applies
its local secret and locator filters. If omitted, the broker uses the first
selected entity's filtered core label. An explicit label can describe a
selection containing several entities. The label never determines the kind
and is never treated as provider evidence.

Only a supported, accepted answer with exact current source references can
receive a semantic kind. Missing probabilities/confidence, insufficient
support, or selecting `unknown` records a generic unknown interpretation.
Contradicted answers also keep their generic kind. Fixed mappings express
the author's intended meaning; they cannot override core thresholds or grant
authority. Mapping or label changes alter the hashed bundle and require fresh
approval. Score descriptors remain neutral 0–1 questions; the broker maps them
to `['Low', 'High']` independently of these output semantics.

`getAssets()` returns validated profiles with namespace
`<extension-id>.<profile-id>`. Installation validates their structure and
integrity; it cannot establish the truth or neutrality of natural-language
questions. The parent decision broker separately approves profile activation,
checks the current project/digest/profile grant, restricts candidate IDs to the
delivered scope, and applies source consent and local filtering before any
provider request. It records namespaced interpretations. Projection, view
switching, and replay never implicitly activate analysis.

## Parent integration contract

Initialize `await createExtensionRegistry({ dataDir, projectId })` outside the
synchronous hook path. Methods are asynchronous: `list`, `install`, `remove`,
`grant`, `revoke`, `getGrant`, `getAssets`, `doctor`, and `dev`.

Tests inject `transport(spec, { directory, signal })`, which returns tarball
bytes or a tarball path inside that private temporary directory. Production uses
the bounded npm pack transport. Injected transport is trusted host code and
does not become an extension manifest capability.

Pinned host routes:

```text
GET  /api/extensions
POST /api/extensions/grant
POST /api/extensions/revoke
POST /api/extensions/analysis
GET  /api/extensions/data/<id>
GET  /api/extensions/frame/<id>?nonce=<fresh>
```

The parent owns all authentication, strict route/query parsing, the frame host
UI, grant prompts, selection/inspection, and live/replay subscriptions. Extension
frames are not authenticated API principals and receive no viewer credentials.

`runtime/daemon/extension-api.mjs` provides
`createExtensionAPI({ registry, getSnapshot, projectId, runAnalysis? })`, returning
`{ handle }`. Call `await handle(req, res, { viewerAuthorized })` after the
parent's existing Host/Origin and viewer-cookie checks, before a legacy
blanket rejection of query strings. It returns `true` for handled extension
routes and `false` for unrelated routes. External read bearer tokens and opaque
origins must never satisfy `viewerAuthorized`.

`getSnapshot({ scopeId?, sessionId?, checkpointId?, persistent: false })` must
return the current-policy snapshot synchronously, just as the model API does.
The helper accepts only `scope`, `session`, and `checkpoint` on data routes
and `nonce` on frame routes. Duplicate, empty, unknown, or malformed parameters
are rejected. It tags requested checkpoints as replay before applying the
grant. It applies every frame response header and removes an inherited
`X-Frame-Options: DENY` only when delivering a valid authorized frame document.

The grant body is `{ id, digest, fields, history, approved, profiles? }`;
revocation takes `{ id }`. The analysis body is
`{ id, digest, profileId, entityIds, revision }`. Analysis requires the current
profile/field grant, a declared profile, current revision, and candidates in
the granted projection and the profile's candidate selector. It accepts no
caller-supplied questions, paths, source, or URLs.

The injected `runAnalysis` callback receives
`{ projectId, extensionId, digest, profile, entityIds, revision, grant, signal }`.
It returns `{ status, requestId?, interpretationIds? }`, where status is
`accepted`, `pending`, `complete`, or `unavailable`. The HTTP response includes
only those fields, and only interpretation IDs already recorded under the
profile namespace and visible through the current grant. The helper rechecks
grants after asynchronous asset/provider operations and sends no stale result
after revocation. Provider errors become fixed public errors. The callback
still owns source consent, local filtering, evidence version checks, provider
budgets, interpretation recording, and shared-job ownership.

Construct a frame response with:

```js
const installed = await registry.getAssets(extensionId);
const { body, headers } = createFrameDocument({ ...installed, nonce });
// Send every returned header and body; never serve body alone or as srcdoc.
```

`getAssets(id)` returns `{ manifest, assets, digest, profiles, development }`.
An optional `{ digest }` checks a pinned current digest. Optional
`{ assetPath }` returns `{ bytes, contentType, digest, assetPath }` only for
that exact installed, hash-verified declared file. Never fall through to a
filesystem/static-server path. A missing install or mismatched digest fails.

`createFrameDocument` returns a response-level CSP containing
`sandbox allow-scripts`, no network sources, no forms, workers, child frames,
CSS, media, or evaluated code, and SHA-256 allowances for the exact trusted
prelude and bundled script. It sets no-store, no-referrer, and nosniff.
The frame must also use `sandbox="allow-scripts"` without `allow-same-origin`.
Its document remains sandboxed when opened directly.

Bootstrap uses a fresh unpredictable base64url nonce of 24–128 characters:

1. Bind the installed digest, approved grant, instance, and nonce to this frame
   document. The host must await its initial load.
2. The host creates a `MessageChannel` and posts
   `{ type: "graphlin:bootstrap", apiVersion: 1, nonce }` with exactly one port
   to the expected frame window. An opaque-origin target requires `"*"`;
   that does not authorize a different window.
3. The prelude accepts only `event.source === parent`, the matching nonce,
   one port, and its first bootstrap. It emits `graphlin:connect` with the port,
   nonce, API version, and inert JSON assets, then sends
   `{ type: "graphlin:ready", apiVersion: 1, nonce }` on the port.
4. The host checks the ready nonce and current grant/digest before sending
   projected model data. Each subsequent message is context-bound and bounded.
5. On navigation, replacement, disposal, revocation, policy tightening, or
   digest change, close old ports, cancel frame-owned work, clear revoked
   scenes/caches, and bootstrap a new document only after approval. Shared
   decision jobs retain their other authorized owners.

A sandboxed extension still reads the data the user grants it. CSP and opaque
origins are not a universal zero-disclosure guarantee, including frame
self-navigation. Revocation stops future delivery and clears host-controlled
copies; it cannot recall copied data. Iframes also do not guarantee hard CPU
or memory isolation. The parent browser integration must test actual browser
behavior, navigation replacement, direct opening, timeouts, and recovery before
enabling custom renderers.

## Offline conformance checks

From the Graphlin checkout:

```sh
npm test -- tests/extensions/*.test.mjs
npm run build
npm run check:packages
```

The tests use original synthetic C4 data and injected registry transport. They
cover unknown features/capabilities, integrity, install rollback, cancellation,
unsafe paths/links/tar entries, digest-scoped grants, revocation, history,
allowlisted nested projection, scene mappings and bounds, nonce bootstrap,
custom status/selection, and SDK cancellation. They use no keys, live decision
provider, or private project. Browser isolation and npm-installed end-to-end
selection remain parent integration gates.
