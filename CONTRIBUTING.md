# Contributing to Graphlin

Graphlin turns observable coding-agent work into live architecture diagrams.
Contributions to host adapters, classification examples, accessibility, and
diagram usability are welcome.

Use Node.js 22.14 or newer on macOS or Linux. Install the pinned WASM parser,
`@vscode/tree-sitter-wasm@0.3.1`, from the committed `package-lock.json` without
running lifecycle scripts. Published npm packages and generated plugins bundle
the full parser dependency for offline use.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm run check:packages
npm run demo
```

Run the large-inventory pagination stress test locally with:

```sh
npm run test:stress
```

It traverses all 20,000 entities alongside 40,000 relations and checks bounded
responses, current reads, and validation work. CI runs `npm test` with the
correctness, privacy, and integration tests; stress tests are separate.

The demo and automated tests use synthetic fixtures and make no Jev API calls.
Live evaluations are explicit commands documented in the README. Use generated
examples for them; do not submit private project code or transcripts.

Keep changes focused and describe the user-visible problem, the resulting
behavior, and how you checked it. Add regression coverage for behavior changes.
Documentation-only changes do not need new tests. Include screenshots for
significant viewer changes, with tokens, paths, and private labels removed.

Before proposing a new host integration, separate configuration validation from
actual host activation. Record the host version and observed events. Do not
claim access to private reasoning or infer runtime success from a source snippet.

Privacy boundaries are part of the product:

- Hooks must remain passive and fail open without changing agent behavior.
- Source transmission requires explicit consent and local filtering.
- The second Jev stage receives only evidence approved by the first stage.
- Stale source versions invalidate claims; classification is not execution.
- Browser access, logs, exports, and stored state must preserve their existing
  authentication and evidence policies.

Use generic paths, generated identifiers, and synthetic source in fixtures.
Never commit credentials, environment files, local state, agent transcripts, or
machine-specific setup. Report vulnerabilities using [SECURITY.md](SECURITY.md).

Opt in to staged-file and commit-message checks with
`npm run security:install`. The installer downloads AWS
[git-secrets](https://github.com/awslabs/git-secrets) at commit
`7d6b970cbd3c216353cb22b383b70c150140662e`, verifies its SHA-256, and keeps it in
Git's local metadata directory. Existing hooks and `core.hooksPath` are preserved;
if installation reports a conflict, run `node scripts/security-check.mjs setup`
and explicitly chain `.githooks/pre-commit` and `.githooks/commit-msg` from your
hook manager. Scans are offline, use AWS regex rules without credential-file
providers, and report only opaque file ID, rule, and line—not matched values
or filenames that might themselves contain secrets. File IDs are `file-` plus
the first 20 hex characters of SHA-256 of the repository-relative path (AWS
historical results prefix the path with `commitSHA:`; messages use `COMMIT_EDITMSG`).
They do not read `~/.aws/credentials` or use repository/global allowances. No baseline or
exclusions are configured; discuss false positives before adding exceptions.
Run `npm run security:check` to check the index, or
`npm run security:history` in a complete checkout to check
reachable history and commit messages. One separate CI job requires both
git-secrets and checksum-pinned Gitleaks 8.30.1 (its built-in generic-provider
rules), plus `node --test --test-timeout=90000 tests/security/*.mjs`. Both scanners
fail closed when unavailable; Gitleaks ignores inline allowances and uses no
baseline. Release publication depends on that full CI workflow. Local hooks
require git-secrets; Gitleaks is required in CI. To run the security tests locally,
set `GRAPHLIN_TEST_GITLEAKS` to your verified Gitleaks 8.30.1 binary after tool setup.

Release maintainers should follow [the release guide](docs/releasing.md).
Contributions are provided under the repository's [MIT license](LICENSE).
