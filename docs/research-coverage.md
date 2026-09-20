# Research coverage

The initial design review read 109 pages indexed by the official TypeSafe
Jev documentation on 19 September 2026. This covered concepts, primitives,
patterns, JavaScript and Python SDK references, demos, model notes, and
cookbooks. Linked external datasets, media, repositories, and full legal
agreements were outside that review. Third-party snapshots are not
redistributed; use the original sources below.

## Primary documentation

- [Introduction and index](https://docs.typesafe.ai/introduction.md)
- [State and context](https://docs.typesafe.ai/concepts/state.md)
- [Building with System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)
- [HTTP API](https://docs.typesafe.ai/api.md)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md)
- [Choice](https://docs.typesafe.ai/primitives/choice.md),
  [Noul](https://docs.typesafe.ai/primitives/noul.md), and
  [Score](https://docs.typesafe.ai/primitives/score.md)
- [Patterns](https://docs.typesafe.ai/patterns.md) and
  [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)
- [Pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md)
- [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md)
- [Model capabilities](https://docs.typesafe.ai/models.md) and
  [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)

Host packaging and hook references appear in the source table in
[the design](graphlin-design.md). [The design review](graphlin-review.md)
records boundary concerns and their resolutions.

## Decisions informed by the review

Use narrow, named context and direct array paths. Deduplicate shared evidence
and ask atomic questions about it. Results of independent questions in one
request are not inputs to one another; the architecture pass therefore follows
local materialization of the intake result.

Choice confidence differs from winning-option probability. Cookbook timing,
cost, and accuracy examples do not establish Graphlin performance. Source-level
classification does not prove runtime connectivity. The implementation's
[synthetic live findings](jev-integration-findings.md) record measured outcomes
and limitations separately from the design.

Model and platform documentation changes independently of this repository.
Recheck the relevant official source before changing wire contracts, supported
host versions, model limits, or release packaging. Do not infer zero retention
for every TypeSafe account from an enterprise offering.
