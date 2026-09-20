# Provider-independent decisions

The daemon owns one decision service. A provider supplies bounded answers, never
bundles, graph mutations, source access, consent, evidence freshness, or grants.
`runtime/decisions/` has no dependency on `runtime/jev/`. Jev's adapter owns HTTP,
endpoint restrictions, credentials, model validation, wire types, and response
parsing. Alternate providers require none of those vendor conventions.

## Integration factories

```js
import { createDecisionService } from '../runtime/decisions/index.mjs';
import { createJevProvider } from '../runtime/jev/provider.mjs';

const decisions = createDecisionService({
  provider: createJevProvider({ apiKey, fetchImpl }), // Replace this adapter only.
  // Existing: materializeBundle, buildRelationProposals, clock, limits,
  // intakePolicy, admissionPolicy.
  // Optional: profiles: [], cache: { maxEntries: 512, maxBytes: 8388608, ttlMs: 60000 }.
});
```

`createJevProvider({ apiKey, model = 'jev-1.13.0',
fetchImpl = globalThis.fetch, endpoint })` uses the existing production
endpoint by default. Endpoint overrides are restricted to injected loopback
test transports. Its provenance is
`{ id: 'jev', version: '1', model: 'jev-1.13.0' }`; the selected model is
reported if overridden. Mode is `live`, or `demo` for the existing branded
fixture transport. Missing credentials return `unavailable / missing_key`.
An injected alternate provider needs no Jev model, URL, key, or environment
variable. Model provenance is optional for alternate providers.

The old `runtime/jev/index.mjs` exports remain available:
`createDecisionService({ apiKey, fetchImpl, model, endpoint, ...coreOptions })`
explicitly selects Jev. It also exports `createJevProvider`,
`createFixtureTransport`, and the existing limit/policy constants. Jev's
question-builder and wire-validator exports remain compatible. No factory reads
environment keys.

The unchanged pipeline accepts this service through its existing
`decisionService` option. `classify({ event, candidates, policy, deadlineAt,
signal })`, `stats()`, and `close()` retain their existing contracts.

## Broker evaluation API and SDK descriptors

`evaluate(input)` and `decide(input)` are aliases. These are trusted daemon
interfaces, not extension message handlers. The broker first validates the
installed profile, grant, consent, replay state, metadata projection, and
ownership. It supplies only approved model metadata and identifiers/relations.
Do not pass extension-provided state, prompts, paths, URLs, or raw source here.
No render mount, replay, layout, or view switch should implicitly invoke them.

```js
const result = await decisions.evaluate({
  state: {
    entities: [{ id: 'entity-1', kind: 'module' }],
    relations: [],
  },
  questions: [
    {
      id: 'boundary', kind: 'choice',
      question: 'Which supplied boundary describes `entities[0]`?',
      options: [
        { id: 'component', label: 'A supported component boundary' },
        { id: 'unknown', label: 'Insufficient boundary evidence' },
      ],
      requiredMetrics: ['probabilities', 'confidence'],
    },
    { id: 'supported', kind: 'boolean', question: 'Is this boundary supported?',
      requiredMetrics: ['probability'] },
    { id: 'relevance', kind: 'score', question: 'Rate relevance to the supplied scope.',
      options: ['Low', 'Medium', 'High'] },
  ],
  profile: { id: 'example.boundaries', version: '1' }, // Optional.
  cacheContext: { // Optional; all six fields required when provided.
    projectId: 'project-1', worktreeId: 'worktree-1', lineage: 'branch-generation-1',
    policyVersion: 'policy-1', evidenceVersion: 'metadata-revision-7', taskScope: null,
  },
  signal, deadlineAt,
});
```

Question fields:

| Field | Contract |
| --- | --- |
| `id` | Unique bounded identifier |
| `kind` | `boolean`, `choice`, or `score` |
| `question` | Host-validated question text, up to 8192 characters |
| `focus` | Optional additional instruction, up to 8192 characters |
| `options` | Omitted for boolean; choice has 2–128 distinct `{id,label}` entries; score has 2–128 ordered string labels |
| `requiredMetrics` | Optional array: boolean supports `probability`; choice/score support `probabilities` and `confidence` |

Score values use zero-based option indices. A probabilistic score must equal
its distribution's weighted index, within the existing rounding tolerance.
Questions in one request are independent; they cannot consume another answer
from that request. Dependent stages require an explicit subsequent broker call
within the broker's overall workflow budget.

Every result has this shape:

