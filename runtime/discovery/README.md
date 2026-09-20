# Local discovery

`index.mjs` exports a metadata inventory and a bounded source extractor.
The host owns source consent, capture, evidence freshness, display, persistence,
and remote transmission. Neither API classifies source or proves runtime
behavior. Tests use synthetic files and do not contact Jev.

## Integration

```js
import { createInventory, extractStructure } from './runtime/discovery/index.mjs';

const inventory = createInventory({
  projectRoot,
  excludePaths: ['generated/**'],
});
const page = await inventory.next({ limit: 64, signal });
// page.entries includes files and directories for root summaries.
// page.paths includes file paths only. Authorize source capture in the host.

const structure = await extractStructure({
  artifactId: capture.id,
  relativePath: capture.relativePath,
  text: capture.text,
  hash: capture.hash,
  generation: capture.generation,
  complete: capture.complete,
  signal,
});

// Keep inventory and call next() to resume. Release abandoned cursors:
await inventory.close();
```

`extractStructure` is asynchronous. Input must be an authorized UTF-8 capture,
with the core artifact ID, SHA-256 hash, and positive generation. Hash mismatch,
local secret filtering, excluded paths, cancellation, and source limits suppress
declaration extraction. A partial capture must pass `complete: false`, even when
its text happens to be syntactically valid. Capture windows must not be presented
as whole-file text.

The result is deeply frozen:

- `entities`: `{id,label,kind,parentId,artifactId,startLine,endLine,qualifiedName}`.
  The first entity is a file/module root (`parentId: null`); its ID equals
  `enumeration.scopeId`. Invalid/excluded paths can return no entities. Declaration
  kinds are `class`, `function`, `method`, `interface`, `namespace`, `enum`,
  `type_alias`, and `variable`. Python currently enumerates class/function
  declarations; JS/TS also include simple variable bindings.
- `relations`: `{id,source,target,kind}`. `contains` is the only emitted relation.
  Both endpoints exist and each parent encloses its child's line span.
- `imports`: `{id,artifactId,ownerId,specifier,bindings,startLine,endLine,kind,resolved}`.
  Each binding is `{imported,local}`. Kinds are `import`, `reexport`,
  `dynamic_import`, and `require_reference`. Every reference is unresolved;
  no target entity, dependency edge, or runtime connectivity is fabricated.
  A call spelled `require` can be shadowed and carries `require_resolution`
  as an omission. The host must resolve its binding before treating it as an import.
- `enumeration`: `{complete,extractor,version,scopeId,omissions,artifactId,hash,
  generation,identityVersion,capability,coveredRanges}`. `version` binds the
  adapter, pinned package, language, and actual grammar SHA-256.

Entity identity uses artifact identity, language, parent identity, declaration
kind/name, and a same-parent duplicate ordinal. It does not use body text, line
numbers, content hash, generation, session, or drawing shape. Ambiguous duplicate
declarations use source order; reordering those duplicates is not a supported
rename reconciliation. A parser/identity-version change requires host
reconciliation before using enumeration to infer deletion.

Complete enumeration refers to the supported declaration kinds above.
`complete: false` never establishes prior-symbol absence. Syntax errors,
anonymous scopes without an identifiable owner, destructuring/computed
declarations, budget omissions, or unavailable parsers are explicit omissions.
Valid siblings can survive an incomplete parse; declarations inside uncertain
owners are withheld. `coveredRanges` certifies the file only on complete
enumeration and is otherwise empty.

JS, MJS, CJS, JSX, TS, MTS, CTS, TSX, PY, and PYI select bundled grammars.
Other suffixes, including Markdown/MDX/RST documentation, return a file-level
`unsupported` capability. Missing/broken parser assets return explicitly
`lexical` file-level capability; this fallback makes no guessed ownership claims.
Documentation fences are never routed into a language parser.

## Inventory and coverage

`createInventory` is a synchronous factory. `next({limit,signal})` returns:

```js
{
  paths: ['gateway/main.py'],
  entries: [
    { relativePath: 'gateway/main.py', kind: 'file', size: 100, mtimeMs: 0, root: 'gateway' }
  ],
  continuation: { sequence: 1, pendingDirectories: 2 },
  coverage: {
    complete: false, visited: 1, inventoried: 1, excluded: 0, symlinks: 0,
    unavailable: 0, deferred: 0, pendingDirectories: 2,
    roots: [{ root: 'gateway', inventoried: 1 }], omissions: []
  }
}
```

Continuation is diagnostic; the inventory instance retains directory handles and
positions. It is not a serializable restart token or a filesystem snapshot.
Continue calling `next` while `continuation` is non-null, including when a page
has no paths. A new inventory is a new scan; use evidence reconciliation for
filesystem changes. Concurrent calls are rejected with a fixed error. Abort
stops the current slice without losing the cursor. `close` releases handles.

