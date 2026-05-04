# Sidetrack MVP — Product Requirements Document

**Version**: 0.1 (draft for review)
**Branch**: `prd/switchboard-mvp-v1`
**Status**: Adversarial-review draft, supersedes ChatGPT planner draft (see PR review thread)
**Depends on**: PR #9 (`brainstorm/principle-and-sync-and-reviews`) for the §23.0 / §27 / §27.6 / §28 anchors referenced below.

---

## 1. One-line scope

Sidetrack MVP is the **side-panel workboard** that keeps active AI work
from scattering across tabs, providers, searches, and coding sessions.
Track by default, reorganize manually, queue follow-ups, recover lost
tabs, and generate portable packets for other AIs, notebooks, and coding
agents.

It is explicitly **not**: a memory product, an Obsidian export tool, a
generic browser-automation MCP, an annotation-only plugin, or an
auto-organizer.

## 2. Source of truth

This PRD is grounded in two artifacts of different weight:

- **User napkin (2026-04-26)** — a rough brain-dump capturing user
  intent on the side-panel workstream model, queues, async tracking,
  tab recovery, packet generation, notebook integration boundary, and
  coding-agent boundary. The napkin is authoritative on *what to build
  and why*, not on precise wording or implementation detail. The PRD's
  job is to operationalize the napkin's intent without drifting from
  it. See PR review thread.
- **BRAINSTORM.md anchors** (locked) — architectural decisions the PRD
  must not contradict:
  - **§23.0** — Obsidian first-class citizen; BAC depends only on
    interfaces and core (filesystem + Markdown + frontmatter + `.canvas` +
    `.base` + `_BAC/`). Plugins (incl. Local REST API) are opt-in
    acceleration, never required.
  - **§24.5** — MCP both host and server. Server: BAC exposes its event
    log + recall + notebook to coding agents. Host: BAC surfaces user-
    installed MCP servers in the side panel.
  - **§24.10** — Ship-blocking safety primitives: RedactionPipeline,
    token-budget warnings, screen-share-safe mode, prompt-injection
    scrub for captured pages.
  - **§27** — Connection setup, sync-in (vault → BAC), sync-out (BAC →
    vault) are three separate concepts.
  - **§27.6** — Companion process is the v1 writer architecture. MV3 +
    FileSystemAccess cannot own writes for sustained or silent operation
    (vault-bridge PoC empirical result).
  - **§28** — Inline review primitive: annotate spans of an assistant
    turn; submit-back to original chat; dispatch-out to another chat;
    track via `ReviewEvent`.

If the PRD drifts from napkin intent or contradicts a locked BRAINSTORM
anchor, the PRD is the bug. Detail and wording the napkin doesn't pin
down are the PRD's to decide.

## 3. The user problem

Direct from the napkin (paraphrased, not invented):

> "I'm working across multiple AI threads, searches, tabs, and coding
> agents. Some are for real projects. Some are ad-hoc. Some are misc
> life questions. Some have pending follow-up questions. Some are
> closed or forgotten. Some need to be sent to another AI. Some need to
> become structured notes later. **I lose track.**"

The napkin's worked example: two real projects (this plugin, VM live
migration), plus misc life tasks (travel planning, email replies, random
searches). The user **does not always create project folders first** —
they often start with ad-hoc root chats and reorganize after the shape
becomes clear. Reorganization happens **multiple times** as understanding
evolves.

## 4. Product principles

These constrain every scope decision below.

1. **Track by default, organize by user action, suggest later.** No AI
   auto-organization in MVP.
2. **Ad-hoc first, project later.** Inbox/Misc are first-class. Project
   assignment is optional, not required.
3. **Reorganization is the normal state, not error recovery.** Users move
   items between clusters multiple times; the data model must preserve
   identity through every move.
4. **Queues, inbound reminders, and manual checklists are first-class
   objects** — not afterthoughts attached to other things.
5. **Sidetrack owns workstreams.** Memory products, notebooks, smart
   recall, and coding agents plug in via interfaces — Sidetrack does
   not become any of those.
6. **Safety primitives (§24.10) are ship-blocking, not polish.** Every
   outbound dispatch routes through Redaction + token-budget + screen-
   share-safe + injection-scrub. Default-deny.
7. **Vault is canonical state.** Per §23.0 + §27.6, the companion writes
   to the vault via plain filesystem; the extension is a sensor + UI;
   the MCP server is a stateless reader over stdio or local WebSocket.
   No production state lives only in `chrome.storage.local`.

## 5. Architecture (load-bearing — not an implementation detail)

Per §27.6, the v1 architecture is **three independent processes** that
communicate only through the vault on disk (and a thin extension ↔
companion bridge for live capture):

```text
┌──────────────────────────┐                ┌──────────────────────────┐
│ Chrome MV3 extension     │                │ Coding agent             │
│  (browser sensor + UI)   │                │ (Claude Code, Cursor,    │
│  - provider-capture      │                │  Codex CLI, JetBrains…)  │
│  - side-panel workboard  │                └─────────────┬────────────┘
│  - hot cache + capture   │                              │ stdio / WebSocket
│    queue                 │                              │
└──────────┬───────────────┘                              │
           │ HTTP loopback on 127.0.0.1                   │
           │ (per ADR-0001 — Q4 decision; Native           │
           │  Messaging considered and rejected)            │
           ▼                                              │
┌──────────────────────────┐                              │
│ Companion (Node)         │                              │
│  - holds vault path      │                              │
│  - owns ALL vault writes │                              │
│  - runs sustained tasks  │                              │
│    (live tabs, embed     │                              │
│    rebuild, batch sync)  │                              │
└──────────┬───────────────┘                              │
           │ Node fs                                      │
           ▼                                              │
┌──────────────────────────────────────────────────────┐  │
│ Vault folder (canonical state)                       │  │
│  Projects/.../*.md       Source notes + decisions    │  │
│  _BAC/workstreams/*.md   Workstream tree projection  │  │
│  _BAC/events/*.jsonl     Append-only event log       │  │
│  _BAC/dashboards/*.base  Where Was I, queues, etc.   │  │
│  _BAC/reviews/*.md       Inline review trail (§28)   │  │
│  _BAC/recall/index.bin   Rebuildable embedding cache │  │
│                  ▲                                   │  │
└──────────────────│───────────────────────────────────┘  │
                   │ Node fs                              │
                   ▼                                      ▼
          ┌────────────────────────────────────────────┐
          │ sidetrack-mcp (Node, stateless reader)     │
          │ stdio or ws://127.0.0.1:8721/mcp          │
          │ bridge-key gated when WebSocket is used    │
          └────────────────────────────────────────────┘
```

### 5.1 Process responsibilities

