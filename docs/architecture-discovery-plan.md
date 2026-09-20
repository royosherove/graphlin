# Automatic architecture discovery

The C4 renderer in 0.2.0 can display supported interpretations, but ordinary
source discovery does not produce application or component boundaries. This
change connects that missing path.

## Behavior

1. After initial source discovery settles, analyze captured source through the
   configured decision service. Identify supported applications, components,
   and their membership without requiring architecture documents.
2. Offer **Discover architecture** in the C4 view. This requests asynchronous
   analysis of the current project and reports progress or a useful reason when
   analysis is unavailable. Replay remains read-only.
3. When source changes, invalidate its old evidence and refresh affected
   interpretations. Preserve unrelated boundaries. New applications must allow
   previously discovered components to be reconsidered for membership.

Source transmission follows the existing project policy and local filtering.
The existing provider-independent source analysis path performs intake before
semantic questions. Missing support remains unknown; source evidence does not
prove deployment or runtime connectivity.

## Implementation boundaries

- A pure architecture analyzer builds finite decision questions and returns
  versioned interpretations. It does not access files or mutate the model.
- A bounded controller coalesces source observations, captures current evidence,
  runs analysis outside the hook intake sequence, and revalidates evidence
  before acceptance. Unchanged observations do not repeat classification.
- The model can replace affected interpretations atomically, including removing
  a boundary when fresh evidence no longer supports it. History remains frozen.
- The daemon exposes authenticated `GET /api/architecture` and
  `POST /api/architecture/discover`. The latter accepts an empty object and
  returns status immediately.
- The C4 view presents progress, unavailable states, and application/component
  nesting. Stable group identities permit independent expansion.

Source, queue, request, interpretation, and scene limits remain explicit.
Partial coverage must be visible. Background work stops on shutdown and honors
pause, policy, evidence-version, and branch changes.

## Completion evidence

- A generated project with no architecture document acquires supported
  applications, components, and membership through the actual decision service,
  parser, scheduler, and model, without seeding interpretations.
- The resulting C4 scene contains visible nested boundaries.
- The manual button reaches the authenticated endpoint and causes analysis.
- An edit or deletion refreshes affected boundaries and keeps unrelated ones.
- A newly discovered application can acquire previously discovered components.
- Unchanged reconciliation does not repeatedly call the model; late results,
  missing credentials, denied source transmission, and shutdown are handled.
- Browser checks exercise the manual action and rendered nesting.
- Normal CI and package verification pass. Large stress tests remain local
  through `npm run test:stress`.
