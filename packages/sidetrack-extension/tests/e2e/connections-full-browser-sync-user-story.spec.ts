import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { installLlmNetworkMock, type LlmNetworkMock } from './helpers/llm-network-mock';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

const CODEX_COLLECTOR_ID = 'sidetrack.codex-cli';

const VISITS = [
  {
    url: 'https://eval.sidetrack.local/postgres/sidetrack_eval_postgres/merge-a',
    title: 'sidetrack_eval_postgres merge concurrency write skew',
    body: 'sidetrack_eval_postgres merge concurrency write skew with row locking notes',
  },
  {
    url: 'https://eval.sidetrack.local/postgres/sidetrack_eval_postgres/merge-b',
    title: 'sidetrack_eval_postgres merge lock ordering diagnostics',
    body: 'sidetrack_eval_postgres lock ordering diagnostics and retry analysis',
  },
  {
    url: 'https://eval.sidetrack.local/postgres/sidetrack_eval_postgres/merge-c',
    title: 'sidetrack_eval_postgres merge retry plan',
    body: 'sidetrack_eval_postgres retry plan for serializable transactions',
  },
  {
    url: 'https://eval.sidetrack.local/kubernetes/sidetrack_eval_kubernetes/eviction-a',
    title: 'sidetrack_eval_kubernetes pod eviction pressure',
    body: 'sidetrack_eval_kubernetes pod eviction pressure and scheduler diagnostics',
  },
  {
    url: 'https://eval.sidetrack.local/kubernetes/sidetrack_eval_kubernetes/eviction-b',
    title: 'sidetrack_eval_kubernetes pod restart budget',
    body: 'sidetrack_eval_kubernetes restart budget and disruption planning',
  },
  {
    url: 'https://eval.sidetrack.local/accounting/sidetrack_eval_negative/invoice-aging',
    title: 'sidetrack_eval_negative invoice aging reconciliation',
    body: 'sidetrack_eval_negative invoice aging reconciliation unrelated accounting work',
  },
  {
    url: 'https://copy.fail/',
    title: 'copy.fail ambient clipboard research',
    body: 'Ambient browser visit while the workstream stays focused in Sidetrack.',
  },
] as const;

const ALL_URLS = VISITS.map((visit) => visit.url);

interface ConnectionNode {
  readonly id: string;
  readonly kind: string;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
}

interface ConnectionEdge {
  readonly id: string;
  readonly kind: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly confidence?: string;
  readonly producedBy?: {
    readonly source?: string;
    readonly revisionId?: string;
    readonly kind?: string;
  };
  readonly metadata?: Record<string, unknown>;
}

interface ConnectionsEnvelope {
  readonly data: {
    readonly snapshot: {
      readonly nodes: readonly ConnectionNode[];
      readonly edges: readonly ConnectionEdge[];
    };
  };
}

interface FeedbackProjectionEnvelope {
  readonly data: {
    readonly positiveLabels: readonly { readonly fromId: string; readonly toId: string }[];
    readonly negativeLabels: readonly { readonly fromId: string; readonly toId: string }[];
  };
}

interface RetrainEnvelope {
  readonly data:
    | {
        readonly status: 'trained';
        readonly revisionId: string;
        readonly candidateCount: number;
      }
    | {
        readonly status: 'skipped' | 'failed';
        readonly reason?: string;
        readonly error?: string;
      };
}

interface CollectorsEnvelope {
  readonly collectors: readonly {
    readonly collector_id: string;
    readonly status: 'loaded' | 'load-failed';
    readonly last_promoted_at: string | null;
    readonly quarantine_count: number;
  }[];
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/u, '');

const visitNodeId = (url: string): string => `timeline-visit:${stripTrailingSlash(url)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const apiGet = async (comp: TestCompanion, path: string): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    headers: { 'x-bac-bridge-key': comp.bridgeKey },
  });
  if (!res.ok)
    throw new Error(`GET ${path} failed with ${String(res.status)}: ${await res.text()}`);
  return await res.json();
};

const apiPost = async (comp: TestCompanion, path: string, body: unknown): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bac-bridge-key': comp.bridgeKey,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed with ${String(res.status)}: ${await res.text()}`);
  }
  return await res.json();
};

