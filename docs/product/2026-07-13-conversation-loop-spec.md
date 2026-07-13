# Conversation Loop — Product Spec (2026-07-13)

Owner: PM (conversation-loop). Branch: `feat/conversation-loop` (off `main`
502e5a11). Status: spec for the current wave. All wiring claims verified
against source, not comments (§ verified-hygiene rule).

---

## 1. The human job (JTBD)

> "I run several AI conversations across ChatGPT, Claude, and Gemini at
> once. I want to **fire follow-ups without babysitting tabs**, **know at a
> glance which conversations owe me a reply**, and **never miss one that
> came back**."

Three verbs, one lifecycle:

1. **Send** a follow-up — ideally without me re-finding the tab.
2. **Track** what I'm waiting on — which threads are mid-turn with the AI.
3. **Catch** the reply — an unread signal I can clear by reading.

Today the product chops this one loop into **three surfaces that never
reference each other**, so the job feels like three unrelated chores:

- **Work › Queued** — a standalone list where items sit with **no action**
  when their tab is closed (the "useless screen" — verbatim user feedback).
- **Work thread rows** — a "Waiting on AI" pill computed from turn roles.
- **Inbox › Replies** — unread AI replies with **no context** about what
  they answer or which thread they belong to.

The user's three complaints map exactly to these seams:

1. *"Queued screen is basically useless — give me an Open button so it can
   auto-capture again."* → Queued rows have zero open/reopen affordance.
2. *"Replies in Inbox vs waiting-on-AI in Work — streamline; I don't get
   why the Inbox replied list is so hard to understand."* → two "waiting"
   concepts on two surfaces + context-free reply cards.
3. *"Understand features like a human, structure them like a top-tech PM."*
   → this spec: one state machine, surfaces as views of it, one vocabulary.

---

## 2. The single loop state machine

There is exactly **one** conversation-loop lifecycle per **thread**. Every
surface is a *view* of this machine — no surface owns its own private
lifecycle. The states below are **derived** from data that already exists;
we are not adding new capture semantics or new persisted state machines.

### 2.1 States (per thread)