| Process | Owns | Does not own |
|---|---|---|
| **Extension** | DOM capture, side-panel UI, hot cache for snappy reads, capture queue when companion is offline | Vault writes, sustained timers, long-lived state |
| **Companion** | All vault writes, live-tab tick, embedding-index rebuild, replay of extension's offline queue, audit log | UI, browser DOM, MCP client config |
| **Vault** | Canonical state in plain files | Anything else; it's just files |
| **sidetrack-mcp** | Read-only access to vault state via stdio MCP or local WebSocket JSON-RPC (`ws://127.0.0.1:8721/mcp`) | Any state of its own; the side panel and companion HTTP routes keep working without MCP |

### 5.2 Why the companion (not just extension)

Empirically validated by `poc/vault-bridge` (2026-04-26):

- **U6 fail**: MV3 service-worker `setInterval` died at sequence 30
  (~30 s, MV3 idle window). Continuous timers cannot live in the SW.
- **U5 fail-risk**: FileSystemAccess `queryPermission()` returned
  `prompt` after a SW restart inside the same Chrome session. Silent
  capture is not achievable when permission state is tied to SW
  lifecycle.

The companion holds the vault path at the OS level (no permission UX),
survives SW deaths and browser closes, and runs whatever sustained tasks
the side panel needs.

### 5.3 What stays in the extension

- Side-panel React UI (workboard, search, packet composer, etc.)
- Provider-capture content scripts (DOM capture per provider)
- Hot cache in `chrome.storage.local` for snappy side-panel reads (TTL'd,
  evictable, never the source of truth)
- Capture queue in `chrome.storage.local` when companion is unreachable;
  drains on reconnect with chronological replay; cap at 1000 items with
  oldest-eviction
- Companion-status badge in the side panel

### 5.4 Substrate (per §23.0)

- Companion writes via plain Node `fs` (atomic temp-file-then-rename)
- File formats: Markdown + YAML frontmatter + JSON Canvas + `.base`
- `_BAC/` reserved namespace for Sidetrack-owned files
- Local REST API plugin: opportunistic acceleration only (surgical
  PATCH-with-frontmatter / PATCH-with-heading); detected at startup;
  **never required** for any operation

### 5.5 Sync direction (per §27)

- **Connection setup**: one-time companion install + vault path config.
  Side panel surfaces "vault: connected · companion: running".
- **Sync-in (vault → Sidetrack)**: companion scans vault on startup +
  on FS event (when supported); reconciles `bac_id`-keyed entities;
  surfaces user-edited frontmatter changes back to the side panel.
- **Sync-out (Sidetrack → vault)**: per-event, owned by companion.
  Source notes, event log, dashboards, review trail, all written by
  companion via Node `fs`.
- **Conflicts/merges**: deferred. Tentative posture: last-write-wins on
  `bac_*` frontmatter keys; user-owned keys never overwritten; body
  merges via heading-targeted PATCH (REST API path) or delimited-region
  markers (`<!-- bac:region:notes -->`) on the filesystem path. Detailed
  conflict design lives in a separate spike, not v1 scope.

## 6. Scope: P0 / P0.5 / P1 / P2

Scoping is graded by *what blocks an honest dogfood demo of the
acceptance scenario in §13*. P0 is mandatory; P0.5 is strong dogfood
addition; P1 is post-MVP iteration; P2 is explicit deferral.

### 6.1 P0 — must ship

#### 6.1.1 Side-panel workboard

The main product surface. Six views, switchable but all visible by
default in a single scrollable panel:

- **Current tab** — if tracked, show where it lives in the workstream
  tree; quick actions (Stop, Queue, Packet)
- **Active work** — tracked items grouped by primary workstream; collapse
  to project headers
- **Queued (outbound)** — pending follow-up asks; grouped by target
  thread/workstream/provider
- **Inbound (NEW)** — tracked threads where a new assistant turn arrived
  since last visit; "Claude replied 3 minutes ago"
- **Needs organize** — items in Inbox/Misc that the user hasn't placed
- **Recent / Search** — lexical search box + recent-touched list

Sort/filter affordances: by `lastSeenAt`, by provider, by workstream,
by status, by tag. "X minutes ago" relative timestamps as the napkin
asks.

#### 6.1.2 Capture + tracking

- **Auto-track** for supported providers (ChatGPT, Claude, Gemini, Codex
  web). Default on; per-site toggle.
- **Manual track current tab** — button in side panel; works on any URL.
- **Stop auto-tracking** — per-tab and per-site.
- **Remove tracking** — drops the item entirely.
- **Selector-canary fallback** — when DOM selectors break (provider
  redesign), switch to clipboard mode and warn in side panel.
- **Source provenance** on every captured turn: `provider`, `model` if
  detectable, `threadId`, `threadUrl`, `capturedAt`, `selectorCanary`
  status.

#### 6.1.3 Workstream organization

- **Nested tree**: project → cluster → subcluster (unlimited depth, but
  UI defaults to 3-level visible).
- **Move items** between workstreams; identity preserved by `bac_id`,
  not by file path.
- **Inbox/Misc** as first-class default. Project assignment is optional.
- **Iterative reorganization** is the design center: create / rename /
  move / delete-empty / split / merge are all one-click operations,
  expected to happen often.
- **Tags** orthogonal to the tree (one item, multiple tags).
- **Links** between items (typed: `related`, `source_of`, `follow_up`,
  `coding_session_for`, `dispatched_to`, etc.).

#### 6.1.4 Queue (outbound asks)

- `QueueItem` attached to: a tracked thread, a workstream, a provider,
  or global.
- Status: `pending` → `ready` → `sent` / `done` / `skipped`.
- "Compose packet from queue" — selected queue items become the
  questions section of a Research Packet.
- No auto-send (paste-mode default per §24.10).

#### 6.1.5 Inbound reminders (NEW — was missing in planner draft)

Closes the napkin's *"Remind me of conversations returned"*.

- **`ReminderItem`** when a tracked provider thread receives a new
  assistant turn since the user's last visit to that thread.
  Detection: extension watches the thread's last-turn timestamp via
  fetch/SSE interception (per §24.3a) or DOM canary; companion records
  ReminderItem when timestamp advances.
- Surface in side panel "Inbound" view.
- Mark seen / mark relevant / dismiss.

#### 6.1.6 Manual checklists (NEW — was missing in planner draft)

Closes the napkin's *"Project can also allow creating manual checklists
& tick progress (doesn't automate things but interface)"*.

- `ChecklistItem` attached to a workstream (any level).
- Fields: `text`, `status` (`todo` / `done`), `createdAt`, optional
  `note`.
- Pure UI: user adds, ticks, removes. No automation, no AI suggestion.
- Renders in side panel under the workstream's expanded view.
- Persists to vault as a `bac:checklist:` frontmatter array on the
  workstream's index Markdown file (so it's editable in Obsidian too).

