import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startCompanion, type CompanionRuntime } from '../../runtime/companion.js';
import { startRelayServer, type StartedRelayServer } from '../relayServer.js';
import { generateRendezvousSecret } from '../relayCrypto.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import type { AcceptedEvent } from '../causal.js';

// Probe — verifies that browser.timeline.observed events ferried via
// importEdgeEvent on companion A actually publish via the relay so
// companion B's timeline projection contains them. Bypasses chrome /
// playwright by talking to the companions over HTTP directly.

const reservePort = (() => {
  let next = 39_400;
  return () => next++;
})();

const post = async (url: string, bridgeKey: string, body: unknown): Promise<Response> => {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bac-bridge-key': bridgeKey,
      'Idempotency-Key': `idem-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(body),
  });
};

const getJson = async <T>(url: string, bridgeKey: string): Promise<T> => {
  const r = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
  if (!r.ok) throw new Error(`GET ${url} → ${String(r.status)}`);
  return (await r.json()) as T;
};

interface ConnectionsResponse {
  data: {
    snapshot: {
      nodes: { id: string }[];
      edges: { kind: string; fromNodeId: string; toNodeId: string }[];
    };
  };
}

const buildTimelineEvent = (
  replicaId: string,
  seq: number,
  url: string,
  observedAt: string,
  workstreamId?: string,
): AcceptedEvent => ({
  clientEventId: `${replicaId}-tl-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: observedAt.slice(0, 10),
  type: BROWSER_TIMELINE_OBSERVED,
  payload: {
    eventId: `${replicaId}-tl-${String(seq)}`,
    url,
    canonicalUrl: url,
    title: `visit ${url}`,
    observedAt,
    transition: 'activated',
    ...(workstreamId === undefined ? {} : { workstreamId }),
  },
  acceptedAtMs: Date.parse(observedAt),
});

describe('browser.timeline.observed relay sync (probe for L5 gap)', () => {
  let server: StartedRelayServer;
  let companionA: CompanionRuntime | null = null;
  let companionB: CompanionRuntime | null = null;
  let vaultA: string;
  let vaultB: string;

  beforeEach(async () => {
    server = await startRelayServer({ port: 0 });
    vaultA = await mkdtemp(join(tmpdir(), 'sidetrack-tlrs-a-'));
    vaultB = await mkdtemp(join(tmpdir(), 'sidetrack-tlrs-b-'));
  });

  afterEach(async () => {
    if (companionA !== null) await companionA.close();
    if (companionB !== null) await companionB.close();
    await server.close();
    await rm(vaultA, { recursive: true, force: true });
    await rm(vaultB, { recursive: true, force: true });
    companionA = null;
    companionB = null;
  });

  it('publishes timeline events through importEdgeEvent so peer companion sees the visit', async () => {
    const secret = generateRendezvousSecret().toString('base64url');
    const url = `ws://${server.host}:${String(server.port)}/`;
    const portA = reservePort();
    const portB = reservePort();
    companionA = await startCompanion({
      vaultPath: vaultA,
      port: portA,
      relay: { url, mode: 'remote', rendezvousSecret: secret },
    });
    companionB = await startCompanion({
      vaultPath: vaultB,
      port: portB,
      relay: { url, mode: 'remote', rendezvousSecret: secret },
    });

    // Give both transports a tick to connect+subscribe.
    await new Promise((r) => setTimeout(r, 250));

    // Post a workstream + a timeline event tagged with that workstream.
    const wsRes = await post(`${companionA.url}/v1/workstreams`, companionA.bridgeKey, {
      title: 'probe ws',
    });
    expect(wsRes.ok).toBe(true);
    const wsBody = (await wsRes.json()) as { data: { bac_id: string } };
    const wsId = wsBody.data.bac_id;

    const URL_HN = 'https://news.ycombinator.com/item?id=tlrs_probe';
    const URL_AMBIENT = 'https://copy.fail/';
    const tlRes = await post(`${companionA.url}/v1/timeline/events`, companionA.bridgeKey, {
      events: [
        buildTimelineEvent('replica-tlrs-edge-A', 1, URL_HN, '2026-05-08T10:00:00.000Z', wsId),
        buildTimelineEvent(
          'replica-tlrs-edge-A',
          2,
          URL_AMBIENT,
          '2026-05-08T10:01:00.000Z',
          wsId,
        ),
      ],
    });
    expect(tlRes.ok).toBe(true);

    // Poll companion B for both timeline-visit nodes (15s budget).
    const startedMs = Date.now();
    const wantA = `timeline-visit:${URL_HN}`;
    const wantB = `timeline-visit:${URL_AMBIENT.replace(/\/+$/u, '')}`;
    let seen = false;
    let lastBNodeIds: string[] = [];
    let lastANodeIds: string[] = [];
    while (Date.now() - startedMs < 15_000) {
      try {
        const c = await getJson<ConnectionsResponse>(
          `${companionB.url}/v1/connections`,
          companionB.bridgeKey,
        );
        lastBNodeIds = c.data.snapshot.nodes.map((n) => n.id);
        const ids = new Set(lastBNodeIds);
        if (ids.has(wantA) && ids.has(wantB)) {
          seen = true;
          break;
        }
      } catch {
        // keep polling
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!seen) {
      try {
        const cA = await getJson<ConnectionsResponse>(
          `${companionA.url}/v1/connections`,
          companionA.bridgeKey,
        );
        lastANodeIds = cA.data.snapshot.nodes.map((n) => n.id);
      } catch {
        // ignore
      }
      // eslint-disable-next-line no-console
      console.error('[probe] FINAL A nodes:', JSON.stringify(lastANodeIds));
      // eslint-disable-next-line no-console
      console.error('[probe] FINAL B nodes:', JSON.stringify(lastBNodeIds));
    }
    expect(seen).toBe(true);
  }, 30_000);
});
