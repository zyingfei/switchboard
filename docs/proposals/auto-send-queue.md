# Auto-send queued follow-ups — proposal

**Status:** draft, awaiting sign-off
**Author:** Claude (after the "hi" queue bug was filed)
**Date:** 2026-04-29

## Problem

Today, queued follow-ups are **paste targets**: the user clicks
"Copy" on a queue item, switches to the provider tab, manually pastes
into the composer, sends. After the next capture catches the user
turn that contains the queue text, the queue item flips to `done`
(the word-boundary fix in this PR makes that work even for short
text like "hi").

The user wants Sidetrack to instead **auto-send queued items into
the live chat**, one at a time, waiting for each AI reply to land
before sending the next.

## Why this is harder than it looks

Auto-typing into a provider chat composer is **§24.10 ship-blocking
territory**. Per PRD §6.1.13, dispatch has four hard gates:

1. **Per-target opt-in.** Auto-send must be opt-in **per provider**
   (chatgpt, claude, gemini), stored as `companionSettings.autoSendOptIn`.
   Default false. No quiet rollout.
2. **Screen-share-safe mode.** If `getDisplayMedia` is active in the
   tab, auto-send must NOT fire — the user is screen-sharing and a
   surprise message could leak.
3. **Captured-page injection scrub.** The queue item text is
   *user-authored*, so the standard injection-detection from the
   capture path doesn't apply directly. But we should still scan for
   patterns that look like prompt-injection attempts before sending,
   for the case where the queue item came from a paste that included
   external content.
4. **Token budget.** A queued item that would push the chat over the
   provider's context window must be flagged before send (the
   provider may silently truncate or refuse).

We also need:

- **Reliable "AI is done responding" detection** per provider so we
  don't send the next item while the assistant is still streaming.
  ChatGPT/Claude/Gemini each gate this with a different DOM signal
  (Stop button → Send button transition).
- **Composer DOM stability.** ChatGPT and Claude use ProseMirror /
  Tiptap; Gemini uses Quill. Direct `input.value =` doesn't trigger
  the editor's onChange. We already have working selectors from
  `tests/e2e/live-status-transitions.spec.ts` — that proves driving
  is feasible, but a queue-driven send is a longer-running flow that
  has to survive tab focus changes and provider re-renders.
- **Failure visibility.** If a send fails (composer locked, AI
  refused, network blip), the queue item must NOT silently disappear.
  Show the failure on the queue row + offer retry / abort.

## Recommended scope: P0.5 (post-M1, before M2 dispatch)

I'd hold this until M2 because:

- Dispatch + safety chain (§24.10) is M2's primary theme — sharing
  the safety primitives between dispatch packets and auto-send queue
  items is a natural fit.
