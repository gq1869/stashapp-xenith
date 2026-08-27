# Security Policy

## Supported Versions

Xenith is maintained by a single developer with no backport branches. Only the latest release receives security fixes.

| Version               | Supported |
| ---------------------- | --------- |
| 3.0.x (latest release) | ✅        |
| < 3.0                  | ❌        |

Runtime requirements: Stash v0.31+, Python ≥ 3.11.

## Reporting a Vulnerability

**Preferred:** use GitHub's private vulnerability reporting — go to this repo's Security tab and click "Report a vulnerability." This opens a private draft advisory that only the maintainer can see, so exploit details aren't posted publicly before a fix ships.

**Fallback:** if private reporting isn't available to you, open a public issue. For anything sensitive, keep the issue minimal (e.g. "possible security issue, requesting a private channel") rather than posting exploit details in the open. Public issues are otherwise fine for non-sensitive hardening suggestions.

Please include:

- Affected Xenith version
- Stash version you're running
- Reproduction steps
- Impact (what an attacker could actually do)

### Response expectations

This is a hobby project, not an enterprise product — response times are best-effort:

- Acknowledgement within 7 days
- Assessment and a planned fix window communicated within 30 days
- Disclosure once a fixed release is tagged, or after 90 days, whichever comes first

## Scope

Xenith is a browser-side Stash plugin plus a Python task backend that runs inside your own self-hosted Stash instance. It does not hold credentials of its own: the frontend talks to `/graphql` same-origin using your existing Stash session cookie (`src/api.js`), and the backend receives its Stash connection via the plugin JSON handshake on stdin (`stashapp-tools`), not via any key or token Xenith manages itself.

**In scope:**

- Injection or XSS through library-derived strings rendered by the React components (`src/components/*.jsx`) or the DOM-injecting modules (`src/badge-injector.js`, `src/scene-tooltips.js`)
- GraphQL request construction in `src/api.js`
- Snapshot import handling in `backend/tasks.py` — untrusted JSON parsing, and path handling around the `XENITH_SNAPSHOTS_DIR` override and snapshot filenames
- Exposure of the `snapshots/` directory, which `xenith.yml` publishes as a Stash plugin asset path
- Vulnerable dependencies reachable at runtime (`stashapp-tools`; the frontend bundle ships zero runtime npm dependencies)

**Out of scope:**

- Vulnerabilities in Stash itself — report those to [stashapp/stash](https://github.com/stashapp/stash) upstream
- Anything requiring an already-compromised Stash instance, host machine, or authenticated admin session
- The `qa/` test harness, Playwright e2e config, and `STASH_URL` handling (test-only code)
- Missing HTTP security headers or TLS configuration — that's the Stash server's responsibility, not this plugin's
- Resource exhaustion from pointing the plugin at an extremely large library

## Testing Guidance

Please test only against your own Stash instance and your own data — never against a server you don't own or operate. No bug bounty is offered for this project.
