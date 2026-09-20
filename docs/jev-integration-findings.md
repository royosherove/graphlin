# Jev integration: live findings and context design

19 September 2026. This record separates offline contract checks from live
classification evidence.

The current baseline is `intake-v3` / `architecture-v6`. Its final combined
synthetic run recorded **46 passes, one strict negative-context failure, and one
timeout across 48 decisions / 96 requests**. All 20 kind decisions passed. The
failed mock case produced no accepted or compiled write. Earlier runs below
remain historical evidence; the expanded-kind results are recorded separately.

## Initial live evidence

The first two live requests used the same synthetic PostgreSQL write snippet.
Both returned HTTP 200 from `jev-1.13.0`. They took approximately 1.33 and
1.20 seconds end to end for intake. Neither reached the architecture stage:
the intake gate approved no candidates.

The second request produced relevance probabilities of 0.10–0.30 and
sensitivity probabilities of 0.11–0.18 across eight candidates. The initial
thresholds require relevance >= 0.5 and sensitivity <= 0.1. The empty bundle
was therefore the specified conservative behavior, not a transport failure.

These observations do not establish general model accuracy. They expose an
integration assumption that requires better input design and further testing.

## Documentation checked

Fresh official pages were retrieved during implementation and compared with
the repository's research material:

- [State](https://docs.typesafe.ai/concepts/state.md): named, related context in one
  object; content and supporting facts belong in state.
- [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md):
  narrowly scoped context, direct backticked dot-and-index paths, atomic
  questions, structured guidance, independent questions in one request.
- [Advanced structure](https://docs.typesafe.ai/primitives/advanced.md): named
  instruction fields and explicit boundary descriptions/examples.
- [Pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md):
  local candidate enumeration, bounded semantic selection, exact local copying.
- [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md):
  questions share state but cannot consume each other's hidden results.
- [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md):
  literal interpretation, indirection, irrelevant context, adversarial text,
  and independently answered propositions require deliberate handling.

The official live endpoints are those pages' counterparts at
`https://docs.typesafe.ai/`, with the same paths and `.md` suffix.

## Changes motivated by the documentation

The original wire request duplicated the same snippet for eight entity
candidates and asked questions by looking up long opaque IDs. Its broad
terms, such as architectural evidence and sensitive content, left important
boundaries implicit.

The revised wire design gives each unique snippet one position in an
`evidence` array, gives candidate entities direct array positions, and
constructs question paths in code. For example, a question can name
`entities[0].name` and `evidence[0].code` directly. Private stable IDs and
source-version checks remain local.

Sensitivity is evaluated once for a shared evidence span and applied to its
entity candidates in code. Definitions distinguish actual secret values or
private personal data from variable names and environment-key references.
This does not relax the local privacy filter or the numerical thresholds.

Relevance and role criteria explicitly include source-level functions,
classes, modules, and bindings. Relationship questions name exact endpoints,
the requested operation, and the relevant code. Missing implementations still
prevent an unqualified claim.

Candidate discovery removes incidental lexical noise, such as SQL keywords
inside strings and environment-variable property names. Generic syntax can
prioritize an enclosing function and its called receiver without deciding
whether a particular library performs a database write; that decision remains
with Jev.

Both stages remain separate requests. The architecture stage only sees the
approved bundle materialized after intake. Historical context, cached graphs,
and unapproved candidate labels cannot bypass that boundary.

## Observed effect of the revised state

The first revised PostgreSQL write intake used five questions instead of
17 and 4,554 request bytes instead of 15,185. It supplied three meaningful
entities: `saveNote`, `db`, and `Pool`. Sensitivity was 0.05; relevance was
0.92–0.98. All three passed intake without changing its thresholds.

Architecture v2 returned write support 0.93 and missing-context probability
0.32, leaving the edge tentative. Reviewing that question exposed an overly
broad definition of context. Architecture v3 defines the function's operation
when invoked: a known driver binding and visible operation suffice; actual
credentials, upstream callers, and live connection success are unnecessary.
Unresolved local wrappers and unknown SQL remain genuine missing context.
Each relationship also has an explicit definition, so a database query does
not imply message consumption.

## Earlier strict write smoke evaluation (architecture-v3)

The earlier production-deadline run used 14 synthetic cases, each repeated twice
in one process: **56 API requests, 26 passing scenarios, one failed positive
expectation, and one timeout/inconclusive scenario**. Model: `jev-1.13.0`.
Rubrics: `intake-v2` and `architecture-v3`.

The harness checks that the exact intended source→target proposition and its
context question were actually dispatched. Positive cases require a compiled
accepted write with accepted endpoints and expected roles. Known negatives
require low write support, resolved context, and no rendered write. Uncertain
cases require the context veto as well as no accepted write. A missing
candidate, proposal, answer, or valid B decision is inconclusive.

| Synthetic case | Two runs | Write support | Missing context |
|---|---|---|---|
| PostgreSQL INSERT | Timeout; pass | 0.90 when completed | 0.05 |
| PostgreSQL SELECT | Both pass | 0.03 | 0.07 |
| Client configuration only | Both pass | 0.03 | 0.08–0.09 |
| Visible mock receiving INSERT | Both pass | 0.35–0.37 | 0.08 |
| Unresolved `repository.save` | Both pass; tentative | 0.81 | 0.78–0.80 |
| Hostile comment above SELECT | Both pass | 0.03 | 0.06 |
| PostgreSQL UPDATE | Both pass | 0.92 | 0.04–0.05 |
| PostgreSQL DELETE | Both pass | 0.94 | 0.04 |
| Unknown SQL argument | Both pass; uncertain | 0.15–0.18 | 0.70 |
| Unused INSERT string plus SELECT | Both pass | 0.04 | 0.08–0.09 |
| Query object containing INSERT | Both pass | 0.91 | 0.04 |
| CommonJS INSERT | Pass; tentative (failed positive expectation) | 0.87; 0.84 | 0.05; 0.04 |
| TypeScript import alias plus INSERT | Both pass | 0.92–0.93 | 0.05 |
| Template/constant SELECT | Both pass | 0.03 | 0.07 |

The CommonJS repeat had accepted endpoints and sufficient context, but its
0.84 support fell below the 0.85 acceptance threshold. It stayed visible as
tentative. This is retained as a failed positive expectation; the threshold
was not lowered.

Completed two-stage decisions ranged from **861 to 1,548 ms**, with median
**938 ms** and sample p95 **1,530 ms**. The cold first request exceeded the
production **2,000 ms** event deadline. This is not a 500 ms end-to-end system
under the measured conditions.

The run reported 194,222 input tokens and 18,634 output tokens. Usage for the
timed-out request is incomplete, so these are observed totals rather than a
complete billing statement.

A separate diagnostic run allowed 3,000 ms and repeated INSERT twice.
Both passed: **2,128 ms cold**, then **1,272 ms**. That explains the cold-start
deadline miss but does not establish production performance or change the
runtime's two-second policy.

Before the expanded-kind evaluation, initial probes, request redesign,
intermediate matrices, the strict matrix, and the diagnostic run recorded
**138 live requests**. Only
generated synthetic snippets were sent. Requests were explicit measurements,
not automatic production retries. The local reports remain Git-ignored.

Reproduce the strict matrix:

```sh
node scripts/evaluate-jev.mjs --repeat 2
```

Diagnostic deadline comparison:

```sh
node scripts/evaluate-jev.mjs --case postgres-write --repeat 2 --deadline-ms 3000
```

## Expanded kinds and final architecture-v6 evaluation

Each run below used `jev-1.13.0`, `intake-v3`, two repeats per synthetic case,
and the production 2000 ms event deadline. Counts are harness outcomes for
individual decisions, not accuracy estimates. The v6 combined suite contains
14 write cases and ten kind cases; its denominator differs from v4/v5.

| B rubric | Suite | Decisions | Pass | Fail | Timeout / inconclusive | API requests |
|---|---|---:|---:|---:|---:|---:|
| `architecture-v4` | Kinds | 20 | 12 | 8 | 0 | 40 |
| `architecture-v5` | Kinds | 20 | 17 | 2 | 1 | 40 |
| `architecture-v6` | All | 48 | 46 | 1 | 1 | 96 |

Raw live reports remain local and Git-ignored. The numeric replay fixtures
below preserve the relevant synthetic failures without sharing machine data.

The v4 failures concerned configuration/constructed-client separation,
namespace aliases, named-member aliases, and ordinary data. In v5 only the
named-member alias remained a semantic failure: the imported constructor
`Store` was classified as datastore at probability 0.79 (tentative) and 0.80
(accepted), both with entity support 0.96. The separate v5 function timeout had
no B judgment. Numeric [v4](../tests/jev/fixtures/kind-failures-v4.mjs) and
[v5](../tests/jev/fixtures/kind-failures-v5.mjs) replay fixtures preserve those
failures under the unchanged gates; replay is not a fresh model measurement.

V6 applies declaration and import rules before other binding kinds. A bare
named constructor import is module; a separately instantiated database-driver
receiver can be datastore. All **20/20 kind decisions** passed in the final run,
including both `Store` aliases as module, with selected probability and
confidence 1. The **28 write decisions** had 26 passes, one failure, and one
timeout. The rubric was refined against these same examples, so this is
development feedback rather than an independent validation set.

The sole v6 failure was `mock-write` repeat 1. Its exact `saveNote → db` write
proposition was asked. Both endpoints had accepted expected kinds (function
and module); write support was **0.20**, missing context **0.11**. Only
`contextResolved` failed the known-negative expectation of <=0.10. The raw
relation judgment remained tentative, and core omitted it because support was
below its 0.50 display floor. **No write was accepted or compiled into the
graph.** `Decision.status: accepted` describes the accepted nodes and must not
be interpreted as accepting every relation. Repeat 2 passed at support 0.19
and missing context 0.10, also with no compiled write. This boundary variation
is retained as a limitation; neither the expectation nor threshold was relaxed.

The first PostgreSQL write timed out after 2004 ms as measured by the runner
(diagnostics: 2002 ms; A: 1359 ms, B: 642 ms). It had no valid B decision or
compiled write. The 47 completed decisions took 877–1647 ms, with sample median
928 ms. Reported usage totaled 279,394 input and 28,946 output tokens; one
timed-out stage lacks validated usage, so these are incomplete observed totals.
The shared deadline remains 2000 ms.

The v6 offline capacity check dispatches 12 distinct 1800-character ASCII spans,
each 24 lines. A has 25 questions / 42,799 bytes; B retains all 12 entities and
seven proposals with **39 questions / 61,438 bytes**, below the unchanged
65,536-byte cap. This does not guarantee every UTF-8 input fits, estimate model
tokens, or establish live latency at maximum capacity. Oversized bodies still
fail explicitly. Thresholds and case expectations remain fixed; no further
rubric tuning is planned for this baseline.

## Limits and next measurements

These examples are a smoke evaluation, not a calibrated accuracy benchmark.
The same model inputs can produce different probabilities, including values
on either side of a threshold. Broader languages, real multi-file projects,
mixed database/message operations, adversarial source, and incomplete
captures need representative evaluation.

The bounded proposal generator omits alternatives beyond its question budget;
the reports retain those counts. Unasked relations do not establish absence.
The source classifier cannot establish runtime connectivity or persistence.
Cold-start handling and context enrichment remain opportunities for the next
slice. See the [pattern review](jev-patterns.md) for routing experiments that
preserve the current baseline.
