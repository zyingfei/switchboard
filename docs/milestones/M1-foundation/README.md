# Milestone 1 — Foundation

**Status**: planning (2026-04-26)
**Branch**: `m1/foundation`
**Target**: production scaffolds + minimal end-to-end vertical slice
**Estimated**: ~1.5–2 weeks of agent work

---

## What this milestone is

The smallest possible vertical slice that proves the v1 architecture
works end-to-end with **real production-grade code** following the
standards. Not a PoC. Not a feature-complete MVP. The thinnest path
from "user opens an AI chat" to "coding agent can ask `bac.recent_threads`
and get the captured thread."

> **The acceptance bar**: open a real ChatGPT chat → side panel shows
> the thread → captures land in the vault as JSONL → run
> `bac-mcp --vault <path>` from a separate terminal → `bac.recent_threads`
> returns the thread within 30 seconds. Repeat with Chrome restarted.

If that loop works under the standards in `CODING_STANDARDS.md` and
`standards/03-ts-browser-plugin.md`, M1 ships.

## What this milestone is NOT

Defer to M2 and beyond:

- Workstream tree organization (Mock 2 — nested clusters, move-to,
  drag-and-drop)
- Manual checklists, queues, packets, reviews, dispatches, settings
  beyond minimum
- First-run wizard (use programmatic config for M1; build wizard in M2)
- Tab recovery (Mock 3)
- §24.10 ship-blocking safety primitives (Redaction, token-budget,
  screen-share-safe, captured-page injection scrub) — they ship-block
  on **dispatch**; M1 has no dispatch surface
- Inline review (Mock 7) — depends on §28 dispatch, deferred with §24.10
- §6.1.14 MCP write tools with per-workstream trust — read-only MCP only
  in M1
- §6.3.2 MCP host role
- Per-workstream privacy flag UI (the data field exists but no settings
  surface yet)