```js
{
  status: 'accepted', // Or abstained, invalid, unavailable, timeout, overloaded.
  answers: [{
    id: 'boundary', kind: 'choice', value: 'component',
    probability: null,
    probabilities: { component: 0.94, unknown: 0.06 },
    confidence: 0.95,
  }],
  provenance: {
    contractVersion: 1,
    provider: { id: 'provider-id', version: '1' }, // Optional model if supplied.
    profile: { id: 'example.boundaries', version: '1' }, // Or null.
    cacheContext: { /* the exact supplied version context, or null */ },
    inputHash: 'sha256-of-exact-provider-encoded-input',
    completedAt: 1234,
    usage: { inputTokens: 10, outputTokens: 5 }, // Or null.
    mode: 'local', // live, demo, or local.
    cacheKey: 'sha256-of-versioned-request-context', // Or null.
  },
  diagnostics: {
    code: 'ok', calls: 1,
    cache: { status: 'miss', key: 'sha256-of-versioned-request-context' },
    // Existing bounded timing, question counts, usage and trace metadata.
  },
}
```

Boolean `value` is a supplied boolean or null; `probability` is the probability
that the proposition is true. Neither is inferred from the other. Choice
`value` is an option ID; score `value` is the numeric score. All unavailable
metrics are null, including irrelevant metric fields. Never interpret missing
confidence or a deterministic selection as probability 1. A provider can
return an answer without probabilities only when the question does not require
them. Missing required metrics yield `abstained / missing_answer_metrics`;
unsupported declared capabilities yield `abstained / unsupported_capability`
with `diagnostics.capabilityLimitations`. Invalid results have no answers.

`accepted` means the bounded answer contract passed. Core still decides whether
the answer supports an interpretation, a graph change, or no change. This does
not establish execution, verification, or authoritative architectural truth.
Provider-added text, explanations, bundles, judgments, and arbitrary usage
fields are discarded.

The metadata API rejects non-JSON values, cycles, excessive depth/size, and
obvious source/credential fields such as `code`, `text`, `snippet`, `transcript`,
`prompt`, and `apiKey`. This guard is not a substitute for broker authorization
or core's local secret filtering; approved metadata must not hide raw content
under another field name. No raw metadata state is retained in completed cache
entries or diagnostics.

## Extension analysis broker

```js
import { createAnalysisBroker } from '../runtime/decisions/broker.mjs';

const runAnalysis = createAnalysisBroker({
  service: decisions,
  model: pipeline.model,
  policy, // A policy object, or () => currentPolicy for a changing policy.
  projectId,
  registry,
});

const result = await runAnalysis({
  projectId, extensionId, digest,
  profile, // Installed declarative profile from runtime/extensions/profiles.mjs.
  entityIds, // Nonempty unique canonical model IDs.
  revision, // Current live model revision.
  grant, // Grant snapshot already checked by the HTTP helper.
  signal,
});
// { status: 'complete', requestId, interpretationIds }
// or { status: 'unavailable' }
```

These are the exact five factory options. `service` supplies `evaluate`;
`model` supplies synchronous `snapshot()` and `observeInterpretations()`.
`registry` supplies async `getAssets(extensionId, { digest })` and
`getGrant(extensionId)`. Use the same policy and project model as the pipeline.
The factory returns the async function directly, with no extra object wrapper,
queue, cache, source reader, or transport.

The parent HTTP helper authenticates explicit POST requests with exactly
`{id,digest,profileId,entityIds,revision}` and resolves the current installed
profile and grant before this callback. It must never accept extension-supplied
state or raw source. It owns response notification after the callback. Mounting,
rendering, viewing, switching layouts, and replay never invoke analysis.

The broker independently checks `analysis.request`, the immutable package
digest and installed profile, approved profile/field/entity scope, current
grant equality, and `transmitSource`. Read-only source consent is insufficient.
It rejects replay/checkpoint snapshots. It repeats authority, policy,
revision, metadata, and exact-reference checks after evaluation before core
admission; it checks authority and resulting current records again before
returning IDs. Revocation, stale evidence, malformed responses, cancellation,
or exceeded bounds produce only `unavailable`.

Profile questions are `{id,kind,question,options?,interpretationKind?,
interpretationLabel?}`. Choice options are strings,
mapped to neutral `{id: 'option-N', label}` entries. Extension scores have no
options and a 0–1 range; the broker supplies neutral `['Low','High']` criteria.
No taxonomy, provider name, model, key, endpoint, or vendor wire type is part of
the extension profile schema. Questions remain independent.

Only selected, current, locally filtered model metadata is sent. Entity fields
are `id/kind/label/basis/parentId`; relation fields are
`id/source/target/kind/basis`. Optional interpretation context contains bounded
IDs, namespace/version, kind, safe label, entity IDs, and support. Relationships
and interpretations cannot escape the selected entity scope. Paths,
qualified names, source references, raw source, and arbitrary extra fields
are omitted from transmission. Unsafe labels are replaced locally and make
support unknown. Profile text is locally secret-filtered before dispatch.

