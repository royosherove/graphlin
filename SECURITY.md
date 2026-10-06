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

The experimental decider provider sends the same filtered snippets, after the
same consent, to a Decider server in your AWS account, through a local SSM
tunnel on a loopback endpoint (default `http://127.0.0.1:8099/v1/systemone`).
Know these risks:

- The Decider server has no authentication. The tunnel controls the access, and
  the model name check is a label check only.
- When the tunnel is down, a different local process on port 8099 can receive
  the source. Stop Graphlin before you stop the tunnel, or use metadata mode.
- Node.js can send `fetch` requests through an environment proxy
  (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`, with `HTTP_PROXY`). The decider
  provider does not use `fetch` or the global agent: it connects with
  `node:http` and a private agent to the loopback endpoint only, thus a proxy
  does not get the source. A test examines this in a child process.
- The provider value applies to all projects that share a Graphlin data
  directory. See `docs/usage.md`.

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
