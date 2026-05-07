import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

// Browser-A captures via the extension's autoCapture path; we then
// expect the same capture.recorded event to land on the OTHER
// vault's per-replica log (under A's replicaId) via the relay. This
// proves the full path:
//
//   ext A queue → companion A /v1/events → eventLog.appendClient
//     → relay publish → companion B importPeerEvent
//     → companion B's _BAC/log/<A-replicaId>/*.jsonl
//
// The companion-side smoke I ran in Phase 2 used curl to skip the
// extension queue. This test is the missing link: it goes through
// the extension queue + extension-side fetch + companion HTTP
// surface, which is what catches regressions in the
// queue/idempotency/intent-flag wiring.

const threadId = 'bac_thread_two_browser_capture';
const threadUrl = 'https://chatgpt.com/c/two-browser-capture';
const now = '2026-05-07T01:30:00.000Z';

const thread = {
  bac_id: threadId,
  provider: 'chatgpt' as const,
  threadUrl,
  title: 'Two-browser capture sync',
  lastSeenAt: now,
  status: 'active' as const,
  // 'auto' (not 'manual') so the autoCapture gate in background.ts
  // forwards the synthetic event to storeCaptureEvent → companion.
  // 'manual' would silently drop on the early-return at line 1763.
  trackingMode: 'auto' as const,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

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

interface FoundCaptureEvent {
  readonly clientEventId: unknown;
  readonly type: unknown;
  readonly dot?: { readonly replicaId?: unknown; readonly seq?: unknown };
  readonly payload?: { readonly threadId?: unknown; readonly threadUrl?: unknown };
}

// Walks `<vault>/_BAC/log/<*replicaId*>/*.jsonl` returning every
// capture.recorded event whose payload.threadUrl matches. We match
// by URL rather than threadId because the autoCapture extension
// path doesn't send a threadId field — the companion assigns its
// own bac_id at write time, and payload.threadId is only populated
// when the input carried one. threadUrl is the only stable
// identifier available end-to-end.
const findCaptureForThreadUrl = async (
  vaultRoot: string,
  matchThreadUrl: string,
): Promise<FoundCaptureEvent[]> => {
  const logRoot = path.join(vaultRoot, '_BAC', 'log');
  const replicaDirs = await readdir(logRoot).catch(() => [] as readonly string[]);
  const found: FoundCaptureEvent[] = [];
  for (const replicaDir of replicaDirs) {
    const fullDir = path.join(logRoot, replicaDir);
    const files = await readdir(fullDir).catch(() => [] as readonly string[]);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const raw = await readFile(path.join(fullDir, file), 'utf8').catch(() => '');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed = JSON.parse(trimmed) as FoundCaptureEvent;
          if (parsed.type !== 'capture.recorded') continue;
          if (parsed.payload?.threadUrl === matchThreadUrl) {
            found.push(parsed);
          }
        } catch {
          // Skip malformed lines.
        }
      }
    }
  }
  return found;
};

test.describe('two-browser capture sync over relay', () => {
  test('capture posted via the extension queue in browser A lands on companion B as a peer event', async () => {
    test.setTimeout(120_000);

    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    let runtimeA: ExtensionRuntime | undefined;
    let runtimeB: ExtensionRuntime | undefined;

    try {
      const relayPort = await reservePort();
      const relayUrl = `ws://127.0.0.1:${String(relayPort)}/`;
      const secret = generateRendezvousSecret().toString('base64url');

      // companion-A hosts the relay so we don't need a third
      // process; companion-B connects to it as a remote relay,
      // mirroring the most common production topology (one host,
      // one or more remote peers).
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
      await seedAndOpenSidepanel(runtimeB, {
        [SETTINGS_KEY]: settingsFor(companionB),
        [THREADS_KEY]: [thread],
        [WORKSTREAMS_KEY]: [],
      });

      // The relay-client SSE/WS reconnect loop kicks in slightly
      // after settings are seeded. Same wait shape the review-draft
      // two-browser test uses.
      await new Promise((r) => setTimeout(r, 2_500));

      // Drive a synthetic capture into A's background via
      // autoCapture (queue-lifecycle.spec uses this exact pattern
      // because the test fixture isn't on chatgpt.com — the
      // captureCurrentTab path requires a real chatgpt content
      // script).
      const captureResponse = await runtimeA.sendRuntimeMessage(pageA, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'chatgpt',
          threadUrl,
          title: 'Two-browser capture sync',
          capturedAt: now,
          turns: [
            {
              role: 'user',
              text: 'recall me on the other side via the relay',
              ordinal: 0,
              capturedAt: now,
            },
            {
              role: 'assistant',
              text: 'I will appear in browser B via peer sync.',
              ordinal: 1,
              capturedAt: now,
            },
          ],
        },
      });
      assertOk(captureResponse);

      // First confirm the capture reached companion-A. The
      // assertion below differentiates a "extension didn't post"
      // failure (this poll times out) from a "post worked but
      // relay didn't" failure (the next poll times out). Without
      // splitting them we'd have to dig through trace.zip to
      // distinguish.
      await expect
        .poll(
          async () => {
            const events = await findCaptureForThreadUrl(companionA!.vaultPath, threadUrl);
            return events.length;
          },
          { timeout: 10_000, intervals: [500, 1_000] },
        )
        .toBeGreaterThan(0);

      // Now poll B's vault for the same event imported via the
      // relay. Walks per-replica subdirs under _BAC/log/ and
      // matches by payload.threadUrl (we don't know A's replicaId
      // up front — findCaptureForThreadUrl does the discovery).
      // expect.poll returns void; we re-fetch the events after the
      // assertion to inspect the actual record contents below.
      await expect
        .poll(
          async () => {
            const events = await findCaptureForThreadUrl(companionB!.vaultPath, threadUrl);
            return events.length;
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toBeGreaterThan(0);

      // Causal-lineage invariant: the synced event on B carries
      // A's replicaId in dot.replicaId, NOT B's. If the relay
      // re-stamped it with B's replicaId we'd lose attribution
      // and idempotent-replay would break.
      const events = await findCaptureForThreadUrl(companionB.vaultPath, threadUrl);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const byReplica = (events[0]?.dot?.replicaId ?? '') as string;
      expect(typeof byReplica).toBe('string');
      expect(byReplica.length).toBeGreaterThan(0);
      // Confirm the matching replicaId is present as a directory
      // under B's _BAC/log/ — i.e. the foreign event is filed under
      // its origin replicaId, not under B's own.
      const replicaDirs = await readdir(path.join(companionB.vaultPath, '_BAC', 'log'));
      expect(replicaDirs).toContain(byReplica);
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
    }
  });
});