#### 6.1.7 Tab recovery

- **TabSnapshot** stored on track: URL, title, provider, threadId,
  favicon, lastActiveAt.
- Recovery strategies (in order):
  1. **Focus open tab** (if Chrome reports it open).
  2. **Restore session** (via `chrome.sessions` API for recently closed).
  3. **Reopen URL** (always works for shared / canvas / public URLs;
     for signed-in chat threads, opens the URL — provider redirects to
     the conversation if session is alive).
  4. **Recreate by title + provider** (P1 — provider-history scrape).
- Side panel surfaces "closed (restorable)" status distinct from "open"
  vs "removed".

#### 6.1.8 Search + recent déjà-vu (lexical)

- Local FTS (MiniSearch per §24.4) over tracked items: title, provider,
  workstream path, captured turns.
- "Did I research X recently" surface — answers "what tracked threads
  match this query, in the last N days?".
- **Smart recall** (vector + calibrated freshness) is **P1**, not P0.
  The MVP ships lexical only; vector is a follow-up.

#### 6.1.9 Packet generation

Three packet types — naming clarified to avoid the §28 collision:

- **Context Pack** — canonical structured payload (MCP-readable).
  Used by: MCP, coding agents, notebook exports, internal search,
  future memory providers. Sections: goal, workstream tree, relevant
  items, decisions, open questions, queued asks, links, sources,
  timestamps, provenance.
- **Research Packet** (renamed from "Review Packet" in planner draft to
  avoid clash with §28 inline reviews) — outbound human-facing bundle
  for GPT Pro / Claude / Gemini / Deep Research / etc. Sections: goal,
  what I already know, links + source checklist, relevant prior chats,
  what I want you to verify, questions to answer, desired output format.
  Includes the Resume / Latest-developments / Web-content templates from
  §6.4 below.
- **Coding Agent Packet** — formatted for Claude Code / Cursor / Codex
  consumption. Includes `AGENTS.md`-shaped project context (per the
  Linux Foundation Agentic AI standard).

All three flow through the §24.10 RedactionPipeline + token-budget
warning + screen-share-safe check before any output is rendered or
copied.

#### 6.1.10 Inline review primitive (§28)

This is **distinct** from the packet system. Annotation-on-an-assistant-
turn:

- **Review** — user selects span(s) of an assistant turn in a tracked
  thread; opens composer in side panel; per-span comment + verdict
  (`agree` / `disagree` / `partial` / `needs-source`).
- **Submit-back** — composes a follow-up user turn quoting the spans +
  comments + verdict; dispatches into the same thread (paste-mode
  default; auto-send opt-in).
- **Dispatch-out** — bundles reviewed turn + annotations + (optional)
  prior-context turns; dispatches to a different chat (multi-target,
  same primitive as packet dispatch).
- **Track** — `ReviewEvent` stored as `bac_reviews:` frontmatter array
  on the captured-turn note; future recall ranker uses verdict signal
  (P1).

Review is a P0 capability for the dogfood demo (§13).

#### 6.1.11 Structured download / export

- Default naming pattern (per napkin):
  `<Project>/<Subproject>/<Subtopic>/.../<chat-name>-<reportN>.md`
- On-demand: "Export this thread / cluster / workstream as Markdown."
- (P0.5: auto-on-promote; see §6.2.3.)
- Files include `bac_id` in frontmatter so reorg doesn't break linkage.

#### 6.1.12 Stable IDs (technical invariant — not user-facing)

- Every entity has `bac_id` (16-char ULID).
- File paths and folder names are projections; `bac_id` is identity.
- Rename/move/restructure never breaks reference.
- This is a hard invariant the data model must preserve through every
  operation, not a "nice to have."

#### 6.1.13 Safety primitives (§24.10 — ship-blocking)

All four are P0, not P1. Without them, Sidetrack is one cross-
pollination away from leaking the user's API keys into a third-party
chat log.

- **RedactionPipeline** — runs before any outbound dispatch (Submit-
  back, Dispatch-out, Research Packet, Coding Agent Packet, manual
  copy). Default deny-list: AWS keys, OpenAI keys, GitHub tokens,
  common SSN / email / phone patterns. User-extendable.
- **Token-budget warnings** — count tokens with `tiktoken-js` before
  any paste / dispatch; warn if it will exceed the target model's
  context window.
- **Per-workstream privacy flag** (P0 — substantive privacy control).
  Each workstream carries a `private` / `shared` / `public` flag.
  `private` workstreams are masked in the side panel when displayed
  in any context the user has flagged as "show private label only"
  (Mock 11). Default for new workstreams: `private`. Users can
  promote to `shared` / `public` with intent. Per Q6 decision,
  **this flag is the substantive privacy control for v1**.
- **Screen-share-safe auto-detect** (deferred to **P1** per Q6) —
  auto-detect via `navigator.mediaDevices.getDisplayMedia` permission
  state and trigger masking automatically. Skipped from MVP because
  (a) per-workstream privacy flag does most of the work when defaults
  are correct, (b) detection has OS-level edge cases (macOS Screen
  Recording bypass), (c) "always-add-it-later" is genuinely true
  here. See §6.3.x for P1 plan.
- **Captured-page injection scrub** — when Sidetrack captures a web
  page (annotations / source) and includes it in a packet, wrap in
  `<context>...</context>` markers; scrub known prompt-injection
  patterns ("ignore previous instructions" etc.); warn at large
  injections. Captured page bodies are untrusted by default.

#### 6.1.14 MCP write tools with per-workstream trust (NEW per Q1 + Q7)

Per the Q1/Q7 decision, MCP write tools ship in MVP (not P1). Closes
the napkin's *"based on same api where MCP apis can also be called by
api agents to do the same."*

- **Tools**: `move_item`, `new_cluster`, `queue_item`, `link_items`,
  `attach_coding_session`. Each has a typed Zod schema and a
  capability spec (per `templates/mcp-capability-spec.md`).