const waitForConnections = async (
  comp: TestCompanion,
  predicate: (env: ConnectionsEnvelope) => boolean,
  message: string,
  timeoutMs = 90_000,
): Promise<ConnectionsEnvelope> => {
  const startedMs = Date.now();
  let latest: ConnectionsEnvelope | null = null;
  while (Date.now() - startedMs < timeoutMs) {
    latest = (await apiGet(comp, '/v1/connections')) as ConnectionsEnvelope;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}; latest=${JSON.stringify(latest?.data.snapshot ?? null)}`);
};

const waitForCondition = async (
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 90_000,
): Promise<void> => {
  const startedMs = Date.now();
  while (Date.now() - startedMs < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
};

const edgeConnects = (edge: ConnectionEdge, left: string, right: string): boolean =>
  (edge.fromNodeId === left && edge.toNodeId === right) ||
  (edge.fromNodeId === right && edge.toNodeId === left);

const topContributionCount = (edge: ConnectionEdge): number => {
  const raw = edge.metadata?.topContributions;
  return Array.isArray(raw) ? raw.length : 0;
};

const feedbackCapableEdges = (env: ConnectionsEnvelope): readonly ConnectionEdge[] =>
  env.data.snapshot.edges.filter(
    (edge) =>
      edge.kind === 'closest_visit' ||
      edge.kind === 'visit_resembles_visit' ||
      edge.kind === 'visit_continues_visit',
  );

const postFlowFeedback = async (
  comp: TestCompanion,
  input: {
    readonly choice: 'confirm' | 'reject';
    readonly relationKind: 'closest_visit' | 'visit_resembles_visit' | 'visit_continues_visit';
    readonly fromId: string;
    readonly toId: string;
  },
): Promise<void> => {
  await apiPost(comp, '/v1/feedback/events', {
    type: input.choice === 'confirm' ? 'user.flow.confirmed' : 'user.flow.rejected',
    payload: {
      payloadVersion: 1,
      relationKind: input.relationKind,
      fromId: input.fromId,
      toId: input.toId,
      ...(input.choice === 'reject' ? { reason: 'not-related' } : {}),
    },
  });
};

const postBootstrapFeedbackLabels = async (
  comp: TestCompanion,
): Promise<{
  readonly positive: { readonly fromId: string; readonly toId: string };
  readonly negative: { readonly fromId: string; readonly toId: string };
}> => {
  const positive = {
    fromId: visitNodeId(VISITS[0].url),
    toId: visitNodeId(VISITS[1].url),
  };
  const secondPositive = {
    fromId: visitNodeId(VISITS[0].url),
    toId: visitNodeId(VISITS[2].url),
  };
  const negative = {
    fromId: visitNodeId(VISITS[0].url),
    toId: visitNodeId(VISITS[6].url),
  };
  const secondNegative = {
    fromId: visitNodeId(VISITS[0].url),
    toId: visitNodeId(VISITS[5].url),
  };
  for (const pair of [positive, secondPositive]) {
    await postFlowFeedback(comp, {
      choice: 'confirm',
      relationKind: 'closest_visit',
      ...pair,
    });
  }
  for (const pair of [negative, secondNegative]) {
    await postFlowFeedback(comp, {
      choice: 'reject',
      relationKind: 'closest_visit',
      ...pair,
    });
  }
  return { positive, negative };
};

const clickVisibleEdge = async (panel: Page, edge: ConnectionEdge): Promise<void> => {
  const row = panel.getByTestId(`edge-${edge.id}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
};

const setConnectionsAnchor = async (panel: Page, anchorId: string, hops = '2'): Promise<void> => {
  const input = panel.getByTestId('connections-anchor-input');
  await input.click();
  await input.fill(anchorId);
  await input.press('Enter');
  await panel.getByTestId('connections-hops-select').selectOption(hops);
  await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
};

const openConnectionsPanel = async (
  runtime: ExtensionRuntime,
  comp: TestCompanion,
  activeWorkstreamId?: string,
): Promise<Page> => {
  const panel = await runtime.context.newPage();
  await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await runtime.seedStorage(panel, {
    [SETUP_KEY]: true,
    [SETTINGS_KEY]: {
      companion: { port: comp.port, bridgeKey: comp.bridgeKey },
      autoTrack: false,
      siteToggles: { chatgpt: true, claude: true, gemini: true },
      notifyOnQueueComplete: true,
    },
    ...(activeWorkstreamId === undefined
      ? {}
      : { 'sidetrack.activeWorkstreamId': activeWorkstreamId }),
  });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
    timeout: 30_000,
  });
  await panel.getByRole('tab', { name: 'Connections' }).click();
  await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
  return panel;
};

