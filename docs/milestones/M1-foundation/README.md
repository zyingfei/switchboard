# Milestone 1 — Foundation (Tracker)

**Status**: planning (2026-04-26)
**Branch**: `m1/foundation`
**Target**: production-grade **active-work tracker** — full P0 tracking + organization, no dispatch yet
**Estimated**: ~3–4 weeks of agent work

---

## What this milestone is

A **first usable version** of Sidetrack: the user can install it, have
their cross-provider AI work auto-tracked, organize it into nested
workstreams, queue follow-ups, get reminded when chats receive
replies, recover forgotten tabs, and read all of it from a coding
agent via MCP. The full P0 *tracker* surface lands. The *dispatch*
surface (packets, inline reviews, §24.10 safety primitives) is the
next coherent chunk and lives in M2.

> **Why split here**: dispatch + safety primitives are a single
> chunk (you can't ship dispatch without Redaction + token-budget +
> screen-share-safe + injection-scrub all together — that's the
> §24.10 "ship-blocking" framing). It's cleaner to land the tracker
> first, get user-facing data in motion, then add the dispatch chain
> in M2 with proper safety design.

The user should be able to use M1 daily as a passive observer +
organizer of their AI work. M2 turns it into an active orchestrator.

> **The acceptance bar**: install Sidetrack → use ChatGPT, Claude,
> Gemini, and Codex web through the day → side panel shows organized
> tracked work → user creates a nested workstream and moves things
> into it → queues a follow-up to a thread → gets an Inbound
> notification when Claude replies to that thread → accidentally
> closes a tab and recovers it → from a separate terminal, runs
> `bac-mcp --vault <path>` and asks `bac.context_pack({ workstream: "..."} )`,
> gets the captured threads + queued asks back. All under the standards.

If that loop works, M1 ships.

## What this milestone is NOT (defer to M2 — the dispatch milestone)

These all naturally cluster around dispatch + safety, so they land
together in M2:

- **Packet composer** (Mock 5) — outbound packets to other AIs
- **Dispatch confirm + safety chain** (Mock 6 + §24.10) — Redaction +
  token-budget + screen-share-safe + captured-page injection scrub —
  ship-blocking primitives, all four together
- **Inline review primitive** (Mock 7 / §28) — Submit-back, Dispatch-out
- **Recent Dispatches view** (Mock 13 second half) — depends on
  DispatchEvent stream from M2
- **MCP write tools + per-workstream trust mode** (§6.1.14) — defers
  with dispatch since it's the same approval model
- **MCP host role** (§24.5) — separate adjacency, M2+
- **Annotation capture** (Mock 14) — input side of §28 review; M2 with
  reviews
- **Coding session attach** (Mock 12) — standalone but small; folds
  into M2 batch
- **Auto-download** (PRD §6.2.3) — depends on packet outputs
- **First-run wizard polish** (Mock 8) — programmatic config (paste
  bridge.key) is acceptable for M1; full wizard with companion install
  picker etc. is M2
- **Vault Markdown projection** (PRD §10 Case A — full Source notes,
  generated `.canvas`, generated `.base`) — JSONL events + thread
  index is the M1 bar; full projection is M2 (depends on having the
  promoted-artifact concept which depends on dispatch)
- **Smart recall vector** — lexical only in M1; transformers.js +
  MiniLM is M2/M3
- **Notebook link-back** (PRD §10 Case B / Case C) — M3+
- **Screen-share-safe auto-detect** (per Q6 deferred to P1+) — the
  per-workstream privacy flag (P0) **is** in M1 as the substantive
  control; auto-detect is later

These deferrals are documented in PRD §6.5 and §11. M1 must not
re-litigate them.

## Source artifacts the M1 work depends on

All on `main`:

- **PRD.md** — full P0 tracker surface: §6.1.1 Workboard, §6.1.2
  Capture+tracking, §6.1.3 Workstream organization, §6.1.4 Queue,
  §6.1.5 Inbound reminders, §6.1.6 Manual checklists, §6.1.7 Tab
  recovery, §6.1.8 Search+lexical recall, §6.1.11 Structured download
  (manual export only — auto is M2), §6.1.12 Stable IDs, **§6.1.13
  per-workstream privacy flag** (the P0 substantive control after Q6
  demoted auto-mask). Also §5 architecture, §9 failure modes.
