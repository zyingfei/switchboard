# Sidetrack milestone roadmap

**Status**: living document. Updated as milestones complete or scope
shifts. Authoritative milestone *plans* live in
`docs/milestones/M<n>-<name>/README.md`; this file is the index.

---

## Milestone state (truth pass 2026-07-11)

| Milestone | Status | Branch | PR | Notes |
|---|---|---|---|---|
| **M1 — Foundation (Tracker)** | **SHIPPED** | `m1/foundation` | #13 | Full P0 tracker. Three providers + generic-fallback. Dispatch surface not included. |
| **M2 — Dispatch + Safety** | **SHIPPED** | `feat/recall-ranker-v2-replacement` | — | Dispatch + §24.10 safety chain + inline review + MCP writes. Outbound-preflight unification landing in current wave-set. Note: the original planning branch `m2/dispatch-planning` was superseded by the active feature branch. |
| **M3 — Recall + Annotation** | **SUBSTANTIALLY DELIVERED EARLY** on `feat/recall-ranker-v2-replacement` | — | — | Hybrid lexical+vector recall (/v2 pipeline, SQLite FTS5 + sqlite-vec), learned ranker, connections IVM, suggestions, annotation anchoring all shipped on the active branch. Notebook link-back still open. See M-MVP-closure for remaining P0 gaps. |
| **M-MVP-closure** | **ACTIVE** | `feat/recall-ranker-v2-replacement` | — | Open P0 gaps before §13 closes. See detail below. Exit gate: all 16 §13 steps pass + CI green. |
| **M4+ — Productization & distribution** | sketch (this doc) | — | — | Surface built intelligence during §15 dogfood, then distribute MCP-registry-first followed by Chrome Web Store; lift freeze deliberately after §15 window. Gated on M-MVP-closure merge + §15 success criteria. |

---

## Product roadmap horizons (2026-07-11)

### NOW — close the ship loop

Goal: complete M-MVP-closure so the §13 demo passes and the branch
merges to main.

Items in flight or recently landed:

- **F16 green baseline + CI blocking** — DONE. The 13-fail/8-file
  baseline on `feat/recall-ranker-v2-replacement` is established and
  confirmed unrelated; CI gate is in place.
- **F01 dispatch-path inversion** (§24.10 outbound-preflight unification)
  — DONE. All outbound routes unified through RedactionPipeline +
  token-budget + screen-share-safe + injection-scrub.
- **Four §13 UI gaps**: Checklist view, Inbound view, Queued view,
  Export route — DONE (landed in the current wave-set).
- **Step-8 recovery wiring** (`chrome.sessions` restore modal +
  `chrome.sessions.restore` path) — DONE (fix/tab-recovery-modal-wiring).
- **Remaining**: live recorded §13 demo run; supervised install landing
  (`--install-service` via `launchd` / `systemd` / Task Scheduler per
  ADR-0001 v1.5).

### NEXT — surface built intelligence during the §15 window

After M-MVP-closure merges, the 30-day §15 dogfood window begins. The
goal for this horizon is to make the intelligence Sidetrack has already
built (recall, graph neighbors, connections) visibly useful in the
everyday workflow — without changing the serving math (P1 freeze lifts
only after §13 + §15).

Planned features for this horizon (none require ranker/recall/connections
math changes; all are UI/plumbing/read-path):

- **Packets pull recall/graph neighbors** — the Research Packet and
  Context Pack composers query `/v2` recall and graph neighbors for the
  selected workstream; surface top-N results as suggested inclusions.
  Reading served output is freeze-safe (ADR-0011).
- **Queue → packet** — selected queue items compose the questions
  section of a Research Packet (§6.1.9 / §13 step 11; in-flight,
  carries into §15).
- **Déjà-vu "why" chips** — when a recall hit surfaces in the side
  panel, show a micro-chip explaining why: "visited 3×", "linked from
  MVP PRD", "you queued a follow-up". Read-only display over existing
  recall metadata.
- **Where-was-I rollup** — "Bases dashboard" surface: daily/weekly
  summary of active workstreams, open queues, and inbound reminders;
  written by companion to `_BAC/dashboards/where-was-i.base` at drain
  time.
- **Redaction preview** — show which tokens would be redacted before
  the user commits to a dispatch; "preview redaction" button in the
  packet composer.

### LATER — distribute, then lift the freeze deliberately

After §15 criteria are met:

- **MCP-registry-first distribution**: submit `sidetrack-mcp` to the
  MCP registry (and stdio-install documentation) before Chrome Web Store
  submission. MCP users (coding-agent power users) are the early adopter
  cohort; extension store submission follows once the MCP integration
  story is validated.
- **Chrome Web Store submission** + Obsidian community plugin
  marketplace (BAC for Obsidian per BRAINSTORM §24.15).
- **Deliberate freeze lift**: after §13 + §15, revisit the ranker/recall/
  connections serving math with full empirical signal from the dogfood
  window. Landing candidates: screen-share-safe auto-detect (§6.3.3),
  suggestion layer (§6.3.6), notebook link-back (§10 Case B).
- **Companion `--install-service`** polish for cross-OS (macOS
  `launchd`, Linux `systemd`, Windows Task Scheduler per ADR-0001 v1.5).

### DEBT — lanes that need attention before they compound

Technical debt to address in parallel with NEXT/LATER (do not block
on these, but do not let them slide indefinitely):

- **Perf lane**: connections materialization delta (scoped-delta base
  carry-forward, P0-A nav rebuild); ext fan-out throttle; off-thread
  resolve.
- **Storage lane**: WAL checkpoint hygiene; embedding-store compaction;
  event-log rotation.
- **Contracts lane**: snapshot-watcher resolve-flood V3/V4 hardening;
  typed-read sweep for any remaining full-scan callers.
- **Decompositions lane**: untracked-tab attribution (latestUrl/latestTitle
  seed), persistent web annotation (§6.3.4 Hypothesis-style anchoring).

---

## M-MVP-closure — Open P0 gaps (active, 2026-07-11)

**Theme**: close the remaining P0 gaps so the §13 acceptance scenario
runs end-to-end. The branch `feat/recall-ranker-v2-replacement` is
~247 commits ahead of main and substantially delivers M3 scope early.

**DONE items** (landed in current wave-set or prior):

- Checklist UI — `## Checklist` markdown body section, renders + edits.
- Inbound view — "Inbound" panel section with assistant-turn detection.
- Queued view — "Queued" panel section grouped by thread/workstream.
- Export route — vault write on manual export; path projection.
- `chrome.sessions` tab restore — `chrome.sessions.restore` + recovery
  modal wiring (fix/tab-recovery-modal-wiring branch).
- Safety inversion (§24.10 outbound-preflight unification) — DONE.
- MCP identity / audit — server-derived agent identity + audit trail.
- F16 green baseline + CI gate — DONE.
- F01 dispatch-path inversion — DONE.

**Remaining (exit criteria)**:

- **Queue → packet** — in flight; carries into §15 window if needed.
- **Recorded §13 demo run** — live end-to-end run documented in
  `docs/demos/2026-07-11-section13-acceptance-runbook.md`; pending
  execution.
- **Supervised install landing** — `--install-service` flag for
  `launchd` / `systemd` / Task Scheduler per ADR-0001 v1.5.

**Exit gate**: all 16 §13 steps pass end-to-end + CI green on the
feature branch. Subject to the P1 freeze (§11 decision 9): no new
ranker/recall/connections/attribution scope during closure (see
ADR-0011 for the freeze boundary).

---

## M3 — Recall + Annotation (substantially delivered early)

Most M3 scope shipped ahead of schedule on `feat/recall-ranker-v2-replacement`
(2026-07-11 truth pass). The items below are the original M3 sketch;
delivered items are marked.

**Delivered on active branch**:
- Hybrid lexical + vector recall (/v2 pipeline, SQLite FTS5 + sqlite-vec,
  calibrated-freshness ranking) — PRD §6.3.1 pulled forward to P0.
- Learned reranker (LambdaMART + online LR head, impression emission,
  trainable recall.action events).
- Suggestion layer (workstream suggestions, topic suggestions).
- `sidetrack.recall.query` MCP tool (read-only).

**Still open from original M3 scope**:

- **Persistent web annotation** (PRD §6.3.4) — Hypothesis-style
  anchoring (TextQuote + TextPosition + CssSelector fallbacks);
  restore highlights on revisit; annotation as §28 review target.
  Lightweight annotation capture shipped in M2; persistent anchoring
  is the remaining lift.
- **Notebook link-back** (PRD §10 Case B) — sync-in scan for vault
  notes referencing a workstream via `bac_workstream:` frontmatter
  field; surfaces in workstream detail.