- **Trust model**: per-workstream. User opts in once per workstream
  ("trust Codex inside `Sidetrack / MVP PRD`"); within scope, tools
  execute without per-call approval. Outside scope, fall back to
  per-call approval modal in the side panel ("Codex wants to move 3
  items into 'X' — approve? / reject?").
- **Audit log every call** to `_BAC/audit/<date>.jsonl` regardless of
  trust mode. Includes: agent ID (MCP client), tool name, args,
  scope (workstream the call was scoped to), trust-mode-active
  (yes/no), result, timestamp.
- **Trust scope UX**: settings page exposes per-workstream trusted-
  agents list; each entry shows last-call timestamp + total calls;
  one-click "revoke trust." Adding trust is opt-in only — no default.
- **Token gate**: same API key as the read-only side (Q4 / §5.x).

### 6.2 P0.5 — strong dogfood additions

These are not strictly required to ship MVP but materially improve the
dogfood loop (§13) and unblock several user-told scenarios.

#### 6.2.1 Coding session attachment + resume

Closes the napkin's *"Coding agent session can also be tendered to
plugin … when needed, can even have a helper command like Claude /
codex resume"*.

- Manual attach: `tool` (`codex` / `claude_code` / `cursor` / `other`),
  `cwd`, `branch`, `sessionId`, `name`, `resumeCommand`.
- Coding sessions appear in the same workstream tree as chats and
  searches.
- Side panel: "Open in {tool}" button runs the `resumeCommand` (via
  `chrome.tabs.create` for terminal-launch URLs, or copy-to-clipboard
  fallback).
- Linkable to chats/searches/packets via the typed-link system (§6.1.3).

#### 6.2.2 Async dispatch ledger (NEW — closes napkin gap)

Closes the napkin's *"i might want to know where I am when doing those,
you see I might lost track if some of those are async"*.

- `DispatchEvent` recorded on every Submit-back / Dispatch-out /
  Research Packet send / Clone-to-chat.
- Fields: `sourceItemId`, `targetItemId` (if known), `targetProvider`,
  `targetUrl`, `dispatchedAt`, `status` (`sent` / `replied` / `noted` /
  `pending`).
- Side panel "Recent dispatches" view — answers "I cloned this chat
  three hours ago, where did it go and did the AI reply yet?"
- Pairs with §6.1.5 Inbound reminders: when the target replies, the
  dispatch's status flips to `replied` and a ReminderItem fires.

#### 6.2.3 Auto-download on promote

Closes the napkin's *"or by default download to structured naming
conventions"* (the planner draft only handled the manual case).

- Per-workstream toggle (per Q3 decision):
  - **Default off** for workstream root and Inbox/Misc (scratch
    space stays scratch).
  - **Default on** for project / cluster / subcluster (real projects
    get auto-projection — vault is canonical for things that matter).
  - **Per-workstream override** in settings: user can flip any
    workstream independently of its tier.
- When on: every promoted artifact (decision, review verdict, packet)
  writes to vault on creation, using the §6.1.11 naming convention.
- Off: nothing writes until user explicitly exports.

#### 6.2.4 Markdown / Obsidian projection

- Sidetrack-originated structured items project to vault as Markdown
  + frontmatter on every change.
- Per §27 sync-out via companion.
- Obsidian renders these via convention; **no plugin required** (per
  §23.0). If user has Local REST API installed, companion uses surgical
  PATCH for race-free frontmatter updates; otherwise plain file write.

#### 6.2.5 Annotation capture (lightweight)

Closes the napkin's web-page-annotation idea (the input side of §28
inline review):

- Selected text + URL + note + timestamp captured to active workstream.
- Persistent overlay deferred to P1 (Hypothesis-style anchoring).
- The captured annotation can be opened later as a §28 review target.

#### 6.2.6 MCP server (read-only, stdio + local WebSocket)

Reuses `poc/mcp-server` from main (already validated against fixtures):

- Tools use the `bac.*` namespace and mirror the existing read-side
  companion surface: `bac.recall`, `bac.read_thread_md`,
  `bac.read_workstream_md`, `bac.list_dispatches`,
  `bac.list_workstream_notes`, `bac.list_buckets`,
  `bac.list_audit_events`, `bac.list_annotations`,
  `bac.system_health`, archive/unarchive helpers, and workstream
  suggestions/bumps.
- Reads vault state via Node `fs` (per §27.6).
- One-line stdio install in Claude Code / Cursor / Codex MCP config:
  `npx sidetrack-mcp --vault <path>`.
- Long-lived local-agent route:
  `ws://127.0.0.1:8721/mcp?token=<bridge-key>` or
  `Sec-WebSocket-Protocol: bearer.<bridge-key>`.
- Audit log every tool call to `_BAC/audit/<date>.jsonl`.

### 6.3 P1 — post-MVP

#### 6.3.1 Smart recall (vector)

- transformers.js + MiniLM-L6-v2 (per §24.4) + calibrated-freshness
  ranking (3d / 3w / 3m / 3y per §24.8).
- Local-only; index is rebuildable cache from vault (per
  `poc/recall-vector` design).

#### 6.3.2 MCP host role (§24.5 — second half)

The planner draft dropped this entirely; per §24.5 it's load-bearing.

- Side panel surfaces user-installed MCP servers (filesystem, GitHub,
  Linear, Sentry, custom).
- Their tools become dispatchable from the side panel — same UI as
  chat/notebook dispatch.
- Side panel becomes a unified action surface across the user's
  already-installed MCP server ecosystem.

#### 6.3.3 Screen-share-safe auto-detect (moved here from P0 per Q6)

- Auto-detect via `navigator.mediaDevices.getDisplayMedia` permission
  state; trigger masking in the side panel automatically when active.
- Per-workstream privacy flag (P0 in §6.1.13) remains the substantive
  control; this is the convenience layer on top.