const installVisitRoutes = async (runtime: ExtensionRuntime): Promise<void> => {
  await runtime.context.route(/^https?:\/\//u, async (route) => {
    const requestUrl = stripTrailingSlash(route.request().url());
    const visit = VISITS.find((candidate) => stripTrailingSlash(candidate.url) === requestUrl);
    if (visit === undefined) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><title>${visit.title}</title></head>
          <body>
            <main>
              <h1>${visit.title}</h1>
              <p id="copy-source">${visit.body}</p>
              <textarea id="paste-target" aria-label="Paste target"></textarea>
              <div style="height: 1800px"></div>
            </main>
          </body>
        </html>`,
    });
  });
};

const drainTimeline = async (
  runtime: ExtensionRuntime,
  page: Page,
  expectedAtLeast: number,
): Promise<void> => {
  let latest: unknown = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    latest = await runtime.sendRuntimeMessage(page, {
      type: 'sidetrack.timeline.force-drain',
    });
    const result = latest as {
      ok?: boolean;
      drain?: { uploaded?: number; remaining?: number };
    } | null;
    if (result !== null && result.ok === true && (result.drain?.uploaded ?? 0) >= expectedAtLeast) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `timeline force drain did not upload ${String(expectedAtLeast)} visits: ${JSON.stringify(latest)}`,
  );
};

const performCopyPasteBestEffort = async (source: Page, destination: Page): Promise<void> => {
  await source.evaluate(() => {
    window.scrollBy(0, 700);
    const sourceNode = document.querySelector('#copy-source');
    if (sourceNode === null) return;
    const range = document.createRange();
    range.selectNodeContents(sourceNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await source.keyboard
    .press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
    .catch(() => undefined);
  await source
    .evaluate(async () => {
      await navigator.clipboard?.writeText('sidetrack L5 copied snippet').catch(() => undefined);
    })
    .catch(() => undefined);

  const target = destination.locator('#paste-target');
  await target.click().catch(() => undefined);
  await destination.keyboard
    .press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    .catch(() => undefined);
  await destination
    .evaluate(() => {
      const target = document.querySelector('#paste-target');
      if (!(target instanceof HTMLTextAreaElement)) return;
      target.value = `${target.value} sidetrack L5 copied snippet`;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('paste', { bubbles: true }));
    })
    .catch(() => undefined);
};

const driveBrowserAVisits = async (runtime: ExtensionRuntime): Promise<void> => {
  const researchTab = await runtime.context.newPage();
  await researchTab.goto(VISITS[0].url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await researchTab
    .evaluate(() => window.scrollBy(0, document.body.scrollHeight / 2))
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));

  await researchTab.goto(VISITS[1].url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const pasteTab = await runtime.context.newPage();
  await pasteTab.goto(VISITS[2].url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await performCopyPasteBestEffort(researchTab, pasteTab);
  await new Promise((resolve) => setTimeout(resolve, 500));

  await pasteTab.close();
  await researchTab.close();

  for (const visit of VISITS.slice(3)) {
    const page = await runtime.context.newPage();
    await page.goto(visit.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.close();
  }
};

const collectorManifest = (): string => `id = "${CODEX_COLLECTOR_ID}"
name = "Sidetrack Codex CLI"
version = "0.1.0"
manifest_schema = 1

[compatibility]
requires-companion = ">=1.0.0 <2.0.0"
requires-vault = 1

[[emits]]
event_type = "session_started"
payload_version = 1
stability = "alpha"

[[emits]]
event_type = "session_turn"
payload_version = 1
stability = "alpha"

[io]
rotation = "daily"

[capabilities]
reads-paths = []
reads-env = []
reads-network = false
default-enabled = true

[process]
managed-by = "user"
`;

const collectorLine = (input: {
  readonly eventType: 'session_started' | 'session_turn';
  readonly emittedAt: string;
  readonly runId: string;
  readonly sourceRecordId: string;
  readonly payload: Record<string, unknown>;
}): string =>
  JSON.stringify({
    collector_id: CODEX_COLLECTOR_ID,
    event_type: input.eventType,
    payload_version: 1,
    emitted_at: input.emittedAt,
    collector_version: '0.1.0',
    collector_run_id: input.runId,
    source_record_id: input.sourceRecordId,
    payload: input.payload,
  });

const waitForCollectorLoaded = async (comp: TestCompanion): Promise<void> => {
  await waitForCondition(async () => {
    const env = (await apiGet(comp, '/v1/collectors')) as CollectorsEnvelope;
    return env.collectors.some(
      (collector) => collector.collector_id === CODEX_COLLECTOR_ID && collector.status === 'loaded',
    );
  }, 'Codex collector manifest was not loaded');
};

const waitForCollectorPromotion = async (comp: TestCompanion): Promise<void> => {
  await waitForCondition(async () => {
    const env = (await apiGet(comp, '/v1/collectors')) as CollectorsEnvelope;
    return env.collectors.some(
      (collector) =>
        collector.collector_id === CODEX_COLLECTOR_ID &&
        collector.status === 'loaded' &&
        collector.last_promoted_at !== null &&
        collector.quarantine_count === 0,
    );
  }, 'Codex collector inbox lines were not promoted');
};

const writeCodexCollectorFixture = async (
  vaultPath: string,
  comp: TestCompanion,
): Promise<void> => {
  const manifestDir = join(vaultPath, '_BAC', 'collectors', CODEX_COLLECTOR_ID);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, 'collector.toml'), collectorManifest(), 'utf8');
  await waitForCollectorLoaded(comp);

  const now = Date.now();
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
  const runId = `run-${randomUUID()}`;
  const sessions = ['codex-l5-alpha', 'codex-l5-beta'] as const;
  const lines = [
    collectorLine({
      eventType: 'session_started',
      emittedAt: iso(-40_000),
      runId,
      sourceRecordId: sessions[0],
      payload: {
        session_id: sessions[0],
        started_at: iso(-40_000),
        cwd: '/repo/browser-ai-companion',
        model: 'gpt-5-codex',
      },
    }),
    collectorLine({
      eventType: 'session_started',
      emittedAt: iso(-35_000),
      runId,
      sourceRecordId: sessions[1],
      payload: {
        session_id: sessions[1],
        started_at: iso(-35_000),
        cwd: '/repo/browser-ai-companion',
        model: 'gpt-5-codex',
      },
    }),
    ...[0, 1, 2, 3].map((turn) => {
      const sessionId = sessions[turn % sessions.length];
      return collectorLine({
        eventType: 'session_turn',
        emittedAt: iso(-30_000 + turn * 2_000),
        runId,
        sourceRecordId: `${sessionId}:${String(turn)}`,
        payload: {
          session_id: sessionId,
          turn_index: turn,
          started_at: iso(-30_000 + turn * 2_000),
          completed_at: iso(-29_000 + turn * 2_000),
          model: 'gpt-5-codex',
          prompt_text: `Implement L5 full browser sync step ${String(turn)}`,
          response_text: `Completed L5 full browser sync step ${String(turn)}`,
          tool_call_count: 2,
          exec_command_count: 1,
        },
      });
    }),
  ];

  const dateStamp = new Date().toISOString().slice(0, 10);
  const inboxDir = join(vaultPath, '_BAC', 'inbox', CODEX_COLLECTOR_ID);
  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, `${dateStamp}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  await apiPost(comp, `/v1/collectors/${CODEX_COLLECTOR_ID}/replay`, {});
  await waitForCollectorPromotion(comp);
};

const readJsonlLogEvents = async (
  vaultPath: string,
): Promise<readonly Record<string, unknown>[]> => {
  const root = join(vaultPath, '_BAC', 'log');
  const out: Record<string, unknown>[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries: readonly {
      readonly name: string;
      readonly isDirectory: () => boolean;
      readonly isFile: () => boolean;
    }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const raw = await readFile(fullPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) out.push(parsed);
      }
    }
  };

  await visit(root);
  return out;
};