| State (canonical) | Plain-word chip | Derived from (existing data) |
|---|---|---|
| **Idle** | *(no chip)* | no pending queue items, `lastTurnRole !== 'user'`, no unread reminder |
| **Queued** | `N queued · open to send` / `N queued · sending` | ≥1 `QueueItem{status:'pending', scope:'thread', targetId===threadId}` |
| **Sending** | `Sending…` | any pending item with `progress:'typing'` |
| **Waiting on AI** | `Waiting on AI · <age>` | `thread.lastTurnRole === 'user'` (last captured turn was the user's) |
| **Replied · unread** | `Replied · unread` | some `InboundReminder{threadId, status:'new'}` |
| **Needs attention** | `Needs organize` / `Tab closed` / `Stale` | existing `deriveLifecycle` states (unchanged) |

**Precedence** (highest wins — matches and extends the current
`deriveLifecycle` order in `src/sidepanel/lifecycle.ts:36`):

```
Tab closed  >  Tracking stopped  >  Replied·unread  >  Needs organize
            >  Stale  >  Sending  >  Queued  >  Waiting on AI  >  AI replied last  >  Idle
```

Rationale for the two insertions:
- **Replied·unread stays at the top** of the "actionable-now" band (it is
  today's `unread-reply`, kept verbatim as the highest-value signal) —
  renamed in copy from "Unread reply" to **"Replied · unread"** so the
  thread row and the Inbox use *the same words* for the same event.
- **Queued / Sending sit just above "Waiting on AI"**: an item I stacked
  but haven't shipped is a *more actionable* state than a thread already
  mid-turn with the AI. Sending outranks Queued because it is transient and
  the user should see progress, not a stale "open to send" CTA.

### 2.2 Events → transitions

Every transition is fired by an event that **already exists in the wiring**.
No new event is introduced.

| Event (existing wiring) | Transition |
|---|---|
| User submits inline composer (`submitQueueFollowUp`, App.tsx:4060 → `queueFollowUp` → `createQueueItem`, background.ts:2717) | `Idle/Waiting/Replied` → **Queued** |
| Drain starts typing (`updateQueueItem{progress:'typing'}`, autoSendDrain.ts:180) | **Queued** → **Sending** |
| Drain ships item (`status:'done'`, autoSendDrain.ts:194) + capture stamps `lastTurnRole:'user'` | **Sending** → **Waiting on AI** |
| Drain bails (`lastError` set, autoSendDrain.ts:161/172/186) | **Sending/Queued** → **Queued (blocked)** — item stays pending, blocker named |
| Assistant turn captured for the thread (background.ts:972/1011 companion, 1408/1425 local; stamps `lastTurnRole:'assistant'`) + `createLocalReminder{status:'new'}` | **Waiting on AI** → **Replied · unread** |
| User opens/reads the reply (`onOpen` → reminder `status:'seen'`, InboundCard) | **Replied · unread** → **AI replied last** / **Idle** |
| `markQueueItemsDoneFromTurns` matches the follow-up text in a captured user turn (state.ts:1546) | **Queued** → item `done` (loop closure without drain — e.g. user pasted manually) |

### 2.3 The one-paragraph model (canonical)

> A thread is **Idle** until I stack a follow-up on it, which makes it
> **Queued**. When the thread's tab is available and the §24.10 gates pass,
> the drain flips it to **Sending** and then, once the text lands as my
> turn, to **Waiting on AI**. If the drain can't ship (tab closed, auto-send
> off, provider not opted in, screen-share-safe on, over budget) the item
> stays **Queued (blocked)** with the blocker named and the one action that
> clears it. When the AI's reply is captured, the thread flips to **Replied
> · unread** and the Inbox badge increments in the **same event** — one
> capture, two views, same words. Opening the reply marks it read, and the
> thread settles back toward **Idle**, ready for the next follow-up.

---

## 3. Surfaces as views of the machine

### 3.1 Vocabulary (canonical — used *everywhere*, no synonyms)

| Concept | The word we use | Never say |
|---|---|---|
| A follow-up I stacked, not yet sent | **Queued** | "pending", "parked" |
| It's typing into the provider now | **Sending** | "dispatching", "in progress" |
| I sent, the AI hasn't answered | **Waiting on AI** | "awaiting", "in flight" |
| The AI answered, I haven't read it | **Replied · unread** | "Unread reply", "new inbound", "inbound" |
| I read it | **Read** | "seen", "acknowledged" |
| Why an item can't send | **Blocker** | "error", "lastError" |
| The button that clears the blocker | **Open** / **Send now** | "Retry" (Retry stays only for transient send failures) |

Note: today's row pill says **"Unread reply"** and the Inbox is titled
**"Replies"**. We unify on **"Replied · unread"** for the *state* and keep
**"Replies"** as the Inbox tab name (it's the plural noun for the list).
The thread chip and the Inbox describe the same event with the same head
word — **Replied**.

### 3.2 WORK thread rows — the loop-state chip

Each thread row shows **one** loop-state chip, derived by the extended
`deriveLifecycle`. Exact copy per state:

| State | Chip text | Tone | Tap target |
|---|---|---|---|
| Queued (shippable, tab open) | `1 queued · send now` (pluralize N) | amber | Send now → `triggerAutoSendDrain` |
| Queued (blocked, tab closed) | `1 queued · open to send` | amber | Open → open tab, then drain |
| Queued (blocked, other gate) | `1 queued · <blocker>` (e.g. `auto-send off`) | amber | Open → fix path |
| Sending | `Sending…` | amber | — (transient) |
| Waiting on AI | `Waiting on AI · 12m` | amber | — |
| Replied · unread | `Replied · unread` | signal | Open → read (same as Inbox Open) |
| AI replied last | `AI replied last` | gray | — |
| (existing) | `Tab closed` / `Needs organize` / `Stale` | gray/amber | (unchanged) |

The chip **count** (`N queued`) is the number of pending thread-scoped
items for that thread — the same filter the drain uses
(`readPendingItemsForThread`, targetId===threadId). This makes the row chip
and the Queued view **provably consistent** (same predicate).

Consistency guarantee: the row's `Replied · unread` chip and the Inbox
`Replied` card are driven by the **same** `InboundReminder{status:'new'}`
records (`deriveLifecycle` line 52 already reads reminders). One reminder,
two views. Reading it in *either* place clears it in *both* (status → seen).

### 3.3 QUEUED view — every row names its blocker + the unblocking action

**Decision: Queued stays a sub-tab. Do NOT fold it into Threads.**

Justification (PM call, not a coin-flip):
- **Distinct job.** Threads answers *"which conversations owe me a reply?"*
  (a *reading* triage). Queued answers *"what am I about to send, and why
  hasn't it gone?"* (a *sending* triage). Collapsing them buries a
  send-blocker inside a reply-triage list.
- **Cross-thread batch view.** Queued groups by target across *all* threads
  (`groupQueueItems`), so a user with 6 blocked items across 4 threads sees
  them in one place. A filtered Threads section can't show workstream/global
  items, which have no thread row at all.
- **The row chip already links them.** With §3.2, the Threads row surfaces
  the per-thread queue state and taps straight into the send path — so the
  discoverability argument for merging is already satisfied without losing
  the batch view. Best of both: Threads *points at* Queued; Queued *is* the
  workbench.

**Row anatomy (replaces the current text + `failed` + Retry/Dismiss):**

```
<item text, 2-line clamp>
<blocker line, only when blocked>            [Open] [Send now] [Edit] [Remove]
```

Per-row actions and exact copy, mapped to the blocker:

| Blocker (from drain `stoppedReason` / `lastError`) | Blocker line copy | Primary action | Wiring |
|---|---|---|---|
| Tab closed | `The chat tab is closed.` | **[Open]** | open/focus tab (`openTabForThread`, App.tsx:3797) → then `triggerAutoSendDrain` |
| Auto-send off for thread | `Auto-send is off for this thread.` | **[Open]** | Open opens the thread; the send-mode choice (auto vs paste) is made there — never bypass the toggle |
| Provider not opted in | `<Provider> isn't opted in for auto-send.` | **[Open]** → paste | Open the tab in **paste mode** (dispatch/paste flow, item preloaded) — respects the gate verbatim |
| Screen-share-safe on | `Screen-share-safe mode is on.` | **[Open]** → paste | same paste fallback |
| Over token budget | `This follow-up is over the send limit.` | **[Edit]** | Edit to shorten, then it re-drains |
| Send failed (transient) | `Send failed — try again.` | **[Send now]** | `retryAutoSend` (background.ts:3075) |
| No blocker (tab open, gates pass, not yet drained) | *(none)* | **[Send now]** | `triggerAutoSendDrain` |

**[Open] semantics (the fix for complaint #1):**
1. `openTabForThread` focuses the existing tab or `chrome.tabs.create`s the
   thread URL (App.tsx:3797/3830) — this *is* "reopen the link to capture
   again."
2. After the tab is confirmed loaded, fire `triggerAutoSendDrain(threadId)`.
   The drain runs the §24.10 preflight funnel **unchanged**: thread opt-in →
   provider opt-in → screen-share-safe → token budget → redaction →
   auto-type. If every gate passes, the item auto-sends. If a gate blocks,
   the item's blocker line updates in place (no silent failure).
3. **If auto-send is off** (the most common case — `autoSendEnabled`
   defaults undefined), [Open] does NOT force-flip the toggle. It opens the
   thread tab and hands the item to the **existing dispatch/paste flow**
   (`DispatchConfirm`, `dispatchKind:'chat-paste'`) with the item text
   preloaded — the user pastes to send. This routes through
   `preflightOutbound` so the pasted text is **redacted/scrubbed**, never
   raw (the §24.10 redaction funnel is unconditional and un-bypassable).

**[Send now]** appears only when the tab is already open and gates would
pass; it fires the drain directly (no tab open needed).

**[Edit]** opens the item text inline (reuses the composer), re-writes the
`QueueItem.text`, clears `lastError`. This is the *only* fix for the
over-budget dead-end that doesn't require Dismiss.

**[Remove]** = today's Dismiss (`status:'dismissed'`). Renamed to plain
"Remove" per the vocabulary table.

**Empty state (real, not a shrug):**

```
Nothing queued yet.

Queue a follow-up on any conversation and it waits here until it can
send. When the tab's open and auto-send is on, it goes out on its own —
otherwise Open the thread and we'll help you send it.
```

### 3.4 INBOX › Replies — context line + optional snippet

Today an inbound card shows only: provider chip, thread title, age, unread
dot, Open, Dismiss (`InboundCard.tsx`). The user can't tell *what* the
reply answers. We add **one context line** and, if cheap, a **one-line
snippet**.

**New card anatomy:**

```
● <Provider chip>  <Thread title>                         <age>
  <workstream> · in reply to "<prompt excerpt / disambiguator>"
  "<one-line reply snippet>"                          [Open]  [Dismiss]
```

**Context line — data join (all data already exists):**
- **Workstream:** `thread.primaryWorkstreamId` → resolved label
  (`effectiveThreadWorkstream.ts` / `resolveWorkstreamPath`, already used by
  ConnectionsView). Add it to the mapper's `InboundThreadLite`
  (currently only `bac_id/title/lastTurnRole`, mapInboundReminder.ts:9).
- **In reply to:** best available of, in order:
  1. the `QueueItem.text` that was auto-resolved `done` by
     `markQueueItemsDoneFromTurns` for this thread around `detectedAt`
     (the follow-up that prompted the reply), else
  2. the `DispatchEventRecord.body` excerpt if a dispatch flipped `replied`
     for this thread (`markDispatchesRepliedForThread`), else
  3. **fall back to nothing** — never fabricate. If neither exists, the
     context line shows workstream only.
- **Reply snippet (optional, cheap-only):** the assistant turn text pinned
  by `lastAssistantTurnOrdinal` (already stored on the reminder,
  workboard.ts:160). If the turn text is in memory from the last capture,
  show its first ~90 chars; if fetching it would cost a store read, **skip
  the snippet** (do not add a read to the hot path). Snippet is a
  progressive enhancement, not a requirement.

**Open still = read.** `onOpen` marks the reminder `seen` and focuses the
thread tab (unchanged). This clears the row chip and decrements the badge —
the handshake in §3.5.

### 3.5 The Waiting-on-AI ⇄ Inbox handshake

**One event, two views, same words.** When a fresh assistant turn is
captured for a tracked thread (background.ts capture path):

1. `lastTurnRole` flips to `'assistant'` → the thread row's
   `deriveLifecycle` stops returning **Waiting on AI**.
2. `createLocalReminder{status:'new'}` is written → the thread row returns
   **Replied · unread** AND `mapInboundReminders` surfaces the card in
   Inbox › Replies AND the Inbox badge count increments.

These are two reads of the **same reminder record** — there is no second
computation to drift. The current bug the user feels ("two waitings") is
that the row said "Waiting on AI" (turn-role) while the queue said
`progress:'waiting'` (drain-await) — **two different signals**. We resolve
it by naming them differently and scoping them:

- **Waiting on AI** (thread-level, turn-role) = "I sent, the AI is thinking."
- **Sending** (item-level, `progress:'typing'`) = "we're typing it in now."
- We **remove** `progress:'waiting'` from user-facing copy on the queue row
  — once an item ships it's `done` and the *thread* is Waiting on AI. The
  queue item does not maintain its own "waiting for reply" life; the thread
  does. (The `progress:'waiting'` field can stay in the type for the drain's
  internal use but is not shown as a competing "waiting" label.)

Reading the reply in **either** the thread row's `Replied · unread` chip
**or** the Inbox card fires the same `onOpen` → `status:'seen'`, clearing
**both** views. No surface can show "unread" after the other cleared it.

---

## 4. Edge cases — every dead-end gets a resolution or an accepted limit

Mapped 1:1 from the verified dead-end list.

| # | Dead-end | Resolution in this spec |
|---|---|---|
| D1 | **Thread-scoped + tab closed** — drain writes "Open the chat tab…", no open affordance | **RESOLVED.** [Open] opens/focuses the tab (`openTabForThread`) then fires the drain. Blocker line names it: "The chat tab is closed." |
| D2 | **Thread-scoped + auto-send off** — no drain ever fires, no hint | **RESOLVED.** Blocker line: "Auto-send is off for this thread." [Open] opens the thread; the send happens via the existing dispatch/paste flow with the item preloaded. We do NOT auto-flip the toggle (consent stays explicit). |
| D3 | **Provider opt-out** — retry re-fails, no deep-link | **RESOLVED (paste fallback).** Blocker line: "<Provider> isn't opted in for auto-send." [Open] routes to paste mode (redacted). Deep-link to Settings › Auto-send is a **nice-to-have, deferred** (see notDoing). |
| D4 | **Screen-share-safe on** | **RESOLVED (paste fallback).** Blocker line: "Screen-share-safe mode is on." [Open] → paste mode. |
| D5 | **Over token budget** — no edit-to-shorten | **RESOLVED.** [Edit] lets the user shorten in place; clears `lastError`; re-drains. |
| D6 | **Workstream / global scoped** — never drains, never auto-resolves | **RESOLVED by removing the trap.** The scope selector's non-thread options lead to a permanent dead-end. This wave **hides the workstream/global scope options** from the composer (they were PR #241 speculative). Queue is thread-scoped only — matching what §13 step 4 already documents as "the same object." Global/workstream drain is **explicitly deferred** (needs a real fan-out drain design). Any *existing* non-thread items get a Queued-view banner: "This follow-up isn't tied to an open chat — Remove it and re-queue on a thread." |
| D7 | **Auto-send off, want manual send** — queue has no paste lane, only raw Copy | **RESOLVED.** [Open] → dispatch/paste flow (preflighted + redacted). The raw `copyQueueItemText` (no redaction) is **replaced** by the paste flow's safe copy — closes a redaction gap. |
| D8 | **Reply captured but thread not tracked** — no reminder, invisible | **ACCEPTED LIMITATION.** Reminder creation is intentionally gated on a tracked thread (background.ts:1047/1442). Auto-tracking untracked-tab replies is out of scope (new capture semantics). Documented, not fixed. |
| D9 | **Reply captured while viewing the thread** — no reminder (by design), race can hide it | **ACCEPTED LIMITATION (design).** `userIsViewingThreadUrl` short-circuits to `dismissRemindersForThread` — if you're looking at it, it's read. The tab-away race is a narrow window; the reply still lives on the thread. Not fixed this wave. |
| D10 | **Inbox Open recreates tab but doesn't drain** — queued follow-ups still sit | **RESOLVED.** After `onOpen`/`openTabForThread`, fire `triggerAutoSendDrain(threadId)` (same hook [Open] uses in Queued). Opening a thread with pending items — from Inbox *or* Queued — now attempts the drain. |

**Bonus systemic fix (no dead-end, but the missing trigger):** there is
today **no "tab became available → drain"** path (the `onUpdated`/`onActivated`
listeners at background.ts:4765/4771 do not call `triggerAutoSendDrain`).
This spec does **not** add a global tab-listener drain (risk: draining on
every navigation). Instead, the drain is fired **explicitly on user intent**:
[Open], [Send now], Inbox Open. This is the minimal, predictable trigger —
the user's action *is* the "tab available" event.

---

## 5. §13 runbook impact (steps 4 / 9 / 10)

The §13 acceptance runbook
(`docs/demos/2026-07-11-section13-acceptance-runbook.md`) changes as follows.
These are the three steps this wave touches; all other steps are unaffected.

**Step 4 (queue two follow-ups):**
- Today's DELTA ("queue is thread-scoped only; no workstream selector,
  flagged P0 polish") **is now the intended design**, not a delta. Remove
  the "flagged as a P0 polish item" language — thread-scope is the spec.
- New EXPECT: each queued row shows a **blocker line + [Open]/[Send now]**
  when it can't ship. Add a sub-step: "close the thread tab, open Queued,
  confirm the row reads `The chat tab is closed.` with an **[Open]** button;
  click it — the tab reopens and (if auto-send is on) the item sends."

**Step 9 (Inbound "replied N minutes ago"):**
- The tab is now **Inbox › Replies** (rename from "Inbound" if the runbook
  still says Inbound). EXPECT copy updates to the unified state name:
  rows read **"<Provider> · <thread title>"** with a **context line**
  ("<workstream> · in reply to …") and, when available, a **reply snippet**.
- Replace "Open / Mark relevant / Dismiss" with the current **Open /
  Dismiss** (Mark-relevant was already removed; runbook is stale here).
- New EXPECT: the thread row for the same thread simultaneously shows
  **`Replied · unread`** and the Inbox badge increments — call out the
  one-event-two-views handshake as a thing to verify.

**Step 10 (inline review → dispatch out):**
- Unchanged in mechanics, but note the **shared paste path**: the Queued
  [Open]→paste fallback reuses the same `DispatchConfirm` / `chat-paste`
  flow this step exercises. If step 10's dispatch/redaction passes, the
  Queued paste fallback inherits the same safety guarantee (call it out so
  a reviewer doesn't re-test redaction twice).

**Scorecard summary update:** step 4 moves from "Partial by design" to
"Should pass cleanly" (the thread-scope is now spec, and the blocker/[Open]
affordance is the new acceptance criterion).

---

## 6. Not doing (deliberate scope exclusions)

- **No serving-math / ranker changes.** This is pure loop UX; the recall
  ranker, similarity, and topic producers are untouched.
- **No new capture semantics.** No auto-tracking of untracked-tab replies
  (D8), no body-indexing changes, no new turn storage. We read
  `lastAssistantTurnOrdinal` / `lastTurnRole` that already exist.
- **No provider-side automation beyond the existing drain.** [Open] uses
  `runAutoSendDrain` and the §24.10 preflight funnel verbatim. No new
  auto-type paths, no new provider selectors, no bypass of any gate.
- **No global tab-listener drain.** Draining on every `onUpdated` is a
  CPU/consent risk (history: CPU-runaway). Drain fires on explicit user
  intent only.
- **No workstream/global-scoped queue drain.** Those scopes are hidden this
  wave (D6). A real cross-thread fan-out drain is a separate design.
- **No Settings deep-links from queue rows** (D3 nice-to-have). Paste
  fallback covers the send path; the opt-in toggle lives in Settings and
  the user gets there the existing way. Deferred.
- **No redesign of the second "Inbox" (tab-session / URL attribution).**
  The name collision is real but that surface is a different feature; a
  rename is out of scope here (noted for a future cleanup).
- **No reply-snippet store read on the hot path.** Snippet is in-memory-only
  progressive enhancement; if it'd cost a read, we skip it.

---

## 7. Acceptance criteria (this spec is met when)

1. Every Work thread row shows exactly one loop-state chip from §2.1, using
   the §3.1 vocabulary.
2. Every Queued row with a blocker names it and offers the unblocking
   action; [Open] opens the tab and fires the drain (auto-send or preloaded
   paste), never bypassing preflight/redaction.
3. Queued has a real empty state (§3.3).
4. Inbox › Replies cards show the workstream · in-reply-to context line
   (snippet when cheap); Open marks read and fires the drain for pending
   items.
5. A captured reply flips the thread to `Replied · unread` and increments
   the Inbox badge from one event; reading in either view clears both.
6. Every dead-end in §4 is resolved or explicitly accepted.
</content>
</invoke>
