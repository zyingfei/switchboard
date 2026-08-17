# CI

Two gates exist for this repo, and they check different things on
purpose. Confusing them — treating a green hosted-CI run as "the build
is fine" or skipping `bun run verify` because hosted CI is green — is
the failure mode this doc exists to prevent.

## `bun run verify` — the local full gate

```bash
bun run verify
```

Runs, in order, across every package (`bun run --sequential --filter
'./packages/*' <script>`): `format:check`, `lint`, `typecheck`,
`test`, `build`. This is the **authoritative "did I break anything"
check** — it is the only thing that runs `build` (including `wxt
build` for the extension) and `lint`/`format:check` for every package.
Run it before opening a PR. It is slower than any single hosted-CI job
(it is sequential across packages, not parallel jobs) and is not
itself run in hosted CI — hosted CI reimplements the parts that matter
for a fast, parallel PR signal (see below), not `verify` verbatim.

## Hosted CI (`.github/workflows/ci.yml`)

Runs on every PR and on push to `main`. Five jobs, parallel:

| Job | Blocking? | What it runs | Runtime (measured) |
| --- | --- | --- | --- |
| `companion` | **Yes** | `tsc -p tsconfig.build.json` (build gate; also produces `dist/` for child-process tests), `bun run test:golden` (resolve-quality referee), full `bun test` (includes `src/integration/extensionCompanionSpine.test.ts`, the cross-package spine — see below). `SIDETRACK_SQLITE_LIB=off`. | ~3-3.5 min on GitHub's ubuntu-latest (see recent `main` runs) |
| `extension` | **Yes** | `wxt prepare`, `tsc --noEmit`, `vitest run` (unit tests only — `tests/e2e/` excluded by `vitest.config.ts`) | ~1 min |
| `mcp` | **Yes** | `tsc --noEmit`, `vitest run` | ~30s |
| `vector-real-dim` | **Yes** | A scoped `bun test` over the sqlite-vec-backed store suites, WITHOUT the `SIDETRACK_SQLITE_LIB=off` opt-out — real 384-dim vectors through the real extension. See "Why a separate vector lane" below. | ~0.4s locally (macOS, real vec-capable libsqlite3); comfortably under the 2-minute blocking bar |
| `package-smoke` | No (advisory — `continue-on-error: true`) | `wxt build` (real extension artifact) + companion `tsc` + `stamp-build.mjs` (real `dist/cli.js`), boot the compiled companion against an empty temp vault, assert `/v1/version` reports a `buildSha`, send `SIGTERM`, assert clean exit inside the shutdown watchdog's grace window. | ~15-20s |

None of the five jobs' scripts are literally `bun run verify` — each
reimplements the subset relevant to that package/concern so PRs get
fast, parallel, per-package failure signal instead of one slow
sequential run. `lint` and `format:check` are NOT gated in hosted CI
(they run in `verify` only) — a style violation doesn't block a PR
merge today; that's a known, accepted gap, not an oversight.

### Why browser e2e stays out of the blocking path

Issue #143 is the concrete motivation: PR #141 shipped with
`/v1/edge/events` effectively unreachable and nothing in hosted CI
caught it, because at the time **there was no hosted CI at all**
(`gh api .../actions/workflows` returned `total_count: 0`; no
`.github/` directory existed). The obvious fix — run
`packages/sidetrack-extension/tests/e2e/connections-full-browser-sync-user-story.spec.ts`
with live browsers on every PR — was considered and rejected for the
blocking path: that spec drives real Chrome for Testing against real
provider-page fixtures, taking minutes, and is exactly the kind of
non-deterministic, environment-heavy check the "honest CI" principle
in `ci.yml`'s own header comment rules out for a fast PR gate. It
still exists and still runs manually / in the live-check loop
documented in `docs/dev-testing.md` — it is not deleted, just not
wired to block merges.