const hasCodingTurn = async (vaultPath: string): Promise<boolean> => {
  const events = await readJsonlLogEvents(vaultPath);
  return events.some((event) => {
    if (event['type'] === 'coding.session.turn.observed') return true;
    const payload = event['payload'];
    return isRecord(payload) && payload['type'] === 'coding.session.turn.observed';
  });
};

test.describe('connections - full browser sync user story (Stage 1 + 2/3 + 4 composed)', () => {
  test.skip(
    process.env['SIDETRACK_E2E_SKIP_LIVE_BROWSERS'] === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(600_000);

  let relay: TestRelay | null = null;
  let companionA: TestCompanion | null = null;
  let companionB: TestCompanion | null = null;
  let runtimeA: ExtensionRuntime | null = null;
  let runtimeB: ExtensionRuntime | null = null;
  let llmMockA: LlmNetworkMock | null = null;
  let llmMockB: LlmNetworkMock | null = null;

  test.afterAll(async () => {
    if (runtimeA !== null) await runtimeA.close();
    if (runtimeB !== null) await runtimeB.close();
    if (companionA !== null) await companionA.close();
    if (companionB !== null) await companionB.close();
    if (relay !== null) await relay.close();
    runtimeA = null;
    runtimeB = null;
    companionA = null;
    companionB = null;
    relay = null;
  });

  test('syncs A browser activity and collector events to B with feedback/ranker surfaces', async () => {
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
    llmMockA = await installLlmNetworkMock(runtimeA.context);
    llmMockB = await installLlmNetworkMock(runtimeB.context);
    await installVisitRoutes(runtimeA);
    await installVisitRoutes(runtimeB);

    const wsRes = (await apiPost(companionA, '/v1/workstreams', {
      title: 'Full sync research',
    })) as { data: { bac_id: string } };
    const wsId = wsRes.data.bac_id;

    const panelA = await openConnectionsPanel(runtimeA, companionA, wsId);
    await runtimeA.seedStorage(panelA, {
      'sidetrack.timeline.enabled': true,
      'sidetrack.activeWorkstreamId': wsId,
    });
    const reinit = await runtimeA.sendRuntimeMessage(panelA, {
      type: 'sidetrack.timeline.reinit',
    });
    expect((reinit as { ok?: boolean } | null)?.ok).toBe(true);

    await driveBrowserAVisits(runtimeA);
    const drainSender = await runtimeA.context.newPage();
    await drainSender.goto(`chrome-extension://${runtimeA.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await drainTimeline(runtimeA, drainSender, ALL_URLS.length);
    await drainSender.close();

    await writeCodexCollectorFixture(companionA.vaultPath, companionA);

    const expectedVisitIds = ALL_URLS.map(visitNodeId);
    await waitForConnections(
      companionA,
      (env) => {
        const ids = new Set(env.data.snapshot.nodes.map((node) => node.id));
        return expectedVisitIds.every((id) => ids.has(id));
      },
      'Browser A visits did not materialize in companion A',
    );

    const syncedEnv = await waitForConnections(
      companionB,
      (env) => {
        const ids = new Set(env.data.snapshot.nodes.map((node) => node.id));
        return ids.has(`workstream:${wsId}`) && expectedVisitIds.every((id) => ids.has(id));
      },
      'Browser B did not receive Browser A visits through the relay',
      120_000,
    );

    for (const nodeId of expectedVisitIds) {
      const node = syncedEnv.data.snapshot.nodes.find((candidate) => candidate.id === nodeId);
      expect(node, nodeId).toBeDefined();
      expect(node?.metadata?.workstreamId).toBe(wsId);
      expect(
        syncedEnv.data.snapshot.edges.some(
          (edge) =>
            edge.kind === 'visit_in_workstream' &&
            edge.fromNodeId === nodeId &&
            edge.toNodeId === `workstream:${wsId}`,
        ),
      ).toBe(true);
    }

    await waitForCondition(
      async () => hasCodingTurn(companionB!.vaultPath),
      'Browser B vault log did not receive collector-promoted coding turns',
      120_000,
    );

    const panelB = await openConnectionsPanel(runtimeB, companionB, wsId);
    await setConnectionsAnchor(panelB, `workstream:${wsId}`);
    for (const nodeId of expectedVisitIds) {
      await expect(panelB.getByTestId(`node-${nodeId}`)).toBeVisible({ timeout: 20_000 });
    }

    const bootstrapFeedback = await postBootstrapFeedbackLabels(companionB);
    const initialProjection = (await apiGet(
      companionB,
      '/v1/feedback/projection',
    )) as FeedbackProjectionEnvelope;
    expect(
      initialProjection.data.positiveLabels.some(
        (label) =>
          label.fromId === bootstrapFeedback.positive.fromId &&
          label.toId === bootstrapFeedback.positive.toId,
      ),
    ).toBe(true);
    expect(
      initialProjection.data.negativeLabels.some(
        (label) =>
          label.fromId === bootstrapFeedback.negative.fromId &&
          label.toId === bootstrapFeedback.negative.toId,
      ),
    ).toBe(true);

    const retrained = (await apiPost(companionB, '/v1/connections/ranker/retrain', {
      force: true,
      threshold: 1,
      numRound: 8,
      randomNegativeCandidatesPerPositive: 1,
    })) as RetrainEnvelope;
    expect(retrained.data.status).toBe('trained');
    if (retrained.data.status !== 'trained') {
      throw new Error(`ranker did not train: ${JSON.stringify(retrained.data)}`);
    }
    const rankerRevisionId = retrained.data.revisionId;

    const rankedEnv = await waitForConnections(
      companionB,
      (env) =>
        env.data.snapshot.edges.some(
          (edge) =>
            edge.kind === 'closest_visit' &&
            edge.producedBy?.source === 'ranker' &&
            typeof edge.producedBy.revisionId === 'string' &&
            topContributionCount(edge) > 0,
        ),
      'Browser B did not materialize ranker closest_visit edges',
      120_000,
    );
    const rankerEdge = rankedEnv.data.snapshot.edges.find(
      (edge) =>
        edge.kind === 'closest_visit' &&
        edge.producedBy?.source === 'ranker' &&
        edge.producedBy.revisionId === rankerRevisionId &&
        topContributionCount(edge) > 0,
    );
    expect(rankerEdge, 'ranker closest_visit edge').toBeDefined();
    if (rankerEdge === undefined) throw new Error('Missing ranker edge');

    await setConnectionsAnchor(panelB, `workstream:${wsId}`, '4');
    await clickVisibleEdge(panelB, rankerEdge);
    await expect(panelB.getByTestId('edge-provenance')).toBeVisible({ timeout: 10_000 });
    await expect(panelB.getByTestId('producer-pin-ranker')).toBeVisible();
    await panelB.getByTestId('producer-pin-ranker-pin').click();
    const pinnedRevision = await panelB.evaluate(async () => {
      const got = await chrome.storage.local.get('sidetrack.producerPin.ranker');
      const value = got['sidetrack.producerPin.ranker'];
      return typeof value === 'string' ? value : null;
    });
    expect(pinnedRevision).toBe(rankerRevisionId);

    await panelB.getByTestId('edge-provenance').getByTestId('feedback-confirm').click();
    await expect(panelB.getByTestId('edge-provenance').getByTestId('feedback-saved')).toBeVisible();
    const rankerEdges = feedbackCapableEdges(rankedEnv).filter(
      (edge) => edge.kind === 'closest_visit',
    );
    const uiRejectEdge =
      rankerEdges.find((edge) => !edgeConnects(edge, rankerEdge.fromNodeId, rankerEdge.toNodeId)) ??
      rankerEdge;
    await setConnectionsAnchor(panelB, `workstream:${wsId}`, '4');
    await clickVisibleEdge(panelB, uiRejectEdge);
    await panelB.getByTestId('edge-provenance').getByTestId('feedback-reject').click();
    await expect(panelB.getByTestId('edge-provenance').getByTestId('feedback-saved')).toBeVisible();

    const uiProjection = (await apiGet(
      companionB,
      '/v1/feedback/projection',
    )) as FeedbackProjectionEnvelope;
    expect(
      uiProjection.data.positiveLabels.some(
        (label) => label.fromId === rankerEdge.fromNodeId && label.toId === rankerEdge.toNodeId,
      ),
    ).toBe(true);
    expect(
      uiProjection.data.negativeLabels.some(
        (label) => label.fromId === uiRejectEdge.fromNodeId && label.toId === uiRejectEdge.toNodeId,
      ),
    ).toBe(true);

    await panelB.getByTestId('connections-mode-flow').click();
    await expect(panelB.getByTestId('flow-path-view')).toBeVisible();
    await panelB.getByTestId(`flow-visit-${rankerEdge.fromNodeId}`).click();
    await expect(panelB.getByTestId('why-related-panel')).toBeVisible();
    await expect(panelB.getByTestId('why-related-panel')).toContainText(/Ranker score/u);

    const topicNodes = rankedEnv.data.snapshot.nodes.filter((node) => node.kind === 'topic');
    if (topicNodes.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[full-sync] topic nodes did not form under this live browser timing');
    }
    const engagementClasses = rankedEnv.data.snapshot.nodes
      .filter((node) => node.kind === 'timeline-visit')
      .map((node) => node.metadata?.engagement)
      .filter((value) => isRecord(value) && typeof value['class'] === 'string');
    if (engagementClasses.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[full-sync] engagement classes were not flushed by the live browser buffer');
    }
    const navigationEdges = rankedEnv.data.snapshot.edges.filter(
      (edge) => edge.kind === 'visit_continues_visit',
    );
    if (navigationEdges.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[full-sync] navigation continuation edges were not available in this run');
    }

    llmMockA.assertNoLlmCalls();
    llmMockB.assertNoLlmCalls();
  });
});
