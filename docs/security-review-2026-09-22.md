# Publication security review — September 22, 2026

**Result:** no credentials or unintended personal information found in the
reviewed Git history, repository media, or published npm artifact.

Review base: `e672039d248f0868a957c896d7a472f0c281bbad`, Graphlin **0.4.0**.
The remote's only published branch was `main`; there were no tags or additional
branches outside the reviewed history.

| Surface | Check | Result |
| --- | --- | --- |
| Git history | Gitleaks 8.30.1 across all 45 commits, without inline allow exceptions | No secret findings |
| AWS credentials | Pinned AWS git-secrets across files and commit messages | No findings |
| Personal information | 678 historical file blobs and 45 commit objects checked for home paths, email addresses, internal domains, account assignments and private IPs | No unintended identifiers |
| Tracked paths | 308 files checked for credential files, state, logs and private configuration | None tracked; `.env.example` contains an empty value |
| npm 0.4.0 | Registry integrity verified; all 143 published files scanned; package allowlist and byte checks passed | No secret findings or unexpected files |
| Repository media | Metadata and OCR across six reachable image blobs, including 336 GIF frames; sampled visual review | No unintended identifiers or authentication URLs found |
| Dependencies | npm audit of the locked dependency tree | Zero known vulnerabilities reported |
| Release workflow | Token handling and release guard reviewed; 33 release tests passed | Token confined to the final publish step |
| GitHub | Repository secret scanning and push protection enabled; open alerts queried | No open alerts at review time |

Home-path matches were synthetic privacy-test inputs. One email-like match was
a test URL; another occurred only in compressed GIF bytes and was absent from
the decoded image. Intentional public GitHub maintainer attribution is retained.

The review found missing ignore rules for `.aws/`, `.ssh/`, `.p12`, and `.pfx`
files. These were added; none of those files had been tracked.

Prevention now includes explicit local AWS commit hooks and a separate CI job
using pinned, checksum-verified AWS git-secrets and Gitleaks. CI security checks
gate npm publication. Existing package-content checks remain in place. See
[Contributing](../CONTRIBUTING.md) for installation and checks.

No findings required credential rotation or Git history rewriting. Scanning
does not prove the absence of every secret or personal detail, and this review
is not an application penetration test. Continue reviewing prose, media, and
new files before publishing.
