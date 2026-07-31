# Cost-of-change experiment: refactoring server.ts under measurement (S0–S5)

2026-07-30 · branch `refactor/cost-of-change` (off `feat/agent-fixes-integration` @ 51bd5026)

## Method

Kent-Beck-style discipline, instrumented: freeze one representative change
("PROBE-1": add an authenticated `GET /v1/system/change-probe` endpoint + a
`changeProbe` key in `/v1/system/health` + an unconditional `probe: {seen: true}`
on every batch-resolve result including cached ones + colocated tests), then in a
loop: land ONE refactoring step, and have a **fresh agent with no prior context**
implement the identical frozen prompt at that stage's SHA, in an isolated
worktree. Record cost, throw the change away. The only line that varies between
probe runs is the stage SHA. A run is valid only if its own tests pass and
non-test `tsc` is clean. Probes never commit; worktrees are destroyed after
metrics are recorded so no probe can see another's work.

Three characterization tests added at S1 (exact 122-route dispatch order, health
key inventory, batch-resolve result shape) are the referee for every refactoring
step: builders may not modify them; probes must update them (that cost is part of
the measurement).

Executor: sonnet agents, settings held constant. Costs are harness-metered
(`subagent_tokens`, `tool_uses`, `duration_ms`), not self-reported. LOC =
`split('\n').length` summed over non-test `.ts` in `packages/sidetrack-companion/src`.

## The curve

| stage | refactoring landed | server.ts LOC | probe tokens | tools | minutes | searches | files edited |
|---|---|---|---|---|---|---|---|
| S0 | (monolith baseline) | 11,382 | 212,364 | 120 | 19.2 | ~40 | 5 |
| S1 | characterization pins | 11,382 | 241,335 | 92 | 20.2 | ~30 | 5 |
| S2 | 25 route modules + routeSupport | 1,760 | 233,261 | 88 | 13.0 | ~15 | 7 |
| S3 | single lane-decoration seam | 1,790 | 233,514 | 93 | 18.5 | ~20 | 8 |
| S4 | health contributor registry | 1,790 | 222,164 | 92 | 16.7 | ~25 | 8 |
| S5 | unconditional response boundary | 1,809 | 252,896 | 88 | 16.3 | ~20 | 9 |

Builder (refactoring) costs: S1 196k tok/17 min · S2 515k/60 min · S3 215k/15 min
· S4 216k/18 min · S5 **126k/8 min** — monotonically cheaper after the big S2
lift: small steps on a refactored base are cheap to take.

## Hypotheses vs outcomes

- **S1 "pins cost flat or ↑" — CONFIRMED** (+13.6% tokens). The probe must
  discover and update three pin files every run; that is the safety net's
  subscription fee. Counter-effect: tool calls fell 120→92 and server.ts paging
  fell ~16→8 offsets — the pins double as documentation (the probe read the
  route inventory instead of spelunking for it).
- **S2 "largest drop" — CONFIRMED on wall-clock (−35%) and searches (−62%), NOT
  on tokens** (−3.3%). Extraction deleted *finding* cost; *doing* cost stayed.
- **S3 "part-(3) cost halves" — REFUTED.** The probe *refused the seam*: it
  found `finalizeBatchResolveResults` is invoked under
  `guessLanesEnabled && contentLaneEnabled()` while PROBE-1 demands an
  unconditional field, so it stamped both response tuples directly — and wrote a
  test proving its field survives `SIDETRACK_CONTENT_LANE=0`. The seam's
  contract (flag-gated lane decoration) was narrower than the change class
  (unconditional wire field). **A seam that doesn't match the change class gets
  routed around — by a correctly-reasoning agent.**
- **S4 "health key near-constant" — CONFIRMED.** The probe appended one
  `healthContributors` entry and *quoted the registry's own doc line* as its
  extension point. Structure taught the agent.
- **S5 (amended after the S3 refutation; logged before the probe ran) —
  structurally CONFIRMED, token-noise caveat.** The probe used all three seams —
  route module, registry entry, and `buildBatchResolveResponse` — and produced
  the best-engineered implementation of the series: it shallow-copied each
  result at the boundary so the stamp cannot leak into the resolver/SWR caches
  that hold the same object references pre-boundary. The explicit boundary made
  an aliasing hazard visible that every earlier probe silently skirted. Tokens
  nevertheless ROSE to the series maximum: this probe also read
  AGENTS.md/CODING_STANDARDS.md (none before it did) and added extra cache-path
  tests — diligence variance dominates.
