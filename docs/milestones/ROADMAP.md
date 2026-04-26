# Sidetrack milestone roadmap

**Status**: living document. Updated as milestones complete or scope
shifts. Authoritative milestone *plans* live in
`docs/milestones/M<n>-<name>/README.md`; this file is the index.

This document sketches what comes after **M2 — Dispatch + Safety**. It
deliberately stays light — no E2E acceptance criteria, no sequencing,
no agent prompts. Each milestone here gets a full plan when it's the
next-up milestone (i.e., when its predecessor is in flight or
complete).

---

## Milestone state

| Milestone | Status | Branch | PR | Notes |
|---|---|---|---|---|
| **M1 — Foundation (Tracker)** | building | `m1/foundation` | #13 | Full P0 tracker. Three providers + generic-fallback. No dispatch surface. ~3-4 weeks. |
| **M2 — Dispatch + Safety** | planning | `m2/dispatch-planning` | #15 | Dispatch + §24.10 safety chain + inline review + remaining mocks + MCP writes/host + Codex web extractor. Build branch (`m2/dispatch`) created off main once M1 lands. ~4-5 weeks. |
| **M3 — Recall + Annotation** | sketch (this doc) | — | — | Smart recall (vector), persistent web annotation, notebook link-back, suggestion layer. ~3-4 weeks expected. |
| **M4+ — Productization & multi-tenant** | sketch (this doc) | — | — | Companion auto-start, multi-vault, notebook structured sync-back, distribution. Loose grouping; will split when M3 lands. |

---

## M3 — Recall + Annotation (sketch)

**Theme**: turn the tracked + organized + dispatched corpus into a
*memory surface*. M1 captured. M2 acted on. M3 makes the captured
corpus *findable across time* and lets the user pin and re-find
arbitrary web content.

**Probable in-scope**:

- **Smart recall (vector)** per PRD §6.3.1
  - `transformers.js` + `MiniLM-L6-v2` (~25 MB, per BRAINSTORM §24.4)
  - Calibrated-freshness ranking (3d / 3w / 3m / 3y per §24.8)
  - Index lives in `_BAC/recall/index.bin` as a rebuildable cache
    (reconstruct from event log; never the source of truth)
  - On-device only (no cloud embedding API)
  - Surfaces in: side panel "déjà-vu" pop-on-highlight, packet
    composer scope picker (suggested items), bac-mcp `bac.recall`
    tool
- **Persistent web annotation** per PRD §6.3.4
  - Hypothesis client (BSD-2) for `TextQuoteSelector` +
    `TextPosition` + `CssSelector` fallbacks (per BRAINSTORM §24.4)
  - Restore highlights on revisit
  - Annotation now usable as a §28 review target (not just lightweight
    capture from M2)
- **Notebook link-back** (PRD §10 Case B)
  - Sync-in: scan vault for human-authored notes whose frontmatter
    references a Sidetrack workstream (`bac_workstream:` field)
  - Sidetrack records the link; does NOT parse the note body
  - Surfaces in workstream detail: "linked notes from your vault"
- **Suggestion layer** (PRD §6.3.6)
  - "This thread looks related to {workstream X}" surface in
    Workboard's Needs-Organize section
  - Signal: lexical + vector + link-neighborhood
  - User must accept; never auto-applies (per §6.5 anti-pattern list)
  - Only ships once M1+M2 manual-org workflow is dogfood-validated
- **`bac.recall` MCP tool** (read-only) — surfaces vector recall
  results to coding agents

**Probable deferrals to M4+**:
- Streaming embeddings (large-corpus performance) — M3 ships
  embed-on-capture; if performance tanks, optimize in M4
- Vector index sharding (Pagefind pattern per BRAINSTORM §24.4) — M3
  ships single-index; shard if cold-start time crosses budget
- EmbeddingGemma-300M opt-in — MiniLM is the M3 default

**Why M3 is its own milestone (not folded into M2)**:
- Vector recall has its own engineering surface (transformers.js
  loading, OPFS for model weights, index management) that's
  orthogonal to dispatch
- Persistent annotation needs Hypothesis client integration which is
  its own significant lift (CSP, content-script anchoring, revisit
  detection)
- Suggestion layer can't ship before manual-org has been dogfooded
  through M1+M2 — needs the empirical "what users actually do" signal

---

## M4+ — Productization & multi-tenant (sketch)

These are loose buckets that will split into proper milestones when
M3 lands and we have a clearer signal. Listed in rough priority order:

### M4-candidate: Productization

- **Companion `--install-service`** per ADR-0001 v1.5 plan
  (`launchd` / `systemd` / Task Scheduler integration)
- **First-run wizard polish v2** (M2 already polishes, but cross-OS
  install flows often surface real friction; iterate)
- **Auto-update path** for the companion (currently `npm update -g`)
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
