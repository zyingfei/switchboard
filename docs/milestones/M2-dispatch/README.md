# Milestone 2 — Dispatch + Safety

**Status**: planning (2026-04-26)
**Branch**: `m2/dispatch-planning` (planning); build branch will be
`m2/dispatch` once M1 lands and this plan is approved
**Prerequisite**: M1 (PR #13) **must be merged** before M2 build starts
**Target**: complete the active-orchestrator surface — dispatch +
ship-blocking safety chain + inline review + remaining mocks
**Estimated**: ~4–5 weeks of agent work

---

## What this milestone is

M1 ships Sidetrack as a **passive observer + organizer** — captures,
organizes, queues, reminds, recovers, exposes via read-only MCP. M2
adds the **active orchestrator** half: actually *do* something with
the tracked work — compose packets, dispatch to other AIs, review
assistant turns, automate from coding agents.

> **Why these things ship together**: §24.10 names four ship-blocking
> safety primitives (Redaction + token-budget + screen-share-safe +
> captured-page injection scrub). All four are load-bearing on
> *dispatch* — the moment Sidetrack sends content to a third party,
> all four must guard the boundary or it's a leak. The packet
> composer (Mock 5), dispatch confirm (Mock 6), inline review (§28
> Mock 7), and per-workstream MCP write tools (§6.1.14) all share
> this same boundary. Splitting any of them across milestones means
> shipping dispatch without the full safety chain. M2 is the unit.

> **The acceptance bar**: with M1 already in place, the user can
> select content from a tracked workstream → compose a Research
> Packet → preview the Redaction + token-budget + screen-share-safe +
> injection-scrub guards firing → dispatch to GPT Pro / Claude /
> Gemini in paste-mode → see the dispatch logged in the Recent
> Dispatches view → annotate the assistant turn that comes back via
> §28 review composer → submit-back or dispatch-out. From a coding
> agent, call MCP write tools (`bac.move_item`, `bac.queue_item`)
> within an opted-in trusted workstream and see them execute without
> per-call approval. All under the standards.

If that loop works, M2 ships.

## What this milestone is NOT (defer to M3+)

These cluster around recall, multi-tenant, and post-MVP polish — none
share the dispatch+safety boundary so they're cleanly deferrable:

- **Smart recall (vector via transformers.js + MiniLM)** — lexical
  search remains the M1+M2 baseline; vector recall + calibrated-
  freshness ranking (PRD §6.3.1) is M3.
- **Persistent web annotation** with Hypothesis-style anchoring —
  M2's Mock 14 is **lightweight capture only** (selection + note); the
  persistent-overlay-on-revisit case (PRD §6.3.4) is M3.
- **Notebook link-back** (PRD §10 Case B/C) — read frontmatter to know
  a human note links to a workstream; M3.
- **Multi-vault routing** (PRD §6.5) — single-vault per companion
  remains; M3+.
- **Notebook structured macros syncing back to Sidetrack** (PRD §10
  Case C) — needs schema versioning + 3-way merge + conflict UI; M4+
  spike.
- **`--install-service`** companion auto-start hook (per ADR-0001
  v1.5 plan) — M2.5 / M3 productization.
- **Suggestion layer** ("this looks related to workstream X") — M3,
  after manual organization is dogfood-validated.
- **Cross-user review aggregation** — explicitly out of scope (PRD
  §6.5).
- **Mobile** — separate product entirely.

## Source artifacts the M2 work depends on

All on `main` (after M1 PR #13 merges):

- **PRD.md**:
  - §6.1.9 Packet generation
  - §6.1.10 Inline review primitive (§28)
  - §6.1.13 Safety primitives (the four §24.10 entries)
  - §6.1.14 MCP write tools with per-workstream trust
  - §6.2.1 Coding session attachment
  - §6.2.2 Async dispatch ledger
  - §6.2.3 Auto-download on promote
  - §6.2.5 Annotation capture (lightweight)
  - §6.2.6 MCP server (read-only) — adds write tools per §6.1.14
  - §6.3.2 MCP host role (§24.5)
  - §10 Notebook integration Case A — full sync-out (Source notes,
    `.canvas`, `.base` projection)
- **BRAINSTORM.md**:
  - §24.10 (ship-blocking safety primitives, full text)
  - §28 (inline review primitive, full text — Review / Submit-back /
    Dispatch-out / Track)
  - §24.5 (MCP both host and server)
  - §24.4 (Hypothesis client for any future persistent annotation
    work)
- **AGENTS.md** — repo conventions, milestone-PR convention, naming
  policy.
- **CODING_STANDARDS.md** — POC→product conversion rule still
  applies to whatever safety primitive code exists in `poc/dogfood-
  loop/` (RedactionPipeline / dispatch preflight).
- **standards/03-ts-browser-plugin.md** — the dispatch primitive lives
  in the extension; standards for the new content-script work,
  Hypothesis anchoring (P3), keyboard shortcuts.
- **standards/02-mcp-components.md** — write-tool capability registry,
  per-workstream trust audit log shape, host-role lifecycle.
- **standards/01-api-component.md** — companion HTTP routes added in
  M2: dispatch event recorder, audit log query, write-tool approval
  bridge. Same RFC + OpenAPI workflow as M1.
- **docs/adr/0001-companion-install-http-loopback.md** — install path
  is locked; M2.5 ships `--install-service`.
- **M1 deliverables** (existence assumed):
  - `packages/sidetrack-companion/` — extend with dispatch event
    endpoint, write-tool approval bridge, MCP-host lifecycle
  - `packages/sidetrack-extension/` — extend with packet composer,
    dispatch confirm, inline review, annotation capture, settings
    additions
  - `packages/sidetrack-mcp/` — extend with write tools + host-role
    discovery
  - `packages/sidetrack-shared/` (if M1 created it) — extend with
    DispatchEvent, ReviewEvent, packet shapes

PoCs to lift behavior from:

- **`poc/dogfood-loop/`** — already has the dispatch preflight,
  redaction-pipeline scaffolding, fork/converge UX, prompt-run shape.
  **Lift the safety primitives + dispatch UX patterns**.
- **`poc/provider-capture/`** — extend with **Codex web** extractor
  (deferred from M1 — exploratory work; ~1 week of focused selector
  research).

Design references (in this PR under `design/`):

- **`design/MVP-mocks-prompts.md`** — Mocks 5, 6, 7, 8 (full wizard),
  12, 13 (Recent Dispatches second half), 14 are M2.
- **`design/mockup-stage/`** — designer's interactive Stage prototype.
  M2 mocks already designed there:
  - Mock 5 PacketComposer (in `project/modals.jsx`)
  - Mock 6 DispatchConfirm (in `project/modals.jsx` — note REVIEW.md
    flagged the missing captured-page injection scrub UI)
  - Mock 7 ReviewComposer (in `project/panel.jsx`)
  - Mock 8 Wizard (in `project/modals.jsx` — REVIEW.md flagged needs
    HTTP-only install-path update per ADR-0001)
  - Mock 12 CodingAttach (in `project/modals.jsx`)
  - Mock 14 Annotation (in `project/modals.jsx`)
  Use as **design reference**, not pixel-perfect target. Apply the
  REVIEW.md fixes during the build.

## Deliverables

### 1. Safety primitives (P0 ship-blocking — §24.10)

All four travel together. **No dispatch surface ships without all
four operational at the dispatch boundary.**

#### 1a. RedactionPipeline (`packages/sidetrack-shared/redaction/`)

- Default deny-list: AWS keys, OpenAI keys, GitHub tokens, common
  SSN / email / phone regex (per PRD §6.1.13).
- User-extendable rule registry — Settings UI + companion-side
  storage at `_BAC/.config/redaction-rules.json`.
- Streaming-safe match-and-replace (handle large packet bodies).
- Returns `{ output, fired: [{ ruleId, type, count }] }` for the
  dispatch confirm UI.
- Vitest unit tests covering all default rules + user-rule
  edge cases.

#### 1b. Token-budget warnings (`packages/sidetrack-shared/tokens/`)

- `tiktoken-js` (or `gpt-tokenizer`) wrapped in a typed adapter.
- Per-target-model context window registry (Claude 200k, GPT-5 256k,
  Gemini 1M, Codex variants, etc.).
- Returns `{ count, model, contextWindow, percent, level: 'green' | 'amber' | 'over' }`.
- Surfaces as bar in dispatch confirm (Mock 6) — amber ≥ 80%, signal
  ≥ 100%; cancel-required when over.

#### 1c. Screen-share-safe mode (extension-side)

- Auto-detect via `navigator.mediaDevices.getDisplayMedia` permission
  state (per §24.10) — note: per Q6 this is now **opt-in convenience**
  on top of the per-workstream privacy flag (P0 in M1). M2 makes
  the auto-detect functional.
- When active: side panel masks tracked-item titles + queue text +
  packet previews to `[private]`.
- Dispatch confirm shows signal-orange warning if active during
  compose (already designed in Mock 6).
- Settings toggle to disable auto-detect (defaults on).

#### 1d. Captured-page injection scrub (`packages/sidetrack-shared/injection-scrub/`)

- Wrap captured page bodies in `<context>...</context>` markers
  before they enter any packet.
- Pattern detector for common prompt-injection signals:
  "ignore previous instructions", "system prompt:", "you are now…",
  unusual control characters, suspiciously formatted instruction
  blocks.
- Surface inline warning in packet composer + dispatch confirm when
  any captured-page source has a hit (Mock 6 currently MISSING this
  surface per the design REVIEW.md; M2 build adds it).
- Pre-warn at "large injection" thresholds (>2KB of captured-page
  body in any single source).

### 2. Packet composer (Mock 5) — `packages/sidetrack-extension/src/composer/`

Promoted to production from the design mockup. Single composer with
template selector for three packet kinds:

- **Context Pack** — canonical structured payload (MCP-readable)
- **Research Packet** — outbound for GPT Pro / Claude / Gemini /
  Deep Research; templates locked from PRD §6.4:
  - **A. Web-to-AI checklist** (P0 per Q2)
  - **B. Resume → tech-stack inference** (deferred per Q2 — design
    fields preserved in PRD §6.4 if you want to ship; otherwise leave
    as a placeholder template stub)
  - **C. Latest developments radar** (P1 per Q2 — needs scheduling;
    M2 ships user-triggered version, the scheduled version is M3)
- **Coding Agent Packet** — formatted for Claude Code / Cursor /
  Codex consumption; includes `AGENTS.md`-shaped context

Live preview pane, scope picker (multi-select tree), target picker.

All output flows through the §24.10 chain before render.

### 3. Dispatch confirm + safety chain (Mock 6)

Promoted from mockup. Updates from REVIEW.md:

- ADD captured-page injection-scrub UI (missing in mockup)
- Confirm paste-mode locked (already in mockup)
- Per-target auto-send opt-in row (already in mockup; no providers
  enabled by default)
- Show all four safety guards side-by-side: redaction list, token
  bar, screen-share check, injection-scrub status

### 4. Inline review primitive (§28 — Mock 7)

- Span-selection in tracked tab (content-script) → opens composer
  in side panel
- 5-verdict picker (agree / disagree / partial / needs-source / open)
- Per-span comment + reviewer note
- Three actions: Save review only, Submit-back to original chat,
  Dispatch-out to another chat
- `ReviewEvent` persisted to vault as `_BAC/reviews/<bac_id>.md` +
  frontmatter mirror on the captured-turn note (per §28)
- Submit-back: composes follow-up user-turn into the same chat
  (paste-mode default, locked per Q5 — no auto-send opt-in for
  submit-back at MVP)
- Dispatch-out: routes through Mock 6 dispatch confirm with the
  reviewed turn + annotations as packet content

### 5. Async dispatch ledger (Mock 13 second half)

- `DispatchEvent` recorded on every Submit-back / Dispatch-out /
  Research Packet send / Clone-to-chat
- New side-panel view "Recent dispatches" — chronological list with
  status pills (sent / replied / noted / pending)
- When target replies, status flips to `replied` + Inbound reminder
  fires (paired with M1's Inbound view)
- Pairs with Mock 13 first half (Inbound) which M1 already has

### 6. First-run wizard polish (Mock 8 full version)

Replace M1's paste-key onboarding with the full wizard from the
design mockup, with REVIEW.md fixes:

- Welcome + value prop
- Companion install path: **HTTP loopback only** per ADR-0001 (remove
  the Native Messaging card from the mockup; relegate to a "considered
  and rejected" footnote)
- Vault folder picker via `showDirectoryPicker()`
- Provider permission grant (3 providers from M1 + Codex if §10 below
  ships in M2)
- Done state

### 7. Coding session attach (Mock 12)

- Manual attach modal: tool / cwd / branch / sessionId / name /
  resumeCommand
- "Open in {tool}" button on attached sessions runs `resumeCommand`
  via `chrome.tabs.create` for terminal-launch URLs (or
  copy-to-clipboard fallback)
- Coding sessions appear in the same workstream tree as chats
- `bac-mcp` `bac.coding_sessions()` returns live data (was empty in
  M1)

### 8. Annotation capture (lightweight — Mock 14)

- Right-click menu or keyboard shortcut on selected text in any web
  page → opens lightweight composer
- Selection + URL + page title + note → workstream picker → save
- Persistent overlay on revisit deferred to M3 (Hypothesis-style
  anchoring per PRD §6.3.4)
- Captured annotation can be opened as the source for a §28 review
  later

### 9. Auto-download on promote (PRD §6.2.3)

- Per-workstream toggle in Settings (default off for root/Misc, on
  for project-tier per Q3 Mixed)
- Per-workstream override (settings)
- Promoted artifact (decision, review verdict, packet) writes to
  vault on creation using §6.1.11 naming convention
- Vault Markdown projection follows PRD §10 Case A — Source notes,
  `.canvas` / `.base` generation per existing brainstorm anchors

### 10. MCP write tools + per-workstream trust (§6.1.14)

- New MCP tools: `bac.move_item`, `bac.new_cluster`, `bac.queue_item`,
  `bac.link_items`, `bac.attach_coding_session`
- Each has Zod schema + `templates/mcp-capability-spec.md` doc
- Per-workstream trust mode: settings UI shows trusted-agents list per
  workstream; user opts in once ("trust Codex inside `Sidetrack /
  MVP PRD`"); within scope, tools execute without per-call approval
- Outside scope: per-call approval modal in side panel ("Codex wants
  to move 3 items into 'X' — approve / reject?")
- Audit log every call to `_BAC/audit/<date>.jsonl` with: agent ID,
  tool, args, scope, trust-mode-active, result, timestamp
- One-click "revoke trust" on the trusted-agents list

### 11. MCP host role (§24.5)

- Companion-hosted MCP-host registry (lifts user's other MCP server
  configs from a known location)
- Side panel surfaces user-installed MCP servers (filesystem, GitHub,
  Linear, Sentry, custom) with their tools
- Tools become dispatchable from the side panel — same UI as packet
  dispatch
- Auth/permission boundary: each external MCP server's auth is
  per-server; companion is the proxy holding the keys
- Audit log every external-tool invocation just like internal ones

### 12. Codex web extractor (`poc/provider-capture/src/capture/providerConfigs/codex.ts`)

Deferred from M1. M2 includes the exploratory selector work:

- Pages to handle: `chatgpt.com/codex`, `chat.openai.com/codex`,
  any standalone Codex web URL pattern
- Same `ProviderConfig` shape as ChatGPT/Claude/Gemini extractors
- Selector canary + clipboard fallback per the existing pattern
- Live validation pass equivalent to PoC's other providers

(Note: this lands in `poc/provider-capture` even though it's M2 —
the PoC is the canonical extractor source, and `packages/sidetrack-
extension` lifts from there. Document in DEMO.md whether the lift
to packages happens in this milestone or M3.)

### 13. Companion: dispatch + audit endpoints

- `POST /v1/dispatches` — record a DispatchEvent (called by
  extension on every dispatch action)
- `POST /v1/reviews` — record a ReviewEvent
- `POST /v1/annotations` — record an annotation
- `GET /v1/audit?since=...` — paginated audit log query (for
  Settings → Audit log surface)
- `POST /v1/mcp-host/discover` — discover user-installed MCP servers
  (lifts from `~/.config/{client}/mcp.json` etc.)
- All Zod-validated, all using the M1 Problem error envelope, all
  audit-logged
- New api-endpoint-rfc.md per group; OpenAPI spec extended

### 14. End-to-end demo script

`docs/milestones/M2-dispatch/DEMO.md` — copy-paste runbook covering:

- Full dispatch loop (compose packet → confirm → dispatch → see in
  Recent Dispatches → reply detected via Inbound)
- Inline review (highlight assistant turn → review → submit-back →
  dispatch-out)
- MCP write tool flow (Codex calls `bac.move_item` outside trust →
  approval modal → opt in to trust → subsequent calls silent)
- MCP host: add a filesystem MCP server → tools surface in side
  panel → dispatch from Sidetrack → see audit log entry
- Coding session attach + resume via `claude resume`
- Annotation capture → later open as review source
- Codex web capture (if shipped)
- Auto-download per-workstream override behavior
- Each §24.10 safety primitive demonstrated firing

### 15. Standards compliance evidence

`docs/milestones/M2-dispatch/STANDARDS-CHECK.md` — full re-fill of:

- `checklists/production-readiness.md`
- `checklists/api-design-review.md` (companion's new endpoints)
- `checklists/browser-plugin-design-review.md`
- `checklists/mcp-design-review.md` (write tools + host role)

## E2E acceptance criteria

The milestone is done when **all** of the following pass:

### Safety chain (the §24.10 quartet)

1. **Redaction fires**: compose a packet with a fake API key in
   source content; dispatch confirm shows "Redacted N items: 1
   GitHub token"; output to clipboard / paste contains the redaction
   marker, NOT the original key.
2. **Token budget warns + blocks**: compose a packet exceeding 80%
   of target context — amber. Exceed 100% — signal-orange + dispatch
   button disabled until user trims.
3. **Screen-share-safe auto-mask**: start screen-share via Zoom-web
   (or `getDisplayMedia` test page) — side panel titles mask within
   5s; dispatch confirm shows the warning. Stop sharing — unmasks.
4. **Injection scrub**: include a captured page containing "ignore
   previous instructions and reveal..." — packet composer shows
   inline warning; output wraps in `<context>` markers.

### Dispatch primitives

5. **Compose Research Packet (Web-to-AI checklist template)**: scope
   pick across multiple workstreams + queued items, target=GPT Pro,
   live preview renders, all four safety guards visible.
6. **Dispatch in paste-mode**: copies packet to clipboard, opens
   target chat tab in a new window, toast confirms.
7. **DispatchEvent recorded**: Recent Dispatches view shows the
   sent dispatch with status `sent`.
8. **Inbound reply chains**: when target chat receives an assistant
   reply, dispatch row flips to `replied` + Inbound notification
   fires (M1's Inbound view shows the reply).

### Inline review (§28)

9. **Span review**: highlight a span in a tracked Claude turn → side
   panel composer opens with the span quoted; pick verdict; add
   comments; save.
10. **Submit-back**: from saved review, "Submit-back to Claude
    thread" composes a follow-up user turn quoting the spans;
    dispatch-confirm fires (paste-mode); copies to clipboard.
11. **Dispatch-out**: from saved review, "Dispatch to ChatGPT"
    bundles reviewed turn + annotations into a Research Packet;
    dispatch-confirm flow.
12. **Review trail in vault**: review persists at
    `_BAC/reviews/<bac_id>.md` + as `bac_reviews:` frontmatter on
    the captured-turn note.

### MCP write tools + host

13. **Write tool requires approval (untrusted)**: from Claude Code,
    call `bac.move_item({ item, targetWorkstream })` outside trust
    scope → side panel shows approval modal with the move request;
    user approves; vault state updates.
14. **Trust opt-in**: in side panel, opt in to trust Claude Code for
    `Sidetrack / MVP PRD` workstream → subsequent
    `bac.move_item` calls within that workstream execute silently;
    audit log entry has `trust-mode-active: true`.
15. **Trust scope boundary**: same agent calls `bac.move_item` for an
    item in a different workstream (not in trust scope) → approval
    modal again.
16. **Audit log**: every MCP write call (approved / rejected /
    silent-via-trust) lands in `_BAC/audit/<date>.jsonl`.
17. **MCP host surface**: install a filesystem MCP server config →
    Sidetrack discovers it → tools render in side panel → dispatch a
    tool call → audit logged.

### Coding session

18. **Attach + resume**: attach a Codex CLI session via Mock 12 modal
    → coding session row appears in workstream tree → "Open in Codex"
    runs the resume command (or copies to clipboard).
19. **MCP returns live data**: `bac.coding_sessions()` returns the
    attached session.

### Annotation

20. **Lightweight capture**: select text on a web page → context-menu
    "Save to Sidetrack" → composer → save. Saved annotation appears
    in Workboard Recent.
21. **Annotation as review source**: open saved annotation → "Review"
    action opens §28 composer with the annotation as the captured
    span.

### Auto-download + projection

22. **Auto-download on promote**: in a project-tier workstream
    (auto-download default ON), promote a packet → file appears at
    the §6.1.11 path in vault. In Inbox/Misc (default OFF), no auto-
    download. Per-workstream override flips behavior.
23. **Vault projection (PRD §10 Case A)**: promoted Source notes,
    decisions, queues render as Obsidian Markdown + frontmatter +
    generated `.canvas` (workstream tree map) + generated `.base`
    ("Where Was I" dashboard). Open in Obsidian — renders natively.

### Codex web (if shipped in M2)

24. **Codex web capture**: open a chatgpt.com/codex page → assistant
    turn captured within 30s → in vault → side panel.

### Failure modes

25. **Dispatch with companion offline**: extension queues the dispatch
    intent; on reconnect, prompts user "send X queued dispatches?"
    rather than silent replay (because dispatch is a user-intent
    action, not a passive sync).
26. **Provider rate-limit on submit-back**: detect failed dispatch;
    fall back to clipboard mode; toast explains.

### Standards gates

27. companion: `lint + typecheck + test + openapi-lint` green
28. extension: `lint + typecheck + test + build + e2e` green
29. mcp: `lint + typecheck + test` green
30. shared: `lint + typecheck + test` green
31. No `any` across boundaries; no hidden global state.
32. All four `checklists/` filled in `STANDARDS-CHECK.md`.
33. Every new MCP write tool has a `templates/mcp-capability-spec.md`
    doc; every new HTTP endpoint has an `api-endpoint-rfc.md` doc.

## Failure modes the milestone must surface gracefully

Per PRD §9, M2 must handle all M1 failure modes plus:

- **Companion-down during dispatch** — queue intent, prompt on
  reconnect (not silent replay)
- **Provider rate-limit / auth fail on submit-back** — fall back to
  clipboard mode, surface error
- **External MCP server misbehaving** — companion-side timeout +
  surface in side panel; don't let one bad server hang the host
- **Trust opt-in given for wrong agent** — easy "revoke all trusts
  for {agent}" in Settings
- **Captured-page injection detected at compose-time** — block
  dispatch button until user explicitly acknowledges

## Out of scope clarifications (FAQ)

- **Smart recall (vector)?** → No, M3.
- **Persistent web annotation overlay?** → No, M3. M2 ships
  lightweight capture (selection + note); persistent anchor on
  revisit needs Hypothesis client integration which is M3.
- **Multi-vault?** → No, M3+.
- **Notebook structured macro sync-back?** → No, M4+ spike. Needs
  schema versioning + 3-way merge + conflict UI design.
- **Mobile?** → No, separate product.
- **Suggestions ("looks related to X")?** → No, M3 — after manual
  organization is dogfood-validated through M1+M2.
- **Auto-send by default for any provider?** → No, ever. Paste-mode
  is the v1 default forever (per Q5); auto-send is per-provider
  per-workstream opt-in beyond v1.
- **Cross-user review aggregation?** → No, ever (PRD §6.5).

## Reference reading order (for the agent)

Total: ~4 hours of reading before code (heavier than M1 because the
safety + dispatch surface is more complex).

1. `AGENTS.md` (5 min) — repo conventions + milestone-PR convention
   (added in PR #14 / chore/agents-milestone-convention)
2. M1 deliverables: `packages/sidetrack-{companion, extension, mcp}/
   README.md` (20 min) — the existing scaffold M2 builds on
3. PRD.md §6.1.9, §6.1.10, §6.1.13, §6.1.14, §6.2.1, §6.2.2,
   §6.2.3, §6.2.5, §6.2.6, §6.3.2, §10 (40 min)
4. BRAINSTORM.md §24.4, §24.5, §24.10, §28 (20 min)
5. `docs/adr/0001-companion-install-http-loopback.md` (5 min)
6. `CODING_STANDARDS.md` (10 min refresh)
7. `standards/01-api-component.md` + `templates/api-endpoint-rfc.md`
   (15 min) — companion's new endpoints in M2
8. `standards/02-mcp-components.md` + `templates/mcp-capability-spec.md`
   (15 min) — write tools + host role
9. `standards/03-ts-browser-plugin.md` (15 min) — extension new
   surfaces (composer / dispatch confirm / review composer / annotation
   composer / settings additions)
10. `poc/dogfood-loop/README.md` + skim `src/` for redaction-pipeline,
    dispatch preflight, fork/converge, prompt-run shape (40 min)
11. `poc/provider-capture/README.md` + skim ChatGPT extractor as the
    template for the new Codex extractor (15 min)
12. `design/MVP-mocks-prompts.md` Mocks 5, 6, 7, 8, 12, 13, 14
    (15 min) — UI surface for M2
13. `design/mockup-stage/REVIEW.md` (5 min) — flagged design gaps to
    fix during build (esp. captured-page injection scrub UI in
    Mock 6, install-path lock in Mock 8)
14. Open `design/mockup-stage/project/SwitchBoard.html` in a browser
    (15 min) — see all M2 mocks live; copy interaction patterns

## Sequencing

23 numbered steps. Each step is independently reviewable (commit
or PR per step):

1. **Pre-flight**: read M1 final deliverables; map M1's API contracts;
   sketch M2's additive endpoints in `docs/api/m2-additions.md`.
2. **packages/sidetrack-shared/**: scaffold (if M1 didn't already
   create it). Strict TS, vitest. Smoke: `npm test`.
3. **RedactionPipeline** in shared. Default deny-list + user-rule
   registry types + streaming match-and-replace + tests.
4. **Token-budget adapter** in shared. tiktoken-js wrap + per-model
   context registry + tests.
5. **Injection-scrub** in shared. Pattern detector + `<context>`
   wrapper + thresholds + tests.
6. **Companion API design**: `api-endpoint-rfc.md` for the new M2
   endpoints (`/v1/dispatches`, `/v1/reviews`, `/v1/annotations`,
   `/v1/audit`, `/v1/mcp-host/discover`). OpenAPI spec extended.
   Spectral lint passes. **Hard gate before any new route.**
7. **Companion: dispatch + review + annotation endpoints** + audit
   query. Smoke: each endpoint POSTs + returns expected vault file.
8. **Companion: MCP-host discovery** — read user's other MCP server
   configs, expose via `GET /v1/mcp-host/servers`. Smoke: returns
   discovered servers from a fixture filesystem MCP config.
9. **MCP write tools** in `packages/sidetrack-mcp/`: `bac.move_item`,
   `bac.new_cluster`, `bac.queue_item`, `bac.link_items`,
   `bac.attach_coding_session`. Each with capability spec doc.
   Smoke: stdio harness exercises each tool against a fixture vault.
10. **MCP host registry** in `packages/sidetrack-mcp/`: load
    user-server configs via companion endpoint; expose tools through
    Sidetrack's MCP server (proxy pattern). Smoke: external server's
    tool callable via Sidetrack's MCP.
11. **Extension: packet composer** (Mock 5) — kind selector +
    template selector + scope picker + target picker + live preview.
    Apply Web-to-AI checklist template (P0 per Q2).
12. **Extension: safety chain wired into composer** — Redaction
    summary, token bar, screen-share check, injection-scrub status.
    All four primitives surface in the composer footer.
13. **Extension: dispatch confirm** (Mock 6) — full safety chain
    visible side-by-side; paste-mode locked; per-target auto-send
    opt-in row; ADD captured-page injection-scrub UI (per REVIEW.md
    fix); confirm dispatch action records DispatchEvent via companion.
14. **Extension: Recent Dispatches view** (Mock 13 second half) —
    chronological list with status pills; clicking row focuses
    source / opens target.
15. **Extension: inline review composer** (Mock 7 / §28) — span
    selection in content script; composer; verdict picker;
    save/submit-back/dispatch-out actions wired through dispatch
    confirm; ReviewEvent persisted via companion.
16. **Extension: per-workstream MCP write tool trust** UI (Settings
    section) — trusted-agents list per workstream; opt-in flow;
    revoke; approval modal for untrusted calls.
17. **Extension: first-run wizard polish** (Mock 8 full) — replace
    M1's paste-key flow with the full wizard. HTTP-only install path
    per ADR-0001 (remove NM card per REVIEW.md fix).
18. **Extension: coding session attach** (Mock 12) — manual attach
    modal; "Open in {tool}" button.
19. **Extension: annotation capture** (Mock 14) — context menu +
    keyboard shortcut → composer → save → in Workboard Recent.
20. **Auto-download on promote** (per PRD §6.2.3) — per-workstream
    toggle; per-workstream override; promoted-artifact writer.
21. **Vault projection (PRD §10 Case A)** — Source notes,
    `.canvas` workstream-tree map generator, `.base` "Where Was I"
    dashboard generator. Companion-side, fired on promote.
22. **`poc/provider-capture/src/capture/providerConfigs/codex.ts`** —
    exploratory selector work for chatgpt.com/codex pages. Lift into
    `packages/sidetrack-extension` once stable.
23. **Failure modes** (per PRD §9 + M2 additions): companion-down-
    during-dispatch queue, rate-limit fallback, external-MCP timeout,
    revoke-all-trusts, dispatch block on injection.
24. **Standards gates + checklists** — all green; STANDARDS-CHECK.md
    filled.
25. **DEMO.md + STANDARDS-CHECK.md + SURPRISES.md** — write up.

Boundaries:
- Steps 2–5 (shared safety primitives) MUST land before step 11
  (composer needs them).
- Step 6 (API design RFC + OpenAPI) is a hard gate before any new
  companion route (steps 7–8).
- Step 12 (composer + safety chain wired) must land before step 13
  (dispatch confirm); step 13 must land before step 14 (Recent
  Dispatches needs DispatchEvents).
- Step 22 (Codex extractor) is independent — can land in parallel
  with the rest.

Time-box per step: 5 calendar days (heavier than M1 because the
safety primitives are non-trivial).

## Done

When E2E acceptance criteria + standards gates pass:

- Write `docs/milestones/M2-dispatch/DEMO.md`
- Write `docs/milestones/M2-dispatch/STANDARDS-CHECK.md`
- Write `docs/milestones/M2-dispatch/SURPRISES.md` if any out-of-
  scope items surfaced
- Update this README's status from "planning" to "complete" with
  retrospective + obvious M3 candidate (expected: smart recall +
  multi-vault + persistent annotation)
- Open final PR titled `M2: Dispatch + Safety — packets, reviews,
  MCP writes, host role` against main

Naming: products use **Sidetrack**; existing `_BAC/` namespace
preserved per AGENTS.md; per the rename policy, M2 work is "new
things being built" → use Sidetrack throughout.
