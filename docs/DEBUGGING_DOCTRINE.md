# Debugging & verification doctrine

Born from the 2026-07-21→24 incident week: four independent ways one
user-facing signal (workstream suggestions) silently went to zero —
a write-queue collapse, an event-buffer starvation, an empty-corpus
cache poisoning, and a render-layer edge wipe — three of which were
"fixed" once each before the real fix landed, because each fix
verified one abstraction above what the user actually sees. These
rules are binding for agents and humans working on this repo. If a
rule seems wrong for a case, say so explicitly and cite evidence —
do not silently skip it.

## Rules of diagnosis

1. **Evidence before prediction.** Never tell the user what a surface
   "should" show based on an intermediate layer. Verify at the
   artifact that surface reads, quote the measurement (query, count,
   timestamp), then predict. The served artifacts are:
   - suggestions/attribution → `current.db` `edges_index` + the
     resolve response itself (`POST /v1/visits/batch-resolve`)
   - engagement → `engagement.session.aggregated` events in
     `event-store.db` (not intervals, not the durable mirror)
   - panel state → what the panel's endpoint returns *at that
     moment*, including error responses (a 500 renders as a card
     too).
2. **Regression means find the last-good timestamp first.** When the
   user reports "this worked before," the first question is *when
   did it last work* (diff diagnostics history, event timestamps,
   file mtimes, git log around that date) — not whether today's
   state has a plausible explanation. Every incident this week was
   initially mis-called "standing behavior" because the explanation
   was plausible and the history window was too short.
3. **"Designed this way" requires a citation.** To close a report as
   intended behavior you must cite the design anchor (BRAINSTORM §,
   ADR, or code comment that predates the report) AND show the
   behavior matches it. Otherwise treat it as a defect. The user has
   explicitly rejected unevidenced "designed this way" answers.
4. **Reproduce at real scale.** Unit-scale reproductions have hidden
   every performance defect in this repo (leiden at N=6, typed reads
   at 452k events, similarity at 6 items vs 9k visits). Perf and
   corpus behavior must be checked against the real vault
   (~700MB event store, ~9k-visit corpus) or a generated equivalent.
5. **User-visible flapping = alternating states, not steady error.**
   If a symptom is intermittent, diff a good instance against a bad
   instance of the *same operation* (drain diagnostics history is
   retained for this). Bimodality is a fingerprint, not noise.

## Rules of design (signal-carrying pipelines)

6. **Absent ≠ empty.** Any stage consuming an input lane must
   distinguish "lane not loaded on this path" from "lane genuinely
   empty." An unloaded lane must never flow downstream as an empty
   corpus, and a degenerate result (hash-of-empty) must never be
   persisted or cached under a valid key.
7. **Served-signal floors.** A user-facing signal may not silently
   collapse. Guards live at the WRITE SEAM OF THE SERVED ARTIFACT
   (the table resolvers read), not at the revision/build layer above
   it. Collapse requires a recorded reset reason (privacy purge,
   model change, version bump, operator rebuild); otherwise repair/
   carry forward and raise a health state that is visible and
   DECAYS when clean (no permanently-stuck alarms).
8. **Every queue is bounded and every producer is deduplicated.**
   Arrival rate must be provably ≤ service rate, or the queue must
   shed/coalesce (snapshots supersede; zero-delta events are not
   produced). The two collapses this week were both unbounded queues
   fed by zero-information events (552 identical captures/hr; 76
   idle beacons/min into a 10/min drain).
9. **Runtime-agility bar.** One user browsing lightly: seconds-scale
   work per single event is a bug to root-cause, not debt (see
   memory: the companion serves ONE person; ms-scale writes, idle
   ~0% CPU).

## Rules of fixing

10. **Acceptance tests read back the store.** A fix's test writes
    through the real path and reads the SERVED artifact back
    (`current.db`, the HTTP response, the buffer contents). Testing
    the layer you changed is how two incomplete fixes shipped in one
    day. If the test doesn't read what the user reads, it doesn't
    count as acceptance.
11. **Verify the fix against the live failure before closing.** Unit
    green is necessary, not sufficient: deploy to the test companion
    (:17374) and watch the actual drain/serve cycle produce the
    right artifact (a monitor on the served table, not on logs).