These two items are candidates for M4 or a thin M3-close milestone
depending on product priority after M-MVP-closure merges.

---

## M4+ — Productization & distribution (sketch, gated on §15 window)

These are loose buckets that will split into proper milestones when
M-MVP-closure merges and the 30-day §15 dogfood window concludes.
Do not plan M4 scope until §15 success criteria are met (see §15 counter
table in PRD.md for the observable freeze-lift condition). Listed in
rough priority order:

### M4-candidate: Productization

- **Companion `--install-service`** per ADR-0001 v1.5 plan
  (`launchd` / `systemd` / Task Scheduler integration)
- **First-run wizard polish v2** (M2 already polishes, but cross-OS
  install flows often surface real friction; iterate)
- **Auto-update path** for the companion (currently `bun update --global`)
- **Telemetry-free local diagnostics** (capture-health UI, error
  exports for support)
- **Distribution surfaces**: Chrome Web Store submission, Obsidian
  community plugin marketplace (BAC for Obsidian microsite per
  BRAINSTORM §24.15), Hugging Face / WXT community channels
- **Settings importer/exporter** (move config + workstream tree
  between machines without exposing the vault)

### M4-candidate: Multi-vault + multi-machine

- **Multi-vault routing** (per PRD §6.5 deferred; per-bucket vault
  routing per BRAINSTORM §23.9 O10 v1.5 stance)
- **Vault portability**: open second machine, point at same vault
  (cloud-synced via iCloud / Dropbox / Obsidian Sync), pick up where
  you left off
- **Companion-on-different-machine** scenarios (probably
  v2 — needs auth + transport beyond loopback)

### M4-candidate: Notebook structured macro sync-back

- **PRD §10 Case C**: notebook contains structured `bac_*` blocks
  that the user (or AI) edits, and those changes propagate back to
  Sidetrack state
- Requires: schema versioning, content hashes, three-way merge,
  conflict UI, no-delete-without-confirmation
- M4+ spike (large engineering surface; user explicitly deferred at
  PRD §6.5)

### M4-candidate: Encrypted backup escape valve

- **PRD §6.5 deferred + BRAINSTORM §24.13**: encrypted blob backup
  to user-provided storage (S3 / R2 / Dropbox / iCloud / WebDAV /
  GitHub gist)
- libsodium secretbox; user-set passphrase
- Solves device loss without cloud-service dependency
- Could ship earlier if user demand surfaces

### M4-candidate: Recall calibration session (PRD §6.3.x sketch)

- Quarterly prompt: "review 20 random recall hits and mark
  relevant/not"
- Updates local ranker; surfaces concept drift (BRAINSTORM S112)
- Depends on M3 recall being live + having signal to learn from

---

## Things explicitly NOT in any planned milestone

(Per PRD §6.5 + BRAINSTORM § anchors. These are non-goals, not "later"
items.)

- **Cross-user review aggregation** — single-user trust boundary
  forever (PRD §6.5)
- **Auto-organization** (AI moves items without explicit user action)
  — violates the "manual organization is core" principle
- **Auto-send by default for any provider** — paste-mode is the v1
  default forever (per Q5 / PRD §6.5)
- **Generic browser-control MCP** — explicitly not Sidetrack's
  positioning (PRD §6.5 + competitive analysis in PRD §1)
- **Mobile** as a Chrome-extension-extension — separate product
  entirely (different platform, different UX, different distribution)
- **Custom Obsidian-graph UI** — Obsidian's native Graph/Canvas/Bases
  handles it (per BRAINSTORM §23.3 simplifier)
- **Production-grade vector DB** beyond local on-device — local +
  rebuildable cache is the architectural commitment per §23.0

---

## How to use this doc

The **NOW / NEXT / LATER / DEBT** horizon grid above is the forward
product roadmap. Use it to orient new work: if a proposed change
doesn't fit a horizon, it goes to followUps or is deferred.

When **M-MVP-closure exits** (§13 passes, branch merges to main),
write the full **M4 milestone plan** at
`docs/milestones/M4-surface/{README.md, AGENT-PROMPT.md}` per the
milestone-PR convention (AGENTS.md). Use the NEXT-horizon sketch above
as the starting point. Don't plan M5+ until §15 window data is in —
the empirical signal will reshape what comes next.

This roadmap is a thinking aid, not a commitment. Reorder freely
when product signal arrives.
