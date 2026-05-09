import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { installLlmNetworkMock, type LlmNetworkMock } from './helpers/llm-network-mock';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';
import {
  buildWorkGraphEvalAcceptedEvents,
  WORK_GRAPH_EVAL_EXPECTED,
  WORK_GRAPH_EVAL_VISIT_BY_KEY,
  WORK_GRAPH_EVAL_VISITS,
  WORK_GRAPH_EVAL_WORKSTREAM_ID,
} from '../../../sidetrack-companion/src/connections/__fixtures__/workGraphEval.js';

// Stage 2/3 user-story e2e (L1).
//
// Drives the feedback-driven learning loop end-to-end through the UI:
//
//   1. Seed the real companion event log with the deterministic eval pack.
//      The pack uses `sidetrack_eval_*` cluster tokens that the test embedder
//      maps to fixed vector axes, so cosine neighborhoods are predictable.
//   2. Gate the graph snapshot on non-zero Stage 2/3 outputs:
//      visit_resembles_visit, topic nodes, visit_continues_visit,
//      closest_visit, and revision-bearing inferred edges.
//   3. Open the Connections panel, verify Why Related shows ranker feature
//      contributions, pin the actual ranker revision, and submit confirm +
//      reject feedback via S26 UI buttons.
//   4. Assert feedback landed in `/v1/feedback/projection`, force retrain,
//      and verify the rejected pair's closest_visit score decreases or the
//      edge disappears.
//   5. Verify zero LLM-shaped network calls.

interface ConnectionsEnvelope {
  data: {
    snapshot: {
      nodes: { id: string; kind: string; metadata?: Record<string, unknown> }[];
      edges: {
        id: string;
        kind: string;
        fromNodeId: string;
        toNodeId: string;
        confidence?: string;
        producedBy?: { source?: string; revisionId?: string };
        metadata?: Record<string, unknown>;
      }[];
    };
  };
}

type SnapshotEdge = ConnectionsEnvelope['data']['snapshot']['edges'][number];

const nodeIdForVisitKey = (key: keyof typeof WORK_GRAPH_EVAL_VISIT_BY_KEY): string =>
  `timeline-visit:${WORK_GRAPH_EVAL_VISIT_BY_KEY[key].url}`;

const edgeConnects = (edge: SnapshotEdge, left: string, right: string): boolean =>
  (edge.fromNodeId === left && edge.toNodeId === right) ||
  (edge.fromNodeId === right && edge.toNodeId === left);

const edgeScore = (edge: SnapshotEdge): number => {
  const raw = edge.metadata?.score;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
};

const topContributionCount = (edge: SnapshotEdge): number => {
  const raw = edge.metadata?.topContributions;
  return Array.isArray(raw) ? raw.length : 0;
};

const waitForConnections = async (
  comp: TestCompanion,
  predicate: (env: ConnectionsEnvelope) => boolean,
  message: string,
): Promise<ConnectionsEnvelope> => {
  const startedMs = Date.now();
  let latest: ConnectionsEnvelope | null = null;
  while (Date.now() - startedMs < 90_000) {
    latest = (await apiGet(comp, '/v1/connections')) as ConnectionsEnvelope;
    if (predicate(latest)) return latest;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${message}; latest=${JSON.stringify(latest?.data.snapshot ?? null)}`);
};

const findEdge = (
  env: ConnectionsEnvelope,
  kind: string,
  left: string,
  right: string,
): SnapshotEdge | undefined =>
  env.data.snapshot.edges.find((edge) => edge.kind === kind && edgeConnects(edge, left, right));

const clickVisibleEdge = async (panel: Page, edge: SnapshotEdge): Promise<void> => {
  const row = panel.getByTestId(`edge-${edge.id}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(panel.getByTestId('edge-provenance')).toHaveAttribute('data-edge-id', edge.id, {
    timeout: 10_000,
  });
};

interface FeedbackProjectionEnvelope {
  data: {
    positiveLabels: { fromId: string; toId: string }[];
    negativeLabels: { fromId: string; toId: string }[];
  };
}

interface HealthEnvelope {
  data: {
    workGraph?: {
      ranker?: {
        activeRevisionId: string | null;
        loadStatus: string;
        retrainSkipReason: string | null;
      };
      ann?: { backend: string; fallbackActive: boolean };
      feedback?: { positiveLabelCount: number; negativeLabelCount: number };
      topicProducer?: {
        activeRevisionId: string | null;
        algorithmVersion: string | null;
        topicCount: number;
      };
    };
  };
}

interface RetrainEnvelope {
  data:
    | {
        status: 'trained';
        revisionId: string;
        candidateCount: number;
      }
    | {
        status: 'skipped' | 'failed';
        reason?: string;
        error?: string;
      };
}

const apiGet = async (comp: TestCompanion, path: string): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    headers: { 'x-bac-bridge-key': comp.bridgeKey },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${String(res.status)}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`POST ${path} → ${String(res.status)}: ${await res.text()}`);
  return await res.json();
};