- Inbound reminders, Recent Dispatches view
- Coding session attach
- Annotation capture
- Auto-download (per Q3 — needs packet system first)
- Smart recall (vector); lexical-only is fine for M1
- Notebook link-back / canvas / bases generation (Mock 11.A in PRD §10
  Case A is sync-out; M1 only writes events + thread metadata, not the
  full Markdown projection — that's M2)

These deferrals are documented in PRD §6.5 and §11. M1 must not
re-litigate them.

## Source artifacts the M1 work depends on

All on `main` after the PRD/standards/brainstorm merges:

- **PRD.md** — especially §5 (architecture), §6.1.1 (Workboard layout),
  §6.1.2 (capture + tracking), §6.1.7 (tab recovery — but only for
  surfacing closed-tab state in the side panel; recovery dialog is M2),
  §6.2.6 (MCP server read-only).
- **BRAINSTORM.md** — anchors §23.0, §24.5, §27, §27.6 (the architecture
  the milestone implements).
- **AGENTS.md** — repo conventions, `_BAC/` namespace, `bac_id` stable
  identity, vault canonical, paste-mode default (no dispatch in M1
  anyway).
- **CODING_STANDARDS.md** — non-negotiables, ports & adapters,
  POC→product conversion rule.
- **standards/03-ts-browser-plugin.md** — MV3 service-worker lifecycle,
  typed message bus, content-script isolation, permission minimization,
  storage migrations.
- **standards/02-mcp-components.md** — MCP capability registry,
  lifecycle, safety, transport.
- **docs/adr/0001-companion-install-http-loopback.md** — companion
  install path is HTTP loopback (locked).

PoCs to lift behavior from (per CODING_STANDARDS.md §"POC-to-product
conversion rule" — capture as tests, design boundary, implement through
standard architecture, then archive):

- **`poc/local-bridge/`** — companion + extension client + 60-min
  sustained tick proven. **This is the foundation lift.**
- **`poc/provider-capture/`** — DOM capture for ChatGPT/Claude/Gemini/
  Codex web with selector canary + clipboard fallback. **The capture
  side is here.**
- **`poc/mcp-server/`** — stdio MCP server reading vault state. **The
  read side is here; will be re-pointed at the live vault.**

Design references (in this PR under `design/`):

- **`design/MVP-mocks-prompts.md`** — Mock 1 (Workboard) is the only
  M1 design surface. Mocks 2–14 are M2+.
- **`design/mockup-stage/`** — designer's interactive Stage prototype.
  Use for design language (paper / ink / signal-orange / Fraunces /
  Source Serif 4 / JetBrains Mono) and the Workboard's interaction
  patterns. **Not pixel-perfect target** per user direction; recreate
  in TypeScript-strict React.

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
- Audit log every write to `_BAC/audit/<date>.jsonl` (per PRD §6.2.6)
- Capability registry pattern for HTTP routes (open-for-extension,
  closed-for-modification per CODING_STANDARDS.md §4)
- Vitest unit tests for: schema validation, vault writer, auth
  rejection, queue replay
- Integration test: in-process HTTP client → companion → vault →
  filesystem inspection
- `package.json` `bin: { "sidetrack-companion": "./dist/cli.js" }` for
  `npx @sidetrack/companion`

### 2. `packages/sidetrack-extension/` (production scaffold)

Promote `poc/local-bridge/extension/` + `poc/provider-capture/`
content-script logic to production-grade per
`standards/03-ts-browser-plugin.md`:

- WXT + React + TypeScript MV3 (matches all existing PoCs)
- Strict TS via `configs/ts/tsconfig.base.json`
- Typed message bus (no `any` across context boundaries)
- Content-script isolation per `standards/03-ts-browser-plugin.md`
- `chrome.storage.local` for hot cache + capture queue (per PRD §5.3);
  vault is canonical
- Side-panel React app rendering **a minimal Mock 1 Workboard** —
  Current Tab section + Recent section only. No workstream tree, no
  queue, no inbound, no needs-organize. Just the two sections that
  prove tracking works.
- Capture pipeline: lift from `poc/provider-capture` for at least
  ChatGPT (one provider proves the pattern). Selector canary with
  clipboard fallback per PRD §6.1.2.
- Companion client: lift from `poc/local-bridge/extension` (HTTP
  loopback per ADR-0001).
- Permission minimization per `standards/03-ts-browser-plugin.md` —
  ship at install with `activeTab + storage`; request host permissions
  per-provider via `chrome.permissions.request()`.
- Vitest unit tests for: message bus contracts, capture queue, hot
  cache.
- Playwright extension e2e: extension loaded → mock chat tab → capture
  observed → companion received.

### 3. `bac-mcp` re-pointed at live vault

The existing `poc/mcp-server/` is the read side. For M1:

- No code rewrite — just confirm it works against the real vault
  populated by the M1 companion+extension.
- Tools active in M1: `bac.recent_threads`, `bac.workstream` (returns
  the single implicit "uncategorized" workstream for M1), `bac.search`
  (lexical over the vault). Other tools exist but return empty
  collections gracefully.
- Update `poc/mcp-server/README.md` with the new live-vault demo path.

### 4. End-to-end demo script

`docs/milestones/M1-foundation/DEMO.md` (created on completion) —
copy-paste runbook: install companion, install extension, open
ChatGPT, see thread, run `npx bac-mcp --vault <path>` in another
terminal, run a real Claude Code session that calls `bac.recent_threads`
and gets the thread. Includes cold-start (Chrome restarted) variant.

### 5. Standards compliance evidence

`docs/milestones/M1-foundation/STANDARDS-CHECK.md` (created on
completion) — fill the relevant checklists:

- `checklists/production-readiness.md`
- `checklists/browser-plugin-design-review.md`
- `checklists/mcp-design-review.md` (light — read-only MCP)

## E2E acceptance criteria

The milestone is done when **all** of the following pass:

1. **Companion starts cleanly**: `npx @sidetrack/companion --vault /tmp/sidetrack-m1` boots, binds 127.0.0.1, writes `bridge.key` to `_BAC/.config/`, logs startup with version + port to stderr. Health endpoint responds within 1s.
2. **Extension installs and connects**: load unpacked from `packages/sidetrack-extension/.output/chrome-mv3`. First-run paste of `bridge.key` connects to companion. Side-panel header shows "vault: connected · companion: running".
3. **ChatGPT capture lands in vault**: open `chat.openai.com`, send one message, get one assistant turn. Within 30 seconds the assistant turn appears as a JSONL line in `/tmp/sidetrack-m1/_BAC/events/<date>.jsonl` with `provider: "chatgpt"`, `threadId`, `threadUrl`, `capturedAt`.
4. **Side panel shows the thread**: Current Tab section shows the ChatGPT thread title (italic-serif if AI-authored) with provider chip and relative timestamp. Recent section lists it.
5. **bac-mcp returns the thread**: from a terminal, `npx bac-mcp --vault /tmp/sidetrack-m1` boots; an in-process stdio client (or real Claude Code with the MCP config) calls `tools/call` with `{ name: "bac.recent_threads" }` and gets the thread back within 5 seconds.
6. **Chrome restart survives**: quit Chrome, restart, reopen ChatGPT — side panel reconnects to companion (companion stayed running), Recent shows the prior thread, capturing continues.
7. **Companion crash recovers**: kill companion mid-session, send a ChatGPT message (extension queues), restart companion — queued capture replays, lands in vault.
8. **Standards gates pass**:
   - `cd packages/sidetrack-companion && npm run lint && npm run typecheck && npm test`
   - `cd packages/sidetrack-extension && npm run lint && npm run typecheck && npm test && npm run build`
   - `cd packages/sidetrack-extension && npm run e2e` (Playwright)
   - All green.
9. **No `any` across boundaries.** Spot-check via `grep -nr ": any" packages/` returns nothing in production code (test files exempt).
10. **No hidden global state.** Spot-check via the standards' rubric — composition root wires dependencies; no service locators.

## Failure modes the milestone must surface gracefully

Per PRD §9, M1 must handle:

- Companion down: extension shows "companion: disconnected · N items queued" red badge; queue grows in `chrome.storage.local`; replays on reconnect.
- Vault unreachable: companion shows error; queue captures in-memory bounded; surfaces side-panel banner.
- Provider-capture broken (ChatGPT redesign): selector-canary detects miss; switch to clipboard mode; yellow banner in side panel.

## Out of scope clarifications (frequent questions agents ask)

- "Should I build the workstream tree?" — **No.** M1 has only an implicit "uncategorized" workstream. Workstream tree is M2.
- "Should I build the move-to picker?" — **No.** No reorganization in M1.
- "Should I add the manual checklist?" — **No.** M2.
- "Should I add Inbound reminders?" — **No.** M2.
- "Should I do the dispatch composer / Confirm dispatch / safety chain?" — **No.** M1 has no dispatch surface; safety primitives are not yet load-bearing. M2 + M3.
- "Should I add the per-workstream privacy flag UI?" — **No.** Data model field can exist; UI is M2.
- "Should I do the first-run wizard?" — **No.** Programmatic config (paste `bridge.key` once) is the M1 onboarding. Wizard is M2.
- "Should I implement multiple providers (ChatGPT + Claude + Gemini)?" — **One provider in M1; ChatGPT preferred** (most coverage in `poc/provider-capture`). Adding more providers is mechanical and is M1.5 / M2.
- "Should I write to vault as full Markdown notes (per PRD §10 Case A)?" — **No.** M1 writes only `_BAC/events/<date>.jsonl` events + a small `_BAC/threads/<bac_id>.json` index per tracked thread. Markdown projection is M2.

## Reference reading order (for the agent)

1. `AGENTS.md` (5 min) — repo conventions
2. `PRD.md` §1, §3, §5, §6.1.1, §6.1.2 (15 min) — what we're building
3. `docs/adr/0001-companion-install-http-loopback.md` (5 min) —
   companion install rationale
4. `BRAINSTORM.md` §23.0, §24.5, §27, §27.6 (10 min) — load-bearing
   anchors (use `BRAINSTORM-INDEX.md` to navigate)
5. `CODING_STANDARDS.md` (10 min) — non-negotiables
6. `standards/03-ts-browser-plugin.md` (15 min) — extension standards
7. `standards/02-mcp-components.md` (10 min) — MCP read-side standards
8. `poc/local-bridge/README.md` + skim source (20 min) — what's been
   proven; what to lift
9. `poc/provider-capture/README.md` + skim source (15 min) — capture
   pattern to lift
10. `poc/mcp-server/README.md` (10 min) — read side as-is
11. `design/MVP-mocks-prompts.md` Mock 1 only (5 min) — Workboard layout
12. `design/mockup-stage/REVIEW.md` (5 min) — context for the mockup
13. `design/mockup-stage/project/SwitchBoard.html` open in browser
    (15 min) — see the design language live

Total: ~2 hours of reading before code.

## Sequencing

Suggested order — each step is independently reviewable and gates the next:

1. **Scaffold packages/sidetrack-companion/** — TS strict, lint, vitest, package.json + bin. No business logic. Smoke-test: `npm test` passes.
2. **Scaffold packages/sidetrack-extension/** — WXT + React + TS strict, lint, vitest. Side panel renders "Hello Sidetrack" + companion-status badge. Smoke: `npm run build` produces a loadable extension.
3. **Companion: HTTP server + auth + bridge.key** (lift from poc/local-bridge/companion). Smoke: `curl -H "x-bac-bridge-key: $(cat ...)" http://127.0.0.1:7331/v1/health` returns 200.
4. **Companion: vault writer + audit log + Zod schemas at all boundaries**. Smoke: POST `/v1/events` writes to `_BAC/events/<date>.jsonl`.
5. **Extension: companion client + hot cache + queue** (lift from poc/local-bridge/extension). Smoke: side-panel test event button → vault file grows.
6. **Extension: provider-capture content script for ChatGPT** (lift from poc/provider-capture). Smoke: open chat.openai.com → assistant turn captured → POSTed to companion → in vault.
7. **Side panel: minimal Mock 1 Workboard** — Current Tab + Recent only. Wire to hot cache + companion state. Apply design tokens from `design/mockup-stage/project/styles.css`.
8. **bac-mcp re-point + smoke**: `npx bac-mcp --vault /tmp/sidetrack-m1` against live vault. Confirm `bac.recent_threads` returns captured threads.
9. **Failure modes** — kill companion, restart, restart Chrome, broken selector. Verify each per PRD §9.
10. **Standards gates + checklists** — all green.
11. **DEMO.md + STANDARDS-CHECK.md** — write up.

Each step is its own commit (or PR if you prefer smaller reviews). Don't
batch step 5 and 7; design-system application (step 7) is its own
review unit.

## Done

When the E2E acceptance criteria + standards gates pass, file the
final commit, mark M1 complete in this README, and propose M2 scope
based on what surfaced.

Naming: products use **Sidetrack**; existing `_BAC/` namespace
preserved per AGENTS.md.