12. **Fix the class, then the instance.** Each incident gets (a) the
    direct repair and (b) the invariant that makes the class
    impossible or loudly visible. If (b) is deferred, it is written
    down as tracked debt with the trigger condition.

## Diagnostic toolkit (verified recipes)

- **HTTP log**: `SIDETRACK_HTTP_LOG=1` → `/tmp/sidetrack-http-debug.log`.
  Includes non-2xx (since 2026-07-24). Latency trends per endpoint;
  climbing POST durations = serial queue backlog.
- **Drain forensics**: `~/.sidetrack-vault-test/_BAC/connections/diagnostics/history/*.json`
  (retained ~2 days). Per-drain similarity/engagement/floor sections.
  Diff good-vs-bad drains; `similarityFloor` reports the terminal
  `renderedSimilarityFamilyEdgeCount` + `renderRepaired`.
- **Served graph**: read-only sqlite:
  `sqlite3 "file:$HOME/.sidetrack-vault-test/_BAC/connections/current.db?mode=ro" "SELECT kind, COUNT(*) FROM edges_index GROUP BY 1;"`
- **Event history**: same pattern against `event-store.db`
  (`events` table: type, accepted_at_ms, payload LIKE …).
- **Extension internals via CDP** (test browser :9222, raw Bun
  WebSocket; playwright hangs): SW target from `/json`;
  `globalThis.__sidetrackEngagementDiag` (rolling 50);
  `sidetrackDebug.*` (build, engagementBufferCount,
  drainEdgeEventsBulk, compactEdgeEventBuffer); `chrome.storage` and
  `indexedDB` are directly evaluable in the SW context.
- **CPU attribution**: `sample <pid> 5` (sqlite3_step dominance =
  scan-heavy queries); `screen -X hardcopy -h` for phase logs
  (`SIDETRACK_CONNECTIONS_PHASE_LOG=1`).
- **Companion process discipline**: test instance :17374 / vault
  `~/.sidetrack-vault-test`, screen `sidetrack-companion-test`,
  launch via `scripts/run-test-companion.sh`; kill precisely (port
  or screen name), never broad pkill; `/v1/version buildSha` vs
  `git rev-parse --short HEAD` catches stale dist.

## Signal-flow reference (what feeds what)

```
page (content scripts: engagement.ts 30s beacons·finals, evidence)
  → SW handlers (capture gates: master switch, host-scoped blocklist)
  → IndexedDB edge-event buffer  [priority: session.aggregated, navigation.committed;
                                  boot compaction; zero-delta suppression]
  → POST /v1/edge/events (batched import, validators; skips are SILENT to sender)
  → sync event log (JSONL shards) + event-store.db mirror (typed idx)
  → contract runner → materializer drains
      paths: warm scoped-delta | full rebuild | reconcile CHILD fork |
             chunked boot catch-up | gap-seal   ← path-dependent input
             assembly is the historic defect surface (rule 6)
  → visitSimilarity build  [engagement gate ≥5s from session.aggregated;
                            Layer-0 build floor; revision store]
  → snapshot render  [edge survival filter: BOTH endpoints must exist —
                      rendered floor + endpoint-completion repair here]
  → current.db (THE SERVED ARTIFACT; parent/child drains race on it,
                last writer wins)
  → resolve family (+SWR cache; resolver-cache writes are best-effort
                    on SQLITE_BUSY) → panel
  → panel states: populated > error("busy — retrying") > empty > pending
```

Chat captures take a parallel lane: POST /v1/events → capture
admission gate (content dedup + per-thread latest-wins) → legacy
store + CAPTURE_RECORDED mirror → same materializer fan-in.

## Known standing debt (check before re-diagnosing)

See auto-memory index for the live list. As of 2026-07-24: upstream
window-poor corpus assembly (floor repairs it; renderRepaired alarm),
P0-A per-drain materializer cost, end-to-end resolve canary not yet
built, purge tombstone still eTLD+1-wide vs host-scoped rules,
doc-vector coverage ~14% (background embedding off).