test.describe('Stage 2/3 user story (feedback + producer pin)', () => {
  test.skip(
    process.env.SIDETRACK_E2E_SKIP_LIVE_BROWSERS === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(240_000);

  let companion: TestCompanion | null = null;
  let runtime: ExtensionRuntime | null = null;
  let llmMock: LlmNetworkMock | null = null;

  test.afterAll(async () => {
    if (runtime !== null) await runtime.close();
    if (companion !== null) await companion.close();
    runtime = null;
    companion = null;
  });

  test('drives the feedback loop end-to-end with zero LLM calls', async () => {
    companion = await startTestCompanion();
    await companion.ingestEvents(buildWorkGraphEvalAcceptedEvents());

    const expectedVisitIds = WORK_GRAPH_EVAL_VISITS.map((visit) => `timeline-visit:${visit.url}`);
    const seededEnv = await waitForConnections(
      companion,
      (candidate) => {
        const ids = new Set(candidate.data.snapshot.nodes.map((node) => node.id));
        return expectedVisitIds.every((id) => ids.has(id));
      },
      'work-graph eval visits did not materialize',
    );

    const wsEdges = seededEnv.data.snapshot.edges.filter(
      (edge) =>
        edge.kind === 'visit_in_workstream' &&
        edge.toNodeId === `workstream:${WORK_GRAPH_EVAL_WORKSTREAM_ID}`,
    );
    expect(wsEdges.length).toBeGreaterThanOrEqual(WORK_GRAPH_EVAL_VISITS.length);

    const resemblesEdges = seededEnv.data.snapshot.edges.filter(
      (edge) => edge.kind === 'visit_resembles_visit',
    );
    expect(resemblesEdges.length).toBeGreaterThan(0);

    const topicNodes = seededEnv.data.snapshot.nodes.filter((node) => node.kind === 'topic');
    expect(topicNodes.length).toBeGreaterThan(0);
    for (const expectedTopic of WORK_GRAPH_EVAL_EXPECTED.expectedTopicClusters) {
      const matchingTopic = topicNodes.find((node) => {
        const memberCount = node.metadata?.memberCount;
        const titles = node.metadata?.representativeTitles;
        return (
          typeof memberCount === 'number' &&
          memberCount >= expectedTopic.minimumMembers &&
          Array.isArray(titles) &&
          titles.some(
            (title) =>
              typeof title === 'string' &&
              title.includes(`sidetrack_eval_${expectedTopic.cluster}`),
          )
        );
      });
      expect(matchingTopic, `topic for ${expectedTopic.cluster}`).toBeDefined();
    }

    const continuationEdges = seededEnv.data.snapshot.edges.filter(
      (edge) => edge.kind === 'visit_continues_visit',
    );
    expect(continuationEdges.length).toBeGreaterThan(0);

    const baselineRetrain = (await apiPost(companion, '/v1/connections/ranker/retrain', {
      force: true,
      numRound: 8,
      randomNegativeCandidatesPerPositive: 1,
    })) as RetrainEnvelope;
    expect(baselineRetrain.data.status).toBe('trained');
    if (baselineRetrain.data.status !== 'trained') {
      throw new Error(`baseline retrain did not train: ${JSON.stringify(baselineRetrain.data)}`);
    }
    const baselineRevisionId = baselineRetrain.data.revisionId;

    const env = await waitForConnections(
      companion,
      (candidate) => candidate.data.snapshot.edges.some((edge) => edge.kind === 'closest_visit'),
      'closest_visit edges did not materialize after forced retrain',
    );
    const closestVisitEdges = env.data.snapshot.edges.filter(
      (edge) => edge.kind === 'closest_visit',
    );
    expect(closestVisitEdges.length).toBeGreaterThan(0);
    for (const edge of closestVisitEdges) {
      expect(edge.confidence).toBe('inferred');
      expect(edge.producedBy?.source).toBe('ranker');
      expect(edge.producedBy?.revisionId).toBe(baselineRevisionId);
      expect(topContributionCount(edge)).toBeGreaterThan(0);
    }

    const inferredRevisionEdges = env.data.snapshot.edges.filter(
      (edge) => edge.confidence === 'inferred' && typeof edge.producedBy?.revisionId === 'string',
    );
    expect(inferredRevisionEdges.length).toBeGreaterThan(0);

    const health = (await apiGet(companion, '/v1/system/health')) as HealthEnvelope;
    expect(health.data.workGraph?.ranker?.activeRevisionId).toBe(baselineRevisionId);
    expect(health.data.workGraph?.ranker?.loadStatus).toBe('ready');
    expect(health.data.workGraph?.ann?.backend).toMatch(/^(hnsw|flat)$/u);
    expect(health.data.workGraph?.feedback?.positiveLabelCount).toBeGreaterThan(0);
    expect(health.data.workGraph?.feedback?.negativeLabelCount).toBeGreaterThan(0);
    expect(health.data.workGraph?.topicProducer?.activeRevisionId).toEqual(expect.any(String));
    expect(health.data.workGraph?.topicProducer?.topicCount).toBeGreaterThan(0);

    runtime = await launchExtensionRuntime({ forceLocalProfile: true });

    llmMock = await installLlmNetworkMock(runtime.context);

    const panel = await runtime.context.newPage();
    await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await runtime.seedStorage(panel, {
      [SETUP_KEY]: true,
      [SETTINGS_KEY]: {
        companion: { port: companion.port, bridgeKey: companion.bridgeKey },
        autoTrack: false,
        siteToggles: { chatgpt: true, claude: true, gemini: true },
        notifyOnQueueComplete: true,
      },
      'sidetrack.activeWorkstreamId': WORK_GRAPH_EVAL_WORKSTREAM_ID,
    });
    await panel.reload({ waitUntil: 'domcontentloaded' });
    await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
      timeout: 30_000,
    });

    await panel.bringToFront();
    await panel.getByRole('tab', { name: 'Connections' }).click();
    await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });

    const anchor = panel.getByTestId('connections-anchor-input');
    await anchor.click();
    await anchor.fill(`workstream:${WORK_GRAPH_EVAL_WORKSTREAM_ID}`);
    await anchor.press('Enter');
    await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });

    const rejectedFromId = nodeIdForVisitKey(
      WORK_GRAPH_EVAL_EXPECTED.feedbackEffect.rejectedPair[0],
    );
    const rejectedToId = nodeIdForVisitKey(WORK_GRAPH_EVAL_EXPECTED.feedbackEffect.rejectedPair[1]);
    const confirmedFromId = nodeIdForVisitKey('pg_merge_a');
    const confirmedToId = nodeIdForVisitKey('pg_merge_c');
    const rejectEdge = findEdge(env, 'closest_visit', rejectedFromId, rejectedToId);
    const confirmEdge =
      findEdge(env, 'closest_visit', confirmedFromId, confirmedToId) ??
      findEdge(env, 'visit_resembles_visit', confirmedFromId, confirmedToId);
    expect(rejectEdge, 'baseline closest_visit edge to reject').toBeDefined();
    expect(confirmEdge, 'baseline relation edge to confirm').toBeDefined();
    if (rejectEdge === undefined || confirmEdge === undefined) {
      throw new Error('Missing baseline feedback edges.');
    }
    const rejectScoreBefore = edgeScore(rejectEdge);
    // eslint-disable-next-line no-console
    console.log(
      `[stage2-3] rejected closest_visit score before retrain: ${rejectedFromId} -> ${rejectedToId} = ${String(
        rejectScoreBefore,
      )}`,
    );

    await anchor.click();
    await anchor.fill(rejectedFromId);
    await anchor.press('Enter');
    await panel.getByTestId('connections-mode-linked').click();
    await clickVisibleEdge(panel, rejectEdge);
    await expect(panel.getByTestId('edge-provenance')).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByTestId('producer-pin-ranker')).toBeVisible();
    await panel.getByTestId('producer-pin-ranker-pin').click();
    const pinnedRevision = await panel.evaluate(async () => {
      const got = await chrome.storage.local.get('sidetrack.producerPin.ranker');
      const value = got['sidetrack.producerPin.ranker'];
      return typeof value === 'string' ? value : null;
    });
    expect(pinnedRevision).toBe(baselineRevisionId);

    await panel.getByTestId('connections-mode-focus').click();
    await expect(panel.getByTestId('focus-view')).toBeVisible();
    const topicEdge = env.data.snapshot.edges.find(
      (edge) => edge.kind === 'visit_in_topic' && edge.fromNodeId === rejectedFromId,
    );
    expect(topicEdge, 'topic membership for Why Related visit').toBeDefined();
    if (topicEdge === undefined) throw new Error('Missing topic membership for Why Related visit.');
    await panel.getByTestId(`focus-expand-${topicEdge.toNodeId}`).click();
    await panel.getByTestId(`focus-visit-${rejectedFromId}`).click();
    await expect(panel.getByTestId('why-related-panel')).toBeVisible();
    await expect(panel.getByTestId('why-related-panel')).toContainText(/Ranker score/u);
    await expect(panel.getByTestId('why-related-panel')).toContainText(
      /Ranker score [0-9.]+: [a-z_]+ [+-][0-9.]+/u,
    );

    await panel.getByTestId('connections-mode-linked').click();
    await expect(panel.getByTestId('connections-groups')).toBeVisible();
    await clickVisibleEdge(panel, confirmEdge);
    await panel.getByTestId('edge-provenance').getByTestId('feedback-confirm').click();
    await expect(panel.getByTestId('edge-provenance').getByTestId('feedback-saved')).toBeVisible();
    await clickVisibleEdge(panel, rejectEdge);
    await panel.getByTestId('edge-provenance').getByTestId('feedback-reject').click();
    await expect(panel.getByTestId('edge-provenance').getByTestId('feedback-saved')).toBeVisible();

    const feedbackProjection = (await apiGet(
      companion,
      '/v1/feedback/projection',
    )) as FeedbackProjectionEnvelope;
    expect(
      feedbackProjection.data.positiveLabels.some(
        (label) => label.fromId === confirmEdge.fromNodeId && label.toId === confirmEdge.toNodeId,
      ),
    ).toBe(true);
    expect(
      feedbackProjection.data.negativeLabels.some(
        (label) => label.fromId === rejectEdge.fromNodeId && label.toId === rejectEdge.toNodeId,
      ),
    ).toBe(true);

    const retrained = (await apiPost(companion, '/v1/connections/ranker/retrain', {
      force: true,
      numRound: 8,
      randomNegativeCandidatesPerPositive: 1,
    })) as RetrainEnvelope;
    expect(retrained.data.status).toBe('trained');
    if (retrained.data.status !== 'trained') {
      throw new Error(`post-feedback retrain did not train: ${JSON.stringify(retrained.data)}`);
    }
    expect(retrained.data.revisionId).not.toBe(baselineRevisionId);

    const retrainedEnv = (await apiGet(companion, '/v1/connections')) as ConnectionsEnvelope;
    const rejectEdgeAfter = findEdge(retrainedEnv, 'closest_visit', rejectedFromId, rejectedToId);
    if (rejectEdgeAfter !== undefined) {
      const rejectScoreAfter = edgeScore(rejectEdgeAfter);
      // eslint-disable-next-line no-console
      console.log(
        `[stage2-3] rejected closest_visit score after retrain: ${rejectedFromId} -> ${rejectedToId} = ${String(
          rejectScoreAfter,
        )}`,
      );
      expect(rejectScoreAfter).toBeLessThan(rejectScoreBefore);
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[stage2-3] rejected closest_visit score after retrain: ${rejectedFromId} -> ${rejectedToId} = edge disappeared`,
      );
    }

    const postRetrainHealth = (await apiGet(companion, '/v1/system/health')) as HealthEnvelope;
    expect(postRetrainHealth.data.workGraph?.ranker?.activeRevisionId).toBe(
      retrained.data.revisionId,
    );
    expect(postRetrainHealth.data.workGraph?.ranker?.loadStatus).toBe('ready');
    expect(postRetrainHealth.data.workGraph?.feedback?.negativeLabelCount).toBeGreaterThanOrEqual(
      2,
    );

    llmMock.assertNoLlmCalls();
  });
});
