# Sidetrack Manual Stealth Experiment

This is a bounded diagnostic mode for manual Sidetrack testing. It compares the
normal Playwright/Chrome-for-Testing manual recorder with a Patchright Node.js
launch to see whether automation-shaped browser traits contribute to false
positives on owned, staging, or local test surfaces.

It is not a Cloudflare bypass feature. It does not solve CAPTCHA, does not
rotate proxies, does not use Browserless challenge-solving flows, and does not
click human checks. Third-party challenge pages are recorded as detours so the
durable replay path can use local fixtures or snapshots.

## Why Test Browsers Trigger Challenges

Manual Playwright runs can look different from a long-lived user Chrome:
automation-visible properties, extension launch flags, clean profile history,
CDP attachment, WebGL/browser traits, network reputation, request cadence, and
missing session continuity can all contribute to anti-bot false positives.
Patchright can reduce some automation-visible browser differences, but it cannot
make the browser equivalent to a real user session.

Modern challenge systems can also consider network fingerprinting, IP
reputation, request patterns, prior cookies, and Turnstile/CAPTCHA outcomes.
That is why normal Chrome manual capture remains the recommended path for
realistic human sessions, and routed fixtures remain the recommended path for
deterministic CI and replay.

## Modes

Manual browser mode is represented by:

- `normal-chrome-manual`
- `persistent-playwright-manual`
- `persistent-playwright-stealth-experiment`
- `routed-fixture-e2e`

Stealth mode is opt-in only and requires:

```bash
SIDETRACK_MANUAL_BROWSER_MODE=persistent-playwright-stealth-experiment
SIDETRACK_E2E_STEALTH_EXPERIMENT=1
```

The runtime prints:

```text
Stealth experiment mode is for owned/staging/local diagnostics only. It does not bypass third-party Cloudflare challenges.
```

## Profile Rules

Stealth mode uses a fresh Sidetrack-owned temporary profile by default. To
reuse a profile across manual experiment runs, set
`SIDETRACK_STEALTH_USER_DATA_DIR` to a Sidetrack-owned path.

It must not use:

- `~/Library/Application Support/Google/Chrome/Default`
- any personal Chrome profile
- any profile path not clearly owned by Sidetrack testing

If a different test profile is needed, set `SIDETRACK_STEALTH_USER_DATA_DIR` to
a Sidetrack-owned path.

## Domain Allowlist

Use `SIDETRACK_STEALTH_ALLOWED_HOSTS` for owned/staging/local hosts:

```bash
SIDETRACK_STEALTH_ALLOWED_HOSTS=localhost,127.0.0.1,staging.example.test
```

Manual navigation to other hosts is still allowed, but Sidetrack only records
outcomes. It does not recover from, retry, or interact with third-party
challenges.

Recorded outcomes are:

- `loaded_live`
- `loaded_fixture`
- `login_required`
- `cloudflare_challenge`
- `turnstile_or_captcha`
- `http_403`
- `navigation_failed`

## Run The Experiment

From the package directory:

```bash
cd packages/sidetrack-extension
npm run e2e:manual-stealth-experiment
```

This runs the existing L5 manual recorder in stealth experiment mode. Browse as
usual, then stop the recorder. The artifact directory includes
`manual-browser-diagnostics.json` and stdout prints:

- browser mode
- browser channel
- user data directory
- whether Playwright/CDP attached
- whether Patchright loaded
- challenge counts by host
- 403 counts by host
- login-required counts by host
- captured page snapshot count
- `replayFixtureSuggested`

For a local-fixture launch smoke:

```bash
cd packages/sidetrack-extension
npm run e2e:manual-stealth-smoke
```

## CI And Replay

Deterministic routed fixture replay rejects stealth mode. It also fails if a
request hits `challenges.cloudflare.com`, a
`/cdn-cgi/challenge-platform/` path, or an unstubbed live third-party document.

Use normal Chrome manual capture for realistic human sessions. Use routed
fixtures for repeatable CI/replay.

## Explicitly Forbidden

- CAPTCHA solving
- proxy rotation
- Browserless challenge-solving flows
- automatic Turnstile interaction
- auto-clicking human checks
- third-party anti-bot bypass logic
- exporting cookies or secrets from a personal Chrome profile
