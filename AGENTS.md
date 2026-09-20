# Working on Graphlin

Read README.md and CONTRIBUTING.md before changing behavior. The runtime uses
JavaScript ES modules with Node.js built-ins; the viewer uses plain HTML, CSS,
JavaScript, and SVG.

If `.graphlin-local/AGENTS.md` exists, read its private workstation instructions
as well. That directory must remain local and untracked.

Preserve passive, fail-open hooks, explicit source consent, local secret
filtering, evidence-version checks, and authentication. Pre-tool intent is not
source evidence, and source evidence does not prove runtime success. Never claim
private reasoning capture.

Run appropriate tests with `npm test`, build plugin packages with `npm run build`,
and validate them with `npm run check:packages`. Keep the package, plugin
manifests, CLI, and bundled skill names and versions consistent.

Use synthetic fixtures. Do not read, print, commit, or upload environment files,
credentials, local state, private source, or transcripts unless the user's task
explicitly requires access. Keep machine-specific operations outside this tree.

Do not publish an npm package, create a release, or change repository visibility
without explicit authorization. The release guide describes the required gates.