- **BRAINSTORM.md** — anchors §23.0, §24.5, §27, §27.6.
- **AGENTS.md** — repo conventions, `_BAC/` namespace, `bac_id` stable
  identity, vault canonical, no mandatory plugins.
- **CODING_STANDARDS.md** — non-negotiables, ports & adapters,
  POC→product conversion rule.
- **standards/03-ts-browser-plugin.md** — MV3 service-worker
  lifecycle, typed message bus, content-script isolation, permission
  minimization, storage migrations.
- **standards/02-mcp-components.md** — MCP capability registry,
  lifecycle, safety, transport.
- **standards/00-engineering-baseline.md** — boundary validation,
  typed errors, observability, security baseline.
- **docs/adr/0001-companion-install-http-loopback.md** — companion
  install path is HTTP loopback (locked).

PoCs to lift behavior from (per CODING_STANDARDS.md §"POC-to-product
conversion rule" — capture as tests, design boundary, implement
through standard architecture, then archive):

- **`poc/local-bridge/`** — companion + extension client + 60-min
  sustained tick proven. Foundation lift.
- **`poc/provider-capture/`** — DOM capture for ChatGPT / Claude /
  Gemini / Codex web with selector canary + clipboard fallback. **All
  four providers ship in M1.**
- **`poc/mcp-server/`** — stdio MCP server reading vault state. Read
  side; teach it to consume the live vault's richer data shape.
- **`poc/dogfood-loop/`** — workstream graph entities (Workstream,
  Bucket, Source, PromptRun, ContextEdge), `_BAC/workstreams/` shape,
  Context Pack generation. **Lift the data model.** Skip the
  fork/converge/dispatch parts (M2).

Design references (in this PR under `design/`):

- **`design/MVP-mocks-prompts.md`** — Mocks 1, 2, 3, 4, 9 (minimal),
  10, 11, 13 (Inbound only) are M1. Mocks 5, 6, 7, 8 (full wizard),
  12, 14 are M2.
- **`design/mockup-stage/`** — designer's interactive Stage prototype.
  Use for design language (paper / ink / signal-orange / Fraunces /
  Source Serif 4 / JetBrains Mono) and the Workboard's interaction
  patterns. **Not pixel-perfect target** per user direction; recreate
  in TS-strict React.

## Deliverables

### 1. `packages/sidetrack-companion/` (production scaffold)

Promote `poc/local-bridge/companion/` to production-grade per
`standards/00-engineering-baseline.md` + `standards/02-mcp-components.md`:

- Strict TS via `configs/ts/tsconfig.base.json`
- Typed-lint via `configs/ts/eslint.config.mjs` (typescript-eslint)
- Boundary validation: every HTTP request body parsed via Zod schema
  (per CODING_STANDARDS.md §3 "no unvalidated boundary input")
- Structured logging with correlation IDs
- Health endpoint, status endpoint with stable shape
- Audit log every write to `_BAC/audit/<date>.jsonl`
- Capability registry pattern for HTTP routes (open-for-extension,
  closed-for-modification per CODING_STANDARDS.md §4)
- Vitest unit tests for: schema validation, vault writer, auth
  rejection, queue replay
- Integration test: in-process HTTP client → companion → vault →
  filesystem inspection
- `package.json` `bin: { "sidetrack-companion": "./dist/cli.js" }` for
  `npx @sidetrack/companion`
- **Vault writer** writes:
  - `_BAC/events/<date>.jsonl` — append-only capture event log
  - `_BAC/threads/<bac_id>.json` — per-thread state index (provider,
    threadId, threadUrl, title, lastSeenAt, status, primary
    workstream, tags)
  - `_BAC/workstreams/<bac_id>.json` — workstream tree nodes
    (kind, parent, children, tags, checklist)
  - `_BAC/queue/<bac_id>.json` — queued asks (scope, target, text,
    status)
  - `_BAC/reminders/<bac_id>.json` — inbound reminders
  - `_BAC/audit/<date>.jsonl` — every write the companion makes
