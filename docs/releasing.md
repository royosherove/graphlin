# Releasing Graphlin

Graphlin is being prepared for a public, MIT-licensed npm release under the
unscoped name `graphlin`. The CLI is `graphlin`. The release repository must be
the public `royosherove/graphlin`. Preparing these files does not
create the repository, reserve the npm name, publish a package, or authorize
changing repository visibility.

`package.json` intentionally remains `private: true`. Public release requires
an explicit change to `private: false`, a public repository, and the repository
Actions variable `NPM_PUBLISH_ENABLED=true`. The release guard rejects missing
settings, other repositories, private repositories, other branches, tags,
and inconsistent package versions. Keep the variable unset or `false` until
publication is separately authorized and the remaining release gates are ready.
The maintainer has configured `NPM_TOKEN` as a **repository Actions secret**.
The workflow supports this location without moving or duplicating the secret.
The repository and package remain private; adding the secret does not enable
publishing.

After activation, a push or merge to `main` runs the complete CI matrix and
publishes a new package version only if every check succeeds. An already
published version is a successful no-op. Tags do not trigger publication.

## Verify a candidate locally

Use Node.js 22.14.0 or later on macOS or Linux. There are no external package
dependencies and no dependency installation is needed.

```sh
npm run validate
npm test
npm run build
npm run pack:check
npm pack --dry-run
```

`npm run check:packages` combines validation, plugin builds, and tarball checks;
run `npm test` separately for the full test suite.

CI runs validation, the full tests, plugin builds, and npm tarball checks on
Node.js 22, 24, and 26 on Linux and macOS: all six combinations are required.
Release jobs use Node 24 and npm 11.17.0. Update the matrix as Node support changes.

`ci.yml` handles pull requests, pushes to branches other than `main`, and its
own manual test runs. `release.yml` handles pushes to `main` and calls that
same `ci.yml` from the same commit, including every matrix check. This avoids
running a second copy of CI on main. CI still runs while publication is
disabled or the package is private. All checkouts use the event's exact
`github.sha`, including the publish checkout; they do not pick up a newer
main commit after an approval delay.

These development and release npm scripts require a source checkout. Generated
plugin packages expose only their runnable controls and validation commands.

`pack:check` creates an actual tarball in a temporary directory, checks its file
list and integrity, extracts it, checks public contents, installs it offline
without lifecycle scripts, and executes the installed `graphlin --help`.
It then imports the installed `preparePackages(dataDir, version)` to create
stable plugins under `dataDir/plugins/graphlin/<version>`. After deleting the
temporary npm installation, extracted source, tarball, and npm cache, a fresh
process starts each stable Claude and Codex bundle with an offline fixture
service. Real packaged `collect.sh` hooks deliver `SessionStart` and
`PostToolUse` through IPC. Authenticated HTTP must show the first accepted
`saveNote` shape with the synthetic file's source hash; silent hooks alone
do not pass. Servers close and temporary files are removed afterward.
This invokes no real host CLI, reads no personal configuration or API keys,
and uses only local HTTP and IPC. It requires the system `tar` command,
which is available on the supported CI runners.

The `files` array in `package.json` is an exact filename allowlist shared by npm
and the plugin builder. Every filename starts with `./` to anchor it at the
package root: an unanchored `README.md` can also include nested private READMEs.
The allowlist includes the runtime, required scripts, schemas,
manifests, Graphlin skill, adapter guidance, root README, and MIT license.
It excludes local state, credentials, environment files, operational helpers,
research, evaluation scripts, tests, CI configuration, and development docs.
New runtime files must be deliberately added to the allowlist.

The tarball check also rejects credential formats and identifying machine
paths. This is a bounded automated check, not a guarantee that arbitrary
private prose or every possible secret is detectable: review the included
README, skill, adapter guidance, and source before release.

The builder generates `dist/portable/graphlin`, `dist/claude/graphlin`, and
`dist/codex/graphlin`, plus the local Codex marketplace and inactive Kiro
profile. It preserves source/output symlink rejection and only replaces
directories carrying its `.graphlin-package` ownership marker. Neither building
nor packaging installs anything into a user's host configuration.

## Initial npm and GitHub setup