- **S6 null control — SKIPPED, logged**: at N=1 another sample cannot separate
  signal from noise, and the goal (the refactoring) was complete.

## Signal vs noise

Probe **tokens are noise-dominated** (212–253k band, single-digit-% moves,
diligence variance between runs larger than most stage effects). The reliable
movers were:

- **Edit-site structure**: part (2) collapsed to one registry entry (S4); part
  (3) collapsed to one boundary function (S5); part (1) was a clean module
  insert from S2 on. This is the real "cost of change" — the risk surface.
- **Wall-clock**: 19–20 min (S0/S1) → 13–17 min (S2+).
- **Discovery effort**: searches ~40 → ~15–25; server.ts read at 16 offsets
  (S0) → 4 (S5).
- **Decision quality**: S1's probe inlined helpers into the monolith (code
  accretes where code already is); S2+ probes created/used proper modules; S5's
  probe caught the cache-aliasing hazard.
- **Builder cost**: 515k → 126k per step after the base was refactored.

## Verification record

Every stage: builder diff reviewed by the lead; pins verified byte-untouched
(`git diff` empty on all three files); http suite re-run by the lead in the
builder's worktree (315/0); non-test `tsc` re-checked (0 errors); NUL-byte scan
on every changed file. Full companion suite at the S5 tip: **2,981 pass / 8
skip / 0 fail across 328 files** (the trailing `panic: A C++ exception occurred`
is the known bun-1.3.14 at-exit panic, which fires after the summary; CI wraps
it). One latent production bug was found and fixed by the S2 move itself: a
module-level `let` reassigned by an exported helper — legal inline, illegal
across an ES-module import boundary, so the mutator moved with its state.

## Limitations

N=1 per stage by design (user directive); one change class probed; probes pay
the pin-update tax from S1 onward (a constant added to every post-S0
measurement); agent diligence varies run to run and is the largest token factor;
sonnet-class executor, effort inherited constant.

## What to keep

1. The three characterization pins — they refereed five refactorings without a
   single wire regression and demonstrably serve as documentation.
2. The registry and boundary patterns — both were *used unprompted* by later
   probes, which is the only proof of an abstraction that matters.
3. The lesson of S3: before building a seam, name the change class it must
   absorb — including whether that class is conditional or unconditional. A
   seam with the wrong contract is routed around, at full cost, by agents
   reasoning correctly.
4. The probe technique itself: a frozen representative change is a cheap,
   repeatable seam detector — it found the flag-gating mismatch no review
   caught.

## Post-hoc verification (2026-07-31)

Beyond the per-stage referees, the outcome was verified end-to-end:

- **Pin integrity at branch level**: zero commits touch the three
  characterization files after S1; `git diff 9e993031..tip` on them is empty.
- **Dist builds**: `tsc -p tsconfig.build.json` clean at both the fork point
  and the tip — the 26 extracted modules and adjusted dynamic imports survive
  the build path, not just `bun test`.
- **Dist-gated tests un-skipped**: against the freshly built tip dist,
  `statusContract` runs 2/0 (its bundle check no longer skips) and the 13-test
  `connectionsHnswReconcileIntegration` suite — the "pre-existing failure"
  class in every worktree — passes 13/0, spawning real children from the
  refactored dist.
- **Live A/B**: two isolated companions (fork point 51bd5026 vs tip) booted
  from their own dists on throwaway vaults/ports; identical probes against
  `/v1/status`, `/v1/system/health`, `/v1/system/vault-ledger`,
  `POST /v1/visits/batch-resolve`, and an unknown route. The full-response
  diff contains only timestamps, request IDs, and ms-scale timing jitter —
  every key, key order (12 health keys; 7 result keys), and semantic value
  identical, including the conditional omission of the vault-ledger health
  key on a fresh vault behaving the same on both sides.
- **No experiment contamination**: live batch-resolve results carry no
  `probe` field — the throwaway change exists only in destroyed worktrees.