- Companion handles: `POST /v1/events`, `POST /v1/threads`,
  `POST /v1/workstreams`, `PATCH /v1/workstreams/:id`,
  `POST /v1/queue`, `POST /v1/reminders`, `GET /v1/health`,
  `GET /v1/status`. All Zod-validated. All audit-logged.

### 2. `packages/sidetrack-extension/` (production scaffold)

Promote `poc/local-bridge/extension/` + `poc/provider-capture/`
content-script logic to production-grade per
`standards/03-ts-browser-plugin.md`:

- WXT + React + TypeScript MV3 (matches all existing PoCs)
- Strict TS, typed-lint, vitest, Playwright extension e2e
- Typed message bus across SW / side panel / content scripts (no
  `any` anywhere)
- Content-script isolation per `standards/03-ts-browser-plugin.md`
- `chrome.storage.local` for hot cache + capture queue (per PRD §5.3);
  vault is canonical
- Permission minimization per `standards/03-ts-browser-plugin.md` —
  ship at install with `activeTab + storage`; request host
  permissions per-provider via `chrome.permissions.request()` on
  first "Connect" click

**Side panel (full Mock 1 Workboard)**:
- All six sections: Current Tab · Active Work · Queued · Inbound ·
  Needs Organize · Recent / Search
- Section collapse/expand persisted in `chrome.storage.local`
- "Auto, Manual, Stopped, Removed" tracking-mode pills on each item
- Companion-status badge (Mock 10 banners for companion-down,
  vault-unreachable, provider-broken)
- Per-workstream privacy flag → masked items render `[private]`
  (Mock 11)

**Workstream detail (Mock 2)**:
- Breadcrumb navigation (workstream tree depth)
- Tracked items list with type icons + provider chips
- Manual checklist with `[+] Add item` (Mock 2 sub-feature)
- Queued asks for this workstream
- Subclusters (recursive)
- Footer: New subcluster · Add tag · Move to… · Export

**Reorganize UX (Mock 4)**:
- Drag-and-drop in workstream tree
- "Move to…" picker modal with type-to-filter and create-on-the-fly
- Identity preserved by `bac_id` — moves never break links
- Toast with `[Undo]`

**Tab recovery (Mock 3)**:
- Closed-but-restorable items render with status pill
- Recovery dialog: focus open / restore session / reopen URL (in
  priority order)
- TabSnapshot stored on every tracked item

**Inbound reminders (Mock 13 first half)**:
- Detect new assistant turns in tracked threads via fetch/SSE
  interception (or DOM canary)
- Surface in workboard Inbound section
- Mark seen / Mark relevant / Dismiss

**Settings (minimal — subset of Mock 9)**:
- Tracking: global auto-track + per-site toggles
- Privacy: per-workstream privacy flag picker (the P0 substantive
  control after Q6)
- Companion: status pill, install path, vault folder, restart hint
- About: version, vault path, companion path
- Sections deferred to M2: Packets (auto-download), Dispatch
  (paste-mode lock visible but no providers to opt-in for since
  there's no dispatch in M1), MCP (read-only enumeration is enough
  for M1; trust list is M2), Redaction rules

**Capture (4 providers)**:
- ChatGPT, Claude, Gemini, Codex web — full coverage
- Auto-track on by default; per-site disable
- Manual "Track current tab" button for any URL
- Selector canary per provider per tab load
- Clipboard-mode fallback when selector breaks
- Source/provenance fields on every captured turn

**Capture queue**:
- `chrome.storage.local`-backed queue for offline companion
- Chronological replay on reconnect; oldest-eviction at 1000 items
- Drop counter for "queue full" warning

**Search**:
- Lexical FTS (MiniSearch per §24.4) over tracked items: title,
  provider, workstream path, captured turns
- "Did I research X recently" surface

### 3. `bac-mcp` adapted for live vault

The existing `poc/mcp-server/` is the read side. For M1:

- Lift to `packages/sidetrack-mcp/` per
  `standards/02-mcp-components.md` (capability registry, lifecycle,
  audit log, Zod-validated tool inputs).
