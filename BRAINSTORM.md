# browser-ai-companion — Product Brainstorm

> Status: open brainstorm. No scope cuts yet. Items marked `[+claude]` are extensions
> Claude generated beyond direct user input — flag them for keep / cut.
> Trim + prioritize → `PRD.md` (later).

---

## 1. Vision

A browser **switchboard** for cross-tool research and coding workflows.

The plugin moves bytes between places that already have intelligence (third-party
chat UIs, search engines, notebooks, coding agents) and remembers everything the
user has done so they don't repeat work, lose threads, or re-explain context to
the same model twice.

**Hard constraints from the user:**

1. **Don't burn tokens.** The plugin itself does not (by default) call paid LLM APIs.
   It leverages the user's already-open, already-paid-for chat UI sessions.
   Even copy/paste-through-the-chat-UI is acceptable — the plugin's job is to make
   that copy/paste cheap, traceable, and reversible.
2. **Open architecture.** Every external system (notebook, chat provider, search,
   coding agent, issue tracker) is an **adapter** with a typed interface. The product
   ships with a few, but is built so community/user can add more without forking.
3. **Privacy-first by default.** Inherit TechPulse-style guardrails: no full-DOM
   capture, no cookies, no screenshots-by-default, bounded text extraction, deny-list
   for auth/payment/banned pages. Conversation history and event log live locally.

---

## 2. The three pillars (workflows)

### W1. Cross-AI orchestration

User runs many parallel workstreams — ChatGPT thread A doing research, Gemini
thread B reviewing notes, ChatGPT thread C reviewing PR #42, coding-agent session D
rebasing, notebook E as the shared whiteboard. Working memory of "what state is
each thread in" breaks. Plugin job: **thread registry + drift management +
push/pull between threads, notebook, and coding agents**.

### W2. Reading capture

User reads in chat UIs and on tech sites; wants to keep what matters and re-find
it later. Plugin job: **bidirectional capture (chat ↔ notebook ↔ source page) with
provenance, low-friction**.

### W3. Ambient research with long-term memory

User does daily tech reading across buckets (chore list / WIP project / job-prep /
ad-hoc). Highlights terms, dispatches in parallel to search + chat UIs, optionally
clips. **10 months later, similar topic appears — plugin says "you researched this
before, here's what you found".** Plugin job: **parallel dispatch + déjà-vu recall
over a personal research event log**.

---

## 3. Cross-cutting primitives

These three primitives plus three new ones underpin every scenario:

| Primitive | What it is | Where it lives |
|---|---|---|
| **Observe** | Read assistant turns, thread URLs, page DOM | Content scripts on chat-UI hosts + page hosts |
| **Inject** | Paste text into chat input, optionally hit send | Content scripts |
| **Locate** | Find the tab holding a given thread/URL/bucket | Background, `chrome.tabs` |
| **Bucket** | Active research namespace (wip/foo, job-prep, …) | Side panel, applied to every event |
| **Event log** | Append-only history of highlights, dispatches, clips, drifts | Local IndexedDB |
| **Recall** | Search the event log + notebook adapter for prior matches | Side panel, on-highlight + on-query |

---

## 4. Use case catalog

Scenarios numbered `S1..Sn` for addressability. Each is a 1–3 sentence sketch;
the PRD will deepen each to a step-by-step e2e + edge-case table at the fidelity
of the example I showed earlier.

### W1 — Cross-AI orchestration

| # | Scenario | One-liner |
|---|---|---|
| S1 | **"Where was I?" panel** | Side panel lists every tracked workstream (chat threads across providers, notebook entries in play, open PRs, coding agents) with a one-line status: "waiting your reply", "assistant replied 14m ago, unread", "note edited after last push to this thread". |
| S2 | **Push note → chat (single thread)** | From a notebook entry, "send to ChatGPT thread *auth-redesign*" → focuses tab, pastes (full or delta), optionally sends. |
| S3 | **Push delta → many stale threads** `[+claude]` | One click syncs a note's latest delta to every thread that's drifted. Each gets a tagged paste: "[updated 2026-04-24, since last sync]". |
| S4 | **Capture chat turn → notebook** | "Save turn" affordance on every assistant message. Writes Q+A + thread URL + timestamp to active bucket. |
| S5 | **Capture whole chat thread → notebook** | Save entire transcript as one entry, with TOC of turns. |
| S6 | **Cross-pollinate** | From a Gemini turn, "ask ChatGPT thread X to react to this" → pastes the turn into ChatGPT's input. |
| S7 | **Drift / staleness alerts** | Note `auth-redesign` edited at 14:32; Gemini thread last fed at 13:10 → "stale context" badge → click → paste diff. |
| S8 | **Handoff to coding agent** | Notebook entry → "feed to coding agent" → either pastes into Claude Code / Codex / Cursor tab, or copies a prepared prompt to clipboard with notification. Agent target is configurable. |
| S9 | **PR review loop** | New PR appears in tracked repo → side panel notifies → "review with → [pick chat thread]" pulls diff and pastes. Reverse: "save assistant comment as PR review comment" via GitHub API. |
| S10 | **Conversation forking** `[+claude]` | In a ChatGPT thread, fork from turn N → new chat pre-seeded with truncated transcript. Useful for branching exploration without polluting the main thread. |
| S11 | **Multi-agent coding dispatch** `[+claude]` | Same task → Claude Code + Cursor in parallel → side panel shows both outcomes (PR diffs) for diff/pick. |
| S12 | **Forgotten thread alert** `[+claude]` | "You started a Gemini chat 'k8s-debug' on 2025-11-04, never resolved or saved — dismiss or archive?" |
| S13 | **Tab sweep** `[+claude]` | Side panel lists all open tabs; assign each to a bucket / archive to notebook / close. Cleans the post-research mess. |

### W2 — Reading capture

| # | Scenario | One-liner |
|---|---|---|
| S14 | **Save selection from any page → notebook** | Selection + URL + page title → notebook entry, optionally with AI-generated title/tags (uses dispatch flow, not paid API). |
| S15 | **Save full page (readability) → notebook** | "Clip page" cleans page via Readability.js, saves to bucket. |
| S16 | **Save chat turn with quote-cite** `[+claude]` | When saving an answer, also save the *user prompts that led to it* so the entry stands alone as evidence. |
| S17 | **Save SERP** `[+claude]` | "Save this Google search" captures top N results (title + URL + snippet) as a list entry — useful for "the search itself was the finding". |
| S18 | **Save image / chart with caption** `[+claude]` | Right-click image → "save with caption" → optionally dispatches image to a chat for description, then saves description + image URL. |
| S19 | **Save PDF selection** `[+claude]` | Works in Chrome's PDF viewer — selection + page number + PDF URL → entry. |
| S20 | **Save YouTube timestamp / transcript range** `[+claude]` | On a YouTube page, highlight transcript or set in/out timestamps → entry with deep-link `?t=`. |
| S21 | **Save tweet / social post** `[+claude]` | On X/HN/Reddit, "save post" captures author, link, content (no auth-walled scraping). |
| S22 | **Save research session** `[+claude]` | Mark "session start: topic X" → plugin records all tabs, highlights, dispatches, clips for that window of time → end-of-session writes a structured summary entry. |

### W3 — Ambient research + long-term memory

| # | Scenario | One-liner |
|---|---|---|
| S23 | **Active bucket setting** | One click in side panel sets the active research bucket. Every event, capture, dispatch is auto-tagged. |
| S24 | **Daily intent prompt** `[+claude]` | At first activity of the day (or first activity after N hours idle), side panel asks "what bucket are you in today?" Defaults from history + calendar (S46). |
| S25 | **Highlight → multi-target dispatch** | Selection → floating "Look this up" → fan-out to N configured targets (Google, ChatGPT, Gemini, Claude, Perplexity, MDN, GitHub code search, …). Each target = open/focus tab + inject prompt + (optional) send. |
| S26 | **A/B comparison view** | Same prompt to ChatGPT + Gemini → side panel shows both replies side-by-side once content scripts read them back. "Save this", "Save both", "Save merged with attribution". |
| S27 | **Déjà vu on highlight** | When user highlights, plugin queries event log + notebook for similar past highlights/queries/notes. Surfaces matches *before* dispatch. ("You researched this on 2025-08-12 → notebook entry X, ChatGPT thread Y.") |
| S28 | **Déjà vu on typed query** `[+claude]` | Same as S27 but triggered by typing in the side panel search/dispatch box, not a page highlight. |
| S29 | **Cross-bucket discovery** `[+claude]` | "You researched related concepts under `job-prep/distributed-systems` → see also." Helps repurpose past research for new contexts. |
| S30 | **Topic graph** `[+claude]` | Auto-cluster entries by content similarity → graph view per bucket → see "you've been circling this topic for 3 weeks". |
| S31 | **Weekly research digest** `[+claude]` | Every Monday, side panel offers a summary of last week's activity (highlights, dispatches, clips, time per bucket). Copy to clipboard or write to notebook. |
| S32 | **Resurface aging notes** `[+claude]` | Spaced-repetition-style: every N days, side panel surfaces a note for review. "Still relevant? archive / re-explore / ignore". |
| S33 | **Trail mode** `[+claude]` | Record a Hansel-and-Gretel trail of tabs, highlights, queries, dispatches over a session → replay later, share, or feed to a coding agent. |
| S34 | **Inverse search on hover** `[+claude]` | Hover any term on a webpage → if you've written about it before, tooltip shows the relevant note snippet. |
| S35 | **Question bank per bucket** `[+claude]` | Accumulate "open questions" per bucket; periodically dispatch them to a chat for refinement. |
| S36 | **Prompt library per bucket** `[+claude]` | Save reusable prompt templates (e.g. "review this code for X, Y, Z") with `${selection}` placeholder; one-click apply. |
| S37 | **Persona persistence across providers** `[+claude]` | Per bucket, store a "system prompt / persona" prepended to dispatched messages → ChatGPT and Gemini answer in similar register. |
| S38 | **Steel-man / red-team pair dispatch** `[+claude]` | Same content to two threads with opposite system instructions → balanced view in A/B layout. |
| S39 | **Compare runs** `[+claude]` | Same prompt N times to same model → see variance. Useful for evaluation. |
| S40 | **Chained dispatch** `[+claude]` | "Send to ChatGPT, when reply arrives, auto-forward to Gemini for review." Builds critique pipelines. (Requires DOM observation for completion.) |
| S41 | **Watch a query** `[+claude]` | Subscribe to a Google search; plugin re-runs daily and notifies on new results (background alarms). |
| S42 | **Voice-to-prompt** `[+claude]` | Mic in side panel → browser Speech Recognition → text dispatched. No paid API. |
| S43 | **"Why am I on this page?" trace** `[+claude]` | Side panel shows breadcrumb of how you got here (tab parent chain) — useful when you've clicked through 5 links and forgotten what you were looking for. |
| S44 | **Annotate page in place** `[+claude]` | Hypothesis-style — persistent highlights on URLs, optionally synced to notebook. Re-visit a page → your prior highlights re-appear. |
| S45 | **Citation drift watcher** `[+claude]` | Saved web page changes content (etag/last-modified) → notify "your note from URL X may now be stale". |
| S46 | **Calendar-aware bucket switch** `[+claude]` | Optional Google Calendar integration — current meeting "tech-pulse interview prep" → suggest matching bucket. |
| S47 | **Pomodoro focus mode** `[+claude]` | Lock plugin to one bucket for N minutes; hide cross-bucket distractions / suppress non-bucket déjà-vu hits. |
| S48 | **Reference resolver** `[+claude]` | Detect `[1]`, `[Smith 2024]`, bare URLs, DOIs in any page text → "look up + dispatch". |
| S49 | **Bucket export to markdown bundle** `[+claude]` | Ship a research bucket as a portable archive (zip of markdown + metadata) — for sharing, archival, or for feeding into a coding agent. |
| S50 | **Export pack to coding agent** `[+claude]` | Generate a single `context.md` from the bucket's notes + linked chat threads + chosen code paths → drop into a project so the coding agent reads it as primary context. |
| S51 | **Search across all observed chat threads** `[+claude]` | Local index over snapshotted chat-UI content → "find me the chat where I asked about X" across providers. |
| S52 | **Bookmark folder import** `[+claude]` | Read Chrome bookmarks; offer to import folders as buckets — onboarding shortcut for users without a notebook tool yet. |
| S53 | **Inbox triage** `[+claude]` | Ad-hoc captures land in `inbox` bucket → weekly review prompt: file / merge / delete. |
| S54 | **Auto-summarize long thread before save** `[+claude]` | Optional, off-by-default, uses tokens. For users willing to pay for a clean entry instead of a wall of transcript. |
| S55 | **Time-spent tracker per bucket** `[+claude]` | Pomodoro-ish per-bucket time accumulator → "you spent 4.5h on `wip/foo` this week". |

---

## 5. Capture inputs (every way content enters the system)

| Input | Trigger | Notes |
|---|---|---|
| Active tab page | Side panel "analyze" / "save page" button | Readability extraction, capped |
| Selected text (any tab) | Floating button on selection / context menu | Cap at e.g. 5k chars |
| Context-menu on link/image/page | Right-click | Native Chrome integration |
| Keyboard shortcut | Configurable global hotkey | Quick capture without leaving keyboard |
| Toolbar popup | Browser-action click | Mini quick-capture form |
| Content-script overlay on chat UIs | "Save turn" buttons injected per assistant message | Per-provider DOM adapters |
| Voice (mic) | Side panel mic button | Browser Speech Recognition |
| Scheduled (cron) | `chrome.alarms` | Watched queries (S41), digests (S31) |
| Forwarded email `[+claude]` | Email-in address (requires backend) | v2+ |
| RSS feed `[+claude]` | Periodic poll | v2+ |
| External webhook `[+claude]` | "Send to companion" from another tool | v2+ |

## 6. Dispatch targets (every place content can go)

| Target | Mechanism | Adapter |
|---|---|---|
| ChatGPT | Open/focus tab → inject input → optional send | `ChatAdapter:openai-web` |
| Gemini | Same | `ChatAdapter:gemini-web` |
| Claude.ai | Same | `ChatAdapter:claude-web` |
| Perplexity, Le Chat, Copilot, Phind, You.com | Same pattern | Each its own adapter |
| Google / Bing / DuckDuckGo / Kagi search | `chrome.tabs.create` with URL template | `SearchAdapter` |
| MDN / Stack Overflow / GitHub code search / Sourcegraph / devdocs | URL template | `SearchAdapter` |
| Wikipedia / Wolfram Alpha / dictionary / translator | URL template | `SearchAdapter` |
| Notion / Obsidian / Logseq / Apple Notes / Google Docs / Drive | API or local file | `NotebookAdapter` |
| Bear / Roam / Joplin / plain markdown folder | API or local file | `NotebookAdapter` |
| Claude Code (terminal CLI) | Clipboard + notification | `CodingAgentAdapter:clipboard` |
| Cursor / Aider / Bolt / V0 / Devin / Copilot Workspace | Tab inject or clipboard | Each its own adapter |
| GitHub Issues / Linear / Jira / Beads | API | `IssueTrackerAdapter` |
| Slack / Discord webhook `[+claude]` | Webhook POST | `MessageAdapter` |
| Email draft `[+claude]` | `mailto:` link | Native |
| Anki `[+claude]` (flashcard creation) | AnkiConnect localhost API | `LearningAdapter` |
| Custom URL template | User-defined `?q=` | First-class extension point |

## 7. Content types (what we move)

Text selection · whole-page (readability) · image (URL/alt + optional caption) · code block (with language) · table (preserved) · video frame / YT timestamp · PDF page snippet · social post (tweet/HN/Reddit) · chat turn (Q+A) · whole chat thread (transcript) · diff (PR) · search result list (SERP) · tab snapshot (URL+title+favicon) · research session (set of tabs over a window) · audio transcription (voice).

---

## 8. Adapter interfaces (the openness substrate)

```ts
// Notebook — your knowledge store. Notion, Obsidian, Logseq, Google Docs, etc.
interface NotebookAdapter {
  id: string;                          // "notion", "obsidian-local", ...
  capabilities: {
    search: boolean;                   // can list adapter do FTS?
    update: boolean;                   // can append vs. only create new?
    delete: boolean;
    nestedBuckets: boolean;            // hierarchical buckets?
  };
  listBuckets(): Promise<Bucket[]>;
  createBucket(path: string): Promise<Bucket>;
  appendEntry(bucketId: string, payload: EntryPayload): Promise<EntryRef>;
  updateEntry(entryId: string, patch: Partial<EntryPayload>): Promise<void>;
  getEntry(entryId: string): Promise<Entry | null>;
  searchEntries(q: SearchQuery): Promise<EntryRef[]>;
  openEntry(entryId: string): Promise<URL | FilePath>;  // for "open in tool"
}

// Chat (observed) — third-party chat UIs the user is signed into.
interface ObservedChatAdapter {
  id: string;                          // "openai-web", "gemini-web", "claude-web"
  hostMatch: string[];                 // ["chatgpt.com", "chat.openai.com"]
  detectThread(tabId: number): Promise<ThreadRef | null>;  // URL → thread ID
  observeAssistantTurns(tabId: number, cb: (turn: Turn) => void): Unsubscribe;
  injectInput(tabId: number, text: string, opts?: { send?: boolean }): Promise<void>;
  listOpenThreads(): Promise<ThreadRef[]>;  // across all tabs
}

// Search — anything that takes a query and shows results in a tab.
interface SearchAdapter {
  id: string;                          // "google", "mdn", "github-code"
  urlTemplate: string;                 // "https://google.com/search?q=${q}"
  preferredOpen: "newTab" | "currentTab";
}

// Coding agent — a CLI / tab / web tool you hand prompts to.
interface CodingAgentAdapter {
  id: string;                          // "claude-code", "cursor", "copilot-workspace"
  dispatch(prompt: string, opts?: { workingDir?: string }): Promise<DispatchResult>;
  // Implementations: clipboard+toast, tab-inject, native-messaging-host, etc.
}

// Issue tracker — for PR-loop and "open question → ticket" flows.
interface IssueTrackerAdapter {
  id: string;                          // "github", "linear", "jira", "beads"
  createIssue(payload: IssuePayload): Promise<IssueRef>;
  listIssues(query: IssueQuery): Promise<IssueRef[]>;
  addComment(issueId: string, body: string): Promise<void>;
}
```

**Why these specific adapter shapes:**
- `NotebookAdapter` capabilities flag matters — Apple Notes can't do FTS via API; we fall back to local cache index.
- `ObservedChatAdapter.detectThread` is what makes "which tab is which thread" work — every adapter must answer "given a URL, what thread?"
- `SearchAdapter` is intentionally minimal — most search engines just need a URL template.
- `CodingAgentAdapter.dispatch` is deliberately vague on transport so terminals + tabs + native hosts all fit.

---

## 9. Storage model

| Tier | What | Where | Why |
|---|---|---|---|
| **Event log** | Every highlight, dispatch, clip, drift, push, capture | IndexedDB (`bac.events`) | Months of activity will outgrow `chrome.storage.local`. Append-only. |
| **Snapshot cache** | Snapshot of saved chat turns, page selections (so déjà-vu works even if source dies) | IndexedDB (`bac.snapshots`) | Notebook adapters can be slow / offline; provenance must survive |
| **Settings** | API keys, adapter configs, bucket prefs, hotkeys | `chrome.storage.local` | Small, fast, per-profile, never synced (security) |
| **Search index** | Local FTS / optional embedding index | IndexedDB (`bac.index`) | For déjà-vu and S51. Lazy-built from events + snapshots. |
| **Notebook (canonical)** | Full notes | External (Notion / Obsidian / …) | User's source of truth |
| **Cloud sync** `[+claude]` | Optional encrypted blob of event log | User-configured (D1 / S3 / WebDAV) | v2+, multi-device |

---

## 10. UI surfaces

| Surface | Purpose |
|---|---|
| **Side panel** | Primary UI: "where was I?", dispatcher, déjà-vu results, bucket picker, thread registry, settings, search |
| **Floating button on selection** | Lightweight "look this up / save" affordance on any page |
| **Context menu** | Right-click: "save selection", "dispatch to…", "save page", "save image" |
| **Toolbar popup** | Quick capture without opening side panel |
| **Keyboard shortcuts** | Configurable: open panel, capture selection, dispatch to default target, switch bucket |
| **Content-script overlay (chat UIs)** | Per-turn "save" buttons on chatgpt.com / gemini.google.com / claude.ai |
| **Toast notifications** | Drift alerts, dispatch results, error fallbacks |
| **Tab badge** | Red dot when something needs attention (drift, forgotten thread, watched-query hit) |
| **New-tab page widget** `[+claude]` | Opt-in: today's research summary, active bucket, "where was I?" |

---

## 11. Identity, permissions, privacy

- **No mandatory account.** Local-first. Optional Chrome profile-keyed identity.
- **API keys** (if user enables paid-API features) live in `chrome.storage.local`,
  never in synced storage, never logged.
- **Per-domain enable/disable** — some users won't want plugin reading bank chat support.
- **Excluded URLs (regex)** + **deny-list** for auth/payment/banned pages (TechPulse pattern).
- **Incognito mode**: capture disabled by default; user can opt-in per-extension.
- **Audit log** — user can view "what did the plugin do today" (every event, every dispatch, every API call).
- **Local-only mode** — no remote calls at all; pure orchestration. For the paranoid.
- **Optional encryption** of event log with user-set passphrase. `[+claude]`
- **Never bundle service credentials** (TechPulse lesson). Build-time guard greps the bundle.
- **Host permissions** restricted to configured chat-UI hosts + notebook hosts. Declared dynamically when adapter enabled.

---

## 12. Long-term memory mechanics

