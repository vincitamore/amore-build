# Security Policy

## Reporting a Vulnerability

Report suspected security issues through **GitHub private vulnerability
advisories** on this repository:

**[Security → Advisories → "Report a vulnerability"](https://github.com/vincitamore/amore-build/security/advisories/new)**

Please do not file public issues for security reports, and do not post details
in discussions, PRs, or any other public channel, until a fix is public.

**There is no security email alias** — private advisories are the single
reporting channel, so reports stay attached to the repository and get a
private working thread by construction.

### What to include

- Affected version / commit (`amore --version` prints the build commit).
- Reproduction steps or a proof-of-concept, and the impact you see.
- Whether the issue reproduces in **upstream** `xai-org/grok-build` — if it
  does, it is an upstream bug and should be reported there as well; this fork
  tracks upstream and will pull their fix. Issues in fork-specific surfaces
  (identity/branding layer, `.amore` config-dir handling, `amore init` /
  `amore setup`, the bundled `templates/house/` content, the iris
  companion seam, `instruments/iris/`) belong here.

### Expectations

This is a personal-scale open project maintained in the open, not a staffed
security org: response is **best-effort, no SLA**. Reasonable-coordination
disclosure is appreciated — we aim to acknowledge useful reports and will
credit reporters in release notes unless you ask otherwise.

### Scope guidance

- Secrets handling is documented in `docs/authentication.md`
  (`~/.amore/auth.json` must never be committed or logged; `AMORE_*` env
  vars take precedence over `GROK_*` aliases).
- `amore init` / `amore setup` write templates and config under your user
  home and project tree — report anything that writes outside those roots or
  follows input-controlled paths unsafely.