- Tools active in M1 (read-only):
  - `bac.recent_threads` — returns tracked threads sorted by
    lastSeenAt
  - `bac.workstream({ id })` — returns workstream subtree + tracked
    items + queued asks + checklist
  - `bac.context_pack({ workstreamId, includeQueueItems })` — minimal
    Context Pack (no Research Packet templates yet — that's M2 with
    dispatch)
  - `bac.search({ query })` — lexical
  - `bac.queued_items({ scope })` — queued follow-ups
  - `bac.inbound_reminders({ since })` — inbound replies
  - `bac.coding_sessions()` — returns empty in M1 (no attach UI yet)
- All tools return empty / sensible defaults if data is absent.
- One-line install via standard MCP client config:
  `npx @sidetrack/mcp --vault <path>`.

### 4. End-to-end demo script

`docs/milestones/M1-foundation/DEMO.md` (created on completion) —
copy-paste runbook covering the full M1 acceptance scenario including
multi-provider use, organization, queue, inbound, recovery, MCP
roundtrip, and the cold-start variants.

### 5. Standards compliance evidence

`docs/milestones/M1-foundation/STANDARDS-CHECK.md` (created on
completion) — fill the relevant checklists:

- `checklists/production-readiness.md`
- `checklists/browser-plugin-design-review.md`
- `checklists/mcp-design-review.md`

## E2E acceptance criteria

The milestone is done when **all** of the following pass:

### Capture & tracking

1. **Companion starts cleanly**: `npx @sidetrack/companion --vault /tmp/sidetrack-m1` boots, binds 127.0.0.1, writes `bridge.key`. Health endpoint responds within 1s.
2. **Extension installs and connects**: load unpacked from `packages/sidetrack-extension/.output/chrome-mv3`. First-run paste of `bridge.key` connects to companion. Side-panel header shows "vault: connected · companion: running".
3. **Multi-provider capture**: open ChatGPT, Claude, Gemini, Codex web tabs. Send messages, get assistant turns. Within 30 seconds of each turn, an event lands in `_BAC/events/<date>.jsonl` with the right `provider`, `threadId`, `threadUrl`, `capturedAt`. Side-panel Recent section shows all four threads.
4. **Selector canary**: simulate a broken selector for one provider — yellow banner appears in side panel, clipboard fallback offered, capture still functional.
5. **Stop/remove tracking**: per-tab stop and per-site stop both work. Removing a tracked item deletes from the side panel and from the vault index.

### Organization

6. **Create nested workstream**: side panel → "New workstream" → "Sidetrack" → expand → "MVP PRD" → expand → "Active Work". Tree renders correctly.
7. **Move tracked items**: drag a thread from Recent into "Sidetrack / MVP PRD / Active Work". Item appears in workstream detail. Move it to a sibling workstream — references and `bac_id` preserved.
8. **Manual checklist**: open workstream detail → add 3 checklist items → tick 1. State persists across side-panel close/reopen and across Chrome restart.
9. **Tags + per-workstream privacy flag**: add tag `architecture` to a workstream; flag it `private`. In Workboard, items in that workstream render `[private]` (titles masked).

### Queue

10. **Queue follow-up**: from a thread, add queue item "Ask Claude to compare with VM live migration architecture." Status pill shows `pending`. Item appears in Workboard Queued section + workstream detail. (No dispatch in M1 — queue is a list, not an action trigger.)

### Inbound reminders

11. **Inbound detection**: Send a message in a tracked Claude thread, then navigate away. When Claude replies (in another tab or background), Inbound section surfaces "Claude replied X min ago" with pulse-signal-orange dot. Mark relevant / dismiss work.

### Tab recovery

12. **Recovery dialog**: accidentally close a tracked tab. Item shows `closed (restorable)`. Click → recovery dialog → reopen URL works. (Restore-session and focus-open variants tested if Chrome cooperates.)

### MCP read-side

13. **bac-mcp returns rich data**: `npx @sidetrack/mcp --vault /tmp/sidetrack-m1` boots; from an in-process stdio harness (or real Claude Code with MCP config):
    - `bac.recent_threads` → returns 4 captured threads
    - `bac.workstream({ id: "<sidetrack id>" })` → returns nested tree + items + queued + checklist
    - `bac.context_pack({ workstreamId })` → returns Markdown context pack
    - `bac.search({ query: "vm live migration" })` → returns matching threads
    - `bac.queued_items()` → returns the queued follow-up
    - `bac.inbound_reminders()` → returns the Claude reply