These are maintainer actions for when public release is authorized:

1. Review the complete repository and history for public disclosure, including
   material excluded from npm. Only then make `royosherove/graphlin` public.
   npm provenance does not support private source repositories, even for public
   npm packages; this project's workflow deliberately blocks such publication.
2. Confirm control or availability of the unscoped npm name `graphlin`.
   Configure the publishing account and two-factor authentication. The token
   must have granular **Read and write (publish and stage)** package access
   and **Bypass 2FA** enabled for noninteractive publication. Limit access to
   the required package where possible and rotate it before expiration.
   Stage-only and read-only tokens cannot run this workflow's direct
   `npm publish`. Legacy tokens are no longer supported.
3. Before enabling publication, create or review the GitHub Actions environment
   named `npm`. This deployment environment is independent of where the token
   is stored. Under deployment
   restrictions choose **Selected branches and tags**, add a **Branch**
   rule for exactly `main`, and allow no tags or other branches. Configure
   required reviewers if releases should wait for approval. Restrict who
   can change the workflow, environment, and repository variables. Protect
   `main` with the complete CI checks required before merge; select the
   actual check names shown by GitHub after the workflows have run.
4. Keep the existing repository Actions secret **`NPM_TOKEN`**. Future rotation
   is managed directly in GitHub under **Settings → Secrets and variables →
   Actions → Repository secrets**. No move into the `npm` environment and no
   duplicate secret are required. An environment-scoped `NPM_TOKEN` is also
   supported as an alternative; if both scopes contain that name, GitHub uses
   the environment secret for that job.
   Never put the value in chat, source files, command arguments, or logs.
   The workflow reads `${{ secrets.NPM_TOKEN }}` and maps it to `NODE_AUTH_TOKEN`
   only in the final publish step; `actions/setup-node` configures the registry
   authentication reference. This workflow does not pass the token to CI,
   guard, build, package smoke, or registry lookup. Environment deployment
   rules still gate the publish job when the token is stored at repository level.
5. In a separately reviewed change, set `package.json` to `private: false`
   and keep all four versions equal: `package.json`, `plugin.json`,
   `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json`. Choose a
   stable version that has never been published and run the candidate checks.
   The workflow never changes `private`, bumps versions, or edits manifests.
6. After setup and authorization, set the **repository Actions variable**
   `NPM_PUBLISH_ENABLED` to the exact string `true`. Keep this variable at
   repository level so the guard can read it before entering the environment.
   Do not shadow it with an environment variable. Merge the reviewed release
   candidate to `main`, or use the manual release procedure below.

The first version can use this same token workflow if the account and token
permit creating `graphlin`; no OIDC bootstrap publication is required. A
missing package lookup does not reserve the name or prove publishing rights.
Keep npm package access compatible with granular tokens; selecting
“disallow tokens” conflicts with this release plan. Do not configure an npm
trusted publisher as part of the token setup: npm can prefer OIDC when a
matching trusted publisher exists.

**Token publishing deadline:** npm's documentation checked September 20,
2026 says direct publishing with granular access tokens will be removed in
January 2027. The requested token pipeline works with the current direct
publish model. Before that deadline, maintainers must explicitly migrate
to trusted publishing or a staged token publication workflow with maintainer
approval. No migration is enabled by this preparation.

GitHub pushes, pulls, and authenticated GitHub CLI commands must follow
`AGENTS.md` and any local instructions it references. Use the authorized
publication environment and transfer only reviewed, committed source.
Local operational configuration and credentials are excluded from npm.

## Release an established package

1. Choose a new stable semantic version. Update all four version fields together
   **before merging** and run the candidate checks. For example, change all
   four `0.1.0` versions to `0.2.0`. The workflow does not publish prereleases
   or build-metadata versions. npm versions are immutable, including after
   unpublishing; a code change at an existing version cannot replace it.
2. Review and merge the candidate to `main` (or make an authorized direct push).
   No tag is required. `release.yml` runs the full reusable CI matrix first.
   Failed, cancelled, or skipped required checks block guard and publication.
3. After CI succeeds, the guard requires the exact public repository, a
   `push` or `workflow_dispatch` event on `refs/heads/main`, the enabled
   variable, `private: false`, matching stable versions, and validated package
   metadata and contents. Pull requests, forks, tags, and other branches
   cannot pass these gates.