- Right now, manual paste works and the queue auto-resolves on send
  (with this PR's fix). Auto-send is a UX polish layer, not a
  blocker for dogfood.

If you want to ship sooner, it can land as a P0.5 add-on after M1
merges, gated on the four §24.10 primitives.

## Three design options

### Option A — content-script-driven auto-send (recommended for M2)

The content script already runs on chatgpt.com / claude.ai /
gemini.google.com. Extend it with an `autoSendQueueItem` handler:

```ts
// background → content
{ type: 'sidetrack.queue.autoSend', items: [...], options: {...} }

// content → background (per item)
{ type: 'sidetrack.queue.autoSend.result', queueItemId, ok, error? }
```

The content script:

1. Validates §24.10 gates locally (screen-share, injection scan,
   token estimate).
2. Focuses the composer DOM (selectors from
   `live-status-transitions.spec.ts`).
3. Pastes the queue item text via `execCommand('insertText')` or
   directly via the editor's API.
4. Clicks the send button.
5. Watches for the "Stop" button → "Send" button transition (per-provider).
6. Reports success or failure back, then waits for the next queue
   item.

**Pros:**
- Same context as the manual flow today; provider-specific selectors
  already work.
- Failure modes (DOM drift, screen-share active) surface immediately
  to the side panel via the existing `messageTypes.captureFeedback`.

**Cons:**
- Complex per-provider state machines for "AI done responding".
- Race: if the user's keystrokes overlap with the auto-send, both
  fight for the composer.

**Mitigation:** disable the composer (or show a "Sidetrack is
sending…" overlay) while a queue item is in flight. Auto-cancel on
any user input.

### Option B — clipboard-based auto-send

Side panel writes the next queue item to clipboard, then the user
focuses the chat tab (or we focus it via `chrome.tabs.update`),
then a content-script injection paste-and-sends.

**Pros:**
- Simpler than driving the composer DOM directly.
- Reuses the existing clipboard-fallback path from the wizard's
  onReadClipboard.

**Cons:**
- Loses the user's clipboard contents.
- Many providers' composers have anti-paste-from-clipboard heuristics
  that strip formatting or block.
- Still need the "AI done responding" detector for sequencing.

### Option C — Submit via provider API (long-term)

ChatGPT / Claude / Gemini all have official APIs. Sidetrack could
post directly via `fetch`, bypassing the DOM entirely.

**Pros:**
- Robust against DOM drift.
- Streaming-end signal is unambiguous (HTTP response close).

**Cons:**
- Requires the user's API key, separate from the chat session
  cookie — a fundamental UX shift.
- Doesn't show in the chat UI for the user, so the conversation
  history diverges from what's on screen.
- ChatGPT's web chat session is NOT API-equivalent (different model
  weights, different tool surface, different memory).

**Verdict:** out of scope for M1/M2. Revisit if there's user demand.

## Recommended path: Option A, gated on M2 §24.10

1. Land §24.10 safety primitives as part of M2 dispatch.
2. Add `messageTypes.queue.autoSend` + `messageTypes.queue.autoSend.result`.
3. Extend `entrypoints/content.ts` with the per-provider
   composer-driver code-path. Selectors come from
   `live-status-transitions.spec.ts`'s `providers[]` table.
4. Side panel: gate the "Auto-send" button on per-provider
   `autoSendOptIn` setting AND `screenShareActive=false`. Show a
   running indicator + cancel button while the queue drains.
5. Fail safe: any error stops the drain, surfaces a queue-row error
   chip with retry. No silent skips.
6. Tests:
   - Unit: per-provider composer driver against fixture HTMLs.
   - Synthetic e2e: drive a fixture page with a fake "Stop button"
     toggle to simulate AI streaming. Send 3 queue items, assert
     each fires only after the previous "completed".
   - Live e2e (opt-in): real provider, single queue item, verify
     end-to-end paste + send + auto-resolve. Skip in CI; dev runs
     it manually.

## Migration / risk

- **No storage migration.** Queue items already have `status` and
  `targetId` fields — auto-send just transitions `pending` →
  `sent` → `done` (or `pending` → `failed`).
- **No new permissions.** Already have host_permissions on the
  three providers + activeTab.
- **Behavior change:** today, copying an item leaves the queue
  item visible until next capture. Auto-send transitions it
  immediately. If the user wants to bail mid-drain, they need
  Cancel — UX detail to nail down.
- **Privacy:** `screenShareSafeMode` already exists in the safety
  chain. We extend the same interlock to the auto-send path.

## Open questions for the user

1. Does the recommended P0.5-after-M1 timing work, or is auto-send
   urgent enough to interrupt M2 sequencing?
2. For the first iteration, is **single-item auto-send** (one
   button per queue item: "Send now") enough, or do you want
   **drain-the-whole-queue** as the only mode?
3. Should auto-send be a **per-thread default** (toggle on the
   thread row) or a **per-item action** (button on each queue row)?
4. When the user has the chat tab in foreground and starts typing,
   should an in-flight auto-send abort, or queue behind their
   manual input?

Once you pick on those, I can scope the M2 PR.
