# Security

Graphlin is an early-stage local development tool. Security fixes target the
latest development version until versioned releases establish a support policy.

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
