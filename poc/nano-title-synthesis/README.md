# PoC: Gemini Nano title synthesis (Chrome built-in Prompt API)

**Date:** 2026-07-27 · **Status:** partially validated — API proven, model
delivery blocked in the test browser; quality gate pending on a browser
with working component delivery.

## Goal

Attack the measured accuracy defect from the guess-lane work: junk-titled
entities (chat turns titled "ChatGPT"/"Branch · X", URL-as-title visits)
carry title-only vectors and junk terms, polluting the title lane, FTS,
and the content lane's neighbor tails (PGSimCity probe, 2026-07-27).
Plan: synthesize 4–10-word descriptive titles on-device (zero outbound)
with Chrome's built-in Gemini Nano.

## What was established (evidence)

- **API surface present** in the extension page context on Chrome for
  Testing 150.0.7871.115: `LanguageModel` and `Summarizer` both defined;
  `LanguageModel.availability()` answers; `create()` accepted and drove a
  download monitor. `window.ai` is gone (old surface).
- **Model delivery is BLOCKED in Chrome for Testing**: availability stays
  `downloading` with progress pinned at 0; `chrome://components` shows
  "Optimization Guide On Device Model — Version: 0.0.0.0"; a forced
  component update click does not move it; the profile's
  `OptGuideOnDeviceModel/` stays 0 bytes. Consistent with CfT's stripped
  component-updater/Google-services integration. **This is a property of
  the test rig, not of the plan** — regular Chrome delivers the component.

## Harness

`harness.ts` (run: `PATH="$HOME/.bun/bin:$PATH" bun poc/nano-title-synthesis/harness.ts`):
waits for availability, selects junk-titled threads STRUCTURALLY (empty /
URL-shaped / title recurring verbatim across ≥3 threads — no vocabulary
lists), pulls thread markdown from the companion, prompts Nano with an
explicit content-only + SKIP-if-thin instruction, and prints
before→after + latency for human quality judgment. Read-only; no writes.

Rerun it against a browser whose profile has the model (daily Chrome with
`--remote-debugging-port`, or CfT if component delivery ever works) to
complete the quality gate.

## Decision

Ship only the feature-detected availability surface + user-intent
download affordance (Health panel). Title synthesis into `titleHints`
stays flag-gated OFF until the harness passes the quality gate on a
machine with the model. Per CODING_STANDARDS PoC-to-product rule, the
harness stays here; the product surface was written fresh.