The exported `ANALYSIS_LIMITS` are 256 entities, 128 relations, 64 context
interpretations, 16 exact source references, 16 questions, and 32 KiB metadata.
The service's lower configured limits also apply. Oversized requests fail
closed, without implicit batching or truncation. Nonempty references require
a current, fresh, present artifact with exactly matching hash/generation and a
known, safe, nonexcluded relative path; that path stays local. Public intent
references cannot support analysis. Entities without references can receive
only unknown interpretations.

Evaluation provenance uses profile `{id: extensionId + '.' + profile.id,
version: digest}`. The cache context binds project/worktree to the canonical
project ID and lineage to `snapshot.coverage.lineage.id ?? projectId`. Policy
version binds the effective policy plus the exact grant; evidence version binds
revision plus the metadata/reference/lineage hash; task scope binds
extension/profile/digest. A changed opaque lineage ID rejects an in-flight
result even if source and revision are otherwise identical. Branch names and
HEAD values are never sent to the provider; the opaque lineage ID stays in
local cache provenance. The parent also invalidates/cancels work when replacing
the project model.

Profile `interpretationKind` may explicitly name `application`, `container`,
`component`, `system`, `external_system`, `actor`, `person`, `context`, or
`datastore`. `selected-choice` is allowed only for choice questions whose
options are those exact kinds or `unknown`. Only supported, accepted answers
with nonempty current references receive the declared kind. The broker derives
it from the validated declaration and selected option ID, never from answer
text or an arbitrary label. All other records keep their generic analysis kind.
Without a declaration, choosing the string `application` cannot create a C4
boundary; the default view remains unknown.

An optional `interpretationLabel` requires a mapping and is limited to 80
locally filtered characters. Otherwise the boundary uses the first selected
entity's filtered core label. The label and mapping stay out of provider
question descriptors; their installed digest binds them into grant and cache
provenance. They do not change provider capabilities or wire contracts.

Interpretations use namespace `extensionId + '.' + profile.id`, version
`digest`, basis `decision`, and exact current references retained locally.
The combined namespace must fit the model's 80-character limit. Missing
probabilities or required confidence always produce `support: 'unknown'` and
`classification: 'unknown'`, even if a deterministic provider selected a value.
Probability thresholds reuse core admission defaults. Incomplete metadata
support also remains unknown. These records do not establish runtime success.

The broker reads back model-assigned IDs and returns only records that match
this request, namespace, version, references, and current validity. It respects
the core display-label projection. Capacity rejection cannot fabricate IDs;
partial retention returns only the IDs actually retained. Results expose no
provider response fields, grants, prompts, or metadata. The wider HTTP callback
contract also permits `accepted` and `pending`; this synchronous admission
broker currently returns only `complete` or `unavailable`.

## Scheduling, cache, cancellation, and freshness

All entry points share one concurrency limit, pending queue, cooldown, request
and response byte limits, question limits, and deadline clock. Source work
reserves two calls; a broker evaluation reserves one. Defaults remain two active
workflows, 32 queued workflows, 2000 ms, 40 questions per request, 64 KiB request,
and 256 KiB response. Requests do not retry. Adapter serialization is synchronous
and side-effect-free; transport and response-body work must honor the shared
abort signal. The service also bounds providers that ignore it.
Queued broker evaluations yield to queued source/intake work.

Evaluation caching requires all six `cacheContext` fields. They are bounded
opaque identifiers or nonnegative integer versions; `taskScope` may be null.
The broker must bind `evidenceVersion` to every supplied record/reference and
`lineage` to the selected worktree/branch. Exact metadata, questions, options,
required metrics, profile ID/version, provider ID/version/model/mode and
capabilities also enter the key. Different taxonomy options therefore cannot
reuse the same result. No context means no cache.

Only successful normalized evaluation results are cached. Defaults are 512
entries, 8 MiB total serialized results, and 60 seconds, with LRU eviction.
Set any cache bound to zero to disable caching and coalescing. Cache entries
contain answers and provenance, not source, state, or approved bundle objects.
Source `classify` and `analyze` never reuse serialized approval capabilities.
The parent may retain their original branded bundles under its own bounded
admission lifecycle.

Concurrent equivalent evaluations share one queued/active workflow. Each
subscriber has its own cancellation and deadline; losing one subscriber does
not cancel another. The underlying work stops when no subscribers remain.
The first workflow's service deadline cannot be extended by later subscribers.
Subscriber count is bounded by concurrency plus queue capacity. Stats expose
cache hits, shared hits, evictions, entries/bytes, and active subscribers.

