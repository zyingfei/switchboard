# Cost-of-change experiment — ledger (OUT OF REPO by design)

Branch: `refactor/cost-of-change` (off feat/agent-fixes-integration @ 51bd5026)
Probe executor: Agent tool, model=sonnet, effort=inherited-session(max, CONSTANT — deviation
from "high" noted: the Agent tool exposes no effort param; constancy preserved).
N=1 per stage. A run is VALID only if its own tests pass + non-test tsc clean.
Probe worktrees destroyed after metrics recorded; probes never commit.
The ONLY line that varies between probe runs is the stage SHA in the env preamble.

## FROZEN PROBE-1 (verbatim, every run)
In the Sidetrack companion (packages/sidetrack-companion), add a read-only diagnostic
feature: (1) a new authenticated endpoint GET /v1/system/change-probe returning
{ data: { ok: true, flag: <boolean: env SIDETRACK_CHANGE_PROBE, default true,
'0'/'false' disables> } }; (2) a changeProbe: { ok, flag } key in the GET
/v1/system/health response; (3) every result returned by the visits batch-resolve
endpoint gains a field probe: { seen: true } — on EVERY path that produces results,
including cached ones; (4) colocated bun tests covering all three behaviors, plus
flag-off; typecheck must stay clean for non-test files. Do not commit, push, or touch
any running process. At the end, report: number of files you read, number of
grep/search operations, number of files you edited, and your test output tail.

## FROZEN ENV PREAMBLE (every run; only <SHA> varies)
You are in an isolated git worktree of /Users/yingfei/playground/playground/browser-ai-companion.
First: `git checkout <SHA>` (detached is fine). Then symlink node_modules:
ln -s /Users/yingfei/playground/playground/browser-ai-companion/node_modules ./node_modules
ln -s /Users/yingfei/playground/playground/browser-ai-companion/packages/sidetrack-companion/node_modules ./packages/sidetrack-companion/node_modules
bun is NOT on PATH: prefix commands with PATH="$HOME/.bun/bin:$PATH". This package's
tests run with `bun test <files>` from packages/sidetrack-companion (NOT vitest).
Typecheck: npx tsc --noEmit -p tsconfig.json (errors inside .test.ts files are a
pre-existing baseline; non-test files must be clean). Never push, never commit, never
touch anything on ports 17374 or 11434.

## Stage hypotheses (pre-registered)
S1 pin tests: cost flat or ↑ (probe must also update inventory pins) — honest cost of a safety net
S2 extract route modules: largest ↓ (discovery)
S3 consolidate twin resolve seams: part-(3) cost halves
S4 health contributor registry: part-(2) near-constant
S5 composition root: marginal ↓
S6 (optional, control): predicted null
AMENDMENT (logged 2026-07-30, BEFORE probe@S4/S5 ran): S5 composition-root REPLACED by S5-prime single-unconditional-response-boundary, in direct response to the probe@S3 refutation below. New S5 hypothesis: part-(3) edit sites 2 to 1, modest token drop; the probe should stamp inside the one response builder. Composition root demoted to optional, alongside the null control.

## Results

| stage | sha | serverLoc | prodLoc | files | probe tokens | tool_uses | duration_ms | filesRead | searches | edited | valid |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S0 | 51bd5026 | 11382 | 122580 | 691 | 212364 | 120 | 1152197 | 14 (~36 reads) | ~40 | 5 | YES |
| S1 | 9e993031 | 11382 | 122580 | 694 | 241335 | 92 | 1210539 | 8 (srv@8 offsets) | ~30 | 5 | YES |
| S2 | 82355c14 | 1760 | 122892 | 720 | 233261 | 88 | 780992 | ~14 | ~15 | 7 | YES |
| S3 | 47558428 | 1790 | 122922 | 720 | 233514 | 93 | 1108693 | 15 | ~20 | 8 | YES |
| S4 | 6f7a837a | 1790 | 122999 | 720 | 222164 | 92 | 1004393 | ~13 | ~25 | 8 | YES |
| S5 | 5485f174 | 1809 | 123018 | 720 | 252896 | 88 | 976905 | 14 (srv@4 offsets) | ~20 | 9 | YES |

