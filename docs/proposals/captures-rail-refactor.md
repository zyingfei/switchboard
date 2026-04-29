# Captures rail refactor — proposal

**Status:** draft, awaiting sign-off before implementation
**Author:** Claude (post-#65 cleanup pass)
**Date:** 2026-04-29

## Problem

The Captures rail currently renders **one row per reminder**. A
single thread that's collected multiple unread replies (each
assistant turn after the user-last-seen mark creates a fresh
reminder) shows up as multiple identical-looking rows:

```
Captures
2
+ note
Domain Name Productivity Tool Analysis - Google Gemini
Gemini · 1 min ago · unread
Domain Name Productivity Tool Analysis - Google Gemini
Gemini · 1 min ago · unread
```

Two issues:
1. **Visual duplication.** Same thread, same provider, indistinguishable
   timestamps. The user can't tell which entry corresponds to which
   reply, and the second entry adds no information.
2. **Redundant signal.** Each thread row already carries an "Unread
   reply" lifecycle pill (`deriveLifecycle` → `unread-reply` kind).
   The rail says the same thing a second time.

Source: `entrypoints/sidepanel/App.tsx:1711-1731` renders each
reminder unconditionally; no per-thread coalescing.

## Three options, ranked

### Option A — drop reminders from the rail entirely (recommended)

The captures rail becomes manual-notes-only. The lifecycle pill on
the thread row remains the canonical "this thread has unread"
signal.

**Why this wins:**
- Eliminates double-rendering by definition.
- Thread row is already the click target for "go look at the
  reply" — sending the user to the rail to then click through to
  the thread is one extra step.
- The pill animates (signal pulse class), which is a stronger
  attention-getter than a static rail row.
- Code change is surgical: remove the `visibleReminders.slice(...)
  .map(...)` block from the rail render.

**Tradeoff:**
- Loses the chronological "what changed since I last looked" feed
  that the rail offers when you have many threads. Power users with
  20+ tracked threads might miss it.
- Mitigation: thread-row sort already prioritises `unread-reply`
  kind near the top; the inbox effect is preserved at the row
  level.

### Option B — coalesce per-thread, show count badge

Rail still shows reminders, but at most one row per thread. If a
thread has multiple unread reminders, append a `· 3 replies` chip.

**Why consider it:**
- Keeps a discoverable inbox surface for users who like to scan
  what's new.
- Less destructive than Option A — current users who rely on the
  rail still see something.

**Tradeoffs:**
- Still duplicates the lifecycle pill's signal.
- "Click rail row → jump to thread" UX has to be wired (currently
  rail rows aren't interactive).
- Coalescing logic adds nontrivial state: when does a count
  decrement? On each capture? On opening the thread? The current
  reminder model creates one row per assistant turn; we'd need a
  per-thread aggregate.

### Option C — keep flat list, just dedupe identical-text rows

Cheapest possible fix: in the render loop, skip a reminder if the
PRECEDING reminder in the list shares (`threadId`, `provider`,
relative-time bucket).

**Why consider it:**
- Smallest diff. No model changes.

**Why I don't recommend it:**
- Doesn't solve the redundancy with the lifecycle pill.
- Bucket-based dedup is fragile — if reminders straddle a minute
  boundary they show as distinct again.

## Recommended path: Option A + a small inbox affordance

1. **Rail change** (App.tsx:1664-1731):
   - Remove the `visibleReminders.slice(0, 8).map(...)` block.
   - Keep `scopedNotes` rendering as-is (manual notes only).
   - Empty-state copy updates: "Notes you save here are scoped to the
     current workstream. Inbound replies surface as the **Unread
     reply** badge on each thread row above."

2. **Section header change** (App.tsx, the `<div className="cap-head">`
   above the rail, find via grep):
   - The "Captures · N" badge currently counts notes + reminders.
     Change to just `scopedNotes.length`.

3. **No model changes.** Reminders still get created, still drive the
   `unread-reply` lifecycle kind. We're only removing one rendering
   surface.

4. **Optional follow-up (not in scope of this PR):** if power users
   miss the inbox, add a top-of-workboard "Inbox" pill that filters
   threads to those with `unread-reply` kind. Skip until requested.

## Test plan if this lands

- Update `tests/e2e/spec-coverage.spec.ts` (the lifecycle-pill test)
  — the `unreadThread` thread should still show `Unread reply` pill
  on its row even with no rail entry.
- Add a new test in `tests/e2e/inbound-reminders.spec.ts`:
  seed 2+ reminders on one thread → assert exactly 1 thread row
  visible with `Unread reply` pill, **0** rows in `.capture-list`
  for those reminders.
- Existing `capture-notes.spec.ts` still passes (notes path
  unchanged).

## Migration / risk

- No storage migration needed. Reminders still write the same way.
- No API changes — `messageTypes.createReminder` /
  `messageTypes.updateReminder` semantics unchanged.
- Visual regression: `capture-empty` empty-state copy needs a one-
  line update so it doesn't reference inbound replies.

## Open questions for the user

1. Are you OK losing the rail-as-inbox affordance entirely, or do
   you want me to add the optional follow-up Inbox pill in the
   same PR?
2. Should reminder rows _ever_ render in the rail — e.g. when the
   thread has been archived but the reminder is still live? My
   default plan is "no, ever" but we can carve out edge cases.