Instead, `companion`'s `src/integration/extensionCompanionSpine.test.ts`
is the **deterministic substitute** #143 explicitly asks for ("split
out a smaller deterministic e2e/smoke"): it boots a real
`createCompanionHttpServer` / `startHttpServer` instance (no browser),
replays the extension's real wire shapes for the canonical loop —

1. `POST /v1/edge/events` with a batch built via the extension's real
   `edge-event-drain.ts` (`PRIORITY_STREAMS` +
   `partitionEdgeEventDrainBatch`, imported directly — not
   reimplemented) — this is #143's exact ask #2, "companion accepts
   POST /v1/edge/events", and would fail loudly (503/404) on a
   missing or renamed route.
2. `POST /v1/timeline/events` with a `browser.timeline.observed`
   event — the plugin-originated "edge event" (per that route's own
   header comment) that actually feeds the URL projection fold.
3. `POST /v1/page-content/extracted` via the extension's real,
   shipped `PageContentClient.index()` — not a hand-rolled fetch.
4. Drain/materialize via `SyncContractRunner.awaitIdle()` — the
   companion's own readiness signal (documented in `runner.ts` as
   "used by tests"). No sleeps.
5. `GET /v1/timeline`, `GET /v1/visits/inbox`, and `GET
   /v1/page-content/coverage` all show the visit — three independent
   read paths, so a stage silently mis-reading another stage's data
   (not just a missing route) also fails the test.
6. Re-POST the same edge-event batch (idempotent replay) and read the
   durable event log back directly, proving the substrate every
   materializer catches up from actually recorded
   `engagement.session.aggregated` — #143's ask #3, generalized past
   "the HTTP call returned 200."

Runs deterministically (verified 3x locally, ~300ms each run) and
carries a provenance comment in the test file documenting exactly
which pieces are imported from the extension's real source vs
hand-built to satisfy the companion's own runtime validators.

### Why a separate vector lane

`companion`'s `SIDETRACK_SQLITE_LIB=off` opt-out exists so low-
dimension test fixtures elsewhere in that suite don't hit strict
vec-column dimension enforcement (see that job's inline comment).
That means the blocking gate, as originally configured, was never
guaranteed to exercise sqlite-vec at the real embedding dimension
(384 — `recall/embedder.ts`, `RECALL_MODEL.embeddingDim`) end to end.

Verification note (2026-08-17): a `gh run view` on a recent green
`main` run showed `SIDETRACK_SQLITE_LIB=off` does **not** actually
prevent sqlite-vec from loading on GitHub's `ubuntu-latest` runner —
`prototypeLaneWiring.test.ts`'s hard `vectorBackendAvailable===true`
assertion already passes there today, and the job log shows
`sqlite-vec loaded via bun-sqlite` despite the opt-out. That is a
pre-existing platform discrepancy (Bun's Linux-bundled SQLite appears
to support extension loading where its macOS build does not),
unrelated to this change, and out of scope to fix here — flagged, not
silently fixed. It does confirm the `vector-real-dim` job's core
assumption empirically: real vec-capable sqlite is genuinely available
on this exact runner type.

`vector-real-dim` makes the real-dimension lane explicit and scoped:
it runs the suites that are genuinely vector-dependent (touch
`docs_vec` directly, or assert `store.vectorBackendAvailable`) without
the opt-out, so a real column-width mismatch between the embedding
manifest and the vec schema fails loudly instead of never being
exercised. It is deliberately narrow — not the whole `companion`
suite, which still carries low-dimension fixtures this lane isn't
meant to fix (a wider combination hit an unrelated cross-file flake
during local investigation; see the job's inline comment).

### Why `package-smoke` is advisory, not blocking

`wxt build` (real esbuild/rollup bundling, ~106MB of output including
onnxruntime-web WASM) and a real `bun dist/cli.js` child process with
signal handling are more exposed to environment-specific flake
(bundler version drift, runner resource limits under process spawn)
than a pure `bun test` unit run — categorically different risk profile
than the four blocking jobs. It starts advisory; promote it to
blocking once it has run clean across a run or two of real PR traffic.