### Failure modes (per PRD §9)

14. **Chrome restart**: quit Chrome, restart, reopen tracked tabs. Side panel reconnects to companion (companion stayed running), state persists, capture continues.
15. **Companion crash + restart**: kill companion mid-session, send a captured turn (extension queues), restart companion — queued capture replays, lands in vault, badge returns to "connected".
16. **Vault unreachable**: simulate vault folder removed (rename it). Companion banner surfaces. After re-pick, captures resume. No data loss for in-flight (queue holds).

### Standards gates

17. `cd packages/sidetrack-companion && npm run lint && npm run typecheck && npm test`
18. `cd packages/sidetrack-extension && npm run lint && npm run typecheck && npm test && npm run build`
19. `cd packages/sidetrack-extension && npm run e2e` (Playwright)
20. `cd packages/sidetrack-mcp && npm run lint && npm run typecheck && npm test`
21. **No `any` across boundaries.** Spot-check via `grep -nr ": any" packages/` returns nothing in production code.
22. **No hidden global state.** Spot-check via the standards' rubric — composition root wires dependencies; no service locators.

## Failure modes the milestone must surface gracefully

Per PRD §9, M1 must handle each of these with a side-panel banner +
graceful-degrade:

- Companion down → "Companion: disconnected · N items queued" red badge; queue grows; replays on reconnect
- Vault unreachable → "Vault: error" banner with `[Re-pick]` action
- Provider-capture broken (selector failure) → yellow banner with extractor-health stat + `[Queue diagnostic]` action
- MV3 SW idle death → silent recovery (companion is canonical)
- Local REST API plugin absent → no error (default state per §23.0)

## Out of scope clarifications (FAQ)

The "should I build X?" questions agents commonly ask:

- **Workstream tree, manual checklist, queue, inbound, tab recovery,
  per-workstream privacy flag** → **Yes, all in M1.** This is the
  "tracker complete" milestone.
- **Packet composer (Mock 5)** → **No, M2.** Dispatch milestone.
- **Dispatch confirm + safety chain (Mock 6, §24.10 Redaction +
  token-budget + screen-share-safe + injection-scrub)** → **No, M2.**
  These four primitives are ship-blocking for dispatch and travel
  together; defer the whole bundle to M2.
- **Inline review (Mock 7, §28)** → **No, M2.** Depends on dispatch.
- **First-run wizard polish (Mock 8 full version)** → **No, M2.**
  Programmatic config (paste-key) is the M1 onboarding. Add the
  install-path picker + provider-permission step + companion install
  helper in M2.
- **Coding session attach (Mock 12)** → **No, M2.** Standalone but
  small — folds into M2 with dispatch / annotation.
- **Annotation capture (Mock 14)** → **No, M2.** Input side of §28
  review.
- **Recent Dispatches view (Mock 13 second half)** → **No, M2.**
  Depends on DispatchEvent stream.
- **MCP write tools + per-workstream trust (§6.1.14)** → **No, M2.**
  Defers with dispatch.
- **MCP host role (§6.3.2)** → **No, M2+.**
- **Auto-download (§6.2.3)** → **No, M2.** Depends on packet outputs.
- **Vault Markdown projection — full Source notes / `.canvas` /
  `.base`** → **No, M2.** M1 writes JSONL events + JSON index files
  (machine-readable). Markdown projection ships when there's content
  to project (promoted artifacts from dispatch).
- **Smart recall (vector via transformers.js)** → **No, M2/M3.**
  Lexical only in M1.
- **Notebook link-back (PRD §10 Case B/C)** → **No, M3+.**
- **Screen-share-safe auto-detect** → **No, deferred per Q6 to P1+.**
  Per-workstream privacy flag (in M1) is the substantive control.
- **Multiple providers** → **Yes, all four (ChatGPT, Claude, Gemini,
  Codex) in M1.** Capture pattern is identical; ship the full set.

## Reference reading order (for the agent)

