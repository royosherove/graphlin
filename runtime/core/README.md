# Graphlin core

`index.mjs` exports the frozen module API. The implementation uses Node.js 22+
built-ins and performs no network requests. JSON schemas live in `../../schemas`;
the runtime also checks relationships between fields, provenance, privacy, and
serialized byte limits that JSON Schema alone does not enforce.

Evidence is scoped to the canonical worktree root. The original root spelling
is accepted as an alias, including macOS `/var` versus `/private/var`. Child
symlinks are all rejected, including links that stay inside the root. The store
retains bounded path/version metadata, not source text. `missing` retracts
support; `unavailable` and `partial` only make it stale. The coordinator must
serialize capture and decision acceptance and call `isCurrent` first.

Candidate discovery supplies lexical identifiers and exact source spans.
Several entities can share a snippet. Declared functions/classes precede local
bindings and imported identifiers. String/comment bodies, dotted property names,
and environment-key lookups do not supply entity names. Original source remains
unchanged for Jev's judgment. Other-language declarations and type-like names
have lexical fallbacks. It does not resolve language scopes,
imports, wrappers, SQL, or ORM semantics. Identical names within one artifact
share an entity key; names in different artifacts remain distinct. Long lines
and candidates beyond the budget are omitted. `complete` describes capture
completeness, not whether a snippet contains sufficient semantic context.

Candidate digests bind source versions, spans, labels, text, and effective
policy. JSON candidate snapshots are supported. Core materializes an immutable
approved bundle and requires that exact bundle object for proposals and
compilation. Rebuilding or cloning a bundle cannot bypass intake. Missing,
invalid, conflicting, or high-sensitivity answers also quarantine overlapping
copied context. Relevance and sensitivity are independent questions.

Public messages use `event.id` as `messageId`, a hash of complete public text,
and `Math.max(1, event.sequence)` as `contentVersion`. Graph references retain
the full discriminated source reference and `basis: "jev_interpretation"`.
Public intent produces proposed claims. Source interpretation produces observed
claims with unknown activity/authorship; generic tool success never verifies
runtime behavior. Compilation conservatively enforces the default admission
floors even if an injected Jev admission policy is looser.

Experimental graph-admission floor v1: both nodes and edges require
`supportProbability >= 0.5` to be drawn. Lower-support judgments are omitted,
including those labeled `tentative` or `accepted`; a filtered node cannot
provide an endpoint for a new edge. At exactly 0.5 a known-role node or grounded
edge can be tentative. Accepted claims still require the existing stricter
support, role, confidence, completeness and context checks. Raw Jev judgments
are unchanged, and intake privacy/relevance thresholds are unchanged. This
admission rule does not retrospectively rewrite persisted graphs.

The role catalog has 12 known kinds plus the non-admitted `unknown` answer.
Core compiles the approved Jev role using these fixed presentation mappings:

| Kind | Shape | Generic label |
| --- | --- | --- |
| client | browser | Client |
| service | component | Service |
| datastore | cylinder | Datastore |
| queue | queue | Queue |
| external | cloud | External |
| module | rect | Module |
| function | hexagon | Function |
| class | class_box | Class |
| interface | interface_box | Interface |
| event | document | Event |
| configuration | parallelogram | Configuration |
| package | folder | Package |

The six legacy shapes remain allowed: `rounded_rect`, `rect`, `cylinder`,
`cloud`, `diamond`, and `group`. With the nine new shapes the allowlist has 15
members. Existing role/shape combinations stay valid on restore and replay;
fresh compilation uses the current mapping without changing entity identity.
Role distributions allow at most `ROLES.length + 1` entries, still validating
every key, finite probability, sum and winner. Classification thresholds and
question counts are unchanged. Lexical selection already recognizes interface
declarations; Jev owns semantic role selection and declaration precedence.
Viewer layout and appearance animations do not mutate core graph coordinates,
revisions, source references or evidence.

Limits: 32 paths per capture; 1,024 tracked paths; 256 KiB per file; 12 candidates;
1,800 characters/24 lines per snippet; seven relation proposals, further reduced
by the question budget; 256 nodes/768 edges; eight references per claim;
256 characters per excerpt. Graph admission stops at 896 KiB serialized UTF-8;
the hard limit is 1 MiB. Invalidation can remove optional excerpts to remain
within the hard limit. Relation omissions are returned explicitly.

Relation selection prioritizes enclosing function-to-call-receiver pairs, then
binding-to-constructor pairs, using only approved bundle text. All six relation
questions for the best pair precede fanout. A constructor pair prioritizes the
`depends_on` question when only one slot remains. These are lexical selection
hints, never semantic truth rules. Calls inside template interpolations and
clipped/unmatched function bodies do not receive enclosing-function hints.

Projection applies display and persistence permissions independently. Policy
changes or unknown approval provenance hide source labels and excerpts.
Restored evidence requires fresh capture and approval; there is no locator
hydration interface. Bounded approval bookkeeping may conservatively redact old
history. Patch replay is idempotent for the last 1,024 patch IDs on an in-process
graph lineage; revision checks reject incompatible replay after serialization.

Run the offline checks from the project root:

```sh
node --test tests/core/*.test.mjs tests/jev/*.test.mjs tests/integration/*.test.mjs
```
