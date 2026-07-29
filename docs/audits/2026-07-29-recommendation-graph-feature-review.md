# Recommendation & graph — feature review from first principles

**Date:** 2026-07-29 · **Vantage:** post PR #315–#326 (on-device AI engines, guess lanes 7+8,
lane-fallback, hub guard, resolver-core perf, sim-floor widen + drain-liveness repair), reviewed
against the live dogfood vault (~4.8k nodes / 66k edges full graph, 63,221 similarity-family
edges, 1,290 evidenced pages, 2,749 labels).

**Method:** first-principles requirements for a *local-first personal browsing organizer*,
checked against what is actually built and what the last 72 hours of live operation demonstrated.
Evidence over architecture diagrams: where a claim below has a number, it was measured this week.

---

## 0. The first-principles frame

A personal recommender that files your browsing into workstreams has exactly five jobs:

| # | Job | The question it must answer |
|---|-----|------------------------------|
| J1 | **Signal capture** | Did we observe enough of what the user did, cheaply and privately? |
| J2 | **Representation** | Do pages/threads/workstreams live in a structure where "belongs with" is computable? |
| J3 | **Decision** | Given partial evidence, produce the *best current guess* with honest uncertainty. |
| J4 | **Learning** | Does every user correction make the next guess better — measurably? |
| J5 | **Trust** | Can the user see why, veto cheaply, and believe the confidence language? |

The system's stated wedge (zero-outbound privacy + felt memory) adds a sixth: **J6 — everything
above must run on-device at interactive latency.**

Scorecard up front:

- J1 capture: **strong** (event-sourced, admission-gated, engagement, selections, threads).
- J2 representation: **strong on edges, weak on entities** (§2).
- J3 decision: **structurally excellent, numerically starved** — the honest-disclosure machinery
  (lanes, typed emptiness, fallback) now outclasses the fusion it discloses (§1).
- J4 learning: **the widest gap.** The loop exists on paper; almost nothing served is learned
  (ship-gate `fail: active-model-does-not-beat-comparison-baseline`, serving unenforced,
  0/671 historical auto-attributions) (§3).
- J5 trust: **strong and recently strengthened** (lanes, `· gist` provenance, unconfirmed
  labels, no fake percents) — but confidence language is *suppressed* rather than *calibrated* (§4).
- J6 on-device: **now strong** (Apple FM 4.1s/0.61 grounded; resolve p95 tamed; drains resumable)
  with two honest holes: Chinese, and first-drain cold cost (§5).

---

## 1. Gaps — ranked by user-felt cost

### G1. Fusion ignores its best signals (the decision layer is starved)