- **Recall trigger points**: highlight, typed query, page-load (URL similarity), dispatch start.
- **Recall sources**: event log (highlights, dispatches), snapshot cache (saved chat turns + page clips), notebook adapter `searchEntries`.
- **Ranking**: BM25 + bucket boost + recency boost (start simple). Optional embeddings later (local model or one-time API call per entry).
- **Recall UI**: badge + expandable list with date, bucket-at-time, source link, snapshot preview.
- **Cross-bucket signal** (S29): same query matches entries in a bucket different from the active one → flag as "cross-bucket".
- **Stale-entry handling** (E4 family): linked notebook entry deleted → fall back to snapshot + show "snapshot from save time, original gone".
- **Privacy**: recall is local-only. Never sends event-log content to any server.

---

## 13. Orchestration mechanics

- **Thread registry**: every chat tab the user has marked "tracked" (or auto-tracked if option on) gets a row. Fields: provider, thread URL, name (auto from first user prompt or user-editable), bucket, last activity, last fed-from-note timestamp, unread badge.
- **Drift detection**: `note.lastEdited > thread.lastFedFromNote(note)` → drift. UI badge.
- **Push delta**: compute markdown diff from last-fed snapshot to current note; paste only the diff with "[updated YYYY-MM-DD, since last sync]" prefix.
- **Resume panel** (S1): renders thread registry sorted by "what needs attention next" — unread assistant replies, drift count, forgotten threads, PR notifications.
- **Auto-track vs. opt-in track** is a setting; default opt-in (less noise).
- **Aggregation** (S26 A/B): once dispatched, content scripts in each target tab observe assistant turns; once both finish (heuristic: no new tokens for N seconds), side panel renders side-by-side.
- **Chained dispatch** (S40): same observation hook + a "when reply done, do Y" rule registered at dispatch time.

---

## 14. PR / coding agent loop

- **Tracked repos**: user configures `org/repo[s]`. Plugin polls (or webhook via backend in v2) for PR changes.
- **PR review trigger**: new PR / new commit / new comment → side panel notification.
- **Diff fetch**: via `gh` CLI through native messaging host *or* GitHub API with user PAT (settings).
- **Dispatch to chat**: pastes diff + prompt template ("review for X, Y, Z" from prompt library, S36) into selected chat thread.
- **Reverse**: select assistant turn → "post as PR review comment" → GitHub API call.
- **Coding agent dispatch** (S8): clipboard + notification for terminal agents (Claude Code), tab-inject for web (Cursor), native messaging for IDE plugins.
- **Multi-agent dispatch** (S11): same prompt → N agents → side panel shows when each produces a PR / output → diff/pick.

---

## 15. Tech stack (default; can revisit)

- **WXT + React + TypeScript**, MV3 side panel — same as TechPulse companion. Reuse what works.
- **FileSystemAccess API** for vault write (extension side) — `showDirectoryPicker()` + persisted `FileSystemDirectoryHandle`. Substrate per §23.0 (interfaces and core, no plugin dependency).
- **IndexedDB** via Dexie (or `idb`) for event log, snapshots, search index.
- **OPFS** for blob snapshots (per §24.3k).
- **Defuddle** (replaces Readability.js per §24.4) for page extraction; **Turndown** for HTML→Markdown.
- **Hypothesis client** (BSD-2) for highlight anchoring (replaces Mark.js, per §24.4).
- **MiniSearch** (default) for local FTS; **transformers.js + MiniLM-L6-v2** for embeddings (v1 default per §24.4).
- **Local REST API client** (optional) — used only when user has the Obsidian plugin installed; gives surgical PATCH-with-frontmatter / PATCH-with-heading.
- **Zod** for adapter contract schemas (TechPulse pattern).
- **Vitest** + Playwright for unit + e2e tests.

---

## 16. Edge cases & failure modes (cross-cutting)

| # | Case | Plan |
|---|---|---|
| E1 | Not signed into provider in this Chrome profile | Detect via DOM (no input field present) → toast → skip target, others proceed |
| E2 | Stale chat thread URL (deleted, different account) | Tab loads to provider home → fallback to "new thread" with same prompt → log fallback |
| E3 | Chat UI DOM changed → selectors break | Catch failure → toast "Provider layout may have changed; queued to clipboard" → user pastes manually → telemetry to bump adapter version |
| E4 | Notebook entry from déjà-vu deleted/renamed | `getEntry` 404 → fall back to local snapshot ("snapshot at save time, original gone") |
| E5 | Bucket-at-time differs from current | Déjà vu still surfaces, flagged as "different bucket: job-prep" |
| E6 | User didn't pick a bucket | Default `inbox`, prompt at clip time |
| E7 | Selection too long (e.g. 12k chars) | Cap at 5k with `[truncated]` notice; full text optionally cached in event log |
| E8 | Two notebook entries match déjà vu | Show both grouped by bucket |
| E9 | Incognito tab | Content scripts not loaded → side panel "incognito: capture disabled" |
| E10 | Two open tabs claim same thread URL | Focus most recently active; log ambiguity |
| E11 | Auto-send disabled in settings | Paste only; user reviews + sends manually |
| E12 | Network offline | Queue events; replay on reconnect |
| E13 | Notion API rate-limited | Backoff + queue; surface in side panel as "queued (rate-limit)" |
| E14 | Browser updates break MV3 | Pinned test channel; staged ship |
| E15 | Chat provider blocks injection / detects automation | Fallback to clipboard + manual paste; log + telemetry |
| E16 | User-set excluded domain accidentally captures | Strict pre-check — exclusion always wins |
| E17 | Two devices, conflicting event logs | v2 sync: timestamp-merge, last-write-wins for entry text, union for events |
| E18 | User clears extension storage | Backup-export reminder before clear (where possible); offer cloud-sync opt-in |
| E19 | Watched query (S41) returns 1000s of new results | Cap at top-N; show as a single digest entry |
| E20 | A/B replies arrive at wildly different times | Show what's ready; mark slow target as "waiting"; timeout at e.g. 90s |
| E21 | User dispatches same thing twice in 5s | Debounce; second click goes to existing dispatch result |
| E22 | Persona prompt (S37) bloats every dispatch | Cap persona size; show token estimate in settings |
| E23 | Drift detection false positive (note edit was a typo fix) | "Mark as already-synced" button; or threshold edit size before flagging |
| E24 | Voice (S42) transcribes wrong words | Show transcribed text before dispatch; user can edit |
| E25 | Calendar (S46) suggests wrong bucket | One click to dismiss; learn over time |

---

## 17. Open questions (defer; we'll answer when shaping PRD)

1. Notebook today: which tool? (Picks first `NotebookAdapter` impl.)
2. Coding agent default: Claude Code / Cursor / Codex / other?
3. Auto-track open chat tabs vs. explicit opt-in?
4. Auto-send pasted prompts vs. paste-and-stop?
5. Drift detection: useful or noise?
6. PR review loop: scope for v1 or park?
7. Embeddings + paid API for déjà-vu (S27/S28): off-by-default opt-in, or local-only forever?
8. New-tab page widget: yes / no?
9. Multi-device sync: v1 / v2 / never?
10. Native messaging host (for terminal coding agents): build day-1 or v2?
11. Telemetry: any (anonymized adapter-failure pings) or strictly none?

---

## 18. Non-goals (placeholder — fill at PRD time)

