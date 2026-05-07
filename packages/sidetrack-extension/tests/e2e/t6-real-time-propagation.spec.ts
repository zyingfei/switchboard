import { test } from '@playwright/test';

// Tier 6.1 — cross-browser real-time propagation.
//
// Question: "Does the other browser visibly update?"
//
// BLOCKED on F9: the extension's vaultChangesClient only
// subscribes to `_BAC/review-drafts/` (entrypoints/background.ts).
// Thread state changes on a peer companion (capture.recorded →
// projection updates threads.json) never reach browser B's
// extension; B's `chrome.storage.local.sidetrack.threads` does not
// learn of the new thread without a manual reload.
//
// Until F9 lands (add `_BAC/threads/` to the SSE subscription with
// a mirrorRemoteThread setter analogous to the existing
// mirrorRemoteReviewDraft), this scenario can't pass.
//
// Test outline (will pass after F9):
//   1. Two browsers, two companions wired through a relay with a
//      shared rendezvous secret.
//   2. Both side panels open; THREADS_KEY seeded EMPTY on both.
//   3. Drive an autoCapture in browser A.
//   4. Within 5 s and WITHOUT page.reload(): browser B's side
//      panel renders a `.thread` row with the captured title.
//
// Companion-level propagation already works (proven by
// two-browser-capture-sync.spec.ts at the event-log layer); the
// missing piece is the extension-side mirror.

test.describe('Tier 6.1 — cross-browser real-time propagation', () => {
  test.skip('capture in A appears in B side panel within 5 s without manual reload (BLOCKED on F9)', async () => {
    // See header comment for the test outline. Full implementation
    // lives behind helpers/relay.ts (startTestRelay) +
    // helpers/sec.ts (quiesceUntilConverged).
  });
});
