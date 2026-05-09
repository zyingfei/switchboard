# T1 — Local user-session validation harness

**Status**: Wave 1 (charter) — design only, no implementation
**Track**: Testing infrastructure (T1)
**Date**: 2026-05-09

## What this track is

A local-only record / replay / evaluate harness that augments the
deterministic L5 spec landed in PR #109/#110. The user records a
real workflow once; the system replays it locally against the same
extension / companion / relay code paths a real user drives; the
evaluator produces a report distinguishing page-replay,
extension-observation, companion-projection, graph-materialization,
and evaluation-expectation failures.

It is **test infrastructure**, not a product milestone.

## Source artifacts

- [`CHARTER.md`](./CHARTER.md) — load-bearing design contract for
  Wave 2. Answers the design questions, freezes the `SessionPack`
  v1 schema, and names the privacy / replay / evaluation contracts
  Wave 2 must satisfy.
- [`AGENT-PROMPT.md`](./AGENT-PROMPT.md) — paste-ready handoff for
  the Wave 2 coding agent.

## Sequencing

| Wave | Branch | Deliverable |
|---|---|---|
| 1 — Charter | `t1/record-replay-charter` | This folder. No code. |
| 2a — One-browser slice | `t1/record-replay-2a` | record + replay one browser, `captureLevel: minimal`, five-layer evaluator, markdown + JSON report. |
| 2b — Two-browser relay | `t1/record-replay-2b` | record + replay two browsers + relay, add opt-in `captureLevel: html`. |
| 2c — Detours + warnings + scoring | `t1/record-replay-2c` | first-class detour classifier, qualitative warnings, graph-quality scoring (R18), `captureLevel: html+paste` (explicit flag), report polish. |
| 2d — CLI tool | `t1/record-replay-2d` | small `sidetrack-test` CLI wrapping `record` / `replay` / `report` / `list` / `inspect`; thin shell over the Playwright manual specs. |

Each Wave 2 slice is a separate PR; Wave 2a's helpers are reused
by every later slice.

## Done criteria for Wave 1

- `CHARTER.md` answers the design questions in order.
- `SessionPack` v1 type and the versioning rule are present and
  frozen in `CHARTER.md`.
- `AGENT-PROMPT.md` is self-contained for any coding agent.
- No code changes. `scripts/verify-standards.sh` passes.

## Reading order

1. The original brief (the proposal that prompted this track).
2. The PR #109/#110 manual brief at
   `docs/proposals/stage-4-collector-framework-briefs.md`.
3. This `CHARTER.md`.
4. `AGENT-PROMPT.md` once Wave 2 work begins.

## Out of scope

The deliberate non-goals are listed in
[`CHARTER.md` §6](./CHARTER.md#6-whats-in-v1-vs-follow-up). The
load-bearing ones:

- No live-mode replay in v1 (stubbed only; schema is forward-compatible).
- No screenshots, ever.
- No CI gating — T1 is user-driven.
