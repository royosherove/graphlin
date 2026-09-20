# Releasing Graphlin

Graphlin is being prepared for a public, MIT-licensed npm release under the
unscoped name `graphlin`. The CLI is `graphlin`. The intended repository is
`royosherove/graphlin`, initially **private**. Preparing these files does not
create the repository, reserve the npm name, publish a package, or authorize
changing repository visibility.

`package.json` intentionally remains `private: true`. Public release requires
an explicit change to `private: false`, a public repository, and the repository
Actions variable `NPM_PUBLISH_ENABLED=true`. The release guard rejects missing
settings, other repositories, private repositories, and mismatched tags.
Leave the variable unset throughout private development.

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
Node.js 22, 24, and 26 on Linux and macOS. As of September 20, 2026, Node 22
and 24 are supported LTS lines and Node 26 is Current; release jobs use Node 24.
Update the matrix as Node support changes.

These development and release npm scripts require a source checkout. Generated
plugin packages expose only their runnable controls and validation commands.

`pack:check` creates an actual tarball in a temporary directory, checks its file
list and integrity, extracts it, checks public contents, installs it offline
without lifecycle scripts, and executes the installed `graphlin --help`.
Temporary files are removed afterward. It requires the system `tar` command,
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
   Configure the publishing account and its two-factor authentication using
   npm's current account flow. No npm name has been reserved by this preparation.
3. Change `package.json` to `private: false` and keep all four versions equal:
   `package.json`, `plugin.json`, `.claude-plugin/plugin.json`, and
   `.codex-plugin/plugin.json`. Run the candidate checks above.
4. If `graphlin` does not exist on npm yet, bootstrap the real initial version
   with a separately authorized interactive publication of a reviewed
   tarball. The documented trusted-publisher setup starts in an existing
   package's Settings page. Use npm's browser login/2FA flow; never store or
   share credentials in this repository, command arguments, or workflow logs.
   The initial interactive publication consumes that version and does not
   carry this GitHub workflow's provenance. Configure OIDC afterward and use
   a new version for the first automated release.
5. In the npm package Settings → Trusted Publisher, choose GitHub Actions and
   configure these exact values:

   | Field | Value |
   | --- | --- |
   | Organization or user | `royosherove` |
   | Repository | `graphlin` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm` |
   | Allowed actions | Explicitly permit direct `npm publish` |

   Enter only the workflow filename, including `.yml`. Values are case-sensitive.
   The environment name must match the publish job. New trusted publishers
   created after September 3, 2026 default to staged publication; this workflow
   uses direct publication, so that additional allowed action is required.
   npm does not validate this configuration when it is saved.
6. Create the GitHub Actions environment `npm`. Configure required reviewers and
   deployment tag restrictions for stable `v*` tags. Protect the default branch
   and release tags, and restrict who can change the release workflow and
   environment settings. Set the repository Actions variable
   `NPM_PUBLISH_ENABLED` to the exact string `true` after setup is complete.
7. Once OIDC publishing works, npm recommends package publishing access
   “Require two-factor authentication and disallow tokens.” Trusted publishing
   continues to work with that setting. Do not add `NPM_TOKEN` or
   `NODE_AUTH_TOKEN` secrets to this workflow.

GitHub pushes, pulls, and authenticated GitHub CLI commands must follow
`AGENTS.md` and any local instructions it references. Use the authorized
publication environment and transfer only reviewed, committed source.
Local operational configuration and credentials are excluded from npm.

## Release an established package

1. Choose a new stable semantic version. Update all four version fields together
   and run the candidate checks. This workflow does not publish prereleases or
   build-metadata versions.
2. Review and commit the candidate. From the authorized publication environment, push the
   matching tag `v<version>` pointing to that reviewed commit. For example,
   package version `0.2.0` requires exactly `v0.2.0`.
3. `release.yml` checks the repository, public visibility, release variable,
   package metadata, and exact tag/version equality before running the full CI
   matrix. Publication only proceeds after all checks and any `npm` environment
   approval. Failed checks do not publish.
4. The publish job rebuilds and checks the candidate on a GitHub-hosted Ubuntu
   runner, then calls `npm publish --access public --provenance`. The job alone
   receives `id-token: write`; it uses no stored npm token and disables package
   caching. It uses npm 11.17.0, which satisfies npm's documented OIDC minimum
   of npm 11.5.1 and Node 22.14.0.
5. Verify the new version and provenance on npm. To stop future automatic
   releases, unset `NPM_PUBLISH_ENABLED`. An already published version cannot be
   reused; do not move an existing release tag to hide a failed candidate.

The workflow builds from the checked-out tag. It does not create a GitHub
repository, release, tag, or commit, and does not change repository visibility.
Its `npm publish` operation is an actual public release when all gates permit it.

## Official references

Verified against official documentation on September 20, 2026:

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) — supported
  runners, CLI requirements, exact publisher fields, allowed actions, OIDC,
  provenance, and publishing access.
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) —
  public repository metadata, attestations, and provenance limitations.
- [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) —
  the `files` allowlist, automatic README/LICENSE inclusion, `bin`, `private`,
  and `publishConfig`.
- [Node.js releases](https://nodejs.org/en/about/previous-releases) — supported
  runtime release lines.
