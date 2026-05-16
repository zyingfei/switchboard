import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';
import { conflictForSlot, expectConflictUi } from './helpers/ui';

// Tier 6.4 — conflict UI rendering for register slot.
//
// Question: "Do conflicts show understandable choices?"
//
// Setup:
//   1. Start standalone relay; boot two companions wired to it
//      with a shared rendezvous secret.
//   2. Two extension runtimes, both seeded with the same thread.
//   3. From browser A, append a draft span. The relay propagates
//      it; B's side panel mirrors the draft.
//   4. STOP the relay (partition between A and B's companions).
//   5. From A: updateReviewDraft({ verdict: 'agree' }).
//   6. From B: updateReviewDraft({ verdict: 'partial' }).
//   7. RESTART the relay. Both companions exchange the buffered
//      events. The two verdict.set events are causally concurrent
//      → register conflict.
//
// Invariant: each side panel renders a ConflictBanner for the
// verdict slot ("Verdict has 2 versions:") with both candidate
// values reachable as picker buttons. Confirms:
//   - companion-side mergeRegister keeps both candidates,
//   - the SSE mirror at mirrorRemoteReviewDraft propagates the
//     conflict status to chrome.storage,
//   - ReviewDraftFooter renders the ConflictBanner subtree.

const threadId = 'bac_thread_t64_conflict';
const threadUrl = 'https://chatgpt.com/c/t64-conflict';
const now = '2026-05-07T05:00:00.000Z';

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

const seededThread = {
  bac_id: threadId,
  provider: 'chatgpt' as const,
  threadUrl,
  title: 'T6.4 conflict-UI fixture',
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'auto' as const,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

const anchor = {
  textQuote: { exact: 'register conflict surfaces in UI', prefix: '', suffix: '' },
  textPosition: { start: 0, end: 33 },
  cssSelector: 'main',
};

const readDraft = async (page: Page): Promise<unknown> =>
  await page.evaluate(
    async ({ key, id }) => {
      const all = await chrome.storage.local.get(key);
      const drafts = all[key] as Record<string, unknown> | undefined;
      return drafts?.[id] ?? null;
    },
    { key: 'sidetrack.reviewDrafts', id: threadId },
  );

test.describe('Tier 6.4 — conflict UI for register slot', () => {
  test('concurrent verdict.set on two replicas surfaces a ConflictBanner with both candidates', async () => {
    test.setTimeout(180_000);

    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    let runtimeA: ExtensionRuntime | undefined;
    let runtimeB: ExtensionRuntime | undefined;
    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');

      companionA = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      companionB = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });

      runtimeA = await launchExtensionRuntime({ forceLocalProfile: true });
      runtimeB = await launchExtensionRuntime({ forceLocalProfile: true });

      const pageA = await seedAndOpenSidepanel(runtimeA, {
        [SETTINGS_KEY]: settingsFor(companionA),
        [THREADS_KEY]: [seededThread],
        [WORKSTREAMS_KEY]: [],
      });
      const pageB = await seedAndOpenSidepanel(runtimeB, {
        [SETTINGS_KEY]: settingsFor(companionB),
        [THREADS_KEY]: [seededThread],
        [WORKSTREAMS_KEY]: [],
      });

      // Give the SSE clients a moment to attach before we drive
      // the first edit. Same wait shape as
      // two-browser-review-draft-sync.spec.
      await new Promise((r) => setTimeout(r, 2_500));

      // Drive a span add on A → relay → B mirrors it. Need a span
      // for the draft to exist; we don't actually use it for the
      // conflict assertion.
      assertOk(
        await runtimeA.sendRuntimeMessage(pageA, {
          type: messageTypes.appendReviewDraftSpan,
          threadUrl,
          anchor,
          quote: anchor.textQuote.exact,
          comment: 'pre-conflict span',
          capturedAt: now,
        }),
      );

      // Wait for B's side to mirror the draft (so we know the relay
      // is delivering before we partition).
      await expect.poll(async () => readDraft(pageB), { timeout: 30_000 }).not.toBeNull();

      // PARTITION. Both companions still up; only the relay is
      // gone. Outbound events buffer in each replica's transport
      // and replay on reconnect.
      await relay.stop();

      // Concurrent verdict.set on both replicas. A says agree, B
      // says partial. Each goes through the local SW →
      // updateReviewDraft handler → eventLog.appendClient on the
      // local companion. Both events get the same baseVector
      // (the pre-partition state) and neither dominates the other.
      assertOk(
        await runtimeA.sendRuntimeMessage(pageA, {
          type: messageTypes.updateReviewDraft,
          threadId,
          overall: 'A side',
          verdict: 'agree',
        }),
      );
      assertOk(
        await runtimeB.sendRuntimeMessage(pageB, {
          type: messageTypes.updateReviewDraft,
          threadId,
          overall: 'B side',
          verdict: 'partial',
        }),
      );

      // RECONNECT. Each companion's outbound transport replays
      // buffered events to the relay; the relay fans them out.
      // mergeRegister sees both candidates; projection emits
      // conflict status; SSE pushes to each extension; side
      // panels show ConflictBanner.
      await relay.restart();

      // Wait for the conflict to land in chrome.storage on both
      // sides (proxy for: relay reconnect → events flushed → both
      // projections rebuilt → SSE pushed → mirrorRemoteReviewDraft
      // wrote the conflict candidates). Without this poll the
      // expand-chip click below would race the rendering.
      await expect
        .poll(
          async () => {
            const draft = (await readDraft(pageA)) as { conflicts?: { verdict?: unknown } } | null;
            return draft?.conflicts?.verdict !== undefined;
          },
          { timeout: 20_000, intervals: [500, 1_000] },
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            const draft = (await readDraft(pageB)) as { conflicts?: { verdict?: unknown } } | null;
            return draft?.conflicts?.verdict !== undefined;
          },
          { timeout: 20_000, intervals: [500, 1_000] },
        )
        .toBe(true);

      // The ConflictBanner only mounts when the row's Review-draft
      // chip is expanded. Click it on both panels — this matches
      // the user gesture they'd take to see the draft. Switching
      // to All-threads view first makes the thread row visible
      // (the default view filters by workstream).
      await pageA.getByRole('tab', { name: 'All threads' }).click();
      await pageB.getByRole('tab', { name: 'All threads' }).click();
      await pageA.locator('.thread-review-draft-chip').first().click();
      await pageB.locator('.thread-review-draft-chip').first().click();

      // Each side panel surfaces the verdict conflict.
      await expectConflictUi(pageA, 'verdict');
      await expectConflictUi(pageB, 'verdict');

      // Both candidate values reachable as picker buttons. The
      // verdict ConflictBanner renders <button title="<label>">
      // where label comes from VERDICT_LABELS in
      // ReviewDraftFooter.tsx ("Agree", "Partial", etc.) — NOT the
      // raw verdict id. Match the user-visible label.
      await expect(conflictForSlot(pageA, 'verdict').locator('button[title="Agree"]')).toHaveCount(
        1,
      );
      await expect(
        conflictForSlot(pageA, 'verdict').locator('button[title="Partial"]'),
      ).toHaveCount(1);
      await expect(conflictForSlot(pageB, 'verdict').locator('button[title="Agree"]')).toHaveCount(
        1,
      );
      await expect(
        conflictForSlot(pageB, 'verdict').locator('button[title="Partial"]'),
      ).toHaveCount(1);
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});
