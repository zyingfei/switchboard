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
| **M4+ — Productization & multi-tenant** | sketch (this doc) | — | — | Companion auto-start, multi-vault, notebook structured sync-back, distribution. Gated on the 30-day §15 window after M-MVP-closure merges. |

---

## M-MVP-closure — Open P0 gaps (active, 2026-07-11)

**Theme**: close the remaining P0 gaps so the §13 acceptance scenario
runs end-to-end. The branch `feat/recall-ranker-v2-replacement` is
~247 commits ahead of main and substantially delivers M3 scope early,
but several §13 steps remain open.

**Open P0 gaps (exit criteria)**:

- **Checklist UI** — `## Checklist` markdown body section in side panel
  (§6.1.6 amended); workstream detail view renders + edits checklist
  items.
- **Inbound view** — "Inbound" panel section surfaces tracked threads
  with new assistant turns since last visit (§6.1.5 / §13 step 9).
- **Queued view** — "Queued" panel section shows pending queue items
  grouped by thread/workstream (§6.1.4 / §13 step 4+6).
- **Queue → packet** ("Compose packet from queue") — selected queue
  items compose the questions section of a Research Packet; in flight
  this wave-set (§6.1.9 / §13 step 11).
- **Export route** — vault write on manual export; path projection
  from workstream tree (§6.1.11 / §13 step 13).
- **`chrome.sessions` tab restore** — `chrome.sessions.restore` path
  for recently-closed tabs (§6.1.7 / §13 step 8).
- **Safety inversion** (§24.10 outbound-preflight unification) —
  outbound dispatch routes consistently through RedactionPipeline +
  token-budget + screen-share-safe + injection-scrub; landing this
  wave-set.
- **MCP identity / audit** — server-derived agent identity + per-call
  audit trail (`_BAC/audit/<date>.jsonl`); trust-opt-in reverted per
  §11 decision 10 (amended 2026-07-11); landing this wave-set.

**Exit gate**: all 16 §13 steps pass end-to-end + CI green on the
feature branch. Subject to the P1 freeze (§11 decision 9): no new
ranker/recall/connections/attribution scope during closure.

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

## M4+ — Productization & multi-tenant (sketch, gated on §15 window)

These are loose buckets that will split into proper milestones when
M-MVP-closure merges and the 30-day §15 dogfood window concludes.
Do not plan M4 scope until §15 success criteria are met. Listed in
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

When **M2 is in flight**, write the full **M3 milestone plan** at
`docs/milestones/M3-recall/{README.md, AGENT-PROMPT.md}` per the
milestone-PR convention (AGENTS.md). Use the sketch above as the
starting point; refine the in/out lists, add E2E acceptance criteria,
sequence the work, run it through standards.

When **M3 is in flight**, similarly promote one of the M4-candidate
buckets to a full plan. Don't try to plan M4+M5+M6 ahead of time —
the empirical signal from each milestone will reshape what comes
next.

This roadmap is a thinking aid, not a commitment. Reorder freely
when product signal arrives.