## Run log

- S1 landed 2026-07-30T18:52:26.077Z: 3 characterization files (122 routes ordered, 12 health keys, 7 result keys + 8-lane order), prod diff = one export keyword. bun test src/http: 314/1skip/0. tsc baseline byte-identical. Builder cost: 196,410 tok / 111 tools / 993s. DEVIATION: builder used git stash during verification (worktree-local, no damage).
- probe@S0 and probe@S1 in flight; S2 builder in flight.
- probe@S0 VALID 2026-07-30T18:53:13.119Z: 122/0 tests, tsc byte-identical baseline. Monolith symptom: server.ts alone read at ~16 offsets. Found BOTH resolve response sites. Worktree destroyed.
- probe@S1 VALID 2026-07-30T19:12:39.074Z: +13.6% tokens vs S0 — S1 hypothesis CONFIRMED (probe had to discover+update 3 pins). tool_uses DOWN 120→92 and server.ts offsets 16→8 (pins acted as documentation?). QUALITATIVE: S0 probe created system/changeProbe.ts module; S1 probe inlined the helper INTO server.ts — monolith gravity, same prompt, different placement (N=1 variance caveat). DEVIATION #2: probe used git stash for pre-existing-failure comparison (worktree-local). Worktree destroyed.
- S2 landed 2026-07-30T19:57:52.738Z: 82355c14 route extraction — server.ts 11382 to 1760 (split-length method), 25 route modules (8804 loc) + routeSupport.ts (1104), 121 routes moved, 2 left inline (batch-resolve mega-route + DEBUG_HEAP_SNAPSHOT dev routes, not in pinned 122). Pins UNMODIFIED (empty diff verified) + 315/0 http tests + 0 non-test tsc errors RE-VERIFIED BY LEAD in worktree. statusContract.test.ts legitimately updated (handler moved; still fails loudly if moved again). prodLoc +312 = extraction overhead (imports/segment arrays across 26 files). Builder cost: 514737 tok / 285 tools / 3603s (~2.4x a probe). Builder deviations (reality-driven): routeSupport holds stateful infra (readBody x23 users, TTL cache x6, SWR x4 — stateless-only would have kept most routes inline); fixed real ES-module bug (imported let cannot be reassigned — mutator moved with its state); dynamic import() paths needed same adjustment as static. NUL clean x28.
- probe@S2 VALID 2026-07-30T20:11:25.602Z: tokens 233261 (−3.3% vs S1, +9.8% vs S0) BUT duration 781s (−35% vs S0/S1) and searches ~15 (−62% vs S0) — extraction deleted DISCOVERY: probe went straight to routes/systemRoutes.ts, colocated flag helpers with both consumers (placement improved vs S1 monolith-inline). Residual cost = (a) 3-pin update tax (constant by design) + (b) part-(3) twin seam: probe again touched BOTH batch-resolve returns — exactly S3 target. 7 files edited (2 prod + 5 test). S2 hypothesis (largest drop): CONFIRMED on wall-clock+searches, NOT tokens (yet). Worktree destroyed.
- S3 landed 2026-07-30T20:14:48.153Z: 47558428 single finalize seam — finalizeBatchResolveResults (server.ts ~792, module scope) does the full per-URL decoration sequence (title/gist, appendContentLane, appendAiLane, applyLaneDecisions, prediction entries) ONCE; both terminals (sqlite + plain-store fallback) call it; adding a cross-cutting per-result field is now ONE edit site. ONE file changed (+111/−81; net +30 = doc comment). Pins UNMODIFIED (empty diff) + 315/0 + tsc 0 non-test RE-VERIFIED BY LEAD. Note: fallback path restructured resolve-then-decorate (was interleaved per-URL) — wire-identical (throws 500 whole request either way; per-URL decoration independent). Builder cost: 215122 tok / 65 tools / 913s — S3 build ~= one probe cost.
- probe@S3 VALID 2026-07-30T20:34:57.040Z: tokens 233514 (FLAT vs S2, +0.1%), duration 1109s (UP vs 781s), 8 files edited. S3 HYPOTHESIS REFUTED — probe REFUSED the new seam: it found finalizeBatchResolveResults is invoked under guessLanesEnabled+contentLaneEnabled, and PROBE-1 part (3) demands an UNCONDITIONAL field, so it stamped at BOTH response tuples and wrote a test proving the stamp survives SIDETRACK_CONTENT_LANE=0. THE FINDING: the seam contract (flag-gated lane decoration) is narrower than the change class (unconditional wire field); the change routed around the abstraction. Part-(3) is still a 2-site edit. Placement quality good (created system/changeProbe.ts module like S0 probe). Worktree destroyed.
- S4 landed 2026-07-30T20:34:57.040Z: 6f7a837a health contributor registry — 4 named contributors (baseReport/reliability/laneCalibration/vaultLedger); scratch slot carries the one real inter-key dependency (reliability reads baseReport); Object.assign fold reproduces spread insertion-order semantics incl. re-touched observability slot; adding key foo = one registry entry. ONE file (+324/−247, net +77 mostly moved blocks). Two honest double-casts (HealthReport lacks index signature). Pins UNMODIFIED + 315/0 + tsc-0 RE-VERIFIED BY LEAD. Builder: 216079 tok / 63 tools / 1059s.
- S5 landed 2026-07-30T20:44:11.551Z: 5485f174 single unconditional response boundary — buildBatchResolveResponse(results, snapshotRevision), sync, ZERO flag checks, both terminals return ONLY through it; builder proved the two original terminal blocks byte-identical modulo indentation BEFORE extracting; finalize seam untouched. ONE file (+33/−14). Pins UNMODIFIED + 315/0 + tsc-0 RE-VERIFIED BY LEAD. Builder: 126348 tok / 74 tools / 467s — CHEAPEST builder yet (small step on refactored base).
- probe@S4 VALID 2026-07-30T20:52:05.439Z: 222164 tok (−4.9% vs S3, first sub-S1-baseline move toward S0), 92 tools, 1004s. Part-(2) HYPOTHESIS CONFIRMED: probe appended ONE healthContributors entry and QUOTED the registry doc line (append ONE entry... nothing else changes) as its extension point — the structure taught the agent. Part (3) still 2 sites at this SHA (S5 boundary not yet present — as designed). Extra diligence: +8 related test files beyond http/system (83/0). Worktree destroyed.
- probe@S5 VALID 2026-07-30T21:01:48.033Z: 252896 tok — HIGHEST run, yet structurally BEST: part (1) route module, part (2) ONE registry entry, part (3) inside buildBatchResolveResponse (THE boundary) with a correctness insight none of the earlier probes had — shallow-copied each result so the stamp cannot leak into resolver/SWR caches holding the same object references pre-boundary (earlier probes plausibly mutated cached objects; the explicit boundary made the aliasing hazard VISIBLE). Token rise explained by diligence variance: read AGENTS.md+CODING_STANDARDS.md (no earlier probe did), added 2 extra cache-path test cases, touched 9 files. server.ts read at only 4 offsets (vs 16 at S0). CONCLUSION SIGNAL: tokens are noise-dominated (212-253k band, N=1); the reliable movers are edit-site structure (2 to 1), wall-clock (19-20 min to 13-17 min), searches (~40 to ~15-25), monolith paging (16 to 4 offsets), and BUILDER cost (515k to 126k). Worktree destroyed.
- S6 NULL CONTROL SKIPPED 2026-07-30T21:01:48.033Z: pre-registered as optional; the S2-S5 token band already brackets run-to-run variance, one more N=1 sample cannot separate signal from noise, and the user goal (the refactoring itself) is complete. Logged rather than silently dropped.
- FULL-SUITE GATE 2026-07-30T21:05:41.900Z: main tree @5485f174 bun test = 2981 pass / 8 skip / 0 fail across 328 files (72.5s). Trailing panic(main thread) C++ exception is the KNOWN bun-1.3.14 at-exit panic (fires AFTER the summary; the CI bun-exit-panic wrapper exists for it). Leftover S1-builder worktree (stage-s1) removed.