Traversal rotates top-level root lanes, including a lane for root files, and
rotates directories inside each lane. A large tooling subtree cannot consume
every slice while other known roots wait. No file contents, hashes, manifests,
project parsers, project configuration, or Python interpreters are read/run by
inventory. Only names, directory entries, real paths, and stat metadata are used.
It reuses core policy exclusions and also skips generated/dependency/local-state
directories. Excluded names are withheld. Symlinks, including aliases within the
root, are skipped; the canonical root and directory inodes are revalidated.

Coverage is complete only after traversal finishes without a permanent omission.
Policy exclusions and skipped symlinks are counted separately from uncertainty.
`deferred` is a lower bound on known deferred directory scopes, **not a count of
unseen files**. Time/entry slices retain continuation; path/directory/depth caps
stop or omit bounded scopes explicitly. An exhausted capped scan remains
incomplete and cannot imply deletion. Start a narrower scan to explore a
deferred scope.

## Bounds

Callers can lower these hard caps through `limits`:

| Extractor option | Default/hard cap |
| --- | ---: |
| `fileBytes` | 262,144 |
| `entities` (including file root) | 2,048 |
| `imports` | 512 |
| `bindings` per import | 128 |
| `nodes` | 50,000 |
| `depth` | 128 |
| `milliseconds` for parse and traversal together | 100 |

The parser's progress callback cancels parsing. Traversal checks the same
deadline, bounds work/stack size, and deletes each tree/parser in `finally`.
Initialization caches only the four trusted grammars; no source tree/text is
retained. The initial dependency/grammar load is separate from source work.
These are cooperative work limits, not a process memory sandbox.

| Inventory option | Default/hard cap |
| --- | ---: |
| `paths` (directories and files combined) | 10,000 |
| `entriesPerSlice` visited, including excluded names | 512 |
| `milliseconds` per slice | 50 |
| `depth` traversed below root | 24 |
| `directories` retained/open | 256 |
| `batch` output entries | 200 |

`next` defaults to 64 output entries. Filesystem operations already in progress
can finish after the cooperative deadline.

## M0 parser packaging spike

Decision: pin **`@vscode/tree-sitter-wasm@0.3.1`** (MIT). The Microsoft package
ships a matched Tree-sitter runtime and all required offline WASM grammars.
The package has no runtime dependencies or install lifecycle. No native addon,
local compiler, Python installation, or project-installed parser is needed.

The npm tarball inspected on 2026-09-20 is 2,053,205 bytes; full unpacked size
is 22,082,102 bytes. Runtime needs the following subset plus the package manifest,
LICENSE, and `cgmanifest.json`:

| Asset under dependency `wasm/` | Bytes |
| --- | ---: |
| `tree-sitter.js` | 168,729 |
| `tree-sitter.wasm` | 206,218 |
| `tree-sitter-javascript.wasm` | 411,770 |
| `tree-sitter-typescript.wasm` | 1,413,849 |
| `tree-sitter-tsx.wasm` | 1,445,638 |
| `tree-sitter-python.wasm` | 457,883 |
| Total | 4,104,087 |

The runtime manifest identifies Tree-sitter 0.25.1 at commit
`fc15f621334a262039ffaded5937e2844f88da61`. Grammar ABIs are 15 for JS/Python
and 14 for TS/TSX. Grammar metadata reports 0.0.0, so certificates bind actual
WASM hashes instead of inventing grammar package patch versions.

Assets must live under **Graphlin's own**
`node_modules/@vscode/tree-sitter-wasm/`, in both npm and standalone plugin
distributions. The loader deliberately does not search ancestor packages or
the inspected project's current directory. A missing bundle produces the
explicit file-level fallback. Root dependencies, lockfile, asset copying, and
npm/plugin package checks are parent-owned integration work.

Official references used for the spike:

- Microsoft package source: `https://github.com/microsoft/vscode-tree-sitter-wasm`
- Tree-sitter web binding docs at the runtime release:
  `https://github.com/tree-sitter/tree-sitter/blob/v0.25.1/lib/binding_web/README.md`
- Packaged `wasm/web-tree-sitter.d.ts` documents parse progress cancellation,
  `Language.load`, and explicit tree/parser cleanup.

Discovery tests passed on macOS arm64 with Node 22.14.0, 24.21.0, and 26.5.0.
Linux remains a parent/CI verification gate; it was not tested on this workstation.

Synthetic metadata benchmark on macOS arm64, Node 26.5.0, 2026-09-20:

| Fixture | Emitted paths | Pages of up to 64 | Total | Maximum observed slice |
| --- | ---: | ---: | ---: | ---: |
| 1,000 files / 5 roots | 1,005 | 16 | 192 ms | 16 ms |
| 10,000 files / 5 roots | 10,000 | 157 | 2,129 ms | 19 ms |

Tooling comprised 80% of each fixture. Every product root was served. The larger
case correctly ended incomplete at the 10,000-path cap, reporting `path_limit`;
the limit includes directory summaries. Fixture generation is excluded from
timings. These are local observations, not cross-platform performance promises.