- Edge cases to handle: macOS Screen Recording bypass (OS-level
  capture doesn't always trigger), self-recording for personal use
  (toggle to suppress masking).

(MCP write tools moved from here to **§6.1.14 P0** per Q1+Q7
decision — no longer a P1 deferral.)

#### 6.3.4 Persistent web annotation

- Hypothesis-style anchoring (TextQuote + TextPosition + CssSelector
  fallbacks, per §24.4).
- Restore on revisit.
- §28 review can be invoked on a stored annotation, not just on a chat
  turn.

#### 6.3.5 Notebook link-back (read-only)

- Sync-in scans vault for human-authored notes whose frontmatter links
  to a Sidetrack workstream.
- Sidetrack records the link (workstream now knows "this note
  references me") but does not parse the note body.
- Prevents Sidetrack from becoming a notebook parser (per the
  planner draft's Case B boundary, which we keep).

#### 6.3.6 Suggestion layer

After manual organization is dogfood-validated:

- "This looks related to {workstream X}" suggestion based on lexical /
  vector / link-neighborhood signals.
- User must accept; suggestion never auto-applies.

#### 6.3.7 Clone chat with reflection

- "Open new chat with this packet" — opens target tab/provider, paste-
  mode default per §24.10.
- Auto-send opt-in per provider per workstream.
- Records DispatchEvent (§6.2.2) so the chain is traceable.

#### 6.3.8 Tab regeneration when restore fails

- Provider-history scrape (signed-in only): match closed thread by
  title + capturedAt + first-user-turn hash.
- Fallback to "you'll have to start a new chat" with packet pre-loaded.

### 6.4 Production Idea Templates (Research Packets)

The napkin lists three "Production Ideas" that are best treated as
**Research Packet templates**. P-tiers locked per Q2 decision (§11).

- **A. Web-to-AI checklist** (the napkin's #1) — **P0**. Bundle web
  sources + questions + verification asks for a target AI (GPT Pro /
  Deep Research). Template fields: goal, sources, claims to verify,
  questions, desired output format. Ships with MVP; appears as a
  template choice in Mock 5 packet composer.
- **B. Resume → tech-stack inference** (napkin #2) — **deferred**
  (per Q2 — "very specific case; reconsider if it fits the system
  later"). Template design preserved here so it can land later
  without re-design: emphasizes evidence vs inference, confidence
  levels, no protected-attribute inference, no hiring
  recommendations. Inputs: resume text, public profile links.
  Outputs: languages / frameworks / infra / databases / cloud /
  scale indicators / missing evidence / follow-up questions.
- **C. Latest-developments radar** (napkin's "Latest developments for
  each area I am familiar with") — **P1**. Template for "watchlist"
  packets. Fields: topic, prior-known state, sources to check,
  expected output format. **Cross-reference**: this template needs a
  scheduling mechanism to fire periodically; group with a future
  generic "scheduled tasks" feature when that lands. Until then, the
  template is user-triggered ("run radar now").

### 6.5 P2 — explicitly defer

| Area | Reason |
|---|---|
| Auto-organization (AI moves items without user) | Trust risk; explicit principle 1 above |
| Auto-send into providers (silent dispatch into ChatGPT/Claude/Gemini) | Brittle; per §24.10 paste-mode is default, opt-in only |
| Notebook → Sidetrack structured merge (Case C in planner draft) | Needs schema versioning + 3-way merge + conflict UI; separate spike |
| Multi-vault routing | Single vault per companion instance for MVP |
| Team / cloud sync | Changes privacy/security architecture; v2 |
| Standalone web-annotation product spinout | Possible later; not Sidetrack MVP |
| Custom Obsidian-graph UI | Obsidian's Graph/Canvas/Bases handles it (per §23.3 simplifier) |
| Production-grade vector DB | Local lexical + transformers.js (P1) is enough; PGlite/pgvector deferred |
| Cross-user review aggregation | Single-user trust boundary only |
| Provider-side memory integration (ChatGPT memories, Claude conversation_search) | Useful eventually; not MVP wedge |

## 7. Object model

```ts
type Workstream = {
  bac_id: string;                    // ULID, identity invariant
  title: string;
  kind: "root" | "misc" | "project" | "cluster" | "subcluster";
  parentId?: string;
  childrenIds: string[];
  tags: string[];
  checklist?: ChecklistItem[];       // per §6.1.6
  createdAt: string;
  updatedAt: string;
};

type TrackedItem = {
  bac_id: string;
  type:
    | "ai_thread"        // ChatGPT/Claude/Gemini/Codex web chat
    | "search"           // Google/DuckDuckGo/Perplexity result page
    | "web_page"         // arbitrary tracked URL
    | "annotation"       // selected text + note (P0.5)
    | "coding_session"   // attached terminal session (P0.5)
    | "notebook_link"    // P1
    | "artifact"         // promoted decision / source / open question
    | "packet";          // generated Context Pack / Research Packet / etc.
  title: string;
  status:
    | "active" | "tracked" | "queued" | "needs_organize"
    | "closed" | "restorable" | "archived" | "removed";
  trackingMode: "auto" | "manual" | "stopped";
  primaryWorkstreamId?: string;     // optional — Inbox/Misc allowed
  tags: string[];
  links: Array<{
    targetId: string;
    relation:
      | "related" | "source_of" | "follow_up" | "blocks"
      | "supports" | "contradicts" | "same_context"
      | "coding_session_for" | "dispatched_to";
  }>;
  source: {
    provider?: ProviderId;
    url?: string;
    domain?: string;
    providerThreadId?: string;
    model?: string;                 // when detectable
    capturedAt?: string;
    selectorCanary?: "ok" | "warning" | "failed";
  };
  tab?: TabSnapshot;
  createdAt: string;
  lastSeenAt: string;
  updatedAt: string;
};

type TabSnapshot = {
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  url: string;
  title?: string;
  favIconUrl?: string;
  provider?: ProviderId;
  lastActiveAt: string;
  restoreStrategy:
    | "focus_open_tab" | "restore_session"
    | "reopen_url" | "recreate" | "unknown";
};

type QueueItem = {
  bac_id: string;
  scope:
    | { type: "tracked_item"; id: string }
    | { type: "workstream"; id: string }
    | { type: "global" };
  targetProvider?: ProviderId;
  text: string;
  status: "pending" | "ready" | "sent" | "done" | "skipped";
  createdAt: string;
  updatedAt: string;
};

// NEW per §6.1.5 — closes napkin "Remind me of conversations returned"
type ReminderItem = {
  bac_id: string;
  trackedItemId: string;            // the thread that received a reply
  detectedAt: string;
  lastSeenAt?: string;              // user's last visit to the thread
  inboundTurnAt: string;            // when the new turn appeared
  status: "unseen" | "seen" | "dismissed";
};

// NEW per §6.1.6
type ChecklistItem = {
  bac_id: string;
  text: string;
  status: "todo" | "done";
  createdAt: string;
  doneAt?: string;
  note?: string;
};

type Packet = {
  bac_id: string;
  kind:
    | "context_pack"           // canonical, MCP-readable
    | "research_packet"        // outbound to GPT Pro / Claude / etc.
    | "coding_agent_packet"    // for Claude Code / Cursor / Codex
    | "notebook_export";
  title: string;
  scope: {
    workstreamIds?: string[];
    trackedItemIds?: string[];
    includeQueueItems?: boolean;
    includeLinksDepth?: number;
  };
  target:
    | "gpt_pro" | "deep_research" | "claude" | "gemini"
    | "codex" | "claude_code" | "cursor"
    | "notebook" | "markdown";
  template?: "web_to_ai_checklist" | "resume_tech_stack" | "latest_developments_radar" | "custom";
  sections: Array<{
    title: string;
    content: string;
    sourceItemIds?: string[];
  }>;
  redactionApplied: string[];        // list of redaction-rule IDs that fired
  tokenEstimate: number;             // tiktoken count
  screenShareSafeAtCompose: boolean; // was screen-share-safe mode active?
  createdAt: string;
};

// Per BRAINSTORM §28 — distinct from Packet
type ReviewEvent = {
  bac_id: string;
  targetEventId: string;             // the captured assistant turn
  targetSpan: { start: number; end: number; quote: string }[];
  verdict: "agree" | "disagree" | "partial" | "needs-source" | "open";
  comments: { spanIndex: number; text: string }[];
  reviewerNote: string;
  dispatched?: {
    submittedBack?: { threadId: string; userTurnId: string; at: string };
    dispatchedOut?: { targetThreadId: string; userTurnId: string; at: string }[];
  };
  createdAt: string;
  updatedAt: string;
};

// NEW per §6.2.2 — closes napkin async-tracking gap
type DispatchEvent = {
  bac_id: string;
  sourceItemId: string;              // captured turn / packet / annotation
  targetItemId?: string;             // if a tracked target exists
  targetProvider?: ProviderId;
  targetUrl?: string;
  dispatchKind:
    | "submit_back" | "dispatch_out" | "research_packet"
    | "clone_to_chat" | "coding_agent_packet";
  dispatchedAt: string;
  status: "sent" | "replied" | "noted" | "pending";
};

type CodingSession = {
  bac_id: string;
  tool: "codex" | "claude_code" | "cursor" | "jetbrains" | "other";
  cwd?: string;
  branch?: string;
  sessionId?: string;
  name: string;
  resumeCommand?: string;
  primaryWorkstreamId?: string;
  attachedAt: string;
  links: TrackedItem["links"];
};

type ProviderId =
  | "chatgpt" | "claude" | "gemini"
  | "google" | "perplexity"
  | "codex" | "claude_code" | "cursor"
  | "web" | "other";
```

All entities live in the vault as Markdown files (or, for high-volume
event-style entities, as JSONL rows under `_BAC/events/<date>.jsonl`).
The companion is the only writer. The extension and bac-mcp are
readers.

## 8. User stories

Concise; acceptance criteria omitted where the previous sections cover
them. Each story maps to a P-tier and a closure napkin item.

### Story 1 — Track current tab (P0, napkin: track current tab)

> As a user, when I'm in an AI chat or search tab, I want to click
> *Track current tab*, so the work isn't lost even if I don't know
> what project it belongs to yet.

### Story 2 — Auto-track + stop (P0, napkin: sidebar auto-tracking)

> As a user, I want Sidetrack to auto-track supported provider tabs
> by default, but let me stop tracking a specific tab or site without
> disabling globally.

### Story 3 — Ad-hoc root work (P0, napkin: random questions / misc)

> As a user, I may ask random questions before creating a project. I
> want those chats to stay in Inbox/Misc until I decide where they
> belong. Inbox is normal, not "uncategorized = error."

### Story 4 — Reorganize iteratively (P0, napkin: reorganize multiple times)

> As a user, my understanding of a project changes over time. I want to
> reorganize chats, searches, and coding sessions into nested clusters
> multiple times without breaking anything.

### Story 5 — Visualize what I'm doing (P0, napkin: visualize multiple threads with queues, organized)

> As a user, I want one side panel that shows my active threads, queued
> follow-ups, inbound reminders, closed-but-restorable items, and
> unorganized items at a glance.

### Story 6 — Queue follow-ups (P0, napkin: queued feature into ongoing threads)

> As a user, I want to attach pending questions to an ongoing thread or
> workstream, so when I come back later I don't have to reconstruct
> what I meant to ask.

### Story 7 — Inbound reminder (P0, napkin: remind me of conversations returned)

> As a user, when a tracked AI thread receives a new assistant turn
> while I'm not looking at it, I want to see "Claude replied 3 minutes
> ago" in the side panel.

### Story 8 — Manual checklist (P0, napkin: project allows creating manual checklists)

> As a user, I want to attach a manual checklist to a project /
> cluster, tick items off as I do them, and have nothing automated
> happen because of the ticks. The checklist is a UI surface, not a
> trigger.

### Story 9 — Tab recovery (P0, napkin: forgot or accidentally close the tab)

> As a user, if I forget a tab or accidentally close it, Sidetrack
> should show the last-known tracked thread and let me reopen / focus /
> recreate it.

### Story 10 — Generate Research Packet for another AI (P0, napkin: ask another search/chat with shared context + web-to-OpenAI checklist)

> As a user, I want to bundle selected chats / searches / links /
> queued questions into a packet I can send to GPT Pro, Deep Research,
> Claude, or Gemini. Redaction + token-budget + screen-share-safe
> checks run automatically before the packet is rendered or copied.

### Story 11 — Generate Coding Agent Packet (P0, napkin: project linked to coding sessions)

> As a user, I want to generate a packet shaped for Claude Code /
> Cursor / Codex consumption — `AGENTS.md`-shaped project context plus
> the relevant chats and decisions.

### Story 12 — Inline review of an assistant turn (P0, napkin: annotate web page + review format to send to other AIs)

> As a user, I want to select a span of an assistant's reply, comment
> on it with a verdict (`agree` / `disagree` / `partial` / `needs-
> source`), and either submit my review back to that chat or dispatch
> the reviewed turn + my annotations to another AI for a second
> opinion.

### Story 13 — Async dispatch tracking (P0.5, napkin: i might want to know where I am if some are async)

> As a user, when I cloned a chat or sent a packet to another AI three
> hours ago, I want to see in the side panel where it went, whether
> the target replied, and what the source was — so I don't lose the
> chain.

### Story 14 — Coding session attach + resume (P0.5, napkin: Claude / codex resume helper)

> As a user, I want to attach my Codex / Claude Code / Cursor session
> to a workstream, and have a one-click "open in Codex" that runs the
> resume command — so coding sessions live in the same nested view as
> chats and searches.

### Story 15 — Structured download (P0 manual, P0.5 auto-on-promote, napkin: download chat notes adhoc or by default)

> As a user, I want exports to follow a deterministic path
> `Project/Subproject/Subtopic/.../<chat>-<reportN>.md` automatically
> when I promote artifacts (default for project-level workstreams),
> and on-demand for everything else.

### Story 16 — Screen-share-safe (P0 ship-blocking, §24.10)

> As a user, when I start a screen-share for a meeting, my side panel
> should auto-mask tracked-thread titles, queue text, and packet
> previews — without me remembering to enable a "private mode."

### Story 17 — Companion-down graceful degrade (P0 failure mode)

> As a user, if the companion process crashes or isn't running, the
> side panel should still let me capture (queued locally), search the
> hot cache, and read existing tracked items — and surface a clear
> "companion: disconnected · N items queued" badge.

## 9. Failure modes

For each major dependency, the v1 must specify what the user sees and
what the system does. Production PRD requirement, not optional.

| Failure | Detection | Side-panel surface | Behavior |
|---|---|---|---|
| **Companion process down** | Extension can't reach NM/HTTP endpoint | "Companion: disconnected · N items queued" red badge | Captures queue locally; reads from hot cache; replays on reconnect; oldest-eviction at 1000 items |
| **Bridge key setup invalid** | First-run / settings validation distinguishes missing key, malformed copied value, and companion auth rejection | Inline setup error: "Bridge key missing", "Bridge key malformed", or "Bridge key rejected" | Do not close setup; do not persist rejected keys; user can paste the correct `_BAC/.config/bridge.key` and retry |
| **Vault folder unreachable** | Companion `fs` operations fail | "Vault: error" yellow badge with reason | Companion buffers writes in-memory (cap 100 items); side panel surfaces "vault unreachable for X minutes — re-pick folder?" |
| **Provider-capture broken** (selector failure) | Per-load selector canary detects miss | Yellow banner on side panel: "ChatGPT extractor health: 4/10 recent captures clean" | Switch to clipboard mode; surface a "queue diagnostic bundle" button |
| **Token budget exceeded** (about to dispatch) | tiktoken count > model context window | Pre-dispatch warning with "edit / proceed anyway / cancel" | Default-deny; user must explicitly proceed |
| **Redaction rule fires** (PII / API key in dispatch) | RedactionPipeline matches | "Redacted N items: AWS key, email" with reveal toggle | Replace with `<redacted:kind>` markers; user can opt to include unredacted (logged as audit event) |
| **Screen-share active** (during dispatch) | `getDisplayMedia` permission detected | "Screen-share active — packet preview masked" | Mask all tracked content in side panel; warn before dispatching from a private workstream |
| **Captured-page injection detected** | Pattern match on captured body during packet compose | "This source contains content that looks like a prompt-injection attempt" | Wrap in `<context>` markers automatically; escalate visible warning before dispatch |
| **Tab restore fails** (session unavailable) | `chrome.sessions.restore` returns null | "Couldn't restore — opening URL instead" | Fall back to `chrome.tabs.create` with the saved URL |
| **MV3 SW idle death** (data loss risk) | Hot-cache writes rely on SW being alive | "Capture queued — companion will sync" silent | Companion is canonical, so SW death is recoverable; no user-visible loss |
| **Local REST API plugin absent** | Companion startup probe | None (default state, not an error per §23.0) | Companion uses plain Node `fs` writes; plugin would have been opportunistic acceleration |

## 10. Notebook integration

Per the planner draft's three-case boundary (kept verbatim, mapped to
§27 sync directions):

### Case A — Sidetrack-originated structured content (P0.5 sync-out)

Examples: tracked chats, search history, review packets, context packs,
checklists, structured project exports.

- **Direction**: sync-out (Sidetrack → vault → user sees in Obsidian)
- **Owner**: Sidetrack (companion writes per §27)
- **Vault is the projection**; Sidetrack owns identity and structure
- Per §23.0, file formats are interface-and-core (Markdown +
  frontmatter + `.canvas` + `.base`); no plugin required

### Case B — Human-originated unstructured notebook content (P1 sync-in, link-only)

Examples: creative notes, personal records, Canvas sketches, freeform
mind maps the user writes in Obsidian.

- **Direction**: sync-in, but read-only and link-only
- Sidetrack records that a notebook note links to a workstream
  (frontmatter `bac_workstream:` field on the user's note)
- Sidetrack does **not** parse the note body
- Prevents Sidetrack from becoming a notebook parser

### Case C — Structured notebook macros that sync back (P2 deferred)

Examples: notebook contains structured `bac_*` blocks the user (or AI)
edits, and those changes propagate back to Sidetrack state.

- **Direction**: sync-in, structured, requires merge semantics
- Deferred per §27 conflicts/merges; needs schema versioning + 3-way
  merge + conflict UI design before scope-locking
- Safe-merge invariant when this lands: never overwrite user notebook
  changes silently; never delete Sidetrack records from notebook
  edits alone; every structured sync-back must be previewed or
  conflict-checked

## 11. Decisions log (resolved 2026-04-26)

The eight open questions from this PRD's prior draft were resolved
together with the user. Recording answers + brief rationale here so
the trail isn't lost.

1. **MCP API parity with UI actions** → **upgraded to P0 with
   per-workstream trust mode**. Write tools (`move_item`,
   `new_cluster`, `queue_item`, `link_items`,
   `attach_coding_session`) ship in MVP. User opts in once per
   workstream ("trust Codex inside `Sidetrack / MVP PRD`"); within
   that scope tools execute without per-call approval; outside the
   scope, fall back to per-call approval. Audit log every call
   regardless. See §6.1.14 (new) and the corresponding §6.3.3
   removal.

2. **Production Idea Templates priority**:
   - **A. Web-to-AI checklist** → **P0** ("very desire to have").
   - **B. Resume → tech-stack inference** → **deferred** (very
     specific case; reconsider if it fits the system later).
   - **C. Latest developments radar** → **P1**, with note: may fit
     into a future generic scheduling feature; cross-reference
     when scheduling lands.
   See §6.4 for updated tiers.

3. **Auto-download default** → **Mixed (current PRD position)** plus
   **per-workstream override in settings**. Default off for
   root/Misc, on for project-tier; user can flip any workstream
   independently. §6.2.3 updated.

4. **Companion install path** → **HTTP loopback locked.** Decision
   recorded as ADR-0001 (`docs/adr/0001-companion-install-http-loopback.md`).
   Native Messaging cannot satisfy §27.6's "long-lived process,
   sustained tasks, browser-restart survival" requirements without
   daemonization gymnastics; HTTP loopback is the standard pattern
   in the broader ecosystem (mcp-chrome, browser-mcp, Local REST
   API plugin) and is multi-MCP-client neutral. v1.5 ships an
   `--install-service` flag wiring the companion into `launchd` /
   `systemd` / Task Scheduler. §5 architecture updated.

5. **Inline-review submit-back default** → **paste-mode locked**
   for v1. No auto-send on submit-back. Per-provider auto-send
   opt-in deferred beyond v1.

6. **Screen-share-safe mode** → **auto-detect demoted to P1+**;
   per-workstream `private` / `shared` / `public` flag stays P0
   as the substantive privacy control. Auto-detect via
   `getDisplayMedia` is nice-to-have convenience but adds
   complexity for a niche scenario; user can flag sensitive
   workstreams as `private` and rely on that. §6.1.13, §10
   updated.

7. **Coding-agent silent automation** → **per-workstream trust
   mode** (same model as Q1; see above).

8. **MVP product name** → **Sidetrack**. (Repo on GitHub remains at
   `switchboard/` for backward-compat with existing PRs; rename
   when convenient.)

## 12. What this PRD intentionally does NOT do (vs the planner draft)

For audit clarity, these are deviations from the ChatGPT planner draft
this PRD supersedes. Each deviation is justified against the napkin or
BRAINSTORM.

| Planner draft | This PRD | Why |
|---|---|---|
| "Review Packet" | "Research Packet" | §28 already owns "Review" as inline annotation primitive; collision avoided |
| Manual checklists not mentioned | P0 §6.1.6 | Napkin has it as a discrete feature |
| Inbound reminders not mentioned | P0 §6.1.5 | Napkin: "Remind me of conversations returned" |
| Async dispatch tracking covered only by "Locate current item" | P0.5 §6.2.2 explicit ledger | Napkin: "I might lost track if some of those are async" |
| Auto-download not mentioned (manual only) | P0.5 §6.2.3 | Napkin: "or by default download to structured naming" |
| §24.10 safety primitives absent | P0 §6.1.13 ship-blocking | BRAINSTORM marked these ship-blocking |
| MCP host role dropped | P1 §6.3.2 | §24.5 explicit: BAC is BOTH host AND server |
| §28 inline review absent | P0 §6.1.10 distinct primitive | BRAINSTORM has it as a feature primitive, not a packet |
| Companion architecture not mentioned | §5 load-bearing | §27.6 makes this v1 anchor; PRD silence would contradict the architecture |
| Persistence model unspecified | §5.3 + §7 explicit (vault canonical, hot cache only in chrome.storage.local) | §27.6 forces this |
| No failure-mode section | §9 explicit table per dependency | Production PRD requirement |
| Resume tech-stack and developments radar out-of-scope | §6.4 templates with P-tier pending user decision (§11 Q2) | Napkin lists as "Production Ideas" |
| Coding session resume helper in object model only, no UI | P0.5 §6.2.1 explicit "Open in {tool}" button | Napkin asks for resume helper |
| MCP API parity left implicit | §11 Q1 explicit user decision | Napkin asks for action parity; PRD demoted to P1 with conservative approval; user decides |

## 13. Acceptance scenario (dogfood)

The MVP is real if this scenario works end-to-end against the user's
actual workflow.

```text
Setup: companion is running, vault is wired, side panel is open.

1.  Open ChatGPT, Claude, a Google search tab, and a Codex CLI session
    while working on the "Sidetrack" workstream (the napkin example —
    user's project of building Sidetrack itself).
2.  Sidetrack auto-tracks the three AI tabs; user clicks "Track
    current tab" on the Google search.
3.  Side panel shows all four items in "Active work."
4.  User queues two follow-ups into the "Sidetrack" workstream:
    - "Ask Claude to compare with VM live migration architecture."
    - "Ask Codex to inspect bac-mcp packaging once it lands."
5.  User creates a nested workstream:
    Sidetrack / MVP PRD / Active Workstreams.
6.  User moves the three AI items + the Google search into that
    workstream. Codex session stays in a sibling cluster.
7.  User adds a manual checklist to "MVP PRD":
    - [ ] Reconcile review packet naming with §28
    - [ ] Decide on companion install path
    - [ ] Confirm auto-download default
8.  User accidentally closes the Claude tab. Side panel shows it as
    "closed (restorable)"; one-click "Reopen" focuses or restores.
9.  Claude replies to the still-open ChatGPT-thread that the user has
    in another window. Side panel "Inbound" view shows
    "ChatGPT replied 2 minutes ago — switchboard MVP scope."
10. User reads the new turn, selects a span, opens the §28 review
    composer in the side panel. Verdict: `partial`. Comments on the
    spans. Hits "Dispatch out → Claude" to get a second opinion.
    DispatchEvent recorded; "Recent dispatches" view shows it.
11. User generates a Research Packet from the "MVP PRD" cluster + the
    two queued asks, target: GPT Pro. Redaction fires (one email
    pattern); token budget shows 4,200 / 32,000; screen-share-safe
    check passes. Packet renders; user copies and pastes into GPT Pro.
12. User generates a Coding Agent Packet from the same cluster, target:
    Claude Code. AGENTS.md-shaped output.
13. User exports the Research Packet to vault: writes to
    `Sidetrack/MVP-PRD/Active-Workstreams/2026-04-26-gpt-pro-mvp-scope-research-packet.md`
    (path projection of the workstream tree).
14. User opens the vault in Obsidian. Frontmatter mirror is intact;
    Bases dashboard "Where Was I" shows current state; Canvas project
    map renders the workstream tree.
15. From terminal, user runs `npx bac-mcp --vault <path>`, configures
    Codex to use it, runs `bac.context_pack({ workstream: "MVP PRD" })`.
    Returns the same data the side panel shows.
16. User starts a screen-share for a video call. Side panel auto-masks
    titles to `[private]`; user confirms with the screen-share
    indicator. Stops share — titles re-render.

If all 16 steps work, MVP ships.
```

## 14. Out of scope (explicit, P2 or beyond)

Mirrors §6.5; restated here for unambiguous PRD-readers:

- AI auto-organization
- Silent auto-send into providers (paste-mode is the v1 default forever; auto-send is per-provider per-workstream opt-in beyond v1)
- Notebook → Sidetrack structured merge (§27 conflicts/merges deferred)
- Multi-vault routing
- Team / cloud sync
- Custom Obsidian-graph UI (Obsidian native handles it)
- Production-grade vector DB
- Cross-user review aggregation
- Provider-side memory integration (ChatGPT memories, Claude conversation_search)
- Standalone web-annotation product spinout
- Mobile (iOS/Android) — Chrome extension + Node companion is desktop-first; mobile is a separate product

## 15. Success criteria for v1

This MVP succeeds if, over a 30-day dogfood window, the user can:

- Track ≥80% of their AI work without manual intervention beyond
  "track current tab" / "stop auto-track."
- Reorganize their tracked work at least 3 times without losing
  identity or links.
- Generate at least 5 Research Packets that they actually send to GPT
  Pro / Claude / Gemini / Codex (i.e., the packet system is real, not
  decorative).
- Recover at least one accidentally-closed tab via the recovery
  surface.
- Use one MCP-driven coding session that consumes a context pack from
  bac-mcp.
- Operate continuously for ≥7 days without losing data to companion
  crashes or Chrome restarts.

If any of these fail, the MVP is bug, not feature.

## 16. Strongest one-liner

> **Sidetrack MVP is the control panel for messy active AI work: it
> remembers what you're doing across tabs, lets you queue and reorganize
> it, and turns it into portable packets for the next AI — without
> burning tokens, without losing privacy, and without depending on any
> single notebook plugin to function.**
