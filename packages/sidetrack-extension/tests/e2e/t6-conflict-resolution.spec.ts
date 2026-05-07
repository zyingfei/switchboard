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
import { expectConflictUi, pickConflictCandidate } from './helpers/ui';

// Tier 6.5 — conflict resolution propagates A→B.
//
// Question: "Does resolving a conflict in one browser clear it
// in the other?"
//
// Setup (same as T6.4):
//   1. Standalone relay; two companions wired through it.
//   2. Two extension runtimes, both seeded with the same thread.
//   3. Add a span via A → mirror to B.
//   4. STOP relay; concurrent verdict.set on A and B.
//   5. RESTART relay; both side panels show ConflictBanner with
//      both candidates.
//
// New invariant:
//   6. On A, click the "Use 'Agree'" picker. A's onPick →
//      onUpdate({verdict: 'agree'}) → updateReviewDraft event
//      whose baseVector covers BOTH peer verdict.set events.
//   7. mergeRegister at projection time sees the new edit
//      causally dominate the two candidates → conflict collapses
//      to resolved/'agree'.
//   8. SSE pushes the resolved projection to BOTH side panels.
//   9. A's ConflictBanner clears within 5 s. B's clears too,
//      and both render a stable verdict slot.
//
// What this proves:
//   - The resolution event's deps actually cover both candidates
//     (browser computes baseVector from the chrome.storage
//     mirror of the post-conflict projection).
//   - The relay propagates the resolution event back to B.
//   - B's mirrorRemoteReviewDraft drops the conflict block
//     (conflicts === undefined).
//   - ReviewDraftFooter unmounts the ConflictBanner subtree.

const threadId = 'bac_thread_t65_resolve';
const threadUrl = 'https://chatgpt.com/c/t65-resolve';
const now = '2026-05-07T05:30:00.000Z';

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

const seededThread = {
  bac_id: threadId,
  provider: 'chatgpt' as const,
  threadUrl,
  title: 'T6.5 conflict-resolution fixture',
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'auto' as const,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

const anchor = {
  textQuote: { exact: 'resolution propagates A->B', prefix: '', suffix: '' },
  textPosition: { start: 0, end: 26 },
  cssSelector: 'main',
};

const readDraftConflict = async (page: Page): Promise<unknown> =>
  await page.evaluate(
    async ({ key, id }) => {
      const all = await chrome.storage.local.get(key);
      const drafts = all[key] as Record<string, { conflicts?: unknown }> | undefined;
      return drafts?.[id]?.conflicts ?? null;
    },
    { key: 'sidetrack.reviewDrafts', id: threadId },
  );

const readDraftVerdict = async (page: Page): Promise<unknown> =>
  await page.evaluate(
    async ({ key, id }) => {
      const all = await chrome.storage.local.get(key);
      const drafts = all[key] as Record<string, { verdict?: unknown }> | undefined;
      return drafts?.[id]?.verdict ?? null;
    },
    { key: 'sidetrack.reviewDrafts', id: threadId },
  );

test.describe('Tier 6.5 — conflict resolution propagates', () => {
  test('picking a candidate on A clears the conflict on both A and B', async () => {
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

      await new Promise((r) => setTimeout(r, 2_500));

      // Add a span on A so the draft exists on both sides.
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

      // Wait for the draft mirror on B (the span itself, not yet
      // a verdict/conflict). Polls the storage directly to avoid
      // racing the chip-render.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (key) => {
              const all = await chrome.storage.local.get(key);
              const drafts = all[key] as Record<string, unknown> | undefined;
              return drafts !== undefined && Object.keys(drafts).length > 0;
            }, 'sidetrack.reviewDrafts'),
          { timeout: 30_000 },
        )
        .toBe(true);

      // PARTITION + concurrent verdict.set.
      await relay.stop();
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

      // RECONNECT.
      await relay.restart();

      // Wait for the conflict to land on both sides in storage.
      await expect
        .poll(
          async () => {
            const c = (await readDraftConflict(pageA)) as { verdict?: unknown } | null;
            return c?.verdict !== undefined;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            const c = (await readDraftConflict(pageB)) as { verdict?: unknown } | null;
            return c?.verdict !== undefined;
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      // Open the draft on both sides so the ConflictBanner mounts.
      await pageA.getByRole('tab', { name: 'All threads' }).click();
      await pageB.getByRole('tab', { name: 'All threads' }).click();
      await pageA.locator('.thread-review-draft-chip').first().click();
      await pageB.locator('.thread-review-draft-chip').first().click();
      await expectConflictUi(pageA, 'verdict');
      await expectConflictUi(pageB, 'verdict');

      // RESOLVE. Click "Use 'Agree'" in browser A. The verdict
      // ConflictBanner's onPick maps to onUpdate({verdict: 'agree'}).
      // baseVector at emit time covers both pre-resolution
      // candidates because mirrorRemoteReviewDraft already
      // wrote the post-conflict projection.vector to storage.
      await pickConflictCandidate(pageA, 'verdict', 'Agree');

      // A's banner clears. Use a wider timeout — resolution
      // requires a full local emit + companion projection rebuild
      // + SSE → mirror cycle even on the same machine.
      await expect(
        pageA
          .locator('.review-draft-conflict')
          .filter({
            has: pageA.locator('.review-draft-conflict-label', { hasText: 'Verdict' }),
          }),
      ).toHaveCount(0, { timeout: 30_000 });

      // B's banner clears via the relay-propagated resolution
      // event. Slightly more wait than A because of round-trip.
      await expect(
        pageB
          .locator('.review-draft-conflict')
          .filter({
            has: pageB.locator('.review-draft-conflict-label', { hasText: 'Verdict' }),
          }),
      ).toHaveCount(0, { timeout: 30_000 });

      // chrome.storage on both sides must reflect the resolved
      // verdict (no conflict + value === 'agree'). Reading from
      // storage directly avoids any chrome.* DOM rendering
      // race; the SSE → mirrorRemoteReviewDraft path is the
      // load-bearing assertion here.
      await expect
        .poll(
          async () => {
            const c = (await readDraftConflict(pageA)) as { verdict?: unknown } | null;
            return c?.verdict;
          },
          { timeout: 15_000 },
        )
        .toBeUndefined();
      await expect
        .poll(
          async () => {
            const c = (await readDraftConflict(pageB)) as { verdict?: unknown } | null;
            return c?.verdict;
          },
          { timeout: 15_000 },
        )
        .toBeUndefined();
      expect(await readDraftVerdict(pageA)).toBe('agree');
      expect(await readDraftVerdict(pageB)).toBe('agree');
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});
