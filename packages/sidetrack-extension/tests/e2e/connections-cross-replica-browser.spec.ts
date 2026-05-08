import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

// Layer 5 — two-browser, two-companion, relay-synced Connections e2e.
//
// Spawns:
//   - Real relay subprocess (no embedded relay).
//   - Companion A wired to that relay with rendezvous secret.
//   - Companion B wired to the same relay with the same rendezvous
//     secret. A and B sync through the relay.
//   - Two playwright-managed Chromium profiles (forceLocalProfile,
//     unique userDataDir each) — one per companion.
//
// Drives Browser A:
//   - workstream + thread + capture (with content-derived edges)
//   - dispatch
//   - timeline visits including ambient ones tagged with workstreamId
//     (Phase 4 — active-workstream attribution)
//
// Waits for the relay to ferry every accepted event from A's eventLog
// to B's, then waits for B's connections materializer to drain.
//
// Asserts Browser B's side panel renders the same workstream-centered
// subgraph: the thread, the dispatch, the timeline visits (including
// the ambient HN/copy.fail-style visit attached via
// visit_in_workstream).

const URL_HN = 'https://news.ycombinator.com/item?id=42_xrep';
const URL_AMBIENT = 'https://copy.fail/';
const URL_CHAT = 'https://chatgpt.com/c/cross_replica_thread';
const URL_PR = 'https://github.com/zyingfei/switchboard/pull/42';

const T_XR = 't_cross_replica';
const D_XR = 'd_cross_replica';

const apiPost = async (
  comp: TestCompanion,
  path: string,
  body: unknown,
): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bac-bridge-key': comp.bridgeKey,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${String(res.status)}: ${await res.text()}`);
  return await res.json();
};

const apiGet = async (comp: TestCompanion, path: string): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    headers: { 'x-bac-bridge-key': comp.bridgeKey },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${String(res.status)}: ${await res.text()}`);
  return await res.json();
};

const seedFlowOnA = async (
  compA: TestCompanion,
): Promise<{ wsId: string }> => {
  const ws = (await apiPost(compA, '/v1/workstreams', {
    title: 'Cross-replica research',
  })) as { data: { bac_id: string } };
  await apiPost(compA, '/v1/threads', {
    bac_id: T_XR,
    provider: 'chatgpt',
    threadUrl: URL_CHAT,
    title: 'Cross-replica thread',
    lastSeenAt: '2026-05-07T10:00:00.000Z',
    status: 'active',
    trackingMode: 'auto',
    primaryWorkstreamId: ws.data.bac_id,
    tags: [],
  });
  await apiPost(compA, '/v1/events', {
    threadId: T_XR,
    threadUrl: URL_CHAT,
    provider: 'chatgpt',
    title: 'Cross-replica thread',
    capturedAt: '2026-05-07T10:00:00.000Z',
    turns: [
      {
        ordinal: 0,
        role: 'user',
        text: `i'm reading ${URL_HN} for the cross-replica test.`,
        capturedAt: '2026-05-07T10:00:00.000Z',
      },
    ],
  });
  await apiPost(compA, '/v1/dispatches', {
    bac_id: D_XR,
    title: 'Cross-replica dispatch',
    kind: 'coding',
    target: { provider: 'codex', mode: 'paste' },
    workstreamId: ws.data.bac_id,
    sourceThreadId: T_XR,
    body: `let's reproduce the issue from ${URL_HN}.`,
    createdAt: '2026-05-07T10:05:00.000Z',
    mcpRequest: {
      codingSessionId: 'cs_cross_replica',
      approval: 'auto-approved',
      requestedAt: '2026-05-07T10:05:00.000Z',
    },
  });
  // Timeline visits — chat + a referenced URL + an AMBIENT one
  // (URL_AMBIENT) tagged with workstreamId. The ambient visit is
  // never referenced in any chat / dispatch / annotation; it
  // attaches purely via visit_in_workstream.
  await apiPost(compA, '/v1/timeline/events', {
    events: [
      { url: URL_CHAT, time: '2026-05-07T10:00:00.000Z', title: 'Chat' },
      { url: URL_HN, time: '2026-05-07T10:01:00.000Z', title: 'HN', workstreamId: ws.data.bac_id },
      {
        url: URL_AMBIENT,
        time: '2026-05-07T10:02:00.000Z',
        title: 'copy.fail',
        workstreamId: ws.data.bac_id,
      },
      { url: URL_PR, time: '2026-05-07T10:03:00.000Z', title: 'PR' },
    ].map((v, i) => ({
      clientEventId: `xr-tl-${String(i + 1).padStart(3, '0')}`,
      dot: { replicaId: 'replica-xr-A', seq: i + 1 },
      deps: {},
      aggregateId: '2026-05-07',
      type: 'browser.timeline.observed',
      payload: {
        eventId: `xr-tl-${String(i + 1).padStart(3, '0')}`,
        url: v.url,
        canonicalUrl: v.url,
        title: v.title,
        observedAt: v.time,
        transition: 'activated',
        ...((v as { workstreamId?: string }).workstreamId === undefined
          ? {}
          : { workstreamId: (v as { workstreamId: string }).workstreamId }),
      },
      acceptedAtMs: Date.parse(v.time),
    })),
  });
  return { wsId: ws.data.bac_id };
};