1. `AGENTS.md` (5 min)
2. `PRD.md` §1, §3, §5, §6.1.1 through §6.1.13, §9 (30 min)
3. `docs/adr/0001-companion-install-http-loopback.md` (5 min)
4. `BRAINSTORM.md` §23.0, §24.5, §27, §27.6 (10 min)
5. `CODING_STANDARDS.md` (10 min)
6. `standards/03-ts-browser-plugin.md` (15 min)
7. `standards/02-mcp-components.md` (10 min)
8. `standards/00-engineering-baseline.md` (10 min)
9. `poc/local-bridge/README.md` + skim source (20 min)
10. `poc/provider-capture/README.md` + skim all four extractors (25 min)
11. `poc/mcp-server/README.md` + skim source (15 min)
12. `poc/dogfood-loop/README.md` — workstream graph entities (15 min)
13. `design/MVP-mocks-prompts.md` Mocks 1, 2, 3, 4, 9, 10, 11, 13 (15 min)
14. `design/mockup-stage/REVIEW.md` + open `project/SwitchBoard.html`
    in a browser (20 min)

Total: ~3.5 hours of reading before code.

## Sequencing

Suggested order — each step is independently reviewable:

1. **Scaffold packages/sidetrack-companion/** — TS strict, lint, vitest, package.json + bin. Smoke: `npm test` passes.
2. **Scaffold packages/sidetrack-extension/** — WXT + React + TS strict, lint, vitest. Side panel renders "Hello Sidetrack" + companion-status badge. Smoke: `npm run build` produces a loadable extension.
3. **Scaffold packages/sidetrack-mcp/** — lift `poc/mcp-server` to standards. Smoke: `npm test` passes; stdio harness returns empty arrays for all tools.
4. **Companion: HTTP server + auth + bridge.key** (lift from `poc/local-bridge/companion`). Zod schemas at every boundary. Smoke: `curl` hits `/v1/health`.
5. **Companion: vault writer + audit log + capture-event endpoint** (Zod-validated `POST /v1/events`). Smoke: HTTP write → JSONL line in vault.
6. **Companion: workstream/queue/reminder endpoints** (full vault writer per Deliverable 1). Smoke: each endpoint writes the expected vault file.
7. **Extension: companion client + hot cache + queue** (lift from `poc/local-bridge/extension`). Smoke: side-panel test event → vault file grows.
8. **Extension: provider-capture for all four providers** (lift from `poc/provider-capture`). Smoke: each provider captures an assistant turn → POSTed to companion → in vault.
9. **Extension: side panel — Workboard sections** (Mock 1, all 6 sections). Wire to hot cache + companion state. Apply design tokens.
10. **Extension: workstream organization** (Mock 2 + Mock 4 — create / move / nested / drag / picker / Inbox / Misc).
11. **Extension: manual checklist** (Mock 2 sub-feature).
12. **Extension: queue UX** (add / edit / status; no dispatch wiring).
13. **Extension: inbound reminders** (Mock 13 first half — detection + surfacing).
14. **Extension: tab recovery dialog** (Mock 3).
15. **Extension: settings minimal** (Mock 9 subset — tracking, privacy, companion, about).
16. **Extension: per-workstream privacy flag** (data model + Mock 9 picker + Mock 11 masked render).
17. **bac-mcp: wire all M1 read tools to live vault.** Smoke: each tool returns expected data shape from a populated vault.
18. **Failure modes (PRD §9)**: companion-down banner, vault-unreachable banner, provider-broken canary banner, queue replay on reconnect.
19. **Standards gates + checklists** — all green.
20. **DEMO.md + STANDARDS-CHECK.md** — write up.

Each step is its own commit (or PR for smaller reviews). The
boundary at step 9 is intentional — steps 1-8 are infrastructure;
9-16 are user-facing UX; 17 is glue; 18 is robustness; 19-20 is
documentation.

## Done

When the E2E acceptance criteria + standards gates pass, file the
final commit, mark M1 complete in this README, and propose M2 scope
based on what surfaced. Expected M2: dispatch + §24.10 safety
primitives + packet composer + inline review + first-run wizard
polish + coding session attach + annotation capture + auto-download
+ MCP write tools + recent dispatches.

Naming: products use **Sidetrack**; existing `_BAC/` namespace
preserved per AGENTS.md.
