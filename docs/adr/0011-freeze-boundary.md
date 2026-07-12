# ADR-0011 — P1 freeze boundary: serving-math frozen, read-path freeze-safe

- Status: Accepted
- Date: 2026-07-11
- Owner: User + Claude
- Components: API | Shared
- Related: ADR-0005, ADR-0008, PRD §11 decision 9, ROADMAP.md §NOW/§NEXT

## Context

The branch `feat/recall-ranker-v2-replacement` is substantially ahead
of main (~247 commits) and delivers M3 scope early: hybrid
lexical+vector recall (`/v2` pipeline, SQLite FTS5 + sqlite-vec),
a learned reranker (LambdaMART + online LR head, impression emission,
trainable `recall.action` events), connections IVM, suggestions, and
attribution fixes.

PRD §11 decision 9 imposed a **P1 freeze** on ranker/recall/connections/
attribution scope until all 16 §13 acceptance steps pass. The freeze
exists because adding new capability scope to these subsystems before
the core dogfood loop is validated risks compounding complexity, breaking
the evaluation spine, or creating regression ratchets that make §13 harder
to close.

A recurring question during the §15 NEXT-horizon work is: **what
counts as frozen?** Specifically, when a new feature reads the output
of the ranker, recall pipeline, or connections graph to display it in
the UI (packets pulling recall neighbors, déjà-vu chips, where-was-I
rollup), does that cross the freeze boundary?

This ADR records the decision and its rationale so it does not need to
be re-litigated on every new feature request.

## Decision

The freeze boundary is defined along the **write path vs read path**
distinction, not along the subsystem boundary:

**FROZEN until §13 passes + §15 window met**:

- Scoring functions, scoring weights, threshold constants in the recall
  pipeline (`/v2` reranker, `learnedRerank.ts`, `graph_baseline`
  scorer).
- Retrain pipeline changes: new artifact kinds, new feature vectors,
  new training-data sources, new label production paths.
- Graph edge production: new edge types, changed edge weights, changed
  candidate filters, changed aggregator grouping logic.
- Attribution logic: new attribution signals, changed similarity
  thresholds, changed policy decisions in `policy.ts`.
- Any change to the `shipGate` conditions or `reservedTestMetric`
  evaluation (ADR-0008).

**FREEZE-SAFE (permitted during the freeze)**:

- Reading the **output** of the ranker, recall pipeline, or connections
  graph and displaying it in the UI (side panel, packets, chips,
  rollups). The serving math does not change; only the consumer changes.
- Plumbing new read-path endpoints that proxy existing served output
  to new surfaces (e.g. a packet composer calling `/v2/recall` to
  populate suggested inclusions).
- Bug fixes and stability improvements to the retrain loop, impression
  emission, and online head update — provided no new feature scope is
  added (ADR-0008 maintenance-only clause).
- UI/UX changes to how recall results are displayed (chip text, sort
  order in the panel, grouping in the packet composer) — provided the
  underlying scores are unchanged.
- Install, distribution, and supervised-install work (ADR-0001 v1.5
  `--install-service` flag).
- New MCP read-only tools that query existing vault state.
- Documentation, ADRs, roadmap updates.

**Boundary test**: if a proposed change requires editing any of
`ranker/select.ts`, `recall-v2/learnedRerank.ts`, `recall-v2/pipeline.ts`
scoring logic, `connections/policy.ts` edge weights/thresholds,
`connections/similarity.ts` thresholds, or any training/label-production
module — it is FROZEN. If the change only adds a new caller of an
existing `/v2` endpoint or reads an existing field from the served
response, it is freeze-safe.

## Options considered

### Option A — Freeze the entire ranker/recall/connections subsystem (hard boundary)

Pros:
- Simple rule; no judgment calls.

Cons:
- Blocks useful UI work that consumes served output without changing
  any math. The NEXT-horizon features (packets pulling recall neighbors,
  déjà-vu chips, where-was-I rollup) are all read-path consumers — they
  would be unnecessarily blocked.
- The freeze's purpose is to prevent scoring/training regressions, not
  to block consumers of already-validated served output.

### Option B — Write-path vs read-path boundary (chosen)

Pros:
- Permits NEXT-horizon UI/plumbing work without lifting the freeze
  prematurely.
- The serving math (the thing the freeze protects) is unchanged; its
  output is simply read by more consumers.
- Consistent with the maintenance-only clause in ADR-0008 (bug fixes
  permitted; new feature scope is not).

Cons:
- Requires judgment to classify a proposed change. The boundary test
  above (which source files are touched) makes this mechanical in
  practice.

### Option C — Freeze until §13 only, then lift fully

Pros:
- Simpler exit condition.

Cons:
- Premature. The §15 window provides empirical signal (real usage
  data, real label production, real recall quality) that is necessary
  before changing the serving math. Lifting the freeze at §13 would
  skip the validation window the freeze was designed to protect.

## Consequences

Positive:
- NEXT-horizon features (packets, chips, rollup, redaction preview)
  can proceed in parallel with §13 closure without waiting for a freeze
  lift.
- The freeze-lift condition is now observable: the PRD §15 counter
  table (amended 2026-07-11) and the ROADMAP.md LATER-horizon entry
  together define when to revisit serving math.
- New contributors can classify proposed changes mechanically using the
  boundary test without reading the full freeze history.

Negative:
- Read-path consumers of recall/connections output accumulate during
  the freeze window. When the freeze lifts, a coordinated review of
  all new consumers against the updated serving math is needed to
  ensure they still make sense (e.g. if RRF weights shift, the
  "suggested inclusions" ranking in the packet composer may need
  recalibration).

## Freeze-lift gate (observable)

The freeze lifts when **both** conditions are met:

1. All 16 §13 acceptance steps pass in a live recorded run (runbook:
   `docs/demos/2026-07-11-section13-acceptance-runbook.md`).
2. All six §15 success criteria in the PRD §15 counter table are met
   (≥80% tracked, ≥3 lossless reorgs, ≥5 packets dispatched, ≥1 tab
   recovery, ≥1 MCP context-pack session, ≥7 days zero data loss).

When both gates pass, update this ADR's status to Superseded and record
the freeze-lift date. The first post-freeze ranker/recall/connections
scope item should reference this ADR to confirm the lift.