The content lane (query-time full-vector + BM25 over the recall store) and the AI lane
(gist-only query) are demonstrably the *most informative* signals on exactly the pages that
need help — junk-titled arXiv ids, bare URLs, features-only pages. Live Kimi case: six
structural lanes empty, content+AI both correct — decision `held: corroboration 1 < 2`,
because **lane agreement does not count as corroboration**. The lane-fallback (#326) papers the
*display* gap honestly, but the decision itself still cannot use the evidence.

*Why it's the top gap:* every other investment (gists, engines, hub guard) funnels into lanes
that terminate in a UI row. The marginal value of better gists is capped by fusion blindness.

### G2. Two similarity systems that can drift apart

Materialized visit-similarity (engagement-gated ≥5s, own embed path, HNSW store, floor guard)
and the recall-store KNN (chunk vectors, feeds lanes) are separate corpora with separate
lifecycles. This week's incidents were all seams of that duality: the floor "expectation"
shifting (59,908 → 63,221), the cold-cache full-embed freeze, `peekRecallV2Store` leaving lanes
dead after restarts. Two systems answering "what is similar?" will keep disagreeing in ways
that cost investigation days.

### G3. The learning loop is decorative

Impressions/actions/trainable emission exist; the trained ranker **loses to the title-lexical
baseline** and the gate that would block it from serving is unenforced (it serves nothing
anyway). There is no golden labeled set, no prequential readout an operator looks at, and no
calibration mapping scores → words. Concretely: 2,749 labels exist and essentially none of the
serving path's behavior changes when a new one lands (beyond graph edges).

### G4. Entities are generated and thrown away

Every gist ends with `Key Entities: …` — extracted by a 3B model, validated, saved — and then
treated as opaque prose. No entity nodes, no cross-page entity edges, no "show me everything
touching Kimi Delta Attention." The graph has URL/thread/workstream nodes and communities
(`forum:`/`author:`), but the *conceptual* layer the AI already produces is discarded at the
moment it exists.

### G5. Declines are captured but not consulted

`Not in any stream` writes a real negative — and this week's fallback happily re-suggested a
workstream on a page carrying `user declined — not in any stream` in its own gate detail.
Negative labels are the cheapest, highest-precision signal a personal system gets; today they
gate one arm and are invisible to lanes/fallback.

### G6. Sessions exist as capture, not as context

Tab-session resolver is dry-run only. Serving treats each page independently; "the other tabs
open right now" — the strongest single prior for *what task is this page part of* — never
enters the decision. (The Now card literally knows the session id.)

### G7. Chinese remains an end-to-end hole

Nano and Apple FM refuse zh (measured, despite advertised support); the only zh-capable engine
(WebGPU gemma) answers zh pages in English, which the validator rightly rejects; every small
in-browser alternative bake-offed 0/6 valid. So zh pages get: no gist → no AI lane → weaker
content lane. For a bilingual vault (15+ pure-zh pages found in one scan) this is a visible
quality cliff along language lines.

### G8. Liveness/observability are conventions, not contracts

Three separate incidents this week shared one root: *long work with no output* (phase marks
flag-gated; heartbeat demonstrably fragile; 18h frozen vault read as one quiet health row).
The fixes ("long phases speak on stdout", inflight-tagged stalls) are patterns — nothing stops
the next long phase from being written silent. Also: rig vs production launcher env diverged
(`SIDETRACK_EVENT_STORE`), which is exactly how the widen bug shipped against an untested
configuration.

### G9. No ranking-quality regression net

Resolve *plumbing* is well-tested; resolve *quality* is not. The Binance mis-ranking, the
false-friend, the hub-magnet class — each was caught by a human eyeball on a live page. A
frozen set of (page → correct workstream) cases would have caught all three mechanically.

---

## 2. Enhancements — each tied to a gap, ordered by leverage/effort

### E1. Calibrated lane→fusion promotion (G1+G3+G5, the keystone)
Observe-first, the house pattern: log every lane's top pick vs the user's eventual filing
(prequential — the counters and impression machinery already exist). After N days, per-lane
precision@1 is a *measured* number; then (flagged): lane agreement counts toward corroboration
with weight derived from that precision, and declines veto. This single loop converts gists,
hub guard, and both lanes from disclosure into decisions — and produces the calibration data E5
needs. *Effort: small companion module + one fusion touch; the risky part (policy) is already
gated by the repo's observe→serve discipline.*

### E2. One similarity substrate (G2)
Make the recall store's chunk vectors the only embedding corpus; the materializer consumes
(and caches) from it instead of running a parallel embed path. Kills the drift class, the
double-embed cost, and the second cold-cache. *Effort: medium; the embed-cache and store
already share the model id.*

### E3. Entity layer v1 from existing gists (G4)
Parse `Key Entities` (already structured-ish, already validated) into typed nodes with
evidence edges; apply an idf/hub analog so "AI" the entity doesn't become a magnet. Unlocks
entity dossiers, cross-workstream discovery, and a *much* better AI-lane query (entities, not
prose). *Effort: small-medium, additive event type — the enrichment pipeline pattern (#288/#316)
is the template.*

### E4. Session-as-context (G6)
Feed the live tab-session's co-open set into the resolver as a prior (bounded weight, flagged).
Cheap, explainable ("3 open tabs are filed here"), and it is the signal humans actually use.

### E5. Earned confidence words (G3+J5)
Once E1 emits calibration curves, reintroduce confidence language as measured buckets
("right 8 of the last 10 times") — the honest version of the words removed this week.

### E6. Decline memory as a first-class check (G5)
One lookup: per (canonicalUrl|domain, workstream) decline tombstones consulted by lanes,
fallback, and fusion. The open product question from #326, generalized.

### E7. Liveness as a type (G8)
Materializer phases take a required `progress` reporter (type error to omit); CI runs a
synthetic-large-vault drain canary with the watchdog at production settings. Also: one launcher
template so rig/prod env cannot diverge silently.

### E8. Golden resolve set (G9)
Freeze ~200 historical (page → filed workstream) pairs incl. this week's failure cases; nightly
local run reports precision per arm/lane; ship-gate finally has teeth. *This is the cheapest
item on the list relative to how many future eyeball-debugging sessions it deletes.*

### E9. zh honesty + routing (G7)
Short term: zh pages route gist → title-enrichment-only + copy that says why; remote engine
(if user-enabled) offered explicitly for zh. Re-run the bake-off when a credible small
multilingual ONNX export lands. No pretending.

---

## 3. Possible usage — what the built substrate already supports

These are *near* (mostly plumbing, not research), listed with the pieces they reuse:

| Usage | Reuses | Distance |
|---|---|---|
| **"Pick up where you left off"** — morning per-workstream digest: new pages, gists, open questions | gists (4s each on Apple FM) + recency + workstream projection | UI + one loop |
| **Entity dossiers** — click an entity, see every page/thread/workstream touching it | E3 | E3 + a route |
| **Teach-in-place** — every lane row's "File here" already writes a label; close the loop with a visible "learned it" ack driven by E1's counters | lanes + labels + E1 | small |
| **Ask-your-trail (RAG)** — "where did I read about KV-cache reduction?" answered with citations | /v2 recall + gists + MCP server (already a pillar) | prompt + route |
| **Research packets** — share a workstream as gists+links, zero raw text (privacy-preserving by construction) | dispatches ("research packet" exists) + gists | polish |
| **Déjà-vu at capture** — "you read this 3 weeks ago, filed under X" toast on revisit-by-content | similarity + gist hash | small |
| **Attention drift review** — weekly topic×engagement shift, "you're migrating from X to Y" | engagement folds + topics | analytics UI |
| **Agent surface** — expose resolve/lanes/enrich via MCP so an agent can organize the last hour on request | MCP server + batch-resolve | mostly exists |

The common thread: the expensive substrate (graph, gists, retrieval, provenance) is built and
now *stable*; most user-visible value from here is composition, not new engines.

---

## 4. Best-practice scorecard (for this class of application)

| Practice | State | Evidence |
|---|---|---|
| Event-sourced, replayable derivations | ✅ | folds, retraction event, registry coverage test |
| Observe→serve promotion with kill switches | ✅ pattern | arms, flags; **but** ship-gate unenforced (G3) |
| Honest uncertainty in UI | ✅ | typed emptiness, unconfirmed chips, no fake 100% |
| Calibration of confidence | ❌ | words suppressed, not earned (E5) |
| Negative-label use | ❌ | captured, unconsulted (G5) |
| Single source per derived quantity | ⚠️ | dual similarity systems (G2) |
| Golden-set quality regression | ❌ | all ranking bugs this week found by eyeball (G9) |
| Liveness/progress contracts | ⚠️ | fixed by convention this week, not by type (G8) |
| Config parity dev/prod | ⚠️ | `SIDETRACK_EVENT_STORE` divergence shipped a bug |
| Privacy as architecture | ✅ | on-device engines, origin allowlists, no-key loopback lane, route-pattern logging |

---

## 5. Recommended order

1. **E8 golden set** (days; makes every later change measurable)
2. **E1 lane→fusion prequential** (the keystone; starts its clock immediately)
3. **E6 decline memory** (small, high precision, answers the open #326 question)
4. **E2 one similarity substrate** (deletes the drift class before it costs another week)
5. **E3 entity layer** (first genuinely *new* capability; cheap because gists exist)
6. E4, E5, E7, E9 as they slot in.

The one-sentence review: **capture, representation, and honesty are now ahead of decision and
learning — the system knows more than it uses, and shows more than it acts on; the next unit of
work should make evidence count, measurably, rather than add another evidence source.**
