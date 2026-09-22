# Security

Graphlin is an early-stage local development tool. Security fixes target the
latest released version.

Do not post credentials, browser launch tokens, source excerpts, personal paths,
or agent transcripts in public issues.

Report a suspected vulnerability through the repository's **Security → Report a
vulnerability** option when it is available. If it is unavailable, open a minimal
issue asking a maintainer for a private reporting channel; omit exploit details
and sensitive attachments.

A useful private report includes the affected version, host and operating system,
a synthetic reproduction, expected and actual behavior, and the impact. Sanitized
classification reason codes are useful; real API keys and production data are not.

Graphlin binds to loopback and uses local authentication. Keep its data directory
private and do not expose the service through a public tunnel. Live classification
sends filtered snippets to TypeSafe only after explicit source consent. The demo
is offline. See the README for evidence display, persistence, and log controls.

## Repository checks

Run `npm run security:install` in a source checkout to install the pinned AWS
git-secrets hooks. They check the staged file contents and commit message,
block commits when scanning cannot finish, and preserve existing hook managers.
Scans run locally without reading your AWS credential file or validating keys
against a service. See [Contributing](CONTRIBUTING.md) for setup and manual checks.

CI scans the full Git history with AWS git-secrets and Gitleaks before npm
publication. Scanner downloads are pinned and checksum-verified. Diagnostic
output omits matched credential values. The package check separately verifies
every shipped file against the public allowlist and rejects credential patterns
and identifying machine paths.

These checks complement manual review of prose, screenshots, and recordings.
Synthetic security-test inputs and intentional public maintainer attribution
are not private user data. Never add broad exclusions or a baseline that hides
an unreviewed finding.