- Replace your notebook tool. (We adapt to it, not absorb it.)
- Be a chat UI ourselves by default. (We can render replies, but we don't host conversations.)
- Train models. (Local index for recall; no training, no fine-tuning.)
- Mobile. (Browser extension, desktop-only for v1.)

---

## 19. Trim-down candidates (for PRD prioritization later — not now)

Holding pen for "definitely v2+" so we don't litter v1 thinking:
- S11 multi-agent coding dispatch
- S30 topic graph
- S33 trail mode (partial overlap with S22 research session)
- S40 chained dispatch
- S46 calendar awareness
- S52 bookmark import
- S54 auto-summarize (uses tokens; opposite of constraint)
- Cloud sync tier
- Email/RSS/webhook inputs

These survive in the doc for PRD reference but won't crowd v1.

---

## 20. What's next

- User adds any missing use cases / pain points.
- User flags `[+claude]` items to keep / cut.
- We then write `PRD.md` covering: vision, three workflows, every accepted scenario as a step-by-step e2e + edge-case table at the fidelity of the example shown earlier, adapter contracts, storage model, non-goals, and a v1 trim-down recommendation.

---

## 21. Addendum 2026-04-24 — dogfood loop & mindflow capture

Two threads added by user; integrating without renumbering sections 1–20.

### 21.1 Meta-observation: the user is dogfooding the product right now

While brainstorming this doc, the user is doing exactly the workflow the product
describes:

- Generated `BRAINSTORM.md` here (root node).
- Forked it to ChatGPT (branch A) with a meta-prompt about feasibility, competitors,
  scope, reuse, and missed scenarios.
- Forked the same meta-prompt to Claude (branch B).
- Awaiting both to "finish thinking" — wants a notification when each is done.
- Will read each, aggregate picks, fold back into master doc.

This is the **canonical product demo**. If we can build a v0 that supports this
exact loop end-to-end (fork to N chats → notify on completion → converge view →
patch back into the source doc), we have a credible product before anything
fancier. Call this the **dogfood spine** (S62 below).

### 21.2 Structural pattern: research DAG (fork / converge / dotted)

Earlier sections treat the event log as an append-only stream and entries as flat.
The user's actual mental model is a **DAG**:

- **Parent → child** edges: this entry was forked from that one.
- **Sibling** edges: these branches are forks of the same parent.
- **Convergence** edges: these N branches were merged into this one.
- **Dotted / loose** edges: typed "related" / "informed-by" / "see-also" — not
  structural, just labelled.

Notes are nodes; chat threads are nodes; dispatches are operations on nodes;
captures are nodes. The event log records the *operations*; a new **graph store**
records the *edges*.

A DAG (not a tree) because: same node can have multiple parents (cross-bucket
discovery is a multi-parent edge), convergences mean N nodes feed one new node,
and dotted edges aren't constrained to acyclicity at all.

### 21.3 New primitive: Relate

Slots into the section 3 primitives table alongside Observe / Inject / Locate /
Bucket / Event log / Recall:

| Primitive | What it is | Where it lives |
|---|---|---|
| **Relate** | Create / read / traverse typed edges between nodes (notes, chats, dispatches, captures) | Background, IndexedDB graph store; surfaced in side panel as DAG view |

### 21.4 New scenarios — W1 cross-AI orchestration (fork / converge / dogfood)

| # | Scenario | One-liner |
|---|---|---|
| S56 | **Fork node to N targets** `[+claude]` | Right-click any note / dispatch / capture → "fork to ChatGPT + Claude + Gemini with this prompt template" → spawns N child branches, each tracked as a workstream. Generalizes S25 (highlight dispatch). |
| S57 | **Converge branches into a target** `[+claude]` | When ≥2 branches of a fork have results, side panel offers a "converge" view: replies side-by-side, per-chunk pick/merge UI, output goes to: existing note (patch), new note (child node), or replace source. Generalizes S26 A/B to N branches. |
| S58 | **"Tell me when this thread is done thinking"** `[+claude]` | One click on any tracked chat thread → plugin watches assistant streaming via DOM mutation → desktop notification + side-panel badge when complete. Foundation for S57, S40, dogfood loop. |
| S59 | **DAG view of research history** `[+claude]` | Per-bucket graph view: nodes (notes, chats, captures) with parent/child/converge/dotted edges. Click node → preview + open. Hover edge → relationship type + when. |
| S60 | **Dotted / loose links between entries** `[+claude]` | Manual or auto-suggested "related" / "see-also" edges that aren't parent/child. Surfaces in déjà-vu (S27) and DAG view (S59). |
| S61 | **Patch-from-aggregation** `[+claude]` | When converging (S57), plugin generates a diff against the source note showing proposed adds/edits per branch — user accepts/rejects per chunk. Avoids hand-merging walls of text. |
| S62 | **Self-hosted dogfood loop (the demo zero)** `[+claude]` | Open a markdown note in side panel → "fork to N chats" with a meta-prompt → S58 watcher pings on each completion → S57 converge view shows all replies → user accepts S61 diff chunks → file is patched. Single scenario exercises fork, observe-completion, converge, patch — the spine of the whole product. **Build this first.** |

### 21.5 New scenarios — W3 ambient research / mindflow

| # | Scenario | One-liner |
|---|---|---|
| S63 | **Mindflow capture mode (passive)** | Toggle on for a window of time (or until idle): plugin records URL + title + time + tab-to-tab transitions. No content extraction by default — privacy-light by default, can opt-in to selection capture per session. |
| S64 | **Mind-map view (live, growing)** `[+claude]` | While mindflow capture is on, side panel renders a growing graph: nodes = visited tabs, edges = navigation transitions (link click, new tab from tab N, search → result, back-button). Persists per session, exportable. |
| S65 | **Think-out-loud journal** `[+claude]` | Side panel has a free-text typing area; entries timestamp-attach to whichever tab/node was active when typed. Becomes part of the mindflow record. Like Hypothesis but for the act of browsing, not the page content. |
| S66 | **Retroactive mindflow surfacing** | Past mindflow nodes (URLs, titles, journal text) participate in déjà-vu (S27/S28). Even if user didn't intentionally save, "you bounced through 4 pages about X last Saturday" surfaces when X reappears. |
| S67 | **End-of-mindflow checkpoint** | When capture ends (timer / idle / explicit), prompt: "Tag a topic? Promote any nodes to a research bucket? Discard?" Lightweight triage so noise doesn't accumulate. |
| S68 | **Curiosity bucket** | Default destination for unintentional captures, distinct from research buckets. Auto-purges after N days unless promoted. Reduces "do I need to file this?" friction. |

### 21.6 Storage model — add graph store

Slots into section 9 alongside event log / snapshot cache / settings / index /
notebook / cloud:

| Tier | What | Where | Why |
|---|---|---|---|
| **Graph / edges** | Typed edges between nodes (notes, chats, dispatches, captures): parent, child, converge-into, related-loose, mindflow-transition | IndexedDB (`bac.graph`) | DAG view (S59), patch-from-aggregation (S61), retroactive mindflow recall (S66), mind-map (S64) all traverse edges, not just scan events |

### 21.7 Dogfood loop as a development practice

Make this a **first-class development discipline** for the project:

- Every milestone has a self-test: can the product develop its *own next milestone*
  using its current primitives? If not, that's a hint about the ordering of work.
- v0.1 = the **S62 spine** (fork, observe completion, converge, patch). It's the
  smallest scenario that exercises every core primitive and is the user's actual
  current workflow. Build it first; everything else extends it.
- Once S62 works, the BRAINSTORM.md → PRD.md → per-scenario specs themselves
  become product-driven artifacts (forked to chats, converged back) rather than
  hand-curated ones.
- The brainstorm and PRD docs live as nodes in the system once the local-markdown
  notebook adapter exists. They're the first real entries.

### 21.8 New edge cases

| # | Case | Plan |
|---|---|---|
| E26 | Mindflow captures a sensitive page (banking, medical, work) by accident | Per-domain deny-list always wins; mid-flow on a denied URL → skip + visible "skipped" gap in mind-map (gap visible so user knows, but no content) |
| E27 | DAG cycle (A → forked → B → converged-back → A) | Allow; render as cycle in DAG view; recall traversal is BFS with visited set |
| E28 | Fork branch never converges (user forgot, chat thread abandoned) | After N days, "stale fork" badge on parent; one-click "drop branch" or "promote to standalone note" |
| E29 | Per-domain capture exclusion changes mid-mindflow | Apply going-forward only; existing nodes from now-excluded domain remain, with bulk-purge in checkpoint UI |
| E30 | Done-thinking watcher (S58) false positive (assistant pauses mid-stream) | Heuristic: completion = no DOM mutation in turn region for >Ns AND send-button re-enabled; tunable per provider adapter |
| E31 | Two forks return identical content (e.g. both ChatGPT and Claude give the same canned answer) | Converge UI deduplicates per-chunk before showing pick UI; flags "agreement" |
| E32 | User aborts a fork mid-flight (closes tab) | Mark branch `aborted` in graph; converge view shows N-1 branches |

### 21.9 Updated "what's next"

The user is currently mid-dogfood (this moment): forks of BRAINSTORM.md running
in ChatGPT and Claude with a meta-prompt about feasibility / competitors /
missed scenarios / wheel-reuse. Next steps:

- User reads ChatGPT and Claude replies when ready; pastes any pickups here.
- Claude folds them in (more `[+claude]` items + accepted external picks,
  flagged by source).
- Iterate until breadth feels complete.
- Then `PRD.md`, with **v1 = the S62 dogfood spine**, and trim-down driven by
  the heuristic *"does v1 let us develop v1.1 using v1?"*.

---

## 22. Addendum 2026-04-24 evening — external review fold-in (ChatGPT)

Two external reviews delivered by user. Items from this section are marked
`[+gpt]` for audit trail.

- **File 1** (`deep-research-chatgpt-early-input.md`): a generic "validate any
  project" framework (Crunchbase / TAM-SAM-SOM / patent FTO / 30-day gantt).
  Off-target — didn't engage with our actual product. Useful disciplines
  extracted in §22.1; the rest is parked.
- **File 2** (`chatgpt-second-pass-with-pro-thinking.txt`): on-target product
  analysis with strong upgrades to data model, scope, competitor map, and reuse.
  Substantially folded in §22.2 onward.
- **Claude deep research**: still in flight. Will be folded as §23 when it arrives.

### 22.1 From File 1: useful disciplines (everything else parked)

- **Tables, every cell sourced** for competitor evidence — never prose.
- **Five-lens substitute scan** when assessing competition: (a) adjacent-category
  software, (b) internal/DIY stacks, (c) open-source projects, (d) service/agency
  substitutes, (e) platform-native features quietly satisfying the need.
- File 1 contains a usable 30-day validation gantt, IP/FTO checklist, search-query
  recipes, and master competitor table template — keep on file for if/when we run
  a real validation sprint at PRD time.

Parked (premature for brainstorm phase): TAM/SAM/SOM modeling, trademark/patent
clearance, app-store ASO discussion.

### 22.2 Sharpest positioning (confirmed and clarified) `[+gpt]`

> A browser companion that **remembers, routes, and reconciles** your research
> context across AI chats, tabs, notebooks, docs, PRs, and coding agents —
> without becoming another AI model or another notebook.

**Avoid these positions** (each is a crowded space and not where the value lives):

- AI sidebar
- Chatbot aggregator
- Bookmark manager
- Web clipper
- Tab manager
- Agent browser

We are a **context switchboard + memory ledger**. The wedge is *multi-tool
coordination without forcing the user into one vendor*.

### 22.3 Data-model upgrade — workstream graph entities `[+gpt]`

Sharpens what §21.2 began. Replace "events + flat entries" with an explicit
entity model:

```
Workstream            // a research/coding initiative; spans buckets, threads, sources, decisions
  Bucket              // namespace within a workstream (e.g. "auth-redesign/threats")
  Artifact            // note, page clip, chat turn, PR diff, code snippet, search-result list, journal entry
  Source              // URL, PDF page, GitHub PR, chat thread, notebook entry
  PromptRun           // what was sent, to whom, when, with what context — the dispatch as a record
  ThreadState         // what a chat/coding-agent thread currently knows (see §22.5)
  ContextEdge         // artifact version X was sent to target Y at time Z
  Decision            // chosen conclusion, with supporting artifacts
  OpenQuestion        // unresolved question, linked to source artifacts
  Claim               // assertion + evidence + confidence + freshness
  FreshnessSignal     // source changed, note edited, PR updated, thread stale
```

The DAG edges from §21 attach between these entity instances. This is the
**state ledger for thinking** that everything else hangs off.

### 22.4 New killer abstraction — Context Pack `[+gpt]`

A **portable bundle** generated from a workstream / bucket. Markdown-shaped:

```markdown
# Context Pack: auth-redesign

## Goal
…

## Current decision
…

## Relevant source clips
- Source A, URL, captured date, quote/snippet
- Source B, PDF page 17, captured date

## Prior AI outputs
- ChatGPT thread X conclusion
- Gemini critique Y

## Open questions
…

## Code / PR context
…

## Instructions for target
…
```

**One abstraction unifies most dispatch-side scenarios:**

- Note → chat thread (with structured context, not just selection)
- Bucket → coding agent (the `context.md` from S50)
- Research → PR review (diff + decisions + open questions in one packet)
- Job-prep → study session (decisions + claims + open questions for review)
- Resume project after 10 months (rehydrate the bucket)

Context packs become the **universal handoff format**, themselves tracked as
artifacts in the workstream graph (with version history per pack).

### 22.5 Thread Knowledge State `[+gpt]`

Concrete schema that makes "drift" actionable rather than vague (replaces the
abstract S7):

```ts
interface ThreadKnowledgeState {
  threadId: string;
  provider: "openai-web" | "gemini-web" | "claude-web" | ...;
  bucket: string;
  knownArtifacts: { artifactId: string; version: string; sentAt: Date }[];
  lastUserPromptAt: Date;
  lastAssistantTurnAt: Date;
  unreadAssistantTurns: number;
  staleBecause: { artifactId: string; oldVersion: string; newVersion: string }[];
  unresolvedQuestions: string[];
}
```

Side panel can now say specifically:

> *"Gemini reviewed version 3 of `auth-redesign`. Notebook is now version 5.
>  Missing: revised threat model, latest PR diff."*

### 22.6 Typed extraction — manual-first capture buttons `[+gpt]`

On every chat turn and page clip, in addition to plain "Save", offer typed-save:

- **Save as Claim** (assertion → links to source, has confidence + freshness)
- **Save as Decision** (chosen conclusion → links to alternatives considered)
- **Save as Open Question** (unresolved → can be re-dispatched later)
- **Save as Assumption** (e.g. "this answer assumes React 19") → feeds freshness
- **Save as Counterargument** (links to the claim it counters)

Turns random captures into a usable research memory without any AI extraction
(manual-first; AI-suggest is a later optional layer).

### 22.7 Freshness signals — extended `[+gpt]`

Extend S45 (citation drift) to all freshness triggers:

- Notebook entry edited after thread feed
- PR changed after review prompt was sent
- Docs page changed after answer was saved
- Chat response predates a known source update
- Search result saved 6 months ago — query likely stale; offer rerun
- Package/library version changed since the research happened (release-note
  watcher, S90)

Each emits a `FreshnessSignal` on affected artifacts/threads, surfaces in
"where was I?" panel.

### 22.8 Dispatch Preflight (security + transparency) `[+gpt]`

Before sending anything to a chat/tool, a one-screen confirm:

- Target (provider + thread name)
- Active bucket
- Context pack length (chars, est. tokens)
- Sensitive domains included (highlighted)
- Whether the target has seen prior versions of these artifacts
- Auto-send vs paste-only setting (per dispatch override)
- Redaction warnings (emails, tokens, API keys, internal URLs detected)

OWASP lists prompt injection as the top LLM application risk; preflight is the
user's brake before bytes leave the browser. Pairs with W7 security scenarios.

### 22.9 Adapter Health Status `[+gpt]`

Extends the adapter contracts in §8:

```ts
interface AdapterHealth {
  provider: "openai-web" | "gemini-web" | "claude-web" | ...;
  canDetectThread: boolean;
  canInject: boolean;
  canObserveTurns: boolean;
  canDetectCompletion: boolean;
  lastSuccessfulTestAt: Date;
  failureReason?: string;
  fallback: "clipboard" | "open-url" | "manual";
}
```

Status surfaces in side panel; failed adapters auto-fall-back instead of
silently breaking. Trust comes from gracefully degrading, not from claiming
reliability.

### 22.10 Workstream lifecycle states `[+gpt]`

Replaces my thin "forgotten thread" handling. Each workstream / thread has a
state machine:

```
inbox  →  exploring  →  waiting on AI  →  waiting on source  →  ready to decide
              ↓                                                        ↓
         archived  ←  resurfaced                                    decided  →  handed to coding agent  →  implemented
```

Solves "forgotten thread" by knowing whether something is unresolved, obsolete,
merged, or superseded. Side panel can sort by state ("show me everything ready
to decide" / "show me what's waiting on AI").

### 22.11 Competitor landscape `[+gpt]`

| Class | Examples | Our wedge |
|---|---|---|
| **AI browsers / sidebars** | ChatGPT Atlas, Perplexity Comet, Gemini in Chrome, Copilot in Edge | Don't compete head-on. We are *vendor-neutral coordination across all of them*, not "the AI browser" |
| **Multi-model AI clients** | ChatHub, Sider, HARPA AI, Merlin | Multi-model alone isn't defensible. Differentiator: persistent workstream memory + provenance + drift + adapter openness |
| **Bookmarking / clipping / annotation** | Readwise Reader, Raindrop, Linkwarden, Hypothesis | Don't rebuild generic clipping. Saved clips become *dispatchable context* and *thread freshness signals* |
| **Personal web memory** *(closest philosophical kin)* | **Promnesia** (browsing-history enhancer, OSS), **Pieces** (OS-level memory across code/docs/chats) | *browser-workstream-first* (not OS-wide), *explicit buckets*, *cross-thread routing* |
| **Tab / workspace managers** | Workona, Toby, Tab Session Manager, Session Buddy | Use tabs as signals, not as the unit. Our row says "PR review loop, waiting on Claude answer, note edited after last feed, 2 unresolved claims" — not "5 tabs" |

Implication: positioning is **context switchboard + memory ledger**, none of
the categories above.

### 22.12 Reuse map (concrete libraries) `[+gpt]`

Updates / extends §15:

| Need | Use | Status |
|---|---|---|
| Extension framework | **WXT** (Chrome/Firefox/Edge/Safari from one codebase) | already chosen |
| Persistent side UI | Chrome **Side Panel API** | already chosen |
| Local data | **IndexedDB + Dexie** | already chosen |
| Optional permissions | **Chrome optional host permissions** at runtime | new — better than declaring all upfront |
| Page readability | **Mozilla Readability** | already chosen |
| Full-page archive | **SingleFile** pattern / lib | new — high-fidelity save vs. readability-only |
| Annotation data model | **W3C Web Annotation Data Model** | new — standardize anchoring/provenance instead of inventing |
| Local FTS | **MiniSearch / Lunr / Orama** | Orama new — supports hybrid full-text + vector |
| Optional local embeddings | **Transformers.js** or **Chrome built-in AI APIs** | new — on-device déjà-vu without paid API |
| Obsidian integration | **Obsidian URI / Advanced URI** | new — concrete adapter mechanism |
| Notion integration | **Notion block APIs** (`append block children`) | new — concrete adapter mechanism |
| Joplin integration | **Joplin Web Clipper / Data API** | new — concrete adapter mechanism |
| GitHub PR/issues | **GitHub REST + gh CLI** | already implied |
| Tool interop standard | **MCP** (Model Context Protocol) | new — v2+ extension point (see below) |
| Extension testing | **Playwright** (supports Chrome extensions) | already chosen |

**Key new finding — MCP**: rather than passing context.md files to coding
agents, expose our workstream graph as an **MCP server**. Coding agents (Claude
Code, Cursor) can then *query the user's research memory directly as a tool*.
Cleaner v2 handoff than file/clipboard. Worth flagging now so we don't
architect against it.

### 22.13 New workflow families W4–W9 `[+gpt]`

Catalog continues from §4. Numbering S69+ in this addendum.

#### W4 — Research decision memory

| # | Scenario | One-liner |
|---|---|---|
| S69 | **Decision log per bucket** | "We chose X over Y because…" with source clips and AI critiques attached. Persistent `Decision` artifact in workstream graph. |
| S70 | **Claim ledger** | Save claims with evidence link, confidence, source, freshness. Surface conflicting claims (S72). |
| S71 | **Assumption tracker** | "This answer assumes React 19 / k8s 1.31 / pricing as of 2026-04". Feeds freshness checks (S90). |
| S72 | **Contradiction detector** | Two saved claims disagree → side panel surfaces both + source + asks user to resolve. |
| S73 | **"What changed since last research?"** | Rerun saved query / refetch saved sources → diff against last result → highlight novel material. |

#### W5 — Context pack / handoff workflows

| # | Scenario | One-liner |
|---|---|---|
| S74 | **Bucket → context.md export** | Generate context pack from a bucket as portable markdown. Drop into a project for a coding agent to read first. (Subsumes / sharpens S50.) |
| S75 | **Thread → context pack** | Turn a messy chat into a structured packet (goal / facts / decisions / open questions); extraction manual-first, AI-assisted optionally. |
| S76 | **Notebook delta → all targets (versioned)** | Push only the diff to every stale tracked target; record per-target version receipt in `ContextEdge`. Sharpens S3. |
| S77 | **PR diff + research pack → review thread** | Combine code diff + design notes + prior decisions + open questions + review prompt template; dispatch as a single packet. |
| S78 | **Rehydrate workstream** | One click reopens: tabs, notebook entry, relevant chat threads (focus or open), PR, side-panel state restored to last working configuration. The "where was I after 10 months" answer made operational. |

#### W6 — Quality and evaluation

| # | Scenario | One-liner |
|---|---|---|
| S79 | **Save model verdict** | After A/B comparison (S26), record which answer won and why → builds per-bucket model-quality picture over time. |
| S80 | **Prompt run history** | Every dispatch (`PromptRun`) tracks template, target, response, rating, follow-ups. Browsable by template / target / bucket. |
| S81 | **Repeatability check** | Run same prompt N times to same model → variance report. (Extends S39.) |
| S82 | **Source-backed answer view** | UI mode that visually separates "claims with sources" from "unsupported AI suggestions" in any rendered answer. |
| S83 | **Hallucination review queue** | Mark suspicious claims for later verification → queue surfaces in weekly review (S31). |

#### W7 — Security / privacy workflows

| # | Scenario | One-liner |
|---|---|---|
| S84 | **Sensitive-page shield** | Auto-disable capture on auth/payment/bank/health/internal domains (TechPulse pattern, made first-class with deny-list config). |
| S85 | **Redaction preflight** | Detect and warn on emails, tokens, API keys, secrets, internal URLs *before* dispatch leaves the browser. Inline replace-with-placeholder option. |
| S86 | **Prompt-injection taint label** | Content captured from untrusted pages is marked `untrusted` in the workstream graph; flagged in dispatch preflight when sent to agents. |
| S87 | **Local-only strict mode** | Toggle: no external API calls, no cloud sync, no telemetry, no screenshots. The "paranoid mode" guarantee. |
| S88 | **Adapter permission ledger** | User can inspect "today the extension read X, saved Y, sent Z" — daily audit of all adapter actions. |
| S98 | **Dispatch preflight panel** | One-screen confirm before any dispatch (see §22.8). |

#### W8 — Coding-specific workflows

| # | Scenario | One-liner |
|---|---|---|
| S89 | **Error stack → research session** | Capture stack trace from console / page → search docs + ask AI in parallel (W3) → save fix path as decision (S69). |
| S90 | **Release-note watcher** | "Library X released v2.0 — your saved note about X (assumes v1.4) may be stale." Triggered by package-version diff against assumption (S71). |
| S91 | **Code-review memory** | "You previously rejected this pattern in PR #42." Cross-PR decision recall. |
| S92 | **ADR generator** | Convert research bucket + AI debate into Architecture Decision Record markdown for the repo. |
| S93 | **Agent output comparison** | Claude Code vs Cursor vs Codex on same task → side-by-side diff + risk notes + final chosen patch saved as decision. (Sharpens S11.) |

#### W9 — Onboarding and import

| # | Scenario | One-liner |
|---|---|---|
| S94 | **Import Chrome bookmarks as buckets** | First-run shortcut. (Subsumes S52.) |
| S95 | **Import open tabs as session** | Existing browser chaos → first workstream. |
| S96 | **Import Readwise / Raindrop / Linkwarden / Obsidian / etc.** | Avoid making user start from zero; populate workstream graph from prior tools. |
| S97 | **"Find abandoned research" scan** | Locate old saved tabs, notebook entries, chat threads with no `Decision` linked → surface for triage. |

### 22.14 The biggest design principle `[+gpt]`

Every workflow should create a **durable relationship**:

```
source artifact
  → captured into bucket
  → optionally transformed into context pack
  → dispatched to target (PromptRun + ContextEdge)
  → response observed or manually captured (Artifact)
  → saved as claim / decision / question (typed Artifact)
  → freshness tracked over time (FreshnessSignal)
```

Capture alone doesn't solve the painpoint. Dispatch alone doesn't. Search alone
doesn't. **The durable loop does.** Every feature gets evaluated against:
*"does this complete or extend the loop?"*

### 22.15 Strongest-version manifesto `[+gpt]`

For PRD-time scoping. The minimum coherent product is:

1. Local event log + snapshot cache
2. **Workstream graph** (not just buckets)
3. Thread knowledge state + drift detection
4. **Context packs** as the universal handoff format
5. Adapter-based observe/inject with **clipboard/manual fallback**
6. **Notebook integrations** instead of replacing notebooks
7. **Local recall first**; optional local/paid AI enhancements later
8. Strong privacy / permission / redaction model
9. **Quality layer**: claims, decisions, open questions, stale sources
10. **Rehydration**: one click to recover the whole project context

### 22.16 Updated "what's next"

- Claude deep research still in flight — fold as §23 when delivered.
- User picks/cuts `[+gpt]` items above.
- After Claude-deep-research arrives + user trims, build a
  **scenario-by-scenario feasibility matrix** for S1–S98 classifying each by:
  technical risk, dependency risk, privacy risk, best reuse option. ChatGPT-Pro
  recommended this as the next artifact and it's a good bridge to PRD scoping.
- Then `PRD.md`, anchored on the 10-point manifesto. Candidate v1 spine
  (covers all 10 manifesto points at minimum scope):
  - **S62 dogfood loop** (fork → observe completion → converge → patch)
  - **S78 rehydrate workstream** (the "where was I after 10 months" promise)
  - **S74 context pack export** (the universal handoff)
  - **S25 highlight dispatch** (the simplest entry point users meet first)
  - Plus the workstream-graph + thread-state + adapter-health plumbing they require.

---

## 23. Addendum 2026-04-24 evening — Obsidian as the notebook anchor

User input: pick **Obsidian** as the canonical notebook target — not just one
of many adapters. Provided detailed integration map (8 tiers from filesystem
to plugin API to Local REST API to Canvas/Bases). Items marked `[+claude]`
are extensions of the user's pick.

This is the most consequential addendum yet — Obsidian's design choices align
with our hard constraints (local-first, open formats, user-owned data, no
token burn) so completely that anchoring on Obsidian *removes scope* rather
than adding it.

### 23.0 Principle: Obsidian-first-citizen, interfaces-and-core-only `[user 2026-04-26]`

Before the integration-tier picks below, fix the load-bearing principle that
all later tiers must respect:

> **Obsidian is the first-class notebook citizen** — it is the chosen target,
> and BAC's vault conventions follow Obsidian's (frontmatter Properties,
> wikilinks, tags, folders, `.canvas`, `.base`, `_BAC/` reserved namespace).
> **But operation depends only on interfaces and core**: the filesystem, the
> Markdown + YAML frontmatter substrate, the JSON Canvas spec, the `.base`
> spec, and the `_BAC/` folder convention. **Plugins** — including the Local
> REST API plugin — **are opt-in acceleration tiers, never required for BAC
> to function.**

What this rules out:

- "v1 requires the user to install Local REST API plugin" — wrong framing.
- "BAC writes through the REST API as the primary path; filesystem is the
  fallback" — also wrong. The substrate is filesystem-and-files; REST API
  is the accelerator.
- "If the user doesn't install plugin X, BAC enters a degraded mode" — only
  true for plugin-specific niceties (surgical PATCH, Dataview). Core capture,
  organization, dispatch, recall, MCP must all work plugin-free.

What this admits:

- BAC needs **filesystem write access to the vault folder**. In a Chrome MV3
  extension that means **FileSystemAccess API** (`showDirectoryPicker()` once
  + persisted `FileSystemDirectoryHandle`). In a Node companion daemon
  (§26.6) it means a configured vault path.
- Where Local REST API *is* installed, BAC opportunistically uses the
  surgical-PATCH endpoints to avoid read-modify-write races. Where not
  installed, BAC uses temp-file-then-rename atomic writes to the same files.
- Same applies to Dataview / Bases / any other plugin: BAC writes the file
  formats those plugins consume (`.base`, frontmatter conventions), so
  having them installed *renders* nicer in Obsidian, but BAC neither
  requires them nor breaks without them.

**Sync vs connection are separate concerns** — see §27 for the explicit
split between vault-connection setup, sync-in (vault → BAC baseline / keep
in sync), and sync-out (BAC → vault for items the user manually adds outside
the tracked set). Conflict / merge semantics deferred.

This principle reverses the §24 anchor that read "Local REST API plugin is
the primary integration tier; v1 requires user installs it." That sentence
is retracted. The §26.7 "filesystem-write-first adapter" delta — previously
demoted to PoC-scope only — is **promoted to a v1 anchor** as the natural
expression of this principle.

### 23.1 Decision: Obsidian as canonical notebook anchor

**Anchor on Obsidian for v1.** Other notebooks (Notion, Logseq, Joplin, plain
markdown folder, Apple Notes, Google Docs) become **ports** of the
Obsidian-shaped contract, added as needed.

**Why Obsidian specifically:**

- **Local-first + file-over-app**: vault is a folder of `.md` files the user
  owns and can inspect, version, back up, and read with any tool. Matches our
  "user-owned data" principle exactly.
- **Open formats**: Markdown + YAML frontmatter + wikilinks + JSON Canvas +
  `.base` files. We can read and write all of them as plain text — no API
  lock-in, no schema drift hidden inside a SaaS.
- **Local REST API plugin** ([coddingtonbear/obsidian-local-rest-api]): gives
  authenticated HTTPS read/write/patch access from a browser extension to the
  vault. *Opt-in acceleration* — when present, BAC uses surgical PATCH-with-
  frontmatter-target / PATCH-with-heading-target endpoints. **Not a hard
  dependency**: BAC's primary write path is the filesystem-and-Markdown
  substrate (see §23.0 below). The plugin is "nice to have," not "needed to
  function."
- **Canvas (`.canvas` JSON)**: native infinite visual board with nodes/edges.
  We can write canvases programmatically — see §23.3.
- **Bases (`.base` files)**: database-like views over notes/properties. We
  can write base files; Obsidian renders them as tables/cards/dashboards.
- **Plugin API + Obsidian CLI**: deeper integration paths exist if we ever
  outgrow REST.
- **Web Clipper** already exists for capture — we don't compete; we route
  around or coexist.

### 23.2 Integration tier picks

Of the 8 tiers from user's brief, our picks for v1 / v1.5 / later:

| Tier | What | When | Used for |
|---|---|---|---|
| **Direct filesystem** | Read/write `.md`, `.canvas`, `.base` files via FileSystemAccess API (extension) or vault path (companion daemon) | **v1 — primary** | All vault writes/reads. Atomic temp-file-then-rename. Substrate, not fallback. |
| **JSON Canvas** (`.canvas`) | Write `.canvas` files into vault | **v1** for spine | DAG view (S59), mind-map (S64), workstream visualization — see §23.3 |
| **Bases** (`.base`) | Write `.base` files into vault | **v1** for spine | "Where was I?" panel (S1), claim ledger (S70), decision log (S69), workstream lifecycle dashboard — see §23.3 |
| **Obsidian URI** (`obsidian://`) | Deep-link triggers (open file, search, daily note) | **v1** | "Open this entry in Obsidian" buttons in side panel; quick-capture deep-links from browser action |
| **Local REST API plugin** | Authenticated HTTPS read/write/PATCH/search/commands when user has installed it | **v1 — opt-in acceleration** | Surgical PATCH-with-frontmatter-target / PATCH-with-heading-target avoids read-modify-write races. BAC detects presence and uses where available; never required. |
| **Web Clipper coexistence** | Don't replace; recognize when user has it | **v1** | Detect installed; offer "use Web Clipper" as fallback for static page-clip when our flow is overkill |
| **Obsidian CLI** | Shell out to `obsidian` for scripted ops | **v2** | Power-user automations, agent workflows |
| **Plugin API (in-Obsidian plugin)** | Companion plugin running inside Obsidian | **v2+** | Native side-panel inside Obsidian itself, real-time vault events |

**Substrate (always required)**: filesystem write access to the vault folder
(via FileSystemAccess API in the extension, or a configured path in a
companion daemon). Plus the Markdown + YAML frontmatter + `.canvas` + `.base`
file formats and the `_BAC/` reserved namespace. These are interfaces and
core — they exist regardless of which plugins the user has installed.

**Opt-in accelerators (none required)**: Local REST API plugin (surgical
PATCH; HTTPS bearer auth), Dataview (richer in-vault queries), Bases
(richer dashboards). When installed, BAC uses them transparently. When
absent, BAC falls back to plain file writes / Markdown-table dashboards —
same data model, same scenarios, slightly different rendering.

### 23.3 The big scope simplifier — write Canvas + Bases instead of building UIs `[+claude]`

This is the most important architectural insight in the addendum.

**Don't build:**
- Our own DAG visualization for §21 / S59
- Our own "Where was I?" dashboard UI for S1
- Our own claim ledger / decision log dashboards (S69 / S70)
- Our own mind-map renderer for S64

**Do instead:** programmatically write `.canvas` and `.base` files into the
user's vault. Obsidian renders them with full UI, zoom/pan/drag, filtering,
sorting, grouping — all of which we'd otherwise reinvent badly.

**What this looks like in practice:**

| Surface we'd otherwise build | Replace with |
|---|---|
| Side-panel DAG view of research history (S59) | Auto-write `.bac/dag.canvas` with workstream nodes + edges; click "Open in Canvas" |
| "Where was I?" thread registry (S1) | Auto-write `.bac/where-was-i.base` filtered by status; user opens in Obsidian for the full dashboard |
| Mind-map of mindflow capture (S64) | Auto-write `.bac/mindflow-2026-04-24.canvas` as the session ends |
| Claim ledger (S70) | `.bac/claims.base` with `confidence`, `source`, `freshness` columns |
| Decision log (S69) | `.bac/decisions.base` grouped by bucket |
| Workstream lifecycle dashboard (§22.10) | `.bac/workstreams.base` filtered by `status` |
| Hallucination review queue (S83) | `.bac/review-queue.base` filtered by `flagged: true` |
| Architecture Decision Records (S92) | Standard markdown notes with ADR frontmatter; user opens with their preferred ADR view |

The side panel becomes **the dispatcher / capture-tool / preflight UI**, not
the dashboard. Dashboards live where they belong: in the user's notebook.

**Bonus**: this means *the user can edit our outputs by hand in Obsidian*. They
can drag nodes around in the Canvas, add their own notes, filter/sort the
Bases. Their edits round-trip into our state on next read. Obsidian becomes
both presentation layer and editable interface.

### 23.4 Workstream graph mirrored to frontmatter `[+claude]`

The §22.3 entity model (Workstream / Bucket / Artifact / Source / PromptRun /
ThreadState / ContextEdge / Decision / OpenQuestion / Claim / FreshnessSignal)
should be **mirrored into the vault as note frontmatter**, not just kept in
extension-internal IndexedDB.

Pattern:

```yaml
---
bac-id: artifact-2026-04-24-1432-7a3
bac-type: claim
bac-workstream: auth-redesign
bac-bucket: auth-redesign/threats
bac-source: chat:openai-web/threadXYZ#turn5
bac-confidence: medium
bac-freshness: ok
bac-related: [artifact-2026-04-19-..., artifact-2026-04-22-...]
bac-created: 2026-04-24T14:32:00-07:00
---

# Yjs delete-set merging

User asked ChatGPT how Yjs handles GC of delete sets. Answer below…

## Quote
> Delete sets in Yjs are merged by…
```

**Three large wins:**

1. **The graph survives uninstall.** State is in user's vault, not locked in
   our extension. If we go away, the user keeps everything in plain text.
2. **Bases can render dashboards over it natively.** The `.base` files in
   §23.3 query these very `bac-*` properties. No separate index.
3. **Other tools can read it.** AI agents reading the vault see the same
   structure. Claude Code reading a vault for context gets typed claims, not
   undifferentiated markdown.

The IndexedDB graph store (§21.6) still exists as a **fast cache + index**
for browser-side queries (déjà-vu, drift detection), but it's derived from
vault state, not the source of truth. If cache and vault disagree, vault wins.

### 23.5 Inbox-first writing pattern `[+claude from user's Pattern B]`

The user's brief flagged: *"For safe writes, use atomic file writes, avoid
editing the currently open note, preserve frontmatter, and prefer
append-only inbox patterns when possible."*

Adopt as **the default writing posture**:

```
Browser capture / dispatch / chat-turn save
        ↓
{vault}/Inbox/bac-{timestamp}-{slug}.md
        ↓
User reviews in Obsidian
        ↓
Promote / link / move to permanent location
```

- All ad-hoc captures (S14 selection, S4 chat turn, S15 page clip, S40 inbox
  triage, S53 inbox triage, S68 curiosity bucket) write to `Inbox/` first.
- Promotion is a user action in Obsidian (move, link, edit).
- Side panel can offer a "promote inbox entries" prompt at end of session
  (S67 checkpoint).
- We never write into the user's permanent folders without explicit
  confirmation, except for the `.bac/` reserved folder (Canvas + Bases).

### 23.6 Coexistence with Web Clipper

Obsidian Web Clipper is the official capture tool. Don't replace it; coexist:

- **Detect**: at first run, check whether Web Clipper is installed (URI ping).
- **Defer**: for pure "save this article as a clean markdown" use cases (no
  dispatch, no provenance graph), recommend Web Clipper. We're overkill there.
- **Augment**: when user does want dispatch / provenance / freshness on a clip,
  our flow takes over — but writes the captured markdown in a Web-Clipper-
  compatible shape so the user doesn't see two formats.

### 23.7 Updated NotebookAdapter contract (Obsidian-flavored)

The §8 contract was stack-neutral. Obsidian-anchoring sharpens it:

```ts
interface NotebookAdapter {
  id: "obsidian-rest" | "obsidian-fs" | "notion" | "logseq" | "markdown-folder" | ...;
  capabilities: {
    // existing
    search: boolean;
    update: boolean;
    delete: boolean;
    nestedBuckets: boolean;
    // new (Obsidian-flavored)
    frontmatter: boolean;        // can read/write YAML properties?
    backlinks: boolean;          // can resolve [[wiki]] links?
    canvas: boolean;             // can write .canvas files?
    bases: boolean;              // can write .base files?
    inboxFolder: boolean;        // supports atomic-write to inbox pattern?
    nativeOpen: boolean;         // has a "open this entry" deep link (URI / file://)?
  };
  // existing: appendEntry, updateEntry, getEntry, listEntries, searchEntries, openEntry...
  // new:
  writeCanvas(path: string, canvas: JSONCanvas): Promise<void>;
  writeBase(path: string, base: BaseDefinition): Promise<void>;
  writeFrontmatter(entryId: string, properties: Record<string, unknown>): Promise<void>;
  patchHeading(entryId: string, heading: string, body: string): Promise<void>;
  resolveBacklinks(entryId: string): Promise<EntryRef[]>;
}
```

Notion/Logseq/etc. fall back to `capabilities.canvas: false` etc. — the side
panel's own UI is the fallback for users without Obsidian. (UI scope creeps
back in for non-Obsidian users; that's the cost of the simplification.)

### 23.8 New scenarios — Obsidian-specific

| # | Scenario | One-liner |
|---|---|---|
| S99 | **Auto-write workstream graph as frontmatter** `[+claude]` | Every artifact's `bac-*` properties live in the entry's YAML frontmatter. Vault is source of truth; IndexedDB is cache. |
| S100 | **DAG view as `.canvas` file** `[+claude]` | S59 implemented by auto-writing `.bac/dag-{workstream}.canvas`; user opens in Obsidian for native Canvas view. |
| S101 | **"Where was I?" as `.base` file** `[+claude]` | S1 implemented by auto-writing `.bac/where-was-i.base` with status filter; user opens in Obsidian. Side panel still shows a quick text summary. |
| S102 | **Claim ledger `.base`** `[+claude]` | S70 implemented as `.bac/claims.base` filterable by confidence/freshness. |
| S103 | **Decision log `.base`** `[+claude]` | S69 implemented as `.bac/decisions.base` grouped by bucket. |
| S104 | **Inbox-folder write protocol** | All ad-hoc captures land in `{vault}/Inbox/bac-{ts}-{slug}.md`; never write to permanent locations without confirmation. |
| S105 | **Open entry in Obsidian via URI** | Side panel "open" button uses `obsidian://open?vault=…&file=…` — no separate adapter call needed. |
| S106 | **Trigger Obsidian search from side panel** | "Search vault for X" via `obsidian://search?vault=…&query=…` URI — falls back to REST API search if URI unavailable. |
| S107 | **Atomic write protocol** | Writes use REST API `PATCH` (avoid race with user edits) or filesystem temp-file + rename; if a target file is currently open in Obsidian, refuse and queue. |
| S108 | **First-run vault wiring (connection setup)** | At first run: user picks vault folder via FileSystemAccess `showDirectoryPicker()` (or pastes path for daemon mode); BAC persists handle; opportunistically detects Local REST API plugin and offers to use surgical PATCH if present, with "skip — use plain filesystem writes" always available. Plugin install is suggested, never required. See §27 for how connection setup is separate from sync direction. |
| S109 | **Mindflow session as one `.canvas`** `[+claude]` | S63 + S64 implemented: each mindflow session writes one `.canvas` to `{vault}/Mindflow/{date}.canvas` with visited URLs as nodes and navigation transitions as edges. User can immediately reorganize the canvas in Obsidian. |
| S110 | **Context pack as a permanent vault note** `[+claude]` | S74 writes context pack to `{vault}/Context/{bucket}-{date}.md`; user can edit, link, version-control. Coding agents read it from the vault directly. |
| S111 | **Read user's vault as RAG source** `[+claude]` | When dispatching to a chat, optionally include "relevant prior notes from your vault" — local FTS search against vault for related notes, top N attached to context pack. Subsumes part of S27 déjà-vu when user has a structured vault. |

### 23.9 Tradeoffs and open issues with Obsidian-anchoring

| # | Issue | Tentative response |
|---|---|---|
| O1 | ~~Requires user to install Local REST API plugin~~ → reframed per §23.0: plugin is **opt-in acceleration only**; baseline filesystem writes work without it | First-run S108 wires vault folder; plugin presence is detected, suggested, never required |
| O2 | What if user doesn't use Obsidian at all? | v1: "Obsidian-required" positioning, narrows market but sharpens product. v1.5: ship `markdown-folder` adapter (fewer features — no Canvas/Bases UIs) for non-Obsidian users |
| O3 | Mobile vault access from desktop extension | Out of scope. Cloud-synced vaults (iCloud/Dropbox/Obsidian Sync) work transparently when both devices touch the same files |
| O4 | Conflict resolution when user edits a note we're patching | Use REST API atomic patches where possible; for filesystem writes, refuse to write to currently-open files (S107) |
| O5 | Performance for large vaults (10k+ notes) | Local REST API may be slow for bulk reads; maintain our IndexedDB cache as the primary read path; periodic sync, not on-demand reads |
| O6 | `.base` and Canvas formats may evolve in Obsidian | Pin to versioned schema; degrade gracefully on unknown fields; don't auto-overwrite user-edited Canvas/Base files (write to `.bac/` reserved namespace) |
| O7 | Local REST API uses self-signed cert by default | Document trust step in S108; consider HTTP-only on `127.0.0.1` if user prefers |
| O8 | Web Clipper user shows up; gets confused which to use | Detect (S23.6) and route — never run both for the same capture |
| O9 | User's vault is encrypted (e.g. Cryptomator) | Filesystem-tier writes work; REST API works (Obsidian sees decrypted view); just slower |
| O10 | User has multiple vaults | First-run S108 picks one as "primary"; settings allow per-bucket vault routing in v1.5 |

### 23.10 Updated v1 spine

The §22.16 candidate v1 was: S62 + S78 + S74 + S25 plus plumbing. With
Obsidian-anchoring, the spine sharpens:

| Scenario | Why in v1 spine |
|---|---|
| **S108** First-run vault wiring (connection setup) | Onboarding gate for the vault-write substrate; plugin detection is opportunistic, not gating (§23.0) |
| **S25** Highlight dispatch | Simplest entry point users meet first |
| **S62** Dogfood loop (fork → observe → converge → patch) | The canonical demo; exercises every primitive |
| **S104** Inbox-folder write protocol | Default writing posture — every capture lands somewhere safe |
| **S99** Frontmatter mirror | Workstream-graph state lives in vault, not just IndexedDB |
| **S100** DAG view as `.canvas` | Replaces our would-be DAG UI; defers a huge build |
| **S101** "Where was I?" as `.base` | Replaces our would-be dashboard UI; defers a huge build |
| **S74** Context pack export | The universal handoff format |
| **S78** Rehydrate workstream | The "where was I after 10 months" promise made operational |
| **S105** Open entry in Obsidian via URI | Round-trips user back to their notebook for any deep work |

That's 10 scenarios, not 4. The added 6 are mostly *trivially small to
implement* (file write + URI link), because the heavy UI lifting is
delegated to Obsidian. So scope grows by count but **falls in implementation
weight**.

### 23.11 What this changes in earlier sections

Marking for the eventual PRD pass — these earlier items now have
Obsidian-specific implementations:

- §3 primitives: **Locate** now also locates entries in the vault, not just
  in browser tabs.
- §8 NotebookAdapter contract: extended in §23.7.
- §9 storage model: vault is the **canonical** tier; IndexedDB demoted to cache.
- §10 UI surfaces: side panel becomes much thinner — dispatcher + preflight +
  capture, not dashboards. Dashboards live in Obsidian.
- §15 stack: add **FileSystemAccess** writer (extension-side primary path);
  add JSON Canvas writer; add Bases writer; add **optional** Local REST API
  client (used opportunistically when plugin detected).
- §17 open question 1 ("Notebook today?") — answered: **Obsidian, anchor in v1**.

### 23.12 Updated "what's next"

- Claude deep research still in flight — fold as §24 when delivered.
- User picks/cuts `[+claude]` items in §23 (the integration-tier picks and the
  Canvas+Bases reuse strategy are the load-bearing claims; everything else is
  implementation detail).
- After Claude deep research arrives, build the **scenario-by-scenario
  feasibility matrix** (S1–S111 now) bridging to PRD scoping.
- Then `PRD.md`, anchored on the §22.15 manifesto + the §23.10 v1 spine.

---

## 24. Addendum 2026-04-24 evening — Claude deep research fold-in

Claude deep research delivered. Far more technically dense than File 1/2 — full
citation chain, current state of 2025/26 ecosystem, named libraries with
maintenance status, concrete numerical estimates. Items marked `[+claude-dr]`.

This addendum **changes a few earlier choices** (Readability → Defuddle, native
messaging → MCP/localhost-WebSocket, local embeddings v2 → v1) and **adds one
load-bearing axis the prior addendums missed entirely**: MCP as both host and
server. Read §24.2 first — it's the executive summary.

### 24.1 Source

`/Users/yingfei/Downloads/compass_artifact_wf-5d7faefd-…_text_markdown.md`,
~538 lines, titled "Browser-AI-Companion (BAC): Exhaustive Brainstorm Research
Report". Citation chain ~80 links across Chrome dev docs, MDN, GitHub, Hugging
Face, MCP blog, competitor sites.

### 24.2 The five takeaways `[+claude-dr]`

Top of section so they shape the rest of the read:

1. **MCP is the missing axis.** BAC should be **both** an MCP host (hosting
   filesystem/GitHub/Linear/Sentry servers user adds, dispatchable from the side
   panel) **and** an MCP server (exposing event log + recall + notebook adapters
   to external coding agents — Claude Code, Codex, Cursor — so the user in their
   terminal can ask "what did I research about WebGPU last March?" and the agent
   queries BAC's local MCP server). *This is the integration shape that makes
   BAC genuinely architecturally novel vs. Sider et al.*
2. **DOM injection works but should not be the primary substrate.** Use
   **`fetch`/SSE interception** as default (wire format more stable than HTML),
   debounced MutationObserver only for streaming, with a per-load **selector
   canary** that surfaces a warning when selectors stop resolving. Plan for ~1–2
   selector breakages per provider per quarter (~15 maintenance sprints/year for
   3 providers — *not a side-project commitment*). Always graceful-degrade to
   clipboard mode.
3. **Local semantic recall is now genuinely viable in 2026** — promote local
   embeddings from "v2 maybe" to **v1 default**. transformers.js + MiniLM-L6-v2
   (~25 MB ONNX) or EmbeddingGemma-300M (Matryoshka-truncatable) runs in a
   service worker / offscreen document; HF shipped the official "Transformers.js
   Gemma Browser Assistant" extension in Nov 2025 as a reference. PGlite +
   pgvector + transformers.js gives HNSW in-browser search.
4. **The 55-scenario surface is right but needs ruthless onboarding and an MVP
   wow.** Smallest version that delivers magic: **(a) "Where was I?" panel
   spanning providers, (b) chat-turn capture with provenance, (c) parallel
   highlight dispatch (Google + ChatGPT in parallel), (d) déjà-vu on highlight
   at 3-day–3-week recency.** ~25% of the spec surface, ~80% of the magic. The
   "10 months later" recall is delightful but rare; **3-week recall is what
   converts users**. Reframe W3 from "long-term" to "calibrated-freshness".
5. **Two concrete library swaps:** (a) **Defuddle replaces Readability.js** —
   Mozilla's library is effectively in maintenance mode; Defuddle is built for
   Obsidian Web Clipper, multi-pass extraction, standardized footnotes/code/
   math output. (b) **WebSocket localhost bridge / MCP server replaces native
   messaging** for terminal-coding-agent integration. Native messaging requires
   registry-key install (Windows) or out-of-band install (macOS) and can't be
   verified for authenticity. WebSocket-localhost (Browser MCP / Browserbase
   pattern: `npx browser-mcp` once) is materially better install UX, and unifies
   with takeaway #1.

### 24.3 Technical reality picks (from §A) `[+claude-dr]`

Concrete things to bake into the design that the brainstorm under-specified:

| # | Picks | Why |
|---|---|---|
| **24.3a** | **`fetch`/SSE interception primary, DOM secondary** for chat observation. Per-provider adapter wraps `window.fetch` and `XMLHttpRequest`; intercepts JSON responses from `/backend-api/conversation` (or equivalent) before React renders | Wire format changes far less often than rendered HTML; "light-session" extension for ChatGPT and WebDecoy's RE article confirm this is the mainstream pattern |
| **24.3b** | **Selector canary on every chat-tab load** — verify all critical selectors resolve, surface a yellow banner if not, queue diagnostic bundle | PinIt extension author's recommendation; saves the maintenance-treadmill from silent breakage |
| **24.3c** | **Debounced MutationObserver (300ms) + injection markers** (`data-bac-injected`) | Streaming responses cause per-token mutations; double-injection bug is real |
| **24.3d** | **Beware virtualized message lists** (chatgpt-lag-fixer pattern replaces off-screen turns with placeholders) — never assume "all messages are in the DOM" | Long threads silently lose history if naive walk |
| **24.3e** | **`isTrusted` is a future bot-detection vector** — chrome.dispatchEvent generates `isTrusted=false`, the only workaround is `chrome.debugger` (yellow banner UX-killer). None of the providers gate on it today, but architect a clipboard-mode fallback | Unforgeable signal; if any provider flips it on, dispatch breaks instantly |
| **24.3f** | **`chrome.storage.session` for hot state, IndexedDB for durable, never assume in-memory globals persist** — service worker terminates after 30s inactivity | MV3 reality; PinIt and Anthropic's own claude-in-chrome extension hit this |
| **24.3g** | **Offscreen documents required for**: HTML parsing, audio capture, clipboard, Workers for embeddings, transformers.js model loading. Plan one offscreen doc per concern | MV3 service workers can't do these directly |
| **24.3h** | **`chrome.alarms` minimum is 30s** (relaxed in Chrome 120) — fine for periodic drift checks, not sub-second polling | Plan periodic ops accordingly |
| **24.3i** | **Per-origin IndexedDB quota is dynamic and `unlimitedStorage` does NOT exempt IndexedDB** — only `chrome.storage.local`. Eviction is all-or-nothing under storage pressure | One eviction = total knowledge loss. Mitigations: §24.3j |
| **24.3j** | **Always call `navigator.storage.persist()` on init**, monitor `navigator.storage.estimate()`, surface usage in UI, offer encrypted-blob backup to disk via File System Access API | Persistent storage protects against eviction |
| **24.3k** | **Use OPFS (Origin Private File System) for snapshot blobs** — full-page Defuddle HTML, screenshots, model weights. IndexedDB for events + index | OPFS is friendlier to large binaries; transformers.js / PGlite-in-browser already use it |
| **24.3l** | **Stateless drift detection via markdown-comment markers**: when injecting a note into a chat, embed `<!-- bac:src=note-id@hash -->`. On re-visit (any browser/profile), find marker, compare hash → drift = stateless | Spec heuristic `note.lastEdited > thread.lastFedFromNote` requires a content script alive on the chat tab; survives tab closure with markers, doesn't without |
| **24.3m** | **Reply-done detection: 4 cascading signals**, use first-fires: (1) SSE/fetch close, (2) Send-button re-enabled / stop→send transition, (3) Regenerate/copy/thumb buttons rendered, (4) Token-quiet timer 6–10s | Tool-use pauses (web search, code interpreter, MCP) can be 30+s — pure quiet-timer is fragile |
| **24.3n** | **Permissions UX**: ship at install with `activeTab + storage` only; every adapter declares its host pattern as `optional_host_permissions`, requested at first "Connect" click via `chrome.permissions.request()` | The Chrome warning "Read and change all your data on chatgpt.com…" is a documented install-funnel killer. *Adapters become first-class permission boundaries* |
| **24.3o** | **Tab/thread identity**: ChatGPT URL has no `/c/<id>` until first user turn → wait for `history.replaceState`. Identity = URL + content hash of first user turn (handles cross-profile reconciliation, auto-titling renames). Tombstone on server-side delete; retain local snapshot | Spec underspecified |
| **24.3p** | **"Projects" / "Gems" namespaces** (Claude Projects, ChatGPT Projects, Gemini Gems) sit *above* threads — model `bucket ⟷ project` mapping, don't collapse | Major missing concept |
| **24.3q** | **Provider memory features** (Claude `conversation_search`/`recent_chats` Sept 2025; ChatGPT chat-history reference) — BAC's recall now competes with *and* should integrate with these | Don't pretend providers have no memory; the moat is *cross-provider* |

### 24.4 Reuse map — corrections and additions `[+claude-dr]`

Updates §15 / §22.12 with current 2026 state:

| Need | Earlier pick | New pick | Rationale |
|---|---|---|---|
| Page extraction | Readability.js | **Defuddle** (2025) | Readability is in maintenance mode; Defuddle built for Obsidian Web Clipper, multi-pass, standardized footnotes/code/math, designed for HTML→Markdown |
| HTML→Markdown | (unspecified) | **Turndown.js** (battle-tested) or **dom-to-semantic-markdown** (newer) | Pair with Defuddle |
| Highlight anchoring (S44) | "Mark.js or custom" | **Embed Hypothesis client (BSD-2)** | Production-grade TextQuoteSelector / RangeSelector / CssSelector fallbacks; W3C Web Annotation reference impl. Don't reinvent |
| Local FTS | "MiniSearch or Lunr" | **MiniSearch default + Orama for hybrid + FlexSearch for power**. Borrow **Pagefind sharding pattern** (shard index by bucket × month so cold weeks don't load) | FlexSearch fastest by orders of magnitude with persistent indexes (v0.8); Orama gives FTS+vector but GPL v3+ |
| Local embeddings | "later if worth it" | **transformers.js + MiniLM-L6-v2 (~25 MB) as v1 default**, multilingual-e5-small (~120 MB) for multilingual, EmbeddingGemma-300M Matryoshka-truncatable for quality | HF official Gemma Browser Assistant extension (Nov 2025) is reference impl; SemanticFinder demos 13K-line book in 1–2 min on 2018 i7 |
| Local sync (v2) | "user-configured D1/S3/WebDAV" | **Automerge 2.x** for event log (structured JSON, Rust core via WASM, append-only — perfect fit), **Yjs only if collaborative bucket editing** ships | Automerge 2 is structured-data-first; Yjs is text-first |
| Browser ext scaffold | WXT | **WXT (validated)** — Plasmo in maintenance mode, CRXJS abandoned/stalled | Pick was right |
| Schema | Zod | **Zod (validated)**; switch to Valibot only if bundle size becomes painful | |
| Knowledge graph extraction | (unspecified) | **transformers.js + GLiNER (~50 MB)** for local NER | Powers entity-aware déjà-vu without API calls |
| Native messaging host | (planned for terminal coding agents) | **REPLACE with WebSocket localhost bridge** (Browser MCP / Browserbase pattern: `npx browser-mcp` once) **or MCP server-as-localhost-process** | Native messaging registry-key install is friction-acceptable but not friction-free; authenticity unsolved (registry swap). MCP server unifies with §24.5 |
| Web Speech API for voice (S42) | "browser-native, no API" | **AVOID — Chrome talks to Google's servers, violates no-cloud premise.** Use **whisper.cpp WASM** or **transformers.js Whisper-tiny (~75 MB)** | The privacy promise breaks otherwise |
| Notion adapter | "Notion API" | Notion API + **webhooks** (added 2024–2025; rate-limited 3 req/s/user) | Avoid polling where possible |
| Logseq adapter | (Obsidian-only in §23) | **Add Logseq HTTP API** as second first-party (built-in, similar surface) | Logseq + MCP server (Jan 2026) makes it BAC-friendly out of the box |

### 24.5 MCP — the load-bearing axis the brainstorm missed `[+claude-dr]`

The single largest correction to the spec. As of Nov 2025, MCP is "the USB-C
of AI integrations" with first-class support from Microsoft, Cloudflare,
Vercel, OpenAI, Anthropic. The MCP Apps Extension (SEP-1865, Nov 2025)
standardizes sandboxed-iframe UIs and bidirectional UI↔host messaging.
Codex, Claude Code, Cursor, Windsurf, Gemini CLI, Jan, JetBrains, Kiro all
consume MCP servers.

**BAC should be both MCP host AND MCP server.**

| Role | What it means | Why it matters |
|---|---|---|
| **MCP host** | BAC hosts MCP servers the user adds (filesystem, GitHub, Linear, Sentry, custom). Their tools become dispatchable from the side panel — same UI as chat/notebook dispatch | Side panel becomes a unified action surface across all the user's already-installed servers, not just chat UIs |
| **MCP server** | BAC exposes its event log + recall + notebook adapters as MCP tools/resources to *external* clients (Claude Code, Codex, Cursor, JetBrains, etc.) | The user, while in their terminal, can ask Claude Code "what did I research about WebGPU last March?" — Claude Code calls into BAC's local MCP server to query the event log. Supermemory does this hosted-and-paid; BAC does it local-and-free |

**Adapter contracts adopt MCP shapes**: `NotebookAdapter`, `IssueTrackerAdapter`,
etc. become *MCP servers in spirit* with `tools: [{name, description, parameters: ZodSchema}]` plus `resources` for read-only state. A community adapter
author writes one MCP server and gets *Claude Code, Cursor, Codex, AND BAC*
as clients — much better incentive structure than a BAC-specific contract.

**This is the strategic moat.** Server-side MCP can't reach into the user's
logged-in chat tab. BAC sits *uniquely* in the slot where the user's existing
browser sessions are first-class MCP context. Make that the headline.

### 24.6 New entity types `[+claude-dr]`

Extend §22.3 entity model with capture types the spec missed:

```
ToolUseEvent          // ChatGPT Code Interpreter, function-call args/results, MCP tool invocations
BrowsingEvent         // Provider-side web search results with citations
CodeInterpreterEvent  // Code interpreter output (with images)
ArtifactEvent         // Claude artifacts, ChatGPT canvas (live editable surfaces — not plain assistant turns)
LogEvent              // Console errors mirrored from coding agents for debugging
RecallFeedbackEvent   // User marks "this déjà-vu was relevant / not relevant" — feeds local ranker
ReasoningTraceEvent   // o1, Claude thinking, DeepSeek-R1 raw CoT — capture separately, tag distinct
DegradationEvent      // Adapter fell back to clipboard mode, etc. — auditable telemetry
```

**Provenance fields on every event** (extends §22.3 entity model):

- `author: "user" | "assistant:<provider>:<model>" | "tool:<name>"` — crucial for downstream re-use ("don't quote me on the AI's parts")
- `model: string` — provider+model+variant for reproducibility (Claude lets you change model mid-thread; ChatGPT "Auto" routes opaquely)
- `cid: string` — sha256 content address of any captured snapshot
- `prevHash: string` — append-only Merkle hash chain on event log → cheap tamper-evidence
- `signature: Ed25519` — per-install local key signs each event; future "research bundle" can be verified untampered

### 24.7 Cost / optionality reframe — BYO API key as optional power tier `[+claude-dr]`

The "DON'T BURN TOKENS" pillar is **too dogmatic as stated**. Reality:

- ChatGPT Plus / Claude Pro / Gemini Advanced messages are free at the margin
  *until rate limits kick in* — power users hit those daily.
- Pure API token-pricing is often **cheaper than the subscription** for moderate
  users (~$10/mo Sonnet API vs. $20/mo Pro for many usage profiles).

**Spec amendment** — support **both modes** without changing identity:

- **Default**: zero API keys, leverage logged-in browser sessions (current spec).
- **Optional power tier**: BYO API key per provider, used only for power features
  (long-thread auto-summary S54, local prompt rewrite, embedding generation if
  the user wants higher-quality models, S40 chained-dispatch automation).
- API keys live in `chrome.storage.local`, never synced.

Differentiator: *"the only multi-provider tool where you can choose to not pay
them at all — but still can if you want."* No competitor combines this.

### 24.8 Déjà-vu reframe — calibrated-freshness recall `[+claude-dr]`

Reframe W3 from **"long-term recall"** to **"any-time recall over personal
research log with calibrated freshness"** — 3 days → 3 weeks → 3 months → 3 years.

Why: Memex (WorldBrain) and Heyday both struggled with the long-term-recall
positioning. Empirical evidence: people *want* "everything I've ever read about
X" in the abstract, but actual return-to-10-month-old-note frequency is low for
most users. The killer use is **"you researched this 3 weeks ago in another
context — here's what you concluded"**. High-frequency wins drive engagement;
long-tail hits delight as a secondary.

Cite this as the W3 design center for PRD.

### 24.9 Recall UX — the foot-guns from prior attempts `[+claude-dr]`

Memex / Heyday / Mem.ai cautionary tales — the single biggest UX risk in W3 is
**notification fatigue**. Mitigations to bake in:

| Mitigation | Default |
|---|---|
| Surface only on highlight or explicit query — **never on page-load** | On |
| Per-bucket sensitivity slider | Default `medium` |
| Suppress hits below relevance threshold | Threshold tunable |
| "Snooze déjà-vu for this domain / today / forever" | One-click toast action |
| **Screen-share-safe mode** — auto-detect via `navigator.mediaDevices.getDisplayMedia` permission state and suppress hits, especially from private buckets | Auto-detect on; user can override |
| **Recall-scope tagging**: each bucket has a `private | shared | public` flag; private buckets never surface in screen-share or in cross-bucket discovery | Default `private` |

### 24.10 Critical safety primitives the brainstorm under-specified `[+claude-dr]`

These should be ship-blocking for v1:

- **`RedactionPipeline` primitive**: ships with default deny-list (AWS keys,
  OpenAI keys, GitHub tokens, common SSN/email/phone regex), allow user-defined
  patterns. Runs *before* `Inject`. Without this, BAC is one cross-pollination
  away from leaking the user's API keys into a third-party chat log.
  Sharpens S85.
- **Token budget warnings before paste**: count tokens with `tiktoken-js` (or
  similar); warn if a paste will blow the model's context window. Cheap,
  high-value. New scenario S133.
- **Prompt-injection defense for captured pages**: when injecting captured-page
  content into a chat, wrap it in clear `<context>...</context>` markers, scrub
  known prompt-injection patterns ("ignore previous instructions"), warn at
  large injections. Captured page bodies are *untrusted* (S86 taint label).
- **Cite-this-chat-turn**: produce a markdown footnote like
  `[Claude 4.5 Sonnet, 2026-04-12, conversation excerpt — local archive: bac://event/abc123]` for use in a written document. Optional public share link
  if user opts to share. New scenario S134.

### 24.11 New scenarios S112–S136 `[+claude-dr]`

(Claude DR's report numbered S56–S80 — renumbered to avoid collision.)

| # | Scenario | One-liner |
|---|---|---|
| S112 | **Recall calibration session** | Quarterly prompt: "review 20 random recall hits and mark relevant/not". Updates local ranker, surfaces concept drift. |
| S113 | **Adapter dry-run** | "Test this Notion adapter on a fake bucket" — sandboxed end-to-end run that doesn't write to the real notebook. Critical for debugging adapter changes. |
| S114 | **Selector self-heal canary** | Per §24.3b — DOM canary on every chat-tab load; surface yellow banner + queue diagnostic on failure. |
| S115 | **Slack ↔ Linear ↔ ChatGPT loop** | Slack thread with customer bug → captured to "bugs" bucket → dispatched to ChatGPT for repro hypothesis → resulting outline auto-files as Linear issue draft. |
| S116 | **Figma ↔ Jira ↔ Cursor** | Designer drops Figma frame URL → BAC captures latest exported PNG + frame metadata → user dispatches "implement this" to Cursor with frame + linked Jira ticket as context. |
| S117 | **Google Doc ↔ Gemini ↔ Claude Code** | While editing a doc, highlight paragraph → Gemini grounds edits (one tab) + Claude Code implements code blocks (terminal MCP) → both results dropped back as suggested edits in doc comments. |
| S118 | **Resurrect deleted note from snapshot** | User accidentally deleted a Notion page → BAC has the last snapshot → restore back to Notion (or Obsidian fallback). |
| S119 | **Resurrect forgotten thread from event log** | Provider-side conversation gone → BAC reconstructs transcript locally from captured assistant turns → "open as new thread, pre-pasted". |
| S120 | **Share a bucket** | Generate encrypted single-recipient bundle (libsodium box) over WebRTC handshake. Recipient (also BAC user) imports as guest bucket with read-only or merge semantics. |
| S121 | **Merge two users' buckets** | CRDT-merge two `bucket.json` event logs (Automerge handles natively); duplicates collapsed by content hash. |
| S122 | **Lock bucket for solo focus** | Suppresses all cross-bucket discovery and recall hits — for sensitive client work. Sharpens S47 Pomodoro. |
| S123 | **Read aloud a recalled note** | Local TTS (or device TTS) + Whisper transcripts when listening for reversibly-captured audio. |
| S124 | **Accessibility from day one** | High-contrast / large-text mode, ARIA-correct citation popovers, screen-reader landmarks. Don't retrofit. |
| S125 | **Tab-hover summary in side panel** | Hover a tab in "Where was I?" → 2-line auto-summary from local model — no provider call. |
| S126 | **Graceful-degrade to clipboard mode** | When `Inject` returns "input field not found" or 200ms after `dispatchEvent` no DOM change → switch to clipboard mode: copy prompt, focus input, toast "press Cmd-V then Enter". Records `DegradationEvent`. Sharpens E15. |
| S127 | **200+ open tabs survival mode** | Tab manager shows only tabs with BAC events; "purge irrelevant tabs older than 7 days" one-click. Sharpens S13. |
| S128 | **Stale-recall flag** | Recall hit older than 6 months → "this is from your March 2024 research; underlying source may have changed; check citations" inline marker. Ties to S45 citation drift. |
| S129 | **LLM-hallucinated thread URL detection** | Assistant says "see your earlier thread <URL>" → BAC validates against local registry; if doesn't exist → mark assistant turn with "hallucinated reference" warning. |
| S130 | **Personal prompt grimoire** | Across all dispatches, build a per-user prompt-style profile (length, tone keywords, common preambles). Suggest small-edit improvements. Optional, off by default. |
| S131 | **Better-prompt suggester** | Local model rewrites the user's draft prompt before dispatch (latency-bounded, opt-in). Doesn't burn tokens because local. |
| S132 | **Whiteboard-photo OCR** | Drag photo into side panel → Tesseract.js (or transformers.js TrOCR) → extracted text becomes event in active bucket. |
| S133 | **Token budget warnings** | Before any dispatch, count tokens with tiktoken-js, warn if context window will overflow. Per §24.10. |
| S134 | **Cite-this-chat-turn** | "Cite" button on any chat turn → produces a markdown footnote with attribution + local archive ID + optional public share link. Per §24.10. |
| S135 | **Bucket → slide deck** | Compile bucket events into Reveal.js / Marp markdown deck. Title from bucket name; one slide per starred event. |
| S136 | **Bucket → paper outline / one-pager** | Local-model-driven template lays out claims (S70), evidence (event links), open questions — for "share with non-technical teammate". |

(Plus the voice memo S77, screen recording trail S78, command palette E18 from
Claude DR's §D4 — existing scenarios cover these; cross-reference rather than
re-add.)

### 24.12 Risk register / blind spots `[+claude-dr]`

Cherry-picked from §F:

| # | Risk | Tentative response |
|---|---|---|
| R1 | DOM scraping treadmill: 1–2 selector breaks/provider/quarter, ~15 sprints/year | Treat as production SLA, not side-project. Selector canary (S114), graceful degrade (S126), `fetch` interception primary (24.3a) |
| R2 | TOS interpretation: OpenAI/Anthropic/Google ToU prohibits "automated extraction"; user-installed extension is arguably user-automation but no safe harbor | Mitigations: never auto-pace, explicit per-injection user gesture, scope content scripts to conversation surfaces only, MCP/API path for paid-API users |
| R3 | IndexedDB eviction = total knowledge loss | `navigator.storage.persist()`, OPFS for blobs, encrypted-blob-backup escape valve (24.13) |
| R4 | Notification fatigue (Memex/Heyday cautionary tales) | §24.9 mitigations |
| R5 | Provider memory features (Claude `conversation_search`, ChatGPT chat-history reference) compete with our recall | Position as *cross-provider* — provider memory is per-silo, ours spans them. Optionally *integrate* with provider memory APIs as another adapter |
| R6 | Aggregator UIs (t3.chat, OpenRouter) get cheap+rich enough that "give up provider features" stops mattering → BAC premise weakens | Mitigation: BAC's notebook + recall + buckets work regardless of where the user chats; even an aggregator is just another `ObservedChatAdapter` |
| R7 | Browser AI (Comet, Dia) becomes "the AI surface" | Coexist as extension; even *more useful* inside Comet/Dia where the browser-native AI is one node among many in BAC's graph |
| R8 | Open architecture is a tax — community adapter ecosystem takes years (Zotero ~50 translators in year 1, ~600 over 15 years) | Mitigation: ship MCP-server-as-adapter — community author writes one MCP server, gets Claude Code + Cursor + Codex + BAC clients |
| R9 | Browser monoculture — Chrome ~65% but Safari ~18% can't be ignored | WXT covers Chrome+Firefox+Edge for free; Safari at v1.5 via Xcode wrapper; mobile is separate product (no extension on iOS/Android Chrome) |
| R10 | Plugin-injection from captured page content (adversarial "ignore previous instructions") | `<context>...</context>` markers, scrub known patterns, warn on large injections, taint label (S86) |

### 24.13 Local-first dogma — encrypted backup escape valve `[+claude-dr]`

"Local-first, no cloud" is **too dogmatic** as currently stated. Middle ground:

- **Encrypted local + optional encrypted blob backup** to user-provided storage:
  S3, R2, Dropbox, iCloud Drive, GitHub gist, WebDAV.
- All client-side encrypted with a user-set passphrase (libsodium secretbox).
- BAC server *never* sees plaintext (and BAC operates no server).
- Consistent with "API keys never synced" stance — extends it to event-log
  recovery without requiring BAC to operate cloud infrastructure.

Add as new scenario S137 (cross-listed):

| # | Scenario | One-liner |
|---|---|---|
| S137 | **Encrypted-blob backup to user storage** `[+claude-dr]` | Periodic + on-demand encrypted backup of event log + snapshots to user-configured destination (S3/R2/Dropbox/iCloud/WebDAV/gist). Restore on new device by pasting destination URL + passphrase. Solves device loss without cloud-service dependency. |

### 24.14 Positioning + ICP `[+claude-dr]`

Sharpens §22.2 with priority-ordered ICP and recommended framing.

**ICP (priority order):**

1. **Multi-provider power user** (primary): 5+ AI tabs daily, uses 2–3
   providers in parallel, has Obsidian/Notion. Pays ChatGPT Plus + Claude Pro
   (+ maybe Gemini). Pain: re-explaining context, losing threads, no
   cross-tool memory. **Acquisition: HN, X, dev YouTube, Hugging Face.**
2. **Solo dev + coding-agent user**: Uses Claude Code or Codex daily. Pain:
   moving context between chat and terminal. **Acquisition: Claude Code /
   Codex MCP marketplace, dev.to, Cursor forum.**
3. Researcher / academic / journalist (heavy reading + citation needs;
   Zotero/Hypothesis/Obsidian communities).
4. Knowledge worker / consultant (sharing research with non-tech teammates;
   Notion plugin marketplace, ProductHunt).
5. Small team (premium tier, v2+).

**Recommended framing:**

> **"The switchboard for your AI workflows. Stop re-explaining yourself.
> Stop losing threads. Keep your tokens. Keep your data."**

Lead with three differentiators no single competitor combines:
- Cross-provider thread registry
- Don't-burn-tokens
- Local-first with cross-tool reach

### 24.15 Distribution levers `[+claude-dr]`

- Hugging Face + Plasmo + transformers.js + WXT communities — heavy overlap
  with target audience.
- Open-source on GitHub from day one (Memex, Workona-like).
- Integration story per ecosystem — "BAC for Obsidian", "BAC for Claude Code",
  "BAC for Cursor" microsites; each is a distribution surface.
- **Side-pillar distribution**: become an MCP server people add to Claude Code
  / Cursor / Codex. Each MCP listing in those tools' MCP registries is
  distribution that doesn't depend on Chrome Web Store ranking.

### 24.16 MVP wow — reconciling Claude DR's spine with §22 / §23 spines

Three candidate spines have now been proposed:

| Source | Wow-MVP scenarios |
|---|---|
| **§22.16** (gpt) | S62 dogfood + S78 rehydrate + S74 context pack + S25 highlight dispatch |
| **§23.10** (Obsidian) | + S99 frontmatter + S100 Canvas DAG + S101 Bases dashboard + S104 inbox + S105 open in Obsidian + S108 first-run = 10 |
| **§24.2 takeaway 4** (claude-dr) | S1 Where-was-I + S4 chat-turn-capture-with-provenance + S25 highlight dispatch + S27 déjà-vu (3-week recency) |

**Reconciliation — proposed unified v1 spine** (cross-cuts all three):

| # | Scenario | Source |
|---|---|---|
| S108 | First-run vault wiring (FileSystemAccess; opportunistic plugin detect) | §23.0 + §23 onboarding gate |
| S25 | Highlight → multi-target dispatch | All three converge |
| S27 | Déjà-vu on highlight, **3-week recency by default** | §24 reframe of §4 |
| S1 | "Where was I?" panel — chat threads + active note + active bucket across providers | §24 wow + §22 spine |
| S4 | Capture chat turn → notebook with provenance | §24 wow |
| S104 | Inbox-folder write protocol | §23 default writing posture |
| S99 | Workstream-graph mirrored to vault frontmatter | §23 portability |
| S101 | "Where was I?" rendered as `.base` file in vault | §23 scope simplifier |
| S62 | Dogfood spine: fork → observe → converge → patch | §22 self-test |
| S74 | Context pack export | §22 universal handoff |
| S105 | Open entry in Obsidian via URI | §23 round-trip |
| **+** | RedactionPipeline + token-budget warning + screen-share-safe-mode (§24.10/24.9) | **Ship-blocking for v1** |
| **+** | MCP server exposing event log + recall to coding agents (§24.5) | The strategic moat |

That's ~12 scenarios + ~3 safety primitives + MCP server. Bigger than any
single spine alone but *each piece is small with the Obsidian+MCP delegation*.
Decision-time at PRD: cut ruthlessly from this list, but justify each cut
against the manifesto (§22.15) and the wow-criteria.

### 24.17 What this changes in earlier sections

For PRD-pass cleanup:

- **§3 primitives**: add **MCP-bridge** as the 8th primitive (host + server roles).
- **§8 / §22.9 adapter contracts**: add MCP-shape compatibility — every adapter
  doubles as an MCP server.
- **§9 / §21.6 / §23 storage**: OPFS for blobs (was IndexedDB-only); event log
  gets Merkle hash chain + Ed25519 signing; encrypted backup escape valve.
- **§15 stack**: Defuddle replaces Readability; Hypothesis client replaces
  custom highlighter; transformers.js + MiniLM is v1-default, not v2-maybe.
- **§22.3 entity model**: add `ToolUseEvent`, `BrowsingEvent`,
  `CodeInterpreterEvent`, `ArtifactEvent`, `LogEvent`, `RecallFeedbackEvent`,
  `ReasoningTraceEvent`, `DegradationEvent`. Add provenance fields:
  `author`, `model`, `cid`, `prevHash`, `signature`.
- **§22.11 competitor map**: add Memex (WorldBrain) as closest spiritual
  ancestor of W3 (MIT-licensed; deep-read for UX patterns and pitfalls).
  Add Supermemory as direct W3 competitor (cloud, paid; BAC's local-free
  is the wedge). Add Promnesia from §22.11 already there.
- **§17 open questions**: Q3 (auto-track vs opt-in track) leans **opt-in**
  given §24.10 and §24.9 fatigue mitigations. Q4 (auto-send vs paste-only)
  leans **paste-only default** given §24.3e (`isTrusted`) and §24.10
  redaction-preflight chain. Q7 (embeddings) **answered: local v1 default**.
  Q10 (native messaging host) **answered: replace with WebSocket/MCP**.

### 24.18 Updated "what's next"

- All three external reviews now folded (§22 ChatGPT-Pro, §23 user's Obsidian
  brief, §24 Claude DR).
- User flags any `[+claude]` / `[+gpt]` / `[+claude-dr]` items to keep / cut.
- Build the **scenario-by-scenario feasibility matrix** for S1–S137,
  classifying each by: technical risk, dependency risk, privacy risk,
  best reuse option, and *manifesto-coverage* (which of the 10 §22.15
  points it advances). This is the bridge to PRD scoping.
- Then `PRD.md`, anchored on §22.15 manifesto + §24.16 unified v1 spine.
  Suggested PRD section order: vision → positioning (§24.14) → 10-point
  manifesto → entity model (§22.3 + §24.6) → adapter contracts
  (§22.9 + §23.7 + §24.5 MCP-shape) → primitives (§3 + Relate + MCP) →
  every accepted scenario at e2e fidelity → safety primitives (§24.10
  ship-blocking) → distribution (§24.15) → cuts and parking lot.

---

## 25. Addendum 2026-04-24 evening — prompt corpus as autocomplete + training source

User addition: collect every prompt the user writes; use as autocomplete source;
possibly later as training data. Most of the substrate is already in place
(`PromptRun` entity from §22.3, transformers.js + MiniLM in v1 stack from §24,
Redaction Pipeline from §24.10, event log) — this addendum is mostly new UX
surface + privacy hardening + cold-start strategy.

### 25.1 Reframe — the prompt is a first-class artifact

So far the brainstorm treats the *answer* as the artifact worth saving and the
*prompt* as glue. This inverts: every prompt is a piece of *the user's thinking*,
versioned, reusable, predictable. The corpus of prompts ≈ the user's research
voice over time.

Why this is high-value:
- Repeated patterns become reusable templates without anyone hand-curating them.
- Future prompts auto-improve by leveraging *your own past prompts* — much higher
  relevance ceiling than generic "prompt libraries" (AIPRM and similar).
- "Did I already ask this?" is detectable before dispatch — saves a token spend
  *and* a context-switch.
- Consistency across providers: same prompt phrasing → comparable answers.

### 25.2 Five tiers of escalating sophistication

| Tier | What | Stack | When |
|---|---|---|---|
| **T0** | Log every prompt as `PromptRun` event with bucket + provider + target + response link + outcome (saved? discarded? regenerated?) | Already in §22.3 / §24.6; nothing new | Day 0 — implicit in event log |
| **T1** | Side-panel input has dropdown autocomplete from prompt history. Prefix/keyword match (MiniSearch), bucket-filtered, top 5 with last-used + frequency | MiniSearch over `PromptRun.text` | v1 — trivial |
| **T2** | Semantic similarity over prompt history. Type "review for security" → surface prior prompts about security review even if worded differently | transformers.js + MiniLM-L6-v2 (already v1 default §24.4) | v1.5 — same embeddings model the recall layer uses |
| **T3** | Auto-extract reusable templates. Find repeated structural patterns ("always start with 'You are an expert in {domain}…' followed by '{task}' followed by '{constraints}'") → propose as named templates with `${variable}` slots | n-gram clustering + simple template induction | v2 |
| **T4** | Local fine-tune of a small LM on personal prompts. Distilled-Llama / Phi-3-mini in WebLLM or transformers.js, trained on your `PromptRun` corpus via LoRA. Predicts your *next* token in the input box | WebLLM + LoRA training script (offscreen / native) | v3 — speculative; opt-in heavy |

**My recommendation**: T1 + T2 cover ~90% of the value with stack pieces already
in v1. T3 is the natural extension. T4 is interesting but the marginal value
over T2 is unclear and the privacy/compute cost is real.

### 25.3 Privacy posture — the prompt corpus is THE most sensitive corpus

A user's prompt history captures: what they don't know, what they're working on,
what they're worried about, who they're talking to, code they're stuck on,
companies they're researching, health questions they typed at 2 AM. This is
**more sensitive than the conversations themselves** — the questions you ask
reveal more than the answers you receive.

Hardening requirements (ship-blocking for any tier above T0):

| # | Requirement | Why |
|---|---|---|
| P1 | **`RedactionPipeline` (§24.10) runs before `PromptRun` storage**, not just before Inject | Defense in depth — even local corpus shouldn't contain raw API keys. If the local IndexedDB ever leaks, no plaintext secrets |
| P2 | **Per-bucket opt-out for prompt capture** | Sensitive client work / private therapy-style brainstorming can disable corpus participation entirely |
| P3 | **`forget()` cascade applies to prompts** (§24, D3) | Selective deletion of individual prompts, topic-wide deletion, full-bucket purge |
| P4 | **Prompt corpus excluded from cross-user / shared-bucket exports by default** (S120) | Even when sharing a bucket, prompts stay yours |
| P5 | **Prompt corpus excluded from encrypted backup S137 by default**, with explicit opt-in per bucket | The escape valve shouldn't auto-cloud the most sensitive thing |
| P6 | **No federated learning, no anonymized telemetry of prompts, ever, without explicit per-prompt consent** | Closes off a foreseeable bad future where "anonymous prompt aggregation" becomes a revenue line |
| P7 | **Audit ledger entry per autocomplete suggestion** (§22 / S88) — user can inspect "today the autocomplete suggested X based on prior prompts Y, Z" | Same audit standard as the rest of the adapter ledger |
| P8 | **Autocomplete suppressed in screen-share-safe mode** (§24.9) | Same logic as déjà-vu — don't reveal your prompt history on a Zoom call |
| P9 | **Local-only training (T4)** if it ever ships — model weights and gradients never leave the device; no aggregation server | Same privacy contract as recall embeddings |

If any of these can't be met, the corresponding tier doesn't ship.

### 25.4 New scenarios S138–S151

| # | Scenario | One-liner |
|---|---|---|
| S138 | **Prompt history capture (T0)** | Every dispatch records a `PromptRun` event with: prompt text (post-redaction), bucket, provider, target thread, dispatched-at, response artifact link, outcome (saved / discarded / regenerated). Already implicit; make explicit + surface in UI. |
| S139 | **In-input autocomplete (T1) `[+claude]`** | Side-panel dispatch input shows top-K prior prompts as dropdown. Bucket-filtered. Keyboard-driven (↑↓, Tab to accept, Esc to dismiss). |
| S140 | **Snippet expansion `[+claude]`** | TextBlaze-style: type `;rev<Tab>` → expands to your standard review-prompt template. Templates from auto-extraction (T3) or hand-curated. |
| S141 | **Semantic prompt similarity (T2) `[+claude]`** | "You wrote a very similar prompt 3 days ago — see prior answer?" — uses MiniLM embedding distance over prompt history, threshold-tunable. Pre-dispatch déjà-vu *for prompts*, not topics. Saves a re-dispatch. |
| S142 | **Successful-prompt boost `[+claude]`** | Prompts that led to a *saved* answer (S4) or a *decision* (S69) get higher weight in autocomplete ranking. Failure-debias by signal, not by feel. |
| S143 | **Failed-prompt deboost `[+claude]`** | Prompts immediately re-asked or regenerated within N seconds → low-quality signal → autocomplete suppresses. |
| S144 | **Auto-extract reusable templates (T3) `[+claude]`** | Background job clusters PromptRuns by structural similarity; proposes named templates with `${variable}` slots. User accepts / edits / dismisses. Removes the burden of hand-curating S35 prompt library. |
| S145 | **Cross-provider prompt-portability `[+claude]`** | A prompt that worked well on Claude — when user dispatches to ChatGPT, side panel suggests the Claude-tested version with attribution: "this version got a saved answer 4× on Claude". Treats prompts as portable assets, not provider-specific. |
| S146 | **Prompt-template version history per bucket `[+claude]`** | Same template iterated over time → see which version produced the best outcomes. Build the dataset for picking your "best" version of a recurring prompt. |
| S147 | **Per-bucket prompt-style profile (sharpens S130 grimoire) `[+claude]`** | Aggregate length, tone keywords, common preambles per bucket. Surface as a one-page "your prompt voice in `wip/auth-redesign`" — and as defaults for new prompts in that bucket. |
| S148 | **Prompt-intent classifier `[+claude]`** | Local classifier (small zero-shot or trained) tags each prompt as `research / debug / code / refactor / brainstorm / verify / summarize`. Dashboard: "your prompt-mix this week was 60% debug, 25% research, 15% verify" — useful self-awareness. |
| S149 | **Local fine-tune on personal prompts (T4 — speculative) `[+claude]`** | Off-by-default. WebLLM or transformers.js training; LoRA on a small base (Phi-3-mini / TinyLlama). Output: a personal next-token model used as ghost-text completer in the input box. Stays on device. |
| S150 | **Cold-start prompt seed library `[+claude]`** | First-run: ship a curated bundle of "best general prompts" by category (research, code review, summarization, debugging, brainstorming). User opts which categories load into their bucket templates. Solves the "no autocomplete history yet" problem. |
| S151 | **Import prompts from existing sources `[+claude]`** | Onboarding: import from ChatGPT-history export (`conversations.json`), Claude-export, AIPRM library, plain markdown snippets folder. Each imported prompt seeds the corpus tagged with provenance (`imported:chatgpt-history@2026-04-24`). |

### 25.5 Cold-start strategy

The corpus is empty on day 1; autocomplete is useless without history.
Three combined moves:

1. **Seed library (S150)** — curated by bucket type, opt-in.
2. **Import (S151)** — bring prompts you've already written elsewhere.
3. **Aggressive use of T0 (S138)** from the very first dispatch — even week-1
   users have *some* corpus by week 2. Surface the autocomplete affordance
   immediately so users feel the curve.

### 25.6 What this changes / connects to in earlier sections

For PRD-pass cleanup:

- **§22.3 entity model — sharpen `PromptRun`**:
  ```
  PromptRun {
    id, text (post-redaction), bucket, provider, threadId, model,
    dispatchedAt, contextPackId?,
    responseArtifactId?, outcome: "saved" | "discarded" | "regenerated" | "no-action",
    intent?: "research" | "debug" | ... (S148),
    templateId?: string (S140 / S144),
    portedFrom?: { provider, promptRunId } (S145),
  }
  ```
- **§24.6 author/model fields** apply (each PromptRun has the user's `author` field — useful for telling the corpus "this came from me, not from auto-extraction").
- **§24.10 RedactionPipeline** runs *before* PromptRun storage, not just before Inject. P1 above.
- **§24.9 screen-share-safe mode** suppresses autocomplete dropdowns. P8.
- **§24 audit ledger (S88)** records every autocomplete suggestion. P7.
- **§22 S35 / S36 prompt library** subsumed: hand-curated templates are a
  special case of auto-extracted templates (S144) — hand-curated ones just
  skip the extraction step.
- **§24 S130 personal prompt grimoire / S131 better-prompt suggester** depend
  on this corpus as their data layer — without S138–S147, S130 has nothing
  to analyze and S131 has no style to imitate.

### 25.7 Trim recommendations for v1

If trimming, keep:

- **S138** PromptRun capture (T0) — substrate, free
- **S139** in-input autocomplete (T1) — high-value, low-cost
- **S141** semantic prompt similarity (T2) — uses already-loaded MiniLM
- **S150** cold-start seed library — onboarding gate

Defer:
- S140 snippet expansion (nice-to-have polish)
- S142–S143 ranking refinements (need real corpus data to tune)
- S144 template auto-extraction (v2)
- S145 cross-provider portability (v2)
- S146–S148 dashboards and intent classifier (v2)
- **S149 local fine-tune (T4) explicitly v3+ if ever** — cost/benefit unclear vs. T2
- S151 import (v1.5 onboarding polish)

### 25.8 Updated unified v1 spine

§24.16 spine + S138 + S139 + S150 (the four-scenario prompt-corpus core).
S141 piggybacks on the embedding model already loaded for déjà-vu, so it
arrives "for free" once recall is in.

---

## 26. Addendum (2026-04-25): PoC plan after PoC-1/2 — `[+gpt-poc]`

> **User decision 2026-04-25** (superseded 2026-04-26 — see banner below):
> §24 anchors stand for v1 (Local REST API plugin is the primary integration
> tier; v1 requires user installs it; "track + auto-suggest" stance from §24
> also stands). §26's architectural deltas (filesystem-write-first adapter,
> "track + organize, suggest later", Obsidian-absent degraded mode) are
> **PoC-scope only** — useful framing for deciding the next PoC, not a v1
> product anchor. When PRD is drafted, work from §24 anchors, not from §26
> deltas.
>
> **Update 2026-04-26 (user correction)**: the "Local REST API plugin is the
> primary integration tier; v1 requires user installs it" half of the prior
> decision is **retracted**. New principle in §23.0: Obsidian is first-class
> citizen, but BAC operates on **interfaces and core only** — filesystem,
> Markdown, frontmatter, `.canvas`, `.base`, `_BAC/`. Plugins are opt-in
> acceleration, never required. As a consequence, §26.7's "filesystem-write-
> first adapter" delta is **promoted to a v1 anchor**, no longer PoC-only.
> The other §26 deltas ("track + organize, suggest later"; "Obsidian-absent
> degraded mode") remain PoC-scope framing — those are product-positioning
> bets, not interface principles, and stay open for PRD.

The user has now run two PoCs (`poc/dogfood-loop` and `poc/provider-capture`)
plus added three import documents in `imports/` (the deep-research competitive
report, the compass-artifact decision-ready MVP synthesis, and the BAC design
spec). A subsequent discussion with ChatGPT proposed **two alternative PoC
strategies** for what to build next. This section folds that discussion in
with the same exhaustive-first discipline.

Audit-trail marker: **`[+gpt-poc]`** = items originating in the ChatGPT
PoC-planning discussion attached on 2026-04-25.

### 26.1 Where we actually are (verified against `pocs/` READMEs, 2026-04-25)

| PoC | Proven | Explicitly NOT proven |
|---|---|---|
| **`poc/dogfood-loop`** | Local-first loop: note → fork to mock targets → prompt injection into fixture pages → completion observation → IndexedDB artifacts → converge view (`Use A` / `Use B` / `Append both`) → deterministic markdown patch → persisted note. Plus: Google/DuckDuckGo navigation-only fork, active-tab adoption, fixture ChatGPT/Claude/Gemini thread registry, **Obsidian-shaped vault projection** (`_BAC/events/*.jsonl`, `_BAC/workstreams/current.md`, `_BAC/where-was-i.base`), portable Context Pack generation, **read-only in-process MCP-core JSON-RPC smoke** (`bac.recent_threads`, `bac.workstream`, `bac.context_pack`), lexical déjà-vu recall spike, dispatch preflight, Vitest + Playwright extension e2e. | Real provider DOM stability; provider login flows / anti-automation; search result extraction; **real Obsidian Local REST API integration**; **real MCP server transport / process lifetime / native helper packaging**; vector recall (PGlite / pgvector / transformers.js); cloud sync; production security review. |
| **`poc/provider-capture`** | Provider detection (ChatGPT, Claude, Gemini, fixtures); visible-content extraction with provider-aware selectors + conservative fallback; `chrome.storage.local` persistence; side panel preview with selector-canary status, warnings, per-turn source labels; fixture-driven Vitest unit tests + Playwright extension e2e. **Live**: ChatGPT shared/canvas capture; **Gemini signed-in conversation capture (15 turns / 23,570 chars after extractor patch — up from 7 turns / 664 chars on first pass)**. | Long-term provider DOM stability; **real ChatGPT loaded conversation-thread assistant-turn capture (only shared/canvas live so far)**; **Claude logged-in live capture (deferred pending login)**; prompt injection / response automation; cloud sync; end-to-end local encryption; production security review. |

The shape of the next PoC therefore should not re-prove side panel, capture,
local graph, Context Pack, or fake MCP. Those are seeded.

The biggest verified gaps are:

1. **Real Obsidian write path** (filesystem and/or Local REST API).
2. **Real MCP server transport** (something more than in-process JSON-RPC).
3. **Extension ↔ local daemon bridge** (process boundary that survives MV3 service-worker death).
4. **Native/helper packaging** (installer, lifetime, security boundary).
5. **Real Claude live capture** (and a fully proven ChatGPT *conversation-thread* live pass).
6. **User-driven organization model** (project/topic/tag/link assignment, not auto-organize).
7. **Obsidian-native rendering surfaces actually in use** (Graph/Canvas/Bases as the dashboard tier).

### 26.2 PoC philosophy refinement `[+gpt-poc]`

The discussion sharpened what a PoC should mean for this product:

> A PoC should not mean "build every layer." It should mean: where there are
> 2–4 plausible architectures, build the **thinnest experiment that tells us
> which branch to commit to**. Plan PoCs to validate the most valuable / risky
> areas, and avoid overlap with prior PoCs.

This is a useful constraint when picking PoC #3 — "where do 2–4 plausible
architectures still exist?" is a sharper question than "what's missing?"

### 26.3 Sharpened product thesis: Obsidian-native, not Obsidian-dependent `[+gpt-poc]`

A directional pivot from §23's "Obsidian is canonical":

> **BAC should be Obsidian-native when Obsidian is available, but not
> Obsidian-dependent for survival.**

That means actively use Obsidian's top-level concepts — **Links, Graph,
Canvas, Bases, Properties, Tags, folders, backlinks** — rather than treating
the vault as a Markdown export folder. Obsidian's own product positioning
emphasizes local/private notes, open file formats, Links, Graph, Canvas,
plugins, and "your knowledge should last," which maps cleanly onto BAC's
local-first browser-memory ledger framing.

The hierarchy this implies:

```text
Browser captures what happened.
User organizes what matters.
Obsidian renders the knowledge system.
BAC turns that system into reusable AI context.
MCP exposes it to coding agents.
```

(Explicit anti-pattern: "BAC auto-organizes everything. Obsidian is just an
export. MCP is generic browser automation." That framing is rejected.)

### 26.3.1 What BAC should own vs. what Obsidian should own when present

| Layer | BAC should own | Obsidian should own when available |
|---|---|---|
| Browser observation | Tracked AI chats, source URLs, capture events, thread state | — |
| User organization | Project/topic assignment, move in/out, promote to note, tags, links | Reflect and enrich through files, folders, links, tags |
| Durable artifacts | Stable IDs, source provenance, context-pack boundaries | Markdown files, properties, backlinks, graph, bases, canvas |
| Visualization | Minimal side panel, recent/ungrouped, actions | Graph View, Canvas, Bases dashboards |
| Context reuse | Context-pack generator, MCP tools, retrieval policies | Obsidian note graph as the human-editable source |
| Integrations | Adapter contracts | Obsidian as first and richest adapter |

Obsidian-without-Obsidian fallback: **BAC must still function in a degraded
"local-only ledger" mode** for users who have not installed Obsidian.
Frontmatter-mirror writes become an export step rather than a continuous
projection; Bases dashboards become Markdown tables.

### 26.4 Two PoC paths on the table `[+gpt-poc]`

Two distinct proposals from the discussion. Both are captured exhaustively;
the user will decide.

| | Path A — three balanced PoCs | Path B — single `poc/local-bridge` |
|---|---|---|
| **Aim** | Validate three architectural branches in turn (organization, surfaces, MCP/context) | Close the largest single gap (extension → daemon → real Obsidian → real MCP) |
| **PoCs proposed** | 3 | 1 |
| **Risk** | Sequential; longer to first end-to-end demo; some overlap with PoC-1/2 surfaces | Concentrated; one big PoC to land; less direct exercise of user-organization model |
| **Best for** | Testing UX/PKM hypotheses (does Obsidian-native organization actually feel right?) | Testing technical-substrate hypotheses (does the daemon/MCP/Obsidian bridge actually hold up?) |
| **Where they overlap** | Path A's PoC 3 ≈ Path B's MCP + context-pack slice. Path B's daemon assumes some user organization exists; Path A's PoCs 1+2 build that organization. |

These are not mutually exclusive — a hybrid would do **Path B as a substrate
PoC** then **Path A's PoC 1 layered on top of the daemon**. That's noted but
not pre-decided.

### 26.5 Path A in detail — three balanced PoCs `[+gpt-poc]`

#### 26.5.1 PoC 1 — Obsidian-native user organization

**Core question.** Can BAC turn passively tracked browser AI work into an
Obsidian-native project/topic system that users reorganize manually?

**Validates the principle:**

```text
Track by default.
User organizes actively.
Suggestions come later.
```

(This is a meaningful sharpening: prior anchors leaned toward auto-extraction
and auto-suggestion. This PoC tests the human-in-the-loop-first variant.)

**Competing approaches (the architectural fork this PoC resolves):**

| Approach | What it means | Risk |
|---|---|---|
| BAC-only organizer | Keep all organization in BAC UI; Obsidian is export only | Misses Obsidian's native power |
| Folder-first | Project/topic hierarchy maps directly to folders | Simple, can become rigid |
| Link/tag-first | Flat notes; organization comes from tags + wikilinks | Flexible, can feel messy |
| **Hybrid Obsidian-native** | Folders for projects/topics, properties for metadata, tags for virtual grouping, links for graph | Best balance |

**Thin build.** Reuse captures/threads from PoC-1/2. Add minimal user actions:

```text
Add chat to project
Move chat to topic
Create subtopic
Remove from topic
Add tags
Create link to another item
Promote capture to note / decision / source
```

**Example user vault structure:**

```text
SwitchBoard/
  Planning/
    MVP Scope.md
    Market Validation.md
  High Level Design/
    Browser-owned MCP.md
    Obsidian Projection.md
  Security/
    Redaction Boundary.md
    MCP Permissions.md
  Payment/
    Pricing Questions.md
_BAC/
  dashboards/
    where-was-i.base
    switchboard.base
  context-packs/
    switchboard-hld.md
```

**Note shape (Obsidian-native frontmatter):**

```md
---
bac_id: thread_01HT...
bac_type: thread
project: SwitchBoard
topic:
  - High Level Design
  - Browser-owned MCP
provider: claude
source_url: ...
status: tracked
tags:
  - switchboard
  - mcp
  - obsidian
  - architecture
related:
  - "[[Obsidian Projection]]"
  - "[[Security/Redaction Boundary]]"
---

# Claude — Browser-owned MCP discussion

## Source
Original thread: ...

## Notes
...

## Related
- [[Obsidian Projection]]
- [[Security/Redaction Boundary]]
```

**Critical invariant:** BAC tracks by `bac_id` in frontmatter, **not by file
path**. Users can reorganize folders freely without breaking BAC state.

**Pass criterion.** A tracked chat moves from "recent/unorganized" → into a
user-owned project/topic/tag/link structure → without losing source identity
or context-pack eligibility.

**Failure pivots:**

| Failure | Pivot |
|---|---|
| Folder hierarchy feels too rigid | Keep folders shallow (project/topic only); use tags/links for nuance |
| Tags feel too loose | Require one primary project/topic for "organized" items |
| Moving files breaks BAC state | Track by `bac_id` (already the design — re-confirm) |
| Users want Obsidian-first editing | Read frontmatter/links back into BAC |
| Users dislike file clutter | Store raw captures under `_BAC/items`; expose organized views via Bases |

#### 26.5.2 PoC 2 — Links / Graph / Canvas / Bases as first-class surfaces

**Core question.** Can BAC offload major MVP surfaces to Obsidian's native
concepts instead of building custom UI?

This is the PoC that **directly tests §23's bet** that Canvas + Bases can
serve as the dashboard tier instead of building dashboards in the side panel.

**Competing approaches:**

| Approach | What it means | Risk |
|---|---|---|
| BAC custom graph | Build our own graph/mind-map UI | Expensive, duplicates Obsidian |
| Links-only | Generate internal links, rely on Graph View | Lightweight, less curated |
| Canvas-first | Generate `.canvas` maps for projects/topics | Visual, may be too manual |
| Bases-first | Generate dashboards for workstreams, captures, decisions | Great for lists/status, weaker for relationships |
| **Hybrid Obsidian surface** | Links→Graph; Canvas→visual map; Bases→dashboard | Best MVP leverage |

**Thin build.** From one project (e.g. `SwitchBoard`) generate:

```text
1. Notes with internal links     → Graph View
2. Project Canvas                → mind map
3. Bases dashboards              → Where Was I, threads, decisions, OQs
4. Backlinks                     → reverse navigation, free
```

**Required behaviors:**

- **Links** — explicit `## Related` wikilink sections so Graph View and
  Backlinks "just work".
- **Graph** — do NOT build a custom BAC graph yet; inspect whether Obsidian's
  Graph View gives enough value with the link density BAC writes.
- **Canvas** — generate one project map per active project, with groups for
  Planning / HLD / Security / etc., each containing chat, promoted notes,
  decisions, OQs.
- **Bases** — generate `where-was-i.base`, `switchboard-threads.base`,
  `switchboard-decisions.base`, `switchboard-open-questions.base`.

**Pass criterion.** BAC-generated Obsidian artifacts feel native enough that
users continue organizing inside Obsidian (rather than retreating to side
panel for everything).

**Failure pivots:**

| Failure | Pivot |
|---|---|
| Graph View too noisy | Generate fewer links; distinguish `explicit`, `suggested`, `source`, `related` link kinds |
| Canvas too hard to maintain | Generate Canvas only for promoted topics, not every capture |
| Bases syntax brittle | Generate Markdown dashboards first; `.base` as optional enhancement (matches §24.3 "treat Bases as bonus delight, not core dependency") |
| Users edit Obsidian, BAC misses changes | Add read-back scan for frontmatter, links, file moves |
| Obsidian-native surfaces insufficient | Build minimal BAC "map" view later — only after validating need |

#### 26.5.3 PoC 3 — Organization-aware Context Pack and browser-owned MCP

**Core question.** Can the user's Obsidian-native organization drive useful
AI context?

This is the bridge from KM to AI utility. The discussion calls out:

```text
organized browser AI work
  → Obsidian-native graph
  → reusable context pack
  → coding agent
```

Critically, this is **not** "generic browser MCP" — the differentiator is
that the user's organization (project/topic/tag/link/Canvas group) drives
context selection.

**Competing approaches:**

| Approach | How context is selected | Risk |
|---|---|---|
| Folder/path-based | Use project/topic folder path | Simple, brittle after reorganization |
| Tag-based | Use tags like `#mcp`, `#security` | Flexible, noisy |
| Link-neighborhood-based | Use Obsidian links/backlinks around a note | Powerful, depends on link quality |
| Canvas-based | Use nodes in selected Canvas group | Great for visual planning, not always used |
| **Hybrid organization-aware** | Project/topic + tags + links + optional Canvas group | Best fit |

**Thin build.** One MCP tool + one side-panel action:

```ts
bac.context_pack({
  project: "SwitchBoard",
  topic: ["High Level Design", "Browser-owned MCP"],
  includeTags: ["obsidian", "architecture"],
  includeLinkedDepth: 1,
  includeCanvas: "_BAC/canvases/switchboard-map.canvas"
})
```

**Returned pack (Markdown):**

```md
# Context Pack: SwitchBoard / High Level Design / Browser-owned MCP

## Goal
...

## Active decisions
- [[Security/Redaction Boundary]]
- [[High Level Design/Obsidian Projection]]

## Relevant threads
...

## Sources
...

## Open questions
...

## Related graph neighborhood
...
```

**Pass criterion.** A user-created project/topic/link/tag/Canvas structure
can drive a useful MCP context for a coding agent — context comes from
**user organization**, not random full-text search.

**Failure pivots:**

| Failure | Pivot |
|---|---|
| Pack too noisy | Include only promoted artifacts (decisions, notes, sources, OQs) |
| Folder/topic context misses items | Add link-neighborhood expansion |
| Tags create noise | Use tags as filters only, not expansion |
| Link graph sparse | Add "suggested links" but require user confirmation |
| Canvas context inconsistent | Treat Canvas as optional curated context, not primary index |
| MCP setup too high friction | Ship context-pack export first; MCP as advanced/dev-user mode |

#### 26.5.4 How the three PoCs fit together

```text
PoC 1: User organizes browser AI work
        ↓
PoC 2: Obsidian renders it as links / graph / canvas / bases
        ↓
PoC 3: BAC turns that organization into context packs / MCP
```

#### 26.5.5 Path A explicit deferrals

| Deferred | Reason |
|---|---|
| Auto-organization | The whole point is to test manual-first |
| Auto-send into AI providers | Provider automation risk; not needed for this validation |
| Generic browser-control MCP | Different product; not BAC's wedge |
| Full custom graph UI inside BAC | Tested by PoC 2's Graph View dependency |
| Custom Obsidian plugin | Local REST API + filesystem cover MVP |
| Production security hardening | Bigger scope than PoC validation |
| Full vector database | Lexical déjà-vu from PoC-1 is enough for this validation |
| Team collaboration | Single-user local trust boundary first |
| Payment / billing | Not load-bearing for any of the architectural questions |

Keep minimal guardrails: local-only, read-only MCP tools, bounded context
output, basic redaction smoke test, stable IDs in frontmatter.

### 26.6 Path B in detail — single `poc/local-bridge` PoC `[+gpt-poc]`

**One-line goal.** Build the missing local bridge that turns existing
browser-side captures/workstream state into:

```text
real Obsidian writes + real MCP server transport + local trust boundary
```

**Why this is the right "next hardest part".** The capability matrix already
seeded in PoC-1/2 is:

| Capability | Status |
|---|---|
| MV3 side panel | Proven (PoC-1) |
| Background coordinator | Proven (PoC-1) |
| Provider visible capture | Mostly proven (PoC-2; ChatGPT thread + Claude live still pending) |
| Local graph/event model | Proven (PoC-1) |
| Context Pack generation | Proven (PoC-1) |
| Obsidian-shaped projection | Proven as files only (PoC-1; not real Obsidian writes) |
| In-process MCP JSON-RPC core | Proven as smoke (PoC-1; not real transport) |
| **Real Obsidian write path** | **Not proven** |
| **Real MCP server transport** | **Not proven** |
| **Extension ↔ local daemon bridge** | **Not proven** |
| **Native/helper packaging** | **Not proven** |
| **Security boundary** | **Not proven** |

#### 26.6.1 Architecture `[+gpt-poc]`

> Do **not** put the real MCP server inside the Chrome extension. Keep the
> extension as the browser sensor/UI, and add a local companion process.

(This aligns with §24's pivot away from native-messaging toward a localhost
WebSocket / MCP-server-as-process pattern. It also aligns with `mcp-chrome` /
`real-browser-mcp` precedents.)

```text
┌───────────────────────────────────────┐    ┌──────────────────────────────────────────┐
│  Chrome MV3 extension                 │    │  poc/local-bridge daemon (Node 22+)      │
│                                       │    │                                          │
│  provider-capture (visible capture)   │    │  localhost HTTP API (127.0.0.1 only)     │
│  dogfood-loop (workstream graph)      │ →  │  SQLite event store (FTS optional)       │
│  side panel                           │    │  Obsidian adapter (REST + filesystem)    │
│  background coordinator               │    │  real MCP server (stdio first)           │
└───────────────────────────────────────┘    └──────────────────────────────────────────┘
                                                       │                  │
                                                       ↓                  ↓
                                         ┌─────────────────────┐  ┌──────────────────────┐
                                         │  Obsidian vault     │  │  MCP clients         │
                                         │  _BAC/workstreams/  │  │  Claude Code         │
                                         │  _BAC/where-was-i.  │  │  Cursor              │
                                         │  base               │  │  Codex CLI           │
                                         │  _BAC/events/*.     │  │                      │
                                         │  jsonl              │  │                      │
                                         └─────────────────────┘  └──────────────────────┘
```

**Stack:** Node.js 22+, TypeScript, Hono or Fastify, `better-sqlite3`,
`@modelcontextprotocol/sdk`, Zod, Vitest, Playwright e2e harness reused from
existing PoCs.

#### 26.6.2 Scope (in/out) `[+gpt-poc]`

**In scope:**

- `poc/local-bridge/daemon/src/{server,mcpServer,obsidianAdapter,eventStore,schema,security}.ts`
- Extension bridge client (`POST /v1/captures`, `POST /v1/events`, `GET
  /v1/health`, `GET /v1/context-pack/current`)
- Obsidian adapter with **two write modes behind one interface**:
  1. Direct filesystem write to configured vault path (deterministic e2e)
  2. Obsidian Local REST API (more realistic)
- Real MCP server promoting the in-process JSON-RPC core to a real
  `@modelcontextprotocol/sdk` stdio server
- Initial tools: `bac.recent_threads`, `bac.workstream`, `bac.context_pack`,
  `bac.search`, `bac.get_capture`
- Security: bind to `127.0.0.1` only; random local API key generated on
  first daemon startup; reject requests without token; reject non-local
  origins; read-only MCP by default; redaction pass before Obsidian writes;
  audit every bridge write as an event

**Out of scope:**

| Not in scope | Reason |
|---|---|
| Real provider auto-send | Provider automation risk |
| Full refactor of PoC-1/2 | Too much churn |
| Vector embeddings | Lexical déjà-vu enough for this validation |
| Cloud sync | Violates local-first PoC clarity |
| Native installer | Later; first prove daemon contract |
| Production Obsidian plugin | Local REST + filesystem adapter first |
| Team / multi-user mode | Single-user local trust boundary first |

#### 26.6.3 Acceptance demo `[+gpt-poc]`

```text
1. Start local-bridge daemon
2. Load provider-capture extension
3. Open a Gemini / fixture provider tab
4. Click "Capture active tab"
5. Capture stored locally in extension AND sent to daemon
6. Daemon writes:
   - _BAC/events/YYYY-MM-DD.jsonl
   - _BAC/workstreams/current.md
   - _BAC/where-was-i.base
7. MCP client calls bac.context_pack
8. Returns Markdown containing captured provider content + source metadata
```

#### 26.6.4 Test plan `[+gpt-poc]`

**Unit:** schema (provider capture → normalized WorkstreamEvent), eventStore
(append/list/search), obsidianAdapter (writes to temp vault), contextPack
(includes captures from daemon store), mcpServer (`tools/list` +
`tools/call`), security (rejects missing/invalid token).

**Extension e2e** (reuse Playwright harness): fixture provider tab → capture
active tab → daemon receives capture → temp Obsidian vault has Markdown
projection → MCP smoke returns context pack.

**Manual live validation:** Gemini (capture real signed-in conversation
and write to Obsidian); ChatGPT (one normal loaded conversation-thread
pass — also closes the gap from PoC-2); Claude (one logged-in capture pass
— also closes the gap from PoC-2).

### 26.7 Architectural deltas vs. prior anchors `[+gpt-poc]`

Folding-in surfaces several refinements (not yet user-confirmed):

| Prior anchor (where) | Refinement from this discussion | Tension? |
|---|---|---|
| §24 — "Local REST API plugin is the primary integration tier; v1 requires user installs it" | "Direct filesystem write to configured vault path" *first* for deterministic e2e tests; Local REST API *behind same interface*; first-run wizard with filesystem-only fallback if user declines plugin | **Resolved 2026-04-26**: §24 stance retracted in favor of §23.0 (filesystem + interfaces & core; plugin opt-in). This delta is now the v1 anchor. |
| §24 — "MCP-server-as-process REPLACES native messaging" | Same direction; sharpens with concrete daemon shape (Node + Hono/Fastify + SQLite + `@modelcontextprotocol/sdk` stdio) | No — same direction, sharper recipe |
| §23 — "Obsidian is canonical" | "Obsidian-native when available, but not Obsidian-dependent for survival" | **Mild** — softens to allow degraded local-only mode for non-Obsidian users |
| §24 product framing — auto-extract, auto-suggest, auto-organize lean | "Track by default. User organizes actively. Suggestions come later." | **Yes** — meaningful sharpening; trades some wow-moments for trust/control. Consider as ICP-driven choice. |
| §24 unified spine includes calibrated-freshness recall (W3) | Path A defers automation/suggestion entirely until manual organization is validated | **Yes** — déjà-vu surfaces *are* a form of suggestion. Reconcile by treating recall-at-highlight as "user-initiated suggestion" (not auto). |
| §22.3 Workstream Graph entities | Sharpens with concrete Obsidian-native frontmatter shape (`bac_id`, `bac_type`, `project`, `topic`, `tags`, `related`) and the **track-by-`bac_id`-not-path invariant** | No — concretizes prior abstraction |
| §24 default-on safety | "Read-only MCP tools by default; write tools only behind explicit user opt-in"; redaction before Obsidian writes (not just before Inject) | No — extends prior safety primitives consistently |

### 26.8 New scenarios this PoC discussion surfaces

| # | Scenario | Notes |
|---|---|---|
| **S152** | **Track-then-organize loop `[+gpt-poc]`** | Capture/track a chat with no project assignment; user later opens BAC, drags it into `SwitchBoard / High Level Design / Browser-owned MCP`. BAC writes a frontmatter-mirror file, no folder structure changes from BAC's side until the user does it. Suggestions deliberately deferred. |
| **S153** | **Promote capture to typed artifact `[+gpt-poc]`** | One-click "Promote → Note / Decision / Source / Open Question" from the side panel. Each typed artifact gets the appropriate `bac_type` frontmatter and lands in the right vault location. |
| **S154** | **`bac_id`-stable identity across reorganization `[+gpt-poc]`** | User renames `High Level Design/Browser-owned MCP.md` to `Architecture/MCP server architecture.md`; BAC continues to track it correctly because identity is `bac_id`-keyed in frontmatter, not path-keyed. Test: rename + move + edit + restart, BAC still recognizes the file. |
| **S155** | **Obsidian-native Properties + wikilinks frontmatter mirror `[+gpt-poc]`** | Sharpens the §23 frontmatter spec with explicit Properties (date, boolean, list) + wikilink `related` arrays. Internal links use wikilink syntax so Backlinks plugin works without extra config. |
| **S156** | **Generated `.canvas` per active project `[+gpt-poc]`** | Project map: SwitchBoard root → Planning/HLD/Security/Payment groups; each group contains key chats, promoted notes, decisions, OQs. Regenerated from event log on workstream-graph change; not user-round-tripped. |
| **S157** | **Generated `.base` dashboards: where-was-i + threads + decisions + OQs `[+gpt-poc]`** | Concrete Bases targets per project. Markdown-table fallback if user is on older Obsidian without Bases. |
| **S158** | **Local daemon localhost API + token gate `[+gpt-poc]`** | First-startup random API key; bound to `127.0.0.1`; extension stores token; non-local origins rejected. Side panel shows "bridge connected / disconnected" badge. |
| **S159** | **Daemon read-back of vault changes `[+gpt-poc]`** | When user edits frontmatter / wikilinks / moves files in Obsidian, daemon scans and surfaces deltas (e.g. user reassigned a thread to a different topic by editing frontmatter; BAC's state mirrors that). Eventually drift detection (W2) lives here too. |
| **S160** | **Organization-aware context pack `[+gpt-poc]`** | `bac.context_pack({project, topic, includeTags, includeLinkedDepth, includeCanvas})` — context selected from user organization, not full-text search. Returned as markdown with goal / active decisions / threads / sources / OQs / related neighborhood sections. |
| **S161** | **Obsidian-absent degraded mode `[+gpt-poc]`** | If user has not installed Obsidian, BAC still functions: side panel shows organized state from local daemon DB; export-to-vault becomes a manual action; Bases dashboards become Markdown tables in a configured local folder. |
| **S162** | **Frontmatter-driven re-import `[+gpt-poc]`** | Daemon can rebuild its SQLite event store from the vault (`_BAC/events/*.jsonl` + frontmatter mirror) — vault is the canonical source of truth, daemon DB is a cache. Lost daemon DB ≠ lost data. |

### 26.9 Edge cases this surfaces

| # | Case | Mitigation |
|---|---|---|
| **E33** | User reorganizes folders/files in Obsidian while daemon is offline | On daemon next-start, reconcile by `bac_id` scan; missing files mark thread `archived` rather than deleting state |
| **E34** | User installs Obsidian *after* using BAC for weeks | Migration path: daemon emits full vault projection from existing event store; user points at vault path; first sync writes everything |
| **E35** | Two Obsidian vaults (work + personal) | v1 single-vault binding; multi-vault is v1.5+ |
| **E36** | Obsidian Local REST API plugin not installed | **Default state, not an error.** Filesystem-write substrate is primary per §23.0; plugin presence is opportunistic acceleration only. First-run wizard simply notes "you'll get surgical PATCH if you install Local REST API" — no warning, no degraded mode. |
| **E37** | User edits a `.canvas` or `.base` file BAC generated | Treat user edits as a fork: BAC stops regenerating that file; offers "regenerate (overwrites your edits)" or "keep manual" |
| **E38** | Daemon crashes mid-write | All writes idempotent + content-addressed; WAL-mode SQLite; retry on next event; vault writes use temp-file-then-rename |
| **E39** | User deletes a frontmatter `bac_id` | Treat as "user wants to detach this file from BAC"; daemon scans and stops mirroring; logged as a decision event |
| **E40** | Two daemons accidentally running | Lockfile in vault `_BAC/.daemon.lock`; second startup refuses with clear error |

### 26.10 Open questions for user (don't decide unilaterally)

These are the live decisions this addendum surfaces but doesn't resolve.

1. **Path A vs Path B vs hybrid?** Three balanced PoCs (organization-first
   thesis test) vs one local-bridge PoC (technical-substrate test) vs
   "Path B as substrate, then Path A's PoC 1 on top".

2. ~~Filesystem-write-first or Local-REST-API-first?~~ **Resolved 2026-04-26**:
   filesystem-write-first per §23.0. Local REST API is opt-in acceleration
   only. See §23.0 for the load-bearing principle and the §26 banner update
   for the supersession of §24's "v1 requires plugin" anchor.

3. **"Track + organize, suggest later" vs "automate-and-suggest from day 1"?**
   Path A's bet is that human-in-the-loop organization is the trust-building
   wedge. §24's calibrated-freshness recall (W3) is a form of suggestion —
   reconcilable as "user-initiated suggestion" (recall fires on highlight,
   not in background), but worth flagging.

4. **Should next PoC also close the live-capture gaps from PoC-2** (real
   ChatGPT conversation-thread pass; real Claude logged-in pass)? Both Path
   A's PoC 1 and Path B's local-bridge naturally surface this since they
   both consume captures.

5. **Does the `SwitchBoard` example name reflect a real product-naming
   intent**, or is it just a placeholder used in the discussion? (It also
   appears as the `zyingfei/switchboard` repo reference in the
   discussion's first paragraph.)

6. **Hybrid recommendation if user picks one.** If the goal is fastest path
   to a credible "demo-able product slice", a hybrid that does Path B's
   daemon + Path A's PoC 1 (organization on top) lands the most product
   surface in one cycle. If the goal is sharpest architectural decisions,
   Path A's three sequential PoCs maximize learning per PoC.

### 26.11 Bottom-line synthesis (mine, not the discussion's)

The discussion is internally coherent and aligned with most prior anchors.
The two genuinely new contributions are:

1. **The "Obsidian-native, not Obsidian-dependent" reframe** — sharper than
   §23's "canonical" framing because it carries an explicit fallback model.
2. **The "track + organize, suggest later" stance** — a real ICP/UX bet
   that trades wow-moments for trust. Worth treating as a PRD-level
   decision.

The single largest tension with prior anchors is the **filesystem-write-first
vs. Local-REST-API-first** choice (§24 vs §26.4). That's worth resolving
before either PoC starts, because it affects the daemon adapter's interface
shape, the first-run UX, and the install-friction story for the launch.

Floor's yours: pick a PoC path (or hybrid), resolve the §24 anchor question,
or feed more inputs.

---

## 27. Addendum (2026-04-26): Connection setup vs sync direction `[user]`

User-introduced split. Today the brainstorm collapses three different concepts
under "vault integration" — connection wiring, sync into BAC, and sync out of
BAC. They are different in lifecycle, in failure mode, in UX surface, and in
the user's mental model. Keep them separate.

### 27.1 The three concepts, separated

| Concept | What | When it runs | Failure mode | UX surface |
|---|---|---|---|---|
| **Connection setup** | Wire BAC to a vault folder. FileSystemAccess `showDirectoryPicker()` (extension) or vault path config (daemon). One-time per vault per device. Persist the handle / path. Detect Local REST API plugin presence opportunistically (acceleration, not gating). | Once at first run; again if user revokes the handle, switches vaults, or moves the folder. | "No connection" — BAC operates in local-only ledger mode (captures stay in `chrome.storage.local` / daemon DB until a vault is wired). | First-run wizard; settings page; "vault" badge in side panel. |
| **Sync-in** (vault → BAC) | Read the vault: scan for files with `bac_id` frontmatter, pick up user-authored notes the user wants tracked, baseline existing notes when first connecting, keep BAC's view of vault state in sync after the user edits / moves / renames in Obsidian. | At connect, on user request ("re-scan vault"), and on a periodic / FS-watched cadence after that. Cheap to re-run. | "Out of date" — BAC's view lags the vault; user re-runs scan. | Side-panel "scanned N files, M tracked"; daemon log; explicit "Sync from vault" button. |
| **Sync-out** (BAC → vault) | Write to the vault: tracked captures land as Source notes; promoted artifacts (decisions, OQs) land as typed notes; generated `.canvas` and `.base` regenerate. **Also** covers the case where the user manually adds a note **outside** the tracked set and explicitly tells BAC "track this from now on" — that's a sync-out, not a sync-in, because BAC is the side that decides what gets attached. | On capture (per-event), on explicit promote, on regeneration of dashboards / canvases. | "Write blocked" — vault unwriteable (handle revoked, disk full, plugin acceleration failed → fall back to plain write). | Side-panel "wrote 3 files"; per-event success toast; "Open in Obsidian" link. |

The reason this matters: today's brainstorm has S99 (frontmatter mirror), S104
(inbox-folder writing), S107 (atomic write protocol), S108 (first-run vault),
S159 (daemon read-back of vault changes), and parts of S111 (read user's
vault as RAG source) all tangled into a single "Obsidian integration" narrative.
With the split, they line up cleanly:

- **Connection setup**: S108, parts of S107 (atomic-write protocol is a
  property of the connected handle).
- **Sync-in**: S159, S111, the vault-baseline part of S108.
- **Sync-out**: S99, S104, the regeneration of S100 / S101 / S109 / S110, and
  the "user manually adds a note out of track" case (new — see §27.3).

### 27.2 New scenarios for the split

| # | Scenario | Direction | Notes |
|---|---|---|---|
| **S163** | **Connect to vault** | Connection | First-run wizard or settings: pick vault folder via `showDirectoryPicker()`. BAC persists the handle. Detect Local REST API plugin opportunistically. Show "vault: connected · plugin: not installed (optional)". |
| **S164** | **Disconnect / re-pick vault** | Connection | User can disconnect (BAC stops writing; in-flight captures stay local) or switch vaults (BAC asks: archive prior tracked set or migrate). |
| **S165** | **Baseline existing notes (sync-in)** | Sync-in | At first connect, scan vault for files with `bac_id` frontmatter (re-attach to known items) and offer the user a list of un-attached notes they may want to track. User opts in per-folder or per-file. No silent global ingest. |
| **S166** | **Keep-in-sync from vault (sync-in)** | Sync-in | After connection, scan periodically / on FS event for: new `bac_id` files (rare, but possible if user copies a note from another vault), edited frontmatter, file moves/renames, file deletes (treat as detach, not delete-in-BAC). Reconcile on next BAC view. |
| **S167** | **User manually adds an out-of-track note (sync-out trigger)** | Sync-out | User has a Markdown note in the vault that BAC didn't create (e.g. a meeting transcript they wrote by hand). They open it, click "Track in BAC" (extension popup or Obsidian-side URI handler) → BAC writes `bac_id` + `bac_type` frontmatter to the file (sync-out), then it shows up under the appropriate project/topic in the side panel. |
| **S168** | **Per-direction status badges in side panel** | Both | Side panel shows three independent indicators: connection (●/○), sync-in (last scan time, items added), sync-out (last write time, items written). Distinguishes "vault not wired" from "vault wired but write failing". |

### 27.3 What's deferred

User explicitly defers conflict / merge semantics. We acknowledge they exist
but don't design them in this addendum:

- **Conflicts** — BAC writes to a file at the same instant the user edits it
  in Obsidian, or two devices write to the same file via a shared vault
  (iCloud / Dropbox / Obsidian Sync).
- **Merges** — sync-in surfaces a frontmatter change that conflicts with a
  pending sync-out write (e.g. user changed `topic` in Obsidian while BAC was
  re-promoting the same file with a different `topic`).
- **Three-way reconciliation** — BAC state vs. vault state vs. last-known-
  baseline.

Tentative posture for v1 (not pinned): **last-write-wins per file, scoped to
frontmatter keys BAC owns** (the `bac_*` namespace). User-owned keys are
never overwritten. File-body merges are out of scope; if BAC needs to update
a body region it uses heading-targeted PATCH (REST API path) or a
delimited-region marker (`<!-- bac:region:notes -->`) for the filesystem
path. Detailed conflict design lives in a future addendum or PRD.

### 27.4 Why this matters for the §23.0 principle

§23.0 says the substrate is filesystem + interfaces. §27 says the substrate
exposes three operations, not one. That gives the §26.6 daemon and the
extension a cleaner shared interface:

```ts
interface VaultBinding {
  // 27.1 — connection
  connect(handleOrPath: FileSystemDirectoryHandle | string): Promise<void>;
  disconnect(): Promise<void>;
  status(): { connected: boolean; pluginAccelerator: 'rest-api' | 'none'; };

  // 27.1 — sync-in
  scanForBacIds(): AsyncIterable<{ path: string; bacId: string; frontmatter: Record<string, unknown>; }>;
  watchVault(): AsyncIterable<VaultChangeEvent>;     // FS event stream when supported

  // 27.1 — sync-out
  writeNote(path: string, body: string, frontmatter: Record<string, unknown>): Promise<void>;
  patchFrontmatter(path: string, keys: Record<string, unknown>): Promise<void>;
  attachToTrack(path: string, type: BacEntityType): Promise<{ bacId: string; }>;  // S167
}
```

Same interface, two implementations: one backed by FileSystemAccess +
plain-file writes (extension), one backed by Node `fs` + atomic temp-file-
rename (daemon). When Local REST API is detected, `patchFrontmatter` upgrades
to surgical PATCH; otherwise it does read-modify-write under a per-path lock.

### 27.5 What this changes in earlier sections

- §23 NotebookAdapter (§23.7): split `appendEntry` / `writeFrontmatter` into
  the connect / sync-in / sync-out tiers above.
- §23.5 inbox-first writing: still applies, but classified as a sync-out
  policy, not a vault-integration concept.
- §24 storage model: vault is canonical (§24 stands), but BAC's local store
  is no longer "cache" — it's the **sync-in inbox** for items not yet
  attached to the vault. The local store is the staging area; the vault is
  the system of record once items are attached.
- §26.6 daemon: the daemon's Obsidian-adapter contract collapses onto the
  `VaultBinding` interface above. The "two write modes behind one interface"
  in §26.6.2 is still right — just that the modes are filesystem (always)
  with optional REST API acceleration, not "filesystem fallback when REST
  API absent."

### 27.6 Empirical update from `poc/vault-bridge` (2026-04-26): writer moves out of the browser

A feasibility PoC at `poc/vault-bridge` tested the assumption that the
extension can own the sync-out side of §27 directly via FileSystemAccess.
Six U1–U6 unknowns; live Chrome + iCloud run on macOS 26.2 / Chrome
147.0.7727.102 / Node 25.8.2. The data path itself is fine; the **writer
substrate is not viable for production**.

**Failures that pivot the architecture:**

| # | Outcome | Evidence | Implication |
|---|---|---|---|
| **U6** | **Fail** | SW-owned `setInterval` stopped at sequence 30 (~30 s, MV3 idle window); `Refresh` woke a new SW with `Tick count 0` | MV3 service workers cannot host continuous timers. Live-tabs flush, periodic state sync, embedding-index rebuilds, batch sync — none survive in the SW. |
| **U5** | **Fail-risk** | After a SW restart inside the same Chrome session, `queryPermission({ mode: "readwrite" })` returned `prompt`; manual write blocked with "Vault folder permission is prompt; re-grant from the side panel" | "Silent capture" is not achievable when permission state is tied to SW lifecycle. Every SW restart could mean a re-grant click. |
| **U1** | Fail-risk (paired with U5) | Persisted handle was available across some SW restarts then lost write permission | The persisted-handle pattern is necessary but not sufficient. |

U2/U3/U4 all hit Acceptable or Pass. The data path (extension → file →
Node tail reader) works correctly. The failure isn't filesystem semantics
— it's MV3 lifecycle and FileSystemAccess permission state, both
properties of the browser the extension runs inside, neither changeable
from extension code.

**Architectural pivot — Path B promoted from alternative to anchor:**

Add a **companion process** between the extension and the vault. The
companion owns all writes and any sustained operations:

```text
                       ┌─ HTTP/WS or Native Messaging
Extension (sensor) ────┤
                       ▼
              ┌──────────────────────┐
              │ Companion (writer)   │  long-lived process
              │   - holds vault path │  (no permission UX)
              │   - owns all writes  │
              │   - runs sustained   │  (survives SW deaths,
              │     tasks (tick,     │   browser closes,
              │     index rebuild)   │   reboots if started)
              └──────────┬───────────┘
                         │ Node fs
                         ▼
                  Vault folder (canon)
                         │ Node fs
                         ▼
                bac-mcp (reader, unchanged)
```

This maps to **§26.6 Path B** (the `local-bridge` daemon sketch),
previously framed as one of two PoC paths the user might pick at PRD
time. The vault-bridge result empirically eliminates Path A
(extension-only writer) for production use; Path B is no longer an
alternative — it's the v1 writer architecture.

**What's preserved (still load-bearing v1 anchors):**

- §23.0 — vault is canonical; substrate is filesystem + Markdown +
  frontmatter + `.canvas` + `.base` + `_BAC/`. Companion writes via plain
  Node `fs`; plugins remain opt-in acceleration; nothing about the
  substrate principle changes.
- §27.1 — three concepts (connection setup / sync-in / sync-out) still
  separate; both directions just live in the companion now.
- MCP read side — `npx bac-mcp --vault <path>` is unchanged. The
  existing `poc/mcp-server` already validated stdio MCP composition.
- §28 inline reviews — review *capture* (the user marking spans) can
  still happen in the side panel; review *write* (vault frontmatter
  mirror) goes through the companion like any other sync-out.

**What changes:**

- The `VaultBinding` interface sketched in §27.4 now has its primary
  implementation in the companion (Node `fs` + atomic temp-file-rename),
  not in the extension. Extension-side becomes a thin client that posts
  capture events to the companion via NM or localhost HTTP.
- The "single install" UX dies. User installs (a) the extension and (b)
  the companion. Documented elsewhere as the install-funnel cost
  (§24.3n).
- Extension-side persistence in `chrome.storage.local` shifts role: from
  "fast cache for side panel" to "queue for in-flight captures while
  companion is unreachable" (drained on reconnect).

**What this PoC was *not*:**

The vault-bridge PoC was scoped to validate the substrate. It did. The
substrate fails for sustained / silent operation. The next PoC at
`poc/local-bridge` (per §26.6) is scoped to the companion's install-UX
and lifecycle questions, which are the actual unknowns — companion-
writes-to-vault via Node `fs` is well-trodden and not in question.

**MV3 lessons folded back to other sections (for PRD pass):**

- §24.3f ("`chrome.storage.session` for hot state, IndexedDB for
  durable, never assume in-memory globals persist — service worker
  terminates after 30 s inactivity") gets a sharpened corollary: **never
  assume any in-SW timer or in-SW handle survives idle.** SW is for
  event handling, not state ownership.
- §24.3n permissions UX gets a related sharpening: **FileSystemAccess
  permission state revoking after SW restart is a documented MV3
  reality, not a bug.** Designs that depend on silent persistent FS
  access from MV3 are designs that will break.
- §24.10 safety primitives unchanged but reinforced: read-only MCP by
  default + paste-mode dispatch by default were already the v1 stance;
  with writer authority moving to the companion, those defaults compose
  cleanly (extension can't dispatch silently because it can't even
  write silently).

**Status as of 2026-04-26:**

- `poc/vault-bridge` complete, partial outcomes, README + NOTES
  document U1–U6 evidence.
- `poc/local-bridge` (companion architecture) is the next PoC; planning
  artifact lives on the local `poc-planning` branch as `poc/local-bridge/
  TODO.md`.
- Update memory anchor: companion process is now load-bearing for the
  writer side; vault-as-canonical and MCP read side unaffected.

---

## 28. Addendum (2026-04-26): Inline reviews — draft + dispatch back to chats `[user]`

User observation. Most chat vendors (ChatGPT, Claude, Gemini) lack good
inline-review affordances on assistant turns: you can copy, edit your next
prompt, or start a new branch — but you can't *annotate* a turn in place
("this paragraph is wrong; this one is great; here's a counter-example")
and have the chat absorb the annotations as feedback. BAC sits one layer
above and can offer this.

### 28.1 The shape of the feature

A persistent capability set, not a single scenario. Four operations:

| Operation | What | Where the review goes |
|---|---|---|
| **Review** | User selects span(s) of an assistant turn (or a whole turn). BAC opens a review composer in the side panel: per-span comment + an overall verdict (`agree` / `disagree` / `partial` / `needs-source`). | Stored locally as a `ReviewEvent` (new entity type, extends §24.6); also written to the vault as a frontmatter mirror under the captured-turn note. |
| **Submit-back** | "Send review back to original chat" — BAC composes a follow-up user-turn that quotes the spans + attaches the comments + states the verdict, and dispatches into the same thread (same provider, same conversation). Uses the existing dispatch primitive (paste-mode default per §24.10; auto-send opt-in). | Original thread; the assistant sees structured feedback as a normal user turn. |
| **Dispatch-out** | "Send review as context to another chat" — BAC bundles the reviewed turn + the user's annotations + (optional) the prior 2–3 turns of context, and dispatches to a different chat (different provider or different thread) for a second opinion / fact-check / counterfactual. | Target chat the user picks (multi-target dispatch, same primitive as S25). |
| **Track** | The review and its outcome stay attached to the captured turn in BAC. Future recall surfaces "you reviewed this turn N weeks ago — your verdict was Y." Future déjà-vu can de-prioritize turns the user marked `disagree`. | Vault note frontmatter (`bac_reviews:` array); BAC event log. |

### 28.2 Why this is BAC-shaped, not provider-shaped

The providers themselves are unlikely to ship this any time soon, for two
reasons:

1. Inline review is *adversarial* to the provider's "the AI is helpful"
   framing. Letting users pin "this paragraph is wrong" alongside the
   assistant's output would be a UX downgrade for the provider (looks like
   the AI failed) even though it's an upgrade for the user.
2. Cross-chat dispatch ("send this Claude turn to ChatGPT for a second
   opinion") is *anti*-positioning for any single provider — they want you
   to stay in their chat.

BAC, on the other hand, is positioned exactly to serve these two motions
(W1 cross-AI orchestration; W2 reading capture; W3 calibrated-freshness
recall over reviewed material). The review feature is a clean fit:

- It piggybacks on existing capture (the assistant turn is already captured
  — review is metadata layered on top).
- It piggybacks on existing dispatch (submit-back / dispatch-out are
  variants of the highlight-dispatch primitive S25).
- It piggybacks on existing recall (the local ranker can use the review
  verdict as a signal).
- It generates net-new content the user values (annotations) that *only
  BAC* has — strengthening the "your data lives here" wedge.

### 28.3 New entity type: `ReviewEvent`

Extends §24.6 entity types:

```ts
ReviewEvent {
  reviewId: string;                          // ULID
  targetEventId: string;                     // the assistant turn being reviewed
  targetSpan: { start: number; end: number; quote: string; }[]; // 1+ spans
  verdict: 'agree' | 'disagree' | 'partial' | 'needs-source' | 'open';
  comments: { spanIndex: number; text: string; }[];
  reviewerNote: string;                      // free-form overall comment
  dispatched?: {
    submittedBack?: { threadId: string; userTurnId: string; at: string; };
    dispatchedOut?: { targetThreadId: string; userTurnId: string; at: string; }[];
  };
  createdAt: string;
  updatedAt: string;
}
```

Stored in the event log + mirrored to vault as `bac_reviews:` frontmatter
array on the captured-turn's Source note (per §27 sync-out semantics).

### 28.4 New scenarios

| # | Scenario | Notes |
|---|---|---|
| **S169** | **Review an assistant turn inline** `[user]` | User selects span(s) → side-panel composer → write per-span comment + verdict → save. Stays local; nothing dispatched. Useful as a personal-judgment trail even without dispatch. |
| **S170** | **Submit review back to original chat** `[user]` | Composer offers "Send back to this thread" → BAC builds a follow-up user-turn quoting the spans with the comments → dispatches via existing S25-flavored primitive (paste-mode default; auto-send opt-in). The chat sees structured feedback as a normal turn. |
| **S171** | **Dispatch review as context to other chat** `[user]` | Composer offers "Get a second opinion in [ChatGPT / Claude / Gemini / …]" — same multi-target dispatch as S25 with the review bundled as context. The other chat sees the original turn, the user's annotations, and a "what would you say?" framing. |
| **S172** | **Review trail in vault** `[user]` | Reviews appear in the captured-turn's Source note as a `bac_reviews:` frontmatter list and a `## Reviews` body section (Markdown so user can edit). User edits → next sync-in (§27) reconciles back into BAC's state. |
| **S173** | **Review-verdict signal in recall ranker** `[user]` | When recall surfaces déjà-vu hits, hits the user previously marked `disagree` are demoted by default (with "show all" override). Hits marked `agree` get a small boost. Optional, per-bucket toggle. |
| **S174** | **Review-driven Context Pack inclusion** `[user]` | Context Pack generation (S74 / S160) can scope to "only assistant turns I marked `agree` or `partial`" — useful for handing off vetted material to a coding agent. |
| **S175** | **Cross-provider critique loop** `[user]` | Workflow: capture Claude answer → review → dispatch-out to ChatGPT for fact-check → ChatGPT replies with corrections → capture → annotate again. Becomes a cited multi-provider provenance chain. Surfaces in the dogfood loop (§21) as a new fork-pattern. |

### 28.5 Edge cases

| # | Case | Mitigation |
|---|---|---|
| **E41** | Provider thread is gone (deleted server-side) before the user submits-back | Fall back to dispatch-out with the original turn snapshot; warn user "original thread is gone, can't reply in place." |
| **E42** | Reviewed span no longer matches the rendered turn (provider edited / regenerated) | Anchor reviews via Hypothesis-style TextQuote + TextPosition selectors (§24.4 reuse map). On render mismatch, surface "review may be stale" badge. |
| **E43** | User reviews a captured turn from a thread they no longer have access to (org membership lapsed) | Local review remains valid; submit-back disabled; dispatch-out still works (uses captured snapshot). |
| **E44** | User submits-back to a thread that has had additional turns since capture | Prepend a brief "(re: your earlier turn quoted below)" so the assistant has anchor; otherwise it'll respond to whatever's most recent in context. |
| **E45** | Provider rate-limits the submit-back turn | Standard dispatch failure handling; queue + retry + clipboard-mode fallback (§24.3e). |
| **E46** | Sensitive content in the review (user's frustrated remarks not meant for the chat) | RedactionPipeline (§24.10) runs on submit-back / dispatch-out same as any dispatch. Composer shows a "review preview" before send so the user sees exactly what the chat will see. |

### 28.6 What this changes / connects to

- §3 primitives — add **Review** as a 9th primitive (after MCP-bridge from
  §24.17). Review composes Capture (already on) + Annotate (new) + Dispatch
  (existing). Worth flagging at PRD time.
- §24.6 entity model — add `ReviewEvent`.
- §24.10 safety — RedactionPipeline applies to submit-back / dispatch-out
  same as any dispatch.
- §22.3 graph — `ReviewEvent` connects to the captured turn (`targetEventId`)
  and to any dispatch-result turns that came out of it. Becomes part of the
  workstream graph and shows up in `.canvas` views (S100 / S156).
- §24.8 calibrated-freshness recall — review verdicts feed the local ranker
  (S173).
- §74 Context Pack — review verdicts become a filter dimension (S174).

### 28.7 Out of scope here

- Sentiment classification / auto-grading of assistant turns. Reviews are
  user-driven only.
- Sharing reviews publicly. Reviews are local to the user; sharing follows
  the §137 encrypted-blob backup path if the user wants to ship them.
- Review aggregation across users (e.g. "the community marks this Claude
  answer wrong"). Single-user trust boundary only for v1.
- Inline-review UI inside the chat tab DOM (which would need DOM injection
  past the provider's React tree). Side-panel composer only for v1; in-tab
  overlays deferred.