`invalidateCache()` clears retained evaluations and aborts shared evaluations
as `stale_evidence`; use it on revocation or scope invalidation, together with
the broker's owner cancellation. It invalidates the whole service cache.
Every consumer must still revalidate policy, lineage, evidence versions, task
scope, and grant before applying either a fresh or cached result. Noncached
calls are cancelled through their supplied signal. `close()` cancels all work
and clears cached results. A cache hit reports zero new calls/usage; provenance
retains the original provider usage and completion time.

## Source A/B and registered source profiles

`classify` keeps the existing neutral architecture catalog: immutable candidate
snapshots, shared evidence sensitivity, per-entity relevance, core
`materializeBundle`, exact approved B evidence, independent relation/context
questions, and unchanged admission thresholds. The returned bundle is the
exact branded core object. Providers never receive core functions, candidates'
private IDs/digests, or the bundle capability. Source evidence and public intent
stay distinct. The unchanged pipeline performs final version revalidation.

Optional host `profiles` registrations support source-backed analysis through
`analyze({ ...classifyInput, profileId })`. Each registration has
`{ id, version, scope: 'entity' | 'bundle', questions }`; `questions` is an object
keyed by question ID, containing neutral
`{ type, instructions: { question, focus? }, criteria, requiredMetrics? }`.
Boolean criteria have `true`/`false` descriptions, choice criteria map option
IDs to descriptions, and score criteria are ordered string labels.
Entity instructions use `{{entity}}` and `{{evidence}}` placeholders, expanded
to exact approved array paths. The registry is a trusted host operation, not
an extension callback.

This path always runs A first and uses only the exact core bundle for its B
questions. It returns `abstained / profile_answers` plus
`analysis: { profileId, profileVersion, status: 'answered', answers, subjects }`
and no graph judgments. `subjects` maps question IDs to local approved candidate
IDs (null for bundle questions); core owns interpretation admission. Budgets
can reject a large profile rather than adding hidden stages or weakening intake.
The low-level array descriptor API above is the broker/SDK integration seam;
these source registrations are an additional internal A/B facility.

## Adapter contract v1

A provider supplies:

```js
{
  contractVersion: 1, id: 'example', version: '1', mode: 'local',
  // model is optional opaque provenance, not a required vendor name.
  capabilities: {
    boolean: { probability: true },
    choice: { probabilities: true, confidence: true },
    score: { probabilities: true, confidence: true },
  },
  unavailableCode: null, // Or provider_unavailable; Jev compatibility uses missing_key.
  encode(request) { return JSON.stringify(request); },
  async execute(encoded, { signal, deadlineAt, maxResponseBytes, now, reportTransport }) {
    // Return { answers: { questionId: normalizedAnswer }, usage: null | counts }.
  },
}
```

Absent capability types are unsupported; omitted/false metric flags mean the
provider cannot supply that metric. The service exposes its immutable snapshot
as `service.capabilities`. Internal request descriptors use the neutral
`type/instructions/criteria/requiredMetrics` shape described above; adapters
receive frozen projections. `encode` returns the exact outbound string, which
core measures and hashes before dispatch. `execute` must use that string and
make at most one bounded provider request. Credentials remain in the adapter's
closure, not encoded requests, provenance, capabilities, or diagnostics.

Internal boolean answers are `{ type:'boolean', value?, probability? }`;
choice answers are `{ type:'choice', choice, probabilities?, confidence? }`;
score answers are `{ type:'score', score, probabilities?, confidence? }`.
Usage is optional `{ inputTokens, outputTokens }`. The service validates IDs,
types, option coverage, finite metrics, distributions, winners, score
consistency, and usage; Jev also retains its stricter wire validation.

Adapters may throw `DecisionFault(code, status, { retryAfterMs })`; overload
delays are clamped by core. Unknown fault strings are sanitized. Optional
`reportTransport({httpStatus})` supports legacy diagnostics; non-HTTP providers
need not call it. Providers are trusted daemon code, not sandboxed extensions.

## Packaging and verification

The parent owns pipeline/server integration and package allowlists. Include all
`runtime/decisions/*.mjs` files and `runtime/jev/provider.mjs` in the root package
file list and generated host packages. No version bump or release is made here.

Run `npm test -- tests/decisions/*.test.mjs tests/jev/*.test.mjs` plus the
pipeline/runtime integration tests. The unchanged Jev wire fixtures pin exact
requests and rubrics. Deterministic provider tests exercise the same caller,
pipeline, profiles, filtering, branded materialization, deadlines, stale
rejection, capabilities, and cache behavior without credentials or live calls.
