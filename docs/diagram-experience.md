# Diagram shapes, arrangement, and motion

Implementation contract following the first live-session screenshot. The fixed
grid makes larger diagrams difficult to read, and the broad `module` category
hides useful distinctions between functions, interfaces, and classes.

## Shape vocabulary

Keep existing records valid and expand the finite shape catalog. The
classifier selects one primary display kind; code maps it to a shape.

| Primary kind | Default shape |
|---|---|
| Client | Browser window |
| Service | Component |
| Datastore | Cylinder |
| Queue | Queue |
| External | Cloud |
| Module | Rectangle |
| Function | Hexagon |
| Class | Class box |
| Interface | Interface box |
| Event | Document |
| Configuration | Parallelogram |
| Package | Folder |

The original rectangle, rounded rectangle, cylinder, cloud, diamond, and
group tokens remain valid. Nine additional tokens make 15 shapes available.
Users can override a selected node's shape for presentation without changing
its classification, evidence, or identity.

Named function, class, and interface declarations take those primary kinds.
Other bindings use their supported architectural/data kind. A class named
`UserService` does not prove a running service; a client instantiated from a
known database driver can represent its datastore. Events require explicit
event evidence; ordinary objects remain modules. Packages represent the
module/package namespace, not every imported member.

One primary kind is a display convention rather than a complete ontology.
A class can also implement a service. A separate architectural-role/code-kind
axis may follow; adding another question per candidate now would reduce the
relation questions available within the current budget.

Intake and architecture rubrics change together to admit and distinguish
the new kinds. The request count, question count, and confidence thresholds
remain unchanged. Live synthetic evaluation must check the new distinctions
and probability splitting. Existing historical classifications are preserved.

## Arrangement

Provide a layout selector, an Arrange button, and an Auto-arrange toggle.
Hierarchy is the default for new views.

- **Hierarchy:** directed dependencies from top to bottom.
- **Dependency flow:** directed dependencies from left to right.
- **Group by type:** separate visual groups by primary kind.
- **Circular:** arrange connected work around a circle.
- **Grid:** a compact regular arrangement.
- **Original:** restore the compiler's untouched positions.

Force-directed layout is deferred. The six available algorithms are bounded,
deterministic, and need no external dependency.

Hierarchy means directed flow along the existing arrows, not containment.
Cycles are ranked together but retain their individual nodes and arrows.
Disconnected components remain visible. Grouping creates no ownership
relationships. Stable IDs break ties deterministically.

Layout runs over a derived view. It never emits semantic graph patches or
modifies IDs, graph revisions, evidence, canonical coordinates, or exports.
Auto-arrange responds to topology changes, not ordinary status updates.
With auto-arrange off, existing positions stay fixed and new nodes enter
available space. Preferences and shape overrides are bounded, in-memory
state scoped to project, session, and live/replay view. Refreshing the page
resets them; no cross-port persistence is promised.

## Balloon motion

Live additions inflate with a small overshoot, approximately 400 ms. Live
removals immediately leave the canonical diagram and inspector, while a
noninteractive decorative outline inflates briefly and pops into eight
fading particles, approximately 300 ms.

Motion applies to differences between consecutive live snapshots during an
uninterrupted connection. Initial loading, replay, session changes, and
reconnect resynchronization establish a fresh baseline. Staleness alone
does not mean deletion and must not cause a pop.

Positioning and inflation use separate transforms. At most 16 decorative
effects coexist. Rapid re-addition, view changes, hidden tabs, teardown, and
reduced-motion settings cancel effects and their fallback timers. Decorative
elements contain no copied evidence and cannot receive clicks or focus.

Small rearrangements may interpolate nodes, arrows, and labels together
over approximately 250 ms. Large graphs and reduced-motion mode update
immediately. Selection and evidence remain usable throughout.

## Review and delivery

