import { createServer } from 'node:http';

import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';
import { startTestCompanion, type TestCompanion } from './helpers/companion';

const threadId = 'bac_thread_two_browser_sync';
const threadUrl = 'https://chatgpt.com/c/two-browser-sync';
const now = '2026-05-06T18:00:00.000Z';

const thread = {
  bac_id: threadId,
  provider: 'chatgpt' as const,
  threadUrl,
  title: 'Two-browser sync E2E',
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'manual' as const,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

const anchor = {
  textQuote: {
    exact: 'causal sync keeps offline edits ordered',
    prefix: 'The important part is that ',
    suffix: ' across replicas.',
  },
  textPosition: { start: 27, end: 66 },
  cssSelector: 'main',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const reservePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not reserve relay test port.'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

const readDraft = async (page: Page): Promise<unknown> =>
  await page.evaluate(
    async ({ draftsKey, id }) => {
      const all = await chrome.storage.local.get(draftsKey);
      const drafts = all[draftsKey] as Record<string, unknown> | undefined;
      return drafts?.[id] ?? null;
    },
    { draftsKey: 'sidetrack.reviewDrafts', id: threadId },
  );

const readQueueLength = async (page: Page): Promise<number> =>
  await page.evaluate(async () => {
    const all = await chrome.storage.local.get('sidetrack.outbox.reviewDrafts');
    const queue = all['sidetrack.outbox.reviewDrafts'];
    return Array.isArray(queue) ? queue.length : 0;
  });

test.describe('two-browser review-draft sync over relay', () => {
  test('two browsers edit and discard one draft through two companions and a local relay', async () => {
    test.setTimeout(120_000);

    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    let runtimeA: ExtensionRuntime | undefined;
    let runtimeB: ExtensionRuntime | undefined;

    try {
      const relayPort = await reservePort();
      const relayUrl = `ws://127.0.0.1:${String(relayPort)}/`;
      const secret = generateRendezvousSecret().toString('base64url');

      companionA = await startTestCompanion({
        syncRelayLocalPort: relayPort,
        syncRendezvousSecret: secret,
      });
      companionB = await startTestCompanion({
        syncRelay: relayUrl,
        syncRendezvousSecret: secret,
      });

      runtimeA = await launchExtensionRuntime({ forceLocalProfile: true });
      runtimeB = await launchExtensionRuntime({ forceLocalProfile: true });

      const pageA = await seedAndOpenSidepanel(runtimeA, {
        [SETTINGS_KEY]: settingsFor(companionA),
        [THREADS_KEY]: [thread],
        [WORKSTREAMS_KEY]: [],
      });
      const pageB = await seedAndOpenSidepanel(runtimeB, {
        [SETTINGS_KEY]: settingsFor(companionB),
        [THREADS_KEY]: [thread],
        [WORKSTREAMS_KEY]: [],
      });

      // The review-draft SSE client starts before settings are seeded, so give
      // its retry loop one pass to reconnect with the companion credentials.
      await sleep(2_500);

      const append = await runtimeA.sendRuntimeMessage(pageA, {
        type: messageTypes.appendReviewDraftSpan,
        threadUrl,
        anchor,
        quote: anchor.textQuote.exact,
        comment: 'Browser A span comment',
        capturedAt: now,
      });
      assertOk(append);

      const update = await runtimeA.sendRuntimeMessage(pageA, {
        type: messageTypes.updateReviewDraft,
        threadId,
        overall: 'Browser A overall note',
        verdict: 'agree',
      });
      assertOk(update);

      await expect.poll(() => readQueueLength(pageA), { timeout: 15_000 }).toBe(0);

      await expect
        .poll(
          async () => {
            const draft = await readDraft(pageB);
            if (typeof draft !== 'object' || draft === null) return null;
            return draft;
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          threadId,
          threadUrl,
          overall: 'Browser A overall note',
          verdict: 'agree',
          spans: [
            {
              quote: anchor.textQuote.exact,
              comment: 'Browser A span comment',
            },
          ],
        });

      const projectionResponse = await fetch(
        `http://127.0.0.1:${String(companionB.port)}/v1/review-drafts/${threadId}`,
        { headers: { 'x-bac-bridge-key': companionB.bridgeKey } },
      );
      expect(projectionResponse.ok).toBe(true);
      const projection = (await projectionResponse.json()) as unknown;
      expect(projection).toMatchObject({
        data: {
          threadId,
          threadUrl,
          overall: { status: 'resolved', value: 'Browser A overall note' },
          verdict: { status: 'resolved', value: 'agree' },
        },
      });

      const mirroredDraft = await readDraft(pageB);
      expect(mirroredDraft).toMatchObject({
        spans: [{ quote: anchor.textQuote.exact }],
      });
      const spanId = (mirroredDraft as { spans: readonly { bac_id: string }[] }).spans[0]?.bac_id;
      expect(typeof spanId).toBe('string');

      const commentEdit = await runtimeB.sendRuntimeMessage(pageB, {
        type: messageTypes.setReviewDraftSpanComment,
        threadId,
        spanId,
        comment: 'Browser B refined the span comment',
      });
      assertOk(commentEdit);

      const bUpdate = await runtimeB.sendRuntimeMessage(pageB, {
        type: messageTypes.updateReviewDraft,
        threadId,
        overall: 'Browser B follow-up note after seeing A',
        verdict: 'partial',
      });
      assertOk(bUpdate);
      await expect.poll(() => readQueueLength(pageB), { timeout: 15_000 }).toBe(0);

      await expect
        .poll(
          async () => {
            const draft = await readDraft(pageA);
            if (typeof draft !== 'object' || draft === null) return null;
            return draft;
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          threadId,
          threadUrl,
          overall: 'Browser B follow-up note after seeing A',
          verdict: 'partial',
          spans: [
            {
              quote: anchor.textQuote.exact,
              comment: 'Browser B refined the span comment',
            },
          ],
        });

      const discard = await runtimeA.sendRuntimeMessage(pageA, {
        type: messageTypes.discardReviewDraft,
        threadId,
      });
      assertOk(discard);
      await expect.poll(() => readQueueLength(pageA), { timeout: 15_000 }).toBe(0);
      await expect.poll(() => readDraft(pageB), { timeout: 30_000 }).toBeNull();
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
    }
  });
});