4. After any `npm` environment approval, the publish job repeats the release
   guard, builds the plugins, and checks the tarball and installed CLI. It
   then checks public npm registry metadata without credentials:

   | Registry result | Workflow behavior |
   | --- | --- |
   | Exact version exists, even if `latest` differs | Success; skip publishing without needing the token |
   | Valid package metadata lacks the version | Attempt publication |
   | Registry confirms package missing with JSON `Not found` and HTTP 404 | Attempt initial publication |
   | Authentication/rate-limit/server error, timeout, redirect, invalid response, or known unpublished version | Fail; do not publish |

5. For a new version only, the final step requires `NPM_TOKEN` and runs
   `npm publish --access public --provenance --ignore-scripts` against the
   public npm registry. Validation has already run explicitly; lifecycle
   scripts are disabled during the operation receiving the token.
   Only the publish job receives `id-token: write`, for provenance signing.
   Registry authentication uses the configured npm token. Package caching
   and persisted checkout credentials are disabled.
6. Verify the version and provenance on npm. A registry or publish error is
   reported as failure, never converted to success or assumed version
   absence. If another publisher wins a race after the lookup, this run
   fails; a rerun detects the now-published version and becomes a no-op.

The release concurrency group serializes release runs and does not cancel an
active run. GitHub may replace an older pending run when newer runs queue;
do not use this pipeline as a guarantee that every intermediate commit becomes
a release. Keep the intended version bump in the current main candidate.

For a manual retry, open **Actions → Release npm → Run workflow**, select
**main**, and run. The workflow must exist on the default branch for manual
dispatch. Selecting another branch or tag cannot publish. A manual run
repeats the full CI matrix and every release gate for its selected commit.
Running the separate **CI** workflow manually only runs checks.

To stop future publication, unset `NPM_PUBLISH_ENABLED` or set it to `false`.
Also cancel pending or active release runs when stopping an in-progress
release; changing configuration cannot recall a completed npm publication.

The workflow does not create a GitHub repository, release, tag, or commit,
and does not change repository visibility. Once explicitly enabled, its
publish step performs a real public npm release.

## Optional future OIDC migration

Trusted publishing is a separate future change, not a prerequisite for
`NPM_TOKEN`. Preserve the same CI, main-branch, environment, metadata, and
registry gates. Configure npm's GitHub trusted publisher for user
`royosherove`, repository `graphlin`, workflow `release.yml`, and environment
`npm`, explicitly allowing direct `npm publish`. Then review a workflow
change removing the required token check and token mapping. Retain the
publish job's `id-token: write`. Verify the migration before revoking the
token or disallowing token publication. npm's current OIDC minimum is
npm 11.5.1 and Node 22.14.0; the pinned release runtime satisfies it.

## Official references

Verified against official documentation on September 20, 2026:

- [npm access tokens](https://docs.npmjs.com/about-access-tokens/) — granular
  permissions, stage-only restrictions, and the January 2027 direct-publish
  token deadline.
- [npm CI/CD tokens](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/) —
  granular write tokens, bypass 2FA, and secret storage.
- [GitHub npm publication](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages) —
  `setup-node`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, and provenance.
- [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) —
  environment secrets, branch restrictions, and required reviewers.
- [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/using-secrets-in-github-actions) —
  repository and environment secret configuration and the `secrets` context.
- [GitHub secret precedence](https://docs.github.com/en/actions/reference/security/secrets) —
  environment secrets override repository secrets with the same name.
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) —
  same-commit local workflow reuse.
- [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) —
  branch filters, manual dispatch, and dependency gates.
- [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) —
  running and pending workflow behavior.
- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/) —
  immutable name/version combinations and public publication.
- [npm lifecycle configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#ignore-scripts) —
  disabling package lifecycle scripts during publication.
- [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md) —
  public package and version metadata.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) — future
  migration, CLI requirements, and OIDC authentication precedence.
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) —
  public repository metadata, attestations, and provenance limitations.
- [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) —
  the `files` allowlist, automatic README/LICENSE inclusion, `bin`, `private`,
  and `publishConfig`.