Workers own core/schema changes, Jev questions/evaluation, layout algorithms,
and viewer/motion separately. The coordinator reviews integration and creates
checkpoint commits. An independent reviewer checks presentation isolation,
legacy compatibility, bounded work, shape geometry, motion cleanup, and
regression coverage.

Verify cycles, disconnected graphs, long labels, parallel/reverse arrows,
rapid additions/removals, replay during animation, metadata-only updates,
reduced motion, and the maximum supported graph size. Inspect the actual
browser with a larger synthetic graph resembling the supplied screenshot.
Rebuild the host packages and document any required daemon restart.

## Terminal lifecycle and connection guide

`start` and `demo` run in the foreground by default. They print the local
viewer URL and keep the terminal occupied until Ctrl+C, SIGTERM, or an explicit
stop closes the service. `--background` opts into detached operation. MCP start
remains detached so a tool call can return.

Repeated starts reuse the instance for the canonical project and data directory.
A foreground invocation joins an existing compatible instance and controls its
shutdown. Interrupting it stops that exact instance, never a replacement
owner. A new browser token is a new login link to the same port. Conflicting
policy or explicit port settings require a restart.

The viewer's **How to connect** dialog fetches instructions through an
authenticated local endpoint. Commands use trusted service paths and shell
quoting, with no API key, browser token, source excerpt, or model-produced text.
The endpoint is separate from graph snapshots and exports.

Claude instructions load its built profile with `--plugin-dir`. Codex
instructions register the generated local marketplace, install Graphlin,
launch a new session, and direct the user to `/hooks` for trust review.
Unavailable package profiles produce a setup note rather than invented paths.
Both hosts inherit the service's data directory and run in its project.
The user keeps the foreground service terminal open and runs the agent in
another terminal. No host installation occurs merely by opening the dialog.

## Sketch styling and color themes

The diagram should read like an architecture discussion on a whiteboard:
colored shapes with lightly irregular ink outlines, readable labels, and
quiet controls. Keep the existing Avenir/system typography for names and
evidence; sketch the geometry rather than sacrificing label legibility.

The default Sketchbook palette uses white paper, dark ink, and blue, mint,
amber, and pink component fills. Its base tokens are paper `#fbfaf7`,
ink `#293340`, blue `#dceafb`, mint `#d7ece5`, amber `#fae8bd`, and pink
`#f4dbe3`. Ocean, Forest, Sunset, Berry, Sepia, Blueprint dark, and Midnight
dark provide seven alternatives. Each theme includes its own canvas, ink,
component fills, relationship labels, and focus colors.

The existing arrangement row gains a Theme selector and small palette preview:

```text
[Layout ▾] [Arrange] [Auto-arrange]    [Theme ▾] [color swatches]
```

Colors distinguish component kinds. Evidence status retains explicit labels
and line patterns across all themes, including both dark palettes. Theme
preferences use the same bounded, per-view memory as layout choices; they
never enter graph snapshots, classifier context, or exports.

Use **Tidy sketch**, option D in the [line style comparison](line-style-options.html):
shallow, uneven bends, close double strokes, and slightly imperfect corners.
Apply this treatment to shape outlines, internal dividers and rims, and
relationship arrows with open, hand-drawn arrowheads.

The finite shape catalog supplies deterministic sketch outlines seeded from
node ID and shape. Keep the strokes within a small, bounded distance of their
canonical geometry and tighten the variation on short details. Position,
theme, activity, and revision must not alter the outline. Retain canonical
fills, ports, hit targets, and title clipping. Sketch strokes are decorative,
noninteractive, and hidden from accessibility APIs. Cache node strokes and
reuse them for removal animations.

Seed arrow strokes from edge identity and derive them from the numeric route.
Preserve the canonical hit path and attachment points. During layout motion,
move the visible strokes, arrowheads, hit path, and label together. Status
updates and theme changes must not redraw the ink randomly.

This is an appearance inspired by hand-drawn diagrams. It does not add the
Excalidraw editor, its document format, a remote dependency, or a new semantic
diagram model.