interface ConnectionsEnvelope {
  data: {
    snapshot: {
      edgeCount: number;
      nodes: Array<{ id: string }>;
      edges: Array<{ kind: string; fromNodeId: string; toNodeId: string }>;
    };
  };
}

const waitForCompanionToContain = async (
  comp: TestCompanion,
  expectedNodeId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> => {
  // Class B freshness bound is 30 s post-relay-sync; poll until the
  // node appears or we exceed the bound.
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedMs = Date.now();
  while (Date.now() - startedMs < timeoutMs) {
    const all = (await apiGet(comp, '/v1/connections')) as ConnectionsEnvelope;
    if (all.data.snapshot.nodes.some((n) => n.id === expectedNodeId)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`companion did not surface ${expectedNodeId} within ${String(timeoutMs)}ms`);
};

test.describe('connections — two-browser cross-replica sync', () => {
  test.skip(
    process.env['SIDETRACK_E2E_SKIP_LIVE_BROWSERS'] === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(300_000);

  let relay: TestRelay | null = null;
  let companionA: TestCompanion | null = null;
  let companionB: TestCompanion | null = null;
  let runtimeA: ExtensionRuntime | null = null;
  let runtimeB: ExtensionRuntime | null = null;
  let panelA: Page | null = null;
  let panelB: Page | null = null;
  let seedA: { wsId: string } | null = null;

  test.beforeAll(async () => {
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
    // Spawn both browser runtimes with forceLocalProfile so each
    // gets its own playwright-managed Chromium + extension build
    // (no shared profile-dir lock conflicts).
    runtimeA = await launchExtensionRuntime({ forceLocalProfile: true });
    runtimeB = await launchExtensionRuntime({ forceLocalProfile: true });

    // Seed the realistic flow on A.
    seedA = await seedFlowOnA(companionA);

    // Wait for B to receive every synced aggregate. With the Phase
    // 4 relay-publish fix in importEdgeEvent, timeline visits now
    // ferry through the relay too — including ambient ones tagged
    // via active-workstream attribution.
    await waitForCompanionToContain(companionB, `workstream:${seedA.wsId}`);
    await waitForCompanionToContain(companionB, `thread:${T_XR}`);
    await waitForCompanionToContain(companionB, `dispatch:${D_XR}`);
    await waitForCompanionToContain(companionB, `timeline-visit:${URL_HN}`);
    await waitForCompanionToContain(
      companionB,
      `timeline-visit:${URL_AMBIENT.replace(/\/+$/u, '')}`,
    );

    // Configure each browser to talk to its own companion.
    const openPanel = async (
      runtime: ExtensionRuntime,
      comp: TestCompanion,
    ): Promise<Page> => {
      const p = await runtime.context.newPage();
      await p.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });
      await runtime.seedStorage(p, {
        [SETUP_KEY]: true,
        [SETTINGS_KEY]: {
          companion: { port: comp.port, bridgeKey: comp.bridgeKey },
          autoTrack: false,
          siteToggles: { chatgpt: true, claude: true, gemini: true },
          notifyOnQueueComplete: true,
        },
      });
      await p.reload({ waitUntil: 'domcontentloaded' });
      await expect(p.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
        timeout: 30_000,
      });
      await p.getByRole('tab', { name: 'Connections' }).click();
      await expect(p.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
      return p;
    };
    panelA = await openPanel(runtimeA, companionA);
    panelB = await openPanel(runtimeB, companionB);
  });

  test.afterAll(async () => {
    if (companionA !== null) await companionA.close();
    if (companionB !== null) await companionB.close();
    if (runtimeA !== null) await runtimeA.close();
    if (runtimeB !== null) await runtimeB.close();
    if (relay !== null) await relay.close();
    relay = null;
    companionA = null;
    companionB = null;
    runtimeA = null;
    runtimeB = null;
    panelA = null;
    panelB = null;
    seedA = null;
  });

  test('Browser B side panel renders the same workstream subgraph + ambient visits + dispatch edges', async () => {
    if (panelB === null || seedA === null) throw new Error('beforeAll did not run');
    const wsId = seedA.wsId;
    const input = panelB.getByTestId('connections-anchor-input');
    await input.click();
    await input.fill(`workstream:${wsId}`);
    await input.press('Enter');
    await expect(panelB.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
    // Direct neighbors at hops=1 from the workstream — must include
    // the thread (event-derived) AND the tagged ambient timeline
    // visits (visit_in_workstream, Phase 4) AND the dispatch
    // (dispatch_in_workstream emitted from DISPATCH_RECORDED, Phase 4
    // cross-replica fix).
    await expect(panelB.getByTestId(`node-thread:${T_XR}`)).toBeVisible();
    await expect(panelB.getByTestId(`node-dispatch:${D_XR}`)).toBeVisible();
    await expect(panelB.getByTestId(`node-timeline-visit:${URL_HN}`)).toBeVisible();
    await expect(
      panelB.getByTestId(`node-timeline-visit:${URL_AMBIENT.replace(/\/+$/u, '')}`),
    ).toBeVisible();
    // Snapshot-level checks that the structural edges all came
    // across the relay event log (no JSONL on B).
    if (companionB === null) throw new Error('companion B not started');
    const all = (await apiGet(companionB, '/v1/connections')) as ConnectionsEnvelope;
    const edgeKindsPresent = new Set(all.data.snapshot.edges.map((e) => e.kind));
    expect(edgeKindsPresent.has('thread_in_workstream')).toBe(true);
    expect(edgeKindsPresent.has('dispatch_from_thread')).toBe(true);
    expect(edgeKindsPresent.has('dispatch_in_workstream')).toBe(true);
    expect(edgeKindsPresent.has('dispatch_requested_coding_session')).toBe(true);
    expect(edgeKindsPresent.has('visit_in_workstream')).toBe(true);
    // Specifically: visit_in_workstream from the AMBIENT (never-
    // referenced) URL_AMBIENT visit to the workstream — this is the
    // load-bearing assertion for Phase 4 ambient-browsing closure
    // across the relay.
    expect(
      all.data.snapshot.edges.some(
        (e) =>
          e.kind === 'visit_in_workstream' &&
          e.fromNodeId === `timeline-visit:${URL_AMBIENT.replace(/\/+$/u, '')}` &&
          e.toNodeId === `workstream:${wsId}`,
      ),
    ).toBe(true);
  });

  test('Browser A panel still renders its own snapshot (no cross-talk regression)', async () => {
    if (panelA === null || seedA === null) throw new Error('beforeAll did not run');
    const input = panelA.getByTestId('connections-anchor-input');
    await input.click();
    await input.fill(`workstream:${seedA.wsId}`);
    await input.press('Enter');
    await expect(panelA.getByTestId('connections-groups')).toBeVisible({ timeout: 15_000 });
    await expect(panelA.getByTestId(`node-thread:${T_XR}`)).toBeVisible();
    // A has the dispatch JSONL locally so it's at 1-hop directly.
    await expect(panelA.getByTestId(`node-dispatch:${D_XR}`)).toBeVisible();
  });
});
